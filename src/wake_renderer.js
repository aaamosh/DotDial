'use strict';
(() => {
  let generation = 0, stream, context, source, worklet, pending = 0;
  const MAX_PENDING = 4;
  const failure = code => Object.assign(new Error(code), { code });
  function stop() {
    generation++;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    try { worklet?.port.postMessage({ type: 'stop' }); } catch {}
    try { source?.disconnect(); worklet?.disconnect(); } catch {}
    source = worklet = null;
    const old = context; context = null;
    void old?.close().catch(() => {});
  }
  function fail(code, ticket) {
    if (ticket !== generation) return;
    stop();
    window.DotDialWakePipe.error(code);
  }
  async function start(deviceId = 'default') {
    stop();
    const ticket = generation;
    let acquired, audioContext;
    try {
      // Wake analysis has no audible output. A modest buffer lets the silent
      // sink's software clock keep up without a system playback device.
      audioContext = new AudioContext({ sampleRate: 16000, sinkId: { type: 'none' }, latencyHint: 0.1 });
      context = audioContext;
      if (audioContext.sampleRate !== 16000) throw failure('wake_audio_sample_rate');
      await audioContext.audioWorklet.addModule(new URL('./wake_worklet.js', document.baseURI).href);
      if (ticket !== generation) throw failure('wake_capture_cancelled');
      const exact = deviceId === 'default' ? null : await DotDialDevices.resolve(deviceId, 'audioinput');
      if (ticket !== generation) throw failure('wake_capture_cancelled');
      acquired = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(exact ? { deviceId: { exact } } : {}),
      } });
      if (ticket !== generation) throw failure('wake_capture_cancelled');
      stream = acquired;
      const input = audioContext.createMediaStreamSource(acquired);
      const processor = new AudioWorkletNode(audioContext, 'dotdial-wake', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      });
      source = input; worklet = processor; pending = 0;
      processor.port.onmessage = event => {
        if (ticket !== generation) return;
        if (event.data?.error) { fail('wake_audio_backpressure', ticket); return; }
        if (pending >= MAX_PENDING) { fail('wake_audio_backpressure', ticket); return; }
        pending++;
        Promise.resolve().then(() => window.DotDialWakePipe.audio(event.data)).then(result => {
          if (!result?.accepted) throw failure(result?.code || 'wake_audio_unavailable');
        }).catch(error => fail(/^[a-z_]{1,80}$/.test(error?.code || '') ? error.code : 'wake_audio_unavailable', ticket))
          .finally(() => {
            if (ticket !== generation) return;
            pending--;
            processor.port.postMessage({ type: 'ack' });
          });
      };
      processor.onprocessorerror = () => fail('wake_audio_unavailable', ticket);
      for (const track of acquired.getAudioTracks()) track.addEventListener('ended', () => fail('wake_audio_unavailable', ticket), { once: true });
      input.connect(processor); processor.connect(audioContext.destination);
      await audioContext.resume();
      if (ticket !== generation) throw failure('wake_capture_cancelled');
      return { sampleRate: audioContext.sampleRate, deviceId };
    } catch (error) {
      acquired?.getTracks().forEach(track => track.stop());
      if (ticket === generation) stop();
      else void audioContext?.close().catch(() => {});
      throw failure(error?.code || (error?.name === 'NotAllowedError' ? 'microphone_permission_required' : 'wake_audio_unavailable'));
    }
  }
  window.DotDialWake = { start, stop };
})();
