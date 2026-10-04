'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSoundFile, CustomSoundCache, MAX_BYTES } = require('../src/custom_sound.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-sound-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('custom sound input rejects nonlocal, unsupported, unreadable and oversized files', async t => {
  const directory = fixture(t);
  for (const file of ['relative.wav', 'https://example.com/sound.mp3', '/tmp/sound.ogg']) {
    await assert.rejects(readSoundFile(file), { code: 'sound_file_invalid' });
  }
  await assert.rejects(readSoundFile(path.join(directory, 'absent.wav')), { code: 'sound_file_unavailable' });
  const fake = path.join(directory, 'fake.mp3'); fs.writeFileSync(fake, 'This is not audio');
  await assert.rejects(readSoundFile(fake), { code: 'sound_decode_failed' });
  const folder = path.join(directory, 'directory.wav'); fs.mkdirSync(folder);
  await assert.rejects(readSoundFile(folder), { code: 'sound_file_invalid' });
  const big = path.join(directory, 'big.wav'); fs.writeFileSync(big, ''); fs.truncateSync(big, MAX_BYTES + 1);
  await assert.rejects(readSoundFile(big), { code: 'sound_file_too_large' });
});
test('custom sound caching coalesces decoding, notices changed bytes and cleans temporary audio', async t => {
  const directory = fixture(t), file = path.join(directory, 'sound.wav');
  const wave = fs.readFileSync(path.join(__dirname, '../src/sounds/activated.wav')); fs.writeFileSync(file, wave);
  const cache = new CustomSoundCache({ runtimeDir: directory });
  let count = 0;
  cache.decode = async () => { count++; await new Promise(resolve => setTimeout(resolve, 10)); return wave; };
  const [first, second] = await Promise.all([cache.prepare(file), cache.prepare(file)]);
  assert.equal(first, second); assert.equal(count, 1);
  assert.equal(fs.statSync(first).mode & 0o777, 0o600);
  wave[44] ^= 1; fs.writeFileSync(file, wave);
  const changed = await cache.prepare(file); assert.notEqual(first, changed); assert.equal(count, 2);
  await cache.close(); assert.equal(fs.existsSync(first), false); assert.equal(fs.existsSync(changed), false);
  assert.equal(fs.existsSync(file), true);
  await assert.rejects(cache.prepare(file), { code: 'sound_decode_cancelled' });
});
test('closing during sound decoding prevents a late cache write', async t => {
  const directory = fixture(t), cache = new CustomSoundCache({ runtimeDir: directory });
  let release;
  cache.decode = () => new Promise(resolve => { release = resolve; });
  const pending = cache.prepare(path.join(__dirname, '../src/sounds/activated.wav'));
  const rejected = assert.rejects(pending, { code: 'sound_decode_cancelled' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const closing = cache.close(); release(Buffer.alloc(44)); await closing; await rejected;
  assert.equal(fs.existsSync(cache.directory), false);
});
