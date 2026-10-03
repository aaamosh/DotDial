'use strict';

// Synthetic, local-only audio smoke for a real Electron runtime. Run through
// run-audio-smoke.sh so playback is routed to a private PulseAudio null sink.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');
const { app, BrowserWindow, session, ipcMain } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const MEDIA_HTML = path.join(ROOT, 'src', 'media.html');
const SINK = process.env.DOTDIAL_QA_SINK || '';
const SINK_MARKER = SINK.toUpperCase();
const SAMPLE_RATE = 48_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!/^dotdial_qa_[A-Za-z0-9_]+$/.test(SINK)) throw Error('private_qa_sink_required');
if (typeof process.getuid === 'function' && process.getuid() === 0) throw Error('run_as_unprivileged_desktop_user');
if (!process.env.PULSE_SERVER || !process.env.XDG_RUNTIME_DIR) throw Error('pulse_session_environment_required');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-audio-smoke-'));
app.setName('DotDial Audio QA');
app.on('window-all-closed', () => {
  // The smoke owns shutdown and exits only after its resource cleanup.
});
app.setPath('userData', path.join(temporaryRoot, 'electron-profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.disableHardwareAcceleration();

let monitor, monitorError = '';
const monitorChunks = [];
const peers = [];
const failures = [];
let replayPlayer, recordings;
let timedOut;

function frameSamples(buffer) {
  const bytes = buffer.length - (buffer.length % 8);
  return bytes / 8;
}

function outputRms(windowMs = 250) {
  const data = Buffer.concat(monitorChunks);
  const frames = frameSamples(data);
  const count = Math.min(frames, Math.floor(SAMPLE_RATE * windowMs / 1000));
  if (!count) return 0;
  let energy = 0;
  for (let frame = frames - count; frame < frames; frame++) {
    const offset = frame * 8;
    const left = data.readFloatLE(offset), right = data.readFloatLE(offset + 4);
    energy += (left * left + right * right) / 2;
  }
  return Math.sqrt(energy / count);
}

async function waitFor(predicate, timeoutMs = 7000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (monitorError) throw Error('audio_monitor_failed:' + monitorError);
    await sleep(75);
  }
  throw Error('timed_out_waiting_for_' + label);
}

async function waitForRms(minimum, timeoutMs = 6000, label = 'audible_output') {
  await waitFor(() => outputRms() >= minimum, timeoutMs, label);
  return outputRms();
}

async function waitForQuiet(maximum, timeoutMs = 5000, label = 'muted_output') {
  await waitFor(() => outputRms() <= maximum, timeoutMs, label);
  return outputRms();
}

function startMonitor() {
  monitor = spawn('parec', [
    '--device=' + SINK + '.monitor', '--raw', '--format=float32le',
    '--rate=' + SAMPLE_RATE, '--channels=2', '--latency-msec=20',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  monitor.stdout.on('data', chunk => monitorChunks.push(Buffer.from(chunk)));
  monitor.stderr.on('data', chunk => { monitorError += chunk.toString().slice(0, 500); });
  monitor.once('error', error => { monitorError = error.code || error.message; });
  monitor.once('close', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && !monitorError) monitorError = `exit_${code}`;
  });
}

async function enumerateQaOutput() {
  const partition = 'dotdial-qa-devices-' + Date.now();
  const window = new BrowserWindow({ show: false, webPreferences: {
    partition, sandbox: true,
    contextIsolation: true, nodeIntegration: false,
  } });
  const audioSession = session.fromPartition(partition);
  // This mirrors DotDial's permission-check path. Device enumeration is
  // allowed for this exact local page; every capture request remains denied.
  audioSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  audioSession.setPermissionCheckHandler((wc, permission, _origin, details) =>
    wc === window.webContents && permission === 'media' && details?.mediaType === 'audio');
  try {
    await window.loadFile(MEDIA_HTML);
    const devices = await window.webContents.executeJavaScript('DotDialDevices.list()');
    assert.ok(Array.isArray(devices), 'audio device helper returns a list');
    const selected = devices.find(device => device.kind === 'audiooutput' &&
      device.label.toUpperCase().includes(SINK_MARKER));
    assert.ok(selected, 'custom Pulse sink must be visible in a fresh Chromium profile');
    assert.equal(selected.id, 'label:' + selected.label, 'configuration stores a label, not a profile-salted Chromium id');
    return { id: selected.id, label: selected.label, outputs: devices.filter(d => d.kind === 'audiooutput').map(d => d.label) };
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

function makeTonePeerFactory({ chromiumMedia, archive, mediaOptions, getSpeakersMuted }) {
  const Peer = chromiumMedia({ BrowserWindow, session, ipcMain, archive, mediaOptions, getSpeakersMuted });
  return new Peer(() => {}, () => {}, error => failures.push(error?.code || 'media_failure'));
}

async function connectSyntheticRemote(peer, { frequency = 440, gain = 0.15 } = {}) {
  await peer.ready;
  await peer.window.webContents.executeJavaScript(`(() => {
    window.__qaNativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends window.__qaNativePeer {
      constructor(...args) {
        super(...args);
        window.__qaClientPeer = this;
        this.addEventListener('track', () => { window.__qaTrackAt = performance.now(); }, { once: true });
      }
    };
  })()`);
  const offer = await peer.createOffer();
  const answer = await peer.window.webContents.executeJavaScript(`(async () => {
    window.__qaRemotePeer = new window.__qaNativePeer({ iceServers: [] });
    window.__qaToneContext = new AudioContext({ sampleRate: ${SAMPLE_RATE} });
    const destination = window.__qaToneContext.createMediaStreamDestination();
    window.__qaToneGain = window.__qaToneContext.createGain();
    window.__qaToneGain.gain.value = ${gain};
    window.__qaTone = window.__qaToneContext.createOscillator();
    window.__qaTone.frequency.value = ${frequency};
    window.__qaTone.connect(window.__qaToneGain);
    window.__qaToneGain.connect(destination);
    window.__qaTone.start();
    await window.__qaToneContext.resume();
    window.__qaRemotePeer.ondatachannel = event => { window.__qaRemoteChannel = event.channel; };
    await window.__qaRemotePeer.setRemoteDescription({ type: 'offer', sdp: ${JSON.stringify(offer)} });
    const transceiver = window.__qaRemotePeer.getTransceivers()[0];
    transceiver.direction = 'sendrecv';
    await transceiver.sender.replaceTrack(destination.stream.getAudioTracks()[0]);
    await window.__qaRemotePeer.setLocalDescription(await window.__qaRemotePeer.createAnswer());
    while (window.__qaRemotePeer.iceGatheringState !== 'complete') await new Promise(resolve => setTimeout(resolve, 10));
    return window.__qaRemotePeer.localDescription.sdp;
  })()`);
  await peer.acceptAnswer(answer);
  await peer.waitForOpen(8000);
  await sleep(20); // Let the renderer's track callback run before measuring.
  return {
    setTone: (hz, amplitude) => peer.window.webContents.executeJavaScript(`(() => {
      window.__qaTone.frequency.setValueAtTime(${hz}, window.__qaToneContext.currentTime);
      window.__qaToneGain.gain.setTargetAtTime(${amplitude}, window.__qaToneContext.currentTime, .01);
    })()`),
  };
}

async function runBufferCase({ chromiumMedia, outputDeviceId, bufferMs }) {
  const peer = makeTonePeerFactory({ chromiumMedia, archive: null, mediaOptions: {
    bufferMs, outputDeviceId, recordingEnabled: false,
  } });
  peers.push(peer);
  const remote = await connectSyntheticRemote(peer, { frequency: 440, gain: 0.15 });
  await sleep(Math.max(1200, bufferMs + 700));
  const stats = await peer.getStats();
  assert.equal(stats.playback_reserve_ms, bufferMs, 'requested playout reserve reaches the renderer');
  assert.equal(stats.playback_started, true, 'remote track reaches the playback graph');
  assert.equal(stats.playback_error, false, 'remote track plays without media errors');
  assert.equal(stats.microphone_active, false, 'the smoke never opens a microphone');
  const audibleRms = await waitForRms(0.003, 3000, `buffer_${bufferMs}_custom_sink`);
  await remote.setTone(440, 0);
  await sleep(250);
  await peer.close();
  assert.equal(peer.window.isDestroyed(), true);
  return { buffer_ms: bufferMs, audible_rms: audibleRms, receiver_target_ms: stats.receiver_buffer_target_ms, stats };
}

function readWave(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt16LE(20), 1, 'recordings are PCM, not encoded test data');
  assert.equal(bytes.readUInt16LE(22), 1, 'recording is mono');
  assert.equal(bytes.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
  const pcm = new Int16Array((bytes.length - 44) / 2);
  for (let index = 0; index < pcm.length; index++) pcm[index] = bytes.readInt16LE(44 + index * 2);
  return pcm;
}

function powerAt(pcm, frequency) {
  let real = 0, imaginary = 0;
  const step = 2 * Math.PI * frequency / SAMPLE_RATE;
  for (let index = 0; index < pcm.length; index++) {
    const sample = pcm[index];
    real += sample * Math.cos(step * index);
    imaginary += sample * Math.sin(step * index);
  }
  return Math.hypot(real, imaginary);
}

function inspectRecordedWave(pcm, expectedFrequency) {
  assert.ok(pcm.length >= SAMPLE_RATE * 0.55, `recorded clip must contain a substantial speech fragment (${pcm.length} samples)`);
  let squareSum = 0;
  for (const sample of pcm) squareSum += sample * sample;
  const rms = Math.sqrt(squareSum / pcm.length) / 32768;
  assert.ok(rms > 0.018, `recording must contain audible synthetic audio, got RMS ${rms}`);

  const frameSamples = 960; // 20ms at 48kHz
  const frameRms = [];
  for (let begin = 0; begin < pcm.length; begin += frameSamples) {
    const end = Math.min(pcm.length, begin + frameSamples);
    let framePower = 0;
    for (let index = begin; index < end; index++) framePower += pcm[index] * pcm[index];
    frameRms.push(Math.sqrt(framePower / (end - begin)) / 32768);
  }
  const active = frameRms.map(value => value > Math.max(0.004, rms * 0.12));
  const activeRatio = active.filter(Boolean).length / active.length;
  let longestGap = 0, gap = 0;
  for (const value of active) { gap = value ? 0 : gap + 1; longestGap = Math.max(longestGap, gap); }
  assert.ok(activeRatio >= 0.7, `recording should remain continuous through the tone (${activeRatio.toFixed(2)} active windows)`);
  assert.ok(longestGap <= 20, `recording must not contain a long internal dropout (${longestGap * 20}ms)`);

  const target = powerAt(pcm, expectedFrequency);
  const harmonic = powerAt(pcm, expectedFrequency * 2);
  const spectralRatio = target / Math.max(1, harmonic);
  assert.ok(spectralRatio > 5, `recording should preserve remote ${expectedFrequency}Hz tone, ratio ${spectralRatio.toFixed(1)}`);
  return { samples: pcm.length, duration_ms: Math.round(pcm.length * 1000 / SAMPLE_RATE), rms, active_window_ratio: activeRatio,
    longest_gap_ms: longestGap * 20, frequency_harmonic_ratio: spectralRatio };
}

async function runRecordAndFifoCase({ chromiumMedia, MissedAudio, MissedPlayer, outputDeviceId }) {
  const recordingDirectory = path.join(temporaryRoot, 'recordings');
  replayPlayer = new MissedPlayer({ BrowserWindow, session, getOutputDevice: () => outputDeviceId });
  recordings = new MissedAudio({ directory: recordingDirectory, player: replayPlayer });
  const peer = makeTonePeerFactory({ chromiumMedia, archive: recordings,
    getSpeakersMuted: () => recordings.desiredMuted || recordings.playing,
    mediaOptions: { bufferMs: 500, outputDeviceId, recordingEnabled: true } });
  peers.push(peer);
  const remote = await connectSyntheticRemote(peer, { frequency: 440, gain: 0.15 });
  await sleep(1500);
  const audibleStats = await peer.getStats();
  assert.equal(audibleStats.recording_error ?? null, null, 'the remote audio tap and worklet initialize');
  assert.equal(recordings.queue.length, 0, 'audible unmuted audio is not saved');
  const audibleRms = await waitForRms(0.003, 3000, 'recording_case_output');

  await peer.setSpeakersMuted(true);
  await sleep(80);
  const mutedStats = await peer.getStats();
  assert.equal(mutedStats.speaker_gain, 0, 'speaker mute gates the real output branch');
  assert.equal(mutedStats.clock_driver_muted, true, 'muting does not stop Chromium’s WebRTC clock');
  const mutedRms = await waitForQuiet(0.0001, 3000, 'speaker_mute_gate');
  await sleep(1250);
  await remote.setTone(440, 0);
  await sleep(2200);
  assert.equal(recordings.queue.length, 1, 'the muted remote segment is persisted after silence');

  await remote.setTone(660, 0.15);
  await sleep(1350);
  await remote.setTone(660, 0);
  await sleep(1200); // drain the 500ms receive reserve and VAD tail
  await peer.setSpeakersMuted(false);
  await sleep(300);
  assert.equal(recordings.queue.length, 2, 'speaker unmute flushes the second muted fragment');

  const waveReports = recordings.queue.map((clip, index) => {
    const pcm = readWave(path.join(recordingDirectory, clip.name));
    return inspectRecordedWave(pcm, index === 0 ? 440 : 660);
  });

  // Stop midway through a real queued playback. An incomplete HTMLAudioElement
  // ended event must leave that file unread and retryable.
  const queuedNames = recordings.queue.map(clip => clip.name);
  recordings.play();
  await sleep(260);
  const replayRms = await waitForRms(0.003, 2500, 'custom_sink_missed_replay');
  await recordings.stop();
  assert.deepEqual(recordings.queue.map(clip => clip.name), queuedNames, 'interrupted playback keeps all unended files');
  assert.equal(fs.readdirSync(recordingDirectory).filter(name => name.endsWith('.wav')).length, 2);

  const played = [], ended = [], queueChanges = [];
  recordings.onChange = () => queueChanges.push({
    names: recordings.queue.map(clip => clip.name),
    files: new Set(fs.readdirSync(recordingDirectory).filter(name => name.endsWith('.wav'))),
  });
  const expectedOrder = queuedNames.slice();
  const extraPcm = Int16Array.from({ length: SAMPLE_RATE }, (_, index) =>
    Math.round(5000 * Math.sin(index * 2 * Math.PI * 330 / SAMPLE_RATE)));
  const play = replayPlayer.play.bind(replayPlayer);
  replayPlayer.play = async (file, durationMs) => {
    const name = path.basename(file);
    played.push(name);
    assert.ok(fs.existsSync(file), 'a queued file remains on disk until it ends');
    const complete = await play(file, durationMs);
    if (complete) {
      ended.push(name);
      if (ended.length === 1) {
        await recordings.save({ sampleRate: SAMPLE_RATE, pcm: extraPcm });
        expectedOrder.push(recordings.queue.at(-1).name);
      }
    }
    return complete;
  };
  recordings.play();
  await recordings.finished;
  assert.deepEqual(played, expectedOrder, 'one FIFO drain plays older replies before a reply arriving during playback');
  assert.deepEqual(ended, expectedOrder, 'all three WAVs reached HTMLAudioElement ended');
  assert.equal(recordings.queue.length, 0);
  assert.equal(fs.readdirSync(recordingDirectory).filter(name => name.endsWith('.wav')).length, 0,
    'fully ended recordings are deleted');
  for (const name of ended) {
    const removal = queueChanges.find(change => !change.names.includes(name) && !change.files.has(name));
    assert.ok(removal, `the completed ${name} WAV is removed after the ended event`);
  }

  await peer.close();
  const finalStats = await peer.getStats().catch(() => ({}));
  assert.equal(peer.window.isDestroyed(), true);
  return { unmuted_output_rms: audibleRms, muted_output_rms: mutedRms, missed_replay_output_rms: replayRms,
    recording_waveforms: waveReports, fifo_played: played.length, fifo_replies_arriving_during_playback: true,
    interrupted_playback_keeps_unended_files: true, ended_playback_deletes_all_files: true,
    final_stats: finalStats };
}

async function runWorkerCleanupCase({ routedChromiumMedia, outputDeviceId }) {
  const WorkerPeer = routedChromiumMedia({
    electron: process.execPath,
    runtimeDir: process.env.XDG_RUNTIME_DIR,
    mediaOptions: { bufferMs: 500, outputDeviceId, recordingEnabled: false },
    packaged: false,
  });
  const peer = new WorkerPeer(() => {}, () => {}, error => failures.push(error?.code || 'worker_failure'));
  const userData = peer.userDataDirectory;
  await peer.ready;
  const offer = await peer.createOffer();
  assert.match(offer, /m=audio/, 'worker created a local WebRTC offer without microphone capture');
  await peer.close();
  assert.equal(peer.childClosed, true, 'cancelled worker process exits cleanly');
  assert.equal(peer.exit?.code, 0, 'cancelled worker exits without a media failure');
  await waitFor(() => !fs.existsSync(userData), 3000, 'worker_profile_cleanup');
  return { worker_cancelled_after_offer: true, child_exit_code: peer.exit.code, private_profile_removed: true };
}

async function cleanup() {
  for (const peer of peers) {
    try { await peer.close(); } catch {}
  }
  try { await replayPlayer?.close(); } catch {}
  try { await recordings?.clear(); } catch {}
  if (monitor && monitor.exitCode === null) {
    const closed = once(monitor, 'close').catch(() => []);
    monitor.kill('SIGTERM');
    await Promise.race([closed, sleep(1000)]);
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  clearTimeout(timedOut);
}

async function main() {
  startMonitor();
  await waitFor(() => monitorChunks.length > 0, 5000, 'pulse_null_sink_monitor');
  const qaDevices = await enumerateQaOutput();
  const { chromiumMedia } = await import(pathToFileURL(path.join(ROOT, 'src', 'chromium_media.mjs')).href);
  const { MissedAudio } = await import(pathToFileURL(path.join(ROOT, 'src', 'missed_audio.mjs')).href);
  const { MissedPlayer } = await import(pathToFileURL(path.join(ROOT, 'src', 'missed_player.mjs')).href);
  const { routedChromiumMedia } = await import(pathToFileURL(path.join(ROOT, 'src', 'media_worker_peer.mjs')).href);

  const bufferCases = [];
  for (const bufferMs of [0, 500]) bufferCases.push(await runBufferCase({ chromiumMedia, outputDeviceId: qaDevices.id, bufferMs }));
  const recording = await runRecordAndFifoCase({ chromiumMedia, MissedAudio, MissedPlayer, outputDeviceId: qaDevices.id });
  const worker = await runWorkerCleanupCase({ routedChromiumMedia, outputDeviceId: qaDevices.id });
  assert.deepEqual(failures, [], 'media peer or worker must not report failures');
  const result = {
    result: 'passed', electron: process.versions.electron, chromium: process.versions.chrome,
    pulse_sink: SINK, enumerated_output_label: qaDevices.label, output_devices: qaDevices.outputs,
    no_microphone_capture: true, playout_reserves: bufferCases, recording_fifo: recording, worker_cleanup: worker,
  };
  await cleanup();
  console.log(JSON.stringify(result));
  app.exit(0);
}

timedOut = setTimeout(() => {
  console.error(JSON.stringify({ result: 'failed', error: 'smoke_timeout' }));
  void cleanup().finally(() => app.exit(2));
}, 90_000);
timedOut.unref();

app.whenReady().then(main).catch(async error => {
  console.error(JSON.stringify({ result: 'failed', error: error?.message || String(error), stack: error?.stack }));
  await cleanup();
  app.exit(1);
});
