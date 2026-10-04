'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WakeManager } = require('../src/wake-manager.cjs');
const MODEL = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let tries = 0; tries < 30; tries++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('condition did not settle');
}

class FakeChild extends EventEmitter {
  constructor(command, args) {
    super();
    this.command = command;
    this.args = args;
    this.stdout = new EventEmitter();
    this.stdin = { end() {} };
    this.exitCode = null;
    this.signalCode = null;
    this.killSignals = [];
    this.didClose = false;
  }
  kill(signal) {
    this.killSignals.push(signal);
    queueMicrotask(() => this.close(null, signal));
    return true;
  }
  close(code = 0, signal = null) {
    if (this.didClose) return;
    this.didClose = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
  ready() { this.stdout.emit('data', Buffer.from('{"event":"ready"}\n')); }
  wake() { this.stdout.emit('data', Buffer.from('{"event":"wake"}\n')); }
}

function fixture(t, { model = true, onSpawn } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-wake-'));
  const dataDir = path.join(root, 'data');
  const modelDir = path.join(dataDir, 'models', MODEL);
  if (model) {
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'tokens.txt'), 'tokens');
  }
  const paths = { dataDir };
  const children = [];
  const spawn = (command, args) => {
    const child = new FakeChild(command, args);
    children.push(child);
    onSpawn?.(child);
    return child;
  };
  const changes = [];
  const wakes = [];
  const manager = new WakeManager({
    paths, spawn,
    onWake: () => wakes.push('wake'),
    onChange: () => changes.push({ status: manager.status, error: manager.error }),
  });
  t.after(async () => {
    for (const child of children) child.close(0);
    await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, modelDir, children, changes, wakes, manager };
}

const enabledConfig = { enabled: true, phrase: 'Hey Dot', sensitivity: 6, modelPath: '', pythonPath: 'python3' };

test('call pause waits for listener exit and a fast resume starts exactly one replacement', async t => {
  const f = fixture(t);
  f.manager.configure(enabledConfig);
  await until(() => f.children.length === 1);
  const original = f.children[0];
  original.ready();
  assert.equal(f.manager.status, 'listening');

  f.manager.setPaused(true);
  const stopping = f.manager.stopping;
  assert.deepEqual(original.killSignals, ['SIGTERM']);
  assert.equal(f.children.length, 1);
  f.manager.setPaused(false);
  assert.equal(f.children.length, 1, 'resume must not overlap the still-exiting listener');
  await stopping;
  await until(() => f.children.length === 2);
  original.wake();
  assert.deepEqual(f.wakes, [], 'late output from the paused child must be ignored');

  f.children[1].ready();
  assert.equal(f.manager.status, 'listening');
  f.children[1].wake();
  assert.deepEqual(f.wakes, ['wake']);
});

test('missing model and an unavailable interpreter leave stable setup errors', async t => {
  const missing = fixture(t, { model: false });
  missing.manager.configure(enabledConfig);
  await tick();
  assert.equal(missing.manager.status, 'setup_required');
  assert.equal(missing.manager.error, 'wake_model_missing');
  assert.equal(missing.children.length, 0);

  const unavailable = fixture(t, { onSpawn(child) {
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('missing python'), { code: 'ENOENT' }));
      child.close(-2);
    });
  } });
  unavailable.manager.configure(enabledConfig);
  await until(() => unavailable.manager.status === 'setup_required');
  assert.equal(unavailable.manager.error, 'wake_python_unavailable');
  await tick();
  assert.equal(unavailable.manager.status, 'setup_required', 'the close event must not overwrite the spawn error');
});

test('installer spawn failure is reported without leaving install state stuck', async t => {
  const f = fixture(t, { onSpawn(child) {
    if (child.args[0]?.endsWith('setup-wake.py')) {
      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('missing python3'), { code: 'ENOENT' }));
        child.close(-2);
      });
    }
  } });
  assert.deepEqual(await f.manager.install(), { status: 'wake_setup_started' });
  await until(() => f.manager.status === 'setup_required');
  assert.equal(f.manager.error, 'wake_setup_failed');
  assert.equal(f.manager.installing, false);
  assert.equal(f.manager.installer, null);
});

test('quit cancels an installer and never restarts wake listening', async t => {
  const f = fixture(t);
  f.manager.configure(enabledConfig);
  await until(() => f.children.length === 1);
  const installResult = f.manager.install();
  await until(() => f.children.length === 2);
  assert.match(f.children[1].args[0], /setup-wake\.py$/);
  const stateChangesBeforeClose = f.changes.length;

  await f.manager.close();
  assert.deepEqual(await installResult, { status: 'wake_setup_started' });
  assert.equal(f.children[1].killSignals[0], 'SIGTERM');
  assert.equal(f.manager.closed, true);
  assert.equal(f.manager.installing, false);
  assert.equal(f.children.length, 2, 'a successful or failed installer must not start another listener while quitting');
  assert.equal(f.changes.length, stateChangesBeforeClose, 'shutdown must not publish a stale installer result');
});

test('quit during the listener shutdown window prevents a late installer spawn', async t => {
  const f = fixture(t);
  f.manager.configure(enabledConfig);
  await until(() => f.children.length === 1);
  const installResult = f.manager.install();
  const closing = f.manager.close();
  await closing;
  assert.deepEqual(await installResult, { status: 'wake_setup_cancelled' });
  assert.equal(f.children.length, 1);
  assert.equal(f.manager.installer, null);
});

test('the same local listener stays alive through a call and all mute combinations', async t => {
  const f = fixture(t); f.manager.configure(enabledConfig);
  await until(() => f.children.length === 1);
  const listener = f.children[0]; listener.ready();
  for (const state of ['starting', 'active', 'stopping', 'ready']) {
    for (const microphone_muted of [true, false]) for (const speakers_muted of [true, false]) {
      f.manager.setCallState({ state, microphone_muted, speakers_muted });
      assert.equal(f.manager.paused, false);
      assert.equal(f.manager.child, listener);
    }
  }
  f.manager.setCallState({ state: 'active', missed_playing: true });
  listener.wake();
  assert.deepEqual(f.wakes, ['wake']);
  assert.deepEqual(listener.killSignals, []);
  f.manager.setCallState({ state: 'ready', missed_playing: true });
  listener.wake();
  assert.deepEqual(f.wakes, ['wake'], 'idle replay must not trigger a new call');
  await f.manager.stopping;
});

test('changing the phrase during a call replaces only the listener and ignores stale detections', async t => {
  const f = fixture(t); f.manager.configure(enabledConfig);
  await until(() => f.children.length === 1);
  const old = f.children[0]; old.ready();
  f.manager.setCallState({ state: 'active', microphone_muted: true });
  f.manager.configure({ ...enabledConfig, phrase: 'Hello Dot' });
  f.manager.configure({ ...enabledConfig, phrase: 'Computer' });
  old.wake();
  await until(() => f.children.length === 2);
  const replacement = f.children[1];
  assert.equal(replacement.args[replacement.args.indexOf('--phrase') + 1], 'Computer');
  replacement.ready(); replacement.wake(); old.wake();
  assert.equal(f.manager.status, 'listening');
  assert.equal(f.manager.paused, false);
  assert.deepEqual(f.wakes, ['wake']);
  assert.equal(f.children.length, 2);
});
