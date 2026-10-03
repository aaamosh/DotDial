import { fileURLToPath } from 'node:url';

const mediaFile = fileURLToPath(new URL('./media.html', import.meta.url));
const preloadFile = fileURLToPath(new URL('./media_preload.cjs', import.meta.url));

export function chromiumMedia({ BrowserWindow, session, ipcMain, archive, getSpeakersMuted = () => false, mediaOptions = {} }) {
  const senders = new Set();
  if (archive && ipcMain) {
    ipcMain.handle('dotdial-missed-save', async (event, payload) => {
      if (!senders.has(event.sender)) return { saved: false, code: 'recording_unavailable' };
      try { return await archive.save(payload); }
      catch (error) { return { saved: false, code: error.code === 'storage_full' ? 'storage_full' : 'recording_failed' }; }
    });
    ipcMain.on('dotdial-missed-recording', (event, active) => { if (senders.has(event.sender)) archive.setRecording(active); });
    ipcMain.on('dotdial-missed-error', (event, code) => {
      if (senders.has(event.sender)) archive.setError(['recording_unavailable', 'storage_full'].includes(code) ? code : 'recording_failed');
    });
  }
  return class ChromiumPeer {
    constructor(_onEvent, _onLevel, onFailure) {
      this.closed = false;
      this.closedSignal = new Promise(resolve => { this.resolveClosed = resolve; });
      this.window = new BrowserWindow({ show: false, width: 160, height: 100, webPreferences: {
        partition: 'dotdial-media', contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false, webSecurity: true,
        ...(archive ? { preload: preloadFile } : {}),
      } });
      if (archive) senders.add(this.window.webContents);
      const audioSession = session.fromPartition('dotdial-media');
      audioSession.setPermissionRequestHandler((wc, permission, callback, details) => {
        callback(!this.closed && wc === this.window.webContents && permission === 'media' &&
          details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
      });
      audioSession.setPermissionCheckHandler((wc, permission, _origin, details) =>
        !this.closed && wc === this.window.webContents && permission === 'media' && details.mediaType === 'audio');
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.window.webContents.on('will-navigate', event => event.preventDefault());
      this.window.webContents.on('render-process-gone', () => { if (!this.closed) onFailure(); });
      this.ready = this.window.loadFile(mediaFile);
    }

    async invoke(method, ...args) {
      await this.ready;
      if (this.closed) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      const result = await Promise.race([
        this.window.webContents.executeJavaScript(`window.DotDialMedia[${JSON.stringify(method)}](...${JSON.stringify(args)})`, true).then(value => ({ value })),
        this.closedSignal.then(() => ({ closed: true })),
      ]);
      if (result.closed) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      return result.value;
    }

    async createOffer() {
      await this.invoke('configure', mediaOptions);
      if (archive) await this.setSpeakersMuted(getSpeakersMuted());
      return this.invoke('createOffer');
    }
    acceptAnswer(sdp) { return this.invoke('acceptAnswer', sdp); }
    waitForOpen(timeout) { return this.invoke('waitForOpen', timeout); }
    getStats() { return this.invoke('stats'); }
    stopMicrophone() { return this.invoke('stopMicrophone'); }
    setSpeakersMuted(muted) { return this.invoke('setSpeakersMuted', muted === true); }
    flushRecording() { return this.invoke('flushRecording'); }
    async startMicrophone() {
      this.microphoneSettings = await this.invoke('startMicrophone');
      return { stop: () => { if (!this.closed) void this.stopMicrophone().catch(() => {}); } };
    }
    close() {
      if (this.closed) return this.closing;
      this.closed = true;
      this.resolveClosed();
      const destroy = () => {
        senders.delete(this.window.webContents);
        if (archive) archive.setRecording(false);
        if (!this.window.isDestroyed()) this.window.destroy();
      };
      if (!archive || this.window.isDestroyed()) { destroy(); return; }
      // The renderer stops microphone/playout synchronously, then flushes only
      // the final already-recorded remote fragment before its window is released.
      this.closing = (async () => {
        let timeout;
        try {
          await Promise.race([
            this.window.webContents.executeJavaScript('window.DotDialMedia?.close()', true),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('flush_timeout')), 2500); }),
          ]);
        } catch { if (archive.recording) archive.setError('recording_failed'); }
        finally { clearTimeout(timeout); destroy(); }
      })();
      return this.closing;
    }
  };
}
