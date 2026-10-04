import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function loadPlayer({ resolveDevice, setSinkId, play } = {}) {
  const calls = { played: 0, paused: 0, loaded: 0, removed: [] };
  const player = {
    onended: null,
    onerror: null,
    setSinkId: setSinkId || (async () => {}),
    pause() { calls.paused++; },
    removeAttribute(name) { calls.removed.push(name); },
    load() { calls.loaded++; },
    play: play || (() => {
      calls.played++;
      queueMicrotask(() => player.onended?.());
      return Promise.resolve();
    }),
  };
  const context = {
    document: { getElementById: id => id === 'replay' ? player : null },
    DotDialDevices: { resolve: resolveDevice || (async () => 'sink-id') },
    window: {},
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(new URL('./missed_player.js', import.meta.url), 'utf8'), context, {
    filename: 'missed_player.js',
  });
  return { api: context.window.MissedPlayer, calls, player };
}

test('stopping while output-device lookup is pending prevents missed audio from starting', async () => {
  const lookup = deferred();
  const harness = loadPlayer({ resolveDevice: () => lookup.promise });
  const playback = harness.api.play('file:///reply.wav', 1_000, 'label:USB speakers');
  harness.api.stop();
  lookup.resolve('usb-1');

  assert.equal(await playback, false);
  assert.equal(harness.calls.played, 0);
});

test('stopping while setSinkId is pending prevents missed audio from starting', async () => {
  const sink = deferred();
  const harness = loadPlayer({ setSinkId: () => sink.promise });
  const playback = harness.api.play('file:///reply.wav', 1_000, 'label:USB speakers');
  await new Promise(resolve => setImmediate(resolve));
  harness.api.stop();
  sink.resolve();

  assert.equal(await playback, false);
  assert.equal(harness.calls.played, 0);
});

test('a late play rejection from a cancelled clip leaves the replacement handlers intact', async () => {
  const firstPlay = deferred();
  let playCount = 0;
  const harness = loadPlayer({ play: () => {
    harness.calls.played++;
    playCount++;
    return playCount === 1 ? firstPlay.promise : Promise.resolve();
  } });
  const first = harness.api.play('file:///first.wav', 1_000);
  await new Promise(resolve => setImmediate(resolve));
  harness.api.stop();
  assert.equal(await first, false);

  const second = harness.api.play('file:///second.wav', 1_000);
  await new Promise(resolve => setImmediate(resolve));
  const secondEnded = harness.player.onended;
  assert.equal(typeof secondEnded, 'function');
  firstPlay.reject(new Error('old play rejected after cancellation'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.player.onended, secondEnded);
  secondEnded();
  assert.equal(await second, true);
});
