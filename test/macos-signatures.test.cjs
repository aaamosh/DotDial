'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { verifySignatures } = require('../scripts/macos-signatures.cjs');
const { BUNDLE_ID } = require('../scripts/package-macos.cjs');

const BUNDLE = path.resolve('fixture', 'DotDial.app');
const AUDIO = 'com.apple.security.device.audio-input';
const JIT = 'com.apple.security.cs.allow-jit';
const XML = values => '<plist version="1.0"><dict>' + Object.entries(values).map(([key, value]) =>
  `<key>${key}</key>${typeof value === 'boolean' ? `<${value}/>` : `<string>${value}</string>`}`).join('') + '</dict></plist>';

function fixture() {
  const app = { identifier: BUNDLE_ID, entitlements: { [JIT]: true, [AUDIO]: true }, stream: 'stdout' };
  const helper = { identifier: `${BUNDLE_ID}.helper`, entitlements: { [JIT]: true, [AUDIO]: true }, stream: 'stderr' };
  const lock = { identifier: 'dotdial-lock', entitlements: null, stream: 'stdout' };
  const calls = [];
  const h = { app, helper, lock, calls, plistIdentifier: helper.identifier };
  h.command = (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(options.timeout, 10_000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    const ok = { status: 0, stdout: '', stderr: '' };
    if (file === '/usr/bin/plutil') {
      assert.deepEqual(args.slice(0, 4), ['-convert', 'json', '-o', '-']);
      if (args.at(-1).endsWith('Info.plist')) return { ...ok, stdout: JSON.stringify({ CFBundleIdentifier: h.plistIdentifier }) };
      assert.equal(args.at(-1), '-');
      const source = [app, helper, lock].find(signature => signature.entitlements !== null && XML(signature.entitlements) === options.input);
      assert.ok(source, 'only an extracted entitlement plist is sent to plutil');
      return { ...ok, stdout: JSON.stringify(source.entitlements) };
    }
    assert.equal(file, '/usr/bin/codesign');
    const target = args.at(-1);
    const signature = target === BUNDLE ? app : target.endsWith('DotDial Helper.app') ? helper :
      target.endsWith('dotdial-lock') ? lock : null;
    assert.ok(signature, 'inspect each exact signed object, never a specialized helper in its place');
    if (args.includes('--verbose=4')) return { ...ok, [signature.stream]: `Executable=${target}\nIdentifier=${signature.identifier}\nSignature=adhoc\n` };
    assert.deepEqual(args.slice(0, 3), ['-d', '--entitlements', ':-']);
    if (signature.entitlements === null) return { ...ok, stderr: `Executable=${target}\n` };
    return { ...ok, stderr: `Executable=${target}\nwarning: Specifying ':' in the path is deprecated and will not work in a future release\n`,
      [signature.stream]: `<?xml version="1.0" encoding="UTF-8"?>\n${XML(signature.entitlements)}\n` };
  };
  return h;
}

test('signed app and generic helper identities and entitlements are read from either command stream', () => {
  const h = fixture();
  const result = verifySignatures(BUNDLE, h);
  assert.deepEqual(result.app, { identifier: BUNDLE_ID, entitlements: { [JIT]: true, [AUDIO]: true } });
  assert.deepEqual(result.helper, { identifier: `${BUNDLE_ID}.helper`, plistIdentifier: `${BUNDLE_ID}.helper`,
    entitlements: { [JIT]: true, [AUDIO]: true } });
  assert.deepEqual(result.configLock, { identifier: 'dotdial-lock', entitlements: {} });
  assert.equal(h.calls.filter(call => call.file.endsWith('/codesign')).length, 6);
  assert.ok(h.calls.every(call => !call.args.includes('--sign')), 'inspection never mutates a signature');
});

test('an explicitly empty signed entitlement dictionary is also valid for the lock helper', () => {
  const h = fixture(); h.lock.entitlements = {};
  assert.deepEqual(verifySignatures(BUNDLE, h).configLock.entitlements, {});
});

for (const object of ['app', 'helper']) {
  for (const entitlement of [AUDIO, JIT]) {
    for (const value of [undefined, false, 'true']) {
      test(`${object} rejects ${entitlement} when it is ${String(value)}`, () => {
        const h = fixture();
        if (value === undefined) delete h[object].entitlements[entitlement];
        else h[object].entitlements[entitlement] = value;
        assert.throws(() => verifySignatures(BUNDLE, h), /signed entitlement .* must be boolean true/);
      });
    }
  }
}

test('microphone entitlement on the app cannot compensate for its absence on the generic helper', () => {
  const h = fixture(); h.helper.entitlements = { [JIT]: true, nested: AUDIO };
  assert.throws(() => verifySignatures(BUNDLE, h), /DotDial Helper signed entitlement .*audio-input/);
});

test('the main signed identifier must equal the DotDial identity', () => {
  const h = fixture(); h.app.identifier = 'com.github.Electron';
  assert.throws(() => verifySignatures(BUNDLE, h), /DotDial app signed Identifier/);
});

test('the generic helper signed identifier must match its own Info.plist', () => {
  const h = fixture(); h.helper.identifier = `${BUNDLE_ID}.helper.Renderer`;
  assert.throws(() => verifySignatures(BUNDLE, h), /DotDial Helper signed Identifier/);
});

test('a matching non-DotDial helper identity is not accepted', () => {
  const h = fixture(); h.helper.identifier = h.plistIdentifier = 'com.github.Electron.helper';
  assert.throws(() => verifySignatures(BUNDLE, h), /DotDial Helper signed Identifier/);
});

for (const entitlements of [{ [AUDIO]: true }, { [JIT]: false }, { unrelated: 'value' }]) {
  test(`the lock helper rejects all entitlement keys: ${Object.keys(entitlements)[0]}`, () => {
    const h = fixture(); h.lock.entitlements = entitlements;
    assert.throws(() => verifySignatures(BUNDLE, h), /Config lock helper must have no signed entitlement keys/);
  });
}

for (const error of [
  { status: 1, stdout: '', stderr: 'invalid signature' },
  { status: null, signal: 'SIGKILL', stdout: '', stderr: '' },
  { status: 0, error: Object.assign(Error('timed out'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' },
]) {
  test(`command failure cannot produce successful signature evidence: ${error.signal || error.error?.code || error.status}`, () => {
    assert.throws(() => verifySignatures(BUNDLE, { command: () => error }), /signature inspection failed/);
  });
}

test('a thrown command error fails inspection', () => {
  assert.throws(() => verifySignatures(BUNDLE, { command() { throw Error('spawn failed'); } }), /signature inspection failed: spawn failed/);
});

test('malformed lock entitlement output must not be treated as an absent entitlement slot', () => {
  const h = fixture(), command = h.command;
  h.command = (file, args, options) => args.includes('--entitlements') && args.at(-1).endsWith('dotdial-lock')
    ? { status: 0, stdout: '<plist><dict>', stderr: '' } : command(file, args, options);
  assert.throws(() => verifySignatures(BUNDLE, h), /Config lock helper must expose exactly one entitlement plist/);
});

test('contradictory signed identities in command streams cannot be silently ignored', () => {
  const h = fixture(), command = h.command;
  h.command = (file, args, options) => {
    const result = command(file, args, options);
    return args.includes('--verbose=4') ? { ...result, stderr: result.stderr + '\nIdentifier=wrong\n' } : result;
  };
  assert.throws(() => verifySignatures(BUNDLE, h), /exactly one signed Identifier/);
});
