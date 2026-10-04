'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { validateBuild, appFileFilter, artifactStem, buildManifest, signingOptions, prepareAppSource, BUNDLE_ID } = require('../scripts/package-macos.cjs');
const { runRequiredStages, parseJsonLine } = require('../scripts/verify-macos-package.cjs');
const pkg = { name: 'dotdial', productName: 'DotDial', version: '0.1.0-beta.2', devDependencies: { electron: '44.5.1', '@electron/packager': '20.3.0' } };
const sha = 'a'.repeat(40);

test('smoke report parsing rejects contradictory or duplicate reports', () => {
  assert.deepEqual(parseJsonLine('Chromium log\nnull\n{"packagedSmoke":"passed"}\n', 'packagedSmoke'), { packagedSmoke: 'passed' });
  assert.deepEqual(parseJsonLine('{"packagedSmoke":"failed"}', 'packagedSmoke'), { packagedSmoke: 'failed' });
  for (const output of [
    '{"packagedSmoke":"failed"}\n{"packagedSmoke":"passed"}',
    '{"packagedSmoke":"passed"}\n{"packagedSmoke":"failed"}',
    '{"packagedSmoke":"passed"}\n{"packagedSmoke":"passed"}',
    'Chromium log without a report',
  ]) assert.throws(() => parseJsonLine(output, 'packagedSmoke'), /exactly one/);
});

test('macOS packaging requires a native supported architecture and exact installed pins', () => {
  const input = { platform: 'darwin', arch: 'arm64', pkg, electronVersion: '44.5.1', packagerVersion: '20.3.0' };
  assert.doesNotThrow(() => validateBuild(input));
  assert.doesNotThrow(() => validateBuild({ ...input, arch: 'x64' }));
  assert.throws(() => validateBuild({ ...input, platform: 'linux' }), /natively/);
  assert.throws(() => validateBuild({ ...input, arch: 'universal' }), /natively/);
  assert.throws(() => validateBuild({ ...input, electronVersion: '44.5.0' }), /pinned/);
  assert.throws(() => validateBuild({ ...input, packagerVersion: '20.0.0' }), /pinned/);
});

test('macOS archive allows runtime components and rejects private/build/test debris', () => {
  const root = path.resolve('/tmp/dotdial-package-source');
  for (const file of ['src/main.cjs', 'src/ui/preload.cjs', 'src/sounds/calling.wav', 'scripts/setup-wake.py', 'scripts/smoke-packaged.cjs', 'bin/dotdial.cjs']) {
    assert.equal(appFileFilter(path.join(root, file), root), false, file);
    assert.equal(appFileFilter('/' + file, root), false, file);
  }
  for (const file of ['src/test.test.mjs', 'src/.env', 'src/__pycache__/listener.pyc', 'src/debug.tmp', 'bin/.token', 'scripts/smoke-ui.cjs', 'scripts/package-macos.cjs', 'scripts/native/dotdial-lock.c', 'build/native/dotdial-lock', 'node_modules/electron', 'profile/Cookies', 'dist/old.app.zip']) {
    assert.equal(appFileFilter(path.join(root, file), root), true, file);
  }
});

test('preview artifacts identify exact source and never claim Developer ID or notarization', () => {
  const manifest = buildManifest({ pkg, arch: 'arm64', sourceSha: sha, sourceDirty: false, preview: true });
  assert.equal(manifest.sourceCommit, sha);
  assert.equal(manifest.architecture, 'arm64');
  assert.equal(manifest.bundleIdentifier, BUNDLE_ID);
  assert.equal(manifest.minimumMacOS, '13.0');
  assert.equal(manifest.distribution, 'preview');
  assert.equal(manifest.codeSignature, 'ad-hoc');
  assert.equal(manifest.developerIDSigned, false);
  assert.equal(manifest.notarized, false);
  assert.match(artifactStem(pkg.version, 'arm64', sha, true), /-preview-aaaaaaaa-macos-arm64$/);
  assert.equal(artifactStem(pkg.version, 'x64', sha), 'DotDial-0.1.0-beta.2-macos-x64');
  assert.throws(() => artifactStem(pkg.version, '../invalid', sha), /Invalid/);
  assert.throws(() => artifactStem(pkg.version, 'x64', 'uncommitted'), /Invalid/);
});

test('ad-hoc signing is mandatory and needs no credentials or timestamp service', () => {
  const options = signingOptions();
  assert.equal(options.identity, '-');
  assert.equal(options.identityValidation, false);
  assert.equal(options.continueOnError, false);
  assert.equal(options.strictVerify, true);
  const main = options.optionsForFile('/tmp/DotDial.app');
  assert.equal(main.timestamp, 'none');
  assert.equal(main.hardenedRuntime, true);
  assert.ok(main.entitlements.includes('com.apple.security.device.audio-input'));
  assert.ok(!main.entitlements.includes('com.apple.security.device.camera'));
  assert.equal(options.optionsForFile('/tmp/DotDial.app/Contents/Frameworks/DotDial Helper (Renderer).app').entitlements, undefined);
  assert.deepEqual(options.optionsForFile('/tmp/DotDial.app/Contents/Resources/dotdial-lock').entitlements, [],
    'the native lock helper needs no JIT, microphone, or other extra entitlement');
});

test('the pinned Packager hook prepares a Node-independent CLI that handles spaces', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-cli-launcher-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'Path with spaces', 'DotDial.app');
  const appSource = path.join(bundle, 'Contents', 'Resources', 'app');
  const macos = path.join(bundle, 'Contents', 'MacOS');
  const emptyPath = path.join(directory, 'empty-path');
  for (const entry of [appSource, macos, emptyPath]) fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(macos, 'DotDial'), '#!/bin/sh\nprintf \'%s\\n\' "$ELECTRON_RUN_AS_NODE" "$@"\n', { mode: 0o755 });
  const sourceFile = path.join(appSource, 'package.json');
  fs.writeFileSync(sourceFile, '{}', { mode: 0o600 });
  const hooksFile = path.join(path.dirname(require.resolve('@electron/packager')), 'hooks.js');
  const { runHooks } = await import(pathToFileURL(hooksFile).href);
  await runHooks([prepareAppSource], { buildPath: appSource, electronVersion: '44.5.1', platform: 'darwin', arch: 'arm64' });
  assert.equal(fs.statSync(sourceFile).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(macos, 'DotDial')).mode & 0o777, 0o755, 'source normalization must not alter the runtime executable');
  const launcher = path.join(bundle, 'Contents', 'Resources', 'dotdial-cli');
  const result = spawnSync(launcher, ['config', 'set', 'dot.displayName', '"quoted name with spaces"'], {
    encoding: 'utf8', env: { PATH: emptyPath }, timeout: 5000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const [nodeMode, script, ...args] = result.stdout.trim().split('\n');
  assert.equal(nodeMode, '1');
  assert.equal(path.resolve(script), path.join(fs.realpathSync(appSource), 'bin', 'dotdial.cjs'));
  assert.deepEqual(args, ['config', 'set', 'dot.displayName', '"quoted name with spaces"']);
});

test('native verification collects independent failures without relaxing any success gate', async () => {
  const calls = [], recorded = [], evidence = {};
  await assert.rejects(runRequiredStages([
    ['gui', async () => { calls.push('gui'); throw Error('synthetic_capture_failure'); }],
    ['worker', async () => { calls.push('worker'); }],
    ['wake', async () => { calls.push('wake'); throw Error('synthetic_decoder_failure'); }],
    ['dmg', async () => { calls.push('dmg'); }],
  ], evidence, name => recorded.push(name)), /checks failed: gui, wake/);
  assert.deepEqual(calls, ['gui', 'worker', 'wake', 'dmg']);
  assert.deepEqual(recorded, calls);
  assert.equal(evidence.macOSPackageVerified, false);
  assert.equal(evidence.stages.gui.status, 'failed');
  assert.equal(evidence.stages.wake.status, 'failed');
  assert.equal(evidence.stages.worker.status, 'passed');
  assert.equal(evidence.stages.dmg.status, 'passed');
  const passed = {};
  await runRequiredStages([['required', async () => {}]], passed);
  assert.equal(passed.macOSPackageVerified, true);
});
