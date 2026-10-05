'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getPaths } = require('../src/config.cjs');
const { electronLayout } = require('../src/runtime_paths.cjs');

test('macOS defaults use Application Support, Caches and a short per-user temporary socket', () => {
  const paths = getPaths({ platform: 'darwin', home: '/Users/Test Person', env: {}, uid: 501, tmpdir: '/var/folders/ab/test/T' });
  const support = '/Users/Test Person/Library/Application Support/DotDial';
  assert.equal(paths.configFile, `${support}/config.json`);
  assert.equal(paths.stateDir, `${support}/state`);
  assert.equal(paths.dataDir, `${support}/data`);
  assert.equal(paths.profileDir, `${support}/data/profile`);
  assert.equal(paths.recordingsDir, `${support}/data/recordings`);
  assert.equal(paths.cacheDir, '/Users/Test Person/Library/Caches/DotDial');
  assert.equal(paths.socketPath, '/var/folders/ab/test/T/dotdial-501/dotdial.sock');
  assert.ok(Buffer.byteLength(paths.socketPath) < 104);
});

test('macOS and Linux honor the same explicit XDG paths for isolated profiles', () => {
  const env = { XDG_CONFIG_HOME: '/test/cfg', XDG_DATA_HOME: '/test/data', XDG_STATE_HOME: '/test/state', XDG_CACHE_HOME: '/test/cache', XDG_RUNTIME_DIR: '/test/run' };
  const options = { home: '/test/home', env, uid: 501, tmpdir: '/tmp' };
  assert.deepEqual(getPaths({ ...options, platform: 'darwin' }), getPaths({ ...options, platform: 'linux' }));
  assert.equal(getPaths({ ...options, platform: 'darwin', configHome: '/override' }).configFile, '/override/dotdial/config.json');
});

test('macOS does not change existing Linux default paths', () => {
  const paths = getPaths({ platform: 'linux', home: '/home/test', env: {}, uid: 1001, tmpdir: '/tmp' });
  assert.equal(paths.configFile, '/home/test/.config/dotdial/config.json');
  assert.equal(paths.stateDir, '/home/test/.local/state/dotdial');
  assert.equal(paths.dataDir, '/home/test/.local/share/dotdial');
  assert.equal(paths.socketPath, '/run/user/1001/dotdial/dotdial.sock');
});

test('macOS explicit roots must still be absolute', () => {
  assert.throws(() => getPaths({ platform: 'darwin', home: '/Users/test', env: { XDG_DATA_HOME: 'relative' } }), { code: 'DOTDIAL_PATH_INVALID' });
});

test('packaged macOS CLI resolves its own app executable, including spaces', () => {
  const root = '/Applications/Dot Dial.app/Contents/Resources/app';
  const expected = '/Applications/Dot Dial.app/Contents/MacOS/DotDial';
  const actual = electronLayout(root, { platform: 'darwin', existsSync: file => file === expected });
  assert.deepEqual(actual, { packaged: true, electron: expected, mainScript: path.join(root, 'src/main.cjs') });
});

test('source macOS CLI uses Electron.app and does not guess an absent packaged runtime', () => {
  const actual = electronLayout('/src/DotDial', { platform: 'darwin', existsSync: () => false });
  assert.equal(actual.packaged, false);
  assert.equal(actual.electron, '/src/DotDial/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
});

test('Linux packaged and development Electron layouts remain supported', () => {
  const packaged = electronLayout('/opt/dotdial/resources/app', { platform: 'linux', existsSync: p => p === '/opt/dotdial/dotdial-runtime' });
  assert.equal(packaged.electron, '/opt/dotdial/dotdial-runtime');
  assert.equal(packaged.packaged, true);
  const development = electronLayout('/src/DotDial', { platform: 'linux', existsSync: () => true });
  assert.equal(development.packaged, false);
  assert.equal(development.electron, '/src/DotDial/node_modules/electron/dist/electron');
});
