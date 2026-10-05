'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { runPosixSmoke, processGroups, groupOwner } = require('../scripts/posix-smoke-supervisor.cjs');

test('keeper retains independent KILL escalation when reports race parent IPC closure', () => {
  const owner = new EventEmitter(), child = new EventEmitter(), signals = [], timers = [];
  let sends = 0;
  Object.assign(owner, {
    pid: 45678, connected: true,
    send: (_message, callback) => {
      sends++;
      assert.equal(typeof callback, 'function', 'IPC errors must be consumed with a callback');
      callback(Object.assign(Error('synthetic closed channel race'), { code: 'ERR_IPC_CHANNEL_CLOSED' }));
    },
    kill: (pid, signal) => { assert.equal(pid, -owner.pid); signals.push(signal); },
  });
  groupOwner({ process: owner, spawn: () => child, setTimeout: (callback, ms) => timers.push({ callback, ms }) });
  owner.emit('message', { type: 'run', file: 'unused', args: [], env: {} });
  child.emit('exit', 1, null); // Connected check races a closed-channel callback.
  owner.connected = false;
  owner.emit('disconnect');
  child.emit('error', Error('late child error after parent exit'));
  child.emit('exit', 1, null);
  assert.equal(sends, 2, 'late child reports are discarded after disconnect');
  assert.deepEqual(signals, ['SIGTERM', 'SIGCONT']);
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 2000);
  timers[0].callback();
  assert.deepEqual(signals, ['SIGTERM', 'SIGCONT', 'SIGKILL']);
});

function fixture({ mismatch = false, orphan = false, stubborn = false, timeout = false, crash = false, pipesOpen = false } = {}) {
  const owner = new EventEmitter();
  Object.assign(owner, { pid: 45678, connected: true, stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  const signals = [], messages = [];
  let present = true, members = [], pendingTerm = false;
  const exit = () => {
    present = false;
    owner.emit('exit', 0, null);
    if (!pipesOpen) { owner.stdout.end(); owner.stderr.end(); owner.emit('close'); }
  };
  owner.send = message => {
    messages.push(message.type);
    if (message.type === 'release') queueMicrotask(exit);
    if (message.type === 'run') queueMicrotask(() => {
      if (orphan || timeout) members = [{ pid: 45679, pgid: owner.pid, state: 'T' }];
      if (crash) exit();
      else if (!timeout) owner.emit('message', { type: 'child-exit', code: 0, signal: null });
    });
  };
  owner.disconnect = () => { owner.connected = false; };
  const dependencies = {
    spawn: (_file, _args, options) => {
      assert.equal(options.detached, true);
      queueMicrotask(() => owner.emit('message', { type: 'ready', pid: owner.pid }));
      return owner;
    },
    processGroups: async () => [
      ...(present && !mismatch ? [{ pid: owner.pid, pgid: owner.pid, state: 'S' }] : []), ...members,
    ],
    signal: (pid, name) => {
      assert.equal(pid, -owner.pid);
      assert.equal(present, true, 'only signal while the owner still reserves the group ID');
      signals.push(name);
      if (name === 'SIGTERM') pendingTerm = true;
      if (name === 'SIGCONT' && pendingTerm && !stubborn) members = [];
      if (name === 'SIGKILL') { members = []; queueMicrotask(exit); }
    },
  };
  return { dependencies, signals, messages };
}

const fast = { timeout: 30, graceMs: 10, exitGraceMs: 0, killWaitMs: 20 };

test('POSIX owner is verified before any payload can run', async () => {
  const fake = fixture({ mismatch: true });
  await assert.rejects(runPosixSmoke('unused', [], fast, fake.dependencies), /PID namespace/);
  assert.deepEqual(fake.messages, ['release']);
  assert.deepEqual(fake.signals, []);
});

test('a clean payload releases the live owner without group signals', async () => {
  const fake = fixture();
  const result = await runPosixSmoke('unused', [], fast, fake.dependencies);
  assert.equal(result.status, 0);
  assert.equal(result.supervision.forcedCleanup, false);
  assert.deepEqual(fake.messages, ['run', 'release']);
  assert.deepEqual(fake.signals, []);
});

test('successful payload exit with a stopped descendant is failed and resumed for TERM', async () => {
  const fake = fixture({ orphan: true });
  await assert.rejects(runPosixSmoke('unused', [], fast, fake.dependencies), error => {
    assert.equal(error.supervision.forcedCleanup, true);
    assert.deepEqual(error.supervision.survivingPids, []);
    return /left running processes/.test(error.message);
  });
  assert.deepEqual(fake.signals, ['SIGTERM', 'SIGCONT']);
});

test('deadline escalates a stopped, TERM-resistant descendant to bounded group KILL', async () => {
  const fake = fixture({ timeout: true, stubborn: true });
  const started = Date.now();
  await assert.rejects(runPosixSmoke('unused', [], fast, fake.dependencies), error => {
    assert.deepEqual(error.supervision.killedPids, [45679]);
    assert.deepEqual(error.supervision.survivingPids, []);
    return /exceeded/.test(error.message);
  });
  assert.deepEqual(fake.signals, ['SIGTERM', 'SIGCONT', 'SIGKILL']);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(fake.messages, ['run'], 'never release or signal a group after KILL ends its owner');
});

test('unexpected owner exit never signals a potentially recycled group number', async () => {
  const fake = fixture({ crash: true });
  await assert.rejects(runPosixSmoke('unused', [], fast, fake.dependencies), /owner exited unexpectedly/);
  assert.deepEqual(fake.signals, []);
});

test('owner exit cannot pass while another process keeps output pipes open', async () => {
  const fake = fixture({ pipesOpen: true });
  await assert.rejects(runPosixSmoke('unused', [], fast, fake.dependencies), error => {
    assert.equal(error.supervision.ownerExited, true);
    assert.equal(error.supervision.outputClosed, false);
    return /output pipes did not close/.test(error.message);
  });
  assert.deepEqual(fake.signals, [], 'a released group number is never signalled');
});

async function nativeNamespace(t) {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('POSIX-only fixture'); return false; }
  if (process.platform === 'linux' && Number(fs.readFileSync('/proc/self/stat', 'utf8').split(' ', 1)[0]) !== process.pid) {
    t.skip('The executor exposes procfs from a different PID namespace; cannot safely prove group ownership');
    return false;
  }
  const table = await processGroups();
  if (!table.some(item => item.pid === process.pid)) {
    t.skip('The executor exposes ps from a different PID namespace; cannot safely prove group ownership');
    return false;
  }
  return true;
}

async function assertGroupGone(pgid) {
  const table = await processGroups();
  assert.deepEqual(table.filter(item => item.pgid === pgid && !item.state.startsWith('Z')), []);
}

test('real POSIX clean process exits without forced group cleanup', { timeout: 10_000 }, async t => {
  if (!await nativeNamespace(t)) return;
  const result = await runPosixSmoke(process.execPath, ['-e', 'console.log("fixture_clean")'], { timeout: 5000 });
  assert.match(result.stdout, /fixture_clean/);
  assert.equal(result.supervision.forcedCleanup, false);
  await assertGroupGone(result.supervision.processGroup);
});

function stoppedChildProgram({ crash = false, stubborn = false } = {}) {
  const childProgram = `${stubborn ? "process.on('SIGTERM',()=>{});" : ''}
    process.send('ready'); setInterval(()=>{},1000);`;
  return `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],
      {stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>{
      process.kill(child.pid,'SIGSTOP');
      console.log('fixture_stopped='+child.pid);
      ${crash ? "process.kill(process.pid,'SIGKILL');" : 'setInterval(()=>{},1000);'}
    });`;
}

test('real crashed payload leaves a stopped child that receives TERM and CONT', { timeout: 10_000 }, async t => {
  if (!await nativeNamespace(t)) return;
  let failure;
  await assert.rejects(runPosixSmoke(process.execPath, ['-e', stoppedChildProgram({ crash: true })],
    { timeout: 5000, graceMs: 500 }), error => { failure = error; return /SIGKILL/.test(error.message); });
  assert.match(failure.message, /fixture_stopped=/, 'the descendant really reached SIGSTOP');
  assert.equal(failure.supervision.forcedCleanup, true);
  assert.deepEqual(failure.supervision.signals, ['SIGTERM', 'SIGCONT']);
  await assertGroupGone(failure.supervision.processGroup);
});

test('real deadline kills a stopped TERM-resistant descendant and its parent', { timeout: 10_000 }, async t => {
  if (!await nativeNamespace(t)) return;
  let failure;
  const started = Date.now();
  await assert.rejects(runPosixSmoke(process.execPath, ['-e', stoppedChildProgram({ stubborn: true })],
    { timeout: 1500, graceMs: 150 }), error => { failure = error; return /exceeded/.test(error.message); });
  assert.match(failure.message, /fixture_stopped=/, 'timeout must happen after the fixture reached SIGSTOP');
  assert.deepEqual(failure.supervision.signals, ['SIGTERM', 'SIGCONT', 'SIGKILL']);
  assert.deepEqual(failure.supervision.survivingPids, []);
  assert.ok(Date.now() - started < 7000, 'TERM handlers cannot defeat the deadline');
  await assertGroupGone(failure.supervision.processGroup);
});
