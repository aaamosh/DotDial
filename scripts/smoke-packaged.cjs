'use strict';

// Loaded by the real packaged entrypoint only in --demo --smoke-test mode.
// No account, wake listener, physical microphone, or audible output is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (window, source) => window.webContents.executeJavaScript(source, true);

async function until(predicate, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(75);
  }
  throw Error(message);
}

async function speakerState(peer, muted) {
  let observed;
  try {
    // The RPC schedules the AudioParam; require its actual render-thread value.
    return await until(async () => {
      const stats = await peer.getStats();
      observed = { speakers_muted: stats.speakers_muted, speaker_gain: stats.speaker_gain,
        audio_context_state: stats.audio_context_state };
      return stats.speakers_muted === muted && stats.speaker_gain === (muted ? 0 : 1) ? stats : null;
    }, 'speaker_gain_did_not_settle', 5000);
  } catch (error) {
    error.message += ' ' + JSON.stringify({ expected_muted: muted, observed });
    throw error;
  }
}

function windowVisibility(window) {
  if (window.isDestroyed()) return { destroyed: true };
  return { destroyed: false, visible: window.isVisible(), minimized: window.isMinimized(),
    focused: window.isFocused(), bounds: window.getBounds() };
}

async function readinessSnapshot(window, timeoutMs = 500) {
  const snapshot = { window: windowVisibility(window) };
  if (snapshot.window.destroyed || window.webContents.isDestroyed()) return snapshot;
  let timer;
  try {
    snapshot.document = await Promise.race([evaluate(window, `(() => {
    const section = document.querySelector('.settings-section.active');
    const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const animations = section?.getAnimations() || [];
    return { readyState: document.readyState, visibilityState: document.visibilityState,
      fontsStatus: document.fonts?.status || null, timelineTime: finite(document.timeline?.currentTime),
      section: section ? { rectCount: section.getClientRects().length,
        opacity: getComputedStyle(section).opacity } : null,
      animationCount: animations.length, animations: animations.slice(0, 8).map(animation => ({
        name: String(animation.animationName || '').slice(0, 80), playState: String(animation.playState).slice(0, 24),
        pending: animation.pending === true, currentTime: finite(animation.currentTime), startTime: finite(animation.startTime),
      })) };
  })()`), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('renderer_readiness_query_timeout')), timeoutMs);
    })]);
  } catch (error) {
    snapshot.rendererError = String(error.message || error).slice(0, 160);
  } finally { clearTimeout(timer); }
  return snapshot;
}

async function waitForSettingsVisible(window, timeoutMs = 5000) {
  try {
    return await until(() => {
      const observed = windowVisibility(window);
      return !observed.destroyed && observed.visible && !observed.minimized ? observed : null;
    }, 'packaged_settings_not_visible', timeoutMs);
  } catch (error) {
    error.captureReadiness = { stage: 'initial_settings_visibility', observed: await readinessSnapshot(window) };
    throw error;
  }
}

async function capture(window, outputDirectory, filename, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let observed;
  try {
    await until(async () => {
      observed = await readinessSnapshot(window, Math.max(1, Math.min(500, deadline - Date.now())));
      const document = observed.document;
      return document && document.fontsStatus !== 'loading' &&
        (!document.section || document.section.rectCount === 0 || Number(document.section.opacity) >= 0.99);
    }, 'packaged_capture_layout_not_ready', timeoutMs);
  } catch (error) {
    error.captureReadiness = { stage: 'capture', filename, observed };
    throw error;
  }
  const image = await window.webContents.capturePage();
  assert.equal(image.isEmpty(), false, 'packaged window must produce pixels');
  const size = image.getSize();
  const png = image.toPNG();
  assert.ok(size.width > 0 && size.height > 0 && png.length > 512, 'packaged window capture must contain content');
  if (outputDirectory) {
    const temporary = path.join(outputDirectory, `.${filename}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, png, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, path.join(outputDirectory, filename));
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return { width: size.width, height: size.height, png_bytes: png.length, readiness: observed,
    sha256: crypto.createHash('sha256').update(png).digest('hex') };
}

async function runLocalMedia({ app, BrowserWindow, session, ipcMain }) {
  const { chromiumMedia } = await import(pathToFileURL(path.join(app.getAppPath(), 'src', 'chromium_media.mjs')).href);
  const failures = [];
  const Peer = chromiumMedia({ BrowserWindow, session, ipcMain,
    mediaOptions: { bufferMs: 0, recordingEnabled: false } });
  const peer = new Peer(() => {}, () => {}, () => failures.push('media_failure'));
  let result;
  try {
    await peer.ready;
    // Observe real browser objects; delegate every operation to Chromium.
    await evaluate(peer.window, `(() => {
      window.__smokeNativePeer = RTCPeerConnection;
      window.RTCPeerConnection = class extends window.__smokeNativePeer {
        constructor(options) { super(options); window.__smokeClient = this; }
      };
      window.__smokeCapturedTracks = [];
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await getUserMedia(constraints);
        window.__smokeCapturedTracks.push(...stream.getTracks());
        return stream;
      };
    })()`);
    await peer.setSpeakersMuted(true);
    const offer = await peer.createOffer();
    assert.match(offer, /m=audio\s/, 'bundled renderer creates an audio offer');
    assert.deepEqual(await evaluate(peer.window, 'window.__smokeClient.getConfiguration().iceServers'), [],
      'local smoke must not use STUN or TURN servers');
    const answer = await evaluate(peer.window, `(async () => {
      const remote = window.__smokeRemote = new window.__smokeNativePeer({ iceServers: [] });
      const context = window.__smokeToneContext = new AudioContext({ sampleRate: 48000 });
      const destination = window.__smokeToneDestination = context.createMediaStreamDestination();
      const oscillator = window.__smokeTone = context.createOscillator();
      const gain = context.createGain(); gain.gain.value = 0.1;
      oscillator.frequency.value = 440;
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      await context.resume();
      remote.ondatachannel = event => {
        window.__smokeRemoteChannel = event.channel;
        const send = () => event.channel.send(JSON.stringify({ type: 'session.created' }));
        if (event.channel.readyState === 'open') send();
        else event.channel.addEventListener('open', send, { once: true });
      };
      await remote.setRemoteDescription({ type: 'offer', sdp: ${JSON.stringify(offer)} });
      const transceiver = remote.getTransceivers()[0];
      transceiver.direction = 'sendrecv';
      await transceiver.sender.replaceTrack(destination.stream.getAudioTracks()[0]);
      await remote.setLocalDescription(await remote.createAnswer());
      const deadline = performance.now() + 8000;
      while (remote.iceGatheringState !== 'complete') {
        if (performance.now() > deadline) throw Error('smoke_remote_ice_timeout');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return remote.localDescription.sdp;
    })()`);
    await peer.acceptAnswer(answer);
    await peer.waitForOpen(10_000);
    const connected = await until(async () => {
      const stats = await peer.getStats();
      return stats.packetsReceived > 5 && stats.packetsSent > 5 && stats.playback_started &&
        stats.event_types?.['session.created'] === 1 ? stats : null;
    }, 'local_audio_or_data_channel_did_not_flow');
    assert.equal(connected.connection_state, 'connected');
    assert.equal(connected.playback_error, false);
    assert.equal(connected.microphone_active, false, 'offer/answer must not open the microphone');
    assert.equal(connected.speakers_muted, true);
    assert.equal(connected.speaker_gain, 0);

    await peer.startMicrophone();
    const captured = await until(async () => {
      const stats = await peer.getStats();
      return stats.microphone_active && stats.packetsSent > connected.packetsSent ? stats : null;
    }, 'fake_microphone_did_not_start');
    assert.equal(await evaluate(peer.window,
      'window.__smokeCapturedTracks.length === 1 && window.__smokeCapturedTracks.every(t => t.kind === "audio" && t.readyState === "live")'), true);
    await peer.stopMicrophone();
    const stopped = await peer.getStats();
    assert.equal(stopped.microphone_active, false);
    assert.equal(await evaluate(peer.window, 'window.__smokeCapturedTracks.every(t => t.readyState === "ended")'), true,
      'mute must stop the actual fake capture track');

    // --mute-audio silences the runtime while we exercise the actual gain gate.
    await peer.setSpeakersMuted(false);
    const unmuted = await speakerState(peer, false);
    assert.equal(unmuted.speakers_muted, false);
    assert.equal(unmuted.speaker_gain, 1);
    await peer.setSpeakersMuted(true);
    const muted = await speakerState(peer, true);
    assert.equal(muted.speakers_muted, true);
    assert.equal(muted.speaker_gain, 0);
    assert.deepEqual(failures, []);
    result = { engine: connected.engine, connection_state: connected.connection_state,
      packets_received: captured.packetsReceived, packets_sent: captured.packetsSent,
      data_channel_event_received: true, playback_graph_started: true, speaker_gain_toggle: true,
      fake_microphone_started: true, fake_microphone_tracks_ended: true, ice_servers: 0 };
  } finally {
    if (!peer.window.isDestroyed()) {
      await evaluate(peer.window, `(async () => {
        try { window.__smokeTone?.stop(); } catch {}
        window.__smokeToneDestination?.stream.getTracks().forEach(track => track.stop());
        window.__smokeRemoteChannel?.close(); window.__smokeRemote?.close();
        if (window.__smokeToneContext && window.__smokeToneContext.state !== 'closed') await window.__smokeToneContext.close();
      })()`).catch(() => {});
    }
    await peer.close();
  }
  assert.equal(peer.window.isDestroyed(), true, 'local media window must be destroyed');
  return { ...result, media_window_destroyed: true };
}

async function runWakeCapture({ app, BrowserWindow, session, ipcMain }) {
  const { createWakeCaptureFactory, MAX_CHUNK_BYTES } = require(path.join(app.getAppPath(), 'src', 'wake_capture.cjs'));
  assert.equal(MAX_CHUNK_BYTES, 6400);
  const createCapture = createWakeCaptureFactory({ BrowserWindow, session, ipcMain,
    getMicrophoneDeviceId: () => 'default' });
  const errors = [], rendererErrors = [];
  let packets = 0, bytes = 0, peak = 0, callbacksAfterClose = 0, closing = false;
  const wake = createCapture({
    onAudio: async buffer => {
      if (closing) callbacksAfterClose++;
      assert.ok(Buffer.isBuffer(buffer), 'wake capture must deliver a real PCM Buffer');
      assert.equal(buffer.length, 6400, 'worklet must deliver 100 ms of mono float32 PCM at 16 kHz');
      for (let offset = 0; offset < buffer.length; offset += 4) {
        const sample = buffer.readFloatLE(offset);
        assert.ok(Number.isFinite(sample) && Math.abs(sample) <= 1, 'wake PCM must contain finite normalized float32 samples');
        peak = Math.max(peak, Math.abs(sample));
      }
      packets++; bytes += buffer.length;
    },
    onError: code => errors.push(code),
  });
  wake.window.webContents.on('console-message', (_event, details) => {
    if (details?.level === 'error' && rendererErrors.length < 4) rendererErrors.push(String(details.message).slice(0, 300));
  });
  try {
    await wake.ready;
    await until(() => {
      assert.deepEqual(errors, [], 'packaged wake capture must remain healthy');
      return packets >= 3;
    }, 'packaged_wake_worklet_pcm_missing', 8000);
    // createWakeCaptureFactory validates the actual IPC sampleRate === 16000
    // before calling onAudio. These packets exercise the shipped CSP, preload,
    // AudioWorklet module and microphone graph without replacing any of them.
    closing = true;
    await wake.close();
    assert.equal(wake.closed, true);
    assert.equal(wake.window.isDestroyed(), true, 'wake capture must destroy its owned window');
    const finalPackets = packets;
    await sleep(350);
    assert.equal(packets, finalPackets, 'wake PCM callbacks must stop after close');
    assert.equal(callbacksAfterClose, 0);
    assert.deepEqual(errors, []);
    return { result: 'passed', sample_rate: 16000, channels: 1, format: 'float32le',
      chunk_bytes: 6400, packets, pcm_bytes: bytes, pcm_samples: bytes / 4, peak_absolute: peak,
      worklet_pcm_received: true, capture_window_destroyed: true, callbacks_after_close: callbacksAfterClose,
      post_close_observation_ms: 350, physical_microphone_tested: false };
  } catch (error) {
    console.error('DOTDIAL_WAKE_CAPTURE_SMOKE ' + JSON.stringify({ result: 'failed', errors, renderer_errors: rendererErrors }));
    throw error;
  } finally {
    closing = true;
    await wake.close();
  }
}

async function run() {
  const electron = require('electron');
  const { app, BrowserWindow } = electron;
  for (const flag of ['--demo', '--smoke-test', '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream', '--mute-audio']) {
    assert.ok(process.argv.includes(flag), `packaged smoke requires ${flag}`);
  }
  assert.equal(app.isPackaged, true, 'run the built application, not a source-only Electron fixture');
  assert.equal(process.argv.includes('--media-worker'), false);
  let outputDirectory;
  if (process.env.DOTDIAL_SMOKE_OUTPUT_DIR) {
    const requested = process.env.DOTDIAL_SMOKE_OUTPUT_DIR;
    assert.ok(path.isAbsolute(requested) && path.resolve(requested) !== path.parse(requested).root,
      'smoke output directory must be an absolute non-root path');
    fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(requested);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'smoke output must be a real directory');
    if (typeof process.getuid === 'function') assert.equal(stat.uid, process.getuid());
    outputDirectory = fs.realpathSync(requested);
    fs.chmodSync(outputDirectory, 0o700);
  }
  const started = Date.now();
  let phase = 'settings';
  const watchdog = setTimeout(() => {
    console.error('DOTDIAL_PACKAGED_SMOKE ' + JSON.stringify({ result: 'failed', phase, error: 'smoke_timeout' }));
    app.exit(1);
  }, 90_000);
  try {
    await app.whenReady();
    const settings = await until(() => BrowserWindow.getAllWindows().find(window =>
      window.webContents.getURL().includes('view=settings')), 'packaged_settings_missing');
    // DOM/preload readiness can precede the first paint. The real app starts
    // this window hidden and shows it on ready-to-show; do not drive save/reload
    // until that normal initial-show lifecycle has completed.
    const initialSettingsVisibility = await waitForSettingsVisible(settings);
    await until(() => evaluate(settings,
      '!!window.dotdial && !!document.querySelector("#dot-display-name")?.value'), 'packaged_settings_not_ready');
    const original = await evaluate(settings, 'window.dotdial.readConfig()');
    const demoRoot = fs.realpathSync(path.dirname(original.path));
    assert.equal(path.dirname(demoRoot), fs.realpathSync(os.tmpdir()), 'smoke may write only its isolated demo config');
    assert.match(path.basename(demoRoot), /^dotdial-preview-/);
    assert.ok(fs.realpathSync(app.getPath('userData')).startsWith(demoRoot + path.sep));
    assert.equal(original.config.dot.url, '', 'demo must not use an account');
    assert.equal(original.config.wakeWord.enabled, false, 'demo must not start a wake listener');
    const statusPath = path.join(demoRoot, 'state', 'status.json');
    const readStatus = () => JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(readStatus().demo, true);

    await evaluate(settings, `(() => {
      const input = document.querySelector('#dot-display-name');
      input.value = 'Packaged smoke'; input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#top-save').click();
    })()`);
    await until(() => JSON.parse(fs.readFileSync(original.path, 'utf8')).dot.displayName === 'Packaged smoke',
      'packaged_settings_save_failed');
    const saved = await evaluate(settings, 'window.dotdial.readConfig()');
    assert.notEqual(saved.hash, original.hash);
    assert.equal(saved.config.dot.displayName, 'Packaged smoke');
    const reloaded = new Promise(resolve => settings.webContents.once('did-finish-load', resolve));
    settings.webContents.reload();
    await reloaded;
    await until(() => evaluate(settings, 'document.querySelector("#dot-display-name")?.value === "Packaged smoke"'),
      'packaged_settings_did_not_survive_reload');
    assert.deepEqual((await evaluate(settings, 'window.dotdial.readConfig()')).config, saved.config);
    const settingsCapture = await capture(settings, outputDirectory, 'settings.png');

    phase = 'panel';
    await evaluate(settings, `(() => {
      window.__smokeState = null;
      window.__smokeUnsubscribe = window.dotdial.onState(value => { window.__smokeState = value; });
    })()`);
    assert.equal((await evaluate(settings, 'window.dotdial.command("WAKE")')).status, 'preview');
    const panel = await until(() => BrowserWindow.getAllWindows().find(window =>
      window.webContents.getURL().includes('view=panel')), 'packaged_panel_missing');
    await until(() => evaluate(panel, '!!window.dotdial && document.querySelector("#panel-mic")?.disabled === false'),
      'packaged_demo_call_not_active');
    assert.equal(panel.isVisible(), true);
    await until(() => evaluate(settings, 'window.__smokeState?.state === "active"'), 'active_state_not_received_by_preload');
    assert.equal(readStatus().state, 'active');

    for (const [selector, field, value] of [
      ['#panel-mic', 'microphone_muted', true], ['#panel-speakers', 'speakers_muted', true],
      ['#panel-mic', 'microphone_muted', false], ['#panel-speakers', 'speakers_muted', false],
    ]) {
      await evaluate(panel, `document.querySelector(${JSON.stringify(selector)}).click()`);
      await until(() => evaluate(settings, `window.__smokeState?.[${JSON.stringify(field)}] === ${value}`),
        `packaged_${field}_${value}_not_delivered`);
      assert.equal(readStatus()[field], value);
      await until(() => evaluate(panel,
        `document.querySelector(${JSON.stringify(selector)}).classList.contains('muted') === ${value}`),
        `packaged_${field}_${value}_not_rendered`);
    }
    const panelCapture = await capture(panel, outputDirectory, 'panel.png');
    await evaluate(panel, 'document.querySelector("#panel-hangup").click()');
    await until(() => !panel.isVisible() && readStatus().state === 'ready', 'packaged_hangup_did_not_hide_panel');
    assert.equal(readStatus().local_listening, false);
    await evaluate(settings, 'window.__smokeUnsubscribe()');

    phase = 'synthetic_media';
    const media = await runLocalMedia(electron);
    phase = 'wake_capture';
    const wakeCapture = process.platform === 'darwin' ? await runWakeCapture(electron) :
      { result: 'skipped', reason: 'macos_capture_path', physical_microphone_tested: false };
    assert.equal(BrowserWindow.getAllWindows().some(window => /^https?:/.test(window.webContents.getURL())), false,
      'demo smoke must not open account or other network pages');
    phase = 'quit';
    fs.writeSync(1, JSON.stringify({ packagedSmoke: 'passed', result: 'passed', platform: process.platform,
      arch: process.arch, version: app.getVersion(), electron: process.versions.electron,
      chromium: process.versions.chrome, packaged: app.isPackaged, elapsed_ms: Date.now() - started,
      software_rendering_requested: process.argv.includes('--disable-gpu'),
      gui: { settings_preload: true, initial_settings_visibility: initialSettingsVisibility,
        form_save_to_disk: true, settings_reload_persistence: true,
        demo_call_active: true, microphone_toggle: true, speakers_toggle: true, hangup_hides_panel: true,
        settings_capture: settingsCapture, panel_capture: panelCapture },
      media, wake_capture: wakeCapture, physical_microphone_tested: false,
      audible_output_tested: false, account_call_tested: false }) + '\n');
    // Keep the watchdog armed until the real application's quit barrier exits.
    app.quit();
  } catch (error) {
    clearTimeout(watchdog);
    console.error('DOTDIAL_PACKAGED_SMOKE ' + JSON.stringify({ result: 'failed', phase,
      error: String(error?.message || 'smoke_failed').slice(0, 500), captureReadiness: error.captureReadiness }));
    throw error;
  }
}

module.exports = { run, waitForSettingsVisible, capture };
