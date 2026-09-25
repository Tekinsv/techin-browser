'use strict';
// Preload for Techin's own UI only (never loaded into web pages).
// Exposes a tiny, fixed API; the main process validates every call again.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = { state: new Set(), event: new Set() };

ipcRenderer.on('techin:state', (_e, state) => {
  for (const fn of listeners.state) fn(state);
});
ipcRenderer.on('techin:event', (_e, name, data) => {
  for (const fn of listeners.event) fn(name, data);
});

contextBridge.exposeInMainWorld('techin', {
  cmd: (action, args) => ipcRenderer.invoke('techin:cmd', String(action), args ?? {}),
  onState: (fn) => {
    if (typeof fn === 'function') listeners.state.add(fn);
  },
  onEvent: (fn) => {
    if (typeof fn === 'function') listeners.event.add(fn);
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  log: (msg) => ipcRenderer.send('techin:log', String(msg))
});
