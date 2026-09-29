const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('attackResult',()=>ipcRenderer.invoke('claude-api','tabs.query',[{}]));
