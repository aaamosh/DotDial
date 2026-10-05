'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { configLockCommand } = require('../src/config.cjs');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-config-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('config locks resolve a bundled or development native helper on macOS and util-linux on Linux', () => {
  assert.deepEqual(configLockCommand({ platform: 'linux', timeoutMs: 1500 }), {
    command: 'flock', args: ['-x', '-w', '1.5', '3'], timeoutExitCode: 1,
  });
  assert.deepEqual(configLockCommand({ platform: 'darwin', projectRoot: '/fixture/source', timeoutMs: 1500 }), {
    command: '/fixture/source/build/native/dotdial-lock', args: ['--timeout-ms', '1500'], timeoutExitCode: 75,
  });
  assert.deepEqual(configLockCommand({ platform: 'darwin', projectRoot: '/fixture/DotDial.app/Contents/Resources/app', timeoutMs: 0 }), {
    command: '/fixture/DotDial.app/Contents/Resources/dotdial-lock', args: ['--timeout-ms', '0'], timeoutExitCode: 75,
  });
  for (const timeoutMs of [-1, 0.5, NaN, 30001]) assert.throws(() => configLockCommand({ timeoutMs }), TypeError);
});

test('an acquired config lock survives helper exit and releases only after the parent descriptor closes', t => {
  const file = path.join(temporary(t), 'held.lock');
  let holder = fs.openSync(file, 'wx+', 0o600), contender;
  const spec = configLockCommand({ timeoutMs: 0 });
  const attempt = fd => spawnSync(spec.command, spec.args, {
    stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 3000,
  });
  try {
    const first = attempt(holder);
    assert.ifError(first.error);
    assert.equal(first.status, 0, first.stderr?.toString());
    contender = fs.openSync(file, 'r+');
    const blocked = attempt(contender);
    assert.ifError(blocked.error);
    assert.equal(blocked.status, spec.timeoutExitCode, 'an independently opened descriptor must still contend after the first helper exits');
    fs.closeSync(holder); holder = undefined;
    const released = attempt(contender);
    assert.ifError(released.error);
    assert.equal(released.status, 0, 'closing the final parent reference releases the kernel lock');
  } finally {
    if (holder !== undefined) fs.closeSync(holder);
    if (contender !== undefined) fs.closeSync(contender);
  }
});

function macConfigWithSpawn(spawn) {
  const moduleFile = path.resolve(__dirname, '../src/config.cjs');
  const source = fs.readFileSync(moduleFile, 'utf8');
  const module = { exports: {} };
  const runtime = Object.create(process);
  Object.defineProperty(runtime, 'platform', { value: 'darwin' });
  const imports = name => name === 'node:child_process' ? { spawnSync: spawn } : require(name);
  new Function('require', 'module', 'exports', '__dirname', 'process', source)(imports, module, module.exports, path.dirname(moduleFile), runtime);
  return module.exports;
}

test('missing or failing macOS lock helpers fail closed without saving or trying a fallback', t => {
  const directory = temporary(t);
  for (const [index, result] of [
    { error: Object.assign(new Error('missing executable'), { code: 'ENOENT' }) },
    { error: Object.assign(new Error('not executable'), { code: 'EACCES' }) },
    { status: 71 },
  ].entries()) {
    const attempts = [];
    const config = macConfigWithSpawn((command, args, options) => { attempts.push({ command, args, options }); return result; });
    const file = path.join(directory, `config-${index}.json`);
    assert.throws(() => config.saveConfig(file, config.validateConfig({}), { expectedHash: null }), { code: 'DOTDIAL_CONFIG_LOCK_UNAVAILABLE' });
    assert.equal(fs.existsSync(file), false);
    assert.equal(attempts.length, 1);
    assert.ok(path.isAbsolute(attempts[0].command));
    assert.equal(path.basename(attempts[0].command), 'dotdial-lock');
    assert.deepEqual(attempts[0].args, ['--timeout-ms', '2000']);
    assert.equal(typeof attempts[0].options.stdio[3], 'number');
  }
});

test('native lock contention remains a config-busy result and cannot overwrite an existing config', t => {
  const file = path.join(temporary(t), 'config.json');
  const original = '{"version":1}\n'; fs.writeFileSync(file, original, { mode: 0o600 });
  const config = macConfigWithSpawn(() => ({ status: 75 }));
  assert.throws(() => config.saveConfig(file, config.validateConfig({})), { code: 'DOTDIAL_CONFIG_BUSY' });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
