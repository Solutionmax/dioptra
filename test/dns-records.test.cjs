const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { Resolver } = require('node:dns').promises;
const { canLookup, lookupSide, compareSides, dnsReport } = require('../src/dns-records.cjs');

// A tiny authoritative DNS server on localhost, so the real resolver is exercised without internet.
// Like a real one it answers a name that is an alias with the CNAME plus the records of its target,
// says NXDOMAIN for unknown names in its zone and REFUSED for names outside it.
const TYPE = { 1: 'A', 2: 'NS', 5: 'CNAME', 15: 'MX', 16: 'TXT', 28: 'AAAA' }, CODE = Object.fromEntries(Object.entries(TYPE).map(([n, t]) => [t, Number(n)]));
const name = value => Buffer.concat([...value.split('.').filter(Boolean).map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
const rdata = {
  A: v => Buffer.from(v.split('.').map(Number)),
  AAAA: v => { const [head, tail = ''] = v.split('::'), l = head ? head.split(':') : [], r = tail ? tail.split(':') : []; return Buffer.from([...l, ...Array(8 - l.length - r.length).fill('0'), ...r].map(g => g.padStart(4, '0')).join(''), 'hex'); },
  CNAME: name, NS: name,
  MX: ([priority, exchange]) => { const b = Buffer.alloc(2); b.writeUInt16BE(priority); return Buffer.concat([b, name(exchange)]); },
  TXT: v => Buffer.concat((v.match(/[\s\S]{1,255}/g) || ['']).map(chunk => Buffer.concat([Buffer.from([chunk.length]), Buffer.from(chunk)])))
};
function record(owner, type, value) {
  const data = rdata[type](value), head = Buffer.alloc(10);
  head.writeUInt16BE(CODE[type], 0); head.writeUInt16BE(1, 2); head.writeUInt32BE(300, 4); head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), head, data]);
}
// broken: record types (or '*' for everything) the server answers with SERVFAIL.
function dnsServer(zone, records, broken = []) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, peer) => {
    let offset = 12; const labels = [];
    for (;;) { const length = msg[offset++]; if (!length) break; labels.push(msg.subarray(offset, offset + length).toString()); offset += length; }
    const asked = labels.join('.').toLowerCase(), type = TYPE[msg.readUInt16BE(offset)], question = msg.subarray(12, offset + 4);
    const own = n => Object.keys(records).some(key => key.startsWith(`${n} `));
    let answers = [], rcode = 0;
    if (broken.includes('*') || broken.includes(type)) rcode = 2;
    else if (asked !== zone && !asked.endsWith(`.${zone}`)) rcode = 5;
    else if (!own(asked)) rcode = 3;
    else {
      const alias = type !== 'CNAME' && records[`${asked} CNAME`]?.[0], owner = alias || asked;
      if (alias) answers.push(record(asked, 'CNAME', alias));
      for (const value of records[`${owner} ${type}`] || []) answers.push(record(owner, type, value));
    }
    const head = Buffer.alloc(12); msg.copy(head, 0, 0, 2); head.writeUInt16BE(0x8400 | rcode, 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(answers.length, 6);
    socket.send(Buffer.concat([head, question, ...answers]), peer.port, peer.address);
  });
  return new Promise(resolve => socket.bind(0, '127.0.0.1', () => resolve({ address: `127.0.0.1:${socket.address().port}`, close: () => socket.close() })));
}
const resolverFor = address => { const r = new Resolver({ timeout: 1500, tries: 1 }); r.setServers([address]); return r; };
const SPF_NEW = 'v=spf1 +a +mx +ip4:203.0.113.10 ~all', SPF_OLD = 'v=spf1 a mx ip4:198.51.100.24 ~all', DKIM = `v=DKIM1; k=rsa; p=${'A'.repeat(390)}`;
let fresh, old, closed;
before(async () => {
  // The new server: zone as a control panel would create it.
  fresh = await dnsServer('bakery.test', {
    'bakery.test A': ['203.0.113.10'], 'bakery.test MX': [[0, 'bakery.test']], 'bakery.test TXT': [SPF_NEW, DKIM],
    'bakery.test NS': ['ns2.newhost.example', 'NS1.newhost.example'], 'www.bakery.test CNAME': ['bakery.test'], 'shop.bakery.test A': ['203.0.113.10']
  });
  // What the world sees today.
  old = await dnsServer('bakery.test', {
    'bakery.test A': ['198.51.100.24'], 'bakery.test AAAA': ['2001:db8:51::24'], 'bakery.test MX': [[20, 'mx2.oldhost.example'], [10, 'mail.bakery.test']],
    'bakery.test TXT': [SPF_OLD, 'google-site-verification=Zk3vQ8mN1xT7', DKIM], 'bakery.test NS': ['ns1.oldhost.example', 'ns2.oldhost.example'], 'www.bakery.test CNAME': ['bakery.test']
  });
  const unused = dgram.createSocket('udp4');
  closed = await new Promise(resolve => unused.bind(0, '127.0.0.1', () => { const address = `127.0.0.1:${unused.address().port}`; unused.close(() => resolve(address)); }));
});
after(() => { fresh.close(); old.close(); });
const rows = group => Object.fromEntries(group.rows.map(r => [r.type, r.values]));
const make = map => server => resolverFor(map[server]);

test('only real hostnames get a DNS button', () => {
  for (const host of ['example.com', 'www.example.co.uk', 'xn--bcher-kva.example']) assert.equal(canLookup(host), true, host);
  for (const host of ['', 'localhost', '203.0.113.10', '[::1]', '2001:db8::1', 'a'.repeat(260) + '.com', undefined]) assert.equal(canLookup(host), false, String(host));
});

test('bare domain: all record types, sorted, plus the www name', async () => {
  const side = await lookupSide(resolverFor(old.address), 'bakery.test');
  assert.equal(side.status, 'ok');
  assert.deepEqual(side.groups.map(g => [g.name, g.role]), [['bakery.test', 'host'], ['www.bakery.test', 'www']]);
  const host = rows(side.groups[0]);
  assert.deepEqual(host.A, [{ text: '198.51.100.24', ttl: 300 }]);
  assert.deepEqual(host.AAAA, [{ text: '2001:db8:51::24', ttl: 300 }]);
  assert.deepEqual(host.MX, [{ text: 'mail.bakery.test', prio: 10 }, { text: 'mx2.oldhost.example', prio: 20 }], 'lowest priority first');
  assert.deepEqual(host.TXT.map(v => v.text), ['google-site-verification=Zk3vQ8mN1xT7', DKIM, SPF_OLD], 'a long TXT record is joined from its chunks');
  assert.deepEqual(host.NS, [{ text: 'ns1.oldhost.example' }, { text: 'ns2.oldhost.example' }]);
  assert.equal(host.CNAME, undefined, 'a type without records is left out');
  assert.deepEqual(side.groups[1].rows, [{ type: 'CNAME', values: [{ text: 'bakery.test' }] }], 'the www name is shown as the alias only');
});

test('www name that is an alias: only the alias and its address, mail and nameservers under the bare domain', async () => {
  const side = await lookupSide(resolverFor(old.address), 'www.bakery.test');
  assert.deepEqual(side.groups.map(g => [g.name, g.role]), [['www.bakery.test', 'host'], ['bakery.test', 'zone']]);
  assert.deepEqual(side.groups[0].rows.map(r => [r.type, Boolean(r.via)]), [['CNAME', false], ['A', true], ['AAAA', true]], 'alias first, then the addresses it leads to; mail and TXT of the target are not shown as if they belong to www');
  assert.deepEqual(side.groups[1].rows.map(r => r.type), ['MX', 'TXT', 'NS']);
});

test('names are lower case and without the trailing dot', async () => {
  const side = await lookupSide(resolverFor(fresh.address), 'bakery.test');
  assert.deepEqual(rows(side.groups[0]).NS, [{ text: 'ns1.newhost.example' }, { text: 'ns2.newhost.example' }]);
});

test('a name the server does not know, a domain it does not serve, and a server without DNS are told apart', async () => {
  const missing = await lookupSide(resolverFor(old.address), 'staging.bakery.test');
  assert.equal(missing.status, 'notfound'); assert.deepEqual(missing.groups, []);
  const foreign = await lookupSide(resolverFor(old.address), 'example.org');
  assert.equal(foreign.status, 'declined'); assert.equal(foreign.code, 'EREFUSED');
  const dead = await lookupSide(resolverFor(closed), 'bakery.test');
  assert.equal(dead.status, 'failed'); assert.match(dead.code, /^E(CONNREFUSED|TIMEOUT)$/);
});

test('a subdomain without a www name shows only itself', async () => {
  const side = await lookupSide(resolverFor(fresh.address), 'shop.bakery.test');
  assert.equal(side.status, 'ok'); assert.deepEqual(side.groups.map(g => g.name), ['shop.bakery.test']);
});

test('single view: public records with a hint about the rule', async () => {
  const report = await dnsReport({ host: 'bakery.test', ruleIP: '203.0.113.10', compare: false }, make({ '': old.address }));
  assert.equal(report.status, 'ok'); assert.equal(report.server, ''); assert.equal(report.table, null);
  assert.deepEqual(report.groups[0].rows.find(r => r.type === 'A').rule, { ip: '203.0.113.10', same: false });
  const done = await dnsReport({ host: 'bakery.test', ruleIP: '203.0.113.10', compare: false }, make({ '': fresh.address }));
  assert.deepEqual(done.groups[0].rows.find(r => r.type === 'A').rule, { ip: '203.0.113.10', same: true }, 'public DNS already points to the rule');
  const typed = await dnsReport({ host: 'bakery.test', ruleIP: '203.0.113.10', compare: false }, make({ '': fresh.address }));
  assert.equal(typed.groups[0].rows.find(r => r.type === 'A').rule.same, true);
  const plain = await dnsReport({ host: 'bakery.test', ruleIP: '', compare: false }, make({ '': old.address }));
  assert.equal(plain.groups[0].rows.find(r => r.type === 'A').rule, undefined);
});

test('compare: the server from the rule next to public DNS', async () => {
  const report = await dnsReport({ host: 'bakery.test', ruleIP: '203.0.113.10', compare: true }, make({ '': old.address, '203.0.113.10': fresh.address }));
  assert.equal(report.server, 'ok'); assert.deepEqual(report.groups, []);
  const [host, www] = report.table.groups, row = Object.fromEntries(host.rows.map(r => [r.type, r]));
  assert.deepEqual(host.rows.map(r => [r.type, r.status]), [['A', 'expected'], ['AAAA', 'differs'], ['MX', 'differs'], ['TXT', 'differs'], ['NS', 'differs']]);
  assert.equal(report.table.differing, 4, 'the A record points to the rule and is not counted');
  assert.deepEqual(row.A.hostfile, [{ text: '203.0.113.10', differs: false }]); assert.deepEqual(row.A.live, [{ text: '198.51.100.24', differs: false }]);
  assert.deepEqual(row.AAAA.hostfile, []); assert.deepEqual(row.AAAA.live, [{ text: '2001:db8:51::24', differs: true }]);
  assert.deepEqual(row.MX.hostfile, [{ text: 'bakery.test', prio: 0, differs: true }]);
  assert.deepEqual(row.TXT.hostfile.map(v => [v.text, v.differs]), [[DKIM, false], [SPF_NEW, true]], 'only the values that exist on one side are marked');
  assert.deepEqual(row.TXT.live.map(v => [v.text, v.differs]), [['google-site-verification=Zk3vQ8mN1xT7', true], [DKIM, false], [SPF_OLD, true]]);
  assert.equal(www.name, 'www.bakery.test'); assert.deepEqual(www.rows.map(r => [r.type, r.status]), [['CNAME', 'same']]);
});

test('compare: an address that is not the rule counts as a difference', () => {
  const group = (text, extra = []) => [{ name: 'x.test', role: 'host', rows: [{ type: 'A', values: [{ text, ttl: 60 }, ...extra] }] }];
  assert.equal(compareSides(group('192.0.2.7'), group('198.51.100.24'), '203.0.113.10').groups[0].rows[0].status, 'differs');
  assert.equal(compareSides(group('203.0.113.10'), group('203.0.113.10'), '203.0.113.10').groups[0].rows[0].status, 'same');
  assert.equal(compareSides(group('203.0.113.10'), [], '203.0.113.10').groups[0].rows[0].status, 'differs', 'nothing public to replace');
});

test('compare falls back to public DNS when the server from the rule has nothing to compare', async () => {
  const dead = await dnsReport({ host: 'bakery.test', ruleIP: '203.0.113.10', compare: true }, make({ '': old.address, '203.0.113.10': closed }));
  assert.equal(dead.server, 'noanswer'); assert.equal(dead.table, null); assert.equal(dead.groups[0].name, 'bakery.test');
  assert.deepEqual(dead.groups[0].rows.find(r => r.type === 'A').rule, { ip: '203.0.113.10', same: false });
  const other = await dnsServer('elsewhere.test', { 'elsewhere.test A': ['192.0.2.1'] });
  try {
    const foreign = await dnsReport({ host: 'bakery.test', ruleIP: '203.0.113.10', compare: true }, make({ '': old.address, '203.0.113.10': other.address }));
    assert.equal(foreign.server, 'nozone'); assert.equal(foreign.table, null); assert.equal(foreign.groups.length, 2);
  } finally { other.close(); }
});

test('public DNS that does not know the name or cannot be reached is reported, not thrown', async () => {
  const missing = await dnsReport({ host: 'staging.bakery.test', ruleIP: '', compare: false }, make({ '': old.address }));
  assert.equal(missing.status, 'notfound'); assert.deepEqual(missing.groups, []);
  const offline = await dnsReport({ host: 'bakery.test', ruleIP: '203.0.113.10', compare: true }, make({ '': closed, '203.0.113.10': fresh.address }));
  assert.equal(offline.status, 'failed'); assert.match(offline.code, /^E/); assert.equal(offline.table, null, 'no half comparison when public DNS is unreachable');
});

test('a record type that could not be asked is not shown as missing and not counted as a difference', async () => {
  const flaky = await dnsServer('bakery.test', { 'bakery.test A': ['203.0.113.10'], 'bakery.test TXT': [SPF_NEW], 'bakery.test NS': ['ns1.newhost.example'], 'www.bakery.test CNAME': ['bakery.test'] }, ['TXT']);
  try {
    const side = await lookupSide(resolverFor(flaky.address), 'bakery.test');
    assert.equal(side.status, 'ok');
    assert.deepEqual(side.groups[0].rows.find(r => r.type === 'TXT'), { type: 'TXT', values: [], failed: 'ESERVFAIL' });
    const report = await dnsReport({ host: 'bakery.test', ruleIP: '203.0.113.10', compare: true }, make({ '': old.address, '203.0.113.10': flaky.address }));
    const txt = report.table.groups[0].rows.find(r => r.type === 'TXT');
    assert.equal(txt.status, 'unknown'); assert.deepEqual(txt.failed, { hostfile: 'ESERVFAIL', live: '' });
    assert.ok(txt.live.length === 3 && txt.live.every(v => v.differs === false), 'the side that did answer is shown without marks');
    assert.deepEqual(report.table.groups[0].rows.filter(r => r.status === 'differs').map(r => r.type), ['AAAA', 'MX', 'NS']); assert.equal(report.table.differing, 3);
    const list = await dnsReport({ host: 'bakery.test', ruleIP: '', compare: false }, make({ '': flaky.address }));
    assert.equal(list.groups[0].rows.find(r => r.type === 'TXT').failed, 'ESERVFAIL');
  } finally { flaky.close(); }
});

test('public DNS that answers with an error gives no comparison', async () => {
  const down = await dnsServer('bakery.test', {}, ['*']);
  try {
    const report = await dnsReport({ host: 'bakery.test', ruleIP: '203.0.113.10', compare: true }, make({ '': down.address, '203.0.113.10': fresh.address }));
    assert.equal(report.status, 'failed'); assert.equal(report.code, 'ESERVFAIL'); assert.equal(report.table, null); assert.deepEqual(report.groups, []);
  } finally { down.close(); }
});

test('the rule address is compared by value, not by how it was typed', () => {
  const group = text => [{ name: 'x.test', role: 'host', rows: [{ type: 'AAAA', values: [{ text, ttl: 60 }] }] }];
  assert.equal(compareSides(group('2001:db8::1'), group('2001:db8:51::24'), '2001:DB8:0:0:0:0:0:1').groups[0].rows[0].status, 'expected');
});

test('an IPv6 rule address is passed to the resolver in brackets', async () => {
  const seen = [];
  await dnsReport({ host: 'bakery.test', ruleIP: '2001:db8::10', compare: true }, server => { seen.push(server); return resolverFor(closed); });
  assert.deepEqual(seen.sort(), ['', '2001:db8::10']);
  const { serverAddress } = require('../src/dns-records.cjs');
  assert.equal(serverAddress('2001:db8::10'), '[2001:db8::10]'); assert.equal(serverAddress('203.0.113.10'), '203.0.113.10');
});
