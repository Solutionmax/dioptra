// Quit while the window is still loading: Dioptra must exit at once and keep the saved tabs.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Early quit fixture</title><h1>ok</h1>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tabs = ['a', 'b'].map(name => `http://127.0.0.1:${server.address().port}/${name}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-early-quit-')), settingsFile = path.join(profile, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ rules: [], tabs, autoUpdates: false, autoUpdatesChosen: true }));
  try {
    for (let round = 1; round <= 3; round++) {
      const app = await electron.launch({ executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: [...(process.getuid?.() === 0 ? ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs')] : []), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`], cwd: path.resolve(__dirname, '..') });
      await app.firstWindow();
      const exited = new Promise(resolve => app.process().once('exit', () => resolve(true)));
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      const quit = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(false), 15000))]);
      if (!quit) app.process().kill('SIGKILL');
      assert.ok(quit, `round ${round}: Dioptra quits within 15 s when asked during startup`);
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).tabs, tabs, `round ${round}: saved tabs survive a quit during startup`);
    }
    console.log('PASS: quit during startup exits at once and keeps the saved tabs (3 rounds).');
  } finally {
    server.closeAllConnections(); server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
