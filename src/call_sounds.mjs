import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SOUND_FILES = {
  calling: fileURLToPath(new URL('./sounds/calling.wav', import.meta.url)),
  connected: fileURLToPath(new URL('./sounds/connected.wav', import.meta.url)),
  ended: fileURLToPath(new URL('./sounds/ended.wav', import.meta.url)),
};

export class CallSounds {
  constructor({ spawnPlayer = spawn, repeatMs = 1400, volume = 0.55, enabled = true } = {}) {
    this.spawnPlayer = spawnPlayer;
    this.repeatMs = repeatMs; this.volume = volume; this.enabled = enabled;
    this.generation = 0;
  }

  silence() {
    this.generation++;
    clearTimeout(this.repeat);
    const child = this.child;
    this.finish?.();
    child?.kill();
    this.child = null;
  }

  async play(name) {
    this.silence();
    if (!this.enabled || !SOUND_FILES[name]) return;
    const generation = this.generation;
    const once = () => new Promise(resolve => {
      if (generation !== this.generation) return resolve();
      let finished = false;
      const child = this.spawnPlayer('/usr/bin/paplay', [`--volume=${Math.round(65536 * this.volume)}`, SOUND_FILES[name]], { stdio: 'ignore' });
      this.child = child;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (this.child === child) { this.child = null; this.finish = null; }
        resolve();
      };
      this.finish = done;
      const timeout = setTimeout(() => { child.kill(); done(); }, 6000);
      child.once('error', done);
      child.once('exit', done);
    });
    if (name === 'calling') {
      const ring = async () => {
        await once();
        if (generation === this.generation) this.repeat = setTimeout(ring, this.repeatMs);
      };
      void ring();
    } else {
      await once();
    }
  }
}
