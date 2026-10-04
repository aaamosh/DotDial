import test from "node:test";
import assert from "node:assert/strict";
import { CallController } from "./call_controller.mjs";
import { createRequire } from 'node:module';
const { presentState } = createRequire(import.meta.url)('./desktop.cjs');

const PROFILE = "00000000-0000-4000-8000-000000000002~fixture-profile";
const ACCOUNT = "fixture-owner-account";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  let journal = options.initialJournal ? { ...options.initialJournal } : { phase: "closed" };
  const journalWrites = [];
  const sessions = [];
  const events = [];
  const snapshots = [];
  const peers = [];
  const captures = [];

  const makeSession = () => {
    const s = {
      profileId: null,
      accountId: null,
      callId: null,
      async resolveProfile() {
        events.push("resolveProfile");
        if (options.resolveProfile) await options.resolveProfile(s);
        s.profileId = PROFILE;
        s.accountId = ACCOUNT;
        return { profileId: PROFILE };
      },
      async create(offer) {
        events.push(["create", offer]);
        if (options.create) return options.create(s);
        s.callId = "fixture-call-1";
        return { answerSdp: "v=0\r\nanswer" };
      },
      async attach() {
        events.push(["attach", s.callId]);
        if (options.attach) await options.attach(s);
      },
      async stop() {
        events.push(["remoteStop", s.profileId, s.accountId, s.callId]);
        if (options.stop) await options.stop(s);
        s.callId = null;
      },
    };
    sessions.push(s);
    return s;
  };

  class LiveWebRtcPeer {
    constructor(onEvent, onLevel, onConnection) {
      Object.assign(this, { onEvent, onLevel, onConnection });
      peers.push(this);
      events.push("peerCreated");
    }
    async createOffer() { events.push("createOffer"); if (options.createOffer) await options.createOffer(); return "v=0\r\noffer"; }
    async acceptAnswer(sdp) { events.push(["acceptAnswer", sdp]); }
    async waitForOpen() {
      events.push("waitForOpen");
      if (options.waitForOpen) await options.waitForOpen();
    }
    pushAudio(samples) { events.push(["pushAudio", samples.length]); }
    async close() { events.push("peerClosed"); }
  }

  class AudioCapture {
    constructor(rate, callback) {
      Object.assign(this, { rate, callback });
      captures.push(this);
      events.push(["captureStarted", rate]);
    }
    stop() { events.push("captureStopped"); }
  }

  if (options.browserMedia) {
    LiveWebRtcPeer.prototype.startMicrophone = async function () {
      events.push('browserMicrophoneRequested');
      if (options.startMicrophone) await options.startMicrophone();
      this.microphoneSettings = { sampleRate: 48000, echoCancellation: true };
      return new AudioCapture(48000, () => {});
    };
    LiveWebRtcPeer.prototype.getStats = async () => options.stats || { connection_state: 'connected', packetsReceived: 10 };
    LiveWebRtcPeer.prototype.stopMicrophone = async () => {
      captures.at(-1)?.stop();
      if (options.stopMicrophone) await options.stopMicrophone();
    };
  }

  const controller = new CallController({
    makeSession,
    native: { LiveWebRtcPeer, AudioCapture },
    expectedProfile: PROFILE,
    readJournal: () => journal && { ...journal },
    writeJournal: value => {
      journal = { ...value };
      journalWrites.push({ ...value });
    },
    publish: snapshot => snapshots.push({ ...snapshot }),
    cue: async name => events.push(["cue", name]),
  });

  return {
    controller, events, snapshots, sessions, peers, captures, journalWrites,
    get journal() { return journal && { ...journal }; },
  };
}

async function waitFor(predicate, description) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${description}`);
}

test("a real call lifecycle pins the profile and stops the same call once", async () => {
  const h = harness();
  assert.deepEqual(h.controller.wake({ microphone: true, maxSeconds: 3600 }), { status: "accepted_wake" });
  await waitFor(() => h.controller.state === "active", "active call");
  assert.equal(h.controller.snapshot().local_listening, true);
  assert.equal(h.captures[0].rate, 16000);
  assert.equal(h.sessions[0].profileId, PROFILE);

  await h.controller.stop();

  assert.equal(h.controller.state, "ready");
  assert.equal(h.events.filter(event => Array.isArray(event) && event[0] === "create").length, 1);
  assert.deepEqual(h.events.filter(event => Array.isArray(event) && event[0] === "remoteStop"), [
    ["remoteStop", PROFILE, ACCOUNT, "fixture-call-1"],
  ]);
  assert.ok(h.events.includes("captureStopped"));
  assert.ok(h.events.includes("peerClosed"));
  assert.deepEqual(h.journal, { phase: "closed" });
});

test("stop during profile lookup cancels before call allocation", async () => {
  const lookup = deferred();
  const h = harness({ resolveProfile: () => lookup.promise });
  h.controller.wake({ microphone: true });
  assert.equal(h.controller.state, "starting");

  const stopping = h.controller.stop();
  lookup.resolve();
  await stopping;

  assert.equal(h.events.filter(event => Array.isArray(event) && event[0] === "create").length, 0);
  assert.equal(h.peers.length, 1);
  assert.ok(h.events.includes('peerClosed'));
  assert.equal(h.controller.state, "ready");
  assert.equal(h.controller.snapshot().last_error, undefined);
  assert.equal(h.controller.snapshot().start_error, undefined);
  assert.equal(h.controller.snapshot().stage, 'ready');
});

test('hangup during create returns the listening tray after confirming the exact allocated call', async () => {
  const creating = deferred();
  const h = harness({ create: async s => {
    await creating.promise;
    s.callId = 'fixture-delayed-call';
    return { answerSdp: 'v=0\r\nanswer' };
  } });
  h.controller.wake({ microphone: false });
  await waitFor(() => h.journal.phase === 'creating', 'pending create');
  const stopping = h.controller.stop();
  creating.resolve();
  await stopping;
  const state = h.controller.snapshot();
  assert.equal(state.state, 'ready');
  assert.equal(state.stage, 'ready');
  assert.equal(state.start_result, 'cancelled');
  assert.equal(state.last_error, undefined);
  assert.equal(state.start_error, undefined);
  assert.equal(state.stop_result, 'confirmed');
  assert.deepEqual(h.journal, { phase: 'closed' });
  assert.deepEqual(h.events.filter(e => Array.isArray(e) && e[0] === 'remoteStop'), [
    ['remoteStop', PROFILE, ACCOUNT, 'fixture-delayed-call'],
  ]);
  const tray = presentState({ ...state, wake_status: 'listening' });
  assert.equal(tray.tone, 'listening');
  assert.equal(tray.tooltip, 'DotDial · Wake word listening');
});

test('hangup during create still warns when remote closure cannot be confirmed', async () => {
  const creating = deferred();
  const h = harness({ create: async s => {
    await creating.promise; s.callId = 'fixture-delayed-call';
    return { answerSdp: 'v=0\r\nanswer' };
  }, stop: async () => { throw Object.assign(new Error('offline'), { code: 'connection_failed' }); } });
  h.controller.wake({ microphone: false });
  await waitFor(() => h.journal.phase === 'creating', 'pending create');
  const stopping = h.controller.stop(); creating.resolve(); await stopping;
  assert.equal(h.controller.state, 'recovery_required');
  assert.equal(h.controller.snapshot().last_error, 'remote_stop_unconfirmed');
  assert.equal(h.journal.callId, 'fixture-delayed-call');
  assert.equal(presentState(h.controller.snapshot()).tone, 'warning');
});

test('hangup does not hide an unknown create outcome', async () => {
  const creating = deferred();
  const h = harness({ create: () => creating.promise });
  h.controller.wake({ microphone: false });
  await waitFor(() => h.journal.phase === 'creating', 'pending create');
  const stopping = h.controller.stop();
  creating.reject(Object.assign(new Error('offline'), { code: 'request_outcome_unknown' }));
  await stopping;
  assert.equal(h.controller.state, 'recovery_required');
  assert.equal(h.controller.snapshot().last_error, 'request_outcome_unknown');
  assert.equal(presentState(h.controller.snapshot()).tone, 'warning');
});

test('late events from a closed peer cannot warn or stop a subsequent call', async () => {
  const h = harness(); h.controller.wake({ microphone: false }); await h.controller.pending;
  const closedPeer = h.peers[0];
  await h.controller.stop();
  closedPeer.onConnection();
  assert.equal(h.controller.state, 'ready');
  assert.equal(h.controller.snapshot().last_error, undefined);
  assert.equal(presentState({ ...h.controller.snapshot(), wake_status: 'listening' }).tone, 'listening');
  h.controller.wake({ microphone: false }); await h.controller.pending;
  closedPeer.onConnection(); closedPeer.onEvent(null); closedPeer.onLevel(null, 1);
  assert.equal(h.controller.state, 'active');
  assert.equal(h.controller.snapshot().last_error, undefined);
  assert.equal(h.controller.snapshot().event_count, 0);
  assert.equal(h.controller.snapshot().remote_peak, 0);
  assert.equal(presentState(h.controller.snapshot()).tone, 'call');
  h.peers[1].onConnection(); await h.controller.stopping;
  assert.equal(h.controller.snapshot().last_error, 'media_connection_failed');
  assert.equal(presentState(h.controller.snapshot()).tone, 'warning');
});

test('local offer overlaps profile lookup, but cloud allocation waits for both', async () => {
  const lookup = deferred(), offer = deferred();
  const h = harness({ resolveProfile: () => lookup.promise, createOffer: () => offer.promise });
  h.controller.wake({ microphone: false });
  assert.ok(h.events.includes('resolveProfile'));
  assert.ok(h.events.includes('createOffer'));
  assert.equal(h.captures.length, 0);
  assert.equal(h.events.some(e => Array.isArray(e) && e[0] === 'create'), false);
  lookup.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.events.some(e => Array.isArray(e) && e[0] === 'create'), false);
  offer.resolve();
  await h.controller.pending;
  assert.equal(h.controller.state, 'active');
  await h.controller.stop();
});

test('wrong profile closes the prepared local peer without cloud allocation or microphone', async () => {
  const h = harness();
  h.controller.expectedProfile = 'different-profile';
  h.controller.wake();
  await h.controller.pending;
  assert.equal(h.controller.snapshot().last_error, 'dot_profile_mismatch');
  assert.equal(h.controller.snapshot().start_error.stage, 'profile');
  assert.ok(h.events.includes('peerClosed'));
  assert.equal(h.events.some(e => Array.isArray(e) && e[0] === 'create'), false);
  assert.equal(h.captures.length, 0);
});

test("user stop closes local playback immediately while signaling is still waiting", async () => {
  const opening = deferred();
  const h = harness({ waitForOpen: () => opening.promise });
  h.controller.wake({ microphone: false });
  await waitFor(() => h.events.includes("waitForOpen"), "WebRTC connection wait");

  const stopping = h.controller.stop();
  // A user-requested end must release local media without waiting for the
  // connection-open timeout. Remote cleanup can finish afterwards.
  const closedImmediately = h.events.includes("peerClosed");
  opening.resolve();
  await stopping;
  assert.ok(closedImmediately);
});

test("an unknown create result stays recoverable and is never retried", async () => {
  const h = harness({
    create: async () => { throw Object.assign(new Error("transport lost"), { code: "request_outcome_unknown" }); },
  });
  h.controller.wake({ microphone: false });
  await h.controller.pending;

  assert.equal(h.controller.state, "recovery_required");
  assert.deepEqual(h.journal, { phase: "creating", profileId: PROFILE, accountId: ACCOUNT });
  assert.deepEqual(await h.controller.recover(), { status: "creation_outcome_unknown" });
  assert.equal(h.events.filter(event => Array.isArray(event) && event[0] === "create").length, 1);
});

test("a call allocated before attach failure is closed and journaled", async () => {
  const h = harness({ attach: async () => { throw Object.assign(new Error("attach failed"), { code: "api_request_rejected" }); } });
  h.controller.wake({ microphone: true });
  await h.controller.pending;

  assert.equal(h.controller.state, "ready");
  assert.equal(h.captures.length, 0);
  assert.ok(h.events.includes("peerClosed"));
  assert.deepEqual(h.events.filter(event => Array.isArray(event) && event[0] === "remoteStop"), [
    ["remoteStop", PROFILE, ACCOUNT, "fixture-call-1"],
  ]);
  assert.deepEqual(h.journalWrites.slice(-3).map(item => item.phase), ["created", "stopping", "closed"]);
});

test("failed remote stop preserves the exact call for explicit recovery", async () => {
  let stopAttempts = 0;
  const h = harness({
    stop: async () => {
      if (++stopAttempts === 1) throw Object.assign(new Error("network down"), { code: "request_outcome_unknown" });
    },
  });
  h.controller.wake({ microphone: false });
  await waitFor(() => h.controller.state === "active", "active call");
  await h.controller.stop();

  assert.equal(h.controller.state, "recovery_required");
  assert.deepEqual(h.journal, {
    phase: "stopping", profileId: PROFILE, accountId: ACCOUNT, callId: "fixture-call-1",
  });
  assert.deepEqual(await h.controller.recover(), { status: "ready" });
  assert.equal(h.controller.state, "ready");
  assert.equal(stopAttempts, 2);
  assert.equal(h.controller.snapshot().last_error, undefined);
  assert.equal(h.controller.snapshot().last_http_status, undefined);
  assert.equal(h.controller.snapshot().stage, 'ready');
  assert.deepEqual(h.journal, { phase: "closed" });
  assert.equal(h.events.filter(event => Array.isArray(event) && event[0] === "create").length, 1);
  assert.deepEqual(h.events.filter(event => Array.isArray(event) && event[0] === "remoteStop").map(event => event.slice(1)), [
    [PROFILE, ACCOUNT, "fixture-call-1"],
    [PROFILE, ACCOUNT, "fixture-call-1"],
  ]);
});

for (const status of [404, 410]) test(`already absent call (${status}) finishes ordinary cleanup without recovery lock`, async () => {
  const h = harness({ stop: async () => { throw Object.assign(new Error('absent'), { code: 'api_request_rejected', status }); } });
  h.controller.wake({ microphone: false });
  await h.controller.pending;
  await h.controller.stop();
  assert.equal(h.controller.state, 'ready');
  assert.deepEqual(h.journal, { phase: 'closed' });
  assert.equal(h.controller.snapshot().last_error, undefined);
  assert.equal(h.controller.snapshot().stop_result, 'already_closed');
});

test('attach conflict and stop failure retain separate evidence and recover on the next wake', async () => {
  let attaches = 0, stops = 0;
  const h = harness({
    attach: async () => {
      if (++attaches === 1) throw Object.assign(new Error('conflict'), { code: 'api_request_rejected', status: 409 });
    },
    stop: async () => {
      if (++stops === 1) throw Object.assign(new Error('unavailable'), { code: 'api_request_rejected', status: 503 });
    },
  });
  h.controller.wake({ microphone: false });
  await h.controller.pending;
  assert.equal(h.controller.state, 'recovery_required');
  assert.equal(h.controller.snapshot().start_error.http_status, 409);
  assert.equal(h.controller.snapshot().stop_error.http_status, 503);
  assert.equal(h.controller.snapshot().start_error.stage, 'attach');
  assert.deepEqual(h.controller.wake({ microphone: false }), { status: 'accepted_wake' });
  await h.controller.pending;
  assert.equal(h.controller.state, 'active');
  assert.equal(h.controller.snapshot().last_error, undefined);
  const operations = h.events.filter(e => Array.isArray(e) && ['create', 'remoteStop'].includes(e[0])).map(e => e[0]);
  assert.deepEqual(operations, ['create', 'remoteStop', 'remoteStop', 'create']);
  assert.equal(h.sessions[1].profileId, PROFILE);
  assert.equal(h.sessions[1].accountId, ACCOUNT);
  await h.controller.stop();
});

test('failed known-call recovery on wake cannot allocate another call', async () => {
  const h = harness({
    initialJournal: { phase: 'stopping', profileId: PROFILE, accountId: ACCOUNT, callId: 'fixture-old-call' },
    stop: async () => { throw Object.assign(new Error('conflict'), { code: 'api_request_rejected', status: 409 }); },
  });
  h.controller.wake();
  await h.controller.pending;
  assert.equal(h.controller.state, 'recovery_required');
  assert.equal(h.controller.snapshot().stop_error.http_status, 409);
  assert.equal(h.journal.callId, 'fixture-old-call');
  assert.equal(h.peers.length, 0);
  assert.equal(h.captures.length, 0);
  assert.deepEqual(h.events.filter(e => Array.isArray(e) && e[0] === 'remoteStop'), [
    ['remoteStop', PROFILE, ACCOUNT, 'fixture-old-call'],
  ]);
});

test('hangup during known-call recovery prevents the subsequent new call', async () => {
  const recovery = deferred();
  const h = harness({
    initialJournal: { phase: 'stopping', profileId: PROFILE, accountId: ACCOUNT, callId: 'fixture-old-call' },
    stop: () => recovery.promise,
  });
  h.controller.wake();
  assert.equal(h.controller.state, 'starting');
  assert.equal(h.controller.wake().status, 'starting');
  assert.equal((await h.controller.recover()).status, 'busy');
  const stopping = h.controller.stop();
  recovery.resolve();
  await stopping;
  assert.equal(h.controller.state, 'ready');
  assert.equal(h.peers.length, 0);
  assert.equal(h.captures.length, 0);
  assert.deepEqual(h.journal, { phase: 'closed' });
});

test('explicit recovery is single-flight and blocks wake while stopping the old call', async () => {
  const recovery = deferred();
  const h = harness({
    initialJournal: { phase: 'stopping', profileId: PROFILE, accountId: ACCOUNT, callId: 'fixture-old-call' },
    stop: () => recovery.promise,
  });
  const first = h.controller.recover();
  const second = h.controller.recover();
  h.controller.wake();
  assert.equal(first, second);
  assert.equal(h.peers.length, 0);
  assert.equal(h.sessions.length, 1);
  recovery.resolve();
  await first;
  assert.equal(h.controller.state, 'ready');
});

test('stop waits for explicit recovery and recovery journal failures stay locked', async () => {
  const recovery = deferred();
  const h = harness({
    initialJournal: { phase: 'stopping', profileId: PROFILE, accountId: ACCOUNT, callId: 'fixture-old-call' },
    stop: () => recovery.promise,
  });
  h.controller.recover();
  let stopped = false;
  const stopping = h.controller.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  recovery.resolve();
  await stopping;
  assert.equal(h.controller.state, 'ready');
  const broken = harness({ initialJournal: { phase: 'stopping', profileId: PROFILE, accountId: ACCOUNT, callId: 'fixture-old-call' } });
  broken.controller.writeJournal = () => { throw new Error('disk unavailable'); };
  assert.deepEqual(await broken.controller.recover(), { status: 'recovery_failed' });
  assert.equal(broken.controller.state, 'recovery_required');
  assert.equal(broken.journal.callId, 'fixture-old-call');
});

test("startup recovery failure leaves the controller visibly locked", async () => {
  const h = harness({
    initialJournal: { phase: "stopping", profileId: PROFILE, accountId: ACCOUNT, callId: "fixture-call-1" },
    stop: async () => { throw Object.assign(new Error("network down"), { code: "request_outcome_unknown" }); },
  });

  assert.deepEqual(await h.controller.recover(), { status: "remote_stop_unconfirmed" });

  assert.equal(h.controller.state, "recovery_required");
  assert.equal(h.snapshots.at(-1)?.state, "recovery_required");
  assert.deepEqual(h.journal, {
    phase: "stopping", profileId: PROFILE, accountId: ACCOUNT, callId: "fixture-call-1",
  });
});

test('sounds follow the call lifecycle once and connection precedes microphone', async () => {
  const h = harness();
  h.controller.wake();
  h.controller.wake();
  await h.controller.pending;
  const cues = () => h.events.filter(e => Array.isArray(e) && e[0] === 'cue').map(e => e[1]);
  assert.deepEqual(cues(), ['calling', 'connected']);
  assert.ok(h.events.findIndex(e => Array.isArray(e) && e[1] === 'connected') < h.events.findIndex(e => Array.isArray(e) && e[0] === 'captureStarted'));
  await h.controller.stop();
  await h.controller.stop();
  assert.equal(cues().filter(e => e === 'ended').length, 1);
});

test('failed call attempt ends audibly without a connection cue', async () => {
  const h = harness({ resolveProfile: async () => { throw new Error('offline'); } });
  h.controller.wake();
  await h.controller.pending;
  assert.deepEqual(h.events.filter(e => Array.isArray(e) && e[0] === 'cue').map(e => e[1]), ['calling', 'ended']);
});

test('Chromium opens the microphone only after the connection cue and publishes quality metrics', async () => {
  const h = harness({ browserMedia: true, stats: { connection_state: 'connected', packetsReceived: 400, packetsLost: 2, jitter: 0.013 } });
  h.controller.wake();
  await h.controller.pending;
  await h.controller.measure();
  assert.ok(h.events.findIndex(e => Array.isArray(e) && e[1] === 'connected') < h.events.indexOf('browserMicrophoneRequested'));
  assert.equal(h.controller.snapshot().microphone_settings.echoCancellation, true);
  assert.equal(h.controller.snapshot().media.packetsLost, 2);
  await h.controller.stop();
  assert.equal(h.controller.snapshot().local_listening, false);
  assert.ok(h.events.includes('captureStopped'));
});

test('cancellation during browser microphone acquisition releases the eventual capture', async () => {
  const acquisition = deferred();
  const h = harness({ browserMedia: true, startMicrophone: () => acquisition.promise });
  h.controller.wake();
  await waitFor(() => h.events.includes('browserMicrophoneRequested'), 'microphone request');
  const stopping = h.controller.stop();
  assert.ok(h.events.includes('peerClosed'));
  acquisition.resolve();
  await stopping;
  assert.equal(h.controller.state, 'ready');
  assert.equal(h.controller.snapshot().local_listening, false);
  assert.ok(h.events.includes('captureStopped'));
});

test('muting and unmuting keep the same live call and remote playback', async () => {
  const h = harness({ browserMedia: true });
  h.controller.wake();
  await h.controller.pending;
  const peer = h.controller.peer;
  assert.deepEqual(h.controller.setMicrophoneEnabled(false), { status: 'muting_microphone' });
  await h.controller.microphonePending;
  assert.equal(h.controller.snapshot().microphone_muted, true);
  assert.equal(h.controller.snapshot().local_listening, false);
  assert.equal(h.controller.state, 'active');
  assert.equal(h.controller.peer, peer);
  assert.equal(h.events.includes('peerClosed'), false);
  assert.equal(h.events.some(e => Array.isArray(e) && e[0] === 'remoteStop'), false);
  assert.deepEqual(h.controller.setMicrophoneEnabled(false), { status: 'microphone_off' });
  assert.deepEqual(h.controller.setMicrophoneEnabled(true), { status: 'unmuting_microphone' });
  await h.controller.microphonePending;
  assert.equal(h.controller.snapshot().local_listening, true);
  assert.equal(h.controller.snapshot().microphone_muted, false);
  assert.equal(h.sessions.length, 1);
  await h.controller.stop();
});

test('end during unmute cancels capture and duplicate switches cannot reopen it', async () => {
  const pendingMic = deferred();
  let starts = 0;
  const h = harness({ browserMedia: true, startMicrophone: () => ++starts === 2 ? pendingMic.promise : undefined });
  h.controller.wake();
  await h.controller.pending;
  h.controller.setMicrophoneEnabled(false);
  await h.controller.microphonePending;
  h.controller.setMicrophoneEnabled(true);
  assert.deepEqual(h.controller.setMicrophoneEnabled(true), { status: 'microphone_busy' });
  const stopping = h.controller.stop();
  assert.ok(h.events.includes('peerClosed'));
  pendingMic.resolve();
  await stopping;
  assert.equal(h.controller.state, 'ready');
  assert.equal(h.controller.snapshot().local_listening, false);
  assert.equal(h.controller.snapshot().microphone_changing, false);
  assert.equal(h.events.filter(e => e === 'captureStopped').length, 2);
  assert.deepEqual(h.controller.setMicrophoneEnabled(true), { status: 'no_active_call' });
});

test('failed microphone reactivation leaves the active call muted', async () => {
  let starts = 0;
  const h = harness({ browserMedia: true, startMicrophone: async () => { if (++starts === 2) throw new Error('device unavailable'); } });
  h.controller.wake();
  await h.controller.pending;
  h.controller.setMicrophoneEnabled(false);
  await h.controller.microphonePending;
  h.controller.setMicrophoneEnabled(true);
  await h.controller.microphonePending;
  assert.equal(h.controller.state, 'active');
  assert.equal(h.controller.snapshot().microphone_muted, true);
  assert.equal(h.controller.snapshot().microphone_error, 'microphone_change_failed');
  await h.controller.stop();
});
