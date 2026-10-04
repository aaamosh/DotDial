'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const api = window.dotdial;
const view = new URLSearchParams(location.search).get('view') || 'settings';

const COPY = {
  en: {
    desktopCompanion: 'DESKTOP COMPANION', yourAssistant: 'YOUR ASSISTANT', notConnected: 'Not connected', accountUnverified: 'Sign-in not verified', accountVerified: 'Account verified',
    connect: 'Connect', voice: 'Voice', appearance: 'Appearance', advanced: 'Advanced', ready: 'Ready',
    settings: 'Settings', openChatGPT: 'Open ChatGPT', saveChanges: 'Save changes', connection: 'CONNECTION',
    connectYourDot: 'Connect your Dot', connectIntro: 'Give DotDial the link to your assistant. Sign in once in its own private window.',
    desktopReady: 'Desktop ready', voiceControls: 'Voice controls', assistantProfile: 'Assistant profile',
    profileHelp: 'Choose which Dot to open when you call.', privateSession: 'PRIVATE SESSION', dotName: 'Name',
    dotNameHint: 'This name appears in the tray and call panel.', expectedAccount: 'Account email (optional)',
    expectedAccountHint: 'Used to help you check you signed in to the right account.', dotLink: 'Dot link', paste: 'Paste',
    dotLinkHint: 'Use the link from your Dot profile. DotDial opens it in a separate signed-in window.',
    saveProfile: 'Save settings', signInOpenChatGPT: 'Sign in / open ChatGPT',
    privacyNote: 'Sign in with your ChatGPT account. Your password is never stored in this configuration file.',
    wakeWordTitle: 'Hands-free wake word', wakeWordIntro: 'Keep wake-word listening on while the tray shows its listening state.',
    configureVoice: 'Configure voice', audioTitle: 'Clear, local audio', audioIntro: 'Choose your microphone, speakers and playback buffer.', audioSettings: 'Audio settings',
    voiceSettings: 'VOICE SETTINGS', voiceIntro: 'Tune how DotDial listens and plays voice on this computer.',
    wakeWordDescription: 'Wake-word recognition runs locally on this computer. The bundled model recognizes English phrases.', wakePhrase: 'Wake phrase',
    wakePhraseHint: 'Use a short English phrase, such as “Hey Dot”, that sounds different from everyday conversation.', sensitivity: 'Sensitivity',
    sensitivityHint: 'Higher sensitivity can wake up more often by mistake.', wakeModel: 'Recognition model',
    wakeModelHint: 'DotDial can install the local model and its dependencies.', installWakeModel: 'Install or check wake-word support',
    pythonPath: 'Python interpreter', pythonPathHint: 'Used only by local wake-word support. Example: python3.',
    audioDevices: 'Audio devices', deviceHelp: 'Call device names are requested only when you press Scan devices.',
    scanDevices: 'Scan devices', systemDefault: 'System default', microphone: 'Microphone',
    microphoneHint: 'Used for calls. Wake word has a separate input selector.', speakers: 'Speakers', speakersHint: 'Choose where Dot’s voice plays.',
    wakeInput: 'Wake-word input (optional)', wakeInputHint: 'This selects a PortAudio device for local wake recognition only.',
    wakeInputScanLabel: 'Wake-word input list', scanWakeDevices: 'Scan wake inputs', wakeDevicesFound: 'Wake inputs updated.',
    wakeDevicesEmpty: 'No named wake inputs found. System default remains selected.', wakeDevicesUnavailable: 'Could not list wake inputs. System default remains available.',
    wakeDeviceMissing: 'Saved wake input is unavailable. Choose another input or System default.', wakeDeviceAmbiguous: 'This device name is ambiguous in PortAudio; choose another input.',
    playbackBuffer: 'Playback buffer', bufferHelp: 'A short reserve can smooth choppy networks. Larger values add a little delay.',
    lowestDelay: 'Lowest delay', balanced: 'Balanced', custom: 'Custom', callSounds: 'Call sounds',
    playCallSounds: 'Play connect and disconnect sounds', soundVolume: 'Sound volume',
    connectionSound: 'Connection sound', modemSound: 'Modem (default)', telephoneSound: 'Old telephone', customSound: 'Custom audio',
    connectionSoundHint: 'Choose the sound DotDial plays while it calls your Dot.', selectedSoundFile: 'Selected file', noSoundFile: 'No file selected',
    chooseSoundFile: 'Choose file', playPreview: 'Play preview', stopPreview: 'Stop', soundFileLimits: 'MP3 or WAV · up to 30 seconds / 10 MB',
    previewingSound: 'Playing sound preview…', previewFinished: 'Preview finished.', previewStopped: 'Preview stopped.',
    soundFileInvalid: 'Choose a local MP3 or WAV file.', soundFileUnavailable: 'The selected sound file could not be read. Choose it again.',
    soundFileTooLarge: 'Choose a sound file no larger than 10 MiB.', soundFileTooLong: 'Choose a sound no longer than 30 seconds.',
    soundDecodeFailed: 'This file could not be decoded as MP3 or WAV.', soundDecodeBusy: 'A sound is still being prepared. Try again in a moment.',
    callInProgress: 'Finish the call or replay before previewing a sound.', soundPreviewUnavailable: 'Sound preview is unavailable right now.',
    soundChooseCancelled: 'Choose a sound file before saving or previewing.',
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
    callSettingsPending: 'Call settings will apply after the call.',
    endingCall: 'Ending call', wakeListening: 'Wake word listening', microphoneMuted: 'Microphone muted', speakersMuted: 'Speakers muted',
    playingMissed: 'Playing missed replies', errorState: 'Needs attention', playMissed: 'Play missed replies', stopMissed: 'Stop missed replies', endCall: 'End call',
    muteMicrophone: 'Mute microphone', unmuteMicrophone: 'Unmute microphone', muteSpeakers: 'Mute speakers', unmuteSpeakers: 'Unmute speakers',
    saveSuccess: 'Settings saved.', saveFailed: 'Could not save settings.', configConflict: 'Settings changed elsewhere. Reload them before saving.',
    saveWakeBeforeSetup: 'Save the wake-word settings before installing support.',
    invalidDotUrl: 'Enter a link from chatgpt.com/dots/…', invalidEmail: 'Enter a valid email address or leave the field empty.',
    invalidLauncher: 'Launcher settings must be a JSON array of text arguments.', invalidNumber: 'Check the highlighted number fields.',
    pasteUnavailable: 'Clipboard access was not available.', clipboardPasted: 'Link pasted.', reloadDone: 'Latest settings loaded.',
    devicesFound: 'Device list updated.', devicesEmpty: 'No named devices found. System default is still available.',
    devicesUnavailable: 'Could not list devices. System default remains selected.', scanPermission: 'Scanning lists device names; it does not start the microphone.',
    wakeSetupStarted: 'Checking local wake-word support…', wakeSetupDone: 'Wake-word support is ready.', wakeSetupFailed: 'Wake-word setup did not complete.',
    wakeStatusDisabled: 'Wake word is off. Enable it and save settings to start local listening.', wakeStatusListening: 'Wake word is listening locally.', wakeStatusPaused: 'Wake-word listening is paused during idle playback.', wakeStatusRequired: 'Install wake-word support to start listening.', wakeStatusError: 'Wake-word service needs attention.',
    menuShown: 'Tray menu opened.', controlFailed: 'That control is unavailable right now.',
    clearTitle: 'Clear missed replies?', clearBody: 'This permanently deletes saved replies that have not been fully played.',
    accountOpen: 'ChatGPT sign-in opened.',
  },

};

const ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v4M8 22h8"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v4M8 22h8"/><path d="m15 13 6 6m0-6-6 6" stroke="#202226" stroke-width="4"/><path d="m15 13 6 6m0-6-6 6" stroke="#bb7276" stroke-width="2.4"/></svg>',
  speaker: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 11.5h5l6-5v19l-6-5h-5z"/><path d="M20 11a8 8 0 0 1 0 10M22.5 7.5a13 13 0 0 1 0 17"/></svg>',
  speakerOff: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 11.5h5l6-5v19l-6-5h-5z"/><path d="m19 12 7 7m0-7-7 7" stroke="#202226" stroke-width="4"/><path d="m19 12 7 7m0-7-7 7" stroke="#bb7276" stroke-width="2.3"/></svg>',
  hangup: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 2.5c-.8-.5-1.7-.3-2.3.3L2.5 4c-.8.8-.8 2-.5 3.1 1.7 6.7 8.2 13.2 14.9 14.9 1.1.3 2.3.3 3.1-.5l1.2-1.2c.6-.6.8-1.5.3-2.3l-2.4-3.6c-.5-.7-1.4-1-2.2-.5l-2 1.2a16.6 16.6 0 0 1-6-6l1.2-2c.5-.8.2-1.7-.5-2.2z"/></svg>',
};

const DEFAULTS = {
  version: 1,
  dot: { url: '', displayName: 'My dot', expectedEmail: '' },
  general: { startAtLogin: false, hotkey: 'CommandOrControl+Alt+Space' },
  audio: { bufferMs: 0, microphoneDeviceId: 'default', outputDeviceId: 'default', sounds: true, connectionSound: 'modem', customSoundPath: '', soundVolume: .55, microphoneInitiallyMuted: false, speakersInitiallyMuted: false },
  wakeWord: { enabled: false, phrase: 'Hey Dot', sensitivity: 6, modelPath: '', pythonPath: 'python3', deviceName: '', deviceHostApi: '' },
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
let knownWakeDevices = [];
let toastTimer = null;
let selectedSoundPath = '';
let soundPreviewActive = false;

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
function wakeDeviceKey(name, hostApi) { return JSON.stringify([name, hostApi]); }
function setWakeDeviceOptions(rows, selectedName = '', selectedHostApi = '') {
  const select = $('#wake-input');
  if (!select) return;
  const selected = selectedName && selectedHostApi ? wakeDeviceKey(selectedName, selectedHostApi) : 'default';
  select.replaceChildren(new Option(copy('systemDefault'), 'default'));
  for (const device of Array.isArray(rows) ? rows : []) {
    if (typeof device?.name !== 'string' || !device.name || typeof device?.hostApi !== 'string' || !device.hostApi) continue;
    const value = wakeDeviceKey(device.name, device.hostApi);
    const option = new Option(`${device.name} — ${device.hostApi}${device.ambiguous ? ` · ${copy('wakeDeviceAmbiguous')}` : ''}`, value);
    option.disabled = device.ambiguous === true;
    select.append(option);
  }
  if (selected !== 'default' && ![...select.options].some(option => option.value === selected)) {
    const option = new Option(`${selectedName} — ${selectedHostApi} · ${copy('wakeDeviceMissing')}`, selected);
    select.append(option);
  }
  select.value = selected;
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
  assign('audio-connection-sound', ['modem', 'telephone', 'custom'].includes(merged.audio.connectionSound) ? merged.audio.connectionSound : 'modem');
  selectedSoundPath = typeof merged.audio.customSoundPath === 'string' ? merged.audio.customSoundPath : '';
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
  setWakeDeviceOptions(knownWakeDevices, merged.wakeWord.deviceName, merged.wakeWord.deviceHostApi);
  $$('button[data-theme]').forEach(button => button.classList.toggle('selected', button.dataset.theme === merged.appearance.theme));
  setBufferPreset(merged.audio.bufferMs);
  $('#wake-fields').classList.toggle('fields-disabled', !merged.wakeWord.enabled);
  $('#wake-fields').setAttribute('aria-disabled', String(!merged.wakeWord.enabled));
  setWakeControls(merged.wakeWord.enabled);
  $('#sound-volume-field').classList.toggle('fields-disabled', !merged.audio.sounds);
  setSoundControls(merged.audio.sounds);
  renderSelectedSoundPath();
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
    if (!['wake-setup', 'wake-input', 'scan-wake-devices'].includes(control.id)) control.disabled = !enabled;
  });
}
function setSoundControls(enabled) {
  const control = $('#audio-sound-volume');
  if (control) control.disabled = !enabled;
}
function renderSelectedSoundPath() {
  const output = $('#custom-sound-path');
  if (!output) return;
  output.textContent = selectedSoundPath || copy('noSoundFile');
  output.title = selectedSoundPath;
}
function setSoundPreviewControls(active) {
  soundPreviewActive = active;
  const play = $('#preview-sound'), stop = $('#stop-sound-preview');
  if (play) play.disabled = active;
  if (stop) stop.disabled = !active;
}
function soundErrorMessage(error) {
  const code = error?.code || error?.error?.code;
  const key = ({
    sound_file_invalid: 'soundFileInvalid', sound_file_unavailable: 'soundFileUnavailable',
    sound_file_too_large: 'soundFileTooLarge', sound_file_too_long: 'soundFileTooLong',
    sound_decode_failed: 'soundDecodeFailed', sound_decode_busy: 'soundDecodeBusy',
    sound_decode_cancelled: 'previewStopped', call_in_progress: 'callInProgress',
    sound_preview_unavailable: 'soundPreviewUnavailable',
  })[code];
  if (key) return copy(key);
  const message = error?.error?.message || error?.message;
  return typeof message === 'string' && message.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(message)
    ? message : copy('soundPreviewUnavailable');
}
async function selectCustomSound() {
  const status = $('#sound-preview-status');
  status.textContent = '';
  status.className = 'status-note sound-preview-status';
  if (!api || typeof api.chooseSoundFile !== 'function') {
    status.textContent = copy('soundPreviewUnavailable');
    status.className = 'status-note sound-preview-status error';
    return false;
  }
  try {
    const result = await api.chooseSoundFile();
    if (result?.status === 'selected' && typeof result.filePath === 'string' && result.filePath.length <= 4096) {
      selectedSoundPath = result.filePath;
      $('#audio-connection-sound').value = 'custom';
      renderSelectedSoundPath();
      markUnsaved();
      $('#sound-preview-status').textContent = '';
      $('#sound-preview-status').className = 'status-note sound-preview-status';
      return true;
    }
    if (result?.status === 'error') {
      $('#sound-preview-status').textContent = soundErrorMessage(result.error);
      $('#sound-preview-status').className = 'status-note sound-preview-status error';
      return false;
    }
  } catch (error) {
    $('#sound-preview-status').textContent = soundErrorMessage(error);
    $('#sound-preview-status').className = 'status-note sound-preview-status error';
    return false;
  }
  return false;
}
async function ensureCustomSoundSelected() {
  if ($('#audio-connection-sound').value !== 'custom' || selectedSoundPath) return true;
  if (await selectCustomSound()) return true;
  if (!$('#sound-preview-status').classList.contains('error')) {
    $('#sound-preview-status').textContent = copy('soundChooseCancelled');
    $('#sound-preview-status').className = 'status-note sound-preview-status error';
  }
  return false;
}
async function playSoundPreview() {
  if (soundPreviewActive || !api) return;
  if (!await ensureCustomSoundSelected()) return;
  const connectionSound = $('#audio-connection-sound').value;
  const customSoundPath = selectedSoundPath;
  const soundVolume = Number($('#audio-sound-volume').value);
  if (!['modem', 'telephone', 'custom'].includes(connectionSound) || !Number.isFinite(soundVolume) || soundVolume < 0 || soundVolume > 1) {
    $('#sound-preview-status').textContent = copy('soundPreviewUnavailable');
    $('#sound-preview-status').className = 'status-note sound-preview-status error';
    return;
  }
  setSoundPreviewControls(true);
  $('#sound-preview-status').textContent = copy('previewingSound');
  $('#sound-preview-status').className = 'status-note sound-preview-status';
  try {
    const result = await api.previewSound({ connectionSound, customSoundPath, soundVolume });
    if (result?.status !== 'preview_finished' && result?.status !== 'preview_stopped') {
      $('#sound-preview-status').textContent = soundErrorMessage(result?.error || result);
      $('#sound-preview-status').className = 'status-note sound-preview-status error';
    } else {
      $('#sound-preview-status').textContent = copy(result?.status === 'preview_stopped' ? 'previewStopped' : 'previewFinished');
      $('#sound-preview-status').className = 'status-note sound-preview-status success';
    }
  } catch (error) {
    $('#sound-preview-status').textContent = soundErrorMessage(error);
    $('#sound-preview-status').className = 'status-note sound-preview-status error';
  } finally { setSoundPreviewControls(false); }
}
async function stopSoundPreview() {
  if (!soundPreviewActive || !api) return;
  $('#sound-preview-status').textContent = copy('previewingSound');
  try {
    const result = await api.stopSoundPreview();
    if (result?.status === 'error' || result?.error) {
      $('#sound-preview-status').textContent = soundErrorMessage(result.error || result);
      $('#sound-preview-status').className = 'status-note sound-preview-status error';
    }
  } catch (error) {
    $('#sound-preview-status').textContent = soundErrorMessage(error);
    $('#sound-preview-status').className = 'status-note sound-preview-status error';
  }
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
  config.audio.connectionSound = $('#audio-connection-sound').value;
  config.audio.customSoundPath = selectedSoundPath;
  if (!['modem', 'telephone', 'custom'].includes(config.audio.connectionSound)) throw new Error('invalid_sound');
  if (config.audio.customSoundPath && (!config.audio.customSoundPath.startsWith('/') || config.audio.customSoundPath.length > 4096)) throw new Error('invalid_sound');
  config.audio.soundVolume = numeric('audio-sound-volume', 0, 1);
  config.audio.microphoneInitiallyMuted = $('#mic-initially-muted').checked;
  config.audio.speakersInitiallyMuted = $('#speakers-initially-muted').checked;
  config.wakeWord.enabled = $('#wake-enabled').checked;
  config.wakeWord.phrase = $('#wake-phrase').value.trim().slice(0, 48) || 'Hey Dot';
  config.wakeWord.sensitivity = Math.round(numeric('wake-sensitivity', 1, 10));
  config.wakeWord.modelPath = $('#wake-model-path').value.trim().slice(0, 4096);
  if (config.wakeWord.modelPath && !config.wakeWord.modelPath.startsWith('/')) throw new Error('invalid_model_path');
  config.wakeWord.pythonPath = $('#wake-python-path').value.trim().slice(0, 4096) || 'python3';
  const wakeDevice = $('#wake-input').value || 'default';
  if (wakeDevice === 'default') {
    config.wakeWord.deviceName = '';
    config.wakeWord.deviceHostApi = '';
  } else {
    let selected;
    try { selected = JSON.parse(wakeDevice); } catch { throw new Error('invalid_wake_device'); }
    if (!Array.isArray(selected) || selected.length !== 2 || selected.some(value => typeof value !== 'string' || !value)) throw new Error('invalid_wake_device');
    config.wakeWord.deviceName = selected[0];
    config.wakeWord.deviceHostApi = selected[1];
  }
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
  map.invalid_sound = 'Choose a supported connection sound and a local MP3 or WAV file.';
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
  if (!api) return false;
  if (!await ensureCustomSoundSelected()) return false;
  let config;
  try { config = takeForm(); }
  catch (error) {
    const alert = $('#connect-error');
    alert.textContent = explainError(error); alert.hidden = false;
    toast(explainError(error), 'error');
    return false;
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
      return false;
    }
    configHash = result.hash;
    fillForm(result.config);
    toast(copy('saveSuccess'));
    const status = $('#connect-status'); status.textContent = copy('saveSuccess'); status.classList.add('success');
    return true;
  } catch (error) {
    const conflict = ['config_conflict', 'revision_mismatch', 'DOTDIAL_CONFIG_CONFLICT'].includes(error?.code);
    $('#save-status').textContent = conflict ? copy('configConflict') : copy('saveFailed');
    $('#reload-config').hidden = !conflict;
    toast(conflict ? copy('configConflict') : copy('saveFailed'), 'error');
    return false;
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
async function scanWakeDevices() {
  const status = $('#wake-devices-status');
  status.textContent = copy('scanPermission'); status.className = 'field-hint';
  try {
    const result = await runCommand('WAKE_DEVICES');
    if (result?.status !== 'wake_devices_listed' || !Array.isArray(result.inputs)) throw new Error('wake_devices_unavailable');
    knownWakeDevices = result.inputs;
    const [selectedName, selectedHostApi] = (() => {
      try {
        const selected = JSON.parse($('#wake-input').value || '"default"');
        return Array.isArray(selected) && selected.length === 2 ? selected : ['', ''];
      } catch { return ['', '']; }
    })();
    setWakeDeviceOptions(knownWakeDevices, selectedName, selectedHostApi);
    const namedInputs = knownWakeDevices.filter(device => device && typeof device.name === 'string').length;
    status.textContent = namedInputs ? copy('wakeDevicesFound') : copy('wakeDevicesEmpty');
    status.className = `field-hint${namedInputs ? ' success' : ''}`;
  } catch {
    status.textContent = copy('wakeDevicesUnavailable'); status.className = 'field-hint error';
  }
}
function updateSidebar(config, state) {
  const name = String(config?.dot?.displayName || 'My dot').slice(0, 100);
  $('#sidebar-dot-name').textContent = name;
  const verified = state?.identity_verified === true;
  const account = verified ? String(state.verified_email || '').trim() : '';
  const hasDot = Boolean(config?.dot?.url);
  $('#sidebar-account').textContent = account || (verified ? copy('accountVerified') : hasDot ? copy('accountUnverified') : copy('notConnected'));
  const dot = $('#sidebar-status-dot');
  dot.classList.toggle('ready', hasDot && verified && !state.last_error);
  dot.classList.toggle('error', Boolean(state.last_error || state.start_error));
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
  const replayOnly = state.missed_playing === true && !busy;
  const missedCount = Math.max(0, Math.trunc(Number(state.missed_count) || 0));
  const status = [String(loadedConfig?.dot?.displayName || 'DotDial'), phaseText(state)];
  if (missedCount) status.push(`${missedCount} missed replies`);
  if (state.missed_recording) status.push('Saving replies');
  if ($('#panel-view')) $('#panel-view').title = status.join(' · ');
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
    const speakerAction = speakersMuted ? copy('unmuteSpeakers') : copy('muteSpeakers');
    $('#panel-speakers').title = missedCount ? `${speakerAction} · ${missedCount} missed replies · Right-click to play` : speakerAction;
    setIcon($('#panel-speakers'), speakersMuted ? 'speakerOff' : 'speaker');
  }
  if ($('#panel-hangup')) {
    $('#panel-hangup').disabled = !(['starting', 'active'].includes(state.state) || replayOnly);
    const action = replayOnly ? copy('stopMissed') : copy('endCall');
    $('#panel-hangup').title = action;
    $('#panel-hangup').setAttribute('aria-label', action);
  }
  const badge = $('#panel-missed-count');
  if (badge) {
    badge.textContent = missedCount > 99 ? '99+' : String(missedCount);
    badge.dataset.digits = String(badge.textContent.length);
    badge.hidden = missedCount < 1;
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
      disabled: ['wakeStatusDisabled', ''],
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
  if (!unsaved) {
    const pending = Boolean(state.config_error || state.config_pending);
    const saved = $('#save-status');
    saved.textContent = state.config_error ? 'Invalid settings JSON. Correct the file and save it.'
      : state.config_pending ? copy('callSettingsPending') : copy('allChangesSaved');
    saved.classList.toggle('success', !pending);
    const indicator = $('.saved-check');
    indicator.textContent = state.config_error ? '!' : state.config_pending ? '…' : '✓';
    indicator.classList.toggle('warning', pending);
  }
  updateSidebar(loadedConfig || DEFAULTS, state);
}
function setupPanel() {
  const panel = $('#panel-view');
  if (!panel) return;
  $('#panel-mic').addEventListener('click', () => runCommand(latestSnapshot.microphone_muted ? 'UNMUTE' : 'MUTE', { notice: true }));
  $('#panel-speakers').addEventListener('click', () => runCommand(latestSnapshot.speakers_muted ? 'SPEAKERS_UNMUTE' : 'SPEAKERS_MUTE', { notice: true }));
  $('#panel-hangup').addEventListener('click', () => {
    const busy = ['starting', 'active', 'stopping'].includes(latestSnapshot.state);
    void runCommand(latestSnapshot.missed_playing && !busy ? 'MISSED_STOP' : 'STOP', { notice: true });
  });
  let drag = null;
  const buttonAt = event => document.elementFromPoint(event.clientX, event.clientY)?.closest('.panel-control');
  panel.addEventListener('contextmenu', event => { event.preventDefault(); drag = null; void api.showMenu(); });
  panel.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false, button: buttonAt(event) };
    panel.setPointerCapture(event.pointerId);
  });
  panel.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    // Global coordinates stay stable when the window moves beneath the pointer.
    const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
    if (!drag.moved && Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
    drag.moved = true;
    drag.x = event.screenX; drag.y = event.screenY;
    if (dx || dy) void api.movePanel(dx, dy);
  });
  panel.addEventListener('pointerup', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const activate = !drag.moved && drag.button && drag.button === buttonAt(event) && !drag.button.disabled;
    const button = drag.button;
    drag = null;
    if (activate) button.click();
  });
  const cancelDrag = event => { if (drag?.id === event.pointerId) drag = null; };
  panel.addEventListener('pointercancel', cancelDrag);
  panel.addEventListener('lostpointercapture', cancelDrag);
  // Pointer releases are dispatched above; keep keyboard and accessibility clicks.
  panel.addEventListener('click', event => {
    if (event.detail > 0) { event.preventDefault(); event.stopImmediatePropagation(); }
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
  $('#scan-wake-devices').addEventListener('click', scanWakeDevices);
  $('#choose-sound-file').addEventListener('click', () => { void selectCustomSound(); });
  $('#preview-sound').addEventListener('click', () => { void playSoundPreview(); });
  $('#stop-sound-preview').addEventListener('click', () => { void stopSoundPreview(); });
  $('#wake-setup').addEventListener('click', async () => {
    if (unsaved && !await saveForm()) {
      $('#wake-setup-status').textContent = copy('saveWakeBeforeSetup');
      $('#wake-setup-status').className = 'status-note error';
      return;
    }
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
