'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('DotDialWakePipe', Object.freeze({
  audio: payload => ipcRenderer.invoke('dotdial-wake-audio', payload),
  error: code => ipcRenderer.send('dotdial-wake-error', code),
  startup: payload => ipcRenderer.send('dotdial-wake-startup', payload),
}));
