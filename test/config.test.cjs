'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  defaults,
  validateConfig,
  loadConfig,
  loadConfigSnapshot,
  saveConfig,
  getPaths,
} = require('../src/config.cjs');

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-config-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('defaults match the versioned DotDial settings contract', () => {
  assert.deepEqual(defaults, {
    version: 1,
    dot: { url: '', displayName: 'My dot', expectedEmail: '' },
    general: { startAtLogin: false, hotkey: process.platform === 'darwin' ? 'Command+Shift+Space' : 'CommandOrControl+Alt+Space' },
    audio: {
      bufferMs: 0, microphoneDeviceId: 'default', outputDeviceId: 'default', sounds: true,
      soundVolume: 0.55, microphoneInitiallyMuted: false, speakersInitiallyMuted: false,
      connectionSound: 'modem', customSoundPath: '',
    },
    wakeWord: { enabled: false, phrase: 'Hey Dot', sensitivity: 6, modelPath: '', pythonPath: 'python3', deviceName: '', deviceHostApi: '' },
    recording: { enabled: true, maxMegabytes: 200 },
    appearance: { theme: 'system', panelOpacity: 0.86, showPanel: true, language: 'en' },
    network: { signalingProxy: '', signalingLauncher: [], mediaLauncher: [] },
    call: { maxMinutes: 60 },
  });
  assert.deepEqual(validateConfig({}), defaults);
});

test('partial updates merge recursively and return an independent full config', () => {
  const config = validateConfig({ dot: { displayName: 'Study dot' }, audio: { soundVolume: 0.7 } });
  assert.equal(config.dot.url, '');
  assert.equal(config.dot.displayName, 'Study dot');
  assert.equal(config.audio.soundVolume, 0.7);
  assert.equal(config.audio.sounds, true);
  config.dot.displayName = 'changed';
  assert.equal(defaults.dot.displayName, 'My dot');
});

test('strict validation rejects unknown keys and invalid values with stable codes', () => {
  assert.throws(() => validateConfig({ extra: true }), { code: 'DOTDIAL_CONFIG_UNKNOWN_FIELD', field: 'extra' });
  assert.throws(() => validateConfig({ dot: { accountId: 'private' } }), {
    code: 'DOTDIAL_CONFIG_UNKNOWN_FIELD', field: 'dot.accountId',
  });
  for (const url of [
    'http://chatgpt.com/dots/12345678-1234-1234-1234-123456789abc',
    'https://chatgpt.com/dots/12345678-1234-1234-1234-123456789abc?x=1',
    'https://example.com/dots/12345678-1234-1234-1234-123456789abc',
  ]) {
    assert.throws(() => validateConfig({ dot: { url } }), { code: 'DOTDIAL_CONFIG_INVALID', field: 'dot.url' });
  }
  assert.throws(() => validateConfig({ audio: { soundVolume: 1.1 } }), {
    code: 'DOTDIAL_CONFIG_INVALID', field: 'audio.soundVolume',
  });
  assert.throws(() => validateConfig({ wakeWord: { sensitivity: 0 } }), {
    code: 'DOTDIAL_CONFIG_INVALID', field: 'wakeWord.sensitivity',
  });
  assert.throws(() => validateConfig({ recording: { maxMegabytes: 0 } }), {
    code: 'DOTDIAL_CONFIG_INVALID', field: 'recording.maxMegabytes',
  });
  assert.throws(() => validateConfig({ wakeWord: { deviceName: 'Desk microphone' } }), {
    code: 'DOTDIAL_CONFIG_INVALID', field: 'wakeWord.deviceName',
  });
  assert.throws(() => validateConfig({ wakeWord: { deviceHostApi: 'ALSA' } }), {
    code: 'DOTDIAL_CONFIG_INVALID', field: 'wakeWord.deviceName',
  });
  assert.equal(validateConfig({ wakeWord: { deviceName: 'Desk microphone', deviceHostApi: 'ALSA' } }).wakeWord.deviceHostApi, 'ALSA');
});

test('connection sounds default safely and custom sounds require a local MP3 or WAV path', () => {
  assert.equal(validateConfig({ audio: { sounds: true } }).audio.connectionSound, 'modem');
  assert.equal(validateConfig({ audio: { connectionSound: 'telephone' } }).audio.customSoundPath, '');
  for (const customSoundPath of ['/tmp/custom tone.WAV', '/tmp/custom.mp3']) {
    assert.equal(validateConfig({ audio: { connectionSound: 'custom', customSoundPath } }).audio.customSoundPath, customSoundPath);
  }
  for (const customSoundPath of ['', 'relative.wav', 'https://example.com/call.mp3', '/tmp/call.ogg', '/tmp/call.wav\n']) {
    assert.throws(() => validateConfig({ audio: { connectionSound: 'custom', customSoundPath } }), { field: 'audio.customSoundPath' });
  }
  assert.throws(() => validateConfig({ audio: { connectionSound: 'unknown' } }), { field: 'audio.connectionSound' });
});

test('proxy and launcher settings cannot carry recognized credentials', () => {
  assert.throws(() => validateConfig({ network: { signalingProxy: 'https://user:password@example.com:443' } }), {
    code: 'DOTDIAL_CONFIG_INVALID', field: 'network.signalingProxy',
  });
  assert.throws(() => validateConfig({ network: { signalingProxy: 'socks5://proxy.example/?token=secret' } }), {
    code: 'DOTDIAL_CONFIG_INVALID', field: 'network.signalingProxy',
  });
  assert.throws(() => validateConfig({ network: { signalingLauncher: ['vpn', '--api-key=abc123'] } }), {
    code: 'DOTDIAL_CONFIG_INVALID',
  });
});

test('XDG roots keep config, state, data, cache and runtime separate', t => {
  const root = tempDir(t);
  const paths = getPaths({
    home: root,
    env: {
      XDG_CONFIG_HOME: path.join(root, 'cfg'),
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_RUNTIME_DIR: path.join(root, 'run'),
    },
  });
  assert.equal(paths.configFile, path.join(root, 'cfg', 'dotdial', 'config.json'));
  assert.equal(paths.stateDir, path.join(root, 'state', 'dotdial'));
  assert.equal(paths.dataDir, path.join(root, 'data', 'dotdial'));
  assert.equal(paths.cacheDir, path.join(root, 'cache', 'dotdial'));
  assert.equal(paths.runtimeDir, path.join(root, 'run', 'dotdial'));
  assert.equal(paths.socketPath, path.join(root, 'run', 'dotdial', 'dotdial.sock'));
});

test('load and save use defaults, private modes, atomic bytes, and compare-and-swap hashes', t => {
  const directory = tempDir(t);
  const file = path.join(directory, 'config', 'config.json');
  const initial = loadConfigSnapshot(file);
  assert.equal(initial.hash, null);
  assert.deepEqual(initial.config, defaults);

  const saved = saveConfig(file, { dot: { displayName: 'Desk dot' } }, { expectedHash: null });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(saved.config.audio.sounds, true);
  assert.equal(saved.config.dot.displayName, 'Desk dot');
  assert.equal(saved.hash, loadConfigSnapshot(file).hash);
  assert.deepEqual(loadConfig(file), saved.config);
  const lockFile = `${file}.lock`;
  assert.equal(fs.statSync(lockFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).format, 2);
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')), false);

  assert.throws(() => saveConfig(file, defaults, { expectedHash: null }), {
    code: 'DOTDIAL_CONFIG_CONFLICT',
  });
  assert.throws(() => saveConfig(file, defaults, { expectedHash: '0'.repeat(64) }), {
    code: 'DOTDIAL_CONFIG_CONFLICT',
  });
  const next = saveConfig(file, { ...saved.config, dot: { ...saved.config.dot, displayName: 'Updated' } }, {
    expectedHash: saved.hash,
  });
  assert.notEqual(next.hash, saved.hash);
});

test('saving a custom config preserves an existing parent directory mode', t => {
  const root = tempDir(t);
  const directory = path.join(root, 'shared');
  fs.mkdirSync(directory, { mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  const file = path.join(directory, 'dotdial.json');

  saveConfig(file, defaults, { expectedHash: null });

  assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a stale malformed legacy lock is recovered but a live PID lock is preserved', t => {
  const directory = tempDir(t);
  const file = path.join(directory, 'config.json');
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);

  saveConfig(file, defaults, { expectedHash: null });
  assert.equal(loadConfigSnapshot(file).hash, saveConfig(file, defaults).hash);

  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60_000 }));
  fs.utimesSync(lock, old, old);
  assert.throws(() => saveConfig(file, defaults), { code: 'DOTDIAL_CONFIG_BUSY' });
  assert.equal(fs.existsSync(lock), true, 'an active owner is protected regardless of lock age');
});

test('concurrent config writer processes serialize saves without corrupting the file', async t => {
  const directory = tempDir(t);
  const file = path.join(directory, 'config.json');
  const modulePath = path.resolve(__dirname, '../src/config.cjs');
  const source = `
    const { loadConfig, saveConfig } = require(${JSON.stringify(modulePath)});
    const file = process.argv[1], writer = process.argv[2];
    for (let i = 0; i < 8; i++) {
      const current = loadConfig(file);
      saveConfig(file, { ...current, dot: { ...current.dot, displayName: writer + '-' + i } });
    }
  `;
  const writers = Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, file, `writer${index}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr || `writer exited ${code}`)));
  }));

  await Promise.all(writers);

  const current = loadConfigSnapshot(file);
  assert.match(current.config.dot.displayName, /^writer[0-3]-[0-7]$/u);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).format, 2);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});

test('invalid JSON and symlink config files fail closed', t => {
  const directory = tempDir(t);
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => loadConfig(file), { code: 'DOTDIAL_CONFIG_PARSE_ERROR' });
  fs.unlinkSync(file);
  const target = path.join(directory, 'other.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, file);
  assert.throws(() => loadConfig(file), { code: 'DOTDIAL_CONFIG_FILE_UNSAFE' });
  assert.throws(() => saveConfig(file, defaults), { code: 'DOTDIAL_CONFIG_FILE_UNSAFE' });
});

test('checked-in schema and example are valid JSON and example satisfies runtime validation', () => {
  const productRoot = path.resolve(__dirname, '..');
  const schema = JSON.parse(fs.readFileSync(path.join(productRoot, 'config.schema.json'), 'utf8'));
  const example = JSON.parse(fs.readFileSync(path.join(productRoot, 'config.example.json'), 'utf8'));
  assert.equal(schema.properties.version.const, 1);
  // The checked-in example has an explicit Linux shortcut. Loading an existing
  // configuration on macOS must retain it instead of inserting a fresh default.
  assert.equal(example.general.hotkey, schema.properties.general.properties.hotkey.default);
  assert.deepEqual(validateConfig(example), {
    ...defaults, general: { ...defaults.general, hotkey: example.general.hotkey },
  });
});
