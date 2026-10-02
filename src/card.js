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
    const head = el('div', 'card-head', 'What this site runs on'), list = el('dl');
    head.append(el('span', 'card-sub', 'detected from this page'));
    row(list, 'Platform', d.platform, d.version, d.platform && `from the ${d.source}`);
    row(list, 'Shop', d.shop, d.shopVersion);
    row(list, 'Theme', d.theme);
    if (d.extras?.length) { const dd = el('dd', 'card-tags'); for (const name of d.extras) dd.append(el('span', '', name)); list.append(el('dt', '', 'Also found'), dd); }
    if (d.php) row(list, 'PHP', ' ', d.php, 'from the X-Powered-By header');
    row(list, 'Web server', d.server);
    return [head, list];
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
    const head = el('div', 'card-head', 'Memory'); head.append(el('span', 'mono', size(d.total)));
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
    return [head, tabs, system, foot];
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
