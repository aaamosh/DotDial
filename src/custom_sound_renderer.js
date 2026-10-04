'use strict';

window.CustomSound = {
  async decode(base64, mime) {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const audio = new Audio();
    let timer;
    try {
      const duration = await new Promise((resolve, reject) => {
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => resolve(audio.duration);
        audio.onerror = () => reject(Error('sound_decode_failed'));
        timer = setTimeout(() => reject(Error('sound_decode_failed')), 7000);
        audio.src = url;
      });
      clearTimeout(timer);
      if (!Number.isFinite(duration) || duration <= 0) return { error: 'sound_decode_failed' };
      if (duration > 30.1) return { error: 'sound_file_too_long' };
      const context = new OfflineAudioContext(2, 1, 48000);
      const decoded = await context.decodeAudioData(bytes.buffer);
      if (decoded.duration > 30.1) return { error: 'sound_file_too_long' };
      if (decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2) return { error: 'sound_decode_failed' };
      const channels = decoded.numberOfChannels, frames = Math.min(decoded.length, 30 * 48000);
      const buffer = new ArrayBuffer(44 + frames * channels * 2), view = new DataView(buffer);
      const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
      text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVEfmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
      view.setUint32(24, 48000, true); view.setUint32(28, 48000 * channels * 2, true);
      view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data');
      view.setUint32(40, frames * channels * 2, true);
      const samples = Array.from({ length: channels }, (_, channel) => decoded.getChannelData(channel));
      for (let i = 0; i < frames; i++) for (let channel = 0; channel < channels; channel++) {
        const sample = Math.max(-1, Math.min(1, samples[channel][i]));
        view.setInt16(44 + (i * channels + channel) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      }
      return buffer;
    } catch { return { error: 'sound_decode_failed' }; }
    finally { clearTimeout(timer); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); }
  },
};
