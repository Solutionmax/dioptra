/* Whole site (1.4.0-beta.4): which pages to compare, and what the results of all pages say together. Pure: main fetches
   and compares, this picks the pages from a sitemap or a pasted list and folds the parts of every page into one answer:
   what is the same on (nearly) every page is said once, what only some pages have is listed under those pages.
   Everything here reads what a server sent: one pass, indexOf, no pattern that looks ahead for an end. */
const { diffParts, nOf } = require('./differences-parts.js');
const { bareHost } = require('./host-budget.cjs');
const { readPage } = require('./html-read.cjs');
const { HIDDEN } = require('./addons.cjs');
const { isFirstParty } = require('./differences.cjs');
const DEFAULT_PAGES = 20, MAX_PAGES = 50, PAGE_CHOICES = [5, 10, 20, 50];
// A sitemap is read up to 2 MB and 5000 addresses, an index one level deep and at most 5 of its sitemaps.
const SITEMAP_BODY = 2 * 1024 * 1024, SITEMAP_ENTRIES = 5000, SITEMAP_CHILDREN = 5, PASTE_MAX = 20000;
const SITEMAP_PATHS = ['/wp-sitemap.xml', '/sitemap.xml', '/sitemap_index.xml'];
const NOT_A_PAGE = /\.(xml|gz|pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|css|js|json|txt|mp4|mp3|woff2?)$/i;

// The title of a page, as its reading (html-read.cjs) found it; url: the address the page was read with, so it is read once.
// Marks that hide or turn text around are left out: the list shows what is there.
const shown = text => String(text).replace(HIDDEN, '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
const pageTitle = (body, url) => shown(readPage(body || '', url).title);
// Sitemap lines of a robots.txt, in order. Line by line, no pattern that can run long on a hostile file.
function sitemapsInRobots(body) {
  const out = [];
  for (const line of String(body || '').slice(0, 200000).split('\n').slice(0, 3000)) {
    const at = line.indexOf(':');
    if (at > 0 && line.slice(0, at).trim().toLowerCase() === 'sitemap' && out.length < 5) { const value = line.slice(at + 1).trim(); if (value) out.push(value); }
  }
  return out;
}
// The XML entities an address can hold: named ones and numbers (&#38; &#x26;).
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = text => text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/gi, (all, name) => {
  if (name[0] !== '#') return NAMED[name.toLowerCase()];
  const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 31 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
});
// The addresses in a sitemap or a sitemap index: the loc elements directly under a url or a sitemap element, whatever
// their case or namespace prefix (the loc of an image or a video inside a url is not a page). One walk over the text
// itself (no lower-cased copy, whose positions can differ), linear and capped. An index has a sitemapindex element.
const XML_SPACE = new Set([' ', '\t', '\n', '\r']);
function parseSitemap(xml) {
  const text = String(xml || '').slice(0, SITEMAP_BODY), n = text.length, urls = [], stack = [];
  const local = name => name.slice(name.lastIndexOf(':') + 1).toLowerCase();
  let at = 0, capped = false, index = false;
  while (at < n) {
    const open = text.indexOf('<', at); if (open < 0) break;
    if (text.startsWith('<!--', open)) { const end = text.indexOf('-->', open + 4); if (end < 0) break; at = end + 3; continue; }
    if (text.startsWith('<![CDATA[', open)) { const end = text.indexOf(']]>', open + 9); if (end < 0) break; at = end + 3; continue; }
    if (text[open + 1] === '?' || text[open + 1] === '!') { const end = text.indexOf('>', open); if (end < 0) break; at = end + 1; continue; }
    // The end of the tag: a ">" inside a quoted attribute value is not it.
    let close = open + 1, quote = '';
    for (; close < n; close++) { const c = text[close]; if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; }
    if (close >= n) break;
    const ending = text[open + 1] === '/', from = open + (ending ? 2 : 1);
    let stop = from; while (stop < close && stop - from < 60 && !XML_SPACE.has(text[stop]) && text[stop] !== '/') stop++;
    const name = local(text.slice(from, stop));
    at = close + 1;
    if (ending) { const i = stack.lastIndexOf(name); if (i >= 0) stack.length = i; continue; }
    if (name === 'sitemapindex') index = true;
    if (text[close - 1] === '/') continue;
    const parent = stack[stack.length - 1];
    if (stack.length < 16) stack.push(name);
    if (name !== 'loc' || (parent !== 'url' && parent !== 'sitemap')) continue;
    const end = text.indexOf('<', at); if (end < 0) break;
    if (urls.length >= SITEMAP_ENTRIES) { capped = true; break; }
    let value = text.slice(at, end);
    if (text.startsWith('<![CDATA[', end)) { const done = text.indexOf(']]>', end); if (done < 0) break; value = text.slice(end + 9, done); at = done + 3; } else at = end;
    value = decodeXml(value.trim());
    if (value && value.length < 2000) urls.push(value);
  }
  return { index, urls, capped };
}
const TRACKING = /^(utm_[a-z0-9_]*|fbclid|gclid)$/i;
// One address as a page of this site: http(s), the host of the home page (with or without www), no fragment. The host
// name and scheme of the home page are kept, so the domain rule of the tab applies to every page.
function pageOf(value, home) {
  let url, base;
  try { base = new URL(home); url = new URL(String(value).trim(), base); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || bareHost(url.hostname) !== bareHost(base.hostname) || (url.port || '') !== (base.port || '')) return null;
  url.protocol = base.protocol; url.hostname = base.hostname; url.hash = '';
  // Where the visitor came from is not part of the page.
  for (const name of [...new Set(url.searchParams.keys())]) if (TRACKING.test(name)) url.searchParams.delete(name);
  return url.href;
}
// A path without the slashes at its end, counted from the end: a pattern for them is quadratic on a path of many
// slashes with a letter after them (a hostile sitemap).
function trimSlashes(path) { let end = path.length; while (end > 0 && path[end - 1] === '/') end--; return path.slice(0, end); }
// The pages to compare: the home page first, then the list in its own order. A page counts once: /about and /about/
// are one page. A path with a query and the same path without one are one page too (the one without is kept); two
// different queries of one path (?page=2, ?page=3) are two pages. Collecting stops at the limit.
// other: addresses that are not a page of this site (another site, a file); more: the list went on after the limit.
function pickPages(urls, home, limit = DEFAULT_PAGES) {
  const max = Math.min(MAX_PAGES, Math.max(1, Number(limit) || DEFAULT_PAGES));
  const pathOfPage = page => trimSlashes(new URL(page).pathname) || '/';
  const first = pageOf('/', home), out = [first], plain = new Map([[pathOfPage(first), 0]]), queried = new Map(), exact = new Set();
  let other = 0, more = false;
  for (const value of urls) {
    const page = pageOf(value, home);
    if (!page || NOT_A_PAGE.test(new URL(page).pathname)) { other++; continue; }
    const path = pathOfPage(page), search = new URL(page).search;
    if (plain.has(path) || (search && exact.has(path + search))) continue;
    // The path without a query takes the place of the first one that had a query.
    if (!search && queried.has(path)) { const at = queried.get(path); exact.delete(path + new URL(out[at]).search); out[at] = page; plain.set(path, at); continue; }
    if (out.length >= max) { more = true; break; }
    if (search) { exact.add(path + search); if (!queried.has(path)) queried.set(path, out.length); } else plain.set(path, out.length);
    out.push(page);
  }
  return { pages: out, other, more };
}
// A list the user pasted: addresses or paths, one per line or separated by spaces or commas. refused: how many words
// are not an address of this site, with the first few as a sample.
function pastedPages(text, home) {
  let raw = String(text || '');
  // Too long: cut at the last whole word, never in the middle of one.
  if (raw.length > PASTE_MAX) { raw = raw.slice(0, PASTE_MAX); const last = Math.max(raw.lastIndexOf(' '), raw.lastIndexOf('\n'), raw.lastIndexOf(','), raw.lastIndexOf('\t')); raw = raw.slice(0, Math.max(0, last)); }
  const words = raw.split(/[\s,]+/).filter(Boolean), wanted = [], refused = [];
  // A word with a scheme is an address and must be http(s) of this site; anything else is read as a path.
  for (const word of words) { const value = /^[a-z][a-z0-9+.-]*:/i.test(word) || word.startsWith('/') ? word : `/${word}`; if (/^(https?:|\/)/i.test(value) && pageOf(value, home)) wanted.push(value); else refused.push(word.slice(0, 80)); }
  const picked = pickPages(wanted, home, MAX_PAGES);
  return { pages: picked.pages, refused: refused.length, sample: refused.slice(0, 5), more: picked.more };
}

/* A redirect, judged from the address that sent it (1.4.0-beta.6: one rule for a whole-site run, a single comparison and
   the scan of a tab). Followed only within the site: the same host name (www or not), the same scheme and port, no
   credentials, and on the new server only a name that has a domain rule (ruled). http to https on the standard ports is
   the one change of scheme that stays inside. Anything else is not asked: left = { host, own }, host as it is shown
   (with the port or scheme when that is what differs, the scheme alone for a target that is not http), own: another
   address of the same site. */
function redirectStep(from, to, ruled = () => true) {
  let a, b; try { a = new URL(from); b = new URL(to); } catch { return { left: { host: 'an address that cannot be read', own: false } }; }
  if (!['http:', 'https:'].includes(b.protocol)) return { left: { host: `a "${shown(b.protocol).slice(0, 24)}" address`, own: false } };
  const port = u => u.port || (u.protocol === 'https:' ? '443' : '80'), sameHost = bareHost(b.hostname) === bareHost(a.hostname);
  const upgrade = a.protocol === 'http:' && b.protocol === 'https:' && port(a) === '80' && port(b) === '443';
  const inside = sameHost && !b.username && !b.password && (a.protocol === b.protocol ? port(a) === port(b) : upgrade);
  if (inside && ruled(b.hostname)) return { follow: b.href };
  return { left: { host: !sameHost ? b.hostname : a.protocol !== b.protocol ? `${b.protocol}//${b.host}` : b.host, own: sameHost || isFirstParty(b.hostname.toLowerCase(), a.hostname.toLowerCase()) } };
}
// What it means that a server sent the page somewhere that was not followed. both: the two servers send it to the same
// place, so there is nothing of this site to compare. Else the findings: the new server alone is what a hijack looks like.
function leftFindings(hl, ll) {
  if (hl && ll && hl.host === ll.host) return { both: hl, findings: [] };
  if (hl) return { findings: [hl.own ? { state: 'check', text: `The new server sends this page to ${hl.host}, another address of this site, ${ll ? `Live to ${ll.host}` : 'Live does not'}. Not followed` }
    : { state: 'fix', text: `The new server sends this page to ${hl.host}, ${ll ? `Live sends it to ${ll.host}` : 'Live does not'}` }] };
  if (ll) return { findings: [{ state: 'check', text: `Live sends this page to ${ll.host}${ll.own ? ', another address of this site' : ''}, the new server does not` }] };
  return { findings: [] };
}

const RANK = { fix: 4, check: 3, info: 2, ok: 1, none: 0 };
const worst = states => states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'none');
// The path as the list shows it: readable, unless reading it that way would show marks that hide or turn text around.
const SHOWS_WRONG = /[\u0000-\u001f\u007f\u2028\u2029]/;
function pathOf(url) {
  try { const u = new URL(url), raw = u.pathname + u.search, nice = decodeURI(u.pathname) + u.search; return nice.replace(HIDDEN, '') !== nice || SHOWS_WRONG.test(nice) ? raw : nice; } catch { return shown(url); }
}
// What one page says, as small as the window needs it: the parts of Differences for that page. Files and Speed are
// measured in a real page load, which a whole-site run does not do for every page.
// extra: findings about the page itself that the run found (a redirect to another site).
function pageModel({ url, title = '', report, liveReason = null, checks = null, addonTabs = [], extra = [] }) {
  const model = diffParts({ differences: { report, liveReason }, checks, addonTabs, files: null, speed: null });
  const failed = [...extra, ...model.rest.filter(f => f.severity === 'high' && !f.calm).map(f => ({ text: String(f.text || '').replace(/\.$/, ''), state: 'fix' }))];
  return { url, path: pathOf(url), title: shown(title).slice(0, 120), failed,
    parts: model.parts.filter(p => p.id !== 'files' && p.id !== 'speed').map(({ id, group, name, what, state, tag, line, all, addon, by, scope, missing }) => ({ id, group, name, what, state, tag, line, all, addon, by, scope, missing })) };
}
// "4 old addresses in the page" and "300 old addresses in the page" are one finding: for the site, the range.
function rangeText(texts) {
  const list = [...new Set(texts)];
  if (list.length < 2) return list[0] || '';
  const numbers = list.map(t => Number((/^(\d+) /.exec(t) || [])[1])).filter(Number.isFinite);
  if (numbers.length !== list.length) return list[0];
  const low = Math.min(...numbers), high = Math.max(...numbers), longest = list[numbers.indexOf(high)];
  return longest.replace(/^\d+ /, `${low} to ${high} `);
}
/* pages: page models in the order they were compared, the home page first. onceChecks: the texts of the points of
   Checks that are asked once for the site (robots.txt, sitemap, standard addresses); only the home page has them.
   A point is the same finding on another page when its part, its weight and its key (or text) are the same.
   - A finding that is asked once, or found on more than half of the pages, is said once for the site ("wide").
   - A finding on fewer pages is listed under each of those pages.
   - A finding about the page itself (own: its status, a redirect, a failed request) is listed under every page that
     has it, however many, and is also said for the site when it is wide. One exception: the same redirect difference
     on every page (http to https, say) is said once for the site.
   - A script or frame from another site follows the first two rules: on more than half of the pages it is one finding
     for the site, with the pages it is on (decided for 1.4.0-beta.6: twenty rows that say the same hide the one page
     that has something of its own).
   Every part carries found: each finding with the pages it is on, so nothing is merged away. */
function siteResult(pages, { onceChecks = [] } = {}) {
  const n = pages.length, onceText = new Set(onceChecks), order = [], byId = new Map(), own = new Map(pages.map(p => [p.url, [...p.failed]]));
  const pathFor = new Map(pages.map(p => [p.url, p.path]));
  for (const page of pages) for (const part of page.parts) { if (!byId.has(part.id)) { byId.set(part.id, []); order.push(part.id); } byId.get(part.id).push({ page, part }); }
  const parts = order.map(id => {
    const seen = byId.get(id), first = seen[0].part, once = first.scope === 'site' && Boolean(first.addon), points = new Map();
    for (const { page, part } of seen) {
      // A part that differs without points of its own (HTML lines, headers) counts as one point per state.
      // A part without a result on this page (state none) has nothing to add.
      const list = part.state === 'none' ? [] : part.all.length ? part.all : ['info', 'fix', 'check'].includes(part.state) ? [{ text: '', state: part.state }] : [];
      for (const point of list) {
        const key = `${point.state}|${point.key ?? point.text}`, hit = points.get(key) || { state: point.state, own: Boolean(point.own), keyed: point.key !== undefined, pages: [], texts: new Map(), once: once || (id === 'checks' && onceText.has(point.text)) };
        hit.pages.push(page.url); hit.texts.set(page.url, point.text); points.set(key, hit);
      }
    }
    const all = [...points.values()].map(p => ({ ...p, text: rangeText([...p.texts.values()]), wide: p.once || p.pages.length * 2 > n }));
    const wide = all.filter(p => p.wide), few = all.filter(p => !p.wide), judged = seen.filter(x => x.part.state !== 'none');
    // Under its pages: what is not wide, and what is about the page itself even when it is.
    const everywhere = p => p.keyed && n > 1 && p.pages.length >= n;
    const mine = all.filter(p => (p.state === 'fix' || p.state === 'check') && !p.once && (!p.wide || (p.own && !everywhere(p))));
    for (const point of mine) for (const url of point.pages) own.get(url).push({ text: point.texts.get(url) || `${first.name}: ${point.state === 'fix' ? 'needs a fix' : 'differs'}`, state: point.state });
    wide.sort((a, b) => RANK[b.state] - RANK[a.state] || b.pages.length - a.pages.length);
    const named = wide.filter(p => p.text);
    const where = (list, state) => {
      const top = list.filter(p => p.state === state);
      if (!top.length) return '';
      if (top.every(p => p.once)) return 'Once for the site';
      const most = Math.max(...top.filter(p => !p.once).map(p => p.pages.length));
      return most >= n ? (n === 1 ? 'On the page' : `On all ${n} pages`) : `On ${most} of ${nOf(n, 'page')}`;
    };
    // For the site: the worst of what is site-wide. For the menu: the worst of everything, also what one page has.
    const wideState = wide.length ? worst(wide.map(p => p.state)) : '', state = all.length ? worst(all.map(p => p.state)) : judged.length ? 'ok' : 'none';
    const sample = (seen.find(x => x.part.state === (wideState || state)) || seen[0]).part;
    const fixes = named.filter(p => p.state === 'fix').length, checksToo = named.filter(p => p.state === 'check').length;
    const wideTag = id === 'checks' && (fixes || checksToo) ? (fixes ? `${fixes} failed` : `${checksToo} ${checksToo === 1 ? 'differs' : 'differ'}`) : sample.tag;
    const fromFew = all.length > 0 && RANK[state] > RANK[wideState || 'none'], fewPages = new Set(few.filter(p => p.state === state).flatMap(p => p.pages)).size;
    return { id, group: first.group, name: first.name, what: first.what, addon: first.addon, by: first.by, scope: first.scope, line: sample.line,
      state, tag: fromFew ? nOf(fewPages, 'page') : state === 'ok' ? (sample.state === 'ok' ? sample.tag : 'Fine') : state === 'none' ? sample.tag : wideTag,
      where: once ? 'Once for the site' : state === 'none' ? (seen.some(x => x.part.missing) ? 'No result' : 'Not compared') : state === 'ok' ? (n === 1 ? 'Fine on the page' : judged.length >= n ? `Fine on all ${n} pages` : `Fine on ${judged.length} of ${nOf(n, 'page')}`) : fromFew ? `On ${fewPages} of ${nOf(n, 'page')}` : where(wide, state),
      wideState, wideTag, wideWhere: once ? 'Once for the site' : where(wide, wideState),
      tops: named.slice(0, 3).map(p => p.text), more: Math.max(0, named.length - 3), missing: state === 'none' && seen.some(x => x.part.missing),
      found: [...wide, ...few].map(p => ({ text: p.text, state: p.state, wide: p.wide, once: p.once, pages: p.once ? [] : p.pages.map(url => pathFor.get(url)) })) };
  });
  // The most serious finding of a page comes first in its row (what the run itself found about the page, such as a
  // redirect to another site, before the findings of the parts), so it is never behind "and 1 more".
  const rows = pages.map((page, at) => {
    const mine = own.get(page.url).sort((a, b) => RANK[b.state] - RANK[a.state]), fix = mine.filter(p => p.state === 'fix').length;
    return { url: page.url, path: page.path, title: page.title, state: fix ? 'fix' : mine.length ? 'check' : 'ok', tag: fix ? `${fix} to fix` : mine.length ? `${mine.length} to check` : '',
      text: mine.length ? `${mine[0].text}${mine.length > 1 ? `, and ${mine.length - 1} more` : ''}` : 'Nothing of its own', count: mine.length, at };
  });
  // Red before amber, then the page with most findings, then the order of the list.
  const byWeight = (a, b) => RANK[b.state] - RANK[a.state] || b.count - a.count || a.at - b.at, bare = ({ count: _count, at: _at, ...row }) => row;
  return { parts, own: rows.filter(r => r.state !== 'ok').sort(byWeight).map(bare), rest: rows.filter(r => r.state === 'ok').map(bare) };
}

module.exports = { pageTitle, sitemapsInRobots, parseSitemap, pageOf, pickPages, pastedPages, pageModel, siteResult, pathOf, redirectStep, leftFindings, DEFAULT_PAGES, MAX_PAGES, PAGE_CHOICES, SITEMAP_BODY, SITEMAP_CHILDREN, SITEMAP_PATHS };
