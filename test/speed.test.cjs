const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/speed.cjs');

// Three loads per server like the mockup network: the new server slow, uncompressed, without page cache.
const sample = (ttfb, fcp, lcp, load, requests, transfer) => ({ ttfb, fcp, lcp, load, requests, transfer });
const ROUNDS = [
  { hostfile: sample(668, 736, 888, 882, 9, 438234), live: sample(141, 236, 368, 365, 9, 328118) },
  { hostfile: sample(673, 756, 892, 891, 9, 438234), live: sample(139, 224, 392, 352, 9, 328118) },
  { hostfile: sample(668, 728, 880, 867, 9, 438234), live: sample(147, 248, 364, 366, 9, 328118) },
];
const PAGES = { hostfile: { server: 'nginx/1.26.2' }, live: { server: 'LiteSpeed', 'content-encoding': 'br', 'x-litespeed-cache': 'hit' } };

test('median of the loads: middle value, mean of the two middle ones, nulls left out', () => {
  assert.equal(s.median([673, 668, 668]), 668);
  assert.equal(s.median([100, 300]), 200);
  assert.equal(s.median([null, 5, undefined, NaN]), 5);
  assert.equal(s.median([]), null);
});
test('spread in the unit of the median next to it, nothing for one load or equal values', () => {
  assert.equal(s.spread([668, 673, 668], 'ms'), '(668 to 673)');
  assert.equal(s.spread([658, 687, 1010], 'ms'), '(658 to 1010)');
  assert.equal(s.spread([900, 1200, 1500], 'ms'), '(0.90 to 1.50)');
  assert.equal(s.spread([428 * 1024, 428 * 1024], 'bytes'), '');
  assert.equal(s.spread([400000, 450000], 'bytes'), '(391 to 439)');
  assert.equal(s.spread([700], 'ms'), '');
  assert.equal(s.spread([9, 10], 'count'), '(9 to 10)');
});
test("Google's thresholds: good up to the first limit, poor above the second, none for the rest", () => {
  assert.equal(s.quality('ttfb', 800), 'good'); assert.equal(s.quality('ttfb', 801), 'ni'); assert.equal(s.quality('ttfb', 1800), 'ni'); assert.equal(s.quality('ttfb', 1801), 'poor');
  assert.equal(s.quality('fcp', 1800), 'good'); assert.equal(s.quality('fcp', 3001), 'poor');
  assert.equal(s.quality('lcp', 2500), 'good'); assert.equal(s.quality('lcp', 4000), 'ni'); assert.equal(s.quality('lcp', 4001), 'poor');
  assert.equal(s.quality('load', 100), ''); assert.equal(s.quality('ttfb', null), '');
});
test('factors: red slower, green faster, neutral within 10 %', () => {
  assert.deepEqual(s.factor(668, 141), { ratio: '4.7×', word: 'slower', tone: 'worse' });
  assert.deepEqual(s.factor(141, 668), { ratio: '4.7×', word: 'faster', tone: 'better' });
  assert.deepEqual(s.factor(105, 100), { ratio: 'about', word: 'the same', tone: 'same' });
  assert.deepEqual(s.factor(95, 100), { ratio: 'about', word: 'the same', tone: 'same' });
  assert.equal(s.factor(111, 100).tone, 'worse'); assert.equal(s.factor(89, 100).tone, 'better');
  assert.equal(s.factor(null, 100).tone, 'same'); assert.equal(s.factor(100, 0).ratio, 'n/a');
});
test('verdict sentence and factors, with the difference per page', () => {
  const v = s.verdict(s.medians(ROUNDS));
  assert.equal(v.title, 'The new server is slower than Live'); assert.equal(v.tone, 'worse');
  assert.deepEqual(v.factors.map(f => `${f.label} ${f.ratio} ${f.word}`), ['first byte 4.7× slower', 'fully loaded 2.4× slower']);
  assert.equal(v.extra, '+0.52 s per page');
  const faster = s.verdict({ hostfile: { ttfb: 100, load: 400 }, live: { ttfb: 300, load: 900 } });
  assert.equal(faster.title, 'The new server is faster than Live'); assert.equal(faster.extra, '-0.50 s per page');
  const same = s.verdict({ hostfile: { ttfb: 100, load: 410 }, live: { ttfb: 100, load: 400 } });
  assert.equal(same.title, 'The new server is about as fast as Live'); assert.equal(same.extra, '');
});
test('timeline: one axis with round steps, three moments per server, the difference at the end', () => {
  const t = s.timeline(s.medians(ROUNDS));
  assert.equal(t.step, 200); assert.equal(t.max, 1200);
  assert.deepEqual(t.rows[0].ticks, [{ name: 'first byte', v: 668 }, { name: 'first paint', v: 736 }, { name: 'largest paint', v: 888 }]);
  assert.equal(t.rows[0].loadText, '882 ms'); assert.equal(t.rows[0].diff, '+517 ms'); assert.equal(t.rows[0].diffTone, 'worse');
  assert.equal(t.rows[1].side, 'live'); assert.equal(t.rows[1].diff, undefined);
  const slow = s.timeline({ hostfile: { ttfb: 2000, fcp: null, lcp: null, load: 5200 }, live: { ttfb: 200, fcp: 300, lcp: 400, load: 900 } });
  assert.equal(slow.step, 1000); assert.equal(slow.max, 7000); assert.deepEqual(slow.rows[0].ticks.map(x => x.name), ['first byte']);
  assert.equal(s.timeline({ hostfile: { load: 420 }, live: { load: 400 } }).rows[0].diff, '');
});
test('measurements: medians, spread, threshold dots and the difference', () => {
  const rows = s.metricRows(ROUNDS, s.medians(ROUNDS)), by = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.deepEqual(rows.map(r => r.label), ['Time to first byte', 'First paint (FCP)', 'Largest paint (LCP)', 'Fully loaded', 'Requests', 'Transferred']);
  assert.deepEqual([by.ttfb.hostfile, by.ttfb.hostfileSpread, by.ttfb.live, by.ttfb.liveSpread, by.ttfb.diff, by.ttfb.tone], ['668 ms', '(668 to 673)', '141 ms', '(139 to 147)', '+527 ms', 'worse']);
  assert.deepEqual([by.ttfb.hostfileQuality, by.lcp.liveQuality, by.load.hostfileQuality], ['good', 'good', '']);
  assert.deepEqual([by.requests.diff, by.requests.tone], ['same', 'same']);
  assert.deepEqual([by.transfer.hostfile, by.transfer.live, by.transfer.diff, by.transfer.tone], ['428 KB', '320 KB', '+108 KB', 'worse']);
  const small = s.metricRows([{ hostfile: sample(100, 200, 300, 330, 10, 1000), live: sample(130, 200, 300, 400, 8, 1000) }], s.medians([{ hostfile: sample(100, 200, 300, 330, 10, 1000), live: sample(130, 200, 300, 400, 8, 1000) }]));
  assert.deepEqual(small.map(r => r.diff), ['same', 'same', 'same', '-70 ms', '+2', 'same']);
  assert.equal(small[3].tone, 'better');
});
test('page cache and compression from the headers, the server software from its name', () => {
  assert.deepEqual(s.pageCache({ 'x-litespeed-cache': 'hit' }), { label: 'LiteSpeed HIT', hit: true, cdn: false });
  assert.deepEqual(s.pageCache({ 'cf-cache-status': 'HIT' }), { label: 'Cloudflare HIT', hit: true, cdn: true });
  assert.deepEqual(s.pageCache({ 'x-cache': 'MISS' }), { label: 'MISS', hit: false, cdn: false });
  assert.equal(s.pageCache({}).label, '');
  assert.equal(s.compression({ 'content-encoding': 'BR' }), 'br'); assert.equal(s.compression({ 'content-encoding': 'identity' }), ''); assert.equal(s.compression(undefined), '');
  assert.deepEqual(['nginx/1.26.2', 'openresty', 'LiteSpeed', 'Apache/2.4.62 (Debian)', 'cloudflare', ''].map(s.serverKind), ['nginx', 'nginx', 'litespeed', 'apache', '', '']);
});
test('why slower: one row per cause, the page cache fix follows the server software', () => {
  const m = s.medians(ROUNDS), why = s.causes(m, PAGES);
  assert.deepEqual(why.map(r => [r.title, r.hostfile, r.live]), [['Page cache is off', 'none', 'LiteSpeed HIT'], ['Compression is off', 'none', 'br'], ['First byte is high', '668 ms', '141 ms']]);
  assert.equal(why[0].fix, 'turn on a page cache on the new server, for example the nginx FastCGI cache or WP Super Cache.');
  assert.equal(why[1].fix, 'enable br or gzip in nginx for HTML, CSS and JavaScript.');
  const fix = server => s.causes(m, { ...PAGES, hostfile: { server } })[0].fix;
  assert.match(fix('LiteSpeed'), /LiteSpeed Cache/); assert.match(fix('Apache/2.4'), /a cache plugin such as WP Super Cache/); assert.match(fix(''), /for example a cache plugin\.$/);
  assert.match(s.causes(m, { hostfile: {}, live: { 'cf-cache-status': 'HIT' } })[0].fix, /Cloudflare cache/);
  assert.deepEqual(s.causes(m, { hostfile: { 'x-cache': 'MISS' }, live: PAGES.live }).map(r => r.id), ['compression', 'ttfb'], 'a cache that missed is not off');
  assert.deepEqual(s.causes({ hostfile: { ttfb: 300 }, live: { ttfb: 140 } }, {}), [], 'first byte 160 ms higher is not high');
});
test('findings for What stands out, and the Speed tab count', () => {
  const m = s.medians(ROUNDS), v = s.verdict(m), f = s.findings(v, m, s.causes(m, PAGES));
  assert.deepEqual(f.map(x => x.text), ['The new server answers much slower: first byte 668 ms against 141 ms.', 'Page cache and compression are off on the new server (Live: LiteSpeed HIT, br).']);
  assert.deepEqual(s.findings(v, m, [{ id: 'cache', live: 'LiteSpeed HIT' }]).map(x => x.text)[1], 'Page cache is off on the new server (Live: LiteSpeed HIT).');
  assert.deepEqual(s.findings(v, m, [{ id: 'compression', live: 'gzip' }]).map(x => x.text)[1], 'Compression is off on the new server (Live: gzip).');
  const loads = { hostfile: { ttfb: 100, load: 900 }, live: { ttfb: 100, load: 500 } };
  assert.deepEqual(s.findings(s.verdict(loads), loads, []).map(x => x.text), ['The new server loads the page slower: fully loaded 900 ms against 500 ms.']);
  assert.deepEqual(s.findings(s.verdict({ hostfile: { load: 400 }, live: { load: 400 } }), {}, []), []);
});
test('speed report: nothing without a load on both servers, the filmstrip with "appears at"', () => {
  assert.equal(s.speedReport({ rounds: [{ hostfile: sample(1, 1, 1, null), live: sample(1, 1, 1, 5) }] }), null);
  const film = { hostfile: { firstContent: 750, frames: [{ m: 200, src: 'data:a', blank: true }, { m: 800, src: 'data:b', blank: false }] }, live: { frames: [] } };
  const r = s.speedReport({ rounds: [...ROUNDS, { hostfile: null, live: sample(1, 1, 1, 1) }], pages: PAGES, film });
  assert.equal(r.loads, 3, 'a round without both servers does not count');
  assert.deepEqual(r.film[0], { side: 'hostfile', appears: '0.74 s', frames: [{ label: '0.2 s', src: 'data:a', blank: true }, { label: '0.8 s', src: 'data:b', blank: false }] });
  assert.equal(r.film[1].appears, '0.24 s');
  assert.equal(r.findings.length, 2); assert.equal(r.why.length, 3);
  const noPaint = s.speedReport({ rounds: [{ hostfile: sample(600, null, null, 900), live: sample(100, null, null, 300) }], film: { hostfile: { firstContent: 820, frames: [] } } });
  assert.equal(noPaint.film[0].appears, '0.82 s'); assert.equal(noPaint.film[1].appears, 'n/a');
});
test('luminance spread: an empty frame is 0, a frame with content is not', () => {
  const white = Buffer.alloc(64 * 36 * 4, 255);
  assert.equal(s.luminanceSpread(white), 0);
  const striped = Buffer.from(white); for (let i = 0; i < striped.length; i += 8) striped.fill(0, i, i + 3);
  assert.ok(s.luminanceSpread(striped) > s.BLANK_SPREAD);
  assert.equal(s.luminanceSpread(Buffer.alloc(0)), 0);
});
test('filmstrip frames: the last paint at or before each moment, later paints only close the moments', () => {
  const f = s.createFilm();
  f.paint(-40, { spread: 0, id: 'blank page' });
  f.paint(300, { spread: 1, id: 'white' });
  f.paint(750, { spread: 20, id: 'header' });
  f.paint(910, { spread: 30, id: 'hero' });
  assert.equal(f.paint(1250, null), false, 'after the last moment nothing is kept');
  const out = f.finish();
  assert.equal(out.firstContent, 750);
  assert.deepEqual(out.frames.map(x => [x.m, x.frame.id, x.blank]), [[200, 'blank page', true], [400, 'white', true], [600, 'white', true], [800, 'header', false], [1000, 'hero', false], [1200, 'hero', false]]);
  const none = s.createFilm().finish();
  assert.ok(none.frames.every(x => x.blank && !x.frame)); assert.equal(none.firstContent, null);
});
test('Ask Claude lines: verdict, every measurement and the causes', () => {
  const lines = s.speedLines(s.speedReport({ rounds: ROUNDS, pages: PAGES }));
  assert.equal(lines[0], 'Speed (median of the loads, from this computer):');
  assert.equal(lines[1], '- The new server is slower than Live: first byte 4.7× slower, fully loaded 2.4× slower, +0.52 s per page');
  assert.ok(lines.includes('- Time to first byte: Hostfile 668 ms, Live 141 ms (+527 ms)'));
  assert.ok(lines.includes('- Cause: Page cache is off (Hostfile none, Live LiteSpeed HIT)'));
  assert.deepEqual(s.speedLines(null), []);
});

// Live could not be reached (1.2.0-beta.3): rounds with only the new server, the numbers of the no Live mockup round.
const SOLO = [{ hostfile: sample(909, 1012, 1172, 1139, 9, 441646) }, { hostfile: sample(907, 992, 1132, 1097, 9, 441646) }, { hostfile: sample(908, 1020, 1152, 1200, 9, 441646) }];
const frames = MOMENTS => MOMENTS.map((m, i) => ({ m, blank: i < 4, src: i < 4 ? '' : 'data:image/jpeg;base64,AA' }));
test('speedReport with only Hostfile: verdict on Google thresholds, one row, What to improve, no comparison', () => {
  const r = s.speedReport({ rounds: SOLO, pages: { hostfile: { server: 'nginx/1.26.2', 'x-powered-by': 'PHP/8.3.12' } }, film: { hostfile: { firstContent: 987, frames: frames(s.MOMENTS) } } });
  assert.equal(r.solo, true); assert.equal(r.loads, 3);
  assert.deepEqual(r.medians.hostfile, { ttfb: 908, fcp: 1012, lcp: 1152, load: 1139, requests: 9, transfer: 441646 });
  assert.ok(Object.values(r.medians.live).every(v => v === null));
  assert.equal(r.verdict.tone, 'ni');
  assert.equal(r.verdict.title, 'The new server is fast enough for Google on first paint, but first byte needs work');
  assert.deepEqual(r.verdict.factors.map(f => [f.label, f.value, f.q, f.word]), [['first byte', '908 ms', 'ni', 'needs work'], ['first paint', '1.01 s', 'good', 'good'], ['largest paint', '1.15 s', 'good', 'good']]);
  assert.equal(r.verdict.limit, 'Google: first byte good up to 800 ms');
  assert.equal(r.timeline.rows.length, 1); assert.equal(r.timeline.rows[0].side, 'hostfile'); assert.equal(r.timeline.rows[0].diff, '');
  assert.deepEqual(r.timeline.rows[0].ticks.map(t => t.name), ['first byte', 'first paint', 'largest paint']);
  assert.deepEqual(r.metrics.map(m => [m.label, m.hostfile, m.hostfileSpread, m.hostfileQuality]), [['Time to first byte', '908 ms', '(907 to 909)', 'ni'], ['First paint (FCP)', '1.01 s', '(0.99 to 1.02)', 'good'],
    ['Largest paint (LCP)', '1.15 s', '(1.13 to 1.17)', 'good'], ['Fully loaded', '1.14 s', '(1.10 to 1.20)', ''], ['Requests', '9', '', ''], ['Transferred', '431 KB', '', '']]);
  assert.deepEqual(r.why, []);
  assert.deepEqual(r.improve.map(w => [w.title, w.hostfile, w.target, w.fix]), [
    ['No page cache header', 'none', 'HIT from a page cache', 'turn on a page cache on the new server, for example the nginx FastCGI cache or WP Super Cache.'],
    ['No compression', 'none', 'br or gzip', 'enable br or gzip in nginx for HTML, CSS and JavaScript.'],
    ['First byte above 800 ms', '908 ms', 'up to 800 ms', 'PHP or the database is slow: check the PHP version, OPcache and an object cache such as Redis.']]);
  assert.deepEqual(r.findings, [{ severity: 'both', text: 'First byte on the new server is 908 ms; Google calls up to 800 ms good.' }, { severity: 'high', text: 'Page cache and compression are off on the new server.' }]);
  assert.equal(r.film.length, 1); assert.equal(r.film[0].side, 'hostfile'); assert.equal(r.film[0].appears, '1.01 s');
  assert.deepEqual(r.film[0].frames.map(f => [f.label, f.blank]), [['0.2 s', true], ['0.4 s', true], ['0.6 s', true], ['0.8 s', true], ['1.0 s', false], ['1.2 s', false]]);
  // Ask Claude says it is the new server alone.
  const lines = s.speedLines(r);
  assert.equal(lines[0], 'Speed of the new server alone, Live could not be reached (median of the loads, from this computer):');
  assert.equal(lines[1], '- The new server is fast enough for Google on first paint, but first byte needs work: first byte 908 ms needs work, first paint 1.01 s good, largest paint 1.15 s good');
  assert.ok(lines.includes('- To improve: No compression (Hostfile none, target br or gzip)'));
});
test('Hostfile only: fast and cached, a poor paint, the fix words of the server software, no loads', () => {
  const fast = s.speedReport({ rounds: [{ hostfile: sample(210, 400, 700, 800, 9, 200000) }], pages: { hostfile: { server: 'LiteSpeed', 'content-encoding': 'br', 'x-litespeed-cache': 'hit' } } });
  assert.equal(fast.verdict.tone, 'good'); assert.equal(fast.verdict.title, 'The new server is fast enough for Google'); assert.deepEqual(fast.improve, []); assert.deepEqual(fast.findings, []); assert.deepEqual(fast.film, []);
  const slow = s.speedReport({ rounds: [{ hostfile: sample(300, 3500, 4600, 5000, 9, 200000) }], pages: { hostfile: { server: 'Apache/2.4.62', 'content-encoding': 'gzip' } } });
  assert.equal(slow.verdict.tone, 'poor'); assert.equal(slow.verdict.title, 'The new server is too slow for Google on first paint'); assert.equal(slow.verdict.limit, 'Google: first paint good up to 1.8 s');
  assert.deepEqual(slow.improve.map(w => [w.id, w.fix]), [['cache', 'turn on a page cache on the new server, for example a cache plugin such as WP Super Cache.']]);
  assert.deepEqual(slow.findings.map(f => [f.severity, f.text]), [['high', 'First paint on the new server is 3.50 s; Google calls up to 1.8 s good.'], ['high', 'Largest paint on the new server is 4.60 s; Google calls up to 2.5 s good.'], ['high', 'Page cache is off on the new server.']]);
  const near = s.soloVerdict({ ttfb: 500, fcp: 2000, lcp: 2400 });
  assert.equal(near.tone, 'ni'); assert.equal(near.title, 'The new server is nearly fast enough for Google, but first paint needs work');
  assert.equal(s.speedReport({ rounds: [{ hostfile: sample(null, null, null, null, 0, 0) }] }), null, 'no load finished');
  // Rounds with a Live key stay a comparison, also when a Live load failed (null).
  const both = s.speedReport({ rounds: ROUNDS.map((x, i) => (i ? x : { ...x, live: null })), pages: PAGES });
  assert.equal(both.solo, undefined); assert.equal(both.loads, 2); assert.equal(both.timeline.rows.length, 2);
});
