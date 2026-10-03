const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('DotDialArchive', {
  save: payload => ipcRenderer.invoke('dotdial-missed-save', payload),
  recording: active => ipcRenderer.send('dotdial-missed-recording', active === true),
  error: code => ipcRenderer.send('dotdial-missed-error', ['recording_failed', 'recording_unavailable', 'storage_full'].includes(code) ? code : 'recording_failed'),
});
