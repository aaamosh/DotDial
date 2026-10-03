'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const MODEL = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';

class WakeManager {
  constructor({ paths, onWake, onChange = () => {}, spawn: spawnProcess = spawn }) {
    Object.assign(this, { paths, onWake, onChange, spawn: spawnProcess });
    this.status = 'disabled'; this.error = null; this.paused = false; this.closed = false; this.generation = 0;
    this.child = null; this.installer = null; this.installing = false; this.stopping = null; this.closing = null;
  }
  report(status, error = null) { this.status = status; this.error = error; this.onChange(); }
  configure(config) {
    if (this.closed) return;
    if (JSON.stringify(config) === JSON.stringify(this.config)) return;
    this.config = structuredClone(config);
    void this.stop().then(() => this.start());
  }
  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) { this.restartAfterStop = false; void this.stop(); }
    else this.start();
  }
  async pauseAndWait() { this.paused = true; this.restartAfterStop = false; await this.stop(); }
  runtime() {
    const local = path.join(this.paths.dataDir, 'wake-venv', 'bin', 'python');
    return { python: this.config.pythonPath === 'python3' && fs.existsSync(local) ? local : this.config.pythonPath,
      model: this.config.modelPath || path.join(this.paths.dataDir, 'models', MODEL) };
  }
  start() {
    if (this.closed || this.installing || !this.config) return;
    if (!this.config.enabled) { this.report('disabled'); return; }
    if (this.paused) { this.report('paused'); return; }
    if (this.child) return;
    if (this.stopping) { this.restartAfterStop = true; return; }
    const { python, model } = this.runtime();
    if (!fs.existsSync(path.join(model, 'tokens.txt'))) { this.report('setup_required', 'wake_model_missing'); return; }
    const generation = ++this.generation;
    this.report('starting');
    let child;
    try {
      child = this.spawn(python, [path.join(__dirname, 'wake', 'listener.py'), '--model', model,
        '--phrase', this.config.phrase, '--sensitivity', String(this.config.sensitivity)], { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    } catch {
      this.report('setup_required', 'wake_python_unavailable');
      return;
    }
    this.child = child;
    let buffer = '';
    let spawnFailed = false;
    child.stdout.on('data', chunk => {
      if (generation !== this.generation) return;
      buffer += chunk.toString();
      if (buffer.length > 16384) { void this.stop({ status: 'error', error: 'wake_protocol_error' }); return; }
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'ready') this.report('listening');
        if (event.event === 'wake' && !this.paused) this.onWake();
        if (event.event === 'error') this.report('error', /^[a-z_]+$/.test(event.code || '') ? event.code : 'wake_failed');
      }
    });
    child.once('error', () => {
      spawnFailed = true;
      if (generation === this.generation) {
        if (this.child === child) this.child = null;
        this.report('setup_required', 'wake_python_unavailable');
      }
    });
    child.once('close', () => {
      if (this.child === child) this.child = null;
      if (generation === this.generation && !this.closed && !this.paused && !spawnFailed && this.status !== 'error') this.report('error', 'wake_stopped');
    });
  }
  stop(statusAfterStop = null) {
    if (this.stopping) return this.stopping;
    ++this.generation;
    const child = this.child; this.child = null;
    if (!child) {
      if (!this.closed && this.config) this.report(this.config.enabled ? (this.paused ? 'paused' : 'disabled') : 'disabled');
      return Promise.resolve();
    }
    this.stopping = new Promise(resolve => {
      let timer, finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        this.stopping = null;
        if (!this.closed) this.report(statusAfterStop?.status || (this.config?.enabled ? 'paused' : 'disabled'), statusAfterStop?.error || null);
        const restart = this.restartAfterStop;
        this.restartAfterStop = false;
        resolve();
        if (restart && !this.closed && !this.paused) this.start();
      };
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
      child = this.spawn('python3', [path.join(__dirname, '..', 'scripts', 'setup-wake.py'), '--data-dir', this.paths.dataDir], { stdio: 'ignore', shell: false });
    } catch {
      this.installing = false;
      this.report('setup_required', 'wake_setup_failed');
      return { status: 'wake_setup_failed' };
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
module.exports = { WakeManager };
