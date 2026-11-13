// Whole site (1.4.0-beta.4, more in beta.5): the real app in a private test network. A site with a sitemap of twelve pages
// where the new server is wrong on every page, one page is missing on the new server, one has a script from another
// site, one redirects to another site on both servers and one only on the new server (the hijack), and one page ends in
// megabytes of unfinished tags. Covers the page list, progress and Cancel, the grouping for the site, the caps counted on
// the test servers (pages and requests at a time, no request to another host), a part in site scope with its pages, a
// page opened from the list, the chooser, an own list, no sitemap, Cancel while listing, a second run, Live dying and
// Live gone, nothing compared, leaving the site, and the request limit of a run. Needs Linux as root (network and mount
// namespace); elsewhere it says SKIP. SITE_CHECK_SHOTS=<dir> saves screenshots at 1440x1200.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), https = require('node:https'), http = require('node:http'), dgram = require('node:dgram'), zlib = require('node:zlib');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const DOMAIN = 'northwind-bakery.test', NEW = '203.0.113.10', OLD = '198.51.100.24', REFUSED = '198.51.100.30', PLAIN = 'plain-shop.test', APP = path.join(__dirname, '..');

function outside() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) { console.log('SKIP whole site check: needs Linux as root for its private test network'); return 0; }
  for (const tool of ['openssl', 'certutil', 'unshare', 'ip', 'iptables', 'xvfb-run']) if (spawnSync('sh', ['-c', `command -v ${tool}`]).status) { console.error(`whole site check needs ${tool}`); return 1; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-site-check-'));
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
    const result = spawnSync('unshare', ['-n', '-m', 'sh', '-c', `${net} && exec xvfb-run -a -s '-screen 0 1440x1500x24' node ${JSON.stringify(__filename)}`], { stdio: 'inherit', env: { ...process.env, SITE_CHECK_WORK: work, HOME: path.join(work, 'home') } });
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
  const { siteLimit, AT_ONCE } = require('../src/host-budget.cjs');
  const work = process.env.SITE_CHECK_WORK, shots = process.env.SITE_CHECK_SHOTS, sleep = ms => new Promise(r => setTimeout(r, ms));
  const tls = { key: fs.readFileSync(path.join(work, 'site.key')), cert: fs.readFileSync(path.join(work, 'site.crt')) };
  PUBLIC_DNS[`${PLAIN} A`] = [OLD];
  const lookedUp = [];
  await dnsOn('127.0.0.1', PUBLIC_DNS, name => lookedUp.push(name)); await dnsOn(NEW, NEW_DNS, name => lookedUp.push(name));
  const { HOME, PAGES, handler, redirect } = site(work), servers = [];
  // Twelve pages in the sitemap. Every page of the new server has what its home page has (noindex, old addresses, the
  // logo from the old server). /bestellen/ does not exist on the new server, /cakes/ loads a script from another site on
  // the new server only, /away/ redirects to another site on both servers, /hijack/ only on the new server, /hostile/
  // ends in megabytes of unfinished tags. The sitemap also names a page of another site, one page twice (once without
  // its slash) and one with a tracking query.
  const NAMES = { '/bread/': 'Bread', '/cakes/': 'Celebration cakes', '/contact/': 'Contact', '/about/': 'About us', '/blog/': 'Blog', '/terms/': 'Terms', '/delivery/': 'Delivery', '/hijack/': 'Win a prize', '/hostile/': 'Odd page' };
  const LIST = ['/', '/bread/', '/cakes/', '/bestellen/', '/contact/', '/about/', '/blog/', '/terms/', '/delivery/', '/away/', '/hijack/', '/hostile/'];
  const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...LIST, '/bread', '/contact/?utm_source=mail'].map(p => `<url><loc>${HOME}${p.slice(1).replace('&', '&amp;')}</loc></url>`).join('')}<url><loc>https://other-shop.example/</loc></url></urlset>\n`;
  const HOSTILE = `${'<title'.repeat(120000)}${'<script'.repeat(120000)}<!--`;
  const pageFor = (side, p) => PAGES[side].replace('Fresh every morning,<br>since 1962.', NAMES[p]).replace('<title>Northwind Bakery · Fresh every morning</title>', `<title>${NAMES[p]} · Northwind Bakery</title>`)
    .replace('</body>', `${p === '/cakes/' && side === 'new' ? '<script src="https://cdn-jquery.example/jq.min.js"></script>' : ''}${p === '/hostile/' ? HOSTILE : ''}</body>`);
  const seen = { new: 0, old: 0 }, now = { new: 0, old: 0 }, most = { new: 0, old: 0 }, paths = { new: [], old: [] }, inFlight = new Map();
  // flags the steps below switch: no sitemap, a slow robots.txt, Live cutting the connection, the home page moved away.
  const flag = { sitemap: true, slowList: 0, liveDead: false, homeAway: false };
  let probes = 0, mostPages = 0;
  const counted = (side, inner) => (req, res) => {
    const p = new URL(req.url, HOME).pathname, isPage = side === 'new' && LIST.includes(p);
    seen[side]++; now[side]++; most[side] = Math.max(most[side], now[side]); paths[side].push(req.url);
    // Pages in flight on the new server: distinct pages, however many requests each has.
    if (isPage) { inFlight.set(p, (inFlight.get(p) || 0) + 1); mostPages = Math.max(mostPages, inFlight.size); }
    res.on('close', () => { now[side]--; if (isPage) { const left = inFlight.get(p) - 1; if (left) inFlight.set(p, left); else inFlight.delete(p); } });
    return inner(req, res);
  };
  const wrapped = side => { const base = handler(side); return (req, res) => {
    const p = new URL(req.url, HOME).pathname, html = body => setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', Server: side === 'new' ? 'nginx/1.26.2' : 'LiteSpeed', 'Content-Length': Buffer.byteLength(body) }); res.end(body); }, side === 'new' ? 250 : 80);
    if (p === '/site-probe') { probes++; res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no'); }
    if (side === 'old' && flag.liveDead && (NAMES[p] || p === '/bestellen/')) return req.socket.destroy();
    if (flag.homeAway && p === '/' && !/google\./.test(String(req.headers.referer || ''))) { res.writeHead(302, { Location: 'https://other-shop.example/' }); return res.end(); }
    if (/sitemap|^\/robots\.txt$/.test(p) && !flag.sitemap) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html><body>404</body></html>'); }
    if (p === '/robots.txt' && flag.slowList) return setTimeout(() => base(req, res), flag.slowList);
    if (p === '/wp-sitemap-posts-page-1.xml') { res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' }); return res.end(SITEMAP); }
    if (p === '/away/') { res.writeHead(302, { Location: 'https://other-shop.example/landing' }); return res.end(); }
    if (p === '/hijack/' && side === 'new') { res.writeHead(302, { Location: 'https://prizes-win.example/claim?id=nb' }); return res.end(); }
    if (NAMES[p]) return html(pageFor(side, p));
    return base(req, res);
  }; };
  for (const [side, ip] of [['new', NEW], ['old', OLD]]) {
    const secure = https.createServer(tls, counted(side, wrapped(side))), plain = http.createServer(counted(side, redirect(side)));
    servers.push(secure, plain);
    await new Promise(r => secure.listen(443, ip, r)); await new Promise(r => plain.listen(80, ip, r));
  }
  // Two add-ons from a feed on this computer: the test scanner (every page) and a probe with scope site (once per run).
  // The probe is called "constructor": its id is a key in the results, and a plain object has a property of that name.
  const PROBE_ID = 'constructor';
  const signer = crypto.generateKeyPairSync('ed25519'), TOKEN = 'tok_site_check_0001', feeds = {};
  const pub = signer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const PROBE = "module.exports = { api: 1, async scan(ctx) { const side = Object.keys(ctx.pages)[0]; await ctx.fetch(side, new URL('/site-probe', ctx.url).href); return { label: 'Probe', counts: { problems: 1, differ: 0, passed: 0, total: 1 }, summary: [{ tone: 'bad', text: '1 open' }], sub: 'asked once', groups: [{ id: 'g', label: 'Probe', items: [{ title: 'The probe file is open, rescan ' + ctx.rescan, tone: 'worse', values: {}, bad: {} }] }], passed: [] }; } };";
  const release = (id, name, code, extra, data) => {
    const codeBytes = Buffer.from(code), dataBytes = Buffer.from(JSON.stringify(data));
    const manifest = Buffer.from(JSON.stringify({ format: 1, id, name, by: 'SolutionMAX', version: '1.0.0', minDioptra: '1.0.0', tab: { label: name, sub: 'test add-on' }, adds: ['A part in Differences'], may: ['Ask the site itself'], ...extra,
      code: { file: 'main.cjs', sha256: sha(codeBytes), size: codeBytes.length }, data: { file: 'data.json', sha256: sha(dataBytes), size: dataBytes.length, version: '1', rules: 1 } }));
    feeds[id] = { 'addon.json': manifest, 'addon.json.sig': Buffer.from(crypto.sign(null, manifest, signer.privateKey).toString('base64')), 'main.cjs': codeBytes, 'data.json': dataBytes };
  };
  release('malware-scan', 'Malware Scan', fs.readFileSync(path.join(__dirname, 'fixtures/addon-main.cjs'), 'utf8'), {}, { version: '1', domains: { 'cdn-jquery.example': { kind: 'skimmer' } } });
  release(PROBE_ID, 'Site Probe', PROBE, { scope: 'site' }, { version: '1' });
  const feedServer = http.createServer((req, res) => {
    const [, id, file] = req.url.split('/'), body = req.headers.authorization === `Bearer ${TOKEN}` ? (Object.hasOwn(feeds, id) ? feeds[id][file] : null) : null;
    if (!body) { res.writeHead(req.headers.authorization === `Bearer ${TOKEN}` ? 404 : 401); return res.end(); }
    res.writeHead(200, { 'Content-Length': body.length }); return res.end(body);
  });
  await new Promise(r => feedServer.listen(0, '127.0.0.1', r)); servers.push(feedServer);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-site-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ autoUpdates: false, autoUpdatesChosen: true, onboardingCompleted: true, tabs: [HOME], rules: [{ domain: DOMAIN, ip: NEW, enabled: true, www: true }] }));
  let app, ui, stderr = '';
  const launch = async (...more) => {
    app = await electron.launch({ executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: ['--no-sandbox', '-r', path.join(__dirname, 'root-harness.cjs'), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`, `--addon-key=${pub}`, ...more], cwd: APP, env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(work, 'ca.crt') } });
    app.process().stderr.on('data', chunk => { stderr += chunk; });
    ui = await app.firstWindow(); ui.setDefaultTimeout(20000); await ui.waitForFunction(() => window.browser);
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1440, height: 1200 }));
  };
  const cmd = (action, data) => ui.evaluate(([a, d]) => window.browser.command(a, d), [action, data]);
  const st = async () => (await cmd('state')).state;
  async function wait(check, label, ms = 40000) { const end = Date.now() + ms; while (Date.now() < end) { const last = await check().catch(() => null); if (last) return last; await sleep(120); } const s = await st(); throw new Error(`${label}: ${JSON.stringify([s.view, s.site && { ...s.site, parts: s.site.parts.map(p => [p.id, p.state, p.where]) }, s.differences?.status, s.tabs.map(t => t.url)])}`); }
  const shot = async name => { if (!shots) return; await ui.evaluate(() => { document.getElementById('toast').hidden = true; }); await ui.mouse.move(4, 1190); await sleep(700); fs.mkdirSync(shots, { recursive: true }); execFileSync('import', ['-window', 'root', '-crop', '1440x1200+0+0', '+repage', path.join(shots, name)]); };
  const text = locator => locator.evaluate(node => { const parts = [], walk = x => { for (const c of x.childNodes) { if (c.nodeType === 3) parts.push(c.textContent); else walk(c); } }; walk(node); return parts.join(' ').replace(/\s+/g, ' ').trim(); });
  const siteDone = (label, more = () => true, ms = 90000) => wait(async () => { const s = (await st()).site; return s && !s.running && s.status !== 'listing' && s.status !== 'running' && more(s) && s; }, label, ms);
  const quiet = async () => { let last = -1; while (last !== seen.new + seen.old) { last = seen.new + seen.old; await sleep(1200); } };
  try {
    await launch();
    await wait(async () => (await st()).tabs.find(t => t.mode === 'hostfile' && !t.loading && /Northwind Bakery/.test(t.title)), 'Hostfile page');
    await ui.locator('#settings').click(); await ui.locator('#settings-menu [data-settings-category=addons]').click();
    for (const id of ['malware-scan', PROBE_ID]) {
      await ui.locator('#addons-body #addon-code').fill(makeCode(`http://127.0.0.1:${feedServer.address().port}/${id}/`, TOKEN));
      await ui.locator('#addons-body').getByRole('button', { name: 'Continue' }).click();
      await ui.locator('#addons-body').getByRole('button', { name: 'Install', exact: true }).click();
      await wait(async () => (await st()).addons.installed.some(a => a.id === id && a.status === 'active'), `${id} installed`);
    }
    await ui.locator('#close-panel').click();
    // The label of the add-on called "constructor" comes from its own scan of the tab, not from Object.
    await wait(async () => (await st()).tabs[0].chips.some(c => c.id === PROBE_ID && c.text === 'Probe'), 'label of the probe');

    // 1. The page view first: the comparison of the open page, with its checks, speed and both add-ons.
    // The verdict is drawn after the state changes: wait for the title (10 s), then compare what is shown.
    const verdictTitle = async want => { let got = ''; await wait(async () => (got = await box.locator('.dverdict .sv-title').innerText()) === want, `verdict title "${want}"`, 10000).catch(() => {}); assert.equal(got, want); };
    let box = ui.locator('#differences'), row = id => box.locator(`.dm-row[data-part="${id}"]`), over = id => box.locator(`.ov-part[data-part="${id}"]`);
    await ui.locator('#view-differences').click();
    const pageDone = label => wait(async () => { const s = await st(); return s.differences?.status === 'done' && s.checks?.status === 'done' && s.speed?.status === 'done' && s.addonTabs.length === 2 && s.addonTabs.every(a => a.status === 'done') && s; }, label, 90000);
    const first = await pageDone('page comparison');
    assert.equal(first.site, null, 'no whole-site result before it is asked for');
    assert.deepEqual(first.addonTabs.map(a => [a.id, a.scope, a.status]), [['malware-scan', 'page', 'done'], [PROBE_ID, 'site', 'done']]);
    assert.match(first.addonTabs[1].report.groups[0].items[0].title, /rescan false$/, 'opening Differences is not Compare again');
    assert.deepEqual(await box.locator('.dscope button').allInnerTexts(), ['This page', 'Whole site']);
    await quiet();

    // 2. Whole site: the pages come from the sitemap, two at a time; the verdict shows the progress and Cancel stops it.
    //    The view is drawn again after every page: the focus stays on Cancel.
    const startCount = () => { const at = { new: seen.new, old: seen.old, probes }; most.new = 0; most.old = 0; mostPages = 0; paths.new.length = 0; paths.old.length = 0; return at; };
    let from = startCount();
    await box.locator('.dscope button[data-scope=site]').click();
    await wait(async () => { const s = (await st()).site; return s?.status === 'running' && s.done >= 1; }, 'the first page compared', 30000);
    assert.equal(await box.locator('.dm-head h2').innerText(), 'Whole site');
    assert.match(await box.locator('.dverdict .sv-title').innerText(), /^Comparing \d+ of 12 pages$/);
    assert.equal(await box.locator('.dverdict').evaluate(n => /\b(worse|better)\b/.test(n.className)), false, 'neutral while it runs');
    await box.locator('.dverdict').getByRole('button', { name: 'Cancel' }).focus();
    const drawn = (await st()).site.done;
    await wait(async () => (await st()).site.done >= drawn + 2, 'two more pages', 30000);
    assert.equal(await ui.evaluate(() => document.activeElement?.dataset.keep), 'cancel', 'the focus is still on Cancel after the view was drawn again');
    await shot('site-check-1-progress.png');
    await ui.keyboard.press('Enter');
    const stopped = await siteDone('cancelled', s => s.status === 'cancelled', 20000);
    assert.ok(stopped.compared >= 3 && stopped.compared < 11, `stopped after ${stopped.compared}`);
    await verdictTitle(`Stopped after ${stopped.compared} of 12 pages`);
    assert.equal(await box.locator('.dverdict').getByRole('button', { name: 'Cancel' }).count(), 0);
    assert.equal(stopped.own.length + stopped.rest.length, stopped.compared, 'what was compared stays');
    await sleep(1500); const afterStop = seen.new + seen.old; await sleep(1500);
    assert.equal(seen.new + seen.old, afterStop, 'nothing is asked any more after Cancel');

    // 3. Compare again in Whole site runs the whole list. The counters on the servers stay under the caps.
    await quiet(); from = startCount(); lookedUp.length = 0;
    await box.locator('.dhead').getByRole('button', { name: 'Compare again' }).click();
    const done = await siteDone('whole site compared', s => s.status === 'done');
    const asked = { new: seen.new - from.new, old: seen.old - from.old };
    console.log(`whole site: ${done.total} pages in ${done.tookMs} ms, requests new ${asked.new}, old ${asked.old}, at once new ${most.new}, old ${most.old}, pages at once ${mostPages}, probe ${probes - from.probes}`);
    console.log(JSON.stringify({ parts: done.parts.map(p => [p.id, p.state, p.tag, p.where, p.wideState, p.wideWhere, p.tops, p.more]), own: done.own, rest: done.rest.map(p => p.path), notes: done.notes }));
    assert.deepEqual([done.total, done.compared, done.source, done.wanted], [12, 11, 'wp-sitemap.xml', 20], 'the page named twice (/bread and /bread/) and the one with a tracking query count once');
    assert.deepEqual(done.notes, ['1 address in the sitemap is of another site or a file and was left out', '1 page redirects on both servers to other-shop.example, another site, and was skipped: /away/']);
    assert.ok(done.tookMs < 30000, `the page of megabytes of unfinished tags does not hold the run up: ${done.tookMs} ms`);
    // Review 18: two pages at a time, counted as pages in flight on the new server, and at most four requests per server.
    assert.equal(mostPages, 2, 'two pages at a time, never more');
    assert.ok(most.new <= AT_ONCE && most.old <= AT_ONCE, `at most ${AT_ONCE} requests at a time per server: new ${most.new}, old ${most.old}`);
    assert.ok(asked.new + asked.old <= siteLimit(12), `${asked.new + asked.old} requests, limit ${siteLimit(12)}`);
    assert.ok(asked.new + asked.old <= 12 * 12, `a polite run: ${asked.new + asked.old} requests for 12 pages`);
    assert.equal(probes - from.probes, 1, 'the site-scope add-on is scanned once per run');
    // Review 2: a redirect to another site is never followed: no request, not even a DNS question, for the other hosts.
    assert.ok(!lookedUp.some(name => /other-shop|prizes-win/.test(name)), `asked the DNS for ${lookedUp.filter(name => /other-shop|prizes-win/.test(name))}`);
    assert.equal(paths.new.filter(p => p === '/bread/').length, 2, 'a page the sitemap names twice is compared once (the document and the scan of the add-on)');
    assert.equal(paths.new.filter(p => /^\/contact\//.test(p)).every(p => p === '/contact/'), true, 'the address without the tracking query is the one that is asked');
    const part = id => done.parts.find(p => p.id === id);
    // On every page that exists on the new server (9 of 11: /bestellen/ is a 404, /hijack/ a redirect): noindex.
    assert.deepEqual([part('checks').state, part('checks').wideState, part('checks').where], ['fix', 'fix', 'On 9 of 11 pages']);
    assert.ok(part('checks').tops.includes('The new server tells search engines not to index the site'), JSON.stringify(part('checks').tops));
    assert.deepEqual([part(`addon:${PROBE_ID}`).state, part(`addon:${PROBE_ID}`).where, part(`addon:${PROBE_ID}`).tops], ['fix', 'Once for the site', ['The probe file is open, rescan true']]);
    // Review 12: what one page has makes the part red in the menu, though for the site as a whole it is not a finding.
    assert.deepEqual([part('addon:malware-scan').state, part('addon:malware-scan').where, part('addon:malware-scan').wideState, part('addon:malware-scan').tag], ['fix', 'On 2 of 11 pages', '', '2 pages'], '/cakes/ has the script, /hijack/ sends visitors from Google away');
    assert.deepEqual([part('domains').state, part('domains').wideState, part('domains').wideWhere, part('domains').tops], ['fix', 'check', 'On 9 of 11 pages', ['198.51.100.24, image']]);
    // Review 3 and 10: the hijacked page is red on its own row, with the missing page and the page with the foreign script.
    // beta.6: the page with most findings first, and the hijack leads its row.
    assert.deepEqual(done.own.map(p => [p.path, p.state]), [['/hijack/', 'fix'], ['/bestellen/', 'fix'], ['/cakes/', 'fix']]);
    assert.match(done.own[0].text, /^The new server sends this page to prizes-win\.example, Live does not/);
    assert.match(done.own[1].text, /^HTTP status differs: Hostfile 404, Live 200/);
    assert.match(done.own[2].text, /cdn-jquery\.example, script/);
    assert.deepEqual(done.rest.map(p => p.path), ['/', '/bread/', '/contact/', '/about/', '/blog/', '/terms/', '/delivery/', '/hostile/']);
    // What the window shows.
    assert.equal(await box.locator('.dscope button[aria-pressed=true]').innerText(), 'Whole site · 12');
    assert.match(await text(box.locator('.dscope-row')), /12 pages from wp-sitemap\.xml · took \d+ s Choose pages 1 address in the sitemap .* was skipped: \/away\/$/);
    assert.match(await box.locator('.dverdict').getAttribute('class'), /\bworse\b/);
    assert.match(await text(box.locator('.dverdict .sv-fx')), /^\d parts need a fix for the whole site, and 3 of 11 pages have a problem of their own\. On the page you opened: Speed\.$/);
    // Review 15: Speed was measured on the open page only, and has its own place.
    assert.deepEqual(await box.locator('.dstep b').allInnerTexts(), ['Fix once for the whole site', 'Look at once', 'On the page you opened', 'Pages with a problem of their own']);
    assert.equal(await box.locator('.dstep').nth(2).evaluate(n => [...n.nextElementSibling.querySelectorAll('.ov-part')].map(c => c.dataset.part).join()), 'speed');
    assert.equal(await box.locator('.ov-grid').first().locator('.ov-part[data-part="speed"], .ov-part[data-part="files"]').count(), 0);
    assert.match(await text(over('checks').locator('.ov-head small')), /^On 9 of 11 pages · /);
    assert.equal(await text(over(`addon:${PROBE_ID}`).locator('.ov-head small')), 'Once for the site · asked once');
    assert.equal(await box.locator('.ov-grid').first().locator('.ov-part[data-part="addon:malware-scan"]').count(), 0, 'what one page has is not a fix for the whole site');
    assert.equal(await over('domains').locator('.stag.is-check').count(), 1, 'in the steps for the site External domains is something to look at');
    assert.equal(await row('domains').locator('.stag.is-fix').innerText(), '1 page', 'its menu row is red: one page has a script from another site');
    assert.equal(await text(box.locator('.dm-head p')), '11 pages compared on both servers');
    assert.deepEqual(await box.locator('.dm-row small').allInnerTexts().then(a => a.slice(1)), [part('domains').where, 'Measured on the page you opened', part('html').where, part('headers').where, 'Measured on the page you opened', 'On 9 of 11 pages', 'On 2 of 11 pages', 'Once for the site']);
    assert.equal(await text(box.locator('.dstep').last()), 'Pages with a problem of their own 3 of 11 pages');
    assert.deepEqual(await box.locator('.ov-page strong').allInnerTexts(), ['/hijack/', '/bestellen/', '/cakes/']);
    assert.equal(await box.locator('.ov-page .stag.is-fix').count(), 3);
    const more = box.locator('.ov-rest');
    assert.equal(await text(more), '8 pages have nothing of their own Show all'); assert.equal(await more.getAttribute('aria-expanded'), 'false');
    await shot('site-check-2-overview.png');
    await more.focus(); await ui.keyboard.press('Enter');
    assert.equal(await more.getAttribute('aria-expanded'), 'true');
    assert.equal(await ui.evaluate(() => document.activeElement?.dataset.keep), 'rest', 'the focus stays on the button that opened the list');
    assert.deepEqual(await box.locator('.ov-page strong').allInnerTexts(), ['/hijack/', '/bestellen/', '/cakes/', '/', '/bread/', '/contact/', '/about/', '/blog/', '/terms/', '/delivery/', '/hostile/']);
    assert.equal(await text(box.locator('.ov-page').nth(4)), '/bread/ Bread · Northwind Bakery Nothing of its own ›');
    await shot('site-check-3-pages.png');

    // 4. A part in Whole site: the part of the open page, with a line that says where it was found, and the pages per finding.
    await row('checks').click();
    assert.equal(await text(box.locator('.dnote-line')), 'On 9 of 11 pages. Shown here as found on the page that is open (/); a page that differs is listed under its own name.');
    assert.equal(await box.locator('.dch .stag').innerText(), part('checks').tag);
    await box.locator('.cs').waitFor();
    const affected = box.locator('.daffected');
    assert.equal(await affected.evaluate(d => d.open), false);
    await affected.locator('summary').click();
    const lines = await affected.locator('li').evaluateAll(n => n.map(li => [li.querySelector('b').textContent, li.querySelector('span').textContent]));
    assert.deepEqual(lines.find(l => /not to index/.test(l[0])), ['The new server tells search engines not to index the site', '/  /bread/  /cakes/  /contact/  /about/  /blog/  /terms/  /delivery/  /hostile/']);
    assert.ok(lines.some(l => l[1] === 'asked once for the site'), JSON.stringify(lines));
    await shot('site-check-4-part.png');
    await row('overview').click();

    // 5. A page from the list: the tab goes there and the normal page view compares it. The site result stays.
    await box.locator('.ov-page', { hasText: '/cakes/' }).click();
    const cakes = await wait(async () => { const s = await st(); return s.view === 'differences' && s.differences?.status === 'done' && /\/cakes\/$/.test(s.differences.report.url) && s.checks?.status === 'done' && s; }, 'the page from the list compared', 60000);
    assert.match(cakes.tabs.find(t => t.id === cakes.activeId).url, /\/cakes\/$/);
    assert.equal(await box.locator('.dscope button[aria-pressed=true]').innerText(), 'This page');
    assert.equal(await text(box.locator('.dscope-row')), 'This page Whole site · 12 ← Whole site, 12 pages /cakes/');
    assert.equal(await box.locator('.dm-head h2').innerText(), 'Differences');
    assert.equal(await row('domains').locator('.stag.is-fix').innerText(), '2 new');
    assert.deepEqual(await over('domains').locator('.ov-tops li').allInnerTexts(), ['cdn-jquery.example, script', '198.51.100.24, image']);
    assert.match(await text(box.locator('.dverdict.worse .sv-fx')), /need a fix on the new server first: External domains, /);
    await wait(async () => (await st()).speed?.status === 'done', 'speed of the page', 90000);
    await shot('site-check-5-page.png');
    const kept = (await st()).site;
    assert.deepEqual([kept.status, kept.tookMs, kept.compared], ['done', done.tookMs, 11], 'the site result is the one from before');
    await box.locator('.dscope-row .dlink').click();
    assert.equal(await box.locator('.dm-head h2').innerText(), 'Whole site');
    assert.equal((await st()).site.tookMs, done.tookMs, 'going back does not start over');

    // 6. Choose pages: a number of pages from the sitemap, or a list of your own. What is typed in the list survives
    //    the redraws of a run that is going on, with the cursor where it was.
    await quiet();
    await box.locator('.dhead').getByRole('button', { name: 'Compare again' }).click();
    await wait(async () => (await st()).site?.status === 'running', 'running again');
    await box.locator('.dscope-row').getByRole('button', { name: 'Choose pages' }).click();
    assert.deepEqual(await box.locator('.dchoose .fbtn').allInnerTexts(), ['5 pages', '10 pages', '20 pages', '50 pages', 'Compare these pages']);
    const typed = '/contact/\nhttps://evil.example/x\nabout/\n/contact/\nftp://x/y';
    await box.locator('.dchoose textarea').fill(typed);
    await box.locator('.dchoose textarea').evaluate(t => { t.focus(); t.setSelectionRange(3, 9); });
    const at = (await st()).site.done;
    await wait(async () => { const s = (await st()).site; return s.done >= at + 3 || !s.running; }, 'three pages while the list is open', 60000);
    assert.deepEqual(await ui.evaluate(() => { const t = document.querySelector('#differences .dchoose textarea'); return [t.value, document.activeElement === t, t.selectionStart, t.selectionEnd]; }), [typed, true, 3, 9], 'text, focus and cursor survive the redraws');
    await shot('site-check-6-chooser.png');
    await siteDone('the run under the chooser', s => s.status === 'done');
    await box.locator('.dchoose').getByRole('button', { name: 'Compare these pages' }).click();
    const own = await siteDone('own list', s => s.source === 'your list' && s.status === 'done');
    assert.deepEqual([own.total, own.rest.map(p => p.path), own.notes], [3, ['/', '/contact/', '/about/'], ['2 left out, not an address of this site: https://evil.example/x, ftp://x/y']]);
    assert.match(await text(box.locator('.dscope-row')), /3 pages from your list/);
    await box.locator('.dscope-row').getByRole('button', { name: 'Choose pages' }).click();
    await box.locator('.dchoose').getByRole('button', { name: '5 pages' }).click();
    const five = await siteDone('five pages', s => s.total === 5 && s.status === 'done');
    assert.deepEqual([five.compared, five.notes[0]], [5, 'The sitemap lists more pages; these are the first 5']);

    // 7. No sitemap: say so and offer the list. A sitemap without a page of this site says that too.
    flag.sitemap = false;
    await box.locator('.dscope-row').getByRole('button', { name: 'Choose pages' }).click();
    await box.locator('.dchoose').getByRole('button', { name: '20 pages' }).click();
    await siteDone('no sitemap', s => s.status === 'nolist');
    await verdictTitle('No sitemap found');
    assert.match(await box.locator('.dverdict .sv-fx').innerText(), /^No sitemap found on this site \(robots\.txt, \/wp-sitemap\.xml, \/sitemap\.xml, \/sitemap_index\.xml\)\. Choose pages and paste your own list of addresses\.$/);
    assert.equal(await box.locator('.dverdict').evaluate(n => /\b(worse|better)\b/.test(n.className)), false);
    assert.equal(await box.locator('.dchoose textarea').count(), 1, 'the list is offered');
    flag.sitemap = true;

    // 8. Review 14: Cancel while the page list is still being read ends in a final state, and nothing more is asked.
    flag.slowList = 2500;
    await box.locator('.dchoose').getByRole('button', { name: '20 pages' }).click();
    await wait(async () => (await st()).site?.status === 'listing', 'reading the page list');
    await verdictTitle('Looking for the pages of this site');
    await box.locator('.dverdict').getByRole('button', { name: 'Cancel' }).click();
    const early = await siteDone('cancelled while listing', s => s.status === 'cancelled', 15000);
    assert.deepEqual([early.total, early.compared, Boolean(early.stopping)], [0, 0, false]);
    await verdictTitle('Stopped before the page list was read');
    assert.equal(await box.locator('.dverdict').getByRole('button').count(), 0, 'no "Stopping…" left behind');
    await sleep(3200); const listed = paths.new.concat(paths.old).filter(p => /sitemap/.test(p)).length; await sleep(1500);
    assert.equal(paths.new.concat(paths.old).filter(p => /sitemap/.test(p)).length, listed, 'the sitemaps are not asked after Cancel');
    flag.slowList = 0;

    // 9. Review 18: a second run started during the first takes its place.
    await quiet();
    assert.equal((await cmd('site-run', { limit: 20 })).ok, true);
    await wait(async () => (await st()).site?.status === 'running' && (await st()).site.total === 12, 'the first of two runs');
    assert.equal((await cmd('site-run', { limit: 5 })).ok, true);
    const second = await siteDone('the second run', s => s.total === 5 && s.status === 'done');
    assert.deepEqual([second.compared, second.wanted], [5, 5]);
    await sleep(2000); assert.deepEqual([(await st()).site.total, (await st()).site.status], [5, 'done'], 'the first run did not come back');

    // 10. Live dies during a run: every page after that says so on its own row, the run still ends, and it is not green.
    await quiet();
    const dying = cmd('site-run', { limit: 10 });
    await wait(async () => (await st()).site?.status === 'running' && (await st()).site.done >= 2, 'two pages before Live dies');
    flag.liveDead = true; await dying;
    const dead = await siteDone('Live died', s => s.total === 10 && s.status === 'done');
    flag.liveDead = false;
    const failedRows = dead.own.filter(p => /The Live request failed/.test(p.text));
    assert.ok(failedRows.length >= 3 && failedRows.every(p => p.state === 'fix'), JSON.stringify(dead.own.map(p => [p.path, p.text])));
    assert.match(await box.locator('.dverdict').getAttribute('class'), /\bworse\b/);

    // 11. Live cannot be reached at all: the run judges the new server on its own, and says so.
    await quiet(); publicLive(null);
    assert.equal((await cmd('site-run', { limit: 5 })).ok, true);
    const solo = await siteDone('without Live', s => s.total === 5 && s.status === 'done' && Boolean(s.solo), 120000);
    assert.match(solo.solo, /^Live could not be reached: northwind-bakery\.test has no DNS record\.$/);
    assert.equal(await text(box.locator('.dm-head p')), `${solo.compared} pages compared, the new server on its own`);
    assert.deepEqual(solo.parts.filter(p => ['domains', 'html', 'headers'].includes(p.id)).map(p => [p.state, p.where]), [['none', 'Not compared'], ['none', 'Not compared'], ['none', 'Not compared']]);
    assert.equal(solo.parts.find(p => p.id === 'checks').wideState, 'fix');
    assert.equal(await box.locator('.dverdict').evaluate(n => /\bbetter\b/.test(n.className)), false);
    publicLive(OLD);

    // 12. Review 4: no page compared is never green. The home page moved away on both servers: with a list of one page
    //     that moved too nothing is compared; with a page that exists the result says what did not run.
    await quiet(); flag.homeAway = true;
    assert.equal((await cmd('site-run', { list: '/away/' })).ok, true);
    const none = await siteDone('nothing compared', s => s.source === 'your list' && s.status === 'done' && s.total === 2);
    assert.deepEqual([none.compared, none.homeSkipped, none.notes], [0, true, ['2 pages redirect on both servers to other-shop.example, another site, and were skipped: /, /away/']]);
    await verdictTitle('No page was compared');
    assert.equal(await box.locator('.dverdict').evaluate(n => /\b(worse|better)\b/.test(n.className)), false, 'not green, not red: there is no result');
    await shot('site-check-7-nothing.png');
    const probesBefore = probes;
    assert.equal((await cmd('site-run', { list: '/about/' })).ok, true);
    const noHome = await siteDone('home skipped', s => s.status === 'done' && s.compared === 1 && s.homeSkipped);
    assert.equal(noHome.homeSkipped, true); assert.equal(probes, probesBefore, 'the add-on that scans once did not run');
    assert.match(await text(box.locator('.dverdict .sv-fx')), /The home page was skipped, so the checks for the whole site and the add-ons that scan once did not run\./);
    assert.equal(await box.locator('.dverdict').evaluate(n => /\bbetter\b/.test(n.className)), false);
    flag.homeAway = false;

    // 13. The tab leaves the site while a run is going: the run stops and its result is gone.
    await quiet();
    assert.equal((await cmd('site-run', { limit: 20 })).ok, true);
    await wait(async () => { const s = (await st()).site; return s?.status === 'running' && s.done >= 1; }, 'running again', 30000);
    assert.equal((await cmd('navigate', `https://${PLAIN}/`)).ok, true);
    await wait(async () => { const s = await st(); return s.view === 'single' && s.tabs.find(t => t.id === s.activeId).url.includes(PLAIN); }, 'left the site');
    await sleep(2500); const gone = seen.new + seen.old; await sleep(1500);
    assert.ok(seen.new + seen.old - gone <= 2, 'the run stopped asking');
    // Review 15: a run that cannot start says why. This tab has no domain rule.
    const refused = await cmd('site-run', { limit: 5 });
    assert.deepEqual([refused.ok, refused.error], [false, 'Add and apply a domain rule for this website first.']);
    assert.doesNotMatch(stderr, /observer failed|main process error|unhandled rejection|Whole site:|Add-on scan:|Add-on malware-scan:|Add-on constructor:/i, stderr);

    // 14. Review 18: a run that reaches its request limit stops (both workers) and says so; it is never green. The limit
    //     is set low with a switch that only an app that is not packaged knows.
    //     Review 6: the same for the scans after a page load. With no budget at all the label says "Limited" and the card
    //     says why: a tab whose scan was refused does not read as clean.
    await app.close();
    await launch('--site-budget=30', '--scan-budget=0');
    box = ui.locator('#differences'); row = id => box.locator(`.dm-row[data-part="${id}"]`); over = id => box.locator(`.ov-part[data-part="${id}"]`);
    // The tab comes back on the site without a rule it was left on: back to the site with the rule.
    await wait(async () => (await st()).tabs.find(t => !t.loading && /Northwind Bakery/.test(t.title)), 'the tab is back');
    assert.equal((await cmd('navigate', HOME)).ok, true);
    await wait(async () => (await st()).tabs.find(t => t.mode === 'hostfile' && !t.loading && t.url === HOME && t.route.configured), 'Hostfile page again');
    const chips =await wait(async () => { const c = (await st()).tabs.find(t => t.mode === 'hostfile').chips; return c.length === 2 && c; }, 'labels of the refused scans');
    assert.deepEqual(chips.map(c => [c.id, c.text, c.tone]).sort(), [[PROBE_ID, 'Limited', 'warn'], ['malware-scan', 'Limited', 'warn']]);
    assert.deepEqual(await ui.locator('#route-bar .route-addon').allInnerTexts(), ['Limited', 'Limited']);
    assert.match(await ui.locator('#route-bar .route-addon').first().getAttribute('title'), /^(Malware Scan|Site Probe) could not finish its scan of this page\. Click to see what was found\.$/);
    assert.equal(await ui.locator('#route-bar .route-addon.both').count(), 2, 'orange, not red: nothing was found, and nothing was ruled out');
    // On a site without a domain rule the label opens the card.
    assert.equal((await cmd('new-tab', `https://${PLAIN}/`)).ok, true);
    await wait(async () => (await st()).tabs.find(t => t.url.includes(PLAIN) && !t.loading && t.chips.length === 2), 'labels on a site without a rule');
    await ui.locator('#route-bar .route-addon').first().click();
    const cardText = async needle => { const until = Date.now() + 15000; for (;;) { const page = app.windows().find(w => w.url().includes('card.html')); if (page) { await page.waitForFunction(t => document.body.innerText.includes(t), needle); return (await page.locator('body').innerText()).replace(/\s+/g, ' '); } if (Date.now() > until) throw new Error('card did not open'); await sleep(100); } };
    const card = await cardText('Limited');
    for (const name of ['Malware Scan', 'Site Probe']) assert.ok(card.includes(`${name} Limited · not scanned Dioptra stopped asking this site: too many requests went to it in a short time. The scan did not see everything; it runs again in a few minutes.`), card);
    await cmd('card-close'); await cmd('close-tab', (await st()).activeId);
    await wait(async () => (await st()).tabs.length === 1, 'back on the Hostfile tab');
    await ui.locator('#view-differences').click();
    await pageDone('page comparison again'); await quiet();
    await box.locator('.dscope button[data-scope=site]').click();
    const limited = await siteDone('limit reached', s => s.status === 'error');
    assert.match(limited.error, /^Dioptra stopped after \d+ of 12 pages: this run reached its limit of 30 requests to the site in 10 minutes\. Compare again in a few minutes\.$/);
    assert.ok(limited.compared < 11, `stopped early: ${limited.compared}`);
    await verdictTitle('The run stopped');
    assert.equal(await box.locator('.dverdict').evaluate(n => /\b(worse|better)\b/.test(n.className)), false);
    await sleep(1500); const afterLimit = seen.new + seen.old; await sleep(1500);
    assert.equal(seen.new + seen.old, afterLimit, 'the other worker stopped as well');
    await shot('site-check-8-limit.png');
    assert.doesNotMatch(stderr, /observer failed|main process error|unhandled rejection|Whole site:/i, stderr);
    console.log('PASS Whole site check: sitemap list (index, duplicates, tracking query, other site), progress, Cancel with the focus kept, two pages and four requests at a time, no request to another host, grouping (site-wide, once for the site, on the page you opened, pages with a problem of their own, the hijacked page, the rest), affected pages, a page from the list and the way back, the chooser surviving a run, own list, no sitemap, Cancel while listing, a second run, Live dying and Live gone, nothing compared, home page skipped, leaving the site, a run that cannot start, the request limit');
  } catch (error) { console.error(`app output:\n${stderr.slice(-4000)}`); throw error; } finally {
    await app?.close().catch(() => {});
    for (const s of servers) { s.closeAllConnections(); s.close(); }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.env.SITE_CHECK_WORK) inside().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
else process.exit(outside());
