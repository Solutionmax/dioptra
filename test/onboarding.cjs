// Real first-run UI, native view layering, profile persistence and release update controls.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
(async () => {
  const profiles = [], problems = [];
  const server = http.createServer((_req, res) => res.end('<title>Setup fixture</title><h1>Real setup site</h1>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${server.address().port}/`;
  let updateConnections = 0;
  const updateFeed = net.createServer(socket => { updateConnections++; socket.destroy(); });
  await new Promise(resolve => updateFeed.listen(0, '127.0.0.1', resolve));
  const feed = `https://127.0.0.1:${updateFeed.address().port}/`;
  let app, ui;
  const launch = async profile => {
    app = await electron.launch({cwd:root, executablePath:process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args:[...(process.getuid?.()===0?['--no-sandbox','-r',path.join(__dirname,'root-harness.cjs')]:[]), ...(process.env.DIOPTRA_TEST_EXECUTABLE?[]:['.']), `--profile-dir=${profile}`]});
    ui = await app.firstWindow(); ui.setDefaultTimeout(15000); ui.on('pageerror', error => problems.push(error.message));
    await ui.waitForFunction(() => window.browser);
    // Playwright launches Electron in the background on macOS; native keyboard focus needs an active window.
    await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0].focus();});
  };
  const quit = async () => { if (app) { await app.close(); app = null; } };
  const profile = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-setup-')); profiles.push(dir); return dir; };
  const cmd = (action, data) => ui.evaluate(([a,d]) => window.browser.command(a,d), [action,data]);
  const state = async () => (await cmd('state')).state;
  const resize = async width => app.evaluate(({BrowserWindow}, w) => BrowserWindow.getAllWindows()[0].setContentSize(w,860), width);
  const shot = async name => {
    fs.mkdirSync(path.join(root,'artifacts','onboarding'),{recursive:true});
    const png = await app.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(root,'artifacts','onboarding',name), Buffer.from(png,'base64'));
  };
  try {
    const old = profile(), oldFile = path.join(old,'settings.json');
    fs.writeFileSync(oldFile, JSON.stringify({rules:[],tabs:[site],sslVerification:true,autoUpdates:false,autoUpdatesChosen:true}));
    await launch(old);
    assert.ok((await state()).onboarding, 'app exposes the real setup state');
    assert.equal((await state()).onboarding.open, false, 'existing profiles skip automatic setup');
    await ui.waitForFunction(async () => !(await window.browser.command('state')).state.tabs[0].loading);
    assert.equal((await cmd('compare')).ok,true);
    assert.equal((await cmd('compare-with',site)).ok,true); // Unmapped comparison intentionally starts empty.
    await cmd('panel','settings'); if(await ui.locator('#settings-menu').isHidden()) await ui.click('#settings-back'); await ui.locator('#settings-menu [data-settings-category="general"]').click();
    // tab.url/loading are optimistic during startup; wait for both real native pages.
    let loaded = false;
    for(let attempt=0;attempt<150;attempt++) {
      loaded = await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents.getURL()===url && !v.webContents.isLoading()).length===2,site);
      if(loaded)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(loaded,true,'both native comparison pages loaded before setup');
    const beforeSetup = await state();
    const nativeBounds = () => app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents.getURL().startsWith('http')).map(v=>({url:v.webContents.getURL(),bounds:v.getBounds(),visible:v.getVisible()})));
    const beforeBounds = await nativeBounds();
    const windowFocused = await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused());
    await ui.click('#open-onboarding'); await ui.locator('#onboarding-dialog').waitFor();
    assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v.webContents.getURL().startsWith('http')).every(v => !v.getVisible())), true, 'native site is hidden behind setup');
    await ui.click('#onboarding-cancel');
    assert.equal((await state()).onboarding.open, false);
    assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].contentView.children.some(v => v.webContents.getURL().startsWith('http') && v.getVisible())), true, 'cancel restores native site');
    assert.deepEqual((await state()).comparison,beforeSetup.comparison,'cancel keeps comparison');
    assert.equal((await state()).panel,'settings','cancel keeps Settings sidebar');
    assert.deepEqual(await nativeBounds(),beforeBounds,'cancel restores native comparison bounds and visibility');
    assert.equal(await ui.evaluate(()=>document.activeElement.id),'open-onboarding','cancel returns keyboard target to Settings setup button');
    if(windowFocused) assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.isFocused()),true,'active window restores native UI keyboard focus');
    // Locked macOS sessions cannot gain OS focus; still verify real renderer key events and Escape cancellation.
    await ui.keyboard.press('Enter'); await ui.locator('#onboarding-dialog[open]').waitFor();
    await ui.keyboard.press('Escape'); await ui.waitForFunction(()=>!document.getElementById('onboarding-dialog').open);
    assert.deepEqual(await nativeBounds(),beforeBounds,'keyboard cancellation restores both native pages');
    assert.equal(JSON.parse(fs.readFileSync(oldFile)).autoUpdates, false);
    await quit(); await launch(old); assert.equal((await state()).onboarding.open, false, 'cancelled Settings setup never forces existing user');
    await quit();

    const fresh = profile(), file = path.join(fresh,'settings.json');
    assert.equal(fs.existsSync(file), false, 'genuinely missing settings before startup');
    await launch(fresh); await ui.locator('#onboarding-dialog').waitFor();
    assert.equal((await state()).onboarding.step, 0);
    assert.match(await ui.locator('#onboarding-install-help').innerText(), process.platform === 'darwin' ? /Applications/ : process.platform === 'win32' ? /installer/ : /AppImage/);
    await resize(1440); await shot('install-1440.png'); await resize(960); await shot('install-960.png');
    await ui.click('#onboarding-next'); assert.equal((await state()).onboarding.step,1);
    assert.equal(await ui.isChecked('#onboarding-www'), true, 'WWW defaults on');
    assert.equal(await ui.isChecked('#onboarding-ssl'), false, 'SSL exception defaults off');
    await ui.uncheck('#onboarding-www');
    assert.equal(await ui.isChecked('#onboarding-www'), false, 'WWW remains editable');
    await ui.click('#onboarding-cancel'); await quit(); await launch(fresh);
    assert.equal((await state()).onboarding.step,1, 'incomplete setup resumes after restart');
    await ui.fill('#onboarding-domain','https://setup.invalid/path'); await ui.fill('#onboarding-ip','127.0.0.1');
    await ui.click('#onboarding-next'); await ui.locator('#onboarding-error').filter({hasText:'domain name'}).waitFor();
    assert.equal((await state()).rules.length,0,'invalid first domain writes nothing');
    await ui.fill('#onboarding-domain','setup.invalid'); await ui.fill('#onboarding-ip','127.0.0.1:80'); await ui.click('#onboarding-next');
    await ui.locator('#onboarding-error').filter({hasText:'IPv4 or IPv6'}).waitFor();
    await ui.setInputFiles('#onboarding-file',{name:'servers.csv',mimeType:'text/csv',buffer:Buffer.from('name,ip\nSetup server,127.0.0.1\nIPv6 server,::1')});
    await ui.waitForFunction(() => document.getElementById('onboarding-server').options.length===3);
    await ui.selectOption('#onboarding-server','127.0.0.1');
    assert.equal(await ui.inputValue('#onboarding-ip'),'127.0.0.1');
    await ui.check('#onboarding-www'); await ui.check('#onboarding-ssl');
    await resize(960); await shot('domain-960.png'); await resize(1440); await shot('domain-1440.png');
    await ui.click('#onboarding-next');
    // Saving awaits native rule/cache work; the click only dispatches that command.
    await ui.locator('#onboarding-finish:enabled').waitFor({state:'visible'});
    let s = await state(); assert.equal(s.onboarding.step,2); assert.deepEqual(s.rules,[{domain:'setup.invalid',ip:'127.0.0.1',enabled:true,www:true,skipSSL:true}]);
    assert.equal(s.sslVerification,true); assert.equal(s.onboarding.url,'https://setup.invalid/'); assert.equal(s.servers.length,2);
    await shot('ready-1440.png'); await resize(960); await shot('ready-960.png');
    await ui.click('#onboarding-cancel'); await cmd('panel','settings'); if(await ui.locator('#settings-menu').isHidden()) await ui.click('#settings-back'); await ui.locator('#settings-menu [data-settings-category="general"]').click(); await ui.click('#open-onboarding');
    assert.equal((await state()).onboarding.step,2,'Settings resumes ready step');
    await ui.click('#onboarding-finish');
    assert.equal((await state()).onboarding.open,false); assert.equal(JSON.parse(fs.readFileSync(file)).onboardingCompleted,true);
    assert.equal((await state()).tabs.some(t=>t.url==='https://setup.invalid/'),true,'finish opens the saved first site');
    await cmd('navigate',site); await ui.waitForFunction(async()=>{const s=(await window.browser.command('state')).state;return s.tabs.find(t=>t.id===s.activeId)?.connection?.ip==='127.0.0.1';});
    await cmd('panel','settings'); if(await ui.locator('#settings-menu').isHidden()) await ui.click('#settings-back'); await ui.locator('#settings-menu [data-settings-category="general"]').click(); await ui.click('#open-onboarding'); await ui.click('#onboarding-next'); await ui.click('#onboarding-skip'); await ui.click('#onboarding-finish');
    assert.equal((await state()).tabs.filter(t=>t.url===site).length,1,'skip and finish keep current native site');
    await quit();
    fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file)),updateFeed:feed,autoUpdates:require('../package.json').privateBeta===true,autoUpdatesChosen:true}));
    await launch(fresh); assert.equal((await state()).onboarding.open,false,'completion persisted');
    await cmd('panel','settings'); if(await ui.locator('#settings-menu').isHidden()) await ui.click('#settings-back'); await ui.locator('#settings-menu [data-settings-category="general"]').click(); await ui.click('#open-onboarding'); await ui.click('#onboarding-next');
    await ui.fill('#onboarding-domain','strict-setup.invalid'); await ui.fill('#onboarding-ip','::1'); await ui.click('#onboarding-next');
    await ui.locator('#onboarding-finish:enabled').waitFor({state:'visible'});
    assert.deepEqual((await state()).rules.at(-1),{domain:'strict-setup.invalid',ip:'::1',enabled:true,www:true,skipSSL:false},'untouched switches include WWW and keep SSL strict');
    await ui.click('#onboarding-finish');

    // Beta guard remains exercised for beta builds; public releases expose the real updater.
    await app.evaluate(({app})=>Object.defineProperty(app,'isPackaged',{value:true}));
    await cmd('panel','updates');
    s = await state();
    assert.equal(s.updateFeed,feed,'saved update source remains intact');
    if(require('../package.json').privateBeta===true) {
      assert.equal(s.privateBeta,true);assert.equal(s.update.canInstall,false);assert.equal(s.update.status,'private-beta');
      assert.match(s.update.notes,/1\.0-beta/);assert.equal(s.autoUpdates,true,'future public preference preserved');
      for(const action of ['download-update','install-update','update-settings']) {
        const r=await cmd(action,{feed:'https://127.0.0.1:1/',automatic:false});assert.equal(r.ok,false);assert.match(r.error,/private beta/i);
      }
      await ui.click('#check-update');s=await state();assert.equal(s.update.status,'private-beta');assert.match(s.update.message,/No network check/);assert.equal(s.update.checkedAt,undefined);
      assert.equal((await cmd('open-release')).ok,true);assert.equal((await state()).tabs.length,s.tabs.length,'local release notes never open public website');
      assert.equal(await ui.locator('#advanced').isVisible(),false);assert.equal(await ui.locator('#auto-updates').isVisible(),false);
      await new Promise(resolve=>setTimeout(resolve,11000));
      assert.equal(await app.evaluate(()=>Object.keys(process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json').cache).some(p=>/electron-updater[\\/]/.test(p))),false,'beta startup timer never loads public updater');
      assert.equal(updateConnections,0,'beta startup and manual commands make no connection to the saved update feed');
    } else {
      assert.equal(s.privateBeta,false);assert.equal(s.update.canInstall,true);assert.notEqual(s.update.status,'private-beta');
      assert.equal(s.autoUpdates,false,'saved opt-out remains effective in the public release');
      assert.equal(await ui.locator('#advanced').isVisible(),true);assert.equal(await ui.locator('#auto-updates').isVisible(),true);
      assert.equal(await ui.locator('#check-update').isEnabled(),true);assert.match(await ui.locator('#update-version').innerText(),new RegExp(s.versions.app.replaceAll('.','\\.')));
      assert.equal((await cmd('update-settings',{feed,automatic:false})).ok,true,'public update settings are available');
      assert.equal(updateConnections,0,'opted-out public profile makes no automatic update connection');
    }
    await resize(960);await shot('updates-960.png');await resize(1440);await shot('updates-1440.png');
    assert.deepEqual(problems,[],'no renderer errors');
    console.log('PASS: fresh/existing profiles, cancel/restart/resume/reopen, validation, explicit WWW/SSL, CSV, real site/native view layering, completion/skip, release-appropriate updater controls; native screenshots 960/1440.');
  } finally { await quit(); updateFeed.close(); server.closeAllConnections(); server.close(); for(const p of profiles) fs.rmSync(p,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exit(1);});
