'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWakeRuntime, pythonCandidates, checkPython, findWakePython } = require('../src/wake_runtime.cjs');
const paths = { dataDir: '/Users/example/Library/Application Support/DotDial/data' };

test('mac wake runtime discovers installed Homebrew Python without a GUI shell PATH or executing it', () => {
  const installed = new Set(['/opt/homebrew/opt/python@3.12/bin/python3.12', '/usr/bin/python3']);
  const options = { platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, existsSync: file => installed.has(file) };
  const result = resolveWakeRuntime({ pythonPath: 'python3' }, paths, options);
  assert.equal(result.python, '/opt/homebrew/opt/python@3.12/bin/python3.12');
  assert.ok(!pythonCandidates({}, paths, options).includes('/usr/bin/python3'));
  assert.match(result.model, /data\/models\/sherpa-onnx-kws-/);
});

test('macOS uses the private wake environment after setup and an explicit Python for creating it', () => {
  const options = { platform: 'darwin', env: {}, existsSync: () => true };
  assert.equal(resolveWakeRuntime({ pythonPath: '/custom/python' }, paths, options).python, paths.dataDir + '/wake-venv/bin/python');
  assert.equal(resolveWakeRuntime({ pythonPath: '/custom/python' }, paths, { ...options, forSetup: true }).python, '/custom/python');
  assert.equal(resolveWakeRuntime({ pythonPath: '/custom/python' }, paths, { ...options, existsSync: () => false }).python, '/custom/python');
  assert.equal(resolveWakeRuntime({ modelPath: '/custom/model' }, paths, options).model, '/custom/model');
  assert.equal(resolveWakeRuntime({}, paths, options).python, paths.dataDir + '/wake-venv/bin/python');
});

test('Linux keeps its existing explicit interpreter override and private environment priority', () => {
  assert.equal(resolveWakeRuntime({ pythonPath: '/custom/python' }, paths, { platform: 'linux', existsSync: () => true }).python, '/custom/python');
  assert.equal(resolveWakeRuntime({}, paths, { platform: 'linux', existsSync: () => true }).python, paths.dataDir + '/wake-venv/bin/python');
  assert.equal(resolveWakeRuntime({}, paths, { platform: 'linux', existsSync: () => false }).python, 'python3');
});

test('Python version probe is bounded and rejects unavailable, malformed and unsupported runtimes', async () => {
  for (const minor of [10, 11, 12, 13]) {
    const result = await checkPython('/synthetic/python', { execFile(file, args, options, callback) {
      assert.equal(file, '/synthetic/python');
      assert.equal(args[0], '-c');
      assert.equal(options.timeout, 2500); assert.equal(options.maxBuffer, 4096);
      callback(null, JSON.stringify([3, minor, 1]));
    } });
    assert.deepEqual(result.version, [3, minor, 1]);
  }
  for (const minor of [9, 14]) await assert.rejects(checkPython('/synthetic/python', {
    execFile(_f, _a, _o, callback) { callback(null, JSON.stringify([3, minor, 0])); },
  }), { code: 'wake_python_version_unsupported' });
  for (const malformed of ['', 'Python 3.12.1', '{"token":"not a version"}']) await assert.rejects(checkPython('/synthetic/python', {
    execFile(_f, _a, _o, callback) { callback(null, malformed); },
  }), { code: 'wake_python_unavailable' });
});

test('default mac discovery tests candidates and falls back instead of using an incompatible Python', async () => {
  const calls = [];
  const options = { platform: 'darwin', env: { PATH: '/synthetic' },
    existsSync: file => ['/synthetic/python3.13', '/synthetic/python3.12'].includes(file),
    execFile(file, _args, _options, callback) {
      calls.push(file); callback(null, JSON.stringify([3, file.endsWith('13') ? 14 : 12, 0]));
    },
  };
  assert.equal(await findWakePython({}, paths, options), '/synthetic/python3.12');
  assert.deepEqual(calls, ['/synthetic/python3.13', '/synthetic/python3.12']);
});
