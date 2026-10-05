'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveWakeRuntime, findWakePython, wakeModelReady } = require('./wake-runtime.cjs');
const { VOICE_COMMANDS } = require('./voice_commands.cjs');
const failure = code => Object.assign(new Error(code), { code });
const safeCode = (error, fallback = 'wake_failed') => /^[a-z_]{1,80}$/.test(error?.code || '') ? error.code : fallback;
const MAX_QUEUED_PCM = 4 * 1600 * 4;
function processGroupAlive(child) {
  if (process.platform === 'win32' || !Number.isInteger(child?.pid)) {
    return child?.exitCode === null && child?.signalCode === null;
  }
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function signalProcessGroup(child, signal) {
  if (process.platform !== 'win32' && Number.isInteger(child?.pid)) {
    try { process.kill(-child.pid, signal); return; }
    catch (error) { if (error.code === 'ESRCH') return; }
  }
  try { child?.kill(signal); } catch {}
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForProcessGroupExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(child) && Date.now() < deadline) await delay(25);
  return !processGroupAlive(child);
}

function waitForChildExit(child, timeoutMs = 1000) {
  if (child?.exitCode !== null || child?.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise(resolve => { child?.once('close', resolve); child?.once('error', resolve); }),
    delay(timeoutMs),
  ]);
}

class WakeManager {
  constructor({ paths, onWake, onCommand = () => {}, onChange = () => {}, spawn: spawnProcess = spawn,
    platform = process.platform, captureFactory, requestMicrophoneAccess = async () => false,
    findPython = findWakePython, startupTimeoutMs = 30000, now = () => performance.now() }) {
    Object.assign(this, { paths, onWake, onCommand, onChange, spawn: spawnProcess, platform,
      captureFactory, requestMicrophoneAccess, findPython, startupTimeoutMs, now });
    this.status = 'disabled'; this.error = null; this.paused = false; this.closed = false; this.generation = 0;
    this.capture = null; this.starting = null;
    this.callState = {};
    this.idleReplayTailUntil = 0;
    this.child = null; this.installer = null; this.installerCleanup = null; this.installerFinish = null;
    this.deviceScans = new Set(); this.installing = false; this.stopping = null; this.closing = null;
  }
  report(status, error = null) { this.status = status; this.error = error; this.onChange(); }
  configure(config, { inputDeviceId = this.inputDeviceId } = {}) {
    if (this.closed) return;
    if (JSON.stringify(config) === JSON.stringify(this.config) && inputDeviceId === this.inputDeviceId) return;
    this.config = structuredClone(config);
    this.inputDeviceId = inputDeviceId;
    if (this.callState.missed_playing && this.callState.state !== 'active') this.paused = config.commandsEnabled !== true;
    void this.stop().then(() => this.start());
  }
  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) { this.restartAfterStop = false; void this.stop(); }
    else this.start();
  }
  setCallState(state) {
    if (this.config?.commandsEnabled === true && this.callState.missed_playing && this.callState.state !== 'active' && !state.missed_playing) {
      // A final recorded wake phrase may finish decoding after playback ends.
      this.idleReplayTailUntil = this.now() + 750;
    }
    this.callState = { state: state.state, missed_playing: state.missed_playing === true };
    // Commands keep local capture alive so replay can be stopped by voice.
    // Bare wake detections during idle replay remain suppressed below.
    this.setPaused(this.callState.missed_playing && state.state !== 'active' && this.config?.commandsEnabled !== true);
  }
  async pauseAndWait() { this.paused = true; this.restartAfterStop = false; await this.stop(); }
  runtime() {
    return resolveWakeRuntime(this.config || {}, this.paths, { platform: this.platform });
  }
  listDevices() {
    // macOS uses the selected Chromium call input for local wake capture. The
    // separate PortAudio selector belongs to Linux and must not open a Python
    // microphone backend in the macOS decoder-only environment.
    if (this.closed || this.platform === 'darwin') return Promise.resolve({ status: 'wake_devices_unavailable', inputs: [] });
    const { python } = this.runtime();
    return new Promise(resolve => {
      let child, output = '', finished = false, timer;
      const finish = result => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      try {
        child = this.spawn(python, [path.join(__dirname, 'wake', 'list_devices.py')], {
          stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true,
        });
      } catch {
        finish({ status: 'wake_devices_unavailable', inputs: [] });
        return;
      }
      this.deviceScans.add(child);
      child.stdout?.on('data', chunk => {
        output += chunk.toString('utf8');
        if (output.length > 65_536) {
          try { child.kill('SIGKILL'); } catch {}
          finish({ status: 'wake_devices_unavailable', inputs: [] });
        }
      });
      child.once('error', () => {
        this.deviceScans.delete(child);
        finish({ status: 'wake_devices_unavailable', inputs: [] });
      });
      child.once('close', code => {
        this.deviceScans.delete(child);
        if (code !== 0 || finished) { finish({ status: 'wake_devices_unavailable', inputs: [] }); return; }
        let value;
        try { value = JSON.parse(output); } catch { finish({ status: 'wake_devices_unavailable', inputs: [] }); return; }
        const inputs = Array.isArray(value?.inputs) ? value.inputs.slice(0, 64).flatMap(device => {
          const name = device?.name, hostApi = device?.hostApi;
          if (typeof name !== 'string' || !name || name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name) ||
              typeof hostApi !== 'string' || !hostApi || hostApi.length > 80 || /[\u0000-\u001f\u007f]/u.test(hostApi)) return [];
          return [{ name, hostApi, ambiguous: device.ambiguous === true }];
        }) : [];
        finish({ status: 'wake_devices_listed', inputs });
      });
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish({ status: 'wake_devices_unavailable', inputs: [] });
      }, 5000);
      timer.unref();
    });
  }
  start() {
    if (this.closed || this.installing || !this.config) return;
    if (!this.config.enabled) { this.report('disabled'); return; }
    if (this.paused) { this.report('paused'); return; }
    if (this.child) return;
    if (this.stopping) { this.restartAfterStop = true; return; }
    if (this.starting) { this.restartAfterStart = true; return; }
    const { python, model } = this.runtime();
    if (!wakeModelReady(model)) { this.report('setup_required', 'wake_model_missing'); return; }
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
      const args = [path.join(__dirname, 'wake', 'listener.py'), '--model', model,
        '--phrase', this.config.phrase, '--sensitivity', String(this.config.sensitivity)];
      if (this.config.commandsEnabled === true) args.push('--commands-json', JSON.stringify(this.config.commands));
      if (stdinAudio) args.push('--stdin-audio');
      else if (this.config.deviceName && this.config.deviceHostApi) {
        args.push('--device-name', this.config.deviceName, '--device-host-api', this.config.deviceHostApi);
      }
      child = this.spawn(python, args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
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
        if (generation !== this.generation) break;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== 'object') continue;
        if (event.event === 'ready') {
          if (stdinAudio) void this.startCapture(child, generation);
          else this.report('listening');
        }
        if (event.event === 'wake' && !this.paused && this.status === 'listening' &&
            !(this.callState.missed_playing && this.callState.state !== 'active') && this.now() >= this.idleReplayTailUntil) this.onWake();
        if (event.event === 'command' && !this.paused && this.status === 'listening' &&
            this.config.commandsEnabled === true && typeof event.command === 'string' && Object.hasOwn(VOICE_COMMANDS, event.command)) this.onCommand(event.command);
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
    this.installerCleanup = null; this.installerFinish = null;
    let child;
    try {
      const python = this.platform === 'darwin'
        ? await this.findPython(this.config || {}, this.paths, { platform: this.platform, forSetup: true }) : 'python3';
      if (this.closed) { this.installing = false; return { status: 'wake_setup_cancelled' }; }
      child = this.spawn(python, [path.join(__dirname, '..', 'scripts', 'setup-wake.py'), '--data-dir', this.paths.dataDir,
        ...(this.platform === 'darwin' ? ['--stdin-audio'] : [])], {
        stdio: 'ignore', shell: false, detached: process.platform !== 'win32', windowsHide: true,
      });
    } catch (error) {
      this.installing = false;
      const code = this.platform === 'darwin' ? safeCode(error, 'wake_setup_failed') : 'wake_setup_failed';
      this.report('setup_required', code);
      return { status: code };
    }
    this.installer = child;
    child.once('error', () => { void this.finishInstaller(child, 1); });
    child.once('close', code => { void this.finishInstaller(child, code); });
    return { status: 'wake_setup_started' };
  }
  terminateInstaller(child) {
    if (this.installerCleanup?.child === child) return this.installerCleanup.promise;
    const promise = (async () => {
      signalProcessGroup(child, 'SIGTERM');
      if (await waitForProcessGroupExit(child, 2000)) return true;
      signalProcessGroup(child, 'SIGKILL');
      return waitForProcessGroupExit(child, 1500);
    })();
    this.installerCleanup = { child, promise };
    return promise;
  }
  finishInstaller(child, code) {
    if (this.installerFinish?.child === child) return this.installerFinish.promise;
    const promise = (async () => {
      const treeStopped = await this.terminateInstaller(child);
      await waitForChildExit(child);
      this.installing = false;
      if (this.installer === child) this.installer = null;
      if (this.closed) return;
      if (code === 0 && treeStopped) { this.report('ready'); this.start(); }
      else this.report('setup_required', 'wake_setup_failed');
    })();
    this.installerFinish = { child, promise };
    return promise;
  }
  async stopDeviceScan(child) {
    if (child?.exitCode !== null || child?.signalCode !== null) return;
    try { child.kill('SIGTERM'); } catch {}
    await waitForChildExit(child, 1000);
    if (child?.exitCode === null && child?.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
      await waitForChildExit(child, 1000);
    }
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; this.paused = true; this.restartAfterStop = false;
    this.closing = (async () => {
      const installer = this.installer;
      if (installer) {
        await this.terminateInstaller(installer);
        await waitForChildExit(installer);
        if (this.installerFinish?.child === installer) await this.installerFinish.promise;
        else await this.finishInstaller(installer, 1);
      }
      await Promise.all([...this.deviceScans].map(child => this.stopDeviceScan(child)));
      await this.stop();
    })();
    return this.closing;
  }
}
module.exports = { WakeManager, resolveWakeRuntime };
