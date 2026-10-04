'use strict';

const path = require('node:path');
const RATE = 16000;
const MAX_CHUNK_BYTES = 1600 * 4;
const failure = code => Object.assign(new Error(code), { code });
const safeCode = error => /^[a-z_]{1,80}$/.test(error?.code || '') ? error.code : 'wake_audio_unavailable';

// macOS microphone permission belongs to DotDial's signed Electron app. Python
// receives only this bounded local PCM pipe and never opens CoreAudio itself.
function createWakeCaptureFactory({ BrowserWindow, session, ipcMain, getMicrophoneDeviceId = () => 'default', startupTimeoutMs = 15000 }) {
  const captures = new Map();
  const owner = event => {
    const capture = captures.get(event.sender);
    if (!capture || capture.closed || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) return null;
    return capture;
  };
  ipcMain.handle('dotdial-wake-audio', async (event, payload) => {
    const capture = owner(event);
    if (!capture) return { accepted: false, code: 'wake_capture_cancelled' };
    if (payload?.sampleRate !== RATE || !(payload.pcm instanceof ArrayBuffer) ||
        payload.pcm.byteLength < 4 || payload.pcm.byteLength > MAX_CHUNK_BYTES || payload.pcm.byteLength % 4) {
      capture.fail('wake_audio_protocol_error');
      return { accepted: false, code: 'wake_audio_protocol_error' };
    }
    try {
      await capture.onAudio(Buffer.from(payload.pcm));
      return { accepted: !capture.closed, code: capture.closed ? 'wake_capture_cancelled' : undefined };
    } catch (error) {
      const code = safeCode(error);
      capture.fail(code);
      return { accepted: false, code };
    }
  });
  ipcMain.on('dotdial-wake-error', (event, code) => {
    const capture = owner(event);
    if (capture) capture.fail(safeCode({ code }));
  });
  const audioSession = session.fromPartition('dotdial-wake');
  audioSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(captures.has(wc) && permission === 'media' && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
  });
  audioSession.setPermissionCheckHandler((wc, permission, _origin, details) =>
    captures.has(wc) && permission === 'media' && details.mediaType === 'audio');

  return ({ onAudio, onError = () => {} }) => {
    if (typeof onAudio !== 'function') throw failure('wake_audio_unavailable');
    const window = new BrowserWindow({ show: false, width: 160, height: 100, webPreferences: {
      partition: 'dotdial-wake', contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, webSecurity: true, preload: path.join(__dirname, 'wake_preload.cjs'),
    } });
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const capture = {
      window, closed: false, onAudio,
      close() {
        if (this.closed) return Promise.resolve();
        this.closed = true;
        captures.delete(window.webContents);
        resolveClosed();
        // Wake audio has no archive to flush. Destroy synchronously even during
        // a pending getUserMedia so a stale acquisition cannot keep a mic alive.
        if (!window.isDestroyed()) window.destroy();
        return Promise.resolve();
      },
      fail(code) {
        if (this.closed) return;
        void this.close();
        try { onError(code); } catch {}
      },
    };
    captures.set(window.webContents, capture);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => capture.fail('wake_audio_unavailable'));
    window.on('unresponsive', () => capture.fail('wake_audio_unavailable'));
    window.on('closed', () => { if (!capture.closed) capture.fail('wake_audio_unavailable'); });
    let timer;
    capture.ready = Promise.race([
      Promise.resolve().then(() => window.loadFile(path.join(__dirname, 'wake_capture.html'))).then(() => {
        if (capture.closed) throw failure('wake_capture_cancelled');
        return window.webContents.executeJavaScript(`window.DotDialWake.start(${JSON.stringify(getMicrophoneDeviceId())})`, true);
      }),
      closed.then(() => { throw failure('wake_capture_cancelled'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('wake_audio_unavailable')), startupTimeoutMs); }),
    ]).then(() => {
      if (capture.closed) throw failure('wake_capture_cancelled');
      return capture;
    }).catch(error => {
      capture.fail(safeCode(error));
      throw failure(safeCode(error));
    }).finally(() => clearTimeout(timer));
    capture.ready.catch(() => {});
    return capture;
  };
}

module.exports = { createWakeCaptureFactory, MAX_CHUNK_BYTES };
