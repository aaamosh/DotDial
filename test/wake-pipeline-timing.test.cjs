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
