const net = require('node:net');

function normalizedHost(host) {
  const value = String(host).replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  return net.isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value;
}

// SOCKS only carries TCP bytes. Chromium still owns TLS, certificates and SNI.
async function createLiveProxy({ resolve = host => host } = {}) {
  const sockets = new Set();
  const active = new Map();
  const destinations = new Map();
  const keyFor = (host, port) => `${normalizedHost(host)}|${Number(port)}`;
  let closePromise;
  function track(socket) {
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); destinations.delete(socket); });
    return socket;
  }
  const server = net.createServer(client => {
    track(client);
    let pending = Buffer.alloc(0);
    let state = 'greeting';
    let upstream;
    let activeKey;
    let timer = setTimeout(() => client.destroy(), 10000);
    timer.unref();
    const removeActive = () => {
      if (!activeKey) return;
      const peers = active.get(activeKey);
      peers?.delete(upstream);
      if (!peers?.size) active.delete(activeKey);
    };
    client.on('error', () => client.destroy());
    client.once('close', () => { clearTimeout(timer); removeActive(); upstream?.destroy(); });
    function fail(code) {
      if (state === 'failed') return;
      state = 'failed';
      client.off('data', onData);
      client.pause();
      pending = Buffer.alloc(0);
      clearTimeout(timer);
      removeActive();
      upstream?.destroy();
      client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
      timer = setTimeout(() => client.destroy(), 1000);
      timer.unref();
    }
    function onData(chunk) {
      pending = Buffer.concat([pending, chunk]);
      if (state === 'greeting') {
        if (pending.length < 2) return;
        const count = pending[1];
        if (pending[0] !== 5 || count === 0) { client.destroy(); return; }
        if (pending.length < 2 + count) return;
        if (!pending.subarray(2, 2 + count).includes(0)) {
          state = 'failed'; client.off('data', onData); client.pause(); pending = Buffer.alloc(0); client.end(Buffer.from([5, 255])); return;
        }
        client.write(Buffer.from([5, 0]));
        pending = pending.subarray(2 + count);
        state = 'request';
      }
      if (state !== 'request' || pending.length < 4) return;
      if (pending[0] !== 5 || pending[2] !== 0) return fail(1);
      if (pending[1] !== 1) return fail(7);
      const type = pending[3];
      let length;
      let host;
      if (type === 1) length = 10;
      else if (type === 4) length = 22;
      else if (type === 3) {
        if (pending.length < 5) return;
        if (!pending[4]) return fail(4);
        length = 7 + pending[4];
      } else return fail(8);
      // SOCKS address fields bound the handshake to at most 262 bytes.
      if (pending.length < length) return;
      if (type === 1) host = [...pending.subarray(4, 8)].join('.');
      else if (type === 4) host = Array.from({ length: 8 }, (_, i) => pending.readUInt16BE(4 + i * 2).toString(16)).join(':');
      else {
        const bytes = pending.subarray(5, length - 2);
        if ([...bytes].some(byte => byte < 33 || byte > 126)) return fail(4);
        host = bytes.toString('ascii');
      }
      const port = pending.readUInt16BE(length - 2);
      if (!port) return fail(1);
      const payload = pending.subarray(length);
      pending = Buffer.alloc(0);
      state = 'connecting';
      client.pause();
      client.off('data', onData);
      clearTimeout(timer);
      timer = setTimeout(() => fail(6), 10000);
      timer.unref();
      // net.connect uses the OS resolver, outside Electron's host-resolver rules.
      upstream = track(net.connect({ host: resolve(normalizedHost(host)), port }));
      destinations.set(client, normalizedHost(host));
      destinations.set(upstream, normalizedHost(host));
      upstream.on('error', error => {
        if (state === 'connected') client.destroy();
        else fail(({ ECONNREFUSED: 5, ENOTFOUND: 4, EAI_AGAIN: 4, ENETUNREACH: 3, EHOSTUNREACH: 4, ETIMEDOUT: 6 })[error.code] || 1);
      });
      upstream.once('close', () => { removeActive(); if (state === 'connected') client.destroy(); });
      upstream.once('connect', () => {
        if (client.destroyed || state !== 'connecting') return upstream.destroy();
        clearTimeout(timer);
        state = 'connected';
        activeKey = keyFor(host, port);
        if (!active.has(activeKey)) active.set(activeKey, new Set());
        active.get(activeKey).add(upstream);
        // A zero bind address is valid: callers do not need a reachable BND endpoint.
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (payload.length) upstream.write(payload);
        upstream.pipe(client);
        client.pipe(upstream);
        client.resume();
      });
    }
    client.on('data', onData);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const url = `socks5://127.0.0.1:${server.address().port}`;
  return {
    url,
    closeHosts(hosts) {
      for (const [socket, host] of destinations) if (hosts.has(host)) socket.destroy();
      for (const [key, peers] of active) if (hosts.has(key.slice(0, key.lastIndexOf('|')))) {
        for (const socket of peers) socket.destroy();
        active.delete(key);
      }
    },
    addresses(host, port) {
      return [...new Set([...(active.get(keyFor(host, port)) || [])]
        .filter(socket => !socket.destroyed && socket.remoteAddress)
        .map(socket => socket.remoteAddress))];
    },
    close() {
      if (!closePromise) closePromise = new Promise(resolve => {
        server.close(resolve);
        for (const socket of sockets) socket.destroy();
        active.clear();
      });
      return closePromise;
    },
  };
}

module.exports = { createLiveProxy };
