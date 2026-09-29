// Real cookie stores and a real restart; synthetic cookies, never account credentials.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dioptra-session-test-'));
  const root = process.platform === 'linux' && process.getuid() === 0;
  let app;
  const launch = async (executable = process.env.CLAUDE_TEST_EXECUTABLE) => {
    app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), cwd: path.join(__dirname, '..'), args: [...(root ? ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs')] : []), ...(executable ? [] : ['.']), `--profile-dir=${profile}`] });
    await (await app.firstWindow()).getByRole('button', { name: 'Claude', exact: true }).waitFor();
  };
  const read = (partition, name) => app.evaluate(async ({ session }, { partition, name }) => session.fromPartition(partition).cookies.get({ name }), { partition, name });
  const set = (partition, cookie) => app.evaluate(async ({ session }, { partition, cookie }) => session.fromPartition(partition).cookies.set(cookie), { partition, cookie });
  const waitCookie = async (partition, name, value) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if ((await read(partition, name))[0]?.value === value) return;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal((await read(partition, name))[0]?.value, value, `Claude session shared with ${partition}`);
  };
  const cookie = { url: 'https://claude.ai/', name: 'dioptra-test-session', value: 'synthetic-login', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: Math.floor(Date.now() / 1000) + 3600 };
  try {
    if (process.env.CLAUDE_PREVIOUS_EXECUTABLE) {
      await launch(process.env.CLAUDE_PREVIOUS_EXECUTABLE);
      await set('persist:claude-auth', cookie);
      await app.evaluate(async ({ session }) => session.fromPartition('persist:claude-auth').cookies.flushStore());
      await app.close(); app = null;
      await launch();
      await waitCookie('persist:web', cookie.name, cookie.value);
      await app.close(); app = null;
      console.log('Existing login cookie migrated from previous app version.');
    }
    await launch();
    await set('persist:claude-auth', cookie);
    await waitCookie('persist:web', cookie.name, cookie.value);
    const stored = (await read('persist:web', cookie.name))[0];
    assert.equal(stored.secure, true); assert.equal(stored.httpOnly, true);
    assert.equal(stored.hostOnly, true); assert.equal(stored.sameSite, cookie.sameSite);
    await set('persist:claude-auth', { ...cookie, url: 'https://accounts.google.com/', name: 'unrelated-test' });
    assert.equal((await read('persist:web', 'unrelated-test')).length, 0, 'Other provider cookies stay isolated');
    await set('persist:claude-auth', { ...cookie, name: 'scoped-test', domain: '.claude.ai', path: '/oauth' });
    await waitCookie('persist:web', 'scoped-test', cookie.value);
    assert.equal((await read('persist:web', 'scoped-test'))[0].path, '/oauth');
    assert.equal((await read('persist:web', 'scoped-test'))[0].hostOnly, false);
    // Hold an in-flight rotation while the user logs out in the other partition.
    await set('persist:claude-auth', { ...cookie, name: 'race-test' });
    await waitCookie('persist:web', 'race-test', cookie.value);
    await app.evaluate(({ session }) => {
      const cookies = session.fromPartition('persist:web').cookies;
      const get = cookies.get.bind(cookies);
      cookies.get = async filter => {
        if (filter.name === 'race-test') {
          cookies.get = get;
          await new Promise(resolve => { globalThis.releaseCookieTest = resolve; });
        }
        return get(filter);
      };
    });
    await set('persist:claude-auth', { ...cookie, name: 'race-test', value: 'next' });
    const end = Date.now() + 5000;
    while (!await app.evaluate(() => Boolean(globalThis.releaseCookieTest))) {
      assert.ok(Date.now() < end, 'Rotation reached target cookie store');
      await new Promise(r => setTimeout(r, 20));
    }
    await app.evaluate(async ({ session }) => {
      await session.fromPartition('persist:web').cookies.remove('https://claude.ai/', 'race-test');
      globalThis.releaseCookieTest(); delete globalThis.releaseCookieTest;
    });
    await waitCookie('persist:claude-auth', 'race-test', undefined);
    await waitCookie('persist:web', 'race-test', undefined);
    await app.close(); app = null;
    await launch();
    await waitCookie('persist:claude-auth', cookie.name, cookie.value);
    await waitCookie('persist:web', cookie.name, cookie.value);
    await set('persist:web', { ...cookie, value: 'rotated' });
    await waitCookie('persist:claude-auth', cookie.name, 'rotated');
    await app.evaluate(async ({ session }, name) => session.fromPartition('persist:web').cookies.remove('https://claude.ai/', name), cookie.name);
    await waitCookie('persist:claude-auth', cookie.name, undefined);
    await app.close(); app = null;
    await launch();
    assert.equal((await read('persist:claude-auth', cookie.name)).length, 0, 'Logout survives restart');
    assert.equal((await read('persist:web', cookie.name)).length, 0, 'Logout cannot restore an old session');
    const ui = await app.firstWindow();
    assert.equal(await ui.locator('#claude').innerText(), '');
    assert.equal(await ui.locator('#claude img').evaluate(img => img.complete && img.naturalWidth > 0), true);
    console.log('Claude cookie sharing, rotation, restart, logout, isolation and toolbar icon passed.');
  } finally { await app?.close(); await fs.rm(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
