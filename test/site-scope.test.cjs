const test = require('node:test');
const assert = require('node:assert/strict');
const { pageTitle, sitemapsInRobots, parseSitemap, pageOf, pickPages, pastedPages, pageModel, siteResult, DEFAULT_PAGES, MAX_PAGES } = require('../src/site-scope.cjs');

const HOME = 'https://shop.example/';

test('the sitemap lines of robots.txt, and the addresses of a sitemap or an index', () => {
  assert.deepEqual(sitemapsInRobots('User-agent: *\nDisallow: /wp-admin/\n\nSitemap: https://shop.example/wp-sitemap.xml\r\nsitemap:https://shop.example/news.xml\nSitemap:\n# Sitemap: no\n'), ['https://shop.example/wp-sitemap.xml', 'https://shop.example/news.xml']);
  assert.deepEqual(sitemapsInRobots(Array.from({ length: 50 }, (_, i) => `Sitemap: https://shop.example/${i}.xml`).join('\n')).length, 5, 'at most five');
  assert.deepEqual(sitemapsInRobots(undefined), []);
  const set = parseSitemap('<?xml version="1.0"?><urlset><url><loc>https://shop.example/</loc></url><url><loc> https://shop.example/a?x=1&amp;y=2 </loc></url><url><loc><![CDATA[https://shop.example/b/]]></loc></url><url><loc></loc></url></urlset>');
  assert.deepEqual(set, { index: false, urls: ['https://shop.example/', 'https://shop.example/a?x=1&y=2', 'https://shop.example/b/'], capped: false });
  assert.equal(parseSitemap('<sitemapindex><sitemap><loc>https://shop.example/wp-sitemap-posts-post-1.xml</loc></sitemap></sitemapindex>').index, true);
  assert.deepEqual(parseSitemap('<html>404</html>').urls, []);
});

test('review 16: entities, upper case and namespaced loc tags, and an index recognised anywhere in the document', () => {
  const odd = parseSitemap('<?xml version="1.0"?><ns:urlset xmlns:ns="x"><ns:url><ns:loc>https://shop.example/a?x=1&#38;y=2&#x26;z=3</ns:loc></ns:url><URL><LOC>https://shop.example/B&apos;s/&quot;q&quot;&lt;&gt;</LOC></URL><url><loc xml:lang="en">https://shop.example/c</loc></url></ns:urlset>');
  assert.deepEqual(odd.urls, ['https://shop.example/a?x=1&y=2&z=3', 'https://shop.example/B\'s/"q"<>', 'https://shop.example/c']);
  assert.equal(odd.index, false);
  // The root element comes after 6000 characters of comment: still an index.
  const late = parseSitemap(`<?xml version="1.0"?><!-- ${'x'.repeat(6000)} --><SitemapIndex><sitemap><loc>https://shop.example/s1.xml</loc></sitemap></SitemapIndex>`);
  assert.deepEqual([late.index, late.urls], [true, ['https://shop.example/s1.xml']]);
  assert.deepEqual(parseSitemap('<urlset><url><loc>&#0;&#1114112;https://shop.example/x</loc></url></urlset>').urls, ['https://shop.example/x'], 'a character that cannot be is dropped');
});

test('a huge or hostile sitemap: capped in size and entries, read in linear time', () => {
  const many = parseSitemap(`<urlset>${'<url><loc>https://shop.example/p</loc></url>'.repeat(6000)}</urlset>`);
  assert.equal(many.urls.length, 5000); assert.equal(many.capped, true);
  const started = Date.now();
  assert.deepEqual(parseSitemap('<url><loc>'.repeat(300000)).urls, []);
  assert.deepEqual(parseSitemap(`<url><loc>${'<'.repeat(3000000)}`).urls, []);
  assert.deepEqual(parseSitemap('<loc'.repeat(700000)).urls, []);
  assert.deepEqual(parseSitemap(`<url><loc><![CDATA[${'x'.repeat(2500000)}`).urls, []);
  assert.ok(parseSitemap(`${'<url><loc>a</loc></url>'.repeat(10)}${' '.repeat(3000000)}<url><loc>late</loc></url>`).urls.length === 10, 'what lies beyond 2 MB is not read');
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(parseSitemap(`<url><loc>https://shop.example/${'a'.repeat(3000)}</loc></url><url><loc>https://shop.example/ok</loc></url>`).urls.length, 1, 'an absurdly long address is dropped');
});

test('the pages to compare: this site only, the home page first, each once, at most what was asked', () => {
  const urls = ['https://shop.example/cakes/', 'https://www.shop.example/bread/', 'http://shop.example/contact/', 'https://shop.example/cakes/#top', 'https://evil.example/x', 'https://shop.example.evil.example/', 'javascript:alert(1)',
    'https://user:pw@shop.example/secret', 'https://shop.example:8443/admin', '/about/', 'https://shop.example/', 'https://shop.example/sitemap-2.xml', 'https://shop.example/menu.pdf'];
  const picked = pickPages(urls, 'https://shop.example/cakes/wedding/', 20);
  assert.deepEqual(picked.pages, ['https://shop.example/', 'https://shop.example/cakes/', 'https://shop.example/bread/', 'https://shop.example/contact/', 'https://shop.example/about/']);
  assert.deepEqual([picked.other, picked.more], [7, false], 'addresses of other sites and files are counted, not asked');
  assert.equal(pickPages(Array.from({ length: 80 }, (_, i) => `/p${i}/`), HOME).pages.length, DEFAULT_PAGES);
  const capped = pickPages(Array.from({ length: 80 }, (_, i) => `/p${i}/`), HOME, 500);
  assert.deepEqual([capped.pages.length, capped.more, MAX_PAGES], [50, true, 50], 'never more than 50 pages, and collecting stops there');
  assert.deepEqual(pickPages([], HOME, 5).pages, [HOME], 'no list: the home page alone');
  assert.equal(pageOf('https://www.shop.example/a', 'https://shop.example/'), 'https://shop.example/a', 'the host name of the tab is kept, so its rule applies');
  assert.equal(pageOf('//evil.example/a', HOME), null);
});

test('review 16: /about and /about/ are one page, and so is a path with and without a query', () => {
  const picked = pickPages(['/about', '/about/', '/shop/?utm_source=mail', '/shop/', '/shop/?page=2', '/blog?x=1', '/?ref=home', '/contact/'], HOME, 20);
  assert.deepEqual(picked.pages, [HOME, 'https://shop.example/about', 'https://shop.example/shop/', 'https://shop.example/blog?x=1', 'https://shop.example/contact/'], 'the one without a query is kept');
  // Collecting stops at the limit: the hundred thousandth address is never looked at.
  let looked = 0; const endless = { [Symbol.iterator]: function* () { for (let i = 0; i < 100000; i++) { looked++; yield `/p${i}/`; } } };
  assert.equal(pickPages(endless, HOME, 5).pages.length, 5); assert.ok(looked <= 6, `looked at ${looked}`);
});

test('a pasted list: paths or addresses, validated, deduplicated, capped at 50', () => {
  const got = pastedPages('/contact/\ncakes/wedding/ , https://shop.example/bread/\nhttps://evil.example/x\n/contact/\nftp://shop.example/f', HOME);
  assert.deepEqual(got.pages, ['https://shop.example/', 'https://shop.example/contact/', 'https://shop.example/cakes/wedding/', 'https://shop.example/bread/']);
  assert.deepEqual([got.refused, got.sample], [2, ['https://evil.example/x', 'ftp://shop.example/f']]);
  const big = pastedPages(Array.from({ length: 70 }, (_, i) => `/p${i}/`).join('\n'), HOME);
  assert.deepEqual([big.pages.length, big.more], [50, true]);
  assert.deepEqual(pastedPages('', HOME).pages, [HOME]);
  // Review 16: the total of what was refused, not only the first five; a list that is too long is cut between words.
  const bad = pastedPages(Array.from({ length: 12 }, (_, i) => `https://evil${i}.example/`).join(' '), HOME);
  assert.deepEqual([bad.refused, bad.sample.length], [12, 5]);
  const long = pastedPages(`${'/a/ '.repeat(4999)}/this-word-is-cut-by-the-limit/and-must-not-become-a-page/`, HOME);
  assert.deepEqual(long.pages, [HOME, 'https://shop.example/a/'], 'the half word at the cut is left out');
});

test('review 1 of beta.4: the title of a page, in linear time', () => {
  assert.equal(pageTitle('<html><head><TITLE lang="en">  Fresh\n bread  </TITLE></head>'), 'Fresh bread');
  assert.equal(pageTitle('<title>no end'), 'no end'); assert.equal(pageTitle('<p>none</p>'), ''); assert.equal(pageTitle(undefined), '');
  assert.equal(pageTitle(`<title>${'x'.repeat(500)}</title>`).length, 200);
  const started = Date.now();
  assert.equal(pageTitle('<title'.repeat(900000)), '');
  assert.equal(pageTitle(`${' '.repeat(300000)}<title>late</title>`), 'late', 'the title the reading of the page found, wherever it is');
  assert.equal(pageTitle('<title>Sale \u202egpj.exe\u200b\u00ad</title>'), 'Sale gpj.exe', 'marks that hide or turn text are left out');
  assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
});

// Eight pages. On every page: noindex (Checks) and a card skimmer (Malware Scan). The home page also has the site-wide
// checks and the site-scope add-on. /order/ is missing on the new server, /cakes/ has old addresses of its own, six of
// the eight pages differ in a header.
const side = (extra = {}) => ({ ok: true, status: 200, ms: 100, redirects: [], ...extra });
const item = (tone, title) => ({ tone, title });
const checks = (...items) => ({ status: 'done', report: { counts: { problems: items.filter(i => i.tone === 'worse').length, differ: 0, passed: 3, total: 3 + items.length }, groups: [{ id: 'g', label: 'G', items }], passed: [] } });
const scan = (id, name, scope, ...items) => ({ id, name, by: 'SolutionMAX', scope, label: name, sub: '', status: 'done', error: '',
  report: { tone: 'bad', counts: { problems: items.length, differ: 0, passed: 1, total: 1 + items.length }, sub: '', summary: [{ tone: items.length ? 'bad' : 'ok', text: `${items.length} threats` }], groups: items.length ? [{ id: 'g', label: 'G', items }] : [], passed: [{ name: 'p' }] } });
const NOINDEX = item('worse', 'The new server tells search engines not to index the site'), SKIMMER = item('worse', 'A card skimmer loads from cdn-jquery.example');
const foreign = { host: 'cdn-jquery.example', hostfile: true, live: false, types: ['script'], firstParty: false };
function page(path, { missing = false, old = 0, header = true, first = false, script = false, status = 0, clean = false } = {}) {
  const url = new URL(path, HOME).href, gone = missing || status;
  const report = { url, hostfile: side(gone ? { status: status || 404 } : {}), live: side(), domains: script ? [foreign] : [], headers: header && !clean ? [{ name: 'server', hostfile: 'nginx', live: 'LiteSpeed' }] : [], html: { changedLines: clean ? 0 : missing ? 40 : 3 },
    findings: gone ? [{ severity: 'high', text: `HTTP status differs: Hostfile ${status || 404}, Live 200.` }] : [] };
  const cards = missing || clean ? [] : [NOINDEX, ...(old ? [item('worse', `${old} old addresses in the page of the new server`)] : []), ...(first ? [item('worse', '/xmlrpc.php is open on the new server'), item('differs', 'robots.txt differs')] : [])];
  const addonTabs = [scan('malware-scan', 'Malware Scan', 'page', ...(missing || clean ? [] : [SKIMMER])), ...(first ? [scan('wp-leak-check', 'WP Leak Check', 'site', item('worse', 'The debug log can be read by anyone'))] : [])];
  return pageModel({ url, title: `Title of ${path}`, report, checks: checks(...cards), addonTabs });
}
const PAGES = [page('/', { first: true }), page('/bread/'), page('/cakes/', { old: 3 }), page('/order/', { missing: true }), page('/contact/', { header: false }), page('/about/'), page('/blog/'), page('/terms/')];
const ONCE = ['/xmlrpc.php is open on the new server', 'robots.txt differs'];

test('whole site: what every page has is said once, with where it was found', () => {
  const site = siteResult(PAGES, { onceChecks: ONCE }), by = id => site.parts.find(p => p.id === id);
  assert.deepEqual(site.parts.map(p => p.id), ['domains', 'html', 'headers', 'checks', 'addon:malware-scan', 'addon:wp-leak-check']);
  assert.deepEqual([by('domains').state, by('domains').where], ['ok', 'Fine on all 8 pages']);
  assert.deepEqual([by('html').state, by('html').where, by('html').tag], ['info', 'On all 8 pages', '3 lines']);
  const c = by('checks');
  assert.deepEqual([c.state, c.wideState, c.where, c.wideWhere, c.tag], ['fix', 'fix', 'On 7 of 8 pages', 'On 7 of 8 pages', '2 failed']);
  assert.deepEqual(c.tops, ['The new server tells search engines not to index the site', '/xmlrpc.php is open on the new server', 'robots.txt differs'], 'the site-wide checks of the home page count for the site');
  assert.deepEqual([by('addon:malware-scan').wideState, by('addon:malware-scan').where, by('addon:malware-scan').tag], ['fix', 'On 7 of 8 pages', '1 threats']);
  assert.deepEqual([by('addon:wp-leak-check').state, by('addon:wp-leak-check').where, by('addon:wp-leak-check').tops], ['fix', 'Once for the site', ['The debug log can be read by anyone']]);
  // Only pages with something of their own are listed.
  assert.deepEqual(site.own.map(p => [p.path, p.state, p.tag, p.text, p.title]), [
    ['/cakes/', 'fix', '1 to fix', '3 old addresses in the page of the new server', 'Title of /cakes/'],
    ['/order/', 'fix', '1 to fix', 'HTTP status differs: Hostfile 404, Live 200', 'Title of /order/']]);
  assert.deepEqual(site.rest.map(p => p.path), ['/', '/bread/', '/contact/', '/about/', '/blog/', '/terms/']);
});

test('review 15: checks that are asked once say "Once for the site", not "On 1 of 9 pages"', () => {
  // Nothing wrong on the pages themselves; only the site-wide checks of the home page fail.
  const quiet = path => pageModel({ url: new URL(path, HOME).href, report: { url: new URL(path, HOME).href, hostfile: side(), live: side(), domains: [], headers: [], html: { changedLines: 0 }, findings: [] }, checks: checks(), addonTabs: [] });
  const home = pageModel({ url: HOME, report: { url: HOME, hostfile: side(), live: side(), domains: [], headers: [], html: { changedLines: 0 }, findings: [] }, checks: checks(item('worse', '/xmlrpc.php is open on the new server'), item('differs', 'robots.txt differs')), addonTabs: [] });
  const c = siteResult([home, ...['/a/', '/b/', '/c/', '/d/', '/e/', '/f/', '/g/', '/h/'].map(quiet)], { onceChecks: ONCE }).parts.find(p => p.id === 'checks');
  assert.deepEqual([c.state, c.where, c.wideWhere, c.tag], ['fix', 'Once for the site', 'Once for the site', '1 failed']);
  assert.deepEqual(c.found.map(f => [f.text, f.once, f.pages]), [['/xmlrpc.php is open on the new server', true, []], ['robots.txt differs', true, []]]);
});

test('review 10 and beta.6 item 4: status per page however many, a script from another site once for the site when it is on most pages', () => {
  // "HTTP status differs" on 6 of 10 pages, a script from another site on 7 of 10.
  const pages = Array.from({ length: 10 }, (_, i) => page(i ? `/p${i}/` : '/', { clean: true, status: i >= 4 ? 404 : 0, script: i < 7 }));
  const site = siteResult(pages), headers = site.parts.find(p => p.id === 'headers'), domains = site.parts.find(p => p.id === 'domains');
  assert.deepEqual(site.own.map(p => [p.path, p.tag]), [['/p4/', '1 to fix'], ['/p5/', '1 to fix'], ['/p6/', '1 to fix'], ['/p7/', '1 to fix'], ['/p8/', '1 to fix'], ['/p9/', '1 to fix']], 'the status on 6 of 10 pages stays under each page; the script on 7 of 10 is said once');
  assert.deepEqual(site.rest.map(p => p.path), ['/', '/p1/', '/p2/', '/p3/']);
  assert.deepEqual(site.own.find(p => p.path === '/p5/'), { url: 'https://shop.example/p5/', path: '/p5/', title: 'Title of /p5/', state: 'fix', tag: '1 to fix', text: 'HTTP status differs: Hostfile 404, Live 200' });
  // On half of the pages or fewer, a script from another site is listed under its pages.
  const few = siteResult(Array.from({ length: 10 }, (_, i) => page(i ? `/p${i}/` : '/', { clean: true, script: i >= 5 })));
  assert.deepEqual(few.own.map(p => [p.path, p.text]), [5, 6, 7, 8, 9].map(i => [`/p${i}/`, 'cdn-jquery.example, script']));
  // It is wide as well, so it is also said for the site, with the pages it is on.
  assert.deepEqual([headers.wideState, headers.wideWhere, headers.tops], ['fix', 'On 6 of 10 pages', ['HTTP status differs: Hostfile 404, Live 200']]);
  assert.deepEqual(headers.found, [{ text: 'HTTP status differs: Hostfile 404, Live 200', state: 'fix', wide: true, once: false, pages: ['/p4/', '/p5/', '/p6/', '/p7/', '/p8/', '/p9/'] }]);
  assert.deepEqual([domains.wideState, domains.wideWhere, domains.found[0].pages.length], ['fix', 'On 7 of 10 pages', 7]);
  // A site-wide finding that is not about the page (noindex on every page) is said once and its pages can be looked up.
  const checksPart = siteResult(PAGES, { onceChecks: ONCE }).parts.find(p => p.id === 'checks');
  assert.deepEqual(checksPart.found.find(f => /not to index/.test(f.text)).pages, ['/', '/bread/', '/cakes/', '/contact/', '/about/', '/blog/', '/terms/']);
});

test('review 11: merged findings keep the text of each page, the site line shows the range, an info point is not dropped', () => {
  const pages = [page('/', { old: 3 }), page('/a/', { old: 300 }), page('/b/', { old: 12 }), page('/c/', { clean: true, header: true })];
  // /c/ alone differs in a header: an info point on one page.
  pages[3] = pageModel({ url: `${HOME}c/`, title: 'c', report: { url: `${HOME}c/`, hostfile: side(), live: side(), domains: [], headers: [{ name: 'vary', hostfile: 'a', live: 'b' }], html: { changedLines: 0 }, findings: [] }, checks: checks(), addonTabs: [] });
  for (const p of pages.slice(0, 3)) p.parts.find(x => x.id === 'headers').state = 'ok';
  for (const p of pages.slice(0, 3)) p.parts.find(x => x.id === 'headers').all = [];
  const site = siteResult(pages), c = site.parts.find(p => p.id === 'checks'), headers = site.parts.find(p => p.id === 'headers');
  assert.ok(c.tops.includes('3 to 300 old addresses in the page of the new server'), JSON.stringify(c.tops));
  assert.deepEqual(c.found.find(f => /old addresses/.test(f.text)).pages, ['/', '/a/', '/b/']);
  assert.deepEqual([headers.state, headers.where, headers.tag], ['info', 'On 1 of 4 pages', '1 page']);
  assert.deepEqual(headers.found, [{ text: '', state: 'info', wide: false, once: false, pages: ['/c/'] }], 'the header difference of one page can still be found');
  // On the page rows each page has its own number: old addresses on one page of five are that page's own.
  const few = siteResult([page('/', { clean: true }), page('/a/', { old: 300 }), page('/b/', { clean: true }), page('/c/', { clean: true }), page('/d/', { clean: true }), page('/e/', { clean: true }), page('/f/', { old: 7 })]);
  assert.deepEqual(few.own.map(p => [p.path, p.text]), [['/a/', 'The new server tells search engines not to index the site, and 2 more'], ['/f/', 'The new server tells search engines not to index the site, and 2 more']]);
  assert.deepEqual(few.parts.find(p => p.id === 'checks').found.find(f => /old addresses/.test(f.text)), { text: '7 to 300 old addresses in the page of the new server', state: 'fix', wide: false, once: false, pages: ['/a/', '/f/'] });
});

test('review 12: the state of a part for the site is the worst of what is site-wide and what single pages have', () => {
  // The image from another host is on every page (amber, site-wide); a script from another site is on one page (red).
  const img = { host: 'img.example', hostfile: true, live: false, types: ['image'], firstParty: false };
  const pages = ['/', '/a/', '/b/', '/c/', '/d/'].map((path, i) => { const p = page(path, { clean: true }); const m = pageModel({ url: p.url, title: 't', report: { url: p.url, hostfile: side(), live: side(), domains: i === 3 ? [img, foreign] : [img], headers: [], html: { changedLines: 0 }, findings: [] }, checks: checks(), addonTabs: [] }); return m; });
  const d = siteResult(pages).parts.find(p => p.id === 'domains');
  assert.deepEqual([d.state, d.tag, d.where], ['fix', '1 page', 'On 1 of 5 pages'], 'the menu row is red, as the verdict is');
  assert.deepEqual([d.wideState, d.wideTag, d.wideWhere, d.tops], ['check', '1 new', 'On all 5 pages', ['img.example, image']], 'for the site as a whole it is something to look at');
  assert.deepEqual(siteResult(pages).own.map(p => [p.path, p.state, p.text]), [['/c/', 'fix', 'cdn-jquery.example, script, only on Hostfile'.replace(', only on Hostfile', '')]]);
});

test('whole site: a page that could not be fetched or that only the new server sends elsewhere is a finding of that page', () => {
  const failed = pageModel({ url: `${HOME}down/`, report: { url: `${HOME}down/`, hostfile: { ok: false, error: 'socket hang up' }, live: side(), domains: [], headers: [], html: { changedLines: 0 }, findings: [{ severity: 'high', text: 'The Hostfile request failed: socket hang up.' }] },
    checks: { status: 'error', report: null, error: 'The page could not be fetched, so the checks did not run.' }, addonTabs: [] });
  const quiet = (path, extra = []) => pageModel({ url: new URL(path, HOME).href, report: { url: new URL(path, HOME).href, hostfile: side(), live: side(), domains: [], headers: [], html: { changedLines: 0 }, findings: [] }, checks: checks(), addonTabs: [scan('malware-scan', 'Malware Scan', 'page')], extra });
  const hijacked = quiet('/win/', [{ state: 'fix', text: 'The new server sends this page to prizes.example, Live does not' }]);
  const site = siteResult([quiet('/'), quiet('/a/'), failed, quiet('/b/'), hijacked]);
  assert.deepEqual(site.own.map(p => [p.path, p.state, p.tag, p.text]), [['/down/', 'fix', '1 to fix', 'The Hostfile request failed: socket hang up'], ['/win/', 'fix', '1 to fix', 'The new server sends this page to prizes.example, Live does not']]);
  assert.deepEqual(site.parts.map(p => [p.id, p.state, p.where]), [['domains', 'ok', 'Fine on all 5 pages'], ['html', 'ok', 'Fine on all 5 pages'], ['headers', 'ok', 'Fine on all 5 pages'], ['checks', 'ok', 'Fine on 4 of 5 pages'], ['addon:malware-scan', 'ok', 'Fine on 4 of 5 pages']], 'a part that did not run on a page does not claim that page');
  const one = siteResult([PAGES[0]], { onceChecks: ONCE });
  assert.deepEqual([one.parts.find(p => p.id === 'html').where, one.own.length, one.rest.length], ['On the page', 0, 1]);
  assert.deepEqual(siteResult([]), { parts: [], own: [], rest: [] });
});
