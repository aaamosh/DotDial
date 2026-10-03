import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const NAME = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/;
const PART_NAME = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav\.part$/;
const MAX_CLIP = 61 * 48000 * 2;
const failure = code => Object.assign(new Error(code), { code });

function inspectWav(file, stat) {
  if (!stat.isFile() || stat.size < 46 || stat.size > MAX_CLIP + 44) return false;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const header = Buffer.alloc(44);
    if (fs.readSync(fd, header, 0, 44, 0) !== 44) return false;
    const dataBytes = stat.size - 44;
    return header.toString('ascii', 0, 4) === 'RIFF' &&
      header.readUInt32LE(4) === stat.size - 8 &&
      header.toString('ascii', 8, 12) === 'WAVE' &&
      header.toString('ascii', 12, 16) === 'fmt ' &&
      header.readUInt32LE(16) === 16 &&
      header.readUInt16LE(20) === 1 && header.readUInt16LE(22) === 1 &&
      header.readUInt32LE(24) === 48000 && header.readUInt32LE(28) === 96000 &&
      header.readUInt16LE(32) === 2 && header.readUInt16LE(34) === 16 &&
      header.toString('ascii', 36, 40) === 'data' &&
      header.readUInt32LE(40) === dataBytes && dataBytes >= 2 && dataBytes % 2 === 0;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function regularFileStat(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat : null;
  } catch { return null; }
}

export class MissedAudio {
  constructor({ directory, player, beforePlayback = async () => {}, afterPlayback = async () => {},
    beforeDrain = async () => {}, onChange = () => {}, limitBytes = 512 * 1024 * 1024 }) {
    Object.assign(this, { directory, player, beforePlayback, afterPlayback, beforeDrain, onChange, limitBytes });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.settingsFile = path.join(directory, 'settings.json');
    try { this.desiredMuted = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')).speakers_muted === true; }
    catch { this.desiredMuted = false; }
    this.queue = [];
    this.durableBytes = 0;
    this.unusableBytes = 0;
    this.error = null;
    const recovered = [];
    this.lastIdTime = 0;
    for (const name of fs.readdirSync(directory).sort()) {
      const isClip = NAME.test(name), isPart = PART_NAME.test(name);
      if (!isClip && !isPart) continue;
      this.lastIdTime = Math.max(this.lastIdTime, Number(name.slice(0, 13)) || 0);
      const file = path.join(directory, name), stat = regularFileStat(file);
      // Matching symlinks and non-files are deliberately left alone and are
      // not treated as archive data.
      if (!stat) continue;
      this.durableBytes += stat.size;
      if (isClip && inspectWav(file, stat)) {
        recovered.push({ name, bytes: stat.size, durationMs: Math.round((stat.size - 44) / 96) });
        continue;
      }
      if (isPart && inspectWav(file, stat)) {
        const targetName = name.slice(0, -'.part'.length);
        const target = path.join(directory, targetName);
        let targetExists = false;
        try { fs.lstatSync(target); targetExists = true; }
        catch (error) { if (error.code !== 'ENOENT') targetExists = true; }
        if (!targetExists) {
          try {
            // A complete write whose process died before rename is still an
            // unread message. Recover it atomically instead of discarding it.
            fs.renameSync(file, target);
            recovered.push({ name: targetName, bytes: stat.size, durationMs: Math.round((stat.size - 44) / 96) });
            continue;
          } catch {}
        }
      }
      this.unusableBytes += stat.size;
      this.error = 'recording_failed';
    }
    this.queue = recovered.sort((a, b) => a.name.localeCompare(b.name));
    for (const clip of this.queue) fs.chmodSync(path.join(directory, clip.name), 0o600);
    this.pendingBytes = 0; this.saveTail = Promise.resolve();
    this.playing = false; this.recording = false; this.changing = false;
  }

  snapshot() {
    return { speakers_muted: this.desiredMuted || this.playing, speakers_changing: this.changing,
      missed_count: this.queue.length, missed_playing: this.playing, missed_recording: this.recording,
      missed_error: this.error, missed_playback_order: 'fifo' };
  }
  report() { this.onChange(this.snapshot()); }
  setError(code) { this.error = this.unusableBytes ? 'recording_failed' : code; this.report(); }
  setRecording(active) { this.recording = active === true; this.report(); }
  setMuted(muted) {
    const value = muted === true;
    const temporary = this.settingsFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ speakers_muted: value }) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, this.settingsFile);
    this.desiredMuted = value; this.report();
  }

  save({ sampleRate, pcm }) {
    if (sampleRate !== 48000 || !(pcm instanceof ArrayBuffer || ArrayBuffer.isView(pcm))) return Promise.reject(failure('recording_failed'));
    const bytes = pcm.byteLength;
    // VAD rejects isolated clicks; a final continuation after the 60s split can
    // legitimately contain less than 100ms and must not lose the last syllable.
    if (bytes < 2 || bytes > MAX_CLIP || bytes % 2) return Promise.reject(failure('recording_failed'));
    if (this.pendingBytes + this.durableBytes + bytes + 44 > this.limitBytes) {
      this.setError('storage_full'); return Promise.reject(failure('storage_full'));
    }
    const samples = ArrayBuffer.isView(pcm) ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) : Buffer.from(pcm);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28); header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
    this.lastIdTime = Math.max(Date.now(), this.lastIdTime + 1);
    const name = `${this.lastIdTime}-${randomUUID()}.wav`, file = path.join(this.directory, name);
    this.pendingBytes += bytes + 44;
    const operation = this.saveTail.then(async () => {
      let committed = false;
      try {
        await fs.promises.writeFile(file + '.part', Buffer.concat([header, samples]), { mode: 0o600, flag: 'wx' });
        await fs.promises.rename(file + '.part', file);
        this.queue.push({ name, bytes: bytes + 44, durationMs: Math.round(bytes / 96) });
        this.durableBytes += bytes + 44;
        committed = true;
        this.error = this.unusableBytes ? 'recording_failed' : null;
        return { saved: true };
      } catch {
        if (!committed) {
          // Keep and account an incomplete own-format fragment for diagnosis
          // and quota enforcement. Never unlink a path that may have changed
          // into a symlink or belong to another writer.
          const leftover = regularFileStat(file + '.part');
          if (leftover) {
            this.durableBytes += leftover.size;
            this.unusableBytes += leftover.size;
          }
        }
        this.error = 'recording_failed'; throw failure('recording_failed');
      } finally { this.pendingBytes -= bytes + 44; this.report(); }
    });
    this.saveTail = operation.catch(() => {});
    return operation;
  }

  play() {
    if (this.playing) return { status: 'already_playing' };
    if (!this.queue.length) return { status: 'no_missed_messages' };
    this.playing = true; this.cancelled = false; this.error = this.unusableBytes ? 'recording_failed' : null;
    this.disableMicRestore = false;
    this.report();
    this.finished = this.run();
    return { status: 'playing_missed_messages' };
  }

  async waitForSaves() {
    let tail;
    do {
      tail = this.saveTail;
      await tail;
    } while (tail !== this.saveTail);
  }

  async run() {
    let context;
    try {
      context = await this.beforePlayback();
      // Flush any partial recording that predates the playback request before
      // selecting the first FIFO item.
      await this.beforeDrain();
      await this.waitForSaves();
      for (;;) {
        if (this.cancelled) break;
        let clip = this.queue[0];
        if (!clip) {
          await this.waitForSaves();
          if (this.cancelled) break;
          if (this.queue.length) continue;
          // The peer may still have a partial segment that has not reached
          // save() yet. Flush once at the empty-queue boundary, then recheck.
          await this.beforeDrain();
          await this.waitForSaves();
          if (this.cancelled) break;
          clip = this.queue[0];
          if (!clip) break;
        }
        const complete = await this.player.play(path.join(this.directory, clip.name), clip.durationMs);
        if (!complete || this.cancelled) break;
        // The file itself is the durable unread marker; remove only after ended.
        await fs.promises.unlink(path.join(this.directory, clip.name));
        this.queue = this.queue.filter(item => item.name !== clip.name);
        this.durableBytes = Math.max(0, this.durableBytes - clip.bytes);
        this.report();
      }
    } catch { this.error = this.unusableBytes ? 'recording_failed' : 'playback_failed'; }
    finally {
      await this.player.stop().catch(() => {});
      try { await this.afterPlayback(context); } catch { this.error = this.unusableBytes ? 'recording_failed' : 'playback_failed'; }
      this.playing = false; this.report();
    }
  }

  async stop() {
    this.cancelled = true;
    await this.player.stop();
    await this.finished;
  }
  async clear() {
    await this.stop();
    const clips = this.queue.slice();
    for (const clip of clips) {
      await fs.promises.unlink(path.join(this.directory, clip.name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.queue = this.queue.filter(item => item.name !== clip.name);
      this.durableBytes = Math.max(0, this.durableBytes - clip.bytes);
    }
    this.error = this.unusableBytes ? 'recording_failed' : null; this.report();
  }
}
