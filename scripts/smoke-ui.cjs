'use strict';
// Run with Electron under an isolated display. No account, network or microphone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
process.argv.push('--demo');
const output = process.env.DOTDIAL_SCREENSHOTS || path.join(__dirname, '..', 'docs', 'images');
fs.mkdirSync(output, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, message) => {
  for (let n = 0; n < 150; n++) { const value = await fn(); if (value) return value; await delay(80); }
  throw new Error(message);
};
const script = (w, js) => w.webContents.executeJavaScript(js, true);
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
  await delay(1200);
  fs.writeFileSync(demoConfig, JSON.stringify(envelope.config, null, 2));
  await delay(1200);
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
  await script(panel, 'document.querySelector("#panel-hangup").click()');
  await until(() => !panel.isVisible(), 'panel_not_hidden_after_stop');
  await script(settings, 'window.dotdial.command("WAKE"); window.dotdial.command("STOP")');
  await delay(800);
  assert.equal(panel.isVisible(), false, 'cancelled_preview_reopened');
  console.log(JSON.stringify({ result: 'passed', mode: 'synthetic_preview', checks: ['ui_config_write', 'external_json_reload', 'conflict_protection', 'invalid_json_recovery', 'controls', 'panel_lifecycle', 'transparent_corners'], screenshots: output }));
  app.quit();
})().catch(error => { console.error('UI_SMOKE_FAILED', error.message); app.exit(1); });
setTimeout(() => { console.error('UI_SMOKE_TIMEOUT'); app.exit(2); }, 35000).unref();
