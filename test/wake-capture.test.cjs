'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWakeCaptureFactory } = require('../src/wake_capture.cjs');

function harness(execute = async () => ({ sampleRate: 16000 }), { loadFile = async () => {}, ...factoryOptions } = {}) {
  const windows = [], handlers = new Map(), notifications = new Map(); let checkPermission, requestPermission;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = fn => { this.open = fn; };
      this.webContents.executeJavaScript = script => { this.script = script; return execute(); };
      windows.push(this);
    }
    async loadFile(file) { this.file = file; return loadFile(file); }
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
    ...factoryOptions,
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

test('closing during getUserMedia destroys the window immediately and preserves cancelled startup diagnostics', async () => {
  let finish, nowMs = 5000;
  const h = harness(() => new Promise(resolve => { finish = resolve; }), { now: () => nowMs });
  const capture = h.factory({ onAudio: async () => {} });
  await new Promise(resolve => setImmediate(resolve));
  nowMs = 5123;
  const closing = capture.close();
  assert.equal(h.windows[0].isDestroyed(), true);
  await assert.rejects(capture.ready, { code: 'wake_capture_cancelled' });
  assert.equal(capture.startupDiagnostics.state, 'cancelled');
  assert.equal(capture.startupDiagnostics.timedOut, false);
  assert.equal(capture.startupDiagnostics.closedAtMs, 123);
  assert.equal(capture.startupDiagnostics.readyAtMs, null);
  const terminal = structuredClone(capture.startupDiagnostics);
  const sender = h.windows[0].webContents;
  nowMs = 9000;
  h.notifications.get('dotdial-wake-startup')({ sender, senderFrame: sender.mainFrame }, { stage: 'context_start' });
  finish({ sampleRate: 16000 }); await closing;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(capture.closed, true);
  assert.deepEqual(capture.startupDiagnostics, terminal);
});

const rendererStages = [
  'context_start', 'context_ready', 'worklet_start', 'worklet_ready',
  'device_start', 'device_ready', 'microphone_start', 'microphone_ready',
  'graph_ready', 'resume_start', 'resume_ready', 'renderer_ready',
];
const flush = () => new Promise(resolve => setImmediate(resolve));

test('wake startup timeout retains the last unfinished stage at the unchanged fifteen-second limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, nowMs = 20000;
  const errors = [];
  const h = harness(() => new Promise(resolve => { finish = resolve; }), { now: () => nowMs });
  const capture = h.factory({ onAudio: async () => {}, onError: code => errors.push(code) });
  t.after(() => capture.close());
  await flush();
  const sender = h.windows[0].webContents, event = { sender, senderFrame: sender.mainFrame };
  const notify = h.notifications.get('dotdial-wake-startup');
  assert.equal(capture.startupDiagnostics.timeoutMs, 15000);
  assert.deepEqual(capture.startupDiagnostics.events.map(item => item.stage), [
    'created', 'document_loading', 'document_ready', 'renderer_start',
  ]);
  for (const stage of rendererStages.slice(0, 7)) {
    nowMs += 25;
    notify(event, { stage });
  }
  assert.equal(capture.startupDiagnostics.lastStage, 'microphone_start');
  assert.equal(capture.startupDiagnostics.events.at(-1).atMs, 175);

  nowMs = 34999;
  t.mock.timers.tick(14999);
  await flush();
  assert.equal(capture.startupDiagnostics.state, 'pending');
  assert.equal(capture.closed, false);
  nowMs = 35000;
  t.mock.timers.tick(1);
  await assert.rejects(capture.ready, { code: 'wake_audio_unavailable' });
  assert.equal(capture.closed, true);
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.deepEqual(errors, ['wake_audio_unavailable']);
  assert.equal(capture.startupDiagnostics.state, 'failed');
  assert.equal(capture.startupDiagnostics.timedOut, true);
  assert.equal(capture.startupDiagnostics.lastStage, 'microphone_start');
  assert.equal(capture.startupDiagnostics.closedAtMs, 15000);
  assert.equal(capture.startupDiagnostics.elapsedMs, 15000);
  assert.equal(capture.startupDiagnostics.readyAtMs, null);
  const terminal = structuredClone(capture.startupDiagnostics);
  nowMs = 40000;
  notify(event, { stage: 'microphone_ready' });
  notify(event, { stage: 'error', errorName: 'NotAllowedError' });
  finish({ sampleRate: 16000 });
  t.mock.timers.tick(5000);
  await flush();
  assert.deepEqual(capture.startupDiagnostics, terminal);
  assert.deepEqual(errors, ['wake_audio_unavailable']);
});

test('wake startup notifications isolate owners, reject private payloads and bound ordered progress', async t => {
  const h = harness(() => new Promise(() => {}), { now: () => 1000 });
  const captures = [h.factory({ onAudio: async () => {} }), h.factory({ onAudio: async () => {} })];
  t.after(() => Promise.all(captures.map(capture => capture.close())));
  await flush();
  const sender = h.windows[0].webContents, other = h.windows[1].webContents;
  const stranger = { mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  const notify = h.notifications.get('dotdial-wake-startup');
  const before = captures.map(capture => structuredClone(capture.startupDiagnostics));
  for (const wrongOwner of [
    { sender }, { sender, senderFrame: null }, { sender, senderFrame: {} },
    { sender: stranger, senderFrame: stranger.mainFrame },
    { sender: other, senderFrame: sender.mainFrame },
  ]) notify(wrongOwner, { stage: 'context_start' });
  for (const payload of [
    undefined, null, [], {}, 'context_start', { stage: 'unknown_stage' },
    { stage: 'context_start', deviceId: 'private-device-id' },
    { stage: 'context_start', atMs: 123 },
    { stage: 'error', errorName: 'NotAllowedError', message: 'private-error-message' },
    { stage: 'error', errorName: 'private-error-message' },
    { stage: 'error' },
  ]) notify(event, payload);
  assert.deepEqual(captures.map(capture => capture.startupDiagnostics), before);

  notify(event, { stage: 'context_start' });
  notify(event, { stage: 'context_ready' });
  const progressed = structuredClone(captures[0].startupDiagnostics);
  notify(event, { stage: 'context_start' });
  notify(event, { stage: 'context_ready' });
  assert.deepEqual(captures[0].startupDiagnostics, progressed);
  for (const stage of rendererStages.slice(2)) notify(event, { stage });
  for (let index = 0; index < 1000; index++) {
    notify(event, { stage: rendererStages[index % rendererStages.length] });
  }
  const diagnostics = captures[0].startupDiagnostics;
  assert.equal(diagnostics.lastStage, 'renderer_ready');
  assert.equal(diagnostics.state, 'pending');
  assert.deepEqual(diagnostics.events.slice(-rendererStages.length).map(item => item.stage), rendererStages);
  assert.ok(diagnostics.events.length <= 24);
  for (const entry of diagnostics.events) {
    assert.deepEqual(Object.keys(entry).sort(), ['atMs', 'stage']);
    assert.equal(Number.isFinite(entry.atMs), true);
    assert.ok(entry.atMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-|USB Headset/);
  assert.deepEqual(captures[1].startupDiagnostics, before[1]);
});

test('wake startup diagnostics distinguish pre-ready PCM from readiness and retain only safe renderer errors', async t => {
  let nowMs = 4000;
  const pending = [], audio = [], errors = [];
  const h = harness(() => new Promise((resolve, reject) => pending.push({ resolve, reject })), { now: () => nowMs });
  const capture = h.factory({ onAudio: async bytes => audio.push(bytes.length) });
  const failed = h.factory({ onAudio: async () => {}, onError: code => errors.push(code) });
  t.after(() => Promise.all([capture.close(), failed.close()]));
  await flush();
  const sender = h.windows[0].webContents, failedSender = h.windows[1].webContents;
  const event = { sender, senderFrame: sender.mainFrame };
  const failedEvent = { sender: failedSender, senderFrame: failedSender.mainFrame };
  const save = h.handlers.get('dotdial-wake-audio'), notify = h.notifications.get('dotdial-wake-startup');
  const pcm = () => ({ sampleRate: 16000, pcm: new ArrayBuffer(6400) });
  assert.equal(capture.startupDiagnostics.firstPcmAtMs, null);
  assert.equal(capture.startupDiagnostics.pcmChunksBeforeReady, 0);
  nowMs = 4040;
  assert.equal((await save({ sender, senderFrame: {} }, pcm())).accepted, false);
  assert.equal(capture.startupDiagnostics.firstPcmAtMs, null);
  assert.equal((await save(event, pcm())).accepted, true);
  nowMs = 4080;
  assert.equal((await save(event, pcm())).accepted, true);
  assert.equal(capture.startupDiagnostics.firstPcmAtMs, 40);
  assert.equal(capture.startupDiagnostics.pcmChunksBeforeReady, 2);
  assert.equal(capture.startupDiagnostics.state, 'pending');
  assert.equal(capture.startupDiagnostics.readyAtMs, null);
  assert.equal(failed.startupDiagnostics.firstPcmAtMs, null);
  assert.equal(failed.startupDiagnostics.pcmChunksBeforeReady, 0);

  for (const stage of rendererStages.slice(0, 7)) notify(failedEvent, { stage });
  notify(failedEvent, { stage: 'error', errorName: 'NotAllowedError' });
  assert.equal(failed.startupDiagnostics.state, 'pending');
  assert.equal(failed.startupDiagnostics.lastStage, 'microphone_start');
  assert.equal(failed.startupDiagnostics.rendererErrorName, 'NotAllowedError');
  const beforeInvalidError = structuredClone(failed.startupDiagnostics);
  notify(failedEvent, { stage: 'error', errorName: 'Error: private-device-id' });
  notify(failedEvent, { stage: 'error', errorName: 'NotAllowedError' });
  notify(failedEvent, { stage: 'error', errorName: 'TypeError' });
  assert.deepEqual(failed.startupDiagnostics, beforeInvalidError);
  nowMs = 4100;
  pending[1].reject(new Error('private-error-message: /Users/fixture/private-recording.wav'));
  await assert.rejects(failed.ready, error => {
    assert.equal(error.code, 'wake_audio_unavailable');
    assert.equal(error.message, 'wake_audio_unavailable');
    return true;
  });
  assert.equal(failed.startupDiagnostics.state, 'failed');
  assert.equal(failed.startupDiagnostics.timedOut, false);
  assert.equal(failed.startupDiagnostics.lastStage, 'microphone_start');
  assert.equal(failed.startupDiagnostics.rendererErrorName, 'NotAllowedError');
  assert.equal(failed.startupDiagnostics.closedAtMs, 100);
  assert.deepEqual(errors, ['wake_audio_unavailable']);
  assert.doesNotMatch(JSON.stringify(failed.startupDiagnostics), /private-|\/Users/);

  nowMs = 4120;
  pending[0].resolve({ sampleRate: 16000 });
  assert.equal(await capture.ready, capture);
  assert.equal(capture.startupDiagnostics.state, 'ready');
  assert.equal(capture.startupDiagnostics.readyAtMs, 120);
  assert.equal(capture.startupDiagnostics.lastStage, 'ready');
  assert.equal(capture.startupDiagnostics.rendererErrorName, null);
  nowMs = 4220;
  const afterReady = structuredClone(capture.startupDiagnostics);
  notify(event, { stage: 'context_start' });
  notify(event, { stage: 'error', errorName: 'NotAllowedError' });
  assert.deepEqual(capture.startupDiagnostics, afterReady);
  assert.equal((await save(event, pcm())).accepted, true);
  assert.equal(capture.startupDiagnostics.firstPcmAtMs, 40);
  assert.equal(capture.startupDiagnostics.pcmChunksBeforeReady, 2);
  assert.deepEqual(audio, [6400, 6400, 6400]);
});
