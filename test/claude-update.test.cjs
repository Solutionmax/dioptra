const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClaudeUpdates, recoverClaudeUpdate, compareVersions } = require('../src/claude-update.cjs');
const { readSettings, saveSettings, devtoolsLayout } = require('../src/core.cjs');

async function fixture(t, options = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dioptra-claude-update-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const destination = path.join(profile, 'claude-extension');
  async function write(directory, version) { await fs.mkdir(directory, {recursive:true}); await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({version})); await fs.writeFile(path.join(directory, 'worker.js'), version); }
  await write(destination, '1.9.0');
  let running = '1.9.0', nextVersion = '1.10.0', loads = 0;
  const manager = createClaudeUpdates({ profile, getVersion: () => running,
    stage: async () => { if (options.stage) await options.stage(); const directory = await fs.mkdtemp(path.join(profile, 'claude-stage-')); await write(directory, nextVersion); return {directory, version:nextVersion}; },
    unload: async () => { running = null; },
    load: async directory => { const {version} = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); loads++; if (options.failVersion === version) throw new Error('Panel could not reopen'); running = version; return {version}; }
  });
  return {manager, profile, destination, write, running:()=>running, loads:()=>loads, next:version=>{nextVersion=version;}};
}

test('check stages newer numeric version without changing installed files or runtime', async t => {
  const f = await fixture(t);
  await f.manager.check();
  assert.equal(f.manager.state.status, 'available');
  assert.equal(f.manager.state.version, '1.10.0');
  assert.ok(Number.isFinite(Date.parse(f.manager.state.checkedAt)));
  assert.equal(await fs.readFile(path.join(f.destination, 'worker.js'),'utf8'), '1.9.0');
  assert.equal(f.running(), '1.9.0'); assert.equal(f.loads(), 0);
  await f.manager.install();
  assert.equal(f.running(), '1.10.0');
  assert.equal(await fs.readFile(path.join(f.destination, 'worker.js'),'utf8'), '1.10.0');
  assert.equal(f.manager.state.status, 'current');
  assert.deepEqual(await fs.readdir(f.profile), ['claude-extension']);
});

test('equal or older versions never become installable', async t => {
  const f = await fixture(t);
  for (const version of ['1.9', '1.8.99']) {
    f.next(version); await f.manager.check();
    assert.equal(f.manager.state.status, 'current');
    await assert.rejects(f.manager.install(), /Check for.*update|No.*update/i);
    assert.equal(f.running(), '1.9.0');
    assert.deepEqual(await fs.readdir(f.profile), ['claude-extension']);
  }
  assert.equal(compareVersions('1.10', '1.9.99'), 1);
  for (const version of ['v1.2', '1.2-beta', '', '1.2.3.4.5', '65536']) assert.throws(()=>compareVersions(version, '1.0'), /version/i);
});

test('load or panel failure restores previous files and reloads old extension', async t => {
  const f = await fixture(t, {failVersion:'1.10.0'});
  await f.manager.check();
  await assert.rejects(f.manager.install(), /Panel could not reopen/);
  assert.equal(await fs.readFile(path.join(f.destination, 'worker.js'),'utf8'), '1.9.0');
  assert.equal(f.running(), '1.9.0'); assert.equal(f.loads(), 2);
  assert.equal(f.manager.state.status, 'error');
  assert.match(f.manager.state.message, /restored/i);
  assert.deepEqual(await fs.readdir(f.profile), ['claude-extension']);
});

test('failed first install preserves an existing installation too', async t => {
  const f = await fixture(t, {failVersion:'1.10.0'});
  await assert.rejects(f.manager.install({initial:true}), /Panel could not reopen/);
  assert.equal(f.running(), '1.9.0');
  assert.equal(await fs.readFile(path.join(f.destination, 'worker.js'),'utf8'), '1.9.0');
});

test('check failure leaves running extension intact and clears installable candidate', async t => {
  let fail = false;
  const f = await fixture(t, {stage:async()=>{if(fail) throw new Error('Signature invalid');}});
  await f.manager.check(); fail = true;
  await assert.rejects(f.manager.check(), /Signature invalid/);
  assert.equal(f.manager.state.status, 'error');
  await assert.rejects(f.manager.install(), /Check for.*update|No.*update/i);
  assert.equal(f.running(), '1.9.0'); assert.equal(f.loads(), 0);
  assert.deepEqual(await fs.readdir(f.profile), ['claude-extension']);
});

test('remove, reload, update and second check cannot race a pending check', async t => {
  let release; const gate = new Promise(resolve=>{release=resolve;});
  const f = await fixture(t, {stage:()=>gate});
  const check = f.manager.check();
  assert.equal(f.manager.busy, true);
  await assert.rejects(f.manager.check(), /Wait/);
  await assert.rejects(f.manager.install(), /Wait/);
  await assert.rejects(f.manager.run(()=>fs.rm(f.destination,{recursive:true})), /Wait/);
  release(); await check;
  await f.manager.run(async()=>{await fs.rm(f.destination,{recursive:true}); await f.manager.clear();});
  assert.deepEqual(await fs.readdir(f.profile), []);
  assert.equal(f.manager.state.status, 'idle');
});

test('interrupted swap restores old directory before startup and removes abandoned stages', async t => {
  const f = await fixture(t);
  await fs.rename(f.destination, path.join(f.profile, 'claude-extension-backup'));
  await f.write(f.destination, '1.10.0');
  await f.write(path.join(f.profile, 'claude-stage-abandoned'), '1.11.0');
  await recoverClaudeUpdate(f.profile);
  assert.equal(await fs.readFile(path.join(f.destination, 'worker.js'), 'utf8'), '1.9.0');
  assert.deepEqual(await fs.readdir(f.profile), ['claude-extension']);
});

test('automatic Claude checks default on independently and explicit choice survives restart', async t => {
  const f = await fixture(t); const file = path.join(f.profile, 'settings.json');
  assert.equal(readSettings(file).claudeAutoCheck, true);
  saveSettings(file, {...readSettings(file), claudeAutoCheck:false});
  assert.equal(readSettings(file).claudeAutoCheck, false);
  await fs.writeFile(file, JSON.stringify({rules:[], autoUpdates:false, autoUpdatesChosen:true}));
  assert.equal(readSettings(file).claudeAutoCheck, true);
});

test('native page and inspector end above 42px footer', () => {
  for (const dock of ['left','right','bottom']) for (const open of [false,true]) {
    const bounds = devtoolsLayout(1200,900,380,dock,.4,open);
    const bottom = Math.max(bounds.page.y+bounds.page.height, bounds.tools ? bounds.tools.y+bounds.tools.height : 0);
    assert.equal(bottom, 858);
  }
});

test('partial unload failure reloads previous installation without touching its files', async t => {
  const f = await fixture(t); let running = true, attempts = 0;
  const manager = createClaudeUpdates({profile:f.profile, getVersion:()=> '1.9.0', stage:async()=>{const directory=await fs.mkdtemp(path.join(f.profile,'claude-stage-')); await f.write(directory,'1.10.0'); return {directory,version:'1.10.0'};}, unload:async()=>{running=false;if(++attempts===1)throw new Error('View close failed');}, load:async()=>{running=true;return {version:'1.9.0'};}});
  await manager.check(); await assert.rejects(manager.install(), /View close failed/);
  assert.equal(running, true);
  assert.equal(await fs.readFile(path.join(f.destination,'worker.js'),'utf8'), '1.9.0');
});

test('staging rejects HTTP redirects, failed downloads and unverified payloads before file writes', async t => {
  const {stageClaude} = require('../src/claude-install.cjs'); const f=await fixture(t);
  for (const [response,error] of [
    [new Response('', {status:302,headers:{location:'http://clients2.googleusercontent.com/unsafe.crx'}}), /HTTPS/],
    [new Response('', {status:503}), /503/],
    [new Response(Buffer.from('untrusted extension')), /Invalid Chrome extension/]
  ]) {
    await assert.rejects(stageClaude(f.profile, async(url,options)=>{
      assert.equal(new URL(url).origin,'https://clients2.google.com');
      assert.equal(options.redirect,'manual'); assert.equal(options.credentials,'omit');
      return response;
    }),error);
    assert.deepEqual(await fs.readdir(f.profile), ['claude-extension']);
  }
});

test('missing staged directory during swap restores old files and runtime', async t => {
  const f=await fixture(t); await f.manager.check();
  const staged=(await fs.readdir(f.profile)).find(name=>name.startsWith('claude-stage-'));
  await fs.rm(path.join(f.profile,staged),{recursive:true});
  await assert.rejects(f.manager.install(),/ENOENT/);
  assert.equal(await fs.readFile(path.join(f.destination,'worker.js'),'utf8'),'1.9.0');
  assert.equal(f.running(),'1.9.0');
  assert.deepEqual(await fs.readdir(f.profile),['claude-extension']);
});
