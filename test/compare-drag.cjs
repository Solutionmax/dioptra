// Real mouse drag of the bar between the Compare panes. The websites are native views on top of the page, so only
// real input shows that the drag keeps going while the pointer is over them. Linux only: needs xdotool and a window
// manager, for example: xvfb-run -a sh -c 'openbox & sleep 1; npm run test:drag'. DRAG_SHOTS=<dir> saves screenshots.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  try { execFileSync('xdotool', ['version'], { stdio: 'ignore' }); } catch { console.log('SKIP compare drag: xdotool not found'); return; }
  const xdo = (...args) => execFileSync('xdotool', args.map(String));
  const shots = process.env.DRAG_SHOTS;
  const shot = name => { if (shots) execFileSync('import', ['-window', 'root', path.join(shots, name)]); };
  const page = name => `<title>${name}</title><body style="font:16px sans-serif;margin:40px;background:#faf5ef"><h1>Northwind Bakery</h1><p>${name}</p>`;
  const server = http.createServer((req, res) => res.end(page(req.headers.host.startsWith('localhost') ? 'New server' : 'Current server')));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-drag-'));
  const settings = path.join(profile, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ autoUpdates: false, autoUpdatesChosen: true, rules: [{ domain: 'localhost', ip: '127.0.0.1', enabled: true }], tabs: [`http://localhost:${port}/`] }));
  const app = await electron.launch({ executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: [...(process.getuid?.() === 0 ? ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs')] : []), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`], cwd: path.resolve(__dirname, '..') });
  try {
    const ui = await app.firstWindow(); ui.setDefaultTimeout(15000);
    await ui.waitForFunction(() => window.browser);
    const state = async () => (await ui.evaluate(() => window.browser.command('state'))).state;
    const until = async (check, what) => { const end = Date.now() + 15000; while (Date.now() < end) { if (await check(await state())) return; await sleep(100); } throw new Error('Timed out: ' + what); };
    const percent = async () => Math.round((await state()).compareRatio * 100);
    await until(s => s.tabs.some(t => t.title === 'New server' && !t.loading), 'first page');
    await ui.evaluate(() => window.browser.command('compare'));
    await until(s => s.paneLayout.length === 2 && s.tabs.filter(t => !t.loading && t.connection).length === 2, 'two panes');
    await app.evaluate(({ BaseWindow }) => { const win = BaseWindow.getAllWindows()[0]; win.show(); win.focus(); });
    await sleep(800);
    const origin = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentBounds());
    const at = (x, y) => xdo('mousemove', Math.round(origin.x + x), Math.round(origin.y + y));
    const bar = ui.locator('#compare-splitter');
    const websites = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].contentView.children.filter(v => v.webContents.getURL().includes('localhost:') || v.webContents.getURL().includes('127.0.0.1:')).map(v => ({ ...v.getBounds(), visible: v.getVisible() })).sort((a, b) => a.x - b.x));
    assert.equal(await percent(), 50);
    let box = await bar.boundingBox(); const width = (await state()).paneLayout.reduce((most, pane) => Math.max(most, pane.page.x + pane.page.width), 0);

    // Drag to the right, over the right website: the left pane grows while the button is still down.
    at(box.x + 3, box.y + 300); await sleep(200); xdo('mousedown', 1); await sleep(200);
    for (const share of [.55, .62, .7]) { at(width * share, box.y + 320); await sleep(250); assert.equal(await percent(), Math.round(share * 100), `the bar follows the pointer to ${share}`); }
    let views = await websites();
    assert.equal(views.length, 2); assert.ok(views.every(v => v.visible), 'both websites stay visible while dragging');
    assert.ok(views[0].width > views[1].width * 2, 'the left website is resized during the drag'); assert.equal(views[0].width + 6, views[1].x);
    assert.ok(await bar.evaluate(node => node.classList.contains('dragging'))); assert.equal(await ui.locator('#compare-share').textContent(), '70 · 30');
    assert.notEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).compareRatio, .7, 'nothing is saved before release');
    shot('compare-drag-1-dragging.png');
    xdo('mouseup', 1); await sleep(400);
    assert.equal(await percent(), 70, 'release keeps the position'); assert.ok(!await bar.evaluate(node => node.classList.contains('dragging')));
    assert.equal(Math.round(JSON.parse(fs.readFileSync(settings, 'utf8')).compareRatio * 100), 70, 'release saves the position');
    assert.ok(await ui.locator('#compare-reset').isVisible());
    assert.ok(!await bar.evaluate(node => node.matches(':focus-visible')), 'no focus ring left behind after a mouse drag');
    at(width * .2, box.y + 500); await sleep(300); shot('compare-drag-2-released.png');

    // Escape while dragging puts the bar back where the drag started.
    box = await bar.boundingBox();
    at(box.x + 3, box.y + 400); await sleep(200); xdo('mousedown', 1); await sleep(200);
    at(width * .45, box.y + 400); await sleep(300); assert.equal(await percent(), 45);
    xdo('key', 'Escape'); await sleep(400); assert.equal(await percent(), 70, 'Escape cancels the drag');
    at(width * .3, box.y + 400); await sleep(300); xdo('mouseup', 1); await sleep(300);
    assert.equal(await percent(), 70, 'moving on after Escape changes nothing'); assert.equal(Math.round(JSON.parse(fs.readFileSync(settings, 'utf8')).compareRatio * 100), 70);

    // Drag to the far left, over the left website: the left pane stops at a quarter.
    box = await bar.boundingBox();
    at(box.x + 3, box.y + 400); await sleep(200); xdo('mousedown', 1); await sleep(200);
    at(width * .4, box.y + 400); await sleep(250); at(20, box.y + 400); await sleep(300);
    assert.equal(await percent(), 25, 'a pane keeps at least a quarter'); xdo('mouseup', 1); await sleep(400);
    views = await websites(); assert.ok(views[1].width > views[0].width * 2, 'now the right website is larger');

    // The reset button and a double click on the bar make the panes equal again.
    box = await ui.locator('#compare-reset').boundingBox();
    at(box.x + box.width / 2, box.y + box.height / 2); await sleep(200); xdo('click', 1); await sleep(400);
    assert.equal(await percent(), 50, 'the reset button makes the panes equal');
    views = await websites(); assert.ok(Math.abs(views[0].width - views[1].width) <= 1);
    shot('compare-drag-3-reset.png');
    await ui.evaluate(() => window.browser.command('compare-ratio', { ratio: .6 })); await sleep(300);
    box = await bar.boundingBox(); at(box.x + 3, box.y + 400); await sleep(200); xdo('click', '--repeat', 2, '--delay', 80, 1); await sleep(400);
    assert.equal(await percent(), 50, 'a double click on the bar makes the panes equal');
    console.log('PASS compare drag with a real mouse: live resize over both websites, Escape, limits, save on release, reset button, double click');
  } finally {
    // Wait for the app to be gone before removing its profile, it still writes while quitting.
    const exited = new Promise(r => (app.process().exitCode !== null ? r() : app.process().once('exit', r)));
    await app.evaluate(({ app }) => app.quit()).catch(() => {}); await Promise.race([exited, sleep(8000)]);
    server.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exit(1); });
