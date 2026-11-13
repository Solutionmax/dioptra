const test = require('node:test');
const assert = require('node:assert/strict');
const { diffParts, diffVerdict } = require('../src/differences-parts.js');

const side = (extra = {}) => ({ ok: true, status: 200, ms: 100, redirects: [], ...extra });
const report = (extra = {}) => ({ url: 'https://shop.example/', hostfile: side(), live: side(), domains: [], headers: [], html: { changedLines: 0 }, findings: [], ...extra });
const state = (extra = {}, rep = {}, diff = {}) => ({ differences: { status: 'done', report: report(rep), liveReason: null, ...diff }, files: null, speed: null, checks: null, addonTabs: [], ...extra });
const by = (model, id) => model.parts.find(p => p.id === id);
const speedDone = (tone, why = [], solo = null) => ({ status: 'done', report: solo || {
  verdict: { tone, title: 'x', factors: [{ label: 'first byte', ratio: '3.3×', tone: tone === 'worse' ? 'worse' : 'same' }, { label: 'fully loaded', ratio: '2.1×', tone }] },
  metrics: [{ key: 'ttfb', hostfile: '663 ms', live: '201 ms' }, { key: 'load', hostfile: '2.4 s', live: '1.1 s' }], why, findings: [{ severity: 'high', text: 'The new server answers much slower.' }] } });
const checksDone = (counts, groups = [], solo = false) => ({ status: 'done', report: { solo, counts: { problems: 0, differ: 0, passed: 0, total: 0, ...counts }, groups, passed: [] } });
const addon = (extra = {}) => ({ id: 'malware-scan', name: 'Malware Scan', by: 'SolutionMAX', label: 'Security', sub: 'malware scan · add-on by SolutionMAX', status: 'done', error: '', ...extra });
const addonReport = (extra = {}) => ({ tone: 'bad', counts: { problems: 0, differ: 0, passed: 2, total: 2 }, sub: '2 scans', summary: [], groups: [], passed: [{ name: 'a' }, { name: 'b' }], ...extra });
const loaded = { measured: false, measuring: false, alone: [], old: [], counts: { only: 0, both: 0, old: 0 }, findings: [] };
// Everything measured and fine: the base for the cases that must stay green or turn red.
const fine = (extra = {}, rep = {}, diff = {}) => state({ files: { measured: true, counts: { only: 0, both: 0, old: 0 }, findings: [] }, speed: speedDone('same'), checks: checksDone({ passed: 2, total: 2 }), ...extra }, rep, diff);

test('nothing measured yet: six built in parts, no Add-ons group, and the verdict says the result is incomplete', () => {
  const model = diffParts(state());
  assert.deepEqual(model.parts.map(p => p.id), ['domains', 'files', 'html', 'headers', 'speed', 'checks']);
  assert.deepEqual(model.parts.map(p => p.state), ['ok', 'none', 'ok', 'ok', 'none', 'none']);
  assert.deepEqual(model.parts.map(p => p.missing), [false, true, false, false, true, true]);
  assert.deepEqual([...new Set(model.parts.map(p => p.group))], ['The page', 'The server']);
  const v = diffVerdict(model);
  assert.deepEqual([v.tone, v.title], ['', 'The result is incomplete']);
  assert.equal(v.text, 'No result for: Files, Speed, Checks. Nothing to fix in the parts that have a result.');
  assert.deepEqual(by(model, 'checks').tops, ['Use Compare again to run it once more'], 'a part without a result says how to get one');
});

test('review 2: a failed scan, a failed measurement or a part that never ran is never a green verdict', () => {
  for (const [name, extra] of [['speed error', { speed: { status: 'error', error: 'The measurement was stopped.' } }], ['checks idle', { checks: { status: 'idle' } }], ['files unknown', { files: null }],
    ['add-on failed', { addonTabs: [addon({ status: 'error', error: 'The scan took too long and was stopped.', report: null })] }], ['add-on idle', { addonTabs: [addon({ status: 'idle', report: null })] }]]) {
    const v = diffVerdict(diffParts(fine(extra)));
    assert.deepEqual([v.tone, v.title], ['', 'The result is incomplete'], name);
  }
  const failed = by(diffParts(fine({ addonTabs: [addon({ status: 'error', error: 'The scan took too long and was stopped.', report: null })] })), 'addon:malware-scan');
  assert.deepEqual([failed.state, failed.missing, failed.tag, failed.line, failed.tops], ['none', true, 'No result', 'The scan took too long and was stopped.', ['Use Compare again to run it once more']]);
  assert.equal(diffVerdict(diffParts(fine())).tone, 'better', 'everything measured and fine is green');
  // With something to fix it stays red, and still names what has no result.
  const both = diffVerdict(diffParts(fine({ speed: null, checks: checksDone({ problems: 1, passed: 1, total: 2 }, [{ id: 'a', label: 'A', items: [{ tone: 'worse', title: 'noindex' }] }]) })));
  assert.deepEqual([both.tone, both.text], ['worse', '1 part needs a fix on the new server first: Checks. No result for: Speed.']);
});

test('review 1: a script or frame from another site only on the new server is red, an image or a font stays amber', () => {
  const d = (host, types, extra = {}) => ({ host, hostfile: true, live: false, types, firstParty: false, ...extra });
  const quiet = by(diffParts(fine({}, { domains: [d('img.example', ['image']), d('fonts.example', ['font'])] })), 'domains');
  assert.deepEqual([quiet.state, quiet.tag, quiet.line], ['check', '2 new', 'Only the new server loads from these']);
  assert.deepEqual(quiet.tops, ['img.example, image', 'fonts.example, font']);
  const model = diffParts(fine({}, { domains: [d('img.example', ['image']), d('cdn-jquery.example', ['script'])], findings: [{ severity: 'high', text: 'Script from cdn-jquery.example loads only on Hostfile (not on Live).' }] }));
  const loud = by(model, 'domains');
  assert.deepEqual([loud.state, loud.tag, loud.line], ['fix', '2 new', '1 script or frame from another site only on the new server']);
  assert.deepEqual(loud.all, [{ text: 'cdn-jquery.example, script', state: 'fix' }, { text: 'img.example, image', state: 'check' }], 'the script leads');
  assert.deepEqual(model.rest, [], 'the finding is covered by the part');
  const v = diffVerdict(model);
  assert.deepEqual([v.tone, v.title, v.text], ['worse', 'Not ready for the switch', '1 part needs a fix on the new server first: External domains.']);
  assert.equal(by(diffParts(fine({}, { domains: [d('ads.example', ['frame'])] })), 'domains').state, 'fix', 'a frame as well');
  // Not red: a script of the site itself, a script that is on Live too, a script that only Live loads.
  assert.equal(by(diffParts(fine({}, { domains: [d('static.shop.example', ['script'], { firstParty: true })] })), 'domains').state, 'check');
  assert.equal(by(diffParts(fine({}, { domains: [d('cdn.example', ['script'], { live: true })] })), 'domains').state, 'ok');
  const gone = by(diffParts(fine({}, { domains: [d('cdn.example', ['script'], { hostfile: false, live: true }), d('img.example', ['image'])] })), 'domains');
  assert.deepEqual([gone.state, gone.tag, gone.tops[0]], ['check', '2 differ', 'img.example, image, only on Hostfile']);
});

test('files: failed only on Hostfile needs a fix, on both servers is only to read, and without Live the tab says what failed on the new server', () => {
  const files = { measured: true, measuring: false, counts: { only: 5, both: 1, old: 2 }, findings: [{ severity: 'high', title: 'Stylesheet theme.css fails on Hostfile (404) but loads on Live.' }, { severity: 'both', title: 'Script front.js fails on both servers (404).' }] };
  const p = by(diffParts(state({ files })), 'files');
  assert.deepEqual([p.state, p.tag, p.line], ['fix', '5 failed', 'Only on Hostfile · 2 from old server · 1 on both']);
  assert.deepEqual(p.tops, ['Stylesheet theme.css fails on Hostfile (404) but loads on Live']);
  assert.deepEqual(by(diffParts(state({ files: { measured: true, counts: { only: 0, both: 2, old: 0 }, findings: [] } })), 'files').state, 'info');
  assert.deepEqual(by(diffParts(state({ files: { measured: true, counts: { only: 0, both: 0, old: 0 }, findings: [] } })), 'files').state, 'ok');
  const measuring = by(diffParts(state({ files: { ...loaded, measuring: true } })), 'files');
  assert.deepEqual([measuring.state, measuring.tag, measuring.busy], ['none', 'Measuring…', true]);
  // Live not loaded for this page: the server bar and the part say the same.
  const alone = by(diffParts(state({ files: { ...loaded, alone: [{ name: 'style.css', hostfile: { status: '404 Not Found' } }, { name: 'app.js', hostfile: { status: '403 Forbidden' } }] } })), 'files');
  assert.deepEqual([alone.state, alone.tag, alone.line, alone.missing], ['check', '2 failed', 'New server only, open Compare to check them on Live', false]);
  assert.deepEqual(alone.tops, ['style.css 404 Not Found', 'app.js 403 Forbidden']);
  const clean = by(diffParts(state({ files: loaded })), 'files');
  assert.deepEqual([clean.state, clean.tag, clean.line], ['ok', 'All loaded', 'On the new server; open Compare to measure Live']);
});

test('HTML and headers are shown, not judged, unless the status, the redirects or a hidden script differ', () => {
  const quiet = diffParts(state({}, { html: { changedLines: 25 }, headers: [{ name: 'server' }, { name: 'vary' }], findings: [{ severity: 'info', text: 'Server software differs: Hostfile nginx, Live Apache.' }] }));
  assert.deepEqual([by(quiet, 'html').state, by(quiet, 'html').tag, by(quiet, 'headers').state, by(quiet, 'headers').tag], ['info', '25 lines', 'info', '2 differ']);
  assert.deepEqual(quiet.rest, []);
  const loud = diffParts(state({}, { findings: [{ severity: 'high', text: 'HTTP status differs: Hostfile 500, Live 200.' }, { severity: 'medium', text: 'Redirects differ: Hostfile none, Live https://shop.example/nl/.' }, { severity: 'high', text: 'Inline script that looks obfuscated appears only on Hostfile: eval(…' }] }));
  assert.deepEqual([by(loud, 'headers').state, by(loud, 'headers').tag], ['fix', 'Status differs']);
  assert.deepEqual(by(loud, 'headers').tops, ['HTTP status differs: Hostfile 500, Live 200', 'Redirects differ: Hostfile none, Live https://shop.example/nl/']);
  assert.deepEqual(by(loud, 'headers').all.map(p => p.state), ['fix', 'check']);
  assert.equal(by(loud, 'html').state, 'fix');
  assert.deepEqual(loud.rest, []);
  assert.match(diffVerdict(loud).text, /^2 parts need a fix on the new server first: HTML, Headers\./);
});

test('speed: slower needs a fix with the causes, a cause without being slower is a check, running is busy', () => {
  const slow = by(diffParts(state({ speed: speedDone('worse', [{ title: 'Page cache is off' }, { title: 'Compression is off' }]) })), 'speed');
  assert.deepEqual([slow.state, slow.tag, slow.line], ['fix', '3.3× slower', 'First byte after 663 ms, Live after 201 ms']);
  assert.deepEqual(slow.tops, ['Page cache is off', 'Compression is off']);
  assert.deepEqual(by(diffParts(state({ speed: speedDone('worse') })), 'speed').tops, ['The new server answers much slower']);
  assert.deepEqual(by(diffParts(state({ speed: speedDone('same', [{ title: 'Compression is off' }]) })), 'speed').state, 'check');
  assert.deepEqual(by(diffParts(state({ speed: speedDone('better') })), 'speed').tag, '2.1× faster');
  const loads = speedDone('worse'); loads.report.verdict.factors[0].tone = 'same';
  assert.deepEqual([by(diffParts(state({ speed: loads })), 'speed').tag, by(diffParts(state({ speed: loads })), 'speed').line], ['2.1× slower', 'Fully loaded after 2.4 s, Live after 1.1 s']);
  const running = diffParts(fine({ speed: { status: 'running', progress: { done: 2, total: 6 } } }));
  assert.equal(by(running, 'speed').busy, true);
  assert.deepEqual([diffVerdict(running).tone, diffVerdict(running).title], ['', 'Still measuring']);
  assert.deepEqual(by(diffParts(state({ speed: { status: 'error', error: 'The measurement was stopped.' } })), 'speed').line, 'The measurement was stopped.');
  const solo = { solo: true, verdict: { tone: 'ni', title: 'x', factors: [{ label: 'first byte', value: '1.2 s' }, { label: 'first paint', value: '1.4 s' }] }, improve: [{ title: 'No page cache header' }] };
  const alone = by(diffParts(state({ speed: speedDone('', [], solo) })), 'speed');
  assert.deepEqual([alone.tag, alone.line], ['Needs work', 'First byte 1.2 s, first paint 1.4 s']);
});

test('checks: problems first in the worst points, differences are a check, all passed is green', () => {
  const groups = [{ id: 'a', label: 'A', items: [{ tone: 'differs', title: 'xmlrpc is open' }, { tone: 'worse', title: 'robots.txt blocks the whole site' }] }, { id: 'b', label: 'B', items: [{ tone: 'worse', title: '4 old addresses in the page' }, { tone: 'worse', title: 'noindex' }] }];
  const p = by(diffParts(state({ checks: checksDone({ problems: 3, differ: 1, passed: 9, total: 13 }, groups) })), 'checks');
  assert.deepEqual([p.state, p.tag, p.line, p.more], ['fix', '3 failed', '3 of 13 checks failed, 9 passed', 1]);
  assert.deepEqual(p.tops, ['robots.txt blocks the whole site', '4 old addresses in the page', 'noindex']);
  assert.deepEqual(p.all.map(x => x.state), ['fix', 'fix', 'fix', 'check']);
  assert.equal(p.all[1].key, '# old addresses in the page', 'the same finding on another page, whatever the count');
  assert.deepEqual(by(diffParts(state({ checks: checksDone({ differ: 1, passed: 12, total: 13 }, [groups[0]], true) })), 'checks').tag, '1 warning');
  const ok = by(diffParts(state({ checks: checksDone({ passed: 13, total: 13 }) })), 'checks');
  assert.deepEqual([ok.state, ok.tag], ['ok', '13 passed']);
});

test('an add-on report decides its own step: threats are a fix, tone warn a check, nothing found is green', () => {
  const groups = [{ id: 'g', label: 'G', items: [{ tone: 'differs', title: 'A warning' }, { tone: 'worse', title: 'A card skimmer loads' }, { tone: 'worse', title: 'A card skimmer loads' }] }];
  const threat = addon({ report: addonReport({ counts: { problems: 1, differ: 1, passed: 6, total: 8 }, summary: [{ text: '1 threat on the new server' }, { text: '1 warning' }, { text: '6 scans clean' }], groups }) });
  const seo = addon({ id: 'seo-check', name: 'SEO Check', report: addonReport({ tone: 'warn', counts: { problems: 4, differ: 4, passed: 5, total: 13 }, summary: [{ text: '4 cost ranking' }, { text: '4 differ' }], groups }) });
  const other = addon({ id: 'link-check', name: 'Link Check', by: '', scope: 'site', sub: 'broken links · add-on by Someone', report: addonReport() });
  const model = diffParts(state({ addonTabs: [threat, seo, other, addon({ id: 'wp-leak-check', name: 'WP Leak Check', status: 'running', report: null }), addon({ id: 'x', name: 'X', status: 'error', error: 'It broke.', report: null })] }));
  const a = by(model, 'addon:malware-scan'), b = by(model, 'addon:seo-check'), c = by(model, 'addon:link-check');
  assert.deepEqual([a.group, a.addon, a.by, a.what, a.scope], ['Add-ons', 'malware-scan', 'SolutionMAX', 'Spam, card skimmers and hidden redirects', 'page']);
  assert.deepEqual([a.state, a.tag, a.line, a.tops], ['fix', '1 threat', '1 warning · 6 scans clean', ['A card skimmer loads']]);
  assert.deepEqual([b.state, b.tag, b.line], ['check', '4 cost ranking', '4 differ']);
  assert.deepEqual([c.state, c.tag, c.what, c.by, c.scope], ['ok', '2 clean', 'broken links', '', 'site']);
  assert.deepEqual([by(model, 'addon:wp-leak-check').tag, by(model, 'addon:wp-leak-check').busy], ['Scanning…', true]);
  assert.deepEqual([by(model, 'addon:x').state, by(model, 'addon:x').line], ['none', 'It broke.']);
  assert.equal(diffVerdict(model).tone, 'worse');
  const warned = addon({ report: addonReport({ counts: { problems: 0, differ: 1, passed: 6, total: 7 }, summary: [{ text: 'No threats' }, { text: '1 warning' }], groups: [{ id: 'g', label: 'G', items: [groups[0].items[0]] }] }) });
  assert.equal(by(diffParts(state({ addonTabs: [warned] })), 'addon:malware-scan').state, 'check');
});

test('review 4: an add-on may be called constructor or toString without breaking the parts', () => {
  for (const id of ['constructor', 'tostring', 'hasownproperty', '__proto__']) {
    const p = by(diffParts(state({ addonTabs: [addon({ id, name: 'Odd', sub: 'odd name · add-on', report: addonReport() })] })), `addon:${id}`);
    assert.deepEqual([p.what, typeof p.what, p.state], ['odd name', 'string', 'ok'], id);
  }
});

test('review 11: a scan that Dioptra cut short is not called clean', () => {
  const cut = by(diffParts(fine({ addonTabs: [addon({ limited: true, report: addonReport() })] })), 'addon:malware-scan');
  assert.deepEqual([cut.state, cut.tag, cut.missing], ['none', 'Limited', true]);
  assert.match(cut.line, /^The scan was cut short: too many requests to this site/);
  assert.equal(diffVerdict(diffParts(fine({ addonTabs: [addon({ limited: true, report: addonReport() })] }))).title, 'The result is incomplete');
  const found = by(diffParts(state({ addonTabs: [addon({ limited: true, report: addonReport({ counts: { problems: 1, differ: 0, passed: 1, total: 2 }, summary: [{ text: '1 threat' }], groups: [{ id: 'g', label: 'G', items: [{ tone: 'worse', title: 'A card skimmer loads' }] }] }) })] })), 'addon:malware-scan');
  assert.deepEqual([found.state, found.tops], ['fix', ['A card skimmer loads', 'The scan was cut short: too many requests to this site in a short time']]);
});

test('the verdict: red with the parts to fix, green when nothing needs a fix, a failed request stays visible', () => {
  const bad = diffVerdict(diffParts(fine({ checks: checksDone({ problems: 1, passed: 1, total: 2 }, [{ id: 'a', label: 'A', items: [{ tone: 'worse', title: 'noindex' }] }]) })));
  assert.deepEqual([bad.tone, bad.title, bad.text], ['worse', 'Not ready for the switch', '1 part needs a fix on the new server first: Checks.']);
  const calm = diffVerdict(diffParts(fine({}, { domains: [{ host: 'new.example', hostfile: true, live: false, types: ['image'] }] })));
  assert.deepEqual([calm.tone, calm.title, calm.text], ['better', 'Nothing to fix before the switch', 'Worth a look once: External domains.']);
  assert.equal(diffVerdict(diffParts(fine())).text, 'Every part is fine.');
  const failed = diffVerdict(diffParts(fine({}, { live: { ok: false, error: 'certificate has expired' }, findings: [{ severity: 'high', text: 'The Live request failed: certificate has expired.' }] })));
  assert.deepEqual([failed.tone, failed.text, failed.notes], ['worse', 'The Live request failed: certificate has expired.', []]);
});

test('Live has no page: the page parts are not compared, which is no missing result; the reason is a note under the verdict', () => {
  const reason = { kind: 'dns', short: 'no DNS record', text: 'Live could not be reached: shop.example has no DNS record.' };
  const findings = [{ severity: 'info', calm: true, text: reason.text, detail: 'Speed and Checks judged the new server on its own.' }];
  const model = diffParts(state({ speed: speedDone('', [], { solo: true, verdict: { tone: 'good', title: 'x', factors: [] }, improve: [] }), checks: checksDone({ passed: 8, total: 10, needLive: 2 }, [], true) },
    { domains: [{ host: 'a.example', hostfile: true, live: false, types: [] }], findings }, { liveReason: reason }));
  assert.deepEqual(['domains', 'files', 'html', 'headers'].map(id => [by(model, id).state, by(model, id).missing]), [['none', false], ['none', false], ['none', false], ['none', false]]);
  assert.deepEqual([by(model, 'domains').tag, by(model, 'html').tag], ['1 on Hostfile', 'Not compared']);
  assert.equal(by(model, 'speed').what, 'The new server on its own');
  assert.equal(by(model, 'checks').line, '10 checks, no problems, 2 need Live');
  const v = diffVerdict(model);
  assert.deepEqual([v.tone, v.text], ['better', 'Every part is fine.']);
  assert.deepEqual(v.notes, ['Live could not be reached: shop.example has no DNS record. Speed and Checks judged the new server on its own.']);
});

test('review 19: a report that checked nothing, or whose first words are a warning, is never called clean', () => {
  // counts.total 0: the add-on could not read anything, and says so only in its summary.
  const nothing = by(diffParts(fine({ addonTabs: [addon({ report: addonReport({ counts: { problems: 0, differ: 0, passed: 0, total: 0 }, summary: [{ tone: 'ok', text: 'Nothing checked' }], sub: 'The site could not be asked.', passed: [] }) })] })), 'addon:malware-scan');
  assert.deepEqual([nothing.state, nothing.tag, nothing.line, nothing.tops], ['check', 'Nothing checked', 'The site could not be asked.', ['Nothing checked']]);
  const silent = by(diffParts(fine({ addonTabs: [addon({ report: addonReport({ counts: { problems: 0, differ: 0, passed: 0, total: 0 }, summary: [], sub: '', passed: [] }) })] })), 'addon:malware-scan');
  assert.deepEqual([silent.state, silent.tag, silent.line], ['check', 'Nothing checked', 'The add-on reported no checks']);
  // Problems and differences are 0, but its first summary entry is a warning: most checks could not be read.
  for (const tone of ['warn', 'bad']) {
    const p = by(diffParts(fine({ addonTabs: [addon({ report: addonReport({ counts: { problems: 0, differ: 0, passed: 2, total: 15 }, summary: [{ tone, text: '13 could not be read' }, { tone: 'ok', text: '2 closed' }] }) })] })), 'addon:malware-scan');
    assert.deepEqual([p.state, p.tag, p.line, p.tops], ['check', '13 could not be read', '2 closed', ['13 could not be read']], tone);
  }
  assert.equal(diffVerdict(diffParts(fine({ addonTabs: [addon({ report: addonReport({ counts: { problems: 0, differ: 0, passed: 0, total: 0 }, summary: [] }) })] }))).text, 'Worth a look once: Malware Scan.');
  // A report that did check and found nothing stays green.
  assert.equal(by(diffParts(fine({ addonTabs: [addon({ report: addonReport({ summary: [{ tone: 'ok', text: 'No threats' }] }) })] })), 'addon:malware-scan').state, 'ok');
});
