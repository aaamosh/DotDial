'use strict';

// Smoke-only CDP observer: keep the first sample plus the latest 63, and never
// queue a second request behind a slow one. A failed probe stops diagnostics.
function observeWakeAudioClock(webContents, { now = Date.now } = {}) {
  const debug = webContents.debugger, events = [], samples = [], errors = [];
  let active = true, attached = false, timer, watchdog, contextId, cancelRequest;
  const keep = (list, value) => { if (list.length === 64) list.splice(1, 1); list.push({ atMs: now(), ...value }); };
  const recordError = (stage, error) => keep(errors, { stage, code: error?.code === 'timeout' ? 'timeout'
    : /not found|wasn't found|unsupported/i.test(error?.message || '') ? 'unsupported_protocol' : 'protocol_error' });
  const snapshot = () => structuredClone({ active, attached, events, samples, errors });
  function close() {
    if (!active) return;
    active = false; cancelRequest?.(); clearTimeout(timer); clearTimeout(watchdog);
    webContents.removeListener('destroyed', close); debug?.removeListener('message', message);
    if (attached) { attached = false; try { debug.detach(); } catch {} }
  }
  function message(_event, method, params) {
    if (!active || !['WebAudio.contextCreated', 'WebAudio.contextChanged'].includes(method)) return;
    const context = params?.context;
    if (!context || typeof context.contextId !== 'string') return;
    contextId = context.contextId;
    keep(events, { event: method, contextId, state: context.contextState, sampleRate: context.sampleRate });
  }
  async function command(method, params = {}) {
    try {
      return await Promise.race([debug.sendCommand(method, params), new Promise((_, reject) => {
        cancelRequest = () => reject(Error('observer_closed'));
        watchdog = setTimeout(() => reject(Object.assign(Error('clock_probe_timeout'), { code: 'timeout' })), 1500);
      })]);
    } finally { clearTimeout(watchdog); cancelRequest = null; }
  }
  async function poll() {
    if (!active) return;
    if (contextId) {
      try {
        const { realtimeData } = await command('WebAudio.getRealtimeData', { contextId });
        if (!Number.isFinite(realtimeData?.currentTime)) throw Error('invalid_clock_data');
        if (active) keep(samples, { contextId, ...Object.fromEntries(
          ['currentTime', 'renderCapacity', 'callbackIntervalMean', 'callbackIntervalVariance']
            .filter(key => Number.isFinite(realtimeData?.[key])).map(key => [key, realtimeData[key]])) });
      } catch (error) { if (active) { recordError('WebAudio.getRealtimeData', error); close(); } }
    }
    if (active) timer = setTimeout(poll, 500);
  }
  try {
    if (debug.isAttached()) throw Error('debugger_already_attached');
    debug.on('message', message); webContents.once('destroyed', close);
    debug.attach('1.3'); attached = true;
    void command('WebAudio.enable').then(poll, error => { if (active) { recordError('WebAudio.enable', error); close(); } });
  } catch (error) { recordError('debugger.attach', error); close(); }
  return { snapshot, close };
}

module.exports = { observeWakeAudioClock };
