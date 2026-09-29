// Exercises the app updater using the packaged configuration and a local HTTPS feed.
// Runs under development Electron so root CI can load its test-only sandbox harness.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'migratie-update-'));
  const version = require('../package.json').version;
  const futureVersion = version.split('.').map((part, index) => index === 2 ? Number(part) + 1 : part).join('.');
  const artifact = path.join(root, `dist/Dioptra-${version}-linux-x86_64.AppImage`);
  const payload = fs.readFileSync(artifact);
  const sha512 = crypto.createHash('sha512').update(payload).digest('base64');
  const filename = `Dioptra-test-${futureVersion}.AppImage`;
  const metadata = `version: ${futureVersion}\nfiles:\n  - url: ${filename}\n    sha512: ${sha512}\n    size: ${payload.length}\npath: ${filename}\nsha512: ${sha512}\nreleaseDate: '2026-09-29T00:00:00.000Z'\n`;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(profile, 'key'), '-out', path.join(profile, 'cert'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(profile, 'key')), cert: fs.readFileSync(path.join(profile, 'cert')) }, (req, res) => {
    if (req.url.startsWith('/latest-linux.yml')) { res.setHeader('Content-Type', 'text/yaml'); res.end(metadata); }
    else if (req.url.startsWith('/' + filename)) { res.setHeader('Content-Length', payload.length); res.end(payload); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    app = await electron.launch({ cwd: root, args: [...(process.getuid?.() === 0 ? ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs')] : []), '.', `--profile-dir=${profile}`], env: { ...process.env, APPIMAGE: artifact }, timeout: 30000 });
    const ui = await app.firstWindow();
    await ui.getByRole('button', { name: 'Domains', exact: true }).waitFor();
    await app.evaluate(({ app }) => Object.defineProperty(app, 'isPackaged', { value: true }));
    await app.evaluate(({ app }) => app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => { if (new URL(url).hostname === '127.0.0.1') { event.preventDefault(); callback(true); } else callback(false); }));
    await app.evaluate(({ session }) => session.fromPartition('electron-updater').setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3)));
    const initial = (await ui.evaluate(() => window.browser.command('state'))).state;
    assert.equal(initial.updateFeed, 'https://github.com/Solutionmax/dioptra/releases/latest/download/', 'default feed');
    assert.equal(initial.autoUpdates, true, 'automatic checks default on');
    assert.equal(initial.update.canInstall, process.platform !== 'darwin');
    const feed = `https://127.0.0.1:${server.address().port}/`;
    assert.equal((await ui.evaluate(feed => window.browser.command('update-settings', { feed, automatic: false }), feed)).ok, true);
    await app.evaluate((_electron, paths) => { const require = process.getBuiltinModule('module').createRequire(paths.module + '/package.json'); require(paths.module).autoUpdater.updateConfigPath = paths.config; }, { module: path.join(root, 'node_modules/electron-updater'), config: path.join(root, 'dist/linux-unpacked/resources/app-update.yml') });
    await ui.getByRole('button', { name: 'Settings', exact: true }).click();
    await ui.getByRole('button', { name: 'Updates', exact: true }).click();
    await ui.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await ui.getByRole('heading', { name: 'An update is available' }).waitFor();
    const available = (await ui.evaluate(() => window.browser.command('state'))).state.update;
    assert.equal(available.status, 'available'); assert.equal(available.version, futureVersion);
    await ui.getByRole('button', { name: 'Download update', exact: true }).click();
    await ui.getByRole('heading', { name: 'Ready to restart' }).waitFor({ timeout: 60000 });
    assert.equal(await ui.getByRole('button', { name: 'Install and restart', exact: true }).isVisible(), true);
    assert.equal((await ui.evaluate(() => window.browser.command('state'))).state.update.status, 'downloaded');
    console.log('PASS: app updater with packaged config checks HTTPS feed; real AppImage downloaded and SHA512 verified; install intentionally not invoked.');
  } finally {
    if (app) await app.close();
    server.closeAllConnections(); server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
