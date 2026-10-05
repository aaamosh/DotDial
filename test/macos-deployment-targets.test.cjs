'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseMachO, verifyDeploymentTargets } = require('../scripts/macos-deployment-targets.cjs');

const packedVersion = text => {
  const [major, minor = 0, patch = 0] = text.split('.').map(Number);
  return major * 65536 + minor * 256 + patch;
};

function thin({ arch = 'arm64', bits = 64, endian = 'LE', minimum = '13.0', sdk = '15.4',
  legacy = false, platform = 1, filetype = 6, missing = false } = {}) {
  const headerSize = bits === 64 ? 32 : 28, commandSize = missing ? 0 : legacy ? 16 : 24;
  const bytes = Buffer.alloc(headerSize + commandSize);
  const write = (value, offset) => bytes[`writeUInt32${endian}`](value, offset);
  write(bits === 64 ? 0xfeedfacf : 0xfeedface, 0);
  write({ arm64: 0x0100000c, x64: 0x01000007, ia32: 7 }[arch], 4);
  write(arch === 'arm64' ? 0 : 3, 8);
  write(filetype, 12);
  write(missing ? 0 : 1, 16);
  write(commandSize, 20);
  if (!missing) {
    write(legacy ? 0x24 : 0x32, headerSize);
    write(commandSize, headerSize + 4);
    if (!legacy) write(platform, headerSize + 8);
    write(packedVersion(minimum), headerSize + (legacy ? 8 : 12));
    write(packedVersion(sdk), headerSize + (legacy ? 12 : 16));
  }
  return bytes;
}

function fat(slices, { bits = 32, endian = 'BE' } = {}) {
  const entrySize = bits === 64 ? 32 : 20;
  let offset = Math.ceil((8 + slices.length * entrySize) / 16) * 16;
  const entries = slices.map(bytes => {
    const entry = { bytes, offset };
    offset = Math.ceil((offset + bytes.length) / 16) * 16;
    return entry;
  });
  const output = Buffer.alloc(offset);
  const write = (value, cursor) => output[`writeUInt32${endian}`](value, cursor);
  write(bits === 64 ? 0xcafebabf : 0xcafebabe, 0);
  write(slices.length, 4);
  for (const [index, entry] of entries.entries()) {
    const cursor = 8 + index * entrySize;
    // The fixtures use little-endian slices inside either fat byte order.
    write(entry.bytes.readUInt32LE(4), cursor);
    write(entry.bytes.readUInt32LE(8), cursor + 4);
    if (bits === 64) {
      output[`writeBigUInt64${endian}`](BigInt(entry.offset), cursor + 8);
      output[`writeBigUInt64${endian}`](BigInt(entry.bytes.length), cursor + 16);
      write(4, cursor + 24);
    } else {
      write(entry.offset, cursor + 8);
      write(entry.bytes.length, cursor + 12);
      write(4, cursor + 16);
    }
    entry.bytes.copy(output, entry.offset);
  }
  return output;
}

function bundle(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-targets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = path.join(directory, 'DotDial.app');
  fs.mkdirSync(app);
  return { directory, app, put(relative, bytes) {
    const file = path.join(app, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  } };
}

test('Mach-O parser reads 32/64-bit headers in both byte orders, including dyld and legacy targets', () => {
  for (const bits of [32, 64]) for (const endian of ['LE', 'BE']) {
    const slice = parseMachO(thin({ bits, endian, arch: bits === 64 ? 'x64' : 'ia32',
      legacy: true, minimum: '10.13.6', sdk: '15.4', filetype: 7 })).slices[0];
    assert.equal(slice.bits, bits);
    assert.equal(slice.byteOrder, endian);
    assert.equal(slice.deploymentTargets[0].minimumMacOS, '10.13.6');
    assert.equal(slice.deploymentTargets[0].sdk, '15.4.0');
  }
  assert.equal(parseMachO(Buffer.from('<html>resource</html>')), null);
});

test('fat32 and fat64 files preserve native slices in either fat-header byte order', () => {
  for (const bits of [32, 64]) for (const endian of ['LE', 'BE']) {
    const parsed = parseMachO(fat([thin({ arch: 'x64' }), thin()], { bits, endian }));
    assert.deepEqual(parsed.slices.map(slice => slice.architecture), ['x64', 'arm64']);
    assert.ok(parsed.slices.every(slice => slice.deploymentTargets[0].minimumMacOS === '13.0.0'));
  }
});

test('bundle verification scans nested Mach-O files once and distinguishes SDK 15 from minimum macOS 13', t => {
  const fixture = bundle(t);
  fixture.put('Contents/MacOS/DotDial', thin({ filetype: 2 }));
  fixture.put('Contents/Frameworks/Electron.framework/Versions/A/Electron', fat([thin({ arch: 'x64' }), thin()]));
  fixture.put('Contents/Resources/dotdial-lock', thin({ legacy: true, minimum: '12.0' }));
  fixture.put('Contents/Resources/app/index.html', '<html>resource</html>');
  fs.symlinkSync('A', path.join(fixture.app, 'Contents/Frameworks/Electron.framework/Versions/Current'));
  fs.symlinkSync('Versions/Current/Electron', path.join(fixture.app, 'Contents/Frameworks/Electron.framework/Electron'));
  const evidence = verifyDeploymentTargets(fixture.app, { architecture: 'arm64', minimumMacOS: '13.0' });
  assert.equal(evidence.checkedMachOFiles, 3);
  assert.equal(evidence.runtimeTestedOnMinimumMacOS, false);
  assert.ok(evidence.files.some(file => file.path.endsWith('/Versions/A/Electron')));
});

test('a nested library with minimum macOS 15 fails the declared Ventura gate', t => {
  const fixture = bundle(t);
  fixture.put('Contents/MacOS/DotDial', thin({ filetype: 2 }));
  fixture.put('Contents/Frameworks/new-library.dylib', thin({ minimum: '15.0' }));
  assert.throws(() => verifyDeploymentTargets(fixture.app, { architecture: 'arm64' }),
    /new-library\.dylib: arm64 requires macOS 15\.0\.0, above declared 13\.0/);
});

test('every native file needs the requested slice and a macOS deployment command', t => {
  const fixture = bundle(t);
  const file = fixture.put('Contents/MacOS/DotDial', thin({ arch: 'x64' }));
  assert.throws(() => verifyDeploymentTargets(fixture.app, { architecture: 'arm64' }), /arm64 Mach-O slice/);
  fs.writeFileSync(file, thin({ missing: true }));
  assert.throws(() => verifyDeploymentTargets(fixture.app, { architecture: 'arm64' }), /missing macOS deployment target/);
  fs.writeFileSync(file, thin({ platform: 6 }));
  assert.throws(() => verifyDeploymentTargets(fixture.app, { architecture: 'arm64' }), /non-macOS platform/);
});

test('framework symlinks cannot pull unchecked native files from outside the bundle', t => {
  const fixture = bundle(t);
  fixture.put('Contents/MacOS/DotDial', thin());
  const outside = path.join(fixture.directory, 'external.dylib');
  fs.writeFileSync(outside, thin());
  fs.symlinkSync(outside, path.join(fixture.app, 'external.dylib'));
  assert.throws(() => verifyDeploymentTargets(fixture.app, { architecture: 'arm64' }), /symlink escapes/);
});

test('malformed thin/fat headers cannot turn truncated commands or a different CPU into a valid slice', () => {
  assert.throws(() => parseMachO(thin().subarray(0, 40)), /load-command table exceeds/);
  const commands = thin();
  commands.writeUInt32LE(0, 36);
  assert.throws(() => parseMachO(commands), /invalid load-command size/);
  const mismatch = fat([thin()]);
  mismatch.writeUInt32BE(0x01000007, 8);
  assert.throws(() => parseMachO(mismatch), /architecture disagrees/);
  const outside = fat([thin()], { bits: 64 });
  outside.writeBigUInt64BE(2n ** 63n, 16);
  assert.throws(() => parseMachO(outside), /not safely representable/);
});
