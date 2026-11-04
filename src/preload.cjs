'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('eventsLauncher', Object.freeze({
  state: () => ipcRenderer.invoke('events:state'),
  checkPack: () => ipcRenderer.invoke('events:check-pack'),
  launcherUpdateState: () => ipcRenderer.invoke('events:launcher-update-state'),
  downloadLauncherUpdate: () => ipcRenderer.invoke('events:launcher-update-download'),
  installLauncherUpdate: () => ipcRenderer.invoke('events:launcher-update-install'),
  onLauncherUpdate: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on('events:launcher-update', wrapped);
    return () => ipcRenderer.removeListener('events:launcher-update', wrapped);
  },
  getSettings: () => ipcRenderer.invoke('events:get-settings'),
  getSkins: () => ipcRenderer.invoke('events:skins'),
  getDefaultSteve: () => ipcRenderer.invoke('events:default-steve'),
  addSkin: () => ipcRenderer.invoke('events:skin-add'),
  selectSkin: (id) => ipcRenderer.invoke('events:skin-select', id),
  changeSkinModel: (id, model) => ipcRenderer.invoke('events:skin-model', id, model),
  removeSkin: (id) => ipcRenderer.invoke('events:skin-remove', id),
  saveSettings: (settings) => ipcRenderer.invoke('events:save-settings', settings),
  install: () => ipcRenderer.invoke('events:install'),
  installPack: () => ipcRenderer.invoke('events:install-pack'),
  launch: (nickname) => ipcRenderer.invoke('events:launch', nickname),
  onProgress: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on('events:progress', wrapped);
    return () => ipcRenderer.removeListener('events:progress', wrapped);
  },
}));
