// Speed tab: the measuring loads of both servers turned into the verdict, the timeline, the filmstrip frames, the
// measurements with Google's thresholds and the causes. Pure logic without Electron: main.cjs loads the page in
// offscreen windows and passes plain numbers and headers; the window UI only draws what this returns.

// Google's Core Web Vitals thresholds (good up to the first number, poor above the second).
const GOOGLE = { ttfb: [800, 1800], fcp: [1800, 3000], lcp: [2500, 4000] };
const MOMENTS = [200, 400, 600, 800, 1000, 1200];
const SAME = 0.1;              // within 10 % is "about the same"
const BLANK_SPREAD = 6;        // luminance spread of a frame with nothing on it (a white page is about 0)
const METRICS = [['Time to first byte', 'ttfb', 'ms'], ['First paint (FCP)', 'fcp', 'ms'], ['Largest paint (LCP)', 'lcp', 'ms'], ['Fully loaded', 'load', 'ms'], ['Requests', 'requests', 'count'], ['Transferred', 'transfer', 'bytes']];
const SIDES = ['hostfile', 'live'];

const finite = values => values.filter(Number.isFinite);
function median(values) {
  const v = finite(values).sort((a, b) => a - b), mid = Math.floor(v.length / 2);
  if (!v.length) return null;
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}
const ms = v => (v == null ? 'n/a' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);
const bytes = v => (v == null ? 'n/a' : v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : `${Math.round(v / 1024)} KB`);
const seconds = v => (v == null ? 'n/a' : `${(v / 1000).toFixed(2).replace(/0$/, '')} s`);
const FORMAT = { ms, bytes, count: v => (v == null ? 'n/a' : String(v)) };
// The number of a value in a given unit, without the unit: the spread uses the unit of the median next to it.
const UNITS = { ms: v => String(Math.round(v)), s: v => (v / 1000).toFixed(2), KB: v => String(Math.round(v / 1024)), MB: v => (v / 1048576).toFixed(1), count: v => String(v) };
const unitOf = text => (text.match(/ (ms|s|KB|MB)$/) || [, 'count'])[1];
// "(668 to 673)" for the loads of one server; nothing when there is one load or they all round to the same value.
function spread(values, kind) {
  const v = finite(values);
  if (v.length < 2) return '';
  const unit = UNITS[unitOf(FORMAT[kind](median(v)))], low = unit(Math.min(...v)), high = unit(Math.max(...v));
  return low === high ? '' : `(${low} to ${high})`;
}
function quality(metric, value) {
  const limits = GOOGLE[metric];
  if (!limits || value == null) return '';
  return value <= limits[0] ? 'good' : value <= limits[1] ? 'ni' : 'poor';
}
// Hostfile against Live as a factor: red slower, green faster, neutral within 10 %.
function factor(hostfile, live) {
  if (!Number.isFinite(hostfile) || !Number.isFinite(live) || hostfile <= 0 || live <= 0) return { ratio: 'n/a', word: '', tone: 'same' };
  const r = hostfile / live;
  if (r > 1 + SAME) return { ratio: `${r.toFixed(1)}×`, word: 'slower', tone: 'worse' };
  if (r < 1 - SAME) return { ratio: `${(live / hostfile).toFixed(1)}×`, word: 'faster', tone: 'better' };
  return { ratio: 'about', word: 'the same', tone: 'same' };
}

// rounds: [{ hostfile: sample, live: sample }], sample: { ttfb, fcp, lcp, load, requests, transfer } (numbers or null).
function values(rounds, side, key) { return rounds.map(r => r?.[side]?.[key]).filter(Number.isFinite); }
function medians(rounds) {
  const out = {};
  for (const side of SIDES) out[side] = Object.fromEntries(METRICS.map(([, key]) => [key, median(values(rounds, side, key))]));
  return out;
}
function verdict(m) {
  const load = factor(m.hostfile.load, m.live.load), ttfb = factor(m.hostfile.ttfb, m.live.ttfb), tone = load.tone;
  const d = Number.isFinite(m.hostfile.load) && Number.isFinite(m.live.load) ? m.hostfile.load - m.live.load : 0;
  const title = tone === 'worse' ? 'The new server is slower than Live' : tone === 'better' ? 'The new server is faster than Live' : 'The new server is about as fast as Live';
  const extra = Math.abs(d) >= 100 ? `${d > 0 ? '+' : '-'}${(Math.abs(d) / 1000).toFixed(2)} s per page` : '';
  return { tone, title, factors: [{ label: 'first byte', ...ttfb }, { label: 'fully loaded', ...load }], extra };
}
// One axis for both servers, from 0 to a little past the slowest moment, with round grid steps.
function timeline(m) {
  const top = Math.max(1, ...SIDES.flatMap(s => [m[s].load, m[s].lcp, m[s].fcp, m[s].ttfb]).filter(Number.isFinite));
  const step = top > 15000 ? 5000 : top > 6000 ? 2000 : top > 2500 ? 1000 : top > 1200 ? 500 : 200;
  const max = Math.ceil((top * 1.25) / step) * step;
  const d = Number.isFinite(m.hostfile.load) && Number.isFinite(m.live.load) ? m.hostfile.load - m.live.load : 0;
  const row = side => ({
    side, ttfb: m[side].ttfb, load: m[side].load, loadText: ms(m[side].load),
    ticks: [['first byte', m[side].ttfb], ['first paint', m[side].fcp], ['largest paint', m[side].lcp]].filter(([, v]) => Number.isFinite(v)).map(([name, v]) => ({ name, v })),
  });
  return { max, step, rows: [{ ...row('hostfile'), diff: Math.abs(d) >= 50 ? `${d > 0 ? '+' : '-'}${Math.round(Math.abs(d))} ms` : '', diffTone: d > 0 ? 'worse' : 'better' }, row('live')] };
}
function metricRows(rounds, m) {
  return METRICS.map(([label, key, kind]) => {
    const h = m.hostfile[key], l = m.live[key], format = FORMAT[kind], known = Number.isFinite(h) && Number.isFinite(l), d = known ? h - l : 0;
    const floor = kind === 'ms' ? 50 : kind === 'bytes' ? 5120 : 0, big = known && Math.abs(d) > Math.max(l * SAME, floor);
    const diff = !known ? '' : kind === 'count' ? (d ? `${d > 0 ? '+' : ''}${d}` : 'same') : !big ? 'same' : `${d > 0 ? '+' : '-'}${format(Math.abs(d))}`;
    return { label, key, hostfile: format(h), live: format(l), hostfileSpread: spread(values(rounds, 'hostfile', key), kind), liveSpread: spread(values(rounds, 'live', key), kind),
      hostfileQuality: quality(key, h), liveQuality: quality(key, l), diff, tone: kind === 'count' || !big ? 'same' : d > 0 ? 'worse' : 'better' };
  });
}

// The server software decides the words of a fix: "nginx/1.26.2" is nginx, "LiteSpeed" LiteSpeed, "Apache/2.4" Apache.
function serverKind(server) {
  const s = String(server || '').toLowerCase();
  return /nginx|openresty/.test(s) ? 'nginx' : /litespeed/.test(s) ? 'litespeed' : /apache/.test(s) ? 'apache' : '';
}
// Page cache as the response headers tell it, for example "LiteSpeed HIT" or "Cloudflare HIT".
function pageCache(headers = {}) {
  const h = name => String(headers[name] || '').trim().slice(0, 40);
  if (h('x-litespeed-cache')) return { label: `LiteSpeed ${h('x-litespeed-cache').toUpperCase()}`, hit: /hit/i.test(h('x-litespeed-cache')), cdn: false };
  if (h('cf-cache-status')) return { label: `Cloudflare ${h('cf-cache-status').toUpperCase()}`, hit: /hit/i.test(h('cf-cache-status')), cdn: true };
  for (const name of ['x-fastcgi-cache', 'x-nginx-cache', 'x-proxy-cache', 'x-cache-status', 'x-cache', 'x-varnish-cache', 'x-sg-cache', 'x-kinsta-cache']) if (h(name)) return { label: h(name).toUpperCase(), hit: /hit/i.test(h(name)), cdn: false };
  return { label: '', hit: false, cdn: false };
}
const compression = headers => String(headers?.['content-encoding'] || '').trim().toLowerCase().replace(/^identity$/, '').slice(0, 20);
const CACHE_FIX = {
  nginx: 'turn on a page cache on the new server, for example the nginx FastCGI cache or WP Super Cache.',
  litespeed: 'turn on a page cache on the new server, for example LiteSpeed Cache.',
  apache: 'turn on a page cache on the new server, for example a cache plugin such as WP Super Cache.',
  '': 'turn on a page cache on the new server, for example a cache plugin.',
};
const COMPRESSION_FIX = {
  nginx: 'enable br or gzip in nginx for HTML, CSS and JavaScript.',
  litespeed: 'enable compression in the LiteSpeed settings for HTML, CSS and JavaScript.',
  apache: 'enable mod_brotli or mod_deflate in Apache for HTML, CSS and JavaScript.',
  '': 'enable br or gzip on the new server for HTML, CSS and JavaScript.',
};
// pages: { hostfile, live } with the response headers of the page itself (lower case names).
function causes(m, pages) {
  const kind = serverKind(pages.hostfile?.server), rows = [];
  const cache = { hostfile: pageCache(pages.hostfile), live: pageCache(pages.live) }, packed = { hostfile: compression(pages.hostfile), live: compression(pages.live) };
  if (!cache.hostfile.label && cache.live.hit) rows.push({ id: 'cache', title: 'Page cache is off', hostfile: 'none', live: cache.live.label,
    fix: cache.live.cdn ? 'Live comes from the Cloudflare cache and Hostfile goes to the server itself; turn on a page cache on the new server as well, or expect this difference to go when Cloudflare is in front of it.' : CACHE_FIX[kind] });
  if (!packed.hostfile && packed.live) rows.push({ id: 'compression', title: 'Compression is off', hostfile: 'none', live: packed.live, fix: COMPRESSION_FIX[kind] });
  const h = m.hostfile.ttfb, l = m.live.ttfb;
  if (Number.isFinite(h) && Number.isFinite(l) && h > l * 2 && h - l > 200) rows.push({ id: 'ttfb', title: 'First byte is high', hostfile: ms(h), live: ms(l), fix: 'PHP or the database is slow: check the PHP version, OPcache and an object cache such as Redis.' });
  return rows;
}
function findings(v, m, why) {
  const out = [];
  if (v.tone === 'worse') {
    const ttfb = factor(m.hostfile.ttfb, m.live.ttfb), much = r => parseFloat(r) >= 2 ? 'much ' : '';
    out.push({ severity: 'high', text: ttfb.tone === 'worse' ? `The new server answers ${much(ttfb.ratio)}slower: first byte ${ms(m.hostfile.ttfb)} against ${ms(m.live.ttfb)}.` : `The new server loads the page ${much(v.factors[1].ratio)}slower: fully loaded ${ms(m.hostfile.load)} against ${ms(m.live.load)}.` });
  }
  const cache = why.find(r => r.id === 'cache'), packed = why.find(r => r.id === 'compression');
  if (cache && packed) out.push({ severity: 'high', text: `Page cache and compression are off on the new server (Live: ${cache.live}, ${packed.live}).` });
  else if (cache) out.push({ severity: 'high', text: `Page cache is off on the new server (Live: ${cache.live}).` });
  else if (packed) out.push({ severity: 'high', text: `Compression is off on the new server (Live: ${packed.live}).` });
  return out;
}
// Without Live (it could not be reached): the new server on its own, judged on Google's thresholds instead of a comparison.
const LIMIT = { ttfb: '800 ms', fcp: '1.8 s', lcp: '2.5 s' };
const WORD = { good: 'good', ni: 'needs work', poor: 'poor' };
const MOMENT_NAMES = [['first byte', 'ttfb', 'First byte'], ['first paint', 'fcp', 'First paint'], ['largest paint', 'lcp', 'Largest paint']];
function soloVerdict(h) {
  const factors = MOMENT_NAMES.map(([label, key]) => { const q = quality(key, h[key]); return { label, key, value: ms(h[key]), q, word: WORD[q] || 'not measured' }; });
  const poor = factors.find(f => f.q === 'poor'), worst = poor || factors.find(f => f.q === 'ni');
  const paints = factors.slice(1).every(f => f.q === 'good');
  const title = !worst ? 'The new server is fast enough for Google'
    : paints ? `The new server is fast enough for Google on first paint, but first byte ${worst.q === 'poor' ? 'is poor' : 'needs work'}`
      : worst.q === 'poor' ? `The new server is too slow for Google on ${worst.label}` : `The new server is nearly fast enough for Google, but ${worst.label} needs work`;
  return { tone: !worst ? 'good' : poor ? 'poor' : 'ni', title, factors, limit: worst ? `Google: ${worst.label} good up to ${LIMIT[worst.key]}` : 'Google: first byte good up to 800 ms, first paint 1.8 s, largest paint 2.5 s' };
}
// What to improve from the facts of the new server alone: no page cache header, no compression, first byte above 800 ms.
function improve(h, page = {}) {
  const kind = serverKind(page.server), rows = [];
  if (!pageCache(page).label) rows.push({ id: 'cache', title: 'No page cache header', hostfile: 'none', target: 'HIT from a page cache', fix: CACHE_FIX[kind] });
  if (!compression(page)) rows.push({ id: 'compression', title: 'No compression', hostfile: 'none', target: 'br or gzip', fix: COMPRESSION_FIX[kind] });
  if (Number.isFinite(h.ttfb) && h.ttfb > GOOGLE.ttfb[0]) rows.push({ id: 'ttfb', title: 'First byte above 800 ms', hostfile: ms(h.ttfb), target: 'up to 800 ms', fix: 'PHP or the database is slow: check the PHP version, OPcache and an object cache such as Redis.' });
  return rows;
}
function soloFindings(v, rows) {
  const out = [], label = Object.fromEntries(MOMENT_NAMES.map(([, key, name]) => [key, name]));
  for (const f of v.factors) if (f.q === 'ni' || f.q === 'poor') out.push({ severity: f.q === 'poor' ? 'high' : 'both', text: `${label[f.key]} on the new server is ${f.value}; Google calls up to ${LIMIT[f.key]} good.` });
  const cache = rows.some(r => r.id === 'cache'), packed = rows.some(r => r.id === 'compression');
  if (cache && packed) out.push({ severity: 'high', text: 'Page cache and compression are off on the new server.' });
  else if (cache) out.push({ severity: 'high', text: 'Page cache is off on the new server.' });
  else if (packed) out.push({ severity: 'high', text: 'Compression is off on the new server.' });
  return out;
}
function soloReport({ rounds, pages = {}, film = null }) {
  const good = rounds.filter(r => Number.isFinite(r?.hostfile?.load));
  if (!good.length) return null;
  const m = medians(good), v = soloVerdict(m.hostfile), rows = improve(m.hostfile, pages.hostfile), t = timeline(m);
  const appears = seconds(Number.isFinite(m.hostfile.fcp) ? m.hostfile.fcp : film?.hostfile?.firstContent ?? null);
  return { solo: true, loads: good.length, medians: m, verdict: v, timeline: { ...t, rows: [t.rows[0]] }, metrics: metricRows(good, m), why: [], improve: rows, findings: soloFindings(v, rows),
    film: film?.hostfile ? [{ side: 'hostfile', appears, frames: (film.hostfile.frames || []).map(f => ({ label: `${(f.m / 1000).toFixed(1)} s`, src: f.src || '', blank: f.blank })) }] : [] };
}

// Everything the Speed tab shows, from the samples of each round and the page headers of the last good round. Rounds
// that have no Live sample at all ({ hostfile } only) are the new server on its own: see soloReport.
function speedReport({ rounds, pages = {}, film = null }) {
  if (rounds.length && rounds.every(r => r && r.live === undefined)) return soloReport({ rounds, pages, film });
  const good = rounds.filter(r => SIDES.every(s => Number.isFinite(r?.[s]?.load)));
  if (!good.length) return null;
  const m = medians(good), v = verdict(m), why = causes(m, pages);
  const appears = side => seconds(Number.isFinite(m[side].fcp) ? m[side].fcp : film?.[side]?.firstContent ?? null);
  return { loads: good.length, medians: m, verdict: v, timeline: timeline(m), metrics: metricRows(good, m), why, findings: findings(v, m, why),
    film: film ? SIDES.map(side => ({ side, appears: appears(side), frames: (film[side]?.frames || []).map(f => ({ label: `${(f.m / 1000).toFixed(1)} s`, src: f.src || '', blank: f.blank })) })) : [] };
}

// Filmstrip: the luminance spread of a small BGRA bitmap (Electron's toBitmap) tells an empty frame from one with content.
function luminanceSpread(bitmap) {
  const n = Math.floor(bitmap.length / 4);
  if (!n) return 0;
  let sum = 0, square = 0;
  for (let i = 0; i < n * 4; i += 4) { const y = 0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2]; sum += y; square += y * y; }
  const mean = sum / n;
  return Math.round(Math.sqrt(Math.max(0, square / n - mean * mean)) * 10) / 10;
}
// The filmstrip of one load: paints arrive in time order (t in ms after the load started, below 0 = the blank page
// before it). The frame on screen at each moment is the last one painted at or before it, so only that one is kept:
// A paint after the last moment only closes the moments (its item may be null); finish() gives one frame per moment.
function createFilm(moments = MOMENTS) {
  let latest = null, open = 0, first = null;
  const frames = [], last = moments.at(-1);
  return {
    paint(t, item) {
      while (open < moments.length && moments[open] < t) frames[open++] = latest;
      if (open >= moments.length) return false;
      latest = { t, ...item };
      if (first === null && t > 0 && item.spread > BLANK_SPREAD) first = t;
      return t <= last;
    },
    finish() { while (open < moments.length) frames[open++] = latest; return { firstContent: first, frames: moments.map((m, i) => ({ m, frame: frames[i], blank: !frames[i] || frames[i].spread <= BLANK_SPREAD })) }; },
  };
}

// Lines for Ask Claude, inside the untrusted block (the numbers come from the servers).
function speedLines(report) {
  if (!report) return [];
  if (report.solo) {
    const solo = ['Speed of the new server alone, Live could not be reached (median of the loads, from this computer):', `- ${report.verdict.title}: ${report.verdict.factors.map(f => `${f.label} ${f.value} ${f.word}`).join(', ')}`];
    for (const r of report.metrics) solo.push(`- ${r.label}: Hostfile ${r.hostfile}`);
    for (const r of report.improve) solo.push(`- To improve: ${r.title} (Hostfile ${r.hostfile}, target ${r.target})`);
    return solo;
  }
  const lines = ['Speed (median of the loads, from this computer):', `- ${report.verdict.title}: ${report.verdict.factors.map(f => `${f.label} ${f.ratio} ${f.word}`.trim()).join(', ')}${report.verdict.extra ? `, ${report.verdict.extra}` : ''}`];
  for (const r of report.metrics) lines.push(`- ${r.label}: Hostfile ${r.hostfile}, Live ${r.live}${r.diff ? ` (${r.diff})` : ''}`);
  for (const r of report.why) lines.push(`- Cause: ${r.title} (Hostfile ${r.hostfile}, Live ${r.live})`);
  return lines;
}

module.exports = { GOOGLE, MOMENTS, BLANK_SPREAD, median, spread, quality, factor, medians, verdict, timeline, metricRows, serverKind, pageCache, compression, causes, findings, speedReport, soloVerdict, improve, soloReport, luminanceSpread, createFilm, speedLines, ms, bytes, seconds };
