import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FrameReader, RpcConnection, encodeFrame } = require('./media_worker_rpc.cjs');

function rpcPair(parentOptions = {}, workerOptions = {}) {
  const parentToWorker = new PassThrough();
  const workerToParent = new PassThrough();
  const parent = new RpcConnection(workerToParent, parentToWorker, { idPrefix: 'p', ...parentOptions });
  const worker = new RpcConnection(parentToWorker, workerToParent, { idPrefix: 'w', ...workerOptions });
  return { parent, worker, parentToWorker, workerToParent };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('RPC preserves binary archive segments and waits for the archive acknowledgement before peer.close', async () => {
  const segment = Buffer.from([0x00, 0x80, 0xff, 0x41, 0x00, 0x7f]);
  const archiveAck = deferred();
  let archivePayload;
  let closeResolved = false;
  let mediaWorker;
  const links = rpcPair({
    onRequest: async (method, args) => {
      assert.equal(method, 'archive.save');
      archivePayload = Buffer.from(args[0]);
      return archiveAck.promise;
    },
  }, {
    onRequest: async method => {
      assert.equal(method, 'peer.close');
      const saved = await mediaWorker.request('archive.save', [segment]);
      return { closed: true, saved };
    },
  });
  const peer = links.parent;
  mediaWorker = links.worker;

  const closing = peer.request('peer.close').then(value => {
    closeResolved = true;
    return value;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(archivePayload, segment);
  assert.equal(closeResolved, false);
  archiveAck.resolve({ saved: true, id: 'clip-1' });
  assert.deepEqual(await closing, { closed: true, saved: { saved: true, id: 'clip-1' } });
  assert.equal(closeResolved, true);
  links.parentToWorker.end();
});

test('frame reader accepts multiple individually bounded frames in one large chunk', () => {
  const received = [];
  const failures = [];
  const reader = new FrameReader(message => received.push(message.payload.length), error => failures.push(error.code));
  const first = encodeFrame({ payload: Buffer.alloc(8 * 1024 * 1024, 0x31) });
  const second = encodeFrame({ payload: Buffer.alloc(8 * 1024 * 1024, 0x32) });
  assert.ok(first.length + second.length > 16 * 1024 * 1024 + 4);
  reader.push(Buffer.concat([first, second]));
  assert.deepEqual(received, [8 * 1024 * 1024, 8 * 1024 * 1024]);
  assert.deepEqual(failures, []);
});

test('truncated frame is reported when the peer reaches EOF', () => {
  const failures = [];
  const reader = new FrameReader(() => assert.fail('truncated frame must not dispatch'), error => failures.push(error.code));
  reader.push(Buffer.from([0x00, 0x00, 0x00, 0x08, 0x01, 0x02]));
  reader.end();
  assert.deepEqual(failures, ['media_worker_protocol_error']);
});

test('unexpected RPC EOF rejects pending requests', async () => {
  const { parent, workerToParent } = rpcPair();
  const request = parent.request('peer.waitForOpen', [], 10_000);
  const rejected = assert.rejects(request, { code: 'media_worker_eof' });
  workerToParent.end();
  await rejected;
});
