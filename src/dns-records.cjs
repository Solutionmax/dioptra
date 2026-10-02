// DNS records of a hostname for the DNS card: what public DNS answers and, when comparing, what the server from a
// domain rule answers when it is asked directly. Uses Node's resolver, which speaks plain DNS and never reads the
// hosts file. Everything a server returns is untrusted: values are capped here and only ever shown as text.
const { Resolver } = require('node:dns').promises;
const { isIP } = require('node:net');

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
// Limit: longer lists and longer values are cut off before they are compared. A DNS answer is at most 64 KB.
const MAX_VALUES = 100, MAX_TEXT = 4096;
// The server answered, but declined: it does not serve this domain.
const DECLINED = new Set(['EREFUSED', 'ESERVFAIL', 'ENOTIMP', 'EFORMERR', 'EBADRESP']);
// Not an error: the name or the record type simply is not there.
const MISSING = new Set(['', 'ENODATA', 'ENOTFOUND']);
// One spelling per address, so a rule typed as 2001:DB8:0:0:0:0:0:1 matches the 2001:db8::1 a server returns.
function canonicalIP(ip) {
  const bare = String(ip || '').toLowerCase();
  if (isIP(bare) !== 6) return bare;
  try { return new URL(`http://[${bare}]`).hostname.slice(1, -1); } catch { return bare; }
}
const text = value => String(value ?? '').slice(0, MAX_TEXT);
const hostName = value => text(value).replace(/\.$/, '').toLowerCase();
const byText = (a, b) => a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
const address = list => list.map(entry => ({ text: text(entry.address), ttl: Number(entry.ttl) || 0 })).sort(byText);
const QUERIES = {
  A: (resolver, name) => resolver.resolve4(name, { ttl: true }).then(address),
  AAAA: (resolver, name) => resolver.resolve6(name, { ttl: true }).then(address),
  CNAME: (resolver, name) => resolver.resolveCname(name).then(list => list.map(value => ({ text: hostName(value) })).sort(byText)),
  MX: (resolver, name) => resolver.resolveMx(name).then(list => list.map(entry => ({ text: hostName(entry.exchange) || '.', prio: Number(entry.priority) || 0 })).sort((a, b) => a.prio - b.prio || byText(a, b))),
  TXT: (resolver, name) => resolver.resolveTxt(name).then(list => list.map(chunks => ({ text: text(chunks.join('')) })).sort(byText)),
  NS: (resolver, name) => resolver.resolveNs(name).then(list => list.map(value => ({ text: hostName(value) })).sort(byText))
};

// A name that can be looked up in DNS: not an IP address, not a single label such as localhost.
function canLookup(host) {
  return typeof host === 'string' && host.length <= 253 && host.includes('.') && !host.startsWith('[') && !isIP(host);
}
// Names shown for a host: the host itself plus its counterpart. For www that is the bare domain, where mail, TXT and
// nameservers live; for any other name it is the www name.
// Limit: for other subdomains (shop.example.com) the parent domain is not looked up.
function plan(host) {
  const bare = host.startsWith('www.') && host.split('.').length > 2 ? host.slice(4) : '';
  return [{ name: host, role: 'host', types: TYPES }, bare ? { name: bare, role: 'zone', types: ['MX', 'TXT', 'NS'] } : { name: `www.${host}`, role: 'www', types: ['CNAME', 'A', 'AAAA'] }];
}
async function ask(resolver, name, type) {
  try { return { type, values: (await QUERIES[type](resolver, name)).slice(0, MAX_VALUES), code: '' }; }
  catch (error) { return { type, values: [], code: String(error?.code || 'EUNKNOWN').slice(0, 40) }; }
}
// An alias answers every question with the records of its target. Show the alias and, for the visited name, the
// addresses it leads to; the target's mail, TXT and nameservers are not records of the alias.
// A type that could not be asked (timeout, server error) stays in the list as failed: it must not look like a
// record that is missing.
function rowsOf(role, answers) {
  const rows = answers.filter(answer => answer.values.length || !MISSING.has(answer.code)).map(({ type, values, code }) => values.length ? { type, values } : { type, values, failed: code });
  const alias = rows.find(row => row.type === 'CNAME' && row.values.length);
  if (!alias) return rows;
  if (role !== 'host') return [alias];
  return [alias, ...rows.filter(row => ['A', 'AAAA'].includes(row.type)).map(row => ({ ...row, via: true }))];
}
// ok: records (or an existing name without any of these record types). notfound: the name does not exist.
// declined: the server answered but does not serve the domain. failed: no answer at all.
function statusOf(answers) {
  if (answers.some(answer => answer.values.length)) return { status: 'ok', code: '' };
  const codes = answers.map(answer => answer.code);
  if (codes.every(code => code === 'ENOTFOUND')) return { status: 'notfound', code: 'ENOTFOUND' };
  const declined = codes.find(code => DECLINED.has(code));
  if (declined) return { status: 'declined', code: declined };
  const failed = codes.find(code => !MISSING.has(code));
  return failed ? { status: 'failed', code: failed } : { status: 'ok', code: '' };
}
// Everything one resolver knows about a host. Groups without records are left out.
async function lookupSide(resolver, host) {
  const answered = await Promise.all(plan(host).map(async group => ({ ...group, answers: await Promise.all(group.types.map(type => ask(resolver, group.name, type))) })));
  const state = statusOf(answered[0].answers);
  const groups = state.status === 'ok' ? answered.map(({ name, role, answers }) => ({ name, role, rows: rowsOf(role, answers) })).filter(group => group.rows.length) : [];
  return { ...state, groups };
}
const same = (type, a, b) => type === 'MX' ? a.prio === b.prio && a.text === b.text : type === 'TXT' ? a.text === b.text : a.text.toLowerCase() === b.text.toLowerCase();
// Both sides in one table: per name and record type the values of the rule server and of public DNS. A value that
// exists on one side only is marked. An address that differs because the new server points to itself is expected
// during a migration and is not counted. A type that one side could not answer is unknown, not a difference.
function compareSides(hostfile, live, ruleIP) {
  const names = [...new Map([...hostfile, ...live].map(group => [group.name, group.role]))];
  const groups = names.map(([name, role]) => {
    const pick = (side, type) => side.find(group => group.name === name)?.rows.find(row => row.type === type);
    const rows = TYPES.flatMap(type => {
      const a = pick(hostfile, type), b = pick(live, type);
      if (!a && !b) return [];
      const ours = a?.values || [], theirs = b?.values || [];
      const mark = (values, other) => values.map(({ ttl, ...value }) => ({ ...value, differs: !other.some(candidate => same(type, value, candidate)) }));
      const plain = values => values.map(value => ({ ...value, differs: false }));
      const left = mark(ours, theirs), right = mark(theirs, ours);
      if (a?.failed || b?.failed) return [{ type, status: 'unknown', hostfile: plain(left), live: plain(right), failed: { hostfile: a?.failed || '', live: b?.failed || '' } }];
      if (![...left, ...right].some(value => value.differs)) return [{ type, status: 'same', hostfile: left, live: right }];
      const moved = ['A', 'AAAA'].includes(type) && theirs.length && ours.length && ours.every(value => canonicalIP(value.text) === canonicalIP(ruleIP));
      return [moved ? { type, status: 'expected', hostfile: plain(left), live: plain(right) } : { type, status: 'differs', hostfile: left, live: right }];
    });
    return { name, role, rows };
  }).filter(group => group.rows.length);
  return { differing: groups.reduce((sum, group) => sum + group.rows.filter(row => row.status === 'differs').length, 0), groups };
}
// In the list a note under the address tells where this browser goes instead.
function withRule(groups, ruleIP) {
  if (!ruleIP) return groups;
  const wanted = isIP(ruleIP) === 6 ? 'AAAA' : 'A', host = groups.find(group => group.role === 'host');
  const answered = host?.rows.filter(row => row.values.length) || [];
  const target = answered.find(row => row.type === wanted) || answered.find(row => ['A', 'AAAA'].includes(row.type));
  if (!target) return groups;
  const rule = { ip: ruleIP, same: target.values.some(value => canonicalIP(value.text) === canonicalIP(ruleIP)) };
  return groups.map(group => group === host ? { ...group, rows: group.rows.map(row => row === target ? { ...row, rule } : row) } : group);
}
const serverAddress = ip => isIP(ip) === 6 ? `[${ip}]` : ip;
// server '' is the resolver of this computer; otherwise one server is asked directly and briefly, with one retry
// because a single lost packet would otherwise look like a missing record.
function makeResolver(server) {
  const resolver = new Resolver(server ? { timeout: 1500, tries: 2 } : { timeout: 3000, tries: 2 });
  if (server) resolver.setServers([serverAddress(server)]);
  return resolver;
}
// The data for the DNS card. Never throws: what went wrong is part of the report.
// server: '' not asked, 'ok', 'noanswer' (no DNS service there) or 'nozone' (DNS service without this domain).
async function dnsReport({ host, ruleIP = '', compare = false }, make = makeResolver) {
  const [live, direct] = await Promise.all([lookupSide(make(''), host), compare && ruleIP ? lookupSide(make(ruleIP), host) : null]);
  const server = !direct ? '' : direct.status === 'failed' ? 'noanswer' : direct.status === 'ok' && direct.groups.length ? 'ok' : 'nozone';
  // For public DNS an error answer and no answer come to the same thing: there is nothing trustworthy to show.
  const status = live.status === 'declined' ? 'failed' : live.status;
  const table = server === 'ok' && status !== 'failed' ? compareSides(direct.groups, live.groups, ruleIP) : null;
  return { host, ruleIP, askedAt: Date.now(), status, code: live.code, server, table, groups: table || status === 'failed' ? [] : withRule(live.groups, ruleIP) };
}
module.exports = { canLookup, lookupSide, compareSides, dnsReport, serverAddress };
