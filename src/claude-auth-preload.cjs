const {contextBridge,ipcRenderer}=require('electron');
if (contextBridge.executeInMainWorld({func:()=>location.origin}) === 'https://claude.ai') {
  // Used by strict OAuth tabs and the hosted side-panel child frame. Main checks
  // the exact view, frame ancestry, origin and allowed message types separately.
  // Sandbox and context isolation stay enabled; no page receives Node/browser APIs.
  contextBridge.executeInMainWorld({func:invoke=>{
    const runtime = chrome.runtime || (chrome.runtime = {});
    runtime.sendMessage = (id,message,...rest) => {
      const callback = typeof rest.at(-1) === 'function' ? rest.at(-1) : null;
      const result = invoke(id,message);
      if (!callback) return result;
      result.then(callback,error=>{
        const previous=Object.getOwnPropertyDescriptor(runtime,'lastError');
        Object.defineProperty(runtime,'lastError',{configurable:true,value:{message:error.message}});
        try { callback(); } finally { if(previous) Object.defineProperty(runtime,'lastError',previous); else delete runtime.lastError; }
      });
    };
  },args:[(id,message)=>ipcRenderer.invoke('claude-auth',id,message)]});
}
