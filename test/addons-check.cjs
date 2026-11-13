// Add-ons (1.4): the real app in a private test network, with a test add-on from a feed on this computer. The site
// (the bakery of the speed check) loads a script from a listed domain on both servers and, on the new server only,
// redirects visitors who come from Google. Covers: codes that must not install anything, confirm before install, the red
// label, the add-on's tab in Differences, the card on a site without a rule, updates over the air (data at once, code
// after a restart, older and forged releases refused), off and on, a changed file on disk, remove. Needs Linux as root
// (network and mount namespace); elsewhere it says SKIP. ADDONS_CHECK_SHOTS=<dir> saves screenshots at 1440x1200.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), https = require('node:https'), http = require('node:http'), dgram = require('node:dgram'), zlib = require('node:zlib');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const DOMAIN = 'northwind-bakery.test', NEW = '203.0.113.10', OLD = '198.51.100.24', REFUSED = '198.51.100.30', PLAIN = 'plain-shop.test', APP = path.join(__dirname, '..');

function outside() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) { console.log('SKIP add-ons check: needs Linux as root for its private test network'); return 0; }
  for (const tool of ['openssl', 'certutil', 'unshare', 'ip', 'iptables', 'xvfb-run']) if (spawnSync('sh', ['-c', `command -v ${tool}`]).status) { console.error(`add-ons check needs ${tool}`); return 1; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-addons-check-'));
  try {
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: 'ignore' });
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/O=Example Trust Services/CN=Example Trust CA R3']);
    run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'site.key', '-out', 'site.csr', '-subj', `/CN=${DOMAIN}`]);
    // IP SAN: the old server also answers https on its bare address (the temporary URL /~northwind/ of the old account).
    fs.writeFileSync(path.join(work, 'ext.cnf'), `subjectAltName=DNS:${DOMAIN},DNS:www.${DOMAIN},DNS:staging.${DOMAIN},DNS:${PLAIN},IP:${OLD}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
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
    const result = spawnSync('unshare', ['-n', '-m', 'sh', '-c', `${net} && exec xvfb-run -a -s '-screen 0 1440x1500x24' node ${JSON.stringify(__filename)}`], { stdio: 'inherit', env: { ...process.env, ADDONS_CHECK_WORK: work, HOME: path.join(work, 'home') } });
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
  return { HOME, PAGES, handler, redirect, delay: (side, ms) => { DELAY[side] = ms; } };
}
// Live in the public zone: an address, or none at all (NXDOMAIN, a site that only exists on the new server).
function publicLive(ip) {
  delete PUBLIC_DNS[`${DOMAIN} A`]; delete PUBLIC_DNS[`www.${DOMAIN} CNAME`];
  if (ip) Object.assign(PUBLIC_DNS, { [`${DOMAIN} A`]: [ip], [`www.${DOMAIN} CNAME`]: [DOMAIN] });
}

async function inside() {
  const { _electron: electron } = require('playwright');
  const crypto = require('node:crypto');
  const { makeCode } = require('../src/addons.cjs');
  const work = process.env.ADDONS_CHECK_WORK, shots = process.env.ADDONS_CHECK_SHOTS, sleep = ms => new Promise(r => setTimeout(r, ms));
  const tls = { key: fs.readFileSync(path.join(work, 'site.key')), cert: fs.readFileSync(path.join(work, 'site.crt')) };
  PUBLIC_DNS[`${PLAIN} A`] = [OLD];
  await dnsOn('127.0.0.1', PUBLIC_DNS); await dnsOn(NEW, NEW_DNS);
  const { HOME, PAGES, handler, redirect } = site(work), servers = [];
  // The site can be infected per server: a script from a listed domain in the page, and a redirect for visitors from Google.
  const clean = { new: PAGES.new, old: PAGES.old }, cloak = { new: false, old: false };
  const infect = (side, hosts) => { PAGES[side] = clean[side].replace('</body>', `${hosts.map(h => `<script src="https://${h}/jq.min.js"></script>`).join('')}</body>`); };
  const wrapped = side => { const base = handler(side); return (req, res) => {
    if (cloak[side] && new URL(req.url, HOME).pathname === '/' && /google\./.test(String(req.headers.referer || ''))) { res.writeHead(302, { Location: 'https://cheap-meds.example/?id=nb' }); return res.end(); }
    return base(req, res);
  }; };
  for (const [side, ip] of [['new', NEW], ['old', OLD]]) {
    const secure = https.createServer(tls, wrapped(side)), plain = http.createServer(redirect(side));
    servers.push(secure, plain);
    await new Promise(r => secure.listen(443, ip, r)); await new Promise(r => plain.listen(80, ip, r));
  }
  infect('new', ['cdn-jquery.example']); infect('old', ['cdn-jquery.example']); cloak.new = true;

  // The add-on feed on this computer: releases signed with a test key, behind a bearer token.
  const signer = crypto.generateKeyPairSync('ed25519'), stranger = crypto.generateKeyPairSync('ed25519'), TOKEN = 'tok_addons_check_0001';
  const pub = signer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/addon-main.cjs'), 'utf8'), feeds = {}, asked = [];
  const release = (name, key, { version = '1.0.0', code = FIXTURE, domains = ['cdn-jquery.example'], list = '2026-11-11' } = {}) => {
    const codeBytes = Buffer.from(code), dataBytes = Buffer.from(JSON.stringify({ version: list, domains: Object.fromEntries(domains.map(d => [d, { kind: 'skimmer' }])) }));
    const manifest = Buffer.from(JSON.stringify({ format: 1, id: 'malware-scan', name: 'Malware Scan', by: 'SolutionMAX', version, minDioptra: '1.0.0', tab: { label: 'Security', sub: 'malware scan · test add-on' },
      adds: ['A Security tab in Differences', 'A red Malware label next to the server name'], may: ['Read the pages you open in Dioptra'],
      code: { file: 'main.cjs', sha256: sha(codeBytes), size: codeBytes.length }, data: { file: 'threats.json', sha256: sha(dataBytes), size: dataBytes.length, version: list, rules: domains.length } }));
    feeds[name] = { 'addon.json': manifest, 'addon.json.sig': Buffer.from(crypto.sign(null, manifest, key).toString('base64')), 'main.cjs': codeBytes, 'threats.json': dataBytes };
  };
  const feedServer = http.createServer((req, res) => {
    asked.push(req.url);
    const [, name, file] = req.url.split('/'), body = req.headers.authorization === `Bearer ${TOKEN}` ? feeds[name]?.[file] : null;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end(); }
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Length': body.length }); return res.end(body);
  });
  await new Promise(r => feedServer.listen(0, '127.0.0.1', r)); servers.push(feedServer);
  const FEED = `http://127.0.0.1:${feedServer.address().port}/`;
  release('good', signer.privateKey); release('forged', stranger.privateKey);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-addons-profile-')), addonDir = path.join(profile, 'addons');
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ autoUpdates: false, autoUpdatesChosen: true, onboardingCompleted: true, tabs: [HOME], rules: [{ domain: DOMAIN, ip: NEW, enabled: true, www: true }] }));
  let app, ui, stderr = '';
  const launch = async () => {
    app = await electron.launch({ executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs'), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`, `--addon-key=${pub}`], cwd: APP, env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(work, 'ca.crt') } });
    app.process().stderr.on('data', chunk => { stderr += chunk; });
    ui = await app.firstWindow(); ui.setDefaultTimeout(20000); await ui.waitForFunction(() => window.browser);
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1440, height: 1200 }));
  };
  const cmd = (action, data) => ui.evaluate(([a, d]) => window.browser.command(a, d), [action, data]);
  const st = async () => (await cmd('state')).state;
  async function wait(check, label, ms = 30000) { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await check().catch(() => null); if (last) return last; await sleep(150); } const s = await st(); throw new Error(`${label}: ${JSON.stringify([s.view, s.addons, s.addonTabs, s.tabs.map(t => [t.mode, t.url, t.loading, t.chips])])}`); }
  const shot = async name => { if (!shots) return; await ui.evaluate(() => { document.getElementById('toast').hidden = true; }); await ui.mouse.move(4, 1190); await sleep(900); fs.mkdirSync(shots, { recursive: true }); execFileSync('import', ['-window', 'root', '-crop', '1440x1200+0+0', '+repage', path.join(shots, name)]); };
  const clip = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const text = locator => locator.evaluate(node => { const parts = [], walk = x => { for (const c of x.childNodes) { if (c.nodeType === 3) parts.push(c.textContent); else walk(c); } }; walk(node); return parts.join(' ').replace(/\s+/g, ' ').trim(); });
  const cardText = async needle => { const until = Date.now() + 15000; for (;;) { const page = app.windows().find(w => w.url().includes('card.html')); if (page) { await page.waitForFunction(t => document.body.innerText.includes(t), needle); return (await page.locator('body').innerText()).replace(/\s+/g, ' '); } if (Date.now() > until) throw new Error('card did not open'); await sleep(100); } };
  const openAddons = async () => { if (!(await ui.locator('#settings-section').isVisible())) await ui.locator('#settings').click(); if (await ui.locator('#settings-back').isVisible()) await ui.locator('#settings-back').click(); await ui.locator('#settings-menu [data-settings-category=addons]').click(); await ui.locator('#addons-body h3, #addons-body .claude-heading').first().waitFor(); };
  const page = ui => ui.locator('#addons-body');
  const hostTab = () => wait(async () => (await st()).tabs.find(t => t.mode === 'hostfile' && !t.loading && /Northwind Bakery/.test(t.title)), 'Hostfile page');
  try {
    await launch();
    await hostTab();

    // 1. No add-on: Settings has an Add-ons page, nothing is scanned, no label, no extra tab.
    await openAddons();
    assert.equal(await text(page(ui).locator('h3')), 'Add-ons');
    assert.match(await text(page(ui)), /No add-ons installed .* Dioptra only installs add-ons signed by SolutionMAX\. Anything else is refused\./);
    assert.deepEqual((await st()).addons, { installed: [], pending: null });
    assert.equal(await ui.locator('#route-bar .route-addon').count(), 0);
    await shot('addons-1-empty.png');

    // 2. Codes that must not install anything: no code, a wrong key, a feed signed by someone else.
    const code = (name, token = TOKEN) => makeCode(`${FEED}${name}/`, token);
    const enter = async value => { await page(ui).locator('#addon-code').fill(value); await page(ui).getByRole('button', { name: 'Continue' }).click(); };
    await enter('hello'); await page(ui).locator('.addon-error').waitFor();
    assert.equal(await text(page(ui).locator('.addon-error')), 'This is not an add-on code.');
    await enter(code('good', 'tok_someone_elses_key')); await wait(async () => /does not accept this code/.test(await text(page(ui).locator('.addon-error'))), 'wrong key refused');
    await enter(code('forged')); await wait(async () => /not signed by SolutionMAX, or it was changed after signing\. Nothing from it was run\./.test(await text(page(ui).locator('.addon-error'))), 'forged feed refused');
    await shot('addons-2-refused.png');
    assert.equal(fs.existsSync(addonDir), false, 'nothing was stored');
    assert.ok(!asked.some(u => /main\.cjs|threats\.json/.test(u)), `no code was fetched: ${asked}`);
    assert.equal(await page(ui).locator('#addon-code').inputValue(), code('forged'), 'the code stays in the field after an error');

    // 3. The real code: first what it is, with the signature checked; only Install fetches and starts it.
    asked.length = 0;
    await enter(code('good')); await page(ui).getByRole('button', { name: 'Install', exact: true }).waitFor();
    assert.match(await text(page(ui)), /^Malware Scan Add-on by SolutionMAX ✓ Signature verified 1\.0\.0 What it adds A Security tab in Differences A red Malware label next to the server name What it may do Read the pages you open in Dioptra Install Cancel Signed by SolutionMAX\./);
    assert.deepEqual(asked, ['/good/addon.json', '/good/addon.json.sig']);
    assert.equal(fs.existsSync(addonDir), false);
    await shot('addons-3-confirm.png');
    await page(ui).getByRole('button', { name: 'Cancel' }).click(); await page(ui).locator('#addon-code').waitFor();
    assert.equal((await st()).addons.pending, null);
    await enter(code('good')); await page(ui).getByRole('button', { name: 'Install', exact: true }).click();
    await page(ui).locator('.settings-card.addon').waitFor();
    assert.match(await text(page(ui).locator('.settings-card.addon')), /^Malware Scan Add-on by SolutionMAX Active 1\.0\.0 Scans every page after it has loaded, and both servers in Differences\. Threat list 1 rule · 2026-11-11 Updates Automatic\. Last checked .+\. Check for updates Turn off Remove…$/);
    assert.equal(await ui.locator('#toast').innerText(), 'Malware Scan installed.');
    assert.equal(await page(ui).locator('#addon-code').inputValue(), '');
    assert.deepEqual(fs.readdirSync(path.join(addonDir, 'malware-scan')).sort(), ['addon.json', 'addon.json.sig', 'main.cjs', 'source.json', 'threats.json']);
    assert.doesNotMatch(JSON.stringify(await st()), new RegExp(`${TOKEN}|127\\.0\\.0\\.1:${feedServer.address().port}`), 'the key and the feed address stay in the main process');

    // 4. The open page is scanned at once: a red Malware label next to the server name.
    const chip = ui.locator('#route-bar .route-addon');
    await chip.waitFor();
    assert.equal(await chip.innerText(), 'Malware');
    assert.equal(await chip.getAttribute('title'), 'Malware Scan found 2 threats on this page. Click to see what was found.');
    await shot('addons-4-label.png');

    // 5. The label opens Differences on the add-on's part: both servers, side by side.
    await ui.locator('#close-panel').click();
    await chip.click();
    const box = ui.locator('#differences');
    await box.locator('.diff-menu').waitFor();
    const row = id => box.locator(`.dm-row[data-part="${id}"]`), over = id => box.locator(`.ov-part[data-part="${id}"]`);
    const done = await wait(async () => (await st()).addonTabs.find(a => a.status === 'done'), 'scan of both servers');
    assert.deepEqual(done.report.sides, ['hostfile', 'live']); assert.deepEqual(done.report.counts, { problems: 2, differ: 0, passed: 0, total: 2 });
    await wait(async () => (await box.locator('.addon-panel .cs').count()) === 1, 'add-on panel drawn');
    assert.deepEqual(await box.locator('.dm-row strong').allInnerTexts(), ['Overview', 'External domains', 'Files', 'HTML', 'Headers', 'Speed', 'Checks', 'Malware Scan']);
    assert.deepEqual(await box.locator('.dm-list .lbl').allInnerTexts().then(a => a.map(t => t.toLowerCase())), ['the page', 'the server', 'add-ons']);
    assert.equal(await box.locator('.dm-row[aria-current=true] strong').innerText(), 'Malware Scan');
    assert.equal(await row('addon:malware-scan').locator('.stag').innerText(), '2 threats');
    assert.match(await row('addon:malware-scan').locator('.stag').getAttribute('class'), /\bis-fix\b/);
    assert.match(await row('addon:malware-scan').locator('.ptile').getAttribute('style'), /color: rgb\(105, 56, 239\)/, 'the tile of a known add-on has its own colour');
    assert.equal((await text(box.locator('.dch'))).toLowerCase(), 'malware scan add-on spam, card skimmers and hidden redirects 2 threats by solutionmax');
    assert.deepEqual(await box.locator('.addon-panel .cs-n > span:not(.sep)').allInnerTexts(), ['2 threats', '0 clean']);
    assert.deepEqual((await box.locator('.addon-panel .cchip').allInnerTexts()).map(t => t.replace(/\s+/g, ' ')), ['Injected script 1', 'Redirect 1']);
    const cards = box.locator('.addon-panel .pc');
    assert.equal(await cards.count(), 2);
    assert.match(await text(cards.nth(0)), /^Injected script v1: a script loads from cdn-jquery\.example Copy all Hostfile cdn-jquery\.example Live cdn-jquery\.example How to fix: remove it from footer\.php and change all passwords\. https:\/\/cdn-jquery\.example\/jq\.min\.js script in the page Copy grep -rl 'cdn-jquery\.example' wp-content\/ listed in the test list no command$/);
    assert.deepEqual(await cards.nth(0).locator('.vv').evaluateAll(n => n.map(v => v.className)), ['vv bad', 'vv bad']);
    // The redirect is only on the new server: Hostfile red, Live not.
    assert.match(await text(cards.nth(1)), /^Redirect Visitors from Google are sent to another site Hostfile 302 to https:\/\/cheap-meds\.example\/\?id=nb Live 200 OK How to fix: look in \.htaccess \.$/);
    assert.deepEqual(await cards.nth(1).locator('.vv').evaluateAll(n => n.map(v => v.className)), ['vv bad', 'vv']);
    assert.equal(await text(box.locator('.addon-panel .sec-note')), 'A clean scan is no proof of a clean site.');
    await wait(async () => (await st()).speed?.status === 'done', 'speed done', 60000);
    await shot('addons-5-security.png');
    // The Overview puts it under Fix before the switch with its worst points; the entry opens the part again, as does the keyboard.
    await box.locator('.dback').click(); await box.locator('.dverdict').waitFor();
    assert.equal(await box.locator('.dm-row[aria-current=true] strong').innerText(), 'Overview');
    assert.match(await box.locator('.dverdict').getAttribute('class'), /\bworse\b/);
    assert.equal(await box.locator('.dverdict .sv-title').innerText(), 'Not ready for the switch');
    assert.match(await text(box.locator('.dverdict .sv-fx')), /need(s)? a fix on the new server first: .*Malware Scan\.$/);
    assert.equal(await box.locator('.dstep b').first().innerText(), 'Fix before the switch');
    assert.equal(await box.locator('.ov-grid').first().locator('.ov-part[data-part="addon:malware-scan"]').count(), 1);
    assert.equal(await over('addon:malware-scan').locator('.stag.is-fix').innerText(), '2 threats');
    assert.deepEqual(await over('addon:malware-scan').locator('.ov-tops li').allInnerTexts(), ['v1: a script loads from cdn-jquery.example', 'Visitors from Google are sent to another site']);
    assert.equal(await box.locator('.kpi, .subtabs, .diff-side, .finding').count(), 0, 'the cards, the sub tabs and the side column are gone');
    assert.equal(await box.locator('.dhead .ask').innerText(), 'Ask Claude');
    // The card is a container with one button: a screen reader hears a short name, not the whole card.
    assert.equal(await over('addon:malware-scan').evaluate(n => n.tagName), 'DIV');
    assert.equal(await over('addon:malware-scan').getByRole('button').count(), 1);
    assert.equal(await over('addon:malware-scan').locator('.ov-open').getAttribute('aria-label'), 'Malware Scan: 2 threats. Open this part');
    assert.equal(await over('addon:malware-scan').locator('ul button, .ov-open ul, .ov-open div').count(), 0);
    await over('addon:malware-scan').locator('.ov-open').focus(); await ui.keyboard.press('Enter');
    await box.locator('.addon-panel .cs').waitFor();
    assert.equal(await ui.evaluate(() => document.activeElement?.dataset.part), 'addon:malware-scan', 'the focus is on the menu row of the part that opened');
    await shot('addons-5b-overview-part.png');
    // Copy: main copies its own text of that card.
    await cards.nth(0).locator('.cmd .fbtn').click(); await wait(async () => (await clip()) === "grep -rl 'cdn-jquery.example' wp-content/", 'command copied');
    await cards.nth(0).locator('.fbtn.act').click(); await wait(async () => (await clip()) === "grep -rl 'cdn-jquery.example' .", 'action copied');
    assert.equal((await cmd('addon-copy', { addon: 'malware-scan', card: 'nope' })).error, 'Run the scan first.');
    assert.equal((await cmd('differences-ask-claude')).ok, true);
    assert.match(await clip(), /BEGIN UNTRUSTED SERVER DATA[\s\S]*Malware Scan \(2 threats, 0 warnings, 0 clean\):\n- \[threat\] Injected script: v1: a script loads from cdn-jquery\.example\. Hostfile cdn-jquery\.example; Live cdn-jquery\.example\n- \[threat\] Redirect: Visitors from Google are sent to another site\. Hostfile 302 to https:\/\/cheap-meds\.example\/\?id=nb; Live 200 OK[\s\S]*END UNTRUSTED SERVER DATA/);

    // 6. A site without a domain rule: the label opens a card with what was found on that one server.
    assert.equal((await cmd('new-tab', `https://${PLAIN}/`)).ok, true);
    const plainChip = ui.locator('#route-bar .route-addon');
    await wait(async () => (await st()).tabs.find(t => t.url.includes(PLAIN) && !t.loading && t.chips.length), 'label on a site without a rule');
    await plainChip.waitFor();
    assert.equal(await plainChip.getAttribute('data-card'), 'addon'); assert.equal(await plainChip.getAttribute('title'), 'Malware Scan found 1 threat on this page. Click to see what was found.');
    await plainChip.click();
    assert.match(await cardText('a script loads from'), /^Malware Scan 1 threat · 1 clean Injected script v1: a script loads from cdn-jquery\.example cdn-jquery\.example A clean scan is no proof of a clean site\.$/i);
    await shot('addons-6-card.png');
    await cmd('card-close'); await cmd('close-tab', (await st()).activeId);
    await hostTab();

    // 7. Updates over the air. A new threat list counts at once, without a restart.
    infect('new', ['cdn-jquery.example', 'cheap-pills.example']);
    release('good', signer.privateKey, { domains: ['cdn-jquery.example', 'cheap-pills.example'], list: '2026-11-12' });
    await openAddons();
    await page(ui).getByRole('button', { name: 'Check for updates' }).click();
    await wait(async () => /Threat list 2 rules · 2026-11-12 Updates Threat list 2026-11-12 is in use\./.test(await text(page(ui).locator('.settings-card.addon'))), 'new threat list in use');
    assert.equal(await ui.locator('#toast').innerText(), 'Threat list 2026-11-12 is in use.');
    assert.equal(await page(ui).locator('.addon-restart').count(), 0);
    await ui.locator('#close-panel').click();
    await cmd('reload');
    await wait(async () => (await ui.locator('#route-bar .route-addon').getAttribute('title').catch(() => '')) === 'Malware Scan found 3 threats on this page. Click to see what was found.', 'the new list finds the second domain');

    // New code waits for a restart; until then the running version keeps working.
    release('good', signer.privateKey, { version: '1.1.0', code: FIXTURE.replace("const MARK = 'v1';", "const MARK = 'v2';"), domains: ['cdn-jquery.example', 'cheap-pills.example'], list: '2026-11-12' });
    await openAddons();
    await page(ui).getByRole('button', { name: 'Check for updates' }).click();
    await page(ui).locator('.addon-restart').waitFor();
    assert.match(await text(page(ui).locator('.settings-card.addon')), /Active 1\.1\.0 .* Updates Automatic\. Last checked .+\. A new version is ready\. Restart Dioptra to use it\. Check for updates/);
    await shot('addons-7-update.png');
    // A feed that goes back, or that is signed by someone else, changes nothing.
    release('good', signer.privateKey, { version: '1.0.5' });
    assert.match((await cmd('addon-check', 'malware-scan')).notice, /offers 1\.0\.5, older than the installed 1\.1\.0\. Nothing was changed\./);
    release('good', stranger.privateKey, { version: '9.9.9', code: 'process.exit(1)' });
    assert.match((await cmd('addon-check', 'malware-scan')).notice, /not signed by SolutionMAX/);
    assert.equal((await st()).addons.installed[0].version, '1.1.0');
    release('good', signer.privateKey, { version: '1.1.0', code: FIXTURE.replace("const MARK = 'v1';", "const MARK = 'v2';"), domains: ['cdn-jquery.example', 'cheap-pills.example'], list: '2026-11-12' });

    // 8. After the restart the new version runs.
    await app.close(); await launch(); await hostTab();
    await ui.locator('#route-bar .route-addon').waitFor();
    assert.equal((await cmd('view', 'differences')).ok, true);
    const v2 = await wait(async () => (await st()).addonTabs.find(a => a.status === 'done'), 'scan with the new version');
    assert.equal(v2.report.groups[0].items[0].title, 'v2: a script loads from cdn-jquery.example');
    assert.deepEqual((await st()).addons.installed.map(a => [a.version, a.restart, a.status]), [['1.1.0', false, 'active']]);
    await wait(async () => (await st()).speed?.status === 'done', 'speed done', 60000);
    assert.equal((await cmd('view', 'single')).ok, true);

    // 9. Off: nothing is scanned, the label goes. On again: it comes back.
    await openAddons();
    await page(ui).getByRole('button', { name: 'Turn off' }).click();
    await wait(async () => /Off 1\.1\.0 Switched off: nothing is scanned\./.test(await text(page(ui).locator('.settings-card.addon'))), 'switched off');
    assert.equal(await ui.locator('#route-bar .route-addon').count(), 0);
    assert.deepEqual((await st()).addonTabs, []);
    await page(ui).getByRole('button', { name: 'Turn on' }).click();
    await ui.locator('#route-bar .route-addon').waitFor();

    // 10. A file changed on disk: after a restart the add-on does not run and says why. Remove takes it away.
    await app.close();
    fs.appendFileSync(path.join(addonDir, 'malware-scan', 'main.cjs'), '\nrequire("node:fs").writeFileSync(process.env.ADDONS_CHECK_WORK + "/ran", "1");');
    await launch(); await hostTab();
    await openAddons();
    assert.match(await text(page(ui).locator('.settings-card.addon')), /^Malware Scan Add-on by SolutionMAX Needs attention 1\.1\.0 main\.cjs does not match the signed manifest\. Nothing from it was run\. Remove…$/);
    assert.equal(fs.existsSync(path.join(work, 'ran')), false, 'the changed file did not run');
    assert.equal(await ui.locator('#route-bar .route-addon').count(), 0);
    await shot('addons-8-changed.png');
    await page(ui).getByRole('button', { name: 'Remove…' }).click();
    assert.match(await text(page(ui).locator('.inline-confirm')), /^Remove Malware Scan\? You need your code to install it again\. Cancel Remove add-on$/);
    await page(ui).getByRole('button', { name: 'Remove add-on' }).click();
    await wait(async () => /No add-ons installed/.test(await text(page(ui))), 'removed');
    assert.deepEqual(fs.readdirSync(addonDir), []);

    assert.doesNotMatch(stderr.replace(/Add-on malware-scan was not loaded[^\n]*/g, ''), /observer failed|main process error|unhandled rejection|Add-on scan:|Add-on malware-scan:/i, stderr);
    console.log('PASS Add-ons check: Settings page, refused codes (not a code, wrong key, forged signature) store nothing, confirm before install, install, red label on the open page, its part in Differences with both servers, the Overview with its worst points, keyboard, Copy, Ask Claude, card on a site without a rule, new threat list at once, new code after restart, older and forged updates refused, off and on, a changed file does not run, remove');
  } catch (error) { console.error(`app output:\n${stderr.slice(-6000)}`); throw error; } finally {
    await app?.close().catch(() => {});
    for (const s of servers) { s.closeAllConnections(); s.close(); }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.env.ADDONS_CHECK_WORK) inside().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
else process.exit(outside());
