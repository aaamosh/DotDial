import test from 'node:test';
import assert from 'node:assert/strict';
import diagnosticModule from './audio_diagnostics.js';
const { AudioDiagnostics } = diagnosticModule;
const reports = (...rows) => new Map(rows.map(r => [r.id, r]));
const inbound = (id, timestamp, count, other = {}) => ({ id, type: 'inbound-rtp', kind: 'audio', timestamp,
  packetsReceived: count / 960, totalSamplesReceived: count, concealedSamples: 0, silentConcealedSamples: 0, ...other });

test('all incoming audio streams count regardless of report ordering', () => {
  const d = new AudioDiagnostics();
  const a = inbound('a', 1000, 48000, { jitter: .03, audioLevel: .3 });
  const b = inbound('b', 1000, 96000, { jitter: .01, audioLevel: .1 });
  const result = d.collect(reports(a, b));
  assert.equal(result.totalSamplesReceived, 144000);
  assert.equal(result.packetsReceived, 150);
  assert.equal(result.jitter, .03);
  assert.equal(result.audioLevel, .3);
  assert.equal(result.inbound_streams.length, 2);
});

test('intervals separate voiced concealment from silence and compute buffer delay in ms', () => {
  const d = new AudioDiagnostics();
  d.collect(reports(inbound('a', 1000, 48000, { jitterBufferEmittedCount: 48000, jitterBufferDelay: 9600 })));
  const result = d.collect(reports(inbound('a', 3000, 144000, { concealedSamples: 4000, silentConcealedSamples: 1000,
    jitterBufferEmittedCount: 144000, jitterBufferDelay: 38400, jitterBufferTargetDelay: 48000 })));
  assert.equal(result.recent_intervals[0].samples, 96000);
  assert.equal(result.recent_intervals[0].concealed_voiced, 3000);
  assert.equal(result.recent_intervals[0].buffer_ms, 300);
  assert.equal(result.recent_intervals[0].duration_ms, 2000);
  const reset = d.collect(reports(inbound('new-ssrc', 5000, 4000)));
  assert.equal(reset.recent_intervals.length, 1, 'new stream cannot fabricate a negative counter delta');
});

test('output underruns and server receive statistics stay separate, sensitive fields are omitted', () => {
  const result = new AudioDiagnostics().collect(reports(
    { id: 'out', type: 'media-playout', kind: 'audio', synthesizedSamplesDuration: .1, synthesizedSamplesEvents: 2, totalSamplesDuration: 5 },
    { id: 'remote', type: 'remote-inbound-rtp', kind: 'audio', packetsLost: 5, fractionLost: .02, jitter: .1 },
    inbound('a', 1000, 1000, { trackIdentifier: 'private-device', address: 'private-address', transcript: 'private-text' }),
  ));
  assert.equal(result.playout.synthesizedSamplesDuration, .1);
  assert.equal(result.microphone_transport[0].packetsLost, 5);
  assert.equal(result.packetsLost, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test('history is bounded and snapshots do not change retrospectively', () => {
  const d = new AudioDiagnostics();
  for (let n = 1; n <= 80; n++) d.collect(reports(inbound('a', n * 2000, n * 96000)));
  const snapshot = d.collect(reports(inbound('a', 162000, 81 * 96000)));
  assert.equal(snapshot.recent_intervals.length, 60);
  d.collect(reports(inbound('a', 164000, 82 * 96000)));
  assert.equal(snapshot.recent_intervals.length, 60);
});

test('microphone statistics follow the active sender after silence is replaced', () => {
  const result = new AudioDiagnostics().collect(reports(
    { id: 'sender', type: 'outbound-rtp', kind: 'audio', mediaSourceId: 'mic', packetsSent: 100 },
    { id: 'mic', type: 'media-source', kind: 'audio', audioLevel: .2, totalSamplesDuration: 5 },
    { id: 'silence', type: 'media-source', kind: 'audio', audioLevel: 0, totalSamplesDuration: 20 },
  ));
  assert.equal(result.inputAudioLevel, .2);
  assert.equal(result.inputAudioDuration, 5);
});
