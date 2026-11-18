// Pont sécurisé entre les pages (régie) et l'application desktop.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presentor', {
  isDesktop: true,
  platform: process.platform,
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  openOutput: (id, displayId) => ipcRenderer.invoke('output:open', id, displayId),
  closeOutput: (id) => ipcRenderer.invoke('output:close', id),
  identifyDisplays: () => ipcRenderer.invoke('displays:identify'),
  onDisplaysChanged: (fn) => ipcRenderer.on('displays:changed', (e, list) => fn(list)),
});
