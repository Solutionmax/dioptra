const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { validateRules, resolverRules, navigationURL, readSettings, saveSettings } = require('../src/core.cjs');

test('navigation cancellation waits for native loading to stop and cleans listeners', async () => {
  const { cancelNavigation } = require('../src/core.cjs');
  const wc = new EventEmitter(); let loading = true, settled = false;
  Object.assign(wc, { isDestroyed: () => false, isLoading: () => loading, stop() {} });
  const result = cancelNavigation(wc); result.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  wc.emit('did-stop-loading'); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, 'a stale stop event while native loading is true is insufficient');
  loading = false; wc.emit('did-stop-loading'); await result;
  assert.equal(wc.listenerCount('did-stop-loading'), 0); assert.equal(wc.listenerCount('destroyed'), 0);
});
test('navigation cancellation times out rather than permitting an unsafe replacement', async () => {
  const { cancelNavigation } = require('../src/core.cjs'); const wc = new EventEmitter();
  Object.assign(wc, { isDestroyed: () => false, isLoading: () => true, stop() {} });
  await assert.rejects(cancelNavigation(wc, 20), /could not be cancelled/);
  assert.equal(wc.listenerCount('did-stop-loading'), 0); assert.equal(wc.listenerCount('destroyed'), 0);
});
test('navigation cancellation handles destroyed contents without retained listeners', async () => {
  const { cancelNavigation } = require('../src/core.cjs'); const wc = new EventEmitter(); let destroyed = false;
  Object.assign(wc, { isDestroyed: () => destroyed, isLoading: () => true, stop() {} });
  const result = cancelNavigation(wc); destroyed = true; wc.emit('destroyed'); await result;
  assert.equal(wc.listenerCount('did-stop-loading'), 0); assert.equal(wc.listenerCount('destroyed'), 0);
  wc.stop = () => { throw new Error('already destroyed'); }; await cancelNavigation(wc);
});
test('navigation cancellation cleans listeners when the native stop call throws', async () => {
  const { cancelNavigation } = require('../src/core.cjs'); const wc = new EventEmitter();
  Object.assign(wc, { isDestroyed: () => false, isLoading: () => true, stop() { throw new Error('native stop failed'); } });
  await assert.rejects(cancelNavigation(wc), /native stop failed/);
  assert.equal(wc.listenerCount('did-stop-loading'), 0); assert.equal(wc.listenerCount('destroyed'), 0);
});

test('normalizes DNS names and brackets IPv6 without allowing resolver rule injection', () => {
  const rules = validateRules([{ domain: ' EXAMPLE.com. ', ip: '::1', enabled: true }, { domain: 'bücher.de', ip: '127.0.0.1', enabled: false }]);
  assert.deepEqual(rules, [{ domain: 'example.com', ip: '::1', enabled: true, skipSSL: false }, { domain: 'xn--bcher-kva.de', ip: '127.0.0.1', enabled: false, skipSSL: false }]);
  assert.equal(resolverRules(rules), 'MAP example.com [::1]');
  for (const domain of ['x.com, MAP *', '*.com', 'https://x.com', 'x.com/path', '-x.com', 'x..com']) {
    assert.throws(() => validateRules([{ domain, ip: '127.0.0.1' }]));
  }
  for (const ip of ['localhost', '127.0.0.1:80', '127.0.0.1, EXCLUDE *', '999.1.1.1']) {
    assert.throws(() => validateRules([{ domain: 'x.com', ip }]));
  }
  assert.throws(() => validateRules([{ domain: 'x.com', ip: '127.0.0.1' }, { domain: 'X.COM', ip: '::1' }]));
});
test('navigation preserves ports and URLs but rejects privileged schemes', () => {
  assert.equal(navigationURL('example.com/a'), 'https://example.com/a');
  assert.equal(navigationURL('http://localhost:8080/a'), 'http://localhost:8080/a');
  assert.equal(navigationURL('localhost:8080'), 'https://localhost:8080/');
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://settings']) assert.throws(() => navigationURL(value));
});
test('persists rules and tabs atomically and refuses corrupt configuration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migratie-core-'));
  try {
    const file = path.join(dir, 'settings.json');
    const config = readSettings(file);
    config.rules = [{ domain: 'test.invalid', ip: '127.0.0.1', enabled: true, skipSSL: false }];
    config.tabs = ['https://test.invalid/'];
    saveSettings(file, config);
    assert.deepEqual(readSettings(file), config);
    fs.writeFileSync(file, '{bad');
    assert.throws(() => readSettings(file));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('fresh setup resumes while existing profiles skip automatic onboarding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-onboarding-settings-'));
  const file = path.join(dir, 'settings.json');
  try {
    const fresh = readSettings(file);
    assert.equal(fresh.onboardingCompleted, false);
    assert.equal(fresh.onboardingStep, 0);
    saveSettings(file, { ...fresh, onboardingStep: 2, onboardingURL: 'https://setup.invalid/' });
    assert.equal(readSettings(file).onboardingStep, 2);
    assert.equal(readSettings(file).onboardingURL, 'https://setup.invalid/');
    fs.writeFileSync(file, JSON.stringify({rules:[], autoUpdates:false, autoUpdatesChosen:true}));
    assert.equal(readSettings(file).onboardingCompleted, true);
    assert.equal(readSettings(file).autoUpdates, false);
    fs.writeFileSync(file, JSON.stringify({...fresh, onboardingStep:99, onboardingURL:'file:///etc/passwd'}));
    assert.equal(readSettings(file).onboardingStep, 0);
    assert.equal(readSettings(file).onboardingURL, '');
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('DevTools docking leaves separate website, resize handle and inspector areas', () => {
  const { devtoolsLayout } = require('../src/core.cjs');
  const bottom = devtoolsLayout(1200, 900, 0, 'bottom', .4, true);
  assert.equal(bottom.page.x, 0);
  assert.equal(bottom.page.y, 144);
  assert.equal(bottom.page.y + bottom.page.height, bottom.splitter.y);
  assert.equal(bottom.splitter.y + bottom.splitter.height, bottom.bar.y);
  assert.equal(bottom.bar.y + bottom.bar.height, bottom.tools.y);
  assert.equal(bottom.tools.y + bottom.tools.height, 858);
  for (const dock of ['left', 'right']) {
    const layout = devtoolsLayout(960, 640, 460, dock, .7, true);
    assert.ok(layout.page.width >= 200);
    assert.ok(layout.tools.width >= 220);
    assert.equal(layout.tools.width + layout.splitter.width + layout.page.width, 500);
    assert.equal(layout.tools.y, 176);
    if (dock === 'right') assert.equal(layout.page.width + 6, layout.tools.x);
    else assert.equal(layout.tools.width + 6, layout.page.x);
  }
  assert.deepEqual(devtoolsLayout(1200, 900, 0, 'right', .5, false).page, { x: 0, y: 144, width: 1200, height: 714 });
});

test('Compare panes share the width around a 6 px bar and keep at least a quarter each', () => {
  const { compareLayout, compareShare } = require('../src/core.cjs');
  const equal = compareLayout(1280, .5);
  assert.deepEqual(equal, { left: { x: 0, width: 637 }, splitter: { x: 637, width: 6 }, right: { x: 643, width: 637 } });
  for (const [width, ratio] of [[1280, .7], [1281, .25], [500, .75], [999, .333]]) {
    const { left, splitter, right } = compareLayout(width, ratio);
    assert.equal(left.x, 0); assert.equal(left.width, splitter.x); assert.equal(splitter.x + splitter.width, right.x);
    assert.equal(right.x + right.width, width, 'the panes and the bar fill the width exactly');
  }
  assert.ok(compareLayout(1280, .7).left.width > compareLayout(1280, .7).right.width * 2);
  assert.deepEqual(compareLayout(1280, 5), compareLayout(1280, .75), 'a pane can never be dragged away');
  assert.deepEqual(compareLayout(1280, -1), compareLayout(1280, .25));
  assert.deepEqual([.1, .9, .6, NaN, undefined, '0.7'].map(compareShare), [.25, .75, .6, .5, .5, .5]);
});

test('The Compare pane share is restored from settings and repaired when it is out of range', () => {
  const { readSettings, saveSettings } = require('../src/core.cjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-share-')), 'settings.json');
  assert.equal(readSettings(file).compareRatio, .5, 'equal panes on a new profile');
  saveSettings(file, { ...readSettings(file), compareRatio: .68 }); assert.equal(readSettings(file).compareRatio, .68);
  saveSettings(file, { ...readSettings(file), compareRatio: 3 }); assert.equal(readSettings(file).compareRatio, .75);
  fs.writeFileSync(file, JSON.stringify({ rules: [], compareRatio: 'wide' })); assert.equal(readSettings(file).compareRatio, .5);
});

test('updates default to the GitHub feed and automatic checks, unless the user turned them off', () => {
  const { DEFAULT_UPDATE_FEED, ROUTE_BAR_HEIGHT } = require('../src/core.cjs');
  assert.equal(DEFAULT_UPDATE_FEED, 'https://github.com/Solutionmax/dioptra/releases/latest/download/');
  assert.equal(ROUTE_BAR_HEIGHT, 48);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migratie-core-'));
  try {
    const file = path.join(dir, 'settings.json');
    assert.equal(readSettings(file).autoUpdates, true);
    assert.equal(readSettings(file).updateFeed, '');
    fs.writeFileSync(file, JSON.stringify({ rules: [] }));
    assert.equal(readSettings(file).autoUpdates, true);
    fs.writeFileSync(file, JSON.stringify({ rules: [], autoUpdates: false }));
    assert.equal(readSettings(file).autoUpdates, true, 'pre-0.7.0 default (off) is not an explicit choice');
    fs.writeFileSync(file, JSON.stringify({ rules: [], autoUpdates: false, autoUpdatesChosen: true }));
    assert.equal(readSettings(file).autoUpdates, false);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('certificate summary keeps only the shown fields and counts days left', () => {
  const { certSummary, daysLeft } = require('../src/core.cjs');
  const cert = { subjectName: 'fallback', subject: { commonName: 'shop.example' }, issuerName: 'R13', issuer: { commonName: 'R13', organizations: ["Let's Encrypt"] }, validStart: 1789430400, validExpiry: 1797206400, data: 'PEM' };
  assert.deepEqual(certSummary(cert), { subject: 'shop.example', issuer: "Let's Encrypt", issuerName: 'R13', validFrom: 1789430400000, expires: 1797206400000 });
  assert.equal(certSummary({ issuerName: 'x' }), null, 'no dates, no card');
  assert.equal(certSummary({ ...cert, subject: { commonName: 'a'.repeat(500) } }).subject.length, 200);
  assert.equal(daysLeft(1797206400000, 1797206400000 - 74.5 * 86400000), 74);
  assert.equal(daysLeft(1000, 86400000 + 1000), -1);
});

test('PTR query names for IPv4 and IPv6, nothing for non addresses', () => {
  const { ptrName } = require('../src/core.cjs');
  assert.equal(ptrName('212.125.139.107'), '107.139.125.212.in-addr.arpa');
  assert.equal(ptrName('::ffff:1.2.3.4'), '4.3.2.1.in-addr.arpa');
  assert.equal(ptrName('[2606:4700:4700::1111]'), '1.1.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.7.4.0.0.7.4.6.0.6.2.ip6.arpa');
  assert.equal(ptrName('::1'), '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa');
  assert.equal(ptrName('1.2.3.4, 5.6.7.8'), ''); assert.equal(ptrName('example.com'), ''); assert.equal(ptrName(''), '');
});
test('a www rule covers the bare name and the www name with one entry', () => {
  const { expandRules } = require('../src/core.cjs');
  const rules = validateRules([{ domain: 'WWW.Example.com', ip: '203.0.113.10', www: true }, { domain: 'shop.example.com', ip: '::1', enabled: false, www: true }, { domain: 'www.exact.nl', ip: '127.0.0.1' }]);
  assert.deepEqual(rules, [{ domain: 'example.com', ip: '203.0.113.10', enabled: true, www: true, skipSSL: false }, { domain: 'shop.example.com', ip: '::1', enabled: false, www: true, skipSSL: false }, { domain: 'www.exact.nl', ip: '127.0.0.1', enabled: true, skipSSL: false }]);
  assert.equal(resolverRules(rules), 'MAP example.com 203.0.113.10, MAP www.example.com 203.0.113.10, MAP www.exact.nl 127.0.0.1');
  assert.deepEqual(expandRules(rules).map(r => `${r.domain} ${r.enabled}`), ['example.com true', 'www.example.com true', 'shop.example.com false', 'www.shop.example.com false', 'www.exact.nl true']);
  assert.deepEqual(validateRules([{ domain: 'x.com', ip: '127.0.0.1', www: 'yes' }]), [{ domain: 'x.com', ip: '127.0.0.1', enabled: true, skipSSL: false }], 'only a real true switches www on');
  assert.throws(() => validateRules([{ domain: 'x.com', ip: '127.0.0.1', www: true }, { domain: 'www.x.com', ip: '::1' }]), /www\.x\.com is already in the list/);
  assert.throws(() => validateRules([{ domain: 'www.x.com', ip: '::1' }, { domain: 'x.com', ip: '127.0.0.1', www: true }]), /www\.x\.com is already in the list/);
  assert.throws(() => validateRules([{ domain: `${'a'.repeat(61)}.${'b'.repeat(61)}.${'c'.repeat(61)}.${'d'.repeat(61)}.nl`, ip: '127.0.0.1', www: true }]), /Invalid domain name/, 'the www name must fit as well');
});
test('reads a server list from CSV and drops what is not a name with an IP address', () => {
  const { parseServers, validServers } = require('../src/core.cjs');
  assert.deepEqual(parseServers('﻿name;ip\r\nweb01.example.net;203.0.113.10\r\n"web02";"203.0.113.25"\r\n\r\n2001:db8::10\tnl-v6\nbroken line\nweb01.EXAMPLE.net,10.0.0.9\nport,127.0.0.1:80\nzone,fe80::1%eth0\n'), { servers: [{ name: 'web01.example.net', ip: '203.0.113.10' }, { name: 'web02', ip: '203.0.113.25' }, { name: 'nl-v6', ip: '2001:db8::10' }], skipped: 4 });
  assert.deepEqual(parseServers('a,10.0.0.1\nb,10.0.0.2'), { servers: [{ name: 'a', ip: '10.0.0.1' }, { name: 'b', ip: '10.0.0.2' }], skipped: 0 }, 'no header needed');
  assert.deepEqual(parseServers('name,ip\nnothing here'), { servers: [], skipped: 1 });
  assert.deepEqual(parseServers(''), { servers: [], skipped: 0 });
  assert.deepEqual(validServers([{ name: 'ok', ip: '10.0.0.1', extra: 1 }, { name: 'OK', ip: '10.0.0.2' }, { name: '', ip: '10.0.0.3' }, { name: 'x'.repeat(101), ip: '10.0.0.4' }, { name: 'bad\u0007', ip: '10.0.0.5' }, { name: 'noip', ip: 'web' }, null, 'text']), [{ name: 'ok', ip: '10.0.0.1' }]);
  assert.deepEqual(validServers('nope'), []);
  assert.equal(validServers(Array.from({ length: 2100 }, (_, i) => ({ name: `s${i}`, ip: '10.0.0.1' }))).length, 2000);
});
test('keeps the server list in the settings and survives a damaged one', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-servers-')), 'settings.json');
  assert.deepEqual(readSettings(file).servers, [], 'empty on a new profile');
  saveSettings(file, { ...readSettings(file), servers: [{ name: 'web01', ip: '203.0.113.10' }], rules: [{ domain: 'x.com', ip: '203.0.113.10', enabled: true, www: true }] });
  assert.deepEqual(readSettings(file).servers, [{ name: 'web01', ip: '203.0.113.10' }]);
  assert.deepEqual(readSettings(file).rules, [{ domain: 'x.com', ip: '203.0.113.10', enabled: true, www: true, skipSSL: false }]);
  fs.writeFileSync(file, JSON.stringify({ rules: [{ domain: 'x.com', ip: '127.0.0.1' }], servers: { broken: true } }));
  assert.deepEqual(readSettings(file).servers, []); assert.equal(readSettings(file).rules.length, 1, 'rules still load');
});

test('SSL exceptions default off and legacy global bypass migrates only existing rules once', () => {
  const {expandRules}=require('../src/core.cjs');
  assert.equal(validateRules([{domain:'new.test',ip:'127.0.0.1'}])[0].skipSSL,false);
  assert.equal(validateRules([{domain:'new.test',ip:'127.0.0.1',skipSSL:'true'}])[0].skipSSL,false);
  assert.equal(expandRules(validateRules([{domain:'new.test',ip:'127.0.0.1',www:true,skipSSL:true}]))[1].skipSSL,true);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dioptra-ssl-')),file=path.join(dir,'settings.json');
  try {
    assert.equal(readSettings(file).sslVerification,true);
    fs.writeFileSync(file,JSON.stringify({rules:[{domain:'old.test',ip:'127.0.0.1'},{domain:'strict.test',ip:'127.0.0.1',skipSSL:false}],sslVerification:false}));
    const migrated=readSettings(file);assert.equal(migrated.sslVerification,true);assert.equal(migrated.sslPolicyVersion,1);assert.ok(migrated.sslMigration);assert.deepEqual(migrated.rules.map(r=>r.skipSSL),[true,false]);
    migrated.rules.push(validateRules([{domain:'new.test',ip:'127.0.0.1'}])[0]);saveSettings(file,migrated);assert.deepEqual(readSettings(file),migrated);
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
});
