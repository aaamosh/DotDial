export class CallAudioControls {
  constructor({ mailbox, controller }) {
    Object.assign(this, { mailbox, controller });
    this.activationGeneration = 0;
    this.activationPending = null;
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
  stop() {
    this.cancelActivation();
    this.mailbox.disableMicRestore = true;
    // Revoke call ownership synchronously, before replay cleanup can restore
    // a live microphone or speakers across its first await.
    const stopping = this.controller.stop();
    return Promise.all([stopping, this.mailbox.stop()]);
  }
  play() {
    this.cancelActivation();
    if (['starting', 'stopping'].includes(this.controller.state) || this.controller.microphonePending || this.mailbox.changing) {
      return { status: 'audio_busy' };
    }
    return this.mailbox.play();
  }
  microphone(enabled) {
    this.cancelActivation();
    this.microphoneChoice = enabled;
    if (this.mailbox.playing) {
      if (enabled) return { status: 'replay_active' };
      this.mailbox.disableMicRestore = true;
    }
    return this.controller.setMicrophoneEnabled(enabled);
  }
  speakers(muted, { activation = false } = {}) {
    if (!activation) this.cancelActivation();
    const changing = this.mailbox.changing;
    // A manual choice can supersede an in-flight wake activation.
    if (changing && (activation || !this.activationPending)) return { status: 'speakers_busy' };
    this.mailbox.changing = true;
    try { this.mailbox.setMuted(muted); }
    catch { this.mailbox.desiredMuted = muted; this.mailbox.setError('recording_failed'); }
    if (changing) return { status: muted ? 'muting_speakers' : 'unmuting_speakers' };
    this.speakersPending = (async () => {
      if (!muted && this.mailbox.playing) await this.mailbox.stop();
      const peer = this.controller.peer;
      if (peer && !peer.closed) {
        let requested;
        do {
          requested = this.mailbox.desiredMuted || this.mailbox.playing;
          await peer.setSpeakersMuted(requested);
        } while (peer === this.controller.peer && !peer.closed && requested !== (this.mailbox.desiredMuted || this.mailbox.playing));
      }
      return true;
    })().catch(() => { this.mailbox.setError('recording_unavailable'); return false; }).finally(() => {
      this.mailbox.changing = false; this.mailbox.report();
    });
    this.mailbox.report();
    return { status: muted ? 'muting_speakers' : 'unmuting_speakers' };
  }
  cancelActivation() { this.activationGeneration++; }
  activate(cue = async () => {}) {
    if (this.activationPending) return this.activationPending;
    const { controller, mailbox } = this;
    const peer = controller.peer;
    if (!peer || controller.state !== 'active' || controller.cancelled) return Promise.resolve({ status: 'no_active_call' });
    if (controller.microphonePending || mailbox.changing) return Promise.resolve({ status: 'audio_busy' });
    if (controller.capture && !mailbox.desiredMuted && !mailbox.playing) return Promise.resolve({ status: 'already_active' });
    const generation = ++this.activationGeneration;
    const sameCall = () => controller.peer === peer && controller.state === 'active' && !controller.cancelled;
    const current = () => sameCall() && this.activationGeneration === generation;
    this.microphoneChoice = null;
    this.activationPending = (async () => {
      // Stopping replay can restore the microphone itself. Recheck afterward.
      if (mailbox.desiredMuted || mailbox.playing) {
        const result = this.speakers(false, { activation: true });
        if (result.status !== 'unmuting_speakers' || !await this.speakersPending) return { status: 'activation_failed' };
      }
      if (!current()) return { status: 'activation_cancelled' };
      if (mailbox.playing || mailbox.desiredMuted || mailbox.changing) return { status: 'audio_busy' };
      if (!controller.capture) {
        if (controller.microphonePending) return { status: 'audio_busy' };
        controller.setMicrophoneEnabled(true);
        await controller.microphonePending;
        // A newer explicit mute must win even if device acquisition was pending.
        if (!current() && sameCall() && this.microphoneChoice === false && controller.capture) {
          controller.setMicrophoneEnabled(false);
          await controller.microphonePending;
        }
      }
      if (!current()) return { status: 'activation_cancelled' };
      if (!controller.capture || mailbox.desiredMuted || mailbox.playing || mailbox.changing) return { status: 'activation_failed' };
      await cue();
      return { status: 'activated' };
    })().catch(() => ({ status: 'activation_failed' })).finally(() => { this.activationPending = null; });
    return this.activationPending;
  }
}
