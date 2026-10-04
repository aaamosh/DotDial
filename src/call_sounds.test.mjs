import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CallSounds, PLAYBACK_TIMEOUT_MS, SOUND_FILES } from './call_sounds.mjs';

test('ringback is stopped before connection; ending replaces connection without overlap', async () => {
  const players = [];
  const sounds = new CallSounds({ spawnPlayer: (_cmd, args) => {
    const child = new EventEmitter();
    child.args = args;
    child.kill = () => { child.killed = true; child.emit('exit'); };
    players.push(child);
    return child;
  }});
  await sounds.play('calling');
  const connected = sounds.play('connected');
  assert.equal(players[0].killed, true);
  assert.equal(players[1].args[1], SOUND_FILES.connected);
  const ended = sounds.play('ended');
  await connected;
  assert.equal(players[1].killed, true);
  players[2].emit('exit');
  await ended;
  sounds.silence();
  assert.equal(players.length, 3);
});

test('cancelling ringback releases player and prevents repetition', async () => {
  let count = 0;
  let killed = false;
  const sounds = new CallSounds({ repeatMs: 1, spawnPlayer: () => {
    count++;
    const child = new EventEmitter();
    child.kill = () => { killed = true; child.emit('exit'); };
    return child;
  }});
  await sounds.play('calling');
  await sounds.play('silence');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(killed, true);
  assert.equal(count, 1);
});

test('activation cue is available and plays once', async () => {
  assert.equal(SOUND_FILES.activated.endsWith('/sounds/activated.wav'), true);
  const players = [];
  const sounds = new CallSounds({ repeatMs: 1, spawnPlayer: (_cmd, args) => {
    const child = new EventEmitter();
    child.args = args;
    child.kill = () => { child.killed = true; child.emit('exit'); };
    players.push(child);
    return child;
  }});
  const playing = sounds.play('activated');
  assert.equal(players.length, 1);
  assert.equal(players[0].args[1], SOUND_FILES.activated);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(players.length, 1);
  players[0].emit('exit');
  await playing;
  sounds.silence();
});

test('stuck players time out, with enough headroom for the full modem recording', async () => {
  assert.ok(PLAYBACK_TIMEOUT_MS.calling > 20_039);
  let killed = false;
  const sounds = new CallSounds({ playbackTimeoutMs: { default: 15 }, spawnPlayer: () => {
    const child = new EventEmitter();
    child.kill = () => { killed = true; child.emit('exit'); };
    return child;
  }});
  await sounds.play('activated');
  assert.equal(killed, true);
  sounds.silence();
});
