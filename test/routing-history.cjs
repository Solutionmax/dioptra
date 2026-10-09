const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'dioptra-rule-history-'));let app,child,holdHistoryResponse=false,historyRequestEntered=false,releaseHistoryResponse,redirectHistory=false,movedRequests=0;
 const server=http.createServer((req,res)=>{res.setHeader('Cache-Control','no-store');if(req.url==='/moved')movedRequests++;const end=()=>{if(redirectHistory&&req.url==='/three'){res.writeHead(302,{Location:'/moved'});return res.end()}res.end(`<title>${req.url}</title><script>window.onunload=()=>{}</script>${req.url}`)};if(holdHistoryResponse&&req.url==='/three'){historyRequestEntered=true;releaseHistoryResponse=end;return}end()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://localhost:${server.address().port}`,rule={domain:'localhost',ip:'127.0.0.1',enabled:true,skipSSL:false};
 try{
  fs.writeFileSync(profile+'/settings.json',JSON.stringify({rules:[rule],tabs:[origin+'/one'],autoUpdates:false,autoUpdatesChosen:true}));
  app=await electron.launch({executablePath:process.env.DIOPTRA_TEST_EXECUTABLE||undefined,args:[...(process.getuid?.()===0?['--no-sandbox','-r',path.join(__dirname,'root-harness.cjs')]:[]),...(process.env.DIOPTRA_TEST_EXECUTABLE?[]:['.']),`--profile-dir=${profile}`],cwd:path.resolve(__dirname,'..'),env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'}});child=app.process();
  const ui=await app.firstWindow();await ui.waitForFunction(()=>window.browser);const cmd=(a,d)=>ui.evaluate(([a,d])=>window.browser.command(a,d),[a,d]);
  const native=()=>app.evaluate(({webContents},origin)=>{const w=webContents.getAllWebContents().find(w=>w.getURL().startsWith(origin));if(!w)return null;const h=w.navigationHistory;return {url:w.getURL(),loading:w.isLoading(),index:h.getActiveIndex(),entries:h.getAllEntries().map(e=>e.url)}},origin);
  async function wait(check,label){const end=Date.now()+12000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,25))}throw Error(label)}
  const ready=url=>wait(async()=>{const n=await native();return n?.url===url&&!n.loading},'native '+url);
  const state=async()=>(await cmd('state')).state.tabs.find(t=>t.url.startsWith(origin));
  await ready(origin+'/one');await cmd('navigate',origin+'/two');await ready(origin+'/two');await cmd('navigate',origin+'/three');await ready(origin+'/three');
  // Delay only cache clearing; native cancellation and policy decisions remain real.
  await app.evaluate(({session})=>{const s=session.fromPartition('persist:web'),original=s.clearCache.bind(s);s.clearCache=async()=>{process.historyCacheEntered=true;await new Promise(r=>process.historyReleaseCache=r);await original()}});
  async function begin(skipSSL){await app.evaluate(()=>process.historyCacheEntered=false);const save=cmd('save-rules',[{...rule,skipSSL}]);save.catch(()=>{});await wait(()=>app.evaluate(()=>process.historyCacheEntered),'cache barrier');return {save}}
  async function finish(p,url){await app.evaluate(()=>process.historyReleaseCache());assert.equal((await p.save).ok,true);await ready(url);assert.equal((await state()).url,url)}
  let pending=await begin(true);await cmd('back');await cmd('back');assert.equal((await state()).back,false);assert.equal((await state()).forward,true);await cmd('forward');await cmd('hard-reload');
  assert.equal((await state()).url,origin+'/two','latest history intent is reflected during barrier');assert.equal((await native()).url,origin+'/three','history navigation is deferred until cancellation/cache barrier finishes');
  await finish(pending,origin+'/two');assert.deepEqual((await native()).entries,[origin+'/one',origin+'/two',origin+'/three']);assert.equal((await native()).index,1,'Back preserves the native history index and Forward entry');
  pending=await begin(false);await cmd('forward');await finish(pending,origin+'/three');assert.equal((await native()).index,2);
  pending=await begin(true);await cmd('back');await cmd('navigate',origin+'/four');await finish(pending,origin+'/four');
  assert.deepEqual((await native()).entries,[origin+'/one',origin+'/two',origin+'/three',origin+'/four'],'latest address supersedes queued Back');
  holdHistoryResponse=true;pending=await begin(false);await cmd('back');await app.evaluate(()=>process.historyReleaseCache());assert.equal((await pending.save).ok,true);
  await wait(()=>historyRequestEntered,'pending native history response');await new Promise(r=>setTimeout(r,1700));assert.ok(await native(),'slow history selection uses navigation deadline, not cancellation deadline');await cmd('navigate',origin+'/five');assert.equal((await state()).url,origin+'/five');holdHistoryResponse=false;releaseHistoryResponse();await ready(origin+'/five');assert.equal((await state()).url,origin+'/five','new address during pending history commit wins');
  // A selected main-frame history entry may redirect; reload the committed destination.
  pending=await begin(true);redirectHistory=true;await cmd('back');await finish(pending,origin+'/moved');
  assert.equal((await native()).index,2);assert.deepEqual((await native()).entries,[origin+'/one',origin+'/two',origin+'/moved',origin+'/five']);assert.ok(movedRequests>=2,'redirect destination receives the required fresh reload');
  await cmd('forward');await ready(origin+'/five');
  redirectHistory=false;await cmd('navigate',origin+'/three');await ready(origin+'/three');await cmd('navigate',origin+'/six');await ready(origin+'/six');
  holdHistoryResponse=true;historyRequestEntered=false;pending=await begin(false);redirectHistory=true;await cmd('back');await app.evaluate(()=>process.historyReleaseCache());assert.equal((await pending.save).ok,true);
  await wait(()=>historyRequestEntered,'pending redirected history response');await cmd('navigate',origin+'/seven');holdHistoryResponse=false;releaseHistoryResponse();await ready(origin+'/seven');assert.equal((await state()).url,origin+'/seven','new address supersedes redirected history commit');
  console.log('PASS redirected history, fresh destination reload and newest address precedence');
  console.log('PASS deferred Back/Forward, repeated history clicks, reload, newest address and native history semantics during rule barrier');
 }finally{
  if(app){const exited=new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await Promise.race([app.evaluate(({app})=>app.quit()).catch(()=>{}),new Promise(r=>setTimeout(r,3000).unref())]);await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>{child.kill('SIGKILL');reject(Error('Electron quit timeout'))},10000).unref())]);}
  server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
})().catch(e=>{console.error(e);process.exitCode=1});
