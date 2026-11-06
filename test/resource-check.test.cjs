const { test } = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/resource-check.cjs');
const { summaryText } = require('../src/differences.cjs');

// Event shapes as Electron 45.2.2 hands them over in the mockup test network (measured 5 Nov 2026).
const PAGE = 'https://northwind-bakery.test/';
const completed = (path, type, status, headers = {}) => ({ url: new URL(path, PAGE).href, resourceType: type, statusCode: status, responseHeaders: headers });
const failed = (path, type, error) => ({ url: new URL(path, PAGE).href, resourceType: type, error });
const CORS = "Access to font at 'https://static.northwind-bakery.test/fonts/brand.woff2' from origin 'https://northwind-bakery.test' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.";
const MIXED = "Mixed Content: The page at 'https://northwind-bakery.test/' was loaded over HTTPS, but requested an insecure script 'http://northwind-bakery.test/wp-content/plugins/cookie-notice/js/front.js'. This request has been blocked; the content must be served over HTTPS.";
const JQUERY = { level: 'error', message: 'Uncaught ReferenceError: jQuery is not defined', sourceId: 'https://northwind-bakery.test/wp-content/plugins/woocommerce/assets/js/frontend.js', lineNumber: 1 };

function feed(record, { completedList = [], errors = [], console: messages = [] }) {
  for (const d of completedList) { const o = r.responseOutcome(d); if (o?.failed) r.recordFailure(record, o); else if (o) r.recordLoaded(record, o); }
  for (const d of errors) { const o = r.errorOutcome(d); if (o) r.recordFailure(record, o); }
  for (const m of messages) { const o = r.consoleOutcome(m); if (o?.file) r.recordFailure(record, o.file); else if (o?.error) r.recordError(record, o.error); }
  return record;
}
function northwind() {
  const hostfile = feed(r.createRecord(), {
    completedList: [
      completed('/wp-content/themes/hearth/style.css', 'stylesheet', 404, { 'Content-Type': ['text/html'] }),
      completed('/wp-content/plugins/elementor/assets/css/frontend.min.css', 'stylesheet', 200, { 'Content-Type': ['text/html'] }),
      completed('/wp-includes/js/jquery/jquery.min.js', 'script', 403, { 'Content-Type': ['text/html'], Server: ['imunify360-webshield/1.21'] }),
      completed('/wp-content/plugins/woocommerce/assets/js/frontend.js', 'script', 200, { 'Content-Type': ['text/javascript'] }),
      completed('/wp-admin/admin-ajax.php?action=get_refreshed_fragments', 'xhr', 500, { 'Content-Type': ['text/html'] }),
      completed('/', 'mainFrame', 200, { Server: ['nginx/1.26.2'] }),
    ],
    errors: [failed('https://static.northwind-bakery.test/fonts/brand.woff2', 'font', 'net::ERR_CACHE_MISS'), failed('https://static.northwind-bakery.test/fonts/brand.woff2', 'font', 'net::ERR_FAILED')],
    console: [JQUERY, { level: 'error', message: MIXED, sourceId: PAGE }, { level: 'error', message: CORS, sourceId: PAGE }, { level: 'info', message: 'Slow network is detected.' }, { level: 'warning', message: 'Electron Security Warning (Insecure Resources)' }],
  });
  hostfile.pageServer = 'nginx/1.26.2';
  r.recordOld(hostfile, { key: 'https://media.northwind-bakery.test/a/sourdough.jpg', url: 'https://media.northwind-bakery.test/a/sourdough.jpg', type: 'image', host: 'media.northwind-bakery.test', ip: '198.51.100.24', ptr: 'web03.oldhost.example' });
  r.recordOld(hostfile, { key: 'https://media.northwind-bakery.test/a/pastries.jpg', url: 'https://media.northwind-bakery.test/a/pastries.jpg', type: 'image', host: 'media.northwind-bakery.test', ip: '198.51.100.24', ptr: 'web03.oldhost.example' });
  const live = feed(r.createRecord(), {
    completedList: ['/wp-content/themes/hearth/style.css', '/wp-content/plugins/elementor/assets/css/frontend.min.css'].map(p => completed(p, 'stylesheet', 200, { 'Content-Type': ['text/css'] }))
      .concat(completed('/wp-includes/js/jquery/jquery.min.js', 'script', 200), completed('/wp-admin/admin-ajax.php?action=get_refreshed_fragments', 'xhr', 200), completed('https://static.northwind-bakery.test/fonts/brand.woff2', 'font', 200)),
    errors: [failed('https://static.northwind-bakery.test/fonts/brand.woff2', 'font', 'net::ERR_CACHE_MISS')],
    console: [{ level: 'error', message: MIXED, sourceId: PAGE }],
  });
  live.pageServer = 'LiteSpeed';
  return { hostfile, live };
}

test('classifies failed requests from webRequest details', () => {
  assert.deepEqual(r.responseOutcome(completed('/a.css', 'stylesheet', 404)), { key: 'https://northwind-bakery.test/a.css', url: 'https://northwind-bakery.test/a.css', type: 'stylesheet', failed: true, kind: 'http', status: '404 Not Found', code: 404, server: '' });
  const refused = r.responseOutcome(completed('/b.css', 'stylesheet', 200, { 'content-type': ['text/html; charset=utf-8'] }));
  assert.equal(refused.status, 'Refused: not CSS'); assert.equal(refused.why, 'server sent text/html with 200');
  assert.equal(r.responseOutcome(completed('/c.css', 'stylesheet', 200, { 'Content-Type': ['text/css'] })).failed, false);
  assert.equal(r.responseOutcome(completed('/c.css', 'stylesheet', 200)).failed, false, 'no content type: Chromium decides, not counted');
  assert.equal(r.responseOutcome(completed('/x', 'xhr', 500)).type, 'background request');
  assert.equal(r.responseOutcome(completed('/', 'mainFrame', 404)), null, 'the page itself is not a file');
  assert.equal(r.responseOutcome(completed('/p', 'ping', 404)), null);
  assert.equal(r.responseOutcome({ url: 'data:text/css,', resourceType: 'stylesheet', statusCode: 200 }), null);
  assert.equal(r.responseOutcome(completed('/s.js', 'script', 403, { SERVER: ['imunify360-webshield/1.21'] })).server, 'imunify360-webshield');
  assert.equal(r.errorOutcome(failed('/f.woff2', 'font', 'net::ERR_CACHE_MISS')), null, 'Chromium probes the cache for fonts first');
  assert.equal(r.errorOutcome(failed('/f.js', 'script', 'net::ERR_ABORTED')), null);
  assert.deepEqual([r.errorOutcome(failed('/f.js', 'script', 'net::ERR_NAME_NOT_RESOLVED')).status, r.errorOutcome(failed('/f.js', 'script', 'net::ERR_CONNECTION_REFUSED')).why], ['Host not found', 'net::ERR_CONNECTION_REFUSED']);
});

test('parses console messages into refused files and JavaScript errors', () => {
  const cors = r.consoleOutcome({ level: 'error', message: CORS }).file;
  assert.deepEqual([cors.url, cors.type, cors.status, cors.why], ['https://static.northwind-bakery.test/fonts/brand.woff2', 'font', 'Blocked by CORS', 'no Access-Control-Allow-Origin']);
  const mixed = r.consoleOutcome({ level: 'error', message: MIXED }).file;
  assert.deepEqual([mixed.url, mixed.type, mixed.status], ['http://northwind-bakery.test/wp-content/plugins/cookie-notice/js/front.js', 'script', 'Blocked: http on https']);
  assert.equal(r.consoleOutcome({ level: 'error', message: "Mixed Content: The page at 'https://a.test/' was loaded over HTTPS, but requested an insecure XMLHttpRequest endpoint 'http://a.test/api'. This request has been blocked; the content must be served over HTTPS." }).file.type, 'background request');
  assert.equal(r.consoleOutcome({ level: 'warning', message: "Mixed Content: The page at 'https://a.test/' was loaded over HTTPS, but requested an insecure element 'http://a.test/i.png'. This request was automatically upgraded to HTTPS" }), null, 'upgraded images load');
  assert.equal(r.consoleOutcome({ level: 'error', message: "Access to fetch at 'https://api.test/x' from origin 'https://a.test' has been blocked by CORS policy: Response to preflight request doesn't pass access control check" }).file.why, 'preflight request refused');
  const style = r.consoleOutcome({ level: 'error', message: "Refused to apply style from 'https://a.test/x.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled." }).file;
  assert.deepEqual([style.status, style.type, style.why], ['Refused: not CSS', 'stylesheet', 'server sent text/html']);
  assert.deepEqual(r.consoleOutcome(JQUERY).error, { key: 'Uncaught ReferenceError: jQuery is not defined|/wp-content/plugins/woocommerce/assets/js/frontend.js', message: 'Uncaught ReferenceError: jQuery is not defined', source: JQUERY.sourceId, line: 1 });
  assert.equal(r.consoleOutcome({ level: 3, message: 'Uncaught TypeError: x' }).error.message, 'Uncaught TypeError: x', 'old numeric level');
  for (const noise of [{ level: 'info', message: 'Slow network is detected.' }, { level: 'warning', message: 'Electron Security Warning' }, { level: 'error', message: 'Failed to load resource: the server responded with a status of 404 (Not Found)' }, { level: 'error', message: 'boom', sourceId: 'chrome-extension://abc/content.js' }, null]) assert.equal(r.consoleOutcome(noise), null);
  const a = r.consoleOutcome({ level: 'error', message: 'Uncaught Error at https://new.test/app.js:12:4', sourceId: 'https://new.test/app.js', lineNumber: 12 }).error;
  const b = r.consoleOutcome({ level: 'error', message: 'Uncaught Error at https://old.test/app.js:40:9', sourceId: 'https://old.test/app.js', lineNumber: 40 }).error;
  assert.equal(a.key, b.key, 'host and line numbers do not count');
});

test('keeps the most telling reason per file and caps the lists', () => {
  const rec = r.createRecord(), url = 'https://static.northwind-bakery.test/fonts/brand.woff2';
  r.recordFailure(rec, r.errorOutcome(failed(url, 'font', 'net::ERR_FAILED')));
  r.recordFailure(rec, r.consoleOutcome({ level: 'error', message: CORS }).file);
  assert.equal(rec.failures.get(url).status, 'Blocked by CORS');
  r.recordFailure(rec, r.errorOutcome(failed(url, 'font', 'net::ERR_FAILED')));
  assert.equal(rec.failures.get(url).status, 'Blocked by CORS', 'a weaker reason never replaces a stronger one');
  r.recordFailure(rec, { ...r.responseOutcome(completed('/x.css', 'stylesheet', 404)), url: 'https://a.test/x.css#top', key: r.fileKey('https://a.test/x.css#top') });
  assert.ok(rec.failures.has('https://a.test/x.css'), 'fragment is not part of the file');
  for (let i = 0; i < r.MAX_FILES + 5; i++) r.recordFailure(rec, r.responseOutcome(completed(`/f${i}.png`, 'image', 404)));
  assert.equal(rec.failures.size, r.MAX_FILES); assert.equal(rec.dropped, 7);
  for (let i = 0; i < r.MAX_ERRORS + 3; i++) r.recordError(rec, r.consoleOutcome({ level: 'error', message: `Uncaught Error ${i}` }).error);
  r.recordError(rec, r.consoleOutcome({ level: 'error', message: 'Uncaught Error 0' }).error);
  assert.equal(rec.errors.size, r.MAX_ERRORS); assert.equal([...rec.errors.values()][0].count, 2);
});

test('compares both panes: only Hostfile, on both, chips', () => {
  const { hostfile, live } = northwind();
  assert.deepEqual(r.paneSummary(hostfile, live), { failed: 5, both: 1, old: 2, oldHosts: ['media.northwind-bakery.test'], compared: true });
  assert.deepEqual(r.paneSummary(live, hostfile), { failed: 0, both: 1, old: 0, oldHosts: [], compared: true });
  assert.equal(r.paneSummary(hostfile, null).failed, 6, 'without the other side every failure counts');
  const view = r.filesView({ hostfile, live, pageURL: PAGE, ruleIP: '203.0.113.10' });
  assert.deepEqual(view.rows.map(x => [x.name, x.type, x.hostfile.status, x.hostfile.why, x.live.status, x.side]), [
    ['style.css', 'stylesheet', '404 Not Found', '', '200 OK', 'hostfile'],
    ['frontend.min.css', 'stylesheet', 'Refused: not CSS', 'server sent text/html with 200', '200 OK', 'hostfile'],
    ['jquery.min.js', 'script', '403 Forbidden', 'imunify360-webshield', '200 OK', 'hostfile'],
    ['admin-ajax.php', 'background request', '500 Internal Server Error', '', '200 OK', 'hostfile'],
    ['brand.woff2', 'font', 'Blocked by CORS', 'no Access-Control-Allow-Origin', '200 OK', 'hostfile'],
    ['front.js', 'script', 'Blocked: http on https', '', 'Blocked: http on https', 'both'],
  ]);
  assert.deepEqual(view.rows.map(x => x.path).slice(3), ['/wp-admin/admin-ajax.php?action=get_refreshed_fragments', 'static.northwind-bakery.test/fonts/brand.woff2', 'http://northwind-bakery.test/wp-content/plugins/cookie-notice/js/front.js']);
  assert.deepEqual(view.counts, { only: 5, both: 1, liveOnly: 0, old: 2, errors: 1 });
  assert.deepEqual(view.errors, [{ message: 'Uncaught ReferenceError: jQuery is not defined', source: '/wp-content/plugins/woocommerce/assets/js/frontend.js:1', count: 1 }]);
  assert.deepEqual(view.old.map(g => [g.host, g.ip, g.ptr, g.files.length]), [['media.northwind-bakery.test', '198.51.100.24', 'web03.oldhost.example', 2]]);
  assert.deepEqual(view.findings.map(f => [f.severity, f.title, f.detail]), [
    ['high', 'Stylesheet style.css fails on Hostfile (404 Not Found) but loads on Live.', 'Pages on the new server look unstyled.'],
    ['high', 'Stylesheet frontend.min.css is refused on Hostfile.', 'The new server sends a text/html page instead of CSS.'],
    ['high', '2 images on the new server pane come from the old server.', 'media.northwind-bakery.test has no domain rule. They break when the old server goes away.'],
    ['high', 'JavaScript error only on Hostfile: jQuery is not defined.', 'jquery.min.js is blocked by the firewall (403, imunify360-webshield).'],
    ['high', '2 more files fail only on Hostfile: admin-ajax.php (500), brand.woff2 (CORS).', ''],
    ['both', 'Script front.js is blocked on both servers: http on an https page.', ''],
  ]);
  const same = r.consoleOutcome(JQUERY).error;
  r.recordError(live, { ...same, source: 'https://www.northwind-bakery.test/wp-content/plugins/woocommerce/assets/js/frontend.js', line: 7 });
  assert.equal(r.filesView({ hostfile, live, pageURL: PAGE }).errors.length, 0, 'the same error on Live is left out');
});

test('a file that fails only on Live, and a page that was not measured', () => {
  const hostfile = r.createRecord(), live = r.createRecord();
  r.recordLoaded(hostfile, r.responseOutcome(completed('/logo.png', 'image', 200)));
  r.recordFailure(live, r.responseOutcome(completed('/logo.png', 'image', 404)));
  const view = r.filesView({ hostfile, live, pageURL: PAGE });
  assert.deepEqual(view.rows.map(x => [x.side, x.hostfile.status, x.live.status]), [['live', '200 OK', '404 Not Found']]);
  assert.deepEqual(view.findings, [], 'better on the new server is not a finding');
  const none = r.filesView({ hostfile, live: null, pageURL: PAGE });
  assert.equal(none.measured, false); assert.deepEqual(none.findings, []);
  assert.deepEqual(r.filesLines(none), ['Files that did not load (measured in the Hostfile and Live panes):', '- not measured, open Compare to measure files']);
});

test('copy text is plain and stripped of control and bidi characters', () => {
  const { hostfile, live } = northwind();
  r.recordError(hostfile, r.consoleOutcome({ level: 'error', message: 'Uncaught Error: evil‮\u0007text', sourceId: PAGE, lineNumber: 3 }).error);
  const text = r.filesText(r.filesView({ hostfile, live, pageURL: PAGE }), PAGE);
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/);
  assert.match(text, /^Dioptra: files that did not load on https:\/\/northwind-bakery\.test\/\n/);
  assert.match(text, /- https:\/\/northwind-bakery\.test\/wp-includes\/js\/jquery\/jquery\.min\.js \(script\): Hostfile 403 Forbidden \(imunify360-webshield\), Live 200 OK \[only Hostfile\]/);
  assert.match(text, /- http:\/\/northwind-bakery\.test\/wp-content\/plugins\/cookie-notice\/js\/front\.js \(script\): Hostfile Blocked: http on https, Live Blocked: http on https \[on both\]/);
  assert.match(text, /Loaded from the old server \(no domain rule for these hosts\):\n- https:\/\/media\.northwind-bakery\.test\/a\/sourdough\.jpg \(image\) from 198\.51\.100\.24 \(web03\.oldhost\.example\)/);
  assert.match(text, /JavaScript errors only on Hostfile:\n- Uncaught ReferenceError: jQuery is not defined \(\/wp-content\/plugins\/woocommerce\/assets\/js\/frontend\.js:1\)\n- Uncaught Error: eviltext \(\/:3\)/);
  assert.doesNotMatch(text, /[–—]/, 'no en or em dashes');
});

test('Ask Claude carries the files inside the untrusted server data', () => {
  const { hostfile, live } = northwind();
  const report = { url: PAGE, comparedAt: '2026-11-05T12:00:00.000Z', hostfile: { ok: true, status: 200, ms: 90, finalUrl: PAGE, ip: '203.0.113.10' }, live: { ok: true, status: 200, ms: 80, finalUrl: PAGE, ip: '198.51.100.24' }, domains: [], findings: [], headers: [], html: { hunks: [], changedLines: 0 } };
  const text = summaryText(report, r.filesLines(r.filesView({ hostfile, live, pageURL: PAGE })));
  const begin = text.indexOf('----- BEGIN UNTRUSTED SERVER DATA -----'), end = text.indexOf('----- END UNTRUSTED SERVER DATA -----'), files = text.indexOf('Files that did not load'), js = text.indexOf('jQuery is not defined');
  assert.ok(begin < files && files < end && begin < js && js < end, 'files and JavaScript errors sit between the markers');
  assert.equal(summaryText(report), summaryText(report, []), 'without files the summary is unchanged');
});
