'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { waitForSettingsVisible, settingsReloadReadinessSource, capture } = require('../scripts/smoke-packaged.cjs');

function fixture() {
  const state = { visible: false, captures: 0,
    document: { readyState: 'complete', visibilityState: 'visible', fontsStatus: 'loaded',
      section: { rectCount: 1, opacity: '1' }, animationCount: 0, animations: [] } };
  const window = { isDestroyed: () => false, isVisible: () => state.visible,
    isMinimized: () => false, isFocused: () => state.visible,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    show: () => assert.fail('the smoke must wait for the application to show its own window'),
    webContents: { isDestroyed: () => false,
      executeJavaScript: async () => structuredClone(state.document),
      // Mock pixels only exercise the guard; no native rendering is claimed.
      capturePage: async () => { state.captures++; return { isEmpty: () => false,
        getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.alloc(600, 1) }; },
    } };
  return { window, state };
}

test('packaged smoke cannot drive settings or reload before the normal initial window show', async () => {
  const { window, state } = fixture();
  let interactionStarted = false;
  const ready = waitForSettingsVisible(window, 2000).then(observed => {
    interactionStarted = true;
    return observed;
  });
  await Promise.resolve();
  assert.equal(interactionStarted, false, 'a ready DOM in a hidden window is not enough');
  state.visible = true; // Model only the app's normal ready-to-show handler.
  assert.equal((await ready).visible, true);
  assert.equal(interactionStarted, true);
});

test('persisted settings after reload require two fresh frames without rescheduling the marker', () => {
  // Execute the actual probe with a controlled frame queue; this models callback
  // ordering only and makes no claim about native rendering or compositor timing.
  const frames = [], input = { value: 'Packaged smoke' };
  const context = vm.createContext({ window: {}, document: { querySelector: () => input },
    requestAnimationFrame: callback => frames.push(callback) });
  const source = settingsReloadReadinessSource('first-reload');
  const probe = () => vm.runInContext(source, context);
  assert.equal(probe(), false, 'persisted DOM alone is insufficient');
  assert.equal(probe(), false);
  assert.equal(frames.length, 1, 'polls must not restart the frame marker');
  frames.shift()();
  assert.equal(probe(), false, 'the first frame alone is insufficient');
  frames.shift()();
  assert.equal(probe(), true);
  input.value = 'not persisted';
  assert.equal(probe(), false, 'frame readiness must preserve the persisted-value assertion');
  input.value = 'Packaged smoke';
  assert.equal(vm.runInContext(settingsReloadReadinessSource('second-reload'), context), false,
    'a later reload cannot reuse the preceding frame marker');
  assert.equal(frames.length, 1);
});

test('capture preserves font and opacity assertions and reports the last readiness state', async () => {
  const { window, state } = fixture();
  state.visible = true;
  for (const document of [
    { ...state.document, fontsStatus: 'loading' },
    { ...state.document, section: { rectCount: 1, opacity: '0.3' }, animationCount: 1,
      animations: [{ name: 'section-enter', playState: 'running', currentTime: 0, pending: true }] },
  ]) {
    state.document = document;
    await assert.rejects(() => capture(window, undefined, 'settings.png', 20), error => {
      assert.equal(error.message, 'packaged_capture_layout_not_ready');
      assert.equal(error.captureReadiness.observed.window.visible, true);
      assert.deepEqual(error.captureReadiness.observed.document, document);
      return true;
    });
    assert.equal(state.captures, 0, 'an unsettled layout must never reach pixel capture');
  }
  state.document = { ...state.document, fontsStatus: 'loaded', section: { rectCount: 1, opacity: '1' } };
  const result = await capture(window, undefined, 'settings.png');
  assert.equal(state.captures, 1);
  assert.deepEqual(result.readiness.document, state.document);
});

test('a stalled renderer query exhausts the capture budget without queuing another probe', async () => {
  const { window, state } = fixture();
  state.visible = true;
  let probes = 0;
  window.webContents.executeJavaScript = () => { probes++; return new Promise(() => {}); };
  const started = Date.now();
  // Longer than the old 500ms per-query cap: an unresolved query must still be
  // the only renderer request made during this entire capture attempt.
  await assert.rejects(() => capture(window, undefined, 'settings.png', 650), error => {
    assert.equal(error.message, 'packaged_capture_layout_not_ready');
    assert.equal(error.captureReadiness.observed.rendererError, 'renderer_readiness_query_timeout');
    assert.equal(error.captureReadiness.rendererProbeCount, 1);
    return true;
  });
  assert.equal(probes, 1);
  assert.equal(state.captures, 0);
  assert.ok(Date.now() - started < 2000);
});

test('a later stalled probe retains the previous successful renderer snapshot', async () => {
  const { window, state } = fixture();
  state.visible = true;
  state.document.section.opacity = '0.3';
  let probes = 0;
  window.webContents.executeJavaScript = () => ++probes === 1 ?
    Promise.resolve(structuredClone(state.document)) : new Promise(() => {});
  await assert.rejects(() => capture(window, undefined, 'settings.png', 1000), error => {
    assert.equal(error.message, 'packaged_capture_layout_not_ready');
    const readiness = error.captureReadiness;
    assert.equal(readiness.observed.rendererError, 'renderer_readiness_query_timeout');
    assert.deepEqual(readiness.lastSuccessfulRenderer.document, state.document);
    assert.equal(readiness.lastSuccessfulRenderer.window.visible, true);
    assert.ok(readiness.lastSuccessfulRenderer.elapsed_ms <= readiness.observed.elapsed_ms);
    assert.equal(readiness.rendererProbeCount, 2);
    return true;
  });
  assert.equal(probes, 2);
  assert.equal(state.captures, 0);
});
