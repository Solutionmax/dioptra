// Renders one small card (certificate, site platform, memory or DNS records). The main process calls render(data) and gets the
// height the content needs. Every value is set as text, never as HTML.
const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const day = ms => new Date(Number(ms)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const size = kb => kb >= 1048576 ? `${(kb / 1048576).toFixed(2)} GB` : `${Math.round(kb / 1024)} MB`;
function row(list, label, value, mono, note) {
  if (!value) return;
  const dd = el('dd'); dd.append(el('span', '', value));
  if (mono) dd.append(' ', el('span', 'mono', mono));
  if (note) dd.append(el('small', '', note));
  list.append(el('dt', '', label), dd);
}
const clock = ms => new Date(Number(ms)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const span = s => s >= 86400 ? `${+(s / 86400).toFixed(1)} d` : s >= 3600 ? `${+(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
// One DNS value: mail priority in front, lifetime behind an address.
function dnsValue(value, marked) {
  const line = el('div', 'v'), holder = marked ? el('mark') : line;
  if (value.prio !== undefined) holder.append(el('i', 'prio', String(value.prio)));
  holder.append(value.text);
  if (marked) line.append(holder);
  if (value.ttl) line.append(el('em', 'ttl', `TTL ${span(value.ttl)}`));
  return line;
}
function dnsNotice(className, before, strong, after) { const box = el('div', `notice ${className}`); box.append(before, el('b', '', strong), after); return box; }
function dnsName(group) { const name = el('p', 'dns-name', group.name); if (group.role === 'zone') name.append(el('small', '', 'the domain this name belongs to')); return name; }
function dnsList(groups) {
  return groups.map((group, index) => {
    const box = el('div', index ? 'dns-group' : ''), list = el('dl', 'recs');
    for (const row of group.rows) {
      const dd = el('dd'); dd.append(...row.values.map(value => dnsValue(value, false)));
      if (row.failed) dd.append(el('div', 'v none', `lookup failed (${row.failed})`));
      if (row.via) dd.append(el('small', '', 'Reached through the CNAME.'));
      if (row.rule) { const hint = el('small'); if (row.rule.same) hint.append('Same address as your rule.'); else hint.append('Your rule sends this browser to ', el('b', '', row.rule.ip), ' instead.'); dd.append(hint); }
      list.append(el('dt', '', row.type), dd);
    }
    box.append(dnsName(group), list);
    return box;
  });
}
function dnsTable(d) {
  const table = el('table', 'cmp'), cols = el('colgroup'), head = el('tr'), body = el('tbody'), LABEL = { same: 'Same', differs: 'Differs', expected: 'Expected', unknown: 'Unknown' };
  for (const className of ['ct', '', '', 'cs']) cols.append(el('col', className));
  const column = (className, badge, parts) => { const th = el('th', className), note = el('small'); note.append(...parts); th.append(el('span', 'badge', badge), note); return th; };
  head.append(el('th'), column('hostfile', 'HOSTFILE', ['asked ', el('b', '', d.ruleIP), ' itself']), column('live', 'LIVE', ['public DNS']), el('th'));
  const top = el('thead'); top.append(head);
  d.table.groups.forEach((group, index) => {
    if (index) { const tr = el('tr', 'g'), td = el('td'); td.colSpan = 4; td.append(dnsName(group)); tr.append(td); body.append(tr); }
    for (const row of group.rows) {
      const tr = el('tr'), cell = (values, className, note, failed) => {
        const td = el('td', className);
        if (failed) td.append(el('div', 'v none', `lookup failed (${failed})`)); else if (!values.length) td.append(el('div', 'v none', 'no record')); else td.append(...values.map(value => dnsValue(value, value.differs)));
        if (row.status === 'expected') td.append(el('small', '', note));
        return td;
      };
      const state = el('td', 'p'); state.append(el('span', `pill ${row.status === 'differs' ? 'amber' : 'gray'}`, LABEL[row.status]));
      tr.append(el('td', 't', row.type), cell(row.hostfile, '', 'your rule', row.failed?.hostfile), cell(row.live, 'live', 'current server', row.failed?.live), state); body.append(tr);
    }
  });
  table.append(cols, top, body);
  return table;
}
// --- camera button: choose the area (and the panes in Compare), then Download or Copy. Links are shot actions for the main process.
const SHOT_ICONS = {
  camera: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z', 'circle 12 13 3'],
  visible: ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', 'M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z'],
  full: ['M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M12 7v8', 'm9 12 3 3 3-3'],
  download: ['M12 15V3', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5'],
  copy: ['M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  image: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'circle 9 9 2', 'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'],
  check: ['M20 6 9 17l-5-5'],
  folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
  alert: ['circle 12 12 9', 'M12 8v5', 'M12 16h.01'],
  zoom: ['circle 11 11 6.5', 'm20 20-4.3-4.3'],
  panes: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M12 4v16']
};
function shotIcon(name) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const d of SHOT_ICONS[name]) {
    const [kind, cx, cy, r] = d.split(' '), shape = document.createElementNS(ns, kind === 'circle' ? 'circle' : 'path');
    if (kind === 'circle') { shape.setAttribute('cx', cx); shape.setAttribute('cy', cy); shape.setAttribute('r', r); } else shape.setAttribute('d', d);
    svg.append(shape);
  }
  return svg;
}
function shotLink(action, className, icon, label, pressed) {
  const a = el('a', className); a.href = `https://card.invalid/shot-${action}/0`;
  if (pressed !== undefined) { a.setAttribute('role', 'radio'); a.setAttribute('aria-checked', String(pressed)); if (pressed) a.classList.add('on'); }
  if (icon) a.append(shotIcon(icon));
  a.append(...(Array.isArray(label) ? label : [label]));
  return a;
}
function shotOption(action, icon, title, note, on) {
  const text = el('span'); text.append(el('b', '', title), el('small', '', note));
  return shotLink(action, 'shot-opt', icon, [text, el('span', 'dot')], on);
}
function shotResult(d) {
  const out = [], r = d.result || {}, box = (className, icon, ...lines) => { const b = el('div', `shot-done${className}`), text = el('span'); text.append(...lines); b.append(shotIcon(icon), text); return b; };
  if (d.state === 'error') out.push(box(' error', 'alert', el('b', '', 'No screenshot'), el('small', '', d.message)));
  if (r.saved) out.push(box('', 'check', el('b', '', 'Saved to Downloads'), el('code', '', r.name), el('small', '', r.size)));
  if (r.copied) out.push(box(' copy', 'copy', el('b', '', 'Copied to the clipboard'), el('small', '', `${r.saved ? '' : `${r.size}. `}Paste it with ⌘V or Ctrl+V.`)));
  if (r.cut) out.push(el('p', 'shot-note', 'The page is longer than one image can hold, so the picture stops there.'));
  const actions = el('div', 'shot-actions');
  if (r.saved) actions.append(shotLink('folder', 'mem-btn', 'folder', 'Show in folder'));
  if (d.state === 'done' && !r.copied) actions.append(shotLink('copy', 'mem-btn', 'copy', 'Copy'));
  if (d.state === 'done' && !r.saved) actions.append(shotLink('download', 'mem-btn', 'download', 'Download'));
  actions.append(shotLink('again', 'mem-btn', 'camera', d.state === 'error' ? 'Try again' : 'New screenshot'));
  return [...out, actions];
}
function shotProgress(d) {
  const box = el('div', 'shot-progress'), bar = el('div', 'shot-bar'), fill = el('i'), list = el('ul', 'shot-steps');
  fill.style.width = `${Math.max(3, Math.min(100, Number(d.progress.pct) || 0))}%`; bar.append(fill);
  for (const [status, text] of d.progress.steps) { const li = el('li', status); li.append(status === 'ok' ? shotIcon('check') : el('span', status === 'now' ? 'spin' : 'wait'), el('span', '', text)); list.append(li); }
  box.append(el('b', '', d.progress.title), el('small', '', d.compare && d.panes === 'both' ? 'Both pages at the same time. They go back to where you were.' : 'The page goes back to where you were.'), bar, list);
  const actions = el('div', 'shot-actions one'); actions.append(shotLink('cancel', 'mem-btn', '', 'Cancel'));
  return [box, actions];
}
const SHOT_QUALITY = { original: ['PNG, Retina.', 'Every pixel, the largest file.'], sharp: ['JPEG 90 %, Retina.', 'Looks the same as the original, about 5× smaller.'], small: ['JPEG 80 %, half the width.', 'For email and tickets.'] };
function shotChoose(d) {
  const out = [el('div', 'shot-label', 'Area')], area = el('div', 'shot-opts'); area.setAttribute('role', 'radiogroup'); area.setAttribute('aria-label', 'Area');
  area.append(shotOption('visible', 'visible', 'Visible area', d.notes.visible, d.area === 'visible'), shotOption('full', 'full', 'Full page', d.notes.full, d.area === 'full'));
  out.push(area);
  if (d.compare) {
    const seg = el('div', 'shot-seg'), mini = el('div', `shot-mini${d.panes === 'both' ? '' : ' single'}`); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Panes');
    seg.append(shotLink('both', '', '', 'Both, one image', d.panes === 'both'), shotLink('hostfile', '', '', 'New server', d.panes === 'hostfile'), shotLink('live', '', '', 'Live', d.panes === 'live'));
    for (const [side, badge, via] of [['hostfile', 'NEW SERVER', 'via Hostfile'], ['live', 'LIVE', 'public DNS']]) {
      if (d.panes !== 'both' && d.panes !== side) continue;
      const b = el('div', side); b.append(el('b', '', badge), el('span', '', d.ips[side] || 'IP not measured'), el('i', '', via)); mini.append(b);
    }
    out.push(el('div', 'shot-label', 'Panes'), seg, mini);
  }
  // Quality: how the picture is saved. Main keeps the choice; the note says what the chosen one gives.
  const quality = el('div', 'shot-seg three'), [kind, why] = SHOT_QUALITY[d.quality] || SHOT_QUALITY.sharp, qnote = el('p', 'shot-qnote');
  quality.setAttribute('role', 'radiogroup'); quality.setAttribute('aria-label', 'Quality');
  quality.append(shotLink('q-original', '', '', 'Original', d.quality === 'original'), shotLink('q-sharp', '', '', 'Sharp', d.quality === 'sharp'), shotLink('q-small', '', '', 'Small', d.quality === 'small'));
  qnote.append(el('b', '', kind), ` ${why}`); out.push(el('div', 'shot-label', 'Quality'), quality, qnote);
  if (d.area === 'full' && d.lazy) { const note = el('p', 'shot-lazy'); note.append(shotIcon('image'), el('span', '', `This page loads ${d.lazy} image${d.lazy === 1 ? '' : 's'} only when you scroll. Full page scrolls ${d.compare && d.panes === 'both' ? 'both pages' : 'the page'} to the bottom first, so they are in the picture.`)); out.push(note); }
  const actions = el('div', 'shot-actions'); actions.append(shotLink('download', 'mem-btn primary', 'download', 'Download'), shotLink('copy', 'mem-btn', 'copy', 'Copy'));
  return [...out, actions, el('p', 'shot-foot', 'Download saves the picture in Downloads, as JPEG (Sharp, Small) or PNG (Original). Copy puts it on the clipboard.')];
}
function shotCard(d) {
  const head = el('div', 'shot-head'); head.append(shotIcon('camera'), el('strong', '', 'Screenshot'));
  if (d.state === 'off') return [head, el('p', 'card-copy', d.message)];
  if (d.state === 'busy') return [head, ...shotProgress(d)];
  if (d.state === 'done' || d.state === 'error') return [head, ...shotResult(d)];
  return [head, ...shotChoose(d)];
}
// --- zoom pill in the address bar: − and +, the common steps, Reset. Links are zoom actions for the main process.
function zoomLink(action, className, label, target = 0) { const a = el('a', className, label); a.href = `https://card.invalid/zoom-${action}/${target}`; return a; }
function zoomCard(d) {
  const head = el('div', 'shot-head'), row = el('div', 'zoom-row'), steps = el('div', 'zoom-steps'), key = d.mac ? '⌘' : 'Ctrl';
  head.append(shotIcon('zoom'), el('strong', '', 'Zoom'));
  const minus = zoomLink('out', '', '−'), plus = zoomLink('in', '', '+');
  minus.setAttribute('aria-label', 'Zoom out'); plus.setAttribute('aria-label', 'Zoom in');
  row.append(minus, el('b', '', d.label), plus);
  for (const percent of [75, 90, 100, 110, 125, 150]) {
    const step = zoomLink('set', percent === d.percent ? 'on' : '', String(percent), percent);
    step.setAttribute('aria-label', `${percent}%`); step.setAttribute('aria-pressed', String(percent === d.percent)); steps.append(step);
  }
  const out = [head, el('div', 'shot-label', 'Size of the page'), row, steps];
  if (d.compare) { const note = el('p', 'zoom-both'); note.append(shotIcon('panes'), el('span', '', 'Compare: both panes zoom together, so they stay side by side.')); out.push(note); }
  const actions = el('div', 'shot-actions one'), keys = el('p', 'zoom-keys');
  actions.append(zoomLink('reset', 'mem-btn', 'Reset to 100%'));
  keys.append(el('kbd', '', `${key} +`), ' ', el('kbd', '', `${key} −`), ' zoom · ', el('kbd', '', `${key} 0`), ' reset');
  return [...out, actions, keys];
}
const cards = {
  shot: shotCard,
  zoom: zoomCard,
  // What an add-on found on the page of this tab (a tab without a domain rule has no Differences to show it in).
  addon(d) {
    const out = [];
    for (const item of d.items) {
      const head = el('div', 'card-head', item.name), list = el('div', 'addon-found');
      head.append(el('span', 'card-sub', item.summary));
      for (const line of item.lines) { const row = el('div', `addon-line${line.threat ? ' threat' : ''}`); row.append(el('small', '', line.label), el('b', '', line.text)); if (line.value) row.append(el('code', '', line.value)); list.append(row); }
      out.push(head, list);
      if (item.note) out.push(el('p', 'addon-note', item.note));
    }
    return out.length ? out : [el('div', 'card-head', 'Nothing found')];
  },
  cert(d) {
    const head = el('div', 'card-head ok-head', 'Certificate valid'), list = el('dl');
    row(list, 'Issued to', d.subject);
    row(list, 'Issuer', d.issuer, '', d.issuerName === d.issuer ? '' : d.issuerName);
    const dd = el('dd'); dd.append(el('span', '', day(d.expires)), el('span', `card-left${d.daysLeft < 15 ? ' soon' : ''}`, `${d.daysLeft} ${d.daysLeft === 1 ? 'day' : 'days'} left`), el('small', '', `valid since ${day(d.validFrom)}`));
    list.append(el('dt', '', 'Expires'), dd);
    return [head, list];
  },
  site(d) {
    const panes=d.panes, head=el('div','card-head','Connection & site comparison'), table=el('table','connection-comparison'), top=el('thead'), header=el('tr');
    header.append(el('th','','Details'));
    for(const p of panes) {const th=el('th'), badge=el('span','badge',p.route.label==='HOSTFILE'?'New server':'Live');th.className=p.route.label.toLowerCase();th.append(badge,el('small','',p.route.host||'New tab'));header.append(th);} top.append(header);table.append(top);
    const body=el('tbody'), unknown='Not detected';
    const add=(label,values,mark=false)=>{const tr=el('tr'), th=el('th','',label);th.scope='row';tr.append(th);values.forEach((value,i)=>{const td=el('td');td.append(value instanceof Node?value:el('span','',value||unknown));if(mark && values.length===2 && values[0] && values[1] && values[0]!==values[1])td.append(el('span','difference-mark','Different'));tr.append(td);});body.append(tr);};
    add('Connected IP',panes.map(p=>p.startPage?'Ready to browse':p.connection?.fromCache?'Not measured · cached':p.loading||p.error?'Not measured':p.connection?.ip||'Not measured'));
    add('Hostname (PTR)',panes.map(p=>!p.connection?.fromCache&&!p.loading&&!p.error?p.connection?.hostname||'Not measured':'Not measured'));
    add('Type', panes.map((p, index) => {
      const site = !p.loading && !p.error ? p.site || {} : {}, peer = panes[1-index];
      const other = peer && !peer.loading && !peer.error ? peer.site || {} : {}, box = el('div');
      const value = [site.platform,site.version].filter(Boolean).join(' ');
      box.append(el('span','',value || unknown));
      if (site.platform && other.platform && (site.platform !== other.platform || site.version && other.version && site.version !== other.version)) box.append(el('span','difference-mark','Different'));
      const stack=el('div','site-stack');
      for (const [label, key, versionKey] of [['Shop','shop','shopVersion'],['Builder','builder','builderVersion'],['Theme','theme',''],['Plugins','extras','']]) {
        const name = key === 'extras' ? (site.extras || []).join(' · ') : site[key], peerName = key === 'extras' ? (other.extras || []).join(' · ') : other[key];
        const line=el('span'); line.append(el('b','',label), name ? [name,site[versionKey]].filter(Boolean).join(' ') : unknown);
        if (name && peerName && (name !== peerName || versionKey && site[versionKey] && other[versionKey] && site[versionKey] !== other[versionKey])) line.append(el('span','difference-mark','Different'));
        stack.append(line);
      }
      box.append(stack); if(site.source) box.append(el('small','',`Detected from the ${site.source}`)); return box;
    }));
    add('PHP version',panes.map(p=>!p.loading&&!p.error?p.site?.php||'':''),true); add('Web server',panes.map(p=>!p.loading&&!p.error?p.site?.server||'':''),true);
    add('SSL certificate',panes.map(p=>{const box=el('div'), cached=p.connection?.fromCache, cert=!p.loading&&!p.error&&!cached?p.route.certificate:null;let status=p.startPage||p.loading?'Certificate not measured':!p.url.startsWith('https:')?'No TLS':cached?'Certificate not rechecked':p.error?/CERT|SSL/i.test(p.error)?'Strict certificate error':'Certificate not measured':cert?.verified?'SSL valid':cert?.skipped&&p.route.untrusted?'Not trusted · you continued':cert?.skipped?'SSL skipped':p.route.ssl==='SSL checks off'?'Verification skipped · not measured':'Certificate not measured';
      const statusNode=el(cert?.verified?'a':'span',`ssl-chip ${cert?.verified?'strict':'skipped'}`,status);if(cert?.verified)statusNode.href=`https://card.invalid/cert/${p.id}`;box.append(statusNode);if(cert&&!cached&&!p.loading&&!p.error){box.append(' ',cert.issuer||'Issuer unavailable');if(cert.expires)box.append(el('small','',`Expires ${day(cert.expires)}${cert.validFrom?' · valid since '+day(cert.validFrom):''}`));}else if(cached)box.append(el('small','','No fresh certificate verification from cached HTML.'));return box;}));
    add('Page source',panes.map(p=>{const box=el('div');box.append(el('span','',p.connection?.fromCache?'Browser cache':p.connection?'Network':'Not measured'));if(p.connection?.status)box.append(el('small','',`HTTP ${p.connection.status}${Number.isFinite(p.connection.ms)?' · '+Math.round(p.connection.ms)+' ms':''}`));return box;}));
    table.append(body);return [head,table,el('p','comparison-note','Detected details, side by side. Unknown values have not been observed. Orange marks different detected versions. Click a verified certificate for its original detail card.')];
  },
  cache(d) {
    const link=el('a','mem-btn','Reload without browser cache');link.href=`https://card.invalid/hard-reload/${d.id}`;
    return [el('div','card-head','Browser cache'),el('p','card-copy','This page was served from the browser cache. No fresh connection IP, PTR lookup or certificate verification is available. Reload without cache to measure the current server.'),link];
  },
  'cache-menu'() {
    const actions=el('div','card-actions');for(const [action,label] of [['clear-cache','Clear cache & reload both panes'],['hard-reload','Reload active pane without cache'],['clear-site-data','Clear site data…']]){const a=el('a','mem-btn',label);a.href=`https://card.invalid/${action}/0`;actions.append(a);}
    return [el('div','card-head','Clear cache'),el('p','card-copy','Clear browser and DNS cache, then reload the visible pages. Cookies and sign-ins are kept. Clear site data removes cookies and storage for the active site.'),actions];
  },
  tools(d) {
    const actions=el('div','card-actions');for(const [action,label] of [['devtools',d.open?'Close Developer Tools':'Open Developer Tools'],['dock-bottom','Dock below'],['dock-left','Dock left'],['dock-right','Dock right']]){const a=el('a','mem-btn',label);a.href=`https://card.invalid/${action}/0`;actions.append(a);}return [el('div','card-head','Developer Tools'),el('p','card-copy','Inspect the active website. F12 toggles the inspector. Drag its border to resize.'),actions];
  },
  about(d) {
    const actions=el('div','card-actions maker-links');for(const [action,label] of [['maker-website','SolutionMAX'],['maker-github','GitHub'],['maker-coffee','Buy me a coffee']]){const a=el('a','mem-btn',label);a.href=`https://card.invalid/${action}/0`;if(action==='maker-coffee')a.className+=' coffee';actions.append(a);}return [el('div','card-head',`Dioptra ${d.version}`),el('p','card-copy','Same domain. Different server. Created by SolutionMAX.'),actions];
  },
  dns(d) {
    const head = el('div', 'card-head dns-head', 'DNS records'), refresh = el('a', 'mem-btn', 'Refresh'), foot = el('div', 'mem-foot dns-foot');
    refresh.href = 'https://card.invalid/refresh/0';
    if (d.state === 'loading') {
      const busy = el('div', 'dns-busy'); busy.append(el('span', 'spinner'), `Asking DNS for ${d.host}`);
      head.append(el('span', 'card-sub', 'public DNS · what visitors get'));
      return [head, busy];
    }
    const parts = [head], unknown = d.status === 'notfound';
    if (d.status === 'failed') parts.push(dnsNotice('red', 'DNS could not be asked (', d.code || 'no answer', '). Check the connection and try Refresh.'));
    else if (unknown && !d.table) parts.push(dnsNotice('red', 'No records. Public DNS does not know ', d.host, ', so visitors cannot reach it yet.'));
    if (d.table) {
      const n = d.table.differing, expected = d.table.groups.some(group => group.rows.some(row => row.status === 'expected'));
      head.append(el('span', 'card-sub', d.host), el('span', `pill push ${n ? 'amber' : 'green'}`, n ? `${n} record ${n === 1 ? 'type differs' : 'types differ'}` : 'No differences'));
      if (unknown) parts.push(dnsNotice('red', 'Public DNS does not know ', d.host, ' yet. Only the server from your rule has records.'));
      parts.push(dnsTable(d));
      foot.append(el('span', '', `Asked ${clock(d.askedAt)}${expected ? ' · the address is expected to differ during a migration' : ''}`), refresh);
    } else {
      head.append(el('span', 'card-sub', 'public DNS · what visitors get'));
      if (d.status !== 'failed' && d.server === 'noanswer') parts.push(dnsNotice('', '', d.ruleIP, ' does not answer DNS questions, so there is nothing to compare. Below is public DNS.'));
      if (d.status !== 'failed' && d.server === 'nozone') parts.push(dnsNotice('', '', d.ruleIP, ' answers DNS questions but has no records for this domain, so there is nothing to compare. Below is public DNS.'));
      if (d.status === 'ok' && !d.groups.length) parts.push(el('p', 'dns-none', 'This name exists, but has no A, AAAA, CNAME, MX, TXT or NS records.'));
      parts.push(...dnsList(d.groups));
      foot.append(el('span', '', `System resolver · asked ${clock(d.askedAt)}`), refresh);
    }
    return [...parts, foot];
  },
  memory(d) {
    const head = el('div', 'card-head', 'Memory'), summary=el('div','memory-summary'), amount=el('div');amount.append(el('small','','TOTAL DIOPTRA'),el('strong','',size(d.total)));summary.append(amount,el('small','',`${d.tabs} tabs · ${d.processes} processes`));
    const top = Math.max(1, ...d.rows.map(r => r.kb), d.claude, d.rest);
    const line = (label, title, kb, className, href) => {
      const item = el(href ? 'a' : 'div', `mem-row ${className}`), name = el('span', 'mem-title');
      if (href) item.href = href;
      if (label) name.append(el('small', '', label));
      name.append(title);
      const meter = el('span', 'mem-meter'), fill = el('b'); fill.style.width = `${Math.max(2, Math.round(kb / top * 100))}%`; meter.append(fill);
      item.append(name, el('span', 'mem-size', size(kb)), meter);
      return item;
    };
    const tabs = el('div', 'mem-list'), system = el('div', 'mem-list mem-sep');
    // Only mark a tab as heavy when it clearly stands out, not simply because it is the largest.
    d.rows.forEach((r, i) => tabs.append(line(r.label, r.more ? `${r.title} +${r.more} more` : r.title, r.kb, i === 0 && d.rows.length > 1 && r.kb > 307200 ? 'hot' : '', `https://card.invalid/activate/${r.id}`)));
    if (d.claude) system.append(line('', 'Claude panel', d.claude, 'sys'));
    system.append(line('', 'Dioptra itself (window, graphics, network)', d.rest, 'sys'));
    const foot = el('div', 'mem-foot'); foot.append(el('span', '', `${d.tabs} ${d.tabs === 1 ? 'tab' : 'tabs'} · ${d.processes} processes · updates every 5 s`));
    if (d.rows[0]) { const reload = el('a', 'mem-btn', 'Reload heaviest tab'); reload.href = `https://card.invalid/reload/${d.rows[0].id}`; foot.append(reload); }
    return [head, summary, el('div','memory-section','WEBSITE PROCESS GROUPS'), tabs, system, foot];
  }
};
// The memory card refreshes every 5 s. Replacing a row between press and release loses the click, so a refresh
// that arrives while the pointer is down is skipped; the next one follows 5 s later.
let pressed = false, shown = '';
addEventListener('pointerdown', () => { pressed = true; }, true);
for (const type of ['pointerup', 'pointercancel', 'blur']) addEventListener(type, () => { pressed = false; }, true);
// eslint-disable-next-line no-unused-vars
function render(data) {
  if (pressed && data.kind === 'memory' && shown === 'memory') return Promise.resolve(document.body.getBoundingClientRect().height);
  shown = data.kind;
  // A card that is taller than the window gets the class back from the main process and scrolls.
  document.documentElement.classList.remove('tall');
  document.body.replaceChildren(...cards[data.kind](data));
  // Measure after the fonts are in: the fallback font is lower and would cut off the last line.
  return document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => done(document.body.getBoundingClientRect().height))));
}
