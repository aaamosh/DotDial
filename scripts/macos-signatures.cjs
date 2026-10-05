'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BUNDLE_ID } = require('./package-macos.cjs');

const REQUIRED_ENTITLEMENTS = ['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input'];

function verifySignatures(bundle, { command = spawnSync } = {}) {
  const run = (file, args, input) => {
    let result;
    try {
      result = command(file, args, { encoding: 'utf8', timeout: 10_000,
        killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, input,
        stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      throw Error(`${path.basename(file)} signature inspection failed: ${error.message}`, { cause: error });
    }
    if (!result || result.status !== 0 || result.error || result.signal) {
      throw Error(`${path.basename(file)} signature inspection failed (${result?.status ?? result?.signal ?? result?.error?.code}):\n` +
        `${result?.stdout || ''}\n${result?.stderr || ''}`);
    }
    return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  };
  const dictionary = (text, label) => {
    let value;
    try { value = JSON.parse(text); }
    catch { throw Error(`${label} did not produce a valid property-list dictionary.`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Error(`${label} must be a property-list dictionary.`);
    }
    return value;
  };
  const inspect = (target, label, { allowNoEntitlements = false } = {}) => {
    const display = run('/usr/bin/codesign', ['-d', '--verbose=4', target]);
    const identifiers = [...`${display.stdout}\n${display.stderr}`.matchAll(/^Identifier=([^\r\n]+)$/gm)];
    if (identifiers.length !== 1) throw Error(`${label} must have exactly one signed Identifier.`);
    const identifier = identifiers[0][1];
    const extracted = run('/usr/bin/codesign', ['-d', '--entitlements', ':-', target]);
    // codesign versions send the XML to different streams. Extract only the
    // plist document, leaving diagnostics outside the data fed to plutil.
    const output = `${extracted.stdout}\n${extracted.stderr}`;
    const documents = [...output.matchAll(/<plist\b[^>]*>[\s\S]*?<\/plist>/g)];
    let entitlements;
    if (documents.length === 1) {
      entitlements = dictionary(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], documents[0][0]).stdout, `${label} entitlements`);
    } else if (allowNoEntitlements && documents.length === 0 && output.trim().split(/\r?\n/).every(line =>
      !line.trim() || /^Executable=.+$/.test(line) ||
      /^warning: Specifying ':' in the path is deprecated\b/.test(line) ||
      /^(?:.*: )?code object has no entitlements$/.test(line))) {
      // A valid signed executable can have no entitlement slot at all.
      entitlements = {};
    } else {
      throw Error(`${label} must expose exactly one entitlement plist (or none for the config lock helper).`);
    }
    return { identifier, entitlements };
  };
  const requireAudio = (signature, label) => {
    for (const entitlement of REQUIRED_ENTITLEMENTS) {
      if (signature.entitlements[entitlement] !== true) {
        throw Error(`${label} signed entitlement ${entitlement} must be boolean true.`);
      }
    }
  };

  const app = inspect(bundle, 'DotDial app');
  if (app.identifier !== BUNDLE_ID) throw Error(`DotDial app signed Identifier must be ${BUNDLE_ID}.`);
  requireAudio(app, 'DotDial app');

  const helperPath = path.join(bundle, 'Contents', 'Frameworks', 'DotDial Helper.app');
  const helperInfo = dictionary(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-',
    path.join(helperPath, 'Contents', 'Info.plist')]).stdout, 'DotDial Helper Info.plist');
  const helper = inspect(helperPath, 'DotDial Helper');
  if (typeof helperInfo.CFBundleIdentifier !== 'string' || !helperInfo.CFBundleIdentifier.startsWith(BUNDLE_ID + '.helper') ||
      helper.identifier !== helperInfo.CFBundleIdentifier) {
    throw Error('DotDial Helper signed Identifier must match its DotDial Info.plist identity.');
  }
  helper.plistIdentifier = helperInfo.CFBundleIdentifier;
  requireAudio(helper, 'DotDial Helper');

  const configLock = inspect(path.join(bundle, 'Contents', 'Resources', 'dotdial-lock'), 'Config lock helper', { allowNoEntitlements: true });
  if (Object.keys(configLock.entitlements).length !== 0) throw Error('Config lock helper must have no signed entitlement keys.');
  return { app, helper, configLock };
}

module.exports = { verifySignatures };
