#!/usr/bin/env node
'use strict';

// Native decoder -> WakeManager -> VoiceCommands acceptance. Synthetic speech
// replaces microphone acquisition; dispatch uses an isolated call-state fixture.
// Actual Electron capture and real-account calls are separate acceptance scopes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pcmFromWav(bytes) {
  assert.ok(bytes.length >= 44 && bytes.length <= 16000 * 15 * 2 + 65536, 'bounded speech WAV');
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, 'complete RIFF payload');
  let fmt, data;
  let offset = 12;
  for (; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= bytes.length, 'complete WAV chunk');
    const chunk = bytes.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') { assert.equal(fmt, undefined); fmt = chunk; }
    if (id === 'data') { assert.equal(data, undefined); data = chunk; }
    offset += 8 + size + (size % 2);
  }
  assert.equal(offset, bytes.length, 'no truncated trailing WAV chunk');
  assert.ok(fmt && fmt.length >= 16 && data, 'WAV format and samples are present');
  assert.equal(fmt.readUInt16LE(0), 1); assert.equal(fmt.readUInt16LE(2), 1);
  assert.equal(fmt.readUInt32LE(4), 16000); assert.equal(fmt.readUInt32LE(8), 32000);
  assert.equal(fmt.readUInt16LE(12), 2);
  assert.equal(fmt.readUInt16LE(14), 16);
  assert.ok(data.length >= 3200 && data.length <= 16000 * 15 * 2 && data.length % 2 === 0);
  // Same half-second context at each end as native wake speech acceptance.
  const pcm = Buffer.alloc((data.length / 2 + 16000) * 4);
  let peak = 0;
  for (let offset = 0; offset < data.length; offset += 2) {
    const value = data.readInt16LE(offset) / 32768;
    peak = Math.max(peak, Math.abs(value)); pcm.writeFloatLE(value, 32000 + offset * 2);
  }
  assert.ok(peak >= 0.001, 'speech must not be silent');
  return pcm;
}

function verifyEvents(stdout, expected) {
  assert.ok(Buffer.byteLength(stdout) <= 65536, 'bounded recognizer output');
  const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(events, [{ event: 'ready' }, ...expected], 'exact recognition, without extra commands or wake events');
  return events;
}

function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function smoke({ source, data, fixtures, output }, report) {
  assert.equal(process.platform, 'darwin', 'native macOS is mandatory');
  assert.ok(['arm64', 'x64'].includes(process.arch));
  const { defaults, validateConfig } = require(path.join(source, 'src/config.cjs'));
  const { WakeManager } = require(path.join(source, 'src/wake-manager.cjs'));
  const { VoiceCommands, VOICE_COMMANDS } = require(path.join(source, 'src/voice_commands.cjs'));
  const { MODEL } = require(path.join(source, 'src/wake-runtime.cjs'));
  const manifest = JSON.parse(fs.readFileSync(path.join(source, '..', 'dotdial-build.json'), 'utf8'));
  assert.equal(manifest.sourceDirty, false); assert.equal(manifest.architecture, process.arch);
  assert.equal(defaults.wakeWord.commandsEnabled, false, 'upgrade does not opt users into commands');
  const commands = defaults.wakeWord.commands;
  assert.deepEqual(Object.keys(commands).sort(), Object.keys(VOICE_COMMANDS).sort());
  assert.equal(Object.keys(commands).length, 7);
  const preparation = JSON.parse(fs.readFileSync(path.join(fixtures, 'provenance.json'), 'utf8'));
  assert.equal(preparation.prepareWakeSpeech, 'passed');
  assert.equal(preparation.sourceCommit, '6c9f20dc915b17f5619340069889db0aa007fcdc');
  assert.equal(preparation.hostPlatform, 'darwin');
  assert.equal(preparation.hostMachine, process.arch === 'x64' ? 'x86_64' : 'arm64');
  assert.equal(hash(fs.readFileSync(preparation.binary)), preparation.binarySha256);
  const python = path.join(data, 'wake-venv/bin/python');
  const runtime = JSON.parse(run(python, ['-I', '-c', 'import json,sys,platform; print(json.dumps(dict(platform=sys.platform,machine=platform.machine(),prefix=sys.prefix)))']));
  assert.equal(runtime.platform, 'darwin'); assert.equal(runtime.machine, preparation.hostMachine);
  assert.equal(fs.realpathSync(runtime.prefix), fs.realpathSync(path.join(data, 'wake-venv')));
  Object.assign(report, { sourceCommit: manifest.sourceCommit, version: manifest.version, sourceRoot: source,
    hostPlatform: process.platform, hostArch: process.arch, runtime, commands, generatorSha256: preparation.binarySha256 });
  const generated = path.join(path.dirname(output), 'voice-fixtures');
  fs.mkdirSync(generated, { recursive: true });
  const pcms = new Map();
  function speech(text) {
    if (pcms.has(text)) return pcms.get(text);
    const filename = path.join(generated, `${hash(text).slice(0, 16)}.wav`);
    assert.equal(fs.existsSync(filename), false, 'generated fixtures must be fresh');
    run(preparation.binary, ['-voice', 'slt', '-t', text + '.', '-o', filename]);
    const bytes = fs.readFileSync(filename), pcm = pcmFromWav(bytes);
    report.fixtures.push({ text, file: path.basename(filename), wavSha256: hash(bytes), pcmSha256: hash(pcm), pcmBytes: pcm.length });
    pcms.set(text, pcm); return pcm;
  }
  const custom = { ...commands, microphoneOff: 'Disable microphone' };
  validateConfig({ ...defaults, wakeWord: { ...defaults.wakeWord, commands: custom } });
  const cases = Object.keys(commands).map(action => ({ name: action, text: commands[action], action }));
  cases.push({ name: 'wake_with_commands', text: defaults.wakeWord.phrase, wake: true },
    { name: 'unrelated_speech', text: 'The weather is calm today' },
    { name: 'commands_disabled', text: commands.microphoneOff, enabled: false },
    { name: 'custom_phrase', text: custom.microphoneOff, action: 'microphoneOff', commands: custom },
    { name: 'old_phrase_removed', text: commands.microphoneOff, commands: custom });
  for (const spec of cases) {
    const pcm = speech(spec.text), item = { name: spec.name, result: 'failed' };
    report.cases.push(item);
    let child, capture, manager, stdout = '', childError, exited = false;
    const state = { state: 'active', missed_playing: spec.action === 'stopPlayback' }, identity = {};
    const dispatched = [], handled = [], handlerErrors = [];
    let wakes = 0, closed = false;
    const router = new VoiceCommands({ getState: () => state, getCallIdentity: () => identity,
      dispatch: async verb => { dispatched.push(verb); return { status: 'accepted' }; } });
    async function until(predicate, label) {
      const end = performance.now() + 35000;
      while (!predicate()) {
        if (childError) throw childError;
        if (performance.now() >= end) throw Error(label);
        await sleep(10);
      }
    }
    try {
      manager = new WakeManager({ paths: { dataDir: data }, platform: 'darwin',
        requestMicrophoneAccess: async () => true,
        captureFactory: callbacks => { capture = callbacks; return { ready: Promise.resolve(), close: async () => { closed = true; } }; },
        spawn(file, args, options) {
          assert.equal(fs.realpathSync(file), fs.realpathSync(python));
          assert.ok(args.includes('--stdin-audio')); assert.ok(!args.includes('--test-file'));
          child = spawn(file, args, options);
          child.stdout.on('data', bytes => { stdout += bytes.toString(); if (stdout.length > 65536) { childError = Error('stdout_limit'); child.kill('SIGKILL'); } });
          child.once('error', error => { childError = error; });
          child.once('close', () => { exited = true; });
          return child;
        },
        onWake: () => { wakes++; },
        onCommand: action => { handled.push(router.handle(action).catch(error => { handlerErrors.push(error.message); })); },
      });
      manager.setCallState(state);
      manager.configure({ ...defaults.wakeWord, enabled: true, commandsEnabled: spec.enabled !== false,
        commands: spec.commands || commands, modelPath: path.join(data, 'models', MODEL), pythonPath: python });
      await until(() => { if (manager.error) throw Error(manager.error); return manager.status === 'listening'; }, 'voice_start_timeout');
      for (let offset = 0; offset < pcm.length; offset += 6400) await capture.onAudio(pcm.subarray(offset, offset + 6400));
      child.stdin.end();
      await until(() => exited, 'voice_eof_timeout');
      await Promise.all(handled);
      assert.equal(child.exitCode, 0); assert.deepEqual(handlerErrors, []);
      item.events = verifyEvents(stdout, spec.action ? [{ event: 'command', command: spec.action }] : spec.wake ? [{ event: 'wake' }] : []);
      assert.deepEqual(dispatched, spec.action ? [VOICE_COMMANDS[spec.action]] : []);
      assert.equal(wakes, spec.wake ? 1 : 0);
      Object.assign(item, { result: 'passed', dispatched, wakes, eofExit: true });
    } finally {
      if (child && !exited) child.kill('SIGKILL');
      if (manager) await manager.close();
      if (child && !exited) await until(() => exited, 'voice_cleanup_timeout');
      assert.ok(!child || exited, 'native decoder must be reaped');
      assert.ok(!capture || closed, 'synthetic capture must be released');
      item.decoderReaped = exited; item.captureClosed = closed;
    }
  }
  report.nativeVoiceCommands = 'passed';
}

async function main() {
  const [source, data, fixtures, output] = process.argv.slice(2);
  assert.ok([source, data, fixtures, output].every(value => value && path.isAbsolute(value)), 'four absolute paths required');
  const report = { nativeVoiceCommands: 'failed', syntheticSpeech: true, physicalMicrophoneTested: false,
    electronCaptureTested: false, accountCallTested: false, dispatchTarget: 'isolated_state_fixture', fixtures: [], cases: [] };
  try { await smoke({ source, data, fixtures, output }, report); }
  catch (error) { report.error = String(error.stack || error).slice(-8000); process.exitCode = 1; }
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { pcmFromWav, verifyEvents };
