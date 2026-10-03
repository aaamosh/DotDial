'use strict';

const TARGET_SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 960; // 20 ms at 48 kHz.
const PRE_ROLL_SAMPLES = 14_400; // 300 ms.
const SILENCE_END_SAMPLES = 57_600; // 1.2 s.
const TRAILING_SAMPLES = 7_200; // Keep 150 ms after the last voiced frame.
const MIN_VOICE_SAMPLES = 4_800; // 100 ms above the speech threshold.
const MAX_SEGMENT_SAMPLES = 2_880_000; // Split continuous speech at 60 s.
const SPEECH_RMS_THRESHOLD = 0.002;

class DotDialMissedCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;
    this.closed = false;
    this.nextSegmentId = 1;
    this.active = false;
    this.continuationPending = false;
    this.continuationQuietSamples = 0;
    this.segmentId = 0;
    this.continued = false;
    this.segmentSamples = 0;
    this.voiceSamples = 0;
    this.quietSamples = 0;
    this.frame = new Float32Array(FRAME_SAMPLES);
    this.frameLength = 0;
    this.preRoll = new Int16Array(PRE_ROLL_SAMPLES);
    this.preRollWrite = 0;
    this.preRollLength = 0;
    this.port.onmessage = event => this.handleMessage(event.data);
    this.port.postMessage({ type: 'ready', sampleRate: sampleRate });
  }

  process(inputs, outputs) {
    for (const output of outputs[0] || []) output.fill(0);
    if (this.closed || !this.muted) return true;

    const channels = inputs[0] || [];
    const frameCount = outputs[0]?.[0]?.length || channels[0]?.length || FRAME_SAMPLES;
    const channelCount = channels.length;
    for (let index = 0; index < frameCount; index++) {
      let mono = 0;
      if (channelCount) {
        for (let channel = 0; channel < channelCount; channel++) {
          const value = channels[channel][index];
          if (Number.isFinite(value)) mono += value;
        }
        mono /= channelCount;
      }
      this.frame[this.frameLength++] = mono;
      if (this.frameLength === FRAME_SAMPLES) this.consumeFrame(FRAME_SAMPLES);
    }
    return true;
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'abort') {
      this.muted = false;
      this.closed = true;
      this.clearCaptureState();
      return;
    }

    if (message.type === 'set-muted') {
      if (this.closed) {
        this.ack(message.requestId, this.muted);
        return;
      }
      const nextMuted = message.muted === true;
      if (this.muted && !nextMuted) {
        this.flushPartialFrame();
        this.finishActive('unmuted');
      }
      if (!this.muted && nextMuted) this.clearCaptureState();
      this.muted = nextMuted;
      if (!nextMuted) this.clearCaptureState();
      this.ack(message.requestId, this.muted);
      return;
    }

    if (message.type === 'flush') {
      if (!this.closed && this.muted) {
        this.flushPartialFrame();
        if (this.active) this.finishActive('flush');
      }
      this.ack(message.requestId, this.muted);
      return;
    }

    if (message.type === 'close') {
      if (!this.closed) {
        if (this.muted) {
          this.flushPartialFrame();
          this.finishActive('close');
        }
        this.muted = false;
        this.clearCaptureState();
        this.closed = true;
      }
      this.ack(message.requestId, false);
    }
  }

  ack(requestId, muted) {
    this.port.postMessage({ type: 'ack', requestId, muted });
  }

  flushPartialFrame() {
    if (!this.frameLength) return;
    const length = this.frameLength;
    this.consumeFrame(length);
    this.frame.fill(0, 0, length);
    this.frameLength = 0;
  }

  consumeFrame(length) {
    let sumSquares = 0;
    for (let index = 0; index < length; index++) {
      const value = this.frame[index];
      sumSquares = value * value + sumSquares;
    }
    const rms = length ? Math.sqrt(sumSquares / length) : 0;
    const voiced = rms >= SPEECH_RMS_THRESHOLD;

    if (!this.active) {
      if (this.continuationPending) {
        if (voiced) {
          this.beginSegment(true);
          this.appendFrame(length, true);
          this.frame.fill(0, 0, length);
          this.frameLength = 0;
          return;
        }
        this.pushPreRoll(length);
        this.continuationQuietSamples += length;
        if (this.continuationQuietSamples >= SILENCE_END_SAMPLES) {
          this.continuationPending = false;
          this.continuationQuietSamples = 0;
          this.clearPreRoll();
        }
        this.frame.fill(0, 0, length);
        this.frameLength = 0;
        return;
      }
      if (!voiced) {
        this.pushPreRoll(length);
        this.frame.fill(0, 0, length);
        this.frameLength = 0;
        return;
      }
      this.beginSegment(false);
    }

    this.appendFrame(length, voiced);
    this.frame.fill(0, 0, length);
    this.frameLength = 0;

    if (this.segmentSamples >= MAX_SEGMENT_SAMPLES) {
      this.endSegment(this.segmentSamples, this.voiceSamples >= MIN_VOICE_SAMPLES || this.continued, 'limit');
      this.resetSegment();
      this.continuationPending = true;
      this.continuationQuietSamples = 0;
      this.clearPreRoll();
      return;
    }

    if (this.quietSamples >= SILENCE_END_SAMPLES) {
      const trim = Math.min(this.segmentSamples, Math.max(0, this.quietSamples - TRAILING_SAMPLES));
      const validSamples = Math.max(0, this.segmentSamples - trim);
      this.endSegment(validSamples, this.voiceSamples >= MIN_VOICE_SAMPLES || this.continued, 'silence');
      this.resetSegment();
      this.continuationPending = false;
      this.continuationQuietSamples = 0;
      this.clearPreRoll();
    }
  }

  beginSegment(continued) {
    this.active = true;
    this.continued = continued;
    this.segmentId = this.nextSegmentId++;
    this.segmentSamples = this.preRollLength;
    this.voiceSamples = 0;
    this.quietSamples = 0;
    this.port.postMessage({
      type: 'segment-start',
      segmentId: this.segmentId,
      continued,
      preRollSamples: this.preRollLength,
    });
    this.emitPreRoll(this.segmentId);
    this.continuationPending = false;
    this.continuationQuietSamples = 0;
  }

  appendFrame(length, voiced) {
    this.emitPcm(this.segmentId, this.frame, length);
    this.segmentSamples += length;
    if (voiced) {
      this.voiceSamples += length;
      this.quietSamples = 0;
    } else {
      this.quietSamples += length;
    }
  }

  endSegment(validSamples, emit, reason) {
    this.port.postMessage({
      type: 'segment-end',
      segmentId: this.segmentId,
      sampleRate: TARGET_SAMPLE_RATE,
      validSamples,
      emit,
      reason,
    });
  }

  resetSegment() {
    this.active = false;
    this.continued = false;
    this.segmentId = 0;
    this.segmentSamples = 0;
    this.voiceSamples = 0;
    this.quietSamples = 0;
  }

  finishActive(reason) {
    if (!this.active) {
      if (reason === 'flush') return;
      this.continuationPending = false;
      this.continuationQuietSamples = 0;
      return;
    }
    const preserveContinuation = reason === 'flush' && (this.continued || this.voiceSamples >= MIN_VOICE_SAMPLES);
    const trim = Math.min(this.segmentSamples, Math.max(0, this.quietSamples - TRAILING_SAMPLES));
    const validSamples = Math.max(0, this.segmentSamples - trim);
    this.endSegment(validSamples, this.voiceSamples >= MIN_VOICE_SAMPLES || this.continued, reason);
    this.resetSegment();
    this.continuationPending = preserveContinuation;
    this.continuationQuietSamples = 0;
  }

  emitPreRoll(segmentId) {
    const length = this.preRollLength;
    if (length) {
      const samples = new Int16Array(length);
      const start = (this.preRollWrite - length + PRE_ROLL_SAMPLES) % PRE_ROLL_SAMPLES;
      for (let index = 0; index < length; index++) {
        samples[index] = this.preRoll[(start + index) % PRE_ROLL_SAMPLES];
      }
      this.emitPcmBuffer(segmentId, samples);
    }
    this.clearPreRoll();
  }

  pushPreRoll(length) {
    for (let index = 0; index < length; index++) {
      this.preRoll[this.preRollWrite] = this.toInt16(this.frame[index]);
      this.preRollWrite = (this.preRollWrite + 1) % PRE_ROLL_SAMPLES;
      this.preRollLength = Math.min(PRE_ROLL_SAMPLES, this.preRollLength + 1);
    }
  }

  clearPreRoll() {
    this.preRoll.fill(0);
    this.preRollWrite = 0;
    this.preRollLength = 0;
  }

  emitPcm(segmentId, floatSamples, length) {
    const samples = new Int16Array(length);
    for (let index = 0; index < length; index++) samples[index] = this.toInt16(floatSamples[index]);
    this.emitPcmBuffer(segmentId, samples);
  }

  emitPcmBuffer(segmentId, samples) {
    this.port.postMessage({
      type: 'segment-chunk',
      segmentId,
      samples: samples.length,
      pcm: samples.buffer,
    }, [samples.buffer]);
  }

  toInt16(value) {
    const clipped = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
    return clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
  }

  clearCaptureState() {
    this.frame.fill(0);
    this.frameLength = 0;
    this.clearPreRoll();
    this.resetSegment();
    this.continuationPending = false;
    this.continuationQuietSamples = 0;
  }
}

registerProcessor('dotdial-missed-capture', DotDialMissedCaptureProcessor);
