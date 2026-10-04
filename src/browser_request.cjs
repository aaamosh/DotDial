'use strict';

// Serialized into the existing isolated browser world. Credentials never
// leave that world; only a bounded response and dispatch evidence come back.
async function requestInBrowser(auth, request) {
  let dispatched = false;
  try {
    const identity = await auth.get();
    if (identity.accountId !== request.accountId) {
      throw Object.assign(new Error('account_mismatch'), { code: 'account_mismatch' });
    }
    const headers = { Authorization: 'Bearer ' + identity.accessToken,
      'ChatGPT-Account-ID': request.accountId, Accept: 'application/json, application/sdp, text/plain' };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    dispatched = true;
    const response = await fetch(request.path, { method: request.method, headers, body: request.body,
      credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(20000) });
    const result = { status: response.status, headers: Object.fromEntries(
      ['location', 'content-type', 'cf-mitigated'].map(key => [key, response.headers.get(key)]).filter(item => item[1] !== null)) };
    // Preserve a known rejection or allocated Location even if the body fails.
    try { result.body = await response.text(); } catch { result.body = ''; }
    return result;
  } catch (error) {
    return { error: /^[a-z_]{1,80}$/.test(error?.code || '') ? error.code : 'connection_failed',
      requestOutcome: dispatched ? 'unknown' : 'not_sent' };
  }
}

module.exports = { requestInBrowser };
