'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOAD_COMMAND_BYTES = 16 * 1024 * 1024;
const MACH_HEADERS = new Map([
  [0xfeedface, { bits: 32, endian: 'BE' }], [0xcefaedfe, { bits: 32, endian: 'LE' }],
  [0xfeedfacf, { bits: 64, endian: 'BE' }], [0xcffaedfe, { bits: 64, endian: 'LE' }],
]);
const FAT_HEADERS = new Map([
  [0xcafebabe, { bits: 32, endian: 'BE' }], [0xbebafeca, { bits: 32, endian: 'LE' }],
  [0xcafebabf, { bits: 64, endian: 'BE' }], [0xbfbafeca, { bits: 64, endian: 'LE' }],
]);

function invalid(message) { throw Error(`Invalid Mach-O: ${message}`); }
function u32(buffer, offset, endian) { return buffer[`readUInt32${endian}`](offset); }
function u64(buffer, offset, endian) {
  const value = buffer[`readBigUInt64${endian}`](offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid('file offset or size is not safely representable');
  return Number(value);
}
function version(value) { return `${value >>> 16}.${(value >>> 8) & 255}.${value & 255}`; }
function versionNumber(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(value)) throw Error('Expected a numeric macOS version');
  const [major, minor = 0, patch = 0] = value.split('.').map(Number);
  if (major > 65535 || minor > 255 || patch > 255) throw Error('macOS version is out of range');
  return major * 65536 + minor * 256 + patch;
}
function architecture(cpu, subtype) {
  const baseSubtype = subtype & 0x00ffffff;
  if (cpu === 0x0100000c) return baseSubtype === 2 ? 'arm64e' : 'arm64';
  if (cpu === 0x01000007) return baseSubtype === 8 ? 'x86_64h' : 'x64';
  if (cpu === 7) return 'ia32';
  if (cpu === 12) return 'arm';
  return `cpu-${cpu.toString(16)}`;
}

function parseReader(read, size) {
  function bounded(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
        offset > size || length > size - offset) invalid('truncated or out-of-bounds file range');
    return read(offset, length);
  }
  function thin(offset, sliceSize, declared) {
    if (sliceSize < 4) invalid('truncated architecture slice');
    const format = MACH_HEADERS.get(bounded(offset, 4).readUInt32BE());
    if (!format) invalid('fat entry does not contain a Mach-O header');
    const headerSize = format.bits === 64 ? 32 : 28;
    if (sliceSize < headerSize) invalid('truncated Mach-O header');
    const header = bounded(offset, headerSize);
    const { endian } = format;
    const cpuType = u32(header, 4, endian), cpuSubtype = u32(header, 8, endian);
    if (declared && (cpuType !== declared.cpuType || cpuSubtype !== declared.cpuSubtype)) {
      invalid('fat entry architecture disagrees with its Mach-O header');
    }
    const count = u32(header, 16, endian), commandBytes = u32(header, 20, endian);
    if (commandBytes > MAX_LOAD_COMMAND_BYTES || commandBytes > sliceSize - headerSize || count > commandBytes / 8) {
      invalid('load-command table exceeds its slice or safety bound');
    }
    const commands = bounded(offset + headerSize, commandBytes);
    const deploymentTargets = [];
    let cursor = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 8 > commandBytes) invalid('truncated load-command header');
      const command = u32(commands, cursor, endian), length = u32(commands, cursor + 4, endian);
      if (length < 8 || length % (format.bits === 64 ? 8 : 4) || length > commandBytes - cursor) {
        invalid('invalid load-command size');
      }
      if (command === 0x32) { // LC_BUILD_VERSION: platform, minos, sdk, ntools.
        if (length < 24 || u32(commands, cursor + 20, endian) > (length - 24) / 8) {
          invalid('truncated LC_BUILD_VERSION');
        }
        deploymentTargets.push({ command: 'LC_BUILD_VERSION', platform: u32(commands, cursor + 8, endian),
          minimumMacOS: version(u32(commands, cursor + 12, endian)), sdk: version(u32(commands, cursor + 16, endian)) });
      } else if (command === 0x24) { // LC_VERSION_MIN_MACOSX: version, sdk.
        if (length < 16) invalid('truncated LC_VERSION_MIN_MACOSX');
        deploymentTargets.push({ command: 'LC_VERSION_MIN_MACOSX', platform: 1,
          minimumMacOS: version(u32(commands, cursor + 8, endian)), sdk: version(u32(commands, cursor + 12, endian)) });
      }
      cursor += length;
    }
    if (cursor !== commandBytes) invalid('load-command count disagrees with table length');
    return { architecture: architecture(cpuType, cpuSubtype), cpuType, cpuSubtype,
      bits: format.bits, byteOrder: endian, offset, size: sliceSize, deploymentTargets };
  }

  if (size < 4) return null;
  const magic = bounded(0, 4).readUInt32BE();
  if (MACH_HEADERS.has(magic)) return { slices: [thin(0, size)] };
  const fat = FAT_HEADERS.get(magic);
  if (!fat) return null;
  const count = u32(bounded(0, 8), 4, fat.endian);
  if (count < 1 || count > 64) invalid('unsupported fat architecture count');
  const entrySize = fat.bits === 64 ? 32 : 20;
  const table = bounded(8, count * entrySize);
  const ranges = [];
  for (let index = 0; index < count; index++) {
    const cursor = index * entrySize;
    const cpuType = u32(table, cursor, fat.endian), cpuSubtype = u32(table, cursor + 4, fat.endian);
    const offset = fat.bits === 64 ? u64(table, cursor + 8, fat.endian) : u32(table, cursor + 8, fat.endian);
    const sliceSize = fat.bits === 64 ? u64(table, cursor + 16, fat.endian) : u32(table, cursor + 12, fat.endian);
    if (offset < 8 + table.length || sliceSize < 4 || offset > size || sliceSize > size - offset ||
        ranges.some(range => offset < range.offset + range.size && range.offset < offset + sliceSize)) {
      invalid('overlapping or out-of-bounds fat architecture slice');
    }
    ranges.push({ offset, size: sliceSize, cpuType, cpuSubtype });
  }
  return { slices: ranges.map(range => thin(range.offset, range.size, range)) };
}

function parseMachO(buffer) {
  if (!Buffer.isBuffer(buffer)) throw TypeError('Expected a Mach-O Buffer');
  return parseReader((offset, length) => buffer.subarray(offset, offset + length), buffer.length);
}

function parseMachOFile(file, expectedStat) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const actual = fs.fstatSync(descriptor);
    if (!actual.isFile() || actual.dev !== expectedStat.dev || actual.ino !== expectedStat.ino) {
      throw Error('Bundle file changed during verification');
    }
    return parseReader((offset, length) => {
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = fs.readSync(descriptor, bytes, read, length - read, offset + read);
        if (!count) invalid('file changed or ended while reading');
        read += count;
      }
      return bytes;
    }, actual.size);
  } finally { fs.closeSync(descriptor); }
}

function verifyDeploymentTargets(bundle, { architecture: requiredArchitecture, minimumMacOS = '13.0' } = {}) {
  if (!['arm64', 'x64'].includes(requiredArchitecture)) throw Error('Expected native arm64 or x64 architecture');
  const maximumTarget = versionNumber(minimumMacOS);
  if (!fs.lstatSync(bundle).isDirectory()) throw Error('Expected a real application bundle directory');
  const root = fs.realpathSync(bundle), files = [];
  const inside = target => target === root || target.startsWith(root + path.sep);
  function walk(directory) {
    if (!inside(fs.realpathSync(directory))) throw Error('Bundle directory escapes the application');
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), metadata = fs.lstatSync(file);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (metadata.isSymbolicLink()) {
        // Framework aliases are allowed, but inspected only via their real
        // files. A dangling or outside link cannot hide an unchecked library.
        if (!inside(fs.realpathSync(file))) throw Error(`Bundle symlink escapes the application: ${relative}`);
      } else if (metadata.isDirectory()) walk(file);
      else if (metadata.isFile()) {
        let macho;
        try { macho = parseMachOFile(file, metadata); }
        catch (error) { throw Error(`${relative}: ${error.message}`); }
        if (!macho) continue;
        const matching = macho.slices.filter(slice => slice.architecture === requiredArchitecture);
        if (matching.length !== 1) throw Error(`${relative}: expected exactly one ${requiredArchitecture} Mach-O slice`);
        const slice = matching[0];
        if (!slice.deploymentTargets.length) throw Error(`${relative}: missing macOS deployment target`);
        for (const target of slice.deploymentTargets) {
          if (target.platform !== 1) throw Error(`${relative}: ${requiredArchitecture} slice targets a non-macOS platform`);
          if (versionNumber(target.minimumMacOS) > maximumTarget) {
            throw Error(`${relative}: ${requiredArchitecture} requires macOS ${target.minimumMacOS}, above declared ${minimumMacOS}`);
          }
        }
        files.push({ path: relative, slices: macho.slices });
      } else throw Error(`Unexpected special file in application bundle: ${relative}`);
    }
  }
  walk(root);
  if (!files.length) throw Error('No Mach-O files found in application bundle');
  return { requiredArchitecture, declaredMinimumMacOS: minimumMacOS,
    checkedMachOFiles: files.length, runtimeTestedOnMinimumMacOS: false, files };
}

module.exports = { parseMachO, verifyDeploymentTargets };
