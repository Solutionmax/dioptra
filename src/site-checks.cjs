// Checks tab: what a migration often breaks without the page looking different. (1) Search engines told not to index
// the site, (2) old addresses left in the page of the new server, (3) standard addresses that answer differently than
// on Live. Pure logic: main.cjs fetches anonymously through the same routes as Differences and passes plain results.
const { STATUS_CODES } = require('node:http');
const { isFirstParty } = require('./differences.cjs');
const { readPage, stripComments } = require('./html-read.cjs');
const { sitemapsInRobots } = require('./site-scope.cjs');
const { serverKind } = require('./speed.cjs');

const STAGING = /^(staging|stage|dev|test|old)\d*\./;
const MAX_ROWS = 40, MAX_TEXT = 300, MAX_VALUES = 3000;
const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const clean = (text, max = MAX_TEXT) => String(text ?? '').replace(CONTROL, ' ').trim().slice(0, max);

const decode = value => String(value).replace(/&amp;/gi, '&').replace(/&#0*38;/g, '&').replace(/&#x0*2f;/gi, '/').trim();
function absolute(value, base) {
  try { const u = new URL(String(value).trim(), base); return /^https?:$/.test(u.protocol) && u.hostname ? u : null; } catch { return null; }
}
const wwwTwin = host => (host.startsWith('www.') ? host.slice(4) : `www.${host}`);
const bareIP = ip => String(ip || '').replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').toLowerCase();
const noindex = value => /\b(noindex|none)\b/i.test(value || '');
const nofollow = value => /\b(nofollow|none)\b/i.test(value || '');
const tidy = value => clean(value).toLowerCase().split(',').map(s => s.trim()).filter(Boolean).join(', ');

// The parts of one HTML document the checks need, from the one reading of the page (html-read.cjs): attribute values are
// decoded as a browser decodes them, and an address is already whole when the page has a <base href>.
function pageFacts(html, pageURL) {
  const page = readPage(html || '', pageURL);
  return { robots: page.robots.map(v => clean(v)).filter(Boolean).join(', '), canonical: page.canonical ? absolute(page.canonical, page.base)?.href || clean(page.canonical) : '', tags: page.tags, cut: page.cut,
    wordpress: /wordpress/i.test(page.generator) || /\/wp-(content|includes)\//i.test(String(html || '')) };
}
function describe(t) {
  const file = () => { try { return new URL(t.value, 'https://x.invalid/').pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; } };
  if (t.tag === 'a') return `link${t.label ? ` "${t.label}"` : ''}${t.where}`;
  if (t.tag === 'form') return `form action${t.where}`;
  const name = file();
  return `${t.tag} ${t.attr}${name ? `, ${name}` : ''}${t.where}`;
}

// Addresses in the Hostfile HTML that Live does not have and that point back at the old setup: the Live server IP,
// a temporary URL (/~user/ on an IP, on the site itself or on the old server's own name: a /~user/ page elsewhere, such
// as a university home page, is just a link), another copy of the same site (staging., dev., test., or a host with a
// disabled rule or a rule to another server), and http:// links to the site itself on an https page.
const isIP = host => /^\d+(\.\d+){3}$/.test(host) || host.includes(':');
function oldAddresses({ hostfileHTML, liveHTML = '', pageURL, oldIP = '', oldHosts = [], copies = [] }) {
  let page; try { page = new URL(pageURL); } catch { return []; }
  const host = page.hostname.toLowerCase(), old = bareIP(oldIP), known = new Set(copies.map(h => String(h).toLowerCase())), oldNames = new Set(oldHosts.map(h => String(h).toLowerCase()));
  const facts = pageFacts(hostfileHTML, pageURL), rows = [], seen = new Set();
  const live = `${liveHTML || ''}\n${String(liveHTML || '').replace(/\\\//g, '/')}`; // Live keeps escaped addresses in scripts too
  const add = (kind, found, url, where, from, why) => {
    const key = `${kind} ${found}`;
    if (seen.has(key) || rows.length >= MAX_ROWS) return;
    seen.add(key); rows.push({ kind, found: clean(found), url: clean(url, 2000), where: clean(where), from: clean(from, 2000), why });
  };
  // Each value is looked up in the Live page: every distinct value once, and at most MAX_VALUES of them.
  // An address in a tag is decoded, so it is looked up among the decoded addresses of Live too.
  const tried = new Set(), liveValues = new Set(pageFacts(liveHTML, pageURL).tags.map(t => t.value));
  const consider = (value, where, decoded = value) => {
    if (tried.has(value) || tried.size >= MAX_VALUES || rows.length >= MAX_ROWS) return;
    tried.add(value);
    if (liveValues.has(value) || liveValues.has(decoded) || live.includes(value)) return;
    const u = absolute(decoded, pageURL);
    if (!u) return;
    const h = u.hostname.toLowerCase(), origin = `${u.protocol}//${u.host}`;
    const tilde = isIP(bareIP(h)) || isFirstParty(h, host) || oldNames.has(h) ? (u.pathname.match(/^\/~[^/]+\//) || [''])[0] : '';
    if (old && bareIP(h) === old) add('ip', old, u.href, where, `${origin}${tilde.replace(/\/$/, '')}`, 'Loads from the old server and breaks when it goes away');
    if (tilde) add('tilde', tilde, u.href, where, `${origin}${tilde.replace(/\/$/, '')}`, 'Temporary URL of the old hosting account');
    if (h !== host && h !== wwwTwin(host) && isFirstParty(h, host) && (STAGING.test(h) || known.has(h))) add('staging', h, u.href, where, origin, 'Visitors and Google land on the other copy');
    if (u.protocol === 'http:' && page.protocol === 'https:' && (h === host || h === wwwTwin(host))) add('http', `${origin}`, u.href, where, origin, 'Own site over http: an extra redirect on every click');
  };
  for (const t of facts.tags) consider(t.value, describe(t));
  // Scripts and JSON keep addresses too, often with escaped slashes ("https:\/\/198.51.100.24\/~user\/").
  const text = stripComments(hostfileHTML || '').replace(/\\\//g, '/');
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) consider(m[0], 'in a script or text of the page', decode(m[0]));
  const rank = { ip: 0, tilde: 1, staging: 2, http: 3 };
  return rows.sort((a, b) => rank[a.kind] - rank[b.kind]);
}
// Shell quoting for a copied command: single quotes, a single quote inside becomes '\''.
const shellQuote = value => `'${String(value).replace(CONTROL, '').replace(/'/g, "'\\''")}'`;
const searchReplace = (from, to) => `wp search-replace ${shellQuote(from)} ${shellQuote(to)} --all-tables --dry-run`;
// One command per address family (the old IP and its /~user/ path are one address), to the address of the live site.
function replaceCommands(rows, pageURL) {
  let page; try { page = new URL(pageURL); } catch { return []; }
  const families = new Map();
  for (const r of rows) {
    if (families.has(r.from)) continue;
    const to = r.kind === 'http' ? r.from.replace(/^http:/, 'https:') : page.origin;
    const where = r.kind === 'ip' || r.kind === 'tilde' ? `${r.where}, ${rows.some(x => x.from === r.from && x.kind === 'tilde') ? 'temporary URL of the old server' : 'old server IP'}` : r.kind === 'staging' ? `${r.where}, ${STAGING.test(r.found) ? 'staging domain' : 'other copy of the site'}` : `${r.where}, own site over http`;
    families.set(r.from, { found: r.kind === 'http' ? r.url : r.kind === 'staging' ? r.found : `${r.from}/`, where, from: r.from, to, command: searchReplace(r.from, to) });
  }
  return [...families.values()];
}

// The standard addresses asked of both servers. Only addresses of the page host itself (and its www twin when that has a
// rule too), so nothing in the page can send these requests elsewhere.
function standardAddresses({ pageURL, hostfileHTML = '', liveHTML = '', wordpress = false, robotsLive = '', routed = () => true, random = 'check' }) {
  const page = new URL(pageURL), host = page.hostname.toLowerCase(), origin = page.origin, list = [];
  const link = internalLink(hostfileHTML, liveHTML, pageURL);
  if (link) list.push({ id: 'link', name: link.pathname, address: link.pathname, url: link.href, note: 'internal link of this page' });
  if (wordpress) list.push({ id: 'xmlrpc', name: '/xmlrpc.php', address: '/xmlrpc.php', url: `${origin}/xmlrpc.php`, sensitive: true, note: 'usually blocked against password guessing' });
  list.push({ id: 'robots', name: '/robots.txt', address: '/robots.txt', url: `${origin}/robots.txt`, note: 'rules for search engines' });
  const named = sitemapsInRobots(robotsLive).map(value => absolute(value.split(/\s/, 1)[0], origin)).find(u => u && u.hostname.toLowerCase() === host);
  const sitemap = named ? named.pathname + named.search : wordpress ? '/wp-sitemap.xml' : '/sitemap.xml';
  list.push({ id: 'sitemap', name: sitemap, address: sitemap, url: `${origin}${sitemap}`, note: 'sitemap for search engines' });
  if (wordpress) list.push({ id: 'login', name: '/wp-login.php', address: '/wp-login.php', url: `${origin}/wp-login.php`, note: 'login page' });
  if (page.protocol === 'https:') list.push({ id: 'https', name: 'http to https', address: `http://${page.hostname}/`, url: `http://${page.hostname}/`, note: 'http should go to https' });
  const twin = wwwTwin(host);
  if (routed(twin)) list.push({ id: 'www', name: host.startsWith('www.') ? 'bare domain to www' : 'www to bare domain', address: `${page.protocol}//${twin}/`, url: `${page.protocol}//${twin}${page.port ? `:${page.port}` : ''}/`, note: host.startsWith('www.') ? 'the bare domain to www' : 'www to the bare domain' });
  const missing = `/dioptra-check-${String(random).replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'check'}/`;
  list.push({ id: 'missing', name: 'random address gives 404', address: missing, url: `${origin}${missing}`, note: 'random address, should give 404' });
  return list;
}
// One link of the page to another page of the same host: the page it links to most (the order or contact page that
// sits in the menu and in a button), preferably one that Live has too.
function internalLink(hostfileHTML, liveHTML, pageURL) {
  const page = new URL(pageURL), host = page.hostname.toLowerCase();
  const pick = html => pageFacts(html, pageURL).tags.filter(t => t.tag === 'a' && t.attr === 'href').map(t => absolute(t.value, pageURL))
    .filter(u => u && u.hostname.toLowerCase() === host && u.protocol === page.protocol && u.port === page.port && u.pathname !== page.pathname && u.pathname !== '/'
      && !/^\/(wp-admin|wp-login|wp-json|feed|comments|xmlrpc|cart|checkout|my-account|cgi-bin)\b/i.test(u.pathname) && !/\.[a-z0-9]{2,5}$/i.test(u.pathname) && !u.search);
  const mine = pick(hostfileHTML), theirs = new Set(pick(liveHTML).map(u => u.pathname)), count = new Map();
  for (const u of mine) count.set(u.pathname, (count.get(u.pathname) || 0) + 1);
  const pool = mine.some(u => theirs.has(u.pathname)) ? mine.filter(u => theirs.has(u.pathname)) : mine;
  const chosen = pool.reduce((best, u) => (!best || count.get(u.pathname) > count.get(best.pathname) ? u : best), null);
  if (!chosen) return null;
  chosen.hash = ''; return chosen;
}

const statusLabel = r => (!r?.ok ? `failed: ${clean(r?.error || 'no response', 120)}` : `${`${r.status} ${STATUS_CODES[r.status] || ''}`.trim()}${r.headers?.location ? ` → ${clean(r.headers.location, 200)}` : ''}`);
const located = (r, url) => { try { return r.headers?.location ? new URL(r.headers.location, url).href : ''; } catch { return clean(r.headers?.location); } };
const redirectsTo = (r, url, protocol) => r?.ok && r.status >= 300 && r.status < 400 && located(r, url).startsWith(protocol);
// worse: the new server breaks what works on Live, or opens what Live blocks; differs: only different; same: passed.
function standardVerdict(check, hf, live) {
  if (!hf?.ok && !live?.ok) return 'same';
  if (!hf?.ok) return 'worse';
  if (!live?.ok) return 'same';
  if (check.id === 'https') { if (redirectsTo(live, check.url, 'https:') && !redirectsTo(hf, check.url, 'https:')) return 'worse'; }
  if (check.id === 'missing') { if ([404, 410].includes(hf.status)) return 'same'; if ([404, 410].includes(live.status)) return 'worse'; }
  if (hf.status === live.status && located(hf, check.url) === located(live, check.url)) return 'same';
  if ((hf.status >= 400 && live.status < 400) || (check.sensitive && hf.status < 400 && live.status >= 400)) return 'worse';
  return 'differs';
}
function robotsSummary(r) {
  if (!r?.ok || r.status !== 200) return statusLabel(r);
  const groups = [], lines = String(r.body || '').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  let group = null;
  for (const line of lines) {
    const [, key, value = ''] = line.match(/^([a-z-]+)\s*:\s*(.*)$/i) || [];
    if (!key) continue;
    if (/^user-agent$/i.test(key)) { if (!group || group.rules.length) { group = { agents: [], rules: [] }; groups.push(group); } group.agents.push(value.toLowerCase()); }
    else if (group && /^(dis)?allow$/i.test(key)) group.rules.push([key.toLowerCase(), value]);
  }
  const all = groups.find(g => g.agents.includes('*')) || { rules: [] }, blocked = all.rules.filter(([k, v]) => k === 'disallow' && v).map(([, v]) => v);
  return blocked.includes('/') ? '200, blocks the whole site' : `200, blocks ${blocked.slice(0, 3).join(', ') || 'nothing'}${blocked.length > 3 ? ', …' : ''}${blocked.length ? ' only' : ''}`;
}
const xmlrpcRule = kind => (kind === 'nginx' ? 'location = /xmlrpc.php { deny all; }' : kind === 'apache' || kind === 'litespeed' ? '<Files xmlrpc.php> Require all denied </Files>' : '');

// Cards for the problems, names of what passed and the findings, from everything that was fetched.
// input: { pageURL, hostfile, live (page documents with body and headers), standard: [{ check, hostfile, live }], oldIP, copies }
function checksReport({ pageURL, hostfile, live, standard = [], oldIP = '', oldHosts = [], copies = [] }) {
  const hf = pageFacts(hostfile?.body, pageURL), lv = pageFacts(live?.body, pageURL), wordpress = hf.wordpress || lv.wordpress;
  const kind = serverKind(hostfile?.headers?.server), host = new URL(pageURL).hostname, cards = [], passed = [];
  const card = (group, tone, item) => cards.push({ group, tone, ...item });
  const pass = (name, h, l) => passed.push({ name, hostfile: clean(h, 200), live: clean(l, 200) });
  const robotsFetch = standard.find(s => s.check.id === 'robots');
  // 1. Search engines
  const meta = { hostfile: tidy(hf.robots), live: tidy(lv.robots) };
  const metaVerdict = noindex(meta.hostfile) ? (noindex(meta.live) ? 'both' : 'worse') : nofollow(meta.hostfile) && !nofollow(meta.live) ? 'differs' : 'same';
  const show = v => v || 'not set';
  if (metaVerdict === 'same') pass('meta robots', show(meta.hostfile), show(meta.live));
  else card('search', metaVerdict === 'worse' ? 'worse' : 'differs', {
    title: metaVerdict === 'both' ? 'Both servers tell search engines not to index the site' : metaVerdict === 'worse' ? 'The new server tells search engines not to index the site' : 'The new server tells search engines not to follow links',
    hostfile: show(meta.hostfile), live: show(meta.live),
    fix: [wordpress ? 'WordPress, Settings, Reading: untick Discourage search engines.' : 'remove noindex from the robots meta tag in the page template.'],
    action: wordpress ? { kind: 'open', label: 'Open settings', icon: 'open', title: 'Open Settings, Reading on the new server in a new tab', url: `${new URL(pageURL).origin}/wp-admin/options-reading.php` } : null });
  const tag = { hostfile: tidy(hostfile?.headers?.['x-robots-tag']), live: tidy(live?.headers?.['x-robots-tag']) };
  const tagVerdict = tag.hostfile === tag.live ? 'same' : noindex(tag.hostfile) && !noindex(tag.live) ? 'worse' : !noindex(tag.hostfile) && !nofollow(tag.hostfile) && !tag.live ? 'same' : 'differs';
  if (tagVerdict === 'same') pass('X-Robots-Tag', show(tag.hostfile), show(tag.live));
  else card('search', tagVerdict, { title: tagVerdict === 'worse' ? 'The new server sends X-Robots-Tag: noindex' : 'X-Robots-Tag differs', hostfile: show(tag.hostfile), live: show(tag.live),
    fix: [kind === 'nginx' ? 'remove the X-Robots-Tag add_header line from the nginx configuration.' : kind ? 'remove the X-Robots-Tag header from the server configuration or .htaccess.' : 'remove the X-Robots-Tag header from the server configuration.'], action: { kind: 'copy', label: 'Copy', icon: 'copy', title: 'Copy both values', text: `X-Robots-Tag: Hostfile "${show(tag.hostfile)}", Live "${show(tag.live)}"` } });
  if (robotsFetch) {
    const h = robotsSummary(robotsFetch.hostfile), l = robotsSummary(robotsFetch.live);
    const v = h === l ? 'same' : /whole site/.test(h) && !/whole site/.test(l) ? 'worse' : 'differs';
    if (v === 'same') pass('robots.txt', h, l);
    else card('search', v, { title: v === 'worse' ? 'robots.txt on the new server blocks the whole site' : 'robots.txt differs', hostfile: h, live: l,
      fix: v === 'worse' ? [wordpress ? 'WordPress writes this while Discourage search engines is on; untick it, or remove ' : 'remove ', { code: 'Disallow: /' }, ' from robots.txt on the new server.'] : ['make it the same as on Live.'],
      action: { kind: 'open', label: 'Open', icon: 'open', title: 'Open robots.txt through the new server', url: robotsFetch.check.url } });
  }
  const can = { hostfile: hf.canonical, live: lv.canonical }, hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
  const canVerdict = can.hostfile === can.live ? 'same' : can.hostfile && hostOf(can.hostfile) !== (hostOf(can.live) || host.toLowerCase()) ? 'worse' : 'differs';
  if (canVerdict === 'same') pass('canonical', show(can.hostfile), show(can.live));
  else card('search', canVerdict, { title: canVerdict === 'worse' ? 'The canonical address points to another site' : 'The canonical address differs', hostfile: show(can.hostfile), live: show(can.live),
    fix: [wordpress ? 'set the site address in WordPress, Settings, General, or the canonical setting of the SEO plugin, to the live address.' : 'set the canonical link of the page to the live address.'], action: { kind: 'copy', label: 'Copy', icon: 'copy', title: 'Copy the Live canonical address', text: can.live || pageURL } });
  // 2. Old addresses
  const rows = oldAddresses({ hostfileHTML: hostfile?.body, liveHTML: live?.body, pageURL, oldIP, oldHosts, copies }), commands = wordpress ? replaceCommands(rows, pageURL) : [];
  if (!rows.length) pass('old addresses', 'none', 'none');
  else card('old', 'worse', { title: `${rows.length} old address${rows.length === 1 ? '' : 'es'} in the page of the new server`, hostfile: `${rows.length} found, listed below`, live: 'none',
    fix: wordpress ? ['replace them in the database with WP CLI on the new server. Remove ', { code: '--dry-run' }, ' when the counts look right; back up the database first.'] : ['replace them in the content or the database on the new server.'],
    action: { kind: 'copy', label: wordpress ? 'Copy all' : 'Copy list', icon: 'copy', title: wordpress ? 'Copy all commands' : 'Copy the list', text: wordpress ? commands.map(c => c.command).join('\n') : rows.map(r => `${r.found}: ${r.where}`).join('\n') },
    rows, commands: commands.length ? commands : rows.map(r => ({ found: r.found, where: r.where, command: '' })) });
  // 3. Standard addresses
  for (const s of standard) {
    const v = standardVerdict(s.check, s.hostfile, s.live), h = statusLabel(s.hostfile), l = statusLabel(s.live);
    if (v === 'same') { pass(s.check.name, h, l); continue; }
    card('std', v, standardCard(s.check, v, h, l, s.hostfile, s.live, { kind, wordpress }));
  }
  const groups = [['search', 'Search engines'], ['old', 'Old addresses'], ['std', 'Standard addresses']].map(([id, label]) => ({ id, label, items: cards.filter(c => c.group === id) })).filter(g => g.items.length);
  const problems = cards.filter(c => c.tone === 'worse').length, differ = cards.length - problems;
  return { groups, passed, wordpress, counts: { problems, differ, passed: passed.length, total: cards.length + passed.length },
    noindex: metaVerdict === 'worse' || tagVerdict === 'worse' ? 'worse' : metaVerdict === 'both' ? 'both' : '', findings: checkFindings({ metaVerdict, tagVerdict, cards, rows, wordpress }) };
}
function standardCard(check, v, h, l, hf, live, { kind, wordpress }) {
  const open = { kind: 'open', label: 'Open', icon: 'open', title: `Open ${check.address} through the new server`, url: check.url };
  const base = { address: check.address, hostfile: h, live: l, action: open };
  if (check.id === 'xmlrpc' && v === 'worse') {
    const rule = xmlrpcRule(kind);
    return { ...base, title: '/xmlrpc.php is open on the new server', fix: rule ? ['block it as on Live, for example ', { code: rule }, kind === 'nginx' ? ' in nginx.' : ' in .htaccess.'] : ['block it as on Live, in the server configuration or with a security plugin.'],
      action: rule ? { kind: 'copy', label: 'Copy rule', icon: 'copy', title: kind === 'nginx' ? 'Copy the nginx rule' : 'Copy the .htaccess rule', text: rule } : open };
  }
  if (check.id === 'https' && v === 'worse') return { ...base, title: 'http does not go to https on the new server', fix: kind === 'nginx' ? ['add ', { code: 'return 301 https://$host$request_uri;' }, ' to the port 80 server block in nginx.'] : ['add a redirect from http to https, as on Live.'] };
  if (check.id === 'missing' && v === 'worse') return { ...base, title: `An unknown address gives ${hf.status} on the new server`, fix: ['a missing page must answer 404, or search engines index error pages; check the 404 page and the rewrite rules.'] };
  if (check.id === 'www') return { ...base, title: v === 'worse' ? `${check.address} does not work on the new server` : `${check.address} answers differently on the new server`, fix: ['make it redirect as on Live, and check that the certificate covers both names.'] };
  if (v === 'worse' && hf.ok && hf.status === 404 && check.id === 'link') return { ...base, title: `${check.address} gives 404 on the new server`, fix: permalinkFix(kind, wordpress) };
  if (v === 'worse') return { ...base, title: `${check.address} gives ${hf.ok ? hf.status : 'no answer'} on the new server`, fix: [check.id === 'sitemap' ? 'check that the sitemap of WordPress or the SEO plugin is on, and the rewrite rules.' : check.id === 'login' ? 'a firewall or security plugin may block it; compare its rules with Live.' : 'compare the server rules for this address with Live.'] };
  return { ...base, title: `${check.address} answers differently on the new server`, fix: ['compare the server rules for this address with Live.'] };
}
// An internal link that gives 404: on WordPress almost always the rewrite rules for pretty permalinks.
function permalinkFix(kind, wordpress) {
  if (!wordpress) return ['check the rewrite rules on the new server.'];
  if (kind === 'nginx') return ['pretty permalinks need ', { code: 'try_files $uri $uri/ /index.php?$args;' }, ' in nginx.'];
  return kind ? ['WordPress, Settings, Permalinks: Save, so the rewrite rules are written to ', { code: '.htaccess' }, ' again.'] : ['check the rewrite rules for pretty permalinks on the new server.'];
}
const listed = parts => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);
function oldAddressFinding(rows) {
  const kinds = new Set(rows.map(r => r.kind)), http = rows.filter(r => r.kind === 'http').length;
  const staging = rows.filter(r => r.kind === 'staging').length > 1 ? 'other copies of the site' : rows.some(r => r.kind === 'staging' && STAGING.test(r.found)) ? 'the staging domain' : 'another copy of the site';
  return { severity: 'high', text: `The page on the new server still uses old addresses: ${listed([kinds.has('ip') && 'the old server IP', kinds.has('tilde') && 'a temporary URL', kinds.has('staging') && staging, kinds.has('http') && (http > 1 ? 'http links' : 'an http link')].filter(Boolean))}.` };
}
function checkFindings({ metaVerdict, tagVerdict, cards, rows, wordpress }) {
  const out = [];
  if (metaVerdict === 'worse') out.push({ severity: 'high', text: 'The new server tells search engines not to index this site (meta robots noindex).', detail: `${wordpress ? 'WordPress: Settings, Reading, Discourage search engines. ' : ''}Google drops the site after the switch.` });
  else if (tagVerdict === 'worse') out.push({ severity: 'high', text: 'The new server tells search engines not to index this site (X-Robots-Tag noindex).', detail: 'Google drops the site after the switch.' });
  if (metaVerdict === 'both') out.push({ severity: 'both', text: 'Both servers tell search engines not to index this site, so it is not a migration difference.' });
  for (const c of cards.filter(c => c.group === 'search' && c.tone === 'worse' && !/not to index/.test(c.title) && !/X-Robots-Tag: noindex/.test(c.title))) out.push({ severity: 'high', text: `${c.title}.` });
  if (rows.length) out.push(oldAddressFinding(rows));
  for (const c of cards.filter(c => c.group === 'std' && c.tone === 'worse')) {
    const h = c.hostfile.split(' ')[0], l = c.live.split(' ')[0];
    out.push({ severity: 'high', text: c.address === '/xmlrpc.php' ? `/xmlrpc.php is open on Hostfile (${h}), blocked on Live (${l}).` : /gives 404/.test(c.title) && c.address.startsWith('/') ? `${c.address} gives 404 on Hostfile, ${l} on Live: permalinks or rewrite rules missing.` : `${c.title}: Hostfile ${c.hostfile}, Live ${c.live}.` });
  }
  return out;
}
// Without Live (it could not be reached): the new server on its own, each card with what a good server gives next to it.
// www to bare follows whatever Live does and the old server IP is unknown, so those two wait for Live (needLive).
const EXPECTED = { link: '200 OK, the page links to it', xmlrpc: '403 or 404, blocked', robots: '200 OK', sitemap: '200 OK', login: '200 OK', https: '301 to https', missing: '404 Not Found' };
// pass, warn (orange: open or unusual) or worse (red: broken on the new server).
function soloStandardVerdict(check, r, { wordpress, named }) {
  if (!r?.ok) return check.id === 'xmlrpc' ? 'pass' : 'worse'; // xmlrpc.php that does not answer is blocked too
  const s = r.status;
  if (check.id === 'link') return s < 400 ? 'pass' : 'worse';
  if (check.id === 'xmlrpc') return s >= 400 ? 'pass' : 'warn';
  if (check.id === 'robots') return s === 200 ? 'pass' : 'worse';
  if (check.id === 'sitemap') return s === 200 || (s >= 300 && s < 400 && r.headers?.location) ? 'pass' : wordpress || named ? 'worse' : 'warn';
  if (check.id === 'login') return s === 200 ? 'pass' : 'warn';
  if (check.id === 'https') return redirectsTo(r, check.url, 'https:') ? 'pass' : 'worse';
  if (check.id === 'missing') return [404, 410].includes(s) ? 'pass' : 'worse';
  return 'pass';
}
function soloStandardCard(check, h, r, { kind, wordpress }) {
  const open = { kind: 'open', label: 'Open', icon: 'open', title: `Open ${check.address} through the new server`, url: check.url };
  const base = { address: check.address, checkId: check.id, hostfile: h, expected: EXPECTED[check.id] || '200 OK', action: open }, status = r?.ok ? r.status : 'no answer';
  if (check.id === 'xmlrpc') {
    const rule = xmlrpcRule(kind);
    return { ...base, title: '/xmlrpc.php is open on the new server', fix: rule ? ['block it, for example ', { code: rule }, kind === 'nginx' ? ' in nginx, or with a security plugin.' : ' in .htaccess, or with a security plugin.'] : ['block it in the server configuration or with a security plugin.'],
      action: rule ? { kind: 'copy', label: 'Copy rule', icon: 'copy', title: kind === 'nginx' ? 'Copy the nginx rule' : 'Copy the .htaccess rule', text: rule } : open };
  }
  if (check.id === 'https') return { ...base, title: 'http does not go to https on the new server', fix: kind === 'nginx' ? ['add ', { code: 'return 301 https://$host$request_uri;' }, ' to the port 80 server block in nginx.'] : ['add a redirect from http to https on the new server.'] };
  if (check.id === 'missing') return { ...base, title: `An unknown address gives ${status} on the new server`, fix: ['a missing page must answer 404, or search engines index error pages; check the 404 page and the rewrite rules.'] };
  const title = `${check.address} gives ${status} on the new server`;
  if (check.id === 'link') return { ...base, title, fix: r?.ok && r.status === 404 ? permalinkFix(kind, wordpress) : ['check the server rules and the error log of the new server for this address.'] };
  if (check.id === 'sitemap') return { ...base, title, fix: [wordpress ? 'check that the sitemap of WordPress or the SEO plugin is on, and the rewrite rules.' : 'add a sitemap, or name it in robots.txt with a Sitemap line.'] };
  if (check.id === 'login') return { ...base, title, fix: ['a firewall or security plugin may block it; check its rules.'] };
  if (check.id === 'robots') return { ...base, title, fix: [wordpress ? 'WordPress serves robots.txt itself: check the rewrite rules, or add a robots.txt file.' : 'add a robots.txt file on the new server.'] };
  return { ...base, title, fix: ['check the server rules for this address.'] };
}
// input: { pageURL, hostfile (the page with body and headers), standard: [{ check, hostfile }] (www without a result), copies }
function soloChecksReport({ pageURL, hostfile, standard = [], copies = [] }) {
  const hf = pageFacts(hostfile?.body, pageURL), wordpress = hf.wordpress, kind = serverKind(hostfile?.headers?.server);
  const page = new URL(pageURL), host = page.hostname.toLowerCase(), cards = [], passed = [], needLive = [];
  const card = (group, tone, item) => cards.push({ group, tone, ...item });
  const pass = (name, h, expected) => passed.push({ name, hostfile: clean(h, 200), expected: clean(expected, 200) });
  const show = v => v || 'not set', robotsFetch = standard.find(s => s.check.id === 'robots');
  // 1. Search engines
  const meta = tidy(hf.robots), tag = tidy(hostfile?.headers?.['x-robots-tag']), good = 'index, follow or not set';
  if (noindex(meta) || nofollow(meta)) card('search', noindex(meta) ? 'worse' : 'differs', {
    title: noindex(meta) ? 'The new server tells search engines not to index the site' : 'The new server tells search engines not to follow links', hostfile: meta, expected: good,
    fix: [wordpress ? 'WordPress, Settings, Reading: untick Discourage search engines.' : 'remove noindex and nofollow from the robots meta tag in the page template.'],
    action: wordpress ? { kind: 'open', label: 'Open settings', icon: 'open', title: 'Open Settings, Reading on the new server in a new tab', url: `${page.origin}/wp-admin/options-reading.php` } : null });
  else pass('meta robots', show(meta), good);
  if (noindex(tag)) card('search', 'worse', { title: 'The new server sends X-Robots-Tag: noindex', hostfile: tag, expected: 'not set',
    fix: [kind === 'nginx' ? 'remove the X-Robots-Tag add_header line from the nginx configuration.' : kind ? 'remove the X-Robots-Tag header from the server configuration or .htaccess.' : 'remove the X-Robots-Tag header from the server configuration.'], action: { kind: 'copy', label: 'Copy', icon: 'copy', title: 'Copy the value', text: `X-Robots-Tag: Hostfile "${tag}"` } });
  else pass('X-Robots-Tag', show(tag), 'not set, or without noindex');
  if (robotsFetch?.hostfile) {
    const h = robotsSummary(robotsFetch.hostfile);
    if (/whole site/.test(h)) card('search', 'worse', { title: 'robots.txt on the new server blocks the whole site', hostfile: h, expected: 'does not block the whole site',
      fix: [wordpress ? 'WordPress writes this while Discourage search engines is on; untick it, or remove ' : 'remove ', { code: 'Disallow: /' }, ' from robots.txt on the new server.'], action: { kind: 'open', label: 'Open', icon: 'open', title: 'Open robots.txt through the new server', url: robotsFetch.check.url } });
    else pass('robots.txt', h, 'does not block the whole site');
  }
  let canHost = ''; try { canHost = hf.canonical ? new URL(hf.canonical).hostname.toLowerCase() : ''; } catch {}
  if (hf.canonical && canHost !== host && canHost !== wwwTwin(host)) card('search', 'worse', { title: 'The canonical address points to another site', hostfile: hf.canonical, expected: `an address on ${host}`,
    fix: [wordpress ? 'set the site address in WordPress, Settings, General, or the canonical setting of the SEO plugin, to the address of this site.' : 'set the canonical link of the page to the address of this site.'], action: { kind: 'copy', label: 'Copy', icon: 'copy', title: 'Copy the address of this page', text: pageURL } });
  else pass('canonical', show(hf.canonical), `an address on ${host}`);
  // 2. Old addresses: a temporary URL on an IP, other copies and http links work alone; the old server IP needs Live.
  const rows = oldAddresses({ hostfileHTML: hostfile?.body, liveHTML: '', pageURL, oldIP: '', oldHosts: [], copies }), commands = wordpress ? replaceCommands(rows, pageURL) : [];
  if (!rows.length) pass('old addresses', 'none', 'none');
  else card('old', 'worse', { title: `${rows.length} old address${rows.length === 1 ? '' : 'es'} in the page of the new server`, hostfile: `${rows.length} found, listed below`, expected: 'none (old server IP unknown without Live)',
    fix: wordpress ? ['replace them in the database with WP CLI on the new server. Remove ', { code: '--dry-run' }, ' when the counts look right; back up the database first.'] : ['replace them in the content or the database on the new server.'],
    action: { kind: 'copy', label: wordpress ? 'Copy all' : 'Copy list', icon: 'copy', title: wordpress ? 'Copy all commands' : 'Copy the list', text: wordpress ? commands.map(c => c.command).join('\n') : rows.map(r => `${r.found}: ${r.where}`).join('\n') },
    rows, commands: commands.length ? commands : rows.map(r => ({ found: r.found, where: r.where, command: '' })) });
  needLive.push({ name: 'old server IP in the page', why: 'unknown without Live' });
  // 3. Standard addresses, judged on what a good server gives.
  // The whole body, linear: [ \t] cannot cross a line, unlike the old ^\s* with the m flag (quadratic on empty lines).
  const named = /(?:^|\n)[ \t]*sitemap:/i.test(String(robotsFetch?.hostfile?.body || ''));
  for (const s of standard) {
    if (s.check.id === 'www') { needLive.unshift({ name: s.check.name, why: 'which name is the main one' }); continue; }
    const v = soloStandardVerdict(s.check, s.hostfile, { wordpress, named }), h = statusLabel(s.hostfile);
    if (v === 'pass') pass(s.check.name, h, EXPECTED[s.check.id] || '200 OK');
    else card('std', v === 'warn' ? 'differs' : 'worse', soloStandardCard(s.check, h, s.hostfile, { kind, wordpress }));
  }
  const groups = [['search', 'Search engines'], ['old', 'Old addresses'], ['std', 'Standard addresses']].map(([id, label]) => ({ id, label, items: cards.filter(c => c.group === id) })).filter(g => g.items.length);
  const problems = cards.filter(c => c.tone === 'worse').length, warnings = cards.length - problems;
  const findings = [];
  if (noindex(meta)) findings.push({ severity: 'high', text: 'The new server tells search engines not to index this site (meta robots noindex).', detail: `${wordpress ? 'WordPress: Settings, Reading, Discourage search engines. ' : ''}Google drops the site after the switch.` });
  else if (noindex(tag)) findings.push({ severity: 'high', text: 'The new server tells search engines not to index this site (X-Robots-Tag noindex).', detail: 'Google drops the site after the switch.' });
  for (const c of cards.filter(c => c.group === 'search' && c.tone === 'worse' && !/not to index|X-Robots-Tag: noindex/.test(c.title))) findings.push({ severity: 'high', text: `${c.title}.` });
  if (rows.length) findings.push(oldAddressFinding(rows));
  for (const c of cards.filter(c => c.group === 'std')) {
    if (c.tone === 'worse') findings.push({ severity: 'high', text: c.checkId === 'link' && /gives 404/.test(c.title) ? `${c.title}, although the page links to it: permalinks or rewrite rules missing.` : `${c.title}.` });
    else if (c.checkId === 'xmlrpc') findings.push({ severity: 'both', text: `/xmlrpc.php is open on the new server (${c.hostfile.split(' ')[0]}).` });
  }
  return { solo: true, groups, passed, needLive, wordpress, counts: { problems, differ: warnings, passed: passed.length, needLive: needLive.length, total: cards.length + passed.length },
    noindex: noindex(meta) || noindex(tag) ? 'worse' : '', findings };
}

// Lines for Ask Claude, inside the untrusted block.
function checksLines(report) {
  if (!report) return [];
  if (report.solo) {
    const c = report.counts, solo = [`Checks of the new server alone, Live could not be reached (${c.problems} problems, ${c.differ} warnings, ${c.passed} passed, ${c.needLive} need Live):`];
    for (const g of report.groups) for (const item of g.items) solo.push(`- [${item.tone === 'worse' ? 'problem' : 'warning'}] ${g.label}: ${item.title}. Hostfile ${item.hostfile}; expected ${item.expected}`);
    for (const r of report.groups.find(g => g.id === 'old')?.items[0]?.rows || []) solo.push(`  - old address ${r.found}: ${r.url} (${r.where})`);
    if (report.passed.length) solo.push(`- Passed: ${report.passed.map(p => p.name).join(', ')}`);
    solo.push(`- Need Live: ${report.needLive.map(n => n.name).join(', ')}`);
    return solo;
  }
  const lines = [`Checks (${report.counts.problems} problems, ${report.counts.differ} differ, ${report.counts.passed} passed):`];
  for (const g of report.groups) for (const c of g.items) lines.push(`- [${c.tone === 'worse' ? 'problem' : 'differs'}] ${g.label}: ${c.title}. Hostfile ${c.hostfile}; Live ${c.live}`);
  for (const c of report.groups.find(g => g.id === 'old')?.items[0]?.rows || []) lines.push(`  - old address ${c.found}: ${c.url} (${c.where})`);
  if (report.passed.length) lines.push(`- Passed: ${report.passed.map(p => p.name).join(', ')}`);
  return lines;
}
// Noindex from the page as it loaded in a tab: the robots meta tags (read in an isolated world) and the X-Robots-Tag header.
function tabNoindex(metaContents, headerValue) {
  const meta = (Array.isArray(metaContents) ? metaContents : []).map(v => clean(v, 200)).join(', ');
  return noindex(meta) ? 'meta robots' : noindex(clean(headerValue, 200)) ? 'X-Robots-Tag' : '';
}

module.exports = { pageFacts, oldAddresses, replaceCommands, shellQuote, searchReplace, standardAddresses, internalLink, standardVerdict, statusLabel, robotsSummary, checksReport, soloChecksReport, soloStandardVerdict, checksLines, tabNoindex, noindex };
