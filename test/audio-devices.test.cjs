'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'audio_devices.js'), 'utf8');
function session(rows) {
  const context = { navigator: { mediaDevices: { enumerateDevices: async () => rows } } };
  vm.runInNewContext(source, context);
  return context.DotDialDevices;
}
test('configured device follows its label across ephemeral Chromium salts', async () => {
  const a = session([{ kind: 'audioinput', label: 'USB microphone', deviceId: 'profile-a-hash' }]);
  const b = session([{ kind: 'audioinput', label: 'USB microphone', deviceId: 'profile-b-hash' }]);
  const saved = (await a.list())[0].id;
  assert.equal(saved, 'label:USB microphone');
  assert.equal(await b.resolve(saved, 'audioinput'), 'profile-b-hash');
});
test('missing or ambiguous device does not silently switch microphones', async () => {
  await assert.rejects(session([]).resolve('label:USB', 'audioinput'), { code: 'audio_device_unavailable' });
  const ambiguous = session(['a', 'b'].map(deviceId => ({ kind: 'audioinput', label: 'USB', deviceId })));
  await assert.rejects(ambiguous.resolve('label:USB', 'audioinput'), { code: 'audio_device_ambiguous' });
  assert.equal(await ambiguous.resolve('default', 'audioinput'), '');
});
