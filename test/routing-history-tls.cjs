const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),https=require('node:https'),http=require('node:http'),{execFileSync}=require('node:child_process');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'dioptra-history-tls-'));let app,child,requests=0,redirectHistory=false;
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',profile+'/key','-out',profile+'/cert','-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
 const server=https.createServer({key:fs.readFileSync(profile+'/key'),cert:fs.readFileSync(profile+'/cert')},(req,res)=>{if(req.url!=='/favicon.ico')requests++;res.setHeader('Cache-Control','no-store');res.end('<title>ACCEPTED</title><script>window.acceptedDocument=true</script>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`https://localhost:${server.address().port}`,rule={domain:'localhost',ip:'127.0.0.1',enabled:true,skipSSL:true};
 const redirectServer=http.createServer((req,res)=>{res.setHeader('Cache-Control','no-store');if(redirectHistory){res.writeHead(302,{Location:origin+'/redirected'});return res.end()}res.end('<title>HTTP history</title>')});await new Promise(r=>redirectServer.listen(0,'127.0.0.1',r));const httpOrigin=`http://localhost:${redirectServer.address().port}`;
 try{
  fs.writeFileSync(profile+'/settings.json',JSON.stringify({rules:[rule],tabs:[origin+'/one'],autoUpdates:false,autoUpdatesChosen:true}));
  app=await electron.launch({executablePath:process.env.DIOPTRA_TEST_EXECUTABLE||undefined,args:[...(process.getuid?.()===0?['--no-sandbox','-r',path.join(__dirname,'root-harness.cjs')]:[]),...(process.env.DIOPTRA_TEST_EXECUTABLE?[]:['.']),`--profile-dir=${profile}`],cwd:path.resolve(__dirname,'..'),env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'}});child=app.process();
  const ui=await app.firstWindow();await ui.waitForFunction(()=>window.browser);const cmd=(a,d)=>ui.evaluate(([a,d])=>window.browser.command(a,d),[a,d]);
  const native=()=>app.evaluate(({webContents},[origin,httpOrigin])=>{const w=webContents.getAllWebContents().find(w=>w.getURL().startsWith(origin)||w.getURL().startsWith(httpOrigin));if(!w)return null;const h=w.navigationHistory;return {id:w.id,url:w.getURL(),loading:w.isLoading(),index:h.getActiveIndex(),entries:h.getAllEntries().map(e=>e.url)}},[origin,httpOrigin]);
  const state=async()=>(await cmd('state')).state.tabs.find(t=>t.url.startsWith(origin)||t.url.startsWith(httpOrigin));
  async function wait(check,label){const end=Date.now()+12000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,25))}throw Error(label+' '+JSON.stringify({native:await native(),state:await state(),requests}))}
  const ready=url=>wait(async()=>{const n=await native();return n?.url===url&&!n.loading},'native '+url);
  const documentAccepted=async()=>app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('window.acceptedDocument === true'),(await native()).id);
  await ready(origin+'/one');assert.equal(await documentAccepted(),true);
  await app.evaluate(({session})=>{const s=session.fromPartition('persist:web'),original=s.clearCache.bind(s);s.clearCache=async()=>{if(process.historyHoldCache){process.historyCacheEntered=true;await new Promise(r=>process.historyReleaseCache=r);process.historyHoldCache=false}await original()}});
  for(const kind of ['pushState','fragment','document','fragment-address','fragment-barrier']){
   if(kind!=='pushState'){assert.equal((await cmd('save-rules',[rule])).ok,true);await cmd('navigate',origin+'/one');await ready(origin+'/one');assert.equal(await documentAccepted(),true)}
   if(kind==='document'){await cmd('navigate',origin+'/two');await ready(origin+'/two')}
   else if(kind!=='fragment-barrier'){const code=kind!=='fragment'?"history.pushState({},'', '/two')":"location.hash='two'";await app.evaluate(({webContents},[id,code])=>webContents.fromId(id).executeJavaScript(code),[(await native()).id,code]);await ready(origin+(kind!=='fragment'?'/two':'/one#two'))}
   const before=await native(),target=kind==='fragment-barrier'?before.url:before.entries[before.index-1],beforeRequests=requests;
   // Hold only dispatch of the real same-document selection, so a newer address
   // reaches the helper while its main-frame completion listener is installed.
   if(kind==='fragment-address')await app.evaluate(({webContents},id)=>{const h=webContents.fromId(id).navigationHistory,go=h.goToIndex.bind(h);h.goToIndex=index=>{h.goToIndex=go;process.releaseHistorySelection=()=>go(index)}},before.id);
   await app.evaluate(()=>{process.historyHoldCache=true;process.historyCacheEntered=false});const save=cmd('save-rules',[{...rule,skipSSL:false}]);save.catch(()=>{});
   await wait(()=>app.evaluate(()=>process.historyCacheEntered),'cache barrier');if(kind==='fragment-barrier')await cmd('navigate',target+'#newer');else await cmd('back');await app.evaluate(()=>process.historyReleaseCache());assert.equal((await save).ok,true);
   if(kind==='fragment-address'){await cmd('navigate',target+'#newer');await app.evaluate(()=>process.releaseHistorySelection())}
   const expected=kind.startsWith('fragment-')?target+'#newer':target;
   await wait(async()=>{const n=await native(),t=await state();return /CERT/.test(t.error)&&n.url===expected&&!n.loading},kind+' must revalidate selected history');
   const after=await native(),t=await state();assert.equal(t.route.ssl,'SSL checks on');assert.equal(t.connection,null);assert.equal(t.route.certificate?.verified,false);assert.equal(t.route.certificate?.skipped,false);
   assert.equal(await documentAccepted(),false,kind+' cannot retain accepted document');assert.equal(requests,beforeRequests,'strict TLS blocks new HTTP request');if(!kind.startsWith('fragment-')){assert.equal(after.index,before.index-1);assert.deepEqual(after.entries,before.entries,'selected history and Forward entries survive strict replacement')}else assert.equal(t.url,expected,'newer fragment address remains intended URL');
  }
  assert.equal((await cmd('save-rules',[rule])).ok,true);await cmd('navigate',httpOrigin+'/history');await ready(httpOrigin+'/history');await cmd('navigate',origin+'/one');await ready(origin+'/one');
  const before=await native(),beforeRequests=requests;redirectHistory=true;
  await app.evaluate(()=>{process.historyHoldCache=true;process.historyCacheEntered=false});const save=cmd('save-rules',[{...rule,skipSSL:false}]);save.catch(()=>{});await wait(()=>app.evaluate(()=>process.historyCacheEntered),'redirect cache barrier');await cmd('back');await app.evaluate(()=>process.historyReleaseCache());assert.equal((await save).ok,true);
  await wait(async()=>{const n=await native(),t=await state();return n?.url===origin+'/redirected'&&!n.loading&&t?.url===n.url&&/CERT/.test(t.error)},'redirected selection must settle strict TLS failure');
  const after=await native(),t=await state();
  // Chromium commits a failed cross-origin history redirect at the original active index.
  assert.equal(after.index,before.index);const expectedEntries=[...before.entries];expectedEntries[before.index]=origin+'/redirected';assert.deepEqual(after.entries,expectedEntries,'failure handling preserves Chromium native history without an extra navigation');assert.equal(t.route.ssl,'SSL checks on');assert.equal(t.connection,null);assert.equal(t.route.certificate?.verified,false);assert.equal(t.route.certificate?.skipped,false);assert.equal(await documentAccepted(),false);assert.equal(requests,beforeRequests);
  console.log('PASS redirected strict TLS failure and newer fragment address strict revalidation during history selection and cache barrier');
  console.log('PASS fresh strict TLS for pushState, fragment and cross-document queued history; accepted document removed, selected index and Forward history preserved');
 }finally{
  if(app){const exited=new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await Promise.race([app.evaluate(({app})=>app.quit()).catch(()=>{}),new Promise(r=>setTimeout(r,3000).unref())]);await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>{child.kill('SIGKILL');reject(Error('Electron quit timeout'))},10000).unref())]);}
  redirectServer.closeAllConnections();await new Promise(r=>redirectServer.close(r));
  server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
})().catch(e=>{console.error(e);process.exitCode=1});
