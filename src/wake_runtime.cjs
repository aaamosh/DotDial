'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MODEL = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const SUPPORTED_PYTHON = ['3.13', '3.12', '3.11', '3.10'];
const failure = code => Object.assign(new Error(code), { code });

// Resolving paths is deliberately separate from executing an interpreter: the
// CLI doctor can show the effective runtime without opening a microphone or
// starting a subprocess. On macOS the chosen Python creates the managed wake
// environment; subsequent listener starts must use that environment's packages.
// Linux keeps its existing explicit-runtime override behavior.
function pythonCandidates(config = {}, paths = {}, {
  platform = process.platform, env = process.env, existsSync = fs.existsSync, forSetup = false,
} = {}) {
  const local = paths.dataDir && path.join(paths.dataDir, 'wake-venv', 'bin', 'python');
  if (platform === 'darwin' && !forSetup && local && existsSync(local)) return [local];
  if (config.pythonPath && config.pythonPath !== 'python3') return [config.pythonPath];
  if (local && existsSync(local)) return [local];
  if (platform !== 'darwin') return ['python3'];
  const candidates = [];
  const add = candidate => {
    // Apple's developer-tools stub can open an installation dialog merely on
    // --version. Automatic discovery never invokes it. Explicit paths are honored.
    if (candidate === '/usr/bin/python3' || !existsSync(candidate) || candidates.includes(candidate)) return;
    candidates.push(candidate);
  };
  const directories = (env.PATH || '').split(path.delimiter).filter(item => path.isAbsolute(item)).slice(0, 40);
  for (const version of SUPPORTED_PYTHON) {
    for (const directory of directories) add(path.join(directory, `python${version}`));
    for (const prefix of ['/opt/homebrew', '/usr/local']) {
      add(path.join(prefix, 'bin', `python${version}`));
      add(path.join(prefix, 'opt', `python@${version}`, 'bin', `python${version}`));
    }
    add(`/Library/Frameworks/Python.framework/Versions/${version}/bin/python${version}`);
  }
  for (const directory of directories) add(path.join(directory, 'python3'));
  add('/opt/homebrew/bin/python3');
  add('/usr/local/bin/python3');
  return candidates.slice(0, 12);
}

function resolveWakeRuntime(config = {}, paths, options = {}) {
  const candidates = pythonCandidates(config, paths, options);
  return {
    python: candidates[0] || null,
    model: config.modelPath || path.join(paths.dataDir, 'models', MODEL),
  };
}

function checkPython(python, { execFile: execute = execFile, timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    execute(python, ['-c', 'import json,sys; print(json.dumps(list(sys.version_info[:3])))'],
      { timeout: timeoutMs, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
        if (error) { reject(failure('wake_python_unavailable')); return; }
        let version;
        try { version = JSON.parse(String(stdout).trim()); } catch {}
        if (!Array.isArray(version) || version.length !== 3 || version.some(value => !Number.isInteger(value))) {
          reject(failure('wake_python_unavailable')); return;
        }
        if (version[0] !== 3 || version[1] < 10 || version[1] > 13) {
          reject(failure('wake_python_version_unsupported')); return;
        }
        resolve({ python, version });
      });
  });
}

async function findWakePython(config, paths, options = {}) {
  const candidates = pythonCandidates(config, paths, options);
  let incompatible = false;
  for (const python of candidates) {
    try { return (await checkPython(python, options)).python; }
    catch (error) { incompatible ||= error.code === 'wake_python_version_unsupported'; }
  }
  throw failure(incompatible ? 'wake_python_version_unsupported' : 'wake_python_unavailable');
}

module.exports = { MODEL, resolveWakeRuntime, pythonCandidates, checkPython, findWakePython };
