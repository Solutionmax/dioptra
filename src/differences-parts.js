/* The parts of Differences (1.4.0-beta.3): what the menu, the Overview and the head of a part say, derived from the
   reports in the state. No DOM here, so node can test it; loaded before renderer.js, which draws it.
   state of a part: fix (red), check (amber), info (blue, shown but not judged), none (grey, no result), ok (green).
   A result is [state, tag, line, points, why]: a point is a text or { text, state } when it weighs differently from its
   part; why says what kind of "none" it is: 'busy' (still running), 'missing' (it should have a result and has none),
   or nothing (there is nothing to compare, as for the page parts when Live has no page).
   A point with own: true is about this page itself (its status, a redirect): in a whole-site result it stays listed
   under every page that has it. */
const nOf = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const bare = text => String(text || '').replace(/\.$/, '');
const worstFirst = groups => { const items = groups.flatMap(g => g.items); return [...items.filter(i => i.tone === 'worse'), ...items.filter(i => i.tone !== 'worse')]; };
// Two cards may say the same in one line: once. A card that is worse weighs as its part does, another one is to look at.
// key: what makes it the same finding on another page of the site ("4 old addresses" and "3 old addresses" are one).
const toned = (items, worse) => [...new Map(items.map(i => [i.title, { text: i.title, state: i.tone === 'worse' ? worse : 'check', key: String(i.title).replace(/^\d+ /, '# ') }])).values()];
const AGAIN = 'Use Compare again to run it once more';
// Findings of the page comparison that belong to one part; the rest (a request that failed, why Live is away) goes to the verdict.
const OF_DOMAINS = / loads only on (Hostfile|Live)\b|other external domains? only on /, OF_UNREAD = / page was not read to the end: /, OF_HTML = /^Inline script that looks obfuscated/;
// Found in text that a browser may still read as markup (differences.cjs, possibleFindings): amber, never red on its own.
const OF_POSSIBLE = / found only on (Hostfile|Live), inside text that a browser may still /;
const OF_HEADERS_HIGH = /^HTTP status differs/, OF_HEADERS_CHECK = /^Redirects differ/, OF_HEADERS = /^(Server software|X-Powered-By) differs|^Cache headers differ|responded much slower/;

// A script or frame from another site that only the new server loads is what an injection looks like: red. The rest
// (images, fonts, anything only Live loads) is a difference to look at once.
const foreignCode = x => !x.firstParty && x.hostfile && !x.live && (x.types || []).some(t => t === 'script' || t === 'frame');
function domainsResult(r, nl) {
  // A page that was not read to the end cannot be called the same: amber on this part, whatever else it says. So is
  // what only one side has in text that a browser may still run (not without Live, like the other domain differences).
  const unread = (r.findings || []).filter(f => OF_UNREAD.test(f.text)).map(f => ({ text: bare(f.text), state: 'check', key: bare(f.text).replace(/: .*$/, '') }));
  const maybe = nl ? [] : (r.findings || []).filter(f => OF_POSSIBLE.test(f.text)).map(f => ({ text: bare(f.text), state: 'check' }));
  const [state, tag, line, points = []] = domainsRead(r, nl);
  if (!unread.length && !maybe.length) return [state, tag, line, points];
  const quiet = state === 'ok' || state === 'none';
  const [quietTag, quietLine] = unread.length ? ['Not all read', 'The page is too large to read to the end'] : ['Possibly hidden', 'Found in text that a browser may still run'];
  return [state === 'fix' ? 'fix' : 'check', quiet ? quietTag : tag, quiet ? quietLine : line, [...points.filter(x => x.state === 'fix'), ...unread, ...maybe, ...points.filter(x => x.state !== 'fix')]];
}
function domainsRead(r, nl) {
  const all = r.domains || [], host = all.filter(x => x.hostfile && !x.live), live = all.filter(x => x.live && !x.hostfile), n = host.length + live.length;
  if (nl) return ['none', all.length ? `${all.length} on Hostfile` : 'None found', 'No Live to compare'];
  if (!n) return ['ok', all.length ? 'Same' : 'None', all.length ? `${nOf(all.length, 'domain')} found on both` : 'No external domains found'];
  const mixed = host.length && live.length, bad = host.filter(foreignCode), rest = [...host.filter(x => !foreignCode(x)), ...live];
  const say = x => `${x.host}${x.types?.length ? `, ${x.types.join(' and ')}` : ''}${mixed ? `, only on ${x.hostfile ? 'Hostfile' : 'Live'}` : ''}`;
  return [bad.length ? 'fix' : 'check', mixed ? `${n} differ` : host.length ? `${n} new` : `${n} missing`,
    bad.length ? `${nOf(bad.length, 'script or frame', 'scripts or frames')} from another site only on the new server` : mixed ? 'Loaded by one server only' : host.length ? 'Only the new server loads from these' : 'Only Live loads from these',
    [...bad.map(x => ({ text: say(x), state: 'fix' })), ...rest.map(x => ({ text: say(x), state: 'check' }))]];
}
function filesResult(f, nl) {
  if (nl) return ['none', 'Not measured', 'Live has no page'];
  if (!f) return ['none', 'Not measured', 'Not measured yet', [], 'missing'];
  if (!f.measured) {
    // Live was not loaded for this page, but the tab knows what failed on the new server while it loaded.
    const alone = f.alone || [];
    if (f.measuring) return ['none', 'Measuring…', 'The page is loading', [], 'busy'];
    if (alone.length || f.old?.length) return ['check', alone.length ? `${alone.length} failed` : `${f.counts.old} from old server`, 'New server only, open Compare to check them on Live', [...alone.map(x => `${x.name} ${x.hostfile.status}`), ...(f.old || []).map(g => `${nOf(g.files.length, 'file')} from the old server (${g.host})`)]];
    return ['ok', 'All loaded', 'On the new server; open Compare to measure Live'];
  }
  const c = f.counts, points = (f.findings || []).filter(x => x.severity !== 'both').map(x => bare(x.title || x.text));
  const also = [c.old && `${c.old} from old server`, c.both && `${c.both} on both`].filter(Boolean).join(' · ');
  if (c.only) return ['fix', `${c.only} failed`, `Only on Hostfile${also ? ` · ${also}` : ''}`, points];
  if (c.old) return ['fix', `${c.old} from old server`, c.both ? `${c.both} more on both servers` : 'No domain rule for their host', points];
  if (points.length) return ['fix', nOf(points.length, 'problem'), 'Only on Hostfile', points];
  if (f.measuring) return ['none', 'Measuring…', 'Both servers', [], 'busy'];
  if (c.both) return ['info', `${c.both} on both`, 'Not a migration difference'];
  return ['ok', 'All loaded', 'On both servers'];
}
function htmlResult(r, nl, findings) {
  if (nl) return ['none', 'Not compared', 'Live has no page'];
  const n = r.html?.changedLines || 0, odd = findings.filter(f => OF_HTML.test(f.text)), tag = n ? nOf(n, 'line') : 'Identical', line = n ? `${nOf(n, 'line')} ${n === 1 ? 'differs' : 'differ'}` : 'Same markup';
  if (odd.length) return [odd.some(f => / only on Hostfile:/.test(f.text)) ? 'fix' : 'check', tag, line, odd.map(f => ({ text: bare(f.text), state: / only on Hostfile:/.test(f.text) ? 'fix' : 'check' }))];
  return [n ? 'info' : 'ok', tag, line];
}
// The redirect difference without the path of the page itself: http to https on every page is one finding for the site.
function sameRedirect(r) {
  let page; try { page = new URL(r.url); } catch { return undefined; }
  const chain = side => (r[side]?.redirects || []).map(x => { try { const u = new URL(x.location); return u.pathname + u.search === page.pathname + page.search ? `${u.origin}/(this page)` : x.location; } catch { return x.location; } }).join(' > ');
  return `Redirects differ: ${chain('hostfile')} | ${chain('live')}`;
}
function headersResult(r, nl, findings) {
  if (nl) return ['none', 'Not compared', 'Live has no page'];
  const rows = r.headers || [], high = findings.filter(f => OF_HEADERS_HIGH.test(f.text)), odd = findings.filter(f => OF_HEADERS_CHECK.test(f.text));
  const tag = rows.length ? `${rows.length} differ` : 'Same', line = rows.length ? rows.slice(0, 3).map(h => h.name).join(', ') : 'No differences';
  if (high.length || odd.length) return [high.length ? 'fix' : 'check', high.length ? 'Status differs' : 'Redirects differ', line, [...high.map(f => ({ text: bare(f.text), state: 'fix', own: true })), ...odd.map(f => ({ text: bare(f.text), state: 'check', own: true, key: sameRedirect(r) }))]];
  return [rows.length ? 'info' : 'ok', tag, line];
}
function speedResult(sp) {
  if (!sp || sp.status === 'idle') return ['none', 'Not measured', 'Measured after the comparison', ['Open Speed and use Measure now'], 'missing'];
  if (sp.status === 'waiting' || sp.status === 'running') return ['none', 'Measuring…', sp.status === 'waiting' ? 'Starts when the checks are done' : 'Loading the page 3 times, cache off', [], 'busy'];
  if (sp.status === 'error' || !sp.report) return ['none', 'No result', sp.error || 'Speed could not be measured', ['Open Speed and use Measure again'], 'missing'];
  const r = sp.report, v = r.verdict;
  if (r.solo) {
    const list = v.factors.map(f => `${f.label} ${f.value}`).join(', '), line = list.charAt(0).toUpperCase() + list.slice(1), points = r.improve.map(w => w.title);
    if (v.tone === 'poor') return ['fix', 'Too slow', line, points];
    return v.tone === 'ni' || points.length ? ['check', v.tone === 'ni' ? 'Needs work' : `${points.length} to improve`, line, points] : ['ok', 'Fast enough', line];
  }
  // The tag names the moment that lost most; the line gives its two values.
  const load = v.factors[1], worst = v.factors.filter(f => f.tone === 'worse').sort((a, b) => parseFloat(b.ratio) - parseFloat(a.ratio))[0] || load, points = r.why.map(w => w.title);
  const at = r.metrics.find(m => m.key === (worst === load ? 'load' : 'ttfb')), line = at ? `${worst === load ? 'Fully loaded' : 'First byte'} after ${at.hostfile}, Live after ${at.live}` : v.title;
  if (v.tone === 'worse') return ['fix', `${worst.ratio} slower`, line, points.length ? points : r.findings.map(f => bare(f.text))];
  if (points.length) return ['check', `${points.length} to check`, line, points];
  return ['ok', v.tone === 'better' ? `${load.ratio} faster` : 'Same speed', line];
}
function checksResult(ck) {
  if (!ck || ck.status === 'idle') return ['none', 'Not run', 'Run after the comparison', [AGAIN], 'missing'];
  if (ck.status === 'running') return ['none', 'Checking…', 'Search engines, old addresses, standard URLs', [], 'busy'];
  if (ck.status === 'error' || !ck.report) return ['none', 'No result', ck.error || 'The checks could not run', [AGAIN], 'missing'];
  const r = ck.report, c = r.counts, points = toned(worstFirst(r.groups), 'fix'), need = r.solo && c.needLive ? `, ${c.needLive} need Live` : '';
  if (c.problems) return ['fix', `${c.problems} failed`, `${c.problems} of ${nOf(c.total, 'check')} failed, ${c.passed} passed${need}`, points];
  if (c.differ) return ['check', r.solo ? nOf(c.differ, 'warning') : `${c.differ} ${c.differ === 1 ? 'differs' : 'differ'}`, `${c.passed} of ${nOf(c.total, 'check')} passed${need}`, points];
  return ['ok', `${c.passed} passed`, `${nOf(c.total, 'check')}, no problems${need}`];
}
// An add-on report says how bad it is itself: tone warn is "look at once", anything else a threat. The words come from its summary.
function addonResult(a) {
  if (!a || a.status === 'idle') return ['none', 'Not run', 'Runs after the comparison', [AGAIN], 'missing'];
  if (a.status === 'running') return ['none', 'Scanning…', `${a.name} is scanning`, [], 'busy'];
  if (a.status === 'error' || !a.report) return ['none', 'No result', a.error || 'The scan could not run', [AGAIN], 'missing'];
  // A tag is a count and a word: of a longer first summary text ("5 open on the new server") the first two words.
  const r = a.report, c = r.counts, words = r.summary.map(s => s.text), items = worstFirst(r.groups), bad = items.filter(i => i.tone === 'worse'), first = (words[0] || '').length > 16 ? words[0].split(' ').slice(0, 2).join(' ') : words[0];
  const worse = r.tone === 'warn' ? 'check' : 'fix', cut = a.limited ? [{ text: LIMITED, state: 'check' }] : [];
  if (c.problems) return [worse, first || nOf(c.problems, r.tone === 'warn' ? 'problem' : 'threat'), words.slice(1).join(' · ') || r.sub, [...toned(bad.length ? bad : items, worse), ...cut]];
  if (c.differ || items.length) return ['check', first || nOf(c.differ || items.length, r.tone === 'warn' ? 'difference' : 'warning'), words.slice(1).join(' · ') || r.sub, [...toned(items, worse), ...cut]];
  // Dioptra refused requests of this scan: what it did not ask it cannot call clean.
  if (a.limited) return ['none', 'Limited', LIMITED, ['Compare again in a few minutes'], 'missing'];
  // The safety net of the app: a report that checked nothing, or whose own first words are a warning, is not "clean",
  // whatever its counts say. Amber, in the add-on's words.
  const doubt = !c.total || ['warn', 'bad'].includes(r.summary[0]?.tone);
  if (doubt) return ['check', words[0] || 'Nothing checked', words.slice(1).join(' · ') || r.sub || 'The add-on reported no checks', [{ text: words[0] || 'The add-on reported no checks', state: 'check' }]];
  return ['ok', r.passed.length ? `${r.passed.length} clean` : 'Clean', words.join(' · ') || r.sub];
}
const LIMITED = 'The scan was cut short: too many requests to this site in a short time';
// ponytail: the three known add-ons get their line here, like their icon in renderer.js; the upgrade path is a field in the add-on manifest.
// Object.hasOwn: an add-on may be called "constructor".
const ADDON_WHAT = { 'malware-scan': 'Spam, card skimmers and hidden redirects', 'seo-check': 'What Google reads after the move', 'wp-leak-check': 'Files and versions a stranger can reach' };

// s: the state of the window. Returns the parts in menu order and the findings no part covers.
function diffParts(s) {
  const d = s.differences || {}, r = d.report || {}, nl = d.liveReason || null, found = r.findings || [];
  const speedDone = s.speed?.status === 'done' && s.speed.report;
  const part = (id, group, name, what, [state, tag, line, points = [], why = ''], extra = {}) => {
    const all = points.map(p => (typeof p === 'string' ? { text: p, state } : p));
    return { id, group, name, what, state, tag, line, all, tops: all.slice(0, 3).map(p => p.text), more: Math.max(0, all.length - 3), busy: why === 'busy', missing: why === 'missing', ...extra };
  };
  const parts = [
    part('domains', 'The page', 'External domains', 'Other sites the page loads from', domainsResult(r, nl)),
    part('files', 'The page', 'Files', 'Images, styles and scripts that failed', filesResult(s.files, nl)),
    part('html', 'The page', 'HTML', 'Changed lines in the page source', htmlResult(r, nl, found)),
    part('headers', 'The page', 'Headers', 'What the server sends with the page', headersResult(r, nl, found)),
    part('speed', 'The server', 'Speed', nl ? 'The new server on its own' : 'Load time against Live', speedResult(s.speed)),
    part('checks', 'The server', 'Checks', nl ? 'The new server on its own, judged on what a good server gives' : 'Search engines, old addresses, standard URLs', checksResult(s.checks)),
    ...(s.addonTabs || []).map(a => part(`addon:${a.id}`, 'Add-ons', a.name, (Object.hasOwn(ADDON_WHAT, a.id) && ADDON_WHAT[a.id]) || bare(String(a.sub || '').split(' · ')[0]) || a.label, addonResult(a), { addon: a.id, by: a.by || '', scope: a.scope === 'site' ? 'site' : 'page' })),
  ];
  // The domain findings are covered by External domains (which turns red for a foreign script or frame on the new server).
  const covered = f => OF_DOMAINS.test(f.text) || OF_UNREAD.test(f.text) || OF_POSSIBLE.test(f.text) || OF_HTML.test(f.text) || OF_HEADERS_HIGH.test(f.text) || OF_HEADERS_CHECK.test(f.text) || (OF_HEADERS.test(f.text) && (speedDone || !/responded much slower/.test(f.text)));
  return { parts, rest: found.filter(f => !covered(f)), solo: Boolean(nl) };
}
// The bar at the top of the Overview. tone: worse (red), better (green), or none while something still runs or a part
// that should have a result has none: without it the whole cannot be called fine.
function diffVerdict({ parts, rest }) {
  const names = list => list.map(p => p.name).join(', '), of = state => parts.filter(p => p.state === state);
  const fix = of('fix'), check = of('check'), busy = parts.filter(p => p.busy), missing = parts.filter(p => p.missing);
  const say = f => f.text || f.title || '', high = rest.filter(f => f.severity === 'high' && !f.calm), notes = rest.filter(f => f !== high[0] || fix.length).map(f => (f.calm && f.detail ? `${say(f)} ${f.detail}` : say(f)));
  const left = missing.length ? ` No result for: ${names(missing)}.` : '';
  if (fix.length) return { tone: 'worse', title: 'Not ready for the switch', text: `${nOf(fix.length, 'part')} ${fix.length === 1 ? 'needs' : 'need'} a fix on the new server first: ${names(fix)}.${left}`, notes };
  if (high.length) return { tone: 'worse', title: 'Not ready for the switch', text: `${say(high[0])}${left}`, notes };
  if (busy.length) return { tone: '', title: 'Still measuring', text: `${names(busy)} ${busy.length === 1 ? 'is' : 'are'} not done yet. Nothing to fix so far.`, notes };
  if (missing.length) return { tone: '', title: 'The result is incomplete', text: `No result for: ${names(missing)}. ${check.length ? `Worth a look once: ${names(check)}. ` : ''}Nothing to fix in the parts that have a result.`, notes };
  return { tone: 'better', title: 'Nothing to fix before the switch', text: check.length ? `Worth a look once: ${names(check)}.` : 'Every part is fine.', notes };
}
if (typeof module === 'object') module.exports = { diffParts, diffVerdict, nOf };
