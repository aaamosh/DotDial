#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { scanPublicTree } = require('./check-public.cjs');
const { buildNative } = require('./build-macos-native.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APP_NAME = 'DotDial';
const BUNDLE_ID = 'org.dotdial.DotDial';
const MINIMUM_MACOS = '13.0';
const MICROPHONE_DESCRIPTION = 'DotDial uses your microphone for calls you start and, when you enable it, local wake-word recognition.';
const MAC_ARCHITECTURES = new Set(['arm64', 'x64']);
const ELECTRON_NOTICE_FILES = ['LICENSE', 'LICENSES.chromium.html'];
const ELECTRON_NOTICES_DIRECTORY = 'electron-licenses';
const CLI_LAUNCHER = `#!/bin/sh
set -eu
case "$0" in
  */*) launcher_directory=\${0%/*} ;;
  *) printf '%s\\n' 'Run dotdial-cli by its path inside DotDial.app.' >&2; exit 1 ;;
esac
launcher_directory=$(CDPATH='' cd "$launcher_directory" && pwd -P)
export ELECTRON_RUN_AS_NODE=1
exec "$launcher_directory/../MacOS/DotDial" "$launcher_directory/app/bin/dotdial.cjs" "$@"
`;

function validateBuild({ platform, arch, pkg, electronVersion, packagerVersion }) {
  if (platform !== 'darwin' || !MAC_ARCHITECTURES.has(arch)) {
    throw Error('Build macOS packages natively on an Apple Silicon or Intel Mac.');
  }
  if (pkg.name !== 'dotdial' || pkg.productName !== APP_NAME || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    throw Error('package.json must contain the DotDial identity and a SemVer version.');
  }
  if (electronVersion !== pkg.devDependencies?.electron || packagerVersion !== pkg.devDependencies?.['@electron/packager']) {
    throw Error('Run npm ci: installed Electron and Packager must exactly match their pinned versions.');
  }
}

function appFileFilter(candidate, root = ROOT) {
  const value = String(candidate);
  const relative = (path.isAbsolute(value) && (value === root || value.startsWith(root + path.sep))
    ? path.relative(root, value) : value.replace(/^[/\\]+/, '')).split(path.sep).join('/');
  if (!relative) return false;
  if (['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'config.schema.json', 'config.example.json'].includes(relative)) return false;
  if (['bin', 'bin/dotdial.cjs', 'scripts', 'scripts/setup-wake.py', 'scripts/wake-requirements.txt', 'scripts/smoke-packaged.cjs'].includes(relative)) return false;
  if (relative === 'src' || relative.startsWith('src/')) {
    const parts = relative.split('/');
    if (parts.slice(1).some(part => part.startsWith('.') || part === '__pycache__')) return true;
    return /(?:\.test\.(?:cjs|mjs|js)|\.(?:pyc|pyo|log|tmp|bak)(?:\.\d+)?|~|\.sw[op])$/i.test(parts.at(-1));
  }
  return true;
}

function artifactStem(version, arch, sourceSha, preview = false) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !MAC_ARCHITECTURES.has(arch) || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw Error('Invalid macOS artifact identity.');
  }
  return `${APP_NAME}-${version}${preview ? `-preview-${sourceSha.slice(0, 8)}` : ''}-macos-${arch}`;
}

function buildManifest({ pkg, arch, sourceSha, sourceDirty, preview }) {
  artifactStem(pkg.version, arch, sourceSha, preview);
  return {
    schemaVersion: 1,
    product: APP_NAME,
    version: pkg.version,
    platform: 'darwin',
    architecture: arch,
    minimumMacOS: MINIMUM_MACOS,
    bundleIdentifier: BUNDLE_ID,
    electronVersion: pkg.devDependencies.electron,
    sourceCommit: sourceSha,
    sourceDirty: sourceDirty === true,
    distribution: preview ? 'preview' : 'beta',
    codeSignature: 'ad-hoc',
    developerIDSigned: false,
    notarized: false,
    microphoneDescription: MICROPHONE_DESCRIPTION,
  };
}

function signingOptions() {
  return {
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    continueOnError: false,
    strictVerify: true,
    optionsForFile: file => ({
      timestamp: 'none',
      hardenedRuntime: true,
      // Keep Electron's specialized Renderer/GPU/Plugin helper entitlements.
      ...(path.basename(file) === 'dotdial-lock' ? { entitlements: [] } :
        !/Helper \((?:Renderer|GPU|Plugin)\)\.app(?:\/|$)/.test(file) ? {
        entitlements: ['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input'],
      } : {}),
    }),
  };
}

function command(file, args, options = {}) {
  return execFileSync(file, args, { stdio: 'inherit', ...options });
}

function gitSource(root = ROOT) {
  const sourceSha = command('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw Error('A Git source commit is required for the build manifest.');
  const changes = command('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { sourceSha, sourceDirty: changes.length > 0 };
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

function normalizeSource(root) {
  // Do not rewrite framework links, Mach-O files, or signed resources.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) { normalizeSource(file); fs.chmodSync(file, 0o755); }
    else if (entry.isFile()) fs.chmodSync(file, 0o644);
    else throw Error('Unexpected link or special file in application source.');
  }
}

function writeCliLauncher(appSource) {
  // Scripts are signed as resources, avoiding fragile extended-attribute code
  // signatures in Contents/MacOS. afterCopy runs before native signing.
  const launcher = path.resolve(appSource, '..', 'dotdial-cli');
  fs.writeFileSync(launcher, CLI_LAUNCHER, { mode: 0o755, flag: 'wx' });
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

async function prepareAppSource({ buildPath }) {
  normalizeSource(buildPath);
  writeCliLauncher(buildPath);
}

function readNotice(file, description) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (cause) {
    throw Error(`${description} must be a nonempty regular file: ${path.basename(file)}`, { cause });
  }
  if (!stat.isFile() || stat.size === 0) {
    throw Error(`${description} must be a nonempty regular file: ${path.basename(file)}`);
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length === 0) throw Error(`${description} is empty: ${path.basename(file)}`);
  return bytes;
}

function readElectronNotices(electronDirectory, expectedVersion) {
  const installed = JSON.parse(fs.readFileSync(path.join(electronDirectory, 'package.json'), 'utf8'));
  if (typeof expectedVersion !== 'string' || installed.version !== expectedVersion) {
    throw Error('Electron license provenance requires the exact installed runtime version.');
  }
  return ELECTRON_NOTICE_FILES.map(name => {
    const bytes = readNotice(path.join(electronDirectory, 'dist', name), 'Electron distribution notice');
    return { name, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
}

function copyElectronNotices(electronDirectory, destination, expectedVersion) {
  // Read both upstream files before creating the resource directory. Keep the
  // runtime's notices separate from DotDial's own LICENSE and component list.
  const notices = readElectronNotices(electronDirectory, expectedVersion);
  fs.mkdirSync(destination, { mode: 0o755 });
  for (const notice of notices) {
    fs.writeFileSync(path.join(destination, notice.name), notice.bytes, { mode: 0o644, flag: 'wx' });
  }
  return destination;
}

function verifyElectronNotices(bundle, electronDirectory, expectedVersion) {
  const notices = readElectronNotices(electronDirectory, expectedVersion);
  const files = notices.map(notice => {
    const bundledPath = `Contents/Resources/${ELECTRON_NOTICES_DIRECTORY}/${notice.name}`;
    const bytes = readNotice(path.join(bundle, bundledPath), 'Packaged Electron notice');
    const bundledSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bundledSha256 !== notice.sha256) {
      throw Error(`Packaged Electron notice differs from the installed runtime: ${notice.name}`);
    }
    return { sourcePath: `node_modules/electron/dist/${notice.name}`, bundledPath,
      bytes: bytes.length, sourceSha256: notice.sha256, bundledSha256 };
  });
  return { electronVersion: expectedVersion, files };
}

function verifyBundle(bundle, manifest) {
  const contents = path.join(bundle, 'Contents');
  const executable = path.join(contents, 'MacOS', APP_NAME);
  const architecture = command('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (architecture !== (manifest.architecture === 'x64' ? 'x86_64' : 'arm64')) throw Error('Packaged Mach-O architecture does not match the manifest.');
  const lockHelper = path.join(contents, 'Resources', 'dotdial-lock');
  const lockStat = fs.lstatSync(lockHelper);
  if (!lockStat.isFile() || (lockStat.mode & 0o111) !== 0o111) throw Error('The native config lock helper is missing or not executable.');
  const lockArchitecture = command('/usr/bin/lipo', ['-archs', lockHelper], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (lockArchitecture !== architecture) throw Error('The packaged native config lock helper has the wrong architecture.');
  command('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', lockHelper]);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (plist.CFBundleIdentifier !== BUNDLE_ID || plist.CFBundleExecutable !== APP_NAME || plist.LSMinimumSystemVersion !== MINIMUM_MACOS || plist.NSMicrophoneUsageDescription !== MICROPHONE_DESCRIPTION) {
    throw Error('Packaged Info.plist is inconsistent with DotDial identity or microphone permissions.');
  }
  const icon = path.join(contents, 'Resources', plist.CFBundleIconFile || '');
  if (!fs.statSync(icon).isFile() || fs.readFileSync(icon).toString('ascii', 0, 4) !== 'icns') throw Error('Packaged macOS application icon is missing or invalid.');
  const appSource = path.join(contents, 'Resources', 'app');
  const launcher = path.join(contents, 'Resources', 'dotdial-cli');
  if (!fs.statSync(launcher).isFile() || (fs.statSync(launcher).mode & 0o111) !== 0o111 || fs.readFileSync(launcher, 'utf8') !== CLI_LAUNCHER) {
    throw Error('Packaged Node-independent command-line launcher is missing or invalid.');
  }
  for (const relative of ['src/main.cjs', 'bin/dotdial.cjs', 'scripts/setup-wake.py', 'scripts/wake-requirements.txt', 'scripts/smoke-packaged.cjs', 'src/sounds/calling.wav']) {
    if (!fs.statSync(path.join(appSource, relative)).isFile()) throw Error(`Packaged application file is missing: ${relative}`);
  }
  return { executable, launcher, lockHelper, architecture };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.some(value => value !== '--preview')) throw Error('Usage: node scripts/package-macos.cjs [--preview]');
  const preview = argv.includes('--preview');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const readVersion = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
  // Check the host before reading installed packages: a Linux machine must not
  // accidentally claim to have validated or signed a native macOS build.
  if (process.platform !== 'darwin') throw Error('The macOS package target requires a native macOS build host.');
  validateBuild({ platform: process.platform, arch: process.arch, pkg, electronVersion: readVersion('electron'), packagerVersion: readVersion('@electron/packager') });
  const findings = scanPublicTree(ROOT);
  if (findings.length) throw Error('Public-source audit failed:\n' + findings.map(f => `${f.rule}: ${f.file}:${f.line}`).join('\n'));
  const lockHelper = buildNative();
  if (!lockHelper) throw Error('A native config lock helper is required for macOS packages.');
  const source = gitSource();
  const manifest = buildManifest({ pkg, arch: process.arch, ...source, preview });
  const stem = artifactStem(pkg.version, process.arch, source.sourceSha, preview);
  const output = path.join(DIST, `macos-${process.arch}`);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-macos-package-'));
  try {
    const icon = path.join(ROOT, 'src', 'assets', 'dotdial.icns');
    if (!fs.statSync(icon).isFile() || fs.readFileSync(icon).toString('ascii', 0, 4) !== 'icns') throw Error('The reviewed macOS icon is missing or invalid.');
    const { packager } = require('@electron/packager');
    const manifestFile = path.join(temporary, 'dotdial-build.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
    const electronDirectory = path.join(ROOT, 'node_modules', 'electron');
    const electronNotices = copyElectronNotices(electronDirectory,
      path.join(temporary, ELECTRON_NOTICES_DIRECTORY), manifest.electronVersion);
    const results = await packager({
      dir: ROOT,
      out: output,
      name: APP_NAME,
      executableName: APP_NAME,
      appBundleId: BUNDLE_ID,
      appCategoryType: 'public.app-category.productivity',
      appVersion: pkg.version.split('-')[0],
      buildVersion: pkg.version.split('-')[0],
      electronVersion: pkg.devDependencies.electron,
      platform: 'darwin',
      arch: process.arch,
      icon,
      asar: false,
      prune: false,
      overwrite: true,
      ignore: candidate => appFileFilter(candidate),
      // Extra resources are copied before signing. Both standalone downloads
      // inherit these exact runtime notices inside the signed application.
      extraResource: [manifestFile, lockHelper, electronNotices],
      extendInfo: { NSMicrophoneUsageDescription: MICROPHONE_DESCRIPTION, LSMinimumSystemVersion: MINIMUM_MACOS },
      extendHelperInfo: { NSMicrophoneUsageDescription: MICROPHONE_DESCRIPTION, LSMinimumSystemVersion: MINIMUM_MACOS },
      osxSign: signingOptions(),
      afterCopy: [prepareAppSource],
    });
    if (results.length !== 1) throw Error('Expected one native macOS application bundle.');
    const bundle = path.join(results[0], `${APP_NAME}.app`);
    verifyBundle(bundle, manifest);
    verifyElectronNotices(bundle, electronDirectory, manifest.electronVersion);
    const zip = path.join(output, stem + '.app.zip');
    const dmg = path.join(output, stem + '.dmg');
    const sidecar = path.join(output, stem + '.manifest.json');
    for (const file of [zip, dmg, sidecar]) fs.rmSync(file, { force: true });
    command('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip]);
    const diskSource = path.join(temporary, 'disk-source');
    fs.mkdirSync(diskSource);
    command('/usr/bin/ditto', [bundle, path.join(diskSource, `${APP_NAME}.app`)]);
    fs.symlinkSync('/Applications', path.join(diskSource, 'Applications'));
    fs.writeFileSync(path.join(diskSource, 'READ-ME.txt'), [
      `DotDial ${pkg.version} for macOS (${process.arch})`,
      '',
      'Drag DotDial.app to Applications before opening it.',
      'This beta has an ad-hoc code signature. It is not signed with an Apple Developer ID and has not been notarized.',
      'macOS may require you to approve this app in System Settings > Privacy & Security after an attempted launch.',
      'Only approve a download you trust. DotDial does not change system security settings.',
      'Microphone access is requested when you start a call or enable local wake-word listening.',
      `Source commit: ${source.sourceSha}`,
      '',
    ].join('\n'));
    command('/usr/bin/hdiutil', ['create', '-quiet', '-volname', APP_NAME, '-srcfolder', diskSource, '-format', 'UDZO', '-fs', 'HFS+', dmg]);
    command('/usr/bin/hdiutil', ['verify', dmg]);
    fs.copyFileSync(manifestFile, sidecar);
    const checksums = [];
    for (const file of [zip, dmg, sidecar]) {
      fs.chmodSync(file, 0o644);
      checksums.push(`${await sha256(file)}  ${path.basename(file)}`);
    }
    fs.writeFileSync(path.join(output, 'SHA256SUMS'), checksums.join('\n') + '\n', { mode: 0o644 });
    console.log(JSON.stringify({ built: [zip, dmg, sidecar], manifest }, null, 2));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error('macOS packaging failed:', error.stack || error.message); process.exitCode = 1; });
module.exports = { main, validateBuild, appFileFilter, artifactStem, buildManifest, signingOptions, writeCliLauncher, prepareAppSource, copyElectronNotices, verifyElectronNotices, verifyBundle, sha256, BUNDLE_ID, MINIMUM_MACOS, MICROPHONE_DESCRIPTION };
