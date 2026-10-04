#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NATIVE_LOCK = path.join(ROOT, 'build', 'native', 'dotdial-lock');

function buildNative() {
  if (process.platform !== 'darwin') return null;
  const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  if (!architecture) throw Error('DotDial native helpers require an Apple Silicon or Intel Mac.');
  fs.mkdirSync(path.dirname(NATIVE_LOCK), { recursive: true });
  const temporary = path.join(path.dirname(NATIVE_LOCK), `.dotdial-lock-${crypto.randomUUID()}`);
  try {
    execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
      '-mmacosx-version-min=13.0', '-arch', architecture,
      path.join(ROOT, 'scripts', 'native', 'dotdial-lock.c'), '-o', temporary], { stdio: 'inherit', timeout: 120_000 });
    fs.chmodSync(temporary, 0o755);
    const actual = execFileSync('/usr/bin/lipo', ['-archs', temporary], { encoding: 'utf8', timeout: 5000 }).trim();
    if (actual !== architecture) throw Error('The native config lock helper has the wrong architecture.');
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'org.dotdial.DotDial.config-lock',
      '--timestamp=none', '--options', 'runtime', temporary],
      { stdio: 'inherit', timeout: 30_000 });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', temporary], { stdio: 'inherit', timeout: 5000 });
    fs.renameSync(temporary, NATIVE_LOCK);
    return NATIVE_LOCK;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

if (require.main === module) {
  try {
    const file = buildNative();
    if (file) console.log(`Built native config lock helper for ${process.arch}.`);
  } catch (error) {
    console.error('Native macOS helper build failed. Install Xcode Command Line Tools, then run npm ci.');
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildNative, NATIVE_LOCK };
