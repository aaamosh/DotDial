'use strict';

const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { RpcConnection, codedError, safeErrorCode } = require('./media_worker_rpc.cjs');

function workerDataPath() {
  const arg = process.argv.find(value => value.startsWith('--dotdial-media-user-data='));
  const directory = arg?.slice('--dotdial-media-user-data='.length);
  if (!directory || !path.isAbsolute(directory) || !/^dotdial-media-[A-Za-z0-9_-]+$/.test(path.basename(directory))) {
    throw codedError('media_worker_profile_invalid');
  }
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch { throw codedError('media_worker_profile_invalid'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw codedError('media_worker_profile_invalid');
  }
  return directory;
}

let userData;
try { userData = workerDataPath(); }
catch (error) { process.exitCode = 2; process.exit(); }
if (!userData) return;

app.setName('DotDialMedia');
app.setPath('userData', userData);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let peer = null;
let defaultSpeakersMuted = false;
let shuttingDown = false;
let shutdownPromise = null;
let startupFailed = false;
let rpc;
let mediaOptions = {};
try {
  const encoded = process.argv.find(v => v.startsWith('--dotdial-media-options='))?.split('=')[1];
  if (encoded) mediaOptions = JSON.parse(Buffer.from(encoded, 'base64url').toString());
} catch { app.exit(2); }

async function archiveRequest(method, args) {
  if (method !== 'archive.save' || !Array.isArray(args) || args.length !== 1) {
    throw codedError('media_worker_protocol_error');
  }
  return rpc.request('archive.save', args, 30_000);
}

async function handleRequest(method, args) {
  if (!Array.isArray(args)) throw codedError('media_worker_protocol_error');
  if (method === 'peer.setDefaultSpeakersMuted') {
    defaultSpeakersMuted = args[0] === true;
    return { speakers_muted: defaultSpeakersMuted };
  }
  if (!peer) throw codedError(startupFailed ? 'media_worker_start_failed' : 'media_worker_starting');
  switch (method) {
    case 'peer.createOffer': return peer.createOffer();
    case 'peer.acceptAnswer': return peer.acceptAnswer(args[0]);
    case 'peer.waitForOpen': return peer.waitForOpen(args[0]);
    case 'peer.getStats': return peer.getStats();
    case 'peer.stopMicrophone': return peer.stopMicrophone();
    case 'peer.setSpeakersMuted': return peer.setSpeakersMuted(args[0] === true);
    case 'peer.flushRecording': return peer.flushRecording();
    case 'peer.startMicrophone':
      await peer.startMicrophone();
      return peer.microphoneSettings || {};
    case 'peer.close':
      await peer.close();
      return { closed: true };
    default: throw codedError('media_worker_protocol_error');
  }
}

function handleNotification(method, args) {
  if (method === 'worker.shutdown') void shutdown(0);
}

rpc = new RpcConnection(process.stdin, process.stdout, {
  idPrefix: 'w',
  onRequest: handleRequest,
  onNotification: handleNotification,
  onFailure: error => {
    if (shuttingDown) return;
    // EOF is the parent's normal shutdown signal after it has awaited peer.close.
    // Any other protocol/transport failure must tear down the mic-owning child now.
    void shutdown(error?.code === 'media_worker_eof' ? 0 : 2);
  },
});

function notifyRecording(active) {
  try { rpc.notify('archive.recording', [active === true]); } catch {}
}

function notifyError(code) {
  const safe = ['recording_unavailable', 'storage_full'].includes(code) ? code : 'recording_failed';
  try { rpc.notify('archive.error', [safe]); } catch {}
}

function reportMediaFailure() {
  try { rpc.event('media.failure'); } catch {}
}

async function initialize() {
  try {
    const { chromiumMedia } = await import(pathToFileURL(path.join(__dirname, 'chromium_media.mjs')).href);
    const archive = {
      save: payload => archiveRequest('archive.save', [payload]),
      setRecording: notifyRecording,
      setError: notifyError,
    };
    const MediaPeer = chromiumMedia({
      BrowserWindow,
      session,
      ipcMain,
      archive,
      getSpeakersMuted: () => defaultSpeakersMuted,
      mediaOptions,
    });
    peer = new MediaPeer(() => {}, () => {}, reportMediaFailure);
    await peer.ready;
    if (shuttingDown) return shutdown(0);
    rpc.event('ready');
  } catch (error) {
    startupFailed = true;
    if (!shuttingDown) {
      try { rpc.event('startup_error', { code: safeErrorCode(error, 'media_worker_start_failed') }); } catch {}
      void shutdown(2);
    }
  }
}

function shutdown(exitCode) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    try { await peer?.close(); } catch { notifyError('recording_failed'); }
    try { app.exit(exitCode); } catch { process.exit(exitCode); }
  })();
  return shutdownPromise;
}

process.stdin.once('end', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });
process.once('SIGINT', () => { void shutdown(0); });
process.on('uncaughtException', error => {
  startupFailed = true;
  try { rpc.event('fatal', { code: safeErrorCode(error, 'media_worker_failed') }); } catch {}
  void shutdown(2);
});
process.on('unhandledRejection', error => {
  startupFailed = true;
  try { rpc.event('fatal', { code: safeErrorCode(error, 'media_worker_failed') }); } catch {}
  void shutdown(2);
});
app.on('before-quit', event => {
  if (shuttingDown) return;
  event.preventDefault();
  void shutdown(0);
});

app.whenReady().then(initialize).catch(error => {
  startupFailed = true;
  try { rpc.event('startup_error', { code: safeErrorCode(error, 'media_worker_start_failed') }); } catch {}
  void shutdown(2);
});
