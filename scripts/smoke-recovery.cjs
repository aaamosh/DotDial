'use strict';
// Run under an isolated display. Every HTTPS request is served by a local
// fixture; this test never uses a real account, cloud call or microphone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { app, session, BrowserWindow } = require('electron');
const { defaults, getPaths, saveConfig } = require('../src/config.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-recovery-'));
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.XDG_DATA_HOME = path.join(root, 'data');
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_RUNTIME_DIR = path.join(root, 'run');
const paths = getPaths();
const thread = '00000000-0000-4000-8000-000000000001';
const config = structuredClone(defaults);
config.dot.url = 'https://chatgpt.com/dots/' + thread;
config.dot.expectedEmail = 'owner@example.com';
config.audio.sounds = false;
saveConfig(paths.configFile, config, { expectedHash: null });
fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(paths.stateDir, 'call-journal.json'), JSON.stringify({
  phase: 'stopping', callId: 'fixture-call', profileId: 'fixture-profile', accountId: 'fixture-account', threadId: thread,
}), { mode: 0o600 });
const claims = { exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { account_id: 'fixture-account' } };
const token = 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
let stopRequests = 0, pageLoads = 0;
const unexpected = [];
app.whenReady().then(() => {
  session.fromPartition('persist:dotdial').protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.origin !== 'https://chatgpt.com') { unexpected.push('origin'); return new Response('', { status: 403 }); }
    if (url.pathname === '/dots/' + thread) {
      pageLoads++;
      return new Response('<!doctype html><title>Fixture</title>', { headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === '/api/auth/session') return Response.json({ user: { email: 'owner@example.com' }, accessToken: token });
    if (url.pathname === '/backend-api/tbo/fixture-profile/voice/calls/fixture-call/stop' && request.method === 'POST') {
      stopRequests++;
      return stopRequests === 1
        ? new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } })
        : new Response(null, { status: 204 });
    }
    if (url.pathname !== '/favicon.ico') unexpected.push('path');
    return new Response('', { status: 404 });
  });
});
require('../src/main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = command => new Promise((resolve, reject) => {
  const client = net.connect(paths.socketPath);
  client.setTimeout(3000, () => { client.destroy(); reject(new Error('socket_timeout')); });
  client.once('error', reject);
  client.once('connect', () => client.write(command + '\n'));
  let buffer = '';
  client.on('data', chunk => {
    buffer += chunk;
    if (buffer.includes('\n')) { client.destroy(); resolve(JSON.parse(buffer.split('\n')[0])); }
  });
});
const timeout = setTimeout(() => { console.error('recovery_smoke_timeout'); app.exit(1); }, 20000);
void (async () => {
  while (!fs.existsSync(paths.socketPath)) await delay(50);
  const state = await request('STATUS');
  assert.equal(state.state, 'ready');
  assert.equal(state.local_listening, false);
  assert.equal(state.web_action_required, false);
  assert.equal(state.web_verifying, false);
  assert.equal(stopRequests, 2);
  assert.equal(pageLoads, 2);
  assert.deepEqual(unexpected, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'call-journal.json'))).phase, 'closed');
  assert.equal(BrowserWindow.getAllWindows().some(window => window.isVisible()), false);

  // A second file edit must survive a slow, already-running config update.
  const web = session.fromPartition('persist:dotdial');
  const setProxy = web.setProxy.bind(web);
  let releaseProxy, enteredProxy = false;
  const proxyGate = new Promise(resolve => { releaseProxy = resolve; });
  web.setProxy = async options => {
    if (options.proxyRules === 'http://127.0.0.1:9') { enteredProxy = true; await proxyGate; }
    return setProxy(options);
  };
  const firstEdit = structuredClone(config);
  firstEdit.network.signalingProxy = 'http://127.0.0.1:9';
  firstEdit.wakeWord.phrase = 'Computer';
  fs.writeFileSync(paths.configFile, JSON.stringify(firstEdit));
  while (!enteredProxy) await delay(50);
  const secondEdit = structuredClone(firstEdit);
  secondEdit.wakeWord.phrase = 'Hello Dot';
  fs.writeFileSync(paths.configFile, JSON.stringify(secondEdit));
  await delay(1100);
  releaseProxy();
  let reloaded;
  do { await delay(50); reloaded = await request('STATUS'); } while (reloaded.wake_phrase !== 'Hello Dot');
  assert.equal(reloaded.config_pending, false);
  console.log(JSON.stringify({ result: 'passed', recovered_same_call: true, stop_requests: stopRequests,
    page_loads: pageLoads, concurrent_config_edits_applied: true, no_visible_window: true, no_live_call: true }));
  clearTimeout(timeout);
  await request('QUIT');
})().catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(root, { recursive: true, force: true }));
