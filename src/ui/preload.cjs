'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel, listener) => {
  if (typeof listener !== 'function') return () => {};
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('dotdial', Object.freeze({
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
