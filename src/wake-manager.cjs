'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveWakeRuntime, wakeModelReady } = require('./wake-runtime.cjs');

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
  constructor({ paths, onWake, onChange = () => {}, spawn: spawnProcess = spawn }) {
    Object.assign(this, { paths, onWake, onChange, spawn: spawnProcess });
    this.status = 'disabled'; this.error = null; this.paused = false; this.closed = false; this.generation = 0;
    this.child = null; this.installer = null; this.installerCleanup = null; this.installerFinish = null;
    this.deviceScans = new Set(); this.installing = false; this.stopping = null; this.closing = null;
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
  setCallState(state) {
    // An active call can be reactivated by voice, including during local replay.
    // Idle replay stays isolated so a recorded wake phrase cannot start a call.
    this.setPaused(state.missed_playing === true && state.state !== 'active');
  }
  async pauseAndWait() { this.paused = true; this.restartAfterStop = false; await this.stop(); }
  runtime() {
    return resolveWakeRuntime(this.config || { pythonPath: 'python3', modelPath: '' }, this.paths);
  }
  listDevices() {
    if (this.closed) return Promise.resolve({ status: 'wake_devices_unavailable', inputs: [] });
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
    const { python, model } = this.runtime();
    if (!wakeModelReady(model)) { this.report('setup_required', 'wake_model_missing'); return; }
    const generation = ++this.generation;
    this.report('starting');
    let child;
    try {
      const args = [path.join(__dirname, 'wake', 'listener.py'), '--model', model,
        '--phrase', this.config.phrase, '--sensitivity', String(this.config.sensitivity)];
      if (this.config.deviceName && this.config.deviceHostApi) {
        args.push('--device-name', this.config.deviceName, '--device-host-api', this.config.deviceHostApi);
      }
      child = this.spawn(python, args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
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
    this.installerCleanup = null; this.installerFinish = null;
    let child;
    try {
      child = this.spawn('python3', [path.join(__dirname, '..', 'scripts', 'setup-wake.py'), '--data-dir', this.paths.dataDir], {
        stdio: 'ignore', shell: false, detached: process.platform !== 'win32', windowsHide: true,
      });
    } catch {
      this.installing = false;
      this.report('setup_required', 'wake_setup_failed');
      return { status: 'wake_setup_failed' };
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
module.exports = { WakeManager };
