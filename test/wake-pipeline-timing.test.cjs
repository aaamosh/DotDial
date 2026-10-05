'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/smoke-wake-pipeline.cjs'), 'utf8');

function actualCode(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'the regression executes the actual smoke helper');
  return source.slice(from, to);
}

function timingHarness(wallJump) {
  let monotonic = 0, wall = 100000, polls = 0;
  const context = vm.createContext({ started: 0, aborted: false,
    performance: { now: () => monotonic }, Date: { now: () => wall },
    elapsed: () => monotonic,
    sleep: async ms => { monotonic += ms; wall += ms + (polls++ === 0 ? wallJump : 0); },
  });
  vm.runInContext(actualCode('async function until(', '\nfunction alive('), context);
  return { until: context.until, now: () => monotonic, wall: () => wall };
}

test('wake PCM observation keeps its seven-second budget across forward and backward wall-clock jumps', async () => {
  for (const jump of [5000, -5000]) {
    const clock = timingHarness(jump), observation = { requestedChunks: 25 };
    await assert.rejects(() => clock.until(() => false, 7000, 'real_pcm_writes_missing', observation),
      /real_pcm_writes_missing/);
    assert.equal(clock.now(), 7000);
    assert.equal(clock.wall(), 107000 + jump);
    assert.equal(observation.budgetMs, 7000);
    assert.equal(observation.elapsedMs, 7000);
    assert.equal(observation.deadlineAtMs, 7000);
    assert.equal(observation.result, 'failed');
  }
});

test('a forward wall-clock jump cannot end a healthy sequence of 25 acknowledged PCM chunks early', async () => {
  const clock = timingHarness(5000), observation = { requestedChunks: 25 };
  await clock.until(() => Math.floor(clock.now() / 100) >= 25, 7000,
    'real_pcm_writes_missing', observation);
  assert.equal(clock.now(), 2500);
  assert.equal(observation.elapsedMs, 2500);
  assert.equal(observation.budgetMs, 7000);
  assert.equal(observation.result, 'passed');
});

test('wake diagnosis accepts only one through six resume cycles', () => {
  const context = vm.createContext({});
  vm.runInContext(actualCode('function parseResumeCycles(', '\nconst SOURCE'), context);
  for (const value of ['1', '2', '4', '6']) assert.equal(context.parseResumeCycles(value), Number(value));
  for (const value of ['', '0', '7', '-1', '1.5', '01', '4x']) {
    assert.throws(() => context.parseResumeCycles(value), /resume_cycles_must_be_integer_1_to_6/);
  }
});

function cadenceHarness(chunks, elapsedMs) {
  const context = vm.createContext({ assert });
  vm.runInContext(actualCode('function verifyPcmCadence(', '\nasync function listening('), context);
  // A delayed acquisition does not change the established stream's duration.
  const timing = { chunks: Array.from({ length: chunks }, (_, index) => ({
    pcmAtMs: 20000 + index * elapsedMs / (chunks - 1),
  })) };
  return { timing, verify: () => context.verifyPcmCadence(timing, chunks) };
}

test('wake cadence compares PCM duration to monotonic time after the first block, with bounded scheduling tolerance', () => {
  for (const chunks of [10, 25]) {
    const expected = (chunks - 1) * 100;
    for (const jitter of [-200, 0, 300]) {
      const sample = cadenceHarness(chunks, expected + jitter);
      sample.verify();
      assert.equal(sample.timing.cadence.result, 'passed');
      assert.equal(sample.timing.cadence.expectedElapsedMs, expected);
      assert.equal(sample.timing.cadence.toleranceMs, 500);
    }
  }
});

test('25 blocks delivered before seven seconds still fail when the audio stream runs at half speed', () => {
  // These steady durations reproduce the slow ARM/Intel silent-sink ranges:
  // the count-only gate passed, but a live input FIFO can discard audio.
  for (const elapsedMs of [4200, 6300]) {
    const sample = cadenceHarness(25, elapsedMs);
    assert.ok(elapsedMs < 7000);
    assert.throws(sample.verify, /real_pcm_clock_drift/);
    assert.equal(sample.timing.cadence.result, 'failed');
  }
});
