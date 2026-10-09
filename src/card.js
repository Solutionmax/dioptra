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
const cards = {
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
    add('SSL certificate',panes.map(p=>{const box=el('div'), cached=p.connection?.fromCache, cert=!p.loading&&!p.error&&!cached?p.route.certificate:null;let status=p.startPage||p.loading?'Certificate not measured':!p.url.startsWith('https:')?'No TLS':cached?'Certificate not rechecked':p.error?/CERT|SSL/i.test(p.error)?'Strict certificate error':'Certificate not measured':cert?.verified?'SSL valid':cert?.skipped?'SSL skipped':p.route.ssl==='SSL checks off'?'Verification skipped · not measured':'Certificate not measured';
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
// eslint-disable-next-line no-unused-vars
function render(data) {
  // A card that is taller than the window gets the class back from the main process and scrolls.
  document.documentElement.classList.remove('tall');
  document.body.replaceChildren(...cards[data.kind](data));
  // Measure after the fonts are in: the fallback font is lower and would cut off the last line.
  return document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => done(document.body.getBoundingClientRect().height))));
}
