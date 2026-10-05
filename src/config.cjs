'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  version: 1,
  dot: {
    url: '',
    displayName: 'My dot',
    expectedEmail: '',
  },
  general: {
    startAtLogin: false,
    hotkey: process.platform === 'darwin' ? 'Command+Shift+Space' : 'CommandOrControl+Alt+Space',
  },
  audio: {
    bufferMs: 0,
    microphoneDeviceId: 'default',
    outputDeviceId: 'default',
    sounds: true,
    soundVolume: 0.55,
    connectionSound: 'modem',
    customSoundPath: '',
    microphoneInitiallyMuted: false,
    speakersInitiallyMuted: false,
  },
  wakeWord: {
    enabled: false,
    phrase: 'Hey Dot',
    sensitivity: 6,
    modelPath: '',
    pythonPath: 'python3',
    deviceName: '',
    deviceHostApi: '',
  },
  recording: {
    enabled: true,
    maxMegabytes: 200,
  },
  appearance: {
    theme: 'system',
    panelOpacity: 0.86,
    showPanel: true,
    language: 'en',
  },
  network: {
    signalingProxy: '',
    signalingLauncher: [],
    mediaLauncher: [],
  },
  call: {
    maxMinutes: 60,
  },
};

const clone = value => JSON.parse(JSON.stringify(value));

class ConfigError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    if (field) this.field = field;
  }
}

function invalid(field, expectation) {
  throw new ConfigError('DOTDIAL_CONFIG_INVALID', `${field} ${expectation}`, field);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknown(input, defaults, prefix = '') {
  if (!isRecord(input)) invalid(prefix || 'config', 'must be an object');
  for (const key of Object.keys(input)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(defaults, key)) {
      throw new ConfigError('DOTDIAL_CONFIG_UNKNOWN_FIELD', `Unknown configuration field: ${field}`, field);
    }
    if (isRecord(defaults[key]) && Object.hasOwn(input, key)) {
      rejectUnknown(input[key], defaults[key], field);
    } else if (isRecord(input[key]) && !isRecord(defaults[key])) {
      invalid(field, 'must not be an object');
    }
  }
}

function mergeDefaults(input, defaults = DEFAULTS) {
  const result = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    if (isRecord(fallback)) {
      const supplied = Object.hasOwn(input, key) ? input[key] : {};
      result[key] = mergeDefaults(supplied, fallback);
    } else {
      result[key] = Object.hasOwn(input, key) ? input[key] : fallback;
    }
  }
  return result;
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') invalid(field, 'must be a boolean');
}

function requireInteger(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    invalid(field, `must be an integer from ${min} to ${max}`);
  }
}

function requireNumber(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(field, `must be a number from ${min} to ${max}`);
  }
}

function requireString(value, field, { min = 0, max = 4096, allowEmpty = min === 0 } = {}) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(field, `must be a string of at most ${max} characters without control characters`);
  }
  if (!allowEmpty && value.trim().length < min) invalid(field, `must contain at least ${min} characters`);
}

function validateDotUrl(value) {
  requireString(value, 'dot.url', { max: 256 });
  if (value === '') return;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (!new RegExp(`^https://chatgpt\\.com/dots/${uuid}$`, 'i').test(value)) {
    invalid('dot.url', 'must be empty or an HTTPS ChatGPT dot URL ending in a UUID');
  }
}

function validateEmail(value) {
  requireString(value, 'dot.expectedEmail', { max: 254 });
  if (value === '') return;
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value)) {
    invalid('dot.expectedEmail', 'must be empty or a valid email address');
  }
}

function validateProxy(value) {
  requireString(value, 'network.signalingProxy', { max: 2048 });
  if (value === '') return;
  let parsed;
  try { parsed = new URL(value); }
  catch { invalid('network.signalingProxy', 'must be empty or an absolute proxy URL'); }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname ||
      (parsed.pathname !== '' && parsed.pathname !== '/')) {
    invalid('network.signalingProxy', 'must not contain credentials, query, fragment, or a path');
  }
}

function looksLikeSecretArgument(value) {
  return /(?:^|[-_])(?:password|passwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|bearer)(?:$|[=:])/iu.test(value) ||
    /(?:^|\s)(?:bearer\s+)[a-z0-9._~-]{12,}/iu.test(value);
}

function validateArgv(value, field) {
  if (!Array.isArray(value) || value.length > 32) invalid(field, 'must be an array of at most 32 arguments');
  for (let index = 0; index < value.length; index++) {
    const arg = value[index];
    requireString(arg, `${field}[${index}]`, { min: 1, max: 2048, allowEmpty: false });
    if (looksLikeSecretArgument(arg) || (/^--?(?:password|passwd|secret|token|api[-_]?key|authorization|cookie)$/iu.test(arg) && index < value.length - 1)) {
      invalid(`${field}[${index}]`, 'must not contain or introduce credentials; use a credential-free launcher');
    }
  }
}

function validateConfig(input) {
  if (!isRecord(input)) invalid('config', 'must be an object');
  rejectUnknown(input, DEFAULTS);
  const config = mergeDefaults(input);

  if (config.version !== 1) invalid('version', 'must equal 1');

  validateDotUrl(config.dot.url);
  requireString(config.dot.displayName, 'dot.displayName', { min: 1, max: 80, allowEmpty: false });
  validateEmail(config.dot.expectedEmail);

  requireBoolean(config.general.startAtLogin, 'general.startAtLogin');
  requireString(config.general.hotkey, 'general.hotkey', { min: 1, max: 96, allowEmpty: false });
  const accelerator = /^(?:(?:CommandOrControl|CmdOrCtrl|Control|Ctrl|Command|Cmd|Option|Alt|AltGr|Shift|Super|Meta)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause)$/iu;
  if (!accelerator.test(config.general.hotkey)) {
    invalid('general.hotkey', 'must be an Electron accelerator such as CommandOrControl+Alt+Space');
  }

  requireInteger(config.audio.bufferMs, 'audio.bufferMs', 0, 2000);
  requireString(config.audio.microphoneDeviceId, 'audio.microphoneDeviceId', { min: 1, max: 512, allowEmpty: false });
  requireString(config.audio.outputDeviceId, 'audio.outputDeviceId', { min: 1, max: 512, allowEmpty: false });
  requireBoolean(config.audio.sounds, 'audio.sounds');
  requireNumber(config.audio.soundVolume, 'audio.soundVolume', 0, 1);
  if (!['modem', 'telephone', 'custom'].includes(config.audio.connectionSound)) {
    invalid('audio.connectionSound', 'must be modem, telephone, or custom');
  }
  requireString(config.audio.customSoundPath, 'audio.customSoundPath', { max: 4096 });
  if (config.audio.customSoundPath && (!path.isAbsolute(config.audio.customSoundPath) || !/\.(mp3|wav)$/iu.test(config.audio.customSoundPath))) {
    invalid('audio.customSoundPath', 'must be an absolute path to an MP3 or WAV file');
  }
  if (config.audio.connectionSound === 'custom' && !config.audio.customSoundPath) {
    invalid('audio.customSoundPath', 'requires an MP3 or WAV file when the custom sound is selected');
  }
  requireBoolean(config.audio.microphoneInitiallyMuted, 'audio.microphoneInitiallyMuted');
  requireBoolean(config.audio.speakersInitiallyMuted, 'audio.speakersInitiallyMuted');

  requireBoolean(config.wakeWord.enabled, 'wakeWord.enabled');
  requireString(config.wakeWord.phrase, 'wakeWord.phrase', { min: 1, max: 48, allowEmpty: false });
  requireInteger(config.wakeWord.sensitivity, 'wakeWord.sensitivity', 1, 10);
  requireString(config.wakeWord.modelPath, 'wakeWord.modelPath', { max: 4096 });
  if (config.wakeWord.modelPath && !path.isAbsolute(config.wakeWord.modelPath)) {
    invalid('wakeWord.modelPath', 'must be empty or an absolute path');
  }
  requireString(config.wakeWord.pythonPath, 'wakeWord.pythonPath', { min: 1, max: 4096, allowEmpty: false });
  requireString(config.wakeWord.deviceName, 'wakeWord.deviceName', { max: 256 });
  requireString(config.wakeWord.deviceHostApi, 'wakeWord.deviceHostApi', { max: 80 });
  if (Boolean(config.wakeWord.deviceName) !== Boolean(config.wakeWord.deviceHostApi)) {
    invalid('wakeWord.deviceName', 'and wakeWord.deviceHostApi must both be empty or both be selected');
  }

  requireBoolean(config.recording.enabled, 'recording.enabled');
  requireInteger(config.recording.maxMegabytes, 'recording.maxMegabytes', 1, 8192);

  if (!['system', 'light', 'dark'].includes(config.appearance.theme)) {
    invalid('appearance.theme', 'must be system, light, or dark');
  }
  requireNumber(config.appearance.panelOpacity, 'appearance.panelOpacity', 0.2, 1);
  requireBoolean(config.appearance.showPanel, 'appearance.showPanel');
  requireString(config.appearance.language, 'appearance.language', { min: 2, max: 35, allowEmpty: false });
  if (config.appearance.language !== 'en') {
    invalid('appearance.language', 'must be en');
  }

  validateProxy(config.network.signalingProxy);
  validateArgv(config.network.signalingLauncher, 'network.signalingLauncher');
  validateArgv(config.network.mediaLauncher, 'network.mediaLauncher');

  requireInteger(config.call.maxMinutes, 'call.maxMinutes', 1, 1440);
  return config;
}

function absoluteDir(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new ConfigError('DOTDIAL_PATH_INVALID', `${field} must be an absolute path`, field);
  }
  return path.resolve(value);
}

function getPaths(overrides = {}) {
  if (!isRecord(overrides)) throw new ConfigError('DOTDIAL_PATH_INVALID', 'Path overrides must be an object');
  const env = isRecord(overrides.env) ? overrides.env : process.env;
  const home = absoluteDir(overrides.home || os.homedir(), 'home');
  const platform = overrides.platform || process.platform;
  const mac = platform === 'darwin';
  const support = path.join(home, 'Library', 'Application Support', 'DotDial');
  // Explicit XDG roots remain useful for isolated tests and custom installs on
  // either platform. Native macOS defaults never write into /run or the .app.
  const choose = (override, envName, fallback, field) => override || env[envName]
    ? path.join(absoluteDir(override || env[envName], field), 'dotdial')
    : fallback;
  const configDir = choose(overrides.configHome, 'XDG_CONFIG_HOME', mac ? support : path.join(home, '.config', 'dotdial'), 'configHome');
  const stateDir = choose(overrides.stateHome, 'XDG_STATE_HOME', mac ? path.join(support, 'state') : path.join(home, '.local', 'state', 'dotdial'), 'stateHome');
  const dataDir = choose(overrides.dataHome, 'XDG_DATA_HOME', mac ? path.join(support, 'data') : path.join(home, '.local', 'share', 'dotdial'), 'dataHome');
  const cacheDir = choose(overrides.cacheHome, 'XDG_CACHE_HOME', mac ? path.join(home, 'Library', 'Caches', 'DotDial') : path.join(home, '.cache', 'dotdial'), 'cacheHome');
  const uid = overrides.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  const temp = absoluteDir(overrides.tmpdir || os.tmpdir(), 'tmpdir');
  const runtimeFallback = mac ? path.join(temp, `dotdial-${uid ?? 'user'}`)
    : uid !== null ? path.join('/run/user', String(uid), 'dotdial') : path.join(temp, 'dotdial-runtime', 'dotdial');
  const runtimeDir = choose(overrides.runtimeHome, 'XDG_RUNTIME_DIR', runtimeFallback, 'runtimeHome');
  return {
    configDir,
    configFile: path.join(configDir, 'config.json'),
    stateDir,
    dataDir,
    cacheDir,
    runtimeDir,
    socketPath: overrides.socketPath ? absoluteDir(overrides.socketPath, 'socketPath') : path.join(runtimeDir, 'dotdial.sock'),
    recordingsDir: path.join(dataDir, 'recordings'),
    profileDir: path.join(dataDir, 'profile'),
    logFile: path.join(stateDir, 'dotdial.log'),
  };
}

function absoluteFile(file) {
  const chosen = file || getPaths().configFile;
  if (typeof chosen !== 'string' || chosen.length === 0 || !path.isAbsolute(chosen)) {
    throw new ConfigError('DOTDIAL_PATH_INVALID', 'Config file path must be absolute', 'file');
  }
  return path.resolve(chosen);
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readCurrent(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: null, hash: null };
    throw new ConfigError('DOTDIAL_CONFIG_READ_FAILED', 'Could not inspect the configuration file');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ConfigError('DOTDIAL_CONFIG_FILE_UNSAFE', 'Config path must be a regular file, not a symlink');
  }
  if (stat.size > 1024 * 1024) throw new ConfigError('DOTDIAL_CONFIG_TOO_LARGE', 'Config file exceeds 1 MiB');
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch { throw new ConfigError('DOTDIAL_CONFIG_READ_FAILED', 'Could not read the configuration file'); }
  return { exists: true, bytes, hash: hashBytes(bytes) };
}

function parseConfigBytes(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new ConfigError('DOTDIAL_CONFIG_PARSE_ERROR', 'Configuration file is not valid JSON'); }
}

function loadConfigSnapshot(file) {
  const target = absoluteFile(file);
  const current = readCurrent(target);
  const config = current.exists ? validateConfig(parseConfigBytes(current.bytes)) : validateConfig({});
  return { config, hash: current.hash, path: target };
}

function loadConfig(file) {
  return loadConfigSnapshot(file).config;
}

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function initializeLockFile(lockPath) {
  const tempPath = `${lockPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ format: 2, pid: process.pid, createdAt: Date.now() }) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.linkSync(tempPath, lockPath); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } catch (error) {
    throw new ConfigError('DOTDIAL_CONFIG_WRITE_FAILED', 'Could not prepare the config lock');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function configLockCommand({ platform = process.platform, projectRoot = path.resolve(__dirname, '..'), timeoutMs = 2000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw new TypeError('Config lock timeout must be an integer from 0 to 30000 ms');
  if (platform !== 'darwin') return { command: 'flock', args: ['-x', '-w', String(timeoutMs / 1000), '3'], timeoutExitCode: 1 };
  const root = path.resolve(projectRoot), resources = path.dirname(root);
  const packaged = path.basename(root) === 'app' && path.basename(resources) === 'Resources' && path.basename(path.dirname(resources)) === 'Contents';
  return {
    command: packaged ? path.join(resources, 'dotdial-lock') : path.join(root, 'build', 'native', 'dotdial-lock'),
    args: ['--timeout-ms', String(timeoutMs)], timeoutExitCode: 75,
  };
}

function acquireLock(lockPath, timeoutMs = 2000) {
  initializeLockFile(lockPath);
  let fd;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === 'ELOOP') throw new ConfigError('DOTDIAL_CONFIG_LOCK_INVALID', 'Config lock must not be a symbolic link');
    throw new ConfigError('DOTDIAL_CONFIG_WRITE_FAILED', 'Could not open the config lock');
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new ConfigError('DOTDIAL_CONFIG_LOCK_INVALID', 'Config lock must be a regular file');
    const lockCommand = configLockCommand({ timeoutMs });
    // Both helpers lock the inherited open file description. Their exit must
    // leave the lock held by this parent fd until saveConfig closes it.
    const locked = spawnSync(lockCommand.command, lockCommand.args, {
      stdio: ['ignore', 'ignore', 'ignore', fd],
      timeout: timeoutMs + 1000,
      windowsHide: true,
    });
    if (locked.error || locked.status !== 0) {
      if (!locked.error && locked.status === lockCommand.timeoutExitCode) {
        throw new ConfigError('DOTDIAL_CONFIG_BUSY', 'Another configuration update is in progress');
      }
      throw new ConfigError('DOTDIAL_CONFIG_LOCK_UNAVAILABLE', process.platform === 'darwin'
        ? 'The native macOS config lock helper is unavailable. Reinstall DotDial or run npm install from source.'
        : 'The system flock utility is required to save settings');
    }

    let previous;
    const stat = fs.fstatSync(fd);
    try { previous = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { previous = null; }
    if (previous?.format !== 2) {
      const ownerPid = Number.isInteger(previous?.pid) && previous.pid > 0 ? previous.pid : null;
      const ownerAlive = ownerPid !== null && pidExists(ownerPid);
      const oldEnough = Date.now() - stat.mtimeMs > 30_000;
      // Older releases used PID JSON without kernel locks. Preserve a live
      // legacy writer; only recover an unowned malformed file after a grace
      // period. All new writers serialize stale recovery through flock.
      if (ownerAlive || (!oldEnough && ownerPid === null)) {
        throw new ConfigError('DOTDIAL_CONFIG_BUSY', 'Another configuration update is in progress');
      }
    }

    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify({ format: 2, pid: process.pid, createdAt: Date.now() }) + '\n', 0, 'utf8');
    fs.fsyncSync(fd);
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('DOTDIAL_CONFIG_WRITE_FAILED', 'Could not acquire the config lock');
  }
}

function ensurePrivateDir(directory) {
  try {
    // New application-owned config directories are created private. A custom
    // config may live in an existing directory owned by the user, so do not
    // silently change that directory's permissions.
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ConfigError('DOTDIAL_CONFIG_DIR_UNSAFE', 'Config directory must be a real directory');
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('DOTDIAL_CONFIG_WRITE_FAILED', 'Could not prepare a private config directory');
  }
}

function saveConfig(file, input, { expectedHash } = {}) {
  const target = absoluteFile(file);
  const config = validateConfig(input);
  if (expectedHash !== undefined && expectedHash !== null &&
      (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash))) {
    throw new ConfigError('DOTDIAL_CONFIG_HASH_INVALID', 'expectedHash must be a SHA-256 hex digest or null');
  }
  const directory = path.dirname(target);
  ensurePrivateDir(directory);
  const lockPath = `${target}.lock`;
  let lockFd;
  let tempPath;
  try {
    lockFd = acquireLock(lockPath);
    const current = readCurrent(target);
    if (expectedHash !== undefined && expectedHash !== current.hash) {
      throw new ConfigError('DOTDIAL_CONFIG_CONFLICT', 'Configuration changed since it was read; reload before saving');
    }
    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    tempPath = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const tempFd = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeFileSync(tempFd, serialized, 'utf8');
      fs.fsyncSync(tempFd);
    } finally {
      fs.closeSync(tempFd);
    }
    fs.renameSync(tempPath, target);
    tempPath = undefined;
    try {
      const dirFd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* Some Linux filesystems do not support fsync on directories. */ }
    const bytes = Buffer.from(serialized, 'utf8');
    return { config, hash: hashBytes(bytes), path: target };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('DOTDIAL_CONFIG_WRITE_FAILED', 'Could not atomically save the configuration');
  } finally {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch {} }
    if (lockFd !== undefined) { try { fs.closeSync(lockFd); } catch {} }
  }
}

module.exports = {
  defaults: clone(DEFAULTS),
  ConfigError,
  validateConfig,
  loadConfig,
  loadConfigSnapshot,
  saveConfig,
  configLockCommand,
  getPaths,
};
