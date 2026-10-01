const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { domainToASCII } = require('node:url');

const ROUTE_BAR_HEIGHT = 36;
const DEFAULT_UPDATE_FEED = 'https://github.com/Solutionmax/dioptra/releases/latest/download/';
const RELEASE_PAGE = 'https://github.com/Solutionmax/dioptra/releases/latest';
function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length > 500) throw new Error('Up to 500 domain rules are allowed.');
  const seen = new Set();
  return rules.map(rule => {
    if (!rule || typeof rule.domain !== 'string' || typeof rule.ip !== 'string') throw new Error('Enter a domain and IP address.');
    const input = rule.domain.trim().replace(/\.$/, '').toLowerCase();
    if (/[\s,/:*\\?#@]/u.test(input)) throw new Error('Enter only the domain name, without https:// or a path.');
    const domain = domainToASCII(input);
    if (!domain || domain.length > 253 || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Invalid domain name.');
    const ip = rule.ip.trim();
    if (!isIP(ip) || ip.includes('%')) throw new Error('Use a valid IPv4 or IPv6 address without a port.');
    if (seen.has(domain)) throw new Error(`${domain} is already in the list.`);
    seen.add(domain);
    return { domain, ip, enabled: rule.enabled !== false };
  });
}
function resolverRules(rules) {
  return validateRules(rules).filter(r => r.enabled).map(r => `MAP ${r.domain} ${isIP(r.ip) === 6 ? `[${r.ip}]` : r.ip}`).join(', ');
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
  if (!fs.existsSync(file)) return { rules: [], tabs: ['about:blank'], updateFeed: '', autoUpdates: true, autoUpdatesChosen: false, devtoolsDock: 'bottom', devtoolsRatio: .4, sslVerification: false };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { sslVerification: data.sslVerification === true, rules: validateRules(data.rules), tabs: Array.isArray(data.tabs) && data.tabs.length ? data.tabs.slice(0, 50).map(navigationURL) : ['about:blank'], updateFeed: typeof data.updateFeed === 'string' ? data.updateFeed : '', autoUpdates: data.autoUpdatesChosen === true ? data.autoUpdates !== false : true, autoUpdatesChosen: data.autoUpdatesChosen === true, devtoolsDock: ['left', 'right', 'bottom'].includes(data.devtoolsDock) ? data.devtoolsDock : 'bottom', devtoolsRatio: Number.isFinite(data.devtoolsRatio) ? Math.max(.2, Math.min(.7, data.devtoolsRatio)) : .4 };
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
module.exports = { ptrName, certSummary, daysLeft, ROUTE_BAR_HEIGHT, DEFAULT_UPDATE_FEED, RELEASE_PAGE, devtoolsLayout, validateRules, resolverRules, navigationURL, readSettings, saveSettings };
