import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function rendererHarness({ getUserMedia, replaceTrack } = {}) {
  const replacements = [];
  const silentTrack = { readyState: 'live', stop() {} };
  const output = { muted: false, srcObject: null, play: async () => {}, pause() {} };
  let connection;

  class FakePeerConnection {
    constructor() { connection = this; this.iceGatheringState = 'complete'; }
    addTransceiver(track) {
      const sender = { track, replaceTrack: async nextTrack => {
        replacements.push(nextTrack);
        await replaceTrack?.(nextTrack);
        sender.track = nextTrack;
      } };
      this.sender = sender;
      return { sender, receiver: { jitterBufferTarget: null }, setCodecPreferences() {} };
    }
    createDataChannel() { return { readyState: 'open', close() {} }; }
    async createOffer() { return { type: 'offer', sdp: 'fixture-offer' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription() {}
    async getStats() { return []; }
    addEventListener() {}
    removeEventListener() {}
    getSenders() { return this.sender ? [this.sender] : []; }
    close() {}
  }

  class FakeAudioContext {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [silentTrack] } }; }
    createConstantSource() { return { offset: { value: 0 }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { value: 1, setValueAtTime(value) { this.value = value; } }, connect() {}, disconnect() {} }; }
    async resume() {}
    async close() { this.state = 'closed'; }
  }
  class AudioDiagnostics { collect() { return {}; } }

  const context = {
    AudioContext: FakeAudioContext,
    AudioDiagnostics,
    RTCPeerConnection: FakePeerConnection,
    RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
    navigator: { mediaDevices: { getUserMedia: getUserMedia || (async () => { throw Error('unexpected getUserMedia'); }) } },
    window: {},
    document: { getElementById: id => id === 'remote' ? output : null },
    performance,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(new URL('./media_renderer.js', import.meta.url), 'utf8'), context, {
    filename: 'media_renderer.js',
  });
  return {
    context,
    output,
    replacements,
    silentTrack,
    get connection() { return connection; },
    async initialize() {
      context.window.DotDialMedia.configure({ recordingEnabled: false });
      await context.window.DotDialMedia.createOffer();
    },
  };
}

test('a microphone stream returned after mute is stopped without becoming the sender track', async () => {
  const request = deferred();
  const acquisition = deferred();
  const harness = rendererHarness({ getUserMedia: () => { request.resolve(); return acquisition.promise; } });
  await harness.initialize();
  let stopped = 0;
  const track = { readyState: 'live', stop() { stopped++; this.readyState = 'ended'; }, getSettings: () => ({ sampleRate: 48_000 }) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };

  const starting = harness.context.window.DotDialMedia.startMicrophone();
  await request.promise;
  await harness.context.window.DotDialMedia.stopMicrophone();
  acquisition.resolve(stream);

  await assert.rejects(starting, { code: 'cancelled' });
  assert.equal(stopped, 1);
  assert.deepEqual(harness.replacements, [harness.silentTrack]);
});

test('a mute racing replaceTrack restores the silent sender after late microphone completion', async () => {
  const replacing = deferred();
  const finishReplacement = deferred();
  let microphoneTrack;
  const harness = rendererHarness({ replaceTrack: track => {
    if (track === microphoneTrack) {
      replacing.resolve();
      return finishReplacement.promise;
    }
  } });
  await harness.initialize();
  let stopped = 0;
  microphoneTrack = { readyState: 'live', stop() { stopped++; this.readyState = 'ended'; }, getSettings: () => ({ sampleRate: 48_000 }) };
  const stream = { getTracks: () => [microphoneTrack], getAudioTracks: () => [microphoneTrack] };
  harness.context.navigator.mediaDevices.getUserMedia = async () => stream;

  const starting = harness.context.window.DotDialMedia.startMicrophone();
  await replacing.promise;
  await harness.context.window.DotDialMedia.stopMicrophone();
  assert.equal(stopped, 1, 'mute stops the acquired track before replaceTrack settles');
  finishReplacement.resolve();

  await assert.rejects(starting, { code: 'cancelled' });
  assert.equal(stopped, 1);
  assert.deepEqual(harness.replacements, [microphoneTrack, harness.silentTrack, harness.silentTrack]);
});

test('a stale replaceTrack completion cannot replace a newer microphone', async () => {
  const replacingFirst = deferred();
  const finishFirst = deferred();
  let firstTrack;
  const harness = rendererHarness({ replaceTrack: track => {
    if (track === firstTrack) {
      replacingFirst.resolve();
      return finishFirst.promise;
    }
  } });
  await harness.initialize();
  let firstStopped = 0;
  let secondStopped = 0;
  firstTrack = { readyState: 'live', stop() { firstStopped++; this.readyState = 'ended'; }, getSettings: () => ({ sampleRate: 48_000 }) };
  const secondTrack = { readyState: 'live', stop() { secondStopped++; this.readyState = 'ended'; }, getSettings: () => ({ sampleRate: 48_000 }) };
  const streams = [firstTrack, secondTrack].map(track => ({ getTracks: () => [track], getAudioTracks: () => [track] }));
  let acquisitions = 0;
  harness.context.navigator.mediaDevices.getUserMedia = async () => streams[acquisitions++];

  const firstStart = harness.context.window.DotDialMedia.startMicrophone();
  await replacingFirst.promise;
  await harness.context.window.DotDialMedia.stopMicrophone();
  const secondStart = harness.context.window.DotDialMedia.startMicrophone();
  await secondStart;
  finishFirst.resolve();

  await assert.rejects(firstStart, { code: 'cancelled' });
  assert.equal(firstStopped, 1);
  assert.equal(secondStopped, 0);
  assert.equal(harness.connection.getSenders()[0].track, secondTrack);
  assert.deepEqual(harness.replacements, [firstTrack, harness.silentTrack, secondTrack, secondTrack]);
  await harness.context.window.DotDialMedia.stopMicrophone();
});
