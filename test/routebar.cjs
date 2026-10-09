// Route bar and footer extras against a real site: reverse DNS name, certificate card, site platform card,
// DNS records card, memory card, version in the footer and Clear cache reload.
// Needs internet (valid public certificate, PTR record, a WordPress site). Run: xvfb-run -a npm run test:routebar
// With xdotool under a window manager (Linux) the clicks are real mouse clicks.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-routebar-'));
  const site = process.env.ROUTEBAR_SITE || 'https://wordpress.org/', shots = process.env.ROUTEBAR_SHOTS;
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ rules: [], tabs: [site], sslVerification: true, autoUpdates: false, autoUpdatesChosen: true }));
  const app = await electron.launch({ executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: [...(process.getuid?.() === 0 ? ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs')] : []), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`], cwd: path.resolve(__dirname, '..') });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const ui = await app.firstWindow(); ui.setDefaultTimeout(30000);
    await ui.waitForFunction(() => window.browser);
    const bar = ui.locator('#route-bar');
    const views = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].contentView.children.length);
    const topBounds = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].contentView.children.at(-1).getBounds());
    const content = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentSize());
    let realClick = null;
    try { execFileSync('xdotool', ['version'], { stdio: 'ignore' }); realClick = async locator => { let r = await locator.boundingBox(); if (!r) { await locator.waitFor(); r = await locator.boundingBox(); } const c = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentBounds()); const run = (...a) => execFileSync('xdotool', a); run('mousemove', String(Math.round(c.x + r.x + r.width / 2)), String(Math.round(c.y + r.y + r.height / 2))); run('mousedown', '1'); await sleep(120); run('mouseup', '1'); }; } catch {}
    const click = locator => realClick ? realClick(locator) : locator.click();
    const screen = name => { if (shots && realClick) try { execFileSync('import', ['-window', 'root', path.join(shots, name)]); } catch {} };
    const cardPage = async () => { const until = Date.now() + 15000; for (;;) { const page = app.windows().find(w => w.url().includes('card.html')); if (page) return page; if (Date.now() > until) throw new Error('card did not open'); await sleep(100); } };
    const cardText = async needle => { const page = await cardPage(); await page.waitForFunction(text => document.body.innerText.includes(text), needle); await sleep(400); return (await page.locator('body').innerText()).replace(/\s+/g, ' '); };
    // A real user clicks in the focused window with the page focused.
    await app.evaluate(({ app, BaseWindow }) => { const w = BaseWindow.getAllWindows()[0]; app.focus({ steal: true }); w.show(); w.focus(); });
    console.log('real mouse:', Boolean(realClick));

    // 1. Hostname behind the IP.
    await bar.locator('.ptr').waitFor();
    assert.match(await bar.locator('.ptr').innerText(), /^[a-z0-9.-]+\.[a-z]+$/i, 'reverse DNS name is shown behind the connected IP');
    const before = await views();

    // 2. Site info contains observed certificate details; its verified badge opens the original card.
    const chip = bar.locator('button.site-btn'); await chip.waitFor(); await click(chip);
    const siteText = await cardText('Connection & site comparison');
    assert.match(siteText, /WordPress/); assert.match(siteText, /Detected from the (generator tag|file paths in the page)/);
    const cert = (await cardPage()).getByRole('link', {name:'SSL valid', exact:true});await cert.waitFor();await cert.click();
    const certText = await cardText('days left');
    assert.match(certText, /Certificate valid/); assert.match(certText, /ISSUED TO \S+/i); assert.match(certText, /ISSUER \S+/i);
    assert.match(certText, /EXPIRES \d{1,2} \w{3} \d{4}/i); assert.match(certText, /\d+ days? left/);
    assert.equal(await views(), before + 1, 'card is a native view above the page');
    let b = await topBounds();assert.ok(b.y >= 138 && b.height > 100 && b.width===330);
    await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].contentView.children.at(-1).webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}));await sleep(300);assert.equal(await views(),before,'Escape closes certificate card');
    await click(chip);await cardText('Connection & site comparison');screen('site.png');await click(chip);await sleep(300);assert.equal(await views(),before,'Site info toggles');
    await click(chip);await cardText('Connection & site comparison');await click(ui.locator('#address'));await sleep(300);assert.equal(await views(),before,'outside UI click closes native card');

    // 4. DNS card: public records of the visited name, Refresh asks again, and the side by side comparison renders.
    const dnsButton = bar.locator('button.dns-btn'); await dnsButton.waitFor();
    await click(dnsButton);
    const dnsText = await cardText('asked');
    assert.match(dnsText, /DNS records/); assert.match(dnsText, /\bA \d+\.\d+\.\d+\.\d+ ?TTL \d/, 'address with its lifetime'); assert.match(dnsText, /\bNS [a-z0-9.-]+\.[a-z]+/i, 'nameservers');
    assert.match(dnsText, /System resolver · asked \d\d:\d\d/);
    b = await topBounds();
    assert.ok(b.y >= 138 && b.width === 440 && b.height > 150, `DNS card below the bar: ${JSON.stringify(b)}`);
    screen('dns.png');
    await (await cardPage()).locator('a.mem-btn').click({ noWaitAfter: true }); await sleep(300);
    assert.match(await cardText('asked'), /DNS records/); assert.equal(await views(), before + 1, 'Refresh keeps the card open');
    const row = (type, status, hostfile, live) => ({ type, status, hostfile, live });
    const compared = await (await cardPage()).evaluate(async data => { await render(data); return { text: document.body.innerText.replace(/\s+/g, ' '), marked: document.querySelectorAll('mark').length }; }, { kind: 'dns', state: 'done', host: 'example.test', ruleIP: '203.0.113.10', askedAt: Date.now(), status: 'ok', code: '', server: 'ok', groups: [], table: { differing: 1, groups: [
      { name: 'example.test', role: 'host', rows: [row('A', 'expected', [{ text: '203.0.113.10', differs: false }], [{ text: '198.51.100.24', differs: false }]), row('MX', 'differs', [], [{ text: 'mail.example.test', prio: 10, differs: true }]), { ...row('TXT', 'unknown', [], [{ text: 'v=spf1 -all', differs: false }]), failed: { hostfile: 'ETIMEOUT', live: '' } }] },
      { name: 'www.example.test', role: 'www', rows: [row('CNAME', 'same', [{ text: 'example.test', differs: false }], [{ text: 'example.test', differs: false }])] }] } });
    for (const part of [/HOSTFILE ?asked 203\.0\.113\.10 itself/, /LIVE ?public DNS/, /1 record type differs/, /203\.0\.113\.10 your rule 198\.51\.100\.24 current server Expected/, /MX no record 10 ?mail\.example\.test Differs/, /TXT lookup failed \(ETIMEOUT\) v=spf1 -all Unknown/, /www\.example\.test CNAME example\.test example\.test Same/]) assert.match(compared.text, part);
    assert.equal(compared.marked, 1, 'only the value that exists on one side is marked');
    await click(dnsButton); await sleep(500); assert.equal(await views(), before, 'the DNS button toggles');

    // 5. Memory card: opens upward from the footer, lists the tab, a row jumps to its tab.
    const ram = ui.locator('#memory-usage');
    assert.match(await ram.innerText(), /^RAM [\d.]+ [MG]B$/);
    await click(ram);
    const memText = await cardText('Dioptra itself');
    assert.match(memText, /TOTAL DIOPTRA [\d.]+ [MG]B/); assert.match(memText, /TAB ?.+ [\d.]+ [MG]B/); assert.match(memText, /1 tab · \d+ processes/);
    b = await topBounds(); const [, height] = await content();
    assert.ok(b.y + b.height <= height - 30 && b.y > 138, `memory card sits above the footer: ${JSON.stringify(b)}`);
    screen('memory.png');
    await (await cardPage()).locator('a.mem-row').first().click(); await sleep(600);
    assert.equal(await views(), before, 'a tab row closes the card and jumps to the tab');

    // 6. Version in the footer opens the Updates panel with the explanation.
    const version = ui.locator('#footer-version');
    assert.equal(await version.innerText(), `Dioptra v${require('../package.json').version}`);
    await click(version); await ui.locator('#update-section').waitFor();
    assert.equal(await ui.locator('#update-version').innerText(), `Dioptra v${require('../package.json').version}`);
    assert.equal(await ui.locator('#how-steps li').count(), 3, 'three steps explain how updates work');
    screen('updates.png');
    await ui.locator('#close-panel').click().catch(() => ui.evaluate(() => window.browser.command('panel', null)));

    // 7. Clear cache also reloads the page.
    await app.evaluate(({ webContents }, origin) => { globalThis.__loads = 0; for (const wc of webContents.getAllWebContents()) if (wc.getURL().startsWith(origin)) wc.on('did-finish-load', () => globalThis.__loads++); }, new URL(site).origin);
    await ui.locator('#clear-cache').click(); await cardText('Clear cache & reload both panes');
    const cacheCard=await cardPage();
    await cacheCard.getByRole('link',{name:'Clear cache & reload both panes',exact:true}).click({noWaitAfter:true}).catch(error=>{if(!cacheCard.isClosed())throw error;});
    const until = Date.now() + 20000; while (!(await app.evaluate(() => globalThis.__loads)) && Date.now() < until) await sleep(100);
    assert.equal(await app.evaluate(() => globalThis.__loads), 1, 'page reloaded once after Clear cache');
    await bar.locator('.ptr').waitFor(); await chip.waitFor();
    if (shots) await ui.screenshot({ path: path.join(shots, 'bar.png') });
    console.log('PASS: reverse DNS name, certificate card, site platform card, DNS card, memory card, footer version and Updates panel, Clear cache reload.');
    console.log(' cert:', certText); console.log(' site:', siteText); console.log(' dns:', dnsText); console.log(' memory:', memText);
  } finally {
    const exited = new Promise(r => app.process().exitCode !== null ? r() : app.process().once('exit', r));
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await Promise.race([exited, sleep(20000)]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exit(1); });
