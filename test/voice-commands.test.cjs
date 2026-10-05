'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceCommands } = require('../src/voice_commands.cjs');

function fixture(state = { state: 'active' }) {
  const f = { state, call: {}, events: [] };
  f.dispatch = async name => {
    f.events.push(name);
    if (name === 'MISSED_STOP') f.state.missed_playing = false;
    return { status: name === 'SPEAKERS_MUTE' ? 'muting_speakers' : 'accepted' };
  };
  f.voice = new VoiceCommands({ getState: () => f.state, getCallIdentity: () => f.call, dispatch: name => f.dispatch(name) });
  return f;
}

test('only bounded control labels can dispatch; inactive controls cannot place a call', async () => {
  const f = fixture({ state: 'ready' });
  for (const name of ['WAKE', 'QUIT', 'LOGIN', 'MISSED_CLEAR', '__proto__', null, {}]) {
    assert.equal((await f.voice.handle(name)).status, 'unknown_voice_command');
  }
  for (const name of ['microphoneOff', 'microphoneOn', 'speakersOff', 'speakersOn', 'hangUp', 'stopPlayback']) {
    assert.equal((await f.voice.handle(name)).status, 'voice_command_ignored');
  }
  assert.deepEqual(f.events, []);
  await f.voice.handle('playMissedReplies');
  assert.deepEqual(f.events, ['MISSED_PLAY']);
});

test('microphone and speaker choices remain independent in every mute combination', async () => {
  for (const microphone_muted of [true, false]) for (const speakers_muted of [true, false]) {
    const f = fixture({ state: 'active', microphone_muted, speakers_muted });
    for (const name of ['microphoneOff', 'microphoneOn', 'speakersOff', 'speakersOn']) await f.voice.handle(name);
    assert.deepEqual(f.events, ['MUTE', 'UNMUTE', 'SPEAKERS_MUTE', 'SPEAKERS_UNMUTE']);
  }
});

test('speaker mute silences replay without losing the independent live-call choice', async () => {
  const f = fixture({ state: 'active', missed_playing: true });
  await f.voice.handle('speakersOff');
  assert.deepEqual(f.events, ['SPEAKERS_MUTE', 'MISSED_STOP']);
  const idle = fixture({ state: 'ready', missed_playing: true });
  await idle.voice.handle('speakersOff');
  assert.deepEqual(idle.events, ['MISSED_STOP']);
});

test('microphone enable can interrupt replay and does not enable speakers', async () => {
  const f = fixture({ state: 'active', missed_playing: true });
  await f.voice.handle('microphoneOn');
  assert.deepEqual(f.events, ['MISSED_STOP', 'UNMUTE']);
});

test('hangup bypasses pending cleanup and prevents a late microphone enable', async () => {
  const f = fixture({ state: 'active', missed_playing: true });
  let finish;
  f.dispatch = name => {
    f.events.push(name);
    return name === 'MISSED_STOP' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ status: 'accepted' });
  };
  const enabling = f.voice.handle('microphoneOn');
  await f.voice.handle('hangUp');
  assert.deepEqual(f.events, ['MISSED_STOP', 'STOP']);
  finish();
  assert.equal((await enabling).status, 'voice_command_cancelled');
  assert.deepEqual(f.events, ['MISSED_STOP', 'STOP']);
});

test('manual controls, new phrases and replacement calls cancel delayed voice actions', async () => {
  for (const cancel of [f => f.voice.cancel(), f => { f.call = {}; }, f => { f.state.state = 'ready'; }]) {
    const f = fixture({ state: 'active', missed_playing: true });
    let finish;
    f.dispatch = name => { f.events.push(name); return new Promise(resolve => { finish = resolve; }); };
    const enabling = f.voice.handle('microphoneOn');
    cancel(f); finish();
    assert.equal((await enabling).status, 'voice_command_cancelled');
    assert.deepEqual(f.events, ['MISSED_STOP']);
  }
});

test('dialing can be cancelled and replay stopped after the call ends', async () => {
  const f = fixture({ state: 'starting' });
  await f.voice.handle('microphoneOn'); await f.voice.handle('playMissedReplies'); await f.voice.handle('hangUp');
  assert.deepEqual(f.events, ['STOP']);
  f.state = { state: 'ready', missed_playing: true };
  await f.voice.handle('stopPlayback');
  assert.deepEqual(f.events, ['STOP', 'MISSED_STOP']);
});
