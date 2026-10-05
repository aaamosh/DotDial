'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const configStore = require('../src/config.cjs');
const { createMicrophonePermission, createLoginItemController, isCustomMacLaunch, installMacApplicationMenu, secureRuntimeDirectory } = require('../src/macos.cjs');

test('macOS permission checks at startup never prompt or infer microphone access', async () => {
  let prompts = 0;
  const permission = createMicrophonePermission({ platform: 'darwin', systemPreferences: {
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: async () => { prompts++; return true; },
  } });
  assert.equal(permission.status(), 'not-determined');
  await assert.rejects(permission.requireAccess(), { code: 'microphone_permission_required' });
  assert.equal(prompts, 0);
  assert.equal(permission.isPending(), false);
});

test('one native prompt serves concurrent actions but a cancelled action cannot start capture', async () => {
  let state = 'not-determined', prompts = 0, answer, firstCurrent = true;
  const captured = [];
  const permission = createMicrophonePermission({ platform: 'darwin', systemPreferences: {
    getMediaAccessStatus: () => state,
    askForMediaAccess: () => { prompts++; return new Promise(resolve => { answer = resolve; }); },
  } });
  const first = permission.requireAccess({ prompt: true, isCurrent: () => firstCurrent })
    .then(allowed => { if (allowed) captured.push('cancelled call'); return allowed; });
  const second = permission.requireAccess({ prompt: true })
    .then(allowed => { if (allowed) captured.push('current call'); return allowed; });
  await Promise.resolve();
  assert.equal(prompts, 1);
  assert.equal(permission.isPending(), true);
  firstCurrent = false; // Stop, Mute or a newer call invalidates this action.
  state = 'granted'; answer(true);
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.deepEqual(captured, ['current call']);
  assert.equal(permission.isPending(), false);
  assert.equal(await permission.requireAccess(), true);
  assert.equal(prompts, 1);
});

test('a short-lived CLI check returns immediately while a native prompt is still open', async () => {
  let answer;
  const permission = createMicrophonePermission({ platform: 'darwin', systemPreferences: {
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: () => new Promise(resolve => { answer = resolve; }),
  } });
  let current = true;
  const interactive = permission.requireAccess({ prompt: true, isCurrent: () => current });
  await Promise.resolve();
  await assert.rejects(permission.requireAccess(), { code: 'microphone_permission_required' });
  current = false; answer(false);
  assert.equal(await interactive, false, 'closing or cancelling also discards a late denial');
});

test('denied, restricted and unavailable TCC states have specific errors without repeat prompts', async () => {
  for (const [state, code] of [['denied', 'microphone_permission_denied'], ['restricted', 'microphone_permission_restricted'], ['unknown', 'microphone_permission_unavailable']]) {
    const permission = createMicrophonePermission({ platform: 'darwin', systemPreferences: {
      getMediaAccessStatus: () => state,
      askForMediaAccess: () => assert.fail('must not repeat a rejected or unavailable permission prompt'),
    } });
    await assert.rejects(permission.requireAccess({ prompt: true }), { code });
    assert.equal(permission.status(), state);
  }
  const broken = createMicrophonePermission({ platform: 'darwin', systemPreferences: {
    getMediaAccessStatus() { throw Error('native unavailable'); },
  } });
  assert.equal(broken.status(), 'unknown');
  await assert.rejects(broken.requireAccess(), { code: 'microphone_permission_unavailable' });
});

test('native prompt failures and denials do not authorize media', async () => {
  const denied = createMicrophonePermission({ platform: 'darwin', systemPreferences: {
    getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async () => false,
  } });
  await assert.rejects(denied.requireAccess({ prompt: true }), { code: 'microphone_permission_denied' });
  const broken = createMicrophonePermission({ platform: 'darwin', systemPreferences: {
    getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async () => { throw Error('native detail'); },
  } });
  await assert.rejects(broken.requireAccess({ prompt: true }), { code: 'microphone_permission_unavailable' });
  assert.equal(broken.isPending(), false);
});

test('Linux permission flow never invokes macOS APIs', async () => {
  const native = new Proxy({}, { get() { assert.fail('macOS API called on Linux'); } });
  const permission = createMicrophonePermission({ platform: 'linux', systemPreferences: native });
  assert.equal(await permission.requireAccess({ prompt: true }), true);
  assert.equal(await permission.requireAccess({ prompt: true, isCurrent: () => false }), false);
  assert.equal(permission.status(), 'granted');
});

function settingsPermissionFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-settings-intent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const initial = configStore.saveConfig(file, configStore.validateConfig({}), { expectedHash: null });
  let answer, permissionStatus = 'not-determined', prompts = 0;
  const permission = createMicrophonePermission({ platform: 'darwin', systemPreferences: {
    getMediaAccessStatus: () => permissionStatus,
    askForMediaAccess: () => { prompts++; return new Promise(resolve => { answer = resolve; }); },
  } });
  const applied = [];
  // Execute the actual main-process save function without booting Electron,
  // networking, or audio. Config reads/writes retain their real hash semantics.
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const start = main.indexOf('  async function saveSettings('), end = main.indexOf('  function stopSoundPreview()');
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ ...configStore, paths: { configFile: file },
    settingsSaveEpoch: 0, busy: () => false, shuttingDown: false, demo: false,
    process: { platform: 'darwin' }, customMacLaunch: () => false, loginItem: { validate() {} },
    failure: code => Object.assign(new Error(code), { code }), microphonePermission: permission,
    applyDiskConfig: async () => { applied.push(configStore.loadConfigSnapshot(file).config.wakeWord.enabled); },
  });
  const save = vm.runInContext(`${main.slice(start, end)}\nsaveSettings`, context);
  return { initial, save, applied, permission, file, get prompts() { return prompts; },
    allow() { permissionStatus = 'granted'; answer(true); },
    enabled: { ...initial.config, wakeWord: { ...initial.config.wakeWord, enabled: true } },
  };
}

test('a newer Save disabling wake supersedes a pending enable even when the content hash is unchanged', async t => {
  const f = settingsPermissionFixture(t);
  const older = f.save(f.enabled, f.initial.hash);
  const rejected = assert.rejects(older, { code: 'settings_save_superseded' });
  await Promise.resolve();
  assert.equal(f.prompts, 1);
  assert.equal(f.permission.isPending(), true);
  const newer = await f.save(f.initial.config, f.initial.hash);
  assert.equal(newer.config.wakeWord.enabled, false);
  assert.equal(newer.hash, f.initial.hash, 'hash conflict detection alone cannot distinguish this newer intent');
  f.allow();
  await rejected;
  const final = configStore.loadConfigSnapshot(f.file);
  assert.equal(final.config.wakeWord.enabled, false);
  assert.equal(final.hash, newer.hash);
  assert.deepEqual(f.applied, [false], 'the obsolete request must not apply or restart a listener');
});

test('concurrent enable Saves share consent and only the latest request persists', async t => {
  const f = settingsPermissionFixture(t);
  const older = f.save(f.enabled, f.initial.hash);
  const rejected = assert.rejects(older, { code: 'settings_save_superseded' });
  const latest = f.save(f.enabled, f.initial.hash);
  await Promise.resolve();
  assert.equal(f.prompts, 1);
  f.allow();
  await rejected;
  assert.equal((await latest).config.wakeWord.enabled, true);
  assert.equal(configStore.loadConfigSnapshot(f.file).config.wakeWord.enabled, true);
  assert.deepEqual(f.applied, [true]);
});

function loginFixture({ packaged = true, apply = true } = {}) {
  let item = { status: 'not-registered', openAtLogin: false };
  const writes = [];
  const app = {
    isPackaged: packaged,
    getLoginItemSettings: () => ({ ...item }),
    setLoginItemSettings(value) {
      writes.push(value);
      if (apply) item = { status: value.openAtLogin ? 'enabled' : 'not-registered', openAtLogin: value.openAtLogin };
    },
  };
  return { controller: createLoginItemController({ platform: 'darwin', app }), writes, setItem: value => { item = value; } };
}

test('packaged macOS Login Items uses the native app service and reports read-back status', () => {
  const f = loginFixture();
  assert.deepEqual(f.controller.configure({ enabled: true }), { status: 'enabled', error: null });
  assert.deepEqual(f.writes, [{ openAtLogin: true }], 'do not pass Windows-only executable/args options');
  assert.deepEqual(f.controller.configure({ enabled: false }), { status: 'not-registered', error: null });
  assert.deepEqual(f.writes, [{ openAtLogin: true }, { openAtLogin: false }]);
});

test('Login Items preserves OS approval and does not re-enable an OS-disabled item on refresh', () => {
  const pending = loginFixture();
  pending.setItem({ status: 'requires-approval', openAtLogin: false });
  assert.deepEqual(pending.controller.configure({ enabled: true }), { status: 'requires-approval', error: 'login_item_requires_approval' });
  assert.deepEqual(pending.writes, []);

  const f = loginFixture();
  f.controller.configure({ enabled: true });
  f.setItem({ status: 'not-registered', openAtLogin: false });
  assert.deepEqual(f.controller.configure({ enabled: true }), { status: 'not-registered', error: 'login_item_unavailable' });
  assert.equal(f.writes.length, 1, 'an unrelated settings refresh must not undo the OS choice');
  const ignored = loginFixture({ apply: false });
  assert.equal(ignored.controller.configure({ enabled: true }).error, 'login_item_unavailable');
});

test('source builds and custom command-line launches cannot claim native autostart support', () => {
  const source = loginFixture({ packaged: false });
  assert.throws(() => source.controller.validate({ enabled: true }), { code: 'login_item_requires_packaged_app' });
  assert.equal(source.controller.configure({ enabled: true }).error, 'login_item_requires_packaged_app');
  assert.deepEqual(source.writes, []);
  const custom = loginFixture();
  assert.throws(() => custom.controller.validate({ enabled: true, customLaunch: true }), { code: 'login_item_custom_launch_unsupported' });
  assert.equal(custom.controller.configure({ enabled: true, customLaunch: true }).error, 'login_item_custom_launch_unsupported');
  assert.deepEqual(custom.writes, []);
});

test('the CLI default profile is compatible with Login Items; custom paths and launchers are not', () => {
  const nativePaths = Object.fromEntries(['configFile', 'dataDir', 'stateDir', 'runtimeDir', 'profileDir'].map(key => [key, path.join('/fixture/native', key)]));
  assert.equal(isCustomMacLaunch({ nativePaths, paths: nativePaths, profile: nativePaths.profileDir }), false);
  assert.equal(isCustomMacLaunch({ nativePaths, paths: nativePaths }), false);
  assert.equal(isCustomMacLaunch({ nativePaths, paths: nativePaths, profile: '/fixture/alternate-profile' }), true);
  assert.equal(isCustomMacLaunch({ nativePaths, paths: { ...nativePaths, configFile: '/fixture/custom.json' } }), true);
  assert.equal(isCustomMacLaunch({ nativePaths, paths: nativePaths, signalingLauncher: ['wrapper'] }), true);
});

test('macOS menus support editing and Settings; Dock activation respects shutdown', () => {
  const app = new EventEmitter();
  let menu, opened = 0, activated = 0, quitting = false;
  const dispose = installMacApplicationMenu({ platform: 'darwin', app,
    Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { menu = value; } },
    openSettings: () => { opened++; }, onActivate: () => { activated++; }, isQuitting: () => quitting,
  });
  assert.ok(menu.some(item => item.role === 'editMenu'));
  assert.ok(menu.some(item => item.role === 'windowMenu'));
  const settings = menu[0].submenu.find(item => item.accelerator === 'Command+,');
  settings.click();
  assert.equal(opened, 1);
  assert.ok(menu[0].submenu.some(item => item.role === 'quit'));
  app.emit('activate');
  assert.equal(opened, 2); assert.equal(activated, 1);
  quitting = true; app.emit('activate');
  assert.equal(opened, 2);
  dispose(); assert.equal(app.listenerCount('activate'), 0);
  const native = new Proxy({}, { get() { assert.fail('macOS menu setup called on Linux'); } });
  installMacApplicationMenu({ platform: 'linux', app: native, Menu: native })();
});

test('runtime directory is private while an existing symlink or wrong owner is rejected', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  secureRuntimeDirectory(runtime);
  assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
  assert.throws(() => secureRuntimeDirectory(runtime, { uid: (process.getuid?.() || 0) + 1 }), { code: 'runtime_directory_unsafe' });
  const target = path.join(root, 'unrelated');
  fs.mkdirSync(target, { mode: 0o755 }); fs.chmodSync(target, 0o755);
  const link = path.join(root, 'linked-runtime'); fs.symlinkSync(target, link);
  assert.throws(() => secureRuntimeDirectory(link), { code: 'runtime_directory_unsafe' });
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
});

test('a runtime-directory replacement between inspection and chmod cannot follow a symlink', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-runtime-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime'), target = path.join(root, 'unrelated');
  fs.mkdirSync(runtime); fs.mkdirSync(target); fs.chmodSync(target, 0o755);
  const raced = { ...fs, openSync(file, flags) {
    fs.renameSync(runtime, path.join(root, 'old-runtime')); fs.symlinkSync(target, runtime);
    return fs.openSync(file, flags);
  } };
  assert.throws(() => secureRuntimeDirectory(runtime, { fs: raced }), { code: 'runtime_directory_unsafe' });
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
});
