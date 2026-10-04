import test from 'node:test';
import assert from 'node:assert/strict';
import { CallAudioControls } from './call_audio_controls.mjs';
function harness(microphone = true) {
  const events = [];
  const peer = { async setSpeakersMuted(value) { events.push(['speakers', value]); } };
  const controller = { state: 'active', peer, capture: microphone ? {} : null,
    snapshot() { return { state: this.state, microphone_muted: !this.capture }; },
    setMicrophoneEnabled(value) {
      events.push(['microphone', value]);
      this.microphonePending = Promise.resolve().then(() => { this.capture = value ? {} : null; this.microphonePending = null; });
    },
  };
  const mailbox = { playing: true, desiredMuted: true, changing: false,
    report() {}, snapshot() { return { missed_playing: this.playing }; },
    setMuted(value) { this.desiredMuted = value; }, setError() {},
    async stop() { this.playing = false; },
  };
  const controls = new CallAudioControls({ mailbox, controller });
  return { controls, controller, mailbox, events };
}
test('replay pauses microphone and live voice, then restores their independent choices', async () => {
  const h = harness(); const context = await h.controls.beforePlayback();
  assert.equal(h.controller.capture, null);
  assert.deepEqual(h.events, [['microphone', false], ['speakers', true]]);
  await h.controls.afterPlayback(context);
  assert.ok(h.controller.capture); assert.deepEqual(h.events.at(-2), ['speakers', true]);
});
test('previously muted microphone stays muted after replay', async () => {
  const h = harness(false); await h.controls.afterPlayback(await h.controls.beforePlayback());
  assert.equal(h.controller.capture, null);
  assert.equal(h.events.some(e => e[0] === 'microphone' && e[1]), false);
});
test('a call that ended during replay cannot have its microphone reopened', async () => {
  const h = harness(); const context = await h.controls.beforePlayback();
  h.controller.peer = null; h.controller.state = 'ready';
  await h.controls.afterPlayback(context);
  assert.equal(h.controller.capture, null);
});
test('hangup revokes replay restoration before it awaits player cleanup', async () => {
  const h = harness();
  const context = await h.controls.beforePlayback();
  let release;
  h.controller.stop = () => {
    h.events.push(['hangup']);
    h.controller.cancelled = true;
    h.controller.state = 'stopping';
    return new Promise(resolve => { release = resolve; });
  };
  h.mailbox.stop = async () => {
    h.events.push(['stop_replay']);
    await h.controls.afterPlayback(context);
    h.mailbox.playing = false;
  };
  const stopping = h.controls.stop();
  assert.deepEqual(h.events.slice(2), [['hangup'], ['stop_replay']]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller.capture, null);
  assert.equal(h.events.some(e => e[0] === 'microphone' && e[1]), false);
  release();
  await stopping;
});
test('explicit microphone mute during replay prevents automatic reactivation', async () => {
  const h = harness(); const context = await h.controls.beforePlayback();
  h.controls.microphone(false); await h.controller.microphonePending;
  await h.controls.afterPlayback(context);
  assert.equal(h.controller.capture, null);
  assert.equal(h.controls.microphone(true).status, 'replay_active');
});
test('unmuting speakers stops replay before resuming the live track', async () => {
  const h = harness(); h.controls.speakers(false); await h.controls.speakersPending;
  assert.equal(h.mailbox.playing, false); assert.equal(h.mailbox.desiredMuted, false);
  assert.deepEqual(h.events.at(-1), ['speakers', false]);
});
test('recorder failure during speaker restore still restores the paused microphone', async () => {
  const h = harness(); const context = await h.controls.beforePlayback();
  context.peer.setSpeakersMuted = async () => { throw Error('recording_failed'); };
  await assert.rejects(h.controls.afterPlayback(context), /recording_failed/);
  assert.ok(h.controller.capture);
  assert.equal(h.controls.replayContext, null);
});
test('call identity is checked again after waiting for speaker restoration', async () => {
  const h = harness(); const context = await h.controls.beforePlayback();
  context.peer.setSpeakersMuted = async () => { h.controller.peer = {}; };
  await h.controls.afterPlayback(context);
  assert.equal(h.controller.capture, null);
});

test('wake activation enables only muted channels and leaves a live microphone untouched', async t => {
  for (const microphone of [false, true]) for (const speakersMuted of [false, true]) {
    await t.test(`microphone=${microphone}, speakersMuted=${speakersMuted}`, async () => {
      const h = harness(microphone);
      h.mailbox.playing = false; h.mailbox.desiredMuted = speakersMuted;
      const originalCapture = h.controller.capture;
      const result = await h.controls.activate(async () => h.events.push(['cue']));
      const expected = [];
      if (speakersMuted) expected.push(['speakers', false]);
      if (!microphone) expected.push(['microphone', true]);
      if (speakersMuted || !microphone) expected.push(['cue']);
      assert.deepEqual(h.events, expected);
      assert.ok(h.controller.capture);
      if (microphone) assert.equal(h.controller.capture, originalCapture, 'live speech must keep its existing capture');
      assert.equal(h.mailbox.desiredMuted, false);
      assert.equal(result.status, expected.length ? 'activated' : 'already_active');
    });
  }
});

test('overlapping wake detections coalesce and cue waits for both controls', async () => {
  const h = harness(false); h.mailbox.playing = false;
  let releaseSpeakers;
  h.controller.peer.setSpeakersMuted = async value => {
    h.events.push(['speakers', value]);
    await new Promise(resolve => { releaseSpeakers = resolve; });
  };
  const cue = async () => h.events.push(['cue']);
  const first = h.controls.activate(cue), second = h.controls.activate(cue);
  assert.equal(first, second);
  assert.deepEqual(h.events, [['speakers', false]]);
  releaseSpeakers();
  assert.equal((await first).status, 'activated');
  assert.deepEqual(h.events, [['speakers', false], ['microphone', true], ['cue']]);
});

test('ending or replacing a call while speakers change prevents microphone activation and cue', async () => {
  const h = harness(false); h.mailbox.playing = false;
  h.controller.peer.setSpeakersMuted = async () => { h.controller.peer = {}; };
  const result = await h.controls.activate(async () => h.events.push(['cue']));
  assert.equal(result.status, 'activation_cancelled');
  assert.equal(h.controller.capture, null);
  assert.deepEqual(h.events, []);
});

test('a newer manual mute cancels the remaining wake activation', async () => {
  const h = harness(false); h.mailbox.playing = false;
  h.controller.peer.setSpeakersMuted = async () => { h.controls.microphone(false); };
  assert.equal((await h.controls.activate(async () => h.events.push(['cue']))).status, 'activation_cancelled');
  assert.equal(h.controller.capture, null);
  assert.deepEqual(h.events, [['microphone', false]]);
});

test('a manual mute during pending device acquisition wins after it finishes', async () => {
  const h = harness(false); h.mailbox.playing = false; h.mailbox.desiredMuted = false;
  let release;
  h.controller.setMicrophoneEnabled = function(enabled) {
    if (this.microphonePending) return { status: 'microphone_busy' };
    h.events.push(['microphone', enabled]);
    this.microphonePending = (enabled ? new Promise(resolve => { release = resolve; }) : Promise.resolve())
      .then(() => { this.capture = enabled ? {} : null; this.microphonePending = null; });
  };
  const active = h.controls.activate(async () => h.events.push(['cue']));
  h.controls.microphone(false);
  release();
  assert.equal((await active).status, 'activation_cancelled');
  assert.equal(h.controller.capture, null);
  assert.deepEqual(h.events, [['microphone', true], ['microphone', false]]);
});

test('a manual speaker mute wins while wake activation is unmuting speakers', async () => {
  const h = harness(false); h.mailbox.playing = false;
  let release;
  h.controller.peer.setSpeakersMuted = async muted => {
    h.events.push(['speakers', muted]);
    if (!muted) await new Promise(resolve => { release = resolve; });
  };
  const pending = h.controls.activate(async () => h.events.push(['cue']));
  assert.equal(h.controls.speakers(true).status, 'muting_speakers');
  release();
  assert.equal((await pending).status, 'activation_cancelled');
  assert.equal(h.mailbox.desiredMuted, true);
  assert.equal(h.controller.capture, null);
  assert.deepEqual(h.events, [['speakers', false], ['speakers', true]]);
});

test('wake activation interrupts replay without deleting the unplayed queue', async () => {
  const h = harness(false);
  h.mailbox.queue = ['unheard', 'next'];
  h.mailbox.stop = async () => { h.events.push(['stop_replay']); h.mailbox.playing = false; };
  assert.equal((await h.controls.activate(async () => h.events.push(['cue']))).status, 'activated');
  assert.deepEqual(h.mailbox.queue, ['unheard', 'next']);
  assert.deepEqual(h.events, [['stop_replay'], ['speakers', false], ['microphone', true], ['cue']]);
});

test('failed speaker activation and busy audio do not play a success cue', async () => {
  const h = harness(false); h.mailbox.playing = false;
  h.controller.peer.setSpeakersMuted = async () => { throw Error('output_failed'); };
  assert.equal((await h.controls.activate(async () => h.events.push(['cue']))).status, 'activation_failed');
  assert.equal(h.controller.capture, null); assert.deepEqual(h.events, []);
  h.mailbox.changing = true;
  assert.equal((await h.controls.activate(async () => h.events.push(['cue']))).status, 'audio_busy');
  assert.deepEqual(h.events, []);
});
