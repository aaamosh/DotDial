'use strict';

// Counterfactual native decoder measurements. Never modifies the app, model,
// user settings or twelve mandatory recognition-to-routing acceptance cases.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const wrapper = `
import runpy, sys, sherpa_onnx
listener, paths, precision, *arguments = sys.argv[1:]
original = sherpa_onnx.KeywordSpotter
def diagnostic_spotter(**options):
    options['max_active_paths'] = int(paths)
    for part in ('encoder', 'decoder', 'joiner'):
        if precision == 'all' or precision == part:
            options[part] = options[part].replace('.int8.onnx', '.onnx')
    return original(**options)
sherpa_onnx.KeywordSpotter = diagnostic_spotter
sys.argv = [listener, *arguments]
runpy.run_path(listener, run_name='__main__')
`;
function compareDecoder({ python, source, data, model, wake, commands, pcm, report }) {
  report.recognitionComparison = [];
  for (const [paths, precision] of [[4, 'none'], [8, 'none'], [16, 'none'], [4, 'encoder'], [4, 'all']]) {
    const start = performance.now();
    const result = spawnSync(python, ['-I', '-c', wrapper,
      path.join(source, 'src/wake/listener.py'), String(paths), precision,
      '--stdin-audio', '--model', path.join(data, 'models', model), '--phrase', wake,
      '--sensitivity', '6', '--commands-json', JSON.stringify(commands)],
    { input: pcm, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    const observation = { maxActivePaths: paths, fp32: precision,
      pcmSha256: crypto.createHash('sha256').update(pcm).digest('hex'),
      elapsedMs: performance.now() - start, exitCode: result.status,
      stdout: result.stdout || '', error: result.error?.code || null };
    report.recognitionComparison.push(observation);
    assert.equal(result.error, undefined, 'counterfactual decoder exits within its bound');
    assert.equal(result.status, 0, result.stderr);
  }
}
module.exports = { compareDecoder };
