// Real Electron shell: category navigation, saved-library actions, draft preservation,
// and the Claude command boundary (network/install operations are intercepted).
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..'), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-settings-library-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({rules:[],tabs:['about:blank'],autoUpdates:false,autoUpdatesChosen:true,claudeAutoCheck:false}));
  fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({
    bookmarks:[{title:'Alpha saved page',url:'https://alpha.example/'},{title:'Beta saved page',url:'https://beta.example/'}],
    history:[{title:'Recent visit',url:'https://visit.example/',visitedAt:Date.now()}],
    downloads:[{id:'complete-1',name:'report.pdf',path:path.join(profile,'report.pdf'),url:'https://files.example/report.pdf',state:'completed',received:1048576,total:1048576}]
  }));
  let app;
  try {
    app = await electron.launch({cwd:root,executablePath:process.env.DIOPTRA_TEST_EXECUTABLE||undefined,args:[...(process.getuid?.()===0?['--no-sandbox','-r',path.join(__dirname,'root-harness.cjs')]:[]),...(process.env.DIOPTRA_TEST_EXECUTABLE?[]:['.']),`--profile-dir=${profile}`]});
    const ui = await app.firstWindow(); ui.setDefaultTimeout(15000);
    const errors=[];ui.on('pageerror',error=>errors.push(error.message));
    const cmd=(action,data)=>ui.evaluate(([a,d])=>window.browser.command(a,d),[action,data]);
    await ui.locator('#settings').click();
    assert.equal(await ui.locator('#settings-menu button').count(),6,'Settings provides six reachable categories');
    await ui.locator('#settings-menu [data-settings-category="general"]').click();
    assert.ok(await ui.locator('#open-onboarding').isVisible(),'General exposes the real setup guide');
    await ui.locator('#settings-back').click();
    await ui.locator('#settings-menu [data-settings-category="servers"]').click();
    await ui.locator('#server-file').setInputFiles({name:'servers.csv',mimeType:'text/csv',buffer:Buffer.from('web01,203.0.113.10\n')});
    await ui.locator('#servers').getByText('web01',{exact:true}).waitFor();
    assert.equal((await cmd('state')).state.servers[0].ip,'203.0.113.10');
    await ui.locator('#settings-back').click();
    await ui.locator('#settings-menu [data-settings-category="browsing"]').click();
    assert.ok(await ui.locator('#manage-ssl').isVisible());
    await ui.locator('#manage-ssl').click();await ui.locator('#domain-input').fill('unfinished.example');
    await ui.locator('#settings').click();await ui.locator('#settings-menu [data-settings-category="updates"]').click();
    await ui.locator('#advanced summary').click();await ui.locator('#feed').fill('https://draft.example/');
    await cmd('save-rules',[]);
    assert.equal(await ui.locator('#feed').inputValue(),'https://draft.example/','state broadcasts preserve an update-feed draft');
    await ui.locator('#settings-back').click();await ui.locator('#settings-menu [data-settings-category="about"]').click();
    assert.match(await ui.locator('#about-version').innerText(),new RegExp((await cmd('state')).state.versions.app.replaceAll('.','\\.')));
    await ui.locator('#domains').click();assert.equal(await ui.locator('#domain-input').inputValue(),'unfinished.example');
    await ui.locator('#footer-version').click();await ui.locator('#update-section').waitFor();assert.ok(await ui.locator('#update-section').isVisible(),'version shortcut opens nested app updates');
    assert.equal(await ui.locator('#feed').inputValue(),'https://draft.example/','feed draft survives leaving its category and later state broadcasts');
    await ui.locator('#settings-back').click();assert.ok(await ui.locator('#settings-menu').isVisible());
    fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});await ui.screenshot({path:path.join(root,'artifacts','v1-settings.png')});

    await ui.locator('#library').click();await ui.locator('#library-search').fill('BETA');
    assert.equal(await ui.locator('.library-entry').count(),1);assert.match(await ui.locator('#library-list').innerText(),/Beta saved page/);
    await ui.evaluate(()=>{document.getElementById('library-search').setSelectionRange(1,3);});
    await cmd('save-rules',[]);
    assert.equal(await ui.locator('#library-search').inputValue(),'BETA');
    assert.deepEqual(await ui.evaluate(()=>[document.activeElement.id,document.getElementById('library-search').selectionStart,document.getElementById('library-search').selectionEnd]),['library-search',1,3]);
    await ui.locator('#library-search').fill('missing');assert.match(await ui.locator('#library-list').innerText(),/No results/);
    await ui.locator('#library-search').fill('beta');await ui.getByRole('button',{name:'Remove bookmark Beta saved page',exact:true}).click();
    assert.equal((await cmd('state')).state.library.bookmarks.length,1,'remove action changes persisted bookmarks');
    await ui.locator('[data-library="history"]').click();assert.equal(await ui.locator('#library-search').inputValue(),'');
    await ui.locator('#clear-library').click();assert.ok(await ui.locator('#clear-library-confirm').isVisible());
    assert.equal((await cmd('state')).state.library.history.length,1,'opening clear confirmation does not erase history');
    await ui.locator('#clear-library-cancel').click();assert.equal((await cmd('state')).state.library.history.length,1);
    await ui.locator('#clear-library').click();await ui.locator('#clear-library-yes').click();
    await ui.waitForFunction(()=>document.getElementById('library-list').textContent.includes('No history yet'));
    await ui.locator('[data-library="downloads"]').click();assert.ok(await ui.getByRole('button',{name:'Show report.pdf in folder',exact:true}).isVisible());
    await ui.screenshot({path:path.join(root,'artifacts','v1-library.png')});
    await ui.locator('#clear-library').click();await ui.locator('#clear-library-yes').click();
    await ui.waitForFunction(()=>document.getElementById('library-list').textContent.includes('No downloads yet'));

    await ui.locator('#settings').click();await ui.locator('#settings-menu [data-settings-category="claude"]').click();
    assert.ok(await ui.locator('#settings-install-claude').isVisible(),'absent extension offers real install action');
    const state=(await cmd('state')).state;
    await app.evaluate(({ipcMain,BrowserWindow})=>{
      const shell=BrowserWindow.getAllWindows()[0].webContents, send=shell.send.bind(shell);
      shell.send=(channel,...args)=>send(channel,...(channel==='state'&&globalThis.claudeUIFixture?[{...args[0],panel:'settings',claude:globalThis.claudeUIFixture}]:args));
      const original=ipcMain._invokeHandlers.get('browser');globalThis.uiCommands=[];
      ipcMain.removeHandler('browser');ipcMain.handle('browser',(event,action,data)=>{
        if(['claude-check-update','claude-install-update','claude-update-settings','claude-refresh','remove-claude','install-claude','claude-check'].includes(action)){
          globalThis.uiCommands.push({action,data});if(action==='claude-update-settings')globalThis.claudeUIFixture.autoCheck=data.autoCheck;return {ok:true,diagnostics:{interface:'new',browserPermissionAccepted:true,newInterfaceEnabled:true,featureCachePresent:true,featureCacheAgeSeconds:1,extensionVersion:'1.0.94',lastInterfaceSignal:null,requests:{}}};
        }
        return original(event,action,data);
      });
    });
    const emit=async claude=>app.evaluate(({BrowserWindow},data)=>{globalThis.claudeUIFixture=data.claude;BrowserWindow.getAllWindows()[0].webContents.send('state',data);},{...state,panel:'settings',claude});
    const calls=()=>app.evaluate(()=>globalThis.uiCommands);
    await ui.locator('#settings-install-claude').click();assert.ok(await ui.locator('#claude-install-confirm').isVisible());
    assert.equal((await calls()).length,0);await ui.locator('#claude-install-cancel').click();
    await ui.locator('#settings-install-claude').click();await ui.locator('#claude-install-yes').click();
    assert.equal((await calls()).at(-1).action,'install-claude');await app.evaluate(()=>{globalThis.uiCommands=[];});
    await emit({status:'ready',version:'1.0.94',message:'',autoCheck:true,update:{status:'available',version:'1.0.95',message:'A newer extension is available.'}});
    await ui.locator('#claude-update-action').click();assert.equal((await calls()).length,0);
    await ui.locator('#claude-update-cancel').click();assert.equal((await calls()).length,0);await ui.locator('#claude-update-action').click();
    await ui.locator('#claude-update-yes').click();assert.equal((await calls()).at(-1).action,'claude-install-update');
    await ui.locator('#claude-troubleshooting summary').first().click();await ui.locator('#claude-refresh').click();
    assert.ok(await ui.locator('#claude-reload-confirm').isVisible());assert.equal((await calls()).length,1);
    await ui.locator('#claude-reload-cancel').click();await ui.locator('#claude-refresh').click();await ui.locator('#claude-reload-yes').click();
    assert.equal((await calls()).at(-1).action,'claude-refresh');
    await ui.locator('#remove-claude').click();assert.equal((await calls()).length,2);await ui.locator('#claude-remove-cancel').click();
    await ui.locator('#claude-check').click();await ui.locator('#claude-report').waitFor();
    assert.match(await ui.locator('#claude-results').innerText(),/Extension/);assert.ok(await ui.locator('#claude-diagnostics').isHidden(),'technical diagnostics start collapsed');
    await ui.locator('#claude-auto-updates').click();assert.deepEqual((await calls()).at(-1),{action:'claude-update-settings',data:{autoCheck:false}});
    await ui.evaluate(()=>document.querySelector('#panel .panel-scroll').scrollTop=0);await ui.screenshot({path:path.join(root,'artifacts','v1-claude-settings.png')});
    await emit({status:'ready',version:'1.0.94',message:'',autoCheck:false,update:{status:'checking',message:'Checking…'}});
    assert.ok(await ui.locator('#claude-update-action').isDisabled());
    await emit({status:'ready',version:'1.0.94',message:'',autoCheck:false,update:{status:'error',message:'Network unavailable'}});
    assert.match(await ui.locator('#claude-update-message').innerText(),/Network unavailable/);assert.ok(await ui.locator('#claude-update-action').isEnabled());
    await ui.locator('#claude-update-action').click();assert.equal((await calls()).at(-1).action,'claude-check-update');
    await ui.locator('#remove-claude').click();await ui.locator('#claude-remove-yes').click();assert.equal((await calls()).at(-1).action,'remove-claude');
    assert.deepEqual(errors,[],'renderer stays error free');
    console.log('Settings and Library UI: navigation, persistence, actions, confirmations and update states passed.');
  } finally {
    if(app){const exited=new Promise(resolve=>app.process().exitCode!==null?resolve():app.process().once('exit',resolve));await app.evaluate(({app})=>app.quit()).catch(()=>{});await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Dioptra did not quit within 20 s')),20000);timer.unref();})]);}
    fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
