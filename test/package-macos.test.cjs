'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { validateBuild, appFileFilter, artifactStem, buildManifest, signingOptions, prepareAppSource, ensureElectronDistribution, readElectronChecksums, copyElectronNotices, verifyElectronNotices, BUNDLE_ID } = require('../scripts/package-macos.cjs');
const { runRequiredStages, parseJsonLine, verifyArtifactChecksums, verifySpeechFixtures } = require('../scripts/verify-macos-package.cjs');
const { createHash } = require('node:crypto');
const pkg = { name: 'dotdial', productName: 'DotDial', version: '0.1.0-beta.2', devDependencies: { electron: '44.5.1', '@electron/packager': '20.3.0' } };
const sha = 'a'.repeat(40);

function noticeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-electron-notices-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const electronDirectory = path.join(directory, 'electron');
  const distribution = path.join(electronDirectory, 'dist');
  const bundle = path.join(directory, 'DotDial.app');
  const resources = path.join(bundle, 'Contents', 'Resources');
  fs.mkdirSync(distribution, { recursive: true });
  fs.mkdirSync(path.join(resources, 'app'), { recursive: true });
  fs.writeFileSync(path.join(electronDirectory, 'package.json'), JSON.stringify({ version: '44.5.1' }));
  fs.writeFileSync(path.join(distribution, 'version'), '44.5.1');
  fs.writeFileSync(path.join(resources, 'app', 'LICENSE'), 'DotDial license fixture\n');
  // These deliberately small fixture bytes exercise preservation/provenance;
  // they do not claim to be upstream notices or a native application bundle.
  const contents = { LICENSE: 'Electron license fixture\n', 'LICENSES.chromium.html': '<p>Chromium notices fixture</p>\n' };
  for (const [name, bytes] of Object.entries(contents)) fs.writeFileSync(path.join(distribution, name), bytes);
  return { directory, electronDirectory, distribution, bundle, resources, contents };
}

test('macOS packaging explicitly prepares Electron 44 lazy distribution and checks its version and executable', t => {
  const { directory, electronDirectory, distribution, contents } = noticeFixture(t);
  fs.rmSync(distribution, { recursive: true });
  const installed = path.join(electronDirectory, 'install.js');
  // The ordinary Node fixture installer only writes test files. No native
  // binary is executed and no download, macOS API or signature is simulated.
  const writeInstaller = (version, makeExecutable = true) => fs.writeFileSync(installed, `
    const fs = require('node:fs');
    const path = require('node:path');
    const dist = path.join(__dirname, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'version'), ${JSON.stringify(version)});
    for (const [name, contents] of Object.entries(${JSON.stringify(contents)})) fs.writeFileSync(path.join(dist, name), contents);
    if (${makeExecutable}) {
      const binary = path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, 'Native executable placeholder; do not execute.', { mode: 0o755 });
    }
  `);
  writeInstaller('44.5.1');
  assert.throws(() => copyElectronNotices(electronDirectory, path.join(directory, 'before-install'), '44.5.1'), /Electron distribution version/);
  const readiness = ensureElectronDistribution(electronDirectory, '44.5.1');
  assert.equal(readiness.electronVersion, '44.5.1');
  assert.equal(fs.statSync(readiness.executable).isFile(), true);
  assert.doesNotThrow(() => copyElectronNotices(electronDirectory, path.join(directory, 'after-install'), '44.5.1'));
  assert.throws(() => ensureElectronDistribution(electronDirectory, '44.5.0'), /exact pinned npm package/);
  writeInstaller('44.5.0');
  assert.throws(() => ensureElectronDistribution(electronDirectory, '44.5.1'), /distribution version does not match/);
  fs.rmSync(distribution, { recursive: true });
  writeInstaller('44.5.1', false);
  assert.throws(() => ensureElectronDistribution(electronDirectory, '44.5.1'), /ENOENT|executable/);
});

test('pinned Electron checksums permit offline cache reuse and reject altered archive bytes', async t => {
  const { directory, electronDirectory } = noticeFixture(t);
  const filename = 'electron-v44.5.1-darwin-x64.zip';
  const checksumFile = path.join(electronDirectory, 'checksums.json');
  // Exercise the real downloader's hash/cache contract with small fixture bytes;
  // no network, archive extraction or native runtime is needed for this check.
  const bytes = Buffer.from('Electron archive checksum fixture; not a native distribution.');
  const pinned = { [filename]: createHash('sha256').update(bytes).digest('hex') };
  fs.writeFileSync(checksumFile, JSON.stringify(pinned));
  const checksums = readElectronChecksums(electronDirectory, '44.5.1', 'x64');
  assert.deepEqual(checksums, pinned);
  const { downloadArtifact } = await import('@electron/get');
  const requests = [];
  let allowTransfer = true;
  const options = { version: '44.5.1', artifactName: 'electron', platform: 'darwin', arch: 'x64',
    checksums, cacheRoot: path.join(directory, 'cache'), tempDirectory: directory,
    downloader: { async download(url, target) {
      requests.push(url);
      if (!allowTransfer) throw Error('fixture_downloader_offline');
      fs.writeFileSync(target, bytes);
    } } };
  const cached = await downloadArtifact(options);
  assert.equal(requests.length, 1, 'pinned checksums must avoid a separate checksum download');
  allowTransfer = false;
  assert.equal(await downloadArtifact(options), cached);
  assert.equal(requests.length, 1, 'a verified cached archive must work with no network');
  fs.writeFileSync(cached, 'altered archive bytes');
  await assert.rejects(downloadArtifact(options), /fixture_downloader_offline/);
  assert.equal(requests.length, 2, 'an altered archive must require a fresh download, never be accepted');
  assert.throws(() => readElectronChecksums(electronDirectory, '44.5.0', 'x64'), /must provide a SHA-256 checksum/);
  assert.throws(() => readElectronChecksums(electronDirectory, '44.5.1', 'arm64'), /must provide a SHA-256 checksum/);
  for (const invalid of [null, {}, { [filename]: 'invalid' }]) {
    fs.writeFileSync(checksumFile, JSON.stringify(invalid));
    assert.throws(() => readElectronChecksums(electronDirectory, '44.5.1', 'x64'), /must provide a SHA-256 checksum/);
  }
});

test('macOS packages preserve exact pinned Electron notices separately from the project license', t => {
  const fixture = noticeFixture(t);
  const { directory, electronDirectory, bundle, resources, contents } = fixture;
  assert.throws(() => verifyElectronNotices(bundle, electronDirectory, '44.5.1'), /Packaged Electron notice/,
    'the original package omission must fail acceptance');
  const staged = path.join(directory, 'electron-licenses');
  copyElectronNotices(electronDirectory, staged, '44.5.1');
  // Model only Packager extraResource's directory copy, without invoking any
  // platform APIs or asserting that this fixture is signed or runnable.
  fs.cpSync(staged, path.join(resources, 'electron-licenses'), { recursive: true });
  const report = verifyElectronNotices(bundle, electronDirectory, '44.5.1');
  assert.equal(report.electronVersion, '44.5.1');
  assert.equal(report.files.length, 2);
  for (const [name, bytes] of Object.entries(contents)) {
    const file = path.join(resources, 'electron-licenses', name);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    const record = report.files.find(entry => entry.bundledPath.endsWith('/' + name));
    assert.equal(record.sourcePath, 'node_modules/electron/dist/' + name);
    assert.equal(record.sourceSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(record.bundledSha256, record.sourceSha256);
    assert.equal(record.bytes, Buffer.byteLength(bytes));
  }
  assert.equal(fs.readFileSync(path.join(resources, 'app', 'LICENSE'), 'utf8'), 'DotDial license fixture\n');
  assert.throws(() => copyElectronNotices(electronDirectory, path.join(directory, 'wrong-version'), '44.5.0'), /exact installed runtime version/);
  assert.throws(() => verifyElectronNotices(bundle, electronDirectory, '44.5.0'), /exact installed runtime version/);
});

test('macOS packaging refuses missing, empty or nonregular upstream Electron notices', t => {
  const { directory, electronDirectory, distribution, contents } = noticeFixture(t);
  for (const [name, bytes] of Object.entries(contents)) {
    const file = path.join(distribution, name);
    for (const kind of ['missing', 'empty', 'directory', 'symlink']) {
      fs.rmSync(file, { recursive: true, force: true });
      if (kind === 'empty') fs.writeFileSync(file, '');
      if (kind === 'directory') fs.mkdirSync(file);
      if (kind === 'symlink') fs.symlinkSync(path.join(electronDirectory, 'package.json'), file);
      const destination = path.join(directory, `stage-${name}-${kind}`);
      assert.throws(() => copyElectronNotices(electronDirectory, destination, '44.5.1'), /Electron distribution notice.*nonempty regular file/);
      assert.equal(fs.existsSync(destination), false, 'invalid upstream notices cannot create partial resources');
    }
    fs.rmSync(file, { recursive: true, force: true });
    fs.writeFileSync(file, bytes);
  }
});

test('macOS acceptance rejects missing, empty and substituted bundled notices against the installed runtime', t => {
  const { electronDirectory, distribution, bundle, resources, contents } = noticeFixture(t);
  const destination = path.join(resources, 'electron-licenses');
  copyElectronNotices(electronDirectory, destination, '44.5.1');
  for (const [name, bytes] of Object.entries(contents)) {
    const file = path.join(destination, name);
    fs.unlinkSync(file);
    assert.throws(() => verifyElectronNotices(bundle, electronDirectory, '44.5.1'), /Packaged Electron notice.*nonempty regular file/);
    fs.writeFileSync(file, '');
    assert.throws(() => verifyElectronNotices(bundle, electronDirectory, '44.5.1'), /Packaged Electron notice.*nonempty regular file/);
    fs.writeFileSync(file, 'nonempty substituted notice\n');
    assert.throws(() => verifyElectronNotices(bundle, electronDirectory, '44.5.1'), /differs from the installed runtime/);
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(path.join(distribution, name), 'changed upstream reference\n');
    assert.throws(() => verifyElectronNotices(bundle, electronDirectory, '44.5.1'), /differs from the installed runtime/);
    fs.writeFileSync(path.join(distribution, name), bytes);
  }
  assert.equal(verifyElectronNotices(bundle, electronDirectory, '44.5.1').files.length, 2);
});

test('artifact checksums reject duplicate substitution, missing files, unsafe names and altered bytes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-checksums-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = ['preview.app.zip', 'preview.dmg', 'preview.manifest.json'];
  const digest = value => createHash('sha256').update(value).digest('hex');
  for (const file of files) fs.writeFileSync(path.join(directory, file), file);
  const rows = files.map(file => `${digest(file)}  ${file}`);
  const write = entries => fs.writeFileSync(path.join(directory, 'SHA256SUMS'), entries.join('\n') + '\n');
  const verify = () => verifyArtifactChecksums(directory, files.map(file => path.join(directory, file)));
  write([...rows].reverse());
  assert.equal((await verify()).length, 3, 'order does not change the exact set');
  for (const invalid of [[rows[2], rows[2], rows[2]], rows.slice(1), [...rows, rows[0]],
    [rows[0], rows[1], `${digest('other')}  other.json`]]) {
    write(invalid);
    await assert.rejects(verify, /each expected artifact exactly once/);
  }
  write([rows[0], rows[1], `${digest('other')}  ../other.json`]);
  await assert.rejects(verify, /bounded artifact basenames/);
  write(rows);
  fs.writeFileSync(path.join(directory, files[0]), 'altered installer');
  await assert.rejects(verify, /SHA-256 mismatch/);
});

test('speech fixture provenance binds exact source, native architecture, phrases and WAV bytes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-speech-provenance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provenance = { prepareWakeSpeech: 'passed', success: true, sourceRepository: 'https://github.com/festvox/flite',
    sourceCommit: '6c9f20dc915b17f5619340069889db0aa007fcdc', sourceCleanBeforeBuild: true,
    generator: 'Flite', voice: 'slt', hostPlatform: 'darwin', hostMachine: 'arm64', fixtures: {} };
  for (const [name, text] of [['positive', 'Hey Dot.'], ['negative', 'The weather is calm today.']]) {
    // WAV format validation belongs to the real smoke; this gate binds the
    // caller's rendered bytes to the generator's separately recorded output.
    const bytes = Buffer.from(`fixture bytes: ${text}`);
    fs.writeFileSync(path.join(directory, `${name}.wav`), bytes);
    provenance.fixtures[name] = { text, voice: 'slt', sampleRate: 16000, channels: 1,
      sampleFormat: 'pcm16le', sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const write = value => fs.writeFileSync(path.join(directory, 'provenance.json'), JSON.stringify(value));
  write(provenance);
  assert.deepEqual(await verifySpeechFixtures(directory, 'arm64'), provenance);
  await assert.rejects(() => verifySpeechFixtures(directory, 'x64'));
  for (const override of [{ success: false }, { sourceCommit: 'a'.repeat(40) }, { sourceCleanBeforeBuild: false },
    { hostPlatform: 'linux' }, { voice: 'unknown' }]) {
    write({ ...provenance, ...override });
    await assert.rejects(() => verifySpeechFixtures(directory, 'arm64'));
  }
  write({ ...provenance, fixtures: { ...provenance.fixtures,
    positive: { ...provenance.fixtures.positive, text: 'Another phrase.' } } });
  await assert.rejects(() => verifySpeechFixtures(directory, 'arm64'), /exact synthetic speech text/);
  write(provenance);
  fs.writeFileSync(path.join(directory, 'positive.wav'), 'substituted speech');
  await assert.rejects(() => verifySpeechFixtures(directory, 'arm64'), /rendered speech agrees with its provenance/);
});

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
