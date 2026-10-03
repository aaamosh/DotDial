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
