// Continue anyway on a Live certificate error: real app, local server with a certificate for another name.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),https=require('node:https'),{execFileSync}=require('node:child_process');
const selfSigned=(dir,name)=>{execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${dir}/${name}.key`,'-out',`${dir}/${name}.crt`,'-days','1','-subj',`/CN=${name}`],{stdio:'ignore'});return {key:fs.readFileSync(`${dir}/${name}.key`),cert:fs.readFileSync(`${dir}/${name}.crt`)}};
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'dioptra-live-cert-'));let app;
 const server=https.createServer(selfSigned(profile,'web03.oldhost.invalid'),(req,res)=>{res.setHeader('Cache-Control','no-store');res.end('<title>OLD SERVER</title><p>old</p>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`https://localhost:${server.address().port}/`;
 try{
  fs.writeFileSync(profile+'/settings.json',JSON.stringify({rules:[{domain:'localhost',ip:'127.0.0.1',enabled:true,skipSSL:true}],tabs:[origin],autoUpdates:false,autoUpdatesChosen:true}));
  app=await electron.launch({executablePath:process.env.DIOPTRA_TEST_EXECUTABLE||undefined,args:[...(process.getuid?.()===0?['--no-sandbox','-r',path.join(__dirname,'root-harness.cjs')]:[]),...(process.env.DIOPTRA_TEST_EXECUTABLE?[]:['.']),`--profile-dir=${profile}`],cwd:path.join(__dirname,'..')});
  const ui=await app.firstWindow();ui.setDefaultTimeout(15000);await ui.waitForFunction(()=>window.browser);
  const cmd=(a,d)=>ui.evaluate(([a,d])=>window.browser.command(a,d),[a,d]);
  const tabs=async()=>(await cmd('state')).state.tabs;
  async function wait(check,label){const end=Date.now()+15000;while(Date.now()<end){const v=await check();if(v)return v;await new Promise(r=>setTimeout(r,50))}throw Error(label+' '+JSON.stringify(await tabs()))}
  await wait(async()=>(await tabs()).some(t=>t.mode==='hostfile'&&t.connection?.ip),'hostfile page with Skip SSL');
  assert.equal((await cmd('compare')).ok,true);
  const live=await wait(async()=>(await tabs()).find(t=>t.mode==='live'&&t.certBlocked),'Live refuses the certificate');
  assert.equal(live.certBlocked.host,'localhost');assert.equal(live.certBlocked.subject,'web03.oldhost.invalid');
  const hostfile=(await tabs()).find(t=>t.mode==='hostfile');
  assert.equal((await cmd('trust-certificate',hostfile.id)).ok,false,'only a refused Live page can continue');
  const box=ui.locator('#comparison-errors .comparison-error');
  await box.getByText('Live certificate is not trusted').waitFor();await box.getByRole('button',{name:'Open via http'}).waitFor();
  assert.match(await box.locator('.ssl-why').innerText(),/web03\.oldhost\.invalid/);
  await box.getByRole('button',{name:'Continue anyway (unsafe)'}).click();
  await wait(async()=>{const t=(await tabs()).find(t=>t.id===live.id);return !t.error&&!t.loading&&t.title==='OLD SERVER'},'Live loads after Continue anyway');
  await ui.locator('#pane-bars .route-bar.pane-right .route-untrusted').waitFor();
  assert.equal((await tabs()).find(t=>t.id===live.id).route.untrusted,true);
  // Differences fetches Live with the same single certificate, and refuses another one.
  const diff=async()=>{assert.equal((await cmd('view','differences')).ok,true);return wait(async()=>{const d=(await cmd('state')).state.differences;return d.status==='done'&&d.report},'Differences report')};
  assert.equal((await diff()).live.ok,true,'pinned certificate is accepted');
  server.setSecureContext(selfSigned(profile,'other.oldhost.invalid'));server.closeAllConnections();
  const rerun=await cmd('differences-run');assert.equal(rerun.ok,true);const report=rerun.report;assert.equal(report.live.ok,false);assert.match(report.live.error,/certificate changed/);
  assert.equal((await cmd('compare')).ok,true);
  await wait(async()=>(await tabs()).find(t=>t.mode==='live'&&t.certBlocked?.subject==='other.oldhost.invalid'),'a changed certificate is refused again in the page');
  console.log('PASS Live certificate: refused, Continue anyway trusts one certificate, chip shown, Differences pinned, changed certificate refused');
 }finally{await app?.close().catch(()=>{});server.closeAllConnections();server.close();fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
})().catch(e=>{console.error(e);process.exit(1)});
