import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ getUserMedia, sendAudio, addModule, resume, sendStartup } = {}) {
  const nodes = [], contexts = [], tracks = [], constraints = [], deviceQueries = [], errors = [], payloads = [], startup = [];
  function newStream() {
    const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} }; tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  }
  class Context {
    constructor(options) { this.sampleRate = options.sampleRate; this.sinkId = structuredClone(options.sinkId); this.latencyHint = options.latencyHint; this.audioWorklet = { addModule: () => addModule ? addModule() : Promise.resolve() }; this.destination = {}; contexts.push(this); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() { if (resume) await resume(); } async close() { this.closed = true; }
  }
  class Worklet {
    constructor() { this.sent = []; this.port = { postMessage: value => this.sent.push(value) }; nodes.push(this); }
    connect() {} disconnect() {}
  }
  const globals = { window: { DotDialWakePipe: {
    audio(payload) { payloads.push(payload); return sendAudio ? sendAudio(payload) : Promise.resolve({ accepted: true }); },
    error(code) { errors.push(code); },
    startup(payload) { startup.push(structuredClone(payload)); if (sendStartup) sendStartup(payload); },
  } }, AudioContext: Context, AudioWorkletNode: Worklet, URL,
  document: { baseURI: 'file:///synthetic/wake_capture.html' },
  DotDialDevices: { async resolve(value, kind) { deviceQueries.push([value, kind]); return 'exact-device'; } },
  navigator: { mediaDevices: { getUserMedia(options) { constraints.push(options); return getUserMedia ? getUserMedia() : Promise.resolve(newStream()); } } } };
  vm.runInNewContext(fs.readFileSync(new URL('./wake_renderer.js', import.meta.url), 'utf8'), globals, { filename: 'wake_renderer.js' });
  return { api: globals.window.DotDialWake, nodes, contexts, tracks, constraints, deviceQueries, errors, payloads, startup, newStream };
}

test('mac wake renderer sends selected input through a silent 16 kHz context to the acknowledged PCM pipe', async () => {
  const h = harness(); await h.api.start('label:My Microphone');
  assert.equal(h.contexts[0].sampleRate, 16000);
  assert.deepEqual(h.contexts[0].sinkId, { type: 'none' });
  assert.equal(h.contexts[0].latencyHint, 0.1, 'the software-driven sink needs a buffer suited to background analysis');
  assert.deepEqual(h.deviceQueries, [['label:My Microphone', 'audioinput']]);
  assert.equal(h.constraints[0].audio.deviceId.exact, 'exact-device');
  assert.equal(h.constraints[0].video, false);
  const packet = { pcm: new Float32Array(1600).fill(0.125).buffer, sampleRate: 16000 };
  h.nodes[0].port.onmessage({ data: packet }); await tick();
  assert.equal(h.payloads.length, 1); assert.deepEqual(h.errors, []);
  assert.equal(h.payloads[0], packet, 'silent output must preserve the input PCM sent to Python');
  assert.equal(h.nodes[0].sent[0]?.type, 'ack');
  h.api.stop(); assert.equal(h.tracks[0].stopped, true); assert.equal(h.contexts[0].closed, true);
});

test('a late microphone acquisition after stop is closed before it can connect', async () => {
  let resolveMic;
  const h = harness({ getUserMedia: () => new Promise(resolve => { resolveMic = resolve; }) });
  const pending = h.api.start(); await tick();
  assert.equal(typeof resolveMic, 'function'); h.api.stop();
  resolveMic(h.newStream());
  await assert.rejects(pending, { code: 'wake_capture_cancelled' });
  assert.equal(h.tracks[0].stopped, true); assert.equal(h.nodes.length, 0);
});

test('startup diagnostics identify a stalled worklet, microphone or resume without allowing late progress after cancellation', async () => {
  for (const [operation, lastStage] of [['addModule', 'worklet_start'], ['getUserMedia', 'microphone_start'], ['resume', 'resume_start']]) {
    let complete, calls = 0;
    const h = harness({ [operation]: () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
    const pending = h.api.start('label:private microphone'); await tick();
    assert.deepEqual(h.startup.at(-1), { stage: lastStage });
    assert.equal(calls, 1, 'diagnostics must not retry a stalled API');
    assert.equal(h.startup.some(item => item.stage === 'renderer_ready'), false);
    assert.equal(JSON.stringify(h.startup).includes('private'), false);
    h.api.stop();
    assert.equal(h.contexts[0].closed, true, 'cancellation closes the context without awaiting the stalled API');
    assert.ok(h.tracks.every(track => track.stopped));
    const count = h.startup.length;
    complete(operation === 'getUserMedia' ? h.newStream() : undefined);
    await assert.rejects(pending, { code: 'wake_capture_cancelled' });
    assert.equal(h.startup.length, count, 'cancelled generations cannot report a later completed boundary');
    assert.ok(h.tracks.every(track => track.stopped), 'late microphone acquisitions are still stopped');
  }
});

test('startup diagnostics retain only a known renderer API error name and preserve public errors and cleanup', async () => {
  for (const [operation, name, expectedName, code] of [
    ['addModule', 'AbortError', 'AbortError', 'wake_audio_unavailable'],
    ['getUserMedia', 'NotAllowedError', 'NotAllowedError', 'microphone_permission_required'],
    ['resume', 'InvalidStateError', 'InvalidStateError', 'wake_audio_unavailable'],
    ['getUserMedia', 'private microphone name', 'Error', 'wake_audio_unavailable'],
  ]) {
    const error = Object.assign(new Error('private device label, URL and other error details'), { name });
    const h = harness({ [operation]: async () => { throw error; } });
    await assert.rejects(h.api.start(), { code });
    assert.deepEqual(h.startup.at(-1), { stage: 'error', errorName: expectedName });
    assert.equal(JSON.stringify(h.startup).includes('private'), false);
    assert.equal(h.contexts[0].closed, true);
    assert.ok(h.tracks.every(track => track.stopped));
  }
});

test('diagnostic delivery cannot block an otherwise healthy wake capture', async () => {
  const h = harness({ sendStartup() { throw Error('diagnostic delivery unavailable'); } });
  await h.api.start();
  assert.deepEqual(h.startup.at(-1), { stage: 'renderer_ready' });
  assert.deepEqual(h.errors, []);
  h.api.stop();
  assert.equal(h.contexts[0].closed, true);
  assert.ok(h.tracks.every(track => track.stopped));
});

test('wake PCM backpressure is bounded and closes the microphone instead of accumulating audio', async () => {
  const h = harness({ sendAudio: () => new Promise(() => {}) }); await h.api.start();
  for (let n = 0; n < 20; n++) h.nodes[0].port.onmessage({ data: { pcm: new ArrayBuffer(6400), sampleRate: 16000 } });
  await tick();
  assert.equal(h.payloads.length, 4);
  assert.equal(h.tracks[0].stopped, true);
  assert.deepEqual(h.errors, ['wake_audio_backpressure']);
});

test('errors from an earlier capture generation cannot stop a replacement microphone', async () => {
  let rejectOld;
  const h = harness({ sendAudio: () => new Promise((_resolve, reject) => { rejectOld = reject; }) });
  await h.api.start(); h.nodes[0].port.onmessage({ data: { pcm: new ArrayBuffer(6400), sampleRate: 16000 } });
  await tick();
  await h.api.start(); rejectOld(new Error('late transport failure')); await tick();
  assert.equal(h.tracks[0].stopped, true); assert.equal(h.tracks[1].stopped, false); assert.deepEqual(h.errors, []);
  h.api.stop();
});

test('wake worklet credit returns only after the local pipe acknowledges PCM', async () => {
  let acknowledge;
  const h = harness({ sendAudio: () => new Promise(resolve => { acknowledge = resolve; }) });
  await h.api.start();
  h.nodes[0].port.onmessage({ data: { pcm: new ArrayBuffer(6400), sampleRate: 16000 } }); await tick();
  assert.deepEqual(h.nodes[0].sent, []);
  acknowledge({ accepted: true }); await tick();
  assert.equal(h.nodes[0].sent.length, 1); assert.equal(h.nodes[0].sent[0].type, 'ack');
  h.nodes[0].port.onmessage({ data: { error: 'wake_audio_backpressure' } });
  assert.equal(h.tracks[0].stopped, true); assert.deepEqual(h.errors, ['wake_audio_backpressure']);
});

test('wake worklet emits exact bounded 100 ms chunks and never sends speaker output', () => {
  let Processor; const messages = [];
  class Base { constructor() { this.port = { postMessage: message => messages.push(message) }; } }
  vm.runInNewContext(fs.readFileSync(new URL('./wake_worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: Base, sampleRate: 16000,
    registerProcessor(name, impl) { assert.equal(name, 'dotdial-wake'); Processor = impl; },
  });
  const processor = new Processor();
  for (let n = 0; n < 25; n++) {
    const output = new Float32Array(128).fill(1);
    processor.process([[new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.75)]], [[output]]);
    assert.ok(output.every(value => value === 0));
  }
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.equal(message.sampleRate, 16000); assert.equal(message.pcm.byteLength, 6400);
    assert.ok(new Float32Array(message.pcm).every(value => value === 0.5));
  }
  processor.port.onmessage({ data: { type: 'stop' } });
  assert.equal(processor.process([], [[]]), false);
});

test('a stalled renderer cannot accumulate unbounded wake PCM in the worklet MessagePort', () => {
  let Processor; const messages = [];
  class Base { constructor() { this.port = { postMessage: message => messages.push(message) }; } }
  vm.runInNewContext(fs.readFileSync(new URL('./wake_worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: Base, sampleRate: 16000,
    registerProcessor(_name, impl) { Processor = impl; },
  });
  const processor = new Processor();
  for (let n = 0; n < 1250; n++) processor.process([[new Float32Array(128)]], [[]]);
  assert.equal(messages.filter(message => message.pcm).length, 4);
  assert.equal(messages.at(-1).error, 'wake_audio_backpressure');
  assert.equal(messages.length, 5);
  assert.equal(processor.process([], [[]]), false);

  const flowing = new Processor(); messages.length = 0;
  for (let n = 0; n < 1250; n++) {
    const before = messages.length;
    assert.equal(flowing.process([[new Float32Array(128)]], [[]]), true);
    if (messages.length > before) flowing.port.onmessage({ data: { type: 'ack' } });
  }
  assert.equal(messages.length, 100); assert.ok(messages.every(message => message.pcm.byteLength === 6400));
});
