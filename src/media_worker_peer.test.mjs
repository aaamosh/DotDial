import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routedChromiumMedia } from './media_worker_peer.mjs';

const rpcPath = fileURLToPath(new URL('./media_worker_rpc.cjs', import.meta.url));

async function workerFixture(t, mode) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dotdial-media-peer-test-'));
  const launcher = path.join(directory, 'launcher.sh');
  const worker = path.join(directory, 'fake-worker.cjs');
  await writeFile(launcher, '#!/bin/sh\nexec "$@"\n');
  await chmod(launcher, 0o700);
  await writeFile(worker, `
    const { RpcConnection } = require(${JSON.stringify(rpcPath)});
    let rpc;
    rpc = new RpcConnection(process.stdin, process.stdout, {
      idPrefix: 'fake',
      onRequest: async method => {
        if (method === 'peer.close' && ${JSON.stringify(mode)} === 'recording_close_failure') {
          rpc.notify('archive.recording', [true]);
          const error = new Error('close timeout');
          error.code = 'media_worker_timeout';
          throw error;
        }
        if (method === 'peer.close') return { closed: true };
        if (method === 'peer.createOffer') return { type: 'offer', sdp: 'fixture' };
        throw Object.assign(new Error('unexpected request'), { code: 'media_worker_protocol_error' });
      },
    });
    rpc.event('ready');
    if (${JSON.stringify(mode)} === 'crash_after_ready') setTimeout(() => process.exit(7), 30);
    process.stdin.once('end', () => setTimeout(() => process.exit(0), 5));
  `);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, launcher, worker };
}

function createPeer(fixture, extra = {}) {
  return routedChromiumMedia({
    archive: extra.archive || {},
    launcher: [fixture.launcher],
    electron: process.execPath,
    workerPath: fixture.worker,
    runtimeDir: fixture.directory,
    startupTimeoutMs: 3_000,
    closeTimeoutMs: 250,
    terminateGraceMs: 250,
    killGraceMs: 250,
  });
}

test('routed peer reports an uncertain final archive when worker peer.close fails', async t => {
  const fixture = await workerFixture(t, 'recording_close_failure');
  const errors = [];
  const Peer = createPeer(fixture, { archive: { setError: code => errors.push(code) } });
  const peer = new Peer();
  await peer.ready;
  await peer.close();
  assert.deepEqual(errors, ['recording_failed']);
  assert.equal(peer.recordingActive, true);
});

test('routed peer reports worker crashes and completes bounded cleanup', async t => {
  const fixture = await workerFixture(t, 'crash_after_ready');
  let reportFailure;
  const failure = new Promise(resolve => { reportFailure = resolve; });
  const Peer = createPeer(fixture);
  const peer = new Peer(() => {}, () => {}, error => reportFailure(error.code));
  await peer.ready;
  let timer;
  try {
    assert.equal(await Promise.race([
      failure,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('worker crash was not reported')), 2_000); }),
    ]), 'media_worker_exited');
  } finally { clearTimeout(timer); }
  await peer.close();
  assert.equal(peer.childClosed, true);
});
