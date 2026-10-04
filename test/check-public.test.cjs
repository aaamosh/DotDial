'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scanPublicTree } = require('../scripts/check-public.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-public-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };
  return { root, write };
}

test('audits extensionless, SVG, dotfiles and unknown text formats', t => {
  const { root, write } = fixture(t);
  const letter = String.fromCodePoint(0x416);
  const files = ['LICENSE', 'icon.svg', '.editorconfig', 'settings.unusual', 'source.cjs'];
  for (const file of files) write(file, `first line\n<!-- ${letter} -->\n`);
  const findings = scanPublicTree(root);
  assert.deepEqual(new Set(findings.map(item => item.file)), new Set(files));
  assert.ok(findings.every(item => item.rule === 'cyrillic-content' && item.line === 2));
});

test('checks Cyrillic filenames and extended Unicode code points', t => {
  const { root, write } = fixture(t);
  const file = `docs/${String.fromCodePoint(0x44f)}.md`;
  write(file, 'English contents\n');
  write('extended.txt', String.fromCodePoint(0xa640, 0x1e030));
  const findings = scanPublicTree(root);
  assert.ok(findings.some(item => item.file === file && item.rule === 'cyrillic-path'));
  assert.equal(findings.filter(item => item.file === 'extended.txt' && item.rule === 'cyrillic-content').length, 2);
});

test('decodes UTF-16 and rejects unsupported encodings instead of skipping them', t => {
  const { root, write } = fixture(t);
  const text = `English\n${String.fromCodePoint(0x416)}`;
  const little = Buffer.from(`\ufeff${text}`, 'utf16le');
  write('little.data', little);
  write('big.data', Buffer.from(little).swap16());
  write('legacy.data', Buffer.from([0xc6, 0xff, 0x20]));
  write('nul.txt', `prefix\u0000${text}`);
  const findings = scanPublicTree(root);
  for (const file of ['little.data', 'big.data']) {
    assert.ok(findings.some(item => item.file === file && item.rule === 'cyrillic-content' && item.line === 2));
  }
  for (const file of ['legacy.data', 'nul.txt']) {
    assert.ok(findings.some(item => item.file === file && item.rule === 'unreviewed-binary-or-encoding'));
  }
});

test('a binary extension does not exempt text and unknown binaries fail closed', t => {
  const { root, write } = fixture(t);
  write('docs/images/fake.png', String.fromCodePoint(0x416));
  write('archive.bin', Buffer.from([0, 1, 2, 255]));
  write('docs/images/panel.png', Buffer.concat([
    fs.readFileSync(path.join(__dirname, '..', 'docs/images/panel.png')),
    Buffer.from(String.fromCodePoint(0x416)),
  ]));
  const findings = scanPublicTree(root);
  assert.ok(findings.some(item => item.file === 'docs/images/fake.png' && item.rule === 'cyrillic-content'));
  assert.ok(findings.some(item => item.file === 'archive.bin' && item.rule === 'unreviewed-binary-or-encoding'));
  assert.ok(findings.some(item => item.file === 'docs/images/panel.png' && item.rule === 'unreviewed-binary-or-encoding'));
});

test('checks tracked files even inside directories normally used for dependencies or builds', t => {
  const { root, write } = fixture(t);
  execFileSync('git', ['init', '--quiet', root]);
  const letter = String.fromCodePoint(0x416);
  write('dist/tracked.md', letter);
  write('node_modules/tracked/LICENSE', letter);
  write('build/untracked.md', letter);
  execFileSync('git', ['-C', root, 'add', '--', 'dist/tracked.md', 'node_modules/tracked/LICENSE']);
  const findings = scanPublicTree(root);
  assert.deepEqual(new Set(findings.map(item => item.file)), new Set(['dist/tracked.md', 'node_modules/tracked/LICENSE']));
});

test('rejects oversized source and symlinks without reading their targets', t => {
  const { root, write } = fixture(t);
  write('oversized', 'a'.repeat(2 * 1024 * 1024 + 1));
  fs.symlinkSync('../outside', path.join(root, 'linked'));
  const findings = scanPublicTree(root);
  assert.ok(findings.some(item => item.file === 'oversized' && item.rule === 'oversized-source-file'));
  assert.ok(findings.some(item => item.file === 'linked' && item.rule === 'symlink'));
});

test('accepts English source and the existing reviewed binary assets', t => {
  const { root, write } = fixture(t);
  write('LICENSE', 'Permission is hereby granted.\n');
  for (const file of ['docs/images/panel.png', 'src/sounds/calling.wav']) {
    write(file, fs.readFileSync(path.join(__dirname, '..', file)));
  }
  assert.deepEqual(scanPublicTree(root), []);
});
