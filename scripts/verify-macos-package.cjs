#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256, verifyBundle, BUNDLE_ID, MICROPHONE_DESCRIPTION } = require('./package-macos.cjs');

const ROOT = path.resolve(__dirname, '..');

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.status !== 0 || result.error) {
    throw Error(`${path.basename(file)} failed (${result.status ?? result.signal ?? result.error?.code}):\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  return result;
}

function exactlyOne(directory, suffix) {
  const matches = fs.readdirSync(directory).filter(name => name.endsWith(suffix));
  if (matches.length !== 1) throw Error(`Expected one ${suffix} in ${directory}.`);
  return path.join(directory, matches[0]);
}

function verifyHelpers(bundle) {
  const frameworks = path.join(bundle, 'Contents', 'Frameworks');
  const helpers = fs.readdirSync(frameworks).filter(name => name.startsWith('DotDial Helper') && name.endsWith('.app'));
  assert.ok(helpers.length >= 3, 'Electron helper apps are bundled');
  for (const helper of helpers) {
    const file = path.join(frameworks, helper, 'Contents', 'Info.plist');
    const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]).stdout);
    assert.equal(plist.NSMicrophoneUsageDescription, MICROPHONE_DESCRIPTION, `${helper} has its microphone usage explanation`);
    assert.ok(plist.CFBundleIdentifier.startsWith(BUNDLE_ID + '.helper'), `${helper} uses the DotDial identity`);
  }
  return helpers;
}

function parseJsonLine(stdout, expectedField) {
  for (const line of stdout.trim().split('\n').reverse()) {
    try { const value = JSON.parse(line); if (Object.hasOwn(value, expectedField)) return value; } catch {}
  }
  throw Error(`Smoke result ${expectedField} was not emitted:\n${stdout}`);
}

async function main() {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw Error('Run package verification on its native macOS architecture.');
  const directory = path.join(ROOT, 'dist', `macos-${process.arch}`);
  const zip = exactlyOne(directory, '.app.zip');
  const dmg = exactlyOne(directory, '.dmg');
  const sidecar = exactlyOne(directory, '.manifest.json');
  const manifest = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  assert.equal(manifest.architecture, process.arch);
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.codeSignature, 'ad-hoc');
  assert.equal(manifest.developerIDSigned, false);
  assert.equal(manifest.notarized, false);
  if (process.env.GITHUB_SHA) assert.equal(manifest.sourceCommit, process.env.GITHUB_SHA);
  if (process.env.CI) assert.equal(manifest.sourceDirty, false, 'CI must package the committed tree');
  const sums = fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 3);
  for (const row of sums) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(row);
    assert.ok(match, 'checksum entries are bounded artifact basenames');
    assert.equal(await sha256(path.join(directory, match[2])), match[1]);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-package-check-'));
  const reportDirectory = path.join(ROOT, 'build', 'macos-qa', process.arch);
  fs.mkdirSync(reportDirectory, { recursive: true });
  let mounted = false;
  const mount = path.join(temporary, 'disk');
  const evidence = { manifest, checksums: true };
  try {
    const unpacked = path.join(temporary, 'unpacked');
    run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
    const bundle = path.join(unpacked, 'DotDial.app');
    const { executable, launcher, architecture } = verifyBundle(bundle, manifest);
    evidence.architecture = architecture;
    evidence.helpers = verifyHelpers(bundle);
    const signing = run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
    assert.match(signing.stderr, /Signature=adhoc/, 'preview is accurately classified as ad-hoc signed');
    const embedded = JSON.parse(fs.readFileSync(path.join(bundle, 'Contents', 'Resources', 'dotdial-build.json'), 'utf8'));
    assert.deepEqual(embedded, manifest);

    const noNode = path.join(temporary, 'path-without-node');
    fs.mkdirSync(noNode);
    const env = { ...process.env, PATH: noNode, TMPDIR: temporary,
      XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_STATE_HOME: path.join(temporary, 'state'),
      XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
      XDG_RUNTIME_DIR: path.join(temporary, 'run') };
    delete env.ELECTRON_RUN_AS_NODE;
    const configFile = path.join(env.XDG_CONFIG_HOME, 'dotdial', 'config.json');
    assert.equal(run(launcher, ['config', 'path'], { env }).stdout.trim(), configFile);
    const initial = JSON.parse(run(launcher, ['config', 'show'], { env }).stdout);
    assert.equal(initial.hash, null);
    assert.equal(initial.config.wakeWord.enabled, false);
    const save = JSON.parse(run(launcher, ['config', 'set', 'dot.displayName', '"macOS package smoke"'], { env }).stdout);
    assert.equal(save.saved, true);
    const readback = JSON.parse(run(launcher, ['config', 'show'], { env }).stdout);
    assert.equal(readback.config.dot.displayName, 'macOS package smoke');
    const diagnostic = JSON.parse(run(launcher, ['doctor'], { env }).stdout);
    assert.equal(diagnostic.ok, true, 'installed CLI resolves its bundled macOS runtime without system Node');
    evidence.bundledCliWithoutSystemNode = true;
    evidence.cliLauncher = 'Contents/Resources/dotdial-cli';
    evidence.doctor = diagnostic.checks;

    const guiEnv = { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', DOTDIAL_SMOKE_OUTPUT_DIR: reportDirectory };
    delete guiEnv.ELECTRON_RUN_AS_NODE;
    // GitHub's Intel macOS VM has no usable EGL display. Use its software
    // compositor for CI screenshots; normal application launches are unchanged.
    const graphicsArgs = process.arch === 'x64' ? ['--disable-gpu'] : [];
    const gui = run(executable, [...graphicsArgs, '--demo', '--smoke-test', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'], { env: guiEnv });
    evidence.gui = parseJsonLine(gui.stdout, 'packagedSmoke');
    assert.equal(evidence.gui.packagedSmoke, 'passed');
    const worker = run(executable, [path.join(__dirname, 'smoke-macos-worker.cjs'), bundle], { env: { ...guiEnv, ELECTRON_RUN_AS_NODE: '1' } });
    evidence.worker = parseJsonLine(worker.stdout, 'packagedWorkerSmoke');
    assert.equal(evidence.worker.packagedWorkerSmoke, 'passed');

    // Exercise the optional native Python wheels and real local model using the
    // installer/listener from this extracted package. No microphone is opened.
    const python = process.env.DOTDIAL_SMOKE_PYTHON || run('python3', ['-c', 'import sys; print(sys.executable)']).stdout.trim();
    assert.ok(path.isAbsolute(python), 'wake validation requires a native Python 3.10-3.13 executable');
    const wakeData = path.join(temporary, 'wake');
    const packagedSource = path.join(bundle, 'Contents', 'Resources', 'app');
    run(python, [path.join(packagedSource, 'scripts', 'setup-wake.py'), '--data-dir', wakeData, '--stdin-audio'], { timeout: 300_000 });
    const wakeReport = path.join(reportDirectory, 'wake-check.json');
    run(python, [path.join(__dirname, 'smoke-macos-wake.py'), '--data-dir', wakeData, '--app-source', packagedSource, '--output', wakeReport], { timeout: 120_000 });
    evidence.wake = JSON.parse(fs.readFileSync(wakeReport, 'utf8'));
    assert.equal(evidence.wake.wakeSmoke, 'passed');

    fs.mkdirSync(mount);
    run('/usr/bin/hdiutil', ['verify', dmg]);
    run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
    mounted = true;
    const diskBundle = path.join(mount, 'DotDial.app');
    verifyBundle(diskBundle, manifest);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(diskBundle, 'Contents', 'Resources', 'dotdial-build.json'), 'utf8')), manifest);
    assert.equal(fs.readlinkSync(path.join(mount, 'Applications')), '/Applications');
    evidence.diskImage = { readable: true, signedAppVerified: true, applicationsShortcut: true };
    run('/usr/bin/hdiutil', ['detach', mount]);
    mounted = false;
    fs.writeFileSync(path.join(reportDirectory, 'package-check.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ macOSPackageVerified: true, ...evidence }, null, 2));
  } finally {
    fs.writeFileSync(path.join(reportDirectory, 'verification-progress.json'), JSON.stringify(evidence, null, 2) + '\n');
    if (mounted) { try { run('/usr/bin/hdiutil', ['detach', mount]); } catch {} }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error('MACOS_PACKAGE_CHECK_FAILED', error.stack || error.message); process.exitCode = 1; });
module.exports = { main };
