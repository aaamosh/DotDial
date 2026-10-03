import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromiumMedia } from './chromium_media.mjs';

function harness() {
  let window, requestPermission, checkPermission;
  const pending = new Promise(() => {});
  class Window {
    constructor(options) {
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = () => pending;
      window = this;
    }
    async loadFile() {}
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const session = { fromPartition: () => ({
    setPermissionRequestHandler: handler => { requestPermission = handler; },
    setPermissionCheckHandler: handler => { checkPermission = handler; },
  }) };
  const Peer = chromiumMedia({ BrowserWindow: Window, session });
  const peer = new Peer(() => {}, () => {}, () => {});
  return { peer, window, requestPermission, checkPermission };
}

test('closing Chromium releases pending microphone work immediately', async () => {
  const h = harness();
  const microphone = h.peer.startMicrophone();
  await new Promise(resolve => setImmediate(resolve));
  h.peer.close();
  await assert.rejects(microphone, { code: 'cancelled' });
  assert.equal(h.window.destroyed, true);
  assert.equal(h.window.options.show, false);
  assert.equal(h.window.options.webPreferences.backgroundThrottling, false);
});

test('media permission is limited to audio in the exact local media window', () => {
  const h = harness();
  const allowed = (wc, mediaTypes, permission = 'media') => {
    let answer;
    h.requestPermission(wc, permission, value => { answer = value; }, { mediaTypes });
    return answer;
  };
  assert.equal(allowed(h.window.webContents, ['audio']), true);
  assert.equal(allowed({}, ['audio']), false);
  assert.equal(allowed(h.window.webContents, ['audio', 'video']), false);
  assert.equal(allowed(h.window.webContents, ['video']), false);
  assert.equal(allowed(h.window.webContents, ['audio'], 'display-capture'), false);
  h.peer.close();
  assert.equal(allowed(h.window.webContents, ['audio']), false);
});
