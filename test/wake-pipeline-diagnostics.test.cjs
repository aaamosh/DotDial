'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { observeWakeAudioClock } = require('../scripts/wake-pipeline-diagnostics.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(send = async method => method === 'WebAudio.enable' ? {} : {
  realtimeData: { currentTime: 1, renderCapacity: 0.01, callbackIntervalMean: 0.008, callbackIntervalVariance: 0 },
}) {
  const web = new EventEmitter(), debug = new EventEmitter(), calls = [];
  let attached = false, detachCount = 0;
  debug.isAttached = () => attached;
  debug.attach = version => { assert.equal(version, '1.3'); attached = true; };
  debug.detach = () => { attached = false; detachCount++; };
  debug.sendCommand = (method, params) => { calls.push({ method, params }); return send(method, params); };
  web.debugger = debug;
  const context = () => debug.emit('message', {}, 'WebAudio.contextCreated', {
    context: { contextId: 'synthetic-context', contextState: 'running', sampleRate: 16000, url: 'private fixture' },
  });
  return { web, debug, calls, context, detaches: () => detachCount };
}

test('wake clock diagnostics retain first and latest bounded samples and detach without touching audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let now = 0;
  const observer = observeWakeAudioClock(f.web, { now: () => now });
  t.after(observer.close); f.context(); await flush();
  for (let index = 0; index < 70; index++) { now += 500; t.mock.timers.tick(500); await flush(); }
  const report = observer.snapshot();
  assert.equal(report.samples.length, 64); assert.equal(report.samples[0].atMs, 0);
  assert.equal(report.samples.at(-1).atMs, 35000); assert.equal(report.samples.at(-1).currentTime, 1);
  assert.deepEqual(report.errors, []); assert.equal(report.events[0].state, 'running');
  assert.equal(JSON.stringify(report).includes('private fixture'), false);
  assert.ok(f.calls.every(({ method }) => ['WebAudio.enable', 'WebAudio.getRealtimeData'].includes(method)));
  report.samples[0].currentTime = 999; assert.equal(observer.snapshot().samples[0].currentTime, 1);
  const count = f.calls.length; observer.close(); observer.close();
  t.mock.timers.tick(5000); await flush();
  assert.equal(f.calls.length, count); assert.equal(f.detaches(), 1); assert.equal(f.debug.listenerCount('message'), 0);
});

test('a stalled clock probe times out once, stops polling and ignores its late result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveProbe;
  const f = fixture(method => method === 'WebAudio.enable' ? Promise.resolve({}) : new Promise(resolve => { resolveProbe = resolve; }));
  const observer = observeWakeAudioClock(f.web); t.after(observer.close);
  f.context(); await flush();
  t.mock.timers.tick(1000); await flush(); assert.equal(f.calls.length, 2);
  t.mock.timers.tick(500); await flush();
  assert.deepEqual(observer.snapshot().errors.map(({ stage, code }) => ({ stage, code })), [
    { stage: 'WebAudio.getRealtimeData', code: 'timeout' },
  ]);
  t.mock.timers.tick(5000); await flush(); assert.equal(f.calls.length, 2); assert.equal(f.detaches(), 1);
  resolveProbe({ realtimeData: { currentTime: 2 } }); await flush();
  assert.deepEqual(observer.snapshot().samples, []);
});

test('unsupported WebAudio reports a bounded diagnostic error; close cancels an unresolved probe', async t => {
  const f = fixture(async () => { throw Error("WebAudio.enable wasn't found at private fixture"); });
  const observer = observeWakeAudioClock(f.web); await flush();
  assert.equal(observer.snapshot().errors[0].code, 'unsupported_protocol');
  assert.equal(JSON.stringify(observer.snapshot()).includes('private fixture'), false); assert.equal(f.detaches(), 1);
  const g = fixture(method => method === 'WebAudio.enable' ? Promise.resolve({}) : new Promise(() => {}));
  const pending = observeWakeAudioClock(g.web); g.context(); await flush();
  g.web.emit('destroyed'); await flush();
  assert.equal(pending.snapshot().active, false); assert.deepEqual(pending.snapshot().errors, []);
  assert.equal(g.detaches(), 1); assert.equal(g.calls.length, 2);
});
