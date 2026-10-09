const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync }=require('node:child_process');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-compact-'));
  const handler = (req, res) => { res.setHeader('Cache-Control', 'public, max-age=3600'); res.setHeader('X-Powered-By', 'PHP/8.3.12'); res.end('<title>Compact fixture</title><meta name="generator" content="WordPress 6.8.3"><meta name="generator" content="Elementor 3.32.1"><link href="/wp-content/themes/hearth/style.css"><script src="/wp-content/plugins/woocommerce/a.js"></script><h1>Real fixture</h1>'); };
  const host = http.createServer(handler); await new Promise(r => host.listen(0, '::1', r));
  const port = host.address().port, live = http.createServer(handler); await new Promise(r => live.listen(port, '127.0.0.1', r));
  const home = `http://localhost:${port}/`;
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({sslPolicyVersion:1, sslVerification:true, rules:[{domain:'localhost',ip:'::1',enabled:true,www:false,skipSSL:false}], tabs:[home],autoUpdates:false,autoUpdatesChosen:true}));
  const app = await electron.launch({executablePath:process.env.DIOPTRA_TEST_EXECUTABLE||undefined,args:[...(process.getuid?.()===0?['--no-sandbox','-r',path.join(__dirname,'root-harness.cjs')]:[]),...(process.env.DIOPTRA_TEST_EXECUTABLE?[]:['.']),`--profile-dir=${profile}`],cwd:path.resolve(__dirname,'..')});
  try {
    const ui = await app.firstWindow(); ui.setDefaultTimeout(15000);
    const cmd = async (a,d) => { const result=await ui.evaluate(([a,d]) => window.browser.command(a,d),[a,d]); assert.equal(result.ok,true,result.error||a); return result; };
    // Playwright's renderer poll treats async predicates as truthy Promises.
    const until = async (predicate, arg) => { const end=Date.now()+15000; do { if(await ui.evaluate(predicate,arg))return; await new Promise(resolve=>setTimeout(resolve,50)); } while(Date.now()<end); throw new Error('Browser state did not become ready.'); };
    // tab.url is optimistic; wait for the native page to finish before opening an overlay.
    const pageLoaded = async (url, partition='live-comparison') => {
      for (let i=0;i<150;i++) {
        const ready=await app.evaluate(({webContents,session},[target,partition])=>{
          const wc=webContents.getAllWebContents().find(w=>w.session===session.fromPartition(partition) && w.getURL()===target);
          return Boolean(wc && !wc.isLoading());
        },[url,partition]);
        if(ready)return;
        await new Promise(r=>setTimeout(r,100));
      }
      throw new Error('Native page did not finish navigation: '+url);
    };

    await until(async()=>{const s=(await window.browser.command('state')).state;return s.tabs.some(t=>!t.loading&&t.connection?.ip);});
    await app.evaluate(()=>process.getBuiltinModule('dns').setDefaultResultOrder('ipv4first'));
    await cmd('compare');
    await until(async()=>{const s=(await window.browser.command('state')).state;return s.tabs.find(t=>t.id===s.comparison?.live)?.connection?.ip;});
    const routeFonts=await ui.evaluate(()=>[...document.querySelectorAll('#pane-bars .route-bar')].map(n=>({connected:n.isConnected,raw:getComputedStyle(n.querySelector('.route-ip')).fontSize,ip:parseFloat(getComputedStyle(n.querySelector('.route-ip')).fontSize),label:parseFloat(getComputedStyle(n.querySelector('.badge')).fontSize),button:parseFloat(getComputedStyle(n.querySelector('.site-btn')).fontSize)})));
    assert.ok(routeFonts.every(f=>f.ip>=14&&f.label>=12&&f.button>=12),'readable route text: '+JSON.stringify(routeFonts));
    const input=ui.getByRole('textbox',{name:'Compare with URL',exact:true});
    assert.equal(await input.inputValue(),home,'Compare URL is directly visible');
    await input.click(); assert.equal(await input.evaluate(n=>n.selectionEnd-n.selectionStart),home.length,'click selects current URL');
    await input.fill('file:///etc/hosts'); await input.press('Enter'); await ui.locator('#compare-with-error').waitFor();
    await input.press('Escape'); assert.equal(await input.inputValue(),home,'Escape restores URL');
    const other=`http://127.0.0.1:${port}/other?x=1#anchor`; await input.fill(other); await input.press('Enter');
    await until(async url=>{const s=(await window.browser.command('state')).state;const t=s.tabs.find(t=>t.id===s.comparison?.live);return t&&!t.loading&&t.url===url&&t.connection?.url===url;},other);await pageLoaded(other);
    await input.focus(); await ui.getByRole('button',{name:'Same URL',exact:true}).click();
    await until(async url=>{const s=(await window.browser.command('state')).state;const t=s.tabs.find(t=>t.id===s.comparison?.live);return t&&!t.loading&&t.url===url&&t.connection?.url===url;},home);await pageLoaded(home);
    await ui.locator('#pane-bars .site-btn').first().click();
    const cardPage=async()=>{for(let i=0;i<100;i++){const p=app.windows().find(p=>p.url().includes('card.html'));if(p)return p;await new Promise(r=>setTimeout(r,100));}throw new Error('No native card');};
    const cp=await cardPage();
    await cp.locator('.connection-comparison').waitFor();
    const text=await cp.locator('body').innerText(); assert.match(text,/WordPress/);assert.match(text,/PHP version/);assert.match(text,/Elementor 3\.32\.1/);assert.match(text,/Certificate not measured|No TLS/);
    assert.equal(await cp.locator('.connection-comparison thead th').count(),3,'native comparison has two aligned panes');
    const safety=await cp.evaluate(async()=>{const pane={id:1,url:'https://example.test/',route:{host:'example.test',label:'HOSTFILE',ssl:'SSL checks on',certificate:{verified:true,issuer:'Example CA',expires:Date.now()+86400000}},connection:{fromCache:true},site:{platform:'WordPress',version:'6.8.3',builder:'Elementor',builderVersion:'3.32.1',theme:'<img src=x onerror=alert(1)>'}};await render({kind:'site',panes:[pane,{...pane,id:2,loading:true,connection:{},site:{...pane.site,version:'6.8.2',builderVersion:'3.31.0'}}]});return {text:document.body.innerText,links:document.querySelectorAll('a[href*="cert"]').length,unsafe:document.querySelectorAll('img').length};});
    assert.equal(safety.links,0,'cache and loading never claim a currently verified certificate');assert.doesNotMatch(safety.text,/SSL valid/);assert.equal(safety.unsafe,0,'detected site labels render as plain text');
    const differences=await cp.evaluate(async()=>{const pane={id:1,url:'http://example.test/',route:{host:'example.test',label:'HOSTFILE'},connection:{ip:'127.0.0.1'},site:{platform:'WordPress',version:'6.8.3',builder:'Elementor',builderVersion:'3.32.1'}};await render({kind:'site',panes:[pane,{...pane,id:2,site:{...pane.site,version:'6.8.2',builderVersion:'3.31.0'}}]});return document.querySelectorAll('.difference-mark').length;});assert.equal(differences,4,'both columns mark different platform and builder versions');

    await cmd('card-close'); await cmd('panel','domains');
    const ssl=ui.getByRole('switch',{name:'Skip SSL errors',exact:true}); assert.equal(await ssl.getAttribute('aria-checked'),'false');
    await ui.getByRole('button',{name:'Edit localhost',exact:true}).click(); await ssl.click(); await ui.locator('#save-rule').click();
    await ui.waitForFunction(()=>document.getElementById('domain-input').value==='');await pageLoaded(home,'persist:web');
    const rule=(await cmd('state')).state.rules[0];assert.equal(rule.skipSSL,true); await ui.locator('.ssl-chip.skipped').waitFor();
    await cmd('panel',null); await ui.locator('#clear-cache').click();
    const cache=await cardPage();
    await cache.getByRole('link',{name:'Clear cache & reload both panes',exact:true}).waitFor();
    await app.evaluate(({webContents})=>{globalThis.compactLoads=0;for(const wc of webContents.getAllWebContents())if(/^http:/.test(wc.getURL()))wc.once('did-finish-load',()=>globalThis.compactLoads++);});await cache.getByRole('link',{name:'Clear cache & reload both panes',exact:true}).click();for(let i=0;i<100&&(await app.evaluate(()=>globalThis.compactLoads))<2;i++)await new Promise(r=>setTimeout(r,100));assert.equal(await app.evaluate(()=>globalThis.compactLoads),2,'Clear cache menu reloads both native panes');
    const out=path.resolve('artifacts/compact-ui');fs.mkdirSync(out,{recursive:true});
    await cmd('card-close'); await ui.evaluate(()=>{document.getElementById('toast').hidden=true;});
    let canScreenshot=process.platform==='linux'&&Boolean(process.env.DISPLAY);if(canScreenshot)try{execFileSync('import',['-version'],{stdio:'ignore'});}catch{canScreenshot=false;}
    const shot=async(name)=>{ if(!canScreenshot)return; const c=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getContentBounds());execFileSync('import',['-window','root','-crop',`${c.width}x${c.height}+${c.x}+${c.y}`,path.join(out,name)]); };
    for(const width of [960,1380,1440]) for(const ratio of [.25,.5,.75]) {
      await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setContentSize(w,900),width); await cmd('compare-ratio',{ratio});
      await new Promise(r=>setTimeout(r,150)); await shot(`compare-${width}-${ratio*100}.png`);
      const bounds=await ui.locator('#pane-bars .route-bar').evaluateAll(nodes=>nodes.map(n=>({bottom:n.getBoundingClientRect().bottom,height:n.getBoundingClientRect().height,overflow:n.scrollWidth>n.clientWidth||n.scrollHeight>n.clientHeight})));assert.ok(bounds.every(b=>b.height>=48&&!b.overflow),JSON.stringify(bounds));
      {const s=(await cmd('state')).state;assert.ok(s.paneLayout.every((p,i)=>p.page.y===bounds[i].bottom),'native websites begin below readable route bars');}
      await cmd('panel','domains');{const s=(await cmd('state')).state;const p=await ui.locator('#panel').boundingBox();assert.equal(Math.max(...s.paneLayout.map(x=>x.page.x+x.page.width)),p.x,'native views meet sidebar with no gap');const identities=await ui.locator('#pane-bars .route-identity').evaluateAll(ns=>ns.map(n=>n.getBoundingClientRect().width));assert.ok(identities.every(w=>w>=48),'idle pane identities keep visible width: '+identities);}await new Promise(r=>setTimeout(r,150));await shot(`sidebar-${width}-${ratio*100}.png`);await cmd('panel',null);
    }
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(960,900));await cmd('compare-ratio',{ratio:.625});
    await input.fill('file:///etc/hosts');await input.press('Enter');await ui.locator('#compare-with-error').waitFor();
    const errorBounds=await ui.evaluate(()=>{const bar=document.querySelector('#pane-bars .pane-right'),box=bar.getBoundingClientRect();return {overflow:bar.scrollHeight>bar.clientHeight,controls:[...bar.querySelectorAll('.inline-compare-form input,.inline-compare-form button')].map(n=>{const b=n.getBoundingClientRect();return b.top>=box.top&&b.bottom<=box.bottom&&b.left>=box.left&&b.right<=box.right;})};});
    assert.ok(!errorBounds.overflow&&errorBounds.controls.every(Boolean),'invalid URL controls remain inside the narrow bar: '+JSON.stringify(errorBounds));await input.press('Escape');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));await cmd('compare-ratio',{ratio:.5});
    await ui.locator('#pane-bars .site-btn').first().click();await (await cardPage()).locator('.connection-comparison').waitFor();await new Promise(r=>setTimeout(r,300));await shot('site-comparison-1440.png');await cmd('card-close');
    for(const [id,name] of [['clear-cache','footer-cache'],['memory-usage','footer-memory'],['devtools','footer-tools'],['footer-note','footer-about']]){await ui.locator('#'+id).click();await cardPage();await new Promise(r=>setTimeout(r,300));await shot(name+'-1440.png');await cmd('card-close');}
    await cmd('panel','settings');await new Promise(r=>setTimeout(r,200));await shot('settings-1440.png');await cmd('panel','updates');await new Promise(r=>setTimeout(r,200));await shot('updates-1440.png');
    await cmd('panel',null);let st=(await cmd('state')).state;await cmd('activate',st.comparison.host);await cmd('navigate',home+'cached');await pageLoaded(home+'cached','persist:web');await cmd('navigate',home+'away');await pageLoaded(home+'away','persist:web');await cmd('navigate',home+'cached');await until(async url=>{const s=(await window.browser.command('state')).state;const t=s.tabs.find(t=>t.id===s.activeId);return t&&!t.loading&&!t.error&&t.url===url&&t.connection?.url===url&&t.connection.fromCache;},home+'cached');await pageLoaded(home+'cached','persist:web');
    const cachedContent=await app.evaluate(async({BrowserWindow},url)=>{const view=BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents.getURL()===url);return view?{visible:view.getVisible(),heading:await view.webContents.executeJavaScript("document.querySelector('h1')?.textContent")}:null;},home+'cached');assert.deepEqual(cachedContent,{visible:true,heading:'Real fixture'},'cached native page content remains visible');await new Promise(r=>setTimeout(r,300));await shot('cached-page-1440.png');
    const cached=ui.locator('#pane-bars .pane-left');assert.equal(await cached.locator('.badge + .route-cache').count(),1,'Cached badge immediately follows route badge');assert.match(await cached.locator('.route-ip').innerText(),/Not measured/);await cached.locator('.route-cache').click();await (await cardPage()).getByRole('link',{name:'Reload without browser cache',exact:true}).waitFor();await new Promise(r=>setTimeout(r,250));await shot('cached-1440.png');await (await cardPage()).getByRole('link',{name:'Reload without browser cache',exact:true}).click();await until(async()=>{const s=(await window.browser.command('state')).state;const t=s.tabs.find(t=>t.id===s.activeId);return !t.loading&&t.connection?.ip&&!t.connection.fromCache;});
    await cmd('stop-compare');await cmd('new-tab');await ui.getByText('Ready to browse',{exact:true}).waitFor();
    console.log('PASS: direct compare URL, restore/invalid/Same URL, native site comparisons, per-rule SSL, footer cache menu and desktop ratios.');
  } finally { const exited=new Promise(r=>app.process().exitCode!==null?r():app.process().once('exit',r));await app.evaluate(({app})=>app.quit()).catch(()=>{});await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>{app.process().kill('SIGKILL');reject(new Error('Electron did not quit within 15s'));},15000).unref())]);host.closeAllConnections();live.closeAllConnections();await Promise.all([new Promise(r=>host.close(r)),new Promise(r=>live.close(r))]);fs.rmSync(profile,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exit(1)});
