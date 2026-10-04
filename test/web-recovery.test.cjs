'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebRecovery } = require('../src/web_recovery.cjs');
const challenge = () => new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } });

test('an explicitly rejected request refreshes the same web session and retries once', async () => {
  let refreshes = 0, sends = 0;
  const recovery = createWebRecovery(async () => { refreshes++; });
  const result = await recovery.request(async () => ++sends === 1 ? challenge() : new Response(null, { status: 204 }));
  assert.equal(result.status, 204);
  assert.equal(refreshes, 1);
  assert.equal(sends, 2);
});

test('a persistent challenge is returned without a reload or request loop', async () => {
  let refreshes = 0, sends = 0;
  const recovery = createWebRecovery(async () => { refreshes++; });
  assert.equal((await recovery.request(async () => { sends++; return challenge(); })).status, 403);
  assert.equal(refreshes, 1);
  assert.equal(sends, 2);
});

test('failed refresh or cancelled creation preserves the known rejection without a second create', async () => {
  for (const refreshFails of [false, true]) {
    let sends = 0;
    const recovery = createWebRecovery(async () => { if (refreshFails) throw new Error('offline'); });
    const response = await recovery.request(async () => { sends++; return challenge(); }, () => refreshFails);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cf-mitigated'), 'challenge');
    assert.equal(sends, 1);
  }
});

test('transport failure and ordinary API rejection are never retried', async () => {
  let refreshes = 0, sends = 0;
  const recovery = createWebRecovery(async () => { refreshes++; });
  await assert.rejects(recovery.request(async () => { sends++; throw new Error('network'); }), /network/);
  assert.equal(sends, 1);
  for (const status of [401, 403, 409, 429, 500]) {
    let attempts = 0;
    assert.equal((await recovery.request(async () => { attempts++; return new Response('', { status }); })).status, status);
    assert.equal(attempts, 1);
  }
  assert.equal(refreshes, 0);
});

test('concurrent identity challenges share one refresh and keep credentials in their caller', async () => {
  let release, refreshes = 0;
  const recovery = createWebRecovery(() => { refreshes++; return new Promise(resolve => { release = resolve; }); });
  const reader = () => {
    let reads = 0;
    return async () => {
      if (++reads === 1) throw Object.assign(new Error(), { code: 'web_verification_required' });
      return 'identity';
    };
  };
  const first = recovery.identity(reader()), second = recovery.identity(reader());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['identity', 'identity']);
  await assert.rejects(recovery.identity(async () => { throw Object.assign(new Error(), { code: 'account_mismatch' }); }), { code: 'account_mismatch' });
  assert.equal(refreshes, 1);
});
