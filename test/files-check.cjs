// Files that did not load: the real app in a private test network (the mockup network of 5 Nov 2026). A new server
// (203.0.113.10) and the old one (198.51.100.24) with their own DNS and a test CA. The new server really fails: 404,
// 403 from a webshield, 500 on admin-ajax.php, a stylesheet sent as text/html, a font without CORS header (on a host
// with a rule), an http script on an https page; media.* has no rule, so its images still come from the old server.
// cdn.* has no rule either but is a CDN on its own address: that is not the old server.
// Needs Linux as root (network and mount namespace, so nothing touches the real network or /etc); elsewhere it says SKIP.
// FILES_CHECK_SHOTS=<dir> also saves screenshots of the window to compare with the mockup, FILES_CHECK_SIZE=1380x900 another window size.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), https = require('node:https'), dgram = require('node:dgram');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const DOMAIN = 'northwind-bakery.test', NEW = '203.0.113.10', OLD = '198.51.100.24', CDN = '192.0.2.50', APP = path.join(__dirname, '..');

function outside() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) { console.log('SKIP files check: needs Linux as root for its private test network'); return 0; }
  for (const tool of ['openssl', 'certutil', 'unshare', 'ip', 'xvfb-run']) if (spawnSync('sh', ['-c', `command -v ${tool}`]).status) { console.error(`files check needs ${tool}`); return 1; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-files-check-'));
  try {
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: 'ignore' });
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/O=Example Trust Services/CN=Example Trust CA R3']);
    run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'site.key', '-out', 'site.csr', '-subj', `/CN=${DOMAIN}`]);
    fs.writeFileSync(path.join(work, 'ext.cnf'), `subjectAltName=${['', 'www.', 'media.', 'static.', 'cdn.'].map(p => `DNS:${p}${DOMAIN}`).join(',')}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
    run('openssl', ['x509', '-req', '-in', 'site.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'site.crt', '-days', '2', '-extfile', 'ext.cnf']);
    fs.mkdirSync(path.join(work, 'home/.pki/nssdb'), { recursive: true });
    run('certutil', ['-d', 'sql:home/.pki/nssdb', '-N', '--empty-password']);
    run('certutil', ['-d', 'sql:home/.pki/nssdb', '-A', '-t', 'C,,', '-n', 'files-check-ca', '-i', 'ca.crt']);
    fs.writeFileSync(path.join(work, 'resolv.conf'), 'nameserver 127.0.0.1\n');
    const net = `ip link set lo up && ip addr add ${NEW}/32 dev lo && ip addr add ${OLD}/32 dev lo && ip addr add ${CDN}/32 dev lo && mount --bind ${work}/resolv.conf /etc/resolv.conf`;
    const result = spawnSync('unshare', ['-n', '-m', 'sh', '-c', `${net} && exec xvfb-run -a -s '-screen 0 1440x1200x24' node ${JSON.stringify(__filename)}`], { stdio: 'inherit', env: { ...process.env, FILES_CHECK_WORK: work, HOME: path.join(work, 'home') } });
    return result.status ?? 1;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// Tiny DNS: the public zone on 127.0.0.1 (with PTR names for both servers), the new server's own zone on its address.
const TYPE = { 1: 'A', 2: 'NS', 5: 'CNAME', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA' }, CODE = Object.fromEntries(Object.entries(TYPE).map(([n, t]) => [t, Number(n)]));
const encodeName = n => Buffer.concat([...n.split('.').filter(Boolean).map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
const RDATA = { A: v => Buffer.from(v.split('.').map(Number)), CNAME: encodeName, NS: encodeName, PTR: encodeName };
function rr(owner, type, value) { const data = RDATA[type](value), head = Buffer.alloc(10); head.writeUInt16BE(CODE[type], 0); head.writeUInt16BE(1, 2); head.writeUInt32BE(60, 4); head.writeUInt16BE(data.length, 8); return Buffer.concat([encodeName(owner), head, data]); }
function dnsOn(address, records) {
  const socket = dgram.createSocket('udp4').on('message', (msg, peer) => {
    let off = 12; const labels = []; while (msg[off]) { labels.push(msg.subarray(off + 1, off + 1 + msg[off]).toString()); off += msg[off] + 1; }
    const asked = labels.join('.').toLowerCase(), type = TYPE[msg.readUInt16BE(off + 1)], question = msg.subarray(12, off + 5);
    const known = Object.keys(records).some(k => k.startsWith(asked + ' ')), answers = [];
    if (known) { const alias = type !== 'CNAME' && records[asked + ' CNAME']?.[0], owner = alias || asked; if (alias) answers.push(rr(asked, 'CNAME', alias)); for (const v of records[owner + ' ' + type] || []) answers.push(rr(owner, type, v)); }
    const head = Buffer.alloc(12); msg.copy(head, 0, 0, 2); head.writeUInt16BE(known ? 0x8580 : 0x8583, 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(answers.length, 6);
    socket.send(Buffer.concat([head, question, ...answers]), peer.port, peer.address);
  });
  return new Promise(resolve => socket.bind(53, address, resolve));
}
const PUBLIC_DNS = { [`${DOMAIN} A`]: [OLD], [`www.${DOMAIN} CNAME`]: [DOMAIN], [`media.${DOMAIN} A`]: [OLD], [`static.${DOMAIN} A`]: [OLD], [`cdn.${DOMAIN} A`]: [CDN], '10.113.0.203.in-addr.arpa PTR': ['server12.newhost.example'], '24.100.51.198.in-addr.arpa PTR': ['web03.oldhost.example'] };
const NEW_DNS = { [`${DOMAIN} A`]: [NEW], [`www.${DOMAIN} CNAME`]: [DOMAIN] };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Northwind Bakery</title>
<style>@font-face{font-family:Brand;src:url(https://static.${DOMAIN}/fonts/brand.woff2) format("woff2")}h1{font-family:Brand,Georgia,serif}</style>
<link rel="stylesheet" href="/wp-content/themes/hearth/style.css"><link rel="stylesheet" href="/wp-content/plugins/elementor/assets/css/frontend.min.css">
<script src="/wp-includes/js/jquery/jquery.min.js"></script><script src="/wp-content/plugins/woocommerce/assets/js/frontend.js"></script>
<script src="http://${DOMAIN}/wp-content/plugins/cookie-notice/js/front.js"></script></head>
<body><h1>Fresh every morning</h1><img src="/wp-content/uploads/2026/10/hero.jpg" width="280" height="130" alt="">
<img src="https://cdn.${DOMAIN}/logo.jpg" width="40" height="40" alt=""><img src="https://media.${DOMAIN}/wp-content/uploads/2026/10/sourdough.jpg" width="160" height="70" alt=""><img src="https://media.${DOMAIN}/wp-content/uploads/2026/10/pastries.jpg" width="160" height="70" alt="">
<script>fetch('/wp-admin/admin-ajax.php?action=get_refreshed_fragments', { method: 'POST' });</script></body></html>`;
function serve(side, tls, pageHeaders) {
  const font = fs.readFileSync(path.join(APP, 'src/fonts/plus-jakarta-sans-latin.woff2'));
  const reply = (res, status, type, body, headers = {}) => { res.writeHead(status, { 'Content-Type': type, ...headers }); res.end(body); };
  return https.createServer(tls, (req, res) => {
    const p = req.url.split('?')[0], host = String(req.headers.host || '').split(':')[0], isNew = side === 'new';
    if (host === `static.${DOMAIN}`) return reply(res, 200, 'font/woff2', font, isNew ? {} : { 'Access-Control-Allow-Origin': '*' });
    if (p.endsWith('.jpg')) return reply(res, 200, 'image/png', PNG);
    if (p.endsWith('/style.css')) return isNew ? reply(res, 404, 'text/html', '<h1>404 Not Found</h1>') : reply(res, 200, 'text/css', 'body{margin:0}');
    if (p.endsWith('/frontend.min.css')) return isNew ? reply(res, 200, 'text/html', '<h1>Briefly unavailable for scheduled maintenance.</h1>') : reply(res, 200, 'text/css', 'h1{color:#3a2413}');
    if (p.endsWith('/jquery.min.js')) return isNew ? reply(res, 403, 'text/html', '<h1>Access denied</h1>', { Server: 'imunify360-webshield/1.21' }) : reply(res, 200, 'text/javascript', 'window.jQuery=function(f){if(typeof f==="function")document.addEventListener("DOMContentLoaded",f)};');
    if (p.endsWith('/frontend.js')) return reply(res, 200, 'text/javascript', 'jQuery(function(){});');
    if (p === '/wp-admin/admin-ajax.php') return isNew ? reply(res, 500, 'text/html', 'Internal Server Error') : reply(res, 200, 'application/json', '{"fragments":{}}');
    reply(res, 200, 'text/html; charset=utf-8', PAGE, pageHeaders);
  });
}

async function inside() {
  const { _electron: electron } = require('playwright');
  const work = process.env.FILES_CHECK_WORK, shots = process.env.FILES_CHECK_SHOTS, sleep = ms => new Promise(r => setTimeout(r, ms));
  const tls = { key: fs.readFileSync(path.join(work, 'site.key')), cert: fs.readFileSync(path.join(work, 'site.crt')) };
  await dnsOn('127.0.0.1', PUBLIC_DNS); await dnsOn(NEW, NEW_DNS);
  const servers = [serve('new', tls, { Server: 'nginx/1.26.2' }), serve('old', tls, { Server: 'LiteSpeed' }), serve('cdn', tls, {})];
  await Promise.all(servers.map((s, i) => new Promise(r => s.listen(443, [NEW, OLD, CDN][i], r))));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-files-profile-')), home = `https://${DOMAIN}/`;
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ autoUpdates: false, autoUpdatesChosen: true, onboardingCompleted: true, tabs: [home], rules: [{ domain: DOMAIN, ip: NEW, enabled: true, www: true }, { domain: `static.${DOMAIN}`, ip: NEW, enabled: true }] }));
  let app, stderr = '';
  try {
    app = await electron.launch({ executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs'), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`], cwd: APP, env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(work, 'ca.crt') } });
    app.process().stderr.on('data', chunk => { stderr += chunk; });
    const ui = await app.firstWindow(); ui.setDefaultTimeout(20000); await ui.waitForFunction(() => window.browser);
    const [width, height] = (process.env.FILES_CHECK_SIZE || '1440x1200').split('x').map(Number); // the mockup size; the app opens at 1380x900
    await app.evaluate(({ BaseWindow }, [width, height]) => BaseWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width, height }), [width, height]);
    const cmd = (action, data) => ui.evaluate(([a, d]) => window.browser.command(a, d), [action, data]);
    const st = async () => (await cmd('state')).state;
    async function wait(check, label, ms = 20000) { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await check(); if (last) return last; await sleep(100); } const s = await st(); throw new Error(`${label}: ${JSON.stringify([s.view, s.tabs.map(t => [t.mode, t.url, t.loading, t.files]), s.files && { measuring: s.files.measuring, rows: s.files.rows.map(r => `${r.name} ${r.side} ${r.hostfile.status}`), counts: s.files.counts }])}`); }
    const shot = async name => { if (!shots) return; await sleep(900); fs.mkdirSync(shots, { recursive: true }); execFileSync('import', ['-window', 'root', path.join(shots, name)]); };
    const clip = () => app.evaluate(({ clipboard }) => clipboard.readText());
    const host = await wait(async () => (await st()).tabs.find(t => t.mode === 'hostfile' && !t.loading && t.title === 'Northwind Bakery'), 'Hostfile page');

    // 1. Compare: both panes measure what really failed.
    assert.equal((await cmd('compare')).ok, true);
    const settled = async () => { const s = await st(), h = s.tabs.find(t => t.id === host.id), l = s.tabs.find(t => t.mode === 'live'); return h?.files.failed === 5 && h.files.both === 1 && h.files.old === 2 && l && !l.loading && l.files.failed === 0 && l.files.both === 1 && [h, l]; };
    const [h1, l1] = await wait(settled, 'chips counts in Compare');
    assert.deepEqual(h1.files.oldHosts, [`media.${DOMAIN}`], 'the CDN host of the same site is not the old server'); assert.equal(h1.files.compared, true);
    const hostChips = ui.locator('#pane-bars .route-bar.hostfile .route-failed'), liveChips = ui.locator('#pane-bars .route-bar.live .route-failed');
    await wait(async () => (await hostChips.count()) === 2 && (await liveChips.count()) === 1, 'chips in both pane bars');
    assert.deepEqual(await hostChips.allInnerTexts(), ['5 files failed', '2 from old server']);
    assert.match(await hostChips.first().getAttribute('title'), /^5 files failed only on this server\. 1 more fails on both servers\./);
    assert.match(await hostChips.nth(1).getAttribute('title'), /media\.northwind-bakery\.test has no domain rule/);
    assert.equal(await liveChips.innerText(), '1 file failed');
    assert.match(await liveChips.getAttribute('class'), /\bboth\b/);
    assert.match(await liveChips.getAttribute('title'), /^1 file did not load here\. It fails on the new server too, so it is not a migration difference\./);
    await shot('files-1-compare.png');

    // 2. The chip opens Differences on the Files part; the Live record stays after the Live pane closes.
    await hostChips.first().click();
    const box = ui.locator('#differences');
    await box.locator('.diff-menu').waitFor();
    const menu = id => box.locator(`.dm-row[data-part="${id}"]`), over = id => box.locator(`.ov-part[data-part="${id}"]`), flat = async l => (await l.innerText()).replace(/\s+/g, ' ').trim();
    await wait(async () => (await st()).view === 'differences' && (await st()).differences.status === 'done', 'Differences report');
    assert.equal(await box.locator('.dm-row[aria-current=true] strong').innerText(), 'Files', 'the Files part is open');
    const tag = menu('files').locator('.stag');
    await wait(async () => (await tag.innerText()) === '5 failed', 'Files tag with the count of files failing only on Hostfile');
    assert.match(await tag.getAttribute('class'), /\bis-fix\b/);
    assert.equal((await flat(box.locator('.dch'))).toLowerCase(), 'files images, styles and scripts that failed 5 failed built in reload both copy list');
    const rows = box.locator('.dscroll.files > div > table').first().locator('tbody tr');
    assert.equal(await rows.count(), 6);
    const row = name => rows.filter({ has: ui.locator('.fname', { hasText: name }) }).innerText();
    assert.match(await row('style.css'), /stylesheet\s+404 Not Found\s+200 OK\s+Only Hostfile/);
    assert.match(await row('frontend.min.css'), /Refused: not CSS\s+server sent text\/html with 200\s+200 OK/);
    assert.match(await row('brand.woff2'), /static\.northwind-bakery\.test\/fonts\/brand\.woff2[\s\S]*font\s+Blocked by CORS\s+no Access-Control-Allow-Origin\s+200 OK/);
    assert.match(await row('jquery.min.js'), /script\s+403 Forbidden\s+imunify360-webshield\s+200 OK\s+Only Hostfile/);
    assert.match(await row('admin-ajax.php'), /\/wp-admin\/admin-ajax\.php\?action=get_refreshed_fragments[\s\S]*background request\s+500 Internal Server Error\s+200 OK/);
    assert.match(await row('front.js'), /http:\/\/northwind-bakery\.test\/wp-content\/plugins\/cookie-notice\/js\/front\.js[\s\S]*script\s+Blocked: http on https\s+Blocked: http on https\s+On both/);
    assert.match(await rows.filter({ hasText: 'front.js' }).getAttribute('class'), /\bboth\b/);
    // The findings are still in the state (Ask Claude sends them); the Overview shows the worst three of the part.
    const findings = (await st()).files.findings.map(f => `${f.title}${f.detail ? ` ${f.detail}` : ''}`);
    for (const text of ['Stylesheet style.css fails on Hostfile (404 Not Found) but loads on Live. Pages on the new server look unstyled.',
      'Stylesheet frontend.min.css is refused on Hostfile. The new server sends a text/html page instead of CSS.',
      '2 images on the new server pane come from the old server. media.northwind-bakery.test has no domain rule. They break when the old server goes away.',
      'JavaScript error only on Hostfile: jQuery is not defined. jquery.min.js is blocked by the firewall (403, imunify360-webshield).',
      'Script front.js is blocked on both servers: http on an https page.']) assert.ok(findings.includes(text), `finding: ${text}\n${findings.join('\n')}`);
    assert.ok(findings.some(t => /^2 more files fail only on Hostfile: (brand\.woff2 \(CORS\), admin-ajax\.php \(500\)|admin-ajax\.php \(500\), brand\.woff2 \(CORS\))\.$/.test(t)), findings.join('\n'));
    await menu('overview').click(); await box.locator('.dverdict.worse').waitFor();
    assert.match(await flat(box.locator('.dverdict .sv-fx')), /need(s)? a fix on the new server first: (.*, )?Files[,.]/);
    assert.equal(await box.locator('.dstep b').first().innerText(), 'Fix before the switch');
    assert.equal(await flat(over('files').locator('.ov-head')), 'Files Only on Hostfile · 2 from old server · 1 on both 5 failed ›');
    assert.deepEqual(await over('files').locator('.ov-tops li').allInnerTexts(), ['Stylesheet style.css fails on Hostfile (404 Not Found) but loads on Live', 'Stylesheet frontend.min.css is refused on Hostfile', '2 images on the new server pane come from the old server', 'and 2 more']);
    assert.equal(await menu('headers').locator('.stag.is-info').count(), 1, 'the header differences are to read, not judged');
    await over('files').click(); await box.locator('.dscroll.files').waitFor();
    const old = box.locator('.fsec').filter({ hasText: 'Loaded from the old server' });
    await wait(async () => /web03\.oldhost\.example/.test(await old.innerText()), 'reverse name of the old server');
    assert.match((await old.innerText()).replace(/\s+/g, ' '), /media\.northwind-bakery\.test has no domain rule, so the new server pane fetched these files from 198\.51\.100\.24 \(web03\.oldhost\.example\)\. They break when the old server goes away\./);
    assert.equal(await old.getByRole('button').innerText(), `Add rule: media.${DOMAIN} → ${NEW}`);
    assert.equal(await old.locator('tbody tr').count(), 2);
    const js = box.locator('.fsec').filter({ hasText: 'JavaScript errors only on Hostfile' });
    assert.match((await js.locator('tbody').innerText()).replace(/\s+/g, ' '), /^Uncaught ReferenceError: jQuery is not defined \/wp-content\/plugins\/woocommerce\/assets\/js\/frontend\.js:1$/);
    await shot('files-2-differences.png');

    // 3. Copy list and Ask Claude: plain text, files inside the untrusted block.
    await box.getByRole('button', { name: 'Copy list' }).click();
    await wait(async () => (await clip()).startsWith(`Dioptra: files that did not load on ${home}`), 'copied list');
    const copied = await clip();
    assert.match(copied, /jquery\.min\.js \(script\): Hostfile 403 Forbidden \(imunify360-webshield\), Live 200 OK \[only Hostfile\]/);
    assert.match(copied, /front\.js \(script\): Hostfile Blocked: http on https, Live Blocked: http on https \[on both\]/);
    assert.match(copied, /sourdough\.jpg \(image\) from 198\.51\.100\.24 \(web03\.oldhost\.example\)/);
    assert.equal((await cmd('differences-ask-claude')).ok, true);
    const summary = await clip(), begin = summary.indexOf('BEGIN UNTRUSTED SERVER DATA'), end = summary.indexOf('END UNTRUSTED SERVER DATA');
    assert.ok(begin > 0 && begin < summary.indexOf('Files that did not load') && summary.indexOf('jQuery is not defined') < end, 'files and JavaScript errors inside the untrusted block');

    // 4. Single view keeps the chips, against the Live record the Hostfile tab kept.
    await ui.locator('#view-single').click();
    const single = ui.locator('#route-bar .route-failed');
    await wait(async () => (await single.count()) === 2, 'chips in the single view');
    assert.deepEqual(await single.allInnerTexts(), ['5 files failed', '2 from old server']);
    await shot('files-3-single.png');

    // 5. Reload both from Differences: stays in Differences, measures Live again in a hidden view, same result.
    await single.first().click();
    await box.locator('.diff-menu').waitFor();
    await box.getByRole('button', { name: 'Reload both' }).click();
    await wait(async () => (await st()).files?.measuring === true, 'measuring after Reload both', 5000);
    await wait(async () => { const s = await st(); return s.view === 'differences' && s.files && !s.files.measuring && s.files.counts.only === 5 && s.files.counts.both === 1 && s.files.counts.old === 2 && s.files.counts.errors === 1; }, 'measured again');
    assert.equal((await st()).tabs.filter(t => t.mode === 'live').length, 0, 'the hidden Live view is not a tab');

    // 6. Open: the file in a new tab through the new server.
    const before = (await st()).tabs.length;
    await rows.filter({ hasText: 'style.css' }).getByRole('button', { name: /^Open/ }).click();
    const opened = await wait(async () => { const s = await st(); return s.tabs.length === before + 1 && s.tabs.find(t => t.id === s.activeId && /style\.css$/.test(t.url) && !t.loading); }, 'file opened in a new tab');
    assert.equal(opened.mode, 'hostfile'); assert.equal(opened.route.label, 'HOSTFILE');
    assert.equal((await cmd('close-tab', opened.id)).ok, true); assert.equal((await cmd('activate', host.id)).ok, true);

    // 7. Add rule: media.* goes to the new server, nothing comes from the old server any more.
    assert.equal((await cmd('files-add-rule', `cdn.${DOMAIN}`)).ok, false, 'only a host this page really loaded from the old server');
    await ui.locator('#route-bar .route-failed').first().click();
    await box.getByText('Loaded from the old server').waitFor();
    await box.getByRole('button', { name: `Add rule: media.${DOMAIN} → ${NEW}` }).click();
    await wait(async () => (await st()).rules.some(r => r.domain === `media.${DOMAIN}` && r.ip === NEW && r.enabled), 'rule added');
    await wait(async () => { const s = await st(), h = s.tabs.find(t => t.id === host.id); return !h.loading && h.files.old === 0 && h.files.failed === 5 && s.view === 'differences' && s.differences.status === 'done'; }, 'page reloaded without the old server');
    await wait(async () => (await box.locator('.fsec').filter({ hasText: 'Loaded from the old server' }).count()) === 0, 'old server section gone');
    assert.deepEqual(await ui.locator('#route-bar .route-failed').allInnerTexts(), ['5 files failed']);

    // 8. Another page without a Live measurement: Not measured.
    assert.equal((await cmd('navigate', `${home}about/`)).ok, true);
    await wait(async () => { const t = (await st()).tabs.find(t => t.id === host.id); return !t.loading && t.url === `${home}about/` && t.files.failed === 6; }, 'other page loaded');
    assert.equal((await cmd('view', 'differences')).ok, true);
    // The tab itself knows what failed on the new server: the part says the same as the label in the server bar.
    await wait(async () => (await tag.innerText().catch(() => '')) === '6 failed', 'the files that failed on the new server alone');
    assert.match(await tag.getAttribute('class'), /\bis-check\b/);
    assert.equal(await ui.locator('#route-bar .route-failed').first().innerText(), '6 files failed');
    assert.match(await box.locator('.dscroll.files .fnote').first().innerText(), /^Failed on the new server while this tab loaded the page\. Open Compare to check them on Live/);
    assert.deepEqual(await box.locator('.dscroll.files thead th').evaluateAll(n => n.map(x => x.textContent)), ['File', 'Loaded as', 'Hostfile']);
    assert.equal(await box.locator('.dscroll.files tbody tr').count(), 6);
    assert.equal(await box.locator('.dscroll.files .pill').count(), 0, 'no "Only Hostfile" claim without a Live measurement');
    await menu('overview').click();
    assert.equal(await flat(over('files').locator('.ov-head small')), 'New server only, open Compare to check them on Live');
    assert.equal(await box.locator('.ov-part[data-part=files]').evaluate(n => n.parentElement.previousElementSibling.querySelector('b').textContent), 'Look at once');
    assert.match(await ui.locator('#route-bar .route-failed').first().getAttribute('title'), /Open Compare to check them on Live/);

    assert.doesNotMatch(stderr, /observer failed|main process error|unhandled rejection/i, stderr);
    console.log('PASS Files check: chips red and orange, Files card and tab, old server with Add rule, JavaScript error only on Hostfile, Copy list, Ask Claude, Reload both, Open, Not measured');
  } catch (error) { console.error(`app output:\n${stderr.slice(-6000)}`); throw error; } finally {
    await app?.close().catch(() => {});
    for (const s of servers) { s.closeAllConnections(); s.close(); }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.env.FILES_CHECK_WORK) inside().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
else process.exit(outside());
