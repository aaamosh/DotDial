#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { packager } = require('@electron/packager');
const { scanPublicTree } = require('./check-public.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const PACKAGE_NAME = 'dotdial';
const APP_NAME = 'DotDial';
const ARCHIVE_ROOT = 'DotDial-linux-x64';
const RUNTIME_NAME = 'dotdial-runtime';
const ELECTRON_LANGUAGES = new Set(['en-US']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function checkBuildInputs() {
  const pkg = readJson(path.join(PROJECT_ROOT, 'package.json'));
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('DotDial packages are built on Linux x86_64 only.');
  }
  if (pkg.productName !== APP_NAME || pkg.name !== PACKAGE_NAME || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(pkg.version)) {
    throw new Error('package.json must declare the expected product, package name, and a SemVer release version.');
  }
  const electronVersion = pkg.devDependencies?.electron;
  const packagerVersion = pkg.devDependencies?.['@electron/packager'];
  if (!electronVersion || readJson(path.join(PROJECT_ROOT, 'node_modules/electron/package.json')).version !== electronVersion) {
    throw new Error('Installed Electron must exactly match the version pinned in package.json.');
  }
  const installedPackager = readJson(path.join(PROJECT_ROOT, 'node_modules/@electron/packager/package.json')).version;
  if (!packagerVersion || installedPackager !== packagerVersion) {
    throw new Error('Installed @electron/packager must exactly match the version pinned in package.json.');
  }
  return { pkg, electronVersion };
}

function assertPublicTree() {
  const findings = scanPublicTree(PROJECT_ROOT);
  if (findings.length) {
    const details = findings.map(({ file, line, rule }) => `  ${rule}: ${file}:${line}`).join('\n');
    throw new Error(`Refusing to package a source tree with public-source findings:\n${details}`);
  }
}

function appFileFilter(absolutePath) {
  const candidate = String(absolutePath);
  const absoluteInProject = path.isAbsolute(candidate) &&
    (candidate === PROJECT_ROOT || candidate.startsWith(`${PROJECT_ROOT}${path.sep}`));
  const relative = (absoluteInProject
    ? path.relative(PROJECT_ROOT, candidate)
    : candidate.replace(/^[/\\]+/u, '')).split(path.sep).join('/');
  if (!relative) return false;
  if (relative === 'package.json' || relative === 'LICENSE' || relative === 'THIRD_PARTY_NOTICES.md' ||
      relative === 'config.schema.json' || relative === 'config.example.json') return false;
  if (relative === 'bin' || relative.startsWith('bin/')) return false;
  if (relative === 'scripts') return false;
  if (relative === 'scripts/setup-wake.py' || relative === 'scripts/wake-requirements.txt') return false;
  if (relative === 'src' || relative.startsWith('src/')) {
    const sourceParts = relative.split('/');
    const basename = sourceParts.at(-1);
    if (sourceParts.slice(1).some(part => part.startsWith('.') || part === '__pycache__')) return true;
    if (/\.(?:test\.(?:cjs|mjs|js)|pyc|pyo|log)(?:\.\d+)?$/iu.test(basename) || /(?:~|\.sw[op])$/u.test(basename)) return true;
    return false;
  }
  return true;
}

function writeFile(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

function launcherScript() {
  return `#!/bin/sh
set -eu

DOTDIAL_SCRIPT=$(readlink -f -- "$0")
DOTDIAL_BINDIR=\${DOTDIAL_SCRIPT%/*}
DOTDIAL_BINDIR=$(CDPATH= cd -P -- "$DOTDIAL_BINDIR" && pwd -P)
DOTDIAL_RUNTIME="$DOTDIAL_BINDIR/${RUNTIME_NAME}"
DOTDIAL_CLI="$DOTDIAL_BINDIR/resources/app/bin/dotdial.cjs"

if [ "$#" -eq 0 ]; then
  set -- run
elif [ "$1" = "--settings" ]; then
  shift
  set -- run --settings "$@"
fi

if [ ! -x "$DOTDIAL_RUNTIME" ]; then
  echo "DotDial runtime is missing: $DOTDIAL_RUNTIME" >&2
  exit 127
fi

case "\${1-}" in
  --help|-h|config|doctor|run|status|call|hangup|mute|unmute|speakers-mute|speakers-unmute|replay)
    if [ ! -f "$DOTDIAL_CLI" ]; then
      echo "DotDial command line is missing: $DOTDIAL_CLI" >&2
      exit 127
    fi
    ELECTRON_RUN_AS_NODE=1
    export ELECTRON_RUN_AS_NODE
    exec "$DOTDIAL_RUNTIME" "$DOTDIAL_CLI" "$@"
    ;;
  *)
    unset ELECTRON_RUN_AS_NODE
    exec "$DOTDIAL_RUNTIME" "$@"
    ;;
esac
`;
}

function archiveInstallScript() {
  return `#!/bin/sh
set -eu

case "$0" in
  */*) DOTDIAL_BINDIR=\${0%/*} ;;
  *) DOTDIAL_BINDIR=. ;;
esac
DOTDIAL_BINDIR=$(CDPATH= cd -P -- "$DOTDIAL_BINDIR" && pwd -P)

if [ "$(id -u)" -ne 0 ]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Run this installer as root or install sudo first." >&2
    exit 1
  fi
  exec sudo -- "$DOTDIAL_BINDIR/install.sh" "$@"
fi
DOTDIAL_DEST=/opt/dotdial

if [ -e "$DOTDIAL_DEST" ] || [ -L "$DOTDIAL_DEST" ]; then
  echo "/opt/dotdial already exists; use the .deb package manager for upgrades." >&2
  exit 1
fi
for DOTDIAL_PATH in /usr/bin/dotdial /usr/share/applications/dotdial.desktop /usr/share/icons/hicolor/scalable/apps/dotdial.svg; do
  if [ -e "$DOTDIAL_PATH" ] || [ -L "$DOTDIAL_PATH" ]; then
    echo "Refusing to replace an existing file: $DOTDIAL_PATH" >&2
    exit 1
  fi
done

mkdir -p /opt
mkdir -m 0755 "$DOTDIAL_DEST"
DOTDIAL_STAGE=$(mktemp -d "$DOTDIAL_DEST/.install.XXXXXX")
cleanup() { rm -rf "$DOTDIAL_STAGE"; }
trap cleanup EXIT HUP INT TERM
cp -a "$DOTDIAL_BINDIR/." "$DOTDIAL_STAGE/"
chown -R root:root "$DOTDIAL_STAGE"
chmod 0755 "$DOTDIAL_STAGE/dotdial" "$DOTDIAL_STAGE/dotdial-runtime"
chmod 4755 "$DOTDIAL_STAGE/chrome-sandbox"
for DOTDIAL_ITEM in "$DOTDIAL_STAGE"/* "$DOTDIAL_STAGE"/.[!.]* "$DOTDIAL_STAGE"/..?*; do
  if [ -e "$DOTDIAL_ITEM" ] || [ -L "$DOTDIAL_ITEM" ]; then
    mv "$DOTDIAL_ITEM" "$DOTDIAL_DEST/"
  fi
done
rmdir "$DOTDIAL_STAGE"
trap - EXIT HUP INT TERM
cat > /usr/bin/dotdial <<'DOTDIAL_SHIM'
#!/bin/sh
set -eu
DOTDIAL_SCRIPT=$(readlink -f -- "$0")
DOTDIAL_BINDIR=\${DOTDIAL_SCRIPT%/*}
DOTDIAL_ROOT=$(CDPATH= cd -P -- "$DOTDIAL_BINDIR/../../opt/dotdial" && pwd -P)
exec "$DOTDIAL_ROOT/dotdial" "$@"
DOTDIAL_SHIM
chmod 0755 /usr/bin/dotdial
install -D -m 0644 /opt/dotdial/dotdial.desktop /usr/share/applications/dotdial.desktop
install -D -m 0644 /opt/dotdial/dotdial.svg /usr/share/icons/hicolor/scalable/apps/dotdial.svg
echo "DotDial installed. Launch it from the desktop menu or run: dotdial"
`;
}

function commandShimScript() {
  return `#!/bin/sh
set -eu
DOTDIAL_SCRIPT=$(readlink -f -- "$0")
DOTDIAL_BINDIR=\${DOTDIAL_SCRIPT%/*}
DOTDIAL_ROOT=$(CDPATH= cd -P -- "$DOTDIAL_BINDIR/../../opt/dotdial" && pwd -P)
exec "$DOTDIAL_ROOT/dotdial" "$@"
`;
}

function desktopFile() {
  return `[Desktop Entry]
Type=Application
Name=DotDial
Comment=Call your ChatGPT dot
Exec=/opt/dotdial/dotdial
Icon=dotdial
Terminal=false
Categories=AudioVideo;Network;Utility;
StartupNotify=true
StartupWMClass=DotDial
`;
}

function makeDirectory(file, mode = 0o755) {
  fs.mkdirSync(file, { recursive: true, mode });
  fs.chmodSync(file, mode);
}

function normalizeBundlePermissions(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      normalizeBundlePermissions(file);
      fs.chmodSync(file, 0o755);
    } else if (entry.isFile()) {
      if (entry.name === 'chrome-sandbox') fs.chmodSync(file, 0o4755);
      else {
        const executable = (fs.statSync(file).mode & 0o111) !== 0;
        fs.chmodSync(file, executable ? 0o755 : 0o644);
      }
    }
  }
  fs.chmodSync(root, 0o755);
}

function pruneElectronLocales(bundleDir) {
  const localeDir = path.join(bundleDir, 'locales');
  const selected = `${[...ELECTRON_LANGUAGES][0]}.pak`;
  if (!fs.statSync(path.join(localeDir, selected)).isFile()) {
    throw new Error(`Pinned Electron locale is missing: ${selected}`);
  }
  for (const entry of fs.readdirSync(localeDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.pak') && !ELECTRON_LANGUAGES.has(entry.name.slice(0, -4))) {
      fs.unlinkSync(path.join(localeDir, entry.name));
    }
  }
}

function copyFile(source, destination, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.copyFileSync(source, destination);
  if (mode !== undefined) fs.chmodSync(destination, mode);
}

function createTarball(tarRoot, file) {
  const uncompressed = `${file.slice(0, -3)}`;
  execFileSync('tar', [
    '--sort=name', '--mtime=@0', '--owner=65534', '--group=65534', '--numeric-owner',
    '-cf', uncompressed, '-C', path.dirname(tarRoot), ARCHIVE_ROOT,
  ], { stdio: 'inherit' });
  execFileSync('gzip', ['-n', '-f', uncompressed], { stdio: 'inherit' });
  if (!fs.statSync(file).isFile()) throw new Error('tar.gz artifact was not created.');
}

function writeChecksums(files) {
  const lines = files.map(file => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return `${hash}  ${path.basename(file)}`;
  });
  const output = path.join(DIST_DIR, 'SHA256SUMS');
  writeFile(output, `${lines.join('\n')}\n`, 0o644);
}

async function main() {
  process.umask(0o022);
  assertPublicTree();
  const { pkg, electronVersion } = checkBuildInputs();
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  makeDirectory(DIST_DIR);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-package-'));
  try {
    await packager({
      dir: PROJECT_ROOT,
      out: DIST_DIR,
      name: APP_NAME,
      executableName: RUNTIME_NAME,
      appVersion: pkg.version,
      electronVersion,
      platform: 'linux',
      arch: 'x64',
      asar: false,
      prune: false,
      overwrite: true,
      quiet: false,
      ignore: appFileFilter,
    });

    const bundleDir = path.join(DIST_DIR, ARCHIVE_ROOT);
    pruneElectronLocales(bundleDir);
    const runtime = path.join(bundleDir, RUNTIME_NAME);
    const sandbox = path.join(bundleDir, 'chrome-sandbox');
    const appMain = path.join(bundleDir, 'resources', 'app', 'src', 'main.cjs');
    const cli = path.join(bundleDir, 'resources', 'app', 'bin', 'dotdial.cjs');
    const soundDir = path.join(bundleDir, 'resources', 'app', 'src', 'sounds');
    for (const required of [runtime, sandbox, appMain, cli]) {
      if (!fs.existsSync(required)) throw new Error(`Packaged file is missing: ${path.relative(bundleDir, required)}`);
    }
    for (const sound of ['calling.wav', 'connected.wav', 'ended.wav']) {
      if (!fs.statSync(path.join(soundDir, sound)).isFile()) throw new Error(`Packaged call sound is missing: ${sound}`);
    }

    fs.chmodSync(runtime, 0o755);
    fs.chmodSync(sandbox, 0o4755);
    writeFile(path.join(bundleDir, 'dotdial'), launcherScript(), 0o755);
    normalizeBundlePermissions(bundleDir);

    const version = pkg.version.replace(/-(alpha|beta|rc)\./u, '~$1.');
    const tarRoot = path.join(tempRoot, ARCHIVE_ROOT);
    fs.cpSync(bundleDir, tarRoot, { recursive: true, preserveTimestamps: false });
    writeFile(path.join(tarRoot, 'dotdial.desktop'), desktopFile());
    copyFile(path.join(PROJECT_ROOT, 'src/assets/dotdial.svg'), path.join(tarRoot, 'dotdial.svg'));
    writeFile(path.join(tarRoot, 'install.sh'), archiveInstallScript(), 0o755);
    normalizeBundlePermissions(tarRoot);
    const archiveFile = path.join(DIST_DIR, `${APP_NAME}-${pkg.version}-linux-x64.tar.gz`);
    createTarball(tarRoot, archiveFile);

    const debRoot = path.join(tempRoot, 'deb-root');
    const debOpt = path.join(debRoot, 'opt', 'dotdial');
    makeDirectory(debOpt);
    fs.cpSync(bundleDir, debOpt, { recursive: true, preserveTimestamps: false });
    fs.chmodSync(path.join(debOpt, 'chrome-sandbox'), 0o4755);
    const desktopDir = path.join(debRoot, 'usr', 'share', 'applications');
    const iconDir = path.join(debRoot, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps');
    const binDir = path.join(debRoot, 'usr', 'bin');
    const controlDir = path.join(debRoot, 'DEBIAN');
    makeDirectory(desktopDir);
    makeDirectory(iconDir);
    makeDirectory(binDir);
    makeDirectory(controlDir, 0o755);
    writeFile(path.join(desktopDir, 'dotdial.desktop'), desktopFile());
    copyFile(path.join(PROJECT_ROOT, 'src/assets/dotdial.svg'), path.join(iconDir, 'dotdial.svg'));
    writeFile(path.join(binDir, 'dotdial'), commandShimScript(), 0o755);
    const control = `Package: ${PACKAGE_NAME}
Version: ${version}
Section: utils
Priority: optional
Architecture: amd64
Maintainer: DotDial contributors
Depends: libc6, libasound2 | libasound2t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libatk1.0-0 | libatk1.0-0t64, libcairo2, libcups2 | libcups2t64, libdbus-1-3, libdrm2, libexpat1, libgbm1, libgcc-s1, libglib2.0-0 | libglib2.0-0t64, libgtk-3-0 | libgtk-3-0t64, libnspr4, libnss3, libpango-1.0-0, libpulse0, pulseaudio-utils, libx11-6, libx11-xcb1, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2, libxrender1, libxss1, libxtst6
Description: A small Linux tray companion for calling a ChatGPT dot
 DotDial provides tray, hotkey, and floating-panel voice controls for a dot.
`;
    writeFile(path.join(controlDir, 'control'), control, 0o644);
    const debFile = path.join(DIST_DIR, `${PACKAGE_NAME}_${pkg.version}_amd64.deb`);
    execFileSync('dpkg-deb', ['--build', '--root-owner-group', debRoot, debFile], { stdio: 'inherit' });

    const debInfo = execFileSync('dpkg-deb', ['--info', debFile], { encoding: 'utf8' });
    if (!debInfo.includes('Architecture: amd64') || !debInfo.includes(`Version: ${version}`)) {
      throw new Error('Debian package metadata does not match the release.');
    }
    const debContents = execFileSync('dpkg-deb', ['--contents', debFile], { encoding: 'utf8' });
    if (!/rwsr-xr-x\s+root\/root\s+.*\/opt\/dotdial\/chrome-sandbox/u.test(debContents)) {
      throw new Error('Debian package must include only its private setuid sandbox, owned by root with mode 4755.');
    }
    if (!debContents.includes('/usr/bin/dotdial') || !debContents.includes('/usr/share/applications/dotdial.desktop')) {
      throw new Error('Debian package is missing its command shim or desktop entry.');
    }
    writeChecksums([archiveFile, debFile]);
    for (const artifact of [archiveFile, debFile, path.join(DIST_DIR, 'SHA256SUMS')]) fs.chmodSync(artifact, 0o644);
    normalizeBundlePermissions(bundleDir);
    process.stdout.write(`Built ${path.relative(PROJECT_ROOT, archiveFile)}\nBuilt ${path.relative(PROJECT_ROOT, debFile)}\n`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`Packaging failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
