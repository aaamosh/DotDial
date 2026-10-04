'use strict';

// Offline integration of the macOS PCM path on a real Electron host. Requires
// an existing managed wake environment/model; never installs or opens an account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, session, ipcMain } = require('electron');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw Error(`missing_value_for_${name}`);
  return value;
}
const SOURCE = path.resolve(option('--app-source', path.join(__dirname, '..')));
const dataArgument = option('--data-dir', process.env.DOTDIAL_WAKE_DATA_DIR);
if (!dataArgument) throw Error('Use --data-dir PATH or DOTDIAL_WAKE_DATA_DIR with an installed wake environment.');
const DATA = path.resolve(dataArgument);
const OUTPUT = option('--output', null);
if (!['linux', 'darwin'].includes(process.platform)) throw Error('This smoke requires POSIX process signals.');
if (process.getuid?.() === 0) throw Error('Run the Electron smoke as an unprivileged user.');
const { WakeManager } = require(path.join(SOURCE, 'src', 'wake-manager.cjs'));
const { MODEL, wakeModelReady } = require(path.join(SOURCE, 'src', 'wake-runtime.cjs'));
const { createWakeCaptureFactory } = require(path.join(SOURCE, 'src', 'wake_capture.cjs'));
const PYTHON = path.join(DATA, 'wake-venv', 'bin', 'python');
const MODEL_PATH = path.join(DATA, 'models', MODEL);
const CHUNK_BYTES = 6400, MAX_PENDING = 4, MAX_QUEUED_BYTES = CHUNK_BYTES * MAX_PENDING;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-wake-pipeline-'));
const fakeAudio = path.join(temporary, 'synthetic-440hz.wav');
// A reproducible non-speech input: four seconds of 440 Hz bursts at 48 kHz.
// The real capture graph resamples this to 16 kHz; no speech is fabricated.
const inputRate = 48000, inputFrames = inputRate * 4;
const wave = Buffer.alloc(44 + inputFrames * 2);
wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(inputRate, 24); wave.writeUInt32LE(inputRate * 2, 28);
wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(inputFrames * 2, 40);
for (let index = 0; index < inputFrames; index++) {
  const seconds = index / inputRate, cycle = seconds % 0.5;
  const envelope = cycle < 0.35 ? Math.min(1, cycle / 0.005, (0.35 - cycle) / 0.005) : 0;
  wave.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * seconds) * envelope * 0.25 * 32767), 44 + index * 2);
}
fs.writeFileSync(fakeAudio, wave);
app.setName('DotDial Wake Pipeline QA');
app.setPath('userData', path.join(temporary, 'electron-profile'));
app.on('window-all-closed', () => {});
for (const flag of ['use-fake-device-for-media-stream', 'use-fake-ui-for-media-stream', 'mute-audio', 'disable-renderer-backgrounding']) {
  app.commandLine.appendSwitch(flag);
}
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeAudio);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

const started = Date.now(), children = [], captures = [], states = [], phases = [];
let manager, aborted = false, finishing = false, wakeEvents = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (aborted) throw Error('smoke_aborted');
    if (predicate()) return;
    await sleep(25);
  }
  throw Error(label);
}
function alive(child) { return child.exitCode === null && child.signalCode === null; }
function observeChild(command, args, options) {
  assert.equal(command, PYTHON, 'the recognizer must run in its managed environment');
  assert.ok(args.includes('--stdin-audio'), 'exercise the PCM-only detector');
  assert.ok(!args.includes('--device-name') && !args.includes('--device-host-api'));
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  const record = { child, pid: child.pid, ready: 0, wakes: 0, errors: [], stderr: '', exited: false, code: null, signal: null };
  let pending = '';
  child.stdout.on('data', chunk => {
    pending += chunk.toString();
    if (pending.length > 16384) { record.errors.push('stdout_limit'); pending = ''; return; }
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { record.errors.push('invalid_json'); continue; }
      if (event.event === 'ready') record.ready++;
      if (event.event === 'wake') record.wakes++;
      if (event.event === 'error' && record.errors.length < 8) record.errors.push(String(event.code));
    }
  });
  child.stderr.on('data', chunk => { record.stderr = (record.stderr + chunk.toString()).slice(-4000); });
  child.on('error', error => record.errors.push(String(error.code || 'spawn_failed')));
  child.on('close', (code, signal) => { record.exited = true; record.code = code; record.signal = signal; });
  children.push(record);
  return child;
}
function observeCapture(factory, callbacks) {
  const record = { capture: null, chunks: 0, bytes: 0, acknowledged: 0, pending: 0, maxPending: 0,
    maxQueuedBytes: 0, peak: 0, closed: false, callbacksAfterClose: 0, errors: [] };
  const capture = factory({
    onAudio: async pcm => {
      if (record.closed) record.callbacksAfterClose++;
      assert.equal(pcm.length, CHUNK_BYTES);
      for (let offset = 0; offset < pcm.length; offset += 4) {
        const sample = pcm.readFloatLE(offset);
        assert.ok(Number.isFinite(sample) && Math.abs(sample) <= 1, 'finite normalized float32 PCM');
        record.peak = Math.max(record.peak, Math.abs(sample));
      }
      record.chunks++; record.bytes += pcm.length; record.pending++;
      record.maxPending = Math.max(record.maxPending, record.pending);
      try {
        const written = callbacks.onAudio(pcm);
        record.maxQueuedBytes = Math.max(record.maxQueuedBytes, manager.child?.stdin.writableLength || 0);
        await written;
        record.acknowledged++;
      } finally { record.pending--; }
    },
    onError: code => { record.errors.push(code); callbacks.onError(code); },
  });
  record.capture = capture;
  capture.window.once('closed', () => { record.closed = true; });
  captures.push(record);
  return capture;
}
async function listening(index, chunks = 25) {
  await until(() => {
    if (manager.error) throw Error(`listener_start_failed:${manager.error}`);
    return children.length === index + 1 && captures.length === index + 1 && manager.status === 'listening';
  }, 35000, 'listener_start_timeout');
  const child = children[index], capture = captures[index];
  await until(() => {
    if (manager.error || !alive(child.child)) throw Error(`live_pipeline_failed:${manager.error || 'detector_exited'}`);
    return capture.acknowledged >= chunks;
  }, 7000, 'real_pcm_writes_missing');
  assert.equal(child.ready, 1); assert.deepEqual(child.errors, []); assert.deepEqual(capture.errors, []);
  assert.ok(capture.peak >= 0.001, `real PCM must contain the synthetic input, observed peak ${capture.peak}`);
  assert.ok(capture.maxPending <= MAX_PENDING); assert.ok(capture.maxQueuedBytes <= MAX_QUEUED_BYTES);
  return { child, capture };
}
function assertReaped(index) {
  assert.equal(children[index].exited, true, 'detector close event must be observed');
  assert.equal(alive(children[index].child), false, 'detector must not remain alive');
  assert.equal(captures[index].capture.window.isDestroyed(), true, 'owned capture window must be destroyed');
  assert.equal(captures[index].callbacksAfterClose, 0);
}

async function finish(error) {
  if (finishing) return;
  finishing = true; aborted = true; clearTimeout(watchdog);
  const cleanupErrors = [];
  try { if (manager) await deadline(manager.close(), 3500, 'manager_close_timeout'); }
  catch (failure) { cleanupErrors.push(String(failure.message)); }
  for (const record of children) if (alive(record.child)) { try { record.child.kill('SIGKILL'); } catch {} }
  for (const record of captures) {
    try { await deadline(record.capture.close(), 1000, 'capture_close_timeout'); }
    catch (failure) { cleanupErrors.push(String(failure.message || failure)); }
  }
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
  if (children.some(record => !record.exited)) {
    const end = Date.now() + 1000;
    while (children.some(record => !record.exited) && Date.now() < end) await sleep(25);
  }
  if (children.some(record => !record.exited || alive(record.child))) cleanupErrors.push('detector_not_reaped');
  const report = {
    wakePipelineSmoke: error || cleanupErrors.length ? 'failed' : 'passed',
    hostPlatform: process.platform, hostArch: process.arch, exercisedPath: 'macos_pcm', tccMocked: true,
    electron: process.versions.electron, chromium: process.versions.chrome, sourceRoot: SOURCE, dataDir: DATA,
    python: PYTHON, model: MODEL_PATH, microphone: 'chromium_fake_device', positiveSpeechTested: false,
    syntheticInput: { kind: '440hz_sine_bursts', sampleRate: inputRate, seconds: 4, format: 'pcm16_wav' },
    physicalMicrophoneTested: false, accountCallTested: false, audibleOutputTested: false,
    sampleRate: 16000, channels: 1, sampleFormat: 'float32le', chunkBytes: CHUNK_BYTES,
    wakeEvents, phases, states, elapsedMs: Date.now() - started,
    captures: captures.map(({ chunks, bytes, acknowledged, maxPending, maxQueuedBytes, peak, closed, callbacksAfterClose, errors }) =>
      ({ chunks, bytesSubmitted: bytes, writesAcknowledged: acknowledged, maxPending, maxQueuedBytes, peak, closed, callbacksAfterClose, errors })),
    detectors: children.map(({ pid, ready, wakes, errors, stderr, exited, code, signal }) => ({ pid, ready, wakes, errors, stderr, exited, code, signal })),
    captureWindowsRemaining: BrowserWindow.getAllWindows().length, cleanupErrors,
    ...(error ? { error: String(error.message || error).slice(0, 1000) } : {}),
  };
  try { fs.rmSync(temporary, { recursive: true, force: true }); }
  catch (failure) { report.cleanupErrors.push(String(failure.code || 'profile_cleanup_failed')); report.wakePipelineSmoke = 'failed'; }
  if (OUTPUT) {
    try { fs.mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true }); fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n'); }
    catch (failure) { report.wakePipelineSmoke = 'failed'; report.error = `report_write_failed:${failure.code || failure.message}`; }
  }
  fs.writeSync(1, JSON.stringify(report) + '\n');
  app.exit(report.wakePipelineSmoke === 'passed' ? 0 : 1);
}
const watchdog = setTimeout(() => { void finish(Error('wake_pipeline_deadline')); }, 140000);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void finish(Error(`wake_pipeline_interrupted_${signal}`)); });
}

void app.whenReady().then(async () => {
  assert.ok(fs.existsSync(PYTHON), 'managed wake Python is required');
  assert.ok(wakeModelReady(MODEL_PATH), 'all real model files must exist and be readable');
  const factory = createWakeCaptureFactory({ BrowserWindow, session, ipcMain, getMicrophoneDeviceId: () => 'default' });
  manager = new WakeManager({ paths: { dataDir: DATA }, platform: 'darwin',
    requestMicrophoneAccess: async () => true, spawn: observeChild,
    captureFactory: callbacks => observeCapture(factory, callbacks), onWake: () => { wakeEvents++; },
    onChange: () => { if (states.length < 40) states.push({ status: manager.status, error: manager.error, atMs: Date.now() - started }); },
  });
  manager.configure({ enabled: true, phrase: 'Hey Dot', sensitivity: 6, pythonPath: PYTHON, modelPath: MODEL_PATH,
    deviceName: '', deviceHostApi: '' }, { inputDeviceId: 'default' });
  const initial = await listening(0);
  phases.push({ name: 'real_pcm_to_detector', result: 'passed', acknowledgedBytes: initial.capture.acknowledged * CHUNK_BYTES });

  const paused = manager.pauseAndWait();
  assert.equal(initial.capture.capture.window.isDestroyed(), true, 'pause closes capture before waiting for Python');
  await deadline(paused, 4000, 'pause_did_not_finish'); assertReaped(0);
  const oldChunks = initial.capture.chunks;
  manager.setPaused(false);
  const resumed = await listening(1);
  assert.notEqual(resumed.child.pid, initial.child.pid); assert.equal(initial.capture.chunks, oldChunks);
  phases.push({ name: 'pause_and_resume', result: 'passed', oldDetectorReaped: true });

  const stalledAt = Date.now();
  resumed.child.child.kill('SIGSTOP');
  await until(() => {
    if (manager.error && manager.error !== 'wake_audio_backpressure') throw Error(`unexpected_stall_error:${manager.error}`);
    return manager.status === 'error' && manager.error === 'wake_audio_backpressure';
  }, 30000, 'stalled_reader_did_not_apply_backpressure');
  assertReaped(1);
  assert.equal(resumed.child.signal, 'SIGKILL', 'a stopped reader must be forcibly reaped after SIGTERM cannot run');
  assert.ok(resumed.capture.maxPending <= MAX_PENDING); assert.ok(resumed.capture.maxQueuedBytes <= MAX_QUEUED_BYTES);
  assert.deepEqual(resumed.capture.errors, ['wake_audio_backpressure']);
  phases.push({ name: 'real_stalled_reader', result: 'passed', signal: 'SIGSTOP', error: manager.error,
    elapsedMs: Date.now() - stalledAt, detectorReaped: true, captureWindowDestroyed: true });

  manager.start();
  await listening(2, 10);
  await deadline(manager.close(), 4000, 'whole_pipeline_close_timeout'); assertReaped(2);
  const finalChunks = captures.map(record => record.chunks);
  await sleep(350);
  assert.deepEqual(captures.map(record => record.chunks), finalChunks, 'no capture callbacks after whole-chain close');
  assert.ok(captures.every(record => record.callbacksAfterClose === 0));
  assert.equal(BrowserWindow.getAllWindows().length, 0); assert.equal(wakeEvents, 0, 'fake non-speech must not trigger Hey Dot');
  phases.push({ name: 'restart_and_whole_chain_close', result: 'passed', postCloseObservationMs: 350 });
  await finish();
}).catch(error => { void finish(error); });
