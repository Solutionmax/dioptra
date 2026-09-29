const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('browser', {
  command: (action, data) => ipcRenderer.invoke('browser', action, data),
  onFocusFind: callback => ipcRenderer.on('focus-find', () => callback()),
  onPerformance: callback => ipcRenderer.on('performance', (_event, data) => callback(data)),
  onState: callback => ipcRenderer.on('state', (_event, data) => callback(data)),
  onFocusAddress: callback => ipcRenderer.on('focus-address', () => callback()),
  onNotice: callback => ipcRenderer.on('notice', (_event, data) => callback(data)),
  onAuth: callback => ipcRenderer.on('auth', (_event, data) => callback(data))
});
