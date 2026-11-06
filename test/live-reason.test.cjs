const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const r = require('../src/live-reason.cjs');
const d = require('../src/differences.cjs');

const URL_ = 'https://northwind-bakery.test/';
const failed = (code, error, extra = {}) => ({ ok: false, code, error, address: '', port: 443, redirects: [], ...extra });

test('failure kinds: no DNS record, refused, timeout, certificate, other, and Chromium names', () => {
  assert.equal(r.failureKind({ ok: true, status: 200 }), '');
  assert.equal(r.failureKind(null), '');
  assert.equal(r.failureKind(failed('ENOTFOUND', 'getaddrinfo ENOTFOUND northwind-bakery.test')), 'dns');
  assert.equal(r.failureKind(failed('EAI_AGAIN', 'getaddrinfo EAI_AGAIN northwind-bakery.test')), 'dns');
  assert.equal(r.failureKind(failed('ECONNREFUSED', 'connect ECONNREFUSED 198.51.100.30:443')), 'refused');
  assert.equal(r.failureKind(failed('ETIMEDOUT', 'The request timed out after 20 seconds.')), 'timeout');
  assert.equal(r.failureKind(failed('', 'The request timed out after 20 seconds.')), 'timeout', 'an older result without code');
  assert.equal(r.failureKind(failed('EHOSTUNREACH', 'connect EHOSTUNREACH 198.51.100.50:443')), 'unreachable');
  for (const [code, error] of [['CERT_HAS_EXPIRED', 'certificate has expired'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'], ['ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'], ['', 'The live certificate changed since you chose Continue anyway. Open the page again to check it.'], ['', 'net::ERR_CERT_AUTHORITY_INVALID']]) {
    assert.equal(r.failureKind(failed(code, error)), 'certificate', `${code} ${error}`);
  }
  assert.equal(r.failureKind(failed('', 'net::ERR_NAME_NOT_RESOLVED')), 'dns');
  assert.equal(r.failureKind(failed('', 'net::ERR_CONNECTION_REFUSED')), 'refused');
  assert.equal(r.failureKind(failed('', 'net::ERR_CONNECTION_TIMED_OUT')), 'timeout');
  assert.equal(r.failureKind(failed('ECONNRESET', 'socket hang up')), 'other');
  assert.equal(r.failureKind(failed('', 'Blocked redirect to file: URL.')), 'other');
});

test('reason texts name the server that failed and keep the raw code for the small detail line', () => {
  const dns = r.liveReason(failed('ENOTFOUND', 'getaddrinfo ENOTFOUND northwind-bakery.test'), { url: URL_, checkedAt: '2026-11-05T23:29:00.000Z' });
  assert.deepEqual(dns, { kind: 'dns', host: 'northwind-bakery.test', ip: '', port: 443, why: 'northwind-bakery.test has no DNS record', short: 'no DNS record',
    text: 'Live could not be reached: northwind-bakery.test has no DNS record.', detail: 'getaddrinfo ENOTFOUND northwind-bakery.test', checkedAt: '2026-11-05T23:29:00.000Z' });
  assert.equal(r.liveReason(failed('EAI_AGAIN', 'getaddrinfo EAI_AGAIN northwind-bakery.test'), { url: URL_ }).text, 'Live could not be reached: northwind-bakery.test has no DNS record.');
  const refused = r.liveReason(failed('ECONNREFUSED', 'connect ECONNREFUSED 198.51.100.30:443', { address: '198.51.100.30' }), { url: URL_, ip: '192.0.2.99' });
  assert.equal(refused.text, 'Live could not be reached: the old server 198.51.100.30 refused the connection on port 443.', 'the address of the error wins over the lookup');
  assert.equal(refused.short, 'connection refused'); assert.equal(refused.detail, 'connect ECONNREFUSED 198.51.100.30:443');
  const timeout = r.liveReason(failed('ETIMEDOUT', 'The request timed out after 20 seconds.', { port: 8443 }), { url: 'https://northwind-bakery.test:8443/', ip: '198.51.100.40' });
  assert.equal(timeout.text, 'Live could not be reached: the old server 198.51.100.40 did not answer on port 8443.');
  assert.equal(timeout.short, 'no answer'); assert.equal(timeout.detail, 'The request timed out after 20 seconds.');
  assert.equal(r.liveReason(failed('ETIMEDOUT', 'The request timed out after 20 seconds.'), { url: URL_ }).text, 'Live could not be reached: the old server did not answer on port 443.', 'no address known at all');
  assert.equal(r.liveReason(failed('ECONNREFUSED', 'x', { address: '::ffff:198.51.100.30' }), { url: URL_ }).ip, '198.51.100.30');
  // A redirect to another host that has no record: that host is named, not the page.
  assert.equal(r.liveReason(failed('ENOTFOUND', 'getaddrinfo ENOTFOUND www.northwind-bakery.test', { redirects: [{ status: 301, location: 'https://www.northwind-bakery.test/' }] }), { url: URL_ }).why, 'www.northwind-bakery.test has no DNS record');
  // Everything else keeps the behaviour of 1.2.0-beta.2: the certificate has Continue anyway.
  assert.equal(r.liveReason(failed('CERT_HAS_EXPIRED', 'certificate has expired'), { url: URL_ }), null);
  assert.equal(r.liveReason(failed('ECONNRESET', 'socket hang up'), { url: URL_ }), null);
  assert.equal(r.liveReason({ ok: true, status: 200 }, { url: URL_ }), null);
  // Control characters from an error message never reach the window.
  assert.equal(r.liveReason(failed('ENOTFOUND', 'getaddrinfo‮ ENOTFOUND x'), { url: URL_ }).detail, 'getaddrinfo  ENOTFOUND x');
});

test('one dns.lookup only for a refused or silent server whose error names no address', () => {
  assert.equal(r.needsAddress(failed('ETIMEDOUT', 'The request timed out after 20 seconds.')), true);
  assert.equal(r.needsAddress(failed('ECONNREFUSED', 'x')), true);
  assert.equal(r.needsAddress(failed('ECONNREFUSED', 'x', { address: '198.51.100.30' })), false);
  assert.equal(r.needsAddress(failed('ENOTFOUND', 'x')), false);
  assert.equal(r.needsAddress(failed('CERT_HAS_EXPIRED', 'x')), false);
  assert.equal(r.failingHost('https://a.test/', { redirects: [] }), 'a.test');
  assert.equal(r.failingHost('not a url', {}), '');
});

test('findings without Live: the reason first and calm, no findings that compare with an empty page', () => {
  const reason = r.liveReason(failed('ENOTFOUND', 'getaddrinfo ENOTFOUND northwind-bakery.test'), { url: URL_ });
  const before = [{ severity: 'high', text: 'The Live request failed: getaddrinfo ENOTFOUND northwind-bakery.test.' }, { severity: 'medium', text: 'Script from northwind-bakery.test loads only on Hostfile.' },
    { severity: 'high', text: 'Script from cdn.evil.test loads only on Hostfile (not on Live).' }, { severity: 'medium', text: '1 other external domain only on Hostfile: 198.51.100.24.' },
    { severity: 'medium', text: '2 other external domains only on Hostfile: a.test, b.test.' }, { severity: 'high', text: 'Inline script that looks obfuscated appears only on Hostfile: eval(atob(…' }, { severity: 'info', text: 'Something else.' }];
  const after = r.soloFindings(before, reason);
  assert.deepEqual(after.map(f => [f.severity, f.calm || false, f.text]), [['info', true, 'Live could not be reached: northwind-bakery.test has no DNS record.'], ['high', false, 'Inline script that looks obfuscated appears on Hostfile: eval(atob(…'], ['info', false, 'Something else.']]);
  assert.equal(after[0].detail, 'Speed and Checks judged the new server on its own; comparing with Live waits until Live answers.');
  // A newer reason replaces the old one instead of adding a second.
  const again = r.soloFindings(after, r.liveReason(failed('ECONNREFUSED', 'x', { address: '198.51.100.30' }), { url: URL_ }));
  assert.equal(again.filter(f => f.calm).length, 1); assert.match(again[0].text, /refused the connection on port 443/); assert.equal(again.length, 3);
});

test('fetchDocument says why it failed: code, address and port of a refused connection', async () => {
  const probe = net.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); // nothing listens there now
  const result = await d.fetchDocument(null, `https://northwind-bakery.test:${port}/`, { resolveRoute: () => ({ ip: '127.0.0.1' }) });
  assert.equal(result.ok, false); assert.equal(result.code, 'ECONNREFUSED'); assert.equal(result.address, '127.0.0.1'); assert.equal(result.port, port);
  assert.match(result.error, /ECONNREFUSED 127\.0\.0\.1/);
  assert.equal(r.liveReason(result, { url: `https://northwind-bakery.test:${port}/` }).text, `Live could not be reached: the old server 127.0.0.1 refused the connection on port ${port}.`);
});

test('fetchDocument timeout: Node gives an AbortError with the TimeoutError as cause, the text says the seconds', async t => {
  // A loopback server that accepts and never answers (no TLS handshake): the request can only time out.
  const sockets = new Set(), silent = net.createServer(socket => sockets.add(socket)).listen(0, '127.0.0.1'); await once(silent, 'listening');
  t.after(() => { for (const s of sockets) s.destroy(); silent.close(); });
  const port = silent.address().port;
  const result = await d.fetchDocument(null, `https://northwind-bakery.test:${port}/`, { timeout: 2000, resolveRoute: () => ({ ip: '127.0.0.1' }) });
  assert.equal(result.ok, false); assert.equal(result.error, 'The request timed out after 2 seconds.'); assert.equal(result.code, 'ETIMEDOUT'); assert.equal(result.port, port); assert.equal(result.address, '');
  assert.ok(result.ms >= 1950 && result.ms < 6000, `${result.ms} ms`);
  // The same shape without a socket: the AbortError of Node's https, measured in the mockup round.
  const keepAlive = setTimeout(() => {}, 1000);
  const abort = await d.fetchDocument({ fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: init.signal.reason })))) }, URL_, { timeout: 50 });
  clearTimeout(keepAlive);
  assert.equal(abort.error, 'The request timed out after 50 ms.'); assert.equal(abort.code, 'ETIMEDOUT'); assert.equal(abort.port, 443);
  assert.equal(r.liveReason(abort, { url: URL_, ip: '198.51.100.40' }).text, 'Live could not be reached: the old server 198.51.100.40 did not answer on port 443.');
});

test('fetchDocument reads the code from the cause of a fetch error; a success has none of the new fields', async () => {
  const dns = await d.fetchDocument({ fetch: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND northwind-bakery.test'), { code: 'ENOTFOUND', hostname: 'northwind-bakery.test' }) }); } }, URL_);
  assert.equal(dns.ok, false); assert.equal(dns.code, 'ENOTFOUND'); assert.equal(dns.error, 'getaddrinfo ENOTFOUND northwind-bakery.test'); assert.equal(dns.port, 443);
  const plain = await d.fetchDocument({ fetch: async () => { throw new Error('boom'); } }, 'http://a.test/');
  assert.equal(plain.code, ''); assert.equal(plain.port, 80); assert.equal(plain.error, 'boom');
  const good = await d.fetchDocument({ fetch: async () => new Response('<p>ok</p>') }, URL_);
  assert.equal(good.ok, true); assert.equal('code' in good, false); assert.equal('port' in good, false);
});
