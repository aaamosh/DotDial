import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function microphoneTrack({ readyState = 'live', onStop = () => {} } = {}) {
  const ended = new Set();
  return {
    readyState,
    stop() { onStop(); this.readyState = 'ended'; },
    getSettings: () => ({ sampleRate: 48_000 }),
    addEventListener(type, callback) { if (type === 'ended') ended.add(callback); },
    removeEventListener(type, callback) { if (type === 'ended') ended.delete(callback); },
    queuedEnd() {
      const callbacks = [...ended];
      return () => { this.readyState = 'ended'; callbacks.forEach(callback => callback()); };
    },
    end() { this.queuedEnd()(); },
  };
}

const microphoneStream = track => ({ getTracks: () => [track], getAudioTracks: () => [track] });

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
    async initialize(options = {}) {
      context.window.DotDialMedia.configure({ recordingEnabled: false, ...options });
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
  const track = microphoneTrack({ onStop: () => { stopped++; } });
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
  let inputTrack;
  const harness = rendererHarness({ replaceTrack: track => {
    if (track === inputTrack) {
      replacing.resolve();
      return finishReplacement.promise;
    }
  } });
  await harness.initialize();
  let stopped = 0;
  inputTrack = microphoneTrack({ onStop: () => { stopped++; } });
  const stream = microphoneStream(inputTrack);
  harness.context.navigator.mediaDevices.getUserMedia = async () => stream;

  const starting = harness.context.window.DotDialMedia.startMicrophone();
  await replacing.promise;
  await harness.context.window.DotDialMedia.stopMicrophone();
  assert.equal(stopped, 1, 'mute stops the acquired track before replaceTrack settles');
  finishReplacement.resolve();

  await assert.rejects(starting, { code: 'cancelled' });
  assert.equal(stopped, 1);
  assert.deepEqual(harness.replacements, [inputTrack, harness.silentTrack, harness.silentTrack]);
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
  firstTrack = microphoneTrack({ onStop: () => { firstStopped++; } });
  const secondTrack = microphoneTrack({ onStop: () => { secondStopped++; } });
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

test('hot-unplug marks the microphone ended and a deliberate retry keeps the exact selected input', async () => {
  const first = microphoneTrack(), second = microphoneTrack();
  const acquisitions = [], resolved = [];
  let available = true;
  const harness = rendererHarness({ getUserMedia: async options => {
    acquisitions.push(options);
    return microphoneStream(acquisitions.length === 1 ? first : second);
  } });
  harness.context.DotDialDevices = { resolve: async (value, kind) => {
    resolved.push([value, kind]);
    if (!available) throw Object.assign(Error('missing input'), { code: 'audio_device_unavailable' });
    return 'selected-usb-device';
  } };
  await harness.initialize({ microphoneDeviceId: 'label:Selected USB microphone' });
  const media = harness.context.window.DotDialMedia;
  await media.startMicrophone();
  first.end();
  const disconnected = await media.stats();
  assert.equal(disconnected.microphone_active, false);
  assert.equal(disconnected.microphone_error, 'microphone_ended');
  assert.equal(harness.connection.sender.track, harness.silentTrack);
  assert.equal(acquisitions.length, 1, 'unplug must not trigger automatic capture');

  available = false;
  await assert.rejects(media.startMicrophone(), { code: 'audio_device_unavailable' });
  assert.equal(acquisitions.length, 1, 'missing selected input must not fall back to default');
  available = true;
  await media.startMicrophone();
  assert.equal((await media.stats()).microphone_active, true);
  assert.equal((await media.stats()).microphone_error, null);
  assert.equal(acquisitions.length, 2);
  assert.ok(acquisitions.every(options => options.audio.deviceId.exact === 'selected-usb-device'));
  assert.ok(resolved.every(([value, kind]) => value === 'label:Selected USB microphone' && kind === 'audioinput'));
  await media.stopMicrophone();
  assert.equal((await media.stats()).microphone_active, false);
  assert.equal((await media.stats()).microphone_error, null, 'deliberate mute is not a device failure');
});

test('a queued ended event from an old microphone cannot clear a newer capture', async () => {
  const first = microphoneTrack(), second = microphoneTrack();
  let acquisitions = 0;
  const harness = rendererHarness({ getUserMedia: async () => microphoneStream(++acquisitions === 1 ? first : second) });
  await harness.initialize();
  const media = harness.context.window.DotDialMedia;
  await media.startMicrophone();
  const oldEnded = first.queuedEnd();
  await media.stopMicrophone();
  await media.startMicrophone();
  oldEnded();
  assert.equal((await media.stats()).microphone_active, true);
  assert.equal((await media.stats()).microphone_error, null);
  assert.equal(harness.connection.sender.track, second);
  assert.equal(second.readyState, 'live');
  await media.stopMicrophone();
});

for (const dispatchEnded of [true, false]) test(`a track ending during replaceTrack cannot succeed (${dispatchEnded ? 'ended event' : 'event still queued'})`, async () => {
  const input = microphoneTrack(), replacing = deferred(), finishReplacement = deferred();
  const harness = rendererHarness({ getUserMedia: async () => microphoneStream(input), replaceTrack: track => {
    if (track === input) { replacing.resolve(); return finishReplacement.promise; }
  } });
  await harness.initialize();
  const media = harness.context.window.DotDialMedia;
  const starting = media.startMicrophone();
  const rejected = assert.rejects(starting, { code: 'microphone_ended' });
  await replacing.promise;
  if (dispatchEnded) input.end();
  else input.readyState = 'ended';
  finishReplacement.resolve();
  await rejected;
  assert.equal((await media.stats()).microphone_active, false);
  assert.equal((await media.stats()).microphone_error, 'microphone_ended');
  assert.equal(harness.connection.sender.track, harness.silentTrack);
});

test('an already-ended acquired track is rejected before becoming the sender', async () => {
  const input = microphoneTrack({ readyState: 'ended' });
  const harness = rendererHarness({ getUserMedia: async () => microphoneStream(input) });
  await harness.initialize();
  const media = harness.context.window.DotDialMedia;
  await assert.rejects(media.startMicrophone(), { code: 'microphone_ended' });
  assert.equal((await media.stats()).microphone_active, false);
  assert.equal((await media.stats()).microphone_error, 'microphone_ended');
  assert.ok(!harness.replacements.includes(input));
});

test('late silent-track restoration after unplug cannot overwrite a fresh microphone', async () => {
  const first = microphoneTrack(), second = microphoneTrack();
  const restoring = deferred(), finishRestore = deferred();
  let acquisitions = 0, delaySilence = true;
  const harness = rendererHarness({ getUserMedia: async () => microphoneStream(++acquisitions === 1 ? first : second), replaceTrack: track => {
    if (track === harness.silentTrack && delaySilence) {
      delaySilence = false;
      restoring.resolve();
      return finishRestore.promise;
    }
  } });
  await harness.initialize();
  const media = harness.context.window.DotDialMedia;
  await media.startMicrophone();
  first.end();
  // The event must synchronously start restoring silence before any retry.
  assert.equal(harness.replacements.at(-1), harness.silentTrack);
  await restoring.promise;
  await media.startMicrophone();
  finishRestore.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await media.stats()).microphone_active, true);
  assert.equal((await media.stats()).microphone_error, null);
  assert.equal(harness.connection.sender.track, second);
  await media.stopMicrophone();
});
