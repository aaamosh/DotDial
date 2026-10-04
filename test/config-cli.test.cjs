'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const PRODUCT_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PRODUCT_ROOT, 'bin', 'dotdial.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-cli-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, 'config-home'),
    XDG_STATE_HOME: path.join(root, 'state-home'),
    XDG_DATA_HOME: path.join(root, 'data-home'),
    XDG_CACHE_HOME: path.join(root, 'cache-home'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime-home'),
  };
  return { root, env, configFile: path.join(env.XDG_CONFIG_HOME, 'dotdial', 'config.json') };
}

function execute(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('config CLI shows defaults and writes only after explicit set', async t => {
  const { env, configFile } = setup(t);
  const shown = await execute(['config', 'show'], env);
  assert.equal(shown.code, 0, shown.stderr);
  const snapshot = JSON.parse(shown.stdout);
  assert.equal(snapshot.hash, null);
  assert.equal(snapshot.config.dot.displayName, 'My dot');
  assert.equal(fs.existsSync(configFile), false);

  const set = await execute(['config', 'set', 'dot.displayName', '"Desk dot"'], env);
  assert.equal(set.code, 0, set.stderr);
  const saved = JSON.parse(set.stdout);
  assert.equal(typeof saved.hash, 'string');
  assert.equal(fs.existsSync(configFile), true);
  assert.equal(fs.existsSync(path.join(env.XDG_RUNTIME_DIR, 'dotdial', 'dotdial.sock')), false);

  const validate = await execute(['config', 'validate'], env);
  assert.equal(validate.code, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).valid, true);
});

test('config CLI applies compare-and-swap and rejects unknown setting paths', async t => {
  const { env } = setup(t);
  const first = await execute(['config', 'show'], env);
  const hash = JSON.parse(first.stdout).hash;
  assert.equal(hash, null);
  const initial = await execute(['config', 'set', 'audio.soundVolume', '0.7', '--if-hash', 'null'], env);
  assert.equal(initial.code, 0, initial.stderr);
  const newHash = JSON.parse(initial.stdout).hash;
  const stale = await execute(['config', 'set', 'audio.soundVolume', '0.8', '--if-hash', 'null'], env);
  assert.notEqual(stale.code, 0);
  assert.equal(JSON.parse(stale.stderr).error.code, 'DOTDIAL_CONFIG_CONFLICT');
  const unknown = await execute(['config', 'set', 'dot.accountId', '"private"'], env);
  assert.notEqual(unknown.code, 0);
  assert.equal(JSON.parse(unknown.stderr).error.code, 'DOTDIAL_CONFIG_UNKNOWN_FIELD');
  const current = JSON.parse((await execute(['config', 'show'], env)).stdout);
  assert.equal(current.hash, newHash);
  assert.equal(current.config.audio.soundVolume, 0.7);
});

test('local call-control CLI sends bounded verbs over the Unix socket', async t => {
  const { env } = setup(t);
  const socketPath = path.join(env.XDG_RUNTIME_DIR, 'dotdial', 'dotdial.sock');
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const received = [];
  const server = net.createServer(client => {
    let data = '';
    client.on('data', chunk => {
      data += chunk.toString('utf8');
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      const command = data.slice(0, newline);
      received.push(command);
      client.end(`${JSON.stringify(command === 'STATUS'
        ? { state: 'active', microphone_muted: true }
        : { status: 'accepted_test_command' })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const status = await execute(['status'], env);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), { state: 'active', microphone_muted: true });
  const call = await execute(['call'], env);
  assert.equal(call.code, 0, call.stderr);
  assert.deepEqual(received, ['STATUS', 'WAKE']);
});

test('live controls reject a custom config instead of targeting the default socket', async t => {
  const { env, root } = setup(t);
  const customConfig = path.join(root, 'other-config.json');
  const result = await execute(['call', '--config', customConfig], env);

  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stderr).error.code, 'DOTDIAL_ARGUMENT_INVALID');
  assert.match(JSON.parse(result.stderr).error.message, /controls always target the default running instance/u);
  assert.equal(fs.existsSync(path.join(env.XDG_RUNTIME_DIR, 'dotdial', 'dotdial.sock')), false);
});

test('doctor is a local-only report and does not contact the running agent', async t => {
  const { env } = setup(t);
  const report = await execute(['doctor'], env);
  const value = JSON.parse(report.stdout);
  assert.equal(report.code, value.ok ? 0 : 1);
  assert.equal(value.checks.platformLinux, process.platform === 'linux');
  assert.equal(value.checks.config, true);
  assert.equal(value.checks.wakeWordPython, null);
  assert.equal(fs.existsSync(path.join(env.XDG_RUNTIME_DIR, 'dotdial', 'dotdial.sock')), false);
});

test('doctor validates the model directory and uses the same local Python as wake', async t => {
  const { root, env, configFile } = setup(t);
  const dataDir = path.join(env.XDG_DATA_HOME, 'dotdial');
  const python = path.join(dataDir, 'wake-venv', 'bin', 'python');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, '#!/bin/sh\nexit 89\n', { mode: 0o755 });
  const model = path.join(root, 'custom-model');
  fs.mkdirSync(model);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ wakeWord: { enabled: true, modelPath: model } }));
  const read = async () => JSON.parse((await execute(['doctor'], env)).stdout);
  let result = await read();
  assert.equal(result.checks.wakeWordModel, false, 'an empty directory is not a ready model');
  for (const name of ['tokens.txt', 'bpe.model',
    'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx']) fs.writeFileSync(path.join(model, name), 'fixture');
  result = await read();
  assert.equal(result.checks.wakeWordModel, true);
  assert.equal(result.checks.wakeWordPython, true);
  assert.equal(result.paths.wakePython, python);
  assert.equal(result.paths.wakeModel, model);
  fs.writeFileSync(path.join(model, 'bpe.model'), '');
  assert.equal((await read()).checks.wakeWordModel, false, 'an incomplete install cannot pass');
  fs.rmSync(model, { recursive: true });
  fs.writeFileSync(model, 'a text file is not a wake model');
  assert.equal((await read()).checks.wakeWordModel, false);
});

test('doctor checks the default downloaded model instead of skipping an empty modelPath', async t => {
  const { env, configFile } = setup(t);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ wakeWord: { enabled: true } }));
  const result = JSON.parse((await execute(['doctor'], env)).stdout);
  assert.equal(result.checks.wakeWordModel, false);
  assert.equal(result.paths.wakeModel, path.join(env.XDG_DATA_HOME, 'dotdial', 'models', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'));
});
