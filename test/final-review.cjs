// Real anonymous Differences redirects/TLS and server-only native Site info, also runnable against packaged apps.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), https = require('node:https');
const { execFileSync } = require('node:child_process');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-final-review-'));
  const servers = [], seen = [];
  let app, redirects = false, finalPort, tlsPort;
  const serve = async (transport, address, handler, port = 0, options = {}) => {
    const server = transport.createServer(options, handler); servers.push(server);
    await new Promise(resolve => server.listen(port, address, resolve)); return server.address().port;
  };
  try {
    finalPort = await serve(http, '::1', (req, res) => {
      seen.push({ side: 'final', path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
      res.end('<title>Final destination</title><h1>Cross-host final document</h1>');
    });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(profile, 'key'), '-out', path.join(profile, 'cert'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const tls = { key: fs.readFileSync(path.join(profile, 'key')), cert: fs.readFileSync(path.join(profile, 'cert')) };
    const secure = side => (req, res) => {
      seen.push({ side, path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
      res.end('<title>Private TLS</title><h1>Mapped TLS document</h1>');
    };
    tlsPort = await serve(https, '127.0.0.1', secure('tls-live'), 0, tls);
    await serve(https, '::1', secure('tls-host'), tlsPort, tls);
    const handler = side => (req, res) => {
      seen.push({ side, path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
      res.setHeader('Content-Type', 'text/html');
      if (redirects && ['/same', '/cross', '/tls-redirect'].includes(req.url)) {
        res.writeHead(req.url === '/same' ? 301 : 302, { Location: req.url === '/same' ? '/final' : req.url === '/cross' ? `http://[::1]:${finalPort}/final` : `https://localhost:${tlsPort}/final` });
        return res.end();
      }
      if (req.url === '/server-only') res.setHeader('Server', 'nginx/1.25.3');
      res.end(`<title>${side} ${req.url}</title><h1>${side} document</h1>`);
    };
    const port = await serve(http, '::1', handler('host'));
    await serve(http, '127.0.0.1', handler('live'), port);
    const home = `http://localhost:${port}`;
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sslPolicyVersion: 1, sslVerification: true, rules: [{ domain: 'localhost', ip: '::1', enabled: true, skipSSL: true }], tabs: [home + '/same'], onboardingCompleted: true, autoUpdates: false, autoUpdatesChosen: true }));
    app = await electron.launch({ executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: [...(process.getuid?.() === 0 ? ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs')] : []), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`], cwd: path.resolve(__dirname, '..'), env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    await app.evaluate(() => process.getBuiltinModule('dns').setDefaultResultOrder('ipv4first'));
    const ui = await app.firstWindow(); ui.setDefaultTimeout(15000);
    await ui.waitForFunction(() => window.browser);
    const cmd = (action, data) => ui.evaluate(([a, d]) => window.browser.command(a, d), [action, data]);
    const loaded = async url => {
      for (let n = 0; n < 150; n++) {
        if (await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].contentView.children.some(v => v.webContents.getURL() === target && !v.webContents.isLoading()), url)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Native fixture did not finish: ' + url);
    };
    for (const route of ['/same', '/cross', '/tls-redirect']) {
      redirects = false; await cmd('navigate', home + route); await loaded(home + route);
      await app.evaluate(({ session }, url) => session.fromPartition('persist:web').cookies.set({ url, name: 'private-fixture', value: 'never-send' }), home);
      const before = seen.length; redirects = true;
      const result = await cmd('differences-run'); assert.equal(result.ok, true, JSON.stringify(result));
      const report = result.report;
      assert.equal(report.hostfile.ok, true, JSON.stringify(report.hostfile));
      if (route === '/tls-redirect') {
        assert.equal(report.live.ok, false, 'Live redirect must not inherit the localhost Skip SSL rule');
        assert.match(report.live.error, /certificate|self.signed|CERT/i);
        assert.deepEqual(report.live.redirects, [{ status: 302, location: `https://localhost:${tlsPort}/final` }]);
        assert.ok(!seen.slice(before).some(r => r.side === 'tls-live'), 'untrusted Live TLS never reaches the HTTP handler');
      } else {
        assert.equal(report.live.ok, true, JSON.stringify(report.live));
        const finalUrl = route === '/same' ? home + '/final' : `http://[::1]:${finalPort}/final`;
        assert.equal(report.live.finalUrl, finalUrl);
        assert.deepEqual(report.live.redirects, [{ status: route === '/same' ? 301 : 302, location: finalUrl }]);
        assert.equal(report.live.ip, route === '/same' ? '127.0.0.1' : '::1', 'Live IP is the returned document socket, including cross-host redirects');
        assert.ok(seen.slice(before).some(r => r.path === '/final' && r.side === (route === '/same' ? 'live' : 'final')), 'real Live final endpoint was requested');
      }
      assert.ok(seen.slice(before).every(r => r.cookie === undefined && r.authorization === undefined), 'both anonymous sides omit saved cookies and Authorization');
    }
    const card = async () => {
      for (let n = 0; n < 100; n++) { const page = app.windows().find(p => p.url().includes('card.html')); if (page) return page; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('Native Site info card did not open');
    };
    const rows = async () => {
      const page = await card(); await page.locator('.connection-comparison').waitFor();
      return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.connection-comparison tbody tr')].map(tr => [tr.querySelector('th').textContent, [...tr.querySelectorAll('td')].map(td => td.querySelector('span')?.textContent)])));
    };
    redirects = false; await cmd('navigate', home + '/server-only'); await loaded(home + '/server-only');
    await ui.waitForFunction(async () => { const s = (await window.browser.command('state')).state; return s.tabs.find(t => t.id === s.activeId)?.site?.server === 'nginx'; });
    await ui.locator('#route-bar .site-btn').click();
    const serverRows = await rows();
    assert.deepEqual(serverRows['Web server'], ['nginx'], 'native Site info preserves observed server-only metadata');
    assert.deepEqual(serverRows.Type, ['Not detected']); assert.deepEqual(serverRows['PHP version'], ['Not detected']);
    await cmd('card-close'); await cmd('navigate', home + '/no-evidence'); await loaded(home + '/no-evidence');
    const state = (await cmd('state')).state; assert.equal(state.tabs.find(t => t.id === state.activeId).site, null, 'a truly unmarked page still has no detected stack');
    await ui.locator('#route-bar .site-btn').click();
    const emptyRows = await rows();
    for (const name of ['Web server', 'Type', 'PHP version']) assert.deepEqual(emptyRows[name], ['Not detected'], 'native card leaves unobserved ' + name + ' unknown');
    console.log('PASS: real Live 301/302 redirects, final socket IP, strict anonymous TLS despite Skip SSL, cookie isolation, and native server-only/no-evidence Site info.');
  } finally {
    if (app) await app.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exit(1); });
