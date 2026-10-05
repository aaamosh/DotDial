'use strict';

(() => {
  let peer, channel, transceiver, microphone, silentContext, silentSource, silentTrack, closed = false, eventCount = 0;
  let microphoneGeneration = 0, microphoneError = null;
  const output = document.getElementById('remote');
  const diagnostics = new AudioDiagnostics();
  const eventTypes = {};
  const technicalEvents = new Set(['session.created', 'session.updated', 'response.created', 'response.done',
    'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed',
    'input_audio_buffer.cleared', 'output_audio_buffer.started', 'output_audio_buffer.stopped', 'output_audio_buffer.cleared',
    'response.audio.done', 'response.output_audio.done', 'error']);
  let playbackError = false, playbackStarted = false, playbackTimer;
  let playbackReserveMs = 0, microphoneDeviceId = 'default', outputDeviceId = 'default', recordingEnabled = true;
  let speakersMuted = false, missedCapture, captureReady, recordingError, playbackSource, speakerGain;
  const failure = code => Object.assign(new Error(code), { code });
  const stopStream = stream => stream?.getTracks().forEach(track => {
    if (track.readyState !== 'ended') track.stop();
  });
  const liveMicrophoneTrack = () => microphone?.getAudioTracks().find(track => track.readyState === 'live');

  async function restoreMicrophoneTrack(force = false) {
    // Every asynchronous replacement must converge on the latest capture.
    // In particular, delayed unplug cleanup must not silence a newer unmute.
    while (!closed && transceiver) {
      const generation = microphoneGeneration;
      const track = liveMicrophoneTrack() || silentTrack;
      if (track?.readyState !== 'live' || (!force && transceiver.sender.track === track)) return;
      force = false;
      try { await transceiver.sender.replaceTrack(track); } catch { return; }
      if (generation === microphoneGeneration) return;
    }
  }

  function configure(options = {}) {
    if (peer) throw failure('media_already_started');
    if (!Number.isInteger(options.bufferMs ?? 0) || (options.bufferMs ?? 0) < 0 || (options.bufferMs ?? 0) > 2000) throw failure('invalid_audio_buffer');
    playbackReserveMs = options.bufferMs ?? 0;
    microphoneDeviceId = options.microphoneDeviceId || 'default';
    outputDeviceId = options.outputDeviceId || 'default';
    recordingEnabled = options.recordingEnabled !== false;
  }

  async function createOffer() {
    if (closed || peer) throw failure('media_not_ready');
    peer = new RTCPeerConnection({ iceServers: [] });
    silentContext = new AudioContext({ sampleRate: 48000 });
    if (outputDeviceId !== 'default') {
      if (!silentContext.setSinkId) throw failure('output_device_unsupported');
      await silentContext.setSinkId(await DotDialDevices.resolve(outputDeviceId, 'audiooutput'));
    }
    const silentOutput = silentContext.createMediaStreamDestination();
    silentSource = silentContext.createConstantSource();
    silentSource.offset.value = 0;
    silentSource.connect(silentOutput);
    silentSource.start();
    await silentContext.resume();
    // The same post-NetEQ waveform feeds the archive and final speaker gain.
    // The permanently silent element below supplies Chromium's WebRTC clock.
    speakerGain = silentContext.createGain();
    speakerGain.gain.value = speakersMuted ? 0 : 1;
    speakerGain.connect(silentContext.destination);
    if (recordingEnabled && window.DotDialArchive) {
      try { await MissedCapture.prepare(silentContext); }
      catch { recordingError = 'recording_unavailable'; window.DotDialArchive.error(recordingError); }
    }
    silentTrack = silentOutput.stream.getAudioTracks()[0];
    transceiver = peer.addTransceiver(silentTrack, { direction: 'sendrecv', streams: [silentOutput.stream] });
    const codecs = RTCRtpReceiver.getCapabilities('audio').codecs.filter(c => c.mimeType.toLowerCase() === 'audio/opus');
    if (codecs.length) transceiver.setCodecPreferences(codecs);
    channel = peer.createDataChannel('oai-events');
    channel.onmessage = event => {
      eventCount++;
      try {
        const type = JSON.parse(event.data).type;
        if (technicalEvents.has(type)) eventTypes[type] = (eventTypes[type] || 0) + 1;
      } catch {}
    };
    peer.ontrack = event => {
      if (playbackReserveMs > 0 && 'jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = playbackReserveMs;
      // Fill NetEQ before connecting its output. Starting with an empty buffer
      // makes it conceal and time-stretch speech while slowly building reserve.
      // Wait from the first RTP audio, not from SDP/ICE, which can be much earlier.
      const start = () => {
        if (closed) return;
        playbackTimer = setTimeout(() => {
          if (closed || event.track.readyState === 'ended') return;
          try {
            const received = new MediaStream([event.track]);
            playbackSource = silentContext.createMediaStreamSource(received);
            playbackSource.connect(speakerGain);
            // On this Electron build a remote WebAudio source alone receives
            // packets but never pulls decoded samples. Keep this clock driver
            // playing and permanently muted; never toggle it for speaker mute.
            output.muted = true;
            output.srcObject = received;
            output.play().catch(() => { playbackError = true; });
            playbackStarted = true;
            if (!recordingEnabled || !window.DotDialArchive || closed) return;
            try { missedCapture = new MissedCapture(silentContext, received, {
              sourceNode: playbackSource,
              onSegment: async payload => {
                const result = await window.DotDialArchive.save(payload);
                if (!result?.saved) throw failure(result?.code || 'recording_failed');
              },
              onRecording: active => window.DotDialArchive.recording(active),
              onError: code => { recordingError = code; window.DotDialArchive.error(code); },
            });
            captureReady = missedCapture.ready.then(() => missedCapture.setMuted(speakersMuted))
              .catch(() => { recordingError = 'recording_unavailable'; window.DotDialArchive.error(recordingError); });
            } catch { recordingError = 'recording_unavailable'; window.DotDialArchive.error(recordingError); }
          } catch { playbackError = true; }
        }, playbackReserveMs);
      };
      if (event.track.muted) event.track.addEventListener('unmute', start, { once: true });
      else start();
    };
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== 'complete') {
      await new Promise((resolve, reject) => {
        const finish = () => {
          if (peer.iceGatheringState !== 'complete' && !closed) return;
          clearTimeout(timeout);
          peer.removeEventListener('icegatheringstatechange', finish);
          closed ? reject(failure('cancelled')) : resolve();
        };
        const timeout = setTimeout(() => {
          peer.removeEventListener('icegatheringstatechange', finish);
          reject(failure('ice_gathering_timeout'));
        }, 8000);
        peer.addEventListener('icegatheringstatechange', finish);
        finish();
      });
    }
    if (closed) throw failure('cancelled');
    return peer.localDescription.sdp;
  }

  async function acceptAnswer(sdp) {
    await peer.setRemoteDescription({ type: 'answer', sdp });
  }

  async function waitForOpen(timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (!closed && performance.now() < deadline) {
      if (playbackError) throw failure('audio_playback_failed');
      if (peer.connectionState === 'failed') throw failure('media_connection_failed');
      if (peer.connectionState === 'connected' && channel.readyState === 'open') return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw failure(closed ? 'cancelled' : 'media_open_timeout');
  }

  async function startMicrophone() {
    if (closed) throw failure('cancelled');
    const generation = ++microphoneGeneration;
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (microphoneDeviceId !== 'default') {
      const deviceId = await DotDialDevices.resolve(microphoneDeviceId, 'audioinput');
      if (closed || generation !== microphoneGeneration) throw failure('cancelled');
      audio.deviceId = { exact: deviceId };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio });
    if (closed || generation !== microphoneGeneration) {
      stopStream(stream);
      throw failure('cancelled');
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stopStream(stream);
      throw failure('microphone_unavailable');
    }
    if (track.readyState !== 'live') {
      stopStream(stream);
      microphoneError = 'microphone_ended';
      throw failure('microphone_ended');
    }
    microphone = stream;
    let unexpectedlyEnded = false;
    const onEnded = () => {
      if (closed || microphone !== stream || generation !== microphoneGeneration) return;
      unexpectedlyEnded = true;
      microphoneGeneration++;
      microphone = null;
      microphoneError = 'microphone_ended';
      stopStream(stream);
      void restoreMicrophoneTrack();
    };
    track.addEventListener('ended', onEnded, { once: true });
    try {
      await transceiver.sender.replaceTrack(track);
    } catch (error) {
      if (microphone === stream) microphone = null;
      track.removeEventListener('ended', onEnded);
      stopStream(stream);
      if (unexpectedlyEnded) throw failure('microphone_ended');
      throw error;
    }
    // readyState can change before the queued ended event reaches JavaScript.
    if (track.readyState !== 'live') onEnded();
    if (closed || generation !== microphoneGeneration) {
      if (microphone === stream) microphone = null;
      track.removeEventListener('ended', onEnded);
      stopStream(stream);
      // A mute or newer acquisition can race with replaceTrack(). Restore
      // only the current desired track if this stale completion won the race.
      await restoreMicrophoneTrack();
      throw failure(unexpectedlyEnded ? 'microphone_ended' : 'cancelled');
    }
    microphoneError = null;
    const settings = track.getSettings();
    return Object.fromEntries(['sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl'].map(key => [key, settings[key]]));
  }

  async function stopMicrophone() {
    microphoneGeneration++;
    const stream = microphone;
    microphone = null;
    microphoneError = null;
    stopStream(stream);
    await restoreMicrophoneTrack(true);
  }

  async function setSpeakersMuted(muted) {
    speakersMuted = muted === true;
    // Mute after the shared buffered source, so recording and playback keep
    // consuming exactly the same samples and the receiver clock never changes.
    if (speakersMuted && speakerGain) speakerGain.gain.setValueAtTime(0, silentContext.currentTime);
    try {
      if (captureReady) await captureReady;
      if (missedCapture) await missedCapture.setMuted(speakersMuted);
    } finally {
      if (!closed && speakerGain) speakerGain.gain.setValueAtTime(speakersMuted ? 0 : 1, silentContext.currentTime);
    }
    return { speakers_muted: speakersMuted };
  }

  async function flushRecording() {
    if (captureReady) await captureReady;
    if (missedCapture && !closed) await missedCapture.flush();
  }

  async function stats() {
    if (!peer || closed) return {};
    const reports = await peer.getStats();
    return { engine: 'chromium_webrtc', connection_state: peer.connectionState, event_count: eventCount,
      event_types: { ...eventTypes }, microphone_active: !!liveMicrophoneTrack(), microphone_error: microphoneError, playback_error: playbackError,
      playback_started: playbackStarted, playback_reserve_ms: playbackReserveMs,
      recording_source: 'shared_buffered_stream', speaker_gain: speakerGain?.gain.value,
      clock_driver_muted: output.muted,
      speakers_muted: speakersMuted, recording_error: recordingError,
      receiver_buffer_target_ms: transceiver.receiver.jitterBufferTarget,
      audio_context_state: silentContext.state, ...diagnostics.collect(reports) };
  }

  async function close() {
    closed = true;
    microphoneGeneration++;
    clearTimeout(playbackTimer);
    stopMicrophone();
    silentTrack?.stop();
    try { silentSource?.stop(); } catch {}
    output.pause();
    output.srcObject = null;
    channel?.close();
    peer?.close();
    if (captureReady) await captureReady;
    if (missedCapture) await missedCapture.close();
    playbackSource?.disconnect();
    speakerGain?.disconnect();
    if (silentContext?.state !== 'closed') await silentContext?.close();
  }

  window.DotDialMedia = { configure, createOffer, acceptAnswer, waitForOpen, startMicrophone, stopMicrophone, setSpeakersMuted, flushRecording, stats, close };
})();
