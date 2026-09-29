const { contextBridge, ipcRenderer } = require('electron');
// Worker preloads have no location in their isolated world. Inspect the main
// world's origin before exposing anything; ordinary pages receive no bridge.
const origin = contextBridge.executeInMainWorld({ func: () => globalThis.location?.href?.split('/').slice(0,3).join('/') });
if (origin === 'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn') {
  contextBridge.executeInMainWorld({
    func: (invoke, subscribe) => {
      const events = new Map();
      const event = name => {
        if (!events.has(name)) {
          const listeners = new Set();
          events.set(name, { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn), hasListeners: () => listeners.size > 0, dispatch: args => { for (const fn of [...listeners]) { try { fn(...args); } catch (e) { console.error(e); } } } });
        }
        return events.get(name);
      };
      const internalListeners = new Set();
      const internal = chrome.runtime.onMessage;
      const addInternal = internal.addListener.bind(internal), removeInternal = internal.removeListener.bind(internal);
      internal.addListener = fn => { internalListeners.add(fn); addInternal(fn); };
      internal.removeListener = fn => { internalListeners.delete(fn); removeInternal(fn); };
      const nativeMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      const panelMessages = new Set(['CIC_IFRAME_BRIDGE_INIT','CIC_IFRAME_TOOL_CALL','CIC_IFRAME_AGENT_STATE']);
      if (typeof window !== 'undefined' && location.pathname === '/sidepanel.html') chrome.runtime.sendMessage = (...args) => {
        if (!panelMessages.has(args[0]?.type)) return nativeMessage(...args);
        const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
        // A native round trip wakes the worker and proves its vendor listeners are ready.
        const result = nativeMessage({type:'check_native_host_status'}).then(()=>invoke('panel.message',[args[0]])).then(r=>{if(r.error)throw new Error(r.error);return r.value;});
        if (!callback) return result;
        result.then(callback,error=>{const previous=Object.getOwnPropertyDescriptor(chrome.runtime,'lastError');Object.defineProperty(chrome.runtime,'lastError',{configurable:true,value:{message:error.message}});try{callback();}finally{if(previous)Object.defineProperty(chrome.runtime,'lastError',previous);else delete chrome.runtime.lastError;}});
      };
      const externalListeners = new Set();
      const external = chrome.runtime.onMessageExternal;
      const addExternal = external.addListener.bind(external), removeExternal = external.removeListener.bind(external);
      external.addListener = fn => { externalListeners.add(fn); addExternal(fn); };
      external.removeListener = fn => { externalListeners.delete(fn); removeExternal(fn); };
      subscribe((name, args) => {
        if (name === 'dioptra-internal') {
          const [id,message,sender] = args;
          for (const fn of internalListeners) {
            try { const result=fn(message,sender,response=>invoke('panel.reply',[id,response]));
              if (result && typeof result.then === 'function') result.then(response=>{if(response!==undefined)invoke('panel.reply',[id,response]);},()=>invoke('panel.reply',[id,{ok:false,error:'Claude worker could not process the panel request.'}]));
            } catch { invoke('panel.reply',[id,{ok:false,error:'Claude worker could not process the panel request.'}]); }
          }
        } else if (name === 'dioptra-external') {
          const [id,message,sender] = args;
          for (const fn of externalListeners) fn(message,sender,response=>invoke('external.reply',[id,response]));
        } else events.get(name)?.dispatch(args);
      });
      const call = name => (...args) => {
        const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
        const result = invoke(name, args).then(r => { if (r.error) throw new Error(r.error); return r.value; });
        if (!callback) return result;
        result.then(value => callback(value), error => {
          // Match Chrome's callback error lifetime; promise calls reject normally.
          const previous = Object.getOwnPropertyDescriptor(chrome.runtime, 'lastError');
          Object.defineProperty(chrome.runtime, 'lastError', { configurable: true, value: { message: error.message } });
          try { callback(); } finally { if (previous) Object.defineProperty(chrome.runtime,'lastError',previous); else delete chrome.runtime.lastError; }
        });
      };
      const api = (name, methods, listeners = []) => {
        const obj = chrome[name] || (chrome[name] = {});
        for (const method of methods) obj[method] = call(`${name}.${method}`);
        for (const listener of listeners) obj[listener] = event(`${name}.${listener}`);
        return obj;
      };
      if (typeof window !== 'undefined') window.addEventListener('message', event => {
        if (event.origin !== 'https://claude.ai' || !['cic_sidepanel_ready','cic_sidepanel_logged_out','cic_sidepanel_cowork_unavailable'].includes(event.data?.type)) return;
        invoke('diagnostics.signal', [event.data.type]).catch(() => {});
      });
      const nativeScript=chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript=(details,callback)=>{
        const result=invoke('scripting.executeScript',[{...details,func:details.func?.toString()}]).then(r=>{
          if(r.error) throw new Error(r.error);
          return r.value.native ? nativeScript(details) : r.value.results;
        });
        if(!callback) return result;
        result.then(callback,error=>{
          const previous=Object.getOwnPropertyDescriptor(chrome.runtime,'lastError');
          Object.defineProperty(chrome.runtime,'lastError',{configurable:true,value:{message:error.message}});
          try{callback();}finally{if(previous)Object.defineProperty(chrome.runtime,'lastError',previous);else delete chrome.runtime.lastError;}
        });
      };
      api('debugger', ['attach', 'detach', 'sendCommand', 'getTargets'], ['onEvent', 'onDetach']);
      const groups = api('tabGroups', ['get', 'query', 'update']);
      groups.Color = Object.fromEntries(['GREY','BLUE','RED','YELLOW','GREEN','PINK','PURPLE','CYAN','ORANGE'].map(c => [c,c.toLowerCase()]));
      groups.TAB_GROUP_ID_NONE = -1;
      api('sidePanel', ['open', 'setOptions']);
      const identity = api('identity', ['launchWebAuthFlow']);
      identity.getRedirectURL = (path = '') => `https://${chrome.runtime.id}.chromiumapp.org/${path}`;
      api('tabs', ['query','get','getCurrent','create','update','remove','reload','goBack','goForward','group','ungroup','captureVisibleTab'], ['onActivated','onRemoved','onUpdated']);
      chrome.tabs.TAB_ID_NONE = -1;
      api('windows', ['get','getCurrent','getLastFocused','create','update','remove'], ['onRemoved']);
      const dnr = api('declarativeNetRequest', ['updateSessionRules']);
      dnr.RuleActionType = { MODIFY_HEADERS: 'modifyHeaders' };
      dnr.HeaderOperation = { SET: 'set', REMOVE: 'remove', APPEND: 'append' };
      dnr.ResourceType = { XMLHTTPREQUEST: 'xmlhttprequest', OTHER: 'other', WEBSOCKET: 'websocket' };
      api('action', ['getUserSettings','setBadgeBackgroundColor','setBadgeText','setBadgeTextColor','setTitle'], ['onClicked']);
      api('webNavigation', ['getAllFrames'], ['onBeforeNavigate','onCommitted','onCompleted']);
      api('notifications', ['create','clear'], ['onClicked']);
      api('downloads', ['download','search'], ['onChanged']);
      api('permissions', ['contains','remove'], ['onAdded','onRemoved']);
      api('commands', ['getAll'], ['onCommand']);
      chrome.runtime.openOptionsPage = call('runtime.openOptionsPage');
    },
    args: [
      (method, args) => ipcRenderer.invoke('claude-api', method, args),
      callback => ipcRenderer.on('claude-event', (_event, name, args) => callback(name, args))
    ]
  });
}
