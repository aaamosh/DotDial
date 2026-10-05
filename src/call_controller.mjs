export class CallController {
  constructor({ makeSession, native, expectedProfile, readJournal, writeJournal, publish, cue = async () => {} }) {
    Object.assign(this, { makeSession, native, expectedProfile, readJournal, writeJournal, publish, cue });
    this.state = 'ready';
    this.metrics = {};
    this.pending = null;
    this.stopping = null;
    this.session = null;
    this.peer = null;
    this.capture = null;
    this.cancelled = false;
    this.microphonePending = null;
    this.microphoneGeneration = 0;
    this.microphoneTarget = null;
    this.microphoneStopping = null;
    this.recoveryPending = null;
  }

  snapshot() {
    return { state: this.state, local_listening: !!this.capture,
      microphone_muted: this.state === 'active' && !this.capture,
      microphone_changing: !!this.microphonePending, ...this.metrics };
  }

  report() {
    // Observers must never interrupt capture cancellation or remote cleanup.
    try { this.publish(this.snapshot()); }
    catch { this.metrics.status_error = 'status_publish_failed'; }
  }

  wake({ microphone = true, maxSeconds = 600 } = {}) {
    if (this.pending || this.stopping || this.recoveryPending || !['ready', 'recovery_required'].includes(this.state)) return { status: this.state };
    const journal = this.readJournal();
    if (journal && journal.phase !== 'closed' && !journal.callId) {
      this.state = 'recovery_required'; this.report();
      return { status: 'creation_outcome_unknown' };
    }
    this.state = 'starting';
    this.cancelled = false;
    this.callAttempt = true;
    void this.cue('calling');
    this.startedAt = performance.now();
    this.metrics = { input_samples: 0, input_peak: 0, remote_audio_frames: 0, remote_peak: 0, event_count: 0, timings_ms: {} };
    this.report();
    this.pending = this.start(microphone, maxSeconds).catch(async err => {
      this.metrics.stage = err.stage || this.metrics.stage;
      if (this.cancelled && err.code === 'cancelled') {
        // A requested hangup is a normal outcome, including while create is
        // in flight. Cleanup still confirms the exact allocated call below.
        this.metrics.start_result = 'cancelled';
      } else {
        this.metrics.last_error = err.code || 'call_start_failed';
        this.metrics.last_http_status = err.status || null;
        this.metrics.api_reason = err.apiReason || null;
        this.metrics.start_error = { stage: this.metrics.stage, code: this.metrics.last_error,
          http_status: this.metrics.last_http_status, api_reason: this.metrics.api_reason };
      }
      await this.cleanup();
    }).finally(() => { this.pending = null; });
    return { status: 'accepted_wake' };
  }

  check() { if (this.cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); }

  async step(name, action, { announce = true } = {}) {
    const metrics = this.metrics;
    if (announce) { metrics.stage = name; this.report(); }
    const started = performance.now();
    try { return await action(); }
    catch (error) { error.stage ??= name; throw error; }
    finally {
      metrics.timings_ms[name] = Math.round(performance.now() - started);
      if (this.metrics === metrics) this.report();
    }
  }

  async start(microphone, maxSeconds) {
    const journal = this.readJournal();
    if (journal && journal.phase !== 'closed') {
      const result = await this.step('recovery', () => this.recoverSavedCall());
      if (result.status !== 'ready') throw Object.assign(new Error(result.status), { code: result.status });
      this.check();
    }
    this.disconnectedAt = null;
    const s = this.makeSession(); this.session = s;
    if (s.timings) this.metrics.signaling_ms = s.timings;
    this.metrics.stage = 'prepare'; this.report();
    const isCurrentSession = () => this.session === s && !this.cancelled;
    this.peer = new this.native.LiveWebRtcPeer(
      (err) => { if (!err && isCurrentSession()) this.metrics.event_count++; },
      (err, level) => {
        if (!err && isCurrentSession() && Number.isFinite(Number(level))) {
          this.metrics.remote_peak = Math.max(this.metrics.remote_peak, Number(level));
          if (Number(level) > .002) this.metrics.remote_audio_frames++;
        }
      },
      () => {
        if (!isCurrentSession()) return;
        this.metrics.last_error = 'media_connection_failed'; void this.stop();
      }
    );
    // Local offer preparation uses generated silence, with no microphone or
    // cloud call. Overlap it with account/profile verification, then require
    // both to succeed before the one-shot server allocation.
    const [profile, offer] = await Promise.all([
      this.step('profile', () => s.resolveProfile(), { announce: false }),
      this.step('offer', () => this.peer.createOffer(), { announce: false }),
    ]);
    this.check();
    if (this.expectedProfile && profile.profileId !== this.expectedProfile) throw Object.assign(new Error('profile mismatch'), { code: 'dot_profile_mismatch', stage: 'profile' });
    this.writeJournal({ phase: 'creating', profileId: s.profileId, accountId: s.accountId });
    let answer;
    try { answer = await this.step('create', () => s.create(offer)); }
    catch (err) {
      if (!s.callId && (['not_sent', 'rejected'].includes(s.creationOutcome) ||
          (s.creationOutcome === undefined && err.status >= 400 && err.status < 500))) {
        this.writeJournal({ phase: 'closed' });
      }
      throw err;
    }
    this.writeJournal({ phase: 'created', profileId: s.profileId, accountId: s.accountId, callId: s.callId });
    this.check();
    await this.step('accept_answer', () => this.peer.acceptAnswer(answer.answerSdp)); this.check();
    await this.step('attach', () => s.attach()); this.check();
    await this.step('media_open', () => this.peer.waitForOpen(20000)); this.check();
    this.writeJournal({ phase: 'active', profileId: s.profileId, accountId: s.accountId, callId: s.callId });
    await this.step('connected_cue', () => this.cue('connected')); this.check();
    if (microphone && this.peer.startMicrophone) {
      this.capture = await this.step('microphone', () => this.peer.startMicrophone()); this.check();
      this.metrics.microphone_settings = this.peer.microphoneSettings;
    } else if (microphone) {
      this.capture = new this.native.AudioCapture(16000, (err, samples) => {
        if (err || this.cancelled || this.state !== 'active') return;
        this.metrics.input_samples += samples.length;
        for (const v of samples) this.metrics.input_peak = Math.max(this.metrics.input_peak, Math.abs(v));
        try { this.peer?.pushAudio(samples); } catch { void this.stop(); }
      });
    }
    this.state = 'active';
    this.metrics.stage = 'active';
    this.metrics.startup_ms = Math.round(performance.now() - this.startedAt);
    this.report();
    this.timer = setTimeout(() => void this.stop(), maxSeconds * 1000);
    this.meter = setInterval(() => void this.measure(), 2000);
    void this.measure();
  }

  async measure() {
    if (this.measuring || this.state !== 'active') return;
    this.measuring = true;
    const peer = this.peer;
    const capture = this.capture;
    const microphoneGeneration = this.microphoneGeneration;
    const microphonePending = this.microphonePending;
    try {
      if (peer?.getStats) {
        const media = await peer.getStats();
        if (peer !== this.peer || this.state !== 'active') return;
        const currentMicrophone = capture === this.capture && microphoneGeneration === this.microphoneGeneration &&
          !microphonePending && !this.microphonePending;
        if (currentMicrophone && capture && media.microphone_active === false) {
          // The renderer already released an ended track. Keep the call and
          // playback alive, and allow the next explicit unmute to reacquire.
          this.capture = null;
          this.metrics.microphone_error = 'microphone_ended';
        }
        // A stats reply can describe the old track after a newer unmute has
        // completed. Its connection/playback data is still useful, but its
        // microphone fields must not override the latest local intent.
        this.metrics.media = currentMicrophone ? media : { ...media,
          microphone_active: !!this.capture,
          microphone_error: this.metrics.microphone_error === 'microphone_ended' ? 'microphone_ended' : null };
        this.metrics.event_count = media.event_count || 0;
        this.metrics.remote_audio_frames = media.packetsReceived || 0;
        this.metrics.remote_peak = Math.max(this.metrics.remote_peak, media.audioLevel || 0);
        this.metrics.input_peak = Math.max(this.metrics.input_peak, media.inputAudioLevel || 0);
        this.metrics.input_samples = this.capture ? Math.round((media.inputAudioDuration || 0) * (peer.microphoneSettings?.sampleRate || 48000)) : 0;
        if (media.connection_state === 'disconnected') this.disconnectedAt ??= Date.now();
        else this.disconnectedAt = null;
        if (media.connection_state === 'failed' || media.playback_error || (this.disconnectedAt && Date.now() - this.disconnectedAt > 15000)) {
          this.metrics.last_error = media.playback_error ? 'audio_playback_failed' : 'media_connection_failed';
          void this.stop();
        }
      }
      this.report();
    } catch {
      if (peer === this.peer && this.state === 'active') this.metrics.media_stats_unavailable = true;
    } finally { this.measuring = false; }
  }

  setMicrophoneEnabled(enabled) {
    if (this.state !== 'active' || this.cancelled) return { status: 'no_active_call' };
    if (this.microphonePending && this.microphoneTarget === enabled) return { status: 'microphone_busy' };
    if (!this.microphonePending && !!this.capture === enabled) return { status: enabled ? 'microphone_on' : 'microphone_off' };
    const peer = this.peer;
    if (!peer?.startMicrophone || !peer?.stopMicrophone) return { status: 'microphone_control_unavailable' };
    // Mute revokes an unfinished acquisition before sending its asynchronous
    // stop. A subsequent unmute waits for that stop, never for the old capture.
    const generation = ++this.microphoneGeneration;
    this.microphoneTarget = enabled;
    const current = () => generation === this.microphoneGeneration && peer === this.peer &&
      !this.cancelled && this.state === 'active';
    delete this.metrics.microphone_error;
    let operation;
    operation = (async () => {
      if (enabled) {
        if (this.microphoneStopping) await this.microphoneStopping;
        if (!current()) return;
        const capture = await peer.startMicrophone();
        if (!current()) {
          // Chromium capture handles stop the peer's CURRENT microphone. The
          // earlier mute already cancelled this acquisition on the same peer;
          // stopping its stale handle could instead mute a newer acquisition.
          if (peer !== this.peer) capture.stop();
          return;
        }
        this.capture = capture;
        this.metrics.microphone_settings = peer.microphoneSettings;
      } else {
        const capture = this.capture;
        if (!this.microphoneStopping) {
          const stopping = Promise.resolve(peer.stopMicrophone());
          this.microphoneStopping = stopping;
          const clear = () => { if (this.microphoneStopping === stopping) this.microphoneStopping = null; };
          void stopping.then(clear, clear);
        }
        await this.microphoneStopping;
        if (peer === this.peer && this.capture === capture) this.capture = null;
      }
      if (current() && this.metrics.media) {
        this.metrics.media.microphone_active = !!this.capture;
        this.metrics.media.microphone_error = null;
      }
    })().catch(() => {
      if (current()) this.metrics.microphone_error = 'microphone_change_failed';
    }).finally(() => {
      if (this.microphonePending === operation) {
        this.microphonePending = null;
        this.microphoneTarget = null;
        this.report();
      }
    });
    this.microphonePending = operation;
    this.report();
    return { status: enabled ? 'unmuting_microphone' : 'muting_microphone' };
  }

  stop() {
    this.cancelled = true;
    this.microphoneGeneration++;
    void this.cue('silence');
    try { this.capture?.stop(); } catch {}
    this.capture = null;
    const peer = this.peer; this.peer = null;
    let closing;
    try { closing = Promise.resolve(peer?.close()).catch(() => {}); } catch {}
    if (this.stopping) return this.stopping;
    this.state = 'stopping'; this.report();
    this.stopping = (async () => {
      await this.pending;
      await this.recoveryPending;
      await closing;
      await this.microphonePending;
      await this.cleanup();
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async cleanup() {
    clearTimeout(this.timer); clearInterval(this.meter);
    try { this.capture?.stop(); } catch {}
    this.capture = null;
    const peer = this.peer; this.peer = null;
    // Stop local playback and input even if the remote service is unreachable.
    try { await peer?.close(); } catch {}
    if (this.callAttempt) {
      this.callAttempt = false;
      try { await this.cue('ended'); }
      catch { this.metrics.sound_error = 'end_sound_failed'; }
    }
    const s = this.session; this.session = null;
    if (s?.callId) {
      try { this.writeJournal({ phase: 'stopping', profileId: s.profileId, accountId: s.accountId, callId: s.callId }); }
      catch { this.metrics.journal_error = 'journal_write_failed'; }
      // A full disk must not stop us releasing an already known remote call.
      // If the closed marker cannot be saved, retain recovery on the old ID.
      try { await this.closeRemote(s); }
      catch { this.metrics.last_error = 'journal_write_failed'; }
    }
    const j = this.readJournal();
    this.state = j && j.phase !== 'closed' ? 'recovery_required' : 'ready';
    if (this.state === 'ready' && !this.metrics.last_error) this.metrics.stage = 'ready';
    this.report();
  }

  async closeRemote(session) {
    try {
      await session.stop();
      this.metrics.stop_result = 'confirmed';
    } catch (err) {
      this.metrics.stop_error = { code: err.code || 'remote_stop_failed',
        http_status: err.status || null, api_reason: err.apiReason || null };
      // The exact call is already absent. Use the same terminal semantics
      // during ordinary cleanup and restart recovery.
      if (![404, 410].includes(err.status)) {
        this.metrics.last_error = 'remote_stop_unconfirmed';
        return false;
      }
      this.metrics.stop_result = 'already_closed';
    }
    this.writeJournal({ phase: 'closed' });
    return true;
  }

  async recoverSavedCall() {
    const j = this.readJournal();
    if (!j || j.phase === 'closed') return { status: 'ready' };
    if (!j.callId) return { status: 'creation_outcome_unknown' };
    const s = this.makeSession();
    s.profileId = j.profileId; s.accountId = j.accountId; s.callId = j.callId;
    return { status: await this.closeRemote(s) ? 'ready' : 'remote_stop_unconfirmed' };
  }

  recover() {
    if (this.recoveryPending) return this.recoveryPending;
    if (this.pending || this.stopping || this.peer || this.capture) return Promise.resolve({ status: 'busy' });
    this.recoveryPending = this.recoverSavedCall().then(result => {
      this.state = result.status === 'ready' ? 'ready' : 'recovery_required';
      if (result.status === 'ready') this.metrics = { stage: 'ready' };
      else this.metrics.last_error = result.status;
      this.report();
      return result;
    }).catch(() => {
      this.state = 'recovery_required';
      this.metrics.last_error = 'recovery_failed';
      this.report();
      return { status: 'recovery_failed' };
    }).finally(() => { this.recoveryPending = null; });
    return this.recoveryPending;
  }
}
