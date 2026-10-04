'use strict';

// Run with the same bundle's Node mode:
// ELECTRON_RUN_AS_NODE=1 /absolute/DotDial.app/Contents/MacOS/DotDial \
//   scripts/smoke-macos-worker.cjs /absolute/DotDial.app
// The production worker launcher removes ELECTRON_RUN_AS_NODE from its child.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let peer;
let temporaryRoot;
let finishing = false;
let phase = 'bundle';
const started = Date.now();

async function until(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(75);
  }
  throw Error(message);
}

function alive(pid, processGroup = false) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // POSIX signal 0 only probes existence. The negative id addresses the
  // dedicated group created by the production launcher's detached: true.
  try { process.kill(processGroup ? -pid : pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function main() {
  const bundle = process.argv[2];
  assert.equal(process.platform, 'darwin', 'this smoke requires a native macOS runner');
  assert.ok(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1', 'use the bundled Electron Node mode');
  assert.ok(typeof bundle === 'string' && path.isAbsolute(bundle) && bundle.endsWith('.app'), 'supply an absolute .app path');
  const executable = path.join(bundle, 'Contents', 'MacOS', 'DotDial');
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(executable), 'worker and controller must use the same bundled runtime');
  const application = path.join(bundle, 'Contents', 'Resources', 'app');
  assert.ok(fs.statSync(path.join(application, 'src', 'media_worker.cjs')).isFile());
  const { routedChromiumMedia } = await import(pathToFileURL(path.join(application, 'src', 'media_worker_peer.mjs')).href);
  // A short /tmp path also stays below Unix socket path limits on macOS.
  temporaryRoot = fs.mkdtempSync('/tmp/dotdial-worker-smoke-');
  fs.chmodSync(temporaryRoot, 0o700);
  const failures = [];
  const Worker = routedChromiumMedia({ electron: executable, packaged: true, runtimeDir: temporaryRoot,
    electronArgs: [...(process.arch === 'x64' ? ['--disable-gpu'] : []), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
    mediaOptions: { bufferMs: 0, recordingEnabled: false }, getSpeakersMuted: () => true,
    startupTimeoutMs: 30_000, closeTimeoutMs: 8000 });
  phase = 'worker_start';
  peer = new Worker(() => {}, () => {}, error => failures.push(error?.code || 'media_failure'));
  const profile = peer.userDataDirectory;
  const pid = peer.child?.pid;
  assert.ok(Number.isInteger(pid) && pid > 0, 'packaged worker must have its own process');
  assert.equal(path.dirname(profile), temporaryRoot);
  assert.equal(fs.statSync(profile).mode & 0o077, 0);
  await peer.ready;
  assert.equal(alive(pid), true);
  assert.equal(alive(pid, true), true, 'worker must own a detached process group');
  phase = 'offer';
  const offer = await peer.createOffer();
  assert.match(offer, /m=audio\s/, 'bundled worker creates a real Chromium audio offer');
  const initial = await peer.getStats();
  assert.equal(initial.engine, 'chromium_webrtc');
  assert.equal(initial.media_route, 'direct');
  assert.equal(initial.microphone_active, false);
  assert.equal(initial.speakers_muted, true);
  phase = 'fake_microphone';
  await peer.startMicrophone();
  const active = await until(async () => {
    const stats = await peer.getStats();
    return stats.microphone_active ? stats : null;
  }, 'worker_fake_microphone_not_active');
  assert.equal(active.playback_error, false);
  assert.ok(peer.microphoneSettings && typeof peer.microphoneSettings === 'object');
  await peer.stopMicrophone();
  assert.equal((await peer.getStats()).microphone_active, false);
  await peer.setSpeakersMuted(false);
  assert.equal((await peer.getStats()).speaker_gain, 1);
  await peer.setSpeakersMuted(true);
  assert.equal((await peer.getStats()).speaker_gain, 0);
  phase = 'worker_cleanup';
  await peer.close();
  assert.equal(peer.childClosed, true, 'child close must be observed');
  assert.equal(peer.exit?.code, 0, 'normal shutdown must not require a termination signal');
  assert.equal(peer.exit?.signal ?? null, null);
  await until(() => !alive(pid) && !alive(pid, true) && !fs.existsSync(profile),
    'worker_process_group_or_profile_survived_close');
  assert.deepEqual(failures, []);
  assert.deepEqual(fs.readdirSync(temporaryRoot), [], 'worker must not leave sibling profiles behind');
  return { packagedWorkerSmoke: 'passed', result: 'passed', platform: process.platform, arch: process.arch,
    electron: process.versions.electron, node: process.versions.node, elapsed_ms: Date.now() - started,
    software_rendering_requested: process.arch === 'x64',
    packaged_worker_started: true, chromium_offer_created: true,
    fake_microphone_started: true, fake_microphone_stopped: true, speaker_gain_toggle: true,
    child_exit_code: peer.exit.code, child_process_gone: true, owned_process_group_gone: true, private_profile_removed: true,
    physical_microphone_tested: false, remote_call_tested: false };
}

async function finish(error, report) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  // The launcher owns this detached process group. If its close path hangs,
  // terminate only that group; leave its still-live profile intact on failure.
  const finalTimeout = setTimeout(() => {
    if (peer?.child?.pid) {
      try { process.kill(-peer.child.pid, 'SIGKILL'); } catch {}
    }
    console.error('DOTDIAL_MACOS_WORKER_SMOKE ' + JSON.stringify({ result: 'failed', phase, error: 'cleanup_timeout' }));
    process.exit(1);
  }, 15_000);
  try {
    await peer?.close();
    if (temporaryRoot && (!peer || (peer.childClosed && !alive(peer.child?.pid, true)))) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  } catch (cleanupError) { error ||= cleanupError; }
  clearTimeout(finalTimeout);
  if (error) {
    console.error('DOTDIAL_MACOS_WORKER_SMOKE ' + JSON.stringify({ result: 'failed', phase,
      error: String(error.message || 'worker_smoke_failed').slice(0, 500) }));
    process.exit(1);
  }
  fs.writeSync(1, JSON.stringify(report) + '\n');
  process.exit(0);
}

const watchdog = setTimeout(() => { void finish(Error('worker_smoke_timeout')); }, 90_000);
process.once('SIGTERM', () => { void finish(Error('worker_smoke_terminated')); });
process.once('SIGINT', () => { void finish(Error('worker_smoke_interrupted')); });
main().then(report => finish(null, report), error => finish(error));
