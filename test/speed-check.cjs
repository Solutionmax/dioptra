// Speed and Checks: the real app in a private test network (the mockup network of 5 Nov 2026, v2). The new server
// (203.0.113.10) answers the page after about 650 ms, without compression or page cache, says noindex, still uses old
// addresses (the old server IP with a temporary URL, the staging copy, an http link), has no WordPress rewrite (pretty
// permalinks 404) and leaves xmlrpc.php open. The old server (198.51.100.24) answers after about 120 ms, compressed,
// from its LiteSpeed page cache. Then Live cannot be reached (1.2.0-beta.3): first the public DNS has no record for the
// site, then it points to 198.51.100.30 where nothing listens (refused), and at last Live answers again. Needs Linux as
// root (network and mount namespace, so nothing touches the real network or /etc; iptables counts the connections to
// the refused address); elsewhere it says SKIP. SPEED_CHECK_SHOTS=<dir> saves screenshots at 1440x1200 and 1180 wide.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), https = require('node:https'), http = require('node:http'), dgram = require('node:dgram'), zlib = require('node:zlib');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const DOMAIN = 'northwind-bakery.test', NEW = '203.0.113.10', OLD = '198.51.100.24', REFUSED = '198.51.100.30', APP = path.join(__dirname, '..');

function outside() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) { console.log('SKIP speed check: needs Linux as root for its private test network'); return 0; }
  for (const tool of ['openssl', 'certutil', 'unshare', 'ip', 'iptables', 'xvfb-run']) if (spawnSync('sh', ['-c', `command -v ${tool}`]).status) { console.error(`speed check needs ${tool}`); return 1; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-speed-check-'));
  try {
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: 'ignore' });
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/O=Example Trust Services/CN=Example Trust CA R3']);
    run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'site.key', '-out', 'site.csr', '-subj', `/CN=${DOMAIN}`]);
    // IP SAN: the old server also answers https on its bare address (the temporary URL /~northwind/ of the old account).
    fs.writeFileSync(path.join(work, 'ext.cnf'), `subjectAltName=DNS:${DOMAIN},DNS:www.${DOMAIN},DNS:staging.${DOMAIN},IP:${OLD}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
    run('openssl', ['x509', '-req', '-in', 'site.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'site.crt', '-days', '2', '-extfile', 'ext.cnf']);
    if (!spawnSync('sh', ['-c', 'command -v convert']).status) {
      run('convert', ['-size', '1120x520', 'radial-gradient:#f0cf9c-#8f4f22', '-quality', '86', 'hero.jpg']);
      run('convert', ['-size', '96x96', 'xc:#8a4b22', 'logo.png']);
    }
    fs.mkdirSync(path.join(work, 'home/.pki/nssdb'), { recursive: true });
    run('certutil', ['-d', 'sql:home/.pki/nssdb', '-N', '--empty-password']);
    run('certutil', ['-d', 'sql:home/.pki/nssdb', '-A', '-t', 'C,,', '-n', 'speed-check-ca', '-i', 'ca.crt']);
    fs.writeFileSync(path.join(work, 'resolv.conf'), 'nameserver 127.0.0.1\n');
    // Nothing listens on REFUSED; the rule without a target only counts the connection attempts (SYN) to it.
    const net = `ip link set lo up && ip addr add ${NEW}/32 dev lo && ip addr add ${OLD}/32 dev lo && ip addr add ${REFUSED}/32 dev lo && iptables -A OUTPUT -d ${REFUSED} -p tcp --syn && mount --bind ${work}/resolv.conf /etc/resolv.conf`;
    const result = spawnSync('unshare', ['-n', '-m', 'sh', '-c', `${net} && exec xvfb-run -a -s '-screen 0 1440x1500x24' node ${JSON.stringify(__filename)}`], { stdio: 'inherit', env: { ...process.env, SPEED_CHECK_WORK: work, HOME: path.join(work, 'home') } });
    return result.status ?? 1;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// Tiny DNS: the public zone on 127.0.0.1 (with PTR names for both servers), the new server's own zone on its address.
const TYPE = { 1: 'A', 2: 'NS', 5: 'CNAME', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA' }, CODE = Object.fromEntries(Object.entries(TYPE).map(([n, t]) => [t, Number(n)]));
const encodeName = n => Buffer.concat([...n.split('.').filter(Boolean).map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
const RDATA = { A: v => Buffer.from(v.split('.').map(Number)), CNAME: encodeName, NS: encodeName, PTR: encodeName };
function rr(owner, type, value) { const data = RDATA[type](value), head = Buffer.alloc(10); head.writeUInt16BE(CODE[type], 0); head.writeUInt16BE(1, 2); head.writeUInt32BE(60, 4); head.writeUInt16BE(data.length, 8); return Buffer.concat([encodeName(owner), head, data]); }
function dnsOn(address, records, seen = () => {}) {
  const socket = dgram.createSocket('udp4').on('message', (msg, peer) => {
    let off = 12; const labels = []; while (msg[off]) { labels.push(msg.subarray(off + 1, off + 1 + msg[off]).toString()); off += msg[off] + 1; }
    const asked = labels.join('.').toLowerCase(), type = TYPE[msg.readUInt16BE(off + 1)], question = msg.subarray(12, off + 5);
    seen(asked);
    const known = Object.keys(records).some(k => k.startsWith(asked + ' ')), answers = [];
    if (known) { const alias = type !== 'CNAME' && records[asked + ' CNAME']?.[0], owner = alias || asked; if (alias) answers.push(rr(asked, 'CNAME', alias)); for (const v of records[owner + ' ' + type] || []) answers.push(rr(owner, type, v)); }
    const head = Buffer.alloc(12); msg.copy(head, 0, 0, 2); head.writeUInt16BE(known ? 0x8580 : 0x8583, 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(answers.length, 6);
    socket.send(Buffer.concat([head, question, ...answers]), peer.port, peer.address);
  });
  return new Promise(resolve => socket.bind(53, address, resolve));
}
const PUBLIC_DNS = { [`${DOMAIN} A`]: [OLD], [`www.${DOMAIN} CNAME`]: [DOMAIN], '10.113.0.203.in-addr.arpa PTR': ['server12.newhost.example'], '24.100.51.198.in-addr.arpa PTR': ['web03.oldhost.example'] };
const NEW_DNS = { [`${DOMAIN} A`]: [NEW], [`www.${DOMAIN} CNAME`]: [DOMAIN] };

// The site, as in the mockup: WordPress like sizes, a hero photo that takes 150 ms on both servers (so the largest
// paint comes after the first paint), PHP pages after 650 ms on the new server and 120 ms on the old one.
function site(work) {
  const brand = fs.readFileSync(path.join(APP, 'src/brand/dioptra.png')); // without ImageMagick both pictures are the app icon
  const read = name => (fs.existsSync(path.join(work, name)) ? fs.readFileSync(path.join(work, name)) : brand);
  const HERO = read('hero.jpg'), LOGO = read('logo.png'), FONT = fs.readFileSync(path.join(APP, 'src/fonts/plus-jakarta-sans-latin.woff2'));
  const HOME = `https://${DOMAIN}/`, DELAY = { new: 650, old: 120 }, SERVER = { new: { Server: 'nginx/1.26.2' }, old: { Server: 'LiteSpeed' } };
  let seed = 1962;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648, num = n => Math.floor(rnd() * n);
  const SYL = ['ba', 'ke', 'ry', 'lo', 'af', 'mi', 'su', 'gar', 'flo', 'ur', 'cr', 'um', 'pa', 'st', 'wh', 'ea', 'ti', 'ne', 'xo', 'qu'];
  const ident = () => Array.from({ length: 2 + num(3) }, () => SYL[num(SYL.length)]).join(''), hex = () => num(0xffffff).toString(16).padStart(6, '0');
  const fillerCss = n => Array.from({ length: n }, () => `.wp-block-${ident()} .${ident()}-${ident()}{margin:${num(40)}px ${num(40)}px;padding:${num(30)}px;color:#${hex()};background:#${hex()}}`).join('\n');
  const fillerJs = n => `!function(){var ${Array.from({ length: n }, () => `_${ident()}=function(_${ident()}){return _${ident()}.${ident()}(${num(999)},"${ident()}")}`).join(',')};}();`;
  const THEME_CSS = `@font-face{font-family:Brand;src:url(/wp-content/themes/hearth/fonts/brand.woff2) format("woff2");font-display:swap}
body{margin:0;background:#faf5ef;color:#4a2e1a;font-family:system-ui,sans-serif}a{color:inherit;text-decoration:none}
header{display:flex;justify-content:space-between;align-items:center;padding:18px 40px;border-bottom:1px solid #eadfd2}.brand{display:flex;align-items:center;gap:12px;font-family:Brand,Georgia,serif;font-weight:700;font-size:23px;color:#3a2413}.brand img{width:40px;height:40px}nav a{margin-left:28px;font-size:17px;color:#7a5a43}
.hero{display:flex;gap:40px;align-items:center;padding:44px 40px 36px}.hero>div{flex:1}h1{font-family:Brand,Georgia,serif;font-weight:500;font-size:42px;line-height:1.08;margin:0 0 22px;color:#3a2413}.hero p{font-size:17px;line-height:1.45;color:#7a5a43;margin:0 0 26px}.cta{display:inline-block;background:#8a4b22;color:#fff;font-weight:700;font-size:16px;padding:13px 20px;border-radius:9px}
.img img{display:block;width:100%;height:240px;object-fit:cover;border-radius:18px}footer{padding:20px 40px;color:#a08a70}
${fillerCss(380)}`;
  const JQUERY = `window.jQuery=window.$=function(f){if(typeof f==="function")document.addEventListener("DOMContentLoaded",f);return{}};${fillerJs(900)}`;
  const GLOBAL = fillerCss(170); // generated once: both servers send the same theme styles
  const home = side => {
    const isNew = side === 'new';
    const robots = isNew ? `<meta name='robots' content='noindex, nofollow' />` : `<meta name='robots' content='index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1' />`;
    const logo = isNew ? `https://${OLD}/~northwind/wp-content/uploads/2026/10/logo.png` : `${HOME}wp-content/uploads/2026/10/logo.png`;
    const contact = isNew ? `http://${DOMAIN}/contact/` : `${HOME}contact/`, footer = isNew ? `https://staging.${DOMAIN}/` : HOME;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Northwind Bakery · Fresh every morning</title>
${robots}
<link rel="canonical" href="${HOME}">
<meta name="generator" content="WordPress 6.8.3">
<style id='global-styles-inline-css'>${GLOBAL}</style>
<link rel='stylesheet' id='hearth-style-css' href='${HOME}wp-content/themes/hearth/style.css?ver=2.4.1' media='all' />
<script src="${HOME}wp-includes/js/jquery/jquery.min.js?ver=3.7.1" id="jquery-core-js"></script>
</head>
<body class="home">
<header><a class="brand" href="${HOME}"><img src="${logo}" width="40" height="40" alt="">Northwind Bakery</a>
<nav><a href="${HOME}bread/">Bread</a><a href="${HOME}cakes/">Cakes</a><a href="${HOME}bestellen/">Order</a><a href="${contact}">Contact</a></nav></header>
<section class="hero"><div><h1>Fresh every morning,<br>since 1962.</h1><p>Sourdough, pastries and celebration cakes, baked by hand.</p><a class="cta" href="${HOME}bestellen/">Order online</a></div>
<div class="img"><img src="${HOME}wp-content/uploads/2026/10/hero.jpg" width="560" height="260" alt="Fresh sourdough loaves"></div></section>
<footer>© 2026 <a href="${footer}">Northwind Bakery</a> · Bakery street 12</footer>
</body></html>`;
  };
  const PAGES = { new: home('new'), old: home('old') }, ORDER = PAGES.old.replace('Fresh every morning,<br>since 1962.', 'Order online');
  const NGINX_404 = '<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx/1.26.2</center></body></html>';
  const LS_403 = '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>';
  const ROBOTS = `User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n\nSitemap: ${HOME}wp-sitemap.xml\n`;
  const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${HOME}wp-sitemap-posts-page-1.xml</loc></sitemap></sitemapindex>\n`;
  const UP = '/wp-content/uploads/2026/10/';
  const STATIC = { '/wp-content/themes/hearth/style.css': ['text/css', THEME_CSS], '/wp-includes/js/jquery/jquery.min.js': ['application/javascript', JQUERY], '/wp-content/themes/hearth/fonts/brand.woff2': ['font/woff2', FONT],
    [UP + 'hero.jpg']: ['image/jpeg', HERO], [UP + 'logo.png']: ['image/png', LOGO], '/favicon.ico': ['image/png', LOGO], '/robots.txt': ['text/plain; charset=utf-8', ROBOTS], '/wp-sitemap.xml': ['application/xml; charset=utf-8', SITEMAP] };
  const TEXT = /^(text\/|application\/(javascript|xml|json))/;
  function send(req, res, side, status, type, body, extra = {}) {
    const headers = { 'Content-Type': type, ...SERVER[side], ...extra }, accepts = String(req.headers['accept-encoding'] || '');
    let out = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (side === 'old' && TEXT.test(type) && typeof body === 'string' && out.length > 512) {
      const enc = /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : '';
      if (enc) { out = enc === 'br' ? zlib.brotliCompressSync(out) : zlib.gzipSync(out); headers['Content-Encoding'] = enc; }
      headers.Vary = 'Accept-Encoding';
    }
    res.writeHead(status, { ...headers, 'Content-Length': out.length }); res.end(out);
  }
  const handler = side => (req, res) => {
    const isNew = side === 'new', host = String(req.headers.host || '').split(':')[0].toLowerCase();
    let p = new URL(req.url, HOME).pathname;
    if (host === `www.${DOMAIN}`) return send(req, res, side, 301, 'text/html; charset=UTF-8', '', { Location: `https://${DOMAIN}${req.url}` });
    if (!isNew && host === OLD && p.startsWith('/~northwind/')) p = p.slice('/~northwind'.length);
    if (STATIC[p]) return STATIC[p][0] === 'image/jpeg' ? setTimeout(() => send(req, res, side, 200, ...STATIC[p]), 150) : send(req, res, side, 200, ...STATIC[p]);
    const php = (status, body, cached) => setTimeout(() => send(req, res, side, status, 'text/html; charset=UTF-8', body, { 'X-Powered-By': 'PHP/8.3.12', ...(!isNew && cached ? { 'X-LiteSpeed-Cache': 'hit' } : {}) }), DELAY[side]);
    if (p === '/') return php(200, PAGES[side], true);
    if (p === '/bestellen/') return isNew ? send(req, res, side, 404, 'text/html', NGINX_404) : php(200, ORDER, true);
    if (p === '/xmlrpc.php') return isNew ? send(req, res, side, 200, 'text/plain;charset=UTF-8', 'XML-RPC server accepts POST requests only.') : send(req, res, side, 403, 'text/html', LS_403);
    if (p === '/wp-login.php') return php(200, '<!doctype html><title>Log In</title><meta name="robots" content="noindex, nofollow">', false);
    return isNew ? send(req, res, side, 404, 'text/html', NGINX_404) : php(404, PAGES.old.replace('Fresh every morning,<br>since 1962.', 'Page not found'), false);
  };
  const redirect = side => (req, res) => { res.writeHead(301, { ...SERVER[side], 'Content-Type': 'text/html', Location: `https://${String(req.headers.host || DOMAIN).split(':')[0]}${req.url}` }); res.end(); };
  return { HOME, handler, redirect, delay: (side, ms) => { DELAY[side] = ms; } };
}
// Live in the public zone: an address, or none at all (NXDOMAIN, a site that only exists on the new server).
function publicLive(ip) {
  delete PUBLIC_DNS[`${DOMAIN} A`]; delete PUBLIC_DNS[`www.${DOMAIN} CNAME`];
  if (ip) Object.assign(PUBLIC_DNS, { [`${DOMAIN} A`]: [ip], [`www.${DOMAIN} CNAME`]: [DOMAIN] });
}

async function inside() {
  const { _electron: electron } = require('playwright');
  const work = process.env.SPEED_CHECK_WORK, shots = process.env.SPEED_CHECK_SHOTS, sleep = ms => new Promise(r => setTimeout(r, ms));
  const tls = { key: fs.readFileSync(path.join(work, 'site.key')), cert: fs.readFileSync(path.join(work, 'site.crt')) };
  let publicAsked = 0; // questions for the site itself to the public resolver: every Live request starts with one
  await dnsOn('127.0.0.1', PUBLIC_DNS, asked => { if (asked === DOMAIN) publicAsked++; }); await dnsOn(NEW, NEW_DNS);
  const { HOME: home, handler, redirect, delay } = site(work), servers = [];
  for (const [side, ip] of [['new', NEW], ['old', OLD]]) {
    const secure = https.createServer(tls, handler(side)), plain = http.createServer(redirect(side));
    servers.push(secure, plain);
    await new Promise(r => secure.listen(443, ip, r)); await new Promise(r => plain.listen(80, ip, r));
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-speed-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ autoUpdates: false, autoUpdatesChosen: true, onboardingCompleted: true, tabs: [home], rules: [{ domain: DOMAIN, ip: NEW, enabled: true, www: true }] }));
  let app, stderr = '';
  try {
    app = await electron.launch({ executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs'), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`], cwd: APP, env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(work, 'ca.crt') } });
    app.process().stderr.on('data', chunk => { stderr += chunk; });
    const ui = await app.firstWindow(); ui.setDefaultTimeout(20000); await ui.waitForFunction(() => window.browser);
    const size = (width, height) => app.evaluate(({ BaseWindow }, [w, h]) => BaseWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: w, height: h }), [width, height]);
    await size(1440, 1200);
    const cmd = (action, data) => ui.evaluate(([a, d]) => window.browser.command(a, d), [action, data]);
    const st = async () => (await cmd('state')).state;
    async function wait(check, label, ms = 20000) { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await check(); if (last) return last; await sleep(150); } const s = await st(); throw new Error(`${label}: ${JSON.stringify([s.view, s.tabs.map(t => [t.mode, t.url, t.loading, t.noindex]), s.speed && { status: s.speed.status, error: s.speed.error, progress: s.speed.progress }, s.checks && { status: s.checks.status, error: s.checks.error, counts: s.checks.report?.counts }])}`); }
    const shot = async (name, w = 1440, h = 1200) => { if (!shots) return; await ui.evaluate(() => { document.getElementById('toast').hidden = true; }); await sleep(900); fs.mkdirSync(shots, { recursive: true }); execFileSync('import', ['-window', 'root', '-crop', `${w}x${h}+0+0`, '+repage', path.join(shots, name)]); };
    const clip = () => app.evaluate(({ clipboard }) => clipboard.readText());
    // The text of an element as words, without CSS (uppercase labels, inline blocks without spaces between them).
    const text = locator => locator.evaluate(node => { const parts = [], walk = x => { for (const c of x.childNodes) { if (c.nodeType === 3) parts.push(c.textContent); else walk(c); } }; walk(node); return parts.join(' ').replace(/\s+/g, ' ').trim(); });
    const host = await wait(async () => (await st()).tabs.find(t => t.mode === 'hostfile' && !t.loading && /Northwind Bakery/.test(t.title) && t.noindex), 'Hostfile page with noindex');

    // 1. Noindex chip: red in the single view, red in Compare (Live says index).
    const single = ui.locator('#route-bar .route-noindex');
    await single.waitFor();
    assert.equal(await single.innerText(), 'Noindex'); assert.doesNotMatch(await single.getAttribute('class'), /\bboth\b/);
    assert.match(await single.getAttribute('title'), /^The new server tells search engines not to index this page\. Click to see the checks\.$/);
    assert.equal((await cmd('compare')).ok, true);
    const paneChip = ui.locator('#pane-bars .route-bar.hostfile .route-noindex');
    await wait(async () => (await st()).tabs.some(t => t.mode === 'live' && !t.loading && t.title) && (await paneChip.count()) === 1, 'Noindex chip in Compare');
    assert.equal((await st()).tabs.find(t => t.id === host.id).noindex, 'worse');
    assert.equal(await ui.locator('#pane-bars .route-bar.live .route-noindex').count(), 0, 'no chip on the Live side');

    // 2. The chip opens Differences on the Checks part; the checks run after the comparison.
    await paneChip.click();
    const box = ui.locator('#differences');
    await box.locator('.diff-menu').waitFor();
    const row = id => box.locator(`.dm-row[data-part="${id}"]`), over = id => box.locator(`.ov-part[data-part="${id}"]`);
    assert.equal(await box.locator('.dm-row[aria-current=true] strong').innerText(), 'Checks');
    assert.deepEqual(await box.locator('.dm-row strong').allInnerTexts(), ['Overview', 'External domains', 'Files', 'HTML', 'Headers', 'Speed', 'Checks']);
    assert.deepEqual(await box.locator('.dm-list .lbl').allInnerTexts().then(a => a.map(t => t.toLowerCase())), ['the page', 'the server'], 'no Add-ons group without add-ons');
    const checks = await wait(async () => { const s = await st(); return s.checks?.status === 'done' && s.checks.report; }, 'checks done', 40000);
    assert.deepEqual(checks.counts, { problems: 4, differ: 0, passed: 9, total: 13 }, JSON.stringify(checks.groups.map(g => g.items.map(i => i.title))));
    assert.deepEqual(checks.groups.map(g => [g.label, g.items.length]), [['Search engines', 1], ['Old addresses', 1], ['Standard addresses', 2]]);
    assert.deepEqual(checks.passed.map(p => p.name), ['X-Robots-Tag', 'robots.txt', 'canonical', '/robots.txt', '/wp-sitemap.xml', '/wp-login.php', 'http to https', 'www to bare domain', 'random address gives 404']);
    await wait(async () => (await box.locator('.cs').count()) === 1, 'checks summary drawn');
    assert.deepEqual(await box.locator('.cs-n > span:not(.sep)').allInnerTexts(), ['4 problems', '9 passed']);
    assert.deepEqual(await box.locator('.cs-n > span').evaluateAll(n => n.map(s => s.className)), ['bad', 'sep', 'ok']);
    assert.equal(await box.locator('.cs-sub').innerText(), '13 checks on both servers, compared with Live');
    assert.deepEqual((await box.locator('.cchip').allInnerTexts()).map(t => t.replace(/\s+/g, ' ')), ['Search engines 1', 'Old addresses 1', 'Standard addresses 2']);
    assert.equal(await row('checks').locator('.stag.is-fix').innerText(), '4 failed');
    const cards = box.locator('.pc');
    assert.equal(await cards.count(), 4);
    assert.match(await text(cards.nth(0)), /^Search engines The new server tells search engines not to index the site Open settings Hostfile noindex, nofollow Live index, follow, max-image-preview:large/);
    assert.match(await text(cards.nth(0)), /How to fix: WordPress, Settings, Reading: untick Discourage search engines\.$/);
    assert.match(await text(cards.nth(1)), /^Old addresses 4 old addresses in the page of the new server Copy all Hostfile 4 found, listed below Live none How to fix: replace them in the database with WP CLI on the new server\. Remove --dry-run when the counts look right; back up the database first\./);
    const commands = ["wp search-replace 'https://198.51.100.24/~northwind' 'https://northwind-bakery.test' --all-tables --dry-run",
      "wp search-replace 'https://staging.northwind-bakery.test' 'https://northwind-bakery.test' --all-tables --dry-run",
      "wp search-replace 'http://northwind-bakery.test' 'https://northwind-bakery.test' --all-tables --dry-run"];
    assert.deepEqual(await cards.nth(1).locator('.cmd code').allInnerTexts(), commands);
    assert.deepEqual(await Promise.all((await cards.nth(1).locator('.cmd .found').all()).map(text)), [
      'https://198.51.100.24/~northwind/ img src, logo.png, temporary URL of the old server', 'staging.northwind-bakery.test link "Northwind Bakery" in the footer, staging domain', 'http://northwind-bakery.test/contact/ link "Contact" in the menu, own site over http']);
    assert.match(await text(cards.nth(2)), /^Standard addresses \/bestellen\/ gives 404 on the new server Open Hostfile 404 Not Found Live 200 OK How to fix: pretty permalinks need try_files \$uri \$uri\/ \/index\.php\?\$args; in nginx\.$/);
    assert.match(await text(cards.nth(3)), /^Standard addresses \/xmlrpc\.php is open on the new server Copy rule Hostfile 200 OK Live 403 Forbidden How to fix: block it as on Live, for example location = \/xmlrpc\.php \{ deny all; \} in nginx\.$/);
    // Copy: one command, all commands, the nginx rule; the text comes from main, not from the window.
    await cards.nth(1).locator('.cmd').first().getByRole('button', { name: 'Copy' }).click();
    await wait(async () => (await clip()) === commands[0], 'one command copied');
    await cards.nth(1).getByRole('button', { name: 'Copy all' }).click();
    await wait(async () => (await clip()) === commands.join('\n'), 'all commands copied');
    await cards.nth(3).getByRole('button', { name: 'Copy rule' }).click();
    await wait(async () => (await clip()) === 'location = /xmlrpc.php { deny all; }', 'nginx rule copied');
    assert.equal((await cmd('checks-copy', { card: 'nope' })).ok, false, 'an unknown card copies nothing');
    // Passed checks fold out with Show.
    const passed = box.locator('.cpass');
    assert.match(await text(passed), /^9 checks passed, the same on both servers X-Robots-Tag, robots\.txt, canonical, \/robots\.txt, \/wp-sitemap\.xml, \/wp-login\.php, http to https, www to bare domain, random address gives 404 Show$/);
    await passed.getByRole('button', { name: 'Show' }).click();
    await wait(async () => (await box.locator('.cpass-list tbody tr').count()) === 9, 'passed checks listed');
    assert.match(await text(box.locator('.cpass-list tbody tr').filter({ hasText: 'http to https' })), /301 Moved Permanently → https:\/\/northwind-bakery\.test\/ 301 Moved Permanently → https:\/\/northwind-bakery\.test\//);
    await box.locator('.cpass').getByRole('button', { name: 'Hide' }).click();

    // 3. Speed: measured in offscreen windows after the checks; verdict, timeline, filmstrip, thresholds, causes.
    const speed = await wait(async () => { const s = await st(); return s.speed?.status === 'done' && s.speed.report; }, 'speed measured', 90000);
    const m = speed.medians;
    assert.ok(m.hostfile.ttfb > m.live.ttfb * 2 && m.hostfile.ttfb >= 600, `first byte ${m.hostfile.ttfb} against ${m.live.ttfb}`);
    for (const side of ['hostfile', 'live']) for (const key of ['ttfb', 'fcp', 'lcp', 'load']) assert.ok(Number.isFinite(m[side][key]), `${side} ${key} measured: ${JSON.stringify(m)}`);
    assert.ok(m.hostfile.lcp >= m.hostfile.fcp && m.live.lcp >= m.live.fcp, 'largest paint after first paint');
    assert.ok(m.live.transfer < m.hostfile.transfer, `Live is compressed: ${m.live.transfer} against ${m.hostfile.transfer}`);
    assert.equal(speed.verdict.tone, 'worse'); assert.equal(speed.verdict.title, 'The new server is slower than Live');
    assert.deepEqual(speed.why.map(w => [w.title, w.hostfile, w.live]), [['Page cache is off', 'none', 'LiteSpeed HIT'], ['Compression is off', 'none', 'br'], ['First byte is high', speed.why[2].hostfile, speed.why[2].live]]);
    assert.match(speed.why[0].fix, /nginx FastCGI cache or WP Super Cache/);
    assert.equal(speed.loads, 3);
    await row('speed').click();
    await box.locator('.sv').waitFor();
    assert.match(await box.locator('.sv').getAttribute('class'), /\bworse\b/);
    assert.equal(await box.locator('.sv-title').innerText(), 'The new server is slower than Live');
    assert.match(await text(box.locator('.sv-fx')), /^first byte \d+\.\d× slower · fully loaded \d+\.\d× slower · \+\d\.\d\d s per page$/);
    assert.equal(await text(box.locator('.sv-meta .lbl')), '3 loads each, median from this computer');
    assert.match(await row('speed').locator('.stag.is-fix').innerText(), /^\d+\.\d× slower$/);
    assert.equal(await box.locator('.tl-row').count(), 2);
    for (const side of ['h', 'l']) assert.equal(await box.locator(`.tl-row.${side} .tl-tick`).count(), 3, `three moments on ${side}`);
    await wait(async () => (await box.locator('.tl-lab').count()) === 6, 'tick labels placed');
    assert.deepEqual(await box.locator('.tl-row.h .tl-lab').allInnerTexts().then(a => a.map(t => t.replace(/\s*\d+$/, ''))), ['first byte', 'first paint', 'largest paint']);
    assert.match(await box.locator('.tl-row.h .tl-end').innerText(), /^\d+ ms\s*\+\d+ ms$/);
    // Filmstrip: 6 frames per server from the paints of the offscreen windows; Live shows something before Hostfile.
    for (const side of ['h', 'l']) {
      const frames = box.locator(`.fs-row.${side} figure`);
      assert.equal(await frames.count(), 6);
      assert.equal(await box.locator(`.fs-row.${side} figure img[src^="data:image/jpeg;base64,"]`).count(), 6, `frames of ${side}`);
      assert.equal(await box.locator(`.fs-row.${side} figure.first`).count(), 1, `first content frame of ${side}`);
    }
    const firstAt = async side => (await box.locator(`.fs-row.${side} figure`).evaluateAll(n => n.findIndex(f => f.classList.contains('first'))));
    const [hFirst, lFirst] = [await firstAt('h'), await firstAt('l')];
    assert.ok(hFirst > lFirst && hFirst >= 2, `Hostfile appears later in the filmstrip (${hFirst} against ${lFirst})`);
    assert.equal(await box.locator('.fs-row.h figure').nth(0).locator('.nothing').innerText(), 'blank');
    assert.match(await box.locator('.fs-row.h figure.first figcaption').innerText(), /^\d\.\d s, first$/);
    // Measurements with Google's threshold dots and the spread of the 3 loads.
    const rows = box.locator('.mt tbody tr');
    assert.deepEqual(await rows.locator('.metric').allInnerTexts(), ['Time to first byte', 'First paint (FCP)', 'Largest paint (LCP)', 'Fully loaded', 'Requests', 'Transferred']);
    assert.equal(await rows.nth(0).locator('.qd.good').count(), 2, 'first byte under 800 ms on both: good');
    assert.equal(await rows.nth(3).locator('.qd.none').count(), 2, 'fully loaded has no Google threshold');
    assert.match(await text(rows.nth(0)), /^Time to first byte \d+ ms( \(\d+ to \d+\))? \d+ ms( \(\d+ to \d+\))? \+\d+ ms$/);
    assert.match(await rows.nth(0).locator('.dif').getAttribute('class'), /\bworse\b/);
    assert.match(await text(rows.nth(5)), /^Transferred \d+ KB( \(\d+ to \d+\))? \d+ KB( \(\d+ to \d+\))? \+\d+ KB$/);
    assert.deepEqual(await box.locator('.why-row b').allInnerTexts(), ['Page cache is off', 'Compression is off', 'First byte is high']);
    assert.match(await text(box.locator('.why-row').first()), /^Page cache is off Hostfile none Live LiteSpeed HIT Fix: turn on a page cache on the new server, for example the nginx FastCGI cache or WP Super Cache\.$/);
    const views = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.isOffscreen()).length);
    assert.equal(await views(), 0, 'the measuring views are closed');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'no extra window');
    await ui.mouse.move(4, 1190); await shot('speed-check-1-speed.png');
    await row('checks').click(); await box.locator('.cs').waitFor();
    await ui.mouse.move(4, 1190); await shot('speed-check-2-checks.png');

    // 4. The Overview: the parts to fix first with their worst points; the two older findings Speed replaces are not shown.
    await row('overview').click(); await box.locator('.dverdict').waitFor();
    assert.match(await box.locator('.dverdict').getAttribute('class'), /\bworse\b/);
    assert.equal(await box.locator('.dverdict .sv-title').innerText(), 'Not ready for the switch');
    assert.match(await text(box.locator('.dverdict .sv-fx')), /^\d parts need a fix on the new server first: (.*, )?Speed, Checks\.$/);
    assert.doesNotMatch(await text(box.locator('.dverdict')), /responded much slower|Cache headers differ|Server software differs/);
    assert.equal(await box.locator('.dstep b').first().innerText(), 'Fix before the switch');
    assert.equal(await text(over('checks').locator('.ov-head')), 'Checks 4 of 13 checks failed, 9 passed 4 failed ›');
    // What the side column used to say, in the words of the cards, where it is now: the points of the Overview.
    assert.deepEqual(await over('checks').locator('.ov-tops li').allInnerTexts(), ['The new server tells search engines not to index the site', '4 old addresses in the page of the new server', '/bestellen/ gives 404 on the new server', 'and 1 more']);
    assert.equal(checks.groups.flatMap(g => g.items)[3].title, '/xmlrpc.php is open on the new server', 'the fourth point, on the page of the part');
    assert.match(await text(over('speed').locator('.ov-head')), /^Speed First byte after \d+ ms, Live after \d+ ms \d+\.\d× slower ›$/);
    assert.deepEqual(await over('speed').locator('.ov-tops li').allInnerTexts(), ['Page cache is off', 'Compression is off', 'First byte is high']);
    assert.equal(await box.locator('.dstep b').last().innerText(), 'Nothing to do');
    assert.equal(await box.locator('.ov-grid.c3 .ov-part[data-part=headers] .stag.is-info').count(), 1, 'the server software differs: to read, not judged');
    assert.equal(await box.locator('.kpi, .subtabs, .diff-side, .finding').count(), 0, 'the cards, the sub tabs and the side column are gone');
    await ui.mouse.move(4, 1190); await shot('speed-check-0-overview.png');
    // The server software differs: a row of the Headers table (it was a finding in the side column).
    await over('headers').click();
    assert.deepEqual(await box.locator('.dscroll.headers tbody tr').evaluateAll(rows => rows.map(tr => [...tr.cells].map(td => td.textContent).join(' | ')).filter(t => /^server /.test(t))), ['server | nginx/1.26.2 | LiteSpeed']);
    await row('checks').click(); await box.locator('.cs').waitFor();
    assert.deepEqual(await box.locator('.pc .tt').evaluateAll(n => n.map(t => t.lastChild.textContent)), ['The new server tells search engines not to index the site', '4 old addresses in the page of the new server', '/bestellen/ gives 404 on the new server', '/xmlrpc.php is open on the new server']);
    await row('speed').click(); await box.locator('.sp2 .sv').waitFor();

    // 5. Ask Claude: checks and speed inside the untrusted block.
    assert.equal((await cmd('differences-ask-claude')).ok, true);
    const summary = await clip(), begin = summary.indexOf('BEGIN UNTRUSTED SERVER DATA'), end = summary.indexOf('END UNTRUSTED SERVER DATA');
    for (const part of ['Checks (4 problems, 0 differ, 9 passed):', 'old address 198.51.100.24: https://198.51.100.24/~northwind/wp-content/uploads/2026/10/logo.png','Speed (median of the loads, from this computer):', 'Cause: Page cache is off']) {
      const at = summary.indexOf(part); assert.ok(at > begin && at < end, `${part} inside the untrusted block`);
    }

    // 6. Screenshots at 1180 wide, then Measure again measures once more.
    if (shots) { await size(1180, 1420); await sleep(1200); await shot('speed-check-3-speed-1180.png', 1180, 1420); await size(1440, 1200); }
    const before = speed.measuredAt;
    await box.getByRole('button', { name: 'Measure again' }).click();
    await wait(async () => (await st()).speed?.status === 'running', 'measuring again', 5000);
    await wait(async () => (await views()) === 2, 'two offscreen views while measuring', 5000);
    assert.equal(await app.evaluate(({ BaseWindow, BrowserWindow }) => BaseWindow.getAllWindows()[0] === BrowserWindow.getAllWindows()[0] && BaseWindow.getAllWindows()[0].contentView.children.every(v => !v.webContents.isOffscreen())), true, 'the main window stays the first window, its views stay the tabs');
    await wait(async () => { const s = await st(); return s.speed?.status === 'done' && s.speed.report.measuredAt !== before; }, 'measured again', 90000);
    assert.equal(await views(), 0, 'the measuring views are closed again');

    // 7. Live has no DNS record (a site that only exists on the new server, as in the test of beta.2). The new server
    //    answers after about 900 ms now, as in the no Live mockup. Differences says why; Speed and Checks judge the new
    //    server on its own and leave Live alone.
    delay('new', 900); publicLive(null);
    const syns = () => Number(execFileSync('iptables', ['-nvxL', 'OUTPUT'], { encoding: 'utf8' }).split('\n').find(l => l.includes(REFUSED))?.trim().split(/\s+/)[0] || 0);
    const overflow = () => ui.evaluate(() => { let most = 0; for (let n = document.querySelector('#differences .diff-main'); n; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) most = Math.max(most, n.scrollHeight - n.clientHeight); return most; });
    const fitShot = async (name, w, h) => { if (!shots) return; await size(w, h); await sleep(1400); const extra = await overflow(), H = extra ? Math.min(1500, h + extra + 6) : h; if (H !== h) { await size(w, H); await sleep(1400); } await ui.mouse.move(4, H - 10); await shot(name, w, H); };
    const soloDone = (label, solo = true) => wait(async () => { const s = await st(); return s.differences?.status === 'done' && s.checks?.status === 'done' && s.speed?.status === 'done' && Boolean(s.speed.report?.solo) === solo && Boolean(s.checks.report?.solo) === solo && s; }, label, 150000);
    const asked0 = publicAsked;
    assert.equal((await cmd('differences-run')).ok, true);
    const asked = publicAsked;
    assert.ok(asked > asked0, 'Differences asked the public DNS for Live');
    let mostViews = 0;
    const nolive = await wait(async () => { mostViews = Math.max(mostViews, await views()); const s = await st(); return s.checks?.status === 'done' && s.speed?.status === 'done' && s.speed.report?.solo && s; }, 'no DNS record: checks and speed of the new server', 150000);
    assert.equal(mostViews, 1, 'one offscreen view while measuring: the new server only');
    assert.equal(publicAsked, asked, 'no Live request after Differences: Checks and Speed left Live alone');
    const R = nolive.differences.liveReason;
    assert.deepEqual([R.kind, R.text, R.short], ['dns', `Live could not be reached: ${DOMAIN} has no DNS record.`, 'no DNS record']);
    await wait(async () => (await box.locator('.dhead .nl-chip').count()) === 1, 'no DNS record label in the head');
    assert.equal(await box.locator('.dhead .nl-chip').innerText(), 'no DNS record');
    assert.match(await text(box.locator('.dhead .dvs')), /^HOSTFILE 203\.0\.113\.10 vs LIVE no DNS record · compared \d/);
    // The page parts have nothing to compare with: grey tags. The reason is a calm note under the verdict.
    assert.deepEqual(await Promise.all(['domains', 'files', 'html', 'headers'].map(id => row(id).locator('.stag.is-none').innerText())), ['2 on Hostfile', 'Not measured', 'Not compared', 'Not compared']);
    assert.equal(await text(box.locator('.dm-head p')), '6 parts, the new server on its own');
    assert.equal(await row('speed').locator('.stag.is-check').innerText(), 'Needs work');
    assert.equal(await row('checks').locator('.stag.is-fix').innerText(), '3 failed');
    await row('overview').click(); await box.locator('.dverdict').waitFor();
    assert.equal(await text(box.locator('.dverdict.worse .sv-fx')), '1 part needs a fix on the new server first: Checks.');
    assert.deepEqual(await box.locator('.dverdict .sv-lim').allInnerTexts(), [`Live could not be reached: ${DOMAIN} has no DNS record. Speed and Checks judged the new server on its own; comparing with Live waits until Live answers.`]);
    assert.doesNotMatch(await text(box.locator('.diff-main')), /only on Hostfile|The Live request failed|differs:/);
    assert.deepEqual(await over('checks').locator('.ov-tops li').allInnerTexts(), ['The new server tells search engines not to index the site', '3 old addresses in the page of the new server', '/bestellen/ gives 404 on the new server', 'and 1 more']);
    assert.equal(nolive.checks.report.groups.flatMap(g => g.items)[3].title, '/xmlrpc.php is open on the new server');
    assert.equal(await text(over('checks').locator('.ov-head small')), '3 of 12 checks failed, 8 passed, 2 need Live');
    assert.deepEqual(await over('speed').locator('.ov-tops li').allInnerTexts(), ['No page cache header', 'No compression', 'First byte above 800 ms']);
    assert.deepEqual(await box.locator('.dstep').allInnerTexts().then(a => a.map(t => t.replace(/\s+/g, ' ').toLowerCase())), ['fix before the switch these break the site or put it at risk', 'look at once may be fine, worth a look', 'nothing to do shown so you can look it up']);
    await fitShot('speed-check-3-nolive-overview-1440.png', 1440, 1200);
    // Speed: one row, the values of the new server with Google's dots, What to improve with targets.
    await row('speed').click(); await box.locator('.sv.solo').waitFor();
    const banner = box.locator('.nl-banner');
    assert.equal(await banner.locator('b').innerText(), R.text);
    assert.equal(await banner.locator('p').innerText(), 'There is no old site to compare with, so Dioptra measured the new server on its own.');
    assert.match(await banner.locator('code').innerText(), /^getaddrinfo ENOTFOUND northwind-bakery\.test · checked \d/);
    assert.equal(await banner.getByRole('button').innerText(), 'Measure Live too');
    assert.equal(await text(box.locator('.dch .lbl').first()), 'The new server on its own');
    const sv = nolive.speed.report;
    assert.equal(sv.loads, 3); assert.equal(sv.timeline.rows.length, 1); assert.equal(sv.verdict.factors[0].q, 'ni', JSON.stringify(sv.medians.hostfile));
    assert.equal(sv.verdict.title, 'The new server is fast enough for Google on first paint, but first byte needs work', JSON.stringify(sv.medians.hostfile));
    assert.match(await box.locator('.sv.solo').getAttribute('class'), /\bni\b/);
    assert.equal(await box.locator('.sv-title').innerText(), sv.verdict.title);
    assert.match(await text(box.locator('.sv-fx')), /^first byte \d+ ms needs work · first paint (\d+ ms|\d\.\d\d s) good · largest paint (\d+ ms|\d\.\d\d s) good$/);
    assert.equal(await text(box.locator('.sv-lim')), 'Google: first byte good up to 800 ms');
    assert.equal(await text(box.locator('.sv-meta .lbl')), '3 loads, median new server only');
    assert.equal(await text(box.locator('.tl .sec-h .muted')), 'the new server, 0 to fully loaded');
    assert.equal(await box.locator('.tl-row').count(), 1); assert.equal(await box.locator('.tl-row.h .tl-tick').count(), 3);
    assert.equal(await box.locator('.fs-row').count(), 1);
    assert.equal(await box.locator('.fs-row.h figure img[src^="data:image/jpeg;base64,"]').count(), 6, 'filmstrip of the new server');
    assert.equal(await box.locator('.fs-row.h figure.first').count(), 1);
    assert.deepEqual(await box.locator('.mt thead th').evaluateAll(n => n.map(x => x.textContent)), ['Metric', 'Hostfile', 'Live']);
    const mrows = box.locator('.mt tbody tr');
    assert.equal(await mrows.count(), 6); assert.equal(await box.locator('.mt td.nolive').count(), 1);
    assert.equal(await text(box.locator('.mt td.nolive')), 'No Live nothing to compare with until Live can be reached');
    assert.equal(await mrows.nth(0).locator('.qd.ni').count(), 1, 'first byte needs work');
    assert.match(await text(mrows.nth(0).locator('td').nth(1)), /^\d+ ms( \(\d+ to \d+\))?$/);
    assert.equal(await text(box.locator('.why .sec-h')), 'What to improve from the new server alone');
    assert.deepEqual(await box.locator('.why-row b').allInnerTexts(), ['No page cache header', 'No compression', 'First byte above 800 ms']);
    assert.equal(await text(box.locator('.why-row').first()), 'No page cache header Hostfile none Target HIT from a page cache Fix: turn on a page cache on the new server, for example the nginx FastCGI cache or WP Super Cache.');
    assert.match(await text(box.locator('.why-row').nth(2)), /^First byte above 800 ms Hostfile \d+ ms Target up to 800 ms Fix: PHP or the database is slow/);
    await fitShot('speed-check-4-nolive-speed-1440.png', 1440, 1200);
    // Checks: Expected next to Hostfile, the counts with need Live.
    await row('checks').click(); await box.locator('.ck2.solo .cs').waitFor();
    assert.equal(await box.locator('.nl-banner p').innerText(), 'There is no old site to compare with, so Dioptra checked the new server on its own.');
    assert.equal(await box.locator('.nl-banner').getByRole('button').innerText(), 'Check Live too');
    assert.equal(await text(box.locator('.dch .lbl').first()), 'The new server on its own, judged on what a good server gives');
    assert.deepEqual(nolive.checks.report.counts, { problems: 3, differ: 1, passed: 8, needLive: 2, total: 12 });
    assert.deepEqual(await box.locator('.cs-n > span:not(.sep)').allInnerTexts(), ['3 problems', '1 warning', '8 passed', '2 need Live']);
    assert.equal(await box.locator('.cs-sub').innerText(), '12 checks on the new server alone, judged on what a good server gives');
    const nc = box.locator('.pc');
    assert.equal(await nc.count(), 4);
    assert.match(await text(nc.nth(0)), /^Search engines The new server tells search engines not to index the site Open settings Hostfile noindex, nofollow Expected index, follow or not set How to fix: WordPress, Settings, Reading: untick Discourage search engines\.$/);
    assert.match(await text(nc.nth(1)), /^Old addresses 3 old addresses in the page of the new server Copy all Hostfile 3 found, listed below Expected none \(old server IP unknown without Live\) How to fix: replace them in the database with WP CLI/);
    assert.match(await text(nc.nth(2)), /^Standard addresses \/bestellen\/ gives 404 on the new server Open Hostfile 404 Not Found Expected 200 OK, the page links to it How to fix: pretty permalinks need try_files/);
    assert.match(await text(nc.nth(3)), /^Standard addresses \/xmlrpc\.php is open on the new server Copy rule Hostfile 200 OK Expected 403 or 404, blocked How to fix: block it, for example location = \/xmlrpc\.php \{ deny all; \} in nginx, or with a security plugin\.$/);
    assert.match(await nc.nth(3).getAttribute('class'), /\bdiffers\b/);
    await nc.nth(1).getByRole('button', { name: 'Copy all' }).click();
    await wait(async () => (await clip()) === commands.join('\n'), 'all commands copied without Live');
    const fold = box.locator('.nl-fold .cpass-line');
    assert.equal(await text(fold.nth(0)), '8 passed X-Robots-Tag, robots.txt, canonical, /robots.txt, /wp-sitemap.xml, /wp-login.php, http to https, random address gives 404 Show');
    assert.equal(await text(fold.nth(1)), '2 need Live www to bare domain (which name is the main one), old server IP in the page (unknown without Live) they run when Live answers');
    await ui.mouse.move(4, 1190); await fitShot('speed-check-5-nolive-checks-1440.png', 1440, 1200);
    await size(1440, 1200); await sleep(600);
    // Domains, HTML and Headers do not compare with an empty Live.
    await row('domains').click();
    assert.deepEqual(await box.locator('.dscroll thead th').evaluateAll(n => n.map(x => x.textContent)), ['Domain', 'Hostfile', 'Loaded as']);
    assert.equal(await box.locator('.dscroll .pill').count(), 0);
    for (const name of ['html', 'headers']) { await row(name).click(); assert.equal(await box.locator('.dscroll .dempty').innerText(), 'Not compared: Live has no page.'); }
    // Ask Claude says it is the new server alone.
    assert.equal((await cmd('differences-ask-claude')).ok, true);
    const soloSummary = await clip(), b2 = soloSummary.indexOf('BEGIN UNTRUSTED SERVER DATA'), e2 = soloSummary.indexOf('END UNTRUSTED SERVER DATA');
    for (const part of ['Checks of the new server alone, Live could not be reached (3 problems, 1 warnings, 8 passed, 2 need Live):', 'Speed of the new server alone, Live could not be reached', '[info] Live could not be reached: northwind-bakery.test has no DNS record.']) {
      const at = soloSummary.indexOf(part); assert.ok(at > b2 && at < e2, `${part} inside the untrusted block`);
    }
    await row('speed').click(); await box.locator('.sv.solo').waitFor();
    await fitShot('speed-check-6-nolive-speed-1180.png', 1180, 1420);
    await size(1440, 1200); await sleep(600);

    // 8. Live refuses the connection: the reason names the old server and its port; Checks and Speed never connect to it.
    publicLive(REFUSED);
    const syn0 = syns();
    assert.equal((await cmd('differences-run')).ok, true);
    const refused = await soloDone('connection refused: checks and speed of the new server');
    assert.deepEqual([refused.differences.liveReason.text, refused.differences.liveReason.short], [`Live could not be reached: the old server ${REFUSED} refused the connection on port 443.`, 'connection refused']);
    assert.equal(syns() - syn0, 1, 'one connection to the old server: the Differences request, none from Checks and Speed');
    await box.locator('.nl-banner b').waitFor();
    assert.equal(await box.locator('.nl-banner b').innerText(), refused.differences.liveReason.text);
    assert.match(await box.locator('.nl-banner code').innerText(), /^connect ECONNREFUSED 198\.51\.100\.30:443 · checked \d/);
    assert.equal(await box.locator('.dhead .nl-chip').innerText(), 'connection refused');
    // Measure Live too: Live is asked once more; still refused, so only the reason is new and the results stay.
    const measuredAt = refused.speed.report.measuredAt, checkedAt = refused.differences.liveReason.checkedAt;
    await box.getByRole('button', { name: 'Measure Live too' }).click();
    await wait(async () => { const s = await st(); return !s.differences.liveRetry && s.differences.liveReason?.checkedAt !== checkedAt && s; }, 'Live asked again', 30000);
    assert.equal(syns() - syn0, 2, 'Measure Live too asked Live once');
    const still = await st();
    assert.equal(still.speed.status, 'done'); assert.equal(still.speed.report.measuredAt, measuredAt, 'the new server is not measured again');
    assert.equal(still.differences.liveReason.text, refused.differences.liveReason.text);

    // 9. Live answers again: Check Live too runs the normal comparison of both servers, as in 1.2.0-beta.2.
    publicLive(OLD); delay('new', 650);
    await row('checks').click();
    await box.getByRole('button', { name: 'Check Live too' }).click();
    const back = await soloDone('Live answers again: both servers compared', false);
    assert.equal(back.differences.liveReason, null);
    assert.deepEqual(back.checks.report.counts, { problems: 4, differ: 0, passed: 9, total: 13 });
    assert.equal(back.speed.report.verdict.title, 'The new server is slower than Live');
    await wait(async () => (await box.locator('.cs-n').count()) === 1 && (await box.locator('.nl-banner').count()) === 0, 'checks of both servers drawn');
    assert.deepEqual(await box.locator('.cs-n > span:not(.sep)').allInnerTexts(), ['4 problems', '9 passed']);
    assert.equal(await box.locator('.dhead .nl-chip').count(), 0);
    assert.match(await text(box.locator('.dhead .dvs')), /198\.51\.100\.24 · compared \d/);
    await row('speed').click(); await box.locator('.sv.worse').waitFor();
    assert.equal(await box.locator('.tl-row').count(), 2); assert.equal(await box.locator('.fs-row').count(), 2);

    assert.doesNotMatch(stderr, /observer failed|main process error|unhandled rejection/i, stderr);
    console.log('PASS Speed check: Noindex chip, Checks (4 problems, 9 passed, cards, commands, Copy, Show), Speed (verdict, timeline, filmstrip of both servers, Google thresholds, causes), findings, Ask Claude, Measure again; without Live: no DNS record and refused (reason, label, cards, findings, Speed and Checks of the new server alone, no Live requests, Measure Live too), Live back with Check Live too');
  } catch (error) { console.error(`app output:\n${stderr.slice(-6000)}`); throw error; } finally {
    await app?.close().catch(() => {});
    for (const s of servers) { s.closeAllConnections(); s.close(); }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.env.SPEED_CHECK_WORK) inside().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
else process.exit(outside());
