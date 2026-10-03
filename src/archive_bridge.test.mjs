import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromiumMedia } from './chromium_media.mjs';

test('recording bridge accepts only the exact media window and closes after flush', async () => {
  const handlers = new Map(), listeners = new Map(), saved = [], errors = [];
  const ipcMain = { handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => listeners.set(key, fn) };
  class Window {
    constructor() {
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = async () => {};
    }
    async loadFile() {}
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const session = { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) };
  const archive = { async save(value) { saved.push(value); return { saved: true }; }, setRecording() {}, setError(code) { errors.push(code); } };
  const Peer = chromiumMedia({ BrowserWindow: Window, session, ipcMain, archive });
  const peer = new Peer(() => {}, () => {}, () => {});
  const save = handlers.get('dotdial-missed-save');
  assert.equal((await save({ sender: {} }, {})).saved, false);
  assert.equal((await save({ sender: peer.window.webContents }, { pcm: 'fixture' })).saved, true);
  listeners.get('dotdial-missed-error')({ sender: {} }, 'storage_full');
  assert.deepEqual(errors, []);
  listeners.get('dotdial-missed-error')({ sender: peer.window.webContents }, 'untrusted text');
  assert.deepEqual(errors, ['recording_failed']);
  await peer.close();
  assert.equal((await save({ sender: peer.window.webContents }, {})).saved, false);
  assert.equal(saved.length, 1); assert.equal(peer.window.isDestroyed(), true);
});
