'use strict';

// Recognizer labels are data, never arbitrary local IPC commands.
const VOICE_COMMANDS = Object.freeze({
  microphoneOff: 'MUTE', microphoneOn: 'UNMUTE',
  speakersOff: 'SPEAKERS_MUTE', speakersOn: 'SPEAKERS_UNMUTE',
  hangUp: 'STOP', playMissedReplies: 'MISSED_PLAY', stopPlayback: 'MISSED_STOP',
});

class VoiceCommands {
  constructor({ getState, getCallIdentity, dispatch }) {
    Object.assign(this, { getState, getCallIdentity, dispatch });
    this.generation = 0;
  }
  cancel() { this.generation++; }
  async handle(action) {
    if (typeof action !== 'string' || !Object.hasOwn(VOICE_COMMANDS, action)) return { status: 'unknown_voice_command' };
    const state = this.getState(), active = state.state === 'active', replay = state.missed_playing === true;
    const generation = ++this.generation, call = this.getCallIdentity();
    const current = () => generation === this.generation && call === this.getCallIdentity() && this.getState().state === 'active';
    if (action === 'hangUp') {
      if (replay || ['starting', 'active', 'stopping'].includes(state.state)) return this.dispatch('STOP');
    } else if (action === 'stopPlayback') {
      if (replay) return this.dispatch('MISSED_STOP');
    } else if (action === 'playMissedReplies') {
      if (!replay && ['ready', 'active'].includes(state.state)) return this.dispatch('MISSED_PLAY');
    } else if (action === 'speakersOff' && replay) {
      // Muting means silence, including the local missed-reply player. Set the
      // live-call choice before stopping replay so restoration cannot sound it.
      if (active) {
        const result = await this.dispatch('SPEAKERS_MUTE');
        if (result?.status !== 'muting_speakers' || !current()) return result;
      }
      if (generation === this.generation && this.getState().missed_playing) return this.dispatch('MISSED_STOP');
    } else if (active) {
      if (action === 'microphoneOn' && replay) {
        await this.dispatch('MISSED_STOP');
        // A hangup, manual mute or newer voice command must win over this
        // asynchronous replay cleanup, including across replacement calls.
        if (!current()) return { status: 'voice_command_cancelled' };
      }
      return this.dispatch(VOICE_COMMANDS[action]);
    }
    return { status: 'voice_command_ignored' };
  }
}

module.exports = { VOICE_COMMANDS, VoiceCommands };
