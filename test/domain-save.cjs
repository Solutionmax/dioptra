// Real form submission must save and switch the endpoint in the same running app.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-domain-save-'));
  const servers = [], sockets = new Set(); let app;
  async function serve(ip, name, port = 0) {
    const server = http.createServer((req, res) => { res.setHeader('Cache-Control', 'no-store'); res.end(`<title>${name}</title><h1>${name}</h1>`); });
    servers.push(server); server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise(r => server.listen(port, ip, r)); return server.address().port;
  }
  try {
    const port = await serve('127.0.0.1', 'FIRST'); await serve('::1', 'SECOND', port);
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({rules:[],sslPolicyVersion:1,sslVerification:true,onboardingCompleted:true,tabs:[`http://127.0.0.1:${port}/unrelated`],autoUpdates:false,autoUpdatesChosen:true}));
    app = await electron.launch({chromiumSandbox:process.getuid?.()!==0,executablePath:process.env.DIOPTRA_TEST_EXECUTABLE||undefined,args:[...(process.getuid?.()===0?['--no-sandbox','-r',path.join(__dirname,'root-harness.cjs')]:[]),...(process.env.DIOPTRA_TEST_EXECUTABLE?[]:['.']),`--profile-dir=${profile}`],cwd:path.resolve(__dirname,'..')});
    assert.equal(await app.evaluate(()=>process.argv.includes('--no-sandbox')),process.getuid?.()===0,'only the explicit Linux root harness disables the native sandbox');
    const ui = await app.firstWindow(); ui.setDefaultTimeout(15000);
    const cmd = async (a,d) => {const result=await ui.evaluate(([a,d])=>window.browser.command(a,d),[a,d]);assert.equal(result.ok,true,result.error||a);return result;};
    // Await asynchronous state predicates before deciding whether to poll again.
    const until = async (predicate,arg) => {const end=Date.now()+15000;while(Date.now()<end){if(await ui.evaluate(predicate,arg))return;await new Promise(r=>setTimeout(r,100));}throw Error('Domain-save state did not become ready.');};
    await until(async()=>{const s=(await window.browser.command('state')).state;return s.tabs.some(t=>t.title==='FIRST'&&!t.loading);});
    for(let attempt=0;attempt<150;attempt++){const ready=await app.evaluate(({webContents})=>webContents.getAllWebContents().some(w=>w.getURL().endsWith('/unrelated')&&!w.isLoading()));if(ready)break;if(attempt===149)throw Error('Initial native page did not finish');await new Promise(r=>setTimeout(r,100));}
    const identity = await app.evaluate(({app,BrowserWindow,webContents})=>{
      globalThis.domainSaveQuitEvents=0;
      app.on('before-quit',()=>globalThis.domainSaveQuitEvents++);
      const page=webContents.getAllWebContents().find(w=>w.getURL().endsWith('/unrelated'));
      if(!page)throw Error('Native URLs: '+JSON.stringify(webContents.getAllWebContents().map(w=>w.getURL())));
      return page.executeJavaScript('window.domainSaveSentinel=42').then(()=>({pid:process.pid,window:BrowserWindow.getAllWindows()[0].id,page:page.id}));
    });
    await cmd('new-tab',`http://save-check.invalid:${port}/`);
    await until(async()=>{const s=(await window.browser.command('state')).state;return !!s.tabs.find(t=>t.id===s.activeId).error;});
    const target=(await cmd('state')).state.activeId;
    await ui.locator('#domains').click();
    await ui.locator('#domain-input').fill('save-check.invalid');
    await ui.locator('#ip-input').fill('127.0.0.1');
    await ui.locator('#save-rule').click();
    await until(async id=>{const s=(await window.browser.command('state')).state;const t=s.tabs.find(t=>t.id===id);return t.title==='FIRST'&&!t.loading&&!t.error&&s.rules.some(r=>r.domain==='save-check.invalid');},target);
    await ui.waitForFunction(()=>document.getElementById('domain-input').value==='');
    await ui.getByRole('button',{name:'Edit save-check.invalid',exact:true}).click();
    await ui.locator('#ip-input').fill('::1');
    await ui.locator('#save-rule').click();
    await until(async id=>{const s=(await window.browser.command('state')).state;const t=s.tabs.find(t=>t.id===id);return t.title==='SECOND'&&!t.loading&&!t.error&&t.connection?.ip==='::1';},target);
    await ui.waitForFunction(()=>document.getElementById('domain-input').value==='');
    assert.equal(await app.evaluate(({webContents})=>webContents.getAllWebContents().find(w=>w.getURL().includes('save-check.invalid')).executeJavaScript("document.querySelector('h1').textContent")),'SECOND','edited IP serves the second real endpoint');
    // Adding another domain must not reload the existing target or unrelated tab.
    await app.evaluate(({webContents},port)=>webContents.getAllWebContents().find(w=>w.getURL()===`http://save-check.invalid:${port}/`).executeJavaScript('window.targetSentinel=73'),port);
    await ui.locator('#domain-input').fill('another-save.invalid');
    await ui.locator('#ip-input').fill('127.0.0.1');
    await ui.locator('#save-rule').click();
    await until(async()=>{const s=(await window.browser.command('state')).state;return s.rules.length===2&&document.getElementById('domain-input').value==='';});
    const after=await app.evaluate(async({BrowserWindow,webContents},before)=>({pid:process.pid,window:BrowserWindow.getAllWindows()[0].id,page:webContents.fromId(before.page).id,sentinel:await webContents.fromId(before.page).executeJavaScript('window.domainSaveSentinel'),target:await webContents.getAllWebContents().find(w=>w.getURL().includes('save-check.invalid')).executeJavaScript('window.targetSentinel'),quitEvents:globalThis.domainSaveQuitEvents}),identity);
    assert.deepEqual(after,{...identity,sentinel:42,target:73,quitEvents:0});
    const saved=JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8'));
    assert.equal(saved.rules.find(r=>r.domain==='save-check.invalid').ip,'::1');
    assert.equal(saved.rules.find(r=>r.domain==='another-save.invalid').ip,'127.0.0.1');
    assert.equal((await cmd('state')).state.pending,false);
    assert.equal(await ui.getByRole('button',{name:/restart/i}).count(),0,'no restart button in Domains');
    console.log('PASS real Domains form: add + edit IP + add unrelated domain; same process/window; no quit; new endpoint loaded; other pages retained; both rules persisted; no restart control');
  } finally {
    if(app){const exited=new Promise(r=>app.process().exitCode!==null?r():app.process().once('exit',r));await app.evaluate(({app})=>app.quit()).catch(()=>{});await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>{app.process().kill('SIGKILL');reject(Error('App did not exit'));},15000).unref())]);}
    for(const socket of sockets)socket.destroy();for(const server of servers)await new Promise(r=>server.close(r));
    fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exit(1)});
