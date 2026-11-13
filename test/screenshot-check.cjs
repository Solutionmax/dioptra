// Camera button: the real app in a private test network (new server 203.0.113.10, old server 198.51.100.24, own DNS and
// a test CA). A long page with a sticky header, three native lazy images and three behind a JS lazy loader.
// Single: Full page from a scrolled page saves one JPEG (Sharp, the default) in Downloads with every lazy image loaded, the
// page goes back to where it was, Library lists the file, Copy puts the same picture as PNG on the clipboard. Original saves
// a PNG of the same size that is larger, Small a JPEG of half the width and height (and copies that half size).
// Compare: one picture with both panes and a blue (new server) and green (Live) label bar, Live alone, Cancel, and
// Differences says to switch.
// Needs Linux as root (network and mount namespace); elsewhere it says SKIP. SCREENSHOT_CHECK_SHOTS=<dir> saves window pictures,
// SCREENSHOT_CHECK_SCALE=2 runs it as on a Retina screen (every picture twice as many pixels).
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), https = require('node:https'), dgram = require('node:dgram'), zlib = require('node:zlib');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const DOMAIN = 'northwind-bakery.test', NEW = '203.0.113.10', OLD = '198.51.100.24', APP = path.join(__dirname, '..');
const SCALE = Number(process.env.SCREENSHOT_CHECK_SCALE) === 2 ? 2 : 1;
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
const PUBLIC_DNS = { [`${DOMAIN} A`]: [OLD], [`www.${DOMAIN} CNAME`]: [DOMAIN], '10.113.0.203.in-addr.arpa PTR': ['server12.newhost.example'], '24.100.51.198.in-addr.arpa PTR': ['web03.oldhost.example'] };
const NEW_DNS = { [`${DOMAIN} A`]: [NEW], [`www.${DOMAIN} CNAME`]: [DOMAIN] };

// Solid color PNGs, so a pixel of the result says which image is there (or the placeholder when it did not load).
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function solidPng(w, h, [r, g, b]) {
  const chunk = (type, data) => { const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const IMAGES = { a: [200, 40, 40], b: [40, 160, 60], c: [40, 80, 200], d: [220, 160, 20], e: [140, 40, 170], f: [20, 170, 170] };
const PLACEHOLDER = [234, 223, 210];
// Smooth colour with a little grain, like a photo: flat test colours alone are smaller as PNG than as JPEG.
function photoPng(w, h) {
  let seed = 7; const grain = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 * 24 - 12;
  const chunk = (type, data) => { const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) row.set([140 + 90 * Math.sin(x / 23) * Math.cos(y / 31) + grain(), 120 + 80 * Math.cos((x + y) / 41) + grain(), 110 + 70 * Math.sin(y / 19) + grain()].map(v => Math.max(0, Math.min(255, Math.round(v)))), 1 + x * 3); rows.push(row); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Northwind Bakery</title>
<style>body{margin:0;font-family:sans-serif;background:#faf5ef}header{position:sticky;top:0;height:60px;background:#3a2413;color:#fff;display:flex;align-items:center;padding:0 24px}
.spacer{height:1600px;padding:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:24px}img{display:block;width:100%;height:auto;aspect-ratio:3/2;background:rgb(${PLACEHOLDER})}footer{height:300px}</style></head>
<body><header>Northwind Bakery</header><div class="spacer">Fresh every morning<img id="photo" src="/img/photo.png" alt=""></div><div class="grid">
${Object.keys(IMAGES).map((k, i) => i % 2 ? `<img id="${k}" class="lazyload" data-src="/img/${k}.png" alt="">` : `<img id="${k}" loading="lazy" src="/img/${k}.png" alt="">`).join('')}</div><footer>Mill Street 12</footer>
<script src="/lazy.js"></script></body></html>`;
const LAZY_JS = "const io = new IntersectionObserver(list => { for (const e of list) if (e.isIntersecting) { e.target.src = e.target.dataset.src; io.unobserve(e.target); } }); document.querySelectorAll('img.lazyload').forEach(i => io.observe(i));";
function serve(tls) {
  const pngs = { ...Object.fromEntries(Object.entries(IMAGES).map(([k, c]) => [k, solidPng(120, 80, c)])), photo: photoPng(480, 320) };
  return https.createServer(tls, (req, res) => {
    const p = req.url.split('?')[0], img = p.match(/^\/img\/([a-f]|photo)\.png$/);
    if (img) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(pngs[img[1]]); }
    if (p === '/lazy.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(LAZY_JS); }
    if (p !== '/') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE);
  });
}

function outside() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) { console.log('SKIP screenshot check: needs Linux as root for its private test network'); return 0; }
  for (const tool of ['openssl', 'certutil', 'unshare', 'ip', 'xvfb-run']) if (spawnSync('sh', ['-c', `command -v ${tool}`]).status) { console.error(`screenshot check needs ${tool}`); return 1; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-screenshot-check-'));
  try {
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: 'ignore' });
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/O=Example Trust Services/CN=Example Trust CA R3']);
    run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'site.key', '-out', 'site.csr', '-subj', `/CN=${DOMAIN}`]);
    fs.writeFileSync(path.join(work, 'ext.cnf'), `subjectAltName=DNS:${DOMAIN},DNS:www.${DOMAIN}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
    run('openssl', ['x509', '-req', '-in', 'site.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'site.crt', '-days', '2', '-extfile', 'ext.cnf']);
    fs.mkdirSync(path.join(work, 'home/.pki/nssdb'), { recursive: true });
    run('certutil', ['-d', 'sql:home/.pki/nssdb', '-N', '--empty-password']);
    run('certutil', ['-d', 'sql:home/.pki/nssdb', '-A', '-t', 'C,,', '-n', 'screenshot-check-ca', '-i', 'ca.crt']);
    fs.writeFileSync(path.join(work, 'resolv.conf'), 'nameserver 127.0.0.1\n');
    const net = `ip link set lo up && ip addr add ${NEW}/32 dev lo && ip addr add ${OLD}/32 dev lo && mount --bind ${work}/resolv.conf /etc/resolv.conf`;
    const result = spawnSync('unshare', ['-n', '-m', 'sh', '-c', `${net} && exec xvfb-run -a -s '-screen 0 ${1440 * SCALE}x${960 * SCALE}x24' node ${JSON.stringify(__filename)}`], { stdio: 'inherit', env: { ...process.env, SCREENSHOT_CHECK_WORK: work, HOME: path.join(work, 'home') } });
    return result.status ?? 1;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

async function inside() {
  const { _electron: electron } = require('playwright');
  const work = process.env.SCREENSHOT_CHECK_WORK, shots = process.env.SCREENSHOT_CHECK_SHOTS, sleep = ms => new Promise(r => setTimeout(r, ms));
  const tls = { key: fs.readFileSync(path.join(work, 'site.key')), cert: fs.readFileSync(path.join(work, 'site.crt')) };
  await dnsOn('127.0.0.1', PUBLIC_DNS); await dnsOn(NEW, NEW_DNS);
  await Promise.all([NEW, OLD].map(ip => new Promise(r => serve(tls).listen(443, ip, r))));
  const profile = fs.mkdtempSync(path.join(work, 'profile-')), home = `https://${DOMAIN}/`; let downloads = '';
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ autoUpdates: false, autoUpdatesChosen: true, onboardingCompleted: true, tabs: [home], rules: [{ domain: DOMAIN, ip: NEW, enabled: true, www: true }] }));
  let app, stderr = '';
  try {
    app = await electron.launch({ executablePath: process.env.DIOPTRA_TEST_EXECUTABLE || undefined, args: ['--no-sandbox', ...(SCALE > 1 ? [`--force-device-scale-factor=${SCALE}`] : []), '-r', path.join(__dirname, 'root-harness.cjs'), ...(process.env.DIOPTRA_TEST_EXECUTABLE ? [] : ['.']), `--profile-dir=${profile}`], cwd: APP, env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(work, 'ca.crt') } });
    app.process().stderr.on('data', chunk => { stderr += chunk; });
    const ui = await app.firstWindow(); ui.setDefaultTimeout(20000); await ui.waitForFunction(() => window.browser);
    downloads = await app.evaluate(({ app }) => app.getPath('downloads'));
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1440, height: 960 }));
    const cmd = (action, data) => ui.evaluate(([a, d]) => window.browser.command(a, d), [action, data]);
    const st = async () => (await cmd('state')).state;
    async function wait(check, label, ms = 20000) { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await check(); if (last) return last; await sleep(100); } throw new Error(`${label}: ${JSON.stringify(last)}`); }
    const shot = async name => { if (!shots) return; await sleep(700); fs.mkdirSync(shots, { recursive: true }); execFileSync('import', ['-window', 'root', '-crop', `${1440 * SCALE}x${960 * SCALE}+0+0`, '+repage', path.join(shots, name)]); };
    // The page views: the Hostfile tab and the Live pane (its own session).
    const pages = () => app.evaluate(({ webContents, session }, host) => { const live = session.fromPartition('live-comparison');
      return webContents.getAllWebContents().filter(w => w.getURL().startsWith(host)).map(w => ({ id: w.id, live: w.session === live })); }, home);
    const inPage = (id, code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [id, code]);
    // The card is its own view; its actions are links, clicked as a user would.
    const cardId = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().endsWith('card.html'))?.id || 0);
    const cardText = async () => { const id = await cardId(); return id ? app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.body.innerText'), id) : ''; };
    const cardWait = (re, label, ms) => wait(async () => { const t = await cardText(); return re.test(t) && t; }, label, ms);
    const cardClick = async action => { const id = await cardId(); assert.ok(id, 'card is open'); const found = await app.evaluate(({ webContents }, [id, a]) => webContents.fromId(id).executeJavaScript(`(() => { const l = document.querySelector('a[href="https://card.invalid/shot-${a}/0"]'); if (l) l.click(); return Boolean(l); })()`), [id, action]); assert.ok(found, `card link ${action}`); };
    const openCard = async () => { await ui.locator('#screenshot').click(); return cardWait(/Screenshot/, 'card open'); };
    const saved = () => (fs.existsSync(downloads) ? fs.readdirSync(downloads) : []).filter(n => /\.(png|jpg)$/.test(n)).sort();
    const magic = file => fs.readFileSync(file).subarray(0, 4).toString('hex');
    const JPEG = /^ffd8ff/, PNG = /^89504e47$/;
    const clipSize = () => app.evaluate(async ({ clipboard, nativeImage }) => { const items = await clipboard.read(), item = items.find(i => i.types.includes('image/png')); if (!item) return null; const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer()); return { bytes: png.length, png: png.subarray(0, 4).toString('hex'), ...nativeImage.createFromBuffer(png).getSize() }; });
    // Pixels of a saved PNG through nativeImage (BGRA bitmap).
    const pixels = (file, points) => app.evaluate(({ nativeImage }, [file, points, scale]) => {
      const image = nativeImage.createFromPath(file), { width, height } = image.getSize(), bmp = image.toBitmap();
      return { width, height, at: points.map(([x, y]) => { const i = (Math.round(y * scale) * width + Math.round(x * scale)) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; }) };
    }, [file, points, SCALE]);
    const near = (got, want, label) => assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 14), `${label}: got rgb(${got}) want rgb(${want})`);
    // The bar is 3 px: JPEG (Sharp, the default) softens its colour at 1x. It must still be clearly the blue of the new server
    // or the green of Live; the Original PNG is checked to the exact colour.
    const BLUE = [46, 144, 250], GREEN = [18, 183, 106], dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
    const bar = (got, want, label) => assert.ok(Math.max(...got) - Math.min(...got) > 60 && dist(got, want) < dist(got, want === BLUE ? GREEN : BLUE), `${label}: got rgb(${got}) want rgb(${want})`);
    // Where every image sits in the document, and the content width, from the page itself.
    const layout = id => inPage(id, `({ width: document.documentElement.clientWidth, height: document.documentElement.scrollHeight, images: Object.fromEntries([...document.images].map(i => { const r = i.getBoundingClientRect(); return [i.id, { x: r.left + r.width / 2, y: r.top + scrollY + r.height / 2 }]; })) })`);
    const PAD = 12, GAP = 12, TOP = 46, BAR = 44;

    await wait(async () => (await st()).tabs.find(t => t.mode === 'hostfile' && !t.loading && t.title === 'Northwind Bakery'), 'Hostfile page');
    await wait(async () => /203\.0\.113\.10/.test(await ui.locator('#route-bar').innerText()), 'route bar IP');
    const [hostPage] = await pages();
    assert.equal(await ui.locator('#screenshot').getAttribute('aria-label'), 'Screenshot');
    assert.equal(await ui.locator('#screenshot').evaluate(b => b.nextElementSibling.id), 'claude', 'the camera sits right before Claude');
    const before = await inPage(hostPage.id, `[...document.images].filter(i => !i.complete || !i.naturalWidth).length`);
    assert.ok(before >= 3, `lazy images wait for a scroll (${before} not loaded)`);
    await inPage(hostPage.id, 'scrollTo(0, 420), scrollY');

    // 1. Single, visible area chosen by default; Full page shows the lazy note.
    let text = await openCard();
    assert.match(text, /Visible area\nWhat you see now, [\d,]+ × [\d,]+/); assert.match(text, /Full page\nTop to bottom, [\d,]+ × [\d,]+ px/);
    assert.doesNotMatch(text, /^PANES$/m); assert.doesNotMatch(text, /only when you scroll/);
    assert.match(text, /^QUALITY$/m); assert.match(text, /Original\s+Sharp\s+Small/); assert.match(text, /JPEG 90 %, Retina\. Looks the same as the original, about 5× smaller\./);
    assert.match(text, /as JPEG \(Sharp, Small\) or PNG \(Original\)/);
    assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('a[href="https://card.invalid/shot-q-sharp/0"]').getAttribute('aria-checked')`), await cardId()), 'true', 'Sharp is the default');
    await cardClick('full');
    text = await cardWait(/loads 6 images only when you scroll/, 'lazy note');
    assert.match(text, /scrolls the page to the bottom first/);
    await shot('screenshot-1-single.png');

    // 2. Download: one JPEG (Sharp), every lazy image in it, page back at 420, listed in Library.
    await cardClick('download');
    await cardWait(/Saving|Loading lazy images|Capturing/, 'progress', 5000).catch(() => {});
    text = await cardWait(/Saved to Downloads/, 'saved', 40000);
    let files = saved(); assert.equal(files.length, 1);
    assert.match(files[0], /^Dioptra northwind-bakery\.test new server \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.jpg$/);
    assert.match(magic(path.join(downloads, files[0])), JPEG, 'Sharp is a JPEG');
    assert.match(text, /\n[\d.]+ (KB|MB) · Sharp, [\d,]+ × [\d,]+ px/);
    assert.match(text, new RegExp(files[0].replace(/[.()]/g, '\\$&')));
    assert.equal(await inPage(hostPage.id, 'scrollY'), 420, 'the page is back where it was');
    assert.equal(await inPage(hostPage.id, `[...document.images].filter(i => !i.complete || !i.naturalWidth).length`), 0);
    let lay = await layout(hostPage.id), file = path.join(downloads, files[0]);
    let px = await pixels(file, [[PAD + 5, TOP + 1], ...Object.keys(IMAGES).map(k => [PAD + lay.images[k].x, TOP + BAR + lay.images[k].y]), [PAD + lay.width - 10, TOP + BAR + 30]]);
    assert.equal(px.width, SCALE * (PAD * 2 + lay.width), 'one pane wide'); assert.equal(px.height, SCALE * (TOP + BAR + lay.height + PAD), 'the whole page tall');
    bar(px.at[0], BLUE, 'blue bar of the new server');
    Object.keys(IMAGES).forEach((k, i) => near(px.at[i + 1], IMAGES[k], `image ${k}`));
    near(px.at.at(-1), [58, 36, 19], 'the sticky header is at the top of the page');
    const library = (await st()).library?.downloads || [];
    assert.ok(library.some(d => d.name === files[0] && d.state === 'completed' && d.path === file), 'listed in Library, Downloads');
    await shot('screenshot-2-saved.png');

    // 3. Copy after Download uses the same picture: no second capture. The clipboard gets it as PNG, at the same size.
    await cardClick('copy');
    await cardWait(/Copied to the clipboard/, 'copied');
    let clip = await clipSize();
    assert.ok(clip?.bytes > 1000, `PNG on the clipboard (${JSON.stringify(clip)})`); assert.match(clip.png, PNG);
    assert.deepEqual([clip.width, clip.height], [px.width, px.height], 'the clipboard has the picture at the size of the file');
    assert.equal(saved().length, 1);
    await shot('screenshot-3-copied.png');

    // 3b. The choice is kept. Original: a PNG of the same size, larger than Sharp. Small: a JPEG of half the width and height,
    // and Copy then puts that half size on the clipboard.
    const sharp = { file, bytes: fs.statSync(file).size, width: px.width, height: px.height };
    await cardClick('again'); text = await cardWait(/^QUALITY$/m, 'choose again');
    assert.match(text, /JPEG 90 %, Retina/, 'Sharp is still chosen');
    await cardClick('q-original'); text = await cardWait(/PNG, Retina\. Every pixel, the largest file\./, 'Original chosen');
    await cardClick('download'); text = await cardWait(/Saved to Downloads/, 'original saved', 40000);
    assert.match(text, /· Original, /);
    const originalName = saved().find(n => n.endsWith('.png')); assert.ok(originalName, saved().join(', '));
    const original = path.join(downloads, originalName), originalPx = await pixels(original, [[PAD + 5, TOP + 1]]);
    near(originalPx.at[0], BLUE, 'blue bar of the new server in the Original PNG');
    assert.match(magic(original), PNG, 'Original is a PNG');
    assert.deepEqual([originalPx.width, originalPx.height], [sharp.width, sharp.height], 'Original and Sharp have the same size');
    assert.ok(sharp.bytes < fs.statSync(original).size, `Sharp (${sharp.bytes} bytes) is smaller than Original (${fs.statSync(original).size} bytes)`);
    await cardClick('again'); await cardWait(/^QUALITY$/m, 'choose again');
    await cardClick('q-small'); await cardWait(/JPEG 80 %, half the width\. For email and tickets\./, 'Small chosen');
    await cardClick('download'); text = await cardWait(/Saved to Downloads/, 'small saved', 40000);
    assert.match(text, /· Small, /);
    const smallName = saved().find(n => n.endsWith('.jpg') && path.join(downloads, n) !== sharp.file); assert.ok(smallName, saved().join(', '));
    const small = path.join(downloads, smallName), smallPx = await pixels(small, []);
    assert.match(magic(small), JPEG, 'Small is a JPEG');
    assert.deepEqual([smallPx.width, smallPx.height], [Math.ceil(sharp.width / 2), Math.ceil(sharp.height / 2)], 'Small is half the width and height');
    assert.ok(fs.statSync(small).size < sharp.bytes, 'Small is smaller than Sharp');
    await cardClick('copy'); await cardWait(/Copied to the clipboard/, 'small copied');
    clip = await clipSize(); assert.match(clip.png, PNG);
    assert.deepEqual([clip.width, clip.height], [smallPx.width, smallPx.height], 'Copy of Small is the half size picture');
    await cardClick('again'); await cardWait(/^QUALITY$/m, 'choose again'); await cardClick('q-sharp');
    await ui.keyboard.press('Escape'); await cmd('card-close');

    // 4. Compare, both panes in one image (Full page is remembered).
    assert.equal((await cmd('compare')).ok, true);
    await wait(async () => (await ui.locator('#pane-bars .route-bar').count()) === 2 && /198\.51\.100\.24/.test(await ui.locator('#pane-bars').innerText()), 'Compare panes with IPs', 30000);
    const livePage = await wait(async () => (await pages()).find(p => p.live), 'Live page');
    await wait(async () => (await inPage(livePage.id, 'document.readyState')) === 'complete', 'Live loaded');
    text = await openCard();
    assert.match(text, /^PANES$/m); assert.match(text, /NEW SERVER\n203\.0\.113\.10\nvia Hostfile/); assert.match(text, /LIVE\n198\.51\.100\.24\npublic DNS/);
    assert.match(text, /Full page\nTop to bottom, 2 panes, up to [\d,]+ px tall/); assert.match(text, /scrolls both pages to the bottom first/);
    await shot('screenshot-4-compare.png');
    await cardClick('download');
    text = await cardWait(/Saved to Downloads/, 'compare saved', 40000);
    assert.match(text, /New server and Live in one image/);
    files = saved(); const compareFile = files.find(n => / compare /.test(n)); assert.ok(compareFile, files.join(', '));
    assert.match(compareFile, /\.jpg$/);
    const hostLay = await layout(hostPage.id), liveLay = await layout(livePage.id), liveX = PAD + hostLay.width + GAP;
    px = await pixels(path.join(downloads, compareFile), [[PAD + 5, TOP + 1], [liveX + 5, TOP + 1], ...Object.keys(IMAGES).flatMap(k => [[PAD + hostLay.images[k].x, TOP + BAR + hostLay.images[k].y], [liveX + liveLay.images[k].x, TOP + BAR + liveLay.images[k].y]])]);
    assert.equal(px.width, SCALE * (PAD * 2 + hostLay.width + GAP + liveLay.width), 'two panes side by side');
    assert.equal(px.height, SCALE * (TOP + BAR + Math.max(hostLay.height, liveLay.height) + PAD));
    bar(px.at[0], BLUE, 'blue bar left'); bar(px.at[1], GREEN, 'green bar right');
    Object.keys(IMAGES).forEach((k, i) => { near(px.at[2 + i * 2], IMAGES[k], `new server image ${k}`); near(px.at[3 + i * 2], IMAGES[k], `Live image ${k}`); });
    await shot('screenshot-5-compare-saved.png');

    // 5. Live alone, visible area.
    await cardClick('again'); await cardWait(/Both, one image/, 'back to choose');
    await cardClick('live'); await cardClick('visible');
    text = await cardWait(/What you see now, [\d,]+ × [\d,]+/, 'live only');
    assert.doesNotMatch(text, /NEW SERVER/);
    await cardClick('download'); await cardWait(/Saved to Downloads/, 'live saved', 20000);
    const liveFile = saved().find(n => / live /.test(n)); assert.ok(liveFile, saved().join(', '));
    const liveSize = await inPage(livePage.id, '({ w: innerWidth, h: innerHeight })');
    px = await pixels(path.join(downloads, liveFile), [[PAD + 5, TOP + 1]]);
    assert.deepEqual([px.width, px.height], [SCALE * (PAD * 2 + liveSize.w), SCALE * (TOP + BAR + liveSize.h + PAD)], 'the visible area of the Live pane');
    bar(px.at[0], GREEN, 'green bar for Live alone');

    // 6. Cancel during the scroll: no file, the card goes back to the choice, the page back where it was.
    await cardClick('again'); await cardWait(/Both, one image|New server/, 'choose again');
    await cardClick('both'); await cardClick('full');
    await inPage(hostPage.id, 'scrollTo(0, 300)');
    const count = saved().length;
    await cardClick('download');
    await cardWait(/Scroll New server to the bottom/, 'scrolling', 10000);
    await cardClick('cancel');
    await cardWait(/Visible area/, 'back to choose after Cancel', 10000);
    await sleep(800);
    assert.equal(saved().length, count, 'Cancel saves nothing');
    assert.equal(await inPage(hostPage.id, 'scrollY'), 300, 'Cancel puts the page back');

    // 7. Differences shows a hint instead of the options.
    await cmd('card-close'); await ui.locator('#view-differences').click(); await sleep(500);
    text = await openCard();
    assert.match(text, /Switch to Single or Compare to take a screenshot\./);
    await cmd('card-close');

    assert.doesNotMatch(stderr, /Screenshot( card)?:/, 'no screenshot errors in the log');
    console.log(`PASS screenshot check${SCALE > 1 ? ` at ${SCALE}x` : ''}: single full page with 6 lazy images, Library, clipboard, Sharp ${(sharp.bytes / 1024).toFixed(0)} KB vs Original ${(fs.statSync(original).size / 1024).toFixed(0)} KB, Small, compare in one image, Live alone, Cancel, Differences (${saved().length} files)`);
  } catch (error) {
    if (stderr) console.error(stderr.split('\n').filter(l => /Screenshot|Error/.test(l)).slice(-20).join('\n'));
    throw error;
  } finally {
    await app?.evaluate(({ app }) => app.quit()).catch(() => {});
    await sleep(800);
  }
}

if (process.env.SCREENSHOT_CHECK_WORK) inside().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
else process.exit(outside());
