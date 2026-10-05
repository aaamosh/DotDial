'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWakeCaptureFactory } = require('../src/wake_capture.cjs');

function harness(execute = async () => ({ sampleRate: 16000 })) {
  const windows = [], handlers = new Map(), notifications = new Map(); let checkPermission, requestPermission;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = fn => { this.open = fn; };
      this.webContents.executeJavaScript = script => { this.script = script; return execute(); };
      windows.push(this);
    }
    async loadFile(file) { this.file = file; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const factory = createWakeCaptureFactory({ BrowserWindow,
    session: { fromPartition() { return {
      setPermissionRequestHandler(fn) { requestPermission = fn; },
      setPermissionCheckHandler(fn) { checkPermission = fn; },
    }; } },
    ipcMain: { handle(name, fn) { handlers.set(name, fn); }, on(name, fn) { notifications.set(name, fn); } },
    getMicrophoneDeviceId: () => 'label:USB Headset',
  });
  return { factory, windows, handlers, notifications,
    check: (...args) => checkPermission(...args), request: (...args) => requestPermission(...args) };
}

test('wake capture grants only its exact local audio window and accepts bounded owner PCM', async t => {
  const h = harness(); const audio = [];
  const capture = h.factory({ onAudio: async bytes => audio.push(bytes) }); t.after(() => capture.close());
  await capture.ready;
  const window = h.windows[0], sender = window.webContents, event = { sender, senderFrame: sender.mainFrame };
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.match(window.script, /label:USB Headset/);
  assert.equal(h.check(sender, 'media', '', { mediaType: 'audio' }), true);
  assert.equal(h.check(sender, 'media', '', { mediaType: 'video' }), false);
  assert.equal(h.check({}, 'media', '', { mediaType: 'audio' }), false);
  let decision;
  h.request(sender, 'media', allowed => { decision = allowed; }, { mediaTypes: ['audio', 'video'] });
  assert.equal(decision, false);
  const save = h.handlers.get('dotdial-wake-audio');
  assert.equal((await save(event, { sampleRate: 16000, pcm: new ArrayBuffer(6400) })).accepted, true);
  assert.equal(audio[0].length, 6400);
  assert.equal((await save({ sender: {}, senderFrame: {} }, { sampleRate: 16000, pcm: new ArrayBuffer(4) })).accepted, false);
  assert.equal((await save({ sender, senderFrame: {} }, { sampleRate: 16000, pcm: new ArrayBuffer(4) })).accepted, false);
  assert.equal(audio.length, 1);
  await capture.close();
  assert.equal(h.check(sender, 'media', '', { mediaType: 'audio' }), false);
  assert.equal((await save(event, { sampleRate: 16000, pcm: new ArrayBuffer(4) })).accepted, false);
});

test('a malformed wake chunk closes only its owned capture and reports one stable error', async () => {
  const h = harness(); const errors = [];
  const capture = h.factory({ onAudio: () => assert.fail('invalid chunk reached pipe'), onError: code => errors.push(code) });
  await capture.ready;
  const sender = h.windows[0].webContents;
  const result = await h.handlers.get('dotdial-wake-audio')({ sender, senderFrame: sender.mainFrame }, { sampleRate: 48000, pcm: new ArrayBuffer(6404) });
  assert.equal(result.code, 'wake_audio_protocol_error');
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.deepEqual(errors, ['wake_audio_protocol_error']);
});

test('closing during getUserMedia destroys the window immediately and rejects readiness', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const capture = h.factory({ onAudio: async () => {} });
  await new Promise(resolve => setImmediate(resolve));
  const closing = capture.close();
  assert.equal(h.windows[0].isDestroyed(), true);
  await assert.rejects(capture.ready, { code: 'wake_capture_cancelled' });
  finish({ sampleRate: 16000 }); await closing;
  assert.equal(capture.closed, true);
});
