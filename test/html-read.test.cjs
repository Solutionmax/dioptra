// How a page is read (1.4.0-beta.6): by the HTML tokenizer browsers follow, so a page cannot show a browser a script
// that Dioptra does not see. Every case below hid a script from the reader of beta.5.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readPage, extractAssets, cssURLs, MAX_ASSETS, MAX_INLINE, MAX_CANDIDATES, MAX_CSS_URLS, MAX_DEPTH } = require('../src/html-read.cjs');
const { buildReport } = require('../src/differences.cjs');
const { pageFacts, oldAddresses, standardAddresses, internalLink } = require('../src/site-checks.cjs');
const { pageTitle, parseSitemap, pageModel, siteResult, pickPages, pastedPages, redirectStep, leftFindings, pathOf } = require('../src/site-scope.cjs');
const { diffParts, diffVerdict } = require('../src/differences-parts.js');
const { cleanReport } = require('../src/addons.cjs');

const PAGE = 'https://good.site.test/dir/page.html', EVIL = 'evil.example';
const hosts = html => extractAssets(html, PAGE).assets.map(a => `${a.type} ${a.host}`);
const side = (body, more = {}) => ({ ok: true, status: 200, ms: 1, redirects: [], headers: {}, body, finalUrl: PAGE, ip: '203.0.113.10', ...more });

const HIDDEN_SCRIPTS = {
  'five "İ" before it (a lower-cased copy is longer than the text)': `<p>${'İ'.repeat(5)}</p><script src="https://${EVIL}/x.js"></script>`,
  'three hundred "İ" before it': `<p>${'İ'.repeat(300)}</p><script src="https://${EVIL}/x.js"></script>`,
  'a ">" in a quoted attribute': `<script title="a > b" src="https://${EVIL}/x.js"></script>`,
  'a ">" in a single-quoted attribute of the tag before': `<img alt='>' ><script data-x='>' src="https://${EVIL}/x.js"></script>`,
  'an entity for the colon': `<script src="https&#58;//${EVIL}/x.js"></script>`,
  'an entity for the first letter': `<script src="&#x68;ttps://${EVIL}/x.js"></script>`,
  'a named entity without semicolon in the address': `<script src="https://${EVIL}/x.js?a=1&ampb=2"></script>`,
  'after <!--> (an empty comment)': `<!--><script src="https://${EVIL}/x.js"></script><!-- -->`,
  'after <!---> (an empty comment)': `<!---><script src="https://${EVIL}/x.js"></script><!-- -->`,
  'after a comment that ends with --!>': `<!-- a --!><script src="https://${EVIL}/x.js"></script><!-- -->`,
  'an unquoted address with a quote in it': `<script src=https://good.site.test"@${EVIL}/a.js></script>`,
  'script href in svg': `<svg><script href="https://${EVIL}/x.js"></script></svg>`,
  'script xlink:href in svg, self-closed': `<svg><script xlink:href="https://${EVIL}/x.js"/></svg>`,
  'a base address': `<base href="https://${EVIL}/"><script src="lib/a.js"></script>`,
  'an iframe with its document in srcdoc': `<iframe srcdoc="&lt;script src=https://${EVIL}/x.js&gt;&lt;/script&gt;"></iframe>`,
  'a comment opened inside noscript': `<noscript><!-- </noscript><script src="https://${EVIL}/x.js"></script><!-- -->`,
  'a <![CDATA[ outside svg (a comment that ends at the first ">")': `<![CDATA[ > ]]><script src="https://${EVIL}/x.js"></script>`,
  'after a textarea that quotes a comment start': `<textarea><!--</textarea><script src="https://${EVIL}/x.js"></script>`,
  'after </script foo>': `<script>a()</script foo><script src="https://${EVIL}/x.js"></script>`,
  'upper case and new lines': `<SCRIPT\n\tSRC\n=\n"https://${EVIL}/x.js"\n></SCRIPT\n>`,
  'after twenty thousand and one images': `${'<img src=a.png>'.repeat(MAX_ASSETS + 1)}<script src="https://${EVIL}/x.js"></script>`,
  // The security review of 1.4.0-beta.6 (H1 to H3): the small tree builder took a foreign element for HTML.
  'in the title of an SVG (H1: that title is SVG, not HTML raw text)': `<svg><title><script src="https://${EVIL}/x.js"></script></title></svg>`,
  'after a self-closed svg (H2: <![CDATA[ is then a comment that ends at the first ">")': `<svg/><![CDATA[x><script src="https://${EVIL}/x.js"></script>`,
  'after a self-closed math (H2)': `<math/><![CDATA[x><script src="https://${EVIL}/x.js"></script>`,
  'after MathML inside SVG (H3: it stays SVG, so <mi> is no island and <style> no raw text)': `<svg><math><mi><style><p><script src="https://${EVIL}/x.js"></script></style>`,
  'after SVG inside MathML (H3)': `<math><svg><title><script></script><p><script src="https://${EVIL}/x.js"></script>`,
  'in the document of an iframe in the document of an iframe (two levels of srcdoc)': `<iframe srcdoc="&lt;iframe srcdoc=&quot;&amp;lt;script src=https://${EVIL}/x.js&amp;gt;&amp;lt;/script&amp;gt;&quot;&gt;&lt;/iframe&gt;"></iframe>`,
  'in a noscript inside a noscript': `<noscript><noscript><script src="https://${EVIL}/x.js"></script></noscript></noscript>`,
  'as the six hundredth attribute of its tag': `<script ${Array.from({ length: 599 }, (_, i) => `a${i}=1`).join(' ')} src="https://${EVIL}/x.js"></script>`,
};
for (const [name, html] of Object.entries(HIDDEN_SCRIPTS)) {
  test(`a script from another site is found: ${name}`, () => {
    assert.ok(hosts(html).includes(`script ${EVIL}`), JSON.stringify(hosts(html).slice(0, 5)));
    // And the comparison turns External domains red for it.
    const report = buildReport({ url: PAGE, hostfile: side(html), live: side('<html></html>') });
    const domains = diffParts({ differences: { report } }).parts.find(p => p.id === 'domains');
    assert.equal(domains.state, 'fix'); assert.ok(domains.all.some(p => p.text.startsWith(EVIL) && p.state === 'fix'));
  });
}

test('what runs as a script is decided by the type a browser reads, not by a word in it', () => {
  const inline = html => extractAssets(html, PAGE).inlineScripts;
  assert.deepEqual(inline('<script type="text/javascript;x=json">go()</script>'), ['go()'], 'a parameter with "json" in it does not stop a browser');
  assert.deepEqual(inline('<script type="module">go()</script><script type="">a()</script><script type=" TEXT/JavaScript ">b()</script><script language="JavaScript1.2">c()</script>'), ['go()', 'a()', 'b()', 'c()']);
  assert.deepEqual(inline('<script type="application/ld+json">{"a":1}</script><script type="text/template"><b>x</b></script><script type="text/x-handlebars">x</script><script type="importmap">{}</script><script language="vbscript">x</script>'), []);
  assert.deepEqual(inline('<script>a()</scripts><img src=x.png></script><script>b()</script>'), ['a()</scripts><img src=x.png>', 'b()'], '"</scripts>" does not end a script');
  assert.deepEqual(inline('<svg><script>inSvg()</script></svg>'), ['inSvg()']);
  assert.deepEqual(inline('<script>never ended()'), [], 'a script without its end tag is not run');
});

test('the facts of a page: robots, title, links and the menu are read past "İ", comments and look-alike tags', () => {
  const html = `<head><meta content="${'İ'.repeat(5)}"><meta name="robots" content="noindex"><title>Merhaba dünya</title><link rel="canonical" href="/c?a=1&amp;b=2"></head>
<navigation><a href="/not-menu">x</a></navigation><nav><a href="/menu">Menu <b>item</b></a></nav><a href="/after">After</a><footer><a href="/foot">Foot</a></footer>`;
  const facts = pageFacts(html, PAGE);
  assert.equal(facts.robots, 'noindex'); assert.equal(pageTitle(html, PAGE), 'Merhaba dünya'); assert.equal(facts.canonical, 'https://good.site.test/c?a=1&b=2');
  assert.deepEqual(facts.tags.filter(t => t.tag === 'a').map(t => `${t.value}${t.where} "${t.label}"`), ['/not-menu "x"', '/menu in the menu "Menu item"', '/after "After"', '/foot in the footer "Foot"'], '<navigation> is not <nav>');
  assert.equal(pageFacts('<!--><meta name=robots content=noindex><!-- -->', PAGE).robots, 'noindex');
  assert.equal(pageFacts('<!-- <meta name=robots content=noindex> -->', PAGE).robots, '');
  // An address that Live has too is not an old address, whichever way the "&" is written.
  const both = '<a href="http://good.site.test/x?a=1&amp;b=2">x</a>';
  assert.deepEqual(oldAddresses({ hostfileHTML: both, liveHTML: both.replace('&amp;', '&#38;'), pageURL: PAGE }), []);
  assert.equal(oldAddresses({ hostfileHTML: both, liveHTML: '<p>none</p>', pageURL: PAGE }).length, 1);
  // What a visitor without scripts would load is still found, and so is an address in it.
  assert.deepEqual(hosts('<noscript><img src="https://pixel.example/p.gif"><iframe src="https://tag.example/ns"></iframe></noscript>'), ['image pixel.example', 'frame tag.example']);
  assert.deepEqual(pageFacts('<noscript><img src="http://198.51.100.24/~u/p.gif"></noscript>', PAGE).tags.map(t => t.value), ['http://198.51.100.24/~u/p.gif']);
});

test('css addresses: one without its end does not stop the reading, and positions hold after "İ"', () => {
  assert.deepEqual(cssURLs(`a{background:url("x.png} b{background:url(https://${EVIL}/y.png)} c{background:URL( 'z.png' )}`), [`https://${EVIL}/y.png`, 'z.png']);
  assert.deepEqual(cssURLs(`/* ${'İ'.repeat(40)} */ a{background:url(https://${EVIL}/y.png)}`), [`https://${EVIL}/y.png`]);
  assert.deepEqual(hosts(`<style>a{background:url("x.png} b{background:url(https://${EVIL}/y.png)}</style>`), [`other ${EVIL}`]);
  assert.deepEqual(hosts(`<div style="${'İ'.repeat(9)};background:url(https://${EVIL}/y.png)">`), [`other ${EVIL}`]);
});

test('a sitemap: only loc directly under url or sitemap, positions hold after "İ"', () => {
  const xml = `<?xml version="1.0"?><!-- ${'İ'.repeat(50)} --><urlset><url><loc>https://shop.example/a</loc><image:image><image:loc>https://shop.example/a.jpg</image:loc></image:image><video:video><video:player_loc>https://v.example/</video:player_loc></video:video></url><url note="a > b"><loc>https://shop.example/b</loc></url></urlset>`;
  assert.deepEqual(parseSitemap(xml).urls, ['https://shop.example/a', 'https://shop.example/b']);
  assert.deepEqual(parseSitemap('<loc>https://shop.example/loose</loc><x><loc>https://shop.example/x</loc></x>').urls, []);
});

test('a cap that is reached is said, on the page and on its part, in amber', () => {
  const cut = html => { const report = buildReport({ url: PAGE, hostfile: side(html), live: side('<html></html>') }); return [report, diffParts({ differences: { report } }).parts.find(p => p.id === 'domains')]; };
  const [images, part] = cut('<img src=a.png>'.repeat(MAX_ASSETS + 1));
  assert.deepEqual(images.findings.filter(f => /not read to the end/.test(f.text)), [{ severity: 'medium', text: `The Hostfile page was not read to the end: more than ${MAX_ASSETS} addresses.` }]);
  assert.deepEqual([part.state, part.all.find(p => /not read/.test(p.text))], ['check', { text: `The Hostfile page was not read to the end: more than ${MAX_ASSETS} addresses`, state: 'check', key: 'The Hostfile page was not read to the end' }]);
  const [scripts] = cut('<script>a()</script>'.repeat(MAX_INLINE + 1));
  assert.match(scripts.findings.map(f => f.text).join(' '), new RegExp(`not read to the end: more than ${MAX_INLINE} inline scripts`));
  // A body that was longer than the cap: the fetch says so, and the page says it.
  const report = buildReport({ url: PAGE, hostfile: side('<html></html>', { bodyCut: 5 }), live: side('<html></html>') }), domains = diffParts({ differences: { report } }).parts.find(p => p.id === 'domains');
  assert.deepEqual([domains.state, domains.tag, domains.all.map(p => p.text)], ['check', 'Not all read', ['The Hostfile page was not read to the end: only the first 5 MB']]);
  // In a whole-site result it is listed under the page that has it.
  const model = url => pageModel({ url, report: url.endsWith('/big/') ? { ...report, url } : buildReport({ url, hostfile: side('<p>x</p>'), live: side('<p>x</p>') }), checks: null, addonTabs: [] });
  const site = siteResult(['/', '/a/', '/big/', '/b/'].map(p => model(`https://good.site.test${p}`)));
  assert.deepEqual(site.own.map(p => [p.path, p.state, p.text]), [['/big/', 'check', 'The Hostfile page was not read to the end: only the first 5 MB']]);
  assert.equal(extractAssets('<p>small</p>', PAGE).cut, '');
  // More candidates in one srcset than any page has: the first hundred count, and that is said.
  const srcset = readPage(`<img srcset="${'a.png 1x,'.repeat(5000)}">`, PAGE);
  assert.deepEqual([srcset.assets.length, srcset.cut], [100, `more than ${MAX_CANDIDATES} candidates in one srcset`]);
  assert.equal(readPage(`<img srcset="${'b.png 1x,'.repeat(100)}  , ">`, PAGE).cut, '', 'a hundred and a trailing comma is not more');
  assert.equal(readPage(`<img srcset="${'c.png 1x,'.repeat(100)},https://${EVIL}/x.png">`, PAGE).cut, `more than ${MAX_CANDIDATES} candidates in one srcset`, 'an empty candidate does not hide the next one');
  // More addresses in one style than any page has.
  const style = readPage(`<style>${'a{background:url(x.png)}'.repeat(MAX_CSS_URLS + 1)}</style>`, PAGE);
  assert.deepEqual([style.assets.length, style.cut], [MAX_CSS_URLS, `more than ${MAX_CSS_URLS} addresses in one style`]);
  assert.equal(readPage(`<p style="${'background:url(y.png);'.repeat(MAX_CSS_URLS + 1)}">`, PAGE).cut, `more than ${MAX_CSS_URLS} addresses in one style`);
  // Documents nested deeper than are read: said, not skipped.
  let deep = `<script src="https://${EVIL}/x.js"></script>`;
  for (let i = 0; i <= MAX_DEPTH; i++) deep = `<iframe srcdoc="${deep.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`;
  assert.deepEqual([hosts(deep), readPage(deep, PAGE).cut], [[], `documents and text nested more than ${MAX_DEPTH} levels deep`]);
});

test('possible: what a browser that disagrees with the reader would run is found, amber and never red on its own', () => {
  const read = html => readPage(html, PAGE), maybe = html => read(html).possible.map(a => `${a.type} ${a.host}`);
  const domains = (hostfileHTML, liveHTML = '<p>clean</p>') => { const report = buildReport({ url: PAGE, hostfile: side(hostfileHTML), live: side(liveHTML) }); return [report, diffParts({ differences: { report } })]; };
  // H4: Firefox and Safari ignore <xmp> and <style> inside <select> and run the script; new Chromium reads them as raw text.
  for (const html of [`<select><xmp><script src="https://${EVIL}/x.js"></script></xmp></select>`, `<select><style><p><script src="https://${EVIL}/x.js"></script></style></select>`]) {
    assert.deepEqual([hosts(html), maybe(html)], [[], [`script ${EVIL}`]], html);
    const [report, { parts, rest }] = domains(html), part = parts.find(p => p.id === 'domains');
    assert.deepEqual(report.findings.map(f => [f.severity, f.text]), [['medium', `Script from ${EVIL} found only on Hostfile, inside text that a browser may still run.`]]);
    assert.deepEqual([part.state, part.tag, part.all], ['check', 'Possibly hidden', [{ text: `Script from ${EVIL} found only on Hostfile, inside text that a browser may still run`, state: 'check' }]]);
    assert.deepEqual(rest, [], 'covered by External domains, not a note of its own');
    assert.equal(diffVerdict({ parts, rest }).tone !== 'worse', true, 'not red');
  }
  // Every kind of text is read again: raw text elements, comments, <![CDATA[ in SVG, <plaintext>; entities stay as they are.
  assert.deepEqual(maybe(`<textarea><script src="https://${EVIL}/a.js"></script></textarea><title><iframe src="https://${EVIL}/f"></iframe></title><noembed><img src="https://${EVIL}/i.png"></noembed>`), [`script ${EVIL}`, `frame ${EVIL}`, `image ${EVIL}`]);
  assert.deepEqual(maybe(`<!-- <script src="https://${EVIL}/c.js"></script> --><svg><![CDATA[ x><script src="https://${EVIL}/d.js"></script> ]]></svg><plaintext><script src="https://${EVIL}/e.js">`), [`script ${EVIL}`, `script ${EVIL}`, `script ${EVIL}`]);
  assert.deepEqual(maybe(`<select><title><b title=&quot;><script src="https://${EVIL}/x.js"></script></title></select>`), [`script ${EVIL}`], 'an entity in raw text is not decoded before it is read as markup');
  assert.deepEqual(maybe('<title>&lt;script src="https://not.example/x.js"&gt;</title>'), [], 'nor does an entity become a tag');
  assert.equal(read('<title>Caf&eacute; &amp; bar</title>').title, 'Café & bar', 'the title itself is decoded');
  // Prose about tags in a comment: raw text without its end tag is read on as markup, so it does not nest deeper and deeper.
  const prose = read(`<!-- Name it in <title>, keep one <title> per page, never a second <title>; a tiny <script src="https://${EVIL}/x.js"> toggles the tabs. -->`);
  assert.deepEqual([prose.cut, prose.possible.map(a => a.host)], ['', [EVIL]]);
  // What both sides have is no difference, and neither is what the other side has for certain.
  const both = `<!-- <script src="https://${EVIL}/x.js"></script> -->`;
  assert.deepEqual(domains(both, both)[0].findings, []);
  assert.deepEqual(domains(both, `<script src="https://${EVIL}/x.js"></script>`)[0].findings.map(f => f.severity), ['high'], 'Live loads it for certain: the domain finding, nothing possible');
  assert.deepEqual(domains('<!-- <script src="https://cdn.site.test/x.js"></script> -->')[0].findings, [], 'a site of the page itself');
  // Something for certain on top: still red, the possible one is a point next to it.
  const [, { parts }] = domains(`<script src="https://${EVIL}/x.js"></script><!-- <iframe src="https://frame.example/"></iframe> -->`), part = parts.find(p => p.id === 'domains');
  assert.deepEqual([part.state, part.all.map(p => p.state)], ['fix', ['fix', 'check']]);
  // An obfuscated script in text: amber in HTML, where one for certain is red.
  const obfuscated = `<select><xmp><script>var _0x1a2b=['\\x68\\x65\\x6c\\x6c\\x6f','\\x77\\x6f','\\x72\\x6c\\x64\\x21'];eval(atob('ZG9jdW1lbnQud3JpdGUoMSk='));</script></xmp></select>`;
  const [report, { parts: all }] = domains(obfuscated);
  assert.match(report.findings.map(f => f.text).join('\n'), /^Inline script that looks obfuscated appears only on Hostfile, inside text that a browser may still run: /m);
  assert.equal(all.find(p => p.id === 'html').state, 'check');
  // Many of them: five by name, the rest counted, in one line.
  const many = Array.from({ length: 8 }, (_, i) => `<script src="https://s${i}.example/x.js"></script>`).join('');
  assert.deepEqual(domains(`<!-- ${many} -->`)[0].findings.map(f => f.text.split(',')[0]), ['Script from s0.example found only on Hostfile', 'Script from s1.example found only on Hostfile', 'Script from s2.example found only on Hostfile', 'Script from s3.example found only on Hostfile', 'Script from s4.example found only on Hostfile', '3 more scripts or frames from other sites found only on Hostfile']);
});

// A page in UTF-16 loaded a script from another site with zero findings (u16.js of the review): read as UTF-8 it is
// mostly NUL characters and no tag is found.
test('a page in UTF-16 is decoded as a browser decodes it, and one that cannot be read is said', async () => {
  const { readBody, decodeBody } = require('../src/differences.cjs');
  const html = `<html><head><title>Shop</title></head><body><script src="https://${EVIL}/x.js"></script></body></html>`;
  const le = Buffer.from(html, 'utf16le'), be = Buffer.from(le).swap16();
  const body = (bytes, type = 'text/html') => ({ headers: new Headers({ 'content-type': type }), body: new Blob([bytes]).stream() });
  for (const [name, response] of [['byte order mark, little endian', body(Buffer.concat([Buffer.from([0xff, 0xfe]), le]))], ['byte order mark, big endian', body(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))], ['charset=utf-16 in the Content-Type', body(le, 'text/html; charset=UTF-16')], ['charset=utf-16be', body(be, 'text/html;charset="utf-16BE"')]]) {
    const text = await readBody(response);
    assert.equal(text, html, name);
    const report = buildReport({ url: PAGE, hostfile: side(text), live: side('<html><head><title>Shop</title></head><body></body></html>') });
    assert.deepEqual(report.findings.map(f => f.severity), ['high'], name);
  }
  assert.equal(decodeBody(Buffer.from(`\ufeff${html}`)), `\ufeff${html}`, 'UTF-8 with its mark stays as it was read');
  assert.equal(decodeBody(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), 'text/html; charset=utf-16'), '\ufeffa', 'the mark goes before the Content-Type, as in a browser');
  // UTF-16 without a mark or a charset: a browser may still read it; Dioptra cannot, and says so in amber.
  const unread = le.toString('utf8'), report = buildReport({ url: PAGE, hostfile: side(unread), live: side('<html></html>') });
  assert.deepEqual(report.findings.map(f => [f.severity, f.text]), [['medium', 'The Hostfile page was not read to the end: most of it is NUL characters: it is in an encoding Dioptra does not read, such as UTF-16 without a byte order mark.']]);
  assert.equal(diffParts({ differences: { report } }).parts.find(p => p.id === 'domains').state, 'check');
  assert.equal(readPage(`<p>${'a\0'.repeat(10)}</p>`, PAGE).cut, '', 'a few NUL characters are nothing');
});

test('what the reader reads that it did not before: <image>, a style in SVG, @import and image-set strings', () => {
  assert.deepEqual(hosts(`<image src="https://${EVIL}/i.png"><svg><style>@import "https://css.example/a.css";</style></svg>`), [`image ${EVIL}`, 'other css.example']);
  assert.deepEqual(cssURLs(`@import "https://a.example/1.css"; @import url(https://b.example/2.css); @IMPORT'https://c.example/3.css' screen;`), ['https://a.example/1.css', 'https://b.example/2.css', 'https://c.example/3.css']);
  assert.deepEqual(cssURLs(`a{background:image-set("https://d.example/x.png" 1x, url(https://e.example/y.png) 2x, 'https://f.example/z.avif' type("image/avif"))} b{background:-webkit-image-set("https://g.example/q.png" 1x)} i{src:src("https://h.example/s")}`), ['https://d.example/x.png', 'https://e.example/y.png', 'https://f.example/z.avif', 'https://g.example/q.png', 'https://h.example/s']);
  assert.deepEqual(cssURLs(`a{content:"url(https://no.example/1)"} /* url(https://no.example/2) " */ b{background:url( https://i.example/x )}`), ['https://i.example/x'], 'not in a string or a comment');
  assert.deepEqual(cssURLs(`a{background:url("https://j.example/x.png")} b{c:'it\\'s'} d{background:url('https://k.example/y.png')}`), ['https://j.example/x.png', 'https://k.example/y.png'], 'an escaped quote does not end a string');
  assert.deepEqual(hosts(`<input type=IMAGE src="https://${EVIL}/x.png">`), [`image ${EVIL}`], 'the type is read as a browser reads it');
});

test('ordinary pages are read as the reader of 1.4.0-beta.4 read them, except where that reader was wrong', () => {
  const { base, pages } = require('./fixtures/reader-pages.json');
  assert.ok(Object.keys(pages).length >= 35);
  for (const [name, page] of Object.entries(pages)) {
    const got = extractAssets(page.html, base), now = { assets: got.assets.map(a => `${a.type} ${a.url}`).sort(), inline: got.inlineScripts };
    if (page.why) { assert.deepEqual(now, page.now, `${name}: ${page.why}`); assert.notDeepEqual(now, page.beta4, name); }
    else assert.deepEqual(now, page.beta4, name);
  }
});

test('item 2: the sitemap of robots.txt is found line by line, and the link check keeps the port of the page', () => {
  const list = standardAddresses({ pageURL: 'https://shop.example:8443/', robotsLive: 'User-agent: *\n  Sitemap:   https://shop.example:8443/maps/all.xml  \nSitemap: https://other.example/s.xml' });
  assert.equal(list.find(c => c.id === 'sitemap').address, '/maps/all.xml');
  const html = '<a href="https://shop.example/elsewhere">other port</a><a href="https://shop.example:8443/contact">c</a><a href="/contact">c</a>';
  assert.equal(internalLink(html, html, 'https://shop.example:8443/').href, 'https://shop.example:8443/contact');
});

test('item 3: a redirect is followed only within the site', () => {
  const step = (from, to, ruled) => { const r = redirectStep(from, to, ruled); return r.follow || r.left; };
  assert.equal(step('https://shop.example/a', 'https://www.shop.example/a/'), 'https://www.shop.example/a/');
  assert.equal(step('http://shop.example/a', 'https://shop.example/a'), 'https://shop.example/a', 'http to https on the same host stays inside');
  assert.equal(step('https://shop.example/a', 'https://shop.example:443/b'), 'https://shop.example/b', 'the effective port is compared');
  assert.deepEqual(step('https://shop.example/a', 'http://shop.example/a'), { host: 'http://shop.example', own: true }, 'back to http is leaving');
  assert.deepEqual(step('http://shop.example:8080/a', 'https://shop.example:8443/a'), { host: 'https://shop.example:8443', own: true });
  assert.deepEqual(step('https://shop.example/a', 'https://shop.example:8443/a'), { host: 'shop.example:8443', own: true }, 'another port is another server');
  assert.deepEqual(step('https://shop.example/a', `https://${EVIL}/a`), { host: EVIL, own: false });
  assert.deepEqual(step('https://shop.example/a', 'https://cdn.shop.example/a'), { host: 'cdn.shop.example', own: true });
  assert.deepEqual(step('https://shop.example/a', 'https://user:pw@shop.example/a'), { host: 'shop.example', own: true }, 'credentials are never sent');
  assert.deepEqual(step('https://shop.example/a', 'https://www.shop.example/a', () => false), { host: 'www.shop.example', own: true }, 'a name without a domain rule is not asked on the new server');
  assert.deepEqual(step('https://shop.example/a', 'javascript:alert(1)'), { host: 'a "javascript:" address', own: false }, 'a target that is not http is named by its scheme');
  assert.deepEqual(step('https://shop.example/a', 'mailto:a@b.example'), { host: 'a "mailto:" address', own: false });
  // What it means.
  assert.deepEqual(leftFindings({ host: EVIL, own: false }, null).findings, [{ state: 'fix', text: `The new server sends this page to ${EVIL}, Live does not` }]);
  assert.deepEqual(leftFindings(null, { host: 'shop.example:8443', own: true }).findings, [{ state: 'check', text: 'Live sends this page to shop.example:8443, another address of this site, the new server does not' }]);
  assert.deepEqual(leftFindings({ host: 'x.example', own: false }, { host: 'x.example', own: false }), { both: { host: 'x.example', own: false }, findings: [] });
  assert.deepEqual(leftFindings(null, null), { findings: [] });
});

// Item 4, the proof of the review: twenty pages, a script from another site on all of them, one page hijacked.
test('item 4: a script on every page is said once for the site; the one hijacked page is the only row, hijack first', () => {
  const pages = Array.from({ length: 20 }, (_, i) => {
    const url = `https://shop.example/p${i}/`, report = buildReport({ url, hostfile: side(`<script src="https://cdn.x.example/a.js"></script>`, { finalUrl: url }), live: side('<p></p>', { finalUrl: url }) });
    return pageModel({ url, report, checks: null, addonTabs: [], extra: i === 7 ? leftFindings({ host: EVIL, own: false }, null).findings : [] });
  });
  const site = siteResult(pages), domains = site.parts.find(p => p.id === 'domains');
  assert.deepEqual(site.own.map(p => [p.path, p.state, p.text]), [['/p7/', 'fix', `The new server sends this page to ${EVIL}, Live does not`]]);
  assert.equal(site.rest.length, 19);
  assert.deepEqual([domains.state, domains.where, domains.found.length, domains.found[0].pages.length], ['fix', 'On all 20 pages', 1, 20]);
});

test('item 4: rows are sorted red first, then by number of findings, then list order; the worst finding leads', () => {
  const part = (state, all) => ({ id: 'checks', group: 'g', name: 'Checks', what: '', state, tag: '', line: '', all, missing: false });
  const model = (path, failed, points) => ({ url: `https://shop.example${path}`, path, title: '', failed, parts: [part(points.length ? 'check' : 'ok', points)] });
  const amber = text => ({ text, state: 'check' }), red = text => ({ text, state: 'fix' });
  const site = siteResult([model('/', [], []), model('/a/', [], [amber('a1')]), model('/b/', [], [amber('b1'), amber('b2')]), model('/c/', [red('hijack')], [amber('c1'), red('c2')]), model('/d/', [], [red('d1')]), model('/e/', [], []), model('/f/', [], []), model('/g/', [], [])]);
  assert.deepEqual(site.own.map(p => [p.path, p.text]), [['/c/', 'hijack, and 2 more'], ['/d/', 'd1'], ['/b/', 'b1, and 1 more'], ['/a/', 'a1']]);
});

test('item 4: the same redirect difference on every page is said once for the site', () => {
  const make = (path, more = {}) => { const url = `https://shop.example${path}`; return pageModel({ url, checks: null, addonTabs: [], report: buildReport({ url, hostfile: side('<p></p>', { finalUrl: url, redirects: [{ status: 301, location: `https://www.shop.example${path}` }], ...more }), live: side('<p></p>', { finalUrl: url }) }) }); };
  const all = siteResult(['/', '/a/', '/b/', '/c/'].map(p => make(p))), headers = all.parts.find(p => p.id === 'headers');
  assert.deepEqual([all.own.length, all.rest.length, headers.state, headers.where], [0, 4, 'check', 'On all 4 pages']);
  // One page that redirects somewhere of its own keeps its row; a status that differs is always per page.
  const one = siteResult([make('/'), make('/a/'), make('/b/', { redirects: [{ status: 302, location: 'https://shop.example/login' }] }), make('/c/')]);
  assert.deepEqual(one.own.map(p => p.path), ['/', '/a/', '/b/', '/c/'], 'not the same everywhere, so a redirect is listed per page');
  const status = siteResult(['/', '/a/', '/b/'].map(p => make(p, { redirects: [], status: 500 })));
  assert.deepEqual(status.own.map(p => [p.path, p.text]), ['/', '/a/', '/b/'].map(p => [p, 'HTTP status differs: Hostfile 500, Live 200']));
});

test('item 5: two queries of one path are two pages; a path without a query replaces the same path with one; tracking is dropped', () => {
  const HOME = 'https://shop.example/', pick = list => pickPages(list, HOME, 20).pages.map(p => p.slice(HOME.length - 1));
  assert.deepEqual(pick(['/shop/?page=2', '/shop/?page=3', '/shop/?page=2']), ['/', '/shop/?page=2', '/shop/?page=3']);
  assert.deepEqual(pick(['/shop/?page=2', '/shop/?page=3', '/shop/', '/shop/?page=4']), ['/', '/shop/', '/shop/?page=3'], 'the plain path takes the place of the first, and later queries of it are that page');
  assert.deepEqual(pick(['/a/?utm_source=mail&utm_medium=x', '/a/?fbclid=1', '/a/?gclid=2&id=7', '/a/?id=7', '/b/?UTM_Campaign=q&id=1']), ['/', '/a/', '/b/?id=1']);
  assert.deepEqual(pick(['/?p=12', '/?p=13']), ['/'], 'the home page is the plain path');
  assert.deepEqual(pastedPages('/x?a=1 /x?a=2', HOME).pages.map(p => p.slice(HOME.length - 1)), ['/', '/x?a=1', '/x?a=2']);
});

test('item 6: hidden characters, copied commands and the paths of the list', () => {
  const hidden = '­͏᠋᠍︀️ﾠ⠀￹￻\u{e0100}\u{e01ef}​‮';
  const report = cleanReport({ sub: `s${hidden}ub`, groups: [{ id: 'g', label: 'G', items: [{ title: `t${hidden}itle`, tone: 'worse', fix: [{ code: `rm -rf /tmp/x‮аé\n&& echo ok` }], commands: [{ found: 'f', where: 'w', command: 'wp plugin deactivate а-plugin  --all' }], action: { label: 'Copy', text: `line 1\nline 2\t é ${hidden}end` } }] }] }, ['hostfile']);
  const item = report.groups[0].items[0];
  assert.equal(report.sub, 'sub'); assert.equal(item.title, 'title');
  assert.equal(item.fix[0].code, 'rm -rf /tmp/x && echo ok', 'printable ASCII only in what is copied');
  assert.equal(item.commands[0].command, 'wp plugin deactivate -plugin --all', 'a Cyrillic look-alike letter is dropped, not copied');
  assert.equal(item.action.text, 'line 1\nline 2 end', 'and the newline');
  assert.equal(pathOf('https://shop.example/caf%C3%A9/?a=1'), '/café/?a=1');
  assert.equal(pathOf('https://shop.example/a%E2%80%AEgpj.exe'), '/a%E2%80%AEgpj.exe', 'a path that would show turned around is shown as it is sent');
  assert.equal(pathOf('https://shop.example/a%0Ab'), '/a%0Ab');
  assert.equal(pageModel({ url: 'https://shop.example/', title: 'Sa‮le­', report: buildReport({ url: 'https://shop.example/', hostfile: side(''), live: side('') }) }).title, 'Sale');
});

test('review of beta.8: SVG deeper than the reader tracks is a cut, never a silent miss', () => {
  const r = readPage(`${'<svg>'.repeat(65)}${'</svg>'.repeat(64)}<script>x<script src=//evil.example/y.js></script></script>`, 'https://shop.example/');
  assert.match(r.cut, /nested more than 64 levels/);
  assert.equal(readPage(`${'<svg>'.repeat(10)}${'</svg>'.repeat(10)}<p>`, 'https://shop.example/').cut, '');
});
test('review of beta.8: href only makes an SVG script external, language only counts in HTML', () => {
  const r = readPage('<script href="x.js">var a=1</script><svg><script language="foo">var b=2</script><script href="y.js">var c=3</script></svg><script language="foo">var d=4</script>', 'https://shop.example/');
  assert.deepEqual(r.inlineScripts, ['var a=1', 'var b=2']);
});
