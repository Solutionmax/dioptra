const { ipcMain, WebContentsView, Notification } = require('electron');
const { FOOTER_HEIGHT } = require('./core.cjs');
const ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const ORIGIN = `chrome-extension://${ID}`;
const { readClaudeDiagnostics } = require('./claude-diagnostics.cjs');
const { claudeFeatureHeaders } = require('./claude-network.cjs');

// One official extension, one Dioptra window. Chromium still owns extension
// messaging, storage, content scripts and permissions. Only missing APIs live here.
function createClaude({ session, authSession, window, tabs, current, newTab, activate, closeTab, openPanel, getPanel }) {
  if (process.env.DIOPTRA_CLAUDE_DEBUG) session.serviceWorkers.on('console-message', (_e,details) => console.error('CLAUDE WORKER',JSON.stringify(details)));
  const clients = new Set(), groups = new Map(), attached = new Set(), rules = new Map();
  let nextGroup = 1, nextDownload = 1, installed = false, extensionVersion = null;
  const panelPaths = new Map(), externalRequests = new Map(), internalRequests = new Map();
  let nextExternal = 1;
  let accessibilityScript = '';
  const notifications = new Map(), downloads = new Map();
  const interfaceSignals = new Set(['cic_sidepanel_ready','cic_sidepanel_logged_out','cic_sidepanel_cowork_unavailable']);
  let lastInterfaceSignal = null;
  const requests = {};
  const requestName = url => {
    const parsed = new URL(url);
    if (parsed.origin === 'https://api.anthropic.com' && parsed.pathname === '/api/bootstrap/features/claude_in_chrome') return 'features';
    if (parsed.origin === 'https://claude.ai' && parsed.pathname === '/cic/new') return 'newInterface';
  };
  const filter = { urls: ['https://api.anthropic.com/api/bootstrap/features/claude_in_chrome*', 'https://claude.ai/cic/new*'] };
  session.webRequest.onCompleted(filter, details => { const name = requestName(details.url); if (name) requests[name] = { client: requests[name]?.client, status: details.statusCode }; });
  session.webRequest.onErrorOccurred(filter, details => { const name = requestName(details.url); if (name) requests[name] = { client: requests[name]?.client, error: details.error }; });
  const cdpMethods = new Set(['Input.dispatchKeyEvent','Input.dispatchMouseEvent','Input.insertText','Network.disable','Network.enable','Page.captureScreenshot','Page.enable','Page.handleJavaScriptDialog','Runtime.enable','Runtime.evaluate']);
  const windowId = window.id;
  const all = () => [...tabs.values()];
  const find = id => { const tab = all().find(t => t.view.webContents.id === id); if (!tab) throw new Error('Unknown Dioptra tab.'); return tab; };
  const info = tab => ({ id: tab.view.webContents.id, windowId, index: all().indexOf(tab), active: current() === tab, highlighted: current() === tab, pinned: false, incognito: false, selected: current() === tab, url: tab.url, title: tab.title, status: tab.loading ? 'loading' : 'complete', groupId: tab.claudeGroup ?? -1, width: tab.view.getBounds().width, height: tab.view.getBounds().height });
  const windowInfo = (populate = false) => ({ id: windowId, focused: window.isFocused(), incognito: false, type: 'normal', state: window.isFullScreen() ? 'fullscreen' : window.isMaximized() ? 'maximized' : 'normal', ...window.getBounds(), ...(populate ? { tabs: all().map(info) } : {}) });
  const send = (name, ...args) => {
    for (const client of clients) { try { if (client.isDestroyed?.() || client.detached || client.url && !client.url.startsWith(`${ORIGIN}/`)) clients.delete(client); else client.send('claude-event', name, args); } catch { clients.delete(client); } }
  };
  const validURL = value => { const url = new URL(value); if (!['http:','https:','about:'].includes(url.protocol) || url.protocol === 'about:' && value !== 'about:blank') throw new Error('Only web page addresses are supported.'); return value; };
  const getWindow = id => { if (id !== undefined && ![windowId,-2].includes(id)) throw new Error('Unknown Dioptra window.'); return windowInfo(); };
  const handlers = {
    'scripting.executeScript': async details => {
      const tab=find(details?.target?.tabId), wc=tab.view.webContents;
      if(tab.mode !== 'live') return {native:true};
      if(!/^https?:/.test(wc.getURL())) throw new Error('Only web pages can be scripted.');
      if(details.target.documentIds || details.target.frameIds?.some(id=>id!==0) || details.target.allFrames && wc.mainFrame.frames.length) throw new Error('Live scripting currently supports the main frame only.');
      if(details.files || typeof details.func !== 'string' || !['ISOLATED','MAIN',undefined].includes(details.world)) throw new Error('Unsupported Live script injection.');
      const code=`(${details.func})(...${JSON.stringify(details.args || [])})`;
      // Live has a separate network/cookie session, outside Chromium's extension
      // tab registry. Keep vendor DOM helpers and script state isolated from the page.
      const result=details.world==='MAIN' ? await wc.executeJavaScript(code) : await wc.executeJavaScriptInIsolatedWorld(1004,[{code:`${accessibilityScript};\n${code}`}]);
      return {results:[{frameId:0,result}]};
    },
    'diagnostics.signal': signal => { if (interfaceSignals.has(signal)) lastInterfaceSignal = signal; },
    'external.reply': (id,response) => { const pending=externalRequests.get(id); if(pending) { clearTimeout(pending.timer); externalRequests.delete(id); pending.resolve(response); } },
    'tabs.query': query => all().map(info).filter(t => (query?.active === undefined || t.active === query.active) && (!query?.currentWindow || t.windowId === windowId) && (query?.windowId === undefined || [windowId,-2].includes(query.windowId)) && (query?.groupId === undefined || query.groupId === t.groupId) && (query?.url === undefined || (Array.isArray(query.url) ? query.url : [query.url]).some(pattern => new RegExp('^' + pattern.split('*').map(v => v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*') + '$').test(t.url)))),
    'tabs.get': id => info(find(id)),
    'tabs.getCurrent': () => undefined, // The extension panel is not a browser tab.
    'tabs.create': details => { const tab = newTab(validURL(details?.url || 'about:blank'), details?.active !== false); if (!tab) throw new Error('Tab limit reached.'); return info(tab); },
    'tabs.update': async (id, changes) => { if (typeof id === 'object') { changes = id; id = current().view.webContents.id; } const tab = find(id); if (changes.url) await tab.view.webContents.loadURL(validURL(changes.url)); if (changes.active) activate(tab.id); if (changes.muted !== undefined) tab.view.webContents.setAudioMuted(Boolean(changes.muted)); return info(tab); },
    'tabs.remove': ids => { for (const id of [].concat(ids)) closeTab(find(id).id); },
    'tabs.reload': (id, options) => { const wc = id === undefined ? current().view.webContents : find(id).view.webContents; options?.bypassCache ? wc.reloadIgnoringCache() : wc.reload(); },
    'tabs.goBack': id => { const h = find(id).view.webContents.navigationHistory; if (h.canGoBack()) h.goBack(); else throw new Error('No previous page.'); },
    'tabs.goForward': id => { const h = find(id).view.webContents.navigationHistory; if (h.canGoForward()) h.goForward(); else throw new Error('No next page.'); },
    'tabs.captureVisibleTab': async (id, options = {}) => { getWindow(id); const image = await current().view.webContents.capturePage(); return options.format === 'jpeg' ? `data:image/jpeg;base64,${image.toJPEG(options.quality ?? 90).toString('base64')}` : image.toDataURL(); },
    'tabs.group': options => { const members = [].concat(options.tabIds).map(find); let id = options.groupId; if (id === undefined) { id = nextGroup++; groups.set(id, { id, windowId, title: '', color: 'grey', collapsed: false }); } if (!groups.has(id)) throw new Error('Unknown tab group.'); for (const tab of members) { tab.claudeGroup = id; send('tabs.onUpdated', info(tab).id, { groupId: id }, info(tab)); } return id; },
    'tabs.ungroup': ids => { for (const id of [].concat(ids)) { const tab = find(id); tab.claudeGroup = -1; send('tabs.onUpdated', id, { groupId: -1 }, info(tab)); } },
    'tabGroups.get': id => { const group = groups.get(id); if (!group || !all().some(t => t.claudeGroup === id)) throw new Error('Unknown tab group.'); return group; },
    'tabGroups.query': query => [...groups.values()].filter(g => all().some(t => t.claudeGroup === g.id) && Object.entries(query || {}).every(([k,v]) => k === 'windowId' && v === -2 || g[k] === v)),
    'tabGroups.update': (id, changes) => { const group = handlers['tabGroups.get'](id); for (const key of ['title','color','collapsed']) if (changes[key] !== undefined) group[key] = changes[key]; return group; },
    'windows.get': (id, options) => { getWindow(id); return windowInfo(options?.populate); },
    'windows.getCurrent': options => windowInfo(options?.populate),
    'windows.getLastFocused': options => windowInfo(options?.populate),
    'windows.update': (id, options) => { getWindow(id); if (options.focused) window.focus(); if (['width','height','left','top'].some(k => options[k] !== undefined)) { const b = window.getBounds(); window.setBounds({ x: options.left ?? b.x, y: options.top ?? b.y, width: Math.max(960, options.width ?? b.width), height: Math.max(640, options.height ?? b.height) }); } return windowInfo(); },
    'windows.create': () => { throw new Error('Dioptra supports one browser window. Open a tab instead.'); },
    'windows.remove': () => { throw new Error('Close Dioptra using its window controls.'); },
    'debugger.attach': (target, version) => { const wc = find(target.tabId).view.webContents; if (attached.has(wc.id)) return; if (wc.debugger.isAttached()) throw new Error('Debugger already in use. Close Developer Tools and retry.'); wc.debugger.attach(version || '1.3'); attached.add(wc.id); },
    'debugger.detach': target => { const wc = find(target.tabId).view.webContents; if (attached.delete(wc.id)) wc.debugger.detach(); },
    'debugger.sendCommand': (target, method, params = {}) => { const wc = find(target.tabId).view.webContents; if (!attached.has(wc.id)) throw new Error('Debugger is not attached.'); if (!cdpMethods.has(method)) throw new Error(`Unsupported debugger command: ${method}`); return wc.debugger.sendCommand(method, params, target.sessionId); },
    'debugger.getTargets': () => all().map(t => ({ id: String(info(t).id), tabId: info(t).id, type: 'page', title: t.title, url: t.url, attached: attached.has(info(t).id) })),
    'sidePanel.open': options => { const tab = options?.tabId ? find(options.tabId) : current(); return openPanel(panelPaths.get(tab.view.webContents.id) || `sidepanel.html?tabId=${tab.view.webContents.id}`); },
    'sidePanel.setOptions': options => { if (options.path && !/^sidepanel\.html(?:\?tabId=\d+)?$/.test(options.path)) throw new Error('Unsupported panel path.'); if (options.path) panelPaths.set(options.tabId ?? current().view.webContents.id,options.path); },
    'action.getUserSettings': () => ({ isOnToolbar: true }),
    'action.setBadgeBackgroundColor': () => undefined,
    'action.setBadgeTextColor': () => undefined,
    'action.setBadgeText': () => undefined,
    'action.setTitle': () => undefined,
    'webNavigation.getAllFrames': ({tabId}) => find(tabId).view.webContents.mainFrame.framesInSubtree.map(f => ({ frameId: f === find(tabId).view.webContents.mainFrame ? 0 : f.routingId, parentFrameId: f.parent ? f.parent === find(tabId).view.webContents.mainFrame ? 0 : f.parent.routingId : -1, url: f.url, errorOccurred: false, processId:f.processId })),
    'permissions.contains': details => !(details.permissions || []).some(p => !['tabs','activeTab','scripting','debugger','tabGroups','storage','unlimitedStorage','sidePanel','alarms','notifications','webNavigation','downloads','identity','declarativeNetRequestWithHostAccess','offscreen'].includes(p)) && !(details.origins || []).some(o => !['<all_urls>','http://*/*','https://*/*'].includes(o)),
    'permissions.remove': () => { throw new Error('Remove Claude in Dioptra to revoke its browser access.'); },
    'notifications.create': (id, options) => { if (typeof id === 'object') { options = id; id = String(Date.now()); } const notification = new Notification({ title: options.title || 'Claude', body: options.message || '' }); notifications.set(id,notification); notification.on('click',()=>send('notifications.onClicked',id)); notification.on('close',()=>notifications.delete(id)); notification.show(); return id; },
    'notifications.clear': id => { const notification = notifications.get(id); notification?.close(); return Boolean(notification); },
    'downloads.download': options => new Promise((resolve,reject) => {
      validURL(options.url); if (!/^https?:/.test(options.url)) throw new Error('Only HTTP downloads are supported.');
      const wc = current().view.webContents;
      const timer = setTimeout(() => { wc.session.removeListener('will-download',listener); reject(new Error('Download did not start.')); },30000);
      const listener = (_event,item,owner) => {
        if (owner !== wc || !item.getURLChain().includes(options.url)) return;
        clearTimeout(timer); wc.session.removeListener('will-download',listener);
        const id = nextDownload++, record = { id, url:options.url, filename:item.getFilename(), state:'in_progress' }; downloads.set(id,record);
        item.once('done',(_e,state) => { record.state = state === 'completed' ? 'complete' : 'interrupted'; record.filename = item.getSavePath(); send('downloads.onChanged',{ id, state:{current:record.state,previous:'in_progress'} }); });
        resolve(id);
      };
      wc.session.on('will-download',listener); wc.downloadURL(options.url);
    }),
    'downloads.search': (query = {}) => [...downloads.values()].filter(d => query.id === undefined || d.id === query.id),
    'commands.getAll': () => [{ name: 'toggle-side-panel', description: 'Toggle Claude side panel', shortcut: '' }],
    'runtime.openOptionsPage': () => openPanel('options.html'),
    'declarativeNetRequest.updateSessionRules': changes => {
      for (const rule of changes.addRules || []) {
        if (rule.action.type !== 'modifyHeaders' || !rule.condition.urlFilter || rule.action.responseHeaders) throw new Error('Unsupported network rule.');
      }
      for (const id of changes.removeRuleIds || []) rules.delete(id);
      for (const rule of changes.addRules || []) rules.set(rule.id, rule);
    },
    'identity.launchWebAuthFlow': details => new Promise((resolve, reject) => {
      const url = new URL(details.url);
      if (url.protocol !== 'https:' || !['claude.ai','platform.claude.com'].includes(url.hostname)) return reject(new Error('Unsupported authentication provider.'));
      const view = new WebContentsView({ webPreferences: { session: authSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const wc = view.webContents;
      let finished = false;
      const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); window.contentView.removeChildView(view); wc.close(); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => finish(new Error('Authentication timed out. Sign in to Claude and try again.')), details.interactive ? 120000 : Math.min(details.timeoutMsForNonInteractive || 10000,30000));
      const check = (event, next) => { if (next.startsWith(`https://${ID}.chromiumapp.org/`)) { event.preventDefault(); finish(null,next); } };
      wc.on('will-redirect',check); wc.on('will-navigate',check);
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      if (details.interactive) { window.contentView.addChildView(view); const [width,height] = window.getContentSize(); view.setBounds({ x: 0, y: 132, width, height: height - 132 - FOOTER_HEIGHT }); }
      wc.loadURL(details.url).catch(e => { if (!finished && e.code !== 'ERR_ABORTED') finish(e); });
    })
  };
  const authorize = event => {
    if (!installed) return false;
    if (event.type === 'service-worker') return event.session === session && event.serviceWorker.scope === `${ORIGIN}/`;
    return event.sender.session === session && event.senderFrame?.url.startsWith(`${ORIGIN}/`);
  };
  const handleApi = async (event, method, args) => {
    if (!authorize(event)) return { error: 'Access denied.' };
    clients.add(event.type === 'service-worker' ? event.serviceWorker : event.senderFrame);
    try {
      if (method === 'panel.reply') {
        if (event.type !== 'service-worker') throw new Error('Access denied.');
        const pending=internalRequests.get(args?.[0]);
        if(pending){clearTimeout(pending.timer);internalRequests.delete(args[0]);pending.resolve(args[1]);}
        return {value:undefined};
      }
      if (method === 'panel.message') {
        const panel=getPanel(), message=args?.[0];
        if (event.type === 'service-worker' || !panel || event.sender !== panel || event.senderFrame !== panel.mainFrame || new URL(event.senderFrame.url).pathname !== '/sidepanel.html' || !['CIC_IFRAME_BRIDGE_INIT','CIC_IFRAME_TOOL_CALL','CIC_IFRAME_AGENT_STATE'].includes(message?.type)) throw new Error('Access denied.');
        if (![...clients].some(c=>c.scope === `${ORIGIN}/` && !c.isDestroyed())) await session.serviceWorkers.startWorkerForScope(`${ORIGIN}/`);
        const worker=[...clients].find(c=>c.scope === `${ORIGIN}/` && !c.isDestroyed());
        if(!worker) throw new Error('Claude worker is unavailable. Reopen Claude.');
        const value=await new Promise((resolve,reject)=>{
          const id=nextExternal++;
          const timer=setTimeout(()=>{internalRequests.delete(id);reject(new Error('Claude panel request timed out. Reopen Claude.'));},120000);
          internalRequests.set(id,{resolve,reject,timer});
          // A real Chrome sidepanel is an extension page, not a browser tab.
          // Keep vendor feature, account, consent and group checks in its worker.
          try {worker.send('claude-event','dioptra-internal',[id,message,{id:ID,origin:ORIGIN,url:panel.getURL(),frameId:0}]);}
          catch(error){clearTimeout(timer);internalRequests.delete(id);reject(error);}
        });
        return {value};
      }
 if (!Object.hasOwn(handlers,method) || !Array.isArray(args)) throw new Error('Unsupported Claude API.'); return { value: await handlers[method](...args) }; }
    catch (error) { return { error: error.message }; }
  };
  ipcMain.handle('claude-api',handleApi);
  session.serviceWorkers.on('running-status-changed',({versionId,runningStatus})=>{
    if (!['starting','running'].includes(runningStatus)) { for(const client of clients) if(client.versionId === versionId) clients.delete(client); return; }
    const worker=session.serviceWorkers.getWorkerFromVersionID(versionId);
    if (worker.scope !== `${ORIGIN}/`) return;
    worker.ipc.removeHandler('claude-api'); worker.ipc.handle('claude-api',handleApi);
    clients.add(worker);
  });
  ipcMain.handle('claude-auth', async (event,id,message) => {
    if (!installed || id !== ID || !event.senderFrame || new URL(event.senderFrame.url).origin !== 'https://claude.ai') throw new Error('Access denied.');
    const tab = all().find(t=>t.view.webContents === event.sender);
    const authTab = event.sender.session === authSession && tab && event.senderFrame === event.sender.mainFrame;
    const panel = getPanel();
    const panelFrame = event.sender.session === session && event.sender === panel && event.senderFrame.parent === panel.mainFrame && panel.mainFrame.url.startsWith(`${ORIGIN}/`) && new URL(panel.mainFrame.url).pathname === '/sidepanel.html';
    const allowed = authTab ? ['ping','oauth_redirect','get_sidepanel_host_info'] : panelFrame ? ['ping','get_sidepanel_host_info','open_options','set_locale'] : [];
    if (!allowed.includes(message?.type)) throw new Error('Access denied.');
    if (![...clients].some(c=>c.scope === `${ORIGIN}/` && !c.isDestroyed())) await session.serviceWorkers.startWorkerForScope(`${ORIGIN}/`);
    return new Promise((resolve,reject) => {
      const request = nextExternal++;
      const timer=setTimeout(()=>{externalRequests.delete(request);reject(new Error('Claude did not respond. Reopen the Claude panel and retry.'));},60000);
      externalRequests.set(request,{resolve,reject,timer});
      // Chrome omits sender.tab for a side-panel child frame. Electron's native
      // external messaging fabricates a tab here, hiding host identity/actions.
      send('dioptra-external',request,message,{origin:'https://claude.ai',url:event.senderFrame.url,...(authTab ? {tab:info(tab)} : {})});
    });
  });
  authSession.registerPreloadScript({type:'frame',filePath:require('node:path').join(__dirname,'claude-auth-preload.cjs')});
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (installed) for (const rule of rules.values()) {
      const c = rule.condition;
      const pattern = c.urlFilter.replace(/^\|/,'');
      const matches = new RegExp((c.urlFilter.startsWith('|') ? '^' : '') + pattern.split('*').map(v => v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')).test(details.url);
      if (!matches || c.resourceTypes && !c.resourceTypes.includes(details.resourceType === 'xhr' ? 'xmlhttprequest' : details.resourceType.toLowerCase())) continue;
      let initiator = '';
      try { initiator = new URL(details.referrer || details.frame?.url || '').hostname; } catch {}
      const domainMatch = d => initiator === d || initiator.endsWith('.' + d);
      if (c.initiatorDomains && !c.initiatorDomains.some(domainMatch) || c.excludedInitiatorDomains?.some(domainMatch)) continue;
      if (c.tabIds && !c.tabIds.includes(all().some(t => t.view.webContents.id === details.webContentsId) ? details.webContentsId : -1)) continue;
      // Header changes only reach Anthropic's endpoints, never a migration site.
      const hostname = new URL(details.url).hostname;
      if (!['api.anthropic.com','claude.ai','platform.claude.com'].includes(hostname) && !hostname.endsWith('.claude.ai')) continue;
      for (const header of rule.action.requestHeaders || []) {
        for (const key of Object.keys(headers)) if (key.toLowerCase() === header.header.toLowerCase() && ['set','remove'].includes(header.operation)) delete headers[key];
        if (header.operation === 'set') headers[header.header] = header.value;
        if (header.operation === 'append') headers[header.header] = headers[header.header] ? `${headers[header.header]}, ${header.value}` : header.value;
      }
    }
    const outgoing = claudeFeatureHeaders(details.url, headers, installed ? extensionVersion : null);
    if (installed && requestName(details.url) === 'features') {
      const value = name => Object.entries(outgoing).find(([key]) => key.toLowerCase() === name)?.[1];
      requests.features = { client: { platform: value('anthropic-client-platform') === 'claude_browser_extension' ? 'claude_browser_extension' : 'unexpected', version: value('anthropic-client-version') === extensionVersion ? extensionVersion : 'unexpected', browser: /Chrome\/[\d.]+/.exec(value('user-agent') || '')?.[0] } };
    }
    callback({ requestHeaders: outgoing });
  });
  function bind(tab) {
    const wc = tab.view.webContents;
    wc.debugger.on('message', (_event, method, params, sessionId) => { if (attached.has(wc.id)) send('debugger.onEvent', { tabId: wc.id, ...(sessionId ? { sessionId } : {}) }, method, params); });
    wc.debugger.on('detach', (_event, reason) => { if (attached.delete(wc.id)) send('debugger.onDetach', { tabId: wc.id }, reason); });
    wc.on('page-title-updated', (_e,title) => send('tabs.onUpdated',wc.id,{title},{...info(tab),title}));
    wc.on('did-start-navigation', (_e,url,inPlace,main) => { if (main && !inPlace) send('webNavigation.onBeforeNavigate',{ tabId:wc.id, frameId:0, url, timeStamp:Date.now() }); });
    wc.on('did-navigate', (_e,url) => send('webNavigation.onCommitted',{ tabId:wc.id, frameId:0, url, timeStamp:Date.now(), transitionType:'link', transitionQualifiers:[] }));
    wc.on('did-finish-load', () => send('webNavigation.onCompleted',{ tabId:wc.id, frameId:0, url:wc.getURL(), timeStamp:Date.now() }));
    for (const event of ['did-navigate','did-stop-loading']) wc.on(event, () => { if (!wc.isDestroyed()) send('tabs.onUpdated', wc.id, { url: tab.url, status: tab.loading ? 'loading' : 'complete' }, info(tab)); });
    const id = wc.id;
    wc.once('destroyed', () => { attached.delete(id); send('tabs.onRemoved', id, { windowId, isWindowClosing: window.isDestroyed() }); });
  }
  return {
    async diagnostics(wc) {
      if (!installed || !wc.getURL().startsWith(`${ORIGIN}/`)) throw new Error('Open Claude before checking it.');
      return { ...await wc.executeJavaScript(`(${readClaudeDiagnostics.toString()})()`), lastInterfaceSignal, requests: { ...requests } };
    },
    resetDiagnostics() { lastInterfaceSignal = null; for (const key of Object.keys(requests)) delete requests[key]; },
    async load(directory) {
      // Read before loadExtension starts the worker, so its first request also
      // carries the installed version rather than an empty/default identity.
      const manifest = JSON.parse(await require('node:fs/promises').readFile(require('node:path').join(directory, 'manifest.json'), 'utf8'));
      const treeFile=manifest.content_scripts?.flatMap(script=>script.js || []).find(file=>/^assets\/accessibility-tree\.js-[\w-]+\.js$/.test(file));
      accessibilityScript=treeFile ? await require('node:fs/promises').readFile(require('node:path').join(directory,treeFile),'utf8') : '';
      extensionVersion = typeof manifest.version === 'string' ? manifest.version : null;
      installed = true;
      try { const extension = await session.extensions.loadExtension(directory); if (extension.id !== ID) { session.extensions.removeExtension(extension.id); throw new Error('Not the official Claude extension.'); } return extension; }
      catch(e) { installed = false; extensionVersion = null; throw e; }
    },
    remove() { installed = false; for(const pending of internalRequests.values()){clearTimeout(pending.timer);pending.reject(new Error('Claude was removed.'));}internalRequests.clear(); for (const pending of externalRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Claude was removed.')); } externalRequests.clear(); for (const t of all()) if (attached.has(t.view.webContents.id)) t.view.webContents.debugger.detach(); attached.clear(); rules.clear(); clients.clear(); session.extensions.removeExtension(ID); },
    bind,
    clicked(tab) { send('action.onClicked',info(tab)); },
    activate(tab) { send('tabs.onActivated', { tabId: tab.view.webContents.id, windowId }); },
    origin: ORIGIN
  };
}
module.exports = { createClaude, ID, ORIGIN };
