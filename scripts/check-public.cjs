#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set([
  '.git', '.venv', '__pycache__', 'build', 'coverage', 'dist', 'node_modules', 'work',
]);
// Binary content cannot be audited as text. These exact screenshots and
// generated call tones have been reviewed; any change requires a fresh review.
const REVIEWED_BINARIES = new Map([
  ['docs/images/panel.png', '31430168cd4cbac99ee08ab89c0ade7d492f16b20c0f856ad53390c58a9765ea'],
  ['docs/images/settings.png', '4bd2844aa7d18a3bb7d8eea0ea90ace1b200539dcdd8d0068a906fa62c4892be'],
  ['docs/images/voice.png', 'd8ab8a7c66fcb7f2c3c43eb8e54b88a5e7245fca38eb6ac0e7cc6bfed111f78e'],
  ['src/sounds/calling.wav', 'f72efb7c687641098c8301ed8ec9af7f561e04316a31663c85d1a6cadd7babeb'],
  ['src/sounds/connected.wav', '6a08aab9c1c422f2e218379f09cfe09398b046a77ac57078182bfe3bfd174e3a'],
  ['src/sounds/ended.wav', '0ff18c3c2040d28eed720f6d72ac27274c4bc4adffb3757b79990490054013a0'],
]);
const TOKEN_PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/giu],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/gu],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/gu],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/gu],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu],
  ['jwt', /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{12,}\b/gu],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/=-]{32,}/giu],
];
const CYRILLIC = /\p{Script=Cyrillic}/gu;
const ASSIGNED_SECRET = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["']([^"'`\r\n]{24,})["']/giu;
const CREDENTIAL_URL = /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/giu;
const EMAIL = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu;
const LOCAL_PATH = /(?:\/home\/([^/\s]+)\/|\/Users\/([^/\s]+)\/|[A-Z]:\\Users\\([^\\\s]+)\\)/giu;
const EXAMPLE_HOSTS = new Set(['example.com', 'example.net', 'example.org', 'example.test', 'invalid']);
const SAFE_PLACEHOLDERS = new Set(['browser-managed', 'changeme', 'example', 'fixture', 'fixture-token', 'password', 'replace-me', 'test', 'token', 'user', 'username', 'your-user']);

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function addMatch(findings, relative, text, rule, expression, accept = () => false) {
  expression.lastIndex = 0;
  let match;
  while ((match = expression.exec(text))) {
    if (accept(match)) continue;
    findings.push({ file: relative, line: lineAt(text, match.index), rule });
    if (match[0].length === 0) expression.lastIndex++;
  }
}

function isApprovedSound(relative) {
  return /^src\/sounds\/[a-z0-9_-]+\.wav$/iu.test(relative);
}

function inspectPath(relative, entry, findings) {
  const segments = relative.split('/').map(part => part.toLowerCase());
  const basename = segments.at(-1);
  const directories = segments.slice(0, -1);
  const approvedEnvTemplate = basename === '.env.example';
  const approvedSound = entry.isFile() && isApprovedSound(relative);

  if (/\p{Script=Cyrillic}/u.test(relative)) findings.push({ file: relative, line: 1, rule: 'cyrillic-path' });
  if (entry.isSymbolicLink()) {
    findings.push({ file: relative, line: 1, rule: 'symlink' });
    return;
  }
  if (directories.some(part => ['browser-profile', 'cookies', 'profile', 'profiles', 'recordings', 'session', 'sessions', 'user-data'].includes(part))) {
    findings.push({ file: relative, line: 1, rule: 'private-data-directory' });
  }
  if (/^\.env(?:\..*)?$/u.test(basename) && !approvedEnvTemplate) {
    findings.push({ file: relative, line: 1, rule: 'environment-file' });
  }
  if (/^(?:cookies?|login data|local state|web data|history|credentials?\.json|tokens?\.json)$/u.test(basename.replace(/_/gu, ' ')) ||
      /^(?:id_rsa|id_ed25519|.*\.(?:key|pem|p12|pfx|sqlite|sqlite3|db|log))$/u.test(basename)) {
    findings.push({ file: relative, line: 1, rule: 'sensitive-file' });
  }
  if ((/\.wav(?:\.part)?$/u.test(basename) && !approvedSound) || /\.wav\.part$/u.test(basename)) {
    findings.push({ file: relative, line: 1, rule: 'recording-file' });
  }
}

function inspectText(relative, text, findings) {
  addMatch(findings, relative, text, 'cyrillic-content', CYRILLIC);
  for (const [rule, expression] of TOKEN_PATTERNS) addMatch(findings, relative, text, rule, expression);
  addMatch(findings, relative, text, 'hardcoded-secret', ASSIGNED_SECRET, match =>
    SAFE_PLACEHOLDERS.has(match[1].toLowerCase()));
  addMatch(findings, relative, text, 'credential-url', CREDENTIAL_URL, match => {
    try {
      const url = new URL(match[0].replace(/["'),.;]+$/gu, ''));
      return EXAMPLE_HOSTS.has(url.hostname.toLowerCase()) || url.hostname.toLowerCase().endsWith('.example.com');
    } catch { return false; }
  });
  addMatch(findings, relative, text, 'personal-email', EMAIL, match =>
    EXAMPLE_HOSTS.has(match[1].toLowerCase()) || match[1].toLowerCase().endsWith('.example.com'));
  addMatch(findings, relative, text, 'local-user-path', LOCAL_PATH, match =>
    SAFE_PLACEHOLDERS.has((match[1] || match[2] || match[3] || '').toLowerCase()));
}

function decodeText(bytes) {
  // Decode before checking for NUL so UTF-16 cannot bypass the text audit.
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch { return null; }
}

function isApprovedBinary(relative, bytes) {
  const expected = REVIEWED_BINARIES.get(relative);
  return expected !== undefined && createHash('sha256').update(bytes).digest('hex') === expected;
}

function trackedFiles(root) {
  // Source archives do not include Git metadata. In a checkout, tracked files
  // must still be inspected if their directory normally holds build output.
  if (!fs.existsSync(path.join(root, '.git'))) return new Set();
  return new Set(execFileSync('git', ['-C', root, 'ls-files', '--cached', '-z'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\u0000').filter(Boolean));
}

function scanPublicTree(root = PROJECT_ROOT) {
  const findings = [];
  const tracked = trackedFiles(root);
  const trackedDirectories = new Set();
  for (const file of tracked) {
    let directory = path.posix.dirname(file);
    while (directory !== '.') {
      trackedDirectories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  const walk = relativeDir => {
    const absoluteDir = path.join(root, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(relativeDir.split(path.sep).join('/'), entry.name).replace(/^\.\//u, '');
      if (entry.name === '.git') continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name) && !trackedDirectories.has(relative)) continue;
      inspectPath(relative, entry, findings);
      if (entry.isDirectory()) { walk(path.join(relativeDir, entry.name)); continue; }
      if (!entry.isFile()) continue;
      const absolute = path.join(root, relative);
      const stat = fs.statSync(absolute);
      if (stat.size > 2 * 1024 * 1024) {
        findings.push({ file: relative, line: 1, rule: 'oversized-source-file' });
        continue;
      }
      const bytes = fs.readFileSync(absolute);
      const text = decodeText(bytes);
      if (text !== null) inspectText(relative, text, findings);
      else if (!isApprovedBinary(relative, bytes)) {
        findings.push({ file: relative, line: 1, rule: 'unreviewed-binary-or-encoding' });
      }
    }
  };
  walk('');
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

if (require.main === module) {
  const findings = scanPublicTree();
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`BLOCK ${finding.rule}: ${finding.file}:${finding.line}\n`);
    process.stderr.write(`Public-source check failed (${findings.length} finding${findings.length === 1 ? '' : 's'}).\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Public-source check passed.\n');
  }
}

module.exports = { scanPublicTree };
