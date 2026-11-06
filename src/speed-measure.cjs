// Speed measurement: the page loads 3 times per server, both servers at the same moment, cache off, offscreen (only the
// new server when Differences already knows that Live cannot be reached: measure(url, { live: false })). A hidden
// normal view never paints (no first paint, no LCP); an offscreen view does, and its paint events give the filmstrip
// with exact times. The offscreen views live in one hidden host window that main.cjs creates before the main window:
// BrowserWindow.getAllWindows() lists the newest window first and does not list a BaseWindow, so the main window stays
// the first window and its child views stay the tabs (the tests and the release screenshots rely on both).
// Each view: the Hostfile or the Live session, sandboxed, muted, no popups, downloads cancelled (main.cjs asks owns()),
// no permissions (the session handlers allow tabs only), closed after measuring, also on error or timeout. One run at a time.
const { speedReport, luminanceSpread, createFilm, median, MOMENTS } = require('./speed.cjs');
const { observeRequests } = require('./web-requests.cjs');
const { header } = require('./resource-check.cjs');

const WIDTH = 1280, HEIGHT = 720, THUMB = 288, ROUNDS = 3, LOAD_TIMEOUT_MS = 20000, RUN_TIMEOUT_MS = 90000, MAX_REQUESTS = 500, WORLD = 1006;
const LAST = MOMENTS.at(-1);
const PAGE_HEADERS = ['server', 'content-encoding', 'x-litespeed-cache', 'cf-cache-status', 'x-cache', 'x-cache-status', 'x-proxy-cache', 'x-fastcgi-cache', 'x-nginx-cache', 'x-varnish-cache', 'x-sg-cache', 'x-kinsta-cache'];
// Read in an isolated world, so the page cannot see or change it. Paint entries arrive when the frame is presented:
// observe with buffered and wait a moment, reading at load time misses the first paint in most loads (measured).
const MEASURE = `(async () => {
  const t0 = performance.now(); let fcp = null, lcp = null;
  const watch = (type, cb) => { try { const o = new PerformanceObserver(l => l.getEntries().forEach(cb)); o.observe({ type, buffered: true }); return o; } catch (e) { return null; } };
  const o1 = watch('paint', e => { if (e.name === 'first-contentful-paint') fcp = e; });
  const o2 = watch('largest-contentful-paint', e => { lcp = e; });
  while ((!fcp || !lcp) && performance.now() - t0 < 1500) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 200));
  if (o1) o1.disconnect(); if (o2) o2.disconnect();
  const nav = performance.getEntriesByType('navigation')[0] || null, res = performance.getEntriesByType('resource');
  return { ttfb: nav ? Math.round(nav.responseStart) : null, load: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
    fcp: fcp ? Math.round(fcp.startTime) : null, lcp: lcp ? Math.round(lcp.startTime) : null, count: res.length + 1,
    sizes: [[location.href, nav ? nav.transferSize : 0], ...res.slice(0, 400).map(r => [r.name, r.transferSize])] };
})()`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SIDES = ['hostfile', 'live'];

function createSpeedMeter({ WebContentsView, host, sessions, trust, changed = () => {} }) {
  let run = null;
  const watching = new WeakSet(), windows = new Map(); // webContents id -> side record of the current run
  // Sizes of cross origin files without Timing-Allow-Origin are 0 in the page: the request monitoring has them.
  function completed(details) {
    const side = windows.get(details.webContentsId);
    if (!side?.round || side.round.requests.length >= MAX_REQUESTS || !/^https?:/i.test(details.url)) return;
    const length = Number(header(details.responseHeaders, 'content-length')) || 0;
    side.round.requests.push({ url: details.url, length, cached: Boolean(details.fromCache) });
    if (details.resourceType === 'mainFrame' && !(details.statusCode >= 300 && details.statusCode < 400)) side.round.page = Object.fromEntries(PAGE_HEADERS.map(name => [name, header(details.responseHeaders, name)]).filter(([, v]) => v));
  }
  function watch(ses) { if (!watching.has(ses)) { watching.add(ses); observeRequests(ses, 'onCompleted', completed); } }

  function open(side, ses) {
    const view = new WebContentsView({ webPreferences: { offscreen: true, session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    const box = host(); box.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const wc = view.webContents, record = { side, view, box, wc, film: null, t0: 0, round: null };
    windows.set(wc.id, record);
    wc.setAudioMuted(true); wc.setFrameRate(60);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => { if (!/^(https?:|about:blank)/i.test(url)) event.preventDefault(); });
    wc.on('certificate-error', (event, url, _error, certificate, callback) => {
      event.preventDefault();
      let host = ''; try { host = new URL(url).hostname.toLowerCase(); } catch {}
      // The same exceptions as the panes. Answered a tick later: Electron 45 crashes on a synchronous answer for wss://.
      const answer = Boolean(host) && trust(side, host, certificate); setImmediate(() => callback(answer));
    });
    wc.on('paint', (_event, _dirty, image) => {
      const film = record.film;
      if (!film) return;
      const t = record.t0 ? Date.now() - record.t0 : -1;
      film.paint(t, t <= LAST ? { spread: luminanceSpread(image.resize({ width: 64, height: 36 }).toBitmap()), image: image.resize({ width: THUMB }) } : null);
    });
    return record;
  }
  // Cache off for this window only (DevTools "Disable cache"), so the user's cache is left alone. A window that has not
  // loaded anything has no page to talk to yet (the command never answers), so this runs after a first about:blank.
  async function cacheOff(wc) {
    const send = (method, params) => Promise.race([wc.debugger.sendCommand(method, params), sleep(5000).then(() => { throw new Error(`${method} did not answer`); })]);
    try {
      await wc.loadURL('about:blank');
      wc.debugger.attach('1.3');
      // Small buffers: the measurement never reads response bodies through DevTools.
      await send('Network.enable', { maxTotalBufferSize: 65536, maxResourceBufferSize: 16384 });
      await send('Network.setCacheDisabled', { cacheDisabled: true });
      await send('Network.setBypassServiceWorker', { bypass: true });
    } catch (error) { throw new Error(`The cache could not be turned off for the measurement: ${error.message}`); }
  }
  // One load: a blank page first (no frame of the previous load can stay on screen), then the page.
  async function load(record, url, mine) {
    const { wc } = record;
    await wc.loadURL('about:blank'); await sleep(120);
    if (mine.cancelled) throw new Error('cancelled');
    record.film = createFilm(); record.round = { requests: [], page: null }; record.t0 = Date.now();
    const loaded = wc.loadURL(url).then(() => null, error => error);
    const timedOut = sleep(LOAD_TIMEOUT_MS).then(() => new Error(`The page did not finish loading within ${LOAD_TIMEOUT_MS / 1000} seconds.`));
    const error = await Promise.race([loaded, timedOut]);
    if (error && !/ERR_ABORTED/.test(error.message || '')) { wc.stop(); throw error; }
    const perf = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: MEASURE }]);
    await sleep(Math.max(0, LAST + 60 - (Date.now() - record.t0))); // the filmstrip runs to 1.2 s even when the page is faster
    const film = record.film.finish(), round = record.round; record.film = null; record.round = null;
    const sizes = new Map((perf.sizes || []).map(([name, size]) => [name, Number(size) || 0]));
    const transfer = round.requests.length ? round.requests.reduce((sum, r) => sum + (sizes.get(r.url) || r.length), 0) : [...sizes.values()].reduce((a, b) => a + b, 0);
    return { sample: { ttfb: perf.ttfb, fcp: perf.fcp, lcp: perf.lcp, load: perf.load, requests: round.requests.length || perf.count, transfer }, page: round.page, film };
  }
  async function side(record, url, mine) {
    await cacheOff(record.wc);
    // One load that does not count: it opens the connection and starts the page process, which is Dioptra's own start
    // up and not the server (measured on CT102: first byte 982 ms on the first load, about 210 ms on the next ones).
    // A page that does not finish loading once will not the next times either: stop instead of waiting 20 s per load.
    const stuck = error => /did not finish loading/.test(error?.message || '');
    try { await load(record, url, mine); } catch (error) { if (mine.cancelled || stuck(error)) throw error; }
    const out = [];
    for (let i = 0; i < ROUNDS; i++) {
      if (mine.cancelled) throw new Error('cancelled');
      try { out.push(await load(record, url, mine)); } catch (error) { if (mine.cancelled || stuck(error)) throw error; out.push({ sample: null, error: String(error.message || error).slice(0, 200) }); }
      mine.done++; changed();
    }
    return out;
  }
  // The filmstrip of the load closest to the median first paint of that server, so "appears at" and the frames agree.
  function filmOf(loads) {
    const good = loads.filter(l => l.sample && l.film), fcp = median(good.map(l => l.sample.fcp ?? l.sample.load));
    const chosen = good.sort((a, b) => Math.abs((a.sample.fcp ?? a.sample.load) - fcp) - Math.abs((b.sample.fcp ?? b.sample.load) - fcp))[0];
    if (!chosen) return null;
    return { firstContent: chosen.film.firstContent, frames: chosen.film.frames.map(f => ({ m: f.m, blank: f.blank, src: f.frame?.image && !f.frame.image.isEmpty() ? `data:image/jpeg;base64,${f.frame.image.toJPEG(78).toString('base64')}` : '' })) };
  }
  function close(mine) {
    for (const record of mine.records) {
      windows.delete(record.wc.id); record.film = null;
      try { if (record.wc.debugger.isAttached()) record.wc.debugger.detach(); } catch {}
      if (!record.box.isDestroyed()) record.box.contentView.removeChildView(record.view);
      if (!record.wc.isDestroyed()) record.wc.close();
    }
    mine.records = [];
  }
  // live false: Live is known to fail (Differences could not reach it), so only the new server loads; no view for Live.
  async function measure(url, { live: withLive = true } = {}) {
    if (run && run.url === url && run.live === withLive) return run.promise;
    cancel();
    const sides = withLive ? SIDES : ['hostfile'];
    const mine = run = { url, live: withLive, done: 0, total: ROUNDS * sides.length, cancelled: false, records: [] };
    mine.promise = (async () => {
      const ses = sessions();
      for (const s of sides) watch(ses[s]);
      let timer;
      const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => { mine.cancelled = true; reject(new Error('The measurement took longer than 90 seconds and was stopped.')); }, RUN_TIMEOUT_MS); });
      try {
        // one by one, so a view opened before a later open() throws is still closed in finally
        for (const s of sides) mine.records.push(open(s, ses[s]));
        const work = Promise.all(mine.records.map(r => side(r, url, mine)));
        work.catch(() => {}); // after a timeout the loads still end, with an error nobody waits for
        const [hostfile, live = null] = await Promise.race([work, timeout]);
        // Rounds without a live key are the new server on its own (speedReport draws them without a comparison).
        const rounds = hostfile.map((h, i) => (live ? { hostfile: h.sample, live: live[i]?.sample ?? null } : { hostfile: h.sample }));
        const last = loads => [...loads].reverse().find(l => l.page)?.page || {};
        const report = live ? speedReport({ rounds, pages: { hostfile: last(hostfile), live: last(live) }, film: { hostfile: filmOf(hostfile), live: filmOf(live) } })
          : speedReport({ rounds, pages: { hostfile: last(hostfile) }, film: { hostfile: filmOf(hostfile) } });
        if (!report) throw new Error(hostfile.concat(live || []).find(l => l.error)?.error || (live ? 'No load finished on both servers.' : 'No load finished on the new server.'));
        return { ...report, url, measuredAt: new Date().toISOString() };
      } finally { clearTimeout(timer); close(mine); if (run === mine) run = null; }
    })();
    return mine.promise;
  }
  function cancel() { if (!run) return; run.cancelled = true; close(run); run = null; }
  return {
    measure, cancel,
    owns: wc => Boolean(wc && windows.has(wc.id)),
    progress: () => (run ? { url: run.url, done: run.done, total: run.total } : null),
  };
}

module.exports = { createSpeedMeter, MEASURE };
