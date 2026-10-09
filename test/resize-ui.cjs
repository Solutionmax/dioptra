// Native pointer resizing follows the actual footer, route bar and Settings sidebar.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
(async()=>{
  const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'dioptra-resize-ui-'));
  const server=http.createServer((_req,res)=>res.end('<title>Resize fixture</title>Native page'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/`;
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({rules:[],tabs:[url],autoUpdates:false,autoUpdatesChosen:true,claudeAutoCheck:false}));
  let app;
  try{
    app=await electron.launch({cwd:root,executablePath:process.env.DIOPTRA_TEST_EXECUTABLE||undefined,args:[...(process.getuid?.()===0?['--no-sandbox','-r',path.join(__dirname,'root-harness.cjs')]:[]),...(process.env.DIOPTRA_TEST_EXECUTABLE?[]:['.']),`--profile-dir=${profile}`]});
    const ui=await app.firstWindow();ui.setDefaultTimeout(15000);
    const cmd=async(a,d)=>{const result=await ui.evaluate(([action,data])=>window.browser.command(action,data),[a,d]);assert.equal(result.ok,true,result.error||a);return result;};
    const state=async()=>(await cmd('state')).state;
    // Playwright's renderer poll treats async predicates as truthy Promises.
    const until = async (predicate, arg) => { const end=Date.now()+15000; do { if(await ui.evaluate(predicate,arg))return; await new Promise(resolve=>setTimeout(resolve,50)); } while(Date.now()<end); throw new Error('Browser state did not become ready.'); };
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,1000));
    await until(async()=>(await window.browser.command('state')).state.tabs.some(tab=>tab.title==='Resize fixture'&&!tab.loading));
    await cmd('panel','settings');await cmd('devtools');
    for(const dock of ['bottom','right','left']){
      await cmd('devtools-layout',{dock,ratio:.4});
      await ui.waitForFunction(d=>document.querySelector(`[data-dock="${d}"]`).getAttribute('aria-pressed')==='true',dock);
      // IPC replies can precede the renderer's layout event, especially under Rosetta.
      await ui.locator('#tools-splitter').waitFor({state:'visible'});
      const before=(await state()).toolsLayout,handle=await ui.locator('#tools-splitter').boundingBox();
      const x=handle.x+handle.width/2,y=handle.y+Math.min(30,handle.height/2),delta=dock==='left'?60:-60;
      await ui.mouse.move(x,y);await ui.mouse.down();await ui.mouse.move(x+(dock==='bottom'?0:delta),y+(dock==='bottom'?delta:0),{steps:4});await ui.mouse.up();
      await ui.waitForFunction(()=>document.getElementById('tools-drag-shield').hidden);
      const after=(await state()).toolsLayout,growth=dock==='bottom'?after.tools.height-before.tools.height:after.tools.width-before.tools.width;
      assert.ok(Math.abs(growth-60)<=1,`${dock}: a 60 px drag grows tools by 60 px with Settings open, got ${growth}`);
    }
    await cmd('devtools');await cmd('compare');await cmd('compare-with',url);await cmd('panel','settings');
    await ui.locator('#compare-splitter').waitFor();
    const handle=await ui.locator('#compare-splitter').boundingBox();
    await ui.mouse.move(handle.x+3,handle.y+50);await ui.mouse.down();await ui.mouse.move(540,handle.y+50,{steps:4});await ui.mouse.up();
    await until(async()=>Math.abs((await window.browser.command('state')).state.compareRatio-.6)<.001);
    assert.equal(Math.round((await state()).paneLayout[0].banner.width),537,'Compare follows the 900 px area beside Settings');
    console.log('PASS native resize: bottom/left/right tools follow pointer with 42 px footer and 380 px sidebar; Compare uses actual pane width.');
  }finally{
    if(app){const exited=new Promise(resolve=>app.process().exitCode!==null?resolve():app.process().once('exit',resolve));await app.evaluate(({app})=>app.quit()).catch(()=>{});await exited;}
    server.closeAllConnections();server.close();fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
