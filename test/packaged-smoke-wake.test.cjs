'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { runWakeCapture } = require('../scripts/smoke-packaged.cjs');

function harness({ failCycle = 0 } = {}) {
  const windows = [], handlers = new Map(), notifications = new Map();
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      const cycle = windows.length + 1;
      assert.ok(windows.every(window => window.destroyed), 'the preceding capture must close before another starts');
      const wc = this.webContents = new EventEmitter();
      wc.mainFrame = {};
      wc.setWindowOpenHandler = () => {};
      wc.executeJavaScript = async () => {
        if (cycle === failCycle) throw Error('fixture startup rejected');
        for (let packet = 0; packet < 3; packet++) {
          const result = await handlers.get('dotdial-wake-audio')({ sender: wc, senderFrame: wc.mainFrame },
            { sampleRate: 16000, pcm: new Float32Array(1600).fill(0.25).buffer });
          assert.equal(result.accepted, true);
        }
        return { sampleRate: 16000 };
      };
      windows.push(this);
    }
    async loadFile() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  return { windows, electron: {
    app: { getAppPath: () => path.resolve(__dirname, '..') }, BrowserWindow,
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
    ipcMain: { handle(name, callback) {
      assert.equal(handlers.has(name), false, 'all cycles must share one capture factory');
      handlers.set(name, callback);
    }, on(name, callback) { notifications.set(name, callback); } },
  } };
}

test('packaged GUI smoke requires four fresh PCM captures with closed predecessors and retained startup evidence', async () => {
  const h = harness();
  const result = await runWakeCapture(h.electron);
  assert.equal(result.result, 'passed');
  assert.equal(result.cycles, 4);
  assert.equal(result.packets, 12);
  assert.equal(result.pcm_bytes, 12 * 6400);
  assert.equal(h.windows.length, 4);
  for (const [index, capture] of result.captures.entries()) {
    assert.equal(capture.cycle, index + 1);
    assert.equal(capture.packets, 3);
    assert.equal(capture.capture_window_destroyed, true);
    assert.equal(capture.callbacks_after_close, 0);
    assert.equal(capture.startup.state, 'ready');
    assert.equal(capture.startup.timedOut, false);
  }
  assert.ok(h.windows.every(window => window.destroyed));
});

test('a failed GUI capture stops the required sequence immediately and reports its startup evidence without retry', async t => {
  const h = harness({ failCycle: 2 }), logs = [];
  t.mock.method(console, 'error', line => logs.push(line));
  await assert.rejects(runWakeCapture(h.electron), { code: 'wake_audio_unavailable' });
  assert.equal(h.windows.length, 2, 'a failed required cycle must not be replaced by a later success');
  assert.ok(h.windows.every(window => window.destroyed));
  const report = JSON.parse(logs.find(line => line.startsWith('DOTDIAL_WAKE_CAPTURE_SMOKE '))
    .slice('DOTDIAL_WAKE_CAPTURE_SMOKE '.length));
  assert.equal(report.cycle, 2);
  assert.equal(report.result, 'failed');
  assert.equal(report.startup.state, 'failed');
  assert.equal(report.startup.timedOut, false);
  assert.deepEqual(report.errors, ['wake_audio_unavailable']);
});
