'use strict';

const path = require('node:path');
const fs = require('node:fs');

const UI_FILE = path.join(__dirname, 'ui', 'index.html');
const PRELOAD_FILE = path.join(__dirname, 'ui', 'preload.cjs');
const IPC = Object.freeze({
  state: 'dotdial:state',
  configRead: 'dotdial:config-read',
  configSave: 'dotdial:config-save',
  command: 'dotdial:command',
  devices: 'dotdial:devices',
  menu: 'dotdial:menu',
  move: 'dotdial:move',
});
const COMMANDS = new Set([
  'WAKE', 'STOP', 'MUTE', 'UNMUTE', 'SPEAKERS_MUTE', 'SPEAKERS_UNMUTE',
  'MISSED_PLAY', 'MISSED_STOP', 'MISSED_CLEAR', 'LOGIN', 'WAKE_SETUP', 'QUIT',
]);

function safeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (/^[a-z][a-z0-9_]{0,63}$/i.test(key) &&
        (value === null || ['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value))) {
      out[key] = value;
    }
  }
  return out;
}

function presentState(state = {}) {
  const phase = String(state.state || state.phase || 'ready');
  const missedCount = Math.max(0, Math.min(999, Number(state.missed_count) || 0));
  if (phase === 'active') return { phase, tone: 'call', missedCount, tooltip: `DotDial · In call${missedCount ? ` · ${missedCount} missed` : ''}` };
  if (phase === 'starting' || phase === 'stopping') return { phase, tone: 'connecting', missedCount, tooltip: `DotDial · ${phase === 'starting' ? 'Connecting' : 'Ending call'}${missedCount ? ` · ${missedCount} missed` : ''}` };
  if (phase === 'recovery_required' || state.last_error || state.start_error || state.config_error || state.wake_status === 'error' || state.wake_status === 'setup_required') return { phase, tone: 'warning', missedCount, tooltip: `DotDial · Check connection${missedCount ? ` · ${missedCount} missed` : ''}` };
  if (state.wake_status === 'starting' || state.wake_status === 'installing') return { phase, tone: 'connecting', missedCount, tooltip: `DotDial · Preparing wake word${missedCount ? ` · ${missedCount} missed` : ''}` };
  if (state.local_listening || state.wake_listening || state.wake_status === 'listening') return { phase, tone: 'listening', missedCount, tooltip: `DotDial · Wake word listening${missedCount ? ` · ${missedCount} missed` : ''}` };
  return { phase, tone: 'idle', missedCount, tooltip: `DotDial${missedCount ? ` · ${missedCount} missed` : ''}` };
}

const PIXEL_DIGITS = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const body = Buffer.concat([name, data]);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, checksum]);
}

function createTrayPng(tone = 'idle', missedCount = 0) {
  const size = 64, stride = size * 4, pixels = Buffer.alloc(stride * size);
  const colors = {
    idle: [157, 174, 192], listening: [68, 204, 145], connecting: [243, 179, 79],
    call: [235, 88, 91], warning: [240, 151, 83],
  };
  const accent = colors[tone] || colors.idle;
  const setPixel = (x, y, rgba) => {
    const i = (Math.floor(y) * size + Math.floor(x)) * 4;
    if (i < 0 || i + 3 >= pixels.length) return;
    pixels[i] = rgba[0]; pixels[i + 1] = rgba[1]; pixels[i + 2] = rgba[2]; pixels[i + 3] = rgba[3];
  };
  const drawCircle = (cx, cy, radius, color, softness = 1) => {
    for (let y = Math.max(0, Math.floor(cy - radius - 2)); y <= Math.min(size - 1, Math.ceil(cy + radius + 2)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius - 2)); x <= Math.min(size - 1, Math.ceil(cx + radius + 2)); x++) {
        const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const alpha = Math.max(0, Math.min(1, (radius + softness / 2 - distance) / softness));
        if (alpha > 0) setPixel(x, y, [...color.slice(0, 3), Math.round((color[3] ?? 255) * alpha)]);
      }
    }
  };
  // A clean ring with a small breathing point reads at Linux's 22px tray scale.
  drawCircle(32, 31, 24, [accent[0], accent[1], accent[2], 255]);
  drawCircle(32, 31, 18, [0, 0, 0, 0]);
  drawCircle(32, 31, 6, [232, 239, 246, 255]);
  drawCircle(32, 31, 2.5, [accent[0], accent[1], accent[2], 255]);
  const count = Math.max(0, Number(missedCount) || 0);
  if (count > 0) {
    const label = count > 9 ? '9+' : String(count);
    drawCircle(48, 48, 13, [15, 22, 31, 255]);
    drawCircle(48, 48, 10, [246, 249, 252, 255]);
    const glyphs = label.split('');
    const scale = 2;
    const width = glyphs.length * 3 * scale + (glyphs.length - 1) * scale;
    let left = 48 - width / 2;
    for (const glyph of glyphs) {
      const rows = PIXEL_DIGITS[glyph] || PIXEL_DIGITS['9'];
      rows.forEach((row, y) => [...row].forEach((bit, x) => {
        if (bit === '1') drawCircle(left + x * scale + scale / 2, 48 - 5 + y * scale + scale / 2, 0.95, [24, 35, 49, 255], 1.5);
      }));
      left += 4 * scale;
    }
  }
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', require('node:zlib').deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function jsonClone(value, maxBytes = 48 * 1024) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw Object.assign(new Error('invalid_config'), { code: 'invalid_config' }); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maxBytes) throw Object.assign(new Error('invalid_config'), { code: 'invalid_config' });
  return JSON.parse(encoded);
}

function safeErrorCode(error) {
  const code = error && typeof error.code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(error.code) ? error.code : 'operation_failed';
  return code;
}

function validPanelPosition(value) {
  return value && Number.isInteger(value.x) && Number.isInteger(value.y) &&
    Math.abs(value.x) <= 1000000 && Math.abs(value.y) <= 1000000;
}

function readPanelPosition(file) {
  if (!file) return null;
  try {
    if (fs.statSync(file).size > 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.version === 1 && validPanelPosition(value) ? { x: value.x, y: value.y } : null;
  } catch { return null; }
}

function savePanelPosition(file, position) {
  if (!file || !validPanelPosition(position)) return false;
  const temporary = `${file}.${require('node:crypto').randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, x: position.x, y: position.y }) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    return true;
  } catch { return false; }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}

function clampPanelPosition(position, area, size) {
  return {
    x: Math.max(area.x, Math.min(area.x + Math.max(0, area.width - size.width), position.x)),
    y: Math.max(area.y, Math.min(area.y + Math.max(0, area.height - size.height), position.y)),
  };
}

function createDesktop({ getSnapshot, getConfig, saveConfig, command, paths = {}, getAudioDevices } = {}) {
  const electron = require('electron');
  const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog } = electron;
  const stateProvider = typeof getSnapshot === 'function' ? getSnapshot : () => ({});
  const configProvider = typeof getConfig === 'function' ? getConfig : () => ({ config: {}, hash: '' });
  const saveProvider = typeof saveConfig === 'function' ? saveConfig : async () => { throw Object.assign(new Error('saving_unavailable'), { code: 'saving_unavailable' }); };
  const dispatch = typeof command === 'function' ? command : async () => ({ status: 'unavailable' });
  let tray = null, panel = null, settings = null, snapshot = safeState(stateProvider());
  let configCache = jsonClone(configProvider()), disposed = false;
  const positionFile = paths.stateDir ? path.join(paths.stateDir, 'panel-position.json') : null;
  let positionTimer = null, savedPosition = null;
  const persistPanelPosition = () => {
    clearTimeout(positionTimer); positionTimer = null;
    if (!panel || panel.isDestroyed()) return;
    const [x, y] = panel.getPosition();
    if (savedPosition?.x === x && savedPosition?.y === y) return;
    if (savePanelPosition(positionFile, { x, y })) savedPosition = { x, y };
  };
  const keepPanelVisible = () => {
    if (!panel || panel.isDestroyed()) return;
    const bounds = panel.getBounds();
    const position = clampPanelPosition(bounds, screen.getDisplayMatching(bounds).workArea, bounds);
    if (position.x !== bounds.x || position.y !== bounds.y) panel.setPosition(position.x, position.y, false);
  };
  screen?.on?.('display-removed', keepPanelVisible);
  screen?.on?.('display-metrics-changed', keepPanelVisible);
  const handlers = [];
  const windows = () => [panel, settings].filter(Boolean);
  const callCommand = async (name, payload) => {
    if (!COMMANDS.has(name)) return { status: 'invalid_command' };
    try { return await dispatch(name, payload); }
    catch (error) { return { status: safeErrorCode(error) }; }
  };
  const send = (win, channel, payload) => {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  };
  const sendState = () => { for (const win of windows()) send(win, IPC.state, snapshot); };
  const trustedSender = event => {
    const owner = windows().find(win => win.webContents === event.sender);
    if (!owner || owner.isDestroyed() || !event.senderFrame) return false;
    if (event.senderFrame.parent) return false;
    try {
      const url = new URL(event.senderFrame.url);
      return url.protocol === 'file:' && path.resolve(decodeURIComponent(url.pathname)) === UI_FILE;
    } catch { return false; }
  };
  const handle = (channel, fn) => {
    const wrapped = (event, ...args) => {
      if (!trustedSender(event)) throw Object.assign(new Error('untrusted_renderer'), { code: 'untrusted_renderer' });
      return fn(event, ...args);
    };
    ipcMain.handle(channel, wrapped);
    handlers.push(channel);
  };
  const optionsFor = ({ width, height, minWidth, minHeight, transparent, alwaysOnTop = false, resizable = true }) => ({
    width, height, minWidth, minHeight, show: false, frame: !transparent,
    icon: nativeImage.createFromBuffer(createTrayPng('listening')),
    transparent: !!transparent, backgroundColor: transparent ? '#00000000' : '#111821',
    resizable, minimizable: !transparent, maximizable: !transparent,
    fullscreenable: false, skipTaskbar: !!transparent, alwaysOnTop,
    hasShadow: !transparent, autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD_FILE, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  const loadWindow = (win, view) => {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'file:' || path.resolve(decodeURIComponent(parsed.pathname)) !== UI_FILE) event.preventDefault();
      } catch { event.preventDefault(); }
    });
    win.webContents.once('did-finish-load', () => { send(win, IPC.state, snapshot); });
    void win.loadFile(UI_FILE, { query: { view } });
  };
  const createPanel = () => {
    if (panel && !panel.isDestroyed()) return panel;
    panel = new BrowserWindow({
      ...optionsFor({ width: 122, height: 42, minWidth: 122, minHeight: 42, transparent: true, alwaysOnTop: true, resizable: false }),
      focusable: false,
    });
    panel.setAlwaysOnTop(true, 'floating');
    const display = screen.getPrimaryDisplay();
    savedPosition = readPanelPosition(positionFile);
    const requested = savedPosition || { x: display.workArea.x + Math.max(0, display.workArea.width - 142), y: display.workArea.y + Math.max(0, display.workArea.height - 114) };
    const bounds = { ...requested, width: 122, height: 42 };
    const position = clampPanelPosition(requested, screen.getDisplayMatching(bounds).workArea, bounds);
    panel.setPosition(position.x, position.y);
    panel.on('move', () => {
      clearTimeout(positionTimer);
      positionTimer = setTimeout(persistPanelPosition, 150);
      positionTimer.unref();
    });
    panel.on('close', persistPanelPosition);
    loadWindow(panel, 'panel');
    panel.on('closed', () => { panel = null; });
    return panel;
  };
  const openSettings = () => {
    if (disposed) return null;
    if (settings && !settings.isDestroyed()) { settings.show(); settings.focus(); send(settings, IPC.state, snapshot); return settings; }
    settings = new BrowserWindow(optionsFor({ width: 1020, height: 760, minWidth: 860, minHeight: 650, transparent: false, resizable: true }));
    settings.setTitle('DotDial');
    loadWindow(settings, 'settings');
    settings.on('closed', () => { settings = null; });
    settings.once('ready-to-show', () => settings?.show());
    return settings;
  };
  const ensurePanel = () => {
    if (!panel) createPanel();
    if (panel && !panel.isDestroyed() && !panel.isVisible()) panel.showInactive();
    if (panel && !panel.isDestroyed()) send(panel, IPC.state, snapshot);
  };
  const hidePanel = () => { if (panel && !panel.isDestroyed()) { persistPanelPosition(); panel.hide(); } };
  const panelAllowed = () => configCache?.config?.appearance?.showPanel !== false;
  const iconFor = state => {
    const view = presentState(state);
    return nativeImage.createFromBuffer(createTrayPng(view.tone, view.missedCount));
  };
  const refreshTray = () => {
    if (!tray || tray.isDestroyed()) return;
    const view = presentState(snapshot);
    tray.setImage(iconFor(snapshot));
    tray.setToolTip(view.tooltip);
    if (typeof tray.setTitle === 'function') tray.setTitle(view.missedCount ? String(Math.min(view.missedCount, 99)) : '');
    tray.setContextMenu(buildContextMenu());
  };
  const clearMissed = async () => {
    const parentWindow = settings || panel;
    const options = {
      type: 'warning', buttons: ['Cancel', 'Clear recordings'],
      defaultId: 0, cancelId: 0, noLink: true,
      title: 'Clear missed replies?',
      message: 'This permanently deletes every saved reply that has not been fully played.',
    };
    const result = parentWindow
      ? await dialog.showMessageBox(parentWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 1) await callCommand('MISSED_CLEAR');
  };
  const buildContextMenu = () => {
    const active = ['starting', 'active', 'stopping'].includes(snapshot.state);
    const micMuted = snapshot.microphone_muted === true;
    const speakersMuted = snapshot.speakers_muted === true;
    const missed = Number(snapshot.missed_count) || 0;
    const replaying = snapshot.missed_playing === true;
    const template = [
      { label: 'Call your Dot', enabled: !active, click: () => void callCommand('WAKE') },
      { label: 'End call', enabled: active, click: () => void callCommand('STOP') },
      { type: 'separator' },
      { label: micMuted ? 'Turn microphone on' : 'Turn microphone off', enabled: snapshot.state === 'active', click: () => void callCommand(micMuted ? 'UNMUTE' : 'MUTE') },
      { label: speakersMuted ? 'Turn speakers on' : 'Turn speakers off', enabled: snapshot.state === 'active' || replaying, click: () => void callCommand(speakersMuted ? 'SPEAKERS_UNMUTE' : 'SPEAKERS_MUTE') },
      { type: 'separator' },
      { label: replaying ? 'Stop missed replies' : `Play missed replies${missed ? ` (${missed})` : ''}`, enabled: replaying || missed > 0, click: () => void callCommand(replaying ? 'MISSED_STOP' : 'MISSED_PLAY') },
      { label: 'Clear missed recordings…', enabled: missed > 0, click: () => void clearMissed() },
      { type: 'separator' },
      { label: 'Open settings', click: openSettings },
      { label: 'Sign in to ChatGPT', click: () => void callCommand('LOGIN') },
      { type: 'separator' },
      { label: 'Quit DotDial', click: () => void callCommand('QUIT') },
    ];
    return Menu.buildFromTemplate(template);
  };

  handle(IPC.configRead, async () => {
    const value = await configProvider();
    configCache = jsonClone(value);
    return configCache;
  });
  handle(IPC.configSave, async (_event, payload) => {
    if (!payload || typeof payload !== 'object' || typeof payload.hash !== 'string' || payload.hash.length > 256) return { ok: false, error: 'invalid_config' };
    try {
      const config = jsonClone(payload.config);
      const result = await saveProvider(config, payload.hash);
      configCache = jsonClone(result);
      refreshTray();
      return { ok: true, ...configCache };
    } catch (error) {
      const code = safeErrorCode(error);
      return { ok: false, error: code };
    }
  });
  handle(IPC.command, async (_event, name, payload) => {
    if (!COMMANDS.has(name)) return { status: 'invalid_command' };
    return callCommand(name, payload);
  });
  handle(IPC.devices, async () => {
    if (typeof getAudioDevices !== 'function') return { inputs: [], outputs: [] };
    try {
      const devices = await getAudioDevices();
      const normalize = rows => Array.isArray(rows) ? rows.slice(0, 64).map(device => ({
        id: String(device?.id || '').slice(0, 256), label: String(device?.label || '').slice(0, 120),
      })).filter(device => device.id) : [];
      return { inputs: normalize(devices?.inputs), outputs: normalize(devices?.outputs) };
    } catch { return { inputs: [], outputs: [], error: 'devices_unavailable' }; }
  });
  handle(IPC.menu, async () => { tray?.popUpContextMenu(buildContextMenu()); return { status: 'shown' }; });
  handle(IPC.move, (_event, payload) => {
    if (!panel || panel.isDestroyed() || !payload || !Number.isFinite(payload.dx) || !Number.isFinite(payload.dy) || Math.abs(payload.dx) > 500 || Math.abs(payload.dy) > 500) return { status: 'ignored' };
    const [x, y] = panel.getPosition();
    const { width, height } = panel.getBounds();
    const bounds = { x: x + Math.round(payload.dx), y: y + Math.round(payload.dy), width, height };
    const display = screen.getDisplayMatching(bounds);
    const area = display.workArea;
    const position = clampPanelPosition(bounds, area, bounds);
    panel.setPosition(position.x, position.y, false);
    return { status: 'moved' };
  });

  if (typeof Tray === 'function') {
    const icon = iconFor(snapshot);
    tray = new Tray(icon);
    tray.on('click', () => {
      if (['starting', 'active', 'stopping'].includes(snapshot.state)) ensurePanel();
      else void callCommand('WAKE');
    });
    tray.on('double-click', () => {
      if (['starting', 'active', 'stopping'].includes(snapshot.state)) ensurePanel();
      else openSettings();
    });
    tray.on('right-click', () => tray?.popUpContextMenu(buildContextMenu()));
    refreshTray();
  }

  const api = {
    update(nextState = {}) {
      snapshot = safeState(nextState);
      try { configCache = jsonClone(configProvider()); } catch {}
      refreshTray();
      sendState();
      const busy = ['starting', 'active', 'stopping'].includes(snapshot.state) || snapshot.missed_playing === true;
      if (busy && panelAllowed()) ensurePanel();
      else hidePanel();
    },
    openSettings,
    showPanel: ensurePanel,
    hidePanel,
    dispose() {
      if (disposed) return;
      disposed = true;
      persistPanelPosition();
      screen?.removeListener?.('display-removed', keepPanelVisible);
      screen?.removeListener?.('display-metrics-changed', keepPanelVisible);
      for (const channel of handlers) ipcMain.removeHandler(channel);
      handlers.length = 0;
      try { tray?.destroy(); } catch {}
      try { panel?.destroy(); } catch {}
      try { settings?.destroy(); } catch {}
      tray = null; panel = null; settings = null;
    },
  };
  return api;
}

module.exports = { createDesktop, presentState, createTrayPng, readPanelPosition, savePanelPosition, clampPanelPosition, IPC };
