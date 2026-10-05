'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');
const { createMacTrayPng, createDesktop, IPC } = require('../src/desktop.cjs');

function pixels(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), data = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  return { width, height, raw: zlib.inflateSync(Buffer.concat(data)) };
}

test('Mac tray templates have 1x/2x sizes, transparent edges and distinct monochrome states', () => {
  for (const scale of [1, 2]) {
    const shapes = new Set();
    for (const tone of ['idle', 'listening', 'connecting', 'call', 'warning']) {
      const image = pixels(createMacTrayPng(tone, scale));
      assert.equal(image.width, 16 * scale); assert.equal(image.height, 16 * scale);
      let visible = 0;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const start = y * (image.width * 4 + 1) + 1 + x * 4;
        assert.deepEqual([...image.raw.subarray(start, start + 3)], [0, 0, 0]);
        if (image.raw[start + 3]) visible++;
      }
      assert.ok(visible > 0 && visible < image.width * image.height);
      shapes.add(image.raw.toString('base64'));
    }
    assert.equal(shapes.size, 5, 'status must survive macOS template recoloring');
  }
});

function fixture(t, platform, { getAudioDevices } = {}) {
  const windows = [], commands = [], handlers = new Map(), images = [];
  let tray;
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
      this.webContents = new EventEmitter(); this.visible = false; this.destroyed = false;
      Object.assign(this.webContents, { isDestroyed: () => this.destroyed, setWindowOpenHandler() {}, send() {} });
      windows.push(this);
    }
    loadFile() { return Promise.resolve(); }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces(...args) { this.workspaces = args; }
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    getBounds() { return this.bounds; }
    getMinimumSize() { return [this.options.minWidth, this.options.minHeight]; }
    setTitle() {}
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    isVisible() { return this.visible; }
    hide() { this.visible = false; }
    focus() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  class Tray extends EventEmitter {
    constructor(icon) { super(); this.image = icon; this.destroyed = false; tray = this; }
    isDestroyed() { return this.destroyed; }
    setImage(value) { this.image = value; }
    setToolTip(value) { this.tooltip = value; }
    setTitle(value) { this.title = value; }
    setContextMenu(value) { this.menu = value; }
    popUpContextMenu() { assert.fail('macOS should let its assigned native menu handle the click'); }
    destroy() { this.destroyed = true; }
  }
  const screen = new EventEmitter();
  screen.getPrimaryDisplay = screen.getDisplayMatching = () => ({ workArea: { x: 0, y: 24, width: 1440, height: 876 } });
  const electron = { app: {}, BrowserWindow: Window, Tray, screen, dialog: {},
    Menu: { buildFromTemplate: template => ({ template, popup() {} }) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    nativeImage: { createFromBuffer(buffer) {
      const image = { buffer, representations: [], addRepresentation(rep) { this.representations.push(rep); }, setTemplateImage(value) { this.template = value; } };
      images.push(image); return image;
    } },
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  let desktop;
  try {
    desktop = createDesktop({ platform, command: async name => { commands.push(name); return { status: 'ok' }; }, getAudioDevices });
  } finally { Module._load = originalLoad; }
  t.after(() => desktop.dispose());
  return { desktop, tray, windows, commands, handlers, images };
}

test('opening the macOS menu bar item never places an implicit call', async t => {
  const f = fixture(t, 'darwin');
  f.tray.emit('click'); f.tray.emit('double-click'); f.tray.emit('right-click');
  assert.deepEqual(f.commands, []);
  assert.equal(f.tray.listenerCount('click'), 0);
  assert.equal(f.tray.image.template, true);
  assert.equal(pixels(f.tray.image.buffer).width, 16);
  const retina = f.tray.image.representations[0];
  assert.equal(retina.scaleFactor, 2);
  assert.equal(pixels(Buffer.from(retina.dataURL.split(',')[1], 'base64')).width, 32);
  f.tray.menu.template.find(item => item.label === 'Call your Dot').click();
  await Promise.resolve();
  assert.deepEqual(f.commands, ['WAKE']);
  f.desktop.update({ state: 'ready', missed_count: 8 });
  assert.equal(f.tray.title, '8');
  assert.match(f.tray.tooltip, /8 missed/);
});

test('Linux keeps its existing quick-call tray behavior and colored asset', async t => {
  const f = fixture(t, 'linux');
  f.tray.emit('click'); await Promise.resolve();
  assert.deepEqual(f.commands, ['WAKE']);
  assert.equal(f.tray.image.template, undefined);
  assert.equal(pixels(f.tray.image.buffer).width, 64);
  assert.equal(f.tray.listenerCount('double-click'), 1);
});

test('only the macOS call panel spans Spaces and full-screen apps', t => {
  for (const platform of ['darwin', 'linux']) {
    const f = fixture(t, platform);
    f.desktop.update({ state: 'active', microphone_muted: true });
    const panel = f.windows.find(window => window.options.focusable === false);
    assert.ok(panel);
    assert.equal(panel.visible, true);
    assert.deepEqual(panel.workspaces, platform === 'darwin' ? [true, { visibleOnFullScreen: true }] : undefined);
    const settings = f.desktop.openSettings();
    assert.equal(settings.workspaces, undefined);
  }
});

test('explicit device enumeration preserves actionable macOS permission errors', async t => {
  const f = fixture(t, 'darwin', { getAudioDevices: async () => { throw Object.assign(Error('denied'), { code: 'microphone_permission_denied' }); } });
  const settings = f.desktop.openSettings();
  const senderFrame = { url: pathToFileURL(path.join(__dirname, '../src/ui/index.html')).href, parent: null };
  const result = await f.handlers.get(IPC.devices)({ sender: settings.webContents, senderFrame });
  assert.deepEqual(result, { inputs: [], outputs: [], error: 'microphone_permission_denied' });
});
