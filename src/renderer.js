const $ = id => document.getElementById(id);
let libraryTab = 'bookmarks', libraryKey = '';
let state, editing = null, toastTimer, tabsKey = '', rulesKey = '';
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 7000); }
async function command(action, data) { try { const result = await window.browser.command(action, data); if (!result.ok) toast(result.error); return result; } catch (error) { toast(error.message); return { ok: false }; } }
function el(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
function render(next) {
  state = next;
  document.documentElement.style.setProperty('--rb', `${state.routeBarHeight ?? 36}px`);
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
    setIcon($('protocol'), tab.url.startsWith('https:') ? 'lock' : 'globe');
  }
  $('panel').hidden = !state.panel; document.body.classList.toggle('panel-open', Boolean(state.panel));
  $('domains').classList.toggle('selected', state.panel === 'domains');
  $('settings').classList.toggle('selected', state.panel === 'settings');
  $('domains-section').hidden = state.panel !== 'domains';
  $('library-section').hidden = state.panel !== 'library';
  $('settings-section').hidden = state.panel !== 'settings';
  document.body.classList.toggle('claude-open', state.panel === 'claude' && state.claude.status === 'ready');
  $('claude-section').hidden = state.panel !== 'claude';
  $('claude').classList.toggle('selected', state.panel === 'claude');
  $('claude-message').textContent = state.claude.message;
  $('claude-install-info').hidden = state.claude.status === 'ready';
  $('claude-controls').hidden = state.claude.status !== 'ready';
  $('install-claude').disabled = ['loading','installing'].includes(state.claude.status);
  $('update-section').hidden = state.panel !== 'updates';
  $('panel-title').textContent = { domains: 'Domains', settings: 'Settings', updates: 'Updates', claude: 'Claude', library: 'Library' }[state.panel] || '';
  $('panel-subtitle').textContent = state.panel === 'claude' ? 'Experimental · inside Dioptra' : state.panel === 'domains' ? 'Only active in this browser' : state.panel === 'updates' ? 'Keep your migration workspace current' : 'Your Dioptra preferences';
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
  const nextRulesKey = JSON.stringify(state.rules);
  if (rulesKey !== nextRulesKey) {
  rulesKey = nextRulesKey;
  $('rules').replaceChildren();
  for (const [index, rule] of state.rules.entries()) {
    const row = el('div', 'rule'); const text = el('div', 'rule-text'); text.append(el('div', 'rule-domain', rule.domain), el('div', 'rule-ip', rule.ip)); row.append(text);
    const toggle = el('button', 'toggle' + (rule.enabled ? ' on' : '')); toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(rule.enabled)); toggle.setAttribute('aria-label', `Enable ${rule.domain}`); toggle.onclick = () => command('save-rules', state.rules.map((r, i) => i === index ? { ...r, enabled: !r.enabled } : r));
    const edit = el('button', 'small', '✎'); edit.setAttribute('aria-label', `Edit ${rule.domain}`); edit.onclick = () => { editing = rule.domain; $('domain-input').value = rule.domain; $('ip-input').value = rule.ip; $('save-rule').textContent = 'Save'; $('cancel-edit').hidden = false; $('domain-input').focus(); };
    const remove = el('button', 'small', '⌫'); remove.setAttribute('aria-label', `Remove ${rule.domain}`); remove.onclick = async () => { const result = await command('save-rules', state.rules.filter(r => r.domain !== rule.domain)); if (result.ok && editing === rule.domain) resetForm(); };
    row.append(toggle, edit, remove); $('rules').append(row);
  }
  }
  $('empty-rules').hidden = state.rules.length > 0; $('apply').disabled = !state.pending; $('pending').textContent = state.pending ? 'Domain or SSL changes saved. Restart to activate them.' : 'All saved domain rules are active.';
  $('apply').parentElement.classList.toggle('pending', state.pending);
  $('update-message').textContent = state.update.message; $('auto-updates').checked = state.autoUpdates;
  if (document.activeElement !== $('feed')) $('feed').value = state.updateFeed;
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
}
function resetForm() { editing = null; $('rule-form').reset(); $('save-rule').textContent = 'Add'; $('cancel-edit').hidden = true; }
$('rule-form').onsubmit = async event => {
  event.preventDefault(); const existing = state.rules.find(r => r.domain === editing); const rule = { domain: $('domain-input').value, ip: $('ip-input').value, enabled: existing?.enabled ?? true };
  const rules = editing ? state.rules.map(r => r.domain === editing ? rule : r) : [...state.rules, rule];
  const result = await command('save-rules', rules); if (result.ok) resetForm();
};
$('cancel-edit').onclick = resetForm;
$('navigation').onsubmit = event => { event.preventDefault(); const url = $('address').value; $('address').blur(); command('navigate', url); };
$('new-tab').onclick = () => command('new-tab'); $('domains').onclick = () => command('panel', state.panel === 'domains' ? null : 'domains'); $('close-panel').onclick = () => command('panel', null);
$('welcome-domains').onclick = async () => { await command('panel', 'domains'); $('domain-input').focus(); };
$('settings').onclick = () => command('panel', state.panel === 'settings' ? null : 'settings');
$('open-updates').onclick = $('update-notice').onclick = () => command('panel', 'updates');
$('back').onclick = () => command('back'); $('forward').onclick = () => command('forward'); $('reload').onclick = () => command(state.tabs.find(t => t.id === state.activeId)?.loading ? 'stop' : 'reload'); $('retry').onclick = () => command('reload');
$('apply').onclick = () => command('restart'); $('devtools').onclick = () => command('devtools');
$('clear-cache').onclick = async () => { if ((await command('clear-cache')).ok) toast('Cache and DNS cache cleared, page reloaded. Cookies and logins were kept.'); };
$('feed-form').onsubmit = event => { event.preventDefault(); command('update-settings', { feed: $('feed').value, automatic: $('auto-updates').checked }); };
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
$('maker-coffee').onclick = () => command('new-tab', 'https://buymeacoffee.com/solutionmax');
$('tools-close').onclick = () => command('devtools');
document.querySelectorAll('[data-dock]').forEach(button => { button.onclick = () => command('devtools-layout', { dock: button.dataset.dock }); });
let toolsDrag = null;
function dragDock(event) {
  const width = window.innerWidth - (state.panel ? Math.min(480, Math.floor(window.innerWidth * .48)) : 0);
  return event.clientX < width * .25 ? 'left' : event.clientX > width * .75 ? 'right' : 'bottom';
}
for (const id of ['tools-grip', 'tools-splitter']) {
  const handle = $(id);
  handle.onpointerdown = event => {
    if (event.button !== 0 || !state.toolsLayout) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    toolsDrag = { id, dock: state.devtoolsDock, ratio: state.devtoolsRatio, target: state.devtoolsDock, latestRatio: state.devtoolsRatio };
    document.body.classList.toggle('tools-resizing', id === 'tools-splitter');
    command('devtools-drag', true);
  };
  document.addEventListener('pointermove', event => {
    if (!toolsDrag || toolsDrag.id !== id) return;
    if (id === 'tools-grip') {
      toolsDrag.target = dragDock(event);
      document.querySelectorAll('[data-drop]').forEach(node => node.classList.toggle('selected', node.dataset.drop === toolsDrag.target));
    } else {
      const width = window.innerWidth - (state.panel ? Math.min(480, Math.floor(window.innerWidth * .48)) : 0);
      const ratio = toolsDrag.dock === 'bottom' ? (window.innerHeight - 30 - event.clientY) / (window.innerHeight - 162) : toolsDrag.dock === 'right' ? (width - event.clientX) / width : event.clientX / width;
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
$('install-claude').onclick = () => command('install-claude');
$('remove-claude').onclick = () => command('remove-claude');
$('claude-options').onclick = () => command('claude-options');
$('claude-chat').onclick = () => command('panel', 'claude');

$('claude-refresh').onclick = async () => { const result = await command('claude-refresh'); if (result.ok) $('claude-report').hidden = true; };
$('claude-check').onclick = async () => {
  $('claude-check').disabled = true;
  try {
    const result = await command('claude-check');
    if (!result.ok) return;
    const d = result.diagnostics;
    $('claude-diagnostics').textContent = JSON.stringify(d, null, 2);
    $('claude-report-summary').textContent = d.lastInterfaceSignal === 'cic_sidepanel_cowork_unavailable' ? 'Claude reported that the new interface is unavailable and fell back to classic.' : d.interface === 'new' ? 'The new Claude interface is selected. Its load status is shown below.' : d.newInterfaceEnabled === true ? 'The new interface is enabled in the cached settings, but is not currently displayed.' : d.newInterfaceEnabled === false ? 'The cached Claude settings disable the new interface. Try Refresh Claude, then check again.' : 'No interface setting is available yet. Open Claude, finish signing in, then check again.';
    $('claude-report').hidden = false;
  } finally { $('claude-check').disabled = false; }
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
  $('ssl-verification').checked=state.sslVerification; $('apply-ssl').disabled=!state.pending;
  $('footer-note').textContent=`by SolutionMAX · SSL checks ${state.activeSSL?'on':'off for migration sites'}`;
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
    const isRight=t.id===state.comparison.live, peer=isRight?left:right;
    const bar=isRight && (compareWith!==null || t.startPage) ? compareWithBar(t) : routeBar(t,{pane:true,selected,peer,other:isRight?otherSite:undefined});place(bar,pane.banner);bar.classList.toggle('compact',pane.banner.width<800);$('pane-bars').append(bar);
    if(t.error) {
      const error=el('div','comparison-error');place(error,pane.page);
      error.append(el('h2','',`${t.route.label} could not load`),el('p','',t.url),el('code','',t.error));
      const retry=el('button','','Try again');retry.onclick=async()=>{await command('activate',t.id);command('reload');};error.append(retry);$('comparison-errors').append(error);
    } else if(isRight && t.startPage) {
      const empty=el('div','pane-empty'), hint=el('span','','Type the address of the other copy, for example ');place(empty,pane.page);
      hint.append(el('code','','staging.example.com'));empty.append(el('b','','What do you want to compare with?'),hint);$('comparison-errors').append(empty);
    }
  }
  // The bars are rebuilt on every state update: keep the caret, and put it in the field when the field first shows.
  const field=$('compare-with');
  if(field && caret) { if(document.hasFocus()) { field.focus(); field.setSelectionRange(...caret); } } else if(field && !oldField) { field.focus(); field.select(); }
  // Closing the field hands the focus back to the button that opened it.
  if(compareWithClosed) { compareWithClosed=false; if(!field) document.querySelector('#pane-bars button.with')?.focus(); }
  renderDifferences(tab, view);
  renderLibrary();
}
function renderLibrary() {
  const downloads=new Map(state.library.downloads.map(d=>[d.id,d]));for(const d of state.downloads)downloads.set(d.id,d);
  const entries=libraryTab==='downloads'?[...downloads.values()].reverse():state.library[libraryTab];
  const key=JSON.stringify([libraryTab,entries]);if(key===libraryKey)return;libraryKey=key;
  document.querySelectorAll('[data-library]').forEach(n=>n.classList.toggle('selected',n.dataset.library===libraryTab));
  $('clear-library').hidden=libraryTab==='bookmarks';$('clear-library').textContent=libraryTab==='history'?'Clear history':'Clear finished downloads';
  $('library-list').replaceChildren();
  if(!entries.length)$('library-list').append(el('p','empty',`No ${libraryTab} yet.`));
  for(const entry of entries){
    const row=el('div','library-entry');
    if(libraryTab==='downloads'){
      row.append(el('strong','',entry.name),el('p','',`${entry.state}${entry.paused?' · paused':''} · ${(entry.received/1048576).toFixed(1)} / ${entry.total?(entry.total/1048576).toFixed(1):'?'} MB`));
      if(entry.state==='progressing'){const progress=el('progress','');if(entry.total){progress.max=entry.total;progress.value=entry.received;}row.append(progress);}
      for(const [action,label] of entry.state==='completed'?[['show','Show in folder']]:entry.state==='progressing'||entry.canResume?[...(entry.paused||entry.state==='interrupted'?(entry.canResume?[['resume','Resume']]:[]):[['pause','Pause']]),['cancel','Cancel']]:[]){const b=el('button','',label);b.onclick=()=>command('download-action',{id:entry.id,action});row.append(b);}
    } else {
      const open=el('button','library-link',entry.title||entry.url);open.onclick=()=>command('new-tab',entry.url);row.append(open,el('p','',entry.url));
      if(libraryTab==='bookmarks'){const remove=el('button','','Remove');remove.onclick=()=>command('remove-bookmark',entry.url);row.append(remove);}
      else row.append(el('small','',new Date(entry.visitedAt).toLocaleString()));
    }
    $('library-list').append(row);
  }
}
$('compare').onclick=()=>command(currentView()==='compare'?'stop-compare':'compare');
$('view-single').onclick=()=>currentView()==='compare'?command('stop-compare'):currentView()==='differences'?command('view','single'):0;
$('view-differences').onclick=async()=>{
  if(currentView()==='differences') return;
  if(currentView()==='compare') await command('stop-compare');
  const result=await command('view','differences'); if(!result.ok) return;
  const d=state.differences, tab=state.tabs.find(t=>t.id===state.activeId);
  if(d?.status!=='running' && !(d?.status==='done' && d.report?.url===tab?.url)) command('differences-run');
};
$('clear-site-data').onclick=async()=>{ if((await command('clear-site-data')).ok) toast('Site data cleared for this site.'); };
$('open-release').onclick=$('release-page').onclick=()=>command('open-release');
$('footer-version').onclick=()=>command('panel','updates');
$('bookmark').onclick=()=>command('bookmark');
$('library').onclick=$('open-library').onclick=()=>command('panel','library');
$('open-find').onclick=()=>command('find-open');
$('find-input').oninput=()=>command('find',{text:$('find-input').value});
$('find-input').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();command('find',{text:$('find-input').value,forward:!e.shiftKey});}if(e.key==='Escape')command('find-close');};
$('find-next').onclick=()=>command('find',{text:$('find-input').value,forward:true});
$('find-prev').onclick=()=>command('find',{text:$('find-input').value,forward:false});
$('find-close').onclick=()=>command('find-close');
window.browser.onFocusFind(()=>{$('find-input').focus();$('find-input').select();});
$('ssl-verification').onchange=()=>command('ssl-verification',$('ssl-verification').checked);
$('reopen-tab').onclick=()=>command('reopen-tab');
$('clear-library').onclick=()=>command(libraryTab==='history'?'clear-history':'clear-downloads');
document.querySelectorAll('[data-library]').forEach(b=>b.onclick=()=>{libraryTab=b.dataset.library;renderLibrary();});

$('apply-ssl').onclick=()=>command('restart');

/* View state, route bars and the Differences view. All dynamic text uses textContent. */
const ICONS = {
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
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'
};
function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.innerHTML = ICONS[name]; return svg; }
function setIcon(node, name) { if (node.dataset.icon === name) return; node.dataset.icon = name; node.replaceChildren(icon(name)); }
const HOW = {
  general: ['How updates work', ['Dioptra checks GitHub for a new release at start and every 4 hours.', 'You see it in the footer and at the top right. Nothing installs by itself.', 'You choose when. Tabs and domain rules come back after the restart.'], ''],
  manual: ['How to update on macOS', ['Open the download page and get the zip for your Mac: Apple Silicon or Intel.', 'Quit Dioptra and drag the new app over the old one in Applications.', 'Open it. Rules, tabs and logins are kept.'], 'The Mac build is not notarized yet, so it cannot replace itself.'],
  auto: ['How to update', ['Click Download update. The file is checked against its checksum and, on macOS, its signature.', 'Click Install and restart when it suits you.', 'Dioptra reopens on the new version with your tabs.'], '']
};
let howKey = '';
function renderUpdateDetails() {
  const u = state.update, updating = ['available', 'downloading', 'downloaded'].includes(u.status), installed = `v${state.versions.app}`;
  $('update-card').className = `update-card ${u.status === 'downloaded' ? 'green' : updating ? 'blue' : u.status === 'error' ? 'red' : ''}`;
  $('update-title').textContent = { available: 'New version', downloading: 'Downloading', downloaded: 'Ready to install', error: 'Update could not be completed', checking: 'Checking' }[u.status] || 'Installed';
  $('update-version').textContent = updating && u.version ? `${installed} → v${u.version}` : `Dioptra ${installed}`;
  const released = updating && u.date && !Number.isNaN(Date.parse(u.date)) ? new Date(u.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const pill = u.status === 'current' ? 'up to date' : released;
  $('update-pill').hidden = !pill; $('update-pill').textContent = pill; $('update-pill').className = `pill-s ${u.status === 'current' ? 'g' : 'b'}`;
  const checked = u.checkedAt ? `Last checked ${new Date(u.checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
  $('update-message').textContent = u.status === 'current' && checked ? `${checked} · ${state.autoUpdates ? 'checks again every 4 hours' : 'automatic checks are off'}` : u.message;
  const key = !updating ? 'general' : u.canInstall === false ? 'manual' : 'auto';
  if (key !== howKey) { howKey = key; const [title, steps, hint] = HOW[key]; $('how-title').textContent = title; $('how-steps').replaceChildren(...steps.map(step => el('li', '', step))); $('how-hint').textContent = hint; $('how-hint').hidden = !hint; }
  const footer = $('footer-version');
  footer.className = u.status === 'downloaded' ? 'ready' : updating ? 'new' : '';
  footer.textContent = u.status === 'downloaded' ? `v${u.version} ready · restart to update` : updating && u.version ? `Dioptra ${installed} · v${u.version} available` : `Dioptra ${installed}`;
}
function currentView() { return state.view || (state.comparison ? 'compare' : 'single'); }
function withIcon(className, name, text) { const n = el('span', className); n.append(icon(name), text); return n; }
function kv(label, value, className = 'v') { const n = el('span', 'kv'); n.append(el('span', 'k', label), el('span', className, value)); return n; }
const bareIP = ip => String(ip || '').replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
function formatMs(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`; }
// Any click in the window UI outside the button closes the certificate card; the button itself toggles it.
// Handled on the document and on pointerdown: the bar is rebuilt on every state update, so a button can be replaced between press and release and would then never get its click.
function toggleCard(button) { const r = button.getBoundingClientRect(); command('card', { kind: button.dataset.card, id: Number(button.dataset.tab) || 0, right: r.right, bottom: r.bottom }); }
document.addEventListener('pointerdown', event => { const button = event.button === 0 && event.target.closest?.('[data-card]'); if (button) toggleCard(button); else command('card-close'); }, true);
document.addEventListener('click', event => { const button = event.detail === 0 && event.target.closest?.('[data-card]'); if (button) toggleCard(button); });
// Platform and PHP of the site in one chip; in Compare the parts that differ from the other pane are marked.
function siteChip(t, peer) {
  const s = t.site; if (!s || t.loading || t.error) return null;
  const button = el('button', 'site-btn'); button.type = 'button'; button.dataset.card = 'site'; button.dataset.tab = t.id; button.setAttribute('aria-haspopup', 'dialog');
  const value = el('span', 'site-v'), other = peer?.site;
  const part = (name, version, differs) => { if (value.childNodes.length) value.append(' · '); value.append(name); if (version) { value.append(' '); value.append(el('small', differs ? 'differs' : '', version)); } };
  if (s.platform) part(s.platform, s.version, Boolean(other?.platform) && (other.platform !== s.platform || other.version !== s.version));
  if (s.php) part('PHP', s.php, Boolean(other?.php) && other.php !== s.php);
  button.append(el('span', 'k', 'Site'), value);
  button.setAttribute('aria-label', `Site runs on ${value.textContent}, show details`);
  return button;
}
// Opens the DNS card. Nothing is looked up until it is clicked.
function dnsButton(t) {
  const button = el('button', 'dns-btn', 'DNS'); button.type = 'button';
  const chevron = icon('chevron'); chevron.classList.add('chev'); button.append(chevron);
  button.title = `DNS records of ${t.route.host}`; button.setAttribute('aria-label', `Show DNS records of ${t.route.host}`); button.setAttribute('aria-haspopup', 'dialog');
  button.dataset.card = 'dns'; button.dataset.tab = t.id;
  return button;
}
function certButton(t) {
  const button = el('button', 'ok cert-btn'); button.type = 'button';
  const chevron = icon('chevron'); chevron.classList.add('chev');
  button.append(icon('check'), el('span', 'cert-text', 'Certificate valid'), chevron);
  button.setAttribute('aria-label', 'Certificate valid, show issuer and expiry date'); button.setAttribute('aria-haspopup', 'dialog');
  button.dataset.card = 'cert'; button.dataset.tab = t.id;
  return button;
}
// Compare with another URL: the draft address while the field in the right pane bar is open (null = closed).
let compareWith = null, compareWithError = '', compareWithClosed = false;
function closeCompareWith() { compareWith = null; compareWithError = ''; compareWithClosed = true; renderWorkspace(); }
async function submitCompareWith(value) {
  let result; try { result = await window.browser.command('compare-with', value); } catch (error) { result = { ok: false, error: error.message }; }
  if (result.ok) return closeCompareWith();
  compareWithError = result.error || 'That address could not be opened.';
  renderWorkspace();
}
// The right pane bar as a form. An empty right pane has nothing to go back to, so there it cannot be closed.
function compareWithBar(t) {
  const bar = el('form', `route-bar editing${t.startPage ? '' : ' live'}`);
  const label = el('label', '', 'Compare with'), input = el('input', ''), go = el('button', 'with-go', 'Go');
  label.htmlFor = input.id = 'compare-with'; input.value = compareWith ?? ''; input.placeholder = 'https://'; input.spellcheck = false; input.autocomplete = 'off';
  input.oninput = () => { compareWith = input.value; };
  input.onkeydown = event => { if (event.key === 'Escape' && !t.startPage) closeCompareWith(); };
  bar.onsubmit = event => { event.preventDefault(); submitCompareWith(input.value); };
  if (!t.startPage) bar.append(el('span', 'badge', 'LIVE'));
  bar.append(label, input);
  if (compareWithError) { const error = el('span', 'with-error', compareWithError); error.id = 'compare-with-error'; error.setAttribute('role', 'alert'); input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', error.id); bar.append(error); }
  bar.append(go);
  if (!t.startPage) { const same = el('button', '', 'Same URL'); same.type = 'button'; same.title = 'Back to the same URL as the left pane'; same.onclick = () => submitCompareWith(null); const cancel = el('button', '', 'Cancel'); cancel.type = 'button'; cancel.onclick = closeCompareWith; bar.append(same, cancel); }
  return bar;
}
function routeBar(t, { pane = false, selected = false, peer = null, other } = {}) {
  const label = t.route.label === 'HOSTFILE' ? 'Hostfile' : t.route.label === 'LIVE' ? 'Live' : t.route.label;
  const bar = el('div', `route-bar ${t.route.label.toLowerCase()}${selected ? ' active' : ''}`);
  const badge = pane ? el('button', 'badge', t.route.label) : el('span', 'badge', t.route.label);
  if (pane) { badge.setAttribute('aria-pressed', String(selected)); badge.setAttribute('aria-label', `${label} pane${t.route.host ? ` for ${t.route.host}` : ''}${selected ? ', selected' : ''}`); badge.onclick = () => command('activate', t.id); }
  if (other === undefined) bar.append(badge, el('span', 'route-domain', t.route.host || 'New tab'));
  else {
    // The address of the right pane in Compare opens the Compare with field. On pointerdown, as the bar can be rebuilt between press and release.
    const swap = el('button', `with${other ? ' other' : ''}`), open = () => { compareWith = t.url; compareWithError = ''; renderWorkspace(); };
    swap.type = 'button'; swap.title = 'Compare with another URL'; swap.setAttribute('aria-label', `Compare with another URL, now ${t.route.host}`);
    swap.append(el('span', '', t.route.host || 'New tab'), icon('pen'));
    swap.onpointerdown = event => { if (event.button === 0) { event.preventDefault(); open(); } }; swap.onclick = event => { if (event.detail === 0) open(); };
    bar.append(badge, swap);
  }
  if (t.route.dns) bar.append(dnsButton(t));
  if (t.route.configured) { const rule = kv('Rule', t.route.configured); rule.classList.add('rule'); bar.append(rule); }
  const ips = bareIP(t.connection?.ip), fromCache = t.connection?.fromCache;
  const measured = t.loading ? 'Connecting…' : t.error ? 'Not connected' : fromCache ? 'Cached · IP not measured' : ips ? ips : 'IP not available';
  const connected = kv(t.route.label === 'LIVE' ? 'Live' : 'Connected', measured); connected.classList.add('conn');
  const ptr = ips && !t.loading && !t.error && !fromCache ? t.connection?.hostname : '';
  if (ptr) { const name = el('span', 'ptr', ptr); name.title = `Reverse DNS (PTR) of ${ips}: ${ptr}`; connected.append(name); }
  if (ips && !t.loading && !t.error && t.route.configured) {
    const match = ips.split(',').map(s => bareIP(s.trim())).includes(bareIP(t.route.configured));
    connected.append(withIcon(match ? 'ok' : 'bad', match ? 'check' : 'x', match ? 'match' : 'mismatch'));
  }
  bar.append(connected);
  const right = el('span', 'route-right');
  const ssl = t.route.ssl, secure = t.url.startsWith('https:');
  const chip = siteChip(t, peer); if (chip) right.append(chip);
  if (t.error) right.append(withIcon('bad', 'alert', el('span', 'cert-text', /CERT|SSL/i.test(t.error) ? 'Strict certificate error' : 'Load error')));
  else if (secure) right.append(ssl === 'SSL checks off' ? withIcon('warn', 'shield', el('span', 'cert-text', 'Certificate check skipped')) : t.route.cert ? certButton(t) : withIcon('ok', 'check', el('span', 'cert-text', 'Certificate valid')));
  else if (t.url !== 'about:blank') right.append(withIcon('warn', 'info', el('span', 'cert-text', 'No TLS')));
  const status = t.connection?.status ?? t.connection?.statusCode, ms = t.connection?.ms ?? t.connection?.time;
  if (status) right.append(kv('HTTP', Number.isFinite(ms) ? `${status} · ${formatMs(ms)}` : String(status)));
  bar.append(right);
  const source = t.connection?.source === 'active server connections' ? 'Observed server connections for this host and port. Multiple IPs may be shown.' : 'Server IP observed for this page response. Cached pages may have no network connection.';
  const details = `${label} · ${t.route.host || 'New tab'}${t.route.configured ? `\nHostfile IP ${t.route.configured}` : ''}\n${measured}${ptr ? ` · ${ptr}` : ''} · ${ssl}\n${source}`;
  bar.title = details; badge.setAttribute('aria-description', details);
  return bar;
}
function renderRouteBar(tab, view) {
  const bar = $('route-bar'); bar.replaceChildren(); bar.className = 'route-bar';
  if (!tab) return;
  bar.hidden = view === 'compare' && state.routeBarHeight === 0;
  if (view === 'compare') { bar.classList.add('idle'); bar.append(el('span', 'route-domain', 'Comparing Hostfile and Live')); return; }
  const next = routeBar(tab); bar.className = next.className; bar.title = next.title; bar.append(...next.childNodes);
  const pending = el('span', ''); pending.id = 'pending-badge'; pending.textContent = 'Changes pending restart'; pending.hidden = !state.pending;
  bar.querySelector('.route-right').prepend(pending);
}
let diffTab = 'domains', diffKey = '';
function pill(text, red) { return el('span', `pill ${red ? 'red' : 'gray'}`, text); }
function diffState(box, node) { box.replaceChildren(node); }
function renderDifferences(tab, view) {
  const box = $('differences'); box.hidden = view !== 'differences';
  if (box.hidden) { diffKey = ''; return; }
  const d = state.differences || { status: 'idle' }, r = d.report;
  const key = JSON.stringify([d.status, d.error, r?.comparedAt, r?.url, diffTab, state.tabs.find(t => t.id === state.activeId)?.route.label]);
  if (key === diffKey) return; diffKey = key;
  if (d.status === 'running' || (d.status === 'idle' && !r)) { const n = el('div', 'dstate'); n.append(el('div', 'spinner'), el('h2', '', 'Comparing both servers'), el('p', '', 'Fetching the page from the Hostfile server and from Live.')); return diffState(box, n); }
  if (d.status === 'error' || !r) { const n = el('div', 'dstate'); n.append(el('h2', '', 'Comparison failed'), el('code', '', d.error || 'No report available.')); const again = el('button', 'primary', 'Try again'); again.onclick = () => command('differences-run'); n.append(again); return diffState(box, n); }
  const domains = r.domains || [], liveOnly = domains.filter(x => x.live && !x.hostfile), hostOnly = domains.filter(x => x.hostfile && !x.live), oneSided = [...liveOnly, ...hostOnly];
  let host = ''; try { host = new URL(r.url).hostname; } catch {}
  const main = el('div', 'diff-main'), head = el('div', 'dhead'), vs = el('div', 'dvs');
  const badgeHF = el('span', 'badge', 'HOSTFILE'), badgeLive = el('span', 'badge', 'LIVE'); const hfWrap = el('span', 'hostfile'), liveWrap = el('span', 'live'); hfWrap.append(badgeHF); liveWrap.append(badgeLive);
  vs.append(hfWrap, el('span', '', r.hostfile?.ip || 'n/a'), el('span', '', 'vs'), liveWrap, el('span', '', `${r.live?.ip || 'n/a'} · compared ${new Date(r.comparedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
  const again = el('button', 'btn'); again.append(icon('reload'), 'Compare again'); again.onclick = () => command('differences-run');
  head.append(el('h2', '', host || r.url), vs, again);
  const kpis = el('div', 'kpis');
  const card = (label, big, sub, alert) => { const c = el('div', `kpi${alert ? ' alert' : ''}`); c.append(el('div', 'lbl', label), el('div', 'n', big), el('div', 's', sub)); return c; };
  const headerDiffs = r.headers || [];
  kpis.append(
    card('External domains', oneSided.length ? `${oneSided.length} only on ${liveOnly.length && !hostOnly.length ? 'Live' : hostOnly.length && !liveOnly.length ? 'Hostfile' : 'one side'}` : 'No differences', oneSided.length ? oneSided.slice(0, 2).map(x => x.host).join(', ') : `${domains.length} found on both`, liveOnly.length > 0),
    card('HTML', r.html?.changedLines ? `${r.html.changedLines} line${r.html.changedLines === 1 ? '' : 's'}` : 'Identical', r.html?.changedLines ? 'changed between servers' : 'same markup', false),
    card('Headers', String(headerDiffs.length), headerDiffs.length ? headerDiffs.slice(0, 3).map(h => h.name).join(', ') : 'no differences', false),
    card('Status · speed', `${r.hostfile?.status ?? '—'} · ${r.live?.status ?? '—'}`, `${Number.isFinite(r.hostfile?.ms) ? formatMs(r.hostfile.ms) : '—'} vs ${Number.isFinite(r.live?.ms) ? formatMs(r.live.ms) : '—'}`, r.hostfile?.status !== r.live?.status));
  const box2 = el('div', 'dcard'), ch = el('div', 'dch'), tabs = el('div', 'subtabs');
  const titles = { domains: ['External domains', 'where the page loads scripts, fonts and images from'], html: ['HTML', 'changed lines with context'], headers: ['Headers', 'only where the servers differ'] };
  ch.append(el('b', '', titles[diffTab][0]), el('span', 'lbl', titles[diffTab][1]));
  for (const [id, label] of [['domains', 'Domains'], ['html', 'HTML'], ['headers', 'Headers']]) { const b = el('button', '', label); b.setAttribute('aria-pressed', String(diffTab === id)); b.onclick = () => { diffTab = id; renderDifferences(tab, currentView()); }; tabs.append(b); }
  ch.append(tabs);
  const scroll = el('div', 'dscroll');
  scroll.append(diffTab === 'domains' ? domainTable(domains) : diffTab === 'html' ? htmlLines(r.html?.hunks || r.html?.lines || []) : headerTable(headerDiffs));
  box2.append(ch, scroll); main.append(head, kpis, box2);
  const side = el('div', 'diff-side'); side.append(el('div', 'lbl', 'Findings'), el('h3', '', 'What stands out'));
  if (!(r.findings || []).length) side.append(el('div', 'finding', 'No notable differences found.'));
  for (const f of r.findings || []) { const c = el('div', `finding${f.severity === 'high' ? ' high' : ''}`), t = el('div', 't'); t.append(icon(f.severity === 'info' ? 'info' : 'alert'), el('b', '', f.title || f.text || '')); if (f.detail) c.append(t, el('p', '', f.detail)); else c.append(t); side.append(c); }
  const ask = el('button', 'primary ask'); const img = document.createElement('img'); img.src = 'brand/claude.png'; img.alt = ''; ask.append(img, 'Ask Claude about these differences');
  ask.onclick = async () => { const result = await command('differences-ask-claude'); if (result.ok && result.notice) toast(result.notice); };
  side.append(ask, el('p', 'ask-hint', 'Sends this comparison to the Claude panel. Claude keeps working as it does now.'));
  box.replaceChildren(main, side);
}
function table(headers, rows, flags = []) {
  const t = document.createElement('table'), hr = document.createElement('tr'); for (const h of headers) { const th = document.createElement('th'); th.textContent = h; hr.append(th); }
  const thead = document.createElement('thead'); thead.append(hr); t.append(thead);
  const body = document.createElement('tbody'); rows.forEach((cells, i) => { const tr = document.createElement('tr'); if (flags[i]) tr.className = 'flag'; for (const c of cells) { const td = document.createElement('td'); if (c instanceof Node) td.append(c); else td.textContent = c; tr.append(td); } body.append(tr); }); t.append(body); return t;
}
function dot(on) { return el('span', on ? 'y' : 'n0', on ? '●' : '·'); }
function domainTable(domains) {
  if (!domains.length) return el('p', 'dempty', 'No external domains found.');
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
