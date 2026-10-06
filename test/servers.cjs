// www rules, the server list (CSV import, pages) and server suggestions in the IP field, end to end in the real app.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-servers-'));
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>www fixture</title><h1 id="host">${String(req.headers.host).replace(/[^a-z0-9.:-]/gi, '')}</h1>`); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, settingsFile = path.join(profile, 'settings.json');
  const saved = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  // Only the bare domain is in the rule: the www name must reach the fixture through the www switch.
  fs.writeFileSync(settingsFile, JSON.stringify({ rules: [{ domain: 'migration.invalid', ip: '127.0.0.1', enabled: true, www: true }], tabs: [`http://www.migration.invalid:${port}/`], updateFeed: '', autoUpdates: false, autoUpdatesChosen: true }));
  const csv = path.join(profile, 'servers.csv');
  const sample = (prefix, count, net) => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}.example.net;${net}.${10 + i}`);
  fs.writeFileSync(csv, `﻿name;ip\r\n${[...sample('web', 20, '203.0.113'), ...sample('mail', 3, '198.51.100')].join('\r\n')}\r\nbroken line without address\r\n`);
  let app;
  const launch = () => electron.launch({ timeout: 30000, executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: [...(process.getuid?.() === 0 ? ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs')] : []), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`], cwd: path.resolve(__dirname, '..'), env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  try {
    app = await launch();
    const ui = await app.firstWindow();
    await ui.getByRole('button', { name: 'Domains', exact: true }).waitFor();
    const page = await app.waitForEvent('window', { predicate: p => p.url().includes('www.migration.invalid'), timeout: 10000 }).catch(() => app.windows().find(p => p.url().includes('www.migration.invalid')));
    assert.ok(page, 'the www name of a www rule opens');
    await page.locator('#host').waitFor();
    assert.equal(await page.locator('#host').innerText(), `www.migration.invalid:${port}`, 'the www name reaches the rule address with its own Host header');
    await ui.locator('#route-bar .badge').filter({ hasText: 'HOSTFILE' }).waitFor();
    assert.match(await ui.locator('#route-bar').innerText(), /RULE\s*127\.0\.0\.1/i, 'route bar knows the rule behind the www name');

    await ui.getByRole('button', { name: 'Domains', exact: true }).click();
    assert.equal(await ui.locator('#rules .rule').count(), 1, 'one row for both names');
    assert.equal(await ui.locator('#rules .www-chip').innerText(), '+ WWW');
    assert.equal(await ui.locator('#rule-count').innerText(), '1', 'a www rule counts once');
    assert.equal(await ui.getByRole('switch', { name: 'Enable migration.invalid and www.migration.invalid' }).getAttribute('aria-checked'), 'true');
    const ip = ui.getByLabel('IP address', { exact: true }), domain = ui.getByLabel('Domain', { exact: true }), www = ui.getByRole('switch', { name: 'Include www' });
    assert.equal(await ip.getAttribute('placeholder'), '203.0.113.10', 'plain IP field without a server list');
    assert.equal(await ui.locator('#server-tip').isVisible(), true);
    await ip.fill('web'); assert.equal(await ui.locator('#ip-options').isVisible(), false, 'no suggestions without a server list');
    await ip.fill('');

    // Settings: import, pages, replace on a second import.
    await ui.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await ui.locator('#empty-servers').isVisible(), true);
    assert.equal(await ui.locator('#clear-servers').isVisible(), false);
    await ui.locator('#server-file').setInputFiles(csv);
    await ui.locator('#server-status').filter({ hasText: '23 servers imported, 1 line skipped' }).waitFor();
    assert.equal(await ui.locator('#servers .server').count(), 8, 'eight servers on a page');
    assert.equal(await ui.locator('#server-range').innerText(), '1 to 8 of 23');
    assert.equal(await ui.locator('#server-prev').isDisabled(), true);
    const listHeight = (await ui.locator('#servers').boundingBox()).height;
    await ui.getByRole('button', { name: 'Next page' }).click();
    assert.equal(await ui.locator('#servers .server .n').first().innerText(), 'web09.example.net');
    await ui.getByRole('button', { name: 'Next page' }).click();
    assert.equal(await ui.locator('#server-range').innerText(), '17 to 23 of 23');
    assert.equal(await ui.locator('#server-page').innerText(), 'Page 3 of 3');
    assert.equal(await ui.locator('#server-next').isDisabled(), true);
    assert.equal((await ui.locator('#servers').boundingBox()).height, listHeight, 'a short last page keeps the list height');
    assert.deepEqual(saved().servers[22], { name: 'mail03.example.net', ip: '198.51.100.12' });
    await ui.locator('#server-file').setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('name,ip\nnothing useful\n') });
    await ui.locator('#toast').filter({ hasText: 'No servers found' }).waitFor();
    assert.equal(saved().servers.length, 23, 'a file without servers leaves the list alone');
    await ui.locator('#server-file').setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.alloc(1024 * 1024 + 1, 'a') });
    await ui.locator('#toast').filter({ hasText: 'too large' }).waitFor();
    assert.equal((await ui.evaluate(() => window.browser.command('import-servers', 'x'.repeat(1024 * 1024 + 1)))).ok, false, 'the main process refuses an oversized list too');
    assert.equal(saved().servers.length, 23);

    // Domains: suggestions by name or address, at most five.
    await ui.getByRole('button', { name: 'Domains', exact: true }).click();
    assert.equal(await ip.getAttribute('placeholder'), 'IP or server name');
    assert.equal(await ui.locator('#server-tip').isVisible(), false);
    await ip.click(); assert.equal(await ui.locator('#ip-options').isVisible(), false, 'nothing is listed before typing');
    await ip.pressSequentially('web');
    assert.equal(await ui.locator('#ip-options .option').count(), 5, 'at most five suggestions');
    assert.equal(await ui.locator('#ip-options .more').innerText(), '5 of 20 servers. Keep typing to narrow down.');
    assert.equal(await ui.locator('#ip-options .option mark').first().innerText(), 'web');
    await ip.pressSequentially('1');
    assert.deepEqual(await ui.locator('#ip-options .option .n').allInnerTexts(), ['web10.example.net', 'web11.example.net', 'web12.example.net', 'web13.example.net', 'web14.example.net']);
    await ip.press('ArrowDown'); await ip.press('ArrowDown');
    assert.equal(await ui.locator('#ip-options .option.active .n').innerText(), 'web12.example.net');
    assert.equal(await ip.getAttribute('aria-activedescendant'), 'server-option-2');
    await ip.press('Enter');
    assert.equal(await ip.inputValue(), '203.0.113.21', 'Enter fills in the address of the highlighted server');
    assert.equal(await ui.locator('#ip-note').innerText(), 'Server: web12.example.net');
    assert.equal(await ui.locator('#ip-options').isVisible(), false);
    assert.equal(await ui.locator('#rules .rule').count(), 1, 'picking a server does not submit the form');
    await ip.fill('198.51.100.1');
    assert.deepEqual(await ui.locator('#ip-options .option .n').allInnerTexts(), ['mail01.example.net', 'mail02.example.net', 'mail03.example.net'], 'part of an address finds servers too');
    await ip.press('Escape'); assert.equal(await ui.locator('#ip-options').isVisible(), false);
    await ip.fill('mail0'); await ui.locator('#ip-options .option', { hasText: 'mail02.example.net' }).click();
    assert.equal(await ip.inputValue(), '198.51.100.11', 'a click picks a server');

    // www switch: on by default, a typed www name is stored under the bare domain.
    assert.equal(await www.getAttribute('aria-checked'), 'true');
    await domain.fill('www.Klant.invalid');
    assert.equal(await ui.locator('#www-note').innerText(), 'Also sends klant.invalid to this IP');
    await ui.getByRole('button', { name: 'Add', exact: true }).click();
    await ui.getByText('klant.invalid', { exact: true }).waitFor();
    assert.deepEqual(saved().rules[1], { domain: 'klant.invalid', ip: '198.51.100.11', enabled: true, www: true });
    assert.equal(await ui.locator('#rules .rule').nth(1).locator('.srv').innerText(), 'mail02.example.net', 'the row names the server behind the address');
    assert.match(await ui.locator('#pending').innerText(), /restart/i);
    assert.equal(await ip.inputValue(), '', 'form is empty again'); assert.equal(await www.getAttribute('aria-checked'), 'true');
    // A full address that is no server: Enter submits it as typed, even while servers that start with it are suggested.
    await domain.fill('exact.invalid'); await ui.locator('#www-row').click();
    assert.equal(await www.getAttribute('aria-checked'), 'false'); assert.equal(await ui.locator('#www-note').innerText(), 'Only this exact name');
    await ip.fill('203.0.113.1'); assert.equal(await ui.locator('#ip-options .option').count(), 5);
    await ip.press('Enter');
    await ui.getByText('exact.invalid', { exact: true }).waitFor();
    assert.deepEqual(saved().rules[2], { domain: 'exact.invalid', ip: '203.0.113.1', enabled: true }, 'no www, address as typed');
    assert.equal(await ui.locator('#rules .rule').nth(2).locator('.www-chip, .srv').count(), 0);
    // A server name typed in full works without picking it.
    await domain.fill('byname.invalid'); await ip.fill('WEB03.example.net'); await ui.getByRole('button', { name: 'Add', exact: true }).click();
    await ui.getByText('byname.invalid', { exact: true }).waitFor();
    assert.equal(saved().rules[3].ip, '203.0.113.12');
    // The www name of a www rule is taken.
    await domain.fill('www.klant.invalid'); await www.click(); await ip.fill('127.0.0.9'); await ui.getByRole('button', { name: 'Add', exact: true }).click();
    await ui.locator('#toast').filter({ hasText: 'www.klant.invalid is already in the list.' }).waitFor();
    assert.equal(saved().rules.length, 4);
    await ui.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden' });
    await domain.fill(''); await ip.fill('');
    // Edit loads the switch; switching www off keeps the rule under its bare domain.
    await ui.getByRole('button', { name: 'Edit klant.invalid' }).click();
    assert.equal(await www.getAttribute('aria-checked'), 'true'); assert.equal(await ui.locator('#ip-note').innerText(), 'Server: mail02.example.net');
    await www.click(); await ui.getByRole('button', { name: 'Save', exact: true }).click();
    await ui.getByRole('switch', { name: 'Enable klant.invalid', exact: true }).waitFor();
    assert.deepEqual(saved().rules[1], { domain: 'klant.invalid', ip: '198.51.100.11', enabled: true });
    await ui.getByRole('button', { name: 'Edit exact.invalid' }).click();
    assert.equal(await www.getAttribute('aria-checked'), 'false', 'a rule without www opens with the switch off');
    await ui.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await www.getAttribute('aria-checked'), 'true', 'a new rule starts with www on');
    fs.mkdirSync('artifacts', { recursive: true });
    await ip.fill('web');
    fs.writeFileSync('artifacts/servers-domains.png', Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')), 'base64'));
    await ip.fill('');
    await ui.getByRole('button', { name: 'Settings', exact: true }).click();
    await ui.getByRole('heading', { name: 'Servers', exact: true }).scrollIntoViewIfNeeded();
    fs.writeFileSync('artifacts/servers-settings.png', Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')), 'base64'));

    // Restart: list and rules are kept, then Clear list brings back the plain IP field.
    await app.close(); app = null;
    app = await launch();
    const restored = await app.firstWindow();
    await restored.getByRole('button', { name: 'Settings', exact: true }).click();
    await restored.locator('#server-status').filter({ hasText: /^23 servers$/ }).waitFor();
    await restored.getByRole('button', { name: 'Clear list', exact: true }).click();
    await restored.locator('#empty-servers').waitFor();
    assert.equal(await restored.locator('#server-pager').isVisible(), false);
    assert.deepEqual(saved().servers, []);
    await restored.getByRole('button', { name: 'Domains', exact: true }).click();
    assert.equal(await restored.locator('#rules .rule').count(), 4);
    assert.equal(await restored.locator('#rules .srv').count(), 0, 'server names leave the rows with the list');
    assert.equal(await restored.getByLabel('IP address', { exact: true }).getAttribute('placeholder'), '203.0.113.10');
    console.log('PASS: www rule routing and route bar, one row per www rule, CSV import with pages, limits, suggestions (five, keyboard, mouse, by address), www switch add/edit/duplicate, server name lookup, restart persistence and Clear list.');
  } finally {
    if (app) await app.close();
    server.closeAllConnections(); server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
