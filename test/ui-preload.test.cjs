'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('UI state unsubscribe removes only its listener and returns no privileged IPC object', () => {
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = () => Promise.resolve();
  let api;
  const contextBridge = { exposeInMainWorld(name, value) {
    assert.equal(name, 'dotdial');
    api = value;
  } };
  const file = path.join(__dirname, '..', 'src', 'ui', 'preload.cjs');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return { contextBridge, ipcRenderer }; },
    process: { platform: 'darwin' },
  }, { filename: file });
  const received = [];
  const otherListener = () => {};
  ipcRenderer.on('dotdial:state', otherListener);
  const unsubscribe = api.onState(value => received.push(value));
  const value = { state: 'ready' };
  ipcRenderer.emit('dotdial:state', { nativeEvent: true }, value);
  assert.deepEqual(received, [value]);
  assert.equal(ipcRenderer.listenerCount('dotdial:state'), 2);
  assert.equal(unsubscribe(), undefined);
  assert.equal(unsubscribe(), undefined);
  assert.deepEqual(ipcRenderer.listeners('dotdial:state'), [otherListener]);
  ipcRenderer.emit('dotdial:state', {}, { state: 'active' });
  assert.deepEqual(received, [value]);
  assert.equal(api.onState(null)(), undefined);
});
