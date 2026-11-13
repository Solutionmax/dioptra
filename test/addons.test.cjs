const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAddons, parseCode, makeCode, verifyManifest, cleanManifest, cleanReport, reportLines, compareVersions, ADDON_PUBLIC_KEY } = require('../src/addons.cjs');

const BASE = 'https://addons.example/malware-scan/', TOKEN = 'tok_0123456789abcdef';
const keys = () => { const pair = crypto.generateKeyPairSync('ed25519'); return { ...pair, pub: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }; };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const CODE_V1 = "module.exports = { api: 1, scan: async ctx => ({ label: 'Malware', counts: { problems: 1, differ: 0, passed: 2, total: 3 }, summary: [{ tone: 'bad', text: '1 threat' }], groups: [{ id: 'script', label: 'Injected script', items: [{ title: 'v1 ' + ctx.data.version, tone: 'worse', values: { hostfile: 'x', live: 'y' }, bad: { hostfile: true } }] }], passed: [{ name: 'miner' }], findings: [{ text: 'Malware found.', severity: 'high' }], note: 'n' }) };";

// A feed in memory: the files of one release, signed with the test key, behind a bearer token.
function feed(pair, { version = '1.0.0', code = CODE_V1, data = { version: '2026-11-11', domains: {} }, minDioptra = '1.4.0', id = 'malware-scan' } = {}) {
  const codeBytes = Buffer.from(code), dataBytes = Buffer.from(JSON.stringify(data));
  const manifest = Buffer.from(JSON.stringify({ format: 1, id, name: 'Malware Scan', by: 'SolutionMAX', version, minDioptra, tab: { label: 'Security', sub: 'malware scan' }, adds: ['A Security tab'], may: ['Read the pages you open'],
    code: { file: 'main.cjs', sha256: sha(codeBytes), size: codeBytes.length }, data: { file: 'threats.json', sha256: sha(dataBytes), size: dataBytes.length, version: data.version, rules: 3 } }));
  return { 'addon.json': manifest, 'addon.json.sig': Buffer.from(crypto.sign(null, manifest, pair.privateKey).toString('base64')), 'main.cjs': codeBytes, 'threats.json': dataBytes };
}
function server(files) {
  const state = { files, asked: [] };
  state.fetch = async (url, options) => {
    state.asked.push({ url, auth: options.headers.Authorization, redirect: options.redirect });
    if (options.headers.Authorization !== `Bearer ${TOKEN}`) return new Response('no', { status: 401 });
    const body = state.files[url.slice(BASE.length)];
    return body ? new Response(body) : new Response('missing', { status: 404 });
  };
  return state;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-addons-'));
// Modules are loaded from the file itself, never from a cache: each test sees what is on disk.
const loadFresh = (_file, code) => { const mod = { exports: {} }; new Function('module', 'exports', code.toString('utf8'))(mod, mod.exports); return mod.exports; };
const make = (pair, srv, dir = tmp(), extra = {}) => createAddons({ dir, appVersion: '1.4.0', publicKey: pair.pub, fetchImpl: srv.fetch, load: loadFresh, ...extra });
const pages = { hostfile: { ok: true, status: 200, body: '<html>', headers: {} }, live: { ok: true, status: 200, body: '<html>', headers: {} } };

test('the built-in key is an ed25519 public key', () => {
  assert.equal(crypto.createPublicKey({ key: Buffer.from(ADDON_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType, 'ed25519');
});

test('versions order numerically and a release is newer than its betas', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.4.0-beta.2', '1.4.0'), -1);
  assert.equal(compareVersions('1.4.0-beta.2', '1.4.0-beta.10'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.throws(() => compareVersions('1.0', '1.0.0'), /Not a version/);
});

test('an add-on code gives the feed address and the key, https only', () => {
  assert.deepEqual(parseCode(`  ${makeCode(BASE, TOKEN)}\n`), { url: BASE, token: TOKEN });
  assert.equal(parseCode(makeCode('https://addons.example/x', TOKEN)).url, 'https://addons.example/x/');
  for (const bad of ['', 'hello', 'DIOPTRA-!!!', makeCode('http://addons.example/x/', TOKEN), makeCode('https://user:pw@addons.example/', TOKEN), makeCode('https://addons.example/?a=1', TOKEN), makeCode(BASE, 'short'), makeCode('file:///etc/passwd', TOKEN), makeCode('http://127.0.0.1:8080/x/', TOKEN), makeCode('https://10.0.0.1/x/', TOKEN), makeCode('https://[::1]/x/', TOKEN), makeCode('https://router/x/', TOKEN)])
    assert.throws(() => parseCode(bad), /add-on code|https|host name/, bad);
  assert.equal(parseCode(makeCode('http://127.0.0.1:8080/x/', TOKEN), { allowLocal: true }).url, 'http://127.0.0.1:8080/x/');
  assert.throws(() => parseCode(makeCode('http://10.0.0.5/x/', TOKEN), { allowLocal: true }), /https/);
});

test('a manifest counts only with the right signature over its exact bytes', () => {
  const pair = keys(), other = keys(), files = feed(pair), sig = files['addon.json.sig'].toString();
  assert.equal(verifyManifest(files['addon.json'], sig, pair.pub).id, 'malware-scan');
  const changed = Buffer.from(files['addon.json'].toString().replace('1.0.0', '9.0.0'));
  for (const [bytes, signature, key] of [[changed, sig, pair.pub], [files['addon.json'], sig, other.pub], [files['addon.json'], '', pair.pub], [files['addon.json'], 'AAAA', pair.pub], [files['addon.json'], sig, 'not a key'], [files['addon.json'], sig, ADDON_PUBLIC_KEY]])
    assert.throws(() => verifyManifest(bytes, signature, key), /not signed by SolutionMAX/);
});

test('a signed manifest with bad fields is refused', () => {
  const pair = keys(), sign = value => { const bytes = Buffer.from(JSON.stringify(value)); return [bytes, crypto.sign(null, bytes, pair.privateKey).toString('base64'), pair.pub]; };
  const good = JSON.parse(feed(pair)['addon.json'].toString());
  for (const patch of [{ id: '../evil' }, { id: 'UPPER' }, { version: 'latest' }, { format: 2 }, { code: { ...good.code, file: '../main.cjs' } }, { code: { ...good.code, sha256: 'abc' } }, { data: { ...good.data, file: 'main.cjs' } }, { code: { ...good.code, size: 99999999 } }, { name: '' }])
    assert.throws(() => verifyManifest(...sign({ ...good, ...patch })), /manifest|newer Dioptra/, JSON.stringify(patch));
});

test('install: preview shows the add-on, install stores and starts it, the key stays out of the snapshot', async () => {
  const pair = keys(), srv = server(feed(pair)), dir = tmp(), addons = make(pair, srv, dir);
  const shown = await addons.preview(makeCode(BASE, TOKEN));
  assert.equal(shown.name, 'Malware Scan'); assert.equal(shown.version, '1.0.0'); assert.deepEqual(shown.adds, ['A Security tab']);
  assert.deepEqual(srv.asked.map(a => a.url.slice(BASE.length)), ['addon.json', 'addon.json.sig'], 'no code is fetched before Install');
  assert.ok(srv.asked.every(a => a.redirect === 'error'));
  assert.equal(fs.existsSync(path.join(dir, 'malware-scan')), false);
  assert.equal(await addons.install(), 'malware-scan');
  const snap = addons.snapshot();
  assert.equal(snap.pending, null); assert.equal(snap.installed[0].status, 'active'); assert.equal(snap.installed[0].enabled, true);
  assert.doesNotMatch(JSON.stringify(snap), new RegExp(`${TOKEN}|addons\\.example`));
  assert.deepEqual(addons.active(), [{ id: 'malware-scan', name: 'Malware Scan', by: 'SolutionMAX', scope: 'page', tab: { label: 'Security', sub: 'malware scan' } }]);
  // Windows has no POSIX modes (chmod only sets read only); there the profile folder is private to the user.
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'malware-scan', 'source.json')).mode & 0o077, 0, 'the key file is private');
  const report = await addons.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async () => ({}) });
  assert.equal(report.label, 'Malware'); assert.equal(report.groups[0].items[0].title, 'v1 2026-11-11'); assert.equal(report.groups[0].items[0].id, 'script-0');
});

test('install refuses a wrong key, a changed file, and a newer Dioptra requirement', async () => {
  const pair = keys();
  await assert.rejects(make(pair, server(feed(pair))).preview(makeCode(BASE, 'tok_wrongwrongwrong1')), /does not accept this code/);
  await assert.rejects(make(pair, server(feed(keys()))).preview(makeCode(BASE, TOKEN)), /not signed by SolutionMAX/);
  await assert.rejects(make(pair, server(feed(pair, { minDioptra: '2.0.0' }))).preview(makeCode(BASE, TOKEN)), /needs Dioptra 2\.0\.0/);
  const srv = server(feed(pair)), dir = tmp(), addons = make(pair, srv, dir);
  await addons.preview(makeCode(BASE, TOKEN));
  srv.files['main.cjs'] = Buffer.from(`${CODE_V1}\nprocess.exit(1);`);
  await assert.rejects(addons.install(), /main\.cjs does not match the signed manifest/);
  assert.equal(fs.existsSync(path.join(dir, 'malware-scan')), false);
  assert.deepEqual(addons.snapshot().installed, []);
  await assert.rejects(addons.install(), /Enter an add-on code first/);
});

test('update: new data counts at once, new code after a restart, older or silently changed code is refused', async () => {
  const pair = keys(), srv = server(feed(pair)), dir = tmp(), addons = make(pair, srv, dir);
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  assert.equal((await addons.check('malware-scan')).status, 'current');
  const scan = () => addons.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async () => ({}) }).then(r => r.groups[0].items[0].title);

  srv.files = feed(pair, { data: { version: '2026-11-12', domains: {} } });
  const data = await addons.check('malware-scan');
  assert.equal(data.status, 'updated'); assert.match(data.message, /Threat list 2026-11-12 is in use/);
  assert.equal(await scan(), 'v1 2026-11-12'); assert.equal(addons.snapshot().installed[0].restart, false);

  srv.files = feed(pair, { version: '1.1.0', code: CODE_V1.replace("'v1 '", "'v2 '"), data: { version: '2026-11-13', domains: {} } });
  const code = await addons.check('malware-scan');
  assert.match(code.message, /Version 1\.1\.0 is ready\. Restart Dioptra/);
  assert.equal(addons.snapshot().installed[0].version, '1.1.0'); assert.equal(addons.snapshot().installed[0].restart, true);
  assert.equal(await scan(), 'v1 2026-11-12', 'the running code and its data stay together until the restart');
  const restarted = make(pair, srv, dir); await restarted.loadAll();
  assert.equal((await restarted.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async () => ({}) })).groups[0].items[0].title, 'v2 2026-11-13');

  srv.files = feed(pair, { version: '1.0.0' });
  assert.match((await restarted.check('malware-scan')).message, /older than the installed 1\.1\.0/);
  srv.files = feed(pair, { version: '1.1.0', code: `${CODE_V1}//x`, data: { version: '2026-11-13', domains: {} } });
  assert.match((await restarted.check('malware-scan')).message, /changed the code without a new version/);
  srv.files = feed(pair, { version: '1.2.0', id: 'other-addon' });
  assert.match((await restarted.check('malware-scan')).message, /another add-on/);
  srv.files = feed(keys(), { version: '9.0.0' });
  assert.match((await restarted.check('malware-scan')).message, /not signed by SolutionMAX/);
  assert.equal(restarted.snapshot().installed[0].version, '1.1.0');
});

test('start: every installed add-on is checked again; a changed file on disk does not run', async () => {
  const pair = keys(), srv = server(feed(pair)), dir = tmp(), addons = make(pair, srv, dir);
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  let ran = false;
  fs.writeFileSync(path.join(dir, 'malware-scan', 'main.cjs'), 'globalThis.__addonRan = true; module.exports = { api: 1, scan() {} };');
  const again = make(pair, srv, dir, { load: (file, code) => { ran = true; return loadFresh(file, code); } });
  await again.loadAll();
  assert.equal(ran, false);
  const [entry] = again.snapshot().installed;
  assert.equal(entry.status, 'error'); assert.match(entry.message, /main\.cjs does not match the signed manifest/); assert.equal(entry.name, 'Malware Scan');
  assert.deepEqual(again.active(), []);
  await assert.rejects(again.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async () => ({}) }), /not active/);
  // A folder that was never an add-on, and another key: listed as broken, removable, never run.
  fs.mkdirSync(path.join(dir, 'stray')); fs.writeFileSync(path.join(dir, 'stray', 'main.cjs'), 'throw new Error("ran")');
  const third = make(keys(), srv, dir, { load: () => { ran = true; return {}; } }); await third.loadAll();
  assert.equal(ran, false); assert.deepEqual(third.snapshot().installed.map(e => e.status), ['error', 'error']);
  await third.remove('stray'); await third.remove('malware-scan');
  assert.deepEqual(fs.readdirSync(dir), []);
  await assert.rejects(third.remove('../x'), /not installed/);
});

test('turning an add-on off stops its scans and survives a restart', async () => {
  const pair = keys(), srv = server(feed(pair)), dir = tmp(), addons = make(pair, srv, dir);
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  await addons.setEnabled('malware-scan', false);
  assert.deepEqual(addons.active(), []);
  const again = make(pair, srv, dir); await again.loadAll();
  assert.equal(again.snapshot().installed[0].enabled, false); assert.deepEqual(again.active(), []);
  await again.setEnabled('malware-scan', true); assert.equal(again.active().length, 1);
});

test('scan: the add-on may only ask the site itself, 30 times per server, and a failing add-on never breaks Dioptra', async () => {
  const pair = keys(), dir = tmp();
  const code = "module.exports = { api: 1, scan: async ctx => { const out = []; for (const [side, target, opts] of ctx.data.asks) { try { const r = await ctx.fetch(side, target, opts); out.push(r.seen); } catch (e) { out.push('ERR ' + e.message); } } if (ctx.data.throws) throw new Error('boom'); return { counts: { problems: 0, passed: 1, total: 1 }, label: 'Malware', passed: out.map(name => ({ name })) }; } };";
  const asks = [['hostfile', 'https://www.shop.example/a', { userAgent: 'Googlebot\r\nX-Evil: 1', referer: 'https://www.google.com/' }], ['live', 'https://shop.example/b'], ['hostfile', 'https://evil.example/'], ['hostfile', 'file:///etc/passwd'], ['other', 'https://shop.example/'], ['hostfile', 'https://user:pw@shop.example/'], ['hostfile', 'https://shop.example:8443/admin'], ['hostfile', 'http://shop.example/']];
  const srv = server(feed(pair, { code, data: { version: '1', asks } })), addons = make(pair, srv, dir);
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  const seen = [];
  const report = await addons.scan('malware-scan', { url: 'https://www.shop.example/page', pages, fetchPage: async (side, target, headers) => { seen.push([side, target, headers]); return { seen: `${side} ${target}` }; } });
  assert.deepEqual(seen, [['hostfile', 'https://www.shop.example/a', { 'User-Agent': 'Googlebot X-Evil: 1', Referer: 'https://www.google.com/' }], ['live', 'https://shop.example/b', {}]]);
  assert.deepEqual(report.passed.map(p => p.name), ['hostfile https://www.shop.example/a', 'live https://shop.example/b', 'ERR An add-on may only ask the site itself.', 'ERR An add-on may only ask the site itself.', 'ERR That side was not scanned.', 'ERR An add-on may only ask the site itself.', 'ERR An add-on may only ask the site itself.', 'ERR An add-on may only ask the site itself.']);
  assert.equal(report.label, '', 'no label without threats');
  // One side only: the other side cannot be asked.
  const one = await addons.scan('malware-scan', { url: 'https://shop.example/', pages: { live: pages.live }, fetchPage: async side => ({ seen: side }) });
  assert.deepEqual(one.sides, ['live']); assert.equal(one.passed[0].name, 'ERR That side was not scanned.');

  srv.files = feed(pair, { version: '1.0.0', code, data: { version: '2', asks: [...Array.from({ length: 32 }, () => ['hostfile', 'https://shop.example/']), ...Array.from({ length: 31 }, () => ['live', 'https://shop.example/']), ['other', 'https://shop.example/']] } });
  await addons.check('malware-scan');
  // Request 31 for a server is refused; what the new server used does not count for Live. The report keeps 40 names, so count what was fetched.
  const fetched = { hostfile: 0, live: 0 }, refused = [];
  const many = await addons.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async side => { fetched[side]++; return { seen: `${side} ${fetched[side]}` }; } });
  assert.deepEqual(fetched, { hostfile: 30, live: 30 });
  many.passed.forEach((p, i) => { if (p.name.startsWith('ERR')) refused.push([i + 1, p.name]); });
  assert.deepEqual(many.passed.slice(28, 33).map(p => p.name), ['hostfile 29', 'hostfile 30', 'ERR Too many requests for one scan.', 'ERR Too many requests for one scan.', 'live 1']);
  assert.deepEqual(refused, [[31, 'ERR Too many requests for one scan.'], [32, 'ERR Too many requests for one scan.']], 'of the 40 names the report keeps');
  srv.files = feed(pair, { version: '1.0.0', code, data: { version: '3', asks: [], throws: true } });
  await addons.check('malware-scan');
  await assert.rejects(addons.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async () => ({}) }), /boom/);
});

test('a report is cut to shape: capped strings, no control characters, only the scanned sides', () => {
  const long = 'x'.repeat(5000);
  const report = cleanReport({ label: `Mal\u0000ware${long}`, counts: { problems: 2, differ: -1, passed: 'many', total: 1e9 }, sub: `a\nb${long}`, summary: [{ tone: 'evil', text: 't' }, { tone: 'bad', text: '' }],
    groups: [{ id: '../x', label: 'G', items: [{ title: `t\u2028${long}`, tone: 'worse', values: { hostfile: long, live: 'l', other: 'o' }, bad: { hostfile: 1, live: true }, fix: ['plain\u0007', { code: long }, null], commands: [{ found: long, where: 'w', command: `rm\n-rf${long}` }], action: { label: '', text: `line1\nline2${long}` } }, {}] }, { label: '', items: [{}] }, { id: 'empty', label: 'E', items: [] }],
    passed: [{ name: 'p' }, {}, null], findings: [{ text: `f${long}`, severity: 'low', detail: 'd' }, {}], note: long, extra: 'dropped' }, ['hostfile']);
  assert.equal(report.label, 'Mal ware' + 'x'.repeat(8)); assert.deepEqual(report.counts, { problems: 2, differ: 0, passed: 0, total: 0 });
  assert.equal(report.sub.length, 160); assert.ok(report.sub.startsWith('a b'));
  assert.deepEqual(report.summary, [{ tone: 'ok', text: 't' }]);
  assert.equal(report.groups.length, 1); assert.equal(report.groups[0].id, 'g0');
  const [item, empty] = report.groups[0].items;
  assert.equal(item.title.length, 200); assert.deepEqual(Object.keys(item.values), ['hostfile']); assert.equal(item.values.hostfile.length, 160); assert.deepEqual(item.bad, { hostfile: false });
  assert.equal(item.fix[0], 'plain '); assert.equal(item.fix[1].code.length, 160); assert.equal(item.fix[2], '');
  assert.equal(item.commands[0].command.length, 400); assert.doesNotMatch(item.commands[0].command, /\n/);
  assert.equal(item.action.label, 'Copy'); assert.ok(item.action.text.startsWith('line1\nline2')); assert.equal(item.action.text.length, 4000);
  assert.deepEqual([item.id, empty.id, empty.tone, empty.action], ['g0-0', 'g0-1', 'differs', null]);
  assert.deepEqual(report.passed, [{ name: 'p' }]); assert.equal(report.findings, undefined, 'findings is no part of a report any more (1.4.0-beta.4): the cards say it');
  assert.equal(report.note.length, 400); assert.equal(report.extra, undefined);
  assert.throws(() => cleanReport(null, ['live']), /gave no result/);
  assert.deepEqual(reportLines('Malware Scan', report)[0], 'Malware Scan (2 threats, 0 warnings, 0 clean):');
  assert.match(reportLines('Malware Scan', report)[1], /^- \[threat\] G: t x+\. Hostfile x+$/);
  assert.deepEqual(reportLines('x', null), []);
});

test('a second update while old code still runs keeps that code with its own data', async () => {
  const pair = keys(), srv = server(feed(pair)), dir = tmp(), addons = make(pair, srv, dir);
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  const scan = () => addons.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async () => ({}) }).then(r => r.groups[0].items[0].title);
  const v2 = CODE_V1.replace("'v1 '", "'v2 '");
  srv.files = feed(pair, { version: '1.1.0', code: v2, data: { version: 'D2', domains: {} } }); await addons.check('malware-scan');
  srv.files = feed(pair, { version: '1.1.0', code: v2, data: { version: 'D3', domains: {} } });
  assert.match((await addons.check('malware-scan')).message, /Version 1\.1\.0 is ready\. Restart Dioptra/);
  assert.equal(await scan(), 'v1 2026-11-11'); assert.equal(addons.snapshot().installed[0].restart, true);
  // Installing the same pending version again by code changes nothing about what runs.
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  assert.equal(await scan(), 'v1 2026-11-11'); assert.equal(addons.snapshot().installed[0].restart, true);
  // Back to the code that runs: its new data counts at once and no restart is needed.
  const one = make(pair, server(feed(pair)), tmp()); await one.preview(makeCode(BASE, TOKEN)); await one.install();
  assert.equal(one.snapshot().installed[0].restart, false);
  const again = make(pair, srv, dir); await again.loadAll();
  assert.equal((await again.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async () => ({}) })).groups[0].items[0].title, 'v2 D3');
});

test('a stop half way through an update loses nothing: the old set comes back, leftovers go', async () => {
  const pair = keys(), srv = server(feed(pair)), dir = tmp(), addons = make(pair, srv, dir);
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  // As if the app died after the old set stepped aside and before the new one arrived.
  fs.renameSync(path.join(dir, 'malware-scan'), path.join(dir, 'malware-scan.old'));
  fs.mkdirSync(path.join(dir, 'malware-scan.new')); fs.writeFileSync(path.join(dir, 'malware-scan.new', 'main.cjs'), 'half');
  const again = make(pair, srv, dir); await again.loadAll();
  assert.deepEqual(again.snapshot().installed.map(a => [a.id, a.status]), [['malware-scan', 'active']]);
  assert.deepEqual(fs.readdirSync(dir), ['malware-scan']);
  // An .old next to a complete set is only a leftover.
  fs.mkdirSync(path.join(dir, 'malware-scan.old'));
  const third = make(pair, srv, dir); await third.loadAll();
  assert.deepEqual(fs.readdirSync(dir), ['malware-scan']); assert.equal(third.active().length, 1);
  // A normal update leaves no spare folders behind.
  srv.files = feed(pair, { data: { version: 'D2', domains: {} } }); await third.check('malware-scan');
  assert.deepEqual(fs.readdirSync(dir), ['malware-scan']);
});

test('update, remove and switch run one at a time: a removed add-on does not come back', async () => {
  const pair = keys(), srv = server(feed(pair)), dir = tmp(), addons = make(pair, srv, dir);
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  srv.files = feed(pair, { version: '1.1.0', code: `${CODE_V1}//new`, data: { version: 'D2', domains: {} } });
  const [first, second, , gone] = await Promise.all([addons.check('malware-scan'), addons.check('malware-scan'), addons.remove('malware-scan'), addons.check('malware-scan')]);
  assert.equal(first.status, 'updated'); assert.equal(second.status, 'current');
  assert.deepEqual(gone.message, 'That add-on is not installed.');
  assert.deepEqual(fs.readdirSync(dir), []); assert.deepEqual(addons.snapshot().installed, []);
  await assert.rejects(addons.setEnabled('malware-scan', true), /not installed/);
});

test('a scan that never ends is stopped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pair = keys(), srv = server(feed(pair, { code: 'module.exports = { api: 1, scan: () => new Promise(() => {}) };' }));
  const addons = make(pair, srv, tmp(), { fetchImpl: (url, options) => srv.fetch(url, { ...options, signal: undefined }) });
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  const run = addons.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async () => ({}) });
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(30000);
  await assert.rejects(run, /took too long and was stopped/);
});

test('the code that runs is the code that was checked, even if the file changes right after', async () => {
  const pair = keys(), srv = server(feed(pair)), dir = tmp(), addons = make(pair, srv, dir, { load: undefined });
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  // Swap the file between the check and the start: the default loader compiles the checked bytes, never the path.
  const real = fs.promises.readFile, target = path.join(dir, 'malware-scan', 'main.cjs');
  fs.promises.readFile = async (file, ...rest) => { const bytes = await real(file, ...rest); if (file === target) fs.writeFileSync(target, 'module.exports = { api: 1, scan: async () => { globalThis.__swapped = true; return {}; } };'); return bytes; };
  try {
    const again = make(pair, srv, dir, { load: undefined }); await again.loadAll();
    const report = await again.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async () => ({}) });
    assert.equal(report.groups[0].items[0].title, 'v1 2026-11-11'); assert.equal(globalThis.__swapped, undefined);
  } finally { fs.promises.readFile = real; }
});

test('hidden characters never reach the screen or the clipboard', () => {
  // Review 8 of beta.4: also the Arabic letter mark, the Hangul and Mongolian fillers and the tag characters.
  const more = cleanReport({ counts: { problems: 1 }, label: 'M\u061ca\u3164l\u115fw\u1160a\u180er\u{e0001}e\u{e0041}\u{e007f}', sub: 'cl\u{e0020}ean', groups: [{ id: 'g', label: 'G', items: [{ title: 'pay\u{e0070}pal', values: { live: 'x\u3164y' } }] }] }, ['live']);
  assert.deepEqual([more.label, more.sub, more.groups[0].items[0].title, more.groups[0].items[0].values.live], ['Malware', 'clean', 'paypal', 'xy']);
  const report = cleanReport({ counts: { problems: 1 }, label: 'Mal\u200bware', groups: [{ id: 'g', label: 'G', items: [{ title: 'a\u202eb', values: { live: 'x\u2066y' }, fix: ['f\u200fix'], commands: [{ found: 'f', where: 'w', command: 'echo ok \u202e; rm -rf ~ \u202c' }], action: { label: 'Copy', text: 'one\u202e\ntwo\u0085\ufeff' } }] }] }, ['live']);
  const item = report.groups[0].items[0];
  assert.equal(report.label, 'Malware'); assert.equal(item.title, 'ab'); assert.equal(item.values.live, 'xy'); assert.equal(item.fix[0], 'fix');
  assert.equal(item.commands[0].command, 'echo ok ; rm -rf ~'); assert.equal(item.action.text, 'one\ntwo');
});

test('an installed add-on cannot be moved to another feed by a pasted code, and a damaged key file does not load', async () => {
  const pair = keys(), srv = server(feed(pair)), dir = tmp(), addons = make(pair, srv, dir);
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  const other = 'https://elsewhere.example/malware-scan/';
  const moved = make(pair, { fetch: (url, options) => srv.fetch(url.replace(other, BASE), options) }, dir); await moved.loadAll();
  await assert.rejects(moved.preview(makeCode(other, TOKEN)), /already installed from another address\. Remove it first/);
  assert.equal((await moved.check('malware-scan')).status, 'current');
  for (const source of [{ url: 'http://evil.example/x', token: TOKEN }, { url: BASE, token: 'x' }, { url: 'https://10.0.0.1/x/', token: TOKEN }]) {
    fs.writeFileSync(path.join(dir, 'malware-scan', 'source.json'), JSON.stringify(source));
    const again = make(pair, srv, dir); await again.loadAll();
    assert.equal(again.snapshot().installed[0].status, 'error', JSON.stringify(source)); assert.deepEqual(again.active(), []);
  }
});

test('an add-on that is not about threats: orange tone, its own name for the data list, neutral words for Claude', () => {
  const sha = 'a'.repeat(64), base = { format: 1, id: 'seo-check', name: 'SEO Check', version: '1.0.0', minDioptra: '1.4.0', tab: { label: 'SEO' }, code: { file: 'main.cjs', sha256: sha, size: 1 } };
  assert.equal(cleanManifest({ ...base, data: { file: 'rules.json', sha256: sha, size: 1, label: 'Rule set' } }).data.label, 'Rule set');
  assert.equal(cleanManifest({ ...base, data: { file: 'rules.json', sha256: sha, size: 1 } }).data.label, 'Threat list');
  const item = { title: 'No title', tone: 'worse', values: { hostfile: 'none' } }, raw = { label: 'SEO', counts: { problems: 1, total: 1 }, groups: [{ id: 'text', label: 'Title', items: [item] }] };
  assert.equal(cleanReport(raw, ['hostfile']).tone, 'bad');
  assert.equal(cleanReport({ ...raw, tone: 'red' }, ['hostfile']).tone, 'bad');
  const warn = cleanReport({ ...raw, tone: 'warn' }, ['hostfile']);
  assert.equal(warn.tone, 'warn');
  assert.deepEqual(reportLines('SEO Check', warn), ['SEO Check (1 problems, 0 differences, 0 fine):', '- [problem] Title: No title. Hostfile none']);
  assert.match(reportLines('Malware Scan', cleanReport(raw, ['hostfile']))[1], /^- \[threat\] /);
});

test('review 13: on the new server an add-on may only ask the exact host name of the page', async () => {
  const pair = keys();
  const code = "module.exports = { api: 1, scan: async ctx => { const out = []; for (const [side, target] of ctx.data.asks) { try { const r = await ctx.fetch(side, target); out.push(r.seen); } catch (e) { out.push('ERR ' + e.message); } } return { counts: { problems: 0, passed: 1, total: 1 }, passed: out.map(name => ({ name })) }; } };";
  // The rule of the tab is for shop.example: www.shop.example has no rule and would go to Live through DNS, labelled Hostfile.
  const asks = [['hostfile', 'https://shop.example/a'], ['hostfile', 'https://www.shop.example/a'], ['live', 'https://www.shop.example/a'], ['live', 'https://shop.example/a']];
  const srv = server(feed(pair, { code, data: { version: '1', asks } })), addons = make(pair, srv);
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  const seen = [];
  const report = await addons.scan('malware-scan', { url: 'https://shop.example/page', pages, fetchPage: async (side, target) => { seen.push(`${side} ${target}`); return { seen: 'ok' }; } });
  assert.deepEqual(report.passed.map(p => p.name), ['ok', 'ERR The new server may only be asked by its own host name.', 'ok', 'ok']);
  assert.deepEqual(seen, ['hostfile https://shop.example/a', 'live https://www.shop.example/a', 'live https://shop.example/a']);
});

test('review 12: once a scan has ended or timed out, the add-on gets nothing more from fetch', async () => {
  const pair = keys(), sleep = ms => new Promise(r => setTimeout(r, ms));
  // The add-on asks once at once, and again 60 ms later whatever happened; data.hang makes its scan never return.
  const code = "module.exports = { api: 1, scan: ctx => { const late = new Promise(done => setTimeout(() => ctx.fetch('hostfile', ctx.url).then(() => done('answered'), e => done('ERR ' + e.message)), 60)); late.then(text => { ctx.pages.hostfile.late = text; }); const report = { counts: { problems: 0, passed: 1, total: 1 }, passed: [{ name: 'p' }] }; return ctx.fetch('hostfile', ctx.url).then(() => (ctx.data.hang ? new Promise(() => {}) : report)); } };";
  for (const hang of [true, false]) {
    const srv = server(feed(pair, { code, data: { version: '1', hang } })), addons = make(pair, srv, tmp(), { scanTimeoutMs: 25 });
    await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
    const mine = { hostfile: { ok: true, status: 200, body: '', headers: {} } }; let fetched = 0;
    const run = addons.scan('malware-scan', { url: 'https://shop.example/', pages: mine, fetchPage: async () => { fetched++; return {}; } });
    if (hang) await assert.rejects(run, /took too long and was stopped/); else assert.equal((await run).passed[0].name, 'p');
    await sleep(120);
    assert.equal(mine.hostfile.late, 'ERR The scan has ended.', hang ? 'after the timeout' : 'after the scan returned');
    assert.equal(fetched, 1, 'only the request made during the scan reached the site');
  }
});

test('add-on contract 1.4.0-beta.4: scope site in the manifest, rescan in the scan context', async () => {
  const sha = 'a'.repeat(64), base = { format: 1, id: 'wp-leak-check', name: 'WP Leak Check', version: '1.0.0', minDioptra: '1.4.0', tab: { label: 'Leaks' }, code: { file: 'main.cjs', sha256: sha, size: 1 }, data: { file: 'leaks.json', sha256: sha, size: 1 } };
  assert.equal(cleanManifest({ ...base, scope: 'site' }).scope, 'site');
  assert.equal(cleanManifest(base).scope, 'page', 'a manifest from before the field');
  for (const odd of ['SITE', 'all', 1, null, {}]) assert.equal(cleanManifest({ ...base, scope: odd }).scope, 'page', String(odd));
  // rescan: true only when Dioptra says so; an add-on gets a real boolean.
  const pair = keys(), code = "module.exports = { api: 1, scan: async ctx => ({ counts: { problems: 0, passed: 1, total: 1 }, passed: [{ name: typeof ctx.rescan + ' ' + ctx.rescan }] }) };";
  const srv = server(feed(pair, { code })), addons = make(pair, srv);
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  const said = async extra => (await addons.scan('malware-scan', { url: 'https://shop.example/', pages, fetchPage: async () => ({}), ...extra })).passed[0].name;
  assert.equal(await said({ rescan: true }), 'boolean true', 'Compare again, or a whole-site run');
  assert.equal(await said({}), 'boolean false', 'a scan after an ordinary page load');
  assert.equal(await said({ rescan: 'yes' }), 'boolean false');
  assert.equal(addons.active()[0].scope, 'page');
});

test('review 5 of beta.4: a request that waited for its turn is not made once the scan is over', async () => {
  const { createBudget, COMPARE } = require('../src/host-budget.cjs');
  const pair = keys(), sleep = ms => new Promise(r => setTimeout(r, ms)), budget = createBudget();
  // Twelve requests at once and a scan that never returns: four get a place, eight wait. Each request takes 60 ms,
  // the scan is stopped after 25 ms.
  const code = "module.exports = { api: 1, scan: ctx => { ctx.pages.hostfile.asked = Array.from({ length: 12 }, (_, i) => ctx.fetch('hostfile', ctx.url + '?' + i).then(() => 'answered', e => 'ERR ' + e.message)); return new Promise(() => {}); } };";
  const srv = server(feed(pair, { code })), addons = make(pair, srv, tmp(), { scanTimeoutMs: 25 });
  await addons.preview(makeCode(BASE, TOKEN)); await addons.install();
  const mine = { hostfile: { ok: true, status: 200, body: '', headers: {} } }; let started = 0;
  // fetchPage as main.cjs has it: through the lanes of the budget, with the "still wanted" check of the scan.
  const fetchPage = (side, target, _headers, wanted) => budget.ask('shop.example', side, COMPARE, async () => { started++; await sleep(60); return {}; }, wanted);
  await assert.rejects(addons.scan('malware-scan', { url: 'https://shop.example/', pages: mine, fetchPage }), /took too long and was stopped/);
  assert.equal(started, 4, 'four requests were under way when the scan was stopped');
  const answers = await Promise.all(mine.hostfile.asked);
  assert.equal(started, 4, 'none of the eight that waited was started afterwards');
  assert.deepEqual([answers.filter(a => a === 'answered').length, answers.filter(a => a === 'ERR The scan has ended.').length], [4, 8]);
  assert.equal(budget.used('shop.example'), 4, 'and none of them was counted');
});
