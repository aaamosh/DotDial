'use strict';

const CHUNK_SAMPLES = 1600; // 100 ms of mono 16 kHz float32; 6400 bytes.
const MAX_IN_FLIGHT = 4;
class DotDialWakeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK_SAMPLES);
    this.length = 0;
    this.inFlight = 0;
    this.closed = false;
    this.port.onmessage = event => {
      if (event.data?.type === 'stop') { this.closed = true; this.buffer.fill(0); }
      if (event.data?.type === 'ack' && this.inFlight > 0) this.inFlight--;
    };
  }
  process(inputs, outputs) {
    for (const output of outputs[0] || []) output.fill(0);
    if (this.closed) return false;
    const channels = inputs[0] || [];
    if (!channels.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let value = 0;
      for (const channel of channels) value += Number.isFinite(channel[index]) ? channel[index] : 0;
      this.buffer[this.length++] = Math.max(-1, Math.min(1, value / channels.length));
      if (this.length === CHUNK_SAMPLES) {
        // Credits return only after Python's pipe accepts the chunk. This also
        // bounds the MessagePort queue if the renderer itself stops responding.
        if (this.inFlight >= MAX_IN_FLIGHT) {
          this.closed = true; this.buffer.fill(0);
          this.port.postMessage({ error: 'wake_audio_backpressure' });
          return false;
        }
        this.inFlight++;
        this.port.postMessage({ pcm: this.buffer.buffer, sampleRate }, [this.buffer.buffer]);
        this.buffer = new Float32Array(CHUNK_SAMPLES);
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor('dotdial-wake', DotDialWakeProcessor);
