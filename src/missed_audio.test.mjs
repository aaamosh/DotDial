import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MissedAudio } from './missed_audio.mjs';
const pcm = () => ({ sampleRate: 48000, pcm: new Int16Array(9600).fill(900).buffer });
function makeDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-missed-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function setup(t, options = {}) {
  const directory = makeDirectory(t);
  const player = options.player || { async play() { return true; }, async stop() {} };
  return new MissedAudio({ directory, player, ...options });
}
test('saved incoming audio and mute choice survive restart with private modes', async t => {
  const box = setup(t); box.setMuted(true); await box.save(pcm());
  const restored = new MissedAudio({ directory: box.directory, player: box.player });
  assert.equal(restored.snapshot().missed_count, 1); assert.equal(restored.desiredMuted, true);
  const clip = fs.readFileSync(path.join(box.directory, box.queue[0].name));
  assert.equal(clip.toString('ascii', 0, 4), 'RIFF'); assert.equal(clip.readUInt32LE(24), 48000);
  assert.equal(fs.statSync(box.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(box.directory, box.queue[0].name)).mode & 0o777, 0o600);
});
test('complete playback drains the live FIFO including replies saved during playback', async t => {
  let box, started, release;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const firstGate = new Promise(resolve => { release = resolve; });
  const played = [];
  box = setup(t, { player: { async play(file) {
    played.push(path.basename(file));
    if (played.length === 1) { started(); await firstGate; }
    return true;
  }, async stop() {} } });
  await box.save(pcm()); await box.save(pcm());
  const firstTwo = box.queue.map(clip => clip.name);
  box.play(); await firstStarted;
  await box.save(pcm());
  const third = box.queue[2].name;
  release(); await box.finished;
  assert.deepEqual(played, [...firstTwo, third]);
  assert.equal(box.queue.length, 0);
  assert.equal(fs.readdirSync(box.directory).filter(n => n.endsWith('.wav')).length, 0);
});
test('beforeDrain contributes pending clips before first play and at an empty-queue boundary', async t => {
  let box, drains = 0;
  const played = [];
  const expected = [];
  box = setup(t, {
    player: { async play(file) { played.push(path.basename(file)); return true; }, async stop() {} },
    beforeDrain: async () => {
      drains++;
      if (drains === 1 || drains === 2) {
        await box.save(pcm());
        expected.push(box.queue.at(-1).name);
      }
    },
  });
  await box.save(pcm());
  const first = box.queue[0].name;
  expected.unshift(first);
  box.play(); await box.finished;
  assert.equal(drains, 3);
  assert.deepEqual(played, expected);
  assert.equal(box.queue.length, 0);
  assert.equal(fs.readdirSync(box.directory).filter(name => name.endsWith('.wav')).length, 0);
});
test('empty queue waits for an in-flight save before deciding playback is done', async t => {
  let box, started, releasePlayback, releaseWrite;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const playbackGate = new Promise(resolve => { releasePlayback = resolve; });
  const played = [];
  box = setup(t, { player: { async play(file) {
    played.push(path.basename(file));
    if (played.length === 1) { started(); await playbackGate; }
    return true;
  }, async stop() {} } });
  await box.save(pcm());
  const first = box.queue[0].name;
  box.play(); await firstStarted;
  box.saveTail = new Promise(resolve => { releaseWrite = resolve; });
  const pendingSave = box.save(pcm());
  releasePlayback();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(box.playing, true, 'the player must wait for the pending FIFO write');
  releaseWrite();
  await pendingSave;
  const second = box.queue[0].name;
  await box.finished;
  assert.deepEqual(played, [first, second]);
  assert.equal(box.queue.length, 0);
});
test('stopping playback preserves the partial message and all later messages', async t => {
  let resolve, started;
  const ready = new Promise(r => { started = r; });
  const box = setup(t, { player: { play() { started(); return new Promise(r => { resolve = r; }); }, async stop() { resolve?.(false); } } });
  await box.save(pcm()); await box.save(pcm()); box.play(); await ready;
  await box.save(pcm());
  await box.stop();
  assert.equal(box.queue.length, 3); assert.equal(box.playing, false);
});
test('playback failure keeps audio and reports an actionable error', async t => {
  const box = setup(t, { player: { async play() { throw Error('device gone'); }, async stop() {} } });
  await box.save(pcm()); box.play(); await box.finished;
  assert.equal(box.queue.length, 1); assert.equal(box.error, 'playback_failed');
});
test('capacity limit never deletes an unheard recording', async t => {
  const box = setup(t, { limitBytes: 30000 }); await box.save(pcm());
  await assert.rejects(box.save(pcm()), { code: 'storage_full' }); assert.equal(box.queue.length, 1);
});
test('invalid recording payload and unrelated files cannot enter the queue', async t => {
  const box = setup(t);
  await assert.rejects(box.save({ sampleRate: 16000, pcm: pcm().pcm }));
  await assert.rejects(box.save({ sampleRate: 48000, pcm: new ArrayBuffer(3) }));
  fs.writeFileSync(path.join(box.directory, 'unrelated.txt'), 'not audio');
  const restored = new MissedAudio({ directory: box.directory, player: box.player });
  await restored.clear(); assert.equal(fs.readFileSync(path.join(box.directory, 'unrelated.txt'), 'utf8'), 'not audio');
});

test('a complete own .wav.part left by a crash is atomically recovered as unread audio', async t => {
  const directory = makeDirectory(t);
  const player = { async play() { return true; }, async stop() {} };
  const writer = new MissedAudio({ directory, player });
  await writer.save(pcm());
  const clip = writer.queue[0];
  const wav = path.join(directory, clip.name);
  const part = `${wav}.part`;
  const original = fs.readFileSync(wav);
  fs.renameSync(wav, part);

  const recovered = new MissedAudio({ directory, player });
  assert.equal(recovered.snapshot().missed_count, 1);
  assert.equal(recovered.snapshot().missed_error, null);
  assert.equal(fs.existsSync(part), false);
  assert.deepEqual(fs.readFileSync(wav), original);
  recovered.play(); await recovered.finished;
  assert.equal(recovered.snapshot().missed_count, 0);
});

test('incomplete own .wav.part and invalid .wav remain intact, report failure, and consume quota', async t => {
  const player = { async play() { return true; }, async stop() {} };
  for (const suffix of ['.wav.part', '.wav']) {
    const directory = makeDirectory(t);
    const name = `1700000000000-12345678-1234-1234-1234-123456789abc${suffix}`;
    const file = path.join(directory, name);
    const bytes = Buffer.alloc(60, 0x41);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const box = new MissedAudio({ directory, player, limitBytes: 100 });

    assert.equal(box.snapshot().missed_count, 0);
    assert.equal(box.snapshot().missed_error, 'recording_failed');
    await assert.rejects(box.save({ sampleRate: 48000, pcm: Uint8Array.of(1, 0).buffer }), { code: 'storage_full' });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(box.snapshot().missed_error, 'recording_failed');
  }
});

test('foreign files and own-name symlinks are left untouched and do not consume archive quota', async t => {
  const directory = makeDirectory(t);
  const foreignName = 'foreign.bin';
  const foreignFile = path.join(directory, foreignName);
  const foreignBytes = Buffer.alloc(256, 0x7b);
  fs.writeFileSync(foreignFile, foreignBytes, { mode: 0o644 });
  const linkName = '1700000000000-12345678-1234-1234-1234-123456789abc.wav';
  const link = path.join(directory, linkName);
  fs.symlinkSync(foreignName, link);

  const box = new MissedAudio({ directory, player: { async play() { return true; }, async stop() {} }, limitBytes: 50 });
  assert.equal(box.snapshot().missed_count, 0);
  assert.equal(box.snapshot().missed_error, null);
  assert.deepEqual(await box.save({ sampleRate: 48000, pcm: Uint8Array.of(1, 0).buffer }), { saved: true });
  assert.equal(fs.readlinkSync(link), foreignName);
  assert.deepEqual(fs.readFileSync(foreignFile), foreignBytes);
  assert.equal(fs.statSync(foreignFile).mode & 0o777, 0o644);
});
