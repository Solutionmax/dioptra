// Everything that reads a page, a robots.txt or a sitemap in the main process must stay linear on a body a hostile
// server sends (1.4.0-beta.5): each shape below repeats something unfinished up to the body cap, and every reader must
// be done with it well within a second or two. Before the fix "<title" × 80 000 took 37 seconds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractAssets, buildReport, stripComments, lineDiff } = require('../src/differences.cjs');
const { pageFacts, oldAddresses, checksReport, soloChecksReport, robotsSummary, standardAddresses } = require('../src/site-checks.cjs');
const { pageTitle, parseSitemap, sitemapsInRobots, pickPages } = require('../src/site-scope.cjs');

// The Windows test machine is about 1.5x slower than CT102; what this guards against is a freeze of tens of seconds.
const MAX = 5 * 1024 * 1024, LIMIT_MS = process.platform === 'win32' ? 4000 : 2500;
const fill = (piece, size = MAX) => piece.repeat(Math.ceil(size / piece.length)).slice(0, size);
// Unfinished things, each repeated to 5 MB: no end tag, no closing quote, no closing bracket, endless white space.
const SHAPES = {
  'title without end': '<title', 'title open': '<title>', 'script without end': '<script', 'script open': '<script>', 'script src open': '<script src="a.js">', 'style open': '<style>',
  'comment open': '<!--', 'comment almost closed': '<!-- --', 'tag without end': '<img ', 'tags': '<img src=a>', 'anchor with open quote': '<a href="', 'open quote in a tag': '<a x="1" y=\'',
  'style attribute open': '<p style="', 'style with url open': '<p style="background:url(">', 'css url open': '<style>a{background:url("', 'nav without end': '<nav', 'nav end with spaces': '</nav   ',
  'spaces then a letter': `${' '.repeat(4096)}x`, 'one long line of spaces': ' ', 'addresses': 'https://x.example/a ', 'address without end': 'https://', 'less than': '<', 'greater than': '>', 'equals': '=', 'quotes': '"',
  'white space only': ' \t ', 'new lines only': '\n', 'returns only': '\r\n', 'sitemap lines': 'Sitemap:  ', 'sitemap line starts': '\n sitemap:', 'open elements': '<div>', 'links in links': '<a href=x><b>', 'svg': '<svg><desc>', 'templates': '<template>', 'number entity': '&#x', 'noscript': '<noscript><img src=a>', 'srcdoc': '<iframe srcdoc="<img src=a>">', 'srcset of commas': '<img srcset="a,',
  'meta robots': '<meta name="robots" content="', 'links': '<link rel="canonical" href="', 'entities': '&amp;', 'escaped slashes': 'https:\\/\\/1.2.3.4\\/~u\\/', 'srcset': '<img srcset="a 1x, b 2x, ',
  // 1.4.0-beta.8: text is read again as markup (possible), so text inside text inside text must stay linear too.
  'raw text in comments': '<!--<title>', 'raw text in raw text': '<xmp><textarea></xmp>', 'select and raw text': '<select><style><p>', 'cdata in svg': '<svg><![CDATA[<a ', 'css strings': '<style>@import "a', 'image-set': '<p style="background:image-set(',
  // Review of beta.8: closed comments without any "--!>" made stripComments search to the end for every comment.
  'closed comments': '<!--a-->', 'deep svg': '<svg>',
};
const timed = (name, fn) => { const started = process.hrtime.bigint(); fn(); const ms = Number(process.hrtime.bigint() - started) / 1e6; assert.ok(ms < LIMIT_MS, `${name} took ${Math.round(ms)} ms`); return ms; };
const URL = 'https://shop.example/';

for (const [name, piece] of Object.entries(SHAPES)) {
  test(`hostile body, ${name}: every reader of a page is done in time`, () => {
    const body = fill(piece), page = { ok: true, status: 200, ms: 1, redirects: [], headers: {}, body, finalUrl: URL, ip: '203.0.113.10' }, plain = { ...page, body: '<html><head><title>x</title></head><body></body></html>' };
    timed(`extractAssets (${name})`, () => extractAssets(body, URL));
    timed(`stripComments (${name})`, () => stripComments(body));
    timed(`pageTitle (${name})`, () => pageTitle(body, URL));
    timed(`pageFacts (${name})`, () => pageFacts(body, URL));
    timed(`lineDiff (${name})`, () => lineDiff(body, plain.body));
    // The whole comparison of one page, the hostile body on the new server and on both.
    timed(`buildReport, new server (${name})`, () => buildReport({ url: URL, hostfile: page, live: plain }));
    timed(`buildReport, both (${name})`, () => buildReport({ url: URL, hostfile: page, live: page }));
    timed(`oldAddresses (${name})`, () => oldAddresses({ hostfileHTML: body, liveHTML: plain.body, pageURL: URL, oldIP: '198.51.100.24' }));
    timed(`oldAddresses, both (${name})`, () => oldAddresses({ hostfileHTML: body, liveHTML: body, pageURL: URL, oldIP: '198.51.100.24' }));
    timed(`checksReport (${name})`, () => checksReport({ pageURL: URL, hostfile: page, live: plain, standard: [], oldIP: '198.51.100.24' }));
    timed(`soloChecksReport (${name})`, () => soloChecksReport({ pageURL: URL, hostfile: page, standard: [] }));
    timed(`standardAddresses (${name})`, () => standardAddresses({ pageURL: URL, hostfileHTML: body, liveHTML: plain.body, wordpress: true, robotsLive: body.slice(0, 256 * 1024) }));
    // What is read at most 256 KB (robots.txt) or 2 MB (a sitemap) long.
    timed(`robotsSummary (${name})`, () => robotsSummary(body.slice(0, 256 * 1024)));
    timed(`sitemapsInRobots (${name})`, () => sitemapsInRobots(body));
    timed(`parseSitemap (${name})`, () => parseSitemap(body));
  });
}

// A whole inline script of 5 MB goes through the "looks obfuscated" patterns and the line diff.
test('hostile body, one huge inline script: the comparison is done in time', () => {
  for (const piece of ['"', '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'A', 'eval (', 'eval\t', 'function ( p , a ', 'function (', '\\x4', '\\u00', '_0x', 'String.fromCharCode', 'atob (', '+/=', ' ', '\n', '\r']) {
    const body = `<html><script>${fill(piece, MAX - 64)}</script></html>`, page = { ok: true, status: 200, ms: 1, redirects: [], headers: {}, body, finalUrl: URL };
    timed(`buildReport, script of ${JSON.stringify(piece)}`, () => buildReport({ url: URL, hostfile: page, live: { ...page, body: '<html></html>' } }));
    timed(`checksReport, script of ${JSON.stringify(piece)}`, () => checksReport({ pageURL: URL, hostfile: page, live: { ...page, body: '<html></html>' }, standard: [] }));
  }
});

test('the readers still read: the linear tokenizer finds what the patterns found', () => {
  const html = `<!doctype html><!-- <script src="https://hidden.example/x.js"></script> --><html><head><TITLE>T</TITLE>
<link rel=stylesheet href='https://css.example/a.css'><link rel="preload" as="script" href="//pre.example/p.js"><style>a{background:URL( "https://bg.example/b.png" )} b{background:url(https://bare.example/c.png)}</style>
<script src=https://cdn.example/lib.js></script><SCRIPT>var a = "<img src=https://not.example/x.png>"; eval(atob("x"))</SCRIPT><script type="application/ld+json">{"a":"https://json.example/"}</script></head>
<body><img src="https://img.example/a.png" srcset="https://img2.example/a.png 1x, https://img3.example/b.png 2x"><iframe src="https://frame.example/"></iframe><div style="background:url('https://inline.example/i.png')">x</div>
<a href="https://link.example/">not an asset</a><video src=https://video.example/v.mp4></video><input type=image src="https://input.example/i.png"><script src="https://unclosed.example/u.js">`;
  const { assets, inlineScripts } = extractAssets(html, URL);
  assert.deepEqual(assets.map(a => `${a.type} ${a.host}`), ['stylesheet css.example', 'script pre.example', 'other bg.example', 'other bare.example', 'script cdn.example', 'image img.example', 'image img2.example', 'image img3.example', 'frame frame.example', 'other inline.example', 'other video.example', 'image input.example', 'script unclosed.example']);
  assert.deepEqual(inlineScripts, ['var a = "<img src=https://not.example/x.png>"; eval(atob("x"))'], 'a commented script, JSON and what a script quotes are left out');
  assert.equal(stripComments('a<!-- x -->b<!-- y -->c<!-- never ends'), 'abc', 'a comment without an end runs to the end, as in a browser');
  assert.equal(stripComments('a<!-->b<!--->c<!-- x --!>d'), 'abcd');
  const facts = pageFacts('<head><meta name=robots content="noindex, nofollow"><link rel="canonical" href="/x"></head><nav><a href="/menu">Menu <b>item</b></a></nav><footer><a href="http://shop.example/f">F</a></footer>', URL);
  assert.deepEqual([facts.robots, facts.canonical], ['noindex, nofollow', 'https://shop.example/x']);
  assert.deepEqual(facts.tags.map(t => `${t.tag} ${t.value}${t.where} ${t.label}`), ['link /x ', 'a /menu in the menu Menu item', 'a http://shop.example/f in the footer F']);
});

// The shapes of the security review of 1.4.0-beta.6 (perf2.js): a page full of iframe documents or noscript blocks that
// each hold a tag with thousands of attributes. Each nested reading had a second of its own (3 s for one page), and a
// tag's attributes cost the square of their number. Now one clock covers the page and all that is read inside it.
test('hostile body, nested documents full of attributes: one clock for the page, near one second', () => {
  const attrs = n => Array.from({ length: n }, (_, i) => `a${i}`).join(' ');
  const shapes = { srcdocQuad120k: `<iframe srcdoc="<a ${attrs(14000)}"></iframe>`, srcdocQuad40k: `<iframe srcdoc="<a ${attrs(5000)}"></iframe>`, noscriptQuad120k: `<noscript><a ${attrs(14000)}></noscript>`, noscriptQuad500k: `<noscript><a ${attrs(50000)}></noscript>`, srcdocSmallMany: `<iframe srcdoc="<a ${attrs(1500)}"></iframe>` };
  for (const [name, piece] of Object.entries(shapes)) {
    const body = fill(piece);
    const ms = timed(name, () => extractAssets(body, URL));
    assert.ok(ms < 2000, `${name}: ${Math.round(ms)} ms`);
    // Read to the end within the second, or cut and said so: never more time.
    const { cut } = extractAssets(body, URL);
    assert.ok(cut === '' || /^reading took too long|longer than 512 KB/.test(cut), `${name}: ${cut}`);
  }
  // One tag of 5 MB of attributes: what the reader uses is kept, the rest dropped, so the address at the end still counts.
  const one = `<script ${attrs(600000).slice(0, MAX - 100)} src="https://far.example/x.js"></script>`;
  const ms = timed('one tag of 5 MB of attributes', () => extractAssets(one, URL));
  assert.ok(ms < 2000, `${Math.round(ms)} ms`);
  assert.deepEqual(extractAssets(one, URL).assets.map(a => a.host), ['far.example']);
});

// Two patterns of the review that froze the main process (proven with 40 000 new lines and 5390 sitemap entries).
test('hostile robots.txt and sitemap: no pattern that runs long', () => {
  const robots = standardAddresses({ pageURL: URL, hostfileHTML: '', wordpress: false, robotsLive: '' }).find(c => c.id === 'robots');
  const answer = body => ({ ok: true, status: 200, ms: 1, redirects: [], headers: {}, body });
  const page = { ok: true, status: 200, ms: 1, redirects: [], headers: {}, body: '<html><head><title>x</title></head></html>', finalUrl: URL };
  for (const body of ['\n'.repeat(256 * 1024), ' \n'.repeat(128 * 1024), `${'\n'.repeat(200 * 1024)}sitemap:x`]) {
    timed('soloChecksReport, robots.txt of new lines', () => soloChecksReport({ pageURL: URL, hostfile: page, standard: [{ check: robots, hostfile: answer(body) }] }));
  }
  const named = soloChecksReport({ pageURL: URL, hostfile: page, standard: [{ check: robots, hostfile: answer('User-agent: *\n\n  Sitemap: https://shop.example/s.xml\n') }] });
  assert.ok(named.passed.some(p => p.name === '/robots.txt'), 'a robots.txt that names a sitemap still passes');
  // A sitemap index of five children, each with entries of 1900 slashes and a letter (19 s in beta.6).
  const entry = `${URL}${'/'.repeat(1900)}Z`, urls = Array.from({ length: 5 * 1078 }, () => entry);
  timed('pickPages, paths of slashes', () => pickPages(urls, URL, 20));
  assert.deepEqual(pickPages([`${URL}a///`, `${URL}a`, `${URL}b//`], URL, 20).pages, [URL, `${URL}a///`, `${URL}b//`], 'slashes at the end still make one page');
});
