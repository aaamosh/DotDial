'use strict';

// QA only. Keep a live session leader between Electron exit and final cleanup,
// so its process-group number cannot be recycled while we signal that group.
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function processGroups() {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
    encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw Error('Cannot parse POSIX process-group census');
    return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3] };
  });
}

function groupOwner({ process: ownerProcess = process, spawn: start = spawn, setTimeout: later = setTimeout } = {}) {
  if (!ownerProcess.send) throw Error('The group owner requires a supervising IPC parent');
  let child, disconnected = false;
  const safeSend = message => {
    if (!ownerProcess.connected) return;
    // The parent may die after connected was checked. A callback consumes the
    // resulting IPC error instead of terminating our independent KILL timer.
    try { ownerProcess.send(message, () => {}); } catch {}
  };
  // TERM is sent to the entire group. The owner must retain its identity until
  // the supervisor releases it or sends the final group KILL.
  ownerProcess.on('SIGTERM', () => {});
  ownerProcess.on('SIGINT', () => {});
  ownerProcess.on('disconnect', () => {
    if (disconnected) return;
    disconnected = true;
    // Parent crash: the leader is still alive, so this PGID still belongs to us.
    // CONT lets a deliberately stopped Python consume TERM before escalation.
    ownerProcess.kill(-ownerProcess.pid, 'SIGTERM');
    ownerProcess.kill(-ownerProcess.pid, 'SIGCONT');
    later(() => ownerProcess.kill(-ownerProcess.pid, 'SIGKILL'), 2000);
  });
  ownerProcess.on('message', message => {
    if (message.type === 'release') ownerProcess.exit(0);
    if (message.type !== 'run' || child) return;
    child = start(message.file, message.args, {
      cwd: message.cwd, env: message.env, detached: false, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', error => safeSend({ type: 'child-error', message: error.message }));
    child.on('exit', (code, signal) => safeSend({ type: 'child-exit', code, signal }));
  });
  safeSend({ type: 'ready', pid: ownerProcess.pid });
}

async function runPosixSmoke(file, args, options = {}, dependencies = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw Error('POSIX smoke supervision requires macOS or Linux');
  const { timeout = 180_000, graceMs = 2000, exitGraceMs = 500, killWaitMs = 2000,
    maxBuffer = 4 * 1024 * 1024, env = process.env, cwd } = options;
  const start = dependencies.spawn || spawn;
  const census = dependencies.processGroups || processGroups;
  const signal = dependencies.signal || ((pid, name) => process.kill(pid, name));
  const ownerEnv = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete ownerEnv[key];
  const owner = start(process.execPath, [__filename], {
    detached: true, env: ownerEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '', stderr = '', bytes = 0, ownerExited = false, ownerClosed = false, released = false;
  let verified = false, failure, childResult, wake;
  const evidence = { processGroup: owner.pid, forcedCleanup: false, signals: [], killedPids: [], survivingPids: [] };
  const notify = () => { wake?.(); wake = undefined; };
  const fail = error => { failure ||= error; notify(); };
  const wait = ms => new Promise(resolve => {
    const timer = setTimeout(() => { if (wake === resume) wake = undefined; resolve(); }, ms);
    const resume = () => { clearTimeout(timer); resolve(); };
    wake = resume;
  });
  for (const [stream, name] of [[owner.stdout, 'stdout'], [owner.stderr, 'stderr']]) {
    stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBuffer) { fail(Error('POSIX smoke output limit exceeded')); return; }
      if (name === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    });
  }
  owner.on('error', fail);
  owner.on('exit', () => {
    ownerExited = true;
    if (!released) fail(Error('POSIX smoke group owner exited unexpectedly'));
    notify();
  });
  owner.on('close', () => { ownerClosed = true; notify(); });
  owner.on('message', message => {
    if (message.type === 'ready') {
      if (message.pid !== owner.pid) fail(Error('POSIX smoke owner PID mismatch'));
      else evidence.ready = true;
    }
    if (message.type === 'child-exit') childResult = { status: message.code, signal: message.signal };
    if (message.type === 'child-error') fail(Error(message.message));
    notify();
  });
  const interrupted = name => fail(Error(`POSIX smoke interrupted by ${name}`));
  const onInt = () => interrupted('SIGINT'), onTerm = () => interrupted('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const deadline = setTimeout(() => fail(Error(`POSIX smoke exceeded ${timeout} ms`)), timeout);
  const members = async () => (await census()).filter(item => item.pgid === owner.pid && item.pid !== owner.pid && !item.state.startsWith('Z'));
  const signalGroup = name => {
    // Never signal after release/observed leader exit: its number could then be
    // reused. The live, verified owner reserves the group throughout cleanup.
    if (!verified || released || ownerExited) throw Error('Lost POSIX smoke group ownership');
    signal(-owner.pid, name);
    evidence.signals.push(name);
  };
  const drain = async ms => {
    const end = Date.now() + ms;
    let remaining;
    do {
      remaining = await members();
      if (!remaining.length) return remaining;
      await sleep(Math.min(50, Math.max(0, end - Date.now())));
    } while (Date.now() < end);
    return remaining;
  };
  try {
    while (!evidence.ready && !failure) await wait(50);
    if (failure) throw failure;
    const table = await census();
    if (!table.some(item => item.pid === owner.pid && item.pgid === owner.pid && !item.state.startsWith('Z'))) {
      throw Error('Cannot verify detached POSIX smoke group in this PID namespace');
    }
    verified = true;
    if (failure) throw failure;
    owner.send({ type: 'run', file, args, env, cwd });
    while (!childResult && !failure) await wait(50);
    if (failure) throw failure;
    if (childResult.status !== 0) throw Error(`POSIX smoke exited (${childResult.status ?? childResult.signal})`);
  } catch (error) {
    fail(error);
  } finally {
    clearTimeout(deadline);
    try {
      if (verified && !ownerExited) {
        let remaining;
        try { remaining = await drain(failure ? 0 : exitGraceMs); }
        catch (error) { fail(error); remaining = null; }
        if (remaining === null || remaining.length) {
          evidence.forcedCleanup = true;
          fail(Error('POSIX smoke left running processes after exit'));
          signalGroup('SIGTERM');
          signalGroup('SIGCONT');
          try { remaining = await drain(graceMs); }
          catch (error) { fail(error); remaining = null; }
          if (remaining === null || remaining.length) {
            evidence.killedPids = remaining?.map(item => item.pid) || [];
            signalGroup('SIGKILL');
            // KILL also ends the owner. Never signal this group number again.
            released = true;
          }
        }
      }
      if (!ownerExited && !released) { released = true; owner.send({ type: 'release' }); }
      const end = Date.now() + killWaitMs;
      while (!ownerClosed && Date.now() < end) await wait(25);
      if (!ownerExited) fail(Error('POSIX smoke owner did not exit after cleanup'));
      if (!ownerClosed) fail(Error('POSIX smoke output pipes did not close; a process may have escaped the owned group'));
      if (evidence.signals.includes('SIGKILL')) {
        // Observation only after owner exit; no signal may use this PGID again.
        // Ignore zombies, which are already dead and await their OS reaper.
        evidence.survivingPids = (await drain(killWaitMs)).map(item => item.pid);
        if (evidence.survivingPids.length) fail(Error('POSIX smoke group survived SIGKILL'));
      }
    } catch (error) {
      fail(error);
      // Closing IPC invokes the owner's independent TERM/CONT/KILL failsafe.
      if (owner.connected) owner.disconnect();
    }
    owner.stdout.destroy(); owner.stderr.destroy();
    owner.unref();
    if (owner.connected) owner.disconnect();
    evidence.ownerExited = ownerExited;
    evidence.outputClosed = ownerClosed;
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  }
  if (failure) {
    failure.message += `\n${stdout}\n${stderr}`;
    failure.supervision = evidence;
    throw failure;
  }
  return { ...childResult, stdout, stderr, supervision: evidence };
}

if (require.main === module) groupOwner();
module.exports = { runPosixSmoke, processGroups, groupOwner };
