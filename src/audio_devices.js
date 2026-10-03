'use strict';

// Chromium IDs are salted per browser profile. Keep a human-readable device
// label in the config and resolve it inside each short-lived audio session.
(() => {
  const failure = code => Object.assign(new Error(code), { code });
  async function list() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => ['audioinput', 'audiooutput'].includes(d.kind) && d.label &&
      d.deviceId && !['default', 'communications'].includes(d.deviceId))
      .map(d => ({ kind: d.kind, id: 'label:' + d.label, label: d.label }));
  }
  async function resolve(value, kind) {
    if (!value || value === 'default') return '';
    if (!value.startsWith('label:')) throw failure('audio_device_rescan_required');
    const label = value.slice(6);
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === kind &&
      d.label === label && d.deviceId && !['default', 'communications'].includes(d.deviceId));
    if (devices.length !== 1) throw failure(devices.length ? 'audio_device_ambiguous' : 'audio_device_unavailable');
    return devices[0].deviceId;
  }
  globalThis.DotDialDevices = Object.freeze({ list, resolve });
})();
