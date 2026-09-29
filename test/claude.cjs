// Real official extension, real browser APIs. Account login remains a manual check.
const { _electron: electron } = require('playwright');
async function poll(read, value, timeout = 15000) { const end = Date.now()+timeout; let actual; do { actual = await read(); if (actual === value) return; await new Promise(r=>setTimeout(r,100)); } while(Date.now()<end); assert.equal(actual,value); }
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const {execFileSync} = require('node:child_process');
(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(),'dioptra-claude-test-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(profile,'key.pem'),'-out',path.join(profile,'cert.pem'),'-days','1','-subj','/CN=invalid.test'],{stdio:'ignore'});
  const tlsServer = https.createServer({key:await fs.readFile(path.join(profile,'key.pem')),cert:await fs.readFile(path.join(profile,'cert.pem'))},(_req,res)=>res.end('migration TLS'));
  await new Promise(r=>tlsServer.listen(0,'127.0.0.1',r));
  const fixture = process.env.CLAUDE_TEST_EXTENSION_DIR;
  if (fixture) await fs.cp(fixture,path.join(profile,'claude-extension'),{recursive:true});
  const server = http.createServer((_req,res) => { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Claude test page</title><h1>Dioptra control test</h1><input aria-label="Message"><button onclick="document.querySelector(\'h1\').textContent=\'Clicked by Claude bridge\'">Test button</button>'); });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url = `http://localhost:${server.address().port}/`;
  await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({rules:[{domain:'localhost',ip:'127.0.0.1',enabled:true}],tabs:['about:blank']}));
  const root = process.platform === 'linux' && process.getuid() === 0;
  let app;
  try {
    app = await electron.launch({...(process.env.CLAUDE_TEST_EXECUTABLE ? {executablePath:process.env.CLAUDE_TEST_EXECUTABLE} : {}),cwd:path.join(__dirname,'..'),args:[...(root ? ['--no-sandbox','-r',path.join(__dirname,'root-harness.cjs')] : []),...(process.env.CLAUDE_TEST_EXECUTABLE ? [] : ['.']),`--profile-dir=${profile}`],env:{...process.env,ELECTRON_ENABLE_LOGGING:'1'}});
    const ui = await app.firstWindow();
    await ui.getByRole('button',{name:'Claude',exact:true}).waitFor();
    if (fixture) await poll(()=>ui.evaluate(async()=> (await window.browser.command('state')).state.claude.status),'ready');
    await ui.getByRole('button',{name:'Claude',exact:true}).click();
    if (!fixture) { await ui.getByRole('button',{name:'Install Claude',exact:true}).click(); await poll(()=>ui.evaluate(async()=> (await window.browser.command('state')).state.claude.status),'ready',90000); }
    await poll(()=>app.evaluate(({webContents})=>webContents.getAllWebContents().some(w=>w.getURL().includes('/sidepanel.html'))),true);
    await ui.locator('body.claude-open #panel').waitFor({state:'visible'});
    assert.equal(await ui.locator('#panel .panel-head').isVisible(),false,'Installed Claude has no extra Dioptra header');
    const geometry = await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];const view=win.contentView.children.find(v=>v.webContents?.getURL().includes('/sidepanel.html'));return {bounds:view.getBounds(),height:win.getContentSize()[1]};});
    assert.equal(geometry.bounds.y,132,'Claude begins directly below the browser toolbar');
    assert.equal(geometry.bounds.height,geometry.height-162,'Claude fills the pane to the browser footer');
    const run = script => app.evaluate(async({webContents},code)=>webContents.getAllWebContents().find(w=>w.getURL().includes('/sidepanel.html')).executeJavaScript(code),script);
    // Observe the actual Chromium request, using no account credentials. The
    // server can reject it; only the public client identity is under test.
    await app.evaluate(({session})=>{
      globalThis.claudeRequestIdentity=null;
      session.fromPartition('persist:web').webRequest.onSendHeaders({urls:['https://api.anthropic.com/api/bootstrap/features/claude_in_chrome']},d=>{
        const get=name=>Object.entries(d.requestHeaders).find(([key])=>key.toLowerCase()===name)?.[1];
        globalThis.claudeRequestIdentity={platform:get('anthropic-client-platform'),version:get('anthropic-client-version'),agent:get('user-agent')};
      });
    });
    await run(`fetch('https://api.anthropic.com/api/bootstrap/features/claude_in_chrome',{headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000)}).then(()=>null,()=>null)`);
    const client = await app.evaluate(()=>globalThis.claudeRequestIdentity);
    assert.equal(client?.platform,'claude_browser_extension');
    assert.equal(client.version,'1.0.94');
    assert.match(client.agent,/Chrome\/[\d.]+/);
    assert.doesNotMatch(client.agent,/Dioptra\/|Electron\//);
    await app.evaluate(({session})=>session.fromPartition('persist:web').webRequest.onSendHeaders(null));
    if (!root) {
      await poll(()=>run('document.body.innerText.includes("Log in")'),true);
      const response = await run("chrome.runtime.sendMessage({type:'check_native_host_status'})");
      assert.equal(typeof response?.status?.nativeHostInstalled,'boolean','Official background worker responds');
      const anchorProbe = await run(`(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return chrome.runtime.sendMessage({type:'CIC_IFRAME_BRIDGE_INIT',panelTabId:tab.id,sessionId:'dioptra-anchor-test'});})()`);
      assert.notEqual(anchorProbe.error,'sender is not an extension page','Original worker must recognize its own sidepanel for tab-group initialization');
      // The new hosted UI calls the worker from a claude.ai child frame, not an
      // OAuth tab. Keep the original worker; substitute only the remote page.
      await app.evaluate(({session,net}) => session.fromPartition('persist:web').protocol.handle('https', request => {
        if (request.url === 'https://claude.ai/cic/dioptra-test') return new Response('<!doctype html><title>Hosted Claude test</title>', {headers:{'Content-Type':'text/html'}});
        return net.fetch(request,{bypassCustomProtocolHandlers:true});
      }));
      await run(`new Promise(resolve=>{const frame=document.createElement('iframe');frame.id='dioptra-bridge-test';frame.sandbox='allow-scripts allow-same-origin';frame.onload=resolve;frame.src='https://claude.ai/cic/dioptra-test';document.body.append(frame);})`);
      const childRun = code => app.evaluate(async({webContents},code)=>webContents.getAllWebContents().find(w=>w.getURL().includes('/sidepanel.html')).mainFrame.framesInSubtree.find(f=>f.url==='https://claude.ai/cic/dioptra-test').executeJavaScript(code),code);
      const ping = await childRun(`Promise.race([Promise.resolve().then(()=>chrome.runtime.sendMessage('fcoeoabgfenejglbffodgkkbkcdhcgfn',{type:'ping'})).catch(()=>({failed:true})),new Promise(r=>setTimeout(()=>r({timedOut:true}),3000))])`);
      assert.deepEqual(ping,{success:true,exists:true},'Hosted Claude frame reaches original extension worker');
      const host = await childRun(`chrome.runtime.sendMessage('fcoeoabgfenejglbffodgkkbkcdhcgfn',{type:'get_sidepanel_host_info'})`);
      assert.equal(host.ok,true);
      assert.ok(host.capabilities.includes('open_options'),'Hosted frame is identified as the panel, not a website tab');
      assert.deepEqual(await childRun('({require:typeof require,process:typeof process,dioptraCommand:typeof window.browser?.command})'),{require:'undefined',process:'undefined',dioptraCommand:'undefined'});
      const protection = await app.evaluate(({webContents})=>{const p=webContents.getAllWebContents().find(w=>w.getURL().includes('/sidepanel.html')).getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});
      assert.deepEqual(protection,{sandbox:true,contextIsolation:true,nodeIntegration:false});
      await app.evaluate(({webContents})=>new Promise((resolve,reject)=>{
        const wc=webContents.getAllWebContents().find(w=>w.getURL().includes('/sidepanel.html'));
        const loaded=(_event,main)=>{if(!main){clearTimeout(timer);wc.removeListener('did-frame-finish-load',loaded);resolve();}};
        const timer=setTimeout(()=>{wc.removeListener('did-frame-finish-load',loaded);reject(new Error('Hosted frame reload did not finish'));},10000);
        wc.on('did-frame-finish-load',loaded);
        wc.mainFrame.framesInSubtree.find(f=>f.url==='https://claude.ai/cic/dioptra-test').executeJavaScript('location.reload()').catch(()=>{});
      }));
      await poll(async()=>{try{return await childRun(`chrome.runtime.sendMessage('fcoeoabgfenejglbffodgkkbkcdhcgfn',{type:'get_sidepanel_host_info'}).then(r=>r.ok && r.capabilities.includes('open_options'))`);}catch{return false;}},true);
      const forbidden = await childRun(`chrome.runtime.sendMessage('fcoeoabgfenejglbffodgkkbkcdhcgfn',{type:'oauth_redirect',redirect_uri:'https://invalid.test/'}).then(()=>false,()=>true)`);
      assert.equal(forbidden,true,'Hosted panel cannot impersonate an OAuth login tab');
      const impostor = await app.evaluate(async({WebContentsView,session},preload)=>{
        const view=new WebContentsView({webPreferences:{session:session.fromPartition('persist:web'),sandbox:true,contextIsolation:true,nodeIntegration:false,preload}});
        try { await view.webContents.loadURL('https://claude.ai/cic/dioptra-test');return await view.webContents.executeJavaScript(`chrome.runtime.sendMessage('fcoeoabgfenejglbffodgkkbkcdhcgfn',{type:'get_sidepanel_host_info'}).then(()=>false,()=>true)`); }
        finally { view.webContents.close(); }
      },path.join(__dirname,'../src/claude-auth-preload.cjs'));
      assert.equal(impostor,true,'A normal claude.ai page cannot claim the side-panel identity');
      await run(`document.getElementById('dioptra-bridge-test').remove()`);
      await app.evaluate(({session})=>session.fromPartition('persist:web').protocol.unhandle('https'));
    }
    const result = await run(`(async()=>{
      const tab = await chrome.tabs.create({url:${JSON.stringify(url)}});
      const deadline = Date.now()+10000; while ((await chrome.tabs.get(tab.id)).title !== 'Claude test page') { if (Date.now()>deadline) throw new Error('Test page did not load'); await new Promise(r=>setTimeout(r,50)); }
      const queried = await chrome.tabs.query({active:true,currentWindow:true});
      const groupId = await chrome.tabs.group({tabIds:[tab.id]});
      await chrome.tabGroups.update(groupId,{title:'Claude test',color:'orange'});
      await chrome.debugger.attach({tabId:tab.id},'1.3');
      const read = await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'document.querySelector("h1").textContent',returnByValue:true});
      await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'document.querySelector("button").click()'});
      const clicked = await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'document.querySelector("h1").textContent',returnByValue:true});
      const screenshot = await chrome.debugger.sendCommand({tabId:tab.id},'Page.captureScreenshot',{});
      let blocked=false;try{await chrome.debugger.sendCommand({tabId:tab.id},'Browser.close',{});}catch{blocked=true;}
      await chrome.debugger.detach({tabId:tab.id});
      return {tabId:tab.id,queryFound:queried.some(t=>t.id===tab.id),group:await chrome.tabGroups.get(groupId),read:read.result.value,clicked:clicked.result.value,screenshotBytes:screenshot.data.length,blocked};
    })()`);
    assert.ok(result.queryFound); assert.equal(result.group.title,'Claude test'); assert.equal(result.read,'Dioptra control test'); assert.equal(result.clicked,'Clicked by Claude bridge'); assert.ok(result.screenshotBytes>100); assert.ok(result.blocked);
    if (!root) {
      // Synthetic consent/features/API-key marker only in this disposable profile.
      // No account login or model request. Reload to hydrate the vendor feature cache. Exercise the
      // original worker's anchor and tools, not just our individual Chrome APIs.
      await run(`chrome.storage.local.set({features:{timestamp:Date.now(),payload:{features:{chrome_ext_cowork_iframe:{on:true}}}},browserControlPermissionAccepted:true})`);
      await app.evaluate(async({session})=>{
        const extensions=session.fromPartition('persist:web').extensions;
        const extension=extensions.getAllExtensions()[0];
        extensions.removeExtension(extension.id);
        await extensions.loadExtension(extension.path);
      });
      await run('location.reload()').catch(()=>{});
      await poll(async()=>{try{return await run(`document.readyState==='complete' && typeof chrome.runtime.sendMessage==='function'`);}catch{return false;}},true);
      const coldAnchor=await run(`chrome.runtime.sendMessage({type:'CIC_IFRAME_BRIDGE_INIT',panelTabId:${result.tabId},sessionId:'dioptra-cold-anchor'})`);
      assert.equal(coldAnchor?.ok,true,JSON.stringify(coldAnchor));
      const impostorPanel=await app.evaluate(async({WebContentsView,session})=>{
        const view=new WebContentsView({webPreferences:{session:session.fromPartition('persist:web'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
        try {
          await view.webContents.loadURL('chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/sidepanel.html');
          return await view.webContents.executeJavaScript(`chrome.runtime.sendMessage({type:'CIC_IFRAME_BRIDGE_INIT',panelTabId:1,sessionId:'impostor'}).then(()=>false,e=>e.message==='Access denied.')`);
        } finally {await new Promise(resolve=>{view.webContents.once('destroyed',resolve);view.webContents.close();});}
      });
      assert.equal(impostorPanel,true,'Only the registered sidepanel can use the internal relay');
      // Mark the old document so the poll cannot mistake it for the reloaded one (slow under Rosetta).
      await run(`chrome.scripting.executeScript({target:{tabId:${result.tabId}},func:()=>{window.__beforeReload=true;}})`);
      await run(`chrome.tabs.reload(${result.tabId})`);
      await poll(async()=>{try{return await run(`chrome.scripting.executeScript({target:{tabId:${result.tabId}},func:()=>!window.__beforeReload&&document.readyState}).then(r=>r[0]?.result)`);}catch{return ''; }},'complete');
      await run(`chrome.scripting.executeScript({target:{tabId:${result.tabId}},func:()=>document.querySelector('button').click()})`);
      await app.evaluate(()=>process.getBuiltinModule('dns').setDefaultResultOrder('ipv4first'));
      await ui.evaluate(()=>window.browser.command('compare'));
      const liveId=await app.evaluate(({webContents,session})=>webContents.getAllWebContents().find(w=>w.session===session.fromPartition('live-comparison')).id);
      await poll(()=>app.evaluate(({webContents},id)=>webContents.fromId(id).getTitle(),liveId),'Claude test page');
      const liveScript=await run(`chrome.scripting.executeScript({target:{tabId:${liveId}},func:()=>document.title}).then(r=>({title:r[0]?.result}),e=>({error:e.message}))`);
      assert.equal(liveScript.title,'Claude test page',JSON.stringify(liveScript));
      const liveIsolation=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('({tree:typeof window.__generateAccessibilityTree,require:typeof require,browser:typeof window.browser})'),liveId);
      assert.deepEqual(liveIsolation,{tree:'undefined',require:'undefined',browser:'undefined'},'Live page cannot access extension script globals or Node');
      const liveWorld=await run(`chrome.scripting.executeScript({target:{tabId:${liveId}},func:()=>({tree:typeof window.__generateAccessibilityTree,require:typeof require,browser:typeof window.browser})})`);
      assert.deepEqual(liveWorld[0].result,{tree:'function',require:'undefined',browser:'undefined'});

      await run(`chrome.scripting.executeScript({target:{tabId:${liveId}},func:()=>document.querySelector('button').click()})`);
      for(const targetId of [result.tabId,liveId]) {
      const transport = await run(`(async()=>{
        const keys=['features','browserControlPermissionAccepted','anthropicApiKey'];
        const previous=await chrome.storage.local.get(keys);
        try {
          await chrome.storage.local.set({features:{timestamp:Date.now(),payload:{features:{chrome_ext_cowork_iframe:{on:true}}}},browserControlPermissionAccepted:true,anthropicApiKey:'dioptra-disposable-test-key'});
          const request={type:'CIC_IFRAME_BRIDGE_INIT',panelTabId:${result.tabId},sessionId:'dioptra-cold-anchor'};
          const anchor=${JSON.stringify(coldAnchor)};
          if(!anchor?.ok)return {anchor};
          const call=(toolName,args)=>chrome.runtime.sendMessage({type:'CIC_IFRAME_TOOL_CALL',toolName,args,panelTabId:${result.tabId},tabGroupId:anchor.tabGroupId,sessionId:request.sessionId,toolUseId:'dioptra-'+toolName,permissionOverrides:{allowedDomains:['localhost']}});
          const text=await call('get_page_text',{tabId:${targetId}});
          const page=await call('read_page',{tabId:${targetId}});
          const screenshot=await call('computer',{action:'screenshot',tabId:${targetId}});
          await chrome.storage.local.set({browserControlPermissionAccepted:false});
          const denied=await chrome.runtime.sendMessage(request);
          return {anchor,text,page,screenshot:{ok:screenshot?.ok,error:screenshot?.error,is_error:screenshot?.result?.is_error,content:screenshot?.result?.content?.map(c=>c.type==='image'?{type:c.type,bytes:(c.data||c.source?.data)?.length}:c)},denied};
        } finally {await chrome.storage.local.remove(keys);await chrome.storage.local.set(previous);}
      })()`);
      assert.equal(transport.anchor?.ok,true,JSON.stringify(transport));
      assert.equal(transport.text?.ok,true,JSON.stringify(transport.text));
      assert.match(JSON.stringify(transport.text.result),/Clicked by Claude bridge/,`target ${targetId}, host ${result.tabId}, live ${liveId}`);
      assert.equal(transport.page?.ok,true,JSON.stringify(transport.page));
      assert.match(JSON.stringify(transport.page.result),/Clicked by Claude bridge/);
      assert.ok(transport.screenshot?.content?.some(c=>c.type==='image'&&c.bytes>100),JSON.stringify(transport.screenshot));
      assert.equal(transport.denied?.ok,false,'Original worker still enforces browser-control consent');
      assert.match(transport.denied.error,/consent/);
      }
      await ui.evaluate(()=>window.browser.command('stop-compare'));
    }

    // Actual Chromium content script injection, not a simulated page reader.
    const injected = await run(`chrome.scripting.executeScript({target:{tabId:${result.tabId}},func:()=>document.title})`);
    assert.equal(injected[0].result,'Claude test page');
    const isolation = await app.evaluate(async({webContents},id)=>{const wc=webContents.fromId(id);return wc.executeJavaScript('({require:typeof require,debugger:typeof chrome.debugger,browser:typeof window.browser})');},result.tabId);
    assert.deepEqual(isolation,{require:'undefined',debugger:'undefined',browser:'undefined'});
    const denied = await app.evaluate(async({WebContentsView,session},preload)=>{
      const attacker = new WebContentsView({webPreferences:{session:session.fromPartition('persist:web'),preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});
      try { await attacker.webContents.loadURL('about:blank'); return await attacker.webContents.executeJavaScript('window.attackResult()'); }
      finally { attacker.webContents.close(); }
    },path.join(__dirname,'claude-attacker-preload.cjs'));
    assert.equal(denied.error,'Access denied.');

    const tls = await app.evaluate(async({session},url)=>{
      const results=[];
      for (const name of ['persist:web','persist:claude-auth']) { try { await session.fromPartition(name).fetch(url); results.push('accepted'); } catch { results.push('rejected'); } }
      return results;
    },`https://127.0.0.1:${tlsServer.address().port}/`);
    assert.deepEqual(tls,['accepted','rejected'],'Migration TLS bypass stays separate from strict OAuth TLS');
    if (!root) {
      await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Log in').click()`);
      await poll(()=>app.evaluate(({webContents,session})=>webContents.getAllWebContents().some(w=>w.session===session.fromPartition('persist:claude-auth'))),true);
      assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1,'Login stays inside Dioptra');
      await poll(()=>app.evaluate(({webContents,session})=>webContents.getAllWebContents().some(w=>w.session===session.fromPartition('persist:claude-auth') && w.getURL().startsWith('https://claude.ai/'))),true);
      const handshake = await app.evaluate(async({webContents,session})=>webContents.getAllWebContents().find(w=>w.session===session.fromPartition('persist:claude-auth')).executeJavaScript(`chrome.runtime.sendMessage('fcoeoabgfenejglbffodgkkbkcdhcgfn',{type:'ping'})`));
      assert.deepEqual(handshake,{success:true,exists:true},'Strict OAuth page reaches the original extension worker');
      const rejectedOAuth = await app.evaluate(async({webContents,session})=>webContents.getAllWebContents().find(w=>w.session===session.fromPartition('persist:claude-auth')).executeJavaScript(`chrome.runtime.sendMessage('fcoeoabgfenejglbffodgkkbkcdhcgfn',{type:'oauth_redirect',redirect_uri:'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html?state=dioptra-invalid-test-state'})`));
      assert.equal(rejectedOAuth.notStartedHere,true,'Original extension still validates OAuth state');
    }
    await ui.getByRole('button',{name:'Settings',exact:true}).click();
    assert.equal(await ui.locator('#panel .panel-head').isVisible(),true,'Settings keeps its normal panel header');
    await ui.getByRole('button',{name:'Check Claude',exact:true}).waitFor({timeout:2000});
    await run(`chrome.storage.local.set({features:{timestamp:Date.now(),payload:{features:{chrome_ext_cowork_iframe:{on:false,value:false},privateTest:{value:'must-not-leak'}}}}})`);
    await ui.getByRole('button',{name:'Check Claude',exact:true}).click();
    await poll(()=>ui.locator('#claude-diagnostics').innerText().then(t=>t.includes('"newInterfaceEnabled": false')),true);
    const diagnostics = JSON.parse(await ui.locator('#claude-diagnostics').innerText());
    assert.equal(diagnostics.extensionVersion,'1.0.94');
    assert.equal(JSON.stringify(diagnostics).includes('must-not-leak'),false,'Diagnostics never dump the feature payload');
    await ui.getByRole('button',{name:'Copy Claude diagnostics',exact:true}).click();
    assert.deepEqual(JSON.parse(await app.evaluate(({clipboard})=>clipboard.readText())),diagnostics);
    await run(`chrome.storage.local.set({dioptraTestPreference:'keep-me'})`);
    await ui.getByRole('button',{name:'Refresh Claude',exact:true}).click();
    await poll(()=>run(`chrome.storage.local.get('dioptraTestPreference').then(v=>v.dioptraTestPreference)`),'keep-me');
    await poll(()=>ui.evaluate(async()=> (await window.browser.command('state')).state.panel),'claude');
    await ui.getByRole('button',{name:'Settings',exact:true}).click();
    await ui.getByRole('button',{name:'Remove Claude',exact:true}).click();
    await ui.getByRole('button',{name:'Claude',exact:true}).click();
    await ui.getByRole('button',{name:'Install Claude',exact:true}).waitFor();
    assert.equal(await app.evaluate(({session})=>session.fromPartition('persist:web').extensions.getAllExtensions().length),0);
    console.log(`Claude: real tabs, groups, debugger read/click/screenshot, native script injection, removal, page isolation and TLS separation passed${root ? '; worker/login UI needs sandboxed non-root run' : '; official worker anchor, Hostfile + Live page text/accessibility/screenshot, consent, panel identity and login UI passed'}.`);
  } catch(error) { console.error(error); throw error; } finally { if(app) { const force = setTimeout(()=>app.process().kill('SIGKILL'),5000); try { await app.close(); } finally { clearTimeout(force); } } server.close(); tlsServer.close(); await fs.rm(profile,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
