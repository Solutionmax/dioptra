// Integration checks for the Differences engine (view, report, Ask Claude summary) and Clear site data.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-sitedata-'));
  const OBFUSCATED = "var _0x1a2b=['\\x68\\x65','\\x77\\x6f'];eval(atob('ZG9jdW1lbnQud3JpdGUoMSk='));";
  let releaseSet = null;
  const serve = side => (req, res) => {
    // Headers (and cookies) can arrive before the document's storage script; exercise that real network ordering.
    if (req.url === '/set') { res.setHeader('Set-Cookie', 'sd=SECRETVALUE; Path=/'); res.setHeader('Content-Type', 'text/html'); const finish=()=>res.end("<title>set</title><script>localStorage.setItem('k','1')</script>");if(side==='host'&&!releaseSet){res.flushHeaders();releaseSet=finish;return;}return finish(); }
    if (req.url === '/read') { res.setHeader('Content-Type', 'text/html'); return res.end("<title>reading</title><script>document.title='k='+localStorage.getItem('k')</script>"); }
    res.setHeader('Content-Type', 'text/html'); res.setHeader('Server', side === 'host' ? 'HostSrv' : 'LiveSrv'); res.setHeader('Set-Cookie', 'visit=TOPSECRET; Path=/');
    res.end(side === 'host'
      ? `<title>Shop</title><script src="https://evil-cdn.invalid/x.js"></script><script>${OBFUSCATED}</script><p>same</p>`
      : '<title>Shop</title><script src="https://cdn.invalid/lib.js"></script><script src="https://stat-cdnjs.top/j.js"></script><p>same</p>');
  };
  const host = http.createServer(serve('host')); await new Promise(r => host.listen(0, '::1', r));
  const port = host.address().port;
  const live = http.createServer(serve('live')); await new Promise(r => live.listen(port, '127.0.0.1', r));
  const other = http.createServer(serve('other')); await new Promise(r => other.listen(0, '127.0.0.1', r));
  const otherPort = other.address().port;
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ rules: [{ domain: 'localhost', ip: '::1', enabled: true }], tabs: [`http://localhost:${port}/`] }));
  let app, ui;
  try {
    app = await electron.launch({ executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: [...(process.getuid?.() === 0 ? ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs')] : []), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`], cwd: path.resolve(__dirname, '..') });
    ui = await app.firstWindow(); ui.setDefaultTimeout(15000);
    const cmd = (action, data) => ui.evaluate(([a, d]) => window.browser.command(a, d), [action, data]);
    const st = async () => (await cmd('state')).state;
    const poll = async (fn, what) => { const until = Date.now() + 20000; while (Date.now() < until) { if (await fn(await st())) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Timed out: ' + what); };
    const pageLoaded = url => poll(() => app.evaluate(({ webContents }, target) => { const wc=webContents.getAllWebContents().find(w=>w.getURL()===target);return Boolean(wc && !wc.isLoading()); },url), 'native page loaded: '+url);
    await ui.waitForFunction(() => window.browser);
    await poll(s => s.tabs.some(t => t.title === 'Shop' && !t.loading), 'first page');
    await app.evaluate(() => process.getBuiltinModule('dns').setDefaultResultOrder('ipv4first'));
    const websiteViews = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v.webContents.getURL().startsWith('http://')).map(v => v.getVisible()));

    // Route bar geometry: one bar above the page, at the top of each pane when comparing.
    let s = await st();
    assert.equal(s.view, 'single'); assert.equal(s.routeBarHeight, 48);
    assert.equal(s.paneLayout.length, 1);
    assert.equal(s.paneLayout[0].banner.y + s.paneLayout[0].banner.height, s.paneLayout[0].page.y, 'single bar sits directly above the page');
    assert.equal((await cmd('compare')).ok, true);
    await poll(s => s.view === 'compare' && s.paneLayout.length === 2 && s.tabs.every(t => t.connection), 'compare');
    s = await st();
    for (const pane of s.paneLayout) { assert.equal(pane.banner.y + pane.banner.height, pane.page.y); assert.equal(pane.banner.height, 48); assert.equal(pane.banner.width, pane.page.width); }
    assert.equal(s.routeBarHeight, 0, 'no header strip in compare'); assert.equal(s.paneLayout[0].page.y, 144);
    for (const t of s.tabs) { assert.equal(t.connection.status, 200); assert.ok(t.connection.ms >= 0); }

    // Differences from compare: the live tab closes, native views hide, the report arrives.
    assert.equal((await cmd('view', 'differences')).ok, true);
    s = await st(); assert.equal(s.view, 'differences'); assert.equal(s.comparison, null); assert.equal(s.tabs.filter(t => t.mode === 'live').length, 0);
    assert.deepEqual(s.paneLayout, []); assert.ok((await websiteViews()).every(v => v === false), 'website views hidden');
    await poll(s => s.differences.status === 'done', 'differences done');
    s = await st(); const report = s.differences.report;
    assert.equal(report.hostfile.status, 200); assert.equal(report.live.status, 200);
    assert.equal(report.hostfile.ip, '::1'); assert.ok(report.live.ip.includes('127.0.0.1'), 'live IP ' + report.live.ip);
    const evil = report.domains.find(d => d.host === 'evil-cdn.invalid'), lib = report.domains.find(d => d.host === 'cdn.invalid');
    assert.deepEqual([evil.hostfile, evil.live, evil.types], [true, false, ['script']]); assert.deepEqual([lib.hostfile, lib.live], [false, true]);
    const stat = report.domains.find(d => d.host === 'stat-cdnjs.top');
    assert.deepEqual([stat.hostfile, stat.live], [false, true], 'live-only script host');
    assert.ok(report.findings.some(f => f.severity === 'high' && /stat-cdnjs\.top loads only on Live/.test(f.text)));
    const text = report.findings.map(f => `${f.severity}:${f.text}`).join('\n');
    assert.match(text, /high:Script from evil-cdn\.invalid loads only on Hostfile/); assert.match(text, /high:Inline script that looks obfuscated appears only on Hostfile/);
    assert.deepEqual(report.headers.filter(h => h.name === 'server').map(h => [h.hostfile, h.live]), [['HostSrv', 'LiveSrv']]);
    assert.ok(report.html.changedLines > 0); assert.ok(report.html.hunks.some(l => l.side === 'hostfile') && report.html.hunks.some(l => l.side === 'live'));
    assert.equal(/SECRET|visit=/i.test(JSON.stringify(report)), false, 'no cookie values in the report');
    assert.ok(report.headers.some(h => h.name === 'set-cookie') === false, 'both sides set a cookie, so no difference');
    const again = await cmd('differences-run'); assert.equal(again.ok, true); assert.equal(again.report.url, report.url);
    assert.equal((await st()).differences.status, 'done');

    // Ask Claude: copies the summary (Claude itself is not installed in this profile).
    const asked = await cmd('differences-ask-claude'); assert.equal(asked.ok, true); assert.equal(asked.notice, 'Summary copied. Paste it into Claude.');
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.match(clip, /evil-cdn\.invalid only on Hostfile/); assert.match(clip, /Header differences/); assert.equal(/SECRET/.test(clip), false);

    // Leaving the view restores the layout; switching tabs and navigating reset to single.
    assert.equal((await cmd('view', 'single')).ok, true); s = await st();
    assert.equal(s.view, 'single'); assert.equal(s.paneLayout.length, 1); assert.deepEqual(await websiteViews(), [true]);
    await cmd('view', 'differences'); await cmd('new-tab', `http://127.0.0.1:${otherPort}/set`);
    await poll(s => s.view === 'single' && s.tabs.some(t => t.url.includes(otherPort) && !t.loading), 'new tab');
    const second = (await st()).tabs.find(t => t.url.includes(otherPort));
    assert.equal((await cmd('view', 'differences')).ok, false, 'no rule for 127.0.0.1');

    // Clear site data: only the current origin loses cookies and storage.
    await poll(async s => (await app.evaluate(({ session }) => session.fromPartition('persist:web').cookies.get({ name: 'sd' }))).some(c => c.domain === '127.0.0.1'), 'other cookie');
    await cmd('activate', s.tabs[0].id);
    await cmd('navigate', `http://localhost:${port}/set`);
    await poll(async s => (await app.evaluate(({ session }) => session.fromPartition('persist:web').cookies.get({ name: 'sd' }))).some(c => c.domain === 'localhost'), 'localhost cookie');
    // Deliberately interrupt the slow body after its cookie arrived; the completed fast page must remain usable.
    await cmd('navigate', `http://localhost:${port}/read`);
    await pageLoaded(`http://localhost:${port}/read`);
    releaseSet();
    const fast=await st();assert.equal(fast.tabs.find(t=>t.id===fast.activeId)?.error, '', 'an interrupted slow page does not mark the completed fast page as failed');
    assert.equal(await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents.getURL()===url)?.getVisible(),`http://localhost:${port}/read`),true,'fast native page remains visible after interrupting slow navigation');
    await cmd('navigate', `http://localhost:${port}/set`);
    await pageLoaded(`http://localhost:${port}/set`);
    assert.equal(await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL()===url).executeJavaScript("localStorage.getItem('k')"),`http://localhost:${port}/set`),'1','storage script completed before reading it');
    await cmd('navigate', `http://localhost:${port}/read`);
    await poll(s => s.tabs.find(t => t.id === s.activeId).title === 'k=1', 'localStorage set');
    const cleared = await cmd('clear-site-data'); assert.equal(cleared.ok, true, JSON.stringify(cleared)); assert.match(cleared.notice, /localhost/);
    await poll(s => s.tabs.find(t => t.id === s.activeId).title === 'k=null', 'localStorage cleared');
    const cookies = await app.evaluate(({ session }) => session.fromPartition('persist:web').cookies.get({}));
    assert.equal(cookies.filter(c => c.domain.replace(/^\./, '') === 'localhost').length, 0, 'localhost cookies gone');
    assert.ok(cookies.some(c => c.name === 'sd' && c.domain === '127.0.0.1'), 'other origin cookie kept');
    assert.equal(await app.evaluate(({ webContents }, p) => webContents.getAllWebContents().find(w => w.getURL().includes(':' + p)).executeJavaScript("localStorage.getItem('k')"), otherPort), '1', 'other origin storage kept');

    // Recognizing an interrupted load must still preserve real connection failures and their visible error page.
    other.closeAllConnections(); await new Promise(resolve=>other.close(resolve));
    await cmd('navigate',`http://127.0.0.1:${otherPort}/unavailable`);
    await poll(s=>Boolean(s.tabs.find(t=>t.id===s.activeId).error),'real connection failure');
    assert.equal(await ui.locator('#page-error').isVisible(),true,'a genuine connection failure remains visible');
    assert.match(await ui.locator('#page-error-detail').innerText(),/CONNECTION|FAILED/);

    // Protected hosts are never wiped.
    await cmd('navigate', 'https://claude.ai/');
    await poll(s => s.tabs.find(t => t.id === s.activeId).url.startsWith('https://claude.ai'), 'claude.ai tab');
    const refused = await cmd('clear-site-data'); assert.equal(refused.ok, false); assert.match(refused.error, /protected/);
    console.log('PASS differences view + report + ask summary, route bar geometry, interrupted navigation visibility, genuine connection errors, clear-site-data isolation and protected hosts');
  } catch (error) { console.error('State', JSON.stringify(ui ? await ui.evaluate(() => window.browser.command('state')).catch(() => null) : null).slice(0, 3000)); throw error; }
  finally { if (app) await app.close(); for (const server of [host, live, other]) { server.closeAllConnections(); server.close(); } fs.rmSync(profile, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
