'use strict';
// Run with Electron and xdotool under an isolated X11 display. No account, network or microphone.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, ipcMain, nativeImage, Tray, Menu, dialog, screen } = require('electron');
const { IPC } = require('../src/desktop.cjs');
const execFileAsync = promisify(execFile);
// Exercise the full preview UI and IPC without using desktop speakers.
const childProcess = require('node:child_process');
const spawnProcess = childProcess.spawn;
const previewPlayers = [];
childProcess.spawn = (command, args, options) => {
  if (command !== '/usr/bin/paplay') return spawnProcess(command, args, options);
  const player = new (require('node:events').EventEmitter)();
  const timer = setTimeout(() => player.emit('exit', 0), 800);
  player.kill = () => { player.killed = true; clearTimeout(timer); player.emit('exit', 0); };
  previewPlayers.push(player);
  return player;
};
require('node:module').syncBuiltinESMExports();
let selectedSoundFile = path.join(__dirname, '../src/sounds/calling.wav');
dialog.showOpenDialog = async () => selectedSoundFile ? { filePaths: [selectedSoundFile], canceled: false } : { filePaths: [], canceled: true };
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
// Some Linux tray hosts ignore programmatic popup requests. The floating
// panel must still display a native menu and let the user select an action.
Tray.prototype.popUpContextMenu = function () {};
const originalBuildFromTemplate = Menu.buildFromTemplate;
Menu.buildFromTemplate = function (template) {
  const menu = originalBuildFromTemplate.call(this, template);
  menu.on('menu-will-show', () => popupMenus.push(menuShape(menu)));
  return menu;
};
const xdotool = (...args) => execFileAsync('xdotool', args.map(String), { timeout: 5000 });
const queryRuntimeState = () => new Promise((resolve, reject) => {
  const socket = net.createConnection(path.join(path.dirname(demoConfig), 'run', 'dotdial.sock'));
  let buffer = '', settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (error) { socket.destroy(); reject(error); }
    else { socket.end(); resolve(value); }
  };
  const timer = setTimeout(() => finish(new Error('status_socket_timeout')), 3000);
  socket.once('connect', () => socket.write('STATUS\n'));
  socket.on('data', chunk => {
    buffer += chunk.toString();
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    try { finish(null, JSON.parse(buffer.slice(0, newline))); }
    catch { finish(new Error('status_socket_invalid_response')); }
  });
  socket.once('error', error => finish(error));
});
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
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const expectedSettingsSize = [Math.min(680, primaryWorkArea.width), Math.min(507, primaryWorkArea.height)];
  const actualSettingsSize = settings.getSize();
  assert.ok(actualSettingsSize[0] <= expectedSettingsSize[0] && actualSettingsSize[0] >= Math.min(520, expectedSettingsSize[0]) - 1, 'settings_width_adapts_to_work_area');
  assert.ok(actualSettingsSize[1] <= expectedSettingsSize[1] && actualSettingsSize[1] >= Math.min(360, expectedSettingsSize[1]) - 1, 'settings_height_adapts_to_work_area');
  assert.deepEqual(settings.getMinimumSize(), [Math.min(520, expectedSettingsSize[0]), Math.min(360, expectedSettingsSize[1])]);
  const settingsBounds = settings.getBounds();
  const settingsWorkArea = screen.getDisplayMatching(settingsBounds).workArea;
  assert.ok(settingsBounds.x >= settingsWorkArea.x && settingsBounds.y >= settingsWorkArea.y, 'settings_inside_work_area_origin');
  assert.ok(settingsBounds.x + settingsBounds.width <= settingsWorkArea.x + settingsWorkArea.width, 'settings_inside_work_area_right');
  assert.ok(settingsBounds.y + settingsBounds.height <= settingsWorkArea.y + settingsWorkArea.height, 'settings_inside_work_area_bottom');
  settings.webContents.send(IPC.state, { state: 'ready', config_pending: true });
  await until(() => script(settings, 'document.querySelector("#save-status").textContent === "Call settings will apply after the call."'), 'pending_call_settings_copy_missing');
  settings.webContents.send(IPC.state, { state: 'ready', config_pending: false });
  await until(() => script(settings, 'document.querySelector("#save-status").textContent === "All changes saved"'), 'pending_call_settings_copy_not_cleared');
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
  await delay(3200);
  fs.writeFileSync(path.join(output, 'settings.png'), (await settings.webContents.capturePage()).toPNG());
  await script(settings, 'document.querySelector(".nav-item[data-section=voice]").click()');
  await delay(500);
  assert.equal(await script(settings, 'document.querySelector("#audio-connection-sound").value'), 'modem');
  assert.equal(await script(settings, 'document.querySelector("#custom-sound-path").textContent'), 'No file selected');
  assert.equal(await script(settings, 'document.querySelector("#preview-sound").disabled'), false);
  assert.equal(await script(settings, 'document.querySelector("#stop-sound-preview").disabled'), true);
  fs.writeFileSync(path.join(output, 'voice.png'), (await settings.webContents.capturePage()).toPNG());
  await script(settings, 'document.querySelector("#audio-connection-sound").closest("article").scrollIntoView({block:"center"})');
  await delay(150);
  fs.writeFileSync(path.join(output, 'sounds.png'), (await settings.webContents.capturePage()).toPNG());
  await script(settings, 'document.querySelector("#audio-connection-sound").value="telephone";document.querySelector("#top-save").click()');
  await until(async () => (await script(settings, 'window.dotdial.readConfig()')).config.audio.connectionSound === 'telephone', 'telephone_choice_not_saved');
  await script(settings, 'document.querySelector("#preview-sound").click()');
  await until(() => previewPlayers.length === 1, 'preview_player_missing');
  assert.equal(await script(settings, 'document.querySelector("#stop-sound-preview").disabled'), false);
  await script(settings, 'document.querySelector("#stop-sound-preview").click()');
  await until(() => previewPlayers[0].killed, 'preview_stop_not_delivered');
  await until(() => script(settings, '!document.querySelector("#preview-sound").disabled'), 'preview_controls_stuck');
  await script(settings, 'document.querySelector("#choose-sound-file").click()');
  await until(() => script(settings, 'document.querySelector("#audio-connection-sound").value === "custom"'), 'custom_choice_missing');
  await script(settings, 'document.querySelector("#top-save").click()');
  await until(async () => (await script(settings, 'window.dotdial.readConfig()')).config.audio.customSoundPath === selectedSoundFile, 'custom_file_not_saved');
  await script(settings, 'document.querySelector("#preview-sound").click()');
  await until(() => previewPlayers.length === 2, 'custom_preview_missing').catch(async error => {
    console.error('CUSTOM_PREVIEW_STATE', await script(settings, 'document.querySelector("#sound-preview-status").textContent'));
    throw error;
  });
  await until(() => script(settings, '!document.querySelector("#preview-sound").disabled'), 'custom_preview_not_finished');
  selectedSoundFile = null;
  await script(settings, 'document.querySelector("#choose-sound-file").click()');
  await delay(100);
  assert.equal((await script(settings, 'window.dotdial.readConfig()')).config.audio.connectionSound, 'custom');
  await script(settings, 'document.querySelector("#audio-connection-sound").value="modem";document.querySelector("#top-save").click()');
  await until(async () => (await script(settings, 'window.dotdial.readConfig()')).config.audio.connectionSound === 'modem', 'modem_choice_not_restored');
  const devices = await script(settings, 'window.dotdial.getAudioDevices()');
  assert.equal(devices.inputs[0].id, 'default');
  await script(settings, 'window.dotdial.command("WAKE")');
  const panel = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=panel')), 'panel_missing');
  await until(() => script(panel, '!document.querySelector("#panel-mic").disabled'), 'panel_not_active');
  assert.equal(panel.isVisible(), true);
  const activeStateBeforeConfig = await queryRuntimeState();
  assert.equal(activeStateBeforeConfig.state, 'active');
  const callStateBeforeConfig = {
    state: activeStateBeforeConfig.state,
    local_listening: activeStateBeforeConfig.local_listening,
    microphone_muted: activeStateBeforeConfig.microphone_muted,
    speakers_muted: activeStateBeforeConfig.speakers_muted,
  };
  const syntheticConfig = (await script(settings, 'window.dotdial.readConfig()')).config;
  const liveWakeConfig = JSON.parse(JSON.stringify(syntheticConfig));
  liveWakeConfig.wakeWord.phrase = 'Computer';
  fs.writeFileSync(demoConfig, JSON.stringify(liveWakeConfig, null, 2));
  const wakeChangedDuringCall = await until(async () => {
    const current = await queryRuntimeState();
    return current.wake_phrase === 'Computer' && current.config_pending === false ? current : null;
  }, 'wake_phrase_not_applied_during_call');
  assert.equal(wakeChangedDuringCall.state, 'active');
  assert.deepEqual({
    state: wakeChangedDuringCall.state,
    local_listening: wakeChangedDuringCall.local_listening,
    microphone_muted: wakeChangedDuringCall.microphone_muted,
    speakers_muted: wakeChangedDuringCall.speakers_muted,
  }, callStateBeforeConfig);
  assert.equal(panel.isVisible(), true, 'panel_hidden_after_live_wake_config');
  fs.writeFileSync(demoConfig, JSON.stringify(syntheticConfig, null, 2));
  const wakeRestoredDuringCall = await until(async () => {
    const current = await queryRuntimeState();
    return current.wake_phrase === syntheticConfig.wakeWord.phrase && current.config_pending === false ? current : null;
  }, 'wake_phrase_not_restored_during_call');
  assert.equal(wakeRestoredDuringCall.state, 'active');
  assert.equal(panel.isVisible(), true, 'panel_hidden_after_synthetic_config_restore');
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
  // Select a real menu item with native keyboard input. A call to a tray API
  // that silently does nothing must not count as a working context menu.
  for (const expected of ['MUTE', 'UNMUTE']) {
    const menus = popupMenus.length;
    await clickAt(301, 271, 3);
    await until(() => popupMenus.length > menus, 'native_menu_not_shown');
    await xdotool('key', 'Home', 'Down', 'Return');
    // Native menu actions dispatch in the main process, without renderer IPC.
    // Check the actual call state, so merely opening a menu cannot pass.
    await until(async () => (await queryRuntimeState()).microphone_muted === (expected === 'MUTE'), 'native_menu_mic_state_not_changed');
    await delay(100);
  }
  assert.equal(panel.isFocusable(), false, 'menu_must_not_change_panel_focus_policy');
  commandCount = observedCommands.length;
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
  const playersBeforeClose = previewPlayers.length;
  await script(settings, 'document.querySelector("#preview-sound").click()');
  await until(() => previewPlayers.length > playersBeforeClose, 'closing_preview_missing');
  settings.close();
  await until(() => previewPlayers.at(-1).killed, 'settings_close_left_sound_playing');
  console.log(JSON.stringify({ result: 'passed', mode: 'synthetic_preview', checks: ['settings_geometry_and_work_area', 'pending_call_settings_copy', 'ui_config_write', 'external_json_reload', 'conflict_protection', 'invalid_json_recovery', 'connection_sound_save', 'custom_file_choose', 'preview_and_stop', 'custom_decode_and_preview', 'cancel_file_choose', 'wake_phrase_live_during_active_call', 'controls', 'panel_lifecycle', 'transparent_corners', 'three_controls', 'speaker_badge', 'native_click_and_drag', 'context_menu_everywhere', 'native_menu_action_without_tray_popup', 'replay_stop'], screenshots: output, comparisons }));
  app.quit();
})().catch(error => { console.error('UI_SMOKE_FAILED', error.message); app.exit(1); });
setTimeout(() => { console.error('UI_SMOKE_TIMEOUT'); app.exit(2); }, 55000).unref();
