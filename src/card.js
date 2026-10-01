// Renders one small card (certificate, site platform or memory). The main process calls render(data) and gets the
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
  document.body.replaceChildren(...cards[data.kind](data));
  // Measure after the fonts are in: the fallback font is lower and would cut off the last line.
  return document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => done(document.body.getBoundingClientRect().height))));
}
