const { createLiveProxy } = require('./live-proxy.cjs');
const { createLibrary } = require('./library.cjs');
const { randomUUID } = require('node:crypto');
const { shareClaudeSession } = require('./claude-session.cjs');
const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, Menu, clipboard, shell } = require('electron');
const path = require('node:path');
const dns = require('node:dns').promises;
const fs = require('node:fs/promises');
const { createClaude } = require('./claude.cjs');
const { installClaude, directoryName } = require('./claude-install.cjs');
const { pathToFileURL } = require('node:url');
const { ROUTE_BAR_HEIGHT, DEFAULT_UPDATE_FEED, RELEASE_PAGE, devtoolsLayout, validateRules, resolverRules, navigationURL, readSettings, saveSettings } = require('./core.cjs');
const { fetchDocument, buildReport, summaryText } = require('./differences.cjs');

// Keep the original profile through the Hostlane and Dioptra renames.
app.setPath('userData', path.join(app.getPath('appData'), 'Migratiebrowser'));
app.setName('Dioptra');
// Log main-process errors; never block shutdown with Electron's modal error dialog.
process.on('uncaughtException', error => {
  console.error('Dioptra main process error:', error?.stack || error);
  if (quitting) app.exit(0); else dialog.showErrorBox('Dioptra error', String(error?.stack || error).slice(0, 2000));
});
process.on('unhandledRejection', reason => console.error('Dioptra unhandled rejection:', reason?.stack || reason));
const profileArg = process.argv.find(v => v.startsWith('--profile-dir='));
if (profileArg) app.setPath('userData', path.resolve(profileArg.slice(14)));
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
let config;
try { config = readSettings(settingsFile); } catch (error) {
  dialog.showErrorBox('Unable to read settings', `${settingsFile}\n\n${error.message}\nThe file was not overwritten. Repair it or rename it to start fresh.`);
  app.exit(1);
}
const activeSSL = config.sslVerification;
const activeRules = structuredClone(config.rules);
const activeResolver = resolverRules(activeRules);
let savedResolver = activeResolver;
app.commandLine.appendSwitch('host-resolver-rules', activeResolver);
// Direct connections keep domain overrides authoritative, even on a machine with a system proxy.
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('lang', 'en-US');
app.enableSandbox();
const uiURL = pathToFileURL(path.join(__dirname, 'index.html')).href;
let win, webSession, claudeAuthSession, activeId, panel = null, nextId = 1, quitting = false, authRequest = null;
// macOS builds are ad-hoc signed: electron-updater cannot install them, so the notice links to the download page.
const canInstall = process.platform !== 'darwin';
const freshUpdate = message => ({ status: 'idle', message, canInstall, version: '' });
let updateState = freshUpdate('Not checked yet.');
const updateFeed = () => config.updateFeed || DEFAULT_UPDATE_FEED;
let manualUpdate = false;
let updater, checkingUpdate = false, draggingTools = false, toolsLayout = null;
let lastSavedSettings = JSON.stringify(config);
let claude, claudeView, claudeState = { status: 'absent', message: 'Install Claude to use it inside Dioptra.' };
let claudeReport;
let comparing = false, viewMode = 'single', livePromise = null, diffRun = null;
let differences = { status: 'idle', report: null, error: '' };
let liveSession, liveProxy, library, comparison = null, paneLayout = [];
let performance = {memoryKB:null,processes:0};
function samplePerformance() {
  try {
    const metrics=app.getAppMetrics();
    const memory=metrics.map(p=>p.memory?.workingSetSize);
    performance={memoryKB:memory.length && memory.every(n=>Number.isFinite(n)&&n>=0) ? memory.reduce((sum,n)=>sum+n,0) : null,processes:metrics.length};
  } catch {performance={memoryKB:null,processes:0};}
  if(win && !win.isDestroyed()) win.webContents.send('performance',performance);
}
let findState = { open: false, text: '', matches: 0, active: 0 };
const closedTabs = [], downloadItems = new Map();
const visibleComparison = () => comparison && [comparison.host, comparison.live].includes(activeId) ? comparison : null;
function protectedHost(host) { return ['claude.ai','claude.com','anthropic.com','claudeusercontent.com','google.com','googleapis.com','gstatic.com','apple.com','microsoftonline.com'].some(domain => host === domain || host.endsWith('.' + domain)); }
function certificatePolicy(ses) { ses.setCertificateVerifyProc((request, callback) => callback(activeSSL || protectedHost(request.hostname.toLowerCase()) ? -3 : 0)); }
function route(tab) {
  let host = ''; try { host = new URL(tab.url).hostname; } catch {}
  const rule = tab.mode === 'hostfile' && activeRules.find(r => r.enabled && r.domain === host);
  return { label: rule ? 'HOSTFILE' : 'LIVE', configured: rule?.ip || '', host, ssl: !tab.url.startsWith('https:') ? 'HTTP · no TLS' : activeSSL || protectedHost(host) || tab.mode === 'auth' ? 'SSL checks on' : 'SSL checks off' };
}
const tabs = new Map();
const current = () => tabs.get(activeId);
const pending = () => savedResolver !== activeResolver || config.sslVerification !== activeSSL;
function persist() {
  config.tabs = [...tabs.values()].map(t => (t.view.webContents.session === webSession && /^https?:\/\//i.test(t.url) ? t.url : 'about:blank'));
  if (!config.tabs.length) config.tabs = ['about:blank'];
  const serialized = JSON.stringify(config);
  if (serialized !== lastSavedSettings) { saveSettings(settingsFile, config); lastSavedSettings = serialized; }
}
function state() {
  return { view: visibleComparison() ? 'compare' : viewMode, routeBarHeight: visibleComparison() ? 0 : ROUTE_BAR_HEIGHT, differences: viewMode === 'differences' ? differences : { ...differences, report: null }, performance, comparison: visibleComparison(), paneLayout, find: findState, sslVerification: config.sslVerification, activeSSL, library: library?.snapshot() || {bookmarks:[],history:[],downloads:[]}, downloads: [...downloadItems.values()].map(d=>d.record), tabs: [...tabs.values()].map(t => ({ mode: t.mode, route: route(t), connection: t.connection, id: t.id, title: t.title, url: t.url, startPage: t.startPage, loading: t.loading, devtools: Boolean(t.toolsOpen), error: t.error, back: t.view.webContents.navigationHistory.canGoBack(), forward: t.view.webContents.navigationHistory.canGoForward() })), activeId, rules: config.rules, activeRules, pending: pending(), panel, versions: { app: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome }, updateFeed: updateFeed(), autoUpdates: config.autoUpdates, update: updateState, devtoolsDock: config.devtoolsDock, devtoolsRatio: config.devtoolsRatio, toolsLayout, draggingTools, claude: claudeState };
}
function emit() {
  // Tab views are destroyed while quitting; state() must not touch them then.
  if (!quitting && win && !win.isDestroyed()) win.webContents.send('state', state());
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const sidebar = panel ? Math.min(480, Math.floor(width * .48)) : 0;
  if (claudeView) { claudeView.setBounds({ x: width - sidebar, y: 132, width: Math.max(1, sidebar), height: Math.max(1,height - 162) }); claudeView.setVisible(panel === 'claude' && !authRequest && !draggingTools); }
  toolsLayout = null; paneLayout = [];
  const pair = visibleComparison(), differing = !pair && viewMode === 'differences';
  for (const tab of tabs.values()) {
    const selected = pair ? [pair.host, pair.live].includes(tab.id) : tab.id === activeId;
    const visible = selected && !authRequest && !draggingTools && !differing;
    const bounds = devtoolsLayout(width, height, sidebar, config.devtoolsDock, config.devtoolsRatio, !pair && tab.toolsOpen);
    if (pair) { const half = Math.floor(bounds.page.width / 2); bounds.page.x = tab.id === pair.live ? half + 2 : 0; bounds.page.width = tab.id === pair.live ? bounds.page.width - half - 2 : half - 2; }
    if (findState.open) { bounds.page.y += 38; bounds.page.height -= 38; }
    // The route bar(s) fill the last 36px of the header, above the pages: one full width bar, or one bar per pane when comparing.
    const banner = { x: pair ? bounds.page.x : 0, y: 132 - ROUTE_BAR_HEIGHT, width: pair ? bounds.page.width : Math.max(1, width - sidebar), height: ROUTE_BAR_HEIGHT };
    if (selected && !differing) paneLayout.push({ id: tab.id, page: {...bounds.page}, banner });
    tab.view.setBounds(bounds.page);
    tab.view.setVisible(visible && !tab.startPage && !tab.error);
    if (tab.tools && bounds.tools) {
      tab.tools.setBounds(bounds.tools);
      tab.tools.setVisible(visible && Boolean(tab.toolsOpen));
    } else if (tab.tools) tab.tools.setVisible(false);
    if (tab.id === activeId && tab.toolsOpen && !pair && !authRequest) toolsLayout = bounds;
  }
}
function activate(id) {
  if (!tabs.has(id)) return;
  if (activeId !== id) { closeFind(); viewMode = 'single'; }
  activeId = id;
  layout(); emit();
  const tab = current();
  claude?.activate(tab);
  if (tab.url !== 'about:blank' && !tab.error) tab.view.webContents.focus();
}
function failure(tab, message) { tab.connection = null; tab.error = message; tab.loading = false; layout(); emit(); }
function allowed(url) { return url === 'about:blank' || /^https?:\/\//i.test(url); }
function handleShortcut(event,input,tab=current()) {
  if(!tab) return; const wc=tab.view.webContents;
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (mod && key === 'l') { event.preventDefault(); focusAddress(); }
    if (mod && key === 'r') { event.preventDefault(); input.shift ? wc.reloadIgnoringCache() : wc.reload(); }
    if (mod && key === 't') { event.preventDefault(); if(input.shift) reopenTab(); else {newTab(); focusAddress();} }
    if (mod && key === 'f') { event.preventDefault(); openFind(); }
    if (mod && key === 'd') { event.preventDefault(); bookmarkCurrent(); }
    if (input.key === 'Escape' && findState.open) {event.preventDefault();closeFind();layout();emit();}
    if (mod && key === 'w') { event.preventDefault(); closeTab(tab.id); }
    if (input.key === 'F12') { event.preventDefault(); toggleDevTools(tab); }
}
function bindTab(view, initial = 'about:blank', load = true, foreground = true) {
  const tab = { mode: view.webContents.session === liveSession ? 'live' : view.webContents.session === claudeAuthSession ? 'auth' : 'hostfile', connection: null, id: nextId++, view, url: initial, startPage: load && initial === 'about:blank', title: 'New tab', loading: false, error: '' };
  tabs.set(tab.id, tab); win.contentView.addChildView(view);
  const wc = view.webContents;
  claude?.bind(tab);
  wc.on('focus', () => { if (visibleComparison() && activeId !== tab.id) activate(tab.id); });
  wc.on('found-in-page', (_event,result) => { if (tab.id === activeId && findState.open) { findState.matches=result.matches; findState.active=result.activeMatchOrdinal; emit(); } });
  wc.on('page-title-updated', (_event, title) => { tab.title = title || 'New tab'; emit(); });
  wc.on('did-start-loading', () => { tab.loading = true; emit(); });
  wc.on('did-stop-loading', () => { tab.loading = false; if (!tab.error && allowed(wc.getURL())) { tab.url = wc.getURL(); if(tab.mode !== 'auth') library.visit(tab.url, wc.getTitle()); persist(); } emit(); });
  wc.on('did-start-navigation', (_event, url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) { if (tab.id === activeId) viewMode = 'single'; tab.navStart = Date.now(); tab.connection = null; tab.url = url; if (url !== 'about:blank') tab.startPage = false; tab.error = ''; layout(); emit(); }
  });
  const navigated = (_event, url) => { tab.url = url; tab.error = ''; persist(); layout(); emit(); };
  wc.on('did-navigate', navigated);
  wc.on('did-redirect-navigation', (_event,url,_inPlace,isMainFrame) => {if(isMainFrame){tab.url=url;tab.connection=null;emit();}});
  wc.on('did-navigate-in-page', (event, url, main) => { if (main) navigated(event, url); });
  for (const name of ['will-navigate', 'will-redirect']) wc.on(name, (event, url) => { if (!allowed(url)) { event.preventDefault(); failure(tab, 'Unsupported address type. Use http or https.'); } });
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code === -3 && tab.url === url && allowed(wc.getURL())) { tab.url = wc.getURL(); persist(); emit(); }
    if (isMainFrame && code !== -3) { tab.url = url; failure(tab, `${description} (${code})`); }
  });
  wc.once('destroyed', () => {
    if (quitting || !tabs.has(tab.id)) return;
    if (authRequest?.webContentsId === wc.id) finishAuth(null);
    if (comparison && [comparison.host, comparison.live].includes(tab.id)) comparison = null;
    disposeDevTools(tab); tabs.delete(tab.id); win.contentView.removeChildView(tab.view);
    if (!tabs.size) newTab();
    else if (activeId === tab.id) activate([...tabs.keys()].at(-1));
    layout(); persist(); emit();
  });
  wc.on('render-process-gone', (_event, details) => failure(tab, `Page stopped: ${details.reason}. Reload to try again.`));
  wc.on('before-input-event', (event,input) => handleShortcut(event,input,tab));
  wc.setWindowOpenHandler(details => {
    if (tabs.size >= 50) { win.webContents.send('notice', 'Up to 50 tabs at once. Close a tab first.'); return { action: 'deny' }; }
    if (!allowed(details.url)) return { action: 'deny' };
    return { action: 'allow', createWindow: options => {
      const child = new WebContentsView({ webContents: options.webContents, webPreferences: { ...options.webPreferences, session: wc.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, preload: undefined } });
      const created = bindTab(child, details.url, !options.webContents);
      activate(created.id);
      return child.webContents;
    } };
  });
  wc.on('context-menu', (_event, info) => {
    const items = [];
    if (info.linkURL && allowed(info.linkURL)) items.push({ label: 'Open link in new tab', click: () => newTab(info.linkURL, true, tab.mode) });
    if (info.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (info.selectionText) items.push({ role: 'copy' });
    items.push({ label: 'Inspect', click: () => { toggleDevTools(tab, true); wc.inspectElement(info.x, info.y); } });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  if (load) wc.loadURL(initial).catch(error => { if (error.code !== 'ERR_ABORTED') failure(tab, error.message); });
  if (foreground) activate(tab.id); else layout(); persist(); return tab;
}
function newTab(url = 'about:blank', foreground = true, mode = 'hostfile') {
  if (tabs.size >= 50) { win.webContents.send('notice', 'Up to 50 tabs at once. Close a tab first.'); return null; }
  const targetSession = /^https:\/\/claude\.ai\/oauth\//.test(url) ? claudeAuthSession : mode === 'live' ? liveSession : webSession;
  return bindTab(new WebContentsView({ webPreferences: { session: targetSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } }), navigationURL(url), true, foreground);
}
function closeTab(id) {
  const tab = tabs.get(id); if (!tab) return;
  if (tab.mode !== 'auth' && /^https?:/.test(tab.url)) { closedTabs.push({url:tab.url,mode:tab.mode}); if(closedTabs.length>25) closedTabs.shift(); }
  if (comparison && [comparison.host, comparison.live].includes(id)) comparison = null;
  if (authRequest?.webContentsId === tab.view.webContents.id) finishAuth(null);
  disposeDevTools(tab); win.contentView.removeChildView(tab.view); tabs.delete(id); tab.view.webContents.close();
  if (!tabs.size) newTab();
  else if (activeId === id) activate([...tabs.keys()].at(-1));
  layout(); persist(); emit();
}
function toggleDevTools(tab = current(), forceOpen = false) {
  if (!tab) return;
  if (visibleComparison()) { comparison = null; layout(); }
  tab.toolsOpen = forceOpen || !tab.toolsOpen;
  if (!tab.tools && tab.toolsOpen) {
    const tools = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    tab.tools = tools;
    win.contentView.addChildView(tools);
    const wc = tab.view.webContents;
    wc.setDevToolsWebContents(tools.webContents);
    tools.webContents.once('destroyed', () => {
      if (tab.tools !== tools) return;
      tab.tools = null; tab.toolsOpen = false;
      win.contentView.removeChildView(tools); layout(); emit();
    });
    wc.openDevTools({ mode: 'detach', activate: true });
  }
  // Keep the inspector attached while its panel is hidden. Electron's native
  // open/close state is unreliable with a custom DevTools WebContentsView.
  layout(); emit();
}
function disposeDevTools(tab) {
  const tools = tab.tools;
  if (!tools) return;
  tab.tools = null; tab.toolsOpen = false;
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.closeDevTools();
  win.contentView.removeChildView(tools);
  if (!tools.webContents.isDestroyed()) tools.webContents.close();
}
async function openClaudePanel(page) {
  page ||= `sidepanel.html?tabId=${current()?.view.webContents.id}`;
  if (claudeState.status !== 'ready') return;
  if (!claudeView) {
    claudeView = new WebContentsView({ webPreferences: { session: webSession, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, preload: path.join(__dirname, 'claude-auth-preload.cjs') } });
    win.contentView.addChildView(claudeView);
    const view = claudeView;
    view.webContents.once('destroyed', () => { if (claudeView !== view) return; claudeView = null; if (!quitting) { win.contentView.removeChildView(view); if (panel === 'claude') panel = null; layout(); emit(); } });
    claudeView.webContents.setWindowOpenHandler(({url}) => { if (/^https?:\/\//i.test(url)) newTab(url); return { action: 'deny' }; });
    claudeView.webContents.on('will-navigate', (event,url) => { if (!url.startsWith(claude.origin + '/')) { event.preventDefault(); if (/^https?:\/\//i.test(url)) newTab(url); } });
  }
  const url = `${claude.origin}/${page}`;
  if (claudeView.webContents.getURL() !== url) await claudeView.webContents.loadURL(url);
  panel = 'claude'; layout(); emit();
}
function closeFind() {
  if (current() && !current().view.webContents.isDestroyed()) current().view.webContents.stopFindInPage('clearSelection');
  findState = { open:false, text:'', matches:0, active:0 };
}
function openFind() { findState.open = true; layout(); emit(); win.webContents.focus(); win.webContents.send('focus-find'); }
function bookmarkCurrent() { const tab=current(); if(tab && /^https?:/.test(tab.url)) { try {library.bookmark(tab.url,tab.title);emit();} catch(error) {win.webContents.send('notice',error.message);} } }
function reopenTab() { const saved=closedTabs.pop(); if(saved) newTab(saved.url,true,saved.mode === 'live' && liveSession ? 'live' : 'hostfile'); }
function ensureLive() {
  // Live compare uses its own session through a local SOCKS5 proxy with normal OS DNS.
  livePromise ||= (async () => {
    liveProxy=await createLiveProxy();
    liveSession=session.fromPartition('live-comparison', {cache:false});
    await liveSession.setProxy({ mode:'fixed_servers', proxyRules:liveProxy.url, proxyBypassRules:'<-loopback>' });
    certificatePolicy(liveSession); observeConnections(liveSession); setupWebsiteSession(liveSession);
  })().catch(error => { livePromise=null; throw error; });
  return livePromise;
}
function stopCompare() { const pair=comparison; comparison=null; if(pair) {activate(pair.host);closeTab(pair.live);} layout(); }
// The tab that Compare and Differences work on: a Hostfile tab on a domain with an active rule.
function ruledTab(what) {
  const tab=visibleComparison() ? tabs.get(comparison.host) : current();
  if (!tab || tab.mode !== 'hostfile' || !/^https?:/.test(tab.url)) throw new Error(`Open a website in a Hostfile tab to ${what} it.`);
  const rule=activeRules.find(r=>r.enabled && r.domain===new URL(tab.url).hostname);
  if (!rule) throw new Error('Add and apply a domain rule for this website first.');
  return { tab, rule };
}
async function setView(mode) {
  if (mode === 'single') { if (visibleComparison()) stopCompare(); viewMode='single'; layout(); return; }
  if (mode !== 'differences') throw new Error('Unknown view.');
  const { tab, rule } = ruledTab('compare');
  if (visibleComparison()) stopCompare();
  closeFind(); viewMode='differences'; layout(); emit();
  if (differences.report?.url !== tab.url || differences.report?.hostfile?.ip !== rule.ip || differences.status === 'error') runDifferences().catch(() => {});
}
function runDifferences() {
  const { tab, rule } = ruledTab('compare'), url = tab.url;
  if (diffRun?.url === url) return diffRun.promise;
  const mine = { url };
  differences = { status: 'running', report: null, error: '' }; emit();
  mine.promise = (async () => {
    try {
      await ensureLive();
      const { hostname, port, protocol } = new URL(url);
      const [hostfile, live] = await Promise.all([fetchDocument(webSession, url), fetchDocument(liveSession, url)]);
      let liveIP = liveProxy.addresses(hostname, Number(port || (protocol === 'https:' ? 443 : 80)))[0] || '';
      if (!liveIP) liveIP = (await dns.lookup(hostname).catch(() => null))?.address || '';
      const report = buildReport({ url, hostfile: { ...hostfile, ip: rule.ip }, live: { ...live, ip: liveIP } });
      if (diffRun === mine) differences = { status: 'done', report, error: '' };
      return report;
    } catch (error) { if (diffRun === mine) differences = { status: 'error', report: null, error: error.message }; throw error; }
    finally { if (diffRun === mine) diffRun = null; emit(); }
  })();
  diffRun = mine; return mine.promise;
}
async function clearSiteData() {
  const tab = current(); let url; try { url = new URL(tab.url); } catch {}
  if (!url || !/^https?:$/.test(url.protocol)) throw new Error('Open a website first.');
  if (tab.mode === 'auth' || protectedHost(url.hostname.toLowerCase())) throw new Error('Site data for Claude and account sign-in sites is protected and is not cleared here.');
  const wc = tab.view.webContents, ses = wc.session;
  await wc.executeJavaScript('try{sessionStorage.clear()}catch{}').catch(() => {});
  await ses.clearStorageData({ origin: url.origin, storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'websql', 'filesystem'] });
  await ses.clearData({ origins: [url.origin], dataTypes: ['cache'] });
  for (const c of await ses.cookies.get({ url: url.origin })) await ses.cookies.remove(`http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path}`, c.name);
  tab.error = ''; layout(); wc.reloadIgnoringCache();
  return url.hostname;
}
async function compare() {
  if(comparing || visibleComparison()) return;
  comparing=true;
  try {
  const tab=current();
  if (!tab || tab.mode !== 'hostfile' || !/^https?:/.test(tab.url)) throw new Error('Open a website in a Hostfile tab to compare it.');
  if (!activeRules.some(r=>r.enabled && r.domain===new URL(tab.url).hostname)) throw new Error('Add and apply a domain rule for this website first.');
  if (tabs.size>=50) throw new Error('Close a tab before comparing.');
  if (comparison && tabs.has(comparison.live)) closeTab(comparison.live);
  await ensureLive();
  if(tabs.get(tab.id)!==tab || current()!==tab) return;
  closeFind(); viewMode='single';
  tab.toolsOpen=false;
  const live=newTab(tab.url,false,'live');
  // A comparison opened during a Claude conversation stays in its anchor group.
  live.claudeGroup=tab.claudeGroup;
  comparison={host:tab.id,live:live.id}; activeId=tab.id; panel=null; layout();emit();
  } finally { comparing=false; }
}
function observeConnections(ses) {
  // Does not replace Claude's onCompleted/onBeforeSendHeaders handlers.
  ses.webRequest.onResponseStarted(details => {
    if (details.resourceType !== 'mainFrame' || details.statusCode >= 300 && details.statusCode < 400 && details.statusCode !== 304) return;
    const tab=[...tabs.values()].find(t=>t.view.webContents?.id===details.webContentsId);
    if (!tab) return;
    let ip=details.ip || '', source='response';
    if (ses===liveSession) {
      const u=new URL(details.url);
      ip=liveProxy.addresses(u.hostname, Number(u.port || (u.protocol==='https:'?443:80))).join(', ');
      source='active server connections';
    }
    tab.connection={url:details.url,ip:details.fromCache ? '' : ip,fromCache:Boolean(details.fromCache),source,status:details.statusCode,ms:tab.navStart ? Date.now()-tab.navStart : 0}; emit();
  });
}
function setupWebsiteSession(ses) {
  ses.setPermissionCheckHandler(()=>false);
  ses.setPermissionRequestHandler(async (wc,permission,callback,details)=>{
    if(![...tabs.values()].some(t=>t.view.webContents===wc) || !['media','geolocation','notifications','clipboard-read','fullscreen','pointerLock'].includes(permission)) return callback(false);
    const answer=await dialog.showMessageBox(win,{type:'question',message:'Website requests permission',detail:`${details.requestingUrl || wc.getURL()}\n\n${permission}`,buttons:['Deny','Allow once'],defaultId:0,cancelId:0});callback(answer.response===1);
  });
  ses.on('will-download', (_event,item)=>{
    item.setSaveDialogOptions({title:'Save file',defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))});
    const id=randomUUID();
    const record={id,name:item.getFilename(),url:item.getURL(),path:'',state:'progressing',received:0,total:item.getTotalBytes(),paused:false,canResume:false};
    downloadItems.set(id,{item,record}); library.download(record);
    let lastEmit=0;
    const update=(status,terminal=false)=>{
      Object.assign(record,{path:item.getSavePath(),state:status,received:item.getReceivedBytes(),total:item.getTotalBytes(),paused:item.isPaused(),canResume:!terminal&&item.canResume()});
      if(terminal){library.download(record);downloadItems.delete(id);}
      if(terminal||Date.now()-lastEmit>150){lastEmit=Date.now();emit();}
    };
    item.on('updated',(_e,status)=>update(status));
    item.once('done',(_e,status)=>update(status,true));emit();
  });
}

function focusAddress() { win.webContents.focus(); win.webContents.send('focus-address'); }
function finishAuth(data) {
  if (!authRequest) return;
  const request = authRequest; authRequest = null;
  clearTimeout(request.timer);
  if (data) request.callback(String(data.username || ''), String(data.password || ''));
  else request.callback();
  win.webContents.send('auth', null); layout();
}
function setupUpdater() {
  if (!app.isPackaged) return;
  if (!updater) {
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
    const set = (status, message, details = {}) => { updateState = { ...updateState, status, message, ...details }; if (manualUpdate && ['available', 'downloaded'].includes(status)) { panel = 'updates'; layout(); } emit(); };
    updater.on('checking-for-update', () => set('checking', 'Checking for updates…'));
    updater.on('update-available', info => set('available', `Version ${info.version} is available.`, { version: info.version, progress: 0, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : (info.releaseNotes || []).map(n => n.note).join('\n') }));
    updater.on('update-not-available', () => set('current', 'You are running the latest available version.'));
    updater.on('download-progress', info => set('downloading', `Downloading: ${Math.round(info.percent)}%`, { progress: info.percent }));
    updater.on('update-downloaded', () => set('downloaded', 'Update ready. Restart to install.'));
    updater.on('error', error => set('error', `Update failed: ${error.message}`));
  }
  updater.setFeedURL({ provider: 'generic', url: updateFeed() });
}
async function checkForUpdates(manual = false) {
  if (checkingUpdate || ['available', 'downloading', 'downloaded'].includes(updateState.status)) return;
  setupUpdater();
  if (!updater) return;
  manualUpdate = manual; checkingUpdate = true;
  try { await updater.checkForUpdates(); } finally { checkingUpdate = false; }
}
ipcMain.handle('browser', async (event, action, data) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('Access denied.');
  try {
    const tab = current();
    if (viewMode !== 'single' && ['navigate', 'new-tab', 'back', 'forward', 'reload', 'hard-reload', 'compare'].includes(action)) { viewMode = 'single'; layout(); }
    switch (action) {
      case 'state': return { ok: true, state: state() };
      case 'compare': await compare(); break;
      case 'stop-compare': stopCompare(); break;
      case 'view': await setView(data); break;
      case 'differences-run': return { ok: true, report: await runDifferences() };
      case 'differences-ask-claude': {
        if (!differences.report) throw new Error('Run Differences first.');
        clipboard.writeText(summaryText(differences.report));
        // Same route as the toolbar button; the summary is only copied, never injected into the extension.
        if (claudeState.status === 'ready') { await openClaudePanel(); claude.clicked(current()); panel = 'claude'; layout(); emit(); }
        return { ok: true, notice: 'Summary copied. Paste it into Claude.' };
      }
      case 'clear-site-data': { const host = await clearSiteData(); return { ok: true, notice: `Cleared site data for ${host}.` }; }
      case 'open-release': await shell.openExternal(RELEASE_PAGE); break;
      case 'find-open': openFind(); break;
      case 'find-close': closeFind(); layout(); break;
      case 'find': {
        const text=String(data?.text || '').slice(0,1000); const changed=text!==findState.text; findState.text=text;
        if(text) tab.view.webContents.findInPage(text,{forward:data?.forward!==false,findNext:changed});
        else {tab.view.webContents.stopFindInPage('clearSelection');findState.matches=0;findState.active=0;} break;
      }
      case 'bookmark': bookmarkCurrent(); break;
      case 'remove-bookmark': library.removeBookmark(String(data)); break;
      case 'clear-history': library.clearHistory(); break;
      case 'reopen-tab': reopenTab(); break;
      case 'clear-downloads': library.clearDownloads(); break;
      case 'download-action': {
        const running=downloadItems.get(data?.id);
        if(data?.action==='show') {const saved=library.snapshot().downloads.find(d=>d.id===data.id);if(saved?.state==='completed'&&saved.path) shell.showItemInFolder(saved.path);}
        else if(running) {if(data.action==='pause') running.item.pause();else if(data.action==='resume') running.item.resume();else if(data.action==='cancel') running.item.cancel();if(downloadItems.has(data.id)) {running.record.paused=running.item.isPaused();running.record.canResume=running.item.canResume();}}
        break;
      }
      case 'ssl-verification': {
        if(typeof data!=='boolean') throw new Error('Invalid SSL setting.');
        config.sslVerification=data; persist(); break;
      }

      case 'navigate': {
        const url = navigationURL(data); tab.url = url; tab.startPage = url === 'about:blank'; tab.error = ''; layout();
        tab.view.webContents.loadURL(url).catch(error => { if (error.code !== 'ERR_ABORTED') failure(tab, error.message); });
        persist(); break;
      }
      case 'new-tab': newTab(data ?? 'about:blank'); if (!data) focusAddress(); break;
      case 'activate': activate(Number(data)); break;
      case 'close-tab': closeTab(Number(data)); break;
      case 'back': if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack(); break;
      case 'forward': if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward(); break;
      case 'reload': tab.error = ''; layout(); tab.view.webContents.reload(); break;
      case 'hard-reload': tab.error = ''; layout(); tab.view.webContents.reloadIgnoringCache(); break;
      case 'stop': tab.view.webContents.stop(); break;
      case 'panel': if (data === 'claude' && claudeState.status === 'ready') { await openClaudePanel(); claude.clicked(current()); } panel = ['domains', 'settings', 'updates', 'claude', 'library'].includes(data) ? data : null; layout(); break;
      case 'save-rules': {
        const rules = validateRules(data); saveSettings(settingsFile, { ...config, rules }); config.rules = rules; savedResolver = resolverRules(rules); lastSavedSettings = JSON.stringify(config); break;
      }
      case 'restart': {
        const answer = await dialog.showMessageBox(win, { type: 'question', message: 'Apply domain rules and SSL settings, then restart?', detail: 'Tab addresses will be restored. Unsaved form entries will be lost.', buttons: ['Cancel', 'Restart'], defaultId: 0, cancelId: 0 });
        if (answer.response === 1) { persist(); app.relaunch(); app.quit(); } break;
      }
      case 'devtools': toggleDevTools(tab); break;
      case 'devtools-drag': draggingTools = Boolean(data); layout(); break;
      case 'devtools-layout': {
        if (data?.dock !== undefined && !['left', 'right', 'bottom'].includes(data.dock)) throw new Error('Invalid docking position.');
        if (data?.ratio !== undefined && (!Number.isFinite(data.ratio) || data.ratio < .2 || data.ratio > .7)) throw new Error('Invalid inspector size.');
        if (data.dock) config.devtoolsDock = data.dock;
        if (data.ratio !== undefined) config.devtoolsRatio = data.ratio;
        layout(); if (data.commit !== false) persist(); break;
      }
      case 'install-claude': {
        if (claudeState.status === 'installing' || claudeState.status === 'ready') break;
        claudeState = { status: 'installing', message: 'Downloading Claude from the Chrome Web Store…' }; emit();
        try { claude.remove(); await fs.rm(path.join(app.getPath('userData'),directoryName),{recursive:true,force:true}); const result = await installClaude(app.getPath('userData')); const extension = await claude.load(result.directory); claudeState = { status: 'ready', version: extension.version, message: 'Claude installed. Sign in below.' }; await openClaudePanel(); }
        catch (error) { claudeState = { status: 'error', message: error.message }; emit(); throw error; }
        break;
      }
      case 'remove-claude': {
        if (claudeState.status === 'installing') throw new Error('Wait for installation to finish.');
        if (claudeView) { const view = claudeView; claudeView = null; win.contentView.removeChildView(view); view.webContents.close(); }
        claude.remove(); await fs.rm(path.join(app.getPath('userData'),directoryName),{ recursive:true, force:true });
        claudeState = { status: 'absent', message: 'Claude removed.' }; layout(); break;
      }
      case 'claude-check': {
        if (claudeState.status !== 'ready') throw new Error('Install Claude first.');
        if (!claudeView) { await openClaudePanel(); panel = 'settings'; layout(); emit(); }
        claudeReport = { dioptraVersion: app.getVersion(), ...await claude.diagnostics(claudeView.webContents) };
        return { ok: true, diagnostics: claudeReport };
      }
      case 'claude-copy-diagnostics':
        if (!claudeReport) throw new Error('Check Claude first.');
        clipboard.writeText(JSON.stringify(claudeReport, null, 2));
        break;
      case 'claude-refresh': {
        if (claudeState.status !== 'ready') throw new Error('Install Claude first.');
        await openClaudePanel();
        await claudeView.webContents.executeJavaScript("chrome.storage.local.remove('features')");
        claude.resetDiagnostics(); claudeReport = null;
        await claudeView.webContents.loadURL(claudeView.webContents.getURL());
        break;
      }
      case 'claude-options': await openClaudePanel('options.html'); break;
      case 'clear-cache': await webSession.clearCache(); await webSession.clearHostResolverCache(); await webSession.closeAllConnections(); break;
      case 'auth': finishAuth(data); break;
      case 'update-settings': {
        if (checkingUpdate || ['downloading', 'downloaded'].includes(updateState.status)) throw new Error('Finish the current update before changing its source.');
        let feed = String(data.feed || '').trim();
        if (feed === DEFAULT_UPDATE_FEED) feed = '';
        if (feed) { const url = new URL(feed); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS update source without credentials.'); }
        const changes = { ...config, updateFeed: feed, autoUpdates: Boolean(data.automatic), autoUpdatesChosen: true };
        saveSettings(settingsFile, changes); config = changes;
        updateState = freshUpdate(feed ? 'Custom update source saved. Not checked yet.' : 'Default update source in use. Not checked yet.'); setupUpdater(); break;
      }
      case 'check-update':
        if (!app.isPackaged) throw new Error('Automatic updates are available in the installed app.');
        await checkForUpdates(true); break;
      case 'download-update': if (!canInstall) throw new Error('This build cannot install updates itself. Use Open download page.'); manualUpdate = true; if (updater && updateState.status === 'available') { updateState = { ...updateState, status: 'downloading', progress: 0, message: 'Starting download…' }; emit(); await updater.downloadUpdate(); } break;
      case 'install-update': if (updater && updateState.status === 'downloaded') {
        const answer = await dialog.showMessageBox(win, { type: 'question', message: 'Restart Dioptra to install the update?', detail: 'Tabs and domain rules will be restored. Unsaved form entries will be lost.', buttons: ['Cancel', 'Install and restart'], defaultId: 0, cancelId: 0 });
        if (answer.response === 1) { persist(); updater.quitAndInstall(); }
      } break;
      default: throw new Error('Unknown command.');
    }
    emit(); return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.restore(); win?.focus(); });
  app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: 'Dioptra', applicationVersion: app.getVersion(), copyright: 'Copyright © 2026 SolutionMAX', authors: ['SolutionMAX'], website: 'https://solutionmax.net', iconPath: path.join(__dirname, 'brand/dioptra.png') });
    webSession = session.fromPartition('persist:web');
    library = createLibrary(path.join(app.getPath('userData'), 'library.json'));
    certificatePolicy(webSession);
    observeConnections(webSession);
    await webSession.setProxy({ mode: 'direct' });
    claudeAuthSession = session.fromPartition('persist:claude-auth');
    await claudeAuthSession.setProxy({mode:'direct'});
    const claudeSession = await shareClaudeSession(webSession, claudeAuthSession);
    let sessionFlushed = false;
    app.on('before-quit', event => {
      if (sessionFlushed) return;
      event.preventDefault();
      // Quit must never hang (seen under Rosetta): cap the cookie flush, then force exit if shutdown still stalls.
      setTimeout(() => app.exit(0), 8000).unref();
      Promise.race([claudeSession.flush(), new Promise(resolve => setTimeout(resolve, 3000))]).catch(() => console.error('Claude session could not be saved.')).finally(() => { sessionFlushed = true; app.quit(); });
    });
    observeConnections(claudeAuthSession);
    claudeAuthSession.setPermissionCheckHandler(() => false);
    claudeAuthSession.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
    win = new BrowserWindow({ width: 1380, height: 900, minWidth: 960, minHeight: 640, title: 'Dioptra', backgroundColor: '#f6f8fb', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    win.webContents.on('before-input-event',(event,input)=>handleShortcut(event,input));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('resize', () => { layout(); emit(); });
    win.on('blur', () => { if (draggingTools) { draggingTools = false; layout(); emit(); } });
    win.on('close', () => { persist(); quitting = true; if (authRequest) finishAuth(null); for (const t of tabs.values()) { disposeDevTools(t); t.view.webContents.close(); } });
    win.on('closed', () => { liveProxy?.close(); win = null; app.quit(); });
    setupWebsiteSession(webSession);
    app.on('login', (event, wc, details, authInfo, callback) => {
      if (![...tabs.values()].some(t => t.view.webContents === wc)) return;
      event.preventDefault();
      if (authRequest) finishAuth(null);
      authRequest = { callback, webContentsId: wc.id, timer: setTimeout(() => finishAuth(null), 120000) };
      win.webContents.send('auth', { host: authInfo.host, realm: authInfo.realm }); layout(); win.webContents.focus();
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: 'File', submenu: [{ label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => { newTab(); focusAddress(); } }, { label: 'Reopen closed tab', accelerator: 'CmdOrCtrl+Shift+T', click: reopenTab }, { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{label:'Find in page', accelerator:'CmdOrCtrl+F', click:openFind}, {label:'Bookmark page', accelerator:'CmdOrCtrl+D', click:bookmarkCurrent}, { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ label: 'Address bar', accelerator: 'CmdOrCtrl+L', click: focusAddress }, { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => current()?.view.webContents.reload() }, { label: 'Reload without cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => current()?.view.webContents.reloadIgnoringCache() }, { label: 'Developer Tools', accelerator: 'F12', click: () => toggleDevTools() }, { role: 'togglefullscreen' }, { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: () => { const wc = current().view.webContents; wc.setZoomLevel(wc.getZoomLevel() + .5); } }, { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => { const wc = current().view.webContents; wc.setZoomLevel(wc.getZoomLevel() - .5); } }, { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => current().view.webContents.setZoomLevel(0) }] }
    ]));
    const extensionDirectory = path.join(app.getPath('userData'),directoryName);
    try { await fs.access(path.join(extensionDirectory,'manifest.json')); claudeState = {status:'loading',message:'Starting Claude…'}; } catch {}
    claude = createClaude({ session: webSession, authSession: claudeAuthSession, window: win, tabs, current, newTab, activate, closeTab, openPanel: openClaudePanel, getPanel: () => claudeView?.webContents });
    await win.loadFile(path.join(__dirname, 'index.html'));
    const restore = [...config.tabs];
    for (const url of restore) newTab(url);
    for (const type of ['frame','service-worker']) webSession.registerPreloadScript({ type, filePath: path.join(__dirname,'claude-preload.cjs') });
    try {
      await fs.access(path.join(extensionDirectory,'manifest.json'));
      const extension = await claude.load(extensionDirectory);
      claudeState = { status:'ready', version:extension.version, message:'Claude installed.' };
    } catch(error) { if (error.code !== 'ENOENT') claudeState = { status:'error', message:error.message }; }

    samplePerformance();
    setInterval(samplePerformance,5000).unref();
    emit();
    setupUpdater();
    setTimeout(() => { if (config.autoUpdates) checkForUpdates().catch(() => {}); }, 10000).unref();
    setInterval(() => { if (config.autoUpdates) checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000).unref();
  }).catch(error => { dialog.showErrorBox('Browser could not start', error.stack || error.message); app.exit(1); });
  app.on('before-quit', () => { if (!quitting && tabs.size) persist(); });
  app.on('window-all-closed', () => app.quit());
}
