'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 10 * 1024 * 1024;
const messages = {
  sound_file_invalid: 'Choose a local MP3 or WAV file.',
  sound_file_unavailable: 'The selected sound file could not be read. Choose it again.',
  sound_file_too_large: 'Choose a sound file no larger than 10 MiB.',
  sound_file_too_long: 'Choose a sound no longer than 30 seconds.',
  sound_decode_failed: 'This file could not be decoded as MP3 or WAV.',
  sound_decode_cancelled: 'Sound preview stopped.',
  sound_decode_busy: 'A sound is still being prepared. Try again in a moment.',
};
const failure = code => Object.assign(new Error(messages[code] || messages.sound_decode_failed), { code });

async function readSoundFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\u0000-\u001f\u007f]/u.test(file) || !/\.(mp3|wav)$/iu.test(file)) throw failure('sound_file_invalid');
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure('sound_file_invalid');
    if (stat.size > MAX_BYTES) throw failure('sound_file_too_large');
    const bytes = Buffer.alloc(Math.min(MAX_BYTES + 1, stat.size + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > stat.size || length > MAX_BYTES) throw failure('sound_file_too_large');
    const data = bytes.subarray(0, length), wav = /\.wav$/iu.test(file);
    const valid = wav ? data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE'
      : data.toString('ascii', 0, 3) === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
    if (!valid) throw failure('sound_decode_failed');
    return { bytes: data, mime: wav ? 'audio/wav' : 'audio/mpeg' };
  } catch (error) { throw messages[error.code] ? error : failure('sound_file_unavailable'); }
  finally { await handle?.close(); }
}

class CustomSoundCache {
  constructor({ BrowserWindow, session, runtimeDir }) {
    Object.assign(this, { BrowserWindow, session, runtimeDir });
    this.pending = new Map(); this.files = new Map(); this.windows = new Set(); this.closed = false;
  }
  async prepare(file) {
    if (this.closed) throw failure('sound_decode_cancelled');
    const { bytes, mime } = await readSoundFile(file);
    if (this.closed) throw failure('sound_decode_cancelled');
    const key = crypto.createHash('sha256').update(bytes).digest('hex');
    if (this.files.has(key)) return this.files.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= 2) throw failure('sound_decode_busy');
    this.directory ??= fs.mkdtempSync(path.join(this.runtimeDir, 'sound-cache-'));
    fs.chmodSync(this.directory, 0o700);
    const pending = this.decode(bytes, mime).then(wave => {
      if (this.closed) throw failure('sound_decode_cancelled');
      const target = path.join(this.directory, key + '.wav');
      fs.writeFileSync(target, wave, { mode: 0o600, flag: 'wx' });
      this.files.set(key, target);
      return target;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }
  async decode(bytes, mime) {
    const partition = 'dotdial-sound-decode';
    const window = new this.BrowserWindow({ show: false, webPreferences: {
      partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    this.windows.add(window);
    const local = this.session.fromPartition(partition);
    local.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    local.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    let timer;
    try {
      const result = await Promise.race([
        (async () => {
          await window.loadFile(path.join(__dirname, 'custom_sound.html'));
          if (this.closed || window.isDestroyed()) throw failure('sound_decode_cancelled');
          return window.webContents.executeJavaScript(`window.CustomSound.decode(${JSON.stringify(bytes.toString('base64'))}, ${JSON.stringify(mime)})`);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('sound_decode_failed')), 12_000); }),
      ]);
      if (result?.error) throw failure(result.error);
      if (!(result instanceof ArrayBuffer) || result.byteLength < 44 || result.byteLength > 30 * 48000 * 4 + 44) throw failure('sound_decode_failed');
      return Buffer.from(result);
    } catch (error) { throw messages[error.code] ? error : failure('sound_decode_failed'); }
    finally { clearTimeout(timer); this.windows.delete(window); if (!window.isDestroyed()) window.destroy(); }
  }
  async close() {
    this.closed = true;
    for (const window of this.windows) if (!window.isDestroyed()) window.destroy();
    await Promise.allSettled(this.pending.values());
    if (this.directory) fs.rmSync(this.directory, { recursive: true, force: true });
    this.files.clear();
  }
}

module.exports = { CustomSoundCache, readSoundFile, MAX_BYTES };
