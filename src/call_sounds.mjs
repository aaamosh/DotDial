import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLAYBACK_TIMEOUT_MS = Object.freeze({ calling: 35_000, preview: 35_000, default: 6_000 });

export const SOUND_FILES = {
  calling: fileURLToPath(new URL('./sounds/calling.wav', import.meta.url)),
  telephone: fileURLToPath(new URL('./sounds/telephone.wav', import.meta.url)),
  connected: fileURLToPath(new URL('./sounds/connected.wav', import.meta.url)),
  activated: fileURLToPath(new URL('./sounds/activated.wav', import.meta.url)),
  ended: fileURLToPath(new URL('./sounds/ended.wav', import.meta.url)),
};

const CONNECTION_SOUNDS = new Set(['modem', 'telephone', 'custom']);

function normalizedVolume(value, fallback = 0.55) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

export class CallSounds {
  constructor(options = {}) {
    this.spawnPlayer = options.spawnPlayer || spawn;
    this.repeatMs = options.repeatMs ?? 1400;
    this.playbackTimeoutMs = options.playbackTimeoutMs || PLAYBACK_TIMEOUT_MS;
    this.resolveCustomSound = options.resolveCustomSound;
    this.connectionSound = CONNECTION_SOUNDS.has(options.connectionSound) ? options.connectionSound : 'modem';
    this.customSoundPath = typeof options.customSoundPath === 'string' ? options.customSoundPath : '';
    this.volume = normalizedVolume(options.soundVolume ?? options.volume);
    this.enabled = options.sounds ?? options.enabled ?? true;
    this.generation = 0;
  }

  configure(audio = {}) {
    if (typeof audio.sounds === 'boolean') this.enabled = audio.sounds;
    else if (typeof audio.enabled === 'boolean') this.enabled = audio.enabled;

    if (audio.soundVolume !== undefined) this.volume = normalizedVolume(audio.soundVolume, this.volume);
    else if (audio.volume !== undefined) this.volume = normalizedVolume(audio.volume, this.volume);

    if (audio.connectionSound !== undefined) {
      this.connectionSound = CONNECTION_SOUNDS.has(audio.connectionSound) ? audio.connectionSound : 'modem';
    }
    if (typeof audio.customSoundPath === 'string') this.customSoundPath = audio.customSoundPath;
    if (typeof audio.resolveCustomSound === 'function') this.resolveCustomSound = audio.resolveCustomSound;
    if (!this.enabled) this.silence();
    return this;
  }

  silence() {
    this.generation++;
    clearTimeout(this.repeat);
    this.repeat = null;
    this.resolverController?.abort();
    this.resolverController = null;
    const child = this.child;
    this.finish?.();
    child?.kill();
    this.child = null;
  }

  async play(name, audioOverrides = {}) {
    this.silence();
    if (!this.enabled && name !== 'preview') return;
    const generation = this.generation;

    if (name === 'calling') {
      const options = this.connectionOptions();
      this.startCalling(options, generation);
      return;
    }
    if (name === 'preview') return this.playPreview(audioOverrides, generation);

    const file = name === 'connected'
      ? (this.connectionSound === 'modem' ? SOUND_FILES.connected : SOUND_FILES.activated)
      : SOUND_FILES[name];
    if (!file) return;
    try { await this.playFile(file, this.volume, generation, 'default'); }
    catch { /* Lifecycle cues are best-effort and never affect call state. */ }
  }

  connectionOptions(overrides = {}) {
    const connectionSound = overrides.connectionSound ?? this.connectionSound;
    return {
      connectionSound: CONNECTION_SOUNDS.has(connectionSound) ? connectionSound : 'modem',
      customSoundPath: typeof overrides.customSoundPath === 'string' ? overrides.customSoundPath : this.customSoundPath,
      volume: normalizedVolume(overrides.soundVolume, this.volume),
    };
  }

  startCalling(options, generation) {
    if (options.connectionSound !== 'custom') {
      const file = options.connectionSound === 'telephone' ? SOUND_FILES.telephone : SOUND_FILES.calling;
      this.startRingLoop(file, options.volume, generation);
      return;
    }

    void this.prepareCustomCall(options, generation);
  }

  async prepareCustomCall(options, generation) {
    let file;
    try {
      file = await this.resolveCustomFile(options.customSoundPath, generation);
    } catch {
      if (generation !== this.generation) return;
      file = SOUND_FILES.telephone;
    }
    if (file && generation === this.generation) {
      this.startRingLoop(file, options.volume, generation, file === SOUND_FILES.telephone ? null : SOUND_FILES.telephone);
    }
  }

  startRingLoop(file, volume, generation, fallbackFile = null) {
    let currentFile = file;
    let fallback = fallbackFile;
    const ring = async () => {
      try { await this.playFile(currentFile, volume, generation, 'calling'); }
      catch {
        if (fallback && generation === this.generation) {
          currentFile = fallback;
          fallback = null;
          void ring();
          return;
        }
      }
      if (generation === this.generation) this.repeat = setTimeout(ring, this.repeatMs);
    };
    void ring();
  }

  async playPreview(overrides, generation) {
    const options = this.connectionOptions(overrides);
    let file;
    if (options.connectionSound === 'modem') file = SOUND_FILES.calling;
    else if (options.connectionSound === 'telephone') file = SOUND_FILES.telephone;
    else file = await this.resolveCustomFile(options.customSoundPath, generation);
    if (file && generation === this.generation) await this.playFile(file, options.volume, generation, 'preview');
  }

  async resolveCustomFile(path, generation) {
    if (typeof this.resolveCustomSound !== 'function') throw new Error('Custom connection sound is unavailable');
    const controller = new AbortController();
    this.resolverController = controller;
    let cancel;
    const cancelled = new Promise(resolve => { cancel = () => resolve({ cancelled: true }); });
    const onAbort = () => cancel();
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.resolveCustomSound(path, { signal: controller.signal }))
          .then(value => ({ value }), error => ({ error })),
        cancelled,
      ]);
      if (result.cancelled || generation !== this.generation) return null;
      if (result.error) throw result.error;
      if (typeof result.value !== 'string' || !result.value) throw new Error('Custom connection sound is unavailable');
      return result.value;
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
      if (this.resolverController === controller) this.resolverController = null;
    }
  }

  playFile(file, volume, generation, timeoutName) {
    return new Promise((resolve, reject) => {
      if (generation !== this.generation || (!this.enabled && timeoutName !== 'preview')) { resolve(); return; }
      let child;
      try {
        child = this.spawnPlayer('/usr/bin/paplay', [`--volume=${Math.round(65536 * volume)}`, file], { stdio: 'ignore' });
      } catch (error) {
        reject(error);
        return;
      }
      this.child = child;
      let finished = false;
      const done = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (this.child === child) { this.child = null; this.finish = null; }
        if (error) reject(error); else resolve();
      };
      this.finish = () => done();
      const timeout = setTimeout(() => { child.kill(); done(); }, this.playbackTimeoutMs[timeoutName] ?? this.playbackTimeoutMs.default);
      child.once('error', done);
      child.once('exit', code => done(code && code !== 0 ? new Error(`Audio player exited with ${code}`) : undefined));
    });
  }
}
