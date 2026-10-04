'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MODEL = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const MODEL_FILES = [
  'tokens.txt', 'bpe.model',
  'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
];

function resolveWakeRuntime(config, paths) {
  const local = path.join(paths.dataDir, 'wake-venv', 'bin', 'python');
  return {
    python: config.pythonPath === 'python3' && fs.existsSync(local) ? local : config.pythonPath,
    model: config.modelPath || path.join(paths.dataDir, 'models', MODEL),
  };
}

function wakeModelReady(directory) {
  try {
    return fs.statSync(directory).isDirectory() && MODEL_FILES.every(name => {
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      fs.accessSync(file, fs.constants.R_OK);
      return stat.isFile() && stat.size > 0;
    });
  } catch { return false; }
}

module.exports = { MODEL, MODEL_FILES, resolveWakeRuntime, wakeModelReady };
