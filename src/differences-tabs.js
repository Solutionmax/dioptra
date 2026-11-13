/* The Speed, Checks and add-on panels of Differences (1.2). Loaded just before renderer.js; its functions run later and use the helpers
   of renderer.js (el, icon, table, command, toast, state, diffKey).
   Main measures and checks; this only draws what state.speed and state.checks hold. All text goes in with textContent. */
function fbtn(label, iconName, title, onclick) {
  const b = el('button', 'fbtn'); b.type = 'button'; if (iconName) b.append(icon(iconName)); b.append(label);
  if (title) b.title = title; if (onclick) b.onclick = onclick; return b;
}
const sideTag = side => el('span', `tag ${side === 'hostfile' ? 'h' : 'l'}`, side === 'hostfile' ? 'Hostfile' : 'Live');
const sideBadge = side => { const wrap = el('span', side); wrap.append(el('span', 'badge', side === 'hostfile' ? 'Hostfile' : 'Live')); return wrap; };
function secHead(label, muted, extra) { const h = el('div', 'sec-h'); h.append(el('span', 'lbl', label)); if (muted) h.append(el('span', 'muted', muted)); if (extra) h.append(extra); return h; }
function waitState(title, text) { const n = el('div', 'dstate small'); n.append(el('div', 'spinner'), el('h2', '', title), el('p', '', text)); return n; }

// What the parts draw from. The load counter only counts while Speed is open: else every load would draw the whole view again.
function pageTabsKey() {
  const s = state.speed, c = state.checks;
  return [s && [s.status, s.error, s.report?.measuredAt, diffPart === 'speed' && s.progress?.done], c && [c.status, c.error, c.url, c.report && JSON.stringify(c.report.counts) + c.report.groups.map(g => g.items.map(i => i.id + i.title).join()).join()], checksShowPassed, (state.addonTabs || []).map(a => [a.id, a.name, a.label, a.sub, a.by, a.limited, a.status, a.error, a.report && JSON.stringify(a.report)])];
}

/* Live could not be reached (1.2.0-beta.3): a calm note with the reason, then the new server on its own. */
const noLive = () => state.differences?.liveReason || null;
const clockTime = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
// verb: what Dioptra did with the new server alone; again: the button that asks Live once more (main fetches it first).
function liveBanner(verb, again) {
  const R = noLive(), box = el('div', 'nl-banner'), text = el('div', 'nl-text'), at = clockTime(R.checkedAt);
  text.append(icon('info'), el('b', '', R.text), el('p', '', `There is no old site to compare with, so Dioptra ${verb} the new server on its own.`), el('code', '', `${R.detail}${at ? ` · checked ${at}` : ''}`));
  const busy = Boolean(state.differences?.liveRetry);
  const button = fbtn(busy ? 'Trying Live…' : again, 'reload', R.kind === 'dns' ? 'Try Live again, for when its DNS record is there' : 'Try Live again, for when the old server answers', () => command('live-retry'));
  button.disabled = busy; box.setAttribute('role', 'status'); box.append(text, button); return box;
}

/* Speed */
let tickObservers = [];
function speedPanel(sp) {
  for (const o of tickObservers) o.disconnect();
  tickObservers = [];
  const wrap = el('div', `sp2${noLive() ? ' solo' : ''}`), alone = Boolean(noLive());
  if (alone) wrap.append(liveBanner('measured', 'Measure Live too'));
  const who = alone ? 'the new server' : 'both servers';
  if (!sp || sp.status === 'idle') { const p = el('div', 'dempty'); p.append('Speed is measured after the comparison. ', fbtn('Measure now', 'reload', `Load the page 3 times on ${who} without the cache`, () => command('speed-measure'))); wrap.append(p); return wrap; }
  if (sp.status === 'waiting') { wrap.append(waitState('Checking first', `The speed loads start when the checks are done, so the checks do not slow ${alone ? 'the server' : 'the servers'} down.`)); return wrap; }
  if (sp.status === 'running') { wrap.append(waitState(alone ? 'Measuring the new server' : 'Measuring both servers', `${sp.progress ? `${sp.progress.done} of ${sp.progress.total} loads done. ` : ''}${alone ? 'The new server loads the page 3 times' : 'Each server loads the page 3 times at the same moment'}, cache off, in a window you do not see.`)); return wrap; }
  if (sp.status === 'error' || !sp.report) { const n = el('div', 'dstate small'); n.append(el('h2', '', 'Speed could not be measured'), el('code', '', sp.error || 'No result.'), fbtn('Measure again', 'reload', '', () => command('speed-measure'))); wrap.append(n); return wrap; }
  const r = sp.report, bottom = el('div', 'sp2-bottom');
  if (r.solo) {
    bottom.append(speedMetricsSolo(r), speedImprove(r));
    wrap.append(speedVerdictSolo(r), speedTimeline(r, 'the new server, 0 to fully loaded'), speedFilm(r, 'what the new server shows while the page loads, captured during a real load, cache off'), bottom);
    return wrap;
  }
  bottom.append(speedMetrics(r), speedWhy(r));
  wrap.append(speedVerdict(r), speedTimeline(r), speedFilm(r), bottom);
  return wrap;
}
// The new server alone: the verdict on Google's thresholds, one value per moment.
function speedVerdictSolo(r) {
  const v = r.verdict, box = el('div', `box sv solo ${v.tone}`), left = el('div', ''), fx = el('div', 'sv-fx');
  v.factors.forEach((f, i) => { const item = el('span', 'fx'); if (i) item.append(el('span', 'dot', '·')); item.append(`${f.label} `, el('b', f.q, f.value), ` ${f.word}`); fx.append(item, ' '); });
  left.append(el('div', 'sv-title', v.title), fx, el('div', 'sv-lim', v.limit));
  const meta = el('div', 'sv-meta'), lbl = el('span', 'lbl');
  lbl.append(`${r.loads} load${r.loads === 1 ? '' : 's'}, median`, document.createElement('br'), 'new server only');
  meta.append(lbl, fbtn('Measure again', 'reload', 'Load the page 3 times on the new server without the cache', () => command('speed-measure')));
  box.append(left, meta); return box;
}
// Measurements with the Hostfile column; one muted No Live cell instead of the Live and Difference columns.
function speedMetricsSolo(r) {
  const box = el('div', 'box mt'), key = el('span', 'gkey');
  for (const [c, t] of [['good', 'good'], ['ni', 'needs work'], ['poor', 'poor']]) { const s = el('span', ''); s.append(el('i', `qd ${c}`), t); key.append(s); }
  box.title = 'Google thresholds: first byte good up to 800 ms, poor above 1800 ms; first paint 1800 and 3000 ms; largest paint 2500 and 4000 ms.';
  box.append(secHead('Measurements', 'Google thresholds', key));
  const t = table(['Metric', 'Hostfile', 'Live'], []), cols = document.createElement('colgroup'), body = t.querySelector('tbody');
  for (const w of ['32%', '38%', '30%']) { const c = document.createElement('col'); c.style.width = w; cols.append(c); }
  r.metrics.forEach((m, i) => {
    const tr = document.createElement('tr'), a = document.createElement('td'), b = document.createElement('td'), v = el('span', 'v');
    a.append(el('span', 'metric', m.label)); v.append(el('i', `qd ${m.hostfileQuality || 'none'}`), m.hostfile); if (m.hostfileSpread) v.append(el('span', 'spr', m.hostfileSpread)); b.append(v); tr.append(a, b);
    if (!i) { const note = el('td', 'nolive'); note.rowSpan = r.metrics.length; note.append(el('b', '', 'No Live'), el('span', '', 'nothing to compare with until Live can be reached')); tr.append(note); }
    body.append(tr);
  });
  t.prepend(cols); box.append(t); return box;
}
// What to improve, from facts of the new server alone, each with its target.
function speedImprove(r) {
  const box = el('div', `box why${r.improve.length ? '' : ' none'}`);
  box.append(secHead('What to improve', 'from the new server alone'));
  if (!r.improve.length) { box.append(el('p', 'why-none', 'Page cache, compression and first byte look fine.')); return box; }
  for (const w of r.improve) {
    const row = el('div', 'why-row'), head = el('div', 'head'), vals = el('div', 'vals'), h = el('span', ''), aim = el('span', ''), fix = el('div', 'fixl');
    h.append(sideTag('hostfile'), el('span', 'bad', w.hostfile)); aim.append(el('span', 'tag t', 'Target'), el('span', 'aim', w.target)); vals.append(h, aim);
    head.append(el('b', '', w.title), vals); fix.append(el('i', '', 'Fix: '), w.fix);
    row.append(icon('alert'), head, el('span', ''), fix); box.append(row);
  }
  return box;
}
function speedVerdict(r) {
  const v = r.verdict, box = el('div', `box sv ${v.tone}`), left = el('div', ''), fx = el('div', 'sv-fx');
  v.factors.forEach((f, i) => { if (i) fx.append(el('span', 'dot', '·')); fx.append(`${f.label} `, el('b', '', f.ratio), f.word ? ` ${f.word}` : ''); });
  if (v.extra) fx.append(el('span', 'dot', '·'), v.extra);
  left.append(el('div', 'sv-title', v.title), fx);
  const meta = el('div', 'sv-meta'), lbl = el('span', 'lbl');
  lbl.append(`${r.loads} load${r.loads === 1 ? '' : 's'} each, median`, document.createElement('br'), 'from this computer');
  meta.append(lbl, fbtn('Measure again', 'reload', 'Load the page 3 times on both servers without the cache', () => command('speed-measure')));
  box.append(left, meta); return box;
}
function speedTimeline(r, muted = 'both servers on one axis, 0 to fully loaded') {
  const T = r.timeline, box = el('div', 'box tl'), key = el('span', 'tl-key'), k1 = el('span', ''), k2 = el('span', '');
  k1.append(el('i', 'k-wait'), 'waiting for the server'); k2.append(el('i', 'k-tick'), 'moment'); key.append(k1, k2);
  box.append(secHead('Timeline', muted, key));
  const rows = el('div', 'tl-rows'), pct = v => `${(v / T.max) * 100}%`;
  for (const row of T.rows) {
    const line = el('div', `tl-row ${row.side === 'hostfile' ? 'h' : 'l'}`), track = el('div', 'tl-track');
    for (let g = T.step; g < T.max; g += T.step) { const gl = el('i', 'tl-gl'); gl.style.left = pct(g); track.append(gl); }
    if (Number.isFinite(row.load)) { const bar = el('div', 'tl-bar'); bar.style.width = pct(row.load); track.append(bar); }
    if (Number.isFinite(row.ttfb)) { const wait = el('div', 'tl-wait'); wait.style.width = `calc(${pct(row.ttfb)} - 1px)`; track.append(wait); }
    for (const t of row.ticks) { const tick = el('i', 'tl-tick'); tick.style.left = pct(t.v); tick.title = `${t.name} ${t.v} ms`; track.append(tick); }
    const end = el('div', 'tl-end', row.loadText); end.style.left = pct(Math.max(row.load || 0, ...row.ticks.map(t => t.v)));
    if (row.diff) end.append(el('span', `d ${row.diffTone === 'better' ? 'better' : ''}`, row.diff));
    track.append(end); track._ticks = row.ticks; track._max = T.max;
    const observer = new ResizeObserver(() => placeTicks(track)); observer.observe(track); tickObservers.push(observer);
    line.append(sideBadge(row.side), track); rows.append(line);
  }
  const axis = el('div', 'tl-axis');
  for (let g = 0; g <= T.max; g += T.step) { const s = el('span', '', g ? `${g} ms` : '0'); s.style.left = pct(g); if (g === T.max) s.style.transform = 'translateX(-100%)'; axis.append(s); }
  box.append(rows, axis); return box;
}
// Tick labels in lanes, so they never overlap; they need the real width, so after layout and again on every resize.
function placeTicks(track) {
  const w = track.getBoundingClientRect().width;
  if (!w || track._width === w) return;
  track._width = w; track.querySelectorAll('.tl-lab').forEach(n => n.remove());
  const lanes = [];
  for (const t of track._ticks || []) {
    const lab = el('span', 'tl-lab'); lab.append(`${t.name} `, el('b', '', String(t.v))); track.append(lab);
    const width = lab.getBoundingClientRect().width + 6, x = Math.max(0, Math.min((t.v / track._max) * w, w - width));
    let lane = lanes.findIndex(endAt => endAt <= x); if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = x + width; lab.style.left = `${x}px`; lab.style.top = `${27 + lane * 12}px`;
  }
  track.style.height = `${30 + Math.max(1, lanes.length) * 12 + 2}px`;
}
function speedFilm(r, muted = 'what each server shows while the page loads, captured during a real load, cache off') {
  const box = el('div', 'box fs');
  box.append(secHead('Filmstrip', muted));
  for (const row of r.film) {
    const line = el('div', `fs-row ${row.side === 'hostfile' ? 'h' : 'l'}`), lab = el('div', 'fs-lab'), at = el('span', '');
    at.append('appears at ', el('b', '', row.appears)); lab.append(sideBadge(row.side), at);
    const frames = el('div', 'fs-frames'); let first = false;
    for (const f of row.frames) {
      const fig = document.createElement('figure'), isFirst = !first && !f.blank;
      if (isFirst) { first = true; fig.className = 'first'; }
      if (f.src) { const img = document.createElement('img'); img.src = f.src; img.alt = `${row.side === 'hostfile' ? 'Hostfile' : 'Live'} at ${f.label}`; fig.append(img); } else fig.append(el('span', 'fs-none'));
      if (f.blank) fig.append(el('span', 'nothing', 'blank'));
      fig.append(el('figcaption', '', isFirst ? `${f.label}, first` : f.label)); frames.append(fig);
    }
    line.append(lab, frames); box.append(line);
  }
  return box;
}
function speedMetrics(r) {
  const box = el('div', 'box mt'), key = el('span', 'gkey');
  for (const [c, t] of [['good', 'good'], ['ni', 'needs work'], ['poor', 'poor']]) { const s = el('span', ''); s.append(el('i', `qd ${c}`), t); key.append(s); }
  box.title = 'Google thresholds: first byte good up to 800 ms, poor above 1800 ms; first paint 1800 and 3000 ms; largest paint 2500 and 4000 ms.';
  box.append(secHead('Measurements', 'Google thresholds', key));
  const cell = (v, spread, q) => { const s = el('span', 'v'); s.append(el('i', `qd ${q || 'none'}`), v); if (spread) s.append(el('span', 'spr', spread)); return s; };
  const t = table(['Metric', 'Hostfile', 'Live', 'Difference'], r.metrics.map(m => [el('span', 'metric', m.label), cell(m.hostfile, m.hostfileSpread, m.hostfileQuality), cell(m.live, m.liveSpread, m.liveQuality), el('span', `dif ${m.tone}`, m.diff)]));
  const cols = document.createElement('colgroup'); for (const w of ['27%', '29%', '29%', '15%']) { const c = document.createElement('col'); c.style.width = w; cols.append(c); }
  t.prepend(cols); box.append(t); return box;
}
function speedWhy(r) {
  const worse = r.verdict.tone === 'worse', box = el('div', `box why${r.why.length ? '' : ' none'}`);
  box.append(secHead(worse ? 'Why slower' : 'Worth checking', 'per cause, new server against Live'));
  if (!r.why.length) { box.append(el('p', 'why-none', 'Compression, page cache and first byte are like Live.')); return box; }
  for (const w of r.why) {
    const row = el('div', 'why-row'), head = el('div', 'head'), vals = el('div', 'vals'), h = el('span', ''), l = el('span', ''), fix = el('div', 'fixl');
    h.append(sideTag('hostfile'), el('span', 'bad', w.hostfile)); l.append(sideTag('live'), w.live); vals.append(h, l);
    head.append(el('b', '', w.title), vals); fix.append(el('i', '', 'Fix: '), w.fix);
    row.append(icon('alert'), head, el('span', ''), fix); box.append(row);
  }
  return box;
}

/* Checks */
let checksShowPassed = false;
function checksPanel(ck) {
  const alone = Boolean(noLive()), wrap = el('div', `ck2${alone ? ' solo' : ''}`);
  if (alone) wrap.append(liveBanner('checked', 'Check Live too'));
  if (!ck || ck.status === 'idle') { wrap.append(el('p', 'dempty', 'The checks run after the comparison. Use Compare again to run them.')); return wrap; }
  if (ck.status === 'running') { wrap.append(waitState(alone ? 'Checking the new server' : 'Checking both servers', alone ? 'Search engines, old addresses in the page and standard addresses, asked of the new server.' : 'Search engines, old addresses in the page and standard addresses, asked of both servers.')); return wrap; }
  if (ck.status === 'error' || !ck.report) { const n = el('div', 'dstate small'); n.append(el('h2', '', 'The checks could not run'), el('code', '', ck.error || 'No result.')); wrap.append(n); return wrap; }
  const r = ck.report, c = r.counts, sum = el('div', 'box cs'), n = el('div', ''), big = el('div', 'cs-n');
  big.append(el('span', c.problems ? 'bad' : 'ok', c.problems ? `${c.problems} problem${c.problems === 1 ? '' : 's'}` : 'No problems'));
  if (c.differ) big.append(el('span', 'sep'), el('span', 'warn', r.solo ? `${c.differ} warning${c.differ === 1 ? '' : 's'}` : `${c.differ} differ${c.differ === 1 ? 's' : ''}`));
  big.append(el('span', 'sep'), el('span', 'ok', `${c.passed} passed`));
  if (r.solo && c.needLive) big.append(el('span', 'sep'), el('span', 'need', `${c.needLive} need Live`));
  n.append(big, el('div', 'cs-sub', r.solo ? `${c.total} checks on the new server alone, judged on what a good server gives` : `${c.total} checks on both servers, compared with Live`));
  const chips = el('div', 'cs-chips');
  for (const g of r.groups) {
    const chip = el('button', `cchip${g.items.every(i => i.tone !== 'worse') ? ' differs' : ''}`); chip.type = 'button'; chip.append(g.label, el('i', '', String(g.items.length)));
    chip.title = `Go to ${g.label}`; chip.onclick = () => document.getElementById(`ck-${g.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); chips.append(chip);
  }
  sum.append(n, chips); wrap.append(sum);
  for (const g of r.groups) g.items.forEach((item, i) => wrap.append(checkCard(g, item, i)));
  if (r.solo) wrap.append(soloFold(r));
  else if (r.passed.length) wrap.append(passedBox(r.passed));
  return wrap;
}
function checkValue(side, text, bad) { const v = el('span', `vv${bad ? ' bad' : ''}`); v.title = text; v.append(sideTag(side), text); return v; }
// Without Live a card shows what a good server gives next to Hostfile.
function expectedValue(text) { const v = el('span', 'vv aim'); v.title = text; v.append(el('span', 'tag t', 'Expected'), text); return v; }
function checkAction(item) {
  const a = item.action;
  if (!a) return el('span', 'act');
  const b = fbtn(a.label, a.icon, a.title, async () => {
    if (a.kind === 'open') return command('new-tab', a.url);
    const result = await command('checks-copy', { card: item.id }); if (result.ok && result.notice) toast(result.notice);
  });
  b.classList.add('act'); return b;
}
function checkCard(g, item, i) {
  const card = el('div', `pc${item.tone === 'worse' ? '' : ' differs'}`), tt = el('span', 'tt'), vals = el('div', 'vals'), fix = el('div', 'fixl');
  if (!i) card.id = `ck-${g.id}`;
  tt.append(el('span', 'cat', g.label), item.title);
  vals.append(checkValue('hostfile', item.hostfile, true), item.expected !== undefined ? expectedValue(item.expected) : checkValue('live', item.live, false));
  fix.append(el('i', '', 'How to fix: '), ...item.fix.map(x => (typeof x === 'string' ? x : el('code', '', x.code))));
  card.append(icon('alert'), tt, checkAction(item), vals, fix);
  if (item.commands?.length) {
    const cmds = el('div', 'cmds');
    item.commands.forEach((c, n) => {
      const row = el('div', 'cmd'), found = el('div', 'found', c.found); found.append(el('span', '', c.where)); row.append(found);
      if (c.command) {
        row.append(fbtn('Copy', 'copy', 'Copy this command', async () => { const result = await command('checks-copy', { card: item.id, command: n }); if (result.ok && result.notice) toast(result.notice); }), el('code', '', c.command));
      } else row.classList.add('plain');
      cmds.append(row);
    });
    card.append(cmds);
  }
  return card;
}
// Without Live: what passed (folded, Show lists it) and what waits for Live.
function soloFold(r) {
  const box = el('div', `box cpass nl-fold${checksShowPassed ? ' open' : ''}`), line = el('div', 'cpass-line'), need = el('div', 'cpass-line need');
  const show = fbtn(checksShowPassed ? 'Hide' : 'Show', 'chevron', checksShowPassed ? 'Hide the checks that passed' : 'Show the checks that passed', () => { checksShowPassed = !checksShowPassed; diffKey = ''; renderDifferences(state.tabs.find(t => t.id === state.activeId), currentView()); });
  show.setAttribute('aria-expanded', String(checksShowPassed));
  line.append(icon('check'), el('b', '', `${r.passed.length} passed`), el('span', 'names', r.passed.map(p => p.name).join(', ')), show);
  box.append(line);
  if (checksShowPassed) { const t = table(['Check', 'Hostfile', 'Expected'], r.passed.map(p => [p.name, p.hostfile, p.expected])); t.className = 'cpass-list'; box.append(t); }
  if (r.needLive.length) {
    need.append(icon('globe'), el('b', '', `${r.needLive.length} need Live`), el('span', 'names', r.needLive.map(x => `${x.name} (${x.why})`).join(', ')), el('span', 'when', 'they run when Live answers'));
    box.append(need);
  }
  return box;
}
function passedBox(passed) {
  const box = el('div', `box cpass${checksShowPassed ? ' open' : ''}`), line = el('div', 'cpass-line');
  const show = fbtn(checksShowPassed ? 'Hide' : 'Show', 'chevron', checksShowPassed ? 'Hide the checks that passed' : 'Show the checks that passed', () => { checksShowPassed = !checksShowPassed; diffKey = ''; renderDifferences(state.tabs.find(t => t.id === state.activeId), currentView()); });
  show.setAttribute('aria-expanded', String(checksShowPassed));
  line.append(icon('check'), el('b', '', `${passed.length} check${passed.length === 1 ? '' : 's'} passed, the same on both servers`), el('span', 'names', passed.map(p => p.name).join(', ')), show);
  box.append(line);
  if (checksShowPassed) { const t = table(['Check', 'Hostfile', 'Live'], passed.map(p => [p.name, p.hostfile, p.live])); t.className = 'cpass-list'; box.append(t); }
  return box;
}

/* Add-on panels (1.4): an add-on scans and returns a report; Dioptra draws it like Checks. All text goes in with textContent. */
function addonPanel(a) {
  const wrap = el('div', 'ck2 addon-panel');
  if (!a || a.status === 'idle') { wrap.append(el('p', 'dempty', 'The scan runs after the comparison. Use Compare again to run it.')); return wrap; }
  if (a.status === 'running') { wrap.append(waitState(`${a.name} is scanning`, 'The page, what it loads and what search engines get.')); return wrap; }
  if (a.status === 'error' || !a.report) { const n = el('div', 'dstate small'); n.append(el('h2', '', 'The scan could not run'), el('code', '', a.error || 'No result.')); wrap.append(n); return wrap; }
  const r = a.report, sum = el('div', 'box cs'), n = el('div', ''), big = el('div', 'cs-n'), chips = el('div', 'cs-chips');
  // Dioptra refused some of its requests (too many to this site in a short time): the scan did not see everything.
  if (a.limited) wrap.append(el('div', 'sec-note limited', 'This scan was cut short: Dioptra stopped asking the site because too many requests went to it in a short time. What is below is what it saw; compare again in a few minutes for the rest.'));
  r.summary.forEach((s, i) => { if (i) big.append(el('span', 'sep')); big.append(el('span', s.tone, s.text)); });
  n.append(big, el('div', 'cs-sub', r.sub));
  r.groups.forEach(g => {
    const chip = el('button', `cchip${g.items.every(i => i.tone !== 'worse') ? ' differs' : ''}`); chip.type = 'button'; chip.append(g.label, el('i', '', String(g.items.length)));
    chip.title = `Go to ${g.label}`; chip.onclick = () => document.getElementById(`ad-${a.id}-${g.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); chips.append(chip);
  });
  sum.append(n, chips); wrap.append(sum);
  const copy = async data => { const result = await command('addon-copy', { addon: a.id, ...data }); if (result.ok && result.notice) toast(result.notice); };
  for (const g of r.groups) g.items.forEach((item, i) => {
    const card = el('div', `pc${item.tone === 'worse' ? '' : ' differs'}`), tt = el('span', 'tt'), vals = el('div', `vals${r.sides.length === 1 ? ' one' : ''}`), fix = el('div', 'fixl');
    if (!i) card.id = `ad-${a.id}-${g.id}`;
    tt.append(el('span', 'cat', g.label), item.title);
    for (const side of r.sides) vals.append(checkValue(side, item.values[side] || 'not found', item.bad[side]));
    const action = item.action ? fbtn(item.action.label, 'copy', 'Copy to the clipboard', () => copy({ card: item.id })) : el('span', 'act');
    action.classList.add('act'); card.append(icon('alert'), tt, action, vals);
    if (item.fix.length) { fix.append(el('i', '', 'How to fix: '), ...item.fix.map(x => (typeof x === 'string' ? x : el('code', '', x.code)))); card.append(fix); }
    if (item.commands.length) {
      const cmds = el('div', 'cmds');
      item.commands.forEach((c, k) => {
        const row = el('div', 'cmd'), found = el('div', 'found', c.found); found.append(el('span', '', c.where)); row.append(found);
        if (c.command) row.append(fbtn('Copy', 'copy', 'Copy this command', () => copy({ card: item.id, command: k })), el('code', '', c.command)); else row.classList.add('plain');
        cmds.append(row);
      });
      card.append(cmds);
    }
    wrap.append(card);
  });
  if (r.passed.length) { const box = el('div', 'box cpass'), line = el('div', 'cpass-line'); line.append(icon('check'), el('b', '', `${r.passed.length} clean`), el('span', 'names', r.passed.map(p => p.name).join(', '))); box.append(line); wrap.append(box); }
  if (r.note) wrap.append(el('div', 'sec-note', r.note));
  return wrap;
}
