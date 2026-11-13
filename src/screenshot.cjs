// Screenshots from the camera button: the visible area or the full page, of one pane or of both Compare panes in one
// image with a label bar per pane (role, IP, how it was reached). Full page first scrolls through a page that lazy loads
// images, captures through the DevTools protocol in tiles and the window UI joins everything on a canvas (shot-compose.js).
// Scripts run in an isolated world: the page cannot change what they see or return.
'use strict';
const fs = require('node:fs'), path = require('node:path');

const WORLD = 1007;
// Chromium canvases stop at 32767 px per side; leave room for the label bars. A page may also make itself absurdly wide,
// so width and the total pixels of one image are capped too. Anything beyond is cut and the card says so.
const MAX_SIDE = 32000, HEADER_CSS = 110, MAX_WIDTH_CSS = 8000, PIXEL_BUDGET = 120e6;
// One capture per 8000 device pixels: a single huge capture can come back blank on some GPUs.
const TILE_DEVICE_PX = 8000;
// ponytail: fixed step count, so an endless scroll page stops after about 15 s instead of loading forever.
const MAX_SCROLL_STEPS = 60, STEP_WAIT_MS = 250, IMAGE_WAIT_MS = 4000;
const LAZY = 'img[loading="lazy"],img[data-src],img[data-lazy-src],img[data-srcset],img.lazyload,img.lazy,iframe[loading="lazy"]';

const PROBE = `(() => { const d = document.documentElement, b = document.body;
  return { lazy: document.querySelectorAll(${JSON.stringify(LAZY)}).length, width: innerWidth, height: innerHeight,
    full: Math.max(d.scrollHeight, b ? b.scrollHeight : 0), dpr: devicePixelRatio, x: scrollX, y: scrollY }; })()`;
const scrollTo = (x, y) => `(() => { scrollTo({ left: ${Number(x) || 0}, top: ${Number(y) || 0}, behavior: 'instant' });
  return { y: scrollY, max: Math.max(0, document.documentElement.scrollHeight - innerHeight) }; })()`;
const IMAGES_DONE = `new Promise(done => { const waiting = [...document.images].filter(i => !i.complete);
  if (!waiting.length) return done(0); let left = waiting.length; const one = () => { if (--left <= 0) done(waiting.length); };
  waiting.forEach(i => { i.addEventListener('load', one, { once: true }); i.addEventListener('error', one, { once: true }); });
  setTimeout(() => done(waiting.length), ${IMAGE_WAIT_MS}); })`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class Cancelled extends Error { constructor() { super('Cancelled.'); this.cancelled = true; } }
// A page that hangs (an endless loop in its own script, a stuck renderer) must not leave the card waiting forever, and
// Cancel must work while a call is still pending: every call to the page races a timeout and the cancel flag.
const PAGE_TIMEOUT_MS = 10000, CAPTURE_TIMEOUT_MS = 60000, always = () => true;
function guard(promise, alive, ms, message) {
  let poll;
  const stop = new Promise((_, reject) => { const end = Date.now() + ms; poll = setInterval(() => { if (!alive()) reject(new Cancelled()); else if (Date.now() > end) reject(new Error(message)); }, 150); });
  return Promise.race([promise, stop]).finally(() => clearInterval(poll));
}
const inPage = (wc, code, alive = always) => guard(wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]), alive, PAGE_TIMEOUT_MS, 'The page did not answer. Reload it and try again.');

// Where each capture of a full page starts and how tall it is, in CSS pixels; cut when the page is too long or too wide for
// one image. panes: how many pages share the image (Compare), so together they stay within the pixel budget.
function tilePlan(cssHeight, dpr, cssWidth = 1440, panes = 1) {
  const scale = Math.max(1, Number(dpr) || 1), height = Math.max(1, Math.ceil(Number(cssHeight) || 0)), wanted = Math.max(1, Math.ceil(Number(cssWidth) || 0));
  const width = Math.min(wanted, MAX_WIDTH_CSS), budget = Math.floor(PIXEL_BUDGET / (scale * scale * width * Math.max(1, panes)));
  const limit = Math.max(1, Math.min(Math.floor(MAX_SIDE / scale) - HEADER_CSS, budget)), total = Math.min(height, limit), step = Math.floor(TILE_DEVICE_PX / scale), tiles = [];
  for (let y = 0; y < total; y += step) tiles.push({ y, h: Math.min(step, total - y) });
  return { width, height: total, cut: height > total || wanted > width, tiles };
}

// "Dioptra example.com compare 2026-11-08 at 14.32.jpg", like the screenshots of macOS. Only safe characters from the host.
// Sharp and Small are JPEG, Original (and anything unknown) PNG: the same choice as composeShot in shot-compose.js.
const extension = quality => (quality === 'sharp' || quality === 'small' ? 'jpg' : 'png');
function fileName(host, what, date = new Date(), quality = 'original') {
  const safe = String(host || '').toLowerCase().replace(/[^a-z0-9.-]/g, '').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80) || 'page';
  const two = n => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`, time = `${two(date.getHours())}.${two(date.getMinutes())}`;
  return `Dioptra ${safe} ${what} ${day} at ${time}.${extension(quality)}`;
}
// The first free name in the folder: "name.jpg", "name (2).jpg", ... with the extension the name came with.
function freeName(name, exists) {
  if (!exists(name)) return name;
  const [, base, ext] = name.match(/^(.*?)(\.(?:png|jpg))?$/s);
  for (let n = 2; n < 1000; n++) { const next = `${base} (${n})${ext || ''}`; if (!exists(next)) return next; }
  throw new Error('No free file name in Downloads.');
}
function saveShot(dir, name, bytes) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, freeName(name, n => fs.existsSync(path.join(dir, n))));
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return file;
}
// Electron 45 has only the async clipboard: write() with ClipboardItem (writeImage is gone).
async function copyPng(clipboard, ClipboardItem, png) {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

const probe = wc => inPage(wc, PROBE);

// Scrolls from top to bottom so lazy images load, waits for them and puts the page back where it was.
// onStep(done, total) reports progress; alive() false stops at the next step (the page is still put back).
async function scrollThrough(wc, start, { alive, onStep }) {
  const step = Math.max(200, Math.round(start.height * 0.8)), total = Math.min(MAX_SCROLL_STEPS, Math.ceil(Math.max(0, start.full - start.height) / step) + 1);
  try {
    for (let i = 0, y = 0; i < MAX_SCROLL_STEPS; i++, y += step) {
      if (!alive()) throw new Cancelled();
      const at = await inPage(wc, scrollTo(start.x, y), alive);
      onStep(Math.min(i + 1, total), total);
      await sleep(STEP_WAIT_MS);
      if (y >= at.max) break;
    }
    await inPage(wc, IMAGES_DONE, alive);
  } finally { if (!wc.isDestroyed()) await inPage(wc, scrollTo(start.x, start.y)).catch(() => {}); }
}

async function captureVisible(wc, start, alive) {
  const image = await guard(wc.capturePage(), alive, CAPTURE_TIMEOUT_MS, 'The page did not give a picture in time.');
  if (image.isEmpty()) throw new Error('The page gave an empty picture.');
  return { width: start.width, height: start.height, cut: false, tiles: [{ y: 0, h: start.height, data: image.toPNG().toString('base64') }] };
}
// Full page through the DevTools protocol. Reuses a debugger that is already attached (Claude's browser tools);
// Developer Tools of the tab can hold it, then the card asks to close them.
async function captureFull(wc, start, alive, panes) {
  const own = !wc.debugger.isAttached(), send = (method, params) => guard(wc.debugger.sendCommand(method, params), alive, CAPTURE_TIMEOUT_MS, 'The page did not give a picture in time.');
  if (own) { try { wc.debugger.attach('1.3'); } catch { throw new Error('Full page needs the page debugger. Close Developer Tools for this tab and try again.'); } }
  try {
    await inPage(wc, scrollTo(0, 0), alive);
    const { cssContentSize } = await send('Page.getLayoutMetrics');
    // The capture comes back at the scale of the screen; devicePixelRatio also holds the zoom of the tab.
    const plan = tilePlan(cssContentSize.height, start.dpr / (wc.getZoomFactor() || 1), cssContentSize.width, panes), tiles = [];
    for (const t of plan.tiles) {
      if (!alive()) throw new Cancelled();
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: t.y, width: plan.width, height: t.h, scale: 1 } });
      tiles.push({ ...t, data });
    }
    return { width: plan.width, height: plan.height, cut: plan.cut, tiles };
  } finally {
    try { if (own && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* the tab is gone */ }
    if (!wc.isDestroyed()) await inPage(wc, scrollTo(start.x, start.y)).catch(() => {});
  }
}

// panes: [{ wc, name, live, ip, via, ptr }]. Returns the pictures per pane, ready for composeShot.
async function capturePanes(panes, { full, alive, progress }) {
  const starts = await Promise.all(panes.map(p => inPage(p.wc, PROBE, alive)));
  const lazy = full && starts.some(s => s.lazy > 0), scrolled = panes.map(() => [0, 0]);
  const steps = () => [
    ...(lazy ? panes.map((p, i) => [scrolled[i][1] && scrolled[i][0] >= scrolled[i][1] ? 'ok' : 'now', `Scroll ${p.name} to the bottom${scrolled[i][1] ? ` (${scrolled[i][0]} of ${scrolled[i][1]})` : ''}`]) : []),
    [lazy ? 'todo' : 'now', panes.length > 1 ? 'Capture both pages and join them' : 'Capture the page'],
  ];
  if (lazy) {
    progress({ title: 'Loading lazy images…', pct: 5, steps: steps() });
    // allSettled: when one pane fails, the other still stops and goes back before the error is shown.
    const ends = await Promise.allSettled(panes.map((p, i) => scrollThrough(p.wc, starts[i], { alive, onStep: (done, total) => {
      scrolled[i] = [done, total];
      const pct = Math.round(80 * scrolled.reduce((s, [d, t]) => s + (t ? d / t : 0), 0) / panes.length);
      progress({ title: 'Loading lazy images…', pct, steps: steps() });
    } })));
    const failed = ends.find(e => e.status === 'rejected'); if (failed) throw failed.reason;
  }
  if (!alive()) throw new Cancelled();
  progress({ title: 'Capturing…', pct: lazy ? 85 : 30, steps: steps().map(([s, t], i, all) => [i === all.length - 1 ? 'now' : 'ok', t]) });
  const shots = [];
  for (const [i, p] of panes.entries()) shots.push(full ? await captureFull(p.wc, starts[i], alive, panes.length) : await captureVisible(p.wc, starts[i], alive));
  return panes.map((p, i) => ({ live: p.live, ip: p.ip, via: p.via, ptr: p.ptr, ...shots[i] }));
}

module.exports = { WORLD, MAX_SIDE, MAX_WIDTH_CSS, PIXEL_BUDGET, PROBE, tilePlan, fileName, freeName, saveShot, copyPng, probe, capturePanes, Cancelled };
