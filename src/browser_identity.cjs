'use strict';

/**
 * Build a small same-origin identity cache that can be serialized into an
 * Electron isolated world with Function.prototype.toString().
 *
 * This function intentionally has no module-scope dependencies. Keep it
 * self-contained so browser credentials remain inside the app's renderer.
 */
function createBrowserIdentity(expectedEmail = "") {
  const MAX_CACHE_MS = 30_000;
  const MIN_TOKEN_LIFE_MS = 60_000;
  let generation = 0;
  let cached = null;
  let pending = null;

  const failure = (code, status) => Object.assign(new Error(code), { code },
    Number.isInteger(status) ? { status } : {});
  const assertCurrent = startedGeneration => {
    if (startedGeneration !== generation) throw failure('login_session_changed');
    if (location.origin !== 'https://chatgpt.com') throw failure('login_required');
  };

  function invalidate() {
    generation++;
    cached = null;
    pending = null;
  }

  async function load(startedGeneration) {
    if (location.origin !== 'https://chatgpt.com') throw failure('login_required');

    let response;
    try {
      response = await fetch('/api/auth/session', {
        credentials: 'include',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      assertCurrent(startedGeneration);
      throw failure('login_connection_failed');
    }
    assertCurrent(startedGeneration);
    if (!response.ok) {
      if (response.headers?.get('cf-mitigated') === 'challenge') {
        throw failure('web_verification_required', response.status);
      }
      throw failure(response.status === 401 ? 'login_required' : 'login_connection_failed', response.status);
    }

    let session;
    try {
      session = await response.json();
    } catch {
      assertCurrent(startedGeneration);
      throw failure('invalid_login_session');
    }
    assertCurrent(startedGeneration);

    const accessToken = session?.accessToken;
    const email = session?.user?.email;
    if (typeof accessToken !== 'string' || accessToken.length === 0 || typeof email !== 'string') {
      throw failure('login_required');
    }
    if (expectedEmail && email !== expectedEmail) throw failure('account_mismatch');

    let claims;
    try {
      const parts = accessToken.split('.');
      if (parts.length < 2 || !parts[1]) throw new Error();
      const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      claims = JSON.parse(atob(encoded));
    } catch {
      throw failure('invalid_login_session');
    }

    const auth = claims['https://api.openai.com/auth'];
    const accountId = auth?.chatgpt_account_id || auth?.account_id;
    const expiresAt = Number(claims.exp) * 1000;
    const now = Date.now();
    if (typeof accountId !== 'string' || accountId.length === 0 || !Number.isFinite(expiresAt)) {
      throw failure('invalid_login_session');
    }
    if (expiresAt <= now + MIN_TOKEN_LIFE_MS) throw failure('login_refresh_required');
    assertCurrent(startedGeneration);

    const value = { email, accountId, accessToken, expiresAt };
    cached = { value, until: Math.min(now + MAX_CACHE_MS, expiresAt - MIN_TOKEN_LIFE_MS) };
    return { ...value };
  }

  function get() {
    if (location.origin !== 'https://chatgpt.com') return Promise.reject(failure('login_required'));
    if (cached && Date.now() < cached.until) return Promise.resolve({ ...cached.value });
    if (pending && pending.generation === generation) return pending.promise;

    const startedGeneration = generation;
    const record = { generation: startedGeneration, promise: null };
    record.promise = (async () => {
      try { return await load(startedGeneration); }
      catch (error) {
        // The browser may still be refreshing its session just after startup.
        // Retry this read once; never repeat call creation or change account.
        if (!['login_required', 'login_refresh_required', 'login_connection_failed'].includes(error?.code) ||
            error.status === 429) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
        assertCurrent(startedGeneration);
        return load(startedGeneration);
      }
    })().finally(() => {
      // An invalidated request must not clear a newer request's singleflight.
      if (pending === record) pending = null;
    });
    pending = record;
    return record.promise;
  }

  return { get, invalidate };
}

module.exports = { createBrowserIdentity };
