const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { createLiveProxy } = require('../src/live-proxy.cjs');

async function fixture(t, host = '127.0.0.1') {
  const server = net.createServer(socket => socket.pipe(socket));
  server.listen(0, host);
  await once(server, 'listening');
  const proxy = await createLiveProxy();
  const socket = net.connect(Number(new URL(proxy.url).port), '127.0.0.1');
  await once(socket, 'connect');
  t.after(async () => { socket.destroy(); await proxy.close(); await new Promise(resolve => server.close(resolve)); });
  return { server, proxy, socket };
}
function read(socket, length) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const cleanup = () => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => onError(new Error('Unexpected close'));
    const onData = chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= length) {
        socket.pause(); cleanup();
        if (bytes.length > length) socket.unshift(bytes.subarray(length));
        resolve(bytes.subarray(0, length));
      }
    };
    socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose); socket.resume();
  });
}
function request(host, port, type = 3) {
  const address = type === 1 ? Buffer.from(host.split('.').map(Number)) : type === 4 ? Buffer.from('00000000000000000000000000000001', 'hex') : Buffer.concat([Buffer.from([host.length]), Buffer.from(host)]);
  return Buffer.concat([Buffer.from([5, 1, 0, type]), address, Buffer.from([port >> 8, port & 255])]);
}
async function greeting(socket) { socket.write(Buffer.from([5, 1, 0])); assert.deepEqual(await read(socket, 2), Buffer.from([5, 0])); }
async function connected(socket) {
  const header = await read(socket, 4);
  assert.equal(header[1], 0);
  await read(socket, header[3] === 4 ? 18 : 6);
}

for (const type of [1, 3]) {
  test(`CONNECT type ${type} tunnels bytes and tracks only active peer addresses`, async t => {
    const { proxy, socket, server } = await fixture(t);
    const host = type === 3 ? 'localhost' : '127.0.0.1';
    const port = server.address().port;
    assert.deepEqual(proxy.addresses(host, port), []);
    await greeting(socket);
    socket.write(Buffer.concat([request(host, port, type), Buffer.from('hello')]));
    await connected(socket);
    assert.equal((await read(socket, 5)).toString(), 'hello');
    assert.deepEqual(proxy.addresses(host.toUpperCase(), port), ['127.0.0.1']);
    socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(proxy.addresses(host, port), []);
  });
}
test('accepts fragmented greeting and request', async t => {
  const { socket, server } = await fixture(t);
  for (const byte of [5, 1, 0]) { socket.write(Buffer.from([byte])); await new Promise(resolve => setImmediate(resolve)); }
  assert.deepEqual(await read(socket, 2), Buffer.from([5, 0]));
  for (const byte of request('127.0.0.1', server.address().port)) { socket.write(Buffer.from([byte])); await new Promise(resolve => setImmediate(resolve)); }
  await connected(socket);
  socket.write('ok'); assert.equal((await read(socket, 2)).toString(), 'ok');
});
test('rejects unsupported authentication', async t => {
  const { socket } = await fixture(t);
  socket.write(Buffer.from([5, 1, 2]));
  assert.deepEqual(await read(socket, 2), Buffer.from([5, 255]));
});
for (const [name, packet, code] of [
  ['unsupported command', Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]), 7],
  ['unsupported address', Buffer.from([5, 1, 0, 9]), 8],
  ['invalid reserved byte', Buffer.from([5, 1, 1, 1]), 1],
  ['unknown host', request('no-such-host.invalid', 80), 4],
]) {
  test(`reports ${name}`, async t => {
    const { socket } = await fixture(t); await greeting(socket); socket.write(packet);
    assert.equal((await read(socket, 10))[1], code);
  });
}
test('close destroys established tunnels and incomplete handshakes; is idempotent', async t => {
  const { proxy, socket, server } = await fixture(t);
  await greeting(socket); socket.write(request('127.0.0.1', server.address().port)); await connected(socket);
  const incomplete = net.connect(Number(new URL(proxy.url).port), '127.0.0.1'); await once(incomplete, 'connect');
  // A force-closed TCP socket may emit ECONNRESET on macOS before close.
  socket.on('error',()=>{});incomplete.on('error',()=>{});
  const closed = Promise.all([socket,incomplete].map(s=>new Promise(resolve=>s.once('close',resolve))));
  socket.resume(); incomplete.resume();
  await proxy.close(); await closed; await proxy.close();
  assert.deepEqual(proxy.addresses('127.0.0.1', server.address().port), []);
});
test('IPv6 CONNECT when loopback IPv6 is available', async t => {
  let f;
  try { f = await fixture(t, '::1'); } catch (error) { if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) return t.skip('IPv6 unavailable'); throw error; }
  await greeting(f.socket); f.socket.write(request('::1', f.server.address().port, 4)); await connected(f.socket);
  f.socket.write('v6'); assert.equal((await read(f.socket, 2)).toString(), 'v6');
  assert.deepEqual(f.proxy.addresses('::1', f.server.address().port), ['::1']);
});
test('preserves end-to-end TLS certificate verification and SNI', async t => {
  const tls = require('node:tls');
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'live-proxy-tls-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  require('node:child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'key'), '-out', path.join(directory, 'cert'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(directory, 'cert'));
  let observedSNI;
  const server = tls.createServer({ key: fs.readFileSync(path.join(directory, 'key')), cert }, socket => {
    observedSNI = socket.servername;
    socket.pipe(socket);
  });
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const proxy = await createLiveProxy();
  t.after(async () => { await proxy.close(); await new Promise(resolve => server.close(resolve)); });
  async function tunnel() {
    const socket = net.connect(Number(new URL(proxy.url).port), '127.0.0.1');
    await once(socket, 'connect'); await greeting(socket);
    socket.write(request('localhost', server.address().port)); await connected(socket);
    return socket;
  }
  const secure = tls.connect({ socket: await tunnel(), servername: 'localhost', ca: cert });
  await once(secure, 'secureConnect');
  assert.equal(secure.authorized, true);
  secure.write('encrypted'); assert.equal((await read(secure, 9)).toString(), 'encrypted');
  assert.equal(observedSNI, 'localhost');
  secure.destroy();
  const rejected = tls.connect({ socket: await tunnel(), servername: 'wrong.invalid', ca: cert });
  const [error] = await once(rejected, 'error');
  assert.equal(error.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  rejected.destroy();
});
test('returns connection-refused status without recording an endpoint', async t => {
  const { socket, server, proxy } = await fixture(t);
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await greeting(socket); socket.write(request('127.0.0.1', port));
  assert.equal((await read(socket, 10))[1], 5);
  assert.deepEqual(proxy.addresses('127.0.0.1', port), []);
});
test('expires an incomplete handshake after its bounded deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { socket } = await fixture(t);
  // Reading the greeting proves the accept callback installed its deadline.
  await greeting(socket);
  socket.write(Buffer.from([5]));
  socket.on('error', error => assert.equal(error.code, 'ECONNRESET'));
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.resume();
  t.mock.timers.tick(10001);
  await closed;
});
