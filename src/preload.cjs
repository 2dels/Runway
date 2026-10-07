const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('runway', Object.freeze({
  getState: () => ipcRenderer.invoke('runway:state'),
  save: state => ipcRenderer.invoke('runway:save', state),
  importMonarch: () => ipcRenderer.invoke('runway:import-csv'),
  importMonarchSnapshot: () => ipcRenderer.invoke('runway:import-snapshot'),
  showYah: () => ipcRenderer.invoke('runway:open-projects'),
}));
