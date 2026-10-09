const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),https=require('node:https'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'dioptra-routing-')),servers=[],sockets=new Set();let app,tlsRequests=0;
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',profile+'/key','-out',profile+'/cert','-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
 const tlsOptions={key:fs.readFileSync(profile+'/key'),cert:fs.readFileSync(profile+'/cert')};
 async function serve(ip,name,tls=false,port=0){const handler=(req,res)=>{
  if(tls&&req.url==='/')tlsRequests++;
  res.setHeader('Cache-Control','no-store');if(req.url==='/redirect'){res.writeHead(302,{Location:'/page'});return res.end()}
  if(req.url==='/api')return res.end(name);
  if(req.url==='/script'){res.setHeader('Content-Type','text/javascript');return res.end(`window.subresource='${name}'`)}
  res.setHeader('Content-Type','text/html');res.end(`<title>${name}</title><script src='/script'></script><script>document.cookie='fixture=kept; SameSite=Lax';localStorage.setItem('fixture',localStorage.getItem('fixture')||'kept')</script>`);
 };const s=tls?https.createServer(tlsOptions,handler):http.createServer(handler);servers.push(s);
 s.on('connection',c=>{sockets.add(c);c.on('close',()=>sockets.delete(c))});s.on('upgrade',(req,c)=>{const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');c.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');c.write(Buffer.concat([Buffer.from([0x81,name.length]),Buffer.from(name)]));});
 await new Promise(r=>s.listen(port,ip,r));return s.address().port;}
 try{
 const port=await serve('127.0.0.1','ONE'),port2=await serve('::1','TWO',false,port),tls=await serve('127.0.0.1','TLS',true);
 const rule={domain:'localhost',ip:'127.0.0.1',enabled:true,www:true,skipSSL:false};
 fs.writeFileSync(profile+'/settings.json',JSON.stringify({sslVerification:true,rules:[rule],tabs:[`http://localhost:${port}/redirect`],autoUpdates:false,autoUpdatesChosen:true}));
 app=await electron.launch({executablePath:process.env.DIOPTRA_TEST_EXECUTABLE||undefined,args:[...(process.getuid?.()===0?['--no-sandbox','-r',path.join(__dirname,'root-harness.cjs')]:[]),...(process.env.DIOPTRA_TEST_EXECUTABLE?[]:['.']),`--profile-dir=${profile}`],cwd:path.resolve(__dirname,'..'),env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'}});
 await app.evaluate(()=>process.getBuiltinModule('dns').setDefaultResultOrder('ipv4first'));
 const ui=await app.firstWindow();ui.setDefaultTimeout(15000);await ui.waitForFunction(()=>window.browser);const cmd=(a,d)=>ui.evaluate(([a,d])=>window.browser.command(a,d),[a,d]);
 const state=async()=>(await cmd('state')).state;
 async function wait(check,label){const end=Date.now()+12000;let s;while(Date.now()<end){s=await state();if(await check(s))return s;await new Promise(r=>setTimeout(r,50))}throw Error(label+' '+JSON.stringify(s.tabs));}
 let s=await wait(s=>s.tabs.some(t=>t.title==='ONE'&&!t.loading),'initial');const id=s.activeId;
 const tab=s=>s.tabs.find(t=>t.id===id);
 const nativeId=await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL()===url).id,tab(s).url);
 const native=()=>app.evaluate(({webContents},id)=>{const w=webContents.fromId(id);return {url:w.getURL(),loading:w.isLoading()}},nativeId);
 const accepted=async s=>{const n=await native();return !tab(s).loading&&!tab(s).error&&tab(s).connection?.url===tab(s).url&&!tab(s).connection.fromCache&&n.url===tab(s).url&&!n.loading};
 const evalTab=code=>app.evaluate(({webContents},[url,code])=>webContents.getAllWebContents().find(w=>w.getURL()===url).executeJavaScript(code),[tab(s).url,code]);
 const save=async rules=>{const r=await cmd('save-rules',rules);assert.equal(r.ok,true,JSON.stringify(r));return r};
 await cmd('new-tab',`http://127.0.0.1:${port}/unrelated`);s=await wait(s=>s.tabs.some(t=>t.url.endsWith('/unrelated')&&!t.loading),'unrelated');const unrelated=s.activeId;
 await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL()===url).executeJavaScript('window.kept=42'),`http://127.0.0.1:${port}/unrelated`);
 await cmd('activate',id);
 await evalTab("localStorage.setItem('sentinel','survived');document.cookie='sentinel=survived'");
 await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL()===url).executeJavaScript(`new Promise(r=>{window.keptWS=new WebSocket('ws://'+location.host+'/');keptWS.onopen=()=>r(true)})`),`http://127.0.0.1:${port}/unrelated`);
 await save([{...rule,ip:'::1'}]);
 assert.equal((await state()).pending,false,'routing changes apply without restarting');
 s=await wait(s=>tab(s).title==='TWO'&&!tab(s).loading,'hot IP change');assert.equal(tab(s).connection.ip,'::1');
 assert.equal(await evalTab('subresource'),'TWO');assert.equal(await evalTab("localStorage.getItem('fixture')"),'kept');assert.match(await evalTab('document.cookie'),/fixture=kept/);assert.equal(await evalTab("localStorage.getItem('sentinel')"),'survived');assert.match(await evalTab('document.cookie'),/sentinel=survived/);
 assert.deepEqual(await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL()===url).executeJavaScript('[window.kept,window.keptWS.readyState]'),`http://127.0.0.1:${port}/unrelated`),[42,1],'unrelated tab and WebSocket survive');
 assert.equal(await evalTab(`new Promise(r=>{const w=new WebSocket('ws://localhost:${port}/');w.onmessage=e=>{w.close();r(e.data)};w.onerror=()=>r('ERROR')})`),'TWO');
 await save([{...rule,ip:'::1',enabled:false}]);s=await wait(s=>tab(s).title==='ONE'&&!tab(s).loading,'disable');
 await save([{...rule,ip:'::1'}]);await wait(s=>tab(s).title==='TWO'&&!tab(s).loading,'enable');
 await save([]);await wait(s=>tab(s).title==='ONE'&&!tab(s).loading,'delete');
 // .invalid has no normal DNS route; www.localhost resolves differently across operating systems.
 const aliasRule={...rule,domain:'routing-update.invalid'};
 await save([aliasRule]);await cmd('navigate',`http://www.routing-update.invalid:${port}/`);await wait(s=>!tab(s).loading&&tab(s).title==='ONE','www enabled');
 await save([{...aliasRule,www:false}]);s=await wait(s=>Boolean(tab(s).error),'www removed');assert.equal(tab(s).route.configured,'');
 await save([aliasRule]);await wait(s=>!tab(s).loading&&!tab(s).error&&tab(s).title==='ONE','www restored');
 await save([rule]);
 await cmd('navigate',`https://localhost:${tls}/`);await wait(s=>/CERT/.test(tab(s).error),'strict initial');
 for(const skipSSL of [true,false,true,false]){await save([{...rule,skipSSL}]);s=await wait(async s=>skipSSL?!tab(s).error&&!tab(s).loading&&tab(s).title==='TLS'&&tab(s).route.certificate&&tab(s).connection?.url===`https://localhost:${tls}/`&&await app.evaluate(({webContents},url)=>webContents.getAllWebContents().some(w=>w.getURL()===url&&!w.isLoading()),`https://localhost:${tls}/`):/CERT/.test(tab(s).error),'SSL '+skipSSL);assert.equal(tab(s).route.ssl,skipSSL?'SSL checks off':'SSL checks on');if(skipSSL){assert.equal(tab(s).route.certificate?.verified,false);assert.equal(tab(s).route.certificate?.skipped,true);assert.match(tab(s).route.certificate?.verificationResult,/CERT/);assert.equal(await evalTab('subresource'),'TLS');assert.equal(await evalTab(`new Promise(r=>{const w=new WebSocket('wss://localhost:${tls}/');w.onmessage=e=>{w.close();r(e.data)};w.onerror=()=>r('ERROR')})`),'TLS')}}
 // Deliberately revoke as soon as the optimistic state allows it, without waiting
 // for accepted native completion: this sequence exposed the packaged x64 race.
 for(const [label,rules] of [['SSL off',[rule]],['disabled',[{...rule,skipSSL:true,enabled:false}]],['deleted',[]]]){
  await save([{...rule,skipSSL:true}]);await wait(s=>!tab(s).loading&&!tab(s).error,'rapid accept '+label);
  const requested=`https://localhost:${tls}/`;await save(rules);const requestsAfterSave=tlsRequests;
  s=await wait(async s=>/CERT/.test(tab(s).error)&&!(await native()).loading,'rapid revoke '+label);
  assert.equal(tab(s).route.ssl,'SSL checks on');assert.equal(tab(s).url,requested);assert.equal((await native()).url,requested);
  assert.equal(tab(s).connection,null,'strict failure cannot retain accepted connection evidence');
  assert.equal(tlsRequests,requestsAfterSave,'no successful HTTPS document request after strict save acknowledgement');
 }
 await save([{...rule,skipSSL:true}]);await wait(accepted,'restore skip');
 await cmd('navigate',`https://www.localhost:${tls}/`);await wait(accepted,'explicit WWW alias may skip');
 await cmd('navigate',`https://localhost:${tls}/`);await wait(accepted,'back to bare domain');
 await save([{...rule,skipSSL:true},{domain:'accounts.google.com',ip:'127.0.0.1',skipSSL:true}]);await wait(accepted,'accept before compare');
 const diff=await cmd('differences-run');assert.equal(diff.report.hostfile.ok,true,JSON.stringify(diff));assert.equal(diff.report.live.ok,false);assert.equal(diff.report.hostfile.ip,'127.0.0.1');
 await cmd('compare');s=await wait(s=>s.tabs.some(t=>t.mode==='live'&&/CERT/.test(t.error)),'Live always strict');assert.equal(s.tabs.find(t=>t.mode==='live').route.ssl,'SSL checks on');
 await cmd('stop-compare');await cmd('activate',id);await cmd('navigate',`https://accounts.google.com:${tls}/`);await wait(s=>/CERT/.test(tab(s).error),'protected host strict');
 const authStrict=await app.evaluate(async({session},url)=>session.fromPartition('persist:claude-auth').fetch(url).then(()=>false,e=>/CERT/.test(e.message)),`https://127.0.0.1:${tls}/`);assert.equal(authStrict,true);
 const updaterStrict=await app.evaluate(async({session},url)=>session.defaultSession.fetch(url).then(()=>false,e=>/CERT/.test(e.message)),`https://127.0.0.1:${tls}/`);assert.equal(updaterStrict,true);
 const results=await Promise.all([save([{...rule,ip:'::1'}]),save([rule])]);assert.equal(results.length,2);assert.deepEqual((await state()).activeRules,(await state()).rules);
 console.log('PASS hot IP/enable/delete/WWW, SSL off/on/off, strict Live/auth/protected/updater, endpoint IP, redirect/subresource/WebSocket, cookies/storage/unrelated tab, rapid SSL revoke/disable/delete, serialized saves');
 }finally{if(app){const exited=new Promise(r=>app.process().exitCode!==null?r():app.process().once('exit',r));await app.evaluate(({app})=>app.quit()).catch(()=>{});await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>{app.process().kill('SIGKILL');reject(new Error('Electron did not quit within 15s'));},15000).unref())]);}for(const s of sockets)s.destroy();for(const s of servers)s.close();fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
})().catch(e=>{console.error(e);process.exit(1)});
