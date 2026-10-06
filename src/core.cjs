const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { domainToASCII } = require('node:url');

const ROUTE_BAR_HEIGHT = 36;
// A build can carry its own feed in package.json ("updateFeed"), used for update test builds.
const DEFAULT_UPDATE_FEED = (() => { try { return require('../package.json').updateFeed; } catch { return ''; } })() || 'https://github.com/Solutionmax/dioptra/releases/latest/download/';
const RELEASE_PAGE = 'https://github.com/Solutionmax/dioptra/releases/latest';
const MAX_SERVERS = 2000, MAX_SERVER_NAME = 100, MAX_SERVER_CSV = 1024 * 1024;
// A rule with www covers two names: the bare domain and its www name. It is stored under the bare domain.
const ruleNames = rule => (rule.www ? [rule.domain, `www.${rule.domain}`] : [rule.domain]);
function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length > 500) throw new Error('Up to 500 domain rules are allowed.');
  const seen = new Set();
  return rules.map(rule => {
    if (!rule || typeof rule.domain !== 'string' || typeof rule.ip !== 'string') throw new Error('Enter a domain and IP address.');
    const input = rule.domain.trim().replace(/\.$/, '').toLowerCase();
    if (/[\s,/:*\\?#@]/u.test(input)) throw new Error('Enter only the domain name, without https:// or a path.');
    const www = rule.www === true, ascii = domainToASCII(input);
    const domain = www && ascii.startsWith('www.') && ascii.split('.').length > 2 ? ascii.slice(4) : ascii;
    if (!domain || domain.length > (www ? 249 : 253) || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Invalid domain name.');
    const ip = rule.ip.trim();
    if (!isIP(ip) || ip.includes('%')) throw new Error('Use a valid IPv4 or IPv6 address without a port.');
    const valid = www ? { domain, ip, enabled: rule.enabled !== false, www } : { domain, ip, enabled: rule.enabled !== false };
    for (const name of ruleNames(valid)) { if (seen.has(name)) throw new Error(`${name} is already in the list.`); seen.add(name); }
    return valid;
  });
}
// One entry per name, so a lookup by host name also finds the www name of a rule.
const expandRules = rules => rules.flatMap(rule => ruleNames(rule).map(domain => ({ domain, ip: rule.ip, enabled: rule.enabled })));
function resolverRules(rules) {
  return expandRules(validateRules(rules)).filter(r => r.enabled).map(r => `MAP ${r.domain} ${isIP(r.ip) === 6 ? `[${r.ip}]` : r.ip}`).join(', ');
}
// Server list for picking an IP address by name. Entries that are not a name with an IP address are dropped, so a damaged list never blocks the rules.
const serverIP = value => typeof value === 'string' && isIP(value) > 0 && !value.includes('%');
function validServers(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter(server => {
    const name = server?.name, key = typeof name === 'string' && name.toLowerCase();
    if (!key || name !== name.trim() || name.length > MAX_SERVER_NAME || /[\u0000-\u001f\u007f]/.test(name) || !serverIP(server.ip) || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, MAX_SERVERS).map(({ name, ip }) => ({ name, ip }));
}
// One server per line, cells split by comma, semicolon or tab: the cell that is an IP address is the address, the first other cell is the name.
// Limit: no quoted separators and no column choice; with extra columns the first cell that is not an address is the name.
function parseServers(text) {
  const rows = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map(line => {
    const cells = line.split(/[,;\t]/).map(cell => cell.trim().replace(/^"(.*)"$/, '$1').trim()), ip = cells.find(serverIP);
    return { name: cells.find(cell => cell && cell !== ip), ip };
  });
  const servers = validServers(rows), header = rows.length && !rows[0].ip ? 1 : 0; // a first line without an IP address is the header
  return { servers, skipped: rows.length - header - servers.length };
}
function navigationURL(input) {
  if (typeof input !== 'string' || input.length > 16384) throw new Error('Invalid web address.');
  const value = input.trim();
  if (value === 'about:blank' || !value) return 'about:blank';
  if (/^(javascript|file|data|chrome|devtools|blob|vbscript):/i.test(value)) throw new Error('Only http and https addresses are allowed.');
  let url;
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); } catch { throw new Error('Invalid web address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Use an http or https address without credentials.');
  return url.href;
}
// Compare: the ratio is the share of the left pane. Each pane keeps at least a quarter, a 6 px bar sits between them.
const compareShare = value => (Number.isFinite(value) ? Math.max(.25, Math.min(.75, value)) : .5);
function compareLayout(width, ratio) {
  const left = Math.max(1, Math.round(width * compareShare(ratio)) - 3);
  return { left: { x: 0, width: left }, splitter: { x: left, width: 6 }, right: { x: left + 6, width: Math.max(1, width - left - 6) } };
}
function devtoolsLayout(width, height, sidebar, dock, ratio, open) {
  const page = { x: 0, y: 132, width: Math.max(1, width - sidebar), height: Math.max(1, height - 162) };
  if (!open) return { page, bar: null, tools: null, splitter: null };
  const vertical = dock !== 'bottom';
  const total = vertical ? page.width : page.height;
  const size = Math.max(1, Math.min(total - (vertical ? 206 : 126), Math.max(vertical ? 220 : 180, Math.round(total * ratio))));
  let bar, tools, splitter;
  if (!vertical) {
    page.height -= size + 6;
    splitter = { x: 0, y: page.y + page.height, width: page.width, height: 6 };
    bar = { x: 0, y: splitter.y + 6, width: page.width, height: 32 };
    tools = { x: 0, y: bar.y + 32, width: page.width, height: size - 32 };
  } else {
    const fullWidth = page.width;
    page.width -= size + 6;
    const x = dock === 'left' ? 0 : page.width + 6;
    if (dock === 'left') page.x = size + 6;
    bar = { x, y: 132, width: size, height: 32 };
    tools = { x, y: 164, width: size, height: page.height - 32 };
    splitter = { x: dock === 'left' ? size : fullWidth - size - 6, y: 132, width: 6, height: page.height };
  }
  return { page, bar, tools, splitter };
}
function readSettings(file) {
  if (!fs.existsSync(file)) return { rules: [], tabs: ['about:blank'], updateFeed: '', autoUpdates: true, autoUpdatesChosen: false, devtoolsDock: 'bottom', devtoolsRatio: .4, compareRatio: .5, sslVerification: false, servers: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { sslVerification: data.sslVerification === true, rules: validateRules(data.rules), servers: validServers(data.servers), tabs: Array.isArray(data.tabs) && data.tabs.length ? data.tabs.slice(0, 50).map(navigationURL) : ['about:blank'], updateFeed: typeof data.updateFeed === 'string' ? data.updateFeed : '', autoUpdates: data.autoUpdatesChosen === true ? data.autoUpdates !== false : true, autoUpdatesChosen: data.autoUpdatesChosen === true, devtoolsDock: ['left', 'right', 'bottom'].includes(data.devtoolsDock) ? data.devtoolsDock : 'bottom', devtoolsRatio: Number.isFinite(data.devtoolsRatio) ? Math.max(.2, Math.min(.7, data.devtoolsRatio)) : .4, compareRatio: compareShare(data.compareRatio) };
}
function saveSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
// Only the fields the certificate details card shows; names come from the server, so they are capped.
function certSummary(cert) {
  if (!cert || !Number.isFinite(cert.validStart) || !Number.isFinite(cert.validExpiry)) return null;
  const text = value => String(value || '').slice(0, 200);
  return { subject: text(cert.subject?.commonName || cert.subjectName), issuer: text(cert.issuer?.organizations?.[0] || cert.issuer?.commonName || cert.issuerName), issuerName: text(cert.issuer?.commonName), validFrom: cert.validStart * 1000, expires: cert.validExpiry * 1000 };
}
// Name for a pure DNS PTR query. dns.reverse() also reads the hosts file, which is exactly what a migration tester has filled with site names.
function ptrName(ip) {
  ip = String(ip || '').replace(/^\[|\]$/g, '').replace(/^::ffff:(?=\d+\.)/i, '');
  if (isIP(ip) === 4) return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  if (isIP(ip) !== 6) return '';
  const [head, tail = ''] = ip.split('%')[0].split('::'), left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.map(g => g.padStart(4, '0')).join('').split('').reverse().join('.')}.ip6.arpa`;
}
const daysLeft = (expires, now = Date.now()) => Math.floor((expires - now) / 86400000);
module.exports = { ptrName, certSummary, daysLeft, ROUTE_BAR_HEIGHT, DEFAULT_UPDATE_FEED, RELEASE_PAGE, devtoolsLayout, compareLayout, compareShare, validateRules, expandRules, resolverRules, validServers, parseServers, MAX_SERVER_CSV, navigationURL, readSettings, saveSettings };
