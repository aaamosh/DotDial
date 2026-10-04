'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveWakeRuntime, findWakePython } = require('./wake_runtime.cjs');
const failure = code => Object.assign(new Error(code), { code });
const safeCode = (error, fallback = 'wake_failed') => /^[a-z_]{1,80}$/.test(error?.code || '') ? error.code : fallback;
const MAX_QUEUED_PCM = 4 * 1600 * 4;

class WakeManager {
  constructor({ paths, onWake, onChange = () => {}, spawn: spawnProcess = spawn,
    platform = process.platform, captureFactory, requestMicrophoneAccess = async () => false,
    findPython = findWakePython, startupTimeoutMs = 30000 }) {
    Object.assign(this, { paths, onWake, onChange, spawn: spawnProcess, platform,
      captureFactory, requestMicrophoneAccess, findPython, startupTimeoutMs });
    this.status = 'disabled'; this.error = null; this.paused = false; this.closed = false; this.generation = 0;
    this.child = null; this.installer = null; this.installing = false; this.stopping = null; this.closing = null;
    this.capture = null; this.starting = null;
  }
  report(status, error = null) { this.status = status; this.error = error; this.onChange(); }
  configure(config, { inputDeviceId = this.inputDeviceId } = {}) {
    if (this.closed) return;
    if (JSON.stringify(config) === JSON.stringify(this.config) && inputDeviceId === this.inputDeviceId) return;
    this.config = structuredClone(config);
    this.inputDeviceId = inputDeviceId;
    void this.stop().then(() => this.start());
  }
  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) { this.restartAfterStop = false; void this.stop(); }
    else this.start();
  }
  setCallState(state) {
    // An active call can be reactivated by voice, including during local replay.
    // Idle replay stays isolated so a recorded wake phrase cannot start a call.
    this.setPaused(state.missed_playing === true && state.state !== 'active');
  }
  async pauseAndWait() { this.paused = true; this.restartAfterStop = false; await this.stop(); }
  runtime() {
    return resolveWakeRuntime(this.config, this.paths, { platform: this.platform });
  }
  start() {
    if (this.closed || this.installing || !this.config) return;
    if (!this.config.enabled) { this.report('disabled'); return; }
    if (this.paused) { this.report('paused'); return; }
    if (this.child) return;
    if (this.stopping) { this.restartAfterStop = true; return; }
    if (this.starting) { this.restartAfterStart = true; return; }
    const { python, model } = this.runtime();
    if (!fs.existsSync(path.join(model, 'tokens.txt'))) { this.report('setup_required', 'wake_model_missing'); return; }
    const generation = ++this.generation;
    this.report('starting');
    if (this.platform === 'darwin') {
      this.starting = this.startMac(model, generation).catch(error => {
        if (generation !== this.generation || this.closed) return;
        const code = safeCode(error);
        this.report(code.startsWith('wake_python_') ? 'setup_required' : 'error', code);
      }).finally(() => {
        this.starting = null;
        const restart = this.restartAfterStart; this.restartAfterStart = false;
        if (restart && !this.closed && !this.paused) this.start();
      });
      return;
    }
    this.launchListener(python, model, generation, false);
  }
  async startMac(model, generation) {
    if (typeof this.captureFactory !== 'function') throw failure('wake_audio_unavailable');
    if (!await this.requestMicrophoneAccess()) throw failure('microphone_permission_required');
    if (generation !== this.generation || this.closed || this.paused) return;
    const python = await this.findPython(this.config, this.paths, { platform: this.platform });
    if (generation !== this.generation || this.closed || this.paused) return;
    this.launchListener(python, model, generation, true);
  }
  launchListener(python, model, generation, stdinAudio) {
    let child;
    try {
      child = this.spawn(python, [path.join(__dirname, 'wake', 'listener.py'), '--model', model,
        '--phrase', this.config.phrase, '--sensitivity', String(this.config.sensitivity), ...(stdinAudio ? ['--stdin-audio'] : [])],
      { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    } catch {
      this.report('setup_required', 'wake_python_unavailable');
      return;
    }
    this.child = child;
    if (stdinAudio) {
      this.startupTimer = setTimeout(() => {
        if (generation === this.generation) void this.stop({ status: 'error', error: 'wake_start_timeout' });
      }, this.startupTimeoutMs);
      this.startupTimer.unref?.();
      child.stdin?.on?.('error', () => {
        if (generation === this.generation) void this.stop({ status: 'error', error: 'wake_audio_unavailable' });
      });
    }
    let buffer = '';
    let spawnFailed = false;
    child.stdout.on('data', chunk => {
      if (generation !== this.generation) return;
      buffer += chunk.toString();
      if (buffer.length > 16384) { void this.stop({ status: 'error', error: 'wake_protocol_error' }); return; }
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'ready') {
          if (stdinAudio) void this.startCapture(child, generation);
          else this.report('listening');
        }
        if (event.event === 'wake' && !this.paused && this.status === 'listening') this.onWake();
        if (event.event === 'error') {
          const code = /^[a-z_]+$/.test(event.code || '') ? event.code : 'wake_failed';
          if (stdinAudio) void this.stop({ status: 'error', error: code });
          else this.report('error', code);
        }
      }
    });
    child.once('error', () => {
      spawnFailed = true;
      if (generation === this.generation) {
        ++this.generation;
        clearTimeout(this.startupTimer);
        if (this.child === child) this.child = null;
        void this.capture?.close(); this.capture = null;
        this.report('setup_required', 'wake_python_unavailable');
      }
    });
    child.once('close', () => {
      const current = generation === this.generation;
      if (this.child === child) {
        if (current) ++this.generation;
        this.child = null;
        clearTimeout(this.startupTimer);
        void this.capture?.close(); this.capture = null;
      }
      if (current && !this.closed && !this.paused && !spawnFailed && this.status !== 'error') this.report('error', 'wake_stopped');
    });
  }
  async startCapture(child, generation) {
    if (generation !== this.generation || this.capture || this.closed || this.paused) return;
    try {
      const capture = this.captureFactory({
        onAudio: pcm => this.writeAudio(child, generation, pcm),
        onError: code => { if (generation === this.generation) void this.stop({ status: 'error', error: safeCode({ code }) }); },
      });
      this.capture = capture;
      await capture.ready;
      if (generation !== this.generation || this.child !== child || this.capture !== capture || this.closed || this.paused) { await capture.close(); return; }
      clearTimeout(this.startupTimer);
      this.report('listening');
    } catch (error) {
      if (generation === this.generation) await this.stop({ status: 'error', error: safeCode(error, 'wake_audio_unavailable') });
    }
  }
  writeAudio(child, generation, pcm) {
    if (generation !== this.generation || this.child !== child || this.closed || this.paused) return Promise.reject(failure('wake_capture_cancelled'));
    if (!Buffer.isBuffer(pcm) || pcm.length < 4 || pcm.length > 6400 || pcm.length % 4) return Promise.reject(failure('wake_audio_protocol_error'));
    const input = child.stdin;
    if (!input || input.destroyed || input.writableEnded) return Promise.reject(failure('wake_audio_unavailable'));
    if ((input.writableLength || 0) + pcm.length > MAX_QUEUED_PCM) return Promise.reject(failure('wake_audio_backpressure'));
    return new Promise((resolve, reject) => {
      try { input.write(pcm, error => error ? reject(failure('wake_audio_unavailable')) : resolve()); }
      catch { reject(failure('wake_audio_unavailable')); }
    });
  }
  stop(statusAfterStop = null) {
    if (this.stopping) return this.stopping;
    ++this.generation;
    clearTimeout(this.startupTimer);
    const child = this.child; this.child = null;
    const capture = this.capture; this.capture = null;
    let captureClosed;
    try { captureClosed = Promise.resolve(capture?.close()).catch(() => {}); }
    catch { captureClosed = Promise.resolve(); }
    if (!child && !capture) {
      if (!this.closed && this.config) this.report(this.config.enabled ? (this.paused ? 'paused' : 'disabled') : 'disabled');
      return Promise.resolve();
    }
    this.stopping = new Promise(resolve => {
      let timer, finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        void captureClosed.then(() => {
          this.stopping = null;
          if (!this.closed) this.report(statusAfterStop?.status || (this.config?.enabled ? 'paused' : 'disabled'), statusAfterStop?.error || null);
          const restart = this.restartAfterStop;
          this.restartAfterStop = false;
          resolve();
          if (restart && !this.closed && !this.paused) this.start();
        });
      };
      if (!child) { done(); return; }
      child.once('close', done);
      timer = setTimeout(() => { if (!finished) { try { child.kill('SIGKILL'); } catch {} } }, 2000);
      timer.unref();
      try { child.stdin?.end(); child.kill('SIGTERM'); } catch { done(); }
    });
    return this.stopping;
  }
  async install() {
    if (this.closed) return { status: 'wake_setup_cancelled' };
    if (this.installing) return { status: 'wake_setup_running' };
    this.installing = true; await this.stop();
    if (this.closed) { this.installing = false; return { status: 'wake_setup_cancelled' }; }
    this.report('installing');
    let child;
    try {
      const python = this.platform === 'darwin'
        ? await this.findPython(this.config || {}, this.paths, { platform: this.platform, forSetup: true }) : 'python3';
      if (this.closed) { this.installing = false; return { status: 'wake_setup_cancelled' }; }
      child = this.spawn(python, [path.join(__dirname, '..', 'scripts', 'setup-wake.py'), '--data-dir', this.paths.dataDir,
        ...(this.platform === 'darwin' ? ['--stdin-audio'] : [])], { stdio: 'ignore', shell: false });
    } catch (error) {
      this.installing = false;
      const code = this.platform === 'darwin' ? safeCode(error, 'wake_setup_failed') : 'wake_setup_failed';
      this.report('setup_required', code);
      return { status: code };
    }
    this.installer = child;
    let finished = false;
    const finish = code => {
      if (finished) return;
      finished = true;
      this.installing = false; this.installer = null;
      if (this.closed) return;
      if (code === 0) { this.report('ready'); this.start(); }
      else this.report('setup_required', 'wake_setup_failed');
    };
    child.once('error', () => finish(1)); child.once('close', finish);
    return { status: 'wake_setup_started' };
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; this.paused = true; this.restartAfterStop = false;
    this.closing = (async () => {
      const installer = this.installer;
      if (installer) {
        let timer;
        const exited = new Promise(resolve => {
          if (installer.exitCode !== null || installer.signalCode !== null) { resolve(); return; }
          installer.once('close', resolve);
          installer.once('error', resolve);
        });
        if (installer.exitCode === null && installer.signalCode === null) {
          timer = setTimeout(() => { try { installer.kill('SIGKILL'); } catch {} }, 2000);
          timer.unref();
        }
        try { installer.kill('SIGTERM'); } catch {}
        await exited;
        if (timer) clearTimeout(timer);
      }
      await this.stop();
    })();
    return this.closing;
  }
}
module.exports = { WakeManager, resolveWakeRuntime };
