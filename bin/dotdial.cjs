#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { electronLayout } = require('../src/runtime_paths.cjs');
const {
  ConfigError,
  validateConfig,
  loadConfigSnapshot,
  saveConfig,
  getPaths,
  configLockCommand,
} = require('../src/config.cjs');
const { resolveWakeRuntime, wakeModelReady } = require('../src/wake-runtime.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const { mainScript: MAIN_SCRIPT, packaged: PACKAGED_LAYOUT, electron: RUNTIME_ELECTRON } = electronLayout(PROJECT_ROOT);

const USAGE = `DotDial local agent

Usage:
  dotdial config show [--config FILE]
  dotdial config path [--config FILE]
  dotdial config validate [FILE] [--config FILE]
  dotdial config set <dotted.key> <JSON-value> [--if-hash SHA256] [--config FILE]
  dotdial doctor [--electron FILE] [--config FILE]
  dotdial run [--settings] [--electron FILE] [--config FILE]
  dotdial status | call | hangup | mute | unmute | speakers-mute | speakers-unmute | replay

All output is JSON except config path, which prints one absolute path.
Call uses the microphone; use it only when you intend to start a conversation.
Doctor checks local paths and dependencies only. It does not sign in, open a call, or access a microphone.
Config set accepts a JSON value, such as true, 0.55, or the string value shown by:
  dotdial config set dot.displayName '\"My dot\"'
Config show prints {"hash": SHA256-or-null, "config": ...} for safe concurrent edits.
if-hash prevents overwriting changes made since that hash was read.\n`;

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function writeJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function extractOption(args, name) {
  let value;
  const kept = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === name) {
      if (value !== undefined || index + 1 >= args.length) throw fail('DOTDIAL_ARGUMENT_INVALID', `${name} requires one value`);
      value = args[++index];
    } else if (arg.startsWith(`${name}=`)) {
      if (value !== undefined) throw fail('DOTDIAL_ARGUMENT_INVALID', `${name} may be specified once`);
      value = arg.slice(name.length + 1);
    } else kept.push(arg);
  }
  return { value, args: kept };
}

function parseGlobalOptions(args) {
  let rest = [...args];
  const configOption = extractOption(rest, '--config');
  rest = configOption.args;
  const electronOption = extractOption(rest, '--electron');
  rest = electronOption.args;
  return {
    args: rest,
    configFile: configOption.value ? path.resolve(configOption.value) : getPaths().configFile,
    configProvided: configOption.value !== undefined,
    electron: electronOption.value,
  };
}

function parseHashOption(args) {
  const parsed = extractOption(args, '--if-hash');
  return { args: parsed.args, expectedHash: parsed.value === 'null' ? null : parsed.value };
}

function getConfig(file) {
  return loadConfigSnapshot(file);
}

function setDotted(config, dottedKey, value) {
  if (typeof dottedKey !== 'string' || dottedKey.length > 160 || !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u.test(dottedKey)) {
    throw fail('DOTDIAL_ARGUMENT_INVALID', 'Setting name must be a dotted configuration key');
  }
  const segments = dottedKey.split('.');
  let target = config;
  for (const segment of segments.slice(0, -1)) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || !Object.hasOwn(target, segment)) {
      throw fail('DOTDIAL_CONFIG_UNKNOWN_FIELD', `Unknown configuration field: ${dottedKey}`, { field: dottedKey });
    }
    target = target[segment];
  }
  const leaf = segments.at(-1);
  if (!target || typeof target !== 'object' || Array.isArray(target) || !Object.hasOwn(target, leaf)) {
    throw fail('DOTDIAL_CONFIG_UNKNOWN_FIELD', `Unknown configuration field: ${dottedKey}`, { field: dottedKey });
  }
  target[leaf] = value;
}

function parseConfigCommand(args, configFile) {
  const [action, ...rest] = args;
  if (!action || action === 'help' || action === '--help' || action === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (action === 'path') {
    if (rest.length) throw fail('DOTDIAL_ARGUMENT_INVALID', 'config path takes no arguments');
    process.stdout.write(`${configFile}\n`);
    return 0;
  }
  if (action === 'show') {
    if (rest.length) throw fail('DOTDIAL_ARGUMENT_INVALID', 'config show takes no arguments');
    const snapshot = getConfig(configFile);
    writeJson({ hash: snapshot.hash, config: snapshot.config });
    return 0;
  }
  if (action === 'validate') {
    if (rest.length > 1) throw fail('DOTDIAL_ARGUMENT_INVALID', 'config validate accepts at most one file path');
    const file = rest[0] ? path.resolve(rest[0]) : configFile;
    const snapshot = getConfig(file);
    writeJson({ valid: true, hash: snapshot.hash, path: snapshot.path });
    return 0;
  }
  if (action === 'set') {
    const { args: withoutHash, expectedHash: requestedHash } = parseHashOption(rest);
    if (withoutHash.length !== 2) throw fail('DOTDIAL_ARGUMENT_INVALID', 'config set requires a dotted key and one JSON value');
    let value;
    try { value = JSON.parse(withoutHash[1]); }
    catch { throw fail('DOTDIAL_VALUE_INVALID', 'Value must be valid JSON'); }
    const snapshot = getConfig(configFile);
    if (requestedHash !== undefined && requestedHash !== snapshot.hash) {
      throw new ConfigError('DOTDIAL_CONFIG_CONFLICT', 'Configuration changed since that hash was read; reload before saving');
    }
    const next = snapshot.config;
    setDotted(next, withoutHash[0], value);
    const result = saveConfig(configFile, validateConfig(next), { expectedHash: snapshot.hash });
    writeJson({ saved: true, hash: result.hash, path: result.path });
    return 0;
  }
  throw fail('DOTDIAL_COMMAND_UNKNOWN', `Unknown config command: ${action}`);
}

function resolveExecutable(command, pathValue = process.env.PATH || '') {
  if (path.isAbsolute(command)) {
    try { fs.accessSync(command, fs.constants.X_OK); return command; }
    catch { return null; }
  }
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch { /* Continue through PATH. */ }
  }
  return null;
}

function electronPath(override) {
  const candidate = override ? path.resolve(override) : RUNTIME_ELECTRON;
  try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
  catch { return null; }
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function writableDirectoryOrParent(directory) {
  let candidate = path.resolve(directory);
  while (true) {
    try {
      const stat = fs.statSync(candidate);
      return stat.isDirectory() && (() => {
        try { fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK); return true; }
        catch { return false; }
      })();
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

function doctor(configFile, electronOverride) {
  const paths = getPaths();
  let config, configError;
  try { config = loadConfigSnapshot(configFile).config; }
  catch (error) { configError = error.code || 'DOTDIAL_CONFIG_INVALID'; }
  const electron = electronPath(electronOverride);
  const mainExists = isFile(MAIN_SCRIPT);
  const launcherCommand = config?.network.signalingLauncher[0];
  const launcherFound = launcherCommand ? !!resolveExecutable(launcherCommand) : true;
  const wakeRuntime = config ? resolveWakeRuntime(config.wakeWord, paths) : null;
  const pythonFound = config?.wakeWord.enabled ? !!(wakeRuntime.python && resolveExecutable(wakeRuntime.python)) : null;
  const modelFound = config?.wakeWord.enabled ? wakeModelReady(wakeRuntime.model) : null;
  const socketLengthOk = Buffer.byteLength(paths.socketPath) < 104;
  const checks = {
    platformSupported: ['linux', 'darwin'].includes(process.platform),
    node: Number(process.versions.node.split('.')[0]) >= 22,
    config: !configError,
    electron: !!electron,
    mainScript: mainExists,
    configLockUtility: !!resolveExecutable(configLockCommand().command),
    configDirectoryWritable: writableDirectoryOrParent(path.dirname(configFile)),
    stateDirectoryWritable: writableDirectoryOrParent(paths.stateDir),
    dataDirectoryWritable: writableDirectoryOrParent(paths.dataDir),
    cacheDirectoryWritable: writableDirectoryOrParent(paths.cacheDir),
    runtimeDirectoryWritable: writableDirectoryOrParent(paths.runtimeDir),
    signalingLauncher: launcherFound,
    socketPathLength: socketLengthOk,
    wakeWordPython: pythonFound,
    wakeWordModel: modelFound,
  };
  const ok = Object.values(checks).every(value => value === null || value === true);
  writeJson({
    ok,
    platform: process.platform,
    architecture: process.arch,
    checks,
    paths: {
      configFile,
      stateDir: paths.stateDir,
      dataDir: paths.dataDir,
      cacheDir: paths.cacheDir,
      runtimeDir: paths.runtimeDir,
      socketPath: paths.socketPath,
      electron: electron || RUNTIME_ELECTRON,
      mainScript: MAIN_SCRIPT,
      ...(wakeRuntime ? { wakePython: wakeRuntime.python, wakeModel: wakeRuntime.model } : {}),
    },
    ...(configError ? { configError } : {}),
  });
  return ok ? 0 : 1;
}

function allowlistedEnvironment() {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY',
    'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS', 'PULSE_SERVER', 'LANG', 'LC_ALL', 'TMPDIR',
  ];
  return Object.fromEntries(allowed.filter(key => typeof process.env[key] === 'string')
    .map(key => [key, process.env[key]]));
}

function runApp(configFile, electronOverride, appOptions = []) {
  const snapshot = loadConfigSnapshot(configFile);
  if (!['linux', 'darwin'].includes(process.platform)) throw fail('DOTDIAL_PLATFORM_UNSUPPORTED', 'DotDial supports Linux and macOS');
  const electron = electronPath(electronOverride);
  if (!electron) throw fail('DOTDIAL_ELECTRON_MISSING', 'Pinned Electron runtime was not found; run the project install step or pass --electron');
  if (!fs.existsSync(MAIN_SCRIPT)) throw fail('DOTDIAL_MAIN_MISSING', 'DotDial Electron entry point was not found');
  const prefix = snapshot.config.network.signalingLauncher;
  const executable = prefix.length ? resolveExecutable(prefix[0]) : electron;
  if (!executable) throw fail('DOTDIAL_LAUNCHER_MISSING', 'Configured signaling launcher was not found in PATH');
  const prefixArgs = prefix.length ? prefix.slice(1) : [];
  const applicationArgs = PACKAGED_LAYOUT && electron === RUNTIME_ELECTRON ? [] : [MAIN_SCRIPT];
  const args = [
    ...prefixArgs,
    ...(prefix.length ? [electron] : []),
    ...applicationArgs,
    `--config=${configFile}`,
    `--profile=${getPaths().profileDir}`,
    ...appOptions,
  ];
  const child = spawn(executable, args, {
    cwd: PROJECT_ROOT,
    env: allowlistedEnvironment(),
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(fail('DOTDIAL_LAUNCH_FAILED', 'Could not start DotDial')));
    child.once('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

function sendAgentCommand(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let completed = false;
    const finish = (error, value) => {
      if (completed) return;
      completed = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(3000, () => finish(fail('DOTDIAL_AGENT_TIMEOUT', 'DotDial agent did not respond')));
    socket.once('connect', () => socket.write(`${command}\n`));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65_536) return finish(fail('DOTDIAL_AGENT_RESPONSE_TOO_LARGE', 'Agent response exceeded 64 KiB'));
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) {
        try { finish(null, JSON.parse(buffer.subarray(0, newline).toString('utf8'))); }
        catch { finish(fail('DOTDIAL_AGENT_RESPONSE_INVALID', 'Agent returned invalid JSON')); }
      }
    });
    socket.once('error', () => finish(fail('DOTDIAL_AGENT_UNAVAILABLE', 'DotDial agent is not running')));
    socket.once('end', () => {
      if (!completed && buffer.length) {
        try { finish(null, JSON.parse(buffer.toString('utf8'))); }
        catch { finish(fail('DOTDIAL_AGENT_RESPONSE_INVALID', 'Agent returned invalid JSON')); }
      } else if (!completed) finish(fail('DOTDIAL_AGENT_RESPONSE_EMPTY', 'DotDial agent closed without a response'));
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const global = parseGlobalOptions(argv);
  const [command, ...rest] = global.args;
  if (command === 'config') return parseConfigCommand(rest, global.configFile);
  if (command === 'doctor') {
    if (rest.length) throw fail('DOTDIAL_ARGUMENT_INVALID', 'doctor takes no positional arguments');
    return doctor(global.configFile, global.electron);
  }
  if (command === 'run') {
    if (rest.some(argument => argument !== '--settings') || rest.filter(argument => argument === '--settings').length > 1) {
      throw fail('DOTDIAL_ARGUMENT_INVALID', 'run accepts only the optional --settings switch');
    }
    return runApp(global.configFile, global.electron, rest);
  }
  const commands = {
    status: 'STATUS',
    call: 'WAKE',
    hangup: 'STOP',
    mute: 'MUTE',
    unmute: 'UNMUTE',
    'speakers-mute': 'SPEAKERS_MUTE',
    'speakers-unmute': 'SPEAKERS_UNMUTE',
    replay: 'MISSED_PLAY',
  };
  if (!Object.hasOwn(commands, command)) throw fail('DOTDIAL_COMMAND_UNKNOWN', `Unknown command: ${command}`);
  if (rest.length) throw fail('DOTDIAL_ARGUMENT_INVALID', `${command} takes no arguments`);
  if (global.configProvided) {
    throw fail('DOTDIAL_ARGUMENT_INVALID', '--config applies to config, doctor, and run; controls always target the default running instance');
  }
  writeJson(await sendAgentCommand(getPaths().socketPath, commands[command]));
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    const payload = {
      error: {
        code: /^[A-Z0-9_]{1,80}$/u.test(error.code || '') ? error.code : 'DOTDIAL_ERROR',
        message: error.message || 'DotDial command failed',
        ...(error.field ? { field: error.field } : {}),
      },
    };
    writeJson(payload, process.stderr);
    process.exitCode = 1;
  });
}

module.exports = { main, sendAgentCommand, setDotted };
