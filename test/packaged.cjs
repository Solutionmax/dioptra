const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'migratie-packaged-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(profile, 'key.pem'), '-out', path.join(profile, 'cert.pem'), '-days', '1', '-subj', '/CN=wrong-host.invalid'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(profile, 'key.pem')), cert: fs.readFileSync(path.join(profile, 'cert.pem')) }, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Packaged browser test</title><h1>Packaged routing works</h1>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ rules: [{ domain: 'packaged.invalid', ip: '127.0.0.1', enabled: true }], tabs: [`https://packaged.invalid:${server.address().port}/`], updateFeed: '', autoUpdates: false, autoUpdatesChosen: true }));
  let app;
  try {
    app = await electron.launch({ executablePath: process.argv[2], chromiumSandbox: true, args: [`--profile-dir=${profile}`], timeout: 30000 });
    const ui = await app.firstWindow();
    await ui.getByRole('button', { name: 'Domains', exact: true }).waitFor();
    await ui.waitForFunction(() => document.querySelector('.tab-title')?.textContent.includes('Packaged browser test'));
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(await app.evaluate(() => process.argv.includes('--no-sandbox')), false);
    assert.match((await ui.evaluate(() => window.browser.command('state'))).state.updateFeed, /^https:\/\/github\.com\/Solutionmax\/dioptra\/releases\/latest\/download\/$/);
    assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().includes('packaged.invalid')).getLastWebPreferences().sandbox), true);
    console.log('PASS: packaged native app launches, sandbox enabled, DNS override and untrusted/mismatched HTTPS certificate work.', await ui.evaluate(async () => (await window.browser.command('state')).state.versions));
  } finally { if (app) await app.close(); server.closeAllConnections(); server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
