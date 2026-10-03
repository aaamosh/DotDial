'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const api = window.dotdial;
const view = new URLSearchParams(location.search).get('view') || 'settings';

const COPY = {
  en: {
    desktopCompanion: 'DESKTOP COMPANION', yourAssistant: 'YOUR ASSISTANT', notConnected: 'Not connected',
    connect: 'Connect', voice: 'Voice', appearance: 'Appearance', advanced: 'Advanced', ready: 'Ready',
    settings: 'Settings', openChatGPT: 'Open ChatGPT', saveChanges: 'Save changes', connection: 'CONNECTION',
    connectYourDot: 'Connect your Dot', connectIntro: 'Give DotDial the link to your assistant. Sign in once in its own private window.',
    desktopReady: 'Desktop ready', voiceControls: 'Voice controls', assistantProfile: 'Assistant profile',
    profileHelp: 'Choose which Dot to open when you call.', privateSession: 'PRIVATE SESSION', dotName: 'Name',
    dotNameHint: 'This name appears in the tray and call panel.', expectedAccount: 'Account email (optional)',
    expectedAccountHint: 'Used to help you check you signed in to the right account.', dotLink: 'Dot link', paste: 'Paste',
    dotLinkHint: 'Use the link from your Dot profile. DotDial opens it in a separate signed-in window.',
    saveAndContinue: 'Save and continue', signInOpenChatGPT: 'Sign in / open ChatGPT',
    privacyNote: 'Sign in with your ChatGPT account. Your password is never stored in this configuration file.',
    wakeWordTitle: 'Hands-free wake word', wakeWordIntro: 'Keep wake-word listening on while the tray shows its listening state.',
    configureVoice: 'Configure voice', audioTitle: 'Clear, local audio', audioIntro: 'Choose your microphone, speakers and playback buffer.', audioSettings: 'Audio settings',
    voiceSettings: 'VOICE SETTINGS', voiceIntro: 'Tune how DotDial listens and plays voice on this computer.',
    wakeWordDescription: 'Wake-word recognition runs locally on this computer. The bundled model recognizes English phrases.', wakePhrase: 'Wake phrase',
    wakePhraseHint: 'Use a short English phrase, such as “Hey Dot”, that sounds different from everyday conversation.', sensitivity: 'Sensitivity',
    sensitivityHint: 'Higher sensitivity can wake up more often by mistake.', wakeModel: 'Recognition model',
    wakeModelHint: 'DotDial can install the local model and its dependencies.', installWakeModel: 'Install or check wake-word support',
    pythonPath: 'Python interpreter', pythonPathHint: 'Used only by local wake-word support. Example: python3.',
    audioDevices: 'Audio devices', deviceHelp: 'Device names are requested only when you press Scan devices.',
    scanDevices: 'Scan devices', systemDefault: 'System default', microphone: 'Microphone',
    microphoneHint: 'Used for calls. Wake word uses the system default input.', speakers: 'Speakers', speakersHint: 'Choose where Dot’s voice plays.',
    playbackBuffer: 'Playback buffer', bufferHelp: 'A short reserve can smooth choppy networks. Larger values add a little delay.',
    lowestDelay: 'Lowest delay', balanced: 'Balanced', custom: 'Custom', callSounds: 'Call sounds',
    playCallSounds: 'Play connect and disconnect sounds', soundVolume: 'Sound volume',
    startMutedMic: 'Start calls with mic muted', startMutedMicHint: 'You can unmute from the call panel.',
    startMutedSpeakers: 'Start calls with speakers muted', startMutedSpeakersHint: 'Incoming voice can still be saved as a missed reply.',
    personalize: 'PERSONALIZE', appearanceIntro: 'Give the call panel a calm look that fits your desktop.',
    panelStyle: 'Call panel style', panelStyleHint: 'The panel stays small, translucent and visible above your windows.',
    systemTheme: 'System', darkTheme: 'Dark glass', lightTheme: 'Light glass', panelOpacity: 'Panel opacity',
    panelOpacityHint: 'Adjust transparency while keeping call controls readable.', callPanel: 'Call panel',
    showPanel: 'Show while connecting or in a call', livePreview: 'CALL PANEL PREVIEW',
    trayBehavior: 'Tray and startup', trayBehaviorHint: 'Wake-word listening and call status stay available from your tray.',
    startAtLogin: 'Start at login', startAtLoginHint: 'Open DotDial when you sign in to this desktop.', hotkey: 'Call hotkey',
    hotkeyHint: 'Use Electron accelerator names, for example Ctrl+Alt+Space.', advancedSettings: 'ADVANCED SETTINGS',
    advancedIntro: 'Optional routing and local storage settings. Leave fields empty to use normal system routing.',
    networkRouting: 'Network routing', networkHelp: 'Set a proxy for web sign-in and optional command prefixes for launchers you already use.',
    signalingProxy: 'Sign-in and signaling proxy', proxyHint: 'Optional HTTP or SOCKS proxy. Leave empty to use your normal network route.',
    signalingLauncher: 'Signaling launcher prefix (JSON array)', signalingLauncherHint: 'Restart DotDial after changing this. Commands only; no passwords or tokens.',
    mediaLauncher: 'Media launcher prefix (JSON array)', mediaLauncherHint: 'Optional launcher for WebRTC media transport. Leave empty for direct media.',
    recordingStorage: 'Missed reply storage', recordingHelp: 'Unheard assistant audio stays on this computer and is removed after full playback.',
    recordReplies: 'Save replies while speakers are muted', recordRepliesHint: 'Playback follows arrival order and deletes each complete clip after listening.',
    storageLimit: 'Storage limit', storageLimitHint: 'When full, new clips stop saving until space is freed.', callLimit: 'Call safety limit',
    callLimitHelp: 'Automatically end a call after the selected maximum duration.', maxCallMinutes: 'Maximum call length', minutes: 'minutes',
    allChangesSaved: 'All changes saved', reloadSettings: 'Reload settings', connecting: 'Connecting', inCall: 'In call',
    endingCall: 'Ending call', wakeListening: 'Wake word listening', microphoneMuted: 'Microphone muted', speakersMuted: 'Speakers muted',
    playingMissed: 'Playing missed replies', errorState: 'Needs attention', playMissed: 'Play missed replies', stopMissed: 'Stop missed replies', endCall: 'End call',
    muteMicrophone: 'Mute microphone', unmuteMicrophone: 'Unmute microphone', muteSpeakers: 'Mute speakers', unmuteSpeakers: 'Unmute speakers',
    saveSuccess: 'Settings saved.', saveFailed: 'Could not save settings.', configConflict: 'Settings changed elsewhere. Reload them before saving.',
    invalidDotUrl: 'Enter a link from chatgpt.com/dots/…', invalidEmail: 'Enter a valid email address or leave the field empty.',
    invalidLauncher: 'Launcher settings must be a JSON array of text arguments.', invalidNumber: 'Check the highlighted number fields.',
    pasteUnavailable: 'Clipboard access was not available.', clipboardPasted: 'Link pasted.', reloadDone: 'Latest settings loaded.',
    devicesFound: 'Device list updated.', devicesEmpty: 'No named devices found. System default is still available.',
    devicesUnavailable: 'Could not list devices. System default remains selected.', scanPermission: 'Scanning lists device names; it does not start the microphone.',
    wakeSetupStarted: 'Checking local wake-word support…', wakeSetupDone: 'Wake-word support is ready.', wakeSetupFailed: 'Wake-word setup did not complete.',
    wakeStatusListening: 'Wake word is listening locally.', wakeStatusPaused: 'Wake-word listening pauses during a call.', wakeStatusRequired: 'Install wake-word support to start listening.', wakeStatusError: 'Wake-word service needs attention.',
    menuShown: 'Tray menu opened.', controlFailed: 'That control is unavailable right now.',
    clearTitle: 'Clear missed replies?', clearBody: 'This permanently deletes saved replies that have not been fully played.',
    accountOpen: 'ChatGPT sign-in opened.',
  },

};

const ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"></rect><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"></path></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"></rect><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6M4 4l16 16"></path></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4z"></path><path d="M16 9.5a4 4 0 0 1 0 5M18.5 7a7.5 7.5 0 0 1 0 10"></path></svg>',
  speakerOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4zM17 9l5 6m0-6-5 6"></path></svg>',
  hangup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15.5c4.7-4.1 11.3-4.1 16 0l-2.5 3.2a1 1 0 0 1-1.3.2l-2.4-1.5a1 1 0 0 1-.45-1.04l.35-1.55a12.8 12.8 0 0 0-3.4 0l.35 1.55a1 1 0 0 1-.45 1.04l-2.4 1.5a1 1 0 0 1-1.3-.2L4 15.5z"></path></svg>',
  replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 11.5a8.5 8.5 0 1 1 2.2 6.1M3.5 5v6.5H10"></path><path d="M11 9v6l5-3-5-3z"></path></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>',
};

const DEFAULTS = {
  version: 1,
  dot: { url: '', displayName: 'My dot', expectedEmail: '' },
  general: { startAtLogin: false, hotkey: 'CommandOrControl+Alt+Space' },
  audio: { bufferMs: 0, microphoneDeviceId: 'default', outputDeviceId: 'default', sounds: true, soundVolume: .55, microphoneInitiallyMuted: false, speakersInitiallyMuted: false },
  wakeWord: { enabled: false, phrase: 'Hey Dot', sensitivity: 6, modelPath: '', pythonPath: 'python3' },
  recording: { enabled: true, maxMegabytes: 200 },
  appearance: { theme: 'system', panelOpacity: .86, showPanel: true, language: 'en' },
  network: { signalingProxy: '', signalingLauncher: [], mediaLauncher: [] },
  call: { maxMinutes: 60 },
};

const language = 'en';
let loadedConfig = null;
let configHash = '';
let unsaved = false, configLoading = false;
let latestSnapshot = {};
let knownDevices = { inputs: [], outputs: [] };
let toastTimer = null;

function copy(key) { return COPY.en[key] || key; }
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function mergeDefaults(value, defaults) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : cloneJson(defaults);
  if (!defaults || typeof defaults !== 'object') return value === undefined ? defaults : value;
  const result = {};
  for (const [key, defaultValue] of Object.entries(defaults)) result[key] = mergeDefaults(value?.[key], defaultValue);
  for (const [key, existing] of Object.entries(value || {})) if (!(key in result) && !['__proto__', 'prototype', 'constructor'].includes(key)) result[key] = existing;
  return result;
}
function setPath(target, path, value) {
  const keys = path.split('.');
  let object = target;
  for (const key of keys.slice(0, -1)) object = object[key] ||= {};
  object[keys.at(-1)] = value;
}
function getPath(target, path, fallback = '') {
  const result = path.split('.').reduce((object, key) => object?.[key], target);
  return result === undefined || result === null ? fallback : result;
}
function markUnsaved() {
  unsaved = true;
  const status = $('#save-status');
  if (status) { status.textContent = 'Unsaved changes'; status.classList.remove('success'); }
}
function tForPage() {
  $$('[data-i18n]').forEach(node => {
    const value = copy(node.dataset.i18n);
    if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') node.placeholder = value;
    else node.textContent = value;
  });
  document.documentElement.lang = language;
  updatePanel(latestSnapshot);
  updateSettingsState(latestSnapshot);
}
function toast(text, kind = 'normal') {
  const region = $('#toast-region');
  if (!region) return;
  region.replaceChildren();
  const item = document.createElement('div');
  item.className = `toast${kind === 'error' ? ' error' : ''}`;
  item.textContent = text;
  region.append(item);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => item.remove(), 2900);
}
function applyAppearance(config) {
  const appearance = config?.appearance || {};
  const theme = ['light', 'dark', 'system'].includes(appearance.theme) ? appearance.theme : 'system';
  document.body.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  const opacity = Number(appearance.panelOpacity);
  document.documentElement.style.setProperty('--panel-opacity', String(Math.max(.2, Math.min(1, Number.isFinite(opacity) ? opacity : .86))));
}
function showPage(page) {
  const target = document.querySelector(`[data-page="${page}"]`);
  if (!target) return;
  $$('.settings-section').forEach(section => section.classList.toggle('active', section === target));
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.section === page));
  const heading = $(`.nav-item[data-section="${page}"] [data-i18n]`);
  $('#page-breadcrumb').textContent = heading?.textContent || page;
  $('#settings-content')?.scrollTo({ top: 0, behavior: 'smooth' });
}
function setSelectOptions(select, rows, selected, kind) {
  const defaultOption = document.createElement('option');
  defaultOption.value = 'default'; defaultOption.textContent = copy('systemDefault');
  select.replaceChildren(defaultOption);
  const devices = Array.isArray(rows) ? rows : [];
  let found = false;
  for (const device of devices) {
    if (!device || typeof device.id !== 'string' || !device.id || device.id === 'default') continue;
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = device.label || (`${kind === 'input' ? 'Microphone' : 'Output'} ${select.options.length}`);
    select.append(option);
    if (device.id === selected) found = true;
  }
  if (selected && selected !== 'default' && !found) {
    const option = document.createElement('option'); option.value = selected;
    option.textContent = `Current device (${selected.slice(0, 30)})`;
    select.append(option);
  }
  select.value = selected || 'default';
}
function fillForm(config) {
  const merged = mergeDefaults(config || {}, DEFAULTS);
  loadedConfig = merged; unsaved = false;
  tForPage();
  const assign = (id, value) => { const element = $(`#${id}`); if (element) element.value = value ?? ''; };
  const check = (id, value) => { const element = $(`#${id}`); if (element) element.checked = value === true; };
  assign('dot-display-name', merged.dot.displayName);
  assign('dot-expected-email', merged.dot.expectedEmail);
  assign('dot-url', merged.dot.url);
  assign('wake-phrase', merged.wakeWord.phrase);
  assign('wake-sensitivity', merged.wakeWord.sensitivity);
  assign('wake-sensitivity-value', merged.wakeWord.sensitivity);
  assign('wake-model-path', merged.wakeWord.modelPath);
  assign('wake-python-path', merged.wakeWord.pythonPath);
  assign('audio-buffer', merged.audio.bufferMs);
  assign('audio-sound-volume', merged.audio.soundVolume);
  assign('audio-sound-volume-value', `${Math.round(Number(merged.audio.soundVolume) * 100)}%`);
  assign('panel-opacity', merged.appearance.panelOpacity);
  assign('panel-opacity-value', `${Math.round(Number(merged.appearance.panelOpacity) * 100)}%`);
  assign('global-hotkey', merged.general.hotkey);
  assign('network-proxy', merged.network.signalingProxy);
  assign('signaling-launcher', JSON.stringify(merged.network.signalingLauncher, null, 2));
  assign('media-launcher', JSON.stringify(merged.network.mediaLauncher, null, 2));
  assign('recording-max-mb', merged.recording.maxMegabytes);
  assign('call-max-minutes', merged.call.maxMinutes);
  check('wake-enabled', merged.wakeWord.enabled);
  check('audio-sounds', merged.audio.sounds);
  check('mic-initially-muted', merged.audio.microphoneInitiallyMuted);
  check('speakers-initially-muted', merged.audio.speakersInitiallyMuted);
  check('show-panel', merged.appearance.showPanel);
  check('start-at-login', merged.general.startAtLogin);
  check('recording-enabled', merged.recording.enabled);
  setSelectOptions($('#audio-microphone'), knownDevices.inputs, merged.audio.microphoneDeviceId || 'default', 'input');
  setSelectOptions($('#audio-output'), knownDevices.outputs, merged.audio.outputDeviceId || 'default', 'output');
  $$('button[data-theme]').forEach(button => button.classList.toggle('selected', button.dataset.theme === merged.appearance.theme));
  setBufferPreset(merged.audio.bufferMs);
  $('#wake-fields').classList.toggle('fields-disabled', !merged.wakeWord.enabled);
  $('#wake-fields').setAttribute('aria-disabled', String(!merged.wakeWord.enabled));
  setWakeControls(merged.wakeWord.enabled);
  $('#sound-volume-field').classList.toggle('fields-disabled', !merged.audio.sounds);
  setSoundControls(merged.audio.sounds);
  updateSidebar(merged, latestSnapshot);
  applyAppearance(merged);
  const saved = $('#save-status');
  if (saved) { saved.textContent = copy('allChangesSaved'); saved.classList.add('success'); }
}
function setBufferPreset(value) {
  const number = Number(value);
  $$('[data-buffer]').forEach(button => button.classList.toggle('selected', Number(button.dataset.buffer) === number));
}
function setWakeControls(enabled) {
  $$('#wake-fields input, #wake-fields select, #wake-fields textarea, #wake-fields button').forEach(control => {
    if (control.id !== 'wake-setup') control.disabled = !enabled;
  });
}
function setSoundControls(enabled) {
  const control = $('#audio-sound-volume');
  if (control) control.disabled = !enabled;
}
function takeForm() {
  const config = cloneJson(loadedConfig || DEFAULTS);
  const displayName = $('#dot-display-name').value.trim();
  const dotUrl = $('#dot-url').value.trim();
  const email = $('#dot-expected-email').value.trim();
  if (dotUrl) {
    let parsed;
    try { parsed = new URL(dotUrl); } catch { throw new Error('invalid_url'); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com' || !/^\/dots\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.pathname) || parsed.search || parsed.hash) throw new Error('invalid_url');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid_email');
  const numeric = (id, min, max) => {
    const value = Number($(`#${id}`).value);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error('invalid_number');
    return value;
  };
  const parseLauncher = id => {
    const raw = $(`#${id}`).value.trim();
    if (!raw) return [];
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('invalid_launcher'); }
    if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== 'string' || item.length > 2048 || !item.trim())) throw new Error('invalid_launcher');
    return value;
  };
  config.dot.displayName = displayName.slice(0, 80) || 'My dot';
  config.dot.expectedEmail = email.slice(0, 254);
  config.dot.url = dotUrl.slice(0, 2048);
  config.general.startAtLogin = $('#start-at-login').checked;
  config.general.hotkey = $('#global-hotkey').value.trim().slice(0, 80) || 'CommandOrControl+Alt+Space';
  config.audio.bufferMs = Math.round(numeric('audio-buffer', 0, 2000) / 50) * 50;
  config.audio.microphoneDeviceId = $('#audio-microphone').value || 'default';
  config.audio.outputDeviceId = $('#audio-output').value || 'default';
  config.audio.sounds = $('#audio-sounds').checked;
  config.audio.soundVolume = numeric('audio-sound-volume', 0, 1);
  config.audio.microphoneInitiallyMuted = $('#mic-initially-muted').checked;
  config.audio.speakersInitiallyMuted = $('#speakers-initially-muted').checked;
  config.wakeWord.enabled = $('#wake-enabled').checked;
  config.wakeWord.phrase = $('#wake-phrase').value.trim().slice(0, 48) || 'Hey Dot';
  config.wakeWord.sensitivity = Math.round(numeric('wake-sensitivity', 1, 10));
  config.wakeWord.modelPath = $('#wake-model-path').value.trim().slice(0, 4096);
  if (config.wakeWord.modelPath && !config.wakeWord.modelPath.startsWith('/')) throw new Error('invalid_model_path');
  config.wakeWord.pythonPath = $('#wake-python-path').value.trim().slice(0, 4096) || 'python3';
  config.recording.enabled = $('#recording-enabled').checked;
  config.recording.maxMegabytes = Math.round(numeric('recording-max-mb', 1, 8192));
  config.appearance.theme = document.querySelector('button[data-theme].selected')?.dataset.theme || 'system';
  config.appearance.panelOpacity = numeric('panel-opacity', .2, 1);
  config.appearance.showPanel = $('#show-panel').checked;
  config.appearance.language = language;
  config.network.signalingProxy = $('#network-proxy').value.trim().slice(0, 2048);
  config.network.signalingLauncher = parseLauncher('signaling-launcher');
  config.network.mediaLauncher = parseLauncher('media-launcher');
  config.call.maxMinutes = Math.round(numeric('call-max-minutes', 1, 1440));
  return config;
}
function explainError(error) {
  const map = { invalid_url: 'invalidDotUrl', invalid_email: 'invalidEmail', invalid_launcher: 'invalidLauncher', invalid_number: 'invalidNumber' };
  map.invalid_model_path = 'Model path must be absolute, for example /home/user/model.';
  return copy(map[error?.message] || 'saveFailed');
}
async function loadConfig({ quiet = false } = {}) {
  if (!api || configLoading) return;
  configLoading = true;
  try {
    const result = await api.readConfig();
    if (!result || !result.config || typeof result.hash !== 'string') throw new Error('config_unavailable');
    configHash = result.hash;
    fillForm(result.config);
    if (!quiet) toast(copy('reloadDone'));
  } catch { toast(copy('saveFailed'), 'error'); }
  finally { configLoading = false; }
}
async function saveForm() {
  if (!api) return;
  let config;
  try { config = takeForm(); }
  catch (error) {
    const alert = $('#connect-error');
    alert.textContent = explainError(error); alert.hidden = false;
    toast(explainError(error), 'error');
    return;
  }
  $('#connect-error').hidden = true;
  $('#save-status').textContent = 'Saving…';
  try {
    const result = await api.saveConfig(config, configHash);
    if (!result?.ok) {
      const conflict = ['config_conflict', 'revision_mismatch', 'hash_mismatch', 'DOTDIAL_CONFIG_CONFLICT'].includes(result?.error);
      $('#save-status').textContent = conflict ? copy('configConflict') : copy('saveFailed');
      $('#reload-config').hidden = !conflict;
      toast(conflict ? copy('configConflict') : copy('saveFailed'), 'error');
      return;
    }
    configHash = result.hash;
    fillForm(result.config);
    toast(copy('saveSuccess'));
    const status = $('#connect-status'); status.textContent = copy('saveSuccess'); status.classList.add('success');
  } catch (error) {
    const conflict = ['config_conflict', 'revision_mismatch', 'DOTDIAL_CONFIG_CONFLICT'].includes(error?.code);
    $('#save-status').textContent = conflict ? copy('configConflict') : copy('saveFailed');
    $('#reload-config').hidden = !conflict;
    toast(conflict ? copy('configConflict') : copy('saveFailed'), 'error');
  }
}
async function runCommand(name, { notice = false } = {}) {
  try {
    const result = await api.command(name);
    const accepted = ['accepted_wake', 'accepted_stop', 'playing_missed_messages', 'playback_stopped', 'muting_microphone', 'unmuting_microphone', 'microphone_on', 'microphone_off', 'muting_speakers', 'unmuting_speakers', 'ok', 'success', 'preview'];
    if (notice && (!result || !accepted.includes(result.status))) toast(copy('controlFailed'), 'error');
    return result;
  } catch { if (notice) toast(copy('controlFailed'), 'error'); return { status: 'operation_failed' }; }
}
async function pasteDotLink() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) throw new Error('empty');
    $('#dot-url').value = text.trim(); markUnsaved(); toast(copy('clipboardPasted'));
  } catch { toast(copy('pasteUnavailable'), 'error'); }
}
async function scanDevices() {
  const status = $('#devices-status');
  status.textContent = copy('scanPermission'); status.className = 'status-note devices-status';
  try {
    const result = await api.getAudioDevices();
    const inputs = result?.inputs || [];
    const outputs = result?.outputs || [];
    knownDevices = { inputs, outputs };
    const config = loadedConfig || DEFAULTS;
    setSelectOptions($('#audio-microphone'), inputs, config.audio.microphoneDeviceId || 'default', 'input');
    setSelectOptions($('#audio-output'), outputs, config.audio.outputDeviceId || 'default', 'output');
    status.textContent = result?.error ? copy('devicesUnavailable') : (inputs.length || outputs.length ? copy('devicesFound') : copy('devicesEmpty'));
    status.className = `status-note devices-status${result?.error ? ' error' : ' success'}`;
  } catch {
    status.textContent = copy('devicesUnavailable'); status.className = 'status-note devices-status error';
  }
}
function updateSidebar(config, state) {
  const name = String(config?.dot?.displayName || 'My dot').slice(0, 100);
  $('#sidebar-dot-name').textContent = name;
  const account = String(config?.dot?.expectedEmail || '').trim();
  $('#sidebar-account').textContent = account || copy('notConnected');
  const dot = $('#sidebar-status-dot');
  const hasDot = Boolean(config?.dot?.url);
  dot.classList.toggle('ready', hasDot && !state.last_error);
  dot.classList.toggle('error', Boolean(state.last_error || state.start_error));
  $('#panel-dot-name').textContent = name;
}
function phaseText(state) {
  const phase = String(state.state || 'ready');
  if (state.missed_playing) return copy('playingMissed');
  if (phase === 'starting') return copy('connecting');
  if (phase === 'active') {
    if (state.microphone_muted) return copy('microphoneMuted');
    if (state.speakers_muted) return copy('speakersMuted');
    return copy('inCall');
  }
  if (phase === 'stopping') return copy('endingCall');
  if (state.last_error || state.start_error || state.missed_error || state.config_error) return copy('errorState');
  if (state.local_listening || state.wake_listening || state.wake_status === 'listening') return copy('wakeListening');
  if (state.wake_status === 'setup_required' || state.wake_status === 'error') return copy('errorState');
  return copy('ready');
}
function setIcon(button, icon) {
  const wrap = button?.querySelector('.icon-wrap');
  if (wrap && ICONS[icon]) wrap.innerHTML = ICONS[icon];
}
function updatePanel(state = {}) {
  latestSnapshot = state || {};
  const busy = ['starting', 'active', 'stopping'].includes(state.state);
  const active = state.state === 'active';
  const micMuted = state.microphone_muted === true || (active && state.local_listening === false && state.microphone_muted !== false);
  const speakersMuted = state.speakers_muted === true;
  const dot = $('#panel-status-dot');
  if (dot) {
    dot.className = 'panel-status-dot';
    if (state.state === 'active') dot.classList.add('call');
    else if (state.state === 'starting' || state.state === 'stopping') dot.classList.add('connecting');
    else if (state.last_error || state.start_error) dot.classList.add('error');
    else if (state.local_listening || state.wake_listening) dot.classList.add('listening');
  }
  if ($('#panel-status')) $('#panel-status').textContent = phaseText(state);
  if ($('#panel-wave')) $('#panel-wave').classList.toggle('active', active || state.missed_playing === true);
  if ($('#panel-mic')) {
    $('#panel-mic').classList.toggle('muted', micMuted);
    $('#panel-mic').disabled = !active || state.microphone_changing === true;
    $('#panel-mic').setAttribute('aria-label', micMuted ? copy('unmuteMicrophone') : copy('muteMicrophone'));
    $('#panel-mic').title = micMuted ? copy('unmuteMicrophone') : copy('muteMicrophone');
    setIcon($('#panel-mic'), micMuted ? 'micOff' : 'mic');
  }
  if ($('#panel-speakers')) {
    $('#panel-speakers').classList.toggle('muted', speakersMuted);
    $('#panel-speakers').disabled = !(active || state.missed_playing === true) || state.speakers_changing === true;
    $('#panel-speakers').setAttribute('aria-label', speakersMuted ? copy('unmuteSpeakers') : copy('muteSpeakers'));
    $('#panel-speakers').title = speakersMuted ? copy('unmuteSpeakers') : copy('muteSpeakers');
    setIcon($('#panel-speakers'), speakersMuted ? 'speakerOff' : 'speaker');
  }
  if ($('#panel-hangup')) {
    $('#panel-hangup').disabled = !busy;
    $('#panel-hangup').title = copy('endCall');
    $('#panel-hangup').setAttribute('aria-label', copy('endCall'));
  }
  const missedCount = Math.max(0, Number(state.missed_count) || 0);
  const showMissed = missedCount > 0 || state.missed_playing === true;
  if ($('#panel-missed')) {
    $('#panel-missed').hidden = !showMissed;
    $('#panel-missed').disabled = !showMissed;
    $('#panel-missed-count').textContent = String(Math.min(missedCount, 99));
    $('#panel-missed-count').hidden = missedCount < 1;
    const label = state.missed_playing ? copy('stopMissed') : `${copy('playMissed')} (${missedCount})`;
    $('#panel-missed').title = label;
    $('#panel-missed').setAttribute('aria-label', label);
    setIcon($('#panel-missed'), state.missed_playing ? 'stop' : 'replay');
  }
  updateSidebar(loadedConfig || DEFAULTS, state);
}
function updateSettingsState(state = {}) {
  const stateNode = $('#sidebar-state-label');
  if (stateNode) stateNode.textContent = phaseText(state);
  const pulse = $('#sidebar-state-pulse');
  if (pulse) {
    pulse.className = 'state-pulse';
    if (state.state === 'active') pulse.classList.add('call');
    else if (state.state === 'starting' || state.state === 'stopping') pulse.classList.add('connecting');
  }
  const wakeStatus = $('#wake-setup-status');
  if (wakeStatus && state.wake_status) {
    const messages = {
      listening: ['wakeStatusListening', 'success'],
      starting: ['wakeSetupStarted', ''],
      installing: ['wakeSetupStarted', ''],
      paused: ['wakeStatusPaused', ''],
      setup_required: ['wakeStatusRequired', 'error'],
      error: ['wakeStatusError', 'error'],
    };
    const row = messages[state.wake_status];
    if (row) { wakeStatus.textContent = copy(row[0]); wakeStatus.className = `status-note ${row[1]}`.trim(); }
  }
  if (!unsaved && state.config_error) { $('#save-status').textContent = 'Invalid settings JSON. Correct the file and save it.'; }
  else if (!unsaved && state.config_pending) { $('#save-status').textContent = 'Settings will apply after the call.'; }
  updateSidebar(loadedConfig || DEFAULTS, state);
}
function setupPanel() {
  const panel = $('#panel-view');
  if (!panel) return;
  $('#panel-mic').addEventListener('click', () => runCommand(latestSnapshot.microphone_muted ? 'UNMUTE' : 'MUTE', { notice: true }));
  $('#panel-speakers').addEventListener('click', () => runCommand(latestSnapshot.speakers_muted ? 'SPEAKERS_UNMUTE' : 'SPEAKERS_MUTE', { notice: true }));
  $('#panel-hangup').addEventListener('click', () => runCommand('STOP', { notice: true }));
  $('#panel-missed').addEventListener('click', () => runCommand(latestSnapshot.missed_playing ? 'MISSED_STOP' : 'MISSED_PLAY', { notice: true }));
  panel.addEventListener('contextmenu', event => { event.preventDefault(); void api.showMenu(); });
  let drag = null;
  let suppressClickUntil = 0;
  panel.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    try { event.target.setPointerCapture(event.pointerId); } catch {}
  });
  panel.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const totalX = event.clientX - drag.x, totalY = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(totalX, totalY) < 6) return;
    drag.moved = true;
    try { panel.setPointerCapture(event.pointerId); } catch {}
    const dx = Number(event.movementX) || 0, dy = Number(event.movementY) || 0;
    if (dx || dy) void api.movePanel(dx, dy);
  });
  const finishDrag = event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.moved) suppressClickUntil = Date.now() + 320;
    drag = null;
  };
  panel.addEventListener('pointerup', finishDrag);
  panel.addEventListener('pointercancel', finishDrag);
  panel.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}
function setupSettings() {
  $$('.nav-item').forEach(button => button.addEventListener('click', () => showPage(button.dataset.section)));
  $$('[data-go-section]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.goSection)));
  $('#top-save').addEventListener('click', saveForm);
  $('#bottom-save').addEventListener('click', saveForm);
  $('#save-connect').addEventListener('click', saveForm);
  $('#reload-config').addEventListener('click', () => loadConfig());
  $('#open-login').addEventListener('click', async () => { await runCommand('LOGIN'); toast(copy('accountOpen')); });
  $('#login-connect').addEventListener('click', async () => { await runCommand('LOGIN'); toast(copy('accountOpen')); });
  $('#paste-dot-link').addEventListener('click', pasteDotLink);
  $('#scan-devices').addEventListener('click', scanDevices);
  $('#wake-setup').addEventListener('click', async () => {
    $('#wake-setup-status').textContent = copy('wakeSetupStarted');
    const result = await runCommand('WAKE_SETUP');
    if (['wake_setup_started', 'wake_setup_running'].includes(result?.status)) {
      $('#wake-setup-status').textContent = copy('wakeSetupStarted');
      $('#wake-setup-status').className = 'status-note';
    } else {
      const success = ['ready', 'ok', 'success', 'wake_setup_complete'].includes(result?.status);
      $('#wake-setup-status').textContent = success ? copy('wakeSetupDone') : copy('wakeSetupFailed');
      $('#wake-setup-status').className = `status-note ${success ? 'success' : 'error'}`;
    }
  });
  $('#wake-enabled').addEventListener('change', event => {
    $('#wake-fields').classList.toggle('fields-disabled', !event.target.checked);
    setWakeControls(event.target.checked);
    markUnsaved();
  });
  $('#audio-sounds').addEventListener('change', event => {
    $('#sound-volume-field').classList.toggle('fields-disabled', !event.target.checked);
    setSoundControls(event.target.checked);
    markUnsaved();
  });
  $('#wake-sensitivity').addEventListener('input', event => { $('#wake-sensitivity-value').value = event.target.value; markUnsaved(); });
  $('#audio-sound-volume').addEventListener('input', event => { $('#audio-sound-volume-value').value = `${Math.round(Number(event.target.value) * 100)}%`; markUnsaved(); });
  $('#panel-opacity').addEventListener('input', event => {
    $('#panel-opacity-value').value = `${Math.round(Number(event.target.value) * 100)}%`;
    document.documentElement.style.setProperty('--panel-opacity', String(event.target.value)); markUnsaved();
  });
  $('#audio-buffer').addEventListener('input', event => { setBufferPreset(event.target.value); markUnsaved(); });
  $$('[data-buffer]').forEach(button => button.addEventListener('click', () => {
    $('#audio-buffer').value = button.dataset.buffer; setBufferPreset(button.dataset.buffer); markUnsaved();
  }));
  $$('button[data-theme]').forEach(button => button.addEventListener('click', () => {
    $$('button[data-theme]').forEach(item => item.classList.toggle('selected', item === button));
    const theme = button.dataset.theme;
    document.body.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
    markUnsaved();
  }));
  $('#settings-content').addEventListener('input', event => {
    if (event.target.matches('input,select,textarea') && !['wake-sensitivity', 'audio-sound-volume', 'panel-opacity', 'audio-buffer'].includes(event.target.id)) markUnsaved();
  });
  $('#settings-content').addEventListener('change', event => {
    if (event.target.matches('input,select,textarea')) markUnsaved();
  });
}
function init() {
  $$('[data-icon]').forEach(node => { node.innerHTML = ICONS[node.dataset.icon] || ''; });
  const settings = $('#settings-view'), panel = $('#panel-view');
  settings.hidden = view === 'panel'; panel.hidden = view !== 'panel';
  if (view === 'panel') { setupPanel(); void loadConfig({ quiet: true }); }
  else {
    setupSettings();
    showPage('connect');
    void loadConfig({ quiet: true });
  }
  if (api?.onState) api.onState(state => {
    latestSnapshot = state || {};
    if (state?.config_hash && state.config_hash !== configHash && (!unsaved || view === 'panel')) void loadConfig({ quiet: true });
    if (view === 'panel') updatePanel(latestSnapshot);
    else updateSettingsState(latestSnapshot);
  });
  if (view === 'panel') updatePanel(latestSnapshot);
}

init();
