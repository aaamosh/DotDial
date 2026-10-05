'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WakeManager } = require('../src/wake-manager.cjs');
const { MODEL, MODEL_FILES, findWakePython } = require('../src/wake-runtime.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const config = { enabled: true, phrase: 'Hey Dot', sensitivity: 6, modelPath: '', pythonPath: 'python3' };
async function until(predicate) { for (let n = 0; n < 30; n++) { if (predicate()) return; await tick(); } assert.fail('condition did not settle'); }

function fixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-wake-mac-'));
  fs.mkdirSync(path.join(dataDir, 'models', MODEL), { recursive: true });
  for (const file of MODEL_FILES) fs.writeFileSync(path.join(dataDir, 'models', MODEL, file), 'synthetic');
  const children = [], captures = [], wakes = [], changes = [];
  const manager = new WakeManager({ paths: { dataDir }, platform: 'darwin',
    requestMicrophoneAccess: async () => true, findPython: async () => '/synthetic/python3.12',
    onWake: () => wakes.push('wake'), onChange: () => changes.push([manager.status, manager.error]),
    spawn(command, args) {
      const child = new EventEmitter(); child.command = command; child.args = args; child.stdout = new EventEmitter();
      child.stdin = new EventEmitter(); child.stdin.writableLength = 0; child.writes = [];
      child.stdin.write = (pcm, callback) => { child.writes.push(Buffer.from(pcm)); queueMicrotask(() => callback()); return true; };
      child.stdin.end = () => { child.stdin.writableEnded = true; };
      child.exitCode = null; child.signalCode = null;
      child.close = () => { if (child.exitCode !== null) return; child.exitCode = 0; child.emit('close', 0); };
      child.kill = () => { queueMicrotask(child.close); return true; };
      child.ready = () => child.stdout.emit('data', Buffer.from('{"event":"ready"}\n'));
      child.wake = () => child.stdout.emit('data', Buffer.from('{"event":"wake"}\n'));
      children.push(child); return child;
    },
    captureFactory(callbacks) {
      let resolveReady;
      const capture = { callbacks, ready: new Promise(resolve => { resolveReady = resolve; }), closed: false,
        close() { this.closed = true; return Promise.resolve(); }, finish() { resolveReady(); } };
      captures.push(capture); return capture;
    }, ...overrides,
  });
  t.after(async () => { await manager.close(); children.forEach(child => child.close()); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { manager, children, captures, wakes, changes };
}

test('mac wake gives microphone ownership to Electron, streams bounded PCM and waits for capture before reporting ready', async t => {
  const f = fixture(t); f.manager.configure({ ...config, deviceName: 'Saved Linux input', deviceHostApi: 'PulseAudio' }, { inputDeviceId: 'label:Headset' });
  await until(() => f.children.length === 1);
  const child = f.children[0];
  assert.ok(child.args.includes('--stdin-audio')); assert.equal(child.command, '/synthetic/python3.12');
  assert.ok(!child.args.includes('--device-name') && !child.args.includes('--device-host-api'), 'mac wake does not select a Python microphone');
  assert.equal(f.captures.length, 0);
  child.ready(); child.wake();
  assert.equal(f.captures.length, 1); assert.equal(f.manager.status, 'starting'); assert.deepEqual(f.wakes, []);
  f.captures[0].finish(); await tick();
  assert.equal(f.manager.status, 'listening'); child.wake(); assert.deepEqual(f.wakes, ['wake']);
  await f.captures[0].callbacks.onAudio(Buffer.alloc(6400)); assert.equal(child.writes.length, 1);
  child.stdin.writableLength = 25600;
  await assert.rejects(f.captures[0].callbacks.onAudio(Buffer.alloc(6400)), { code: 'wake_audio_backpressure' });
  assert.equal(child.writes.length, 1, 'overflow is never queued');
  const stop = f.manager.pauseAndWait();
  assert.equal(f.captures[0].closed, true, 'capture closes synchronously before waiting for Python');
  await stop; child.wake(); assert.deepEqual(f.wakes, ['wake']);
  await assert.rejects(f.captures[0].callbacks.onAudio(Buffer.alloc(4)), { code: 'wake_capture_cancelled' });
});

test('mac voice commands use argv while stdin stays binary PCM through idle replay', async t => {
  const received = [], commands = require('../src/config.cjs').defaults.wakeWord.commands;
  const f = fixture(t, { onCommand: action => received.push(action) });
  f.manager.configure({ ...config, commandsEnabled: true, commands });
  await until(() => f.children.length === 1);
  const child = f.children[0];
  assert.deepEqual(JSON.parse(child.args[child.args.indexOf('--commands-json') + 1]), commands);
  child.ready(); f.captures[0].finish(); await tick();
  const pcm = Buffer.alloc(6400); pcm.writeFloatLE(0.25);
  await f.captures[0].callbacks.onAudio(pcm);
  f.manager.setCallState({ state: 'ready', missed_playing: true });
  child.wake();
  child.stdout.emit('data', Buffer.from('{"event":"command","command":"stopPlayback"}\n'));
  assert.deepEqual(received, ['stopPlayback']); assert.deepEqual(f.wakes, []);
  assert.deepEqual(child.writes, [pcm]);
  assert.equal(f.captures[0].closed, false);
});

test('denied mac permission does not launch Python or acquire a microphone', async t => {
  const f = fixture(t, { requestMicrophoneAccess: async () => false, findPython: () => assert.fail('must not probe') });
  f.manager.configure(config); await until(() => f.manager.status === 'error');
  assert.equal(f.manager.error, 'microphone_permission_required');
  assert.equal(f.children.length, 0); assert.equal(f.captures.length, 0);
});

test('mac wake-device scan never launches the PortAudio backend', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.manager.listDevices(), { status: 'wake_devices_unavailable', inputs: [] });
  assert.equal(f.children.length, 0); assert.equal(f.captures.length, 0);
});

test('cancelling during a Python probe prevents a late microphone startup', async t => {
  let resolveProbe;
  const f = fixture(t, { findPython: () => new Promise(resolve => { resolveProbe = resolve; }) });
  f.manager.configure(config); await until(() => resolveProbe);
  f.manager.configure({ ...config, enabled: false }); resolveProbe('/synthetic/python'); await tick(); await tick();
  assert.equal(f.children.length, 0); assert.equal(f.captures.length, 0); assert.equal(f.manager.status, 'disabled');
});

test('worker crash closes pending mac capture and late readiness cannot resurrect listening', async t => {
  const f = fixture(t); f.manager.configure(config); await until(() => f.children.length);
  f.children[0].ready(); const capture = f.captures[0];
  f.children[0].close(); assert.equal(capture.closed, true);
  capture.finish(); await tick(); assert.equal(f.manager.status, 'error'); assert.equal(f.manager.error, 'wake_stopped');
  assert.equal(f.manager.capture, null);
});

test('changing only selected input restarts mac capture and rejects old generation audio', async t => {
  const f = fixture(t); f.manager.configure(config, { inputDeviceId: 'label:Old' }); await until(() => f.children.length);
  f.children[0].ready(); f.captures[0].finish(); await tick();
  f.manager.configure(config, { inputDeviceId: 'label:New' });
  assert.equal(f.captures[0].closed, true);
  await until(() => f.children.length === 2);
  await assert.rejects(f.captures[0].callbacks.onAudio(Buffer.alloc(4)), { code: 'wake_capture_cancelled' });
  f.children[1].ready(); f.captures[1].finish(); await tick(); assert.equal(f.manager.status, 'listening');
});

test('mac installer selects checked Python and decoder-only dependencies, and quit cancels a pending probe', async t => {
  const f = fixture(t);
  assert.equal((await f.manager.install()).status, 'wake_setup_started');
  assert.ok(f.children[0].args.includes('--stdin-audio'));
  assert.equal(f.children[0].command, '/synthetic/python3.12'); f.children[0].close();
  let resolveProbe;
  const g = fixture(t, { findPython: () => new Promise(resolve => { resolveProbe = resolve; }) });
  const installing = g.manager.install(); await until(() => resolveProbe);
  await g.manager.close(); resolveProbe('/synthetic/python');
  assert.equal((await installing).status, 'wake_setup_cancelled'); assert.equal(g.children.length, 0);
});

test('installing with a selected base Python starts the recognizer from its managed environment afterward', async t => {
  const probes = [];
  const f = fixture(t, { findPython: (settings, paths, options) => findWakePython(settings, paths, {
    ...options, execFile(file, _args, _options, callback) {
      probes.push(file); callback(null, '[3,12,1]');
    },
  }) });
  const tokens = path.join(f.manager.paths.dataDir, 'models', MODEL, 'tokens.txt');
  fs.unlinkSync(tokens);
  f.manager.configure({ ...config, pythonPath: '/selected/python3.12' });
  await until(() => f.manager.status === 'setup_required');
  assert.equal((await f.manager.install()).status, 'wake_setup_started');
  assert.equal(f.children[0].command, '/selected/python3.12');
  const localPython = path.join(f.manager.paths.dataDir, 'wake-venv', 'bin', 'python');
  fs.mkdirSync(path.dirname(localPython), { recursive: true });
  fs.writeFileSync(localPython, 'synthetic installed interpreter');
  fs.writeFileSync(tokens, 'synthetic installed model');
  f.children[0].close();
  await until(() => f.children.length === 2);
  assert.equal(f.children[1].command, localPython, 'listener uses the interpreter containing installed dependencies');
  assert.deepEqual(probes, ['/selected/python3.12', localPython]);
  f.children[1].ready(); f.captures[0].finish(); await tick();
  assert.equal(f.manager.status, 'listening');
});


test('mac live command edits replace only the local decoder, reject stale labels and retain selected input', async t => {
  const commands = require('../src/config.cjs').defaults.wakeWord.commands;
  const received = [];
  const f = fixture(t, { onCommand: action => received.push(action) });
  const settings = { ...config, commandsEnabled: true, commands };
  f.manager.setCallState({ state: 'active', missed_playing: false });
  f.manager.configure(settings, { inputDeviceId: 'label:Private headset' });
  await until(() => f.children.length === 1);
  f.children[0].ready(); f.captures[0].finish(); await tick();
  f.manager.configure({ ...settings, commands: { ...commands, microphoneOff: 'Disable microphone' } });
  assert.equal(f.captures[0].closed, true);
  await until(() => f.children.length === 2);
  const previous = f.children[0], current = f.children[1];
  const event = Buffer.from('{"event":"command","command":"microphoneOff"}\n');
  previous.stdout.emit('data', event); current.stdout.emit('data', event);
  assert.deepEqual(received, [], 'neither stale nor not-yet-listening commands execute');
  current.ready(); f.captures[1].finish(); await tick();
  current.stdout.emit('data', event);
  assert.deepEqual(received, ['microphoneOff']);
  assert.equal(f.manager.callState.state, 'active');
  assert.equal(f.manager.inputDeviceId, 'label:Private headset');
  assert.equal(JSON.parse(current.args[current.args.indexOf('--commands-json') + 1]).microphoneOff, 'Disable microphone');
  await assert.rejects(f.captures[0].callbacks.onAudio(Buffer.alloc(6400)), { code: 'wake_capture_cancelled' });
  f.manager.configure({ ...settings, commandsEnabled: false });
  await until(() => f.children.length === 3);
  f.children[2].ready(); f.captures[2].finish(); await tick();
  f.children[2].stdout.emit('data', event);
  assert.ok(!f.children[2].args.includes('--commands-json'));
  assert.deepEqual(received, ['microphoneOff']);
});
