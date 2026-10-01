const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateRules, resolverRules, navigationURL, readSettings, saveSettings } = require('../src/core.cjs');

test('normalizes DNS names and brackets IPv6 without allowing resolver rule injection', () => {
  const rules = validateRules([{ domain: ' EXAMPLE.com. ', ip: '::1', enabled: true }, { domain: 'bücher.de', ip: '127.0.0.1', enabled: false }]);
  assert.deepEqual(rules, [{ domain: 'example.com', ip: '::1', enabled: true }, { domain: 'xn--bcher-kva.de', ip: '127.0.0.1', enabled: false }]);
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
    config.rules = [{ domain: 'test.invalid', ip: '127.0.0.1', enabled: true }];
    config.tabs = ['https://test.invalid/'];
    saveSettings(file, config);
    assert.deepEqual(readSettings(file), config);
    fs.writeFileSync(file, '{bad');
    assert.throws(() => readSettings(file));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('DevTools docking leaves separate website, resize handle and inspector areas', () => {
  const { devtoolsLayout } = require('../src/core.cjs');
  const bottom = devtoolsLayout(1200, 900, 0, 'bottom', .4, true);
  assert.equal(bottom.page.x, 0);
  assert.equal(bottom.page.y, 132);
  assert.equal(bottom.page.y + bottom.page.height, bottom.splitter.y);
  assert.equal(bottom.splitter.y + bottom.splitter.height, bottom.bar.y);
  assert.equal(bottom.bar.y + bottom.bar.height, bottom.tools.y);
  assert.equal(bottom.tools.y + bottom.tools.height, 870);
  for (const dock of ['left', 'right']) {
    const layout = devtoolsLayout(960, 640, 460, dock, .7, true);
    assert.ok(layout.page.width >= 200);
    assert.ok(layout.tools.width >= 220);
    assert.equal(layout.tools.width + layout.splitter.width + layout.page.width, 500);
    assert.equal(layout.tools.y, 164);
    if (dock === 'right') assert.equal(layout.page.width + 6, layout.tools.x);
    else assert.equal(layout.tools.width + 6, layout.page.x);
  }
  assert.deepEqual(devtoolsLayout(1200, 900, 0, 'right', .5, false).page, { x: 0, y: 132, width: 1200, height: 738 });
});

test('updates default to the GitHub feed and automatic checks, unless the user turned them off', () => {
  const { DEFAULT_UPDATE_FEED, ROUTE_BAR_HEIGHT } = require('../src/core.cjs');
  assert.equal(DEFAULT_UPDATE_FEED, 'https://github.com/Solutionmax/dioptra/releases/latest/download/');
  assert.equal(ROUTE_BAR_HEIGHT, 36);
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
