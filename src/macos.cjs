'use strict';

const fs = require('node:fs');
const path = require('node:path');

const failure = code => Object.assign(new Error(code), { code });
const MICROPHONE_STATES = new Set(['granted', 'denied', 'restricted', 'not-determined', 'unknown']);

// TCC consent belongs to the application, before a media RPC or a Python
// listener is started. Never infer consent from Chromium's permission handler.
function createMicrophonePermission({ platform = process.platform, systemPreferences, onChange = () => {} } = {}) {
  let pending = null;
  const status = () => {
    if (platform !== 'darwin') return 'granted';
    try {
      const value = systemPreferences.getMediaAccessStatus('microphone');
      return MICROPHONE_STATES.has(value) ? value : 'unknown';
    } catch { return 'unknown'; }
  };
  const denied = value => failure(value === 'restricted' ? 'microphone_permission_restricted'
    : value === 'denied' ? 'microphone_permission_denied'
      : value === 'not-determined' ? 'microphone_permission_required' : 'microphone_permission_unavailable');
  const notify = () => { try { onChange(); } catch {} };
  async function requireAccess({ prompt = false, isCurrent = () => true } = {}) {
    if (!isCurrent()) return false;
    if (platform !== 'darwin') return true;
    const current = status();
    if (current === 'granted') return true;
    if (current !== 'not-determined' || !prompt) throw denied(current);
    if (!pending) {
      // Share one native prompt, but let each caller independently discard its
      // result after Stop, Mute, a newer request, or application shutdown.
      pending = Promise.resolve().then(() => systemPreferences.askForMediaAccess('microphone'))
        .catch(() => { throw failure('microphone_permission_unavailable'); })
        .finally(() => { pending = null; notify(); });
      notify();
    }
    try {
      const granted = await pending;
      if (!isCurrent()) return false;
      if (!granted) {
        const after = status();
        throw denied(after === 'not-determined' ? 'denied' : after);
      }
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      throw error;
    }
  }
  return { status, requireAccess, isPending: () => pending !== null };
}

function createLoginItemController({ app, platform = process.platform } = {}) {
  let requested = null, last = { status: 'not-registered', error: null };
  const unsupported = ({ enabled, customLaunch }) => !enabled || platform !== 'darwin' ? null
    : !app.isPackaged ? 'login_item_requires_packaged_app'
      : customLaunch ? 'login_item_custom_launch_unsupported' : null;
  function validate(options) {
    const code = unsupported(options);
    if (code) throw failure(code);
  }
  function refresh() {
    if (platform !== 'darwin' || !requested) return last;
    const code = unsupported(requested);
    if (code) return (last = { status: 'unavailable', error: code });
    if (!app.isPackaged) return (last = { status: 'not-registered', error: null });
    try {
      const item = app.getLoginItemSettings();
      const status = item.status || (item.openAtLogin ? 'enabled' : 'not-registered');
      const error = requested.enabled
        ? status === 'requires-approval' ? 'login_item_requires_approval'
          : status !== 'enabled' || !item.openAtLogin ? 'login_item_unavailable' : null
        : item.openAtLogin || status === 'enabled' || status === 'requires-approval' ? 'login_item_unavailable' : null;
      return (last = { status, error });
    } catch { return (last = { status: 'unavailable', error: 'login_item_unavailable' }); }
  }
  function configure({ enabled = false, customLaunch = false } = {}) {
    if (platform !== 'darwin') return last;
    const next = { enabled: !!enabled, customLaunch: !!customLaunch };
    const changed = JSON.stringify(next) !== JSON.stringify(requested);
    requested = next;
    if (unsupported(next) || !app.isPackaged) return refresh();
    try {
      if (changed) {
        const current = app.getLoginItemSettings();
        // A settings refresh must not override a later choice in macOS System
        // Settings, nor repeatedly register an item awaiting OS approval.
        if (next.enabled ? !current.openAtLogin && current.status !== 'requires-approval'
          : current.openAtLogin || current.status === 'enabled' || current.status === 'requires-approval') {
          app.setLoginItemSettings({ openAtLogin: next.enabled });
        }
      }
      return refresh();
    } catch { return (last = { status: 'unavailable', error: 'login_item_unavailable' }); }
  }
  return { validate, configure, refresh, snapshot: () => last };
}

function isCustomMacLaunch({ nativePaths, paths, profile, signalingLauncher = [] }) {
  if (!nativePaths) return false;
  return signalingLauncher.length > 0 || !!(profile && path.resolve(profile) !== nativePaths.profileDir) ||
    ['configFile', 'dataDir', 'stateDir', 'runtimeDir'].some(key => paths[key] !== nativePaths[key]);
}

function installMacApplicationMenu({ app, Menu, openSettings, onActivate = () => {}, isQuitting = () => false, platform = process.platform }) {
  if (platform !== 'darwin') return () => {};
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'DotDial', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Command+,', click: openSettings },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      // The native role calls app.quit(), which passes through the quit barrier.
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
  const activate = () => {
    if (isQuitting()) return;
    onActivate();
    openSettings();
  };
  app.on('activate', activate);
  return () => app.removeListener('activate', activate);
}

// macOS may fall back to a shared temporary parent. Only take ownership of
// DotDial's own directory, never chmod a symlink or another user's directory.
function secureRuntimeDirectory(directory, { fs: io = fs, uid = process.getuid?.() } = {}) {
  let descriptor;
  try {
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const before = io.lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || (uid !== undefined && before.uid !== uid)) throw failure('runtime_directory_unsafe');
    descriptor = io.openSync(directory, io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW);
    const opened = io.fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || (uid !== undefined && opened.uid !== uid)) throw failure('runtime_directory_unsafe');
    io.fchmodSync(descriptor, 0o700);
  } catch { throw failure('runtime_directory_unsafe'); }
  finally { if (descriptor !== undefined) io.closeSync(descriptor); }
}

module.exports = { createMicrophonePermission, createLoginItemController, isCustomMacLaunch, installMacApplicationMenu, secureRuntimeDirectory };
