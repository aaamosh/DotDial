'use strict';

// One-time diagnosis. Completing this comparison does not accept a release:
// every variant keeps the existing smoke's independent pass/fail result.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runPosixSmoke } = require('./posix-smoke-supervisor.cjs');

const ROOT = path.resolve(__dirname, '..');
const CONSTRUCTOR = "new AudioContext({ sampleRate: 16000, sinkId: { type: 'none' } })";
const VARIANTS = [
  { name: 'default-interactive', constructor: "new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })" },
  { name: 'none-100ms', constructor: "new AudioContext({ sampleRate: 16000, sinkId: { type: 'none' }, latencyHint: 0.1 })" },
  { name: 'none-250ms', constructor: "new AudioContext({ sampleRate: 16000, sinkId: { type: 'none' }, latencyHint: 0.25 })" },
];
const hash = value => createHash('sha256').update(value).digest('hex');
function argument(name) {
  const index = process.argv.indexOf(name), value = process.argv[index + 1];
  assert.ok(index >= 0 && value && !value.startsWith('--'), `${name} PATH is required`);
  return path.resolve(value);
}
function sourceFiles(root) {
  const files = [];
  const visit = relative => {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    assert.ok(!stat.isSymbolicLink(), `Unexpected source symlink: ${relative}`);
    if (stat.isDirectory()) for (const child of fs.readdirSync(full).sort()) visit(path.join(relative, child));
    else { assert.ok(stat.isFile()); files.push(relative); }
  };
  for (const relative of ['src', 'scripts', 'package.json']) visit(relative);
  return files;
}
function captureSummary(capture, index) {
  const t = capture.timing, samples = t.chunks;
  const requested = t.observation?.requestedChunks;
  const lastRequested = samples.find(sample => sample.chunk === requested);
  return {
    capture: index, acknowledged: capture.writesAcknowledged,
    observationMs: t.observation?.elapsedMs ?? null,
    firstPcmAfterReadyMs: t.firstPcmAtMs === null || t.readyAtMs === null ? null : t.firstPcmAtMs - t.readyAtMs,
    firstToRequestedPcmMs: lastRequested && t.firstPcmAtMs !== null ? lastRequested.pcmAtMs - t.firstPcmAtMs : null,
    expectedFirstToRequestedPcmMs: requested ? (requested - 1) * 100 : null,
    maxPcmGapMs: t.maxPcmGapMs, maxAckLatencyMs: t.maxAckLatencyMs,
  };
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Run the comparison on a native macOS host');
  if (process.env.DOTDIAL_TARGET_ARCH) assert.equal(process.arch, process.env.DOTDIAL_TARGET_ARCH);
  const data = argument('--data-dir'), output = argument('--output-dir');
  assert.ok(fs.existsSync(path.join(data, 'wake-venv', 'bin', 'python')), 'Prepare the managed wake environment first');
  fs.mkdirSync(output, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'dotdial-clock-fixtures-'));
  const original = fs.readFileSync(path.join(ROOT, 'src', 'wake_renderer.js'), 'utf8');
  assert.equal(original.split(CONSTRUCTOR).length - 1, 1, 'Expected exactly one known AudioContext constructor');
  assert.equal((original.match(/new AudioContext\(/g) || []).length, 1);
  const files = sourceFiles(ROOT);
  const summary = {
    diagnosticComparison: 'running', releaseAcceptance: 'not_evaluated',
    hostPlatform: process.platform, hostArch: process.arch, node: process.version,
    sourceCommit: process.env.GITHUB_SHA || null, originalRendererSha256: hash(original),
    resumeCycles: 4, audioClockDiagnostics: false, variants: [], harnessErrors: [],
  };
  try {
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    const electron = require('electron');
    for (const variant of VARIANTS) {
      const fixture = path.join(temporary, variant.name);
      fs.mkdirSync(fixture);
      for (const relative of ['src', 'scripts', 'package.json']) fs.cpSync(path.join(ROOT, relative), path.join(fixture, relative), { recursive: true });
      const changed = original.replace(CONSTRUCTOR, variant.constructor);
      fs.writeFileSync(path.join(fixture, 'src', 'wake_renderer.js'), changed);
      assert.deepEqual(sourceFiles(fixture), files, 'Fixture source inventory must stay identical');
      for (const relative of files) {
        const expected = relative === path.join('src', 'wake_renderer.js') ? Buffer.from(changed) : fs.readFileSync(path.join(ROOT, relative));
        assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), expected, `Unexpected fixture difference: ${relative}`);
      }
      const reportPath = path.join(output, `${variant.name}.json`);
      fs.rmSync(reportPath, { force: true });
      const result = { name: variant.name, constructor: variant.constructor,
        rendererSha256: hash(changed), status: 'not_run', report: path.basename(reportPath) };
      summary.variants.push(result);
      let outcome, executionError;
      try {
        outcome = await runPosixSmoke(electron, [path.join(fixture, 'scripts', 'smoke-wake-pipeline.cjs'),
          '--data-dir', data, '--app-source', fixture, '--output', reportPath, '--resume-cycles', '4'],
        { cwd: fixture, env, timeout: 180_000 });
      } catch (error) {
        executionError = error;
        fs.writeFileSync(path.join(output, `${variant.name}.run-error.log`), String(error.stack || error).slice(0, 128 * 1024) + '\n');
      }
      result.supervision = outcome?.supervision || executionError?.supervision || null;
      if (executionError) result.executionError = executionError.message.split('\n')[0];
      try {
        assert.ok(fs.existsSync(reportPath), 'Smoke did not write its report');
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        assert.ok(['passed', 'failed'].includes(report.wakePipelineSmoke));
        result.status = report.wakePipelineSmoke;
        result.error = report.error || null;
        result.wallMinusMonotonicMs = report.wallMinusMonotonicMs;
        result.captures = report.captures.map(captureSummary);
        assert.equal(report.hostPlatform, 'darwin');
        assert.equal(report.hostArch, process.arch);
        assert.equal(report.sourceRoot, fixture);
        assert.equal(report.resumeCycles, 4);
        assert.equal(report.audioClockDiagnostics, false);
        assert.deepEqual(report.cleanupErrors, [], 'Smoke cleanup failed');
        assert.equal(report.captureWindowsRemaining, 0);
        assert.ok(report.detectors.every(detector => detector.exited), 'Detector was not reaped');
        assert.ok(report.captures.every(capture => capture.closed && capture.callbacksAfterClose === 0), 'Capture cleanup failed');
        assert.equal(Boolean(executionError), report.wakePipelineSmoke === 'failed', 'Process exit and smoke report disagree');
        if (outcome) {
          const emitted = outcome.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
            .filter(value => Object.hasOwn(value, 'wakePipelineSmoke'));
          assert.deepEqual(emitted, [report], 'File and stdout report disagree');
        }
      } catch (error) {
        result.harnessError = error.message;
        summary.harnessErrors.push(`${variant.name}: ${error.message}`);
      }
      const supervision = result.supervision;
      const clean = supervision?.ready && supervision.ownerExited && supervision.outputClosed &&
        !supervision.forcedCleanup && supervision.survivingPids.length === 0;
      if (!clean) summary.harnessErrors.push(`${variant.name}: POSIX supervision or process cleanup failed`);
      console.log(JSON.stringify({ diagnosticVariant: result }));
      // A failed throughput gate is valid evidence. Failed cleanup would
      // contaminate later variants, so do not continue after that failure.
      if (!clean) break;
    }
  } catch (error) {
    summary.harnessErrors.push(String(error.message || error));
  } finally {
    try { fs.rmSync(temporary, { recursive: true, force: true }); }
    catch (error) { summary.harnessErrors.push(`fixture_cleanup_failed: ${error.message}`); }
    summary.diagnosticComparison = summary.harnessErrors.length || summary.variants.length !== VARIANTS.length ? 'failed' : 'complete';
    fs.writeFileSync(path.join(output, 'comparison.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary));
    if (summary.diagnosticComparison !== 'complete') process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
