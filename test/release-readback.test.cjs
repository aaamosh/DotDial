'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readCreatedDraft, TAG, TITLE, REPOSITORY } = require('../scripts/publish-macos-preview.cjs');
const context = { sourceSha: 'a'.repeat(40), runId: '123' }, body = 'exact reviewed notes';
const valid = { id: 123, tag_name: TAG, name: TITLE, target_commitish: context.sourceSha,
  draft: true, prerelease: true, body, author: { login: 'github-actions[bot]' }, assets: [] };
function fixture(responses) {
  const reads = [], waits = [], observations = [];
  let index = 0;
  const client = { async api(endpoint) {
    reads.push(endpoint);
    if (endpoint === `/repos/${REPOSITORY}/releases?per_page=100`) {
      const result = responses[Math.min(index++, responses.length - 1)];
      if (result instanceof Error) throw result;
      return result === null ? [] : [result];
    }
    assert.equal(endpoint, `/repos/${REPOSITORY}/releases/123`);
    return responses[Math.min(index - 1, responses.length - 1)];
  }, command() { assert.fail('draft readback may never write'); } };
  return { reads, waits, observations,
    run: () => readCreatedDraft(client, context, body,
      { sleep: async ms => waits.push(ms), observe: value => observations.push(value) }) };
}
test('new draft visibility recovers with bounded reads and no second creation', async () => {
  const f = fixture([null, null, valid]);
  assert.deepEqual(await f.run(), valid);
  assert.deepEqual(f.waits, [250, 750]);
  assert.deepEqual(f.observations.map(x => x.found), [false, false, true]);
  assert.equal(f.reads.length, 4);
});
test('a permanently absent draft stops without upload or unbounded retries', async () => {
  const f = fixture([null]);
  await assert.rejects(f.run, /absent after four reads/);
  assert.deepEqual(f.waits, [250, 750, 1500]); assert.equal(f.reads.length, 4);
});
test('a mismatched visible draft is rejected immediately and never retried', async () => {
  for (const change of [{ target_commitish: 'b'.repeat(40) }, { prerelease: false },
    { draft: false }, { body: 'different' }, { name: 'different' }, { author: { login: 'other' } }]) {
    const f = fixture([{ ...valid, ...change }, valid]);
    await assert.rejects(f.run, /does not match|unchanged draft/);
    assert.deepEqual(f.waits, []); assert.equal(f.reads.length, 2);
  }
});
test('HTTP failures during draft readback are not converted into visibility retries', async () => {
  const f = fixture([Error('HTTP 403')]);
  await assert.rejects(f.run, /HTTP 403/); assert.deepEqual(f.waits, []);
});
