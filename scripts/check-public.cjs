#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set([
  '.git', '.venv', '__pycache__', 'build', 'coverage', 'dist', 'node_modules', 'work',
]);
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.desktop', '.html', '.js', '.json', '.md', '.mjs', '.py', '.sh', '.txt', '.yml', '.yaml',
]);
const TEXT_BASENAMES = new Set(['.gitignore', 'Dockerfile', 'Makefile']);
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

function scanPublicTree(root = PROJECT_ROOT) {
  const findings = [];
  const walk = relativeDir => {
    const absoluteDir = path.join(root, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(relativeDir.split(path.sep).join('/'), entry.name).replace(/^\.\//u, '');
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      inspectPath(relative, entry, findings);
      if (entry.isDirectory()) { walk(path.join(relativeDir, entry.name)); continue; }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension) && !TEXT_BASENAMES.has(entry.name)) continue;
      const absolute = path.join(root, relative);
      const stat = fs.statSync(absolute);
      if (stat.size > 2 * 1024 * 1024) {
        findings.push({ file: relative, line: 1, rule: 'oversized-source-file' });
        continue;
      }
      const text = fs.readFileSync(absolute, 'utf8');
      if (text.includes('\u0000')) continue;
      inspectText(relative, text, findings);
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
