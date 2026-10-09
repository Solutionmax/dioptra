// The scene on the start page, end to end in the real app: it shows the user's rules and what is typed in the Domains
// form, pauses, makes room in a small window and is taken down as soon as a tab shows a website.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Scene fixture</title><h1>ok</h1>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-scene-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ rules: [{ domain: 'scene.invalid', ip: '203.0.113.9', enabled: true }, { domain: 'off.invalid', ip: '203.0.113.200', enabled: false }], updateFeed: '', autoUpdates: false, autoUpdatesChosen: true }));
  let app, child;
  try {
    // A test machine without a graphics card draws WebGL in software; a real one ignores the switch.
    app = await electron.launch({ timeout: 30000, executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: [...(process.getuid?.() === 0 ? ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs')] : []), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`, '--enable-unsafe-swiftshader'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    child = app.process(); // Playwright may disconnect before teardown; keep the real subprocess handle.
    const ui = await app.firstWindow(); ui.setDefaultTimeout(15000);
    // Errors, and the warning Chromium gives when a page holds on to too many WebGL contexts.
    const problems = []; ui.on('console', message => { if (message.type() === 'error' || /too many active webgl contexts/i.test(message.text())) problems.push(message.text()); }); ui.on('pageerror', error => problems.push(String(error)));
    const cmd = (action, data) => ui.evaluate(([a, d]) => window.browser.command(a, d), [action, data]);
    const labels = () => ui.evaluate(() => [...document.querySelectorAll('#scene .tag3d')].map(node => node.textContent));
    const resize = (width, height) => app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await ui.waitForFunction(() => window.browser && !document.getElementById('welcome').hidden);
    // The bridge exists before the initial UI load resolves. Reloading then aborts main's awaited startup load.
    await ui.waitForLoadState('load');
    await ui.waitForFunction(async () => (await window.browser.command('state')).state.tabs.length > 0);
    // Counts what is really drawn, so "stands still" and "taken down" are measured on the canvas, not on the labels.
    await ui.addInitScript(() => { window.sceneDraws = 0; for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) for (const name of ['drawArrays', 'drawElements']) { const real = proto[name]; proto[name] = function (...args) { window.sceneDraws++; return real.apply(this, args); }; } });
    // Track real media listeners across later mounts; forwarding preserves Chromium's media-query behavior.
    await ui.addInitScript(() => {
      window.sceneMotionListeners = new Set();
      for (const name of ['addEventListener', 'removeEventListener']) {
        const real = MediaQueryList.prototype[name];
        MediaQueryList.prototype[name] = function (type, listener, ...args) {
          if (type === 'change' && this.media === '(prefers-reduced-motion: reduce)') window.sceneMotionListeners[name === 'addEventListener' ? 'add' : 'delete'](listener);
          return real.call(this, type, listener, ...args);
        };
      }
    });
    await ui.reload();
    await ui.waitForFunction(() => window.browser && !document.getElementById('welcome').hidden);
    const draws = ms => ui.evaluate(async wait => { const before = window.sceneDraws; await new Promise(resolve => setTimeout(resolve, wait)); return window.sceneDraws - before; }, ms);
    // The frame that was already on its way when the scene went away may still land; after that there must be none.
    const quiet = async what => { await new Promise(resolve => setTimeout(resolve, 300)); const count = await draws(600); assert.equal(count, 0, `${what} (${count} draw calls in 0.6 s)`); };
    await resize(1380, 860);
    assert.ok(await ui.locator('#welcome .welcome-copy h1').isVisible(), 'the start page still has its headline');

    if (!await ui.evaluate(() => { const probe = document.createElement('canvas'); return Boolean(probe.getContext('webgl2') || probe.getContext('webgl')); })) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(await ui.locator('#welcome.has-scene').count(), 0, 'without WebGL there is no scene');
      assert.ok(await ui.locator('.welcome-notes').isVisible(), 'without WebGL the start page keeps its three notes');
      assert.deepEqual(problems, [], 'without WebGL nothing fails');
      console.log('PASS: no WebGL on this machine, the start page stays as it was.');
      return;
    }

    await ui.waitForSelector('#welcome.has-scene');
    await ui.waitForFunction(() => document.querySelector('#scene .tag3d')?.textContent === 'scene.invalid');
    assert.deepEqual(await labels(), ['scene.invalid', 'Rule → 203.0.113.9', 'Live', 'New server · 203.0.113.9'], 'the scene shows the enabled rule, not the disabled one');
    const box = await ui.locator('#scene canvas').boundingBox(), text = await ui.locator('.welcome-copy').boundingBox();
    assert.ok(box.width > 300 && box.height > 250, `the scene has a real size (${box.width} x ${box.height})`);
    assert.ok(box.x >= text.x + text.width, 'in a wide window the scene stands beside the text');
    assert.ok(await ui.locator('.welcome-notes').isVisible(), 'beside the text the three notes stay');
    const moving = await draws(700);
    assert.ok(moving > 50, `the scene draws and keeps drawing (${moving} draw calls in 0.7 s)`);

    // A live system preference change stops ongoing drawing, and reverting it resumes the same mounted scene.
    await ui.emulateMedia({ reducedMotion: 'reduce' });
    await quiet('live reduced motion stops animation');
    assert.equal(await ui.locator('#scene-pause').isVisible(), false, 'reduced motion hides the pause control');
    await ui.emulateMedia({ reducedMotion: 'no-preference' });
    await ui.waitForSelector('#scene-pause');
    assert.ok(await draws(700) > 50, 'normal motion resumes animation');

    // What is typed in the Domains form shows in the scene before it is saved.
    await ui.click('#welcome-domains'); await ui.waitForSelector('#rule-form');
    await ui.fill('#domain-input', 'https://Typed.Example/path'); await ui.fill('#ip-input', '2001:db8::7');
    await ui.waitForFunction(() => document.querySelector('#scene .tag3d')?.textContent === 'typed.example');
    assert.deepEqual(await labels(), ['typed.example', 'Rule → 2001:db8::7', 'Live', 'New server · 2001:db8::7'], 'the scene follows the form');
    await resize(1300, 900);
    await ui.locator('#scene canvas').waitFor({state:'visible'});
    const stacked = await ui.locator('#scene canvas').boundingBox(), copy = await ui.locator('.welcome-copy').boundingBox();
    assert.ok(stacked.y >= copy.y + copy.height - 1, 'with the panel open the scene moves under the text');
    assert.equal(await ui.locator('.welcome-notes').isVisible(), false, 'under the text the scene takes the place of the three notes');
    await ui.fill('#domain-input', ''); await ui.fill('#ip-input', ''); await ui.click('#close-panel'); await resize(1380,860);
    await ui.waitForFunction(() => document.querySelector('#scene .tag3d')?.textContent === 'scene.invalid');

    // Pause stops the drawing; a state update may still draw one frame so a changed rule shows.
    await ui.click('#scene-pause');
    assert.equal(await ui.textContent('#scene-pause span'), 'Play animation');
    const paused = await draws(700);
    assert.ok(paused * 10 < moving, `a paused scene stands still (${paused} draw calls in 0.7 s, ${moving} while moving)`);
    // Paused means paused: state updates from the app (here: a panel opening and closing) must not nudge the scene along.
    const place = () => ui.evaluate(() => [...document.querySelectorAll('#scene .tag3d')].map(node => node.style.transform).join(' '));
    const before = await place();
    await cmd('panel', 'settings'); await cmd('panel', null); await cmd('panel', 'settings'); await cmd('panel', null);
    await ui.waitForFunction(() => document.getElementById('scene').getBoundingClientRect().left > document.querySelector('.welcome-copy').getBoundingClientRect().right);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await place(), before, 'state updates do not move a paused scene');
    assert.equal(await ui.locator('#scene-pause[aria-pressed]').count(), 0, 'the pause button says what it does in its label, not in a pressed state as well');
    await ui.emulateMedia({ reducedMotion: 'reduce' });
    await quiet('reduced motion also stays still after manual pause');
    await ui.emulateMedia({ reducedMotion: 'no-preference' });
    await ui.waitForSelector('#scene-pause');
    assert.equal(await ui.textContent('#scene-pause span'), 'Play animation', 'media changes preserve manual pause');
    await quiet('normal motion does not override manual pause');
    await ui.click('#scene-pause');
    assert.equal(await ui.textContent('#scene-pause span'), 'Pause animation');
    assert.ok(await draws(700) > 50, 'the scene moves again');

    // No room (a short window with the panel open): the start page is as it was.
    await resize(1000, 700); assert.ok((await cmd('panel', 'domains')).ok);
    await ui.waitForFunction(() => document.getElementById('scene').offsetWidth === 0);
    assert.ok(await ui.locator('.welcome-notes').isVisible(), 'without room for the scene the three notes are back');
    await quiet('a scene that is not shown draws nothing');
    assert.ok((await cmd('panel', null)).ok); await resize(1380, 860);
    await ui.waitForFunction(() => document.getElementById('scene').offsetWidth > 300);

    // A website takes the scene down, a new tab brings it back.
    assert.ok((await cmd('navigate', `http://127.0.0.1:${server.address().port}/`)).ok);
    await ui.waitForFunction(() => document.getElementById('welcome').hidden && !document.getElementById('welcome').classList.contains('has-scene'));
    assert.deepEqual(await labels(), [], 'a tab with a website takes the scene down');
    await quiet('a scene that was taken down draws nothing');
    assert.ok((await cmd('new-tab')).ok);
    await ui.waitForSelector('#welcome.has-scene');
    assert.equal(await ui.evaluate(() => window.sceneMotionListeners.size), 1, 'a mounted scene has one motion listener');
    // Going back and forth between a website and the start page many times must not pile up WebGL contexts.
    const [site, start] = await ui.evaluate(() => state.tabs.map(tab => tab.id));
    for (let round = 0; round < 20; round++) {
      await cmd('activate', site); await ui.waitForFunction(() => !document.getElementById('welcome').classList.contains('has-scene'));
      assert.equal(await ui.evaluate(() => window.sceneMotionListeners.size), 0, 'taking the scene down removes its motion listener');
      await cmd('activate', start); await ui.waitForSelector('#welcome.has-scene');
      assert.equal(await ui.evaluate(() => window.sceneMotionListeners.size), 1, 'remounting does not pile up motion listeners');
    }
    await ui.waitForFunction(() => document.querySelector('#scene .tag3d')?.textContent === 'scene.invalid');
    assert.ok(await draws(700) > 50, 'after 20 rounds the scene still draws');
    await ui.emulateMedia({ reducedMotion: 'reduce' });
    await quiet('remounted scene follows live reduced motion');
    await cmd('activate', site);
    await ui.waitForFunction(() => !document.getElementById('welcome').classList.contains('has-scene'));
    await ui.emulateMedia({ reducedMotion: 'no-preference' });
    await quiet('a media change cannot restart an unmounted scene');
    await ui.emulateMedia({ reducedMotion: 'reduce' });
    await cmd('activate', start); await ui.waitForSelector('#welcome.has-scene');
    await quiet('a scene mounted with reduced motion starts still');
    assert.equal(await ui.locator('#scene-pause').isVisible(), false);
    await ui.emulateMedia({ reducedMotion: 'no-preference' });
    await ui.waitForSelector('#scene-pause');
    assert.ok(await draws(700) > 50, 'a scene mounted still can resume on a live media change');
    assert.deepEqual(problems, [], 'no errors in the window (three.js loads from the app itself, inside the content security policy)');
    console.log('PASS: scene shows rules and typed values, respects live reduced motion and manual pause, and cleans up across 20 mount cycles.');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); let timer;
      try { await Promise.race([app.evaluate(({ app }) => app.quit()).catch(() => {}).then(() => exited), exited, new Promise(resolve => { timer = setTimeout(resolve, 15000); })]); }
      finally { clearTimeout(timer); }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Scene test subprocess did not exit after SIGKILL')), 5000); })]); }
        finally { clearTimeout(timer); }
      }
    }
    server.closeAllConnections(); server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
