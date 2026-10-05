'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pcmFromWav, verifyEvents } = require('../scripts/smoke-macos-voice.cjs');

function wav() {
  const bytes = Buffer.alloc(44 + 3200);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(3200, 40);
  bytes.writeInt16LE(-16384, 44); bytes.writeInt16LE(8192, 46);
  return bytes;
}

test('native command speech preserves signed PCM and keeps speech and leading context while supplying one second of model look-ahead', () => {
  const pcm = pcmFromWav(wav());
  assert.equal(pcm.length, (1600 + 24000) * 4);
  assert.equal(pcm.readFloatLE(32000), -0.5); assert.equal(pcm.readFloatLE(32004), 0.25);
  assert.ok(pcm.subarray(0, 32000).every(byte => byte === 0));
  assert.ok(pcm.subarray(pcm.length - 64000).every(byte => byte === 0));
});

test('native command speech rejects silent, stereo, wrong-rate and truncated WAVs', () => {
  for (const mutate of [b => b.fill(0, 44), b => b.writeUInt16LE(2, 22), b => b.writeUInt32LE(48000, 24), b => b.writeUInt16LE(8, 34), b => b.writeUInt32LE(1, 28), b => b.writeUInt32LE(999999, 40)]) {
    const bytes = wav(); mutate(bytes); assert.throws(() => pcmFromWav(bytes));
  }
  assert.throws(() => pcmFromWav(wav().subarray(0, 100)));
  const trailing = Buffer.concat([wav(), Buffer.from([1, 2])]);
  trailing.writeUInt32LE(trailing.length - 8, 4);
  assert.throws(() => pcmFromWav(trailing));
  assert.throws(() => pcmFromWav(Buffer.alloc(16000 * 15 * 2 + 65537)));
});

test('native voice acceptance requires exact command labels and rejects extra wakes or duplicates', () => {
  const ready = '{"event":"ready"}\n', command = '{"event":"command","command":"hangUp"}\n';
  verifyEvents(ready + command, [{ event: 'command', command: 'hangUp' }]);
  verifyEvents(ready, []);
  for (const output of [ready, ready + command + command, ready + '{"event":"wake"}\n' + command,
    ready + '{"event":"command","command":"microphoneOn"}\n', command + ready,
    ready + '{"event":"error","code":"wake_failed"}\n', ready + 'null\n']) {
    assert.throws(() => verifyEvents(output, [{ event: 'command', command: 'hangUp' }]));
  }
});

test('disabled and unrelated speech cannot pass after any detected command or wake', () => {
  for (const event of [{ event: 'wake' }, { event: 'command', command: 'microphoneOff' }]) {
    assert.throws(() => verifyEvents('{"event":"ready"}\n' + JSON.stringify(event), []));
  }
  assert.throws(() => verifyEvents('x'.repeat(65537), []));
});

test('native package acceptance includes voice commands as a required supervised stage', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-macos-package.cjs'), 'utf8');
  assert.match(source, /\['native_voice_commands', async \(\) =>/);
  assert.match(source, /smoke-macos-voice\.cjs/);
  assert.equal((source.match(/\['native_voice_commands', async/g) || []).length, 1);
  assert.match(source, /voice\.cases\.length, 12/);
});


test('duplicate required gate names fail before running or overwriting evidence', async () => {
  const { runRequiredStages } = require('../scripts/verify-macos-package.cjs');
  let calls = 0;
  await assert.rejects(runRequiredStages([['same', async () => { calls++; }], ['same', async () => { calls++; }]], {}), /unique/);
  assert.equal(calls, 0);
});


test('finite-fixture comparison changes only trailing silence, never speech or recognition thresholds', () => {
  const short = pcmFromWav(wav(), 8000), full = pcmFromWav(wav(), 16000);
  assert.equal(full.length - short.length, 32000);
  assert.deepEqual(full.subarray(0, short.length), short);
  assert.ok(full.subarray(short.length).every(byte => byte === 0));
  for (const frames of [0, -1, 16001, 32000, NaN]) assert.throws(() => pcmFromWav(wav(), frames));
});
