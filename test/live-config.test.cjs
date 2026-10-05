'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectLiveConfig } = require('../src/live_config.cjs');
const { defaults: DEFAULTS } = require('../src/config.cjs');

test('wake changes apply while call settings are pinned, including during recovery', () => {
  const original = structuredClone(DEFAULTS);
  const requested = structuredClone(original);
  requested.wakeWord = { ...requested.wakeWord, enabled: true, phrase: 'Computer', sensitivity: 8 };
  const live = selectLiveConfig(original, requested, true);
  assert.deepEqual(live.config, requested);
  assert.equal(live.pending, false);
  assert.equal(original.wakeWord.phrase, 'Hey Dot');
  assert.equal(selectLiveConfig(live.config, requested, true).pending, false);
});

test('a concurrent route edit stays pending without blocking or losing the latest wake edit', () => {
  const original = structuredClone(DEFAULTS);
  const requested = structuredClone(original);
  requested.wakeWord.phrase = 'Computer';
  requested.network.mediaLauncher = ['/usr/bin/example-route'];
  requested.audio.bufferMs = 500;
  const live = selectLiveConfig(original, requested, true);
  assert.equal(live.config.wakeWord.phrase, 'Computer');
  assert.deepEqual(live.config.network.mediaLauncher, []);
  assert.equal(live.config.audio.bufferMs, 0);
  assert.equal(live.pending, true);
  requested.wakeWord.enabled = true;
  const next = selectLiveConfig(live.config, requested, true);
  assert.equal(next.config.wakeWord.enabled, true);
  assert.deepEqual(next.config.network.mediaLauncher, []);
  const idle = selectLiveConfig(next.config, requested, false);
  assert.deepEqual(idle.config, requested);
  assert.equal(idle.pending, false);
});

test('voice command opt-in and phrase edits apply during a call without changing its route or audio', () => {
  const current = structuredClone(DEFAULTS), requested = structuredClone(DEFAULTS);
  requested.wakeWord.commandsEnabled = true;
  requested.wakeWord.commands.speakersOff = 'Radio silence';
  requested.network.mediaLauncher = ['/usr/bin/example-route'];
  requested.audio.bufferMs = 500;
  const live = selectLiveConfig(current, requested, true);
  assert.equal(live.config.wakeWord.commandsEnabled, true);
  assert.equal(live.config.wakeWord.commands.speakersOff, 'Radio silence');
  assert.deepEqual(live.config.network, current.network);
  assert.deepEqual(live.config.audio, current.audio);
  assert.equal(live.pending, true);
});
