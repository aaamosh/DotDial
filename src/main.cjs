'use strict';

// Packaged Electron starts its own entrypoint for media children too.
if (process.argv.includes('--media-worker')) {
  require('./media_worker.cjs');
} else {
  void boot();
}

async function boot() {
  const { app, BrowserWindow, session, ipcMain, Menu, globalShortcut, dialog, systemPreferences } = require('electron');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const net = require('node:net');
  const { pathToFileURL } = require('node:url');
  const { getPaths, loadConfigSnapshot, saveConfig, validateConfig } = require('./config.cjs');
  const { attachClient } = require('./ipc_client.cjs');
  const { createBrowserIdentity } = require('./browser_identity.cjs');
  const { createWebRecovery } = require('./web_recovery.cjs');
  const { selectLiveConfig } = require('./live_config.cjs');
  const { installQuitBarrier } = require('./quit_guard.cjs');
  const { createMicrophonePermission, createLoginItemController, isCustomMacLaunch, installMacApplicationMenu, secureRuntimeDirectory } = require('./macos.cjs');
  const option = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
  const demo = process.argv.includes('--demo');
  const demoRoot = demo ? fs.mkdtempSync(path.join(os.tmpdir(), 'dotdial-preview-')) : null;
  const paths = getPaths();
  if (option('config')) { paths.configFile = path.resolve(option('config')); paths.configDir = path.dirname(paths.configFile); }
  if (demoRoot) {
    paths.configDir = demoRoot; paths.configFile = path.join(demoRoot, 'config.json');
    paths.stateDir = path.join(demoRoot, 'state'); paths.dataDir = path.join(demoRoot, 'data');
    paths.runtimeDir = path.join(demoRoot, 'run'); paths.recordingsDir = path.join(paths.stateDir, 'missed-audio');
    paths.socketPath = path.join(paths.runtimeDir, 'dotdial.sock');
  }
  let snapshot;
  try {
    // An explicit --config can live in an existing user-owned directory.
    // Creating it is safe; changing that directory's permissions is not ours.
    fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    for (const dir of [paths.stateDir, paths.dataDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    secureRuntimeDirectory(paths.runtimeDir);
    snapshot = loadConfigSnapshot(paths.configFile);
  }
  catch (error) { dialog.showErrorBox('DotDial configuration', error.message); app.exit(2); return; }
  if (snapshot.hash === null) snapshot = saveConfig(paths.configFile, snapshot.config, { expectedHash: null });
  let config = snapshot.config;
  app.setName('DotDial');
  if (process.platform === 'linux') app.setDesktopName('dotdial.desktop');
  app.setPath('userData', demoRoot ? path.join(paths.dataDir, 'profile') : option('profile') || path.join(paths.dataDir, 'profile'));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  if (process.platform === 'darwin') app.setActivationPolicy('regular');

  let desktop, controller, mailbox, missedPlayer, audioControls, sounds, customSounds, wakeManager, webSession, server;
  let soundPreview = false, previewGeneration = 0;
  let loginWindow, pageReady, pageFailed = false, identityEpoch = 0, shuttingDown = false;
  let configPending = false, configError = null, wakeEpoch = 0, hotkeyAvailable = true, applyingConfig = false;
  let configReloadRequested = false, settingsSaveEpoch = 0;
  let demoCallTimer, currentThreadId = null, callPreparing = false, microphoneIntent = 0;
  let webVerifying = false, webActionRequired = false;
  let lastState = { state: 'ready', local_listening: false };
  const journalFile = path.join(paths.stateDir, 'call-journal.json');
  const safeCode = error => /^[a-z0-9_]{1,100}$/i.test(error?.code || '') ? error.code : 'operation_failed';
  const failure = code => Object.assign(new Error(code), { code });
  const loadModule = name => import(pathToFileURL(path.join(__dirname, name)).href);
  const microphonePermission = createMicrophonePermission({ systemPreferences, onChange: () => {
    desktop?.update(state());
    if (!shuttingDown && microphonePermission.status() === 'granted') wakeManager?.start();
  } });
  const loginItem = createLoginItemController({ app });
  const nativePaths = process.platform === 'darwin' ? getPaths({ env: {} }) : null;
  const customMacLaunch = value => isCustomMacLaunch({ nativePaths, paths, profile: option('profile'), signalingLauncher: value.network.signalingLauncher });
  const busy = () => callPreparing || (controller && !['ready'].includes(controller.state));
  function writeJson(file, value) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  function readJournal() {
    try { return JSON.parse(fs.readFileSync(journalFile, 'utf8')); }
    catch (e) { return e.code === 'ENOENT' ? null : { phase: 'invalid_journal' }; }
  }
  function state() {
    return { ...lastState, ...(callPreparing && lastState.state === 'ready' ? { state: 'starting' } : {}), ...mailbox?.snapshot(), ...(mailbox?.playing ? { microphone_changing: true } : {}),
      demo, configured: !!config.dot.url, config_hash: snapshot.hash, config_pending: configPending, config_error: configError,
      wake_status: wakeManager?.status || 'disabled', wake_listening: wakeManager?.status === 'listening', wake_error: wakeManager?.error || null,
      wake_phrase: wakeManager?.config?.phrase || config.wakeWord.phrase,
      web_verifying: webVerifying, web_action_required: webActionRequired,
      hotkey_available: hotkeyAvailable,
      ...(process.platform === 'darwin' && !demo ? {
        microphone_permission: microphonePermission.status(),
        ...(microphonePermission.isPending() ? { microphone_changing: true } : {}),
        login_item_status: loginItem.snapshot().status, login_item_error: loginItem.snapshot().error,
      } : {}) };
  }
  function publish(value = lastState) {
    if (lastState.state === 'active' && value.state !== 'active' && lastState.media) {
      // Preserve bounded transport counters before the next attempt resets them.
      // No addresses, call identifiers, speech or credentials are included.
      writeJson(path.join(paths.stateDir, 'last-call-diagnostics.json'), {
        ended_at: new Date().toISOString(), media: lastState.media,
        timings_ms: lastState.timings_ms, last_error: value.last_error || null,
      });
    }
    lastState = value;
    const current = state();
    desktop?.update(current);
    writeJson(path.join(paths.stateDir, 'status.json'), { updated_at: new Date().toISOString(), ...current });
    wakeManager?.setCallState(current);
    if (current.state === 'ready' && configPending && !applyingConfig) void applyDiskConfig().catch(e => { configPending = false; configError = safeCode(e); desktop?.update(state()); });
  }
  function inIdentityWorld(code) {
    if (!loginWindow || loginWindow.isDestroyed()) throw failure('login_connection_failed');
    return loginWindow.webContents.executeJavaScriptInIsolatedWorld(1007, [{ code: `(async () => {
      const epoch = ${identityEpoch};
      const holder = globalThis.__dotdialIdentity ??= { auth: (${createBrowserIdentity.toString()})(${JSON.stringify(config.dot.expectedEmail)}), epoch };
      if (holder.epoch !== epoch) {
        holder.auth.invalidate(); holder.auth = (${createBrowserIdentity.toString()})(${JSON.stringify(config.dot.expectedEmail)}); holder.epoch = epoch;
      }
      const auth = holder.auth;
      ${code}
    })()` }]);
  }
  const loginURL = () => config.dot.url || 'https://chatgpt.com/dots';
  function loadLoginPage() {
    pageFailed = false;
    pageReady = loginWindow.loadURL(loginURL()).catch(() => { pageFailed = true; throw failure('login_connection_failed'); });
    return pageReady;
  }
  function openLogin(show = true) {
    if (demo) return Promise.resolve();
    if (show) identityEpoch++;
    if (loginWindow && !loginWindow.isDestroyed()) {
      if (show) { loginWindow.show(); loginWindow.focus(); }
      return pageFailed ? loadLoginPage() : pageReady;
    }
    loginWindow = new BrowserWindow({ show, width: 960, height: 760, title: 'DotDial — ChatGPT sign in', webPreferences: {
      partition: 'persist:dotdial', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    } });
    loginWindow.setMenuBarVisibility(false);
    loginWindow.webContents.on('did-start-navigation', (_e, _url, _inPlace, mainFrame) => { if (mainFrame) identityEpoch++; });
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        return { action: u.protocol === 'https:' && ['chatgpt.com', 'auth.openai.com', 'auth0.openai.com', 'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com'].includes(u.hostname) ? 'allow' : 'deny' };
      } catch { return { action: 'deny' }; }
    });
    loginWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('https://')) event.preventDefault(); });
    loginWindow.on('close', e => { if (!shuttingDown) { e.preventDefault(); loginWindow.hide(); } });
    return loadLoginPage();
  }
  async function waitForWebPage() {
    await openLogin(false);
    for (let i = 0; i < 160 && /Just a moment/i.test(loginWindow.webContents.getTitle()); i++) await new Promise(r => setTimeout(r, 250));
    if (/Just a moment/i.test(loginWindow.webContents.getTitle())) throw failure('web_verification_required');
  }
  const webRecovery = createWebRecovery(async () => {
    webVerifying = true; publish();
    try {
      await openLogin(false);
      await loadLoginPage();
      await waitForWebPage();
    } finally { webVerifying = false; publish(); }
  });
  function requireWebAction(error) {
    if (['web_verification_required', 'login_required', 'login_refresh_required'].includes(error?.code)) {
      webActionRequired = true;
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.show();
      publish();
    }
    throw error;
  }
  async function readIdentity() {
    await waitForWebPage();
    const result = await inIdentityWorld(`
      try {
        const s = await auth.get();
        // Actual credentials stay inside the isolated, same-origin browser.
        return { identity: { email: s.email, accountId: s.accountId, accessToken: 'browser-managed' } };
      } catch (e) { return { error: /^[a-z_]{1,80}$/.test(e?.code || '') ? e.code : 'login_connection_failed', status: e.status }; }
    `).catch(() => { throw failure('login_connection_failed'); });
    if (result.error) throw Object.assign(failure(result.error), { status: result.status });
    return result.identity;
  }
  async function identity() {
    try {
      const result = await webRecovery.identity(readIdentity);
      webActionRequired = false;
      return result;
    } catch (error) { return requireWebAction(error); }
  }
  async function fetchOpenAI(url, init = {}) {
    const target = new URL(url);
    if (target.origin !== 'https://chatgpt.com' || !target.pathname.startsWith('/backend-api/tbo/')) throw failure('unexpected_origin');
    const q = { path: target.pathname, method: init.method, body: init.body, accountId: init.headers['ChatGPT-Account-ID'] };
    const send = async () => {
      const r = await inIdentityWorld(`
      const q = ${JSON.stringify(q)};
      const s = await auth.get();
      if (s.accountId !== q.accountId) throw Error('account_mismatch');
      const headers = { Authorization: 'Bearer ' + s.accessToken, 'ChatGPT-Account-ID': q.accountId, Accept: 'application/json, application/sdp, text/plain' };
      if (q.body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(q.path, { method: q.method, headers, body: q.body, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(20000) });
      return { status: r.status, body: await r.text(), headers: Object.fromEntries(['location','content-type','cf-mitigated'].map(k => [k,r.headers.get(k)]).filter(x => x[1] !== null)) };
    `);
      return new Response([204, 205, 304].includes(r.status) ? null : r.body, { status: r.status, headers: r.headers });
    };
    try {
      const response = await webRecovery.request(send, () =>
        !target.pathname.endsWith('/voice/calls') || (!shuttingDown && !controller?.cancelled));
      if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') {
        webActionRequired = true;
        loginWindow?.show(); publish();
      } else if (response.ok) webActionRequired = false;
      return response;
    } catch (error) { return requireWebAction(error); }
  }
  async function saveSettings(value, expectedHash) {
    // A later Save is a new intent even when it writes identical JSON and
    // therefore has the same content hash as the pending permission request.
    const ticket = ++settingsSaveEpoch;
    value = validateConfig(value);
    const previous = loadConfigSnapshot(paths.configFile);
    if (busy() && (JSON.stringify(previous.config.dot) !== JSON.stringify(value.dot) || JSON.stringify(previous.config.network) !== JSON.stringify(value.network))) {
      throw Object.assign(failure('call_in_progress'), { message: 'Finish the current call before changing its account or network route.' });
    }
    if (!demo && value.general.startAtLogin && (!previous.config.general.startAtLogin || customMacLaunch(value) !== customMacLaunch(previous.config))) {
      loginItem.validate({ enabled: true, customLaunch: customMacLaunch(value) });
    }
    if (!demo && process.platform === 'darwin' && value.wakeWord.enabled && !previous.config.wakeWord.enabled) {
      const granted = await microphonePermission.requireAccess({ prompt: true, isCurrent: () => ticket === settingsSaveEpoch && !shuttingDown });
      if (ticket !== settingsSaveEpoch) throw failure('settings_save_superseded');
      if (!granted || shuttingDown) throw failure('operation_cancelled');
    }
    const result = saveConfig(paths.configFile, value, { expectedHash });
    await applyDiskConfig();
    return result;
  }
  function stopSoundPreview() {
    if (soundPreview) { soundPreview = false; previewGeneration++; sounds?.silence(); }
    return { status: 'preview_stopped' };
  }
  async function previewSound(overrides) {
    if (busy() || state().state !== 'ready' || mailbox?.playing) throw Object.assign(failure('call_in_progress'), { message: 'Finish the call or replay before previewing a sound.' });
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).some(key => !['connectionSound', 'customSoundPath', 'soundVolume'].includes(key))) {
      throw Object.assign(failure('sound_file_invalid'), { message: 'Choose a connection sound first.' });
    }
    const audio = validateConfig({ ...config, audio: { ...config.audio, ...overrides } }).audio;
    stopSoundPreview();
    const generation = ++previewGeneration; soundPreview = true;
    try {
      await sounds.play('preview', audio);
      return { status: generation === previewGeneration ? 'preview_finished' : 'preview_stopped' };
    } finally { if (generation === previewGeneration) soundPreview = false; }
  }
  async function applyDiskConfig() {
    if (shuttingDown) return;
    if (applyingConfig) { configReloadRequested = true; return; }
    let next;
    try { next = loadConfigSnapshot(paths.configFile); }
    catch (e) { configPending = false; configError = safeCode(e); publish(); return; }
    configError = null; applyingConfig = true;
    try {
      const update = selectLiveConfig(config, next.config, busy() || mailbox?.playing);
      configPending = update.pending;
      // Publish the saved revision even if call-sensitive settings are pending.
      // A duplicate file-watch event must not invent pending changes.
      snapshot = next;
      wakeManager?.configure(update.config.wakeWord, { inputDeviceId: update.config.audio.microphoneDeviceId });
      if (busy() || mailbox?.playing) {
        config = update.config;
        publish();
        return;
      }
      const old = config; config = next.config; snapshot = next;
      if (mailbox) mailbox.limitBytes = config.recording.maxMegabytes * 1024 * 1024;
      if (JSON.stringify(old.audio) !== JSON.stringify(config.audio)) {
        stopSoundPreview();
        sounds?.configure(config.audio);
      }
      if (config.audio.connectionSound === 'custom') void customSounds?.prepare(config.audio.customSoundPath).catch(() => {});
      if (webSession && old.network.signalingProxy !== config.network.signalingProxy) {
        await webSession.setProxy(config.network.signalingProxy ? { proxyRules: config.network.signalingProxy } : { mode: 'direct' });
        await webSession.closeAllConnections();
      }
      if (old.dot.url !== config.dot.url || old.dot.expectedEmail !== config.dot.expectedEmail) {
        identityEpoch++;
        if (loginWindow && !loginWindow.isDestroyed()) void loadLoginPage().catch(() => {});
      }
      if (app.isReady()) {
        globalShortcut.unregisterAll();
        hotkeyAvailable = !config.general.hotkey || globalShortcut.register(config.general.hotkey, () => { void command(busy() ? 'STOP' : 'WAKE').catch(() => desktop?.openSettings()); });
        if (!demo) configureAutostart();
      }
      wakeManager?.configure(config.wakeWord, { inputDeviceId: config.audio.microphoneDeviceId });
      desktop?.update(state());
    } finally {
      applyingConfig = false;
      if (configReloadRequested) {
        configReloadRequested = false;
        void applyDiskConfig().catch(error => { configError = safeCode(error); publish(); });
      }
    }
  }
  function configureAutostart() {
    if (process.platform === 'darwin') {
      loginItem.configure({ enabled: config.general.startAtLogin, customLaunch: customMacLaunch(config) });
      return;
    }
    const autostart = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'dotdial.desktop');
    if (!config.general.startAtLogin) { if (fs.existsSync(autostart)) fs.unlinkSync(autostart); return; }
    fs.mkdirSync(path.dirname(autostart), { recursive: true, mode: 0o700 });
    const quote = v => '"' + v.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%') + '"';
    const executable = app.isPackaged ? process.execPath : path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron');
    const args = [...config.network.signalingLauncher, executable, ...(app.isPackaged ? [] : [path.join(__dirname, 'main.cjs')]), `--config=${paths.configFile}`];
    fs.writeFileSync(autostart, `[Desktop Entry]\nType=Application\nName=DotDial\nComment=Call your dot\nExec=${args.map(quote).join(' ')}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o600 });
  }
  async function getAudioDevices() {
    if (demo) return { inputs: [{ id: 'default', label: 'System microphone' }], outputs: [{ id: 'default', label: 'System speakers' }] };
    // Invoked by the explicit Scan devices button. TCC grants label access;
    // enumeration below still never calls getUserMedia or opens a stream.
    if (process.platform === 'darwin' && !await microphonePermission.requireAccess({ prompt: true, isCurrent: () => !shuttingDown })) return { inputs: [], outputs: [] };
    const w = new BrowserWindow({ show: false, webPreferences: { partition: 'dotdial-devices', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const s = session.fromPartition('dotdial-devices');
    s.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    // Expose device labels to our local enumeration page without opening a stream.
    s.setPermissionCheckHandler((wc, permission, _origin, details) => wc === w.webContents && permission === 'media' && details.mediaType === 'audio');
    try {
      await w.loadFile(path.join(__dirname, 'media.html'));
      const list = await w.webContents.executeJavaScript('DotDialDevices.list()');
      return { inputs: [{ id: 'default', label: 'System microphone' }, ...list.filter(d => d.kind === 'audioinput')], outputs: [{ id: 'default', label: 'System speakers' }, ...list.filter(d => d.kind === 'audiooutput')] };
    } finally { w.destroy(); }
  }
  async function requireCommandMicrophone(prompt, isCurrent) {
    try { return await microphonePermission.requireAccess({ prompt, isCurrent }); }
    catch (error) {
      if (!prompt && error.code === 'microphone_permission_required' && !shuttingDown) {
        // The CLI's socket has a short response deadline. Show native consent,
        // return immediately, and require a fresh command after permission.
        desktop?.openSettings();
        void microphonePermission.requireAccess({ prompt: true, isCurrent: () => !shuttingDown }).catch(() => {});
      }
      throw error;
    }
  }
  async function command(name, { promptMicrophone = true } = {}) {
    if (name === 'QUIT') { app.quit(); return { status: 'quitting' }; }
    if (name === 'STATUS') return state();
    if (name === 'SETTINGS') { desktop.openSettings(); return { status: 'settings_opened' }; }
    if (demo) {
      if (name === 'WAKE') { stopSoundPreview(); clearTimeout(demoCallTimer); publish({ ...lastState, state: 'starting' }); demoCallTimer = setTimeout(() => publish({ ...lastState, state: 'active', local_listening: true, microphone_muted: false }), 600); }
      if (name === 'STOP') { clearTimeout(demoCallTimer); publish({ state: 'ready', local_listening: false, missed_count: 0 }); }
      if (name === 'MUTE' || name === 'UNMUTE') publish({ ...lastState, microphone_muted: name === 'MUTE', local_listening: name === 'UNMUTE' });
      if (name.startsWith('SPEAKERS_')) publish({ ...lastState, speakers_muted: name === 'SPEAKERS_MUTE' });
      return { status: 'preview' };
    }
    if (name === 'LOGIN') {
      await openLogin(true);
      if (webActionRequired) await loadLoginPage();
      return { status: 'login_opened' };
    }
    if (name === 'WAKE_SETUP') {
      if (process.platform === 'darwin' && !await requireCommandMicrophone(promptMicrophone, () => !shuttingDown)) return { status: 'cancelled' };
      return wakeManager.install();
    }
    if (name === 'WAKE') {
      if (!config.dot.url) { desktop.openSettings(); return { status: 'dot_not_configured' }; }
      if (controller.state === 'active' && !callPreparing) {
        if (process.platform !== 'darwin' || controller.capture) return audioControls.activate(() => sounds.play('activated'));
        const peer = controller.peer, intent = ++microphoneIntent;
        const current = () => intent === microphoneIntent && controller.peer === peer && controller.state === 'active' && !controller.cancelled && !shuttingDown;
        if (!controller.capture && !await requireCommandMicrophone(promptMicrophone, current)) return { status: 'cancelled' };
        if (!current()) return { status: 'cancelled' };
        return audioControls.activate(() => sounds.play('activated'));
      }
      if (callPreparing || ['starting', 'stopping'].includes(controller.state)) return { status: state().state };
      stopSoundPreview();
      const ticket = ++wakeEpoch, intent = ++microphoneIntent; callPreparing = true; publish();
      try {
        const current = () => ticket === wakeEpoch && (process.platform !== 'darwin' || intent === microphoneIntent) && !shuttingDown;
        if (process.platform === 'darwin' && !config.audio.microphoneInitiallyMuted && !await requireCommandMicrophone(promptMicrophone, current)) return { status: 'cancelled' };
        if (!current()) return { status: 'cancelled' };
        if (mailbox.playing) await mailbox.stop();
        if (!current()) return { status: 'cancelled' };
        mailbox.setMuted(config.audio.speakersInitiallyMuted);
        return controller.wake({ microphone: !config.audio.microphoneInitiallyMuted, maxSeconds: config.call.maxMinutes * 60 });
      } finally { if (ticket === wakeEpoch) callPreparing = false; publish(); }
    }
    if (name === 'STOP') { wakeEpoch++; microphoneIntent++; callPreparing = false; audioControls.cancelActivation(); await mailbox.stop(); void controller.stop(); return { status: 'accepted_stop' }; }
    if (name === 'MUTE') { microphoneIntent++; return audioControls.microphone(false); }
    if (name === 'UNMUTE') {
      if (process.platform !== 'darwin' || controller.state !== 'active' || controller.capture || mailbox.playing) return audioControls.microphone(true);
      const peer = controller.peer, intent = ++microphoneIntent;
      const current = () => intent === microphoneIntent && controller.peer === peer && controller.state === 'active' && !controller.cancelled && !shuttingDown;
      if (!await requireCommandMicrophone(promptMicrophone, current)) return { status: 'cancelled' };
      if (!current()) return { status: 'cancelled' };
      return audioControls.microphone(true);
    }
    if (name === 'SPEAKERS_MUTE' || name === 'SPEAKERS_UNMUTE') { microphoneIntent++; return audioControls.speakers(name === 'SPEAKERS_MUTE'); }
    if (name === 'MISSED_PLAY') { microphoneIntent++; stopSoundPreview(); return audioControls.play(); }
    if (name === 'MISSED_STOP') { await mailbox.stop(); return { status: 'playback_stopped' }; }
    if (name === 'MISSED_CLEAR') { await mailbox.clear(); return { status: 'missed_cleared' }; }
    if (name === 'RECOVER') return controller.recover();
    return { status: 'unknown_command' };
  }
  try {
    await app.whenReady();
    const { createDesktop } = require('./desktop.cjs');
    const { CallSounds } = await loadModule('call_sounds.mjs');
    const { CustomSoundCache } = require('./custom_sound.cjs');
    customSounds = new CustomSoundCache({ BrowserWindow, session, runtimeDir: paths.runtimeDir });
    sounds = new CallSounds({ ...config.audio, resolveCustomSound: file => customSounds.prepare(file) });
    desktop = createDesktop({ getSnapshot: state, getConfig: () => loadConfigSnapshot(paths.configFile), saveConfig: saveSettings, command, paths, getAudioDevices, previewSound, stopSoundPreview });
    installMacApplicationMenu({ app, Menu, openSettings: () => desktop?.openSettings(), isQuitting: () => shuttingDown, onActivate: () => {
      loginItem.refresh(); desktop?.update(state());
      if (!demo && microphonePermission.status() === 'granted') wakeManager?.start();
    } });
    if (!demo) {
      webSession = session.fromPartition('persist:dotdial');
      webSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      webSession.setPermissionCheckHandler(() => false);
      await webSession.setProxy(config.network.signalingProxy ? { proxyRules: config.network.signalingProxy } : { mode: 'direct' });
      const [{ DotVoiceSession }, { routedChromiumMedia }, { MissedAudio }, { MissedPlayer }, { CallController }, { CallAudioControls }] = await Promise.all([
        loadModule('dot_voice.mjs'), loadModule('media_worker_peer.mjs'), loadModule('missed_audio.mjs'), loadModule('missed_player.mjs'), loadModule('call_controller.mjs'), loadModule('call_audio_controls.mjs'),
      ]);
      missedPlayer = new MissedPlayer({ BrowserWindow, session, getOutputDevice: () => config.audio.outputDeviceId });
      mailbox = new MissedAudio({ directory: paths.recordingsDir, player: missedPlayer, limitBytes: config.recording.maxMegabytes * 1024 * 1024, onChange: () => publish() });
      const makeSession = () => {
        const j = readJournal();
        currentThreadId = (j?.phase !== 'closed' && j?.callId && j?.threadId) || config.dot.url.split('/').at(-1);
        return new DotVoiceSession({ identity, fetchImpl: fetchOpenAI, threadId: currentThreadId, expectedEmail: config.dot.expectedEmail });
      };
      const native = { LiveWebRtcPeer: class {
        constructor(...args) {
          const Peer = routedChromiumMedia({ archive: mailbox, getSpeakersMuted: () => mailbox.desiredMuted || mailbox.playing,
            launcher: config.network.mediaLauncher, runtimeDir: paths.runtimeDir, packaged: app.isPackaged,
            mediaOptions: { ...config.audio, recordingEnabled: config.recording.enabled } });
          return new Peer(...args);
        }
      } };
      controller = new CallController({ makeSession, native, readJournal,
        writeJournal: value => writeJson(journalFile, { ...value, ...(value.phase !== 'closed' ? { threadId: currentThreadId } : {}) }),
        cue: which => sounds.play(which), publish,
      });
      audioControls = new CallAudioControls({ mailbox, controller });
      const { WakeManager } = require('./wake-manager.cjs');
      const { createWakeCaptureFactory } = require('./wake_capture.cjs');
      wakeManager = new WakeManager({ paths,
        captureFactory: process.platform === 'darwin' ? createWakeCaptureFactory({ BrowserWindow, session, ipcMain, getMicrophoneDeviceId: () => config.audio.microphoneDeviceId }) : undefined,
        requestMicrophoneAccess: () => microphonePermission.requireAccess(),
        onWake: () => { void command('WAKE', { promptMicrophone: false }).catch(() => {}); }, onChange: () => desktop?.update(state()) });
      await controller.recover();
      if (config.dot.url) void openLogin(false).catch(() => {});
    }
    await applyDiskConfig();
    if (fs.existsSync(paths.socketPath)) {
      const live = await new Promise(resolve => { const c = net.connect(paths.socketPath); c.once('connect', () => { c.destroy(); resolve(true); }); c.once('error', () => resolve(false)); });
      if (live) throw failure('controller_socket_in_use');
      fs.unlinkSync(paths.socketPath);
    }
    server = net.createServer(client => attachClient(client, cmd => command(cmd, { promptMicrophone: false }).catch(e => ({ status: 'error', code: safeCode(e) }))));
    server.listen(paths.socketPath, () => fs.chmodSync(paths.socketPath, 0o600));
    fs.watchFile(paths.configFile, { interval: 800 }, () => { void applyDiskConfig().catch(e => { configError = safeCode(e); publish(); }); });
    publish();
    if (demo || !config.dot.url || process.argv.includes('--settings')) desktop.openSettings();
  } catch (error) {
    console.error('DOTDIAL_STARTUP_FAILED ' + safeCode(error));
    dialog.showErrorBox('DotDial could not start', `${safeCode(error)}. Run dotdial doctor for local setup checks.`);
    app.exit(2); return;
  }
  app.on('window-all-closed', () => {});
  app.on('second-instance', () => desktop?.openSettings());
  installQuitBarrier(app, () => {
    shuttingDown = true;
    void (async () => {
      clearTimeout(demoCallTimer); globalShortcut.unregisterAll(); fs.unwatchFile(paths.configFile); wakeEpoch++; microphoneIntent++;
      await wakeManager?.close();
      const stopped = controller?.stop(); await mailbox?.stop(); await stopped;
      await mailbox?.saveTail; await missedPlayer?.close(); sounds?.silence();
      await customSounds?.close();
      webSession?.flushStorageData(); await webSession?.cookies.flushStore();
      desktop?.dispose();
      server?.close(); try { fs.unlinkSync(paths.socketPath); } catch {}
      app.exit(0);
    })();
  });
  process.once('SIGTERM', () => app.quit());
  process.once('SIGINT', () => app.quit());
  if (demo && process.argv.includes('--smoke-test')) void require('../scripts/smoke-packaged.cjs').run().catch(error => {
    console.error('PACKAGED_SMOKE_FAILED', error.stack || error.message); app.exit(1);
  });
}
