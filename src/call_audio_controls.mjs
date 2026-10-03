export class CallAudioControls {
  constructor({ mailbox, controller }) {
    Object.assign(this, { mailbox, controller });
    mailbox.beforePlayback = () => this.beforePlayback();
    mailbox.afterPlayback = context => this.afterPlayback(context);
    mailbox.beforeDrain = async () => {
      const peer = this.controller.peer;
      if (peer && !peer.closed && this.controller.state === 'active') await peer.flushRecording?.();
    };
  }
  async beforePlayback() {
    const controller = this.controller;
    await controller.microphonePending;
    const context = { peer: controller.peer, restoreMicrophone: !!controller.capture };
    this.replayContext = context;
    if (context.peer && controller.state === 'active') {
      controller.setMicrophoneEnabled(false);
      await controller.microphonePending;
      if (controller.capture) throw Error('microphone_pause_failed');
      await context.peer.setSpeakersMuted(true);
    }
    return context;
  }
  async afterPlayback(context = this.replayContext) {
    const controller = this.controller;
    const sameCall = () => context?.peer && context.peer === controller.peer &&
      controller.state === 'active' && !controller.cancelled;
    try {
      if (sameCall()) {
        try { await context.peer.setSpeakersMuted(this.mailbox.desiredMuted); }
        finally {
          // Recorder failure must not strand a microphone paused for replay.
          // Recheck identity after awaiting: a different call may now exist.
          if (sameCall() && context.restoreMicrophone && !this.mailbox.disableMicRestore) {
            controller.setMicrophoneEnabled(true);
            await controller.microphonePending;
          }
        }
      }
    } finally { this.replayContext = null; }
  }
  snapshot() {
    return { ...this.controller.snapshot(), ...this.mailbox.snapshot(),
      microphone_changing: !!this.controller.microphonePending || this.mailbox.playing };
  }
  play() {
    if (['starting', 'stopping'].includes(this.controller.state) || this.controller.microphonePending || this.mailbox.changing) {
      return { status: 'audio_busy' };
    }
    return this.mailbox.play();
  }
  microphone(enabled) {
    if (this.mailbox.playing) {
      if (enabled) return { status: 'replay_active' };
      this.mailbox.disableMicRestore = true;
    }
    return this.controller.setMicrophoneEnabled(enabled);
  }
  speakers(muted) {
    if (this.mailbox.changing) return { status: 'speakers_busy' };
    this.mailbox.changing = true;
    try { this.mailbox.setMuted(muted); }
    catch { this.mailbox.desiredMuted = muted; this.mailbox.setError('recording_failed'); }
    this.speakersPending = (async () => {
      if (!muted && this.mailbox.playing) await this.mailbox.stop();
      const peer = this.controller.peer;
      if (peer && !peer.closed) await peer.setSpeakersMuted(this.mailbox.desiredMuted || this.mailbox.playing);
    })().catch(() => this.mailbox.setError('recording_unavailable')).finally(() => {
      this.mailbox.changing = false; this.mailbox.report();
    });
    this.mailbox.report();
    return { status: muted ? 'muting_speakers' : 'unmuting_speakers' };
  }
}
