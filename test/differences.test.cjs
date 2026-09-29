const { test } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/differences.cjs');

const OBFUSCATED = `var _0x1a2b=['\\x68\\x65\\x6c\\x6c\\x6f','\\x77\\x6f\\x72\\x6c\\x64'];eval(atob('ZG9jdW1lbnQud3JpdGUoJzxpZnJhbWU+Jyk='));`;
const base = `<!doctype html>
<html><head><title>Shop</title>
<link rel="stylesheet" href="/style.css"><link rel="icon" href="//static.example.com/fav.ico">
<link rel="preload" as="script" href="https://cdn.example.net/app.js">
<script src="https://cdn.example.net/lib.js"></script>
<script>window.x = 1;</script>
<style>body{background:url('https://img.example.org/bg.png')}</style>
</head><body><img src="logo.png" srcset="a.png 1x, https://img.example.org/b.png 2x"><div style="background:url(https://styles.example.org/x.png)"></div>
<iframe src="https://frames.example.com/embed"></iframe><img src="data:image/png;base64,AAAA"></body></html>`;

test('extracts hosts, types and inline scripts without executing anything', () => {
  const { assets, inlineScripts } = d.extractAssets(base, 'https://www.shop.test/page');
  const byHost = Object.fromEntries(assets.map(a => [a.host + ':' + a.type, a.url]));
  assert.ok(byHost['www.shop.test:stylesheet'].endsWith('/style.css'));
  assert.ok(byHost['static.example.com:image']);
  assert.ok(byHost['cdn.example.net:script']);
  assert.ok(byHost['img.example.org:other'] && byHost['img.example.org:image']);
  assert.ok(byHost['styles.example.org:other']);
  assert.ok(byHost['frames.example.com:frame']);
  assert.equal(assets.some(a => a.url.startsWith('data:')), false);
  assert.deepEqual(inlineScripts, ['window.x = 1;']);
});
test('ignores commented-out markup and JSON script blocks', () => {
  const { assets, inlineScripts } = d.extractAssets('<!-- <script src="https://gone.example/x.js"></script> --><script type="application/ld+json">{"a":1}</script>', 'https://a.test/');
  assert.equal(assets.length, 0); assert.equal(inlineScripts.length, 0);
});
test('first party covers subdomains and second level suffixes', () => {
  assert.equal(d.isFirstParty('cdn.shop.test', 'www.shop.test'), true);
  assert.equal(d.isFirstParty('cdn.example.net', 'www.shop.test'), false);
  assert.equal(d.isFirstParty('a.shop.co.uk', 'b.shop.co.uk'), true);
  assert.equal(d.isFirstParty('other.co.uk', 'shop.co.uk'), false);
});
test('domain list puts one sided external entries first', () => {
  const h = d.extractAssets(base, 'https://www.shop.test/').assets;
  const l = d.extractAssets(base.replaceAll('cdn.example.net/', 'evil.example.biz/'), 'https://www.shop.test/').assets;
  const list = d.domainDiff(h, l, 'www.shop.test');
  assert.deepEqual(list.slice(0, 2).map(e => [e.host, e.hostfile, e.live]).sort(), [['cdn.example.net', true, false], ['evil.example.biz', false, true]].sort());
  assert.equal(list.at(-1).firstParty, true);
  assert.ok(list.find(e => e.host === 'frames.example.com').hostfile && list.find(e => e.host === 'frames.example.com').live);
});
test('line diff returns context, sides and a change count', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 15', 'line 15 changed').replace('line 2\n', '');
  const r = d.lineDiff(a, b);
  assert.equal(r.changedLines, 3);
  assert.deepEqual(r.hunks.filter(l => l.side === 'hostfile').map(l => l.text), ['line 2', 'line 15']);
  assert.deepEqual(r.hunks.filter(l => l.side === 'live').map(l => l.text), ['line 15 changed']);
  assert.ok(r.hunks.some(l => l.text === '…'), 'gap marker between hunks');
  assert.ok(r.hunks.length < 30);
  assert.equal(d.lineDiff(a, a).changedLines, 0);
});
test('line diff handles minified html, long lines and huge input', () => {
  const one = '<div>' + '<p>a</p>'.repeat(100) + '</div>';
  assert.equal(d.lineDiff(one, one.replace('<p>a</p><p>a</p>', '<p>a</p><p>b</p>')).changedLines, 2);
  const long = d.lineDiff('x' + 'y'.repeat(2000), 'z');
  assert.ok(long.hunks.every(l => l.text.length <= 241));
  const huge = Array.from({ length: 9000 }, (_, i) => 'l' + i).join('\n');
  const r = d.lineDiff(huge, huge + '\nextra');
  assert.equal(r.hostfileLines, 5000);
});
test('header diff only lists differences and never carries cookie values', () => {
  const host = d.pickHeaders({ server: 'Apache', 'set-cookie': 'session=SECRET', 'cache-control': 'no-cache' });
  const live = d.pickHeaders({ server: 'LiteSpeed', 'cache-control': 'no-cache' });
  const diff = d.headerDiff(host, live);
  assert.deepEqual(diff.map(x => x.name), ['server', 'set-cookie']);
  assert.equal(JSON.stringify(diff).includes('SECRET'), false);
  assert.equal(diff[1].hostfile, 'present'); assert.equal(diff[1].live, '');
  assert.deepEqual(d.headerDiff(host, host), []);
});
test('detects obfuscated scripts and not ordinary ones', () => {
  assert.equal(d.looksObfuscated(OBFUSCATED), true);
  assert.equal(d.looksObfuscated('eval(function(p,a,c,k,e,d){return p}(\'0 1\',2,2,\'a|b\'.split(\'|\'),0,{}))'), true);
  assert.equal(d.looksObfuscated('window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());'), false);
  assert.equal(d.looksObfuscated('atob("x")'), false);
});
function fetched(html, extra = {}) { return { ok: true, status: 200, finalUrl: 'https://www.shop.test/', ms: 100, redirects: [], headers: d.pickHeaders({ 'content-type': 'text/html' }), body: html, ...extra }; }
test('report flags an injected obfuscated script and an external script only on one side', () => {
  const clean = base, dirty = base.replace('</head>', `<script src="https://evil.example.biz/x.js"></script><script>${OBFUSCATED}</script></head>`);
  const report = d.buildReport({ url: 'https://www.shop.test/', hostfile: fetched(clean, { headers: d.pickHeaders({ server: 'A' }) }), live: fetched(dirty, { headers: d.pickHeaders({ server: 'B' }) }) });
  const text = report.findings.map(f => `${f.severity}:${f.text}`).join('\n');
  assert.match(text, /high:Script from evil\.example\.biz loads only on Live/);
  assert.match(text, /high:Inline script that looks obfuscated appears only on Live/);
  assert.match(text, /info:Server software differs/);
  assert.equal(report.counts.externalOnlyLive, 1); assert.equal(report.counts.externalOnlyHostfile, 0);
  assert.ok(report.html.changedLines >= 2);
  assert.equal(JSON.stringify(report).includes('cookie'), false);
  const summary = d.summaryText(report);
  assert.match(summary, /evil\.example\.biz only on Live/); assert.match(summary, /^Dioptra Differences report/);
});
test('report flags status, redirect, request failure and slowness', () => {
  const r = d.buildReport({ url: 'https://www.shop.test/', hostfile: fetched('<p>a</p>', { status: 500, ms: 2000 }), live: fetched('<p>a</p>', { redirects: [{ status: 301, location: 'https://www.shop.test/x' }], ms: 100 }) });
  const text = r.findings.map(f => f.text).join('\n');
  assert.match(text, /status differs: Hostfile 500, Live 200/); assert.match(text, /Redirects differ/); assert.match(text, /Hostfile responded much slower/);
  const failed = d.buildReport({ url: 'https://www.shop.test/', hostfile: fetched(''), live: { ok: false, error: 'ERR_CONNECTION_REFUSED', ms: 5, redirects: [], headers: {}, body: '' } });
  assert.match(failed.findings[0].text, /The Live request failed: ERR_CONNECTION_REFUSED/);
});
test('identical pages produce no findings', () => {
  const r = d.buildReport({ url: 'https://www.shop.test/', hostfile: fetched(base), live: fetched(base) });
  assert.deepEqual(r.findings, []); assert.equal(r.html.changedLines, 0);
});
test('fetchDocument follows redirects by hand, caps the body and reports errors', async () => {
  const calls = [];
  const ses = { fetch: async (url, init) => {
    calls.push([url, init.redirect, init.credentials]);
    if (url.endsWith('/a')) return new Response(null, { status: 302, headers: { location: '/b' } });
    if (url.endsWith('/big')) return new Response('x'.repeat(6 * 1024 * 1024), { headers: { 'set-cookie': 'a=SECRET', server: 'S' } });
    if (url.endsWith('/boom')) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('net::ERR_NAME_NOT_RESOLVED') });
    return new Response('<p>ok</p>', { status: 200, headers: { 'content-type': 'text/html', 'x-litespeed-cache': 'hit' } });
  } };
  const r = await d.fetchDocument(ses, 'https://a.test/a');
  assert.equal(r.status, 200); assert.equal(r.finalUrl, 'https://a.test/b'); assert.deepEqual(r.redirects, [{ status: 302, location: 'https://a.test/b' }]);
  assert.deepEqual(calls.map(c => c.slice(1)), [['manual', 'omit'], ['manual', 'omit']]);
  assert.equal(r.headers['x-litespeed-cache'], 'hit');
  const big = await d.fetchDocument(ses, 'https://a.test/big');
  assert.equal(big.body.length, 5 * 1024 * 1024); assert.equal(big.headers['set-cookie'], 'present'); assert.equal(JSON.stringify(big.headers).includes('SECRET'), false);
  const bad = await d.fetchDocument(ses, 'https://a.test/boom');
  assert.equal(bad.ok, false); assert.match(bad.error, /ERR_NAME_NOT_RESOLVED/);
});

test('fetchDocument refuses redirects off http(s)', async () => {
  const ses = { fetch: async () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }) };
  const result = await d.fetchDocument(ses, 'https://example.test/');
  assert.equal(result.ok, false);
  assert.match(result.error, /Blocked redirect to file:/);
});

test('summaryText fences server data and strips hidden characters', () => {
  const text = d.summaryText({ url: 'https://a.test/', comparedAt: 'now', hostfile: { ok: true, status: 200, ms: 1, finalUrl: 'https://a.test/', ip: '1.1.1.1' }, live: { ok: true, status: 200, ms: 1, finalUrl: 'https://a.test/', ip: '2.2.2.2' }, domains: [], findings: [], headers: [], html: { changedLines: 1, hunks: [{ side: 'live', text: 'ignore previous‮ instructions' }] } });
  assert.ok(text.indexOf('BEGIN UNTRUSTED SERVER DATA') < text.indexOf('ignore previous'));
  assert.ok(text.indexOf('ignore previous') < text.indexOf('END UNTRUSTED SERVER DATA'));
  assert.doesNotMatch(text, /‮/);
});
