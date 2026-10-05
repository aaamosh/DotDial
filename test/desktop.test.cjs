'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const EventEmitter = require('node:events');
const Module = require('node:module');
const { presentState, createTrayPng, readPanelPosition, savePanelPosition, clampPanelPosition, settingsWindowGeometry, clampSettingsBounds, IPC } = require('../src/desktop.cjs');
const { installQuitBarrier } = require('../src/quit_guard.cjs');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset); offset += 4;
    const type = buffer.toString('ascii', offset, offset + 4); offset += 4;
    const data = buffer.subarray(offset, offset + length); offset += length;
    const expected = buffer.readUInt32BE(offset); offset += 4;
    assert.equal(crc32(buffer.subarray(offset - length - 8, offset - 4)), expected, `${type} checksum`);
    chunks.push({ type, data });
    if (type === 'IEND') break;
  }
  const header = chunks.find(chunk => chunk.type === 'IHDR').data;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  return { width, height, pixels: zlib.inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data))) };
}

test('tray status colors follow call, connection and wake-listening state', () => {
  assert.equal(presentState({ state: 'active' }).tone, 'call');
  assert.equal(presentState({ state: 'starting' }).tone, 'connecting');
  assert.equal(presentState({ state: 'ready', local_listening: true }).tone, 'listening');
  assert.equal(presentState({ state: 'ready' }).tone, 'idle');
  assert.equal(presentState({ state: 'recovery_required' }).tone, 'warning');
  assert.equal(presentState({ state: 'active', last_error: 'stale' }).tone, 'call');
});

test('tray tooltip and missed badge count are bounded and clear', () => {
  assert.equal(presentState({ state: 'ready', missed_count: 4 }).missedCount, 4);
  assert.match(presentState({ state: 'ready', missed_count: 4 }).tooltip, /4 missed/);
  assert.equal(presentState({ state: 'ready', missed_count: -3 }).missedCount, 0);
  assert.equal(presentState({ state: 'ready', missed_count: 1000 }).missedCount, 999);
});

test('tray shows web sign-in action and verification status with call-state priority', () => {
  const action = presentState({ state: 'ready', web_action_required: true });
  assert.equal(action.tone, 'warning');
  assert.equal(action.tooltip, 'DotDial · Verify ChatGPT sign-in');
  const verifying = presentState({ state: 'ready', web_verifying: true });
  assert.equal(verifying.tone, 'connecting');
  assert.equal(verifying.tooltip, 'DotDial · Checking ChatGPT access');
  assert.equal(presentState({ state: 'active', web_action_required: true }).tooltip, 'DotDial · In call');
  assert.equal(presentState({ state: 'starting', web_verifying: true }).tooltip, 'DotDial · Checking ChatGPT access');
});

test('settings window targets a compact centered size and remains inside small work areas', () => {
  assert.deepEqual(settingsWindowGeometry({ x: 100, y: 40, width: 1440, height: 900 }), {
    x: 480, y: 236, width: 680, height: 507, minWidth: 520, minHeight: 360,
  });
  assert.deepEqual(settingsWindowGeometry({ x: 0, y: 0, width: 600, height: 400 }), {
    x: 0, y: 0, width: 600, height: 400, minWidth: 520, minHeight: 360,
  });
  const small = settingsWindowGeometry({ x: 20, y: 30, width: 430, height: 320 });
  assert.deepEqual(small, { x: 20, y: 30, width: 430, height: 320, minWidth: 430, minHeight: 320 });
  assert.deepEqual(clampSettingsBounds({ x: 1000, y: -30, width: 800, height: 600 }, { x: -1280, y: 0, width: 1280, height: 720 }), {
    x: -800, y: 0, width: 800, height: 600,
  });
  assert.deepEqual(clampSettingsBounds({ x: 1000, y: -30, width: 1800, height: 900 }, { x: -1280, y: 0, width: 1280, height: 720 }), {
    x: -1280, y: 0, width: 1280, height: 720,
  });
});

test('tray asset is a valid transparent 64px PNG and changes for status and missed count', () => {
  const idle = createTrayPng('idle', 0);
  const active = createTrayPng('call', 0);
  const missed = createTrayPng('idle', 3);
  const parsed = decodePng(idle);
  assert.equal(parsed.width, 64);
  assert.equal(parsed.height, 64);
  assert.equal(parsed.pixels.length, 64 * (64 * 4 + 1));
  assert.notDeepEqual(active, idle);
  assert.notDeepEqual(missed, idle);
  assert.equal(parsed.pixels[0], 0); // PNG filter byte on the first transparent row.
});

test('desktop pages keep Electron isolated and restrict their renderer surface', () => {
  const base = path.join(__dirname, '..', 'src');
  const desktop = fs.readFileSync(path.join(base, 'desktop.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(base, 'ui', 'preload.cjs'), 'utf8');
  const html = fs.readFileSync(path.join(base, 'ui', 'index.html'), 'utf8');
  assert.match(desktop, /contextIsolation:\s*true/);
  assert.match(desktop, /nodeIntegration:\s*false/);
  assert.match(desktop, /sandbox:\s*true/);
  assert.match(desktop, /trustedSender/);
  assert.match(desktop, /snapshot\.web_action_required\s*===\s*true\s*\?\s*'Verify ChatGPT sign-in'/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.doesNotMatch(preload, /exposeInMainWorld\(\s*['"](?:electron|ipcRenderer)['"]/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /frame-ancestors 'none'/);
  assert.equal(IPC.command, 'dotdial:command');
});

test('call controls expose icon-only labels and rounded glass clipping', () => {
  const base = path.join(__dirname, '..', 'src', 'ui');
  const html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(base, 'style.css'), 'utf8');
  for (const id of ['panel-mic', 'panel-speakers', 'panel-hangup']) {
    assert.match(html, new RegExp(`id="${id}"[^>]+aria-label="[^"]+"`));
  }
  assert.match(css, /\.panel-glass\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.panel-glass\s*\{[^}]*border-radius:\s*12px/s);
});

for (const platform of ['linux', 'darwin']) test(`Quit menu waits for shutdown and ignores repeated quit requests (${platform})`, async () => {
  const app = new EventEmitter();
  let quitRequests = 0, preventedQuits = 0, defaultQuits = 0, exitCalls = 0;
  app.quit = () => {
    quitRequests++;
    let prevented = false;
    app.emit('before-quit', { preventDefault() { prevented = true; } });
    if (prevented) preventedQuits++;
    else defaultQuits++;
  };
  app.exit = code => { assert.equal(code, 0); exitCalls++; };

  let releaseCleanup;
  const cleanupFinished = new Promise(resolve => { releaseCleanup = resolve; });
  let cleanupStarted = 0;
  installQuitBarrier(app, () => {
    cleanupStarted++;
    void cleanupFinished.then(() => app.exit(0));
  });

  let trayInstance;
  class Tray extends EventEmitter {
    constructor() { super(); this.destroyed = false; trayInstance = this; }
    isDestroyed() { return this.destroyed; }
    setImage() {}
    setToolTip() {}
    setTitle() {}
    setContextMenu(menu) { this.contextMenu = menu; }
    destroy() { this.destroyed = true; }
  }
  const electron = {
    Tray,
    Menu: { buildFromTemplate: template => template },
    ipcMain: { handle() {}, removeHandler() {} },
    nativeImage: { createFromBuffer: () => ({ addRepresentation() {}, setTemplateImage() {} }) },
    app,
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };

  let desktop;
  try {
    const { createDesktop } = require('../src/desktop.cjs');
    const commands = [];
    desktop = createDesktop({ platform, command: async name => {
      commands.push(name);
      if (name === 'QUIT') app.quit();
      return { status: 'ok' };
    } });

    desktop.update({ state: 'ready' });
    trayInstance.contextMenu.find(item => item.label === 'Quit DotDial').click();
    app.quit(); // Simulate a second quit request arriving during asynchronous cleanup.

    assert.deepEqual(commands, ['QUIT']);
    assert.equal(quitRequests, 2);
    assert.equal(preventedQuits, 2);
    assert.equal(defaultQuits, 0);
    assert.equal(cleanupStarted, 1);
    assert.equal(exitCalls, 0);

    releaseCleanup();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exitCalls, 1);
    assert.equal(cleanupStarted, 1);
  } finally {
    desktop?.dispose();
    Module._load = originalLoad;
  }
});


test('panel position survives a fresh read and incomplete state falls back safely', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-position-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'panel-position.json');
  assert.equal(readPanelPosition(file), null);
  assert.equal(savePanelPosition(file, { x: -480, y: 312 }), true);
  assert.deepEqual(readPanelPosition(file), { x: -480, y: 312 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['panel-position.json']);
  assert.equal(savePanelPosition(file, { x: NaN, y: 3 }), false);
  assert.deepEqual(readPanelPosition(file), { x: -480, y: 312 });
  for (const invalid of ['{', 'null', '{"version":2,"x":1,"y":2}', '{"version":1,"x":"1","y":2}', ' '.repeat(1025)]) {
    fs.writeFileSync(file, invalid);
    assert.equal(readPanelPosition(file), null);
  }
  assert.equal(savePanelPosition(path.join(dir, 'absent', 'panel.json'), { x: 1, y: 2 }), false);
});

test('restored panel stays inside the current monitor work area', () => {
  const size = { width: 122, height: 42 };
  const primary = { x: 0, y: 24, width: 1920, height: 1016 };
  assert.deepEqual(clampPanelPosition({ x: 280, y: 250 }, primary, size), { x: 280, y: 250 });
  assert.deepEqual(clampPanelPosition({ x: 4000, y: -500 }, primary, size), { x: 1798, y: 24 });
  const leftMonitor = { x: -1280, y: 0, width: 1280, height: 720 };
  assert.deepEqual(clampPanelPosition({ x: -640, y: 500 }, leftMonitor, size), { x: -640, y: 500 });
  assert.deepEqual(clampPanelPosition({ x: -2000, y: 900 }, leftMonitor, size), { x: -1280, y: 678 });
  assert.deepEqual(clampPanelPosition({ x: -50, y: -50 }, { x: 0, y: 0, width: 100, height: 30 }, size), { x: 0, y: 0 });
});
