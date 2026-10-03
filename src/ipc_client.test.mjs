import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { errorMonitor } from 'node:events';
import { attachClient } from './ipc_client.cjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dotdial-ipc-'));
  const socketPath = path.join(dir, 'ipc.sock');
  const commands = [], errors = [];
  const server = net.createServer(client => {
    attachClient(client, command => { commands.push(command); return { state: 'ready' }; });
    client.on(errorMonitor, error => errors.push(error.code));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { socketPath, commands, errors };
}

function request(socketPath, chunks) {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath);
    let data = '';
    client.on('error', reject);
    client.on('connect', () => chunks.forEach(chunk => client.write(chunk)));
    client.on('data', chunk => { data += chunk; });
    client.on('end', () => resolve(JSON.parse(data)));
  });
}

test('a caller that closes before the reply cannot crash the IPC server', async t => {
  const h = await fixture(t);
  const result = spawnSync(process.execPath, ['-e', `
    const net = require('node:net');
    const c = net.connect(process.argv[1], () => c.write('STATUS\\n', () => c.destroy()));
    c.on('error', () => process.exit(1));
  `, h.socketPath], { timeout: 3000 });
  assert.equal(result.status, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(h.errors.includes('EPIPE') || h.errors.includes('ECONNRESET'), h.errors.join(','));
  assert.deepEqual(await request(h.socketPath, ['STATUS\n']), { state: 'ready' });
  assert.equal(h.commands.filter(c => c === 'STATUS').length, 2);
});

test('split commands dispatch once even when a second command follows', async t => {
  const h = await fixture(t);
  assert.deepEqual(await request(h.socketPath, ['WA', 'KE\nWAKE\n']), { state: 'ready' });
  assert.deepEqual(h.commands, ['WAKE']);
});
