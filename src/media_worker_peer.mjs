import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RpcConnection, codedError, safeErrorCode } = require('./media_worker_rpc.cjs');
const DEFAULT_WORKER = fileURLToPath(new URL('./media_worker.cjs', import.meta.url));
const SAFE_ARCHIVE_ERRORS = new Set(['recording_unavailable', 'storage_full', 'recording_failed']);
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS', 'PULSE_SERVER', 'PULSE_SINK', 'WAYLAND_DISPLAY', 'LANG', 'LC_ALL', 'TMPDIR',
];

function makeTempUserData(runtimeDir) {
  if (typeof runtimeDir !== 'string' || !path.isAbsolute(runtimeDir)) throw codedError('media_worker_profile_invalid');
  let directory;
  try {
    directory = fs.mkdtempSync(path.join(runtimeDir, 'dotdial-media-'));
    fs.chmodSync(directory, 0o700);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw codedError('media_worker_profile_invalid');
    }
    return directory;
  } catch (error) {
    if (directory) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    }
    throw codedError(safeErrorCode(error, 'media_worker_profile_unavailable'));
  }
}

function workerEnvironment() {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0 && !value.includes('\0')) env[key] = value;
  }
  return env;
}

function validateElectronArgs(args) {
  if (!Array.isArray(args) || args.length > 40 || args.some(value => typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) {
    throw codedError('media_worker_args_invalid');
  }
  if (args.some(value => /^--(?:user-data-dir|dotdial-media-user-data)(?:=|$)/i.test(value))) {
    throw codedError('media_worker_args_invalid');
  }
  return [...args];
}

export function routedChromiumMedia({
  archive,
  getSpeakersMuted = () => false,
  launcher = [],
  electron = process.execPath,
  workerPath = DEFAULT_WORKER,
  electronArgs = [],
  runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir(),
  mediaOptions = {},
  packaged = false,
  startupTimeoutMs = 60_000,
  closeTimeoutMs = 8_000,
  terminateGraceMs = 1_500,
  killGraceMs = 1_500,
} = {}) {
  if (!Array.isArray(launcher) || launcher.some(x => typeof x !== 'string' || x.includes('\0')) ||
      (launcher.length && !launcher[0].trim()) ||
      typeof electron !== 'string' || !path.isAbsolute(electron) ||
      typeof workerPath !== 'string' || !path.isAbsolute(workerPath) ||
      typeof getSpeakersMuted !== 'function') {
    throw codedError('media_worker_configuration_invalid');
  }
  const launchArgs = validateElectronArgs(electronArgs);

  return class RoutedChromiumPeer {
    constructor(onEvent = () => {}, onLevel = () => {}, onFailure = () => {}) {
      this.archive = archive;
      this.getSpeakersMuted = getSpeakersMuted;
      this.onEvent = onEvent;
      this.onLevel = onLevel;
      this.onFailure = onFailure;
      this.closed = false;
      this.closing = false;
      this.failureReported = false;
      this.readyResolved = false;
      this.childClosed = false;
      this.closePromise = null;
      this.cleanupPromise = null;
      this.child = null;
      this.connection = null;
      this.microphoneSettings = null;
      this.recordingActive = false;
      this.userDataDirectory = makeTempUserData(runtimeDir);
      this.ready = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.ready.catch(() => {});
      this.startupTimer = setTimeout(() => this.failStartup('media_worker_startup_timeout'), startupTimeoutMs);
      this.startupTimer.unref?.();
      this.launch();
    }

    launch() {
      const command = launcher.length ? launcher[0] : electron;
      const args = [...(launcher.length ? [...launcher.slice(1), electron] : []), ...launchArgs,
        ...(packaged ? ['--media-worker'] : [workerPath]),
        `--dotdial-media-user-data=${this.userDataDirectory}`,
        `--dotdial-media-options=${Buffer.from(JSON.stringify(mediaOptions)).toString('base64url')}`];
      try {
        this.child = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'ignore'],
          detached: process.platform !== 'win32',
          windowsHide: true,
          env: workerEnvironment(),
        });
      } catch {
        this.failStartup('media_worker_start_failed');
        void this.cleanupUserData();
        return;
      }

      this.childClosedPromise = new Promise(resolve => { this.resolveChildClosed = resolve; });
      this.child.once('error', () => {
        this.failStartup('media_worker_start_failed');
        this.handleUnexpectedFailure('media_worker_start_failed');
      });
      this.child.once('exit', (code, signal) => this.handleChildExit(code, signal));
      this.child.once('close', (code, signal) => this.handleChildClose(code, signal));
      this.connection = new RpcConnection(this.child.stdout, this.child.stdin, {
        idPrefix: 'p',
        onRequest: (method, args) => this.handleWorkerRequest(method, args),
        onNotification: (method, args) => this.handleWorkerNotification(method, args),
        onEvent: (name, payload) => this.handleWorkerEvent(name, payload),
        onFailure: error => {
          if (!this.closing && !this.childClosed) {
            const code = safeErrorCode(error, 'media_worker_failed');
            this.handleUnexpectedFailure(code === 'media_worker_eof' ? 'media_worker_exited' : code);
          }
        },
      });
    }

    handleWorkerRequest(method, args) {
      if (method !== 'archive.save' || !Array.isArray(args) || args.length !== 1 ||
          !this.archive || typeof this.archive.save !== 'function') {
        throw codedError(method === 'archive.save' ? 'recording_unavailable' : 'media_worker_protocol_error');
      }
      return Promise.resolve().then(() => this.archive.save(args[0])).catch(error => ({
        saved: false,
        code: error?.code === 'storage_full' ? 'storage_full' : 'recording_failed',
      }));
    }

    handleWorkerNotification(method, args) {
      if (method === 'archive.recording' && Array.isArray(args) && args.length === 1) {
        this.recordingActive = args[0] === true;
        try { this.archive?.setRecording?.(this.recordingActive); } catch {}
        return;
      }
      if (method === 'archive.error' && Array.isArray(args) && args.length === 1) {
        const code = SAFE_ARCHIVE_ERRORS.has(args[0]) ? args[0] : 'recording_failed';
        try { this.archive?.setError?.(code); } catch {}
      }
    }

    handleWorkerEvent(name, payload) {
      if (name === 'ready') {
        if (this.closing || this.closed) return;
        if (!this.readyResolved) {
          this.readyResolved = true;
          clearTimeout(this.startupTimer);
          this.resolveReady();
        }
        return;
      }
      if (name === 'startup_error' || name === 'fatal') {
        const code = safeErrorCode(payload, 'media_worker_start_failed');
        this.failStartup(code);
        void this.close().catch(() => {});
        return;
      }
      if (name === 'media.failure') this.handleUnexpectedFailure('media_connection_failed');
      if (name === 'event') {
        try { this.onEvent(payload?.error || null); } catch {}
      }
    }

    handleChildExit(code, signal) {
      this.exit = { code, signal };
      if (!this.childClosed && !this.closing) {
        this.failStartup('media_worker_exited');
        this.handleUnexpectedFailure('media_worker_exited');
      }
    }

    handleChildClose(code, signal) {
      this.childClosed = true;
      this.exit ||= { code, signal };
      clearTimeout(this.startupTimer);
      if (!this.readyResolved) this.failStartup('media_worker_start_failed');
      this.connection?.fail(codedError('media_worker_closed'));
      this.resolveChildClosed?.(this.exit);
      if (!this.closing) this.handleUnexpectedFailure('media_worker_exited');
      void this.cleanupUserData();
    }

    failStartup(code) {
      if (this.readyResolved) return;
      clearTimeout(this.startupTimer);
      this.rejectReady(codedError(code));
    }

    handleUnexpectedFailure(code) {
      if (this.closing || this.failureReported) return;
      this.failureReported = true;
      if (this.readyResolved) {
        try { this.onFailure(codedError(code)); } catch {}
      }
      if (!this.childClosed) void this.close().catch(() => {});
    }

    async call(method, args = [], timeoutMs = 30_000) {
      await this.ready;
      if (this.closing || this.closed || !this.connection || this.connection.closed) throw codedError('cancelled');
      return this.connection.request(method, args, timeoutMs);
    }

    async createOffer() {
      const muted = this.getSpeakersMuted() === true;
      await this.call('peer.setDefaultSpeakersMuted', [muted], 5_000);
      return this.call('peer.createOffer', [], 15_000);
    }

    acceptAnswer(sdp) { return this.call('peer.acceptAnswer', [sdp], 20_000); }
    waitForOpen(timeoutMs) { return this.call('peer.waitForOpen', [timeoutMs], timeoutMs + 5_000); }
    async getStats() {
      const stats = await this.call('peer.getStats', [], 10_000);
      return { ...stats, media_route: launcher.length ? 'custom' : 'direct' };
    }
    stopMicrophone() { return this.call('peer.stopMicrophone', [], 10_000); }
    setSpeakersMuted(muted) { return this.call('peer.setSpeakersMuted', [muted === true], 10_000); }
    flushRecording() { return this.call('peer.flushRecording', [], 10_000); }
    async startMicrophone() {
      this.microphoneSettings = await this.call('peer.startMicrophone', [], 20_000);
      return { stop: () => { if (!this.closed && !this.closing) void this.stopMicrophone().catch(() => {}); } };
    }

    close() {
      if (this.closePromise) return this.closePromise;
      this.closing = true;
      this.closePromise = this.finishClose();
      return this.closePromise;
    }

    async finishClose() {
      clearTimeout(this.startupTimer);
      const child = this.child;
      if (!child) {
        this.closed = true;
        await this.cleanupUserData();
        return;
      }

      if (this.readyResolved && this.connection && !this.connection.closed) {
        try { await this.connection.request('peer.close', [], closeTimeoutMs); }
        catch {
          // A timed out final archive flush leaves the last segment uncertain.
          // Surface that state instead of silently reporting a clean call end.
          if (this.recordingActive) {
            try { this.archive?.setError?.('recording_failed'); } catch {}
          }
        }
      }
      // EOF is the worker's shutdown signal; normal close above completes its
      // final capture flush before the pipe is half-closed.
      try { if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end(); } catch {}

      let exited = this.childClosed;
      if (!exited) exited = !!(await this.waitForChildClose(closeTimeoutMs));
      if (!exited && child.pid) {
        this.signalOwnedGroup('SIGTERM');
        exited = !!(await this.waitForChildClose(terminateGraceMs));
      }
      if (!exited && child.pid) {
        this.signalOwnedGroup('SIGKILL');
        exited = !!(await this.waitForChildClose(killGraceMs));
      }

      this.closed = true;
      this.connection?.fail(codedError('media_worker_closed'));
      if (exited) await this.cleanupUserData();
      else {
        // Never remove a directory that a possibly-live renderer could still use.
        this.child.once('close', () => { void this.cleanupUserData(); });
        throw codedError('media_worker_shutdown_timeout');
      }
    }

    waitForChildClose(timeoutMs) {
      if (this.childClosed) return Promise.resolve(this.exit || { code: 0, signal: null });
      return Promise.race([
        this.childClosedPromise,
        new Promise(resolve => {
          const timer = setTimeout(() => resolve(null), timeoutMs);
          timer.unref?.();
        }),
      ]);
    }

    signalOwnedGroup(signal) {
      const child = this.child;
      if (!child?.pid) return;
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, signal); return; }
        catch (error) { if (error?.code === 'ESRCH') return; }
      }
      try { child.kill(signal); } catch {}
    }

    cleanupUserData() {
      if (!this.cleanupPromise) {
        const directory = this.userDataDirectory;
        this.cleanupPromise = Promise.resolve().then(() => {
          if (directory && path.basename(directory).startsWith('dotdial-media-')) {
            fs.rmSync(directory, { recursive: true, force: true });
          }
        }).catch(() => {});
      }
      return this.cleanupPromise;
    }
  };
}
