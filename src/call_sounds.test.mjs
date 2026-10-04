import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CallSounds, PLAYBACK_TIMEOUT_MS, SOUND_FILES } from './call_sounds.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function playerFactory() {
  const players = [];
  const spawnPlayer = (_cmd, args) => {
    const child = new EventEmitter();
    child.args = args;
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit'); };
    players.push(child);
    return child;
  };
  return { players, spawnPlayer };
}

test('calling is interrupted by connected and ended cues without overlap', async () => {
  const { players, spawnPlayer } = playerFactory();
  const sounds = new CallSounds({ spawnPlayer });
  await sounds.play('calling');
  assert.equal(players[0].args[1], SOUND_FILES.calling);

  const connected = sounds.play('connected');
  assert.equal(players[0].killed, true);
  assert.equal(players[1].args[1], SOUND_FILES.connected);
  const ended = sounds.play('ended');
  assert.equal(players[1].killed, true);
  players[2].emit('exit');
  await Promise.all([connected, ended]);
  sounds.silence();
  assert.equal(players.length, 3);
});

test('connected and ended player failures never reject call lifecycle work', async () => {
  const { players, spawnPlayer } = playerFactory();
  const sounds = new CallSounds({ spawnPlayer });
  const connected = sounds.play('connected');
  players[0].emit('exit', 1);
  await assert.doesNotReject(connected);

  const ended = sounds.play('ended');
  players[1].emit('exit', 1);
  await assert.doesNotReject(ended);
  sounds.silence();
});

test('telephone and modem selections use matching calling and connection cues', async () => {
  const { players, spawnPlayer } = playerFactory();
  const sounds = new CallSounds({ spawnPlayer });
  sounds.configure({ connectionSound: 'telephone', soundVolume: 0.25, sounds: true });
  sounds.play('calling');
  assert.equal(players[0].args[1], SOUND_FILES.telephone);
  assert.equal(players[0].args[0], '--volume=16384');

  const telephoneConnected = sounds.play('connected');
  assert.equal(players[0].killed, true);
  assert.equal(players[1].args[1], SOUND_FILES.activated);
  players[1].emit('exit');
  await telephoneConnected;

  sounds.configure({ connectionSound: 'modem' });
  sounds.play('calling');
  assert.equal(players[2].args[1], SOUND_FILES.calling);
  const modemConnected = sounds.play('connected');
  assert.equal(players[2].killed, true);
  assert.equal(players[3].args[1], SOUND_FILES.connected);
  players[3].emit('exit');
  await modemConnected;
  sounds.silence();
});

test('custom decoding never blocks call startup and a late result cannot play after connect', async () => {
  const { players, spawnPlayer } = playerFactory();
  let releaseDecode;
  let decoderSignal;
  const decode = new Promise(resolve => { releaseDecode = resolve; });
  const sounds = new CallSounds({
    connectionSound: 'custom', customSoundPath: '/home/user/dial.wav', spawnPlayer,
    resolveCustomSound: (path, { signal }) => {
      assert.equal(path, '/home/user/dial.wav');
      decoderSignal = signal;
      return decode;
    },
  });

  await Promise.race([sounds.play('calling'), delay(30).then(() => { throw new Error('calling awaited custom decoding'); })]);
  await nextTurn();
  assert.equal(players.length, 0);

  const connected = sounds.play('connected');
  assert.equal(decoderSignal.aborted, true);
  assert.equal(players.length, 1);
  assert.equal(players[0].args[1], SOUND_FILES.activated);
  releaseDecode('/cache/custom-dial.wav');
  await nextTurn();
  assert.equal(players.length, 1);
  players[0].emit('exit');
  await connected;
  sounds.silence();
});

test('invalid custom calling sound falls back to telephone without rejecting call startup', async () => {
  const { players, spawnPlayer } = playerFactory();
  const sounds = new CallSounds({
    connectionSound: 'custom', customSoundPath: '/missing/dial.wav', spawnPlayer,
    resolveCustomSound: async () => { throw new Error('unsupported audio'); },
  });
  await sounds.play('calling');
  await nextTurn();
  assert.equal(players.length, 1);
  assert.equal(players[0].args[1], SOUND_FILES.telephone);
  sounds.silence();
});

test('preview uses overrides once and leaves saved audio settings untouched', async () => {
  const { players, spawnPlayer } = playerFactory();
  const sounds = new CallSounds({ spawnPlayer, connectionSound: 'modem', soundVolume: 0.55 });
  const preview = sounds.play('preview', { connectionSound: 'telephone', soundVolume: 0.25 });
  assert.equal(players[0].args[1], SOUND_FILES.telephone);
  assert.equal(players[0].args[0], '--volume=16384');
  assert.equal(sounds.connectionSound, 'modem');
  assert.equal(sounds.volume, 0.55);
  players[0].emit('exit');
  await preview;
  sounds.silence();
});

test('explicit preview plays an unsaved selection even when saved sounds are disabled', async () => {
  const { players, spawnPlayer } = playerFactory();
  const sounds = new CallSounds({ spawnPlayer, sounds: false, connectionSound: 'modem' });
  const preview = sounds.play('preview', { connectionSound: 'telephone', soundVolume: 0.3 });
  assert.equal(players[0].args[1], SOUND_FILES.telephone);
  assert.equal(players[0].args[0], '--volume=19661');
  assert.equal(sounds.enabled, false);
  players[0].emit('exit');
  await preview;
  sounds.silence();
});

test('custom preview resolves its override path and plays the decoded WAV once', async () => {
  const { players, spawnPlayer } = playerFactory();
  const sounds = new CallSounds({
    spawnPlayer, connectionSound: 'modem', customSoundPath: '/saved/old.wav', soundVolume: 0.55,
    resolveCustomSound: async path => {
      assert.equal(path, '/picked/new.mp3');
      return '/cache/new-preview.wav';
    },
  });
  const preview = sounds.play('preview', {
    connectionSound: 'custom', customSoundPath: '/picked/new.mp3', soundVolume: 0.2,
  });
  await nextTurn();
  assert.equal(players[0].args[1], '/cache/new-preview.wav');
  assert.equal(players[0].args[0], '--volume=13107');
  assert.equal(sounds.connectionSound, 'modem');
  assert.equal(sounds.customSoundPath, '/saved/old.wav');
  assert.equal(sounds.volume, 0.55);
  await delay(10);
  assert.equal(players.length, 1);
  players[0].emit('exit');
  await preview;
  sounds.silence();
});

test('preview rejects bad custom audio while calling uses telephone fallback', async () => {
  const { players, spawnPlayer } = playerFactory();
  const sounds = new CallSounds({
    spawnPlayer,
    resolveCustomSound: async () => { throw new Error('unsupported audio'); },
  });
  await assert.rejects(
    sounds.play('preview', { connectionSound: 'custom', customSoundPath: '/bad/file.mp3' }),
    /unsupported audio/,
  );
  assert.equal(players.length, 0);
  await sounds.play('calling');
  await nextTurn();
  assert.equal(players[0].args[1], SOUND_FILES.calling);
  sounds.silence();
});

test('silence stops a pending preview and a late custom decode cannot restart playback', async () => {
  const { players, spawnPlayer } = playerFactory();
  let releaseDecode;
  const decode = new Promise(resolve => { releaseDecode = resolve; });
  const sounds = new CallSounds({ spawnPlayer, resolveCustomSound: () => decode });
  const preview = sounds.play('preview', { connectionSound: 'custom', customSoundPath: '/home/user/dial.mp3' });
  await nextTurn();
  sounds.silence();
  await preview;
  releaseDecode('/cache/custom.wav');
  await nextTurn();
  assert.equal(players.length, 0);
});

test('activation cue is available and plays once', async () => {
  assert.equal(SOUND_FILES.activated.endsWith('/sounds/activated.wav'), true);
  const { players, spawnPlayer } = playerFactory();
  const sounds = new CallSounds({ repeatMs: 1, spawnPlayer });
  const playing = sounds.play('activated');
  assert.equal(players.length, 1);
  assert.equal(players[0].args[1], SOUND_FILES.activated);
  await delay(15);
  assert.equal(players.length, 1);
  players[0].emit('exit');
  await playing;
  sounds.silence();
});

test('stuck players time out without truncating modem or custom connection audio', async () => {
  assert.ok(PLAYBACK_TIMEOUT_MS.calling > 30_000);
  const { players, spawnPlayer } = playerFactory();
  const sounds = new CallSounds({ playbackTimeoutMs: { default: 15 }, spawnPlayer });
  await sounds.play('activated');
  assert.equal(players[0].killed, true);
  sounds.silence();
});
