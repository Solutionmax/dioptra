const $ = id => document.getElementById(id);
let libraryTab = 'bookmarks', libraryKey = '', librarySearch = '', settingsCategory = 'home', feedDirty = false, claudeActionBusy = false, claudeChecking = false;
let state, editing = null, toastTimer, tabsKey = '', rulesKey = '', www = true, skipSSL = false, suggestions = [], suggestionTotal = 0, activeSuggestion = 0, suggestionChosen = false, serverPage = 0, serverNote = '';
const SERVER_PAGE_SIZE = 8, MAX_SUGGESTIONS = 5, MAX_SERVER_CSV = 1024 * 1024; // the CSV limit is the one in core.cjs
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 7000); }
async function command(action, data) { try { const result = await window.browser.command(action, data); if (!result.ok) toast(result.error); return result; } catch (error) { toast(error.message); return { ok: false }; } }
function el(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
function render(next) {
  state = next;
  if (state.panel === 'updates') settingsCategory = 'updates';
  document.documentElement.style.setProperty('--panel', state.panel === 'claude' ? '480px' : '380px');
  document.documentElement.style.setProperty('--rb', `${state.routeBarHeight ?? 48}px`);
  renderWorkspace();
  const nextTabsKey = JSON.stringify([state.activeId, state.tabs.map(t => [t.id, t.title, t.loading, t.route.label])]);
  if (tabsKey !== nextTabsKey) {
  tabsKey = nextTabsKey;
  $('tabs').replaceChildren();
  for (const tab of state.tabs) {
    const item = el('div', 'tab' + (tab.id === state.activeId ? ' active' : '')); item.setAttribute('role', 'tab'); item.setAttribute('aria-selected', String(tab.id === state.activeId)); item.tabIndex = 0;
    item.append(el('span', 'tab-dot ' + tab.route.label.toLowerCase()), el('span', 'tab-title', (tab.loading ? '◌ ' : '') + (tab.title || 'New tab')));
    const close = el('button', 'tab-close', '×'); close.setAttribute('aria-label', `Close tab ${tab.title}`); close.onclick = event => { event.stopPropagation(); command('close-tab', tab.id); }; item.append(close);
    item.onclick = () => command('activate', tab.id); item.onkeydown = event => { if (event.key === 'Enter') command('activate', tab.id); }; $('tabs').append(item);
  }
  }
  const tab = state.tabs.find(t => t.id === state.activeId);
  if (tab) {
    if (document.activeElement !== $('address')) $('address').value = tab.url === 'about:blank' ? '' : tab.url;
    $('back').disabled = !tab.back; $('forward').disabled = !tab.forward; setIcon($('reload'), tab.loading ? 'stop' : 'reload');
    const inDiff = currentView() === 'differences';
    $('welcome').hidden = inDiff || Boolean(state.comparison) || !tab.startPage || Boolean(tab.error);
    $('page-error').hidden = inDiff || Boolean(state.comparison) || !tab.error; $('page-error-detail').textContent = tab.error || ''; $('page-error-url').textContent = tab.url;
    $('page-error-title').textContent = tab.certBlocked ? 'Live certificate is not trusted' : 'Unable to load page'; $('page-error-hint').hidden = Boolean(tab.certBlocked); $('page-error-help').replaceChildren(...(tab.error ? errorHelp(tab) : []));
    setIcon($('protocol'), tab.url.startsWith('https:') ? 'lock' : 'globe');
    renderZoom(tab);
  }
  $('panel').hidden = !state.panel; document.body.classList.toggle('panel-open', Boolean(state.panel));
  $('domains').classList.toggle('selected', state.panel === 'domains');
  $('settings').classList.toggle('selected', ['settings', 'updates'].includes(state.panel));
  $('domains-section').hidden = state.panel !== 'domains';
  $('library-section').hidden = state.panel !== 'library';
  $('settings-section').hidden = !['settings', 'updates'].includes(state.panel);
  document.body.classList.toggle('claude-open', state.panel === 'claude' && state.claude.status === 'ready');
  $('claude-section').hidden = state.panel !== 'claude';
  $('claude').classList.toggle('selected', state.panel === 'claude');
  $('claude-message').textContent = state.claude.message;
  $('claude-install-info').hidden = state.claude.status === 'ready';
  $('install-claude').disabled = ['loading','installing'].includes(state.claude.status);
  $('panel-title').textContent = { domains: 'Domains', settings: 'Settings', updates: 'Settings', claude: 'Claude', library: 'Library' }[state.panel] || '';
  $('panel-subtitle').textContent = state.panel === 'claude' ? 'Experimental · inside Dioptra' : state.panel === 'domains' ? 'Only active in this browser' : state.panel === 'library' ? 'Saved pages, visits and downloads' : 'Your Dioptra preferences';
  renderSettings();
  const bounds = state.toolsLayout;
  for (const [id, rect] of [['tools-bar', bounds?.bar], ['tools-splitter', bounds?.splitter]]) {
    $(id).hidden = !rect;
    if (rect) Object.assign($(id).style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  $('tools-splitter').setAttribute('aria-orientation', state.devtoolsDock === 'bottom' ? 'horizontal' : 'vertical');
  if (bounds) {
    const size = state.devtoolsDock === 'bottom' ? bounds.tools.height + 32 : bounds.tools.width;
    const total = size + 6 + (state.devtoolsDock === 'bottom' ? bounds.page.height : bounds.page.width);
    $('tools-splitter').setAttribute('aria-valuenow', String(Math.round(size / total * 100)));
    $('tools-splitter').setAttribute('aria-valuetext', `${state.devtoolsDock === 'bottom' ? 'Height' : 'Width'}: ${size} pixels`);
  }
  document.querySelectorAll('[data-dock]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.dock === state.devtoolsDock)));
  $('tools-drag-shield').hidden = !state.draggingTools;
  $('devtools').setAttribute('aria-pressed', String(Boolean(tab?.devtools)));
  $('rule-count').textContent = state.activeRules.filter(r => r.enabled).length;
  $('list-count').textContent = `${state.rules.length} domain${state.rules.length === 1 ? '' : 's'}`;
  const nextRulesKey = JSON.stringify([state.rules, state.servers]);
  if (rulesKey !== nextRulesKey) {
  rulesKey = nextRulesKey;
  $('rules').replaceChildren();
  for (const [index, rule] of state.rules.entries()) {
    const row = el('div', 'rule'); const text = el('div', 'rule-text'); const domain = el('div', 'rule-domain'), ip = el('div', 'rule-ip', rule.ip), server = serverFor(rule.ip), names = rule.www ? `${rule.domain} and www.${rule.domain}` : rule.domain;
    domain.append(el('span', '', rule.domain)); const badges = el('div', 'rule-badges'); badges.append(el('span', 'www-chip', rule.www ? '+ WWW' : 'Exact name'), el('span', `ssl-chip ${rule.skipSSL ? 'skipped' : 'strict'}`, rule.skipSSL ? 'SSL skipped' : 'SSL strict')); domain.append(badges); if (server) ip.append(el('span', 'srv', server.name));
    text.append(domain, ip); row.append(text);
    const toggle = el('button', 'toggle' + (rule.enabled ? ' on' : '')); toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(rule.enabled)); toggle.setAttribute('aria-label', `Enable ${names}`); toggle.onclick = async () => { if ((await command('save-rules', state.rules.map((r, i) => i === index ? { ...r, enabled: !r.enabled } : r))).ok) toast('Rule updated. Affected tabs reloaded.'); };
    const edit = el('button', 'small', '✎'); edit.setAttribute('aria-label', `Edit ${rule.domain}`); edit.onclick = () => { editing = rule.domain; $('domain-input').value = rule.domain; $('ip-input').value = rule.ip; setWww(rule.www === true); setSkipSSL(rule.skipSSL === true); ipNote(); $('save-rule').textContent = 'Save'; $('cancel-edit').hidden = false; $('domain-input').focus(); };
    const remove = el('button', 'small', '⌫'); remove.setAttribute('aria-label', `Remove ${rule.domain}`); remove.onclick = async () => { const result = await command('save-rules', state.rules.filter(r => r.domain !== rule.domain)); if (result.ok) { if (editing === rule.domain) resetForm(); toast('Rule removed. Affected tabs reloaded.'); } };
    row.append(toggle, edit, remove); $('rules').append(row);
  }
  renderServers();
  }
  $('empty-rules').hidden = state.rules.length > 0; $('ssl-migration').hidden = !state.sslMigration; $('ssl-migration').textContent = state.sslMigration || '';
  $('update-message').textContent = state.update.message; $('auto-updates').checked = state.autoUpdates;
  if (!feedDirty) $('feed').value = state.updateFeed;
  $('check-update').disabled = !state.updateFeed || ['checking', 'downloading'].includes(state.update.status);
  $('download-update').hidden = state.update.status !== 'available'; $('install-update').hidden = state.update.status !== 'downloaded';
  renderUpdateDetails();
  $('update-progress').hidden = state.update.status !== 'downloading';
  $('update-progress').value = state.update.progress || 0;
  $('release-notes').hidden = !state.update.notes;
  $('release-notes').textContent = state.update.notes || '';
  const updating = ['available', 'downloading', 'downloaded'].includes(state.update.status), manual = state.update.canInstall === false;
  $('update-notice').hidden = !updating;
  $('update-notice').textContent = state.update.status === 'downloaded' ? 'Restart to update' : state.update.status === 'downloading' ? `Downloading ${Math.round(state.update.progress || 0)}%` : `Update ${state.update.version || ''} available`.replace('  ', ' ');
  $('open-release').hidden = !(manual && updating); if (manual) { $('download-update').hidden = true; $('install-update').hidden = true; }
  $('versions').textContent = `Dioptra ${state.versions.app} · Chromium ${state.versions.chromium} · Electron ${state.versions.electron}`;
  $('auto-updates').parentElement.hidden = state.privateBeta;
  $('advanced').hidden = state.privateBeta;
  $('release-page').textContent = state.privateBeta ? 'Local release notes' : 'Release notes';
  $('settings-update-hint').textContent = state.privateBeta ? 'Private beta for local testing. Updates come with your beta downloads.' : 'Check for new versions, download updates and restart to install.';
  renderOnboarding();
  document.dispatchEvent(new CustomEvent('dioptra:state', { detail: state })); // the scene on the start page (scene.js) follows the rules and the page
}
// Zoom of the tab, both panes in Compare: quiet grey at 100 %, blue otherwise. The card (main) has − +, the steps and Reset.
function renderZoom(tab) {
  const percent = Math.round((tab.zoom || 1) * 100), both = Boolean(state.comparison);
  $('zoom').classList.toggle('on', percent !== 100); $('zoom-value').textContent = `${percent}%`; $('zoom-both').hidden = !both;
  $('zoom').setAttribute('aria-label', `Zoom ${percent}%${both ? ', both panes' : ''}`);
  $('zoom').title = `Zoom ${percent}%${both ? ' on both panes' : ''} (${state.platform === 'darwin' ? '⌘' : 'Ctrl'} + and −)`;
}
function renderSettings() {
  const home=settingsCategory==='home';
  $('settings-menu').hidden=!home;$('settings-home-note').hidden=!home;$('settings-back').hidden=home;
  document.querySelectorAll('[data-settings-page]').forEach(node=>node.hidden=node.dataset.settingsPage!==settingsCategory);
  $('about-version').textContent=`Dioptra v${state.versions.app}`;
  const tab=state.tabs.find(tab=>tab.id===state.activeId);let host='';try{host=new URL(tab?.url).host;}catch{}
  $('settings-current-site').textContent=host?`Current site · ${host}`:'Current site';
  $('clear-site-data').disabled=!host;
  renderClaudeSettings(); renderAddons();
}
async function openSettings(category) {
  settingsCategory=category;
  if(state.panel!=='settings') await command('panel','settings');
  renderSettings();document.querySelector('#panel .panel-scroll').scrollTop=0;
  if(category==='home') $('settings-menu').querySelector('button').focus();else $('settings-back').focus();
}
/* Add-ons (1.4). Main installs, checks and runs them; this page only shows state.addons and sends commands. */
let addonUI = { code: '', error: '', busy: '', removing: '' }, addonKey = '';
async function addonCommand(action, data, busy) {
  addonUI = { ...addonUI, busy, error: '' }; renderAddons();
  const result = await window.browser.command(action, data).catch(error => ({ ok: false, error: error.message }));
  addonUI = { ...addonUI, busy: '', removing: '', error: result.ok ? '' : result.error || 'That did not work.', code: result.ok && action === 'addon-install' ? '' : addonUI.code };
  if (result.ok && result.notice) toast(result.notice);
  renderAddons(); return result;
}
function addonHead(a, chips) {
  // A known add-on shows its own drawing, white on a tile in its colour (ADDON_LOOK); any other one the puzzle piece.
  const look = Object.hasOwn(ADDON_LOOK, a.id) ? ADDON_LOOK[a.id] : null;
  const row = el('div', 'settings-row claude-heading'), logo = el('div', `addon-logo${look ? ' filled' : ''}`), grow = el('div', 'settings-grow'), line = el('div', 'addon-chips');
  logo.append(icon(look ? a.id : 'puzzle')); line.append(...chips);
  if (look) { logo.style.background = `linear-gradient(150deg, ${look[3]}, ${look[4]})`; logo.style.boxShadow = `inset 0 1px 0 rgba(255,255,255,.35), 0 7px 16px -8px ${look[4]}`; }
  grow.append(el('h3', '', a.name), el('p', '', a.by ? `Add-on by ${a.by}` : 'Add-on'), line); row.append(logo, grow); return row;
}
const addonChip = (text, tone = '') => el('span', `status-chip ${tone}`, text);
function addonList(title, items) { const card = el('div', 'settings-card'), list = el('ul', 'addon-list'); for (const item of items) list.append(el('li', '', item)); card.append(el('h4', '', title), list); return card; }
function addonActions(...buttons) { const row = el('div', 'settings-actions'); row.append(...buttons); return row; }
function addonButton(label, onclick, className = '') { const b = el('button', className, label); b.type = 'button'; b.onclick = onclick; b.disabled = Boolean(addonUI.busy); return b; }
function renderAddons() {
  const box = $('addons-body'), A = state?.addons || { installed: [], pending: null };
  const key = JSON.stringify([A, addonUI.error, addonUI.busy, addonUI.removing]);
  if (key === addonKey) return; addonKey = key;
  // The page is rebuilt when an update check ends: someone typing a code keeps the field and the caret.
  const typing = document.activeElement?.id === 'addon-code' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const nodes = [], time = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const error = () => { const p = el('p', 'addon-error', addonUI.error); p.setAttribute('role', 'alert'); return p; };
  if (A.pending) {
    // The manifest is fetched and its signature holds; no code has been fetched yet.
    const p = A.pending;
    nodes.push(addonHead(p, [addonChip('✓ Signature verified'), addonChip(p.version, 'blue')]));
    if (p.adds.length) nodes.push(addonList('What it adds', p.adds));
    if (p.may.length) nodes.push(addonList('What it may do', p.may));
    if (addonUI.error) nodes.push(error());
    nodes.push(addonActions(addonButton(addonUI.busy === 'install' ? 'Installing…' : 'Install', () => addonCommand('addon-install', null, 'install'), 'primary'), addonButton('Cancel', () => addonCommand('addon-cancel', null, ''))),
      el('p', 'settings-note', 'Signed by SolutionMAX. It updates itself from the same address; every update is checked the same way.'));
    box.replaceChildren(...nodes); return;
  }
  nodes.push(el('h3', '', 'Add-ons'), el('p', '', 'Extra tools for Dioptra, installed with a personal code'));
  for (const a of A.installed) {
    const broken = a.status !== 'active', card = el('div', 'settings-card addon');
    card.dataset.addon = a.id;
    card.append(addonHead(a, [addonChip(broken ? 'Needs attention' : a.enabled ? 'Active' : 'Off', broken ? 'amber' : a.enabled ? '' : 'blue'), ...(a.version ? [addonChip(a.version, 'blue')] : [])]));
    if (broken) card.append(el('p', 'addon-error', a.message || 'This add-on could not be loaded.'));
    else {
      card.append(el('p', '', a.enabled ? 'Scans every page after it has loaded, and both servers in Differences.' : 'Switched off: nothing is scanned.'));
      const facts = el('dl', 'addon-facts');
      facts.append(el('dt', '', a.data.label || 'Threat list'), el('dd', '', `${a.data.rules.toLocaleString('en-US')} ${a.data.rules === 1 ? 'rule' : 'rules'} · ${a.data.version || 'no version'}`));
      facts.append(el('dt', '', 'Updates'), el('dd', '', (!a.restart && a.update?.message) || (a.checkedAt ? `Automatic. Last checked ${time(a.checkedAt)}.` : 'Automatic.')));
      card.append(facts);
      if (a.restart) card.append(el('p', 'addon-restart', 'A new version is ready. Restart Dioptra to use it.'));
    }
    const removing = addonUI.removing === a.id;
    if (removing) { const ask = el('div', 'inline-confirm'); ask.append(el('p', '', `Remove ${a.name}? You need your code to install it again.`), addonActions(addonButton('Cancel', () => { addonUI = { ...addonUI, removing: '' }; renderAddons(); }), addonButton('Remove add-on', () => addonCommand('addon-remove', a.id, 'remove'), 'danger'))); card.append(ask); }
    else card.append(addonActions(...(broken ? [] : [addonButton(addonUI.busy === `check:${a.id}` ? 'Checking…' : 'Check for updates', () => addonCommand('addon-check', a.id, `check:${a.id}`)), addonButton(a.enabled ? 'Turn off' : 'Turn on', () => addonCommand('addon-enable', { id: a.id, on: !a.enabled }, 'enable'))]), addonButton('Remove…', () => { addonUI = { ...addonUI, removing: a.id, error: '' }; renderAddons(); }, 'danger')));
    nodes.push(card);
  }
  const add = el('div', 'settings-card'), input = el('input', 'addon-code'), go = addonButton(addonUI.busy === 'preview' ? 'Checking…' : 'Continue', () => { if (addonUI.code.trim()) addonCommand('addon-preview', addonUI.code.trim(), 'preview'); }, 'primary');
  input.type = 'text'; input.id = 'addon-code'; input.placeholder = 'DIOPTRA-…'; input.autocomplete = 'off'; input.spellcheck = false; input.value = addonUI.code; input.disabled = Boolean(addonUI.busy);
  input.setAttribute('aria-label', 'Add-on code'); input.oninput = () => { addonUI.code = input.value; };
  input.onkeydown = event => { if (event.key === 'Enter') go.click(); };
  add.append(el('h4', '', A.installed.length ? 'Install another add-on' : 'No add-ons installed'), el('p', '', 'Paste the add-on code you were given. Dioptra fetches the add-on and shows what it is before anything is installed.'), input);
  if (addonUI.error) add.append(error());
  add.append(addonActions(go));
  nodes.push(add, el('p', 'settings-note', 'Dioptra only installs add-ons signed by SolutionMAX. Anything else is refused.'));
  box.replaceChildren(...nodes);
  if (typing && !input.disabled) { input.focus(); input.setSelectionRange(...typing); }
}
function renderClaudeSettings() {
  const c=state.claude, u=c.update||{status:'idle'}, installed=Boolean(c.version), ready=c.status==='ready';
  const busy=claudeActionBusy||['loading','installing'].includes(c.status)||['checking','installing'].includes(u.status);
  $('claude-status').textContent={absent:'Not installed',loading:'Loading…',ready:'Installed',installing:'Installing…',error:'Needs attention'}[c.status]||'Not installed';
  $('claude-status').className=`status-chip ${c.status==='error'?'amber':ready?'':'blue'}`;
  $('claude-version').textContent=c.version?`v${c.version}`:'';
  $('settings-claude-message').textContent=c.message||'';$('settings-claude-message').hidden=!c.message;
  $('settings-install-claude').hidden=installed||ready;$('settings-install-claude').disabled=busy;
  $('claude-chat').hidden=$('claude-options').hidden=!ready;$('claude-controls').hidden=!installed&&!ready;
  for(const id of ['claude-chat','claude-options','claude-refresh','remove-claude','claude-update-action','claude-auto-updates']) $(id).disabled=busy;
  $('claude-check').disabled=busy||claudeChecking||!ready;$('claude-refresh').disabled=busy||!ready;
  $('install-claude').disabled=busy;
  $('claude-update-title').textContent={idle:'Not checked yet',checking:'Checking…',available:'Update available',current:'You’re up to date',installing:'Updating Claude…',error:'Could not check or update'}[u.status]||'Not checked yet';
  $('claude-update-message').textContent=u.message||(u.status==='available'&&u.version?`Version ${u.version}`:c.version?`Installed version ${c.version}`:'Install Claude to check for updates.');
  $('claude-update-state').className=`extension-update ${u.status==='available'?'available':u.status==='error'?'error':''}`;
  $('claude-update-action').textContent=busy?'Please wait…':u.status==='available'?'Update Claude':'Check for updates';
  $('claude-update-action').classList.toggle('primary',u.status==='available');
  $('claude-auto-updates').checked=c.autoCheck!==false;
  $('claude-update-checked').hidden=!u.checkedAt;$('claude-update-checked').textContent=u.checkedAt?`Last checked ${new Date(u.checkedAt).toLocaleString()}`:'';
  if(u.status!=='available') $('claude-update-confirm').hidden=true;
  if(ready) {$('claude-install-confirm').hidden=true;$('claude-panel-install-confirm').hidden=true;}
  if(!installed&&!ready) {$('claude-report').hidden=true;$('claude-reload-confirm').hidden=true;$('claude-remove-confirm').hidden=true;}
}
function showClaudeConfirmation(name, trigger) {
  for(const box of document.querySelectorAll('[id^="claude-"][id$="-confirm"]')) box.hidden=true;
  $(`claude-${name}-confirm`).hidden=false;$(`claude-${name}-cancel`).focus();
}
function bindClaudeConfirmation(name, trigger, action) {
  $(`claude-${name}-cancel`).onclick=()=>{$(`claude-${name}-confirm`).hidden=true;$(trigger).focus();};
  $(`claude-${name}-yes`).onclick=async()=>{
    claudeActionBusy=true;$(`claude-${name}-yes`).disabled=true;renderClaudeSettings();
    try{const result=await command(action);if(result.ok){$(`claude-${name}-confirm`).hidden=true;if(action==='claude-refresh'||action==='remove-claude')$('claude-report').hidden=true;}}
    finally{claudeActionBusy=false;$(`claude-${name}-yes`).disabled=false;renderClaudeSettings();if(!$(trigger).hidden)$(trigger).focus();}
  };
}
function resetForm() { editing = null; $('rule-form').reset(); $('save-rule').textContent = 'Add'; $('cancel-edit').hidden = true; setWww(true); setSkipSSL(false); ipNote(); closeSuggestions(); }
// www switch: the note names the second host name the rule will cover. core.cjs stores the rule under the bare domain.
function wwwNote() {
  const domain = $('domain-input').value.trim().replace(/\.$/, '').toLowerCase();
  $('www-note').textContent = !www ? 'Only this exact name' : !domain ? 'Also sends the www name to this IP' : `Also sends ${domain.startsWith('www.') && domain.split('.').length > 2 ? domain.slice(4) : `www.${domain}`} to this IP`;
}
function setSkipSSL(on) { skipSSL = on; $('ssl-switch').classList.toggle('on', on); $('ssl-switch').setAttribute('aria-checked', String(on)); }
function setWww(on) { www = on; $('www-switch').classList.toggle('on', on); $('www-switch').setAttribute('aria-checked', String(on)); wwwNote(); }
// Server list: imported in Settings, offered by name in the IP field.
const serverFor = ip => state.servers.find(server => server.ip === ip);
function ipNote() { const server = state && serverFor($('ip-input').value.trim()); $('ip-note').textContent = server ? `Server: ${server.name}` : 'IPv4 and IPv6'; }
function renderServers() {
  const servers = state.servers, any = servers.length > 0, pages = Math.max(1, Math.ceil(servers.length / SERVER_PAGE_SIZE));
  serverPage = Math.min(serverPage, pages - 1);
  const first = serverPage * SERVER_PAGE_SIZE, last = Math.min(first + SERVER_PAGE_SIZE, servers.length);
  $('servers').replaceChildren(...servers.slice(first, last).map(server => { const row = el('div', 'server'); row.append(el('span', 'n', server.name), el('span', 'i', server.ip)); return row; }));
  $('servers').classList.toggle('paged', pages > 1); $('servers').hidden = !any; $('server-pager').hidden = pages < 2; $('empty-servers').hidden = any; $('clear-servers').hidden = !any; $('server-tip').hidden = any;
  $('server-range').textContent = `${first + 1} to ${last} of ${servers.length}`; $('server-page').textContent = `Page ${serverPage + 1} of ${pages}`;
  $('server-prev').disabled = serverPage === 0; $('server-next').disabled = serverPage >= pages - 1;
  $('server-status').textContent = serverNote || (any ? `${servers.length} server${servers.length === 1 ? '' : 's'}` : '');
  $('ip-input').placeholder = any ? 'IP or server name' : '203.0.113.10';
  ipNote();
}
// Suggestions: typing in the IP field shows at most MAX_SUGGESTIONS servers that match by name or IP address.
const typedServer = () => $('ip-input').value.trim().toLowerCase();
// Only decides what Enter does in the IP field; the address itself is validated in core.cjs.
const completeIP = value => /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || (/^[0-9a-f:.]+$/i.test(value) && value.split(':').length > 2);
function markedName(name, query) {
  const at = name.toLowerCase().indexOf(query), node = el('span', 'n');
  if (at < 0) node.textContent = name; else node.append(name.slice(0, at), el('mark', '', name.slice(at, at + query.length)), name.slice(at + query.length));
  return node;
}
function drawSuggestions() {
  const box = $('ip-options'), input = $('ip-input'), query = typedServer();
  box.hidden = !suggestions.length; input.setAttribute('aria-expanded', String(suggestions.length > 0));
  if (suggestions.length) input.setAttribute('aria-activedescendant', `server-option-${activeSuggestion}`); else input.removeAttribute('aria-activedescendant');
  box.replaceChildren(...suggestions.map((server, index) => {
    const option = el('div', 'option' + (index === activeSuggestion ? ' active' : '')); option.id = `server-option-${index}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === activeSuggestion));
    option.append(markedName(server.name, query), el('span', 'i', server.ip));
    option.onmousedown = event => { event.preventDefault(); chooseServer(server); };
    return option;
  }));
  if (suggestionTotal > suggestions.length) box.append(el('div', 'more', `${suggestions.length} of ${suggestionTotal} servers. Keep typing to narrow down.`));
}
function suggestServers() {
  const query = typedServer(), starts = server => server.name.toLowerCase().startsWith(query);
  const found = query ? (state?.servers || []).filter(server => server.name.toLowerCase().includes(query) || server.ip.includes(query)) : [];
  const ranked = [...found.filter(starts), ...found.filter(server => !starts(server))]; // names that start with the typed text first
  suggestionTotal = ranked.length; suggestions = ranked.slice(0, MAX_SUGGESTIONS); activeSuggestion = 0; suggestionChosen = false; drawSuggestions();
}
function closeSuggestions() { suggestions = []; suggestionTotal = 0; drawSuggestions(); }
function chooseServer(server) { $('ip-input').value = server.ip; closeSuggestions(); ipNote(); }
$('rule-form').onsubmit = async event => {
  event.preventDefault(); const existing = state.rules.find(r => r.domain === editing), typed = $('ip-input').value.trim();
  const rule = { domain: $('domain-input').value, ip: state.servers.find(server => server.name.toLowerCase() === typed.toLowerCase())?.ip || typed, enabled: existing?.enabled ?? true, www, skipSSL };
  const rules = editing ? state.rules.map(r => r.domain === editing ? rule : r) : [...state.rules, rule];
  const result = await command('save-rules', rules); if (result.ok) { resetForm(); toast('Rule saved. Affected tabs reloaded.'); }
};
$('cancel-edit').onclick = resetForm;
$('www-row').onclick = () => setWww(!www);
$('ssl-row').onclick = () => setSkipSSL(!skipSSL);
$('domain-input').oninput = wwwNote;
$('ip-input').oninput = () => { suggestServers(); ipNote(); };
$('ip-input').onfocus = suggestServers;
$('ip-input').onblur = closeSuggestions;
$('ip-input').onkeydown = event => {
  if (event.key === 'Escape') return closeSuggestions();
  if (!suggestions.length) return;
  // Enter takes the highlighted server, unless a full address was typed and no server was picked with the arrows: then it submits as typed.
  if (event.key === 'Enter' && (suggestionChosen || !completeIP(typedServer()))) { event.preventDefault(); return chooseServer(suggestions[activeSuggestion]); }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault(); suggestionChosen = true; activeSuggestion = (activeSuggestion + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length; drawSuggestions();
};
$('servers').style.setProperty('--rows', SERVER_PAGE_SIZE);
$('server-prev').onclick = () => { serverPage--; renderServers(); };
$('server-next').onclick = () => { serverPage++; renderServers(); };
$('import-servers').onclick = () => $('server-file').click();
$('server-file').onchange = async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  if (file.size > MAX_SERVER_CSV) return toast('This file is too large for a server list.');
  let text; try { text = await file.text(); } catch { return toast('Could not read this file.'); }
  const result = await command('import-servers', text);
  if (result.ok) { serverPage = 0; serverNote = `${result.imported} server${result.imported === 1 ? '' : 's'} imported${result.skipped ? `, ${result.skipped} line${result.skipped === 1 ? '' : 's'} skipped` : ''}`; renderServers(); }
};
$('clear-servers').onclick = async () => { const result = await command('clear-servers'); if (result.ok) { serverPage = 0; serverNote = ''; renderServers(); } };
setWww(true);
$('navigation').onsubmit = event => { event.preventDefault(); const url = $('address').value; $('address').blur(); command('navigate', url); };
$('new-tab').onclick = () => command('new-tab'); $('domains').onclick = () => command('panel', state.panel === 'domains' ? null : 'domains'); $('close-panel').onclick = () => command('panel', null);
$('welcome-domains').onclick = async () => { await command('panel', 'domains'); $('domain-input').focus(); };
$('settings').onclick = () => { settingsCategory = 'home'; command('panel', ['settings', 'updates'].includes(state.panel) ? null : 'settings'); };
$('update-notice').onclick = () => openSettings('updates');
document.querySelectorAll('[data-settings-category]').forEach(button => button.onclick = () => openSettings(button.dataset.settingsCategory));
$('settings-back').onclick = () => openSettings('home');
$('back').onclick = () => command('back'); $('forward').onclick = () => command('forward'); $('reload').onclick = () => command(state.tabs.find(t => t.id === state.activeId)?.loading ? 'stop' : 'reload'); $('retry').onclick = () => command('reload');

$('feed').oninput = () => { feedDirty = true; };
$('feed-form').onsubmit = async event => { event.preventDefault(); const result = await command('update-settings', { feed: $('feed').value, automatic: $('auto-updates').checked }); if (result.ok) feedDirty = false; };
$('auto-updates').onchange = () => command('update-settings', { feed: state.updateFeed, automatic: $('auto-updates').checked });
$('check-update').onclick = () => command('check-update'); $('download-update').onclick = () => command('download-update'); $('install-update').onclick = () => command('install-update');
window.browser.onState(render);
window.browser.onNotice(toast);
window.browser.onFocusAddress(() => { $('address').focus(); $('address').select(); });
window.browser.onAuth(data => { if (!data) { $('auth-dialog').close(); $('auth-form').reset(); return; } $('auth-host').textContent = `${data.host} — ${data.realm || ''}`; $('auth-dialog').showModal(); $('auth-user').focus(); });
$('auth-form').onsubmit = event => { event.preventDefault(); command('auth', { username: $('auth-user').value, password: $('auth-password').value }); };
$('auth-cancel').onclick = () => command('auth', null);
$('auth-dialog').addEventListener('cancel', event => { event.preventDefault(); command('auth', null); });
command('state').then(result => { if (result.ok) render(result.state); });

$('maker-website').onclick = () => command('new-tab', 'https://solutionmax.net/');
$('maker-github').onclick = () => command('new-tab', 'https://github.com/Solutionmax/dioptra');
$('maker-coffee').onclick = () => command('new-tab', 'https://buymeacoffee.com/solutionmax');
$('tools-close').onclick = () => command('devtools');
// Compare: drag the bar between the panes. The press starts in the gap between the two websites and the pointer
// stays captured while it moves over them. The element is never rebuilt, a rebuild would drop the capture.
const splitter = $('compare-splitter');
let splitDrag = null, splitFrame = 0;
const share = ratio => Math.max(.25, Math.min(.75, ratio));
const setShare = (ratio, commit = true) => command('compare-ratio', { ratio: Math.round(share(ratio) * 1000) / 1000, commit });
function renderSplitter() {
  const [left, right] = state.comparison && state.paneLayout.length === 2 ? [...state.paneLayout].sort((a, b) => a.banner.x - b.banner.x) : [];
  // The reset button is a neighbour of the bar, not a child: a separator hides its children from screen readers.
  const reset = $('compare-reset');
  splitter.hidden = !left; reset.hidden = !left || state.compareRatio === .5;
  if (!left) { if (splitDrag) finishSplitDrag(true); return; }
  const x = left.banner.x + left.banner.width, percent = Math.round(state.compareRatio * 100);
  place(splitter, { x, y: left.banner.y, width: right.banner.x - x, height: left.page.y + left.page.height - left.banner.y });
  splitter.setAttribute('aria-valuenow', String(percent));
  splitter.setAttribute('aria-valuetext', `Left pane ${percent} percent`);
  $('compare-share').textContent = `${percent} · ${100 - percent}`;
  reset.style.left = `${x + (right.banner.x - x) / 2}px`; reset.style.top = `${left.banner.y + 7}px`;
  splitter.querySelector('.grip').hidden = !reset.hidden;
}
function finishSplitDrag(cancel) {
  if (!splitDrag) return;
  const drag = splitDrag; splitDrag = null; cancelAnimationFrame(splitFrame); splitFrame = 0;
  splitter.classList.remove('dragging');
  setShare(cancel ? drag.ratio : drag.latest);
}
splitter.onpointerdown = event => {
  if (event.button !== 0) return;
  event.preventDefault(); splitter.setPointerCapture(event.pointerId);
  splitDrag = { ratio: state.compareRatio, latest: state.compareRatio }; splitter.classList.add('dragging');
};
splitter.onpointermove = event => {
  if (!splitDrag) return;
  // A release that never arrived (button let go outside the window) ends the drag where it is.
  if (!event.buttons) return finishSplitDrag(false);
  const width = Math.max(...state.paneLayout.map(pane => pane.banner.x + pane.banner.width));
  splitDrag.latest = share(event.clientX / width);
  // One layout per frame is enough; every step resizes two websites.
  if (!splitFrame) splitFrame = requestAnimationFrame(() => { splitFrame = 0; if (splitDrag) setShare(splitDrag.latest, false); });
};
splitter.onpointerup = () => finishSplitDrag(false);
splitter.onpointercancel = splitter.onlostpointercapture = () => finishSplitDrag(true);
splitter.ondblclick = () => setShare(.5);
// The button hides once the panes are equal: keyboard users continue on the bar, a mouse click leaves no focus ring behind.
$('compare-reset').onclick = event => { setShare(.5); if (event.detail === 0) splitter.focus(); };
splitter.onkeydown = event => {
  if (event.target !== splitter || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
  event.preventDefault(); setShare(state.compareRatio + (event.key === 'ArrowRight' ? .05 : -.05));
};
document.addEventListener('keydown', event => { if (event.key === 'Escape' && splitDrag) { event.preventDefault(); finishSplitDrag(true); } });
document.querySelectorAll('[data-dock]').forEach(button => { button.onclick = () => command('devtools-layout', { dock: button.dataset.dock }); });
let toolsDrag = null;
function dragDock(event) {
  const { page, tools } = state.toolsLayout;
  const width = Math.max(page.x + page.width, tools.x + tools.width);
  return event.clientX < width * .25 ? 'left' : event.clientX > width * .75 ? 'right' : 'bottom';
}
for (const id of ['tools-grip', 'tools-splitter']) {
  const handle = $(id);
  handle.onpointerdown = event => {
    if (event.button !== 0 || !state.toolsLayout) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const bottom = state.devtoolsDock === 'bottom', bounds = state.toolsLayout;
    const size = bottom ? bounds.tools.height + bounds.bar.height : bounds.tools.width;
    toolsDrag = { id, dock: state.devtoolsDock, ratio: state.devtoolsRatio, target: state.devtoolsDock, latestRatio: state.devtoolsRatio, start: bottom ? event.clientY : event.clientX, size, total: size + (bottom ? bounds.page.height + bounds.splitter.height : bounds.page.width + bounds.splitter.width) };
    document.body.classList.toggle('tools-resizing', id === 'tools-splitter');
    command('devtools-drag', true);
  };
  document.addEventListener('pointermove', event => {
    if (!toolsDrag || toolsDrag.id !== id) return;
    if (id === 'tools-grip') {
      toolsDrag.target = dragDock(event);
      document.querySelectorAll('[data-drop]').forEach(node => node.classList.toggle('selected', node.dataset.drop === toolsDrag.target));
    } else {
      const delta = (toolsDrag.dock === 'bottom' ? event.clientY : event.clientX) - toolsDrag.start;
      const ratio = (toolsDrag.size + delta * (toolsDrag.dock === 'left' ? 1 : -1)) / toolsDrag.total;
      toolsDrag.latestRatio = Math.max(.2, Math.min(.7, ratio));
      command('devtools-layout', { ratio: toolsDrag.latestRatio, commit: false });
    }
  });
  handle.onpointerup = () => finishToolsDrag(false);
  handle.onpointercancel = () => finishToolsDrag(true);
  handle.onlostpointercapture = () => { if (toolsDrag) finishToolsDrag(true); };
}
document.addEventListener('pointerup', () => finishToolsDrag(false));
document.addEventListener('pointercancel', () => finishToolsDrag(true));
async function finishToolsDrag(cancel) {
  if (!toolsDrag) return;
  const drag = toolsDrag; toolsDrag = null;
  const changes = cancel ? { dock: drag.dock, ratio: drag.ratio } : { dock: drag.target, ratio: drag.latestRatio };
  await command('devtools-layout', changes);
  await command('devtools-drag', false);
  document.body.classList.remove('tools-resizing');
}
document.addEventListener('keydown', event => { if (event.key === 'Escape' && toolsDrag) { event.preventDefault(); finishToolsDrag(true); } });
window.addEventListener('blur', () => { if (toolsDrag) finishToolsDrag(true); });
$('tools-splitter').onkeydown = event => {
  const keys = state.devtoolsDock === 'bottom' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  const increase = state.devtoolsDock === 'left' ? event.key === 'ArrowRight' : state.devtoolsDock === 'right' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
  command('devtools-layout', { ratio: Math.max(.2, Math.min(.7, state.devtoolsRatio + (increase ? .05 : -.05))) });
};

$('claude').onclick = () => command('panel', state.panel === 'claude' ? null : 'claude');
for (const [trigger, name, action] of [['install-claude', 'panel-install', 'install-claude'], ['settings-install-claude', 'install', 'install-claude'], ['remove-claude', 'remove', 'remove-claude'], ['claude-refresh', 'reload', 'claude-refresh']]) {
  $(trigger).onclick = () => showClaudeConfirmation(name, trigger);
  bindClaudeConfirmation(name, trigger, action);
}
bindClaudeConfirmation('update', 'claude-update-action', 'claude-install-update');
$('claude-update-action').onclick = async () => {
  if (state.claude.update?.status === 'available') return showClaudeConfirmation('update', 'claude-update-action');
  claudeActionBusy = true; renderClaudeSettings();
  try { await command('claude-check-update'); } finally { claudeActionBusy = false; renderClaudeSettings(); }
};
$('claude-auto-updates').onchange = async () => {
  const result = await command('claude-update-settings', { autoCheck: $('claude-auto-updates').checked });
  if (!result.ok) renderClaudeSettings();
};
$('claude-options').onclick = () => command('claude-options');
$('claude-chat').onclick = () => command('panel', 'claude');

$('claude-check').onclick = async () => {
  claudeChecking = true; $('claude-check').disabled = true;
  try {
    const result = await command('claude-check');
    if (!result.ok) return;
    const d = result.diagnostics;
    $('claude-diagnostics').textContent = JSON.stringify(d, null, 2);
    const rows = [['Extension', d.extensionVersion ? `Loaded · v${d.extensionVersion}` : 'Version unavailable'], ['Claude panel', d.interface === 'new' ? 'New interface detected' : d.interface === 'settings' ? 'Extension settings open' : 'Classic interface or loading'], ['Browser permission', d.browserPermissionAccepted ? 'Granted' : 'Not granted']];
    $('claude-results').replaceChildren(...rows.map(([label, value]) => { const row = el('div', ''); row.append(el('span', '', label), el('strong', '', value)); return row; }));
    $('claude-report-summary').textContent = d.lastInterfaceSignal === 'cic_sidepanel_cowork_unavailable' ? 'Claude reported that the new interface is unavailable and fell back to classic.' : d.interface === 'new' ? 'The new Claude interface is selected. Its load status is shown below.' : d.newInterfaceEnabled === true ? 'The new interface is enabled in the cached settings, but is not currently displayed.' : d.newInterfaceEnabled === false ? 'The cached Claude settings disable the new interface. Try Refresh Claude, then check again.' : 'No interface setting is available yet. Open Claude, finish signing in, then check again.';
    $('claude-report').hidden = false;
  } finally { claudeChecking = false; renderClaudeSettings(); }
};
$('claude-copy-diagnostics').onclick = async () => { const result = await command('claude-copy-diagnostics'); if (result.ok) toast('Claude diagnostics copied.'); };

function place(node, rect) { Object.assign(node.style,{left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.width}px`,height:`${rect.height}px`}); }
function renderPerformance(metrics) {
  if(!state) return;
  state.performance=metrics;
  const memoryKB=metrics?.memoryKB;
  const memory=Number.isFinite(memoryKB) && memoryKB>=0 ? (memoryKB>=1048576 ? `${(memoryKB/1048576).toFixed(2)} GB` : `${Math.round(memoryKB/1024)} MB`) : '—';
  $('memory-usage').textContent=`RAM ${memory}`;
  $('memory-usage').title=memory==='—'?'Memory measurement unavailable.':'Click to see memory per tab. Estimate: shared memory can be counted more than once.';
  $('memory-usage').setAttribute('aria-label',`Dioptra uses ${memory} of memory, show details per tab`);
}
window.browser.onPerformance(renderPerformance);
function renderWorkspace() {
  const tab=state.tabs.find(t=>t.id===state.activeId);
  const view=currentView(), usesRule=Boolean(tab?.route.configured && tab?.mode==='hostfile'), inPair=view!=='single';
  const canCompare=tab?.mode==='hostfile' && /^https?:/.test(tab?.url || '');
  const left=state.tabs.find(t=>t.id===state.comparison?.host), right=state.tabs.find(t=>t.id===state.comparison?.live);
  // The right pane of Compare can be on another site; Differences only makes sense for one site on two servers.
  const otherSite=Boolean(left && right && !right.startPage && left.route.host!==right.route.host);
  if(!state.comparison) { compareWith=null; compareWithError=''; }
  for(const [id,name] of [['view-single','single'],['compare','compare'],['view-differences','differences']]) $(id).setAttribute('aria-pressed',String(view===name));
  $('compare').disabled=!inPair && !canCompare; $('view-differences').disabled=view==='compare' ? otherSite || !left?.route.configured : !inPair && !usesRule;
  const why=view==='compare' && otherSite?' (needs the same site on both sides)':$('view-differences').disabled?' (add a domain rule for this site first)':'';
  $('compare').title=(view==='compare'?'Close comparison':usesRule?'Compare Hostfile and Live':'Compare with another URL')+(canCompare||inPair?'':' (open a website first)'); $('view-differences').title='Compare what both servers return'+why;
  const marked=state.library.bookmarks.some(b=>b.url===tab?.url);
  $('bookmark').classList.toggle('on',marked); $('bookmark').setAttribute('aria-label',marked?'Remove bookmark':'Bookmark page');
  $('bookmark').disabled=!/^https?:/.test(tab?.url || '');

  $('footer-note').textContent='by SolutionMAX';
  renderPerformance(state.performance);
  $('find-bar').hidden=!state.find.open;
  $('find-count').textContent=state.find.text ? `${state.find.active} / ${state.find.matches}` : '';
  if(document.activeElement!==$('find-input')) $('find-input').value=state.find.text;
  const oldField=$('compare-with'), caret=document.activeElement===oldField ? [oldField.selectionStart,oldField.selectionEnd] : null;
  $('pane-bars').replaceChildren(); $('comparison-errors').replaceChildren();
  renderRouteBar(tab, view);
  if(state.comparison) for(const pane of state.paneLayout) {
    const t=state.tabs.find(t=>t.id===pane.id);if(!t) continue;
    const selected=t.id===state.activeId;
    const isRight=t.id===state.comparison.live;
    const bar=routeBar(t,{pane:true,selected,other:isRight?otherSite:undefined});place(bar,pane.banner);bar.classList.toggle('route-wrap',pane.banner.height>48);bar.classList.toggle('route-stack',pane.banner.width<=300);bar.classList.add(isRight?'pane-right':'pane-left');$('pane-bars').append(bar);
    if(t.error) {
      const error=el('div','comparison-error');place(error,pane.page);
      error.append(el('h2','',t.certBlocked?'Live certificate is not trusted':`${t.route.label} could not load`),el('p','',t.url),el('code','',t.error));
      const retry=el('button','','Try again');retry.onclick=async()=>{await command('activate',t.id);command('reload');};error.append(...errorHelp(t,retry));$('comparison-errors').append(error);
    } else if(isRight && t.startPage) {
      const empty=el('div','pane-empty'), hint=el('span','','Type the address of the other copy, for example ');place(empty,pane.page);
      hint.append(el('code','','staging.example.com'));empty.append(el('b','','What do you want to compare with?'),hint);$('comparison-errors').append(empty);
    }
  }
  renderSplitter();
  // The bars are rebuilt on every state update: keep the caret, and put it in the field when the field first shows.
  const field=$('compare-with');
  if(field && caret) { if(document.hasFocus()) { field.focus(); field.setSelectionRange(...caret); } } else if(field && !oldField && right?.startPage) { field.focus(); field.select(); }
  // Closing the field hands the focus back to the button that opened it.
  if(compareWithClosed) { compareWithClosed=false; field?.blur(); }
  renderDifferences(tab, view);
  renderLibrary();
}
function renderLibrary() {
  const downloads=new Map(state.library.downloads.map(d=>[d.id,d]));for(const d of state.downloads)downloads.set(d.id,d);
  const all=libraryTab==='downloads'?[...downloads.values()].reverse():state.library[libraryTab];
  const query=librarySearch.trim().toLocaleLowerCase(), entries=all.filter(entry=>[entry.title,entry.name,entry.url].some(value=>String(value||'').toLocaleLowerCase().includes(query)));
  const today=new Date().toDateString(), yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);
  const key=JSON.stringify([libraryTab,entries,query,today]);if(key===libraryKey)return;libraryKey=key;
  document.querySelectorAll('[data-library]').forEach(n=>{n.classList.toggle('selected',n.dataset.library===libraryTab);n.setAttribute('aria-pressed',String(n.dataset.library===libraryTab));});
  $('library-search').placeholder=`Search ${libraryTab}…`;
  $('clear-library').hidden=libraryTab==='bookmarks';$('clear-library').textContent=libraryTab==='history'?'Clear history…':'Clear finished…';
  $('reopen-tab').hidden=libraryTab==='downloads';$('library-local-note').hidden=libraryTab!=='bookmarks';
  const focused=document.activeElement?.dataset.libraryAction;
  $('library-list').replaceChildren();
  if(!entries.length){const empty=el('div','library-empty');empty.append(el('h4','',query?'No results':`No ${libraryTab} yet.`),el('p','',query?'Try another title or website address.':libraryTab==='bookmarks'?'Save a page with the star in the address bar.':libraryTab==='history'?'Pages you visit appear here.':'Downloads appear here when you save a file.'));$('library-list').append(empty);}
  const groups=new Map();
  for(const entry of entries){
    const date=new Date(entry.visitedAt);
    const group=libraryTab==='bookmarks'?'Saved pages':libraryTab==='history'?(date.toDateString()===today?'Today':date.toDateString()===yesterday.toDateString()?'Yesterday':date.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})):entry.state==='completed'?'Completed':entry.state==='cancelled'?'Cancelled':entry.state==='interrupted'?'Interrupted':'In progress';
    if(!groups.has(group))groups.set(group,[]);groups.get(group).push(entry);
  }
  for(const [group,items] of groups){
    $('library-list').append(el('h4','library-group',group));
    for(const entry of items){
      const download=libraryTab==='downloads', title=download?entry.name:entry.title||entry.url;
      const row=el('div','library-entry'), icon=el('span','library-favicon',download?'↓':title.slice(0,1).toUpperCase()), content=el('div','library-content');icon.setAttribute('aria-hidden','true');row.append(icon,content);
      const heading=el(download?'strong':'button','library-link',title);heading.title=title;content.append(heading);
      if(!download){heading.dataset.libraryAction=`open:${entry.url}`;heading.onclick=()=>command('new-tab',entry.url);}
      const meta=el('p','',download?`${(entry.received/1048576).toFixed(1)} / ${entry.total?(entry.total/1048576).toFixed(1):'?'} MB`:entry.url);meta.title=meta.textContent;content.append(meta);
      if(download){
        if(entry.state==='progressing'){const progress=el('progress','');progress.setAttribute('aria-label',`Download progress for ${title}`);if(entry.total){progress.max=entry.total;progress.value=entry.received;}content.append(progress);}
        content.append(el('p','',entry.paused?'Paused':entry.state==='progressing'?'Downloading':entry.state==='interrupted'?(entry.canResume?'Interrupted · can resume':'Interrupted'):entry.state==='cancelled'?'Cancelled':'Completed'));
        const actions=entry.state==='completed'?[['show','Show in folder','folder']]:entry.state==='progressing'||entry.canResume?[...(entry.paused||entry.state==='interrupted'?(entry.canResume?[['resume','Resume download','play']]:[]):[['pause','Pause download','pause']]),['cancel','Cancel download','close']]:[];
        for(const [action,label,symbol] of actions){const button=el('button','library-action');setIcon(button,symbol);button.title=label;button.setAttribute('aria-label',action==='show'?`Show ${title} in folder`:`${label} ${title}`);button.dataset.libraryAction=`${action}:${entry.id}`;button.onclick=()=>command('download-action',{id:entry.id,action});row.append(button);}
      }else if(libraryTab==='bookmarks'){
        const remove=el('button','library-action');setIcon(remove,'trash');remove.title='Remove bookmark';remove.setAttribute('aria-label',`Remove bookmark ${title}`);remove.dataset.libraryAction=`remove:${entry.url}`;remove.onclick=()=>command('remove-bookmark',entry.url);row.append(remove);
      }else{const time=el('time','',new Date(entry.visitedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}));time.dateTime=new Date(entry.visitedAt).toISOString();time.title=new Date(entry.visitedAt).toLocaleString();row.append(time);}
      $('library-list').append(row);
    }
  }
  if(focused) [...$('library-list').querySelectorAll('[data-library-action]')].find(node=>node.dataset.libraryAction===focused)?.focus({preventScroll:true});
}
$('compare').onclick=()=>command(currentView()==='compare'?'stop-compare':'compare');
$('view-single').onclick=()=>currentView()==='compare'?command('stop-compare'):currentView()==='differences'?command('view','single'):0;
async function openDifferences() {
  if(currentView()==='differences') return;
  if(currentView()==='compare') await command('stop-compare');
  const result=await command('view','differences'); if(!result.ok) return;
  const d=state.differences, tab=state.tabs.find(t=>t.id===state.activeId);
  if(d?.status!=='running' && !(d?.status==='done' && d.report?.url===tab?.url)) command('differences-run');
}
$('view-differences').onclick=openDifferences;
// A label in the server bar opens Differences on its part. Like the cards: on pointerdown, because the bar is rebuilt on every state update.
function openPart(id) { diffPart=id; diffKey=''; diffFocus=true; if(currentView()==='differences') renderDifferences(state.tabs.find(t=>t.id===state.activeId),'differences'); else openDifferences(); }
const chipPart=target=>{ const chip=target.closest?.('[data-addon-tab],[data-files],[data-checks]'); return chip ? (chip.dataset.addonTab ? `addon:${chip.dataset.addonTab}` : chip.dataset.files ? 'files' : 'checks') : ''; };
document.addEventListener('pointerdown',event=>{ const part=event.button===0 && chipPart(event.target); if(part) { event.preventDefault(); openPart(part); } },true);
document.addEventListener('click',event=>{ const part=event.detail===0 && chipPart(event.target); if(part) openPart(part); });
$('clear-site-data').onclick=async()=>{ if((await command('clear-site-data')).ok) toast('Site data cleared for this site.'); };
$('open-release').onclick=$('release-page').onclick=()=>command('open-release');
$('footer-version').onclick=()=>openSettings('updates');
$('bookmark').onclick=()=>command('bookmark');
$('library').onclick=$('open-library').onclick=()=>command('panel','library');
$('open-find').onclick=()=>command('find-open');
$('find-input').oninput=()=>command('find',{text:$('find-input').value});
$('find-input').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();command('find',{text:$('find-input').value,forward:!e.shiftKey});}if(e.key==='Escape')command('find-close');};
$('find-next').onclick=()=>command('find',{text:$('find-input').value,forward:true});
$('find-prev').onclick=()=>command('find',{text:$('find-input').value,forward:false});
$('find-close').onclick=()=>command('find-close');
window.browser.onFocusFind(()=>{$('find-input').focus();$('find-input').select();});
$('manage-ssl').onclick=()=>command('panel','domains');
$('reopen-tab').onclick=()=>command('reopen-tab');
$('library-search').oninput=()=>{librarySearch=$('library-search').value;renderLibrary();};
$('clear-library').onclick=()=>{
  $('clear-library-message').textContent=libraryTab==='history'?'Remove the saved history on this device?':'Remove finished entries? Downloaded files stay on your device.';
  $('clear-library-confirm').hidden=false;$('clear-library-cancel').focus();
};
$('clear-library-cancel').onclick=()=>{$('clear-library-confirm').hidden=true;$('clear-library').focus();};
$('clear-library-yes').onclick=async()=>{
  $('clear-library-yes').disabled=true;
  try { if((await command(libraryTab==='history'?'clear-history':'clear-downloads')).ok){$('clear-library-confirm').hidden=true;$('clear-library').focus();} }
  finally { $('clear-library-yes').disabled=false; }
};
document.querySelectorAll('[data-library]').forEach(b=>b.onclick=()=>{libraryTab=b.dataset.library;librarySearch='';$('library-search').value='';$('clear-library-confirm').hidden=true;renderLibrary();});



/* View state, route bars and the Differences view. All dynamic text uses textContent. */
const ICONS = {
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  puzzle: '<path d="M9 4h4v2.5a1.5 1.5 0 0 0 3 0V4h4v5h-2.5a1.5 1.5 0 0 0 0 3H20v8h-5v-2.5a1.5 1.5 0 0 0-3 0V20H4v-6h2.5a1.5 1.5 0 0 0 0-3H4V4z"/>',
  folder: '<path d="M3 5h7l2 3h9v12H3z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  reload: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  stop: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  sliders: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  // The parts of Differences, and the add-ons that have their own icon (see ADDON_LOOK).
  overview: '<rect x="3.5" y="4" width="7" height="7" rx="1.6"/><rect x="13.5" y="4" width="7" height="7" rx="1.6"/><rect x="3.5" y="14" width="7" height="6" rx="1.6"/><rect x="13.5" y="14" width="7" height="6" rx="1.6"/>',
  domains: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3 3.3 3 13.7 0 17M12 3.5c-3 3.3-3 13.7 0 17"/>',
  files: '<path d="M14 3H7.2A2.2 2.2 0 0 0 5 5.2v13.6A2.2 2.2 0 0 0 7.2 21h9.6a2.2 2.2 0 0 0 2.2-2.2V8z"/><path d="M14 3v5h5M9 13h6M9 16.5h4"/>',
  html: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.6 5l-3.2 14"/>',
  headers: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 9h17M7 13h6M7 16h9"/>',
  speed: '<path d="M4.6 17.5a8.5 8.5 0 1 1 14.8 0"/><path d="M12 13.5l4-5"/><circle cx="12" cy="14" r="1.2"/>',
  checks: '<path d="M4 6.5l1.6 1.6L8.4 5M4 12.5l1.6 1.6 2.8-3.1M4 18.5l1.6 1.6 2.8-3.1M12 6.5h8M12 12.5h8M12 18.5h8"/>',
  'malware-scan': '<rect x="8" y="8.5" width="8" height="11.5" rx="4"/><path d="M9.6 8.6a2.4 2.4 0 0 1 4.8 0"/><path d="M10 6.3L8.4 4.2M14 6.3l1.6-2.1M8 12.5H4.5M8 16.2H5l-1 1.8M16 12.5h3.5M16 16.2h3l1 1.8M12 11.5v8.5"/>',
  'seo-check': '<circle cx="10.5" cy="10.5" r="6.8"/><path d="M15.5 15.5L20.5 20.5"/><path d="M7.8 13v-1.6M10.5 13V9.2M13.2 13V7.4"/>',
  'wp-leak-check': '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.5 10.5V7.3a3.5 3.5 0 0 1 6.8-1.2"/><path d="M12 13.2c1.1 1.3 1.7 2.2 1.7 3a1.7 1.7 0 0 1-3.4 0c0-.8.6-1.7 1.7-3z"/>'
};
function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.innerHTML = ICONS[name]; return svg; }
function setIcon(node, name) { if (node.dataset.icon === name) return; node.dataset.icon = name; node.replaceChildren(icon(name)); }
const HOW = {
  beta: ['Local beta updates', ['This private beta does not contact a public update feed.', 'Get the next beta from the person who supplied this build.', 'Quit Dioptra, replace the app in Applications, then reopen it. Your saved profile is kept.'], 'Use the download for your Mac: Apple Silicon (arm64) or Intel (x64).'],
  general: ['How updates work', ['Dioptra checks GitHub for a new release at start and every 4 hours.', 'You see it in the footer and at the top right. Nothing installs by itself.', 'You choose when. Tabs and domain rules come back after the restart.'], ''],
  manual: ['How to update on macOS', ['Open the download page and get the zip for your Mac: Apple Silicon or Intel.', 'Quit Dioptra and drag the new app over the old one in Applications.', 'Open it. Rules, tabs and logins are kept.'], 'The Mac build is not notarized yet, so it cannot replace itself.'],
  auto: ['How to update', ['Click Download update. The file is checked against its checksum and, on macOS, its signature.', 'Click Install and restart when it suits you.', 'Dioptra reopens on the new version with your tabs.'], '']
};
let howKey = '';
function renderUpdateDetails() {
  const u = state.update, updating = ['available', 'downloading', 'downloaded'].includes(u.status), installed = `v${state.versions.app}`;
  $('update-card').className = `update-card ${u.status === 'downloaded' ? 'green' : updating ? 'blue' : u.status === 'error' ? 'red' : ''}`;
  $('update-title').textContent = { 'private-beta': 'Private beta · local testing', available: 'New version', downloading: 'Downloading', downloaded: 'Ready to install', error: 'Update could not be completed', checking: 'Checking' }[u.status] || 'Installed';
  $('update-version').textContent = updating && u.version ? `${installed} → v${u.version}` : `Dioptra ${installed}`;
  const released = updating && u.date && !Number.isNaN(Date.parse(u.date)) ? new Date(u.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const pill = u.status === 'current' ? 'up to date' : released;
  $('update-pill').hidden = !pill; $('update-pill').textContent = pill; $('update-pill').className = `pill-s ${u.status === 'current' ? 'g' : 'b'}`;
  const checked = u.checkedAt ? `Last checked ${new Date(u.checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
  $('update-message').textContent = u.status === 'current' && checked ? `${checked} · ${state.autoUpdates ? 'checks again every 4 hours' : 'automatic checks are off'}` : u.message;
  const key = state.privateBeta ? 'beta' : !updating ? 'general' : u.canInstall === false ? 'manual' : 'auto';
  if (key !== howKey) { howKey = key; const [title, steps, hint] = HOW[key]; $('how-title').textContent = title; $('how-steps').replaceChildren(...steps.map(step => el('li', '', step))); $('how-hint').textContent = hint; $('how-hint').hidden = !hint; }
  const footer = $('footer-version');
  footer.className = u.status === 'downloaded' ? 'ready' : updating ? 'new' : '';
  footer.textContent = u.status === 'downloaded' ? `v${u.version} ready · restart to update` : updating && u.version ? `Dioptra ${installed} · v${u.version} available` : `Dioptra ${installed}`;
}
function currentView() { return state.view || (state.comparison ? 'compare' : 'single'); }
let onboardingBusy = false, onboardingStep = -1, onboardingServers = '';
function renderOnboarding() {
  const setup = state.onboarding, dialog = $('onboarding-dialog');
  if (!setup.open) { if (dialog.open) dialog.close(); return; }
  if (!dialog.open && setup.step === 0) {
    $('onboarding-domain').value = ''; $('onboarding-ip').value = '';
    $('onboarding-www').checked = true; $('onboarding-ssl').checked = false;
    $('onboarding-error').hidden = true;
  }
  $('onboarding-install-help').textContent = state.platform === 'darwin'
    ? 'Open the DMG and drag Dioptra into Applications. For a ZIP, unzip it and move Dioptra.app into Applications. Quit older copies before opening it. If macOS asks for permission to open the app, see Apple’s instructions below.'
    : state.platform === 'win32' ? 'Use the installer supplied with your Windows download, then open Dioptra from the Start menu. This setup screen does not install the app.'
    : 'For an AppImage download, make the file executable in its file properties, then open it. This setup screen does not install the app.';
  $('installation-help').hidden = state.platform !== 'darwin';
  $('onboarding-title').textContent = ['Install Dioptra', 'Your first domain', 'Ready to browse'][setup.step];
  document.querySelectorAll('.onboarding-steps li').forEach((item,index)=>{item.classList.toggle('current',index===setup.step);if(index===setup.step)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');});
  $('onboarding-install').hidden = setup.step !== 0; $('onboarding-domain-form').hidden = setup.step !== 1; $('onboarding-ready').hidden = setup.step !== 2;
  $('onboarding-back').hidden = setup.step !== 1; $('onboarding-skip').hidden = setup.step !== 1;
  $('onboarding-next').hidden = setup.step === 2; $('onboarding-next').textContent = setup.step === 0 ? 'Continue' : 'Save domain';
  $('onboarding-finish').hidden = setup.step !== 2; $('onboarding-finish').textContent = setup.url ? 'Open website' : 'Finish setup';
  $('onboarding-ready-message').textContent = setup.url ? `${setup.url} is mapped to your saved server. Open it to test the site. Certificate errors may still appear when SSL checks are on.` : 'You skipped the first domain. Add a rule from Domains whenever you are ready.';
  for (const id of ['onboarding-next','onboarding-skip','onboarding-finish','onboarding-back','onboarding-cancel']) $(id).disabled = onboardingBusy;
  const servers = JSON.stringify(state.servers);
  if (servers !== onboardingServers) { onboardingServers = servers; const blank=el('option','','Select a server…');blank.value='';$('onboarding-server').replaceChildren(blank,...state.servers.map(server=>{const option=el('option','',`${server.name} · ${server.ip}`);option.value=server.ip;return option;})); }
  $('onboarding-server-label').hidden = !state.servers.length;
  if (!dialog.open) dialog.showModal();
  if (onboardingStep !== setup.step) { onboardingStep = setup.step; $('onboarding-error').hidden=true; if(setup.step===1)$('onboarding-domain').focus();else if(setup.step===2)$('onboarding-finish').focus(); }
}
async function setupCommand(action,data) {
  if (onboardingBusy) return;
  onboardingBusy=true; $('onboarding-error').hidden=true; renderOnboarding();
  try {
    const result=await window.browser.command(action,data);
    if(!result.ok){$('onboarding-error').textContent=result.error;$('onboarding-error').hidden=false;}
    return result;
  } catch(error) { $('onboarding-error').textContent=error.message;$('onboarding-error').hidden=false; }
  finally { onboardingBusy=false; renderOnboarding(); }
}
function nextSetup(event) {
  event.preventDefault();
  return state.onboarding.step===0 ? setupCommand('onboarding-step',1) : setupCommand('onboarding-domain',{domain:$('onboarding-domain').value,ip:$('onboarding-ip').value,www:$('onboarding-www').checked,skipSSL:$('onboarding-ssl').checked});
}
$('open-onboarding').onclick=()=>command('onboarding-open');
$('onboarding-next').onclick=nextSetup; $('onboarding-domain-form').onsubmit=nextSetup;
$('onboarding-back').onclick=()=>setupCommand('onboarding-step',0);
$('onboarding-skip').onclick=()=>setupCommand('onboarding-domain',null);
$('onboarding-finish').onclick=()=>setupCommand('onboarding-finish');
$('onboarding-cancel').onclick=()=>setupCommand('onboarding-cancel');
$('onboarding-dialog').addEventListener('cancel',event=>{event.preventDefault();setupCommand('onboarding-cancel');});
$('installation-help').onclick=()=>command('installation-help');
$('onboarding-import').onclick=()=>$('onboarding-file').click();
$('onboarding-server').onchange=()=>{if($('onboarding-server').value)$('onboarding-ip').value=$('onboarding-server').value;};
$('onboarding-file').onchange=async()=>{
  const file=$('onboarding-file').files[0];$('onboarding-file').value='';if(!file)return;
  if(file.size>MAX_SERVER_CSV){$('onboarding-error').textContent='This file is too large for a server list.';$('onboarding-error').hidden=false;return;}
  const result=await setupCommand('import-servers',await file.text());
  if(result?.ok)$('onboarding-import-status').textContent=`${result.imported} servers imported${result.skipped ? ` · ${result.skipped} rows skipped` : ''}.`;
};
const bareIP = ip => String(ip || '').replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
// Any click in the window UI outside the button closes the certificate card; the button itself toggles it.
// Handled on the document and on pointerdown: the bar is rebuilt on every state update, so a button can be replaced between press and release and would then never get its click.
function toggleCard(button) { const r = button.getBoundingClientRect(); command('card', { kind: button.dataset.card, id: Number(button.dataset.tab) || 0, right: r.right, bottom: r.bottom }); }
document.addEventListener('pointerdown', event => { const button = event.button === 0 && event.target.closest?.('[data-card]'); if (button) toggleCard(button); else command('card-close'); }, true);
document.addEventListener('click', event => { const button = event.detail === 0 && event.target.closest?.('[data-card]'); if (button) toggleCard(button); });
// Site info is available even when the page exposes no platform metadata.
// A refused Live certificate: why, in plain words, then the ways on. Main decides what Continue anyway trusts.
function certReason(c) {
  const p = el('p', 'ssl-why'), name = el('b', '', c.subject || 'an unknown name');
  if (/COMMON_NAME/.test(c.error)) p.append('The live server sent a certificate for ', name, ', not for ', el('b', '', c.host), '.');
  else if (/DATE/.test(c.error)) p.append('The certificate for ', name, ' has expired or is not valid yet.');
  else if (/AUTHORITY/.test(c.error)) p.append('The certificate for ', name, ' is not signed by a trusted authority.');
  else p.append('The certificate for ', name, ' was refused.');
  p.append(' Dioptra cannot confirm this is the real server, so anyone in between could read or change this page.');
  return p;
}
function errorHelp(t, retry) {
  const actions = el('div', 'ssl-actions'); if (retry) actions.append(retry);
  if (/^https:/i.test(t.url)) { const http = el('button', '', 'Open via http'); http.onclick = async () => { await command('activate', t.id); command('navigate', t.url.replace(/^https:/i, 'http:')); }; actions.append(http); }
  if (!t.certBlocked) return actions.childElementCount ? [actions] : [];
  const go = el('button', 'ssl-continue', 'Continue anyway (unsafe)'); go.onclick = () => command('trust-certificate', t.id); actions.append(go);
  return [certReason(t.certBlocked), actions, el('p', 'ssl-note', `Continue trusts this one certificate for ${t.certBlocked.host} until you quit Dioptra. Live only, never for Claude or sign in services.`)];
}
function siteChip(t) {
  const button = el('button', 'site-btn'); button.type = 'button'; button.dataset.card = 'site'; button.dataset.tab = t.id;
  button.append(icon('info'), el('span', 'action-label', 'Site info'), icon('chevron'));
  button.setAttribute('aria-label', 'Site info'); button.setAttribute('aria-haspopup', 'dialog'); return button;
}
function dnsButton(t) {
  const button = el('button', 'dns-btn'); button.type = 'button'; button.append(icon('sliders'), el('span', 'action-label', 'DNS'));
  button.title = `DNS records of ${t.route.host}`; button.setAttribute('aria-label', `Show DNS records of ${t.route.host}`); button.setAttribute('aria-haspopup', 'dialog');
  button.dataset.card = 'dns'; button.dataset.tab = t.id; return button;
}
let compareWith = null, compareWithError = '', compareWithClosed = false;
function closeCompareWith() { compareWith = null; compareWithError = ''; compareWithClosed = true; renderWorkspace(); }
async function submitCompareWith(value) {
  let result; try { result = await window.browser.command('compare-with', value); } catch (error) { result = { ok: false, error: error.message }; }
  if (result.ok) return closeCompareWith();
  compareWithError = result.error || 'That address could not be opened.'; renderWorkspace();
}
function compareWithBar(t) {
  const form = el('form', 'inline-compare-form'), label = el('label', '', 'Compare with'), input = el('input', ''), go = el('button', 'with-go', 'Go');
  label.htmlFor = input.id = 'compare-with'; input.value = compareWith ?? (t.startPage ? '' : t.url); input.placeholder = 'https://'; input.spellcheck = false; input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Compare with URL'); input.title = 'Click to edit or paste another URL';
  input.onclick = () => { if (compareWith === null) input.select(); }; input.oninput = () => { compareWith = input.value; };
  input.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); closeCompareWith(); } };
  form.onsubmit = event => { event.preventDefault(); submitCompareWith(input.value); };
  form.append(label, input);
  if (compareWithError) { const error = el('span', 'with-error', compareWithError); error.id = 'compare-with-error'; error.setAttribute('role', 'alert'); input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', error.id); input.title = compareWithError; form.append(error); }
  const same = el('button', '', 'Same URL'); same.type = 'button'; same.title = 'Back to the same URL as the left pane'; same.onclick = () => submitCompareWith(null); form.append(go, same); return form;
}
function routeBar(t, { pane = false, selected = false, other } = {}) {
  const label = t.route.label === 'HOSTFILE' ? 'New server' : 'Live', cached = Boolean(t.connection?.fromCache);
  const bar = el('div', `route-bar ${t.route.label.toLowerCase()}${selected ? ' active' : ''}${cached ? ' cached' : ''}`);
  const identity = el('div', 'route-identity'), badge = el(pane ? 'button' : 'span', 'badge', label);
  if (pane) { badge.type='button'; badge.setAttribute('aria-pressed', String(selected)); badge.setAttribute('aria-label', `${label} pane${t.route.host ? ` for ${t.route.host}` : ''}${selected ? ', selected' : ''}`); badge.onclick = () => command('activate', t.id); }
  identity.append(badge);
  if (t.route.untrusted) { const chip = el('button', 'route-untrusted', 'Not trusted'); chip.type = 'button'; chip.dataset.card = 'site'; chip.dataset.tab = t.id; chip.title = 'You chose Continue anyway for this certificate. Click for details.'; chip.setAttribute('aria-haspopup', 'dialog'); identity.append(chip); }
  if (cached) { const cache = el('button', 'route-cache', 'Cached'); cache.type='button'; cache.dataset.card='cache'; cache.dataset.tab=t.id; cache.setAttribute('aria-haspopup','dialog'); identity.append(cache); }
  identity.append(...addonChips(t, !$('view-differences').disabled), ...filesChips(t, !$('view-differences').disabled), ...noindexChip(t, !$('view-differences').disabled));
  const ips = !cached && !t.error && !t.loading ? bareIP(t.connection?.ip) : '';
  const measured = t.startPage ? 'Ready to browse' : t.loading ? 'Connecting…' : ips || (cached ? 'IP · Not measured' : 'Not measured');
  identity.append(el('span', 'route-ip', measured));
  // Each pane shows its own size when it is not 100 %, so it is clear that both panes are zoomed alike.
  if (pane && Math.round((t.zoom || 1) * 100) !== 100) { const zoom = el('span', 'route-zoom', `${Math.round(t.zoom * 100)}%`); zoom.title = `This pane is zoomed to ${zoom.textContent}`; identity.append(zoom); }
  if (ips && t.connection?.hostname) { const ptr=el('span','ptr',t.connection.hostname);ptr.title=`Reverse DNS (PTR) of ${ips}: ${ptr.textContent}`;identity.append(ptr); }
  bar.append(identity);
  if (other !== undefined) bar.append(compareWithBar(t));
  const actions = el('span', 'route-right'); if (t.route.dns) actions.append(dnsButton(t)); actions.append(siteChip(t));
  bar.append(actions); bar.title = `${label} · ${t.route.host || 'New tab'}${t.route.configured ? ` · Rule ${t.route.configured}` : ''} · ${measured}`;
  return bar;
}
function renderRouteBar(tab, view) {
  const bar = $('route-bar'); bar.replaceChildren(); bar.className = 'route-bar';
  if (!tab) return;
  bar.hidden = view === 'compare' && state.routeBarHeight === 0;
  if (view === 'compare') { bar.classList.add('idle'); bar.append(el('span', 'route-domain', 'Comparing Hostfile and Live')); return; }
  const next = routeBar(tab); bar.className = next.className; bar.title = next.title; bar.append(...next.childNodes);
}
let diffPart = 'overview', diffKey = '', diffFocus = false, diffScope = 'page', siteChoose = false, siteShowRest = false, siteListDraft = '', siteAffectedOpen = false;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Red: files that fail only on this side. Orange: they fail on the other server too, so not a migration difference.
function filesChips(t, clickable) {
  const f = t.files, chips = [];
  if (!f || t.startPage) return chips;
  const hostfile = t.mode === 'hostfile', other = hostfile ? 'Live' : 'the new server';
  const chip = (text, both, title) => {
    const c = el(clickable ? 'button' : 'span', `route-failed${both ? ' both' : ''}`, text);
    if (clickable) { c.type = 'button'; c.dataset.files = String(t.id); }
    c.title = clickable ? `${title} Click to see the files.` : title; c.setAttribute('aria-label', c.title); return c;
  };
  if (f.failed) chips.push(chip(`${plural(f.failed, 'file')} failed`, false, !f.compared
    ? `${plural(f.failed, 'file')} did not load here.${hostfile && t.route.configured ? ' Open Compare to check them on Live.' : ''}`
    : `${plural(f.failed, 'file')} failed only on this server.${f.both ? ` ${f.both} more ${f.both === 1 ? 'fails' : 'fail'} on both servers.` : ''}`));
  else if (f.both) chips.push(chip(`${plural(f.both, 'file')} failed`, true, f.both === 1
    ? `1 file did not load here. It fails on ${other} too, so it is not a migration difference.`
    : `${f.both} files did not load here. They fail on ${other} too, so they are not a migration difference.`));
  if (f.old && hostfile) chips.push(chip(`${f.old} from old server`, false, `${plural(f.old, 'file')} on this page came from the old server: ${f.oldHosts.join(', ')} ${f.oldHosts.length === 1 ? 'has' : 'have'} no domain rule.`));
  return chips;
}
// Red: an add-on found a threat on this page. Orange: an add-on that is not about threats found a problem. With a rule the label opens the add-on's tab in Differences, else a card.
function addonChips(t, clickable) {
  return (t.chips || []).map(chip => {
    const c = el('button', `route-failed route-addon${chip.tone === 'warn' ? ' both' : ''}`); c.type = 'button'; c.append(icon('alert'), chip.text);
    if (chip.differences && clickable) c.dataset.addonTab = chip.id; else { c.dataset.card = 'addon'; c.dataset.tab = t.id; c.setAttribute('aria-haspopup', 'dialog'); }
    c.title = `${chip.title} Click to see what was found.`; c.setAttribute('aria-label', c.title); return c;
  });
}
// Red: the new server tells search engines not to index the page. Orange: Live says so too, so not a migration difference.
function noindexChip(t, clickable) {
  if (!t.noindex || t.startPage) return [];
  const c = el(clickable ? 'button' : 'span', `route-failed route-noindex${t.noindex === 'both' ? ' both' : ''}`, 'Noindex');
  const title = t.noindex === 'both' ? 'Both servers tell search engines not to index this page, so it is not a migration difference.' : 'The new server tells search engines not to index this page.';
  if (clickable) { c.type = 'button'; c.dataset.checks = String(t.id); }
  c.title = clickable ? `${title} Click to see the checks.` : title; c.setAttribute('aria-label', c.title); return [c];
}
function pill(text, red) { return el('span', `pill ${red ? 'red' : 'gray'}`, text); }
function diffState(box, node) { box.replaceChildren(node); }
function renderDifferences(tab, view) {
  const box = $('differences'); box.hidden = view !== 'differences';
  if (box.hidden) { diffKey = ''; return; }
  const d = state.differences || { status: 'idle' }, r = d.report;
  const nl = d.liveReason || null; // Live could not be reached: nothing below compares with an empty Live
  // The whole-site result of this tab, if there is one; without it there is only the page.
  const site = state.site || null, inSite = diffScope === 'site' && Boolean(site);
  if (!site) { diffScope = 'page'; siteChoose = false; siteListDraft = ''; }
  const key = JSON.stringify([d.status, d.error, r?.comparedAt, r?.url, diffPart, state.tabs.find(t => t.id === state.activeId)?.route.label, state.files, pageTabsKey(), nl && [nl.text, nl.detail, nl.checkedAt], d.liveRetry, diffScope, siteChoose, siteShowRest, site]);
  // Nothing to draw: a focus that was asked for (the open part was clicked again) must not wait for a later, unrelated redraw.
  if (key === diffKey) { diffFocus = false; return; }
  diffKey = key;
  if (d.status === 'running' || (d.status === 'idle' && !r)) { const n = el('div', 'dstate'); n.append(el('div', 'spinner'), el('h2', '', 'Comparing both servers'), el('p', '', 'Fetching the page from the Hostfile server and from Live.')); return diffState(box, n); }
  if (d.status === 'error' || !r) { const n = el('div', 'dstate'); n.append(el('h2', '', 'Comparison failed'), el('code', '', d.error || 'No report available.')); const again = el('button', 'primary', 'Try again'); again.onclick = () => command('differences-run'); n.append(again); return diffState(box, n); }
  let host = ''; try { host = new URL(r.url).hostname; } catch {}
  const main = el('div', 'diff-main'), head = el('div', 'dhead'), vs = el('div', 'dvs');
  const badgeHF = el('span', 'badge', 'HOSTFILE'), badgeLive = el('span', 'badge', 'LIVE'); const hfWrap = el('span', 'hostfile'), liveWrap = el('span', 'live'); hfWrap.append(badgeHF); liveWrap.append(badgeLive);
  const compared = `compared ${new Date(r.comparedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, liveText = el('span', '');
  if (nl) { const chip = el('span', 'nl-chip', nl.short); chip.title = nl.text; liveText.append(chip, `· ${compared}`); } else liveText.textContent = `${r.live?.ip || 'n/a'} · ${compared}`;
  vs.append(hfWrap, el('span', '', r.hostfile?.ip || 'n/a'), el('span', '', 'vs'), liveWrap, liveText);
  // Compare again: in Whole site the same list of pages once more, else this page.
  const again = el('button', 'btn'); again.append(icon('reload'), 'Compare again'); again.onclick = () => (inSite ? command('site-run', { again: true }) : command('differences-run'));
  const ask = el('button', 'primary ask'), img = document.createElement('img'); img.src = 'brand/claude.png'; img.alt = ''; ask.append(img, 'Ask Claude');
  ask.title = 'Sends the comparison of this page to the Claude panel. Claude keeps working as it does now.';
  ask.onclick = async () => { const result = await command('differences-ask-claude'); if (result.ok && result.notice) toast(result.notice); };
  const acts = el('div', 'dacts'); acts.append(ask, again); head.append(el('h2', '', host || r.url), vs, acts);
  // The menu on the right picks what the main area shows: the Overview or one part. A part that is gone (its add-on was removed) falls back to the Overview.
  const model = diffParts(state), parts = inSite ? siteParts(site, model) : model.parts, current = parts.find(p => p.id === diffPart), shown = model.parts.find(p => p.id === diffPart);
  if (!current || !shown) diffPart = 'overview';
  const open = id => { diffPart = id; diffFocus = true; renderDifferences(tab, currentView()); $('canvas').scrollTop = 0; };
  main.append(head, scopeRow(site, r, tab), ...(current && shown ? partPage(shown, r, nl, open, inSite ? current : null) : inSite ? siteOverview(site, parts, open) : overviewPage(model, nl, open)));
  // Drawing again replaces every button: the focus goes back to the row it was on, or to the row of the part just opened.
  const active = box.contains(document.activeElement) ? document.activeElement : null, where = diffFocus || active?.closest('.diff-menu') ? '.diff-menu' : '.diff-main', keep = diffFocus ? diffPart : active?.closest('[data-part]')?.dataset.part;
  // The same for what a whole-site run redraws under the user's hands (after every page): Cancel, Show all, a page
  // row, the chooser. data-keep names them; the list keeps what was typed and where the cursor was.
  const held = !keep && active ? active.closest('[data-keep]') : null, heldId = held?.dataset.keep, caret = held?.tagName === 'TEXTAREA' ? [held.selectionStart, held.selectionEnd] : null;
  box.replaceChildren(main, diffMenu(parts, nl, open, inSite ? site : null));
  if (keep) { const at = [...box.querySelectorAll(`${where} [data-part]`)].find(n => n.dataset.part === keep); (at?.matches('button') ? at : at?.querySelector('.ov-open'))?.focus(); }
  else if (heldId) { const at = [...box.querySelectorAll('[data-keep]')].find(n => n.dataset.keep === heldId); if (at) { at.focus({ preventScroll: true }); if (caret && at.tagName === 'TEXTAREA') at.setSelectionRange(caret[0], caret[1]); } }
  diffFocus = false;
}
// The tag is cut off when an add-on brings long words; the whole text is in its tooltip.
const stateTag = p => { const t = el('span', `stag is-${p.state}`, p.tag); t.title = p.tag; return t; }; // "is-": .check is the class of the checkboxes
// ponytail: icon and colour of the add-ons that exist today, keyed by id; the upgrade path is an icon field in the add-on manifest.
// Per add-on: ink, light tile and border (Differences), then the light and dark end of the filled logo in Settings.
const ADDON_LOOK = { 'malware-scan': ['#6938ef', '#f1edfe', '#d9d0fb', '#8f73f8', '#5a2fd9'], 'seo-check': ['#175cd3', '#e8f1fd', '#c5dbf8', '#4ea6fb', '#175cd3'], 'wp-leak-check': ['#0e7090', '#e3f5f9', '#b9e2ec', '#27bcd9', '#0b6680'] };
function partTile(p) {
  // Object.hasOwn: an add-on may be called "constructor".
  const t = el('span', 'ptile'), look = p.addon && Object.hasOwn(ADDON_LOOK, p.addon) ? ADDON_LOOK[p.addon] : null;
  t.append(icon(p.addon ? (look ? p.addon : 'puzzle') : p.id)); t.firstChild.setAttribute('aria-hidden', 'true');
  if (look) [t.style.color, t.style.background, t.style.borderColor] = look;
  return t;
}
// site: the whole-site result when the menu shows the site; each row then says where the part was found.
function diffMenu(parts, nl, open, site) {
  const side = el('div', 'diff-menu'), stick = el('div', 'dm-stick'), head = el('div', 'dm-head'), tags = el('div', 'dm-tags'), list = el('nav', 'dm-list');
  const n = s => parts.filter(p => p.state === s).length;
  head.append(el('h2', '', site ? 'Whole site' : 'Differences'), el('p', '', site ? `${plural(site.compared, 'page')} compared${site.solo ? ', the new server on its own' : ' on both servers'}` : nl ? `${plural(parts.length, 'part')}, the new server on its own` : `${plural(parts.length, 'part')} compared on both servers`));
  tags.append(el('span', 'stag is-fix', `${n('fix')} to fix`), el('span', 'stag is-check', `${n('check')} to check`), el('span', 'stag is-info', `${n('info')} to read`));
  list.setAttribute('aria-label', 'Parts of the comparison');
  const row = (p, tag) => {
    const b = el('button', 'dm-row'), grow = el('span', 'settings-grow'), c = el('span', 'chevron', '›');
    b.type = 'button'; b.dataset.part = p.id; if (diffPart === p.id) b.setAttribute('aria-current', 'true'); b.onclick = () => open(p.id);
    grow.append(el('strong', '', p.name), el('small', '', site && p.where ? p.where : p.what)); c.setAttribute('aria-hidden', 'true'); b.append(partTile(p), grow, ...(tag ? [tag] : []), c); return b;
  };
  list.append(row({ id: 'overview', name: 'Overview', what: 'The verdict and the worst points' }));
  for (const group of new Set(parts.map(p => p.group))) { list.append(el('span', 'lbl', group)); for (const p of parts.filter(x => x.group === group)) list.append(row(p, stateTag(p))); }
  stick.append(head, tags, list); side.append(stick); return side;
}
// One part in a list of the Overview. The card is a container: its name is the button (a short name for a screen
// reader), a click anywhere on the card opens the part as well.
function partCard(p, withTops, open, small) {
  const card = el('div', 'ov-part'), top = el('div', 'ov-head'), grow = el('span', 'settings-grow'), name = el('strong', ''), go = el('button', 'ov-open', p.name), line = el('small', '', small), c = el('span', 'chevron', '›');
  go.type = 'button'; go.setAttribute('aria-label', `${p.name}: ${p.tag}. Open this part`); card.dataset.part = p.id; card.onclick = () => open(p.id); line.title = small; c.setAttribute('aria-hidden', 'true');
  name.append(go); if (p.addon) name.append(' ', el('span', 'atag', 'Add-on'));
  grow.append(name, line); top.append(partTile(p), grow, stateTag(p), c); card.append(top);
  // A point that only needs a look keeps its amber dot inside a part that needs a fix.
  if (withTops && p.tops.length) { const ul = el('ul', `ov-tops is-${p.state}`); p.tops.forEach((t, i) => ul.append(el('li', p.all?.[i]?.state === 'check' ? 'is-check' : '', t))); if (p.more) ul.append(el('li', 'rest', `and ${p.more} more`)); card.append(ul); }
  return card;
}
const verdictBox = v => {
  const box = el('div', `box sv dverdict${v.tone ? ` ${v.tone}` : ''}`), text = el('div', '');
  text.append(el('div', 'sv-title', v.title), el('div', 'sv-fx', v.text)); for (const note of v.notes || []) text.append(el('div', 'sv-lim', note)); box.append(text); return box;
};
const stepList = (title, hint, parts, withTops, open, small = p => p.line) => {
  const h = el('div', 'dstep'), grid = el('div', `dcard ov-grid${withTops ? '' : ' c3'}`); h.append(el('b', '', title), el('span', 'lbl', hint));
  for (const p of parts) grid.append(partCard(p, withTops, open, small(p)));
  return [h, grid];
};
// Overview: sorted by what to do, not by where it comes from. A step without parts is not shown. A part without a
// result is not "nothing to do": it has its own last step, with why and how to run it again.
function overviewPage(model, nl, open) {
  const out = [verdictBox(diffVerdict(model))], waits = p => p.busy || p.missing;
  for (const [title, hint, parts, withTops] of [['Fix before the switch', 'these break the site or put it at risk', model.parts.filter(p => p.state === 'fix'), true], ['Look at once', nl ? 'may be fine, worth a look' : 'may be fine, but different from Live', model.parts.filter(p => p.state === 'check'), true],
    ['Nothing to do', 'shown so you can look it up', model.parts.filter(p => ['info', 'ok', 'none'].includes(p.state) && !waits(p)), false], ['No result yet', 'not measured, still running or failed', model.parts.filter(waits), true]]) if (parts.length) out.push(...stepList(title, hint, parts, withTops, open));
  return out;
}
/* Whole site (1.4.0-beta.4): one level above the page. Main compares the pages and folds them (site-scope.cjs); this draws it. */
// The parts for the site, in menu order. Files and Speed need a real page load: they are the ones of the open page.
function siteParts(site, model) {
  // onPage: measured in the real load of the open page, not on every page of the run.
  const here = id => { const p = model.parts.find(x => x.id === id); return p && { ...p, where: 'Measured on the page you opened', onPage: true }; };
  return ['domains', 'files', 'html', 'headers', 'speed', 'checks'].map(id => (id === 'files' || id === 'speed' ? here(id) : site.parts.find(p => p.id === id))).concat(site.parts.filter(p => p.addon)).filter(Boolean);
}
const siteTime = ms => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.max(1, Math.round(ms / 1000))} s`);
// Never green without pages, without the home page (the checks for the whole site and the add-ons that scan once run
// there), with a part that has no result, or after a run that stopped.
function siteVerdict(site, parts) {
  const n = site.compared, fix = parts.filter(p => p.wideState === 'fix'), check = parts.filter(p => p.wideState === 'check'), here = parts.filter(p => p.onPage && p.state === 'fix'), ownFix = site.own.filter(p => p.state === 'fix').length, missing = parts.filter(p => p.missing);
  const pages = `${ownFix} of ${plural(n, 'page')} ${ownFix === 1 ? 'has' : 'have'} a problem of ${ownFix === 1 ? 'its' : 'their'} own`, names = list => list.map(p => p.name).join(', ');
  if (site.status === 'listing') return { tone: '', title: 'Looking for the pages of this site', text: 'Reading the sitemap of the site.' };
  if (site.status === 'running') return { tone: '', title: `Comparing ${Math.min(site.total, site.done + 1)} of ${plural(site.total, 'page')}`, text: `Two pages at a time, so the servers are not loaded. ${site.done ? `What ${plural(site.done, 'page')} said so far is below.` : ''}` };
  if (site.status === 'nolist') return { tone: '', title: site.source ? 'No pages to compare' : 'No sitemap found', text: site.error };
  if (site.status === 'error') return { tone: '', title: 'The run stopped', text: site.error, notes: n ? [`What ${plural(n, 'page')} said is below. It is not the whole site.`] : [] };
  if (site.status === 'cancelled' && !site.total) return { tone: '', title: 'Stopped before the page list was read', text: 'Nothing was compared. Compare again starts over.' };
  if (site.status === 'cancelled') return { tone: '', title: `Stopped after ${n} of ${plural(site.total, 'page')}`, text: `${n ? `What ${n === 1 ? 'that page' : `those ${n} pages`} said is below. ` : ''}Compare again runs all pages.` };
  if (!n) return { tone: '', title: 'No page was compared', text: 'Every page of the list was skipped or could not be fetched, so there is no result for this site.' };
  const home = site.homeSkipped ? ' The home page was skipped, so the checks for the whole site and the add-ons that scan once did not run.' : '', left = `${missing.length ? ` No result for: ${names(missing)}.` : ''}${home}`;
  if (fix.length || ownFix || here.length) return { tone: 'worse', title: 'Not ready for the switch', text: `${fix.length ? `${plural(fix.length, 'part')} ${fix.length === 1 ? 'needs' : 'need'} a fix for the whole site` : 'Nothing to fix for the whole site'}${ownFix ? `, and ${pages}` : ''}.${here.length ? ` On the page you opened: ${names(here)}.` : ''}${left}` };
  if (missing.length || site.homeSkipped) return { tone: '', title: 'The result is incomplete', text: `${left.trim()} Nothing to fix in what was compared.` };
  return { tone: 'better', title: 'Nothing to fix before the switch', text: `${plural(n, 'page')} compared. ${check.length ? `Worth a look once: ${names(check)}.` : 'Every part is fine.'}${site.own.length ? ` ${plural(site.own.length, 'page')} to look at below.` : ''}` };
}
function siteOverview(site, parts, open) {
  const box = verdictBox(siteVerdict(site, parts)), out = [box], busy = site.status === 'listing' || site.status === 'running';
  if (busy) { const stop = fbtn(site.stopping ? 'Stopping…' : 'Cancel', 'stop', 'Stop comparing. What was compared stays.', () => command('site-cancel')); stop.disabled = Boolean(site.stopping); stop.dataset.keep = 'cancel'; const meta = el('div', 'sv-meta'); meta.append(stop); box.append(meta); }
  if (site.status === 'nolist' || !site.compared) return out;
  // In the steps for the site a part shows what is site-wide; its menu row shows the worst of everything.
  const forSite = p => ({ ...p, state: p.wideState, tag: p.wideTag, where: p.wideWhere });
  for (const [title, hint, list, small] of [['Fix once for the whole site', 'the same on every page, so one fix counts for all', parts.filter(p => p.wideState === 'fix').map(forSite), p => `${p.where} · ${p.line}`],
    ['Look at once', site.solo ? 'may be fine, worth a look' : 'may be fine, but different from Live', parts.filter(p => p.wideState === 'check').map(forSite), p => `${p.where} · ${p.line}`],
    ['On the page you opened', 'files and speed need a real page load, so they are measured there only', parts.filter(p => p.onPage && ['fix', 'check'].includes(p.state)), p => p.line],
    ['No result yet', 'not measured, still running or failed', parts.filter(p => p.busy || p.missing), p => p.line]]) if (list.length) out.push(...stepList(title, hint, list, true, open, small));
  const h = el('div', 'dstep'), pages = el('div', 'dcard ov-pages'), all = site.own.length + site.rest.length;
  h.append(el('b', '', 'Pages with a problem of their own'), el('span', 'lbl', `${site.own.length} of ${plural(all, 'page')}`));
  const row = p => {
    const b = el('button', 'ov-page'), name = el('span', ''), why = el('span', 'why', p.text), c = el('span', 'chevron', '›');
    b.type = 'button'; b.dataset.page = p.path; b.dataset.keep = `page:${p.path}`; b.title = `Open ${p.path} and compare it on its own`; name.append(el('strong', '', p.path), el('small', '', p.title)); why.title = p.text; c.setAttribute('aria-hidden', 'true');
    b.append(name, why); if (p.tag) { const t = stateTag(p); t.classList.add('ptag'); b.append(t); } b.append(c);
    b.onclick = async () => { if ((await command('site-open', p.url)).ok) { diffScope = 'page'; diffPart = 'overview'; diffKey = ''; $('canvas').scrollTop = 0; } };
    return b;
  };
  for (const p of site.own) pages.append(row(p));
  if (site.rest.length) {
    const more = el('button', 'ov-rest'); more.type = 'button'; more.dataset.keep = 'rest'; more.setAttribute('aria-expanded', String(siteShowRest));
    more.append(el('span', '', site.rest.length === 1 ? '1 page has nothing of its own' : `${site.rest.length} pages have nothing of their own`), el('span', 'act', siteShowRest ? 'Hide' : 'Show all'));
    more.onclick = () => { siteShowRest = !siteShowRest; diffKey = ''; renderDifferences(state.tabs.find(t => t.id === state.activeId), currentView()); };
    pages.append(more); if (siteShowRest) for (const p of site.rest) pages.append(row(p));
  }
  if (site.own.length || site.rest.length) out.push(h, pages);
  return out;
}
// Under the header: This page or Whole site, and what belongs to that choice (where the pages came from, the way back).
function scopeRow(site, r, tab) {
  const row = el('div', 'dscope-row'), seg = el('div', 'dscope'), inSite = diffScope === 'site' && Boolean(site), redraw = () => { diffKey = ''; renderDifferences(tab, currentView()); };
  seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'What to compare');
  const pick = (id, label, go) => { const b = el('button', '', label); b.type = 'button'; b.dataset.scope = id; b.dataset.keep = `scope:${id}`; b.setAttribute('aria-pressed', String((id === 'site') === inSite)); b.onclick = go; seg.append(b); };
  pick('page', 'This page', () => { diffScope = 'page'; diffPart = 'overview'; redraw(); });
  pick('site', site?.total ? `Whole site · ${site.total}` : 'Whole site', async () => { if (!site && !(await command('site-run', {})).ok) return; diffScope = 'site'; diffPart = 'overview'; redraw(); });
  row.append(seg);
  if (inSite) {
    const from = site.status === 'listing' ? 'looking for the sitemap' : site.status === 'nolist' ? (site.source ? `nothing to compare in ${site.source}` : 'no sitemap') : `${plural(site.total, 'page')} from ${site.source}${site.running ? '' : ` · took ${siteTime(site.tookMs)}`}`;
    const choose = el('button', 'dlink', 'Choose pages'); choose.type = 'button'; choose.dataset.keep = 'choose'; choose.setAttribute('aria-expanded', String(siteChoose)); choose.onclick = () => { siteChoose = !siteChoose; redraw(); };
    row.append(el('span', 'lbl', from), choose);
    for (const note of site.notes || []) row.append(el('span', 'lbl dnote', note));
    if (siteChoose || site.status === 'nolist') row.append(siteChooser(site, redraw));
  } else if (site) {
    const back = el('button', 'dlink', `← Whole site, ${plural(site.total, 'page')}`); back.type = 'button'; back.dataset.keep = 'back'; back.onclick = () => { diffScope = 'site'; diffPart = 'overview'; redraw(); };
    let path = ''; try { const u = new URL(r.url); path = decodeURI(u.pathname) + u.search; } catch {}
    row.append(back, el('span', 'badge', path));
  }
  return row;
}
// Choose pages: a number of pages from the sitemap, or a list of addresses of this site. The view is drawn again after
// every page of a run: what was typed lives in siteListDraft, so it is still there.
function siteChooser(site, redraw) {
  const box = el('div', 'dchoose'), counts = el('div', 'dchoose-row'), own = el('div', 'dchoose-row'), list = el('textarea', ''), go = fbtn('Compare these pages', 'reload', '', null);
  const start = async data => { if ((await command('site-run', data)).ok) { siteChoose = false; redraw(); } };
  counts.append(el('span', '', 'From the sitemap:'));
  for (const n of site.choices) { const b = fbtn(`${n} pages`, '', `Compare the first ${n} pages of the sitemap`, () => start({ limit: n })); b.dataset.keep = `count:${n}`; if (n === site.wanted && site.source !== 'your list') b.setAttribute('aria-pressed', 'true'); counts.append(b); }
  list.rows = 4; list.spellcheck = false; list.placeholder = '/contact/\n/shop/cakes/'; list.dataset.keep = 'list'; list.value = siteListDraft; list.oninput = () => { siteListDraft = list.value; };
  list.setAttribute('aria-label', `Your own list of addresses of this site, one per line, at most ${site.max}`);
  go.dataset.keep = 'go'; go.onclick = () => (list.value.trim() ? start({ list: list.value }) : list.focus());
  own.append(el('span', '', `Or your own list, one address per line, at most ${site.max}:`), list, go);
  box.append(counts, own); return box;
}
// Which pages a part of the site was found on: every finding with its pages, so what is said once can still be traced.
function affectedPages(part) {
  const d = document.createElement('details'), sum = document.createElement('summary'), list = el('ul', '');
  d.className = 'daffected'; d.open = siteAffectedOpen; d.ontoggle = () => { siteAffectedOpen = d.open; };
  sum.dataset.keep = 'affected'; sum.textContent = `Affected pages, per finding (${part.found.length})`;
  for (const f of part.found) {
    const li = el('li', `is-${f.state}`), where = f.once ? 'asked once for the site' : f.pages.join('  ');
    li.append(el('b', '', f.text || (f.state === 'info' ? `${part.name} differs` : part.name)), el('span', f.once ? 'once' : 'm', where)); list.append(li);
  }
  d.append(sum, list); return d;
}
// One part: its head and below it the panel of that part. inSite: the part as the whole site has it; the panel below
// is the one of the page that is open, and the note says so.
function partPage(p, r, nl, open, inSite) {
  const back = el('button', 'dback', '← Overview'), card = el('div', 'dcard'), ch = el('div', 'dch'), scroll = el('div', `dscroll ${p.addon ? 'checks' : p.id}`);
  back.type = 'button'; back.onclick = () => open('overview');
  ch.append(partTile(p), el('b', '', p.name)); if (p.addon) ch.append(el('span', 'atag', 'Add-on'));
  ch.append(el('span', 'lbl', p.what), stateTag(inSite || p), el('span', 'lbl', p.addon ? (p.by ? `by ${p.by}` : 'add-on') : 'built in'));
  if (p.id === 'files') {
    const reload = el('button', 'fbtn'); reload.type = 'button'; reload.append(icon('reload'), 'Reload both'); reload.title = 'Reload Hostfile and Live without the cache and measure again';
    reload.onclick = () => command('files-reload');
    const copy = el('button', 'fbtn'); copy.type = 'button'; copy.append(icon('copy'), 'Copy list'); copy.title = 'Copy this list as plain text, for a ticket';
    copy.onclick = async () => { const result = await command('files-copy'); if (result.ok && result.notice) toast(result.notice); };
    ch.append(reload, copy);
  }
  const notCompared = () => el('p', 'dempty', 'Not compared: Live has no page.'), chain = side => (r[side]?.redirects || []).map(x => x.location).join(' > ') || 'none';
  // Status and redirects are not headers, but they are what the server sends with the page: they lead the table when they differ.
  const sent = !r.hostfile?.ok || !r.live?.ok ? [] : [r.hostfile.status !== r.live.status && { name: 'HTTP status', hostfile: String(r.hostfile.status), live: String(r.live.status) }, chain('hostfile') !== chain('live') && { name: 'Redirects', hostfile: chain('hostfile'), live: chain('live') }].filter(Boolean);
  scroll.append(p.addon ? addonPanel(state.addonTabs.find(a => a.id === p.addon)) : p.id === 'domains' ? domainTable(r.domains || [], nl) : p.id === 'files' ? filesPanel(state.files) : p.id === 'speed' ? speedPanel(state.speed) : p.id === 'checks' ? checksPanel(state.checks) : nl ? notCompared() : p.id === 'html' ? htmlLines(r.html?.hunks || r.html?.lines || []) : headerTable([...sent, ...(r.headers || [])]));
  card.append(ch);
  // What was not read cannot be in the table below: said above it.
  if (p.id === 'domains') for (const point of p.all.filter(x => / page was not read to the end: /.test(x.text))) card.append(el('div', 'dnote-line dunread', `${point.text}. What comes after that is not in this list.`));
  if (p.id === 'domains') for (const point of p.all.filter(x => / found only on (Hostfile|Live), inside text that a browser may still /.test(x.text))) card.append(el('div', 'dnote-line dunread', `${point.text}. It is not in this list.`));
  if (inSite) {
    let path = ''; try { path = decodeURI(new URL(r.url).pathname); } catch {}
    card.append(el('div', 'dnote-line', `${inSite.where}. Shown here as found on the page that is open (${path}); a page that differs is listed under its own name.`));
    if (inSite.found?.length) card.append(affectedPages(inSite));
  }
  card.append(scroll); return [back, card];
}
function fileCell(row) {
  // Name and Open share one line; a long name is cut off, Open stays visible.
  const c = el('span', 'fname'), head = el('span', 'fhead'); c.title = row.url; head.append(el('span', 'fn', row.name));
  if (row.canOpen) {
    const open = el('button', 'fopen'); open.type = 'button'; open.append(icon('open'), 'Open'); open.title = `Open ${row.url} in a new tab through the new server`;
    open.setAttribute('aria-label', `Open ${row.name} in a new tab`); open.onclick = () => command('new-tab', row.url); head.append(open);
  }
  c.append(head, el('span', 'fpath', row.path)); return c;
}
function fileStatus(s, side) { const n = el('span', `fstat${s.failed ? (side === 'both' ? ' both' : ' bad') : ''}`, s.status); if (s.why) n.append(el('span', 'fwhy', s.why)); return n; }
function oldServerSection(f) {
  const sec = el('div', 'fsec');
  f.old.forEach((g, i) => {
    const head = el('div', 'frule'), text = el('div', ''), one = g.files.length === 1;
    if (!i) text.append(el('h4', '', 'Loaded from the old server'));
    text.append(el('p', '', `${g.host} has no domain rule, so the new server pane fetched ${one ? 'this file' : 'these files'} from ${g.ip}${g.ptr ? ` (${g.ptr})` : ''}. ${one ? 'It breaks' : 'They break'} when the old server goes away.`));
    head.append(text);
    if (f.ruleIP) {
      const add = el('button', 'fbtn', `Add rule: ${g.host} → ${f.ruleIP}`); add.type = 'button'; add.title = `Send ${g.host} to the new server as well`;
      add.onclick = async () => { add.disabled = true; const result = await command('files-add-rule', g.host); if (result.ok && result.notice) toast(result.notice); else add.disabled = false; };
      head.append(add);
    }
    sec.append(head);
  });
  const rows = f.old.flatMap(g => g.files.map(file => [fileCell({ ...file, canOpen: false }), file.type, el('span', 'fstat bad', `${file.ip}${file.ptr ? ` · ${file.ptr}` : ''}`), pill('Old server', true)]));
  sec.append(table(['File', 'Loaded as', 'Served by', ''], rows, rows.map(() => true)));
  return sec;
}
// The Files tab of Differences: what failed per server, what came from the old server, JavaScript errors only on Hostfile.
function filesPanel(f) {
  const wrap = el('div', '');
  if (!f) { wrap.append(el('p', 'dempty', 'Open a website in a Hostfile tab with a domain rule to measure its files.')); return wrap; }
  if (!f.measured && f.alone?.length) {
    // Live was not loaded for this page: what failed on the new server while the tab loaded it.
    wrap.append(el('p', 'fnote', 'Failed on the new server while this tab loaded the page. Open Compare to check them on Live: a file that fails there too is not a migration difference.'));
    wrap.append(table(['File', 'Loaded as', 'Hostfile'], f.alone.map(row => [fileCell(row), row.type, fileStatus(row.hostfile, 'both')])));
  } else if (!f.measured) wrap.append(el('p', 'dempty', f.measuring ? 'The page is loading…' : 'Every file loaded on the new server. Open Compare to measure Live as well.'));
  else if (!f.rows.length) wrap.append(el('p', 'dempty', f.measuring ? 'Measuring both servers…' : 'Every file loaded on both servers.'));
  else {
    const pills = { hostfile: () => pill('Only Hostfile', true), both: () => { const p = pill('On both'); p.classList.add('both'); return p; }, live: () => pill('Only Live') };
    const t = table(['File', 'Loaded as', 'Hostfile', 'Live', ''], f.rows.map(row => [fileCell(row), row.type, fileStatus(row.hostfile, row.side), fileStatus(row.live, row.side), pills[row.side]()]), f.rows.map(row => row.side === 'hostfile'));
    t.querySelectorAll('tbody tr').forEach((tr, i) => { if (f.rows[i].side === 'both') tr.classList.add('both'); });
    wrap.append(t);
  }
  if (f.measured && (f.rows.length || !f.measuring)) wrap.append(el('p', 'fnote', f.measuring ? 'Measuring both servers…' : `Measured from what the two panes really loaded, also files that scripts and stylesheets request later.${f.dropped ? ` ${f.dropped} more failed files are not listed.` : ''}`));
  if (f.old.length) wrap.append(oldServerSection(f));
  if (f.errors.length) {
    const js = el('div', 'fsec');
    js.append(el('h4', '', 'JavaScript errors only on Hostfile'), el('p', '', 'Errors that also appear on Live are left out.'));
    js.append(table(['Error', 'Source'], f.errors.map(e => [el('span', 'fstat bad ferr', e.count > 1 ? `${e.message} (${e.count} times)` : e.message), e.source]), f.errors.map(() => true)));
    wrap.append(js);
  }
  return wrap;
}
function table(headers, rows, flags = []) {
  const t = document.createElement('table'), hr = document.createElement('tr'); for (const h of headers) { const th = document.createElement('th'); th.textContent = h; hr.append(th); }
  const thead = document.createElement('thead'); thead.append(hr); t.append(thead);
  const body = document.createElement('tbody'); rows.forEach((cells, i) => { const tr = document.createElement('tr'); if (flags[i]) tr.className = 'flag'; for (const c of cells) { const td = document.createElement('td'); if (c instanceof Node) td.append(c); else td.textContent = c; tr.append(td); } body.append(tr); }); t.append(body); return t;
}
function dot(on) { return el('span', on ? 'y' : 'n0', on ? '●' : '·'); }
function domainTable(domains, noLive) {
  if (!domains.length) return el('p', 'dempty', 'No external domains found.');
  // Without Live there is nothing to compare: the domains of the new server, without "only on" labels.
  if (noLive) { const t = table(['Domain', 'Hostfile', 'Loaded as'], domains.map(x => [x.host, dot(x.hostfile), (x.types || []).join(', ')])); t.querySelectorAll('tbody tr').forEach(tr => tr.firstChild.classList.add('m')); return t; }
  const t = table(['Domain', 'Hostfile', 'Live', 'Loaded as', ''], domains.map(x => [x.host, dot(x.hostfile), dot(x.live), (x.types || []).join(', '), x.hostfile && x.live ? pill('Both') : pill(x.live ? 'Only on Live' : 'Only on Hostfile', true)]), domains.map(x => !(x.hostfile && x.live)));
  t.querySelectorAll('tbody tr').forEach(tr => tr.firstChild.classList.add('m')); return t;
}
function htmlLines(lines) {
  if (!lines.length) return el('p', 'dempty', 'The HTML is identical.');
  const code = el('div', 'code'), prefix = { both: '  ', hostfile: 'Hostfile + ', live: 'Live + ' };
  for (const l of lines) code.append(el('div', l.side === 'hostfile' || l.side === 'live' ? l.side : 'both', `${prefix[l.side] || '  '}${l.text || (l.side === 'both' ? '' : '(empty line)')}`));
  return code;
}
function headerTable(rows) {
  if (!rows.length) return el('p', 'dempty', 'No header differences.');
  const t = table(['Header', 'Hostfile', 'Live'], rows.map(h => [h.name, h.hostfile || '—', h.live || '—'])); t.querySelectorAll('tbody td').forEach(td => td.classList.add('m')); return t;
}
