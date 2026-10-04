'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { validateBuild, appFileFilter, artifactStem, buildManifest, signingOptions, writeCliLauncher, BUNDLE_ID } = require('../scripts/package-macos.cjs');
const pkg = { name: 'dotdial', productName: 'DotDial', version: '0.1.0-beta.2', devDependencies: { electron: '44.5.1', '@electron/packager': '20.3.0' } };
const sha = 'a'.repeat(40);

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
  for (const file of ['src/test.test.mjs', 'src/.env', 'src/__pycache__/listener.pyc', 'src/debug.tmp', 'bin/.token', 'scripts/smoke-ui.cjs', 'scripts/package-macos.cjs', 'node_modules/electron', 'profile/Cookies', 'dist/old.app.zip']) {
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
});

test('bundled CLI resolves a path containing spaces without system Node or shell utilities', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-cli-launcher-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'Path with spaces', 'DotDial.app');
  const appSource = path.join(bundle, 'Contents', 'Resources', 'app');
  const macos = path.join(bundle, 'Contents', 'MacOS');
  const emptyPath = path.join(directory, 'empty-path');
  for (const entry of [appSource, macos, emptyPath]) fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(macos, 'DotDial'), '#!/bin/sh\nprintf \'%s\\n\' "$ELECTRON_RUN_AS_NODE" "$@"\n', { mode: 0o755 });
  const launcher = writeCliLauncher(appSource);
  assert.equal(path.basename(launcher), 'dotdial-cli');
  const result = spawnSync(launcher, ['config', 'set', 'dot.displayName', '"quoted name with spaces"'], {
    encoding: 'utf8', env: { PATH: emptyPath }, timeout: 5000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const [nodeMode, script, ...args] = result.stdout.trim().split('\n');
  assert.equal(nodeMode, '1');
  assert.equal(path.resolve(script), path.join(appSource, 'bin', 'dotdial.cjs'));
  assert.deepEqual(args, ['config', 'set', 'dot.displayName', '"quoted name with spaces"']);
});
