'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { requestInBrowser } = require('../src/browser_request.cjs');

const request = { path: '/backend-api/tbo/fixture/voice/calls', method: 'POST', accountId: 'fixture-account', body: '{}' };
const identity = () => Promise.resolve({ accountId: 'fixture-account', accessToken: 'fixture-token' });
function run(get, fetch) {
  return vm.runInNewContext(`(${requestInBrowser.toString()})(auth, request)`, { auth: { get }, request, fetch, AbortSignal });
}

test('browser identity failure proves no allocation was sent and leaks no details', async () => {
  let sends = 0;
  const result = await run(async () => { throw Object.assign(new Error('private identity detail'), { code: 'login_required' }); }, () => { sends++; });
  assert.equal(sends, 0);
  assert.equal(result.requestOutcome, 'not_sent');
  assert.equal(result.error, 'login_required');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('an account switch in the browser is rejected before fetch', async () => {
  let sends = 0;
  const result = await run(async () => ({ accountId: 'another-account', accessToken: 'fixture-token' }), () => { sends++; });
  assert.equal(sends, 0);
  assert.equal(result.requestOutcome, 'not_sent');
  assert.equal(result.error, 'account_mismatch');
});

test('a lost browser fetch result stays unknown and cannot authorize retry', async () => {
  let sends = 0;
  const result = await run(identity, async () => { sends++; throw new Error('private network detail'); });
  assert.equal(sends, 1);
  assert.equal(result.requestOutcome, 'unknown');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('a failed response body preserves rejection or the allocated resource', async () => {
  for (const status of [401, 403, 201]) {
    const result = await run(identity, async () => ({ status, headers: new Headers({ Location: '/calls/fixture-call' }), text: async () => { throw new Error('body lost'); } }));
    assert.equal(result.status, status);
    assert.equal(result.headers.location, '/calls/fixture-call');
    assert.equal(result.body, '');
    assert.equal(result.error, undefined);
  }
});
