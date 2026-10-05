'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel, listener) => {
  if (typeof listener !== 'function') return () => {};
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  // EventEmitter.removeListener returns the privileged ipcRenderer object,
  // which must never cross contextBridge as the unsubscribe return value.
  return () => { ipcRenderer.removeListener(channel, wrapped); };
};

contextBridge.exposeInMainWorld('dotdial', Object.freeze({
  platform: process.platform,
  readConfig: () => invoke('dotdial:config-read'),
  saveConfig: (config, hash) => invoke('dotdial:config-save', { config, hash }),
  command: (name, payload) => invoke('dotdial:command', name, payload),
  getAudioDevices: () => invoke('dotdial:devices'),
  chooseSoundFile: () => invoke('dotdial:sound-choose'),
  previewSound: options => invoke('dotdial:sound-preview', options),
  stopSoundPreview: () => invoke('dotdial:sound-preview-stop'),
  showMenu: () => invoke('dotdial:menu'),
  movePanel: (dx, dy) => invoke('dotdial:move', { dx, dy }),
  onState: listener => subscribe('dotdial:state', listener),
}));
