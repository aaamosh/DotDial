import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const RATE = 48_000;
const FRAME = 960;

function loadProcessor() {
  let Processor;
  const messages = [];
  class AudioWorkletProcessor {
    constructor() {
      this.port = { postMessage: message => messages.push(message), onmessage: null };
    }
  }
  const source = fs.readFileSync(new URL('./missed_worklet.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    sampleRate: RATE,
    registerProcessor(name, implementation) {
      assert.equal(name, 'dotdial-missed-capture');
      Processor = implementation;
    },
  }, { filename: 'missed_worklet.js' });
  return { processor: new Processor(), messages };
}

function loadCaptureHarness() {
  let Processor;
  const nodes = [];
  class AudioWorkletProcessor {
    constructor() {
      this.pendingMessages = [];
      this.port = {
        onmessage: null,
        postMessage: message => {
          if (this.deliverMessage) this.deliverMessage(message);
          else this.pendingMessages.push(message);
        },
      };
    }
  }
  vm.runInNewContext(fs.readFileSync(new URL('./missed_worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor,
    sampleRate: RATE,
    registerProcessor(_name, implementation) { Processor = implementation; },
  }, { filename: 'missed_worklet.js' });

  class AudioWorkletNode {
    constructor() {
      this.processor = new Processor();
      this.port = {
        handler: null,
        pending: [],
        set onmessage(handler) {
          this.handler = handler;
          if (handler) for (const message of this.pending.splice(0)) queueMicrotask(() => handler({ data: message }));
        },
        get onmessage() { return this.handler; },
        start() {},
        close() {},
        postMessage: message => this.processor.port.onmessage?.({ data: message }),
      };
      this.processor.deliverMessage = message => {
        if (this.port.handler) queueMicrotask(() => this.port.handler?.({ data: message }));
        else this.port.pending.push(message);
      };
      for (const message of this.processor.pendingMessages.splice(0)) this.processor.deliverMessage(message);
      nodes.push(this);
    }
    connect() {}
    disconnect() {}
    addEventListener() {}
    process(samples) {
      for (let offset = 0; offset < samples.length;) {
        const length = Math.min(128, samples.length - offset);
        const input = samples.subarray(offset, offset + length);
        this.processor.process([[input]], [[new Float32Array(length)]]);
        offset += length;
      }
    }
  }

  const globals = { AudioWorkletNode, Blob, URL, setTimeout, clearTimeout,
    document: { baseURI: 'file:///tmp/dotdial-widget/media.html' } };
  vm.runInNewContext(fs.readFileSync(new URL('./missed_capture.js', import.meta.url), 'utf8'), globals, {
    filename: 'missed_capture.js',
  });
  let createdSources = 0;
  const source = { connect() {}, disconnect() {} };
  const context = {
    sampleRate: RATE,
    audioWorklet: { async addModule() {} },
    destination: {},
    createMediaStreamSource() { createdSources++; return source; },
  };
  return { MissedCapture: globals.MissedCapture, context, nodes, source, createdSources: () => createdSources };
}

function setMuted(processor, muted) {
  processor.port.onmessage({ data: { type: 'set-muted', muted, requestId: 1 } });
}

function processSamples(processor, value, sampleCount) {
  assert.equal(sampleCount % FRAME, 0);
  const input = new Float32Array(FRAME).fill(value);
  const output = new Float32Array(FRAME);
  for (let offset = 0; offset < sampleCount; offset += FRAME) {
    processor.process([[input]], [[output]]);
  }
}

function messagesOf(messages, type) {
  return messages.filter(message => message.type === type);
}

test('muted capture includes 300 ms pre-roll and trims the silence tail', () => {
  const { processor, messages } = loadProcessor();
  setMuted(processor, true);
  processSamples(processor, 0, 14_400);
  processSamples(processor, 0.1, 5_760); // 120 ms voice.
  processSamples(processor, 0, 57_600); // 1.2 s silence ends the segment.

  const start = messagesOf(messages, 'segment-start')[0];
  const end = messagesOf(messages, 'segment-end')[0];
  assert.equal(start.preRollSamples, 14_400);
  assert.equal(end.reason, 'silence');
  assert.equal(end.emit, true);
  assert.equal(end.validSamples, 14_400 + 5_760 + 7_200);
});

test('a short click is rejected and silence alone never creates a recording', () => {
  const { processor, messages } = loadProcessor();
  setMuted(processor, true);
  processSamples(processor, 0, 30_720);
  assert.equal(messagesOf(messages, 'segment-start').length, 0);

  processSamples(processor, 0.5, FRAME); // 20 ms, below the 100 ms speech minimum.
  processSamples(processor, 0, 57_600);
  const end = messagesOf(messages, 'segment-end')[0];
  assert.equal(end.emit, false);
});

test('audio is captured only while muted, and unmuting flushes the active speech', () => {
  const { processor, messages } = loadProcessor();
  processSamples(processor, 0.1, 9_600);
  assert.equal(messagesOf(messages, 'segment-start').length, 0);

  setMuted(processor, true);
  processSamples(processor, 0.1, 9_600);
  setMuted(processor, false);
  assert.equal(messagesOf(messages, 'segment-start').length, 1);
  assert.deepEqual(messagesOf(messages, 'segment-end').map(message => [message.emit, message.reason]), [[true, 'unmuted']]);
});

test('closing flushes a valid in-progress segment', () => {
  const { processor, messages } = loadProcessor();
  setMuted(processor, true);
  processSamples(processor, 0.1, 9_600);
  processor.port.onmessage({ data: { type: 'close', requestId: 2 } });

  const end = messagesOf(messages, 'segment-end')[0];
  assert.equal(end.emit, true);
  assert.equal(end.reason, 'close');
  assert.equal(end.validSamples, 9_600);
});

test('flush persists the current tail, stays muted, and captures the next segment once', async () => {
  const harness = loadCaptureHarness();
  const persistedBytes = [];
  let releaseFirst;
  const capture = new harness.MissedCapture(harness.context, { getAudioTracks: () => [{}] }, {
    onSegment: ({ sampleRate, pcm }) => {
      assert.equal(sampleRate, RATE);
      persistedBytes.push(pcm.byteLength);
      if (persistedBytes.length === 1) return new Promise(resolve => { releaseFirst = resolve; });
    },
  });
  await capture.ready;
  await capture.setMuted(true);
  const node = harness.nodes[0];

  node.process(new Float32Array(9_900).fill(0.1)); // Includes a partial 300-sample tail.
  let flushFinished = false;
  const firstFlush = capture.flush().then(() => { flushFinished = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(persistedBytes, [9_900 * 2]);
  assert.equal(flushFinished, false); // ACK is not enough; persistence must finish.
  assert.equal(capture.muted, true);
  assert.equal(capture.recording, true);

  releaseFirst();
  await firstFlush;
  assert.equal(capture.muted, true);
  node.process(new Float32Array(5_760).fill(0.1));
  await capture.flush();
  assert.deepEqual(persistedBytes, [9_900 * 2, 5_760 * 2]);
  assert.equal(capture.muted, true);
  assert.equal(capture.recording, true);
  await capture.close();
});

test('a partial pre-roll is split at the segment limit without losing the remainder', async () => {
  const harness = loadCaptureHarness();
  const savedSamples = [];
  const errors = [];
  const capture = new harness.MissedCapture(harness.context, { getAudioTracks: () => [{}] }, {
    onSegment: ({ pcm }) => savedSamples.push(pcm.byteLength / 2),
    onError: code => errors.push(code),
  });
  await capture.ready;
  await capture.setMuted(true);

  // A partial render quantum is flushed into pre-roll, leaving its 128-sample
  // offset at the start of the next spoken segment.
  harness.nodes[0].process(new Float32Array(128));
  await capture.flush();
  const voice = new Float32Array(128).fill(0.1);
  for (let offset = 0; offset < 60 * RATE; offset += voice.length) {
    harness.nodes[0].process(voice);
  }
  await capture.flush();
  await capture.drainSegments();

  assert.deepEqual(savedSamples, [2_880_000, 128]);
  assert.deepEqual(errors, []);
  await capture.close();
});

test('flush retains a short continuation after the 60-second split without duplicating later audio', () => {
  const { processor, messages } = loadProcessor();
  setMuted(processor, true);
  processSamples(processor, 0.1, 60 * RATE);
  processSamples(processor, 0.1, FRAME);
  processor.port.onmessage({ data: { type: 'flush', requestId: 2 } });
  processSamples(processor, 0.1, FRAME);
  processor.port.onmessage({ data: { type: 'flush', requestId: 3 } });
  processSamples(processor, 0.1, 5_760);
  processor.port.onmessage({ data: { type: 'flush', requestId: 4 } });

  const starts = messagesOf(messages, 'segment-start');
  const ends = messagesOf(messages, 'segment-end');
  assert.equal(starts.length, 4);
  assert.equal(starts[0].continued, false);
  assert.equal(starts[1].continued, true);
  assert.equal(starts[2].continued, true);
  assert.equal(starts[3].continued, true);
  assert.deepEqual(ends.map(message => message.reason), ['limit', 'flush', 'flush', 'flush']);
  assert.equal(ends.every(message => message.emit), true);
  assert.deepEqual(ends.map(message => message.validSamples), [60 * RATE, FRAME, FRAME, 5_760]);
  assert.equal(messagesOf(messages, 'ack').filter(message => [2, 3, 4].includes(message.requestId)).length, 3);
});

test('a normal speech fragment retains a short continuation across a FIFO flush', () => {
  const { processor, messages } = loadProcessor();
  setMuted(processor, true);
  processSamples(processor, 0.1, 5_760);
  processor.port.onmessage({ data: { type: 'flush', requestId: 2 } });
  processSamples(processor, 0.1, FRAME);
  processor.port.onmessage({ data: { type: 'flush', requestId: 3 } });
  const ends = messagesOf(messages, 'segment-end');
  assert.equal(ends.every(message => message.emit), true);
  assert.deepEqual(ends.map(message => message.validSamples), [5_760, FRAME]);
});

test('a missing worklet acknowledgement fails safely and reports one stable error code', async () => {
  let AudioWorkletNode;
  class SilentNode {
    constructor() {
      this.port = {
        onmessage: null,
        start() {},
        close() {},
        postMessage() {}, // Deliberately omit the requested ACK.
      };
      queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ready', sampleRate: RATE } }));
    }
    connect() {}
    disconnect() {}
    addEventListener() {}
  }
  AudioWorkletNode = SilentNode;
  const contextGlobal = {
    AudioWorkletNode,
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    document: { baseURI: 'file:///tmp/dotdial-widget/media.html' },
  };
  vm.runInNewContext(fs.readFileSync(new URL('./missed_capture.js', import.meta.url), 'utf8'), contextGlobal, {
    filename: 'missed_capture.js',
  });

  let disconnected = 0;
  const context = {
    sampleRate: RATE,
    audioWorklet: { async addModule() {} },
    destination: {},
    createMediaStreamSource() {
      return { connect() {}, disconnect() { disconnected++; } };
    },
  };
  const errors = [];
  const capture = new contextGlobal.MissedCapture(context, { getAudioTracks: () => [{}] }, {
    onSegment() {},
    onError: code => errors.push(code),
    ackTimeoutMs: 10,
  });

  await assert.rejects(capture.setMuted(true), { code: 'recording_unavailable' });
  assert.deepEqual(errors, ['recording_unavailable']);
  assert.equal(disconnected, 1);
});

test('external sourceNode skips stream-source creation and disconnects only the capture branch', async () => {
  const harness = loadCaptureHarness();
  const connected = [];
  const disconnected = [];
  const sharedSource = {
    connect(destination) { connected.push(destination); },
    disconnect(destination) { disconnected.push(arguments.length ? destination : undefined); },
  };
  const capture = new harness.MissedCapture(harness.context, null, {
    sourceNode: sharedSource,
    onSegment() {},
  });
  await capture.ready;
  const captureNode = harness.nodes[0];
  assert.deepEqual(connected, [captureNode]);
  assert.equal(harness.createdSources(), 0);
  await capture.close();
  assert.deepEqual(disconnected, [captureNode]);
});
