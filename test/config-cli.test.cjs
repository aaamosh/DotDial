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
