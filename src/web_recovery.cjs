'use strict';

function createWebRecovery(refresh) {
  let pending;
  const reload = () => {
    if (!pending) pending = Promise.resolve().then(refresh).finally(() => { pending = null; });
    return pending;
  };
  return {
    async identity(read) {
      try { return await read(); }
      catch (error) {
        if (!['web_verification_required', 'login_refresh_required'].includes(error?.code)) throw error;
        await reload();
        return read();
      }
    },
    async request(send, mayRetry = () => true) {
      const response = await send();
      // A challenge is an explicit rejection before the application endpoint.
      // Never retry ambiguous transport failures or ordinary API errors here.
      if (response.status !== 403 || response.headers.get('cf-mitigated') !== 'challenge') return response;
      if (!mayRetry()) return response;
      // Preserve the definite rejection if refresh fails or the caller cancels.
      // Otherwise a failed refresh could turn a rejected create into an
      // incorrectly ambiguous allocation in the recovery journal.
      try { await reload(); } catch { return response; }
      if (!mayRetry()) return response;
      return send();
    },
  };
}

module.exports = { createWebRecovery };
