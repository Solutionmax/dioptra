const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/site-checks.cjs');

const HOME = 'https://northwind-bakery.test/', OLD = '198.51.100.24';
const page = side => {
  const isNew = side === 'new';
  return `<!doctype html><html><head><title>Northwind Bakery</title>
${isNew ? "<meta name='robots' content='noindex, nofollow' />" : "<meta name='robots' content='index, follow, max-image-preview:large' />"}
<link rel="canonical" href="${HOME}"><meta name="generator" content="WordPress 6.8.3">
<!-- <img src="https://${OLD}/~northwind/commented.png"> -->
<link rel='stylesheet' href='${HOME}wp-content/themes/hearth/style.css?ver=2.4.1' /></head><body>
<header><a class="brand" href="${HOME}"><img src="${isNew ? `https://${OLD}/~northwind/wp-content/uploads/2026/10/logo.png` : `${HOME}wp-content/uploads/2026/10/logo.png`}" alt="">Northwind Bakery</a>
<nav><a href="${HOME}bread/">Bread</a><a href="${HOME}cakes/">Cakes</a><a href="/bestellen/">Order</a><a href="${isNew ? 'http://northwind-bakery.test/contact/' : `${HOME}contact/`}">Contact</a></nav></header>
<a class="cta" href="${HOME}bestellen/">Order online</a><a href="https://cdn.example.net/x.js">CDN</a><a href="${HOME}wp-admin/">Admin</a><a href="${HOME}menu.pdf">Menu</a>
<footer>© 2026 <a href="${isNew ? 'https://staging.northwind-bakery.test/' : HOME}">Northwind Bakery</a></footer>
${isNew ? `<script>var cfg={"ajaxurl":"https:\\/\\/${OLD}\\/~northwind\\/wp-admin\\/admin-ajax.php"};</script>` : ''}</body></html>`;
};
const ok = (status, headers = {}, body = '') => ({ ok: true, status, headers, body });
const fail = error => ({ ok: false, error, headers: {}, body: '' });

test('page facts: robots meta in either quotes, canonical made absolute, WordPress, comments ignored', () => {
  const f = c.pageFacts(page('new'), HOME);
  assert.equal(f.robots, 'noindex, nofollow'); assert.equal(f.canonical, HOME); assert.equal(f.wordpress, true);
  assert.ok(!f.tags.some(t => t.value.includes('commented')));
  const g = c.pageFacts('<meta name="ROBOTS" content="index"><meta name="googlebot" content="noindex"><link rel="canonical" href="/en/">', 'https://shop.test/en/');
  assert.equal(g.robots, 'index, noindex'); assert.equal(g.canonical, 'https://shop.test/en/'); assert.equal(g.wordpress, false);
  assert.deepEqual(c.pageFacts('<img srcset="/a.jpg 1x, /b.jpg 2x">', HOME).tags.map(t => t.value), ['/a.jpg', '/b.jpg']);
});
test('old addresses: the Live IP with its temporary URL, the staging copy, http to the own site; only what Live lacks', () => {
  const rows = c.oldAddresses({ hostfileHTML: page('new'), liveHTML: page('old'), pageURL: HOME, oldIP: OLD });
  assert.deepEqual(rows.map(r => [r.kind, r.found, r.where]), [
    ['ip', OLD, 'img src, logo.png'], ['tilde', '/~northwind/', 'img src, logo.png'],
    ['staging', 'staging.northwind-bakery.test', 'link "Northwind Bakery" in the footer'], ['http', 'http://northwind-bakery.test', 'link "Contact" in the menu']]);
  assert.equal(rows[0].from, `https://${OLD}/~northwind`);
  // The same address on Live is not a migration left over.
  assert.deepEqual(c.oldAddresses({ hostfileHTML: page('new'), liveHTML: page('new'), pageURL: HOME, oldIP: OLD }), []);
  // Escaped slashes in a script count too; ::ffff: and brackets do not hide the IP.
  const script = c.oldAddresses({ hostfileHTML: `<script>var a="https:\\/\\/${OLD}\\/wp-json\\/";</script>`, pageURL: HOME, oldIP: `::ffff:${OLD}` });
  assert.deepEqual(script.map(r => [r.kind, r.where]), [['ip', 'in a script or text of the page']]);
  // Another copy known from the rules (disabled, or to another server); a CDN, https links and the www twin are fine.
  const html = '<a href="https://shop2.northwind-bakery.test/">x</a><img src="https://cdn.example.net/a.png"><a href="https://www.northwind-bakery.test/a/">w</a><a href="http://other.example/">o</a>';
  assert.deepEqual(c.oldAddresses({ hostfileHTML: html, pageURL: HOME, copies: ['shop2.northwind-bakery.test'] }).map(r => [r.kind, r.found]), [['staging', 'shop2.northwind-bakery.test']]);
  assert.deepEqual(c.oldAddresses({ hostfileHTML: html, pageURL: HOME }), []);
  assert.deepEqual(c.oldAddresses({ hostfileHTML: '<a href="http://northwind-bakery.test/">x</a>', pageURL: 'http://northwind-bakery.test/' }), [], 'an http page links to itself over http');
  assert.deepEqual(c.oldAddresses({ hostfileHTML: '', pageURL: 'not a url' }), []);
  // /~user/ on the old server's own name is its temporary URL; on another site it is just a link.
  const tilde = '<a href="https://uni.example.edu/~prof/">prof</a><img src="https://web03.oldhost.example/~northwind/logo.png">';
  assert.deepEqual(c.oldAddresses({ hostfileHTML: tilde, pageURL: HOME, oldHosts: ['web03.oldhost.example'] }).map(r => [r.kind, r.found, r.from]), [['tilde', '/~northwind/', 'https://web03.oldhost.example/~northwind']]);
  assert.deepEqual(c.oldAddresses({ hostfileHTML: tilde, pageURL: HOME }), []);
});
test('wp search-replace commands: one per address family, to the live address, quoted for the shell', () => {
  const rows = c.oldAddresses({ hostfileHTML: page('new'), liveHTML: page('old'), pageURL: HOME, oldIP: OLD });
  assert.deepEqual(c.replaceCommands(rows, HOME).map(x => [x.found, x.where, x.command]), [
    [`https://${OLD}/~northwind/`, 'img src, logo.png, temporary URL of the old server', `wp search-replace 'https://${OLD}/~northwind' 'https://northwind-bakery.test' --all-tables --dry-run`],
    ['staging.northwind-bakery.test', 'link "Northwind Bakery" in the footer, staging domain', "wp search-replace 'https://staging.northwind-bakery.test' 'https://northwind-bakery.test' --all-tables --dry-run"],
    ['http://northwind-bakery.test/contact/', 'link "Contact" in the menu, own site over http', "wp search-replace 'http://northwind-bakery.test' 'https://northwind-bakery.test' --all-tables --dry-run"]]);
  const ipOnly = c.replaceCommands([{ kind: 'ip', found: OLD, url: `http://${OLD}/a.png`, where: 'img src, a.png', from: `http://${OLD}` }], HOME);
  assert.equal(ipOnly[0].where, 'img src, a.png, old server IP');
  assert.equal(c.shellQuote("it's"), "'it'\\''s'");
  assert.equal(c.shellQuote('a\nb‮'), "'ab'");
  assert.equal(c.searchReplace("https://x.test/~o'b", 'https://x.test'), "wp search-replace 'https://x.test/~o'\\''b' 'https://x.test' --all-tables --dry-run");
  assert.deepEqual(c.replaceCommands(rows, 'nope'), []);
});
test('standard addresses: only the page host, WordPress addresses only for WordPress, sitemap from robots.txt', () => {
  const list = c.standardAddresses({ pageURL: HOME, hostfileHTML: page('new'), liveHTML: page('old'), wordpress: true, robotsLive: `Sitemap: ${HOME}wp-sitemap.xml`, routed: host => host === 'www.northwind-bakery.test', random: '7f3a' });
  assert.deepEqual(list.map(x => [x.id, x.address, x.url]), [
    ['link', '/bestellen/', `${HOME}bestellen/`], ['xmlrpc', '/xmlrpc.php', `${HOME}xmlrpc.php`], ['robots', '/robots.txt', `${HOME}robots.txt`],
    ['sitemap', '/wp-sitemap.xml', `${HOME}wp-sitemap.xml`], ['login', '/wp-login.php', `${HOME}wp-login.php`], ['https', 'http://northwind-bakery.test/', 'http://northwind-bakery.test/'],
    ['www', 'https://www.northwind-bakery.test/', 'https://www.northwind-bakery.test/'], ['missing', '/dioptra-check-7f3a/', `${HOME}dioptra-check-7f3a/`]]);
  assert.deepEqual(list.map(x => x.name).slice(5), ['http to https', 'www to bare domain', 'random address gives 404']);
  const plain = c.standardAddresses({ pageURL: 'https://www.shop.test/', robotsLive: 'Sitemap: https://www.shop.test/sitemap_index.xml\nSitemap: https://evil.test/x.xml', routed: () => false, random: '../x y' });
  assert.deepEqual(plain.map(x => x.id), ['robots', 'sitemap', 'https', 'missing'], 'no WordPress, no www rule, no internal link');
  assert.equal(plain[1].url, 'https://www.shop.test/sitemap_index.xml'); assert.equal(plain[3].address, '/dioptra-check-xy/');
  assert.equal(c.standardAddresses({ pageURL: 'https://www.shop.test/', routed: () => true }).find(x => x.id === 'www').name, 'bare domain to www');
  assert.equal(c.standardAddresses({ pageURL: 'https://shop.test/' }).find(x => x.id === 'sitemap').address, '/sitemap.xml');
});
test('internal link: the page linked most, one Live has too; no admin pages, files, queries or other hosts', () => {
  assert.equal(c.internalLink(page('new'), page('old'), HOME).pathname, '/bestellen/');
  assert.equal(c.internalLink('<a href="/a/">a</a><a href="/b/">b</a><a href="/b/">b</a>', '<a href="/a/">a</a>', HOME).pathname, '/a/');
  assert.equal(c.internalLink('<a href="/wp-admin/">x</a><a href="/f.pdf">f</a><a href="/s/?q=1">q</a><a href="https://other.test/x/">o</a><a href="#top">t</a><a href="/">h</a>', '', HOME), null);
  assert.equal(c.internalLink('<a href="/p/#part">p</a>', '', HOME).href, `${HOME}p/`);
});
test('standard verdicts: worse when the new server breaks or opens what Live does not', () => {
  const v = (check, hf, live) => c.standardVerdict({ url: `${HOME}x`, ...check }, hf, live);
  assert.equal(v({ id: 'link' }, ok(404), ok(200)), 'worse');
  assert.equal(v({ id: 'xmlrpc', sensitive: true }, ok(200), ok(403)), 'worse');
  assert.equal(v({ id: 'robots' }, ok(200), ok(200)), 'same');
  assert.equal(v({ id: 'robots' }, ok(200), ok(404)), 'differs');
  assert.equal(v({ id: 'https', url: 'http://northwind-bakery.test/' }, ok(301, { location: HOME }), ok(301, { location: '/' })), 'differs', 'Live redirects to http itself');
  assert.equal(v({ id: 'https' }, ok(301, { location: `${HOME}` }), ok(301, { location: HOME })), 'same');
  assert.equal(v({ id: 'https' }, ok(200), ok(301, { location: HOME })), 'worse', 'Live goes to https, the new server stays on http');
  assert.equal(v({ id: 'missing' }, ok(200), ok(404)), 'worse'); assert.equal(v({ id: 'missing' }, ok(404), ok(200)), 'same'); assert.equal(v({ id: 'missing' }, ok(410), ok(404)), 'same');
  assert.equal(v({ id: 'www' }, fail('ECONNREFUSED'), ok(301, { location: HOME })), 'worse');
  assert.equal(v({ id: 'www' }, ok(301, { location: HOME }), fail('timeout')), 'same');
  assert.equal(v({ id: 'www' }, fail('a'), fail('b')), 'same');
  assert.equal(c.statusLabel(ok(301, { location: HOME })), `301 Moved Permanently → ${HOME}`);
  assert.equal(c.statusLabel(fail('The request timed out after 8 seconds.')), 'failed: The request timed out after 8 seconds.');
});
test('robots.txt summary: the rules for every robot', () => {
  assert.equal(c.robotsSummary(ok(200, {}, 'User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n\nSitemap: x')), '200, blocks /wp-admin/ only');
  assert.equal(c.robotsSummary(ok(200, {}, 'User-agent: Googlebot\nDisallow:\n\nUser-agent: *\nDisallow: /   # everything')), '200, blocks the whole site');
  assert.equal(c.robotsSummary(ok(200, {}, 'User-agent: *\nDisallow:')), '200, blocks nothing');
  assert.equal(c.robotsSummary(ok(404)), '404 Not Found');
});

// The mockup case: noindex, four old addresses, /bestellen/ 404 and xmlrpc.php open; everything else the same.
function mockup(overrides = {}) {
  const robots = ok(200, {}, 'User-agent: *\nDisallow: /wp-admin/\n');
  const list = c.standardAddresses({ pageURL: HOME, hostfileHTML: page('new'), liveHTML: page('old'), wordpress: true, routed: () => true, random: '7f3a' });
  const answers = { link: [ok(404), ok(200)], xmlrpc: [ok(200), ok(403)], robots: [robots, robots], sitemap: [ok(200), ok(200)], login: [ok(200), ok(200)], https: [ok(301, { location: HOME }), ok(301, { location: HOME })], www: [ok(301, { location: HOME }), ok(301, { location: HOME })], missing: [ok(404), ok(404)], ...overrides.answers };
  return c.checksReport({ pageURL: HOME, hostfile: ok(200, { server: 'nginx/1.26.2', ...overrides.hostfileHeaders }, overrides.hostfileHTML ?? page('new')), live: ok(200, { server: 'LiteSpeed' }, overrides.liveHTML ?? page('old')),
    standard: list.map(check => ({ check, hostfile: answers[check.id][0], live: answers[check.id][1] })), oldIP: OLD });
}
test('checks report: 4 problems, 9 passed, in three groups, as in the mockup', () => {
  const r = mockup();
  assert.deepEqual(r.counts, { problems: 4, differ: 0, passed: 9, total: 13 });
  assert.equal(r.noindex, 'worse'); assert.equal(r.wordpress, true);
  assert.deepEqual(r.groups.map(g => [g.id, g.label, g.items.map(i => i.title)]), [
    ['search', 'Search engines', ['The new server tells search engines not to index the site']],
    ['old', 'Old addresses', ['4 old addresses in the page of the new server']],
    ['std', 'Standard addresses', ['/bestellen/ gives 404 on the new server', '/xmlrpc.php is open on the new server']]]);
  assert.deepEqual(r.passed.map(p => p.name), ['X-Robots-Tag', 'robots.txt', 'canonical', '/robots.txt', '/wp-sitemap.xml', '/wp-login.php', 'http to https', 'www to bare domain', 'random address gives 404']);
  const [noindex] = r.groups[0].items, [old] = r.groups[1].items, [link, xmlrpc] = r.groups[2].items;
  assert.deepEqual([noindex.hostfile, noindex.live, noindex.action.label, noindex.action.url], ['noindex, nofollow', 'index, follow, max-image-preview:large', 'Open settings', `${HOME}wp-admin/options-reading.php`]);
  assert.deepEqual([old.hostfile, old.live, old.commands.length, old.action.label], ['4 found, listed below', 'none', 3, 'Copy all']);
  assert.equal(old.action.text, old.commands.map(x => x.command).join('\n'));
  assert.deepEqual([link.hostfile, link.live, link.fix], ['404 Not Found', '200 OK', ['pretty permalinks need ', { code: 'try_files $uri $uri/ /index.php?$args;' }, ' in nginx.']]);
  assert.deepEqual([xmlrpc.action.label, xmlrpc.action.text], ['Copy rule', 'location = /xmlrpc.php { deny all; }']);
  assert.deepEqual(r.findings.map(f => f.text), [
    'The new server tells search engines not to index this site (meta robots noindex).',
    'The page on the new server still uses old addresses: the old server IP, a temporary URL, the staging domain and an http link.',
    '/bestellen/ gives 404 on Hostfile, 200 on Live: permalinks or rewrite rules missing.', '/xmlrpc.php is open on Hostfile (200), blocked on Live (403).']);
  assert.equal(r.findings[0].detail, 'WordPress: Settings, Reading, Discourage search engines. Google drops the site after the switch.');
});
test('checks report: Apache and LiteSpeed get their own fixes, unknown servers a general one', () => {
  const apache = mockup({ hostfileHeaders: { server: 'Apache/2.4.62' } }), [link, xmlrpc] = apache.groups[2].items;
  assert.deepEqual(xmlrpc.action.text, '<Files xmlrpc.php> Require all denied </Files>'); assert.match(link.fix.join(''), /Permalinks: Save/);
  const unknown = mockup({ hostfileHeaders: { server: '' } }).groups[2].items;
  assert.equal(unknown[1].action.label, 'Open'); assert.deepEqual(unknown[1].fix, ['block it as on Live, in the server configuration or with a security plugin.']);
});
test('checks report: noindex on both servers is orange, not a problem; X-Robots-Tag and robots.txt count too', () => {
  const both = mockup({ liveHTML: page('old').replace('index, follow, max-image-preview:large', 'noindex') });
  assert.equal(both.noindex, 'both'); assert.equal(both.counts.problems, 3); assert.equal(both.counts.differ, 1);
  assert.equal(both.groups[0].items[0].tone, 'differs'); assert.equal(both.groups[0].items[0].title, 'Both servers tell search engines not to index the site');
  assert.deepEqual(both.findings[0], { severity: 'both', text: 'Both servers tell search engines not to index this site, so it is not a migration difference.' });
  const tag = mockup({ hostfileHTML: page('old'), hostfileHeaders: { 'x-robots-tag': 'noindex' } });
  assert.equal(tag.noindex, 'worse'); assert.equal(tag.groups[0].items[0].title, 'The new server sends X-Robots-Tag: noindex');
  assert.equal(tag.findings[0].text, 'The new server tells search engines not to index this site (X-Robots-Tag noindex).');
  const blocked = mockup({ hostfileHTML: page('old'), answers: { robots: [ok(200, {}, 'User-agent: *\nDisallow: /'), ok(200, {}, 'User-agent: *\nDisallow: /wp-admin/')] } });
  const card = blocked.groups[0].items.find(i => /robots\.txt/.test(i.title));
  assert.equal(card.title, 'robots.txt on the new server blocks the whole site'); assert.equal(card.tone, 'worse');
  assert.ok(blocked.findings.some(f => f.text === 'robots.txt on the new server blocks the whole site.'));
});
test('checks report without WordPress: no WP CLI commands, the old addresses as a plain list', () => {
  const strip = html => html.replace(/<meta name="generator"[^>]*>/, '').replace(/wp-content|wp-admin/g, 'assets');
  const r = mockup({ hostfileHTML: strip(page('new')), liveHTML: strip(page('old')) });
  assert.equal(r.wordpress, false);
  const old = r.groups.find(g => g.id === 'old').items[0];
  assert.ok(old.commands.every(x => x.command === '')); assert.equal(old.action.label, 'Copy list');
  assert.deepEqual(r.groups[0].items[0].fix, ['remove noindex from the robots meta tag in the page template.']);
  assert.equal(r.groups[0].items[0].action, null);
});
test('Ask Claude lines and the noindex of a tab', () => {
  const lines = c.checksLines(mockup());
  assert.equal(lines[0], 'Checks (4 problems, 0 differ, 9 passed):');
  assert.ok(lines.includes('- [problem] Standard addresses: /xmlrpc.php is open on the new server. Hostfile 200 OK; Live 403 Forbidden'));
  assert.ok(lines.some(l => l.startsWith(`  - old address ${OLD}: https://${OLD}/~northwind/wp-content/uploads/2026/10/logo.png`)));
  assert.match(lines.at(-1), /^- Passed: X-Robots-Tag, robots\.txt/);
  assert.deepEqual(c.checksLines(null), []);
  assert.equal(c.tabNoindex(['index, follow', 'noindex'], ''), 'meta robots');
  assert.equal(c.tabNoindex([], 'noindex, nofollow'), 'X-Robots-Tag');
  assert.equal(c.tabNoindex(['none'], ''), 'meta robots');
  assert.equal(c.tabNoindex(['index'], 'all'), ''); assert.equal(c.tabNoindex(null, undefined), '');
});

// Live could not be reached (1.2.0-beta.3): the new server on its own, judged on what a good server gives.
const ROBOTS_NEW = `User-agent: *\nDisallow: /wp-admin/\n\nSitemap: ${HOME}wp-sitemap.xml\n`;
function soloInput(answers = {}) {
  const list = c.standardAddresses({ pageURL: HOME, hostfileHTML: page('new'), wordpress: true, robotsLive: ROBOTS_NEW, random: 'a1b2c3d4' });
  const base = { link: ok(404, { server: 'nginx/1.26.2' }), xmlrpc: ok(200), robots: ok(200, {}, ROBOTS_NEW), sitemap: ok(200), login: ok(200), https: ok(301, { location: HOME }), missing: ok(404) };
  const results = { ...base, ...answers };
  return { pageURL: HOME, hostfile: ok(200, { server: 'nginx/1.26.2' }, page('new')), copies: [], standard: list.map(check => ({ check, hostfile: check.id === 'www' ? undefined : results[check.id] })) };
}
test('checks without Live: counts, Expected next to Hostfile, need Live, the sitemap from the new robots.txt', () => {
  const input = soloInput(), r = c.soloChecksReport(input);
  assert.equal(input.standard.find(s => s.check.id === 'sitemap').check.url, `${HOME}wp-sitemap.xml`);
  assert.equal(r.solo, true);
  assert.deepEqual(r.counts, { problems: 3, differ: 1, passed: 8, needLive: 2, total: 12 });
  assert.deepEqual(r.passed.map(p => p.name), ['X-Robots-Tag', 'robots.txt', 'canonical', '/robots.txt', '/wp-sitemap.xml', '/wp-login.php', 'http to https', 'random address gives 404']);
  assert.deepEqual(r.needLive, [{ name: 'www to bare domain', why: 'which name is the main one' }, { name: 'old server IP in the page', why: 'unknown without Live' }]);
  assert.deepEqual(r.groups.map(g => [g.label, g.items.map(i => [i.tone, i.title, i.hostfile, i.expected])]), [
    ['Search engines', [['worse', 'The new server tells search engines not to index the site', 'noindex, nofollow', 'index, follow or not set']]],
    ['Old addresses', [['worse', '3 old addresses in the page of the new server', '3 found, listed below', 'none (old server IP unknown without Live)']]],
    ['Standard addresses', [['worse', '/bestellen/ gives 404 on the new server', '404 Not Found', '200 OK, the page links to it'], ['differs', '/xmlrpc.php is open on the new server', '200 OK', '403 or 404, blocked']]]]);
  const old = r.groups[1].items[0];
  // Without the old server IP: the temporary URL on an IP (also escaped in a script, counted once), the staging copy, http.
  assert.deepEqual(old.rows.map(x => [x.kind, x.found, x.where]), [['tilde', '/~northwind/', 'img src, logo.png'], ['staging', 'staging.northwind-bakery.test', 'link "Northwind Bakery" in the footer'], ['http', 'http://northwind-bakery.test', 'link "Contact" in the menu']]);
  assert.deepEqual(old.commands.map(x => x.command), [`wp search-replace 'https://${OLD}/~northwind' 'https://northwind-bakery.test' --all-tables --dry-run`,
    "wp search-replace 'https://staging.northwind-bakery.test' 'https://northwind-bakery.test' --all-tables --dry-run", "wp search-replace 'http://northwind-bakery.test' 'https://northwind-bakery.test' --all-tables --dry-run"]);
  const [link, xmlrpc] = r.groups[2].items;
  assert.deepEqual(link.fix, ['pretty permalinks need ', { code: 'try_files $uri $uri/ /index.php?$args;' }, ' in nginx.']);
  assert.deepEqual(xmlrpc.fix, ['block it, for example ', { code: 'location = /xmlrpc.php { deny all; }' }, ' in nginx, or with a security plugin.']);
  assert.deepEqual([xmlrpc.action.label, xmlrpc.action.text], ['Copy rule', 'location = /xmlrpc.php { deny all; }']);
  assert.deepEqual(r.findings.map(f => [f.severity, f.text]), [
    ['high', 'The new server tells search engines not to index this site (meta robots noindex).'],
    ['high', 'The page on the new server still uses old addresses: a temporary URL, the staging domain and an http link.'],
    ['high', '/bestellen/ gives 404 on the new server, although the page links to it: permalinks or rewrite rules missing.'],
    ['both', '/xmlrpc.php is open on the new server (200).']]);
  assert.equal(r.noindex, 'worse');
  const lines = c.checksLines(r);
  assert.equal(lines[0], 'Checks of the new server alone, Live could not be reached (3 problems, 1 warnings, 8 passed, 2 need Live):');
  assert.ok(lines.includes('- [warning] Standard addresses: /xmlrpc.php is open on the new server. Hostfile 200 OK; expected 403 or 404, blocked'));
  assert.equal(lines.at(-1), '- Need Live: www to bare domain, old server IP in the page');
});
test('checks without Live judge each standard address on its own', () => {
  const v = (id, r, extra = {}) => c.soloStandardVerdict({ id, url: 'http://northwind-bakery.test/' }, r, { wordpress: true, named: false, ...extra });
  assert.equal(v('xmlrpc', ok(403)), 'pass'); assert.equal(v('xmlrpc', ok(405)), 'pass'); assert.equal(v('xmlrpc', fail('socket hang up')), 'pass', 'blocked by a firewall');
  assert.equal(v('xmlrpc', ok(200)), 'warn');
  assert.equal(v('link', ok(200)), 'pass'); assert.equal(v('link', ok(301, { location: '/x/' })), 'pass'); assert.equal(v('link', ok(500)), 'worse'); assert.equal(v('link', fail('timeout')), 'worse');
  assert.equal(v('robots', ok(404)), 'worse');
  assert.equal(v('sitemap', ok(301, { location: '/sitemap_index.xml' })), 'pass'); assert.equal(v('sitemap', ok(404)), 'worse');
  assert.equal(v('sitemap', ok(404), { wordpress: false }), 'warn', 'a guessed /sitemap.xml on a site that names none'); assert.equal(v('sitemap', ok(404), { wordpress: false, named: true }), 'worse');
  assert.equal(v('login', ok(403)), 'warn');
  assert.equal(v('https', ok(301, { location: 'https://northwind-bakery.test/' })), 'pass'); assert.equal(v('https', ok(200)), 'worse'); assert.equal(v('https', ok(301, { location: 'http://other.test/' })), 'worse');
  assert.equal(v('missing', ok(404)), 'pass'); assert.equal(v('missing', ok(410)), 'pass'); assert.equal(v('missing', ok(200)), 'worse');
  // http not going to https is a problem with the nginx line as fix; a site without noindex and old addresses passes those.
  const clean = page('old'), r = c.soloChecksReport({ ...soloInput({ https: ok(200), missing: ok(200) }), hostfile: ok(200, { server: 'nginx/1.26.2' }, clean) });
  assert.deepEqual(r.groups.map(g => g.id), ['std']);
  assert.ok(r.passed.some(p => p.name === 'meta robots') && r.passed.some(p => p.name === 'old addresses'));
  assert.deepEqual(r.groups[0].items.map(i => i.title), ['/bestellen/ gives 404 on the new server', '/xmlrpc.php is open on the new server', 'http does not go to https on the new server', 'An unknown address gives 200 on the new server']);
  assert.deepEqual(r.groups[0].items[2].fix, ['add ', { code: 'return 301 https://$host$request_uri;' }, ' to the port 80 server block in nginx.']);
  assert.equal(r.noindex, '');
});
