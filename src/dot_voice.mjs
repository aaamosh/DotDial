
// Candidate adapter: never changes or copies the account's credentials.

const API_ORIGIN = "https://chatgpt.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function apiReason(data) {
  const code = data?.error?.code || data?.detail?.code || data?.code;
  if (typeof code === 'string' && /^[a-z0-9_-]{1,100}$/i.test(code)) return code;
  // Some responses use a plain detail/message instead of a machine code.
  // Retain only a known category, never raw response text or request details.
  const message = [data?.detail, data?.message, data?.error?.message, data?.detail?.message]
    .filter(value => typeof value === 'string').join(' ').toLowerCase();
  for (const [reason, pattern] of [
    ['call_already_attached', /(?:call.{0,60}already.{0,30}attach|already attached)/],
    ['call_not_found', /call.{0,60}(?:not found|does not exist|no longer exists)/],
    ['call_already_closed', /call.{0,60}(?:already|has been).{0,20}(?:closed|ended|stopped|terminated)/],
    ['call_not_ready', /call.{0,60}not.{0,20}(?:ready|connected)/],
    ['another_call_active', /(?:another|existing|already active).{0,40}call|call.{0,40}already active/],
    ['call_attach_failed', /(?:failed|unable|could not).{0,30}attach/],
  ]) if (pattern.test(message)) return reason;
  return undefined;
}

export class DotVoiceError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = "DotVoiceError";
    this.code = code;
    this.status = status;
  }
}

export class DotVoiceSession {
  constructor({ identity, fetchImpl = fetch, threadId, expectedEmail = "" } = {}) {
    this.expectedEmail = expectedEmail;
    if (typeof identity !== "function") throw new DotVoiceError("identity_provider_required");
    if (!UUID.test(threadId)) throw new DotVoiceError("invalid_thread_id");
    this.identity = identity;
    this.fetch = fetchImpl;
    this.threadId = threadId;
    this.profileId = null;
    this.accountId = null;
    this.callId = null;
    this.creationAttempted = false;
    this.creationOutcome = 'not_sent';
    this.timings = {};
  }

  async request(method, apiPath, body) {
    if (!apiPath.startsWith("/tbo/") || /[?#\\]/.test(apiPath)) {
      throw new DotVoiceError("invalid_api_path");
    }
    const started = performance.now();
    const identity = await this.identity();
    const identityMs = Math.round(performance.now() - started);
    if ((this.expectedEmail && identity.email !== this.expectedEmail) || !identity.accountId || !identity.accessToken) {
      throw new DotVoiceError("account_mismatch");
    }
    if (this.accountId && identity.accountId !== this.accountId) {
      throw new DotVoiceError("account_changed_during_call");
    }
    this.accountId ??= identity.accountId;
    const creating = method === 'POST' && apiPath.endsWith('/voice/calls');
    let response;
    try {
      if (creating) this.creationOutcome = 'unknown';
      response = await this.fetch(`${API_ORIGIN}/backend-api${apiPath}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${identity.accessToken}`,
          "ChatGPT-Account-ID": identity.accountId,
          Accept: "application/json, application/sdp, text/plain",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // Fetch errors may embed request details. Never forward them or headers.
      // The browser bridge can prove its identity check failed before fetch.
      // An execution/transport failure without that proof remains ambiguous.
      if (error?.requestOutcome === 'not_sent') {
        if (creating) this.creationOutcome = 'not_sent';
        throw new DotVoiceError('request_not_sent');
      }
      throw new DotVoiceError(method === "POST" ? "request_outcome_unknown" : "connection_failed");
    }
    const phase = method === 'GET' ? 'profile' : apiPath.endsWith('/attach') ? 'attach' : apiPath.endsWith('/stop') ? 'stop' : 'create';
    this.timings[phase] = { identity_ms: identityMs, total_ms: Math.round(performance.now() - started), ...response.dotdialTimings };
    if (!response.ok) {
      if (creating && response.status >= 400 && response.status < 500) this.creationOutcome = 'rejected';
      const challenged = response.headers.get("cf-mitigated") === "challenge";
      const error = new DotVoiceError(challenged ? "web_verification_required" : "api_request_rejected", response.status);
      if (!challenged && response.headers.get('content-type')?.includes('json')) {
        const data = await response.json().catch(() => null);
        error.apiReason = apiReason(data);
      }
      throw error;
    }
    return response;
  }

  async resolveProfile() {
    const response = await this.request("GET", `/tbo/by-thread/${this.threadId}`);
    const profile = await response.json();
    if (!profile || typeof profile.id !== "string" || !/^[A-Za-z0-9_~-]{1,160}$/.test(profile.id)) {
      throw new DotVoiceError("invalid_dot_profile");
    }
    this.profileId = profile.id;
    return { profileId: profile.id, threadId: this.threadId, displayName: profile.display_name };
  }

  async create(offerSdp) {
    if (!this.profileId) throw new DotVoiceError("dot_profile_not_resolved");
    if (this.creationAttempted) throw new DotVoiceError("call_creation_already_attempted");
    if (typeof offerSdp !== "string" || !offerSdp.startsWith("v=0")) {
      throw new DotVoiceError("invalid_sdp_offer");
    }
    this.creationAttempted = true;
    const apiPath = `/tbo/${this.profileId}/voice/calls`;
    const response = await this.request("POST", apiPath, { sdp: offerSdp });
    const location = response.headers.get("Location");
    if (!location) throw new DotVoiceError("call_created_without_location");
    const url = new URL(location, `${API_ORIGIN}/backend-api${apiPath}`);
    // Desktop extracts the last path component; Location is a resource locator,
    // not necessarily the same TBO route. Never follow this URL or retain its query.
    if (![API_ORIGIN, 'https://api.openai.com'].includes(url.origin)) {
      throw new DotVoiceError("unexpected_call_location");
    }
    const callId = url.pathname.split("/").at(-1);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(callId)) throw new DotVoiceError("invalid_call_id");
    this.callId = callId;
    this.creationOutcome = 'created';
    const answerSdp = await response.text();
    if (!answerSdp.startsWith("v=0")) throw new DotVoiceError("invalid_sdp_answer");
    return { answerSdp };
  }

  async attach() {
    if (!this.callId) throw new DotVoiceError("call_not_created");
    await this.request("POST", `/tbo/${this.profileId}/voice/calls/${this.callId}/attach`);
  }

  async stop() {
    if (!this.callId) return;
    await this.request("POST", `/tbo/${this.profileId}/voice/calls/${this.callId}/stop`);
    this.callId = null;
  }
}
