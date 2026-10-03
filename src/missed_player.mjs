import { fileURLToPath, pathToFileURL } from 'node:url';

export class MissedPlayer {
  constructor({ BrowserWindow, session, getOutputDevice = () => "default" }) { Object.assign(this, { BrowserWindow, session, getOutputDevice }); this.generation = 0; }
  async ready() {
    if (this.window && !this.window.isDestroyed()) return this.loaded;
    this.window = new this.BrowserWindow({ show: false, width: 160, height: 100, webPreferences: {
      partition: 'dotdial-missed-player', contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, webSecurity: true,
    } });
    const session = this.session.fromPartition('dotdial-missed-player');
    session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.setPermissionCheckHandler((wc, permission, _origin, details) => wc === this.window.webContents && permission === 'media' && details.mediaType === 'audio');
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.loaded = this.window.loadFile(fileURLToPath(new URL('./missed_player.html', import.meta.url)));
    return this.loaded;
  }
  async play(file, durationMs) {
    const generation = ++this.generation;
    await this.ready();
    if (generation !== this.generation) return false;
    const timeoutMs = Math.max(15000, durationMs + 15000);
    let timer;
    try {
      return await Promise.race([
        this.window.webContents.executeJavaScript(`window.MissedPlayer.play(${JSON.stringify(pathToFileURL(file).href)}, ${timeoutMs}, ${JSON.stringify(this.getOutputDevice())})`, true),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('playback_timeout')), timeoutMs + 500); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async stop() {
    this.generation++;
    if (!this.window || this.window.isDestroyed()) return;
    let timer;
    const window = this.window;
    try {
      await Promise.race([
        this.loaded.then(() => !window.isDestroyed() && window.webContents.executeJavaScript('window.MissedPlayer?.stop()', true)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('stop_timeout')), 1500); }),
      ]);
    } catch { if (!window.isDestroyed()) window.destroy(); }
    finally { clearTimeout(timer); }
  }
  async close() { await this.stop(); if (this.window && !this.window.isDestroyed()) this.window.destroy(); }
}
