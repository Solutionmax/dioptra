const { createLiveProxy } = require('./live-proxy.cjs');
const { detectSite } = require('./site-detect.cjs');
const { createLibrary } = require('./library.cjs');
const { randomUUID, X509Certificate } = require('node:crypto');
const { shareClaudeSession } = require('./claude-session.cjs');
const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, session, dialog, Menu, clipboard, ClipboardItem, shell } = require('electron');
const { probe: shotProbe, capturePanes, fileName: shotFileName, saveShot, copyPng, Cancelled } = require('./screenshot.cjs');
const path = require('node:path');
const dns = require('node:dns').promises;
const fs = require('node:fs/promises');
const { createClaude } = require('./claude.cjs');
const { directoryName } = require('./claude-install.cjs');
const { createClaudeUpdates, recoverClaudeUpdate } = require('./claude-update.cjs');
const { pathToFileURL } = require('node:url');
const { ptrName, certSummary, daysLeft, ROUTE_BAR_HEIGHT, FOOTER_HEIGHT, DEFAULT_UPDATE_FEED, RELEASE_PAGE, devtoolsLayout, compareLayout, validateRules, expandRules, parseServers, MAX_SERVER_CSV, navigationURL, readSettings, saveSettings, cancelNavigation, zoomStep, zoomPreset, zoomLabel } = require('./core.cjs');
const { fetchDocument, buildReport, summaryText, isFirstParty } = require('./differences.cjs');
const { createRecord, responseOutcome, errorOutcome, consoleOutcome, recordFailure, recordLoaded, recordOld, recordError, paneSummary, filesView, filesLines, filesText, header, sameDocument } = require('./resource-check.cjs');
const { observeRequests } = require('./web-requests.cjs');
const { createSpeedMeter } = require('./speed-measure.cjs');
const { speedLines } = require('./speed.cjs');
const { pageFacts, standardAddresses, checksReport, soloChecksReport, checksLines, tabNoindex } = require('./site-checks.cjs');
const { liveReason, soloFindings, failingHost, needsAddress } = require('./live-reason.cjs');
const { dnsReport, canLookup } = require('./dns-records.cjs');
const { createAddons, reportLines: addonLines } = require('./addons.cjs');
const { createBudget, BudgetError, StoppedError, forSite, bareHost, BROWSE, COMPARE } = require('./host-budget.cjs');
const { pageTitle, sitemapsInRobots, parseSitemap, pageOf, pickPages, pastedPages, pageModel, siteResult, redirectStep, leftFindings, DEFAULT_PAGES, MAX_PAGES, PAGE_CHOICES, SITEMAP_BODY, SITEMAP_CHILDREN, SITEMAP_PATHS } = require('./site-scope.cjs');

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
const activeSSL = true; // Compatibility: verification is always on; exceptions belong to rules.
let activeRules = structuredClone(config.rules);
let activeHosts = expandRules(activeRules);
let routingProxy;
app.commandLine.appendSwitch('lang', 'en-US');
app.enableSandbox();
const uiURL = pathToFileURL(path.join(__dirname, 'index.html')).href;
let win, webSession, claudeAuthSession, activeId, panel = null, nextId = 1, quitting = false, tabsRestored = false, authRequest = null;
// Public releases keep the normal updater; local betas never load or invoke it.
const privateBeta = require('../package.json').privateBeta === true;
const betaMessage = 'Private beta for local testing. Updates are supplied with your beta downloads. No network check was performed.';
const betaNotes = 'Dioptra v1.0-beta (1.0.0-beta.2)\nLocal test distribution · 8 October 2026\n\n• Domain routing and per-rule SSL exceptions apply immediately.\n• Compact Hostfile / Live workspace, site details and comparison.\n• TwinView start page with reduced-motion support.\n• Installation and first-domain setup, with optional server CSV.\n\nThis beta does not check, download or install public releases. Get the next beta from the person who supplied this build. Your profile stays on this computer.';
const canInstall = !privateBeta;
let onboardingOpen = !config.onboardingCompleted;
const freshUpdate = message => ({ status: 'idle', message, canInstall, version: '' });
const localBetaUpdate = () => ({ status: 'private-beta', message: betaMessage, canInstall: false, version: '', notes: betaNotes });
let updateState = privateBeta ? localBetaUpdate() : freshUpdate('Not checked yet.');
const updateFeed = () => config.updateFeed || DEFAULT_UPDATE_FEED;
let manualUpdate = false;
let updater, checkingUpdate = false, draggingTools = false, toolsLayout = null;
let lastSavedSettings = JSON.stringify(config);
let claude, claudeView, claudeState = { status: 'absent', message: 'Install Claude to use it inside Dioptra.' };
let claudeReport, claudeUpdates, claudeReopen;
let comparing = false, viewMode = 'single', livePromise = null, diffRun = null;
// liveReason: why Live could not be reached (no DNS record, refused, no answer); then Speed and Checks judge the new server
// on its own. liveRetry: Measure Live too or Check Live too is asking Live again.
let differences = { status: 'idle', report: null, error: '', liveReason: null, liveRetry: false };
let liveRetry = null;
// Speed and Checks of the page in Differences, each for one URL; a new comparison or a rule change starts them again.
let speed = { status: 'idle', url: '', report: null, error: '' }, checks = { status: 'idle', url: '', report: null, error: '' }, speedRun = null, checksRun = null, meter = null, measureHost = null;
let liveSession, liveProxy, library, comparison = null, paneLayout = [];
let performance = {memoryKB:null,processes:0};
function samplePerformance() {
  try {
    const metrics=app.getAppMetrics();
    const memory=metrics.map(p=>p.memory?.workingSetSize);
    performance={memoryKB:memory.length && memory.every(n=>Number.isFinite(n)&&n>=0) ? memory.reduce((sum,n)=>sum+n,0) : null,processes:metrics.length};
  } catch {performance={memoryKB:null,processes:0};}
  if(win && !win.isDestroyed()) win.webContents.send('performance',performance);
  if (card?.kind === 'memory') { const mine = card; renderCard(memoryData()).then(async height => { if (card === mine && placeCard(height)) await mine.view.webContents.executeJavaScript("document.documentElement.classList.add('tall')"); }, () => {}); }
}
let findState = { open: false, text: '', matches: 0, active: 0 };
const closedTabs = [], downloadItems = new Map();
const visibleComparison = () => comparison && [comparison.host, comparison.live].includes(activeId) ? comparison : null;
function protectedHost(host) { return ['claude.ai','claude.com','anthropic.com','claudeusercontent.com','google.com','googleapis.com','gstatic.com','apple.com','microsoftonline.com','github.com','githubusercontent.com'].some(domain => host === domain || host.endsWith('.' + domain)); }
// Certificate observations per route and hostname; verified and skipped remain distinct.
// Limit: grows with every visited hostname until restart; cap it if that ever shows up in RAM.
const certificates = new Map(), certKey = (mode, host) => `${mode === 'live' ? 'live' : 'hostfile'}:${host}`;
// Continue anyway on a Live page: host -> SHA-256 of that one certificate. Memory only, so it ends with the app; Chromium
// keeps an accepted certificate until restart as well, so promising less (until the tab closes) would not hold.
const liveExceptions = new Map();
const fingerprint = cert => { try { return new X509Certificate(cert.data).fingerprint256; } catch { return ''; } };
function certificatePolicy(ses) {
  ses.setCertificateVerifyProc((request, callback) => {
    const host = request.hostname.toLowerCase(), key = certKey(ses === liveSession ? 'live' : 'hostfile', host);
    const summary = certSummary(request.certificate);
    if (summary) certificates.set(key, { ...summary, verificationResult: request.verificationResult, verified: /^(net::)?OK$/.test(request.verificationResult) });
    else certificates.delete(key);
    // Never cache an exception in Chromium's verifier. Website certificate-error events
    // consult current rules each time; cached acceptance cannot outlive a rule change.
    callback(-3);
  });
}
function skipCertificate(host) {
  return !protectedHost(host) && activeHosts.some(r => r.enabled && r.domain === host && r.skipSSL);
}
let ruleMutation = Promise.resolve();
function applyRules(rules) {
  const run = ruleMutation.then(async () => {
    const before = new Map(activeHosts.filter(r => r.enabled).map(r => [r.domain, r]));
    const nextHosts = expandRules(rules), after = new Map(nextHosts.filter(r => r.enabled).map(r => [r.domain, r]));
    const changed = new Set([...before.keys(), ...after.keys()].filter(host => JSON.stringify(before.get(host)) !== JSON.stringify(after.get(host))));
    saveSettings(settingsFile, { ...config, rules });
    config.rules = rules; activeRules = structuredClone(rules); activeHosts = nextHosts;
    lastSavedSettings = JSON.stringify(config);
    if (!changed.size) return;
    diffRun = null; liveRetry = null; differences = { status: 'idle', report: null, error: '', liveReason: null, liveRetry: false }; resetPageChecks();
    const affected = [...tabs.values()].filter(t => t.mode === 'hostfile' && (changed.has(route(t).host) || [...t.requestHosts].some(host => changed.has(host))));
    for (const t of affected) { t.cancelRuleHistory?.(); t.reloadingRules = true; t.connection = null; t.site = null; t.siteHeaders = {}; t.robots = null; t.error = ''; }
    for (const host of changed) certificates.delete(certKey('hostfile', host));
    routingProxy.closeHosts(changed);
    try {
      await Promise.all(affected.map(t => cancelNavigation(t.view.webContents))); // cancellation acknowledgement, not page completion
      // HTTP cache is session-wide in Electron; cookies and website storage are untouched.
      await webSession.clearCache();
      for (const t of affected) if (tabs.has(t.id)) {
        const wc = t.view.webContents, index = t.ruleHistoryIndex;
        if (index !== undefined && index !== wc.navigationHistory.getActiveIndex()) reloadRuleHistory(t, index);
        else { delete t.ruleHistoryIndex; reloadRuleHistory(t); }
      }
    } catch (error) {
      for (const t of affected) if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
      throw error;
    }
    layout(); emit();
  });
  ruleMutation = run.catch(() => {});
  return run;
}
// Reverse DNS (PTR) name of a connected IP, looked up once per IP. No record or a failed lookup shows nothing.
const reverseNames = new Map();
function reverseName(ip) {
  const name = ptrName(ip);
  if (!name) return Promise.resolve('');
  if (!reverseNames.has(name)) reverseNames.set(name, dns.resolvePtr(name).then(names => String(names[0] || '').replace(/\.$/, '').slice(0, 253), () => ''));
  return reverseNames.get(name);
}
// Small cards (certificate, site platform, memory, DNS records). The website is a native view on top of the window UI, so a card
// is a small native view of its own. Opening and closing never depend on focus events: those differ per platform.
// The button toggles, a click anywhere else or Escape closes.
let card = null;
function closeCard() {
  if (!card) return;
  const { view } = card; card = null;
  if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  view.webContents.close();
}
function memoryData() {
  const kb = new Map(app.getAppMetrics().map(p => [p.pid, p.memory?.workingSetSize || 0])), groups = new Map();
  const pidOf = wc => { try { return wc.getOSProcessId(); } catch { return 0; } };
  // Tabs of the same site can share one process; such a group is one row.
  for (const t of tabs.values()) { const pid = pidOf(t.view.webContents); if (!kb.has(pid)) continue; const g = groups.get(pid) || { id: t.id, label: t.mode === 'live' ? 'LIVE' : 'TAB', title: String(t.title || 'New tab').slice(0, 120), more: -1, kb: kb.get(pid) }; g.more++; groups.set(pid, g); }
  const rows = [...groups.values()].sort((x, y) => y.kb - x.kb), claudePid = claudeView ? pidOf(claudeView.webContents) : 0;
  const claudeKB = kb.has(claudePid) && !groups.has(claudePid) ? kb.get(claudePid) : 0, total = [...kb.values()].reduce((sum, n) => sum + n, 0);
  return { total, rows, claude: claudeKB, rest: Math.max(0, total - claudeKB - rows.reduce((sum, r) => sum + r.kb, 0)), tabs: tabs.size, processes: kb.size };
}
// What the DNS card looks up for a tab. With an active rule the card compares, but only where both sides are on
// screen (Compare, Differences); in a single Hostfile tab the rule is just mentioned next to the public address.
function dnsTarget(tab) {
  const host = route(tab).host;
  if (tab.mode === 'auth' || !canLookup(host)) return null;
  const rule = activeHosts.find(r => r.enabled && r.domain === host), pair = visibleComparison();
  const paired = pair ? [pair.host, pair.live].includes(tab.id) : viewMode === 'differences' && tab.id === activeId;
  return { host, ruleIP: rule && (paired || tab.mode === 'hostfile') ? rule.ip : '', compare: Boolean(rule && paired) };
}
function cardData(kind, id) {
  if (kind === 'shot') return {};
  if (kind === 'zoom') return zoomView();
  if (kind === 'addon') { const t = tabs.get(id); return t ? addonCard(t) : null; }
  if (kind === 'memory') return memoryData();
  if (['cache-menu','tools','about'].includes(kind)) return { version: app.getVersion(), dock: config.devtoolsDock, open: Boolean(current()?.toolsOpen) };
  const tab = tabs.get(id); if (!tab) return null;
  if (kind === 'dns') return dnsTarget(tab);
  if (kind === 'cache') return { id, connection: tab.connection };
  if (kind === 'site') { const pair=visibleComparison(); const ids=pair ? [pair.host,pair.live] : [id]; return { panes: ids.map(id => { const t=tabs.get(id); return { id, url:t.url, route:route(t), connection:t.connection, site:t.site, loading:t.loading, error:t.error, startPage:t.startPage }; }) }; }
  const observed=route(tab).certificate;
  const cert = kind === 'cert' && !tab.loading && !tab.error && observed?.verified ? observed : null;
  return cert ? { ...cert, daysLeft: daysLeft(cert.expires) } : null;
}
const CARD_WIDTH = { addon: 460, shot: 340, zoom: 270, cert: 330, dns: 440, site: 840, 'cache-menu': 400, cache: 380, tools: 310, about: 330, memory: 390 }, DNS_TABLE_WIDTH = 780;
// Returns true when the card had to be cut off at the bottom of the window (the content exceeds the available window).
function placeCard(height) {
  if (!win || win.isDestroyed()) return false;
  const [width, full] = win.getContentSize(), w = Math.min(card.wide ? DNS_TABLE_WIDTH : CARD_WIDTH[card.kind] || 340, width - 16), anchor = card.anchor;
  const footer = ['memory','cache-menu','tools','about'].includes(card.kind), top = footer ? 8 : Math.max(144, ...paneLayout.map(p => p.banner.y + p.banner.height)) + 5;
  const shown = Math.min(height, Math.max(80, full - top - FOOTER_HEIGHT - 8)); card.height = height;
  card.view.setBounds({ x: Math.max(8, Math.min(Math.round(Number(anchor?.right) || width) - w + 7, width - w - 8)), y: footer ? Math.max(8, full - FOOTER_HEIGHT - 8 - shown) : top, width: w, height: shown });
  return shown < height;
}
const renderCard = data => card.view.webContents.executeJavaScript(`render(${JSON.stringify({ kind: card.kind, ...data })})`).then(Math.ceil);
// The DNS card opens at once with a spinner and fills in when the answers are there. Nothing is looked up before
// the click; Refresh asks again. The card can be closed or replaced, the window closed or Refresh clicked again
// while a lookup runs: only the latest run of the card that is still open may draw.
async function showDns(mine) {
  const run = mine.run = (mine.run || 0) + 1, current = () => card === mine && mine.run === run && win && !win.isDestroyed();
  const draw = async data => {
    if (!current()) return;
    const height = await renderCard(data);
    if (current() && placeCard(height)) await mine.view.webContents.executeJavaScript("document.documentElement.classList.add('tall')");
  };
  try {
    mine.wide = false; await draw({ state: 'loading', host: mine.dns.host });
    const report = await dnsReport(mine.dns);
    if (!current()) return;
    // Width first, so the text wraps as it will be shown.
    mine.wide = Boolean(report.table); placeCard(mine.height || 1);
    await draw({ state: 'done', ...report });
  } catch (error) { if (current()) throw error; }
}
// Camera button: the visible area or the full page, of the active tab or of the Compare panes (one image with a label per
// pane). The choice is kept while Dioptra runs. The last picture stays until the card closes, so Copy after Download
// (or the other way round) needs no second capture. Quality: Original (PNG), Sharp (JPEG 90 %) or Small (JPEG 80 %, half).
const shotChoice = { area: 'visible', panes: 'both', quality: 'sharp' };
const SHOT_QUALITY = { original: 'Original', sharp: 'Sharp', small: 'Small' };
const plainIP = ip => String(ip || '').replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
function shotTarget() {
  if (viewMode === 'differences') return { off: 'Switch to Single or Compare to take a screenshot.' };
  const pair = visibleComparison(), list = (pair ? [pair.host, pair.live] : [activeId]).map(id => tabs.get(id));
  if (!list.length || list.some(t => !t || t.startPage || t.error || t.mode === 'auth' || !/^https?:/.test(t.url))) return { off: 'Open a website first, then take a screenshot.' };
  return { compare: Boolean(pair), tabs: list };
}
function shotPane(tab) {
  const r = route(tab), hostfile = r.label === 'HOSTFILE';
  return { wc: tab.view.webContents, live: !hostfile, name: hostfile ? 'New server' : 'Live', ip: plainIP(tab.connection?.ip) || (hostfile ? r.configured : ''),
    via: hostfile ? 'via Hostfile rule' : 'public DNS', ptr: String(tab.connection?.hostname || '').slice(0, 120) };
}
const chosenSides = (list, compare) => compare && shotChoice.panes !== 'both' ? [list[shotChoice.panes === 'hostfile' ? 0 : 1]] : list;
async function probeShot(mine) {
  const s = mine.shot, target = shotTarget();
  if (target.off) { Object.assign(s, { state: 'off', message: target.off }); return; }
  const sides = await Promise.all(target.tabs.map(async tab => { const pane = shotPane(tab); return { ip: pane.ip, probe: await shotProbe(pane.wc).catch(() => null) }; }));
  Object.assign(s, { state: 'choose', compare: target.compare, sides, result: null, message: '' });
}
function shotNotes(s) {
  const sides = chosenSides(s.sides, s.compare).map(x => x.probe).filter(Boolean), n = s.compare && shotChoice.panes === 'both' ? '2 panes, ' : '', fmt = v => Math.round(v).toLocaleString('en-GB');
  if (!sides.length) return { visible: 'What you see now', full: 'Top to bottom' };
  const width = sides.reduce((sum, p) => sum + p.width, 0), tall = Math.max(...sides.map(p => p.height)), full = Math.max(...sides.map(p => p.full));
  return { visible: `What you see now, ${n}${fmt(width)} × ${fmt(tall)}`, full: `Top to bottom, ${n}${n ? 'up to ' : `${fmt(width)} × `}${fmt(full)} px${n ? ' tall' : ''}` };
}
function shotView(mine) {
  const s = mine.shot, base = { kind: 'shot', state: s.state, area: shotChoice.area, panes: shotChoice.panes, quality: shotChoice.quality, compare: Boolean(s.compare), message: s.message || '' };
  if (s.state === 'busy') return { ...base, progress: s.progress };
  if (s.state === 'done' || s.state === 'error') { const r = s.result; return { ...base, result: r && { name: r.name, size: r.size, saved: r.saved, copied: r.copied, cut: r.cut } }; }
  if (s.state === 'off') return base;
  const lazy = Math.max(0, ...chosenSides(s.sides, s.compare).map(x => x.probe?.lazy || 0));
  return { ...base, notes: shotNotes(s), lazy, ips: s.compare ? { hostfile: s.sides[0].ip, live: s.sides[1].ip } : {} };
}
// Draws in order: progress updates come fast and must not overtake each other.
function drawShot(mine) {
  mine.drawing = (mine.drawing || Promise.resolve()).then(async () => {
    if (card !== mine) return;
    const height = await mine.view.webContents.executeJavaScript(`render(${JSON.stringify(shotView(mine))})`).then(Math.ceil);
    if (card === mine && placeCard(height)) await mine.view.webContents.executeJavaScript("document.documentElement.classList.add('tall')");
  }).catch(error => { if (card === mine) console.error('Screenshot card:', error.message); }); // closed mid-draw: nothing to draw on
  return mine.drawing;
}
// Every capture has its own run number: Cancel, Try again or a closed card end the old run, so its scroll loop cannot
// keep moving a page under a new one. Host and address are taken before the capture, so they match the pixels.
async function shotPicture(mine) {
  const s = mine.shot, run = s.run = (s.run || 0) + 1, target = shotTarget(), alive = () => card === mine && s.run === run && win && !win.isDestroyed();
  if (target.off) throw new Error(target.off);
  const list = chosenSides(target.tabs, target.compare), panes = list.map(shotPane), when = new Date(), host = route(list[0]).host, url = list[0].url;
  const shots = await capturePanes(panes, { full: shotChoice.area === 'full', alive, progress: p => { if (alive()) { s.progress = p; drawShot(mine); } } });
  if (!alive()) throw new Cancelled();
  const spec = { host, url, version: app.getVersion(), panes: shots,
    when: when.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) };
  const what = list.length > 1 ? 'compare' : panes[0].live ? 'live' : 'new server', quality = shotChoice.quality;
  return { spec, quality, name: shotFileName(host, what, when, quality), cut: shots.some(p => p.cut), compare: list.length > 1, saved: false, copied: false };
}
// The picture as a file (PNG or JPEG, by its quality) or as PNG for the clipboard. Each is made once, from the captures
// the result keeps, so Copy after a Sharp download needs no second capture.
const isPng = b => b.length > 8 && b.readUInt32BE(0) === 0x89504e47, isJpeg = b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const shotKey = (r, png) => (png || r.quality === 'original' ? 'png' : 'jpeg');
async function shotEncode(r, png) {
  const key = shotKey(r, png);
  if (r[key]) return r[key];
  const image = await win.webContents.executeJavaScript(`window.composeShot(${JSON.stringify({ ...r.spec, quality: r.quality, png: key === 'png' })})`);
  const bytes = Buffer.from(String(image?.data || ''), 'base64');
  if (!(key === 'png' ? isPng(bytes) : isJpeg(bytes))) throw new Error('The picture could not be made.');
  return Object.assign(r, { [key]: bytes, width: image.width, height: image.height })[key];
}
// "3.2 MB · Sharp, 2,880 × 17,748 px": what was saved or copied, so it is clear what goes out.
function shotSize(r, bytes) {
  const amount = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${amount} · ${SHOT_QUALITY[r.quality]}, ${r.width.toLocaleString('en-GB')} × ${r.height.toLocaleString('en-GB')} px${r.compare ? ' · New server and Live in one image' : ''}`;
}
async function shotDeliver(mine, action) {
  const s = mine.shot;
  if (s.delivering || (action === 'download' && s.result?.saved) || (action === 'copy' && s.result?.copied)) return;
  s.delivering = true;
  try {
    if (!s.result) {
      s.state = 'busy'; s.progress = { title: 'Capturing…', pct: 5, steps: [] }; drawShot(mine);
      s.result = await shotPicture(mine);
    }
    if (card !== mine) return;
    const png = action === 'copy';
    if (!s.result[shotKey(s.result, png)]) { s.state = 'busy'; s.progress = { title: 'Making the picture…', pct: 92, steps: (s.progress?.steps || []).map(([, text]) => ['ok', text]) }; drawShot(mine); }
    const run = s.run, bytes = await shotEncode(s.result, png);
    if (card !== mine) return;
    if (s.run !== run) { // Cancel while making the picture: nothing saved or copied
      if (s.result.saved || s.result.copied) s.state = 'done'; else { s.state = 'choose'; s.result = null; }
      return drawShot(mine);
    }
    if (action === 'download') {
      const file = saveShot(app.getPath('downloads'), s.result.name, bytes);
      Object.assign(s.result, { file, name: path.basename(file), saved: true, size: shotSize(s.result, bytes.length) });
      library.download({ id: randomUUID(), name: s.result.name, url: '', path: file, state: 'completed', received: bytes.length, total: bytes.length, createdAt: Date.now() });
      emit();
    } else {
      await copyPng(clipboard, ClipboardItem, bytes);
      if (!s.result.saved) s.result.size = shotSize(s.result, bytes.length);
      s.result.copied = true;
    }
    s.state = 'done';
  } catch (error) {
    if (error.cancelled) { s.state = 'choose'; s.result = null; }
    else { console.error('Screenshot:', error.message); s.state = 'error'; s.message = error.message; }
  } finally { s.delivering = false; }
  return drawShot(mine);
}
async function shotAction(mine, action) {
  const s = mine.shot;
  if (s.state === 'choose' && ['visible', 'full'].includes(action)) { shotChoice.area = action; return drawShot(mine); }
  if (s.state === 'choose' && s.compare && ['both', 'hostfile', 'live'].includes(action)) { shotChoice.panes = action; return drawShot(mine); }
  if (s.state === 'choose' && action.startsWith('q-') && Object.hasOwn(SHOT_QUALITY, action.slice(2))) { shotChoice.quality = action.slice(2); return drawShot(mine); }
  if (s.state === 'busy' && action === 'cancel') { s.run++; return; }
  if (action === 'folder' && s.result?.file) { shell.showItemInFolder(s.result.file); return; }
  if (action === 'again' && s.state !== 'busy') { await probeShot(mine); return drawShot(mine); }
  if (['choose', 'done'].includes(s.state) && ['download', 'copy'].includes(action)) return shotDeliver(mine, action);
}
// Zoom: one size per tab, on every pane of it. In Compare that is the Hostfile and the Live pane, which sit in two sessions,
// so each view is set on its own. Views zoom in isolation (bindTab): another tab of the same site keeps its own size, and
// navigation keeps it; did-navigate sets it again for a view that was not live yet when the size was chosen.
const zoomPanes = () => { const pair = visibleComparison(); return (pair ? [pair.host, pair.live] : [activeId]).map(id => tabs.get(id)).filter(Boolean); };
function applyZoom(tab) { const wc = tab.view.webContents; if (!wc.isDestroyed() && Math.abs(wc.getZoomFactor() - tab.zoom) > 0.001) wc.setZoomFactor(tab.zoom); }
const zoomView = () => ({ percent: Math.round((current()?.zoom || 1) * 100), label: zoomLabel(current()?.zoom), compare: Boolean(visibleComparison()), mac: process.platform === 'darwin' });
function setZoom(factor) {
  for (const t of zoomPanes()) { t.zoom = factor; applyZoom(t); }
  emit();
  const mine = card; // an open zoom card follows the keys and its own buttons
  if (mine?.kind === 'zoom') renderCard(zoomView()).then(height => { if (card === mine) placeCard(height); }, () => {});
}
// in, out, reset (menu, keys, card) and set with a percent from the card's steps.
function zoomAction(action, percent) {
  if (!current()) return;
  if (action === 'in' || action === 'out') setZoom(zoomStep(current().zoom, action === 'in' ? 1 : -1));
  else if (action === 'reset') setZoom(1);
  else if (action === 'set' && zoomPreset(percent)) setZoom(zoomPreset(percent));
}
async function openCard(kind, id, anchor) {
  if (card) { const same = card.kind === kind && card.id === id; closeCard(); if (same) return; }
  if (!['cert', 'site', 'memory', 'dns', 'cache', 'cache-menu', 'tools', 'about', 'shot', 'addon', 'zoom'].includes(kind)) return;
  const data = cardData(kind, id); if (!data) return;
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = view.webContents, mine = card = { view, kind, id, anchor };
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The card has no bridge to the app. Its actions are links to a reserved, never loaded address that is handled here.
  wc.on('will-navigate', (event, url) => {
    event.preventDefault();
    const [, action, target] = url.match(/^https:\/\/card\.invalid\/(activate|reload|refresh|hard-reload|clear-cache|clear-site-data|devtools|dock-bottom|dock-left|dock-right|site|cert|maker-website|maker-github|maker-coffee|shot-(?:visible|full|both|hostfile|live|q-original|q-sharp|q-small|download|copy|cancel|folder|again)|zoom-(?:in|out|reset|set))\/(\d+)$/) || [];
    if (action === 'refresh') { if (card === mine && kind === 'dns') showDns(mine).catch(error => console.error('DNS card:', error.message)); return; }
    if (card !== mine || !action) return;
    if (action.startsWith('shot-') && kind === 'shot') { shotAction(mine, action.slice(5)); return; }
    if (action.startsWith('zoom-') && kind === 'zoom') { zoomAction(action.slice(5), Number(target)); return; }
    const tab = tabs.get(Number(target)) || (target === '0' ? current() : null);
    if (['site','cert'].includes(action) && kind==='site') { closeCard(); openCard(action, Number(target), anchor); return; }
    if (['maker-website','maker-github','maker-coffee'].includes(action) && kind==='about') { closeCard(); newTab({'maker-website':'https://solutionmax.net/','maker-github':'https://github.com/Solutionmax/dioptra','maker-coffee':'https://buymeacoffee.com/solutionmax'}[action]); return; }
    closeCard();
    if (['activate','reload'].includes(action) && kind==='memory' && tab) { activate(tab.id); if(action==='reload') reloadTab(tab); }
    if(action==='hard-reload' && ['cache','cache-menu'].includes(kind) && tab) reloadTab(tab, true);
    if(action==='clear-cache' && kind==='cache-menu') clearBrowserCache().catch(error=>console.error(error.message));
    if(action==='clear-site-data' && kind==='cache-menu') clearSiteData().catch(error=>console.error(error.message));
    if(kind==='tools') { if(action.startsWith('dock-')) {config.devtoolsDock=action.slice(5);persist();} if(action==='devtools' || action.startsWith('dock-')&&!current().toolsOpen) toggleDevTools(); else {layout();emit();} }

  });
  wc.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); closeCard(); win.webContents.focus(); } });
  await wc.loadFile(path.join(__dirname, 'card.html'));
  if (card !== mine) return;
  // Width first, so the text wraps as it will be shown; then the height the content needs.
  view.setBorderRadius(10); placeCard(1); win.contentView.addChildView(view);
  if (kind === 'dns') { mine.dns = data; return showDns(mine); }
  if (kind === 'shot') { mine.shot = { state: 'choose' }; await probeShot(mine); return drawShot(mine); }
  const height = await renderCard(data);
  if (card === mine && placeCard(height)) await wc.executeJavaScript("document.documentElement.classList.add('tall')");
}
function route(tab) {
  let host = ''; try { host = new URL(tab.url).hostname; } catch {}
  const rule = tab.mode === 'hostfile' && activeHosts.find(r => r.enabled && r.domain === host);
  const ssl = !tab.url.startsWith('https:') ? 'HTTP · no TLS' : tab.mode === 'hostfile' && rule?.skipSSL && !protectedHost(host) ? 'SSL checks off' : 'SSL checks on';
  const observed = !tab.connection?.fromCache && certificates.get(certKey(tab.mode, host));
  const untrusted = tab.mode === 'live' && !tab.error && liveExceptions.has(host) && observed?.verified !== true;
  const certificate = tab.mode !== 'auth' && observed ? { ...observed, skipped: (ssl === 'SSL checks off' || untrusted) && !observed.verified } : null;
  return { certificate, untrusted, label: rule ? 'HOSTFILE' : 'LIVE', configured: rule?.ip || '', host, ssl, dns: tab.mode !== 'auth' && canLookup(host), cert: ssl === 'SSL checks on' && tab.mode !== 'auth' && certificates.get(certKey(tab.mode, host))?.verified === true && !tab.connection?.fromCache };
}
const tabs = new Map();
const current = () => tabs.get(activeId);
const pending = () => false;
function persist() {
  // Until the saved tabs are open again the list in the settings is the one to keep (quit during startup).
  if (tabsRestored) {
    config.tabs = [...tabs.values()].map(t => (t.view.webContents.session === webSession && /^https?:\/\//i.test(t.url) ? t.url : 'about:blank'));
    if (!config.tabs.length) config.tabs = ['about:blank'];
  }
  const serialized = JSON.stringify(config);
  if (serialized !== lastSavedSettings) { saveSettings(settingsFile, config); lastSavedSettings = serialized; }
}
function state() {
  return { privateBeta, onboarding: { open: onboardingOpen, step: config.onboardingStep, url: config.onboardingURL }, view: visibleComparison() ? 'compare' : viewMode, routeBarHeight: visibleComparison() ? 0 : ROUTE_BAR_HEIGHT, differences: viewMode === 'differences' ? differences : { ...differences, report: null }, files: viewMode === 'differences' ? differencesFiles() : null, speed: viewMode === 'differences' ? forPage(speed, { progress: meter?.progress() || null }) : null, checks: viewMode === 'differences' ? forPage(checks) : null, addons: addons?.snapshot() || { installed: [], pending: null }, addonTabs: viewMode === 'differences' ? addonTabs() : [], site: viewMode === 'differences' ? siteView() : null, performance, comparison: visibleComparison(), paneLayout, find: findState, sslVerification: config.sslVerification, activeSSL, sslPolicyVersion: config.sslPolicyVersion, sslMigration: config.sslMigration, library: library?.snapshot() || {bookmarks:[],history:[],downloads:[]}, downloads: [...downloadItems.values()].map(d=>d.record), tabs: [...tabs.values()].map(t => ({ mode: t.mode, route: route(t), site: t.site || null, connection: t.connection, id: t.id, title: t.title, url: t.url, startPage: t.startPage, loading: t.loading, devtools: Boolean(t.toolsOpen), zoom: t.zoom, error: t.error, certBlocked: t.error && t.certBlocked ? { host: t.certBlocked.host, error: t.certBlocked.error, subject: t.certBlocked.subject } : null, files: t.mode === 'auth' ? null : paneSummary(t.files, otherRecord(t)), noindex: noindexOf(t), chips: addonChips(t), back: t.ruleHistoryIndex !== undefined ? t.ruleHistoryIndex > 0 : t.view.webContents.navigationHistory.canGoBack(), forward: t.ruleHistoryIndex !== undefined ? t.ruleHistoryIndex < t.view.webContents.navigationHistory.length() - 1 : t.view.webContents.navigationHistory.canGoForward() })), activeId, rules: config.rules, activeRules, servers: config.servers, pending: pending(), panel, platform: process.platform, versions: { app: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome }, updateFeed: updateFeed(), autoUpdates: config.autoUpdates, update: updateState, devtoolsDock: config.devtoolsDock, devtoolsRatio: config.devtoolsRatio, compareRatio: config.compareRatio, toolsLayout, draggingTools, claude: { ...claudeState, autoCheck: config.claudeAutoCheck, update: claudeUpdates?.state || {status:'idle', version:'', message:'Not checked yet.'} } };
}
function emit() {
  // Tab views are destroyed while quitting; state() must not touch them then.
  if (!quitting && win && !win.isDestroyed()) win.webContents.send('state', state());
}
function layout() {
  if (!win || win.isDestroyed()) return;
  closeCard();
  const [width, height] = win.getContentSize();
  const sidebar = panel ? Math.min(panel === 'claude' ? 480 : 380, Math.floor(width * .48)) : 0;
  if (claudeView) { const top = 96 + (visibleComparison() ? 0 : ROUTE_BAR_HEIGHT); claudeView.setBounds({ x: width - sidebar, y: top, width: Math.max(1, sidebar), height: Math.max(1,height - top - FOOTER_HEIGHT) }); claudeView.setVisible(panel === 'claude' && !authRequest && !onboardingOpen && !draggingTools); }
  toolsLayout = null; paneLayout = [];
  const pair = visibleComparison(), differing = !pair && viewMode === 'differences';
  const split = pair && compareLayout(Math.max(1, width - sidebar), config.compareRatio);
  const narrowest = pair ? Math.min(split.left.width, split.right.width) : width - sidebar;
  const routeHeight = pair && narrowest <= 300 ? 156 : pair && narrowest <= 454 ? 86 : ROUTE_BAR_HEIGHT;
  for (const tab of tabs.values()) {
    const selected = pair ? [pair.host, pair.live].includes(tab.id) : tab.id === activeId;
    const visible = selected && !authRequest && !onboardingOpen && !draggingTools && !differing;
    const bounds = devtoolsLayout(width, height, sidebar, config.devtoolsDock, config.devtoolsRatio, !pair && tab.toolsOpen, routeHeight);
    if (pair) { const split = compareLayout(bounds.page.width, config.compareRatio); Object.assign(bounds.page, tab.id === pair.live ? split.right : split.left); }
    if (findState.open) { bounds.page.y += 38; bounds.page.height -= 38; }
    // Both native pages begin below the taller bar when a comparison pane wraps.
    const banner = { x: pair ? bounds.page.x : 0, y: 96, width: pair ? bounds.page.width : Math.max(1, width - sidebar), height: routeHeight };
    if (selected && !differing) paneLayout.push({ id: tab.id, page: {...bounds.page}, banner });
    tab.view.setBounds(bounds.page);
    tab.view.setVisible(visible && !tab.startPage && !tab.error);
    if (tab.tools && bounds.tools) {
      tab.tools.setBounds(bounds.tools);
      tab.tools.setVisible(visible && Boolean(tab.toolsOpen));
    } else if (tab.tools) tab.tools.setVisible(false);
    if (tab.id === activeId && tab.toolsOpen && !pair && !authRequest && !onboardingOpen) toolsLayout = bounds;
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
// History and fragment-only address loads can reuse an accepted document. Once
// the selected main frame commits, force a fresh load under the current policy.
function reloadRuleHistory(tab, index) {
  const wc = tab.view.webContents, requestedURL = tab.url;
  let selectedURL = requestedURL;
  const cleanup = () => {
    clearTimeout(timer); wc.removeListener('did-navigate', selected); wc.removeListener('did-navigate-in-page', selectedInPage); wc.removeListener('did-redirect-navigation', redirected); wc.removeListener('did-fail-load', failed); wc.removeListener('destroyed', cleanup);
    if (tab.cancelRuleHistory === cleanup) delete tab.cancelRuleHistory;
  };
  const replace = (url, error, forceReload = false) => {
    cleanup();
    // Inputs stay deferred through the history commit; replay the newest choice.
    const next = tab.ruleHistoryIndex;
    if (next !== index || tab.url !== requestedURL) return reloadRuleHistory(tab, next);
    tab.reloadingRules = false; delete tab.ruleHistoryIndex;
    tab.url = url; persist();
    if (error) failure(tab, error);
    else if (forceReload) wc.reloadIgnoringCache();
    else { layout(); emit(); }
  };
  // did-navigate is main-frame only; in-page and redirect events also cover subframes.
  const committed = (url, inPage) => { if ((index === undefined || wc.navigationHistory.getActiveIndex() === index) && url === selectedURL) replace(url, null, index !== undefined || inPage); };
  const selected = (_event, url) => committed(url, false);
  const selectedInPage = (_event, url, main) => { if (main) committed(url, true); };
  const redirected = (_event, url, _inPlace, main) => { if (main) selectedURL = url; };
  const failed = (_event, code, description, failedURL, main) => { if (main && code !== -3 && failedURL === selectedURL) replace(failedURL, `${description} (${code})`); };
  const timer = setTimeout(() => { cleanup(); if (!wc.isDestroyed()) wc.close(); }, 20000);
  tab.cancelRuleHistory = cleanup;
  wc.on('did-navigate', selected); wc.on('did-navigate-in-page', selectedInPage); wc.on('did-redirect-navigation', redirected); wc.on('did-fail-load', failed); wc.once('destroyed', cleanup);
  try {
    if (index !== undefined) wc.navigationHistory.goToIndex(index);
    else wc.loadURL(requestedURL, { extraHeaders: 'Cache-Control: no-cache\n' }).catch(() => {}); // Native main-frame events settle same-document loads too.
  } catch (error) { cleanup(); throw error; }
}
function historyStep(tab, offset) {
  const history = tab.view.webContents.navigationHistory;
  if (!tab.reloadingRules) { if (history.canGoToOffset(offset)) history.goToOffset(offset); return; }
  const index = (tab.ruleHistoryIndex ?? history.getActiveIndex()) + offset, entry = history.getEntryAtIndex(index);
  if (!entry) return;
  tab.ruleHistoryIndex = index; tab.url = entry.url; tab.startPage = entry.url === 'about:blank'; tab.error = '';
  persist(); layout(); emit();
}
function reloadTab(tab, ignoreCache = false) {
  if (!tab) return;
  tab.error = ''; layout();
  if (!tab.reloadingRules) ignoreCache ? tab.view.webContents.reloadIgnoringCache() : tab.view.webContents.reload();
}

function handleShortcut(event,input,tab=current()) {
  if(!tab) return; const wc=tab.view.webContents;
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape') closeCard();
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (mod && key === 'l') { event.preventDefault(); focusAddress(); }
    if (mod && key === 'r') { event.preventDefault(); reloadTab(tab, input.shift); }
    if (mod && key === 't') { event.preventDefault(); if(input.shift) reopenTab(); else {newTab(); focusAddress();} }
    if (mod && key === 'f') { event.preventDefault(); openFind(); }
    if (mod && key === 'd') { event.preventDefault(); bookmarkCurrent(); }
    if (input.key === 'Escape' && findState.open) {event.preventDefault();closeFind();layout();emit();}
    if (mod && key === 'w') { event.preventDefault(); closeTab(tab.id); }
    // Zoom like Chrome: + (or =), − and 0. Here too, because a page view that has the focus does not always pass them to the menu.
    if (mod && !input.alt && ['+', '=', '-', '0'].includes(input.key)) { event.preventDefault(); zoomAction(input.key === '-' ? 'out' : input.key === '0' ? 'reset' : 'in'); }
    if (input.key === 'F12') { event.preventDefault(); toggleDevTools(tab); }
}
function bindTab(view, initial = 'about:blank', load = true, foreground = true) {
  const tab = { mode: view.webContents.session === liveSession ? 'live' : view.webContents.session === claudeAuthSession ? 'auth' : 'hostfile', connection: null, requestHosts: new Set(), files: createRecord(), id: nextId++, view, url: initial, startPage: load && initial === 'about:blank', title: 'New tab', loading: false, error: '', zoom: 1 };
  tabs.set(tab.id, tab); win.contentView.addChildView(view);
  const wc = view.webContents;
  wc.setZoomMode('isolated'); // zoom per tab, not per site (see setZoom)
  claude?.bind(tab);
  watchFiles(wc, tab);
  wc.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
    event.preventDefault();
    const host = new URL(url).hostname.toLowerCase(), print = fingerprint(certificate);
    const skipped = tab.mode === 'hostfile' && skipCertificate(host);
    const canTrust = tab.mode === 'live' && Boolean(print) && !protectedHost(host), trusted = canTrust && liveExceptions.get(host) === print;
    const summary = certSummary(certificate);
    if (tab.mode !== 'auth' && summary) certificates.set(certKey(tab.mode, host), { ...summary, verificationResult: error, verified: false });
    // Kept in main only: Continue anyway can trust nothing but the certificate this tab was refused.
    if (isMainFrame && canTrust && !trusted) tab.certBlocked = { host, print, error, subject: summary?.subject || '' };
    // Electron 45.2.2 crashes the main process (SIGSEGV) when this callback runs inside the event for a wss:// request,
    // with true or false alike; one tick later it is fine. The decision is taken above, only the answer waits.
    const answer = skipped || trusted; setImmediate(() => callback(answer));
  });
  wc.on('input-event', (_event, input) => { if (input.type === 'mouseDown') closeCard(); });
  wc.on('focus', () => { if (visibleComparison() && activeId !== tab.id) activate(tab.id); });
  wc.on('found-in-page', (_event,result) => { if (tab.id === activeId && findState.open) { findState.matches=result.matches; findState.active=result.activeMatchOrdinal; emit(); } });
  wc.on('page-title-updated', (_event, title) => { tab.title = title || 'New tab'; emit(); });
  wc.on('did-start-loading', () => { tab.loading = true; emit(); });
  wc.on('did-stop-loading', () => { tab.loading = false; if (!tab.reloadingRules && !tab.error && allowed(wc.getURL())) { tab.url = wc.getURL(); if(tab.mode !== 'auth') library.visit(tab.url, wc.getTitle()); persist(); inspectSite(tab); scanTab(tab); } emit(); });
  wc.on('did-start-navigation', (_event, url, inPlace, isMainFrame) => {
    if (!isMainFrame || inPlace) return;
    // A new document: what failed belongs to the page that is now loading. Reload both keeps Differences open.
    const keepView = tab.keepView; tab.keepView = false; tab.files = createRecord(); filesChanged();
    if (!tab.reloadingRules) { if (tab.id === activeId && !keepView) viewMode = 'single'; tab.requestHosts.clear(); tab.certBlocked = null; try { certificates.delete(certKey(tab.mode, new URL(url).hostname)); } catch {} tab.navStart = Date.now(); tab.connection = null; tab.site = null; tab.siteHeaders = {}; tab.robots = null; tab.url = url; leaveSite(tab, url); if (url !== 'about:blank') tab.startPage = false; tab.error = ''; layout(); emit(); }
  });
  const navigated = (_event, url) => { if (tab.reloadingRules) return; tab.url = url; tab.error = ''; persist(); layout(); emit(); };
  wc.on('did-navigate', navigated); wc.on('did-navigate', () => applyZoom(tab));
  wc.on('did-redirect-navigation', (_event,url,_inPlace,isMainFrame) => {if(isMainFrame && !tab.reloadingRules){tab.url=url;tab.connection=null;emit();}});
  wc.on('did-navigate-in-page', (event, url, main) => { if (main) navigated(event, url); });
  for (const name of ['will-navigate', 'will-redirect']) wc.on(name, (event, url) => { if (!allowed(url)) { event.preventDefault(); failure(tab, 'Unsupported address type. Use http or https.'); } });
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code === -3 && !tab.reloadingRules && tab.url === url && allowed(wc.getURL())) { tab.url = wc.getURL(); persist(); emit(); }
    if (isMainFrame && code !== -3 && !tab.reloadingRules) { tab.url = url; failure(tab, `${description} (${code})`); }
  });
  wc.once('destroyed', () => {
    if (quitting || !tabs.has(tab.id)) return;
    if (authRequest?.webContentsId === wc.id) finishAuth(null);
    if (comparison && [comparison.host, comparison.live].includes(tab.id)) { keepPeer(comparison); comparison = null; }
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
  if (load) wc.loadURL(initial).catch(error => { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) failure(tab, error.message); });
  if (foreground) activate(tab.id); else layout(); persist(); return tab;
}
function newTab(url = 'about:blank', foreground = true, mode = 'hostfile') {
  if (tabs.size >= 50) { win.webContents.send('notice', 'Up to 50 tabs at once. Close a tab first.'); return null; }
  const targetSession = /^https:\/\/claude\.ai\/oauth\//.test(url) ? claudeAuthSession : mode === 'live' ? liveSession : webSession;
  return bindTab(new WebContentsView({ webPreferences: { session: targetSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } }), navigationURL(url), true, foreground);
}
function closeTab(id) {
  const tab = tabs.get(id); if (!tab) return;
  leaveSite(tab, '');
  if (tab.mode !== 'auth' && /^https?:/.test(tab.url)) { closedTabs.push({url:tab.url,mode:tab.mode}); if(closedTabs.length>25) closedTabs.shift(); }
  if (comparison && [comparison.host, comparison.live].includes(id)) { keepPeer(comparison); comparison = null; }
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
function closeClaudeView() {
  if (!claudeView) return;
  const view = claudeView; claudeView = null;
  win.contentView.removeChildView(view); view.webContents.close();
}
async function installClaudeVersion(initial) {
  if (!claudeUpdates || claudeUpdates.busy || claudeState.status === 'loading') throw new Error('Wait for the current Claude operation to finish.');
  const previous = claudeState;
  const url = claudeView && new URL(claudeView.webContents.getURL());
  claudeReopen = {page:url ? url.pathname.slice(1) + url.search : initial ? `sidepanel.html?tabId=${current()?.view.webContents.id}` : null, panel:initial ? 'claude' : panel};
  claudeState = {...claudeState, status:'installing', message:initial ? 'Downloading Claude…' : 'Updating Claude…'}; emit();
  try { await claudeUpdates.install({initial}); }
  catch (error) {
    if (claudeState.status === 'installing') claudeState = initial ? {...previous, status:'error', message:error.message} : previous;
    else if (claudeState.status !== 'ready') claudeState = {...claudeState, status:'error', message:error.message};
    throw error;
  } finally { claudeReopen = null; layout(); emit(); }
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
function stopCompare() { const pair=comparison; comparison=null; if(pair) {keepPeer(pair);activate(pair.host);closeTab(pair.live);} layout(); }
// The tab that Differences works on: a Hostfile tab on a domain with an active rule.
function ruledTab(what) {
  const tab=visibleComparison() ? tabs.get(comparison.host) : current();
  if (!tab || tab.mode !== 'hostfile' || !/^https?:/.test(tab.url)) throw new Error(`Open a website in a Hostfile tab to ${what} it.`);
  const rule=activeHosts.find(r=>r.enabled && r.domain===new URL(tab.url).hostname);
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
// The routes of Differences: Hostfile goes to the IP of the rule (Skip SSL as the rule says), Live through normal DNS and
// trusts only a certificate the user chose Continue anyway for.
const hostfileRoute = host => ({ ip: activeHosts.find(r => r.enabled && r.domain === host)?.ip, skipSSL: skipCertificate(host) });
const liveRoute = host => (liveExceptions.has(host) ? { pin: liveExceptions.get(host) } : null);
// One page of one server. Redirects are followed by hand and only within the site (redirectStep in site-scope.cjs): a
// server decides where its Location points, and another host is never asked on its word. The answer then carries
// left = { host, own }, and the caller says what happened. get(target) asks one address without following.
const SITE_HOPS = 5;
async function followSite(get, url, ruled) {
  const redirects = []; let target = url, doc, ms = 0;
  for (;;) {
    doc = await get(target); ms += doc.ms || 0;
    if (!doc.ok || !doc.to) break;
    const step = redirectStep(target, doc.to, ruled);
    if (step.left) { doc = { ...doc, left: step.left }; break; }
    if (redirects.length >= SITE_HOPS || step.follow === target) break;
    redirects.push({ status: doc.status, location: step.follow }); target = step.follow;
  }
  return { ...doc, ms, finalUrl: target, redirects };
}
const ruledName = name => Boolean(hostfileRoute(name).ip);
const hostfilePage = url => followSite(target => fetchDocument(webSession, target, { redirects: 0, resolveRoute: hostfileRoute }), url, ruledName);
const livePage = url => followSite(target => fetchDocument(liveSession, target, { redirects: 0, resolveRoute: liveRoute }), url);
// A redirect that was not followed, as findings of a single comparison.
function leftAsFindings(hostfile, live) {
  const { both, findings } = leftFindings(hostfile.left, live.left);
  if (both) return [{ severity: 'info', text: `Both servers send this page to ${both.host}. Not followed: open that address to compare it.` }];
  return findings.map(f => ({ severity: f.state === 'fix' ? 'high' : 'medium', text: `${f.text}.` }));
}
// fresh: the user clicked Compare again, so the add-ons are told to ask again instead of using what they remember.
function runDifferences(fresh = false) {
  const { tab } = ruledTab('compare'), url = tab.url;
  if (diffRun?.url === url) return diffRun.promise;
  const mine = { url };
  liveRetry = null; differences = { status: 'running', report: null, error: '', liveReason: null, liveRetry: false }; emit();
  mine.promise = (async () => {
    try {
      await ensureLive();
      const [hostfile, live] = await Promise.all([hostfilePage(url), livePage(url)]);
      const report = buildReport({ url, hostfile, live });
      report.findings.unshift(...leftAsFindings(hostfile, live));
      // The new server answers and Live cannot be reached: say why, and judge the new server on its own.
      const reason = hostfile.ok ? await reasonFor(url, live) : null;
      if (reason) report.findings = soloFindings(report.findings, reason);
      report.counts.findings = report.findings.length;
      if (diffRun === mine) { differences = { status: 'done', report, error: '', liveReason: reason, liveRetry: false }; afterDifferences(url, hostfile, live, fresh); }
      return report;
    } catch (error) { if (diffRun === mine) differences = { status: 'error', report: null, error: error.message, liveReason: null, liveRetry: false }; throw error; }
    finally { if (diffRun === mine) diffRun = null; emit(); }
  })();
  diffRun = mine; return mine.promise;
}
// Why Live failed, or null when it answered or failed in another way (a certificate keeps Continue anyway). A refused or
// silent server's error often names no address: one dns.lookup of the host that failed, at most 2 seconds.
async function reasonFor(url, live) {
  if (live.ok) return null;
  const lookup = host => Promise.race([dns.lookup(host).then(r => r.address, () => ''), new Promise(resolve => setTimeout(resolve, 2000, ''))]);
  const ip = needsAddress(live) ? await lookup(failingHost(url, live)) : '';
  return liveReason(live, { url, ip, checkedAt: new Date().toISOString() });
}
// Differences already knows that Live cannot be reached for this page: Speed and Checks leave Live alone.
const liveUnreachable = url => Boolean(differences.status === 'done' && differences.liveReason && differences.report && sameDocument(differences.report.url, url));
// Measure Live too and Check Live too: ask Live again first. When it answers, the normal comparison runs (both servers,
// then checks and speed); when it does not, only the reason is updated and the results of the new server stay.
function retryLive() {
  const { tab } = ruledTab('compare'), url = tab.url, known = differences.report;
  if (diffRun) return diffRun.promise;
  if (!liveUnreachable(url)) return runDifferences();
  if (liveRetry?.url === url) return liveRetry.promise;
  const mine = liveRetry = { url };
  differences = { ...differences, liveRetry: true }; emit();
  mine.promise = (async () => {
    try {
      await ensureLive();
      const live = await livePage(url);
      if (liveRetry !== mine || differences.report !== known) return null;
      const reason = await reasonFor(url, live);
      if (liveRetry !== mine || differences.report !== known) return null;
      liveRetry = null;
      // Live answers now, or fails another way (for example its certificate): the normal comparison shows it.
      if (!reason) return runDifferences();
      const { body: _body, headers: _headers, ...rest } = live, findings = soloFindings(known.findings, reason);
      differences = { ...differences, report: { ...known, live: rest, findings, counts: { ...known.counts, findings: findings.length } }, liveReason: reason, liveRetry: false };
      return differences.report;
    } finally {
      if (liveRetry === mine) liveRetry = null;
      if (differences.liveRetry && !liveRetry) differences = { ...differences, liveRetry: false };
      emit();
    }
  })();
  return mine.promise;
}
// Speed and Checks belong to one URL: the window only gets them for the page it shows.
function forPage(run, extra = {}) {
  const tab = current();
  return tab && run.url && sameDocument(run.url, tab.url) ? { ...run, ...extra } : { status: 'idle', url: '', report: null, error: '' };
}
function resetPageChecks() {
  speedRun = null; checksRun = null; meter?.cancel(); addonRun = null; addonRuns = { url: '', results: byAddon() };
  speed = { status: 'idle', url: '', report: null, error: '' }; checks = { status: 'idle', url: '', report: null, error: '' };
}
// After a comparison: first the checks (a few small requests), then the speed loads, so the checks do not slow down
// the servers while they are measured.
function afterDifferences(url, hostfile, live, fresh = false) {
  resetPageChecks();
  const mine = checksRun = { url }, solo = liveUnreachable(url);
  checks = { status: 'running', url, report: null, error: '' }; speed = { status: 'waiting', url, report: null, error: '' };
  scanDifferences(url, hostfile, solo ? { ok: false } : live, fresh); emit();
  (solo ? runSoloChecks(url, hostfile) : runChecks(url, hostfile, live)).then(report => { if (checksRun === mine) checks = { status: 'done', url, report, error: '' }; },
    error => { if (checksRun === mine) checks = { status: 'error', url, report: null, error: String(error.message || error).slice(0, 300) }; })
    .finally(() => { if (checksRun !== mine) return; checksRun = null; emit(); measureSpeed(url); });
}
// Anonymous, bounded requests through the routes of Differences: at most 9 addresses, two at a time on both servers,
// redirects not followed, 8 seconds and 256 KB each.
const CHECK_TIMEOUT_MS = 8000, CHECK_BODY = 256 * 1024, CHECK_BATCH = 2;
async function inBatches(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += CHECK_BATCH) out.push(...await Promise.all(items.slice(i, i + CHECK_BATCH).map(fn)));
  return out;
}
// Other copies of the site: hosts with a disabled rule or a rule to another server.
function copiesOf(host) {
  const rule = activeHosts.find(r => r.enabled && r.domain === host);
  return config.rules.filter(r => r.domain !== host && (!r.enabled || r.ip !== rule?.ip)).map(r => r.domain);
}
// Each card gets an id: a Copy button names its card and main copies its own text, never text from the window.
function cardIds(report) { report.groups.forEach(g => g.items.forEach((c, i) => { c.id = `${g.id}-${i}`; })); return report; }
// Live cannot be reached: the same bounded requests, to the new server only (www to bare waits for Live).
// get(side, target, options): how a whole-site run asks, so its requests are counted; a single page asks directly.
async function runSoloChecks(url, hostfile, get = null) {
  if (!hostfile.ok) throw new Error('The page could not be fetched from the new server, so the checks did not run.');
  const bounded = { redirects: 0, maxBody: CHECK_BODY, timeout: CHECK_TIMEOUT_MS };
  const ask = target => (get ? get('hostfile', target, bounded) : fetchDocument(webSession, target, { ...bounded, resolveRoute: hostfileRoute }));
  const page = new URL(url), robots = await ask(`${page.origin}/robots.txt`), wordpress = pageFacts(hostfile.body, url).wordpress;
  // The sitemap address comes from the robots.txt of the new server.
  const list = standardAddresses({ pageURL: url, hostfileHTML: hostfile.body, wordpress, robotsLive: robots.body, routed: host => activeHosts.some(r => r.enabled && r.domain === host), random: randomUUID().slice(0, 8) });
  const answers = new Map(await inBatches(list.filter(c => c.id !== 'www'), async check => [check, check.id === 'robots' ? robots : await ask(check.url)]));
  return cardIds(soloChecksReport({ pageURL: url, hostfile, standard: list.map(check => ({ check, hostfile: answers.get(check) })), copies: copiesOf(page.hostname) }));
}
async function runChecks(url, hostfile, live, get = null) {
  // Without the page of both servers every check would pass on an empty page.
  if (!hostfile.ok || !live.ok) throw new Error(`The page could not be fetched from ${!hostfile.ok ? 'the new server' : 'Live'}, so the checks did not run.`);
  await ensureLive();
  const options = { redirects: 0, maxBody: CHECK_BODY, timeout: CHECK_TIMEOUT_MS };
  const ask = target => (get ? Promise.all([get('hostfile', target, options), get('live', target, options)]) : Promise.all([fetchDocument(webSession, target, { ...options, resolveRoute: hostfileRoute }), fetchDocument(liveSession, target, { ...options, resolveRoute: liveRoute })]));
  const page = new URL(url), robots = await ask(`${page.origin}/robots.txt`);
  const wordpress = pageFacts(hostfile.body, url).wordpress || pageFacts(live.body, url).wordpress;
  const list = standardAddresses({ pageURL: url, hostfileHTML: hostfile.body, liveHTML: live.body, wordpress, robotsLive: robots[1].body, routed: host => activeHosts.some(r => r.enabled && r.domain === host), random: randomUUID().slice(0, 8) });
  const standard = await inBatches(list, async check => { const [h, l] = check.id === 'robots' ? robots : await ask(check.url); return { check, hostfile: h, live: l }; });
  const copies = copiesOf(page.hostname);
  // The old server's own name (reverse DNS), where a temporary URL such as /~user/ of the hosting account lives.
  const oldName = live.ip ? await Promise.race([reverseName(bareIP(live.ip)), new Promise(resolve => setTimeout(resolve, 2000, ''))]) : '';
  return cardIds(checksReport({ pageURL: url, hostfile, live, standard, oldIP: live.ip, oldHosts: [oldName].filter(Boolean), copies }));
}
/* Add-ons (1.4): signed extra tools from their own feed (addons.cjs). Their scans run where the checks run: after a
   comparison (both servers), and after a page has loaded in a tab (the server that tab shows). */
// Results are keyed by add-on id in objects without a prototype: an add-on may be called "constructor".
const byAddon = (from = {}) => Object.assign(Object.create(null), from);
let addons = null, addonRuns = { url: '', results: byAddon() }, addonRun = null;
// How a scan reaches a server: the rule of the new server, Live through its own session, or a tab without a rule.
const ADDON_ROUTES = { hostfile: () => ({ ses: webSession, resolveRoute: hostfileRoute }), live: () => ({ ses: liveSession, resolveRoute: liveRoute }), plain: () => ({ ses: webSession, resolveRoute: hostfileRoute }) };
// An add-on gets at most 2 MB of a page: its scan runs in this process, and a huge page must not hold up the window.
const ADDON_PAGE = 2 * 1024 * 1024, ADDON_AGAIN_MS = 60000;
const addonPages = pages => Object.fromEntries(Object.entries(pages).map(([side, page]) => [side, { ...page, body: String(page.body || '').slice(0, ADDON_PAGE) }]));
// Every request an add-on makes goes through one counter per site and at most four at a time per server (host-budget.cjs).
// who: under whose name the requests are booked, with its limit (BROWSE, COMPARE or a whole-site run). limited: Dioptra refused a request, so the scan did not see everything.
const budget = createBudget();
// Test only, in an app that is not packaged: --scan-budget=<n> sets how many requests the scans after page loads may book.
const scanBudgetArg = app.isPackaged ? '' : process.argv.find(v => v.startsWith('--scan-budget=')) || '';
const SCAN = scanBudgetArg ? { kind: 'browse', limit: Math.min(BROWSE.limit, Math.max(0, Number(scanBudgetArg.slice(14)) || 0)) } : BROWSE;
// rescan: the user asked for a fresh result (Compare again, a whole-site run); the add-on is told so.
// alive: the whole-site run that asked is still going (its own check next to the one of the scan).
async function runAddon(id, url, pages, via, who = COMPARE, rescan = false, alive = null) {
  let limited = false;
  const host = new URL(url).hostname;
  const fetchPage = (side, target, headers, wanted) => { const r = ADDON_ROUTES[via[side]](); return budget.ask(host, side, who, () => fetchDocument(r.ses, target, { redirects: 0, maxBody: CHECK_BODY, timeout: CHECK_TIMEOUT_MS, headers, resolveRoute: r.resolveRoute }), () => (!wanted || wanted()) && (!alive || alive())).catch(error => { if (error instanceof BudgetError) limited = true; throw error; }); };
  try { const report = await addons.scan(id, { url, pages: addonPages(pages), fetchPage, rescan }); return { status: 'done', report, error: '', at: Date.now(), limited }; }
  catch (error) { if (!(error instanceof BudgetError) && !(error instanceof StoppedError)) console.error(`Add-on ${id}:`, error?.message || error); return { status: 'error', report: null, error: String(error?.message || error).slice(0, 300), limited }; }
}
function scanDifferences(url, hostfile, live, fresh = false) {
  const list = addons?.active() || [], pages = {};
  addonRun = null; addonRuns = { url, results: byAddon() };
  if (!list.length) return;
  if (hostfile.ok) pages.hostfile = hostfile;
  if (live.ok) pages.live = live;
  const none = !Object.keys(pages).length, mine = addonRun = { url };
  for (const a of list) addonRuns.results[a.id] = none ? { status: 'error', report: null, error: 'The page could not be fetched, so the scan did not run.' } : { status: 'running', report: null, error: '' };
  if (none) return;
  for (const a of list) runAddon(a.id, url, pages, { hostfile: 'hostfile', live: 'live' }, COMPARE, fresh).then(result => { if (addonRun !== mine) return; addonRuns = { url, results: byAddon({ ...addonRuns.results, [a.id]: result }) }; emit(); });
}
// A page has loaded: scan it on the server this tab shows. Sign-in pages and account services are left alone.
function scanTab(tab) {
  const list = addons?.active() || [];
  // The scan of this very page is still running (a slow server): no second one next to it.
  if (tab.addonScanned?.url === tab.url && tab.addonScanned.scan.pending) { tab.addonScan = tab.addonScanned.scan; return; }
  tab.addonScan = null;
  let host = '', query = ''; try { const u = new URL(tab.url); host = u.hostname.replace(/\.$/, ''); query = u.search; } catch {}
  if (!list.length || tab.mode === 'auth' || tab.startPage || !/^https?:/.test(tab.url) || !host || protectedHost(host)) return;
  // A scan asks for the page again. Not for addresses that may work only once or do something (a sign-in callback, a
  // reset or unsubscribe link: anything with a query), not for devices and services on this computer or the LAN unless
  // there is a domain rule for them, and not twice within a minute (a page that reloads itself).
  const ruledHost = activeHosts.some(r => r.enabled && r.domain === host);
  if (query || (!ruledHost && (host === 'localhost' || /^[\d.]+$/.test(host) || host.startsWith('[') || !host.includes('.') || /\.(local|lan|internal|home|localhost)$/.test(host)))) return;
  if (tab.addonScanned?.url === tab.url && Date.now() - tab.addonScanned.at < ADDON_AGAIN_MS) { tab.addonScan = tab.addonScanned.scan; return; }
  const url = tab.url, mine = tab.addonScan = { url, results: byAddon(), pending: true };
  tab.addonScanned = { url, at: Date.now(), scan: mine };
  const ruled = tab.mode === 'hostfile' && Boolean(route(tab).configured), kind = ruled ? 'hostfile' : tab.mode === 'live' ? 'live' : 'plain', side = ruled ? 'hostfile' : 'live';
  (async () => {
    if (kind === 'live') await ensureLive();
    // The page is asked once more for the scan: that request counts too. Browsing gets the small limit.
    // Redirects only within the site, and every hop counts.
    const r = ADDON_ROUTES[kind](), page = await followSite(target => budget.ask(host, side, SCAN, () => fetchDocument(r.ses, target, { redirects: 0, resolveRoute: r.resolveRoute })), url, kind === 'hostfile' ? ruledName : undefined);
    if (tab.addonScan !== mine || !page.ok) return;
    // The page is somewhere else: that is said, and the other place is not scanned.
    if (page.left) { for (const a of list) mine.results[a.id] = { status: 'error', report: null, error: `This page redirects to ${page.left.host}, so it was not scanned.` }; emit(); return; }
    await Promise.all(list.map(async a => { const result = await runAddon(a.id, url, { [side]: page }, { [side]: kind }, SCAN); if (tab.addonScan === mine) { mine.results[a.id] = result; emit(); } }));
  })().catch(error => {
    // Dioptra refused to ask the page again for the scan: every add-on says so on this tab, none reads as clean.
    if (error instanceof BudgetError) { for (const a of list) mine.results[a.id] = { status: 'error', report: null, error: error.message, limited: true, at: Date.now() }; if (tab.addonScan === mine) emit(); }
    else console.error('Add-on scan:', error?.message || error);
  }).finally(() => {
    mine.pending = false;
    // The add-ons changed while this scan ran: scan once more now, not next to it.
    if (tab.addonAgain) { tab.addonAgain = false; tab.addonScanned = null; if (tabs.has(tab.id)) scanTab(tab); }
  });
}
// Installed, removed or switched: every open page is scanned again; Differences scans with its next comparison.
// A tab whose scan is still running is scanned again when that one is done, not at the same time.
function rescanTabs() { addonRun = null; addonRuns = { url: '', results: byAddon() }; for (const tab of tabs.values()) { if (tab.addonScanned?.scan.pending) { tab.addonAgain = true; continue; } tab.addonScanned = null; scanTab(tab); } }
// The result for a tab: the scan of the tab itself or the comparison of both servers for this page, whichever is newer
// (the page may have been loaded again since the comparison).
function addonResult(tab, id) {
  const both = tab.mode === 'hostfile' && addonRuns.url && sameDocument(addonRuns.url, tab.url) ? addonRuns.results[id] : null;
  const own = tab.addonScan && sameDocument(tab.addonScan.url, tab.url) ? tab.addonScan.results[id] : null;
  const done = [both, own].filter(r => r?.status === 'done');
  // No finished scan: one that Dioptra cut short still counts, so the tab does not read as clean.
  return done.sort((a, b) => b.at - a.at)[0] || [both, own].find(r => r?.limited) || null;
}
const LIMITED_NOTE = 'Dioptra stopped asking this site: too many requests went to it in a short time. The scan did not see everything; it runs again in a few minutes.';
// The red label next to the server name. It opens the add-on's tab in Differences when this tab has a rule, else a card.
function addonChips(tab) {
  if (tab.mode === 'auth' || tab.startPage) return [];
  // A scan that was cut short and found nothing gets an orange "Limited" label: no label would read as clean.
  return (addons?.active() || []).map(a => ({ a, result: addonResult(tab, a.id) })).filter(x => x.result?.report?.label || x.result?.limited).map(({ a, result: { report, limited } }) => ({
    id: a.id, text: report?.label || 'Limited', tone: report?.label ? report.tone : 'warn', differences: tab.mode === 'hostfile' && Boolean(route(tab).configured),
    title: report?.label ? `${a.name} found ${report.counts.problems} ${report.tone === 'warn' ? 'problem' : 'threat'}${report.counts.problems === 1 ? '' : 's'} on this page.${limited ? ' The scan was cut short.' : ''}` : `${a.name} could not finish its scan of this page.` }));
}
function addonTabs() {
  const tab = current();
  return (addons?.active() || []).map(a => ({ id: a.id, name: a.name, by: a.by, scope: a.scope, label: a.tab.label, sub: a.tab.sub, ...(tab && addonRuns.url && sameDocument(addonRuns.url, tab.url) && addonRuns.results[a.id] || { status: 'idle', report: null, error: '' }) }));
}
function addonCard(tab) {
  return { items: (addons?.active() || []).map(a => ({ name: a.name, result: addonResult(tab, a.id) })).filter(x => x.result?.report || x.result?.limited).map(({ name, result: { report, limited } }) => ({
    name, summary: report ? `${limited ? 'Limited · ' : ''}${report.summary.map(s => s.text).join(' · ')}` : 'Limited · not scanned',
    lines: report ? report.groups.flatMap(g => g.items.map(item => ({ label: g.label, text: item.title, value: item.values[report.sides[0]] || '', threat: item.tone === 'worse' }))) : [],
    note: [limited ? LIMITED_NOTE : '', report?.note || ''].filter(Boolean).join(' ') })) };
}
/* Whole site (1.4.0-beta.4): the same comparison for a list of pages of the site, two pages at a time, and what they
   say together (site-scope.cjs). Per page: both documents (status, redirects, headers, HTML, external domains), the
   checks that are about the page, every page-scope add-on. Once, on the home page: the site-wide checks and the
   site-scope add-ons. Not per page: Speed and Files, which need a real page load. Every request goes through the
   counter and the lanes of host-budget.cjs. The result lives in memory with its tab until the tab leaves the site. */
const SITE_PAGES_AT_ONCE = 2;
// Test only, in an app that is not packaged: --site-budget=<n> makes a whole-site run reach its request limit early.
const testSiteBudget = app.isPackaged ? 0 : Number((process.argv.find(v => v.startsWith('--site-budget=')) || '').slice(14)) || 0;
function siteView() {
  const tab = current(), run = tab?.whole;
  let host = ''; try { host = bareHost(new URL(tab.url).hostname); } catch {}
  return run && run.host === host ? { ...run.view, running: run.running, choices: PAGE_CHOICES, max: MAX_PAGES } : null;
}
function leaveSite(tab, url) {
  const run = tab.whole; if (!run) return;
  let host = ''; try { host = bareHost(new URL(url).hostname); } catch {}
  if (host !== run.host) { run.cancelled = true; tab.whole = null; }
}
// The page list: the sitemap named in robots.txt, else the usual addresses; first on the new server, then on Live.
// Redirects are not followed and only addresses of the site itself are asked. alive: the run was not cancelled.
// empty: a sitemap that answered but named no address at all.
async function siteList(ask, home, alive) {
  const bounded = { redirects: 0, maxBody: SITEMAP_BODY, timeout: CHECK_TIMEOUT_MS };
  let empty = '';
  for (const side of ['hostfile', 'live']) {
    if (!alive()) return null;
    const robots = await ask(side, new URL('/robots.txt', home).href, { ...bounded, maxBody: CHECK_BODY });
    const named = robots.ok && robots.status === 200 ? sitemapsInRobots(robots.body).map(value => pageOf(value, home)).filter(Boolean) : [];
    for (const address of [...new Set([...named, ...SITEMAP_PATHS.map(p => new URL(p, home).href)])]) {
      if (!alive()) return null;
      const doc = await ask(side, address, bounded);
      if (!doc.ok || doc.status !== 200) continue;
      const first = parseSitemap(doc.body), name = new URL(address).pathname.slice(1);
      let urls = first.urls, capped = first.capped;
      if (first.index) {
        urls = [];
        for (const child of first.urls.map(value => pageOf(value, home)).filter(Boolean).slice(0, SITEMAP_CHILDREN)) {
          if (!alive()) return null;
          const part = await ask(side, child, bounded);
          if (part.ok && part.status === 200) { const read = parseSitemap(part.body); urls.push(...read.urls); capped = capped || read.capped; }
        }
      }
      if (urls.length) return { name, urls, capped };
      empty ||= name;
    }
  }
  return empty ? { name: empty, urls: [], capped: false } : null;
}
// Starts a run, or says why it cannot start (no rule for the site any more): the window shows that message.
function startSite(options) {
  const { tab } = ruledTab('compare');
  runSite(tab, options).catch(error => console.error('Whole site:', error?.message || error));
}
async function runSite(tab, options) {
  const home = new URL('/', tab.url).href, host = new URL(home).hostname;
  const again = options.again && tab.whole ? tab.whole.options : null;
  const wanted = again || { limit: PAGE_CHOICES.includes(Number(options.limit)) ? Number(options.limit) : DEFAULT_PAGES, list: typeof options.list === 'string' ? options.list.slice(0, 40000) : '' };
  if (tab.whole) tab.whole.cancelled = true; // started twice: the new run takes the place of the old one
  const run = tab.whole = { host: bareHost(host), options: wanted, running: true, cancelled: false, failed: false, models: [], onceChecks: [], skipped: [], solo: null, homeSkipped: false,
    view: { status: 'listing', home, source: '', total: 0, done: 0, compared: 0, tookMs: 0, error: '', notes: [], parts: [], own: [], rest: [], solo: '', wanted: wanted.limit, homeSkipped: false } };
  // alive: this run is still the one of its tab, was not cancelled and did not stop on an error. Checked before every
  // request, also by a request that waited for its turn.
  const alive = () => tab.whole === run && !run.cancelled && !run.failed && tabs.has(tab.id), show = more => { run.view = { ...run.view, ...more }; if (tab.whole === run) emit(); };
  const started = Date.now();
  const capOf = pages => (testSiteBudget > 0 ? { kind: 'site', limit: Math.min(testSiteBudget, forSite(pages).limit) } : forSite(pages));
  let cap = capOf(wanted.limit);
  const ask = (side, target, more = {}) => budget.ask(host, side, cap, () => fetchDocument(side === 'live' ? liveSession : webSession, target, { ...more, resolveRoute: side === 'live' ? liveRoute : hostfileRoute }), alive);
  const fold = () => { const got = siteResult(run.models.filter(Boolean), { onceChecks: run.onceChecks }); return { ...got, compared: run.models.filter(Boolean).length }; };
  // One page of one server. Redirects are followed by hand, and only to the site itself: the same host name (www or
  // not), and on the new server only a name that has a domain rule. Another host is never asked: the answer then
  // carries left = { host, own } (own: another host of the same site), and the caller says what happened.
  const page = (side, url) => followSite(target => ask(side, target, { redirects: 0 }), url, side === 'hostfile' ? ruledName : undefined);
  emit();
  try {
    await ensureLive();
    let pages = [], source = '';
    const notes = [];
    if (wanted.list.trim()) {
      const picked = pastedPages(wanted.list, home); pages = picked.pages; source = 'your list';
      if (picked.refused) notes.push(`${picked.refused} left out, not an address of this site: ${picked.sample.join(', ')}${picked.refused > picked.sample.length ? ', …' : ''}`);
      if (picked.more) notes.push(`More than ${MAX_PAGES} pages: the rest of the list was left out`);
    } else {
      const found = await siteList(ask, home, alive);
      if (!alive()) return;
      if (!found) return show({ status: 'nolist', error: 'No sitemap found on this site (robots.txt, /wp-sitemap.xml, /sitemap.xml, /sitemap_index.xml). Choose pages and paste your own list of addresses.' });
      const picked = pickPages(found.urls, home, wanted.limit); pages = picked.pages; source = found.name;
      if (pages.length < 2) return show({ status: 'nolist', source, error: `The sitemap ${found.name} names no page of this site that can be compared${picked.other ? ` (${picked.other} ${picked.other === 1 ? 'address is' : 'addresses are'} of another site or a file)` : ''}. Choose pages and paste your own list of addresses.` });
      if (picked.more || found.capped) notes.push(`The sitemap lists more pages; these are the first ${pages.length}`);
      if (picked.other) notes.push(`${picked.other} ${picked.other === 1 ? 'address' : 'addresses'} in the sitemap ${picked.other === 1 ? 'is' : 'are'} of another site or a file and ${picked.other === 1 ? 'was' : 'were'} left out`);
    }
    cap = capOf(pages.length);
    show({ status: 'running', source, total: pages.length, notes });
    const list = addons?.active() || [], copies = copiesOf(host);
    const one = async (url, index) => {
      const first = index === 0;
      const [hostfile, live] = await Promise.all([page('hostfile', url), run.solo ? run.solo.live : page('live', url)]);
      if (!alive()) return;
      // Both servers send the page to the same other host: nothing of this site to compare, said in a note. Only one
      // of them, or each to another host: that is a finding of this page (the new server alone is what a hijack looks like).
      const { both, findings: extra } = leftFindings(hostfile.left, live.left);
      if (both) { run.skipped.push({ path: new URL(url).pathname, host: both.host, own: both.own }); if (first) run.homeSkipped = true; return; }
      const report = buildReport({ url, hostfile, live });
      // Live cannot be reached for the home page: the rest of the run leaves Live alone and judges the new server on its own.
      if (first) { const reason = hostfile.ok ? await reasonFor(url, live) : null; if (reason) { const { body: _body, ...rest } = live; run.solo = { reason, live: { ...rest, body: '' } }; } }
      const reason = run.solo?.reason || null;
      if (reason) report.findings = soloFindings(report.findings, reason);
      let checksState = { status: 'error', report: null, error: 'The page could not be fetched, so the checks did not run.' };
      try {
        if (hostfile.ok && (reason || live.ok)) {
          const own = cardIds(reason ? soloChecksReport({ pageURL: url, hostfile, standard: [], copies }) : checksReport({ pageURL: url, hostfile, live, standard: [], oldIP: live.ip, copies }));
          let all = own;
          if (first) { all = await (reason ? runSoloChecks(url, hostfile, ask) : runChecks(url, hostfile, live, ask)); const mine = new Set(own.groups.flatMap(g => g.items.map(i => i.title))); run.onceChecks = all.groups.flatMap(g => g.items.map(i => i.title)).filter(t => !mine.has(t)); }
          checksState = { status: 'done', report: all, error: '' };
        }
      } catch (error) { if (error instanceof BudgetError) throw error; checksState = { status: 'error', report: null, error: String(error?.message || error).slice(0, 300) }; }
      if (!alive()) return;
      const sides = {}; if (hostfile.ok) sides.hostfile = hostfile; if (!reason && live.ok) sides.live = live;
      const scanned = await Promise.all(list.filter(a => first || a.scope !== 'site').map(async a => ({ id: a.id, name: a.name, by: a.by, scope: a.scope, label: a.tab.label, sub: a.tab.sub,
        ...(Object.keys(sides).length ? await runAddon(a.id, url, sides, { hostfile: 'hostfile', live: 'live' }, cap, true, alive) : { status: 'error', report: null, error: 'The page could not be fetched, so the scan did not run.' }) })));
      if (!alive()) return;
      const { body: _b1, ...h } = report.hostfile || {}, { body: _b2, ...l } = report.live || {};
      run.models[index] = pageModel({ url, title: pageTitle(hostfile.body || live.body, hostfile.body ? hostfile.finalUrl || url : live.finalUrl || url), report: { ...report, hostfile: h, live: l }, liveReason: reason, checks: checksState, addonTabs: scanned, extra });
    };
    const step = async index => { await one(pages[index], index); if (alive()) show({ ...fold(), done: run.view.done + 1, solo: run.solo?.reason.text || '', homeSkipped: run.homeSkipped }); };
    await step(0);
    let next = 1;
    // A worker that hits the request limit stops the other one too.
    const worker = async () => { try { while (alive() && next < pages.length) await step(next++); } catch (error) { if (error instanceof StoppedError) return; run.failed = true; throw error; } };
    await Promise.all(Array.from({ length: SITE_PAGES_AT_ONCE }, worker));
  } catch (error) {
    // A request that found the run cancelled when its turn came is no error of the run.
    if (!(error instanceof StoppedError)) run.failed = true;
    if (run.failed && tab.whole === run) run.view = { ...run.view, status: 'error', error: error instanceof BudgetError ? `Dioptra stopped after ${run.view.done} of ${run.view.total} pages: this run reached its limit of ${cap.limit} requests to the site in 10 minutes. Compare again in a few minutes.` : String(error?.message || error).slice(0, 300) };
  } finally {
    // Every way out ends in a final state: done, cancelled (also while the page list was still being fetched), or an error.
    run.running = false;
    if (tab.whole === run) {
      const groups = new Map(); for (const s of run.skipped) groups.set(s.host, [...(groups.get(s.host) || []), s]);
      const notes = [...run.view.notes, ...[...groups].map(([to, list]) => `${list.length} ${list.length === 1 ? 'page redirects' : 'pages redirect'} on both servers to ${to}${list[0].own ? ', another host of this site,' : ', another site,'} and ${list.length === 1 ? 'was' : 'were'} skipped: ${list.slice(0, 5).map(s => s.path).join(', ')}${list.length > 5 ? ', …' : ''}`)];
      const status = ['error', 'nolist'].includes(run.view.status) ? run.view.status : run.cancelled ? 'cancelled' : 'done';
      run.view = { ...run.view, ...(status === 'nolist' ? {} : fold()), status, notes, stopping: false, homeSkipped: run.homeSkipped, tookMs: Date.now() - started };
      emit();
    }
  }
}
// A page from the list: the tab goes there and Differences compares it the normal way. The site result stays.
function openSitePage(url) {
  const { tab } = ruledTab('compare'), run = tab.whole;
  const target = run && pageOf(url, run.view.home);
  if (!target) throw new Error('That page is not part of this site.');
  delete tab.ruleHistoryIndex; tab.keepView = true; tab.url = target; tab.error = '';
  tab.view.webContents.loadURL(target).catch(error => { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) failure(tab, error.message); });
  persist(); layout(); emit();
  runDifferences().catch(() => {});
}
function measureSpeed(url) {
  if (!meter || speedRun?.url === url) return;
  const mine = speedRun = { url }, live = !liveUnreachable(url);
  speed = { status: 'running', url, report: null, error: '' }; emit();
  ensureLive().then(() => (speedRun === mine ? meter.measure(url, { live }) : null)).then(report => { if (speedRun === mine) speed = { status: 'done', url, report, error: '' }; },
    error => { if (speedRun === mine) speed = { status: 'error', url, report: null, error: String(error.message === 'cancelled' ? 'The measurement was stopped.' : error.message || error).slice(0, 300) }; })
    .finally(() => { if (speedRun === mine) { speedRun = null; emit(); } });
}
// Noindex of the page as it loaded in a Hostfile tab with a rule: red, or orange when Live says noindex too (the Live
// pane of Compare, or the checks of this page). Unknown Live counts as red: the new server is the one that says it.
const tabSays = t => Boolean(t && tabNoindex(t.robots, header(t.siteHeaders, 'x-robots-tag')));
function noindexOf(tab) {
  if (tab.mode !== 'hostfile' || tab.startPage || !route(tab).configured || !tabSays(tab)) return '';
  const live = comparison && comparison.host === tab.id ? tabs.get(comparison.live) : null;
  if (live && sameDocument(live.url, tab.url) && !live.loading) return tabSays(live) ? 'both' : 'worse';
  return checks.report && sameDocument(checks.url, tab.url) && checks.report.noindex === 'both' ? 'both' : 'worse';
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
  if (!tab || tab.mode !== 'hostfile' || !/^https?:/.test(tab.url)) throw new Error('Open a website to compare it.');
  // Without a rule both panes would show the same server, so the right pane starts empty and asks for another address.
  const ruled=activeHosts.some(r=>r.enabled && r.domain===new URL(tab.url).hostname);
  if (tabs.size>=50) throw new Error('Close a tab before comparing.');
  if (comparison && tabs.has(comparison.live)) closeTab(comparison.live);
  await ensureLive();
  if(tabs.get(tab.id)!==tab || current()!==tab) return;
  closeFind(); viewMode='single';
  tab.toolsOpen=false;
  const live=newTab(ruled ? tab.url : 'about:blank',false,'live');
  // A comparison opened during a Claude conversation stays in its anchor group.
  live.claudeGroup=tab.claudeGroup;
  // Both panes at the size of the tab.
  live.zoom=tab.zoom; applyZoom(live);
  comparison={host:tab.id,live:live.id}; activeId=tab.id; panel=null; layout();emit();
  if (!ruled) win.webContents.focus();
  } finally { comparing=false; }
}
// What the page gives away about its platform; read in an isolated world so the page cannot see or change the probe.
const SITE_PROBE = `({ generators: [...document.querySelectorAll('meta[name="generator" i]')].slice(0, 20).map(m => String(m.content).slice(0, 200)), robots: [...document.querySelectorAll('meta[name="robots" i],meta[name="googlebot" i]')].slice(0, 5).map(m => String(m.content).slice(0, 200)), urls: [...document.querySelectorAll('script[src],link[href],img[src]')].slice(0, 600).map(n => String(n.src || n.href).slice(0, 400)) })`;
async function inspectSite(tab) {
  const wc = tab.view.webContents, url = wc.getURL();
  if (tab.mode === 'auth' || !/^https?:\/\//i.test(url)) return;
  try {
    const page = await wc.executeJavaScriptInIsolatedWorld(1005, [{ code: SITE_PROBE }]);
    const cookies = (await wc.session.cookies.get({ url })).map(c => c.name);
    if (wc.isDestroyed() || wc.getURL() !== url) return;
    tab.site = detectSite({ headers: tab.siteHeaders, cookies, ...page }); tab.robots = Array.isArray(page.robots) ? page.robots : []; emit();
  } catch (error) {
    // Expected when the page navigates away or closes mid-probe; the next load probes again.
    if (process.env.DIOPTRA_DEBUG) console.error('site probe failed:', error.message);
  }
}
function observeConnections(ses) {
  observeRequests(ses, 'onErrorOccurred', details => fileTraffic(details, true));
  ses.webRequest.onBeforeRequest((details, callback) => {
    const tab = [...tabs.values()].find(t => t.view.webContents?.id === details.webContentsId);
    if (tab && /^https?:|^wss?:/.test(details.url)) tab.requestHosts.add(new URL(details.url).hostname);
    callback({ cancel: false });
  });
  // Does not replace Claude's onBeforeSendHeaders handler; onCompleted and onErrorOccurred go through web-requests.cjs.
  ses.webRequest.onResponseStarted(details => {
    // Status of every file here, not in onCompleted: Blink cancels a stylesheet or script with a 4xx or 5xx status as soon as it
    // sees the headers, and then onCompleted never comes (net::ERR_ABORTED instead), at random (measured 5 Nov 2026).
    fileTraffic(details, false);
    if (details.resourceType !== 'mainFrame' || details.statusCode >= 300 && details.statusCode < 400 && details.statusCode !== 304) return;
    const tab=[...tabs.values()].find(t=>t.view.webContents?.id===details.webContentsId);
    if (!tab) return;
    let ip=details.ip || '', source='response';
    if (ses===liveSession || ses===webSession) {
      const u=new URL(details.url);
      ip=(ses === liveSession ? liveProxy : routingProxy).addresses(u.hostname, Number(u.port || (u.protocol==='https:'?443:80))).join(', ');
      source='active server connections';
    }
    tab.connection={url:details.url,ip:details.fromCache ? '' : ip,fromCache:Boolean(details.fromCache),source,status:details.statusCode,ms:tab.navStart ? Date.now()-tab.navStart : 0}; tab.siteHeaders=details.responseHeaders || {}; emit();
    const connection=tab.connection;
    if (connection.ip && !connection.ip.includes(',')) reverseName(connection.ip).then(name => { if (name && tab.connection === connection) { connection.hostname = name; emit(); } });
  });
}
// Files that did not load. Each pane keeps tab.files (resource-check.cjs), new for every main frame document. Opening
// Differences closes the Live pane, so its record stays with the Hostfile tab as tab.peer, valid while both show one URL.
let filesTimer = null, probe = null;
const PROBE_SETTLE_MS = 2500, PROBE_TIMEOUT_MS = 30000;
const bareIP = ip => String(ip || '').replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').toLowerCase();
// A page can fail dozens of requests in a burst; the window gets one state update per quarter second.
function filesChanged() { if (!filesTimer) filesTimer = setTimeout(() => { filesTimer = null; emit(); }, 250); }
function paneFor(id) {
  if (id === undefined) return null;
  if (probe && !probe.view.webContents.isDestroyed() && probe.view.webContents.id === id) return probe;
  const tab = [...tabs.values()].find(t => t.view.webContents?.id === id);
  return tab && tab.mode !== 'auth' ? tab : null;
}
function watchFiles(wc, pane) {
  wc.on('console-message', details => {
    const outcome = consoleOutcome(details);
    if (!outcome) return;
    if (outcome.file) recordFailure(pane.files, outcome.file); else recordError(pane.files, outcome.error);
    filesChanged();
  });
}
function fileTraffic(details, failed) {
  const pane = paneFor(details.webContentsId);
  if (!pane) return;
  const record = pane.files;
  if (!failed && details.resourceType === 'mainFrame') { record.pageServer = header(details.responseHeaders, 'server'); return; }
  const outcome = failed ? errorOutcome(details) : responseOutcome(details);
  if (!outcome) return;
  if (outcome.failed) recordFailure(record, outcome); else recordLoaded(record, outcome);
  if (!failed && pane.mode === 'hostfile') fromOldServer(pane, record, outcome);
  filesChanged();
}
// The old server is what normal DNS gives for the page host itself. A CDN host of the same site is not the old server
// and does not break with it, so only files served from one of these addresses count. Asked once a minute per host.
const publicIPs = new Map();
function publicAddresses(host) {
  const known = publicIPs.get(host);
  if (known && Date.now() - known.at < 60000) return known.addresses;
  if (publicIPs.size > 100) publicIPs.clear();
  const addresses = dns.lookup(host, { all: true }).then(list => new Set(list.map(a => bareIP(a.address))), () => new Set());
  publicIPs.set(host, { at: Date.now(), addresses });
  return addresses;
}
// A host of the same site without an enabled rule goes through normal DNS, so a Hostfile tab can still load it from the old server.
function fromOldServer(tab, record, outcome) {
  let url; try { url = new URL(outcome.url); } catch { return; }
  const host = url.hostname.toLowerCase(), pageHost = route(tab).host.toLowerCase(), rule = activeHosts.find(r => r.enabled && r.domain === pageHost);
  if (!rule || host === pageHost || !isFirstParty(host, pageHost) || protectedHost(host) || activeHosts.some(r => r.enabled && r.domain === host)) return;
  const add = async ip => {
    const address = bareIP(ip);
    if (!address || address === bareIP(rule.ip) || !(await publicAddresses(pageHost)).has(address) || record.old.has(outcome.key)) return;
    const item = { key: outcome.key, url: outcome.url, type: outcome.type, host, ip: address, ptr: '' };
    recordOld(record, item); filesChanged();
    reverseName(address).then(name => { if (name) { item.ptr = name; filesChanged(); } });
  };
  // The routing proxy knows the server it connected to; a closed connection falls back to the same OS lookup it used.
  const seen = routingProxy.addresses(host, Number(url.port || (/^(https|wss):$/.test(url.protocol) ? 443 : 80)));
  if (seen.length) add(seen[0]); else dns.lookup(host).then(found => add(found.address), () => {});
}
function keepPeer(pair) {
  const host = tabs.get(pair.host), live = tabs.get(pair.live);
  if (host && live && sameDocument(host.url, live.url)) host.peer = { url: live.url, record: live.files, measuring: false };
}
// The record of the other side of the same page: the other pane of a comparison, or the Live record the Hostfile tab kept.
function otherRecord(tab) {
  if (comparison && [comparison.host, comparison.live].includes(tab.id)) {
    const other = tabs.get(tab.id === comparison.host ? comparison.live : comparison.host);
    return other && sameDocument(other.url, tab.url) ? other.files : null;
  }
  return tab.mode === 'hostfile' && tab.peer && sameDocument(tab.peer.url, tab.url) ? tab.peer.record : null;
}
function differencesFiles() {
  const tab = current();
  if (!tab || tab.mode !== 'hostfile' || !/^https?:/.test(tab.url)) return null;
  const rule = activeHosts.find(r => r.enabled && r.domain === route(tab).host), peer = tab.peer && sameDocument(tab.peer.url, tab.url) ? tab.peer : null;
  return filesView({ hostfile: tab.files, live: peer?.record || null, pageURL: tab.url, ruleIP: rule?.ip || '', measuring: Boolean(tab.loading || peer?.measuring) });
}
function closeProbe() {
  const mine = probe;
  if (!mine) return;
  probe = null; clearTimeout(mine.timer); clearTimeout(mine.settle); mine.peer.measuring = false;
  if (win && !win.isDestroyed()) win.contentView.removeChildView(mine.view);
  if (!mine.view.webContents.isDestroyed()) mine.view.webContents.close();
  filesChanged();
}
// Reload both from Differences, where the Live pane is closed: a hidden Live view loads the page once, the same way the
// Live pane would (Live session, normal DNS, sandboxed, muted, no popups or downloads), and is closed when the page settles.
async function measureLive(tab) {
  await ensureLive();
  closeProbe();
  if (!tabs.has(tab.id) || !win || win.isDestroyed()) return;
  const view = new WebContentsView({ webPreferences: { session: liveSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  const wc = view.webContents, peer = { url: tab.url, record: createRecord(), measuring: true };
  const mine = probe = { view, mode: 'live', files: peer.record, peer };
  tab.peer = peer;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('certificate-error', (event, url, _error, certificate, callback) => {
    event.preventDefault();
    let host = ''; try { host = new URL(url).hostname.toLowerCase(); } catch {}
    // Only a certificate the user chose Continue anyway for; answered a tick later (Electron 45 wss:// crash, see bindTab).
    const trusted = Boolean(host) && !protectedHost(host) && liveExceptions.get(host) === fingerprint(certificate);
    setImmediate(() => callback(trusted));
  });
  watchFiles(wc, mine);
  wc.on('did-stop-loading', () => { clearTimeout(mine.settle); mine.settle = setTimeout(() => { if (probe === mine) closeProbe(); }, PROBE_SETTLE_MS); });
  mine.timer = setTimeout(() => { if (probe === mine) closeProbe(); }, PROBE_TIMEOUT_MS);
  view.setVisible(false); win.contentView.addChildView(view); view.setBounds(tab.view.getBounds());
  wc.loadURL(tab.url).catch(() => {});
  filesChanged();
}
async function reloadBoth() {
  const pair = visibleComparison();
  if (pair) { for (const id of [pair.host, pair.live]) reloadTab(tabs.get(id), true); return; }
  const { tab } = ruledTab('measure');
  tab.keepView = viewMode === 'differences';
  reloadTab(tab, true);
  await measureLive(tab);
}
// "Add rule" next to files from the old server: the host must be one this page really loaded from the old server.
async function addFilesRule(host) {
  const { tab, rule } = ruledTab('add a rule for');
  if (![...tab.files.old.values()].some(o => o.host === host)) throw new Error('This page did not load files from that host through the old server.');
  const index = config.rules.findIndex(r => r.domain === host || r.www && `www.${r.domain}` === host);
  const rules = index >= 0 ? config.rules.map((r, i) => (i === index ? { ...r, ip: rule.ip, enabled: true } : r)) : [...config.rules, { domain: host, ip: rule.ip, enabled: true }];
  await applyRules(validateRules(rules));
  if (viewMode === 'differences') runDifferences().catch(() => {});
  return { host, ip: rule.ip };
}
function setupWebsiteSession(ses) {
  ses.setPermissionCheckHandler(()=>false);
  ses.setPermissionRequestHandler(async (wc,permission,callback,details)=>{
    if(![...tabs.values()].some(t=>t.view.webContents===wc) || !['media','geolocation','notifications','clipboard-read','fullscreen','pointerLock'].includes(permission)) return callback(false);
    const answer=await dialog.showMessageBox(win,{type:'question',message:'Website requests permission',detail:`${details.requestingUrl || wc.getURL()}\n\n${permission}`,buttons:['Deny','Allow once'],defaultId:0,cancelId:0});callback(answer.response===1);
  });
  ses.on('will-download', (_event,item,source)=>{
    if ((probe && source === probe.view.webContents) || meter?.owns(source)) { item.cancel(); return; } // the hidden Live measurement and the speed windows never save files
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
  if (privateBeta || !app.isPackaged) return;
  if (!updater) {
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
    const set = (status, message, details = {}) => { updateState = { ...updateState, status, message, ...details }; if (manualUpdate && ['available', 'downloaded'].includes(status)) { panel = 'updates'; layout(); } emit(); };
    updater.on('checking-for-update', () => set('checking', 'Checking for updates…'));
    updater.on('update-available', info => set('available', `Version ${info.version} is available.`, { version: info.version, date: info.releaseDate || '', checkedAt: Date.now(), progress: 0, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : (info.releaseNotes || []).map(n => n.note).join('\n') }));
    updater.on('update-not-available', () => set('current', 'You are running the latest available version.', { checkedAt: Date.now() }));
    updater.on('download-progress', info => set('downloading', `Downloading: ${Math.round(info.percent)}%`, { progress: info.percent }));
    updater.on('update-downloaded', () => set('downloaded', 'Update ready. Restart to install.'));
    updater.on('error', error => set('error', `Update failed: ${error.message}`));
  }
  updater.setFeedURL({ provider: 'generic', url: updateFeed() });
}
async function checkForUpdates(manual = false) {
  if (privateBeta) { updateState = localBetaUpdate(); emit(); return; }
  if (checkingUpdate || ['available', 'downloading', 'downloaded'].includes(updateState.status)) return;
  setupUpdater();
  if (!updater) return;
  manualUpdate = manual; checkingUpdate = true;
  try { await updater.checkForUpdates(); } finally { checkingUpdate = false; }
}
async function clearBrowserCache() {
  for (const ses of [webSession, liveSession].filter(Boolean)) { await ses.clearCache(); await ses.clearHostResolverCache(); await ses.closeAllConnections(); }
  const pair=visibleComparison();
  for(const id of pair ? [pair.host,pair.live] : [activeId]) { const t=tabs.get(id); if(t && !t.startPage) {t.error='';t.view.webContents.reloadIgnoringCache();} }
  layout(); emit();
}
ipcMain.handle('browser', async (event, action, data) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('Access denied.');
  try {
    const tab = current();
    if (viewMode === 'differences' && ['navigate', 'new-tab', 'back', 'forward', 'reload', 'hard-reload', 'compare'].includes(action)) { viewMode = 'single'; layout(); }
    switch (action) {
      case 'state': return { ok: true, state: state() };
      case 'compare': await compare(); break;
      case 'stop-compare': stopCompare(); break;
      case 'compare-with': {
        // Another address for the right pane of Compare; null puts it back on the page of the left pane.
        const pair = visibleComparison(), left = pair && tabs.get(pair.host), right = pair && tabs.get(pair.live);
        if (!left || !right) throw new Error('Open Compare first.');
        const url = data === null ? left.url : navigationURL(data);
        if (!/^https?:/.test(url)) throw new Error('Enter a web address.');
        right.url = url; right.startPage = false; right.error = ''; layout();
        right.view.webContents.loadURL(url).catch(error => { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) failure(right, error.message); });
        break;
      }
      case 'view': await setView(data); break;
      case 'differences-run': return { ok: true, report: await runDifferences(true) };
      case 'live-retry': await retryLive(); break;
      case 'differences-ask-claude': {
        if (!differences.report) throw new Error('Run Differences first.');
        clipboard.writeText(summaryText(differences.report, [...filesLines(differencesFiles()), ...checksLines(forPage(checks).report), ...addonTabs().flatMap(a => addonLines(a.name, a.report)), ...speedLines(forPage(speed).report)]));
        // Same route as the toolbar button; the summary is only copied, never injected into the extension.
        if (claudeState.status === 'ready') { await openClaudePanel(); claude.clicked(current()); panel = 'claude'; layout(); emit(); }
        return { ok: true, notice: 'Summary copied. Paste it into Claude.' };
      }
      case 'clear-site-data': { const host = await clearSiteData(); return { ok: true, notice: `Cleared site data for ${host}.` }; }
      case 'files-reload': await reloadBoth(); break;
      case 'speed-measure': { const { tab: page } = ruledTab('measure'); if (speedRun?.url !== page.url) { speedRun = null; meter?.cancel(); measureSpeed(page.url); } break; }
      case 'checks-copy': {
        const found = forPage(checks).report?.groups.flatMap(g => g.items).find(c => c.id === data?.card);
        if (!found) throw new Error('Run the checks first.');
        const one = Number.isInteger(data?.command), text = one ? found.commands?.[data.command]?.command : found.action?.text;
        if (!text) throw new Error('Nothing to copy.');
        clipboard.writeText(text);
        return { ok: true, notice: one ? 'Command copied. Run it on the new server.' : found.group === 'old' ? 'Commands copied. Run them on the new server.' : 'Copied.' };
      }
      case 'addon-preview': if (!addons) throw new Error('Add-ons are not available.'); await addons.preview(data); break;
      case 'addon-cancel': addons?.cancel(); break;
      case 'addon-install': {
        if (!addons) throw new Error('Add-ons are not available.');
        // A failed install leaves no pending add-on: the window must hear that too.
        const id = await addons.install().catch(error => { emit(); throw error; }), entry = addons.snapshot().installed.find(a => a.id === id);
        rescanTabs(); emit();
        return { ok: true, notice: entry.restart ? `${entry.name} ${entry.version} installed. Restart Dioptra to use the new version.` : `${entry.name} installed.` };
      }
      case 'addon-remove': await addons.remove(String(data)); rescanTabs(); break;
      case 'addon-enable': await addons.setEnabled(String(data?.id), data?.on === true); rescanTabs(); break;
      case 'addon-check': { const update = await addons.check(String(data)); if (update.status === 'updated') rescanTabs(); emit(); return { ok: true, notice: update.message }; }
      case 'addon-copy': {
        const found = addonTabs().find(a => a.id === data?.addon)?.report?.groups.flatMap(g => g.items).find(c => c.id === data?.card);
        if (!found) throw new Error('Run the scan first.');
        const one = Number.isInteger(data?.command), text = one ? found.commands[data.command]?.command : found.action?.text;
        if (!text) throw new Error('Nothing to copy.');
        clipboard.writeText(text);
        return { ok: true, notice: one ? 'Command copied. Run it on the server.' : 'Copied.' };
      }
      case 'files-copy': {
        const view = differencesFiles();
        if (!view) throw new Error('Open Differences on a Hostfile tab first.');
        clipboard.writeText(filesText(view, current().url));
        return { ok: true, notice: 'List copied.' };
      }
      case 'files-add-rule': {
        const added = await addFilesRule(String(data || '').toLowerCase());
        emit(); return { ok: true, notice: `Rule added: ${added.host} → ${added.ip}. The page reloads through the new server.` };
      }
      case 'open-release': if (privateBeta) { updateState = localBetaUpdate(); panel = 'updates'; layout(); } else await shell.openExternal(RELEASE_PAGE); break;
      case 'installation-help': await shell.openExternal('https://support.apple.com/en-us/102445'); break;
      case 'onboarding-open':
        if (config.onboardingCompleted) { config.onboardingStep = 0; config.onboardingURL = ''; }
        onboardingOpen = true; persist(); layout(); win.webContents.focus(); break;
      case 'onboarding-cancel': onboardingOpen = false; persist(); layout(); win.webContents.focus(); break;
      case 'onboarding-step':
        if (!onboardingOpen || ![0, 1].includes(data)) throw new Error('Invalid setup step.');
        config.onboardingStep = data; persist(); break;
      case 'onboarding-domain': {
        if (!onboardingOpen || config.onboardingStep !== 1) throw new Error('Open the first-domain setup step.');
        if (data === null) config.onboardingURL = '';
        else {
          const rules = validateRules([...config.rules, { ...data, enabled: true }]);
          await applyRules(rules);
          config.onboardingURL = `https://${rules.at(-1).domain}/`;
        }
        config.onboardingStep = 2; persist(); break;
      }
      case 'onboarding-finish':
        if (!onboardingOpen || config.onboardingStep !== 2) throw new Error('Finish the setup steps first.');
        config.onboardingCompleted = true; onboardingOpen = false; persist();
        if (config.onboardingURL) newTab(config.onboardingURL);
        layout(); win.webContents.focus(); break;
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
        if (!data) throw new Error('Choose Skip SSL errors on a domain rule. Live and account services always verify certificates.');
        await applyRules(validateRules(config.rules.map(rule => ({ ...rule, skipSSL: false })))); break;
      }

      case 'site-run': startSite(data || {}); break;
      case 'site-cancel': { const run = current()?.whole; if (run?.running) { run.cancelled = true; run.view = { ...run.view, stopping: true }; } break; }
      case 'site-open': openSitePage(String(data || '')); break;
      case 'navigate': {
        const url = navigationURL(data); delete tab.ruleHistoryIndex; tab.url = url; tab.startPage = url === 'about:blank'; tab.error = ''; layout();
        if (!tab.reloadingRules) tab.view.webContents.loadURL(url).catch(error => { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) failure(tab, error.message); });
        persist(); break;
      }
      case 'new-tab': newTab(data ?? 'about:blank'); if (!data) focusAddress(); break;
      case 'activate': activate(Number(data)); break;
      case 'close-tab': closeTab(Number(data)); break;
      case 'back': historyStep(tab, -1); break;
      case 'forward': historyStep(tab, 1); break;
      case 'reload': reloadTab(tab); break;
      case 'trust-certificate': {
        const target = tabs.get(Number(data)), blocked = target?.certBlocked;
        if (!blocked || target.mode !== 'live' || protectedHost(blocked.host)) throw new Error('There is no refused certificate to continue with.');
        liveExceptions.set(blocked.host, blocked.print); target.certBlocked = null; target.error = ''; liveRetry = null; differences = { status: 'idle', report: null, error: '', liveReason: null, liveRetry: false }; layout();
        target.view.webContents.loadURL(target.url).catch(error => { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) failure(target, error.message); });
        break;
      }
      case 'hard-reload': reloadTab(tab, true); break;
      case 'stop': tab.view.webContents.stop(); break;
      case 'panel': if (data === 'claude' && claudeState.status === 'ready') { await openClaudePanel(); claude.clicked(current()); } panel = ['domains', 'settings', 'updates', 'claude', 'library'].includes(data) ? data : null; layout(); break;
      case 'save-rules': {
        const rules = validateRules(data); await applyRules(rules); break;
      }
      case 'import-servers': {
        if (typeof data !== 'string' || data.length > MAX_SERVER_CSV) throw new Error('This file is too large for a server list.');
        const { servers, skipped } = parseServers(data);
        if (!servers.length) throw new Error('No servers found. Each line needs a server name and an IP address.');
        config = { ...config, servers }; persist(); emit();
        return { ok: true, imported: servers.length, skipped };
      }
      case 'clear-servers': config = { ...config, servers: [] }; persist(); break;
      case 'compare-ratio': {
        if (!Number.isFinite(data?.ratio) || data.ratio < .25 || data.ratio > .75) throw new Error('Invalid pane size.');
        config.compareRatio = data.ratio; layout(); if (data.commit !== false) persist(); break;
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
      case 'install-claude':
        if (claudeState.status === 'ready') break;
        await installClaudeVersion(true); break;
      case 'claude-check-update': await claudeUpdates.check(); break;
      case 'claude-install-update': await installClaudeVersion(false); break;
      case 'claude-update-settings': {
        if (typeof data?.autoCheck !== 'boolean') throw new Error('Invalid Claude update preference.');
        const changes = {...config, claudeAutoCheck:data.autoCheck};
        saveSettings(settingsFile, changes); config = changes; lastSavedSettings = JSON.stringify(config);
        break;
      }
      case 'remove-claude': {
        if (claudeState.status === 'loading') throw new Error('Wait for Claude to finish loading.');
        await claudeUpdates.run(async () => {
          closeClaudeView(); claude.remove();
          await fs.rm(path.join(app.getPath('userData'),directoryName),{recursive:true, force:true});
          await claudeUpdates.clear(); claudeReport = null;
          claudeState = {status:'absent', message:'Claude removed.'}; layout();
        });
        break;
      }
      case 'claude-check': {
        return await claudeUpdates.run(async () => {
          if (claudeState.status !== 'ready') throw new Error('Install Claude first.');
          if (!claudeView) { await openClaudePanel(); panel = 'settings'; layout(); emit(); }
          claudeReport = { dioptraVersion: app.getVersion(), ...await claude.diagnostics(claudeView.webContents) };
          return { ok:true, diagnostics:claudeReport };
        });
      }
      case 'claude-copy-diagnostics':
        if (!claudeReport) throw new Error('Check Claude first.');
        clipboard.writeText(JSON.stringify(claudeReport, null, 2));
        break;
      case 'claude-refresh': {
        await claudeUpdates.run(async () => {
          if (claudeState.status !== 'ready') throw new Error('Install Claude first.');
          await openClaudePanel();
          await claudeView.webContents.executeJavaScript("chrome.storage.local.remove('features')");
          claude.resetDiagnostics(); claudeReport = null;
          await claudeView.webContents.loadURL(claudeView.webContents.getURL());
        });
        break;
      }
      case 'claude-options': await claudeUpdates.run(() => openClaudePanel('options.html')); break;
      case 'clear-cache': await clearBrowserCache(); break;
      case 'card': await openCard(String(data?.kind), Number(data?.id) || 0, data); break;
      case 'card-close': closeCard(); break;
      case 'auth': finishAuth(data); break;
      case 'update-settings': {
        if (privateBeta) throw new Error('This private beta uses local downloads. Update preferences are kept for future public releases.');
        if (checkingUpdate || ['downloading', 'downloaded'].includes(updateState.status)) throw new Error('Finish the current update before changing its source.');
        let feed = String(data.feed || '').trim();
        if (feed === DEFAULT_UPDATE_FEED) feed = '';
        if (feed) { const url = new URL(feed); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS update source without credentials.'); }
        const changes = { ...config, updateFeed: feed, autoUpdates: Boolean(data.automatic), autoUpdatesChosen: true };
        saveSettings(settingsFile, changes); config = changes;
        updateState = freshUpdate(feed ? 'Custom update source saved. Not checked yet.' : 'Default update source in use. Not checked yet.'); setupUpdater(); break;
      }
      case 'check-update':
        if (!privateBeta && !app.isPackaged) throw new Error('Automatic updates are available in the installed app.');
        await checkForUpdates(true); break;
      case 'download-update': if (privateBeta) throw new Error('This private beta cannot download public updates. Use your beta downloads.'); if (!canInstall) throw new Error('This build cannot install updates itself. Use Open download page.'); manualUpdate = true; if (updater && updateState.status === 'available') { updateState = { ...updateState, status: 'downloading', progress: 0, message: 'Starting download…' }; emit(); await updater.downloadUpdate(); } break;
      case 'install-update': if (privateBeta) throw new Error('This private beta cannot install public updates. Use your beta downloads.'); if (updater && updateState.status === 'downloaded') {
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
    // Add-ons load before the first tab, so the first page is scanned too. A test build may name its own signing key
    // and a feed on this computer; a packaged Dioptra only knows SolutionMAX's key and https.
    try {
      const testKey = app.isPackaged ? '' : (process.argv.find(v => v.startsWith('--addon-key=')) || '').slice(12);
      addons = createAddons({ dir: path.join(app.getPath('userData'), 'addons'), appVersion: app.getVersion(), allowLocal: !app.isPackaged, log: message => console.error(message), ...(testKey ? { publicKey: testKey } : {}) });
      await addons.loadAll();
    } catch (error) { console.error('Add-ons could not be loaded:', error?.message || error); }
    certificatePolicy(webSession);
    observeConnections(webSession);
    routingProxy = await createLiveProxy({ resolve: host => activeHosts.find(r => r.enabled && r.domain === host)?.ip || host });
    await webSession.setProxy({ mode: 'fixed_servers', proxyRules: routingProxy.url, proxyBypassRules: '<-loopback>' });
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
    // The hidden window that holds the offscreen speed views (speed-measure.cjs); made before the main window, never shown.
    measureHost = new BaseWindow({ show: false, width: 1280, height: 720, focusable: false, skipTaskbar: true, title: 'Dioptra measurement' });
    win = new BrowserWindow({ width: 1380, height: 900, minWidth: 960, minHeight: 640, title: 'Dioptra', backgroundColor: '#f6f8fb', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    win.webContents.on('before-input-event',(event,input)=>handleShortcut(event,input));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('resize', () => { layout(); emit(); });
    win.on('blur', () => { if (draggingTools) { draggingTools = false; layout(); emit(); } });
    win.on('close', () => { persist(); quitting = true; closeProbe(); meter?.cancel(); if (authRequest) finishAuth(null); for (const t of tabs.values()) { disposeDevTools(t); t.view.webContents.close(); } });
    win.on('closed', () => { liveProxy?.close(); routingProxy?.close(); win = null; app.quit(); });
    setupWebsiteSession(webSession);
    meter = createSpeedMeter({ WebContentsView, host: () => measureHost, sessions: () => ({ hostfile: webSession, live: liveSession }), changed: filesChanged,
      trust: (side, host, certificate) => (side === 'hostfile' ? skipCertificate(host) : !protectedHost(host) && liveExceptions.get(host) === fingerprint(certificate)) });
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
      { label: 'View', submenu: [{ label: 'Address bar', accelerator: 'CmdOrCtrl+L', click: focusAddress }, { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => reloadTab(current()) }, { label: 'Reload without cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => reloadTab(current(), true) }, { label: 'Developer Tools', accelerator: 'F12', click: () => toggleDevTools() }, { role: 'togglefullscreen' }, { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: () => zoomAction('in') }, { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => zoomAction('out') }, { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => zoomAction('reset') }] }
    ]));
    const extensionDirectory = path.join(app.getPath('userData'),directoryName);
    await recoverClaudeUpdate(app.getPath('userData'));
    try { await fs.access(path.join(extensionDirectory,'manifest.json')); claudeState = {status:'loading',message:'Starting Claude…'}; } catch {}
    claude = createClaude({ session: webSession, authSession: claudeAuthSession, window: win, tabs, current, newTab, activate, closeTab, openPanel: openClaudePanel, getPanel: () => claudeView?.webContents });
    claudeUpdates = createClaudeUpdates({
      profile:app.getPath('userData'), getVersion:() => claudeState.status === 'ready' ? claudeState.version : null, changed:emit,
      unload:async () => { claudeState = {...claudeState, status:'loading', message:'Reloading Claude…'}; closeClaudeView(); claude.remove(); claudeReport = null; claude.resetDiagnostics(); },
      load:async directory => {
        const extension = await claude.load(directory);
        claudeState = {status:'ready', version:extension.version, message:'Claude installed.'};
        if (claudeReopen?.page) { await openClaudePanel(claudeReopen.page); panel = claudeReopen.panel; layout(); }
        return extension;
      }
    });
    await win.loadFile(path.join(__dirname, 'index.html'));
    const restore = [...config.tabs];
    for (const url of restore) newTab(url);
    tabsRestored = true;
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
    const checkClaude = () => { if (!quitting && config.claudeAutoCheck && claudeState.status === 'ready' && !claudeUpdates.busy) claudeUpdates.check().catch(() => {}); };
    setTimeout(checkClaude, 15000).unref();
    setInterval(checkClaude, 24 * 60 * 60 * 1000).unref();
    // Add-ons update themselves: shortly after the start and every six hours. New threat lists count at once.
    const checkAddons = async () => { if (quitting || !addons) return; for (const a of addons.snapshot().installed.filter(x => x.enabled && x.status === 'active')) { const update = await addons.check(a.id).catch(error => { console.error(`Add-on ${a.id} update check:`, error?.message || error); return null; }); if (update?.status === 'updated') rescanTabs(); } emit(); };
    setTimeout(() => checkAddons().catch(() => {}), 20000).unref();
    setInterval(() => checkAddons().catch(() => {}), 6 * 60 * 60 * 1000).unref();
    setTimeout(() => { if (!privateBeta && config.autoUpdates) checkForUpdates().catch(() => {}); }, 10000).unref();
    setInterval(() => { if (!privateBeta && config.autoUpdates) checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000).unref();
  }).catch(error => {
    console.error('Dioptra could not start:', error?.stack || error);
    // Quitting while the window is still loading ends up here too. A modal error box would then block the shutdown.
    if (quitting) return app.exit(0);
    dialog.showErrorBox('Browser could not start', error.stack || error.message); app.exit(1);
  });
  app.on('before-quit', () => { if (!quitting && tabs.size) persist(); });
  app.on('window-all-closed', () => app.quit());
}
