import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBrowserIdentity } = require('./browser_identity.cjs');
const ORIGIN = 'https://chatgpt.com';
const BASE_NOW = 1_800_000_000_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function jwt(accountId, expiresAt, extra = {}) {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(expiresAt / 1000),
    'https://api.openai.com/auth': { account_id: accountId },
    ...extra,
  })).toString('base64url');
  return `fixture.${payload}.signature`;
}

function makeSession({ accountId = 'account-a', email = 'owner@example.com', expiresAt = BASE_NOW + 300_000, claims = {} } = {}) {
  return { user: { email }, accessToken: jwt(accountId, expiresAt, claims) };
}

function responseFor(session, { ok = true, status = ok ? 200 : 401, challenge = false } = {}) {
  return { ok, status, headers: { get: key => key === 'cf-mitigated' && challenge ? 'challenge' : null },
    async json() { return session; } };
}

function realm(fetchImpl, { now = BASE_NOW, origin = ORIGIN, schedule = setTimeout } = {}) {
  let time = now;
  const pageLocation = { origin };
  class ClockDate extends Date { static now() { return time; } }
  const context = vm.createContext({
    location: pageLocation,
    fetch: fetchImpl,
    Date: ClockDate,
    atob,
    AbortSignal,
    setTimeout: schedule,
  });
  // Exercise the exact function source the Electron caller serializes into
  // executeJavaScriptInIsolatedWorld; no module closure is available there.
  const identity = vm.runInContext(`(${createBrowserIdentity.toString()})("owner@example.com")`, context);
  return {
    identity,
    setNow(value) { time = value; },
    setOrigin(value) { pageLocation.origin = value; },
  };
}

test('serialized helper validates account and coalesces concurrent session reads', async () => {
  let calls = 0;
  const r = realm(async (url, options) => {
    calls++;
    assert.equal(url, '/api/auth/session');
    assert.equal(options.credentials, 'include');
    assert.ok(options.signal instanceof AbortSignal);
    return responseFor(makeSession());
  });

  const [a, b] = await Promise.all([r.identity.get(), r.identity.get()]);
  assert.equal(calls, 1);
  assert.deepEqual({ ...a }, {
    email: 'owner@example.com', accountId: 'account-a',
    accessToken: makeSession().accessToken, expiresAt: BASE_NOW + 300_000,
  });
  assert.deepEqual({ ...b }, { ...a });
  assert.equal((await r.identity.get()).accountId, 'account-a');
  assert.equal(calls, 1);
});

test('cache expires at the earlier of 30 seconds and the token safety margin', async () => {
  let calls = 0;
  const r = realm(async () => {
    calls++;
    const expiresAt = calls === 1 ? BASE_NOW + 80_000 : BASE_NOW + 300_000;
    return responseFor(makeSession({ accountId: `account-${calls}`, expiresAt }));
  });

  assert.equal((await r.identity.get()).accountId, 'account-1');
  r.setNow(BASE_NOW + 19_999);
  assert.equal((await r.identity.get()).accountId, 'account-1');
  assert.equal(calls, 1);

  r.setNow(BASE_NOW + 20_001);
  assert.equal((await r.identity.get()).accountId, 'account-2');
  assert.equal(calls, 2);
});

test('cache never exceeds the 30 second maximum for a long-lived token', async () => {
  let calls = 0;
  const r = realm(async () => {
    calls++;
    return responseFor(makeSession({ accountId: `account-${calls}`, expiresAt: BASE_NOW + 3_600_000 }));
  });

  assert.equal((await r.identity.get()).accountId, 'account-1');
  r.setNow(BASE_NOW + 29_999);
  assert.equal((await r.identity.get()).accountId, 'account-1');
  assert.equal(calls, 1);

  r.setNow(BASE_NOW + 30_001);
  assert.equal((await r.identity.get()).accountId, 'account-2');
  assert.equal(calls, 2);
});

test('session failures are classified without returning provider response text', async t => {
  const cases = [
    ['wrong email', makeSession({ email: 'dotdialmate@example.test' }), 'account_mismatch'],
    ['expired token', makeSession({ expiresAt: BASE_NOW + 59_000 }), 'login_refresh_required'],
    ['missing account claim', makeSession({ claims: { 'https://api.openai.com/auth': {} } }), 'invalid_login_session'],
  ];
  for (const [name, session, code] of cases) {
    await t.test(name, async () => {
      const r = realm(async () => responseFor(session));
      await assert.rejects(r.identity.get(), err => err.code === code && err.message === code);
    });
  }
});

test('wrong origin fails closed without fetching session', async () => {
  let calls = 0;
  const r = realm(async () => { calls++; return responseFor(makeSession()); }, { origin: 'https://evil.example' });
  await assert.rejects(r.identity.get(), err => err.code === 'login_required');
  assert.equal(calls, 0);
});

test('cached identity is not returned after navigation away from the expected origin', async () => {
  let calls = 0;
  const r = realm(async () => { calls++; return responseFor(makeSession()); });
  assert.equal((await r.identity.get()).accountId, 'account-a');
  r.setOrigin('https://evil.example');
  await assert.rejects(r.identity.get(), err => err.code === 'login_required');
  assert.equal(calls, 1);
});

test('invalidation rejects an old in-flight identity and preserves a newer singleflight', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const r = realm(() => (++calls === 1 ? first.promise : second.promise));

  const oldRequest = r.identity.get();
  assert.equal(calls, 1);
  r.identity.invalidate();
  const newRequest = r.identity.get();
  assert.equal(calls, 2);

  first.resolve(responseFor(makeSession({ accountId: 'old-account' })));
  await assert.rejects(oldRequest, err => err.code === 'login_session_changed');
  const joinedRequest = r.identity.get();
  assert.equal(calls, 2, 'the old request must not clear the new pending request');

  second.resolve(responseFor(makeSession({ accountId: 'new-account' })));
  assert.equal((await newRequest).accountId, 'new-account');
  assert.equal((await joinedRequest).accountId, 'new-account');
  assert.equal((await r.identity.get()).accountId, 'new-account');
  assert.equal(calls, 2);
});

test('HTTP and network failures expose only safe error codes', async t => {
  await t.test('HTTP failure', async () => {
    const r = realm(async () => responseFor(null, { ok: false }));
    await assert.rejects(r.identity.get(), err => err.code === 'login_required' && err.message === 'login_required');
  });
  await t.test('network failure', async () => {
    const r = realm(async () => { throw new Error('fixture contains no secret'); });
    await assert.rejects(r.identity.get(), err => err.code === 'login_connection_failed' && err.message === 'login_connection_failed');
  });
});

test('startup session retry is shared and recovers a temporarily empty session', async () => {
  let calls = 0;
  const delays = [];
  const r = realm(async () => responseFor(++calls === 1 ? {} : makeSession()), {
    schedule(fn, ms) { delays.push(ms); queueMicrotask(fn); },
  });
  const [a, b] = await Promise.all([r.identity.get(), r.identity.get()]);
  assert.equal(a.accountId, 'account-a');
  assert.equal(b.accountId, 'account-a');
  assert.equal(calls, 2, 'concurrent callers share the single bounded retry');
  assert.deepEqual(delays, [500]);
});

test('temporary HTTP errors are bounded and do not falsely require login', async t => {
  for (const status of [403, 500, 503]) {
    await t.test(String(status), async () => {
      let calls = 0;
      const r = realm(async () => { calls++; return responseFor(null, { ok: false, status }); }, {
        schedule(fn) { queueMicrotask(fn); },
      });
      await assert.rejects(r.identity.get(), err => err.code === 'login_connection_failed' && err.status === status);
      assert.equal(calls, 2);
    });
  }
});

test('rate limits and browser verification are not immediately retried', async t => {
  for (const [status, challenge, code] of [[429, false, 'login_connection_failed'], [403, true, 'web_verification_required']]) {
    await t.test(String(status), async () => {
      let calls = 0;
      const r = realm(async () => { calls++; return responseFor(null, { ok: false, status, challenge }); });
      await assert.rejects(r.identity.get(), err => err.code === code && err.status === status);
      assert.equal(calls, 1);
    });
  }
});

test('navigation or invalidation during retry cannot fetch a stale session', async t => {
  for (const invalidate of [false, true]) {
    await t.test(invalidate ? 'invalidation' : 'navigation', async () => {
      let calls = 0, resume;
      const waiting = deferred();
      const r = realm(async () => { calls++; return responseFor({}); }, {
        schedule(fn) { resume = fn; waiting.resolve(); },
      });
      const pending = r.identity.get();
      await waiting.promise;
      if (invalidate) r.identity.invalidate(); else r.setOrigin('https://evil.example');
      resume();
      await assert.rejects(pending, err => err.code === (invalidate ? 'login_session_changed' : 'login_required'));
      assert.equal(calls, 1);
    });
  }
});
