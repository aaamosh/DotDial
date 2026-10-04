'use strict';
// Run with Electron and xdotool under an isolated X11 display. No account, network or microphone.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, ipcMain, nativeImage, Tray } = require('electron');
const { IPC } = require('../src/desktop.cjs');
const execFileAsync = promisify(execFile);
process.argv.push('--demo');
const output = process.env.DOTDIAL_SCREENSHOTS || path.join(__dirname, '..', 'docs', 'images');
fs.mkdirSync(output, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, message) => {
  for (let n = 0; n < 150; n++) { const value = await fn(); if (value) return value; await delay(80); }
  throw new Error(message);
};
const script = (w, js) => w.webContents.executeJavaScript(js, true);
const observedCommands = [];
const trayMenus = [];
const popupMenus = [];
const menuShape = menu => (menu?.items || []).map(item => ({ type: item.type || 'normal', label: item.label || '', enabled: item.enabled !== false }));
const originalHandle = ipcMain.handle;
ipcMain.handle = function (channel, listener) {
  return originalHandle.call(this, channel, async (event, ...args) => {
    if (channel === IPC.command) observedCommands.push(String(args[0] || ''));
    return listener(event, ...args);
  });
};
const originalSetContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (menu) {
  trayMenus.push(menuShape(menu));
  return originalSetContextMenu.call(this, menu);
};
const originalPopUpContextMenu = Tray.prototype.popUpContextMenu;
Tray.prototype.popUpContextMenu = function (menu, ...args) {
  popupMenus.push(menuShape(menu));
  return originalPopUpContextMenu.call(this, menu, ...args);
};
const xdotool = (...args) => execFileAsync('xdotool', args.map(String), { timeout: 5000 });
const clickAt = async (x, y, button = 1) => {
  await xdotool('mousemove', Math.round(x), Math.round(y));
  await delay(40);
  await xdotool('click', '--clearmodifiers', button);
  await delay(120);
};
const dragAt = async (x, y, dx, dy) => {
  await xdotool('mousemove', Math.round(x), Math.round(y));
  await xdotool('mousedown', 1);
  await delay(60);
  await xdotool('mousemove', Math.round(x + dx), Math.round(y + dy));
  await delay(100);
  await xdotool('mouseup', 1);
  await delay(180);
};
const imageComparison = (png, referencePath) => {
  const actual = nativeImage.createFromBuffer(png);
  const reference = nativeImage.createFromPath(referencePath);
  if (reference.isEmpty()) return { reference_missing: true };
  const aSize = actual.getSize(), bSize = reference.getSize();
  const result = {
    actual_sha256: crypto.createHash('sha256').update(png).digest('hex'),
    reference_sha256: crypto.createHash('sha256').update(fs.readFileSync(referencePath)).digest('hex'),
    dimensions_match: aSize.width === bSize.width && aSize.height === bSize.height,
    actual_size: [aSize.width, aSize.height], reference_size: [bSize.width, bSize.height],
  };
  if (!result.dimensions_match) return result;
  const a = actual.toBitmap(), b = reference.toBitmap();
  let changed = 0, minX = aSize.width, minY = aSize.height, maxX = -1, maxY = -1;
  for (let y = 0; y < aSize.height; y++) for (let x = 0; x < aSize.width; x++) {
    const i = (y * aSize.width + x) * 4;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      changed++;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  result.changed_pixels = changed;
  result.changed_bbox = changed ? [minX, minY, maxX, maxY] : null;
  return result;
};
let demoConfig;
app.on('web-contents-created', (_event, wc) => wc.on('console-message', (_event, details) => {
  if (details.level === 'error') console.error('renderer:', details.message);
}));
require('../src/main.cjs');
void (async () => {
  await app.whenReady();
  const settings = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=settings')), 'settings_missing');
  await until(() => script(settings, '!!window.dotdial && !!document.querySelector("#dot-display-name").value'), 'settings_not_ready');
  let envelope = await script(settings, 'window.dotdial.readConfig()');
  demoConfig = envelope.path;
  assert.equal(envelope.config.audio.bufferMs, 0);
  assert.equal(envelope.config.wakeWord.enabled, false);
  // UI -> file -> runtime. Also prove stale writes cannot overwrite file edits.
  await script(settings, `document.querySelector('#dot-display-name').value = 'Nova'; document.querySelector('#dot-display-name').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#top-save').click();`);
  await until(() => JSON.parse(fs.readFileSync(demoConfig)).dot.displayName === 'Nova', 'ui_save_failed');
  envelope = await script(settings, 'window.dotdial.readConfig()');
  const oldHash = envelope.hash;
  envelope.config.appearance.theme = 'dark';
  envelope.config.dot.displayName = 'My dot';
  fs.writeFileSync(demoConfig, JSON.stringify(envelope.config, null, 2));
  await until(() => script(settings, 'document.querySelector("#dot-display-name").value === "My dot"'), 'file_edit_not_reloaded');
  const stale = await script(settings, `window.dotdial.saveConfig(${JSON.stringify(envelope.config)}, ${JSON.stringify(oldHash)})`);
  assert.equal(stale.error, 'DOTDIAL_CONFIG_CONFLICT');
  // Invalid external JSON is reported without changing the last valid settings.
  fs.writeFileSync(demoConfig, '{');
  await until(() => script(settings, 'document.querySelector("#save-status").textContent.startsWith("Invalid settings JSON")'), 'invalid_json_not_reported');
  assert.equal(await script(settings, 'document.querySelector(".saved-check").classList.contains("warning")'), true);
  fs.writeFileSync(demoConfig, JSON.stringify(envelope.config, null, 2));
  await until(() => script(settings, 'document.querySelector("#save-status").textContent === "All changes saved"'), 'restored_json_status_not_cleared');
  assert.equal(await script(settings, 'document.querySelector(".saved-check").classList.contains("warning")'), false);
  await script(settings, 'document.querySelector(".nav-item[data-section=connect]").click()');
  await delay(500);
  fs.writeFileSync(path.join(output, 'settings.png'), (await settings.webContents.capturePage()).toPNG());
  await script(settings, 'document.querySelector(".nav-item[data-section=voice]").click()');
  await delay(500);
  fs.writeFileSync(path.join(output, 'voice.png'), (await settings.webContents.capturePage()).toPNG());
  const devices = await script(settings, 'window.dotdial.getAudioDevices()');
  assert.equal(devices.inputs[0].id, 'default');
  await script(settings, 'window.dotdial.command("WAKE")');
  const panel = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=panel')), 'panel_missing');
  await until(() => script(panel, '!document.querySelector("#panel-mic").disabled'), 'panel_not_active');
  assert.equal(panel.isVisible(), true);
  assert.deepEqual(panel.getSize(), [122, 42]);
  assert.equal(panel.isFocusable(), false);
  assert.equal(await script(panel, 'document.querySelectorAll(".panel-control").length'), 3);
  assert.equal(await script(panel, '!!document.querySelector("#panel-hangup svg path")'), true);
  await script(panel, 'document.querySelector("#panel-mic").click()');
  await until(() => script(panel, 'document.querySelector("#panel-mic").classList.contains("muted")'), 'mic_control_failed');
  await script(panel, 'document.querySelector("#panel-speakers").click()');
  await until(() => script(panel, 'document.querySelector("#panel-speakers").classList.contains("muted")'), 'speaker_control_failed');
  await script(panel, 'document.querySelector("#panel-mic").click(); document.querySelector("#panel-speakers").click()');
  await delay(200);
  const panelImage = await panel.webContents.capturePage();
  fs.writeFileSync(path.join(output, 'panel.png'), panelImage.toPNG());
  assert.equal(panelImage.toBitmap()[3], 0, 'rounded_corner_must_be_transparent');
  const pixels = panelImage.toBitmap(), size = panelImage.getSize();
  for (const [x, y] of [[0, 0], [size.width - 1, 0], [0, size.height - 1], [size.width - 1, size.height - 1]]) {
    assert.equal(pixels[(y * size.width + x) * 4 + 3], 0, 'all_corners_transparent');
  }
  const zones = [{ name: 'mic', x: 21 }, { name: 'speaker', x: 61 }, { name: 'hangup', x: 101 }, { name: 'gap', x: 41 }, { name: 'edge', x: 1 }];
  for (const zone of zones) {
    panel.setPosition(280, 250); await delay(80);
    const commandCount = observedCommands.length;
    await dragAt(280 + zone.x, 271, 24, 16);
    await until(() => panel.getPosition()[0] === 304 && panel.getPosition()[1] === 266, `${zone.name}_drag_failed`);
    assert.equal(observedCommands.length, commandCount, `${zone.name}_drag_clicked_control`);
    const menus = popupMenus.length;
    await clickAt(304 + zone.x, 287, 3);
    await until(() => popupMenus.length > menus, `${zone.name}_context_menu_failed`);
    assert.deepEqual(popupMenus.at(-1), trayMenus.at(-1), 'context_menu_differs_from_tray');
    await xdotool('key', 'Escape'); await delay(80);
  }
  panel.setPosition(280, 250); await delay(80);
  let commandCount = observedCommands.length;
  await clickAt(301, 271);
  await until(() => observedCommands.length > commandCount, 'native_mic_click_failed');
  assert.deepEqual(observedCommands.slice(commandCount), ['MUTE']);
  await clickAt(301, 271);
  await until(() => observedCommands.at(-1) === 'UNMUTE', 'native_unmute_failed');
  commandCount = observedCommands.length;
  await clickAt(341, 271);
  await until(() => observedCommands.length > commandCount, 'native_speaker_click_failed');
  assert.deepEqual(observedCommands.slice(commandCount), ['SPEAKERS_MUTE']);
  await clickAt(341, 271);
  await until(() => observedCommands.at(-1) === 'SPEAKERS_UNMUTE', 'native_speaker_unmute_failed');
  for (const count of [4, 15, 137]) {
    panel.webContents.send(IPC.state, { state: 'active', microphone_muted: true, speakers_muted: true, missed_count: count });
    const label = count > 99 ? '99+' : String(count);
    await until(() => script(panel, `document.querySelector('#panel-missed-count').textContent === '${label}'`), 'speaker_badge_failed');
    assert.equal(await script(panel, 'document.querySelectorAll(".panel-control").length'), 3);
    assert.equal(await script(panel, 'document.querySelector("#panel-missed-count").closest("button").id'), 'panel-speakers');
  }
  panel.webContents.send(IPC.state, { state: 'ready', missed_count: 4, missed_playing: true });
  await until(() => script(panel, 'document.querySelector("#panel-mic").disabled && !document.querySelector("#panel-hangup").disabled'), 'replay_controls_failed');
  assert.match(await script(panel, 'document.querySelector("#panel-hangup").title'), /Stop/);
  commandCount = observedCommands.length;
  await dragAt(301, 271, 24, 16);
  await until(() => panel.getPosition()[0] === 304, 'disabled_mic_drag_failed');
  assert.equal(observedCommands.length, commandCount, 'disabled_mic_drag_issued_command');
  const menus = popupMenus.length;
  await clickAt(325, 287, 3);
  await until(() => popupMenus.length > menus, 'disabled_mic_context_menu_failed');
  await xdotool('key', 'Escape'); await delay(80);
  await clickAt(405, 287);
  await until(() => observedCommands.length > commandCount, 'replay_stop_click_failed');
  assert.deepEqual(observedCommands.slice(commandCount), ['MISSED_STOP']);
  // Return the renderer to the demo's real call state before checking live hangup.
  panel.webContents.send(IPC.state, { state: 'active', microphone_muted: false, speakers_muted: false, missed_count: 0 });
  await until(() => script(panel, 'document.querySelector("#panel-hangup").title === "End call"'), 'live_controls_not_restored');
  const comparisons = {};
  for (const name of ['settings', 'voice']) comparisons[name] = imageComparison(fs.readFileSync(path.join(output, `${name}.png`)), path.join(__dirname, '..', 'docs', 'images', `${name}.png`));
  await script(panel, 'document.querySelector("#panel-hangup").click()');
  await until(() => !panel.isVisible(), 'panel_not_hidden_after_stop');
  await script(settings, 'window.dotdial.command("WAKE"); window.dotdial.command("STOP")');
  await delay(800);
  assert.equal(panel.isVisible(), false, 'cancelled_preview_reopened');
  console.log(JSON.stringify({ result: 'passed', mode: 'synthetic_preview', checks: ['ui_config_write', 'external_json_reload', 'conflict_protection', 'invalid_json_recovery', 'controls', 'panel_lifecycle', 'transparent_corners', 'three_controls', 'speaker_badge', 'native_click_and_drag', 'context_menu_everywhere', 'replay_stop'], screenshots: output, comparisons }));
  app.quit();
})().catch(error => { console.error('UI_SMOKE_FAILED', error.message); app.exit(1); });
setTimeout(() => { console.error('UI_SMOKE_TIMEOUT'); app.exit(2); }, 55000).unref();
