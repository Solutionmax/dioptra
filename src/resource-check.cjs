// Files that did not load: what really failed while a page loaded in one pane (files, background requests,
// JavaScript errors) and how the two panes of one page differ. Pure logic without Electron: main.cjs feeds it
// webRequest details and console messages and keeps one record per pane; the window UI only gets plain data.
const { STATUS_CODES } = require('node:http');

const MAX_FILES = 200, MAX_ERRORS = 20, MAX_LOADED = 2000, MAX_TEXT = 300, MAX_URL = 2000;
// Electron resource types that count as a file of the page. The page itself, pings and CSP reports do not.
const TYPES = { stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font', xhr: 'background request', media: 'media', subFrame: 'frame', object: 'object', webSocket: 'websocket', other: 'other' };
// The words Chromium uses for the kind of request in its console messages.
const CONSOLE_TYPES = { script: 'script', stylesheet: 'stylesheet', style: 'stylesheet', font: 'font', image: 'image', video: 'media', audio: 'media', frame: 'frame', iframe: 'frame', fetch: 'background request', xmlhttprequest: 'background request', 'xmlhttprequest endpoint': 'background request' };
// Not a failing file: the page or the browser cancelled the request, or Chromium only looked in its cache first (fonts).
const IGNORED_ERRORS = new Set(['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_CACHE_MISS']);
// One file can fail in two ways at once (a CORS refusal is also a network error); the most telling reason stays.
const RANK = { http: 4, refused: 3, cors: 2, mixed: 2, network: 1 };
const FIREWALL = /imunify|webshield|sucuri|cloudflare|modsecurity|wordfence|bitninja|firewall|\bwaf\b/i;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

const clean = text => String(text ?? '').replace(CONTROL, '');
const fileKey = url => { try { const u = new URL(url); u.hash = ''; return u.href; } catch { return String(url || ''); } };
const sameDocument = (a, b) => Boolean(a && b) && fileKey(a) === fileKey(b);
const webURL = url => /^(https?|wss?):\/\//i.test(String(url || ''));
// Header lookup that ignores case: HTTP/1.1 keeps the server's spelling, HTTP/2 sends lower case.
function header(headers, name) {
  for (const [key, value] of Object.entries(headers || {})) if (key.toLowerCase() === name) return String((Array.isArray(value) ? value[0] : value) ?? '').slice(0, 200);
  return '';
}
// "imunify360-webshield/1.21" becomes "imunify360-webshield": the product names the server, the version is noise.
const serverName = value => String(value || '').trim().split(/[\s/]/)[0].slice(0, 80);
const statusText = code => `${code} ${STATUS_CODES[code] || ''}`.trim();

function createRecord() { return { failures: new Map(), loaded: new Map(), old: new Map(), errors: new Map(), dropped: 0, pageServer: '' }; }
const entry = (url, type, rest) => ({ key: fileKey(url), url: String(url).slice(0, MAX_URL), type, ...rest });

// webRequest onResponseStarted (headers are in): a failed file, or the status of a file that loaded.
function responseOutcome(details) {
  const type = TYPES[details?.resourceType];
  if (!type || !webURL(details.url)) return null;
  const code = Number(details.statusCode) || 0;
  if (code >= 400) return entry(details.url, type, { failed: true, kind: 'http', status: statusText(code), code, server: serverName(header(details.responseHeaders, 'server')) });
  // Chromium refuses such a stylesheet without a console message (Electron 45), so the headers tell.
  const mime = header(details.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
  if (type === 'stylesheet' && code >= 200 && code < 300 && mime && mime !== 'text/css') return entry(details.url, type, { failed: true, kind: 'refused', status: 'Refused: not CSS', why: `server sent ${mime} with ${code}`, mime });
  return entry(details.url, type, { failed: false, status: code ? statusText(code) : 'loaded' });
}
function networkLabel(error) {
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION/.test(error)) return 'Host not found';
  if (/CONNECTION_REFUSED/.test(error)) return 'Connection refused';
  if (/TIMED_OUT/.test(error)) return 'Timed out';
  if (/CERT_|SSL_/.test(error)) return 'Certificate error';
  if (/BLOCKED_BY_(ORB|RESPONSE)/.test(error)) return 'Blocked by the browser';
  return 'Network error';
}
// webRequest onErrorOccurred.
function errorOutcome(details) {
  const type = TYPES[details?.resourceType], error = String(details?.error || '');
  if (!type || !webURL(details.url) || !error || IGNORED_ERRORS.has(error)) return null;
  return entry(details.url, type, { failed: true, kind: 'network', status: networkLabel(error), why: error.slice(0, 80) });
}

const CORS = /^Access to (.+?) at '([^']+)' from origin '[^']*' has been blocked by CORS policy:\s*([\s\S]*)$/;
const MIXED = /^Mixed Content: [\s\S]*?requested an insecure ([\w ]+?) '([^']+)'\. This (?:request|content) has been blocked/;
const REFUSED = /^Refused to (apply style|execute script) from '([^']+)' because its MIME type \('([^']*)'\)/;
function corsReason(text) {
  if (/No 'Access-Control-Allow-Origin' header/i.test(text)) return 'no Access-Control-Allow-Origin';
  if (/preflight/i.test(text)) return 'preflight request refused';
  if (/'Access-Control-Allow-Origin' header (?:has a value|contains multiple)/i.test(text)) return 'wrong Access-Control-Allow-Origin';
  if (/credentials/i.test(text)) return 'credentials not allowed';
  return 'refused by CORS policy';
}
const consoleFile = (url, word, rest) => (webURL(url) ? { file: entry(url, CONSOLE_TYPES[word.toLowerCase()] || 'other', { failed: true, ...rest }) } : null);
const stripHosts = text => text.replace(/\b(?:https?|wss?):\/\/[^/\s'")]+/gi, '').replace(/:\d+(?::\d+)?\b/g, '');
// Same error on both servers: compare without host names and line numbers, which differ between copies of a site.
function errorKey(text, source) {
  let path = ''; try { path = new URL(source).pathname; } catch {}
  return `${stripHosts(text).replace(/\s+/g, ' ').trim()}|${path}`;
}
// A console message of a pane: a file the browser refused (CORS, mixed content, wrong type), a JavaScript error, or nothing.
// Only level error counts; "Slow network is detected" (info) and Electron's security warnings are noise.
function consoleOutcome(message) {
  if (!message || !['error', 3].includes(message.level)) return null;
  const text = String(message.message || '').slice(0, 4000);
  let m;
  if ((m = text.match(CORS))) return consoleFile(m[2], m[1], { kind: 'cors', status: 'Blocked by CORS', why: corsReason(m[3]) });
  if ((m = text.match(MIXED))) return consoleFile(m[2], m[1], { kind: 'mixed', status: 'Blocked: http on https', why: '' });
  if ((m = text.match(REFUSED))) {
    const style = m[1] === 'apply style';
    return consoleFile(m[2], style ? 'stylesheet' : 'script', { kind: 'refused', status: style ? 'Refused: not CSS' : 'Refused: not JavaScript', why: `server sent ${m[3] || 'no type'}`, mime: m[3] });
  }
  // The failing request itself is recorded from the network side.
  if (/^Failed to load resource\b/.test(text)) return null;
  const source = String(message.sourceId || '');
  if (/^(chrome-extension|devtools|node|electron):/i.test(source)) return null;
  return { error: { key: errorKey(text, source), message: text.slice(0, MAX_TEXT), source: source.slice(0, MAX_URL), line: Number(message.lineNumber) || 0 } };
}

// Records are written for every request, so they change in place; the views below build new objects.
function recordFailure(record, item) {
  const known = record.failures.get(item.key);
  if (known) { if ((RANK[item.kind] || 0) > (RANK[known.kind] || 0)) record.failures.set(item.key, { ...item, type: item.type === 'other' ? known.type : item.type }); return; }
  if (record.failures.size >= MAX_FILES) { record.dropped++; return; }
  record.failures.set(item.key, item);
}
function recordLoaded(record, item) { if (record.loaded.has(item.key) || record.loaded.size < MAX_LOADED) record.loaded.set(item.key, item.status); }
function recordOld(record, item) { if (!record.old.has(item.key) && record.old.size < MAX_FILES) record.old.set(item.key, item); }
function recordError(record, item) {
  const known = record.errors.get(item.key);
  if (known) record.errors.set(item.key, { ...known, count: known.count + 1 });
  else if (record.errors.size < MAX_ERRORS) record.errors.set(item.key, { ...item, count: 1 });
}

// Counts for the chips of one pane. other: the record of the other pane on the same page, or null.
function paneSummary(own, other) {
  const failures = [...own.failures.values()], both = other ? failures.filter(f => other.failures.has(f.key)).length : 0;
  return { failed: failures.length - both, both, old: own.old.size, oldHosts: [...new Set([...own.old.values()].map(o => o.host))].slice(0, 5), compared: Boolean(other) };
}
function fileName(url) {
  try { const u = new URL(url), last = u.pathname.split('/').filter(Boolean).pop(); return clean(last ? decodeURIComponent(last) : u.hostname).slice(0, 120); } catch { return clean(url).slice(0, 120); }
}
// Path as the mockup shows it: same host and scheme as the page = path and query, other host = host and path, http on https = the full URL.
function displayPath(url, pageURL) {
  try {
    const u = new URL(url), page = new URL(pageURL), path = u.pathname + u.search;
    return clean(u.protocol !== page.protocol ? u.href : u.host === page.host ? path : u.host + path).slice(0, 400);
  } catch { return clean(url).slice(0, 400); }
}
function cell(f, pageServer) {
  const server = f.kind === 'http' && f.server && f.server.toLowerCase() !== serverName(pageServer).toLowerCase() ? f.server : '';
  return { failed: true, kind: f.kind, status: f.status, why: clean(f.why || server), code: f.code || 0, mime: f.mime || '' };
}
function shortReason(c) {
  if (c.kind === 'cors') return 'CORS';
  if (c.kind === 'mixed') return 'http on https';
  if (c.kind === 'http') return String(c.code);
  if (c.kind === 'refused') return c.status.replace(/^Refused: /, '');
  return c.why.replace(/^net::/, '') || c.status;
}
const typeWord = (type, n) => {
  const words = { stylesheet: ['stylesheet', 'stylesheets'], script: ['script', 'scripts'], image: ['image', 'images'], font: ['font', 'fonts'], 'background request': ['background request', 'background requests'] }[type] || ['file', 'files'];
  return n === 1 ? words[0] : words[1];
};
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);
function oldGroups(record, pageURL) {
  const groups = new Map();
  for (const o of record.old.values()) {
    const g = groups.get(o.host) || { host: o.host, ip: o.ip, ptr: o.ptr || '', files: [] };
    if (!g.ptr && o.ptr) g.ptr = o.ptr;
    g.files.push({ name: fileName(o.url), path: displayPath(o.url, pageURL), url: o.url, type: o.type, ip: o.ip, ptr: o.ptr || '' });
    groups.set(o.host, g);
  }
  return [...groups.values()];
}
function findings(view) {
  if (!view.measured) return [];
  const out = [], covered = new Set(), only = view.rows.filter(r => r.side === 'hostfile');
  const add = (severity, title, detail = '') => out.push({ severity, title, detail });
  const css = only.find(r => r.type === 'stylesheet' && r.hostfile.kind !== 'refused');
  if (css) {
    covered.add(css);
    add('high', `Stylesheet ${css.name} fails on Hostfile (${css.hostfile.status})${css.live.status === 'Not requested' ? '' : ' but loads on Live'}.`, 'Pages on the new server look unstyled.');
  }
  const refused = only.find(r => r.type === 'stylesheet' && r.hostfile.kind === 'refused');
  if (refused) {
    covered.add(refused);
    const mime = refused.hostfile.mime;
    add('high', `Stylesheet ${refused.name} is refused on Hostfile.`, `The new server sends ${!mime ? 'no content type' : mime === 'text/html' ? 'a text/html page' : mime} instead of CSS.`);
  }
  const old = view.old.flatMap(g => g.files);
  if (old.length) {
    const type = old.every(f => f.type === old[0].type) ? old[0].type : 'file', hosts = view.old.map(g => g.host);
    add('high', `${old.length} ${typeWord(type, old.length)} on the new server pane ${old.length === 1 ? 'comes' : 'come'} from the old server.`,
      `${hosts.slice(0, 3).join(', ')}${hosts.length > 3 ? ' and more' : ''} ${hosts.length === 1 ? 'has' : 'have'} no domain rule. ${old.length === 1 ? 'It breaks' : 'They break'} when the old server goes away.`);
  }
  if (view.errors.length) {
    const first = view.errors[0], short = first.message.replace(/^Uncaught (?:\(in promise\) )?(?:\w*Error: )?/, '').replace(/\.$/, '');
    const name = (short.match(/^([\w$.]+) is not defined/) || [])[1]?.toLowerCase(), script = name && only.find(r => r.type === 'script' && r.name.toLowerCase().includes(name));
    let detail = '';
    if (script) {
      covered.add(script);
      detail = FIREWALL.test(script.hostfile.why) ? `${script.name} is blocked by the firewall (${script.hostfile.code || script.hostfile.status}, ${script.hostfile.why}).` : `${script.name} did not load on Hostfile (${script.hostfile.status}).`;
    }
    add('high', view.errors.length === 1 ? `JavaScript error only on Hostfile: ${short}.` : `${view.errors.length} JavaScript errors only on Hostfile. First: ${short}.`, detail);
  }
  const rest = only.filter(r => !covered.has(r));
  if (rest.length) {
    const list = rest.slice(0, 4).map(r => `${r.name} (${shortReason(r.hostfile)})`).join(', ') + (rest.length > 4 ? ', …' : '');
    add('high', `${rest.length}${covered.size ? ' more' : ''} ${rest.length === 1 ? 'file fails' : 'files fail'} only on Hostfile: ${list}.`);
  }
  const both = view.rows.filter(r => r.side === 'both');
  if (both.length === 1) {
    const r = both[0], what = capital(typeWord(r.type, 1));
    add('both', r.hostfile.kind === 'mixed' ? `${what} ${r.name} is blocked on both servers: http on an https page.` : `${what} ${r.name} fails on both servers (${r.hostfile.status}).`);
  } else if (both.length) add('both', `${both.length} files fail on both servers: ${both.slice(0, 4).map(r => r.name).join(', ')}${both.length > 4 ? ', …' : ''}.`);
  return out;
}
// Everything the Files tab of Differences shows. live = null when the Live side did not load this page.
function filesView({ hostfile, live, pageURL, ruleIP = '', measuring = false }) {
  const old = oldGroups(hostfile, pageURL), view = { measured: Boolean(live), measuring, ruleIP, rows: [], old, errors: [], dropped: hostfile.dropped + (live?.dropped || 0) };
  if (live) {
    const row = (f, side, h, l) => ({ key: f.key, url: f.url, name: fileName(f.url), path: displayPath(f.url, pageURL), type: f.type, canOpen: /^https?:/i.test(f.url), side, hostfile: h, live: l });
    const missing = (record, key) => ({ failed: false, status: record.loaded.get(key) || 'Not requested' });
    for (const f of hostfile.failures.values()) {
      const lf = live.failures.get(f.key);
      view.rows.push(row(f, lf ? 'both' : 'hostfile', cell(f, hostfile.pageServer), lf ? cell(lf, live.pageServer) : missing(live, f.key)));
    }
    for (const lf of live.failures.values()) if (!hostfile.failures.has(lf.key)) view.rows.push(row(lf, 'live', missing(hostfile, lf.key), cell(lf, live.pageServer)));
    const order = { hostfile: 0, both: 1, live: 2 };
    view.rows.sort((a, b) => order[a.side] - order[b.side]);
    view.errors = [...hostfile.errors.values()].filter(e => !live.errors.has(e.key)).map(e => ({ message: clean(e.message), source: `${e.source ? displayPath(e.source, pageURL) : 'unknown source'}${e.line ? `:${e.line}` : ''}`, count: e.count }));
  }
  view.counts = { only: view.rows.filter(r => r.side === 'hostfile').length, both: view.rows.filter(r => r.side === 'both').length, liveOnly: view.rows.filter(r => r.side === 'live').length, old: old.reduce((n, g) => n + g.files.length, 0), errors: view.errors.length };
  view.findings = findings(view);
  return view;
}
const SIDE = { hostfile: 'only Hostfile', both: 'on both', live: 'only Live' };
const status = c => `${c.status}${c.why ? ` (${c.why})` : ''}`;
// Plain text of the Files tab, for the clipboard and inside the untrusted block of "Ask Claude".
function filesLines(view) {
  if (!view) return [];
  const lines = ['Files that did not load (measured in the Hostfile and Live panes):'];
  if (!view.measured) lines.push('- not measured, open Compare to measure files');
  else lines.push(...(view.rows.length ? view.rows.map(r => `- ${r.url} (${r.type}): Hostfile ${status(r.hostfile)}, Live ${status(r.live)} [${SIDE[r.side]}]`) : ['- none']));
  if (view.old.length) {
    lines.push('', 'Loaded from the old server (no domain rule for these hosts):');
    for (const g of view.old) for (const f of g.files) lines.push(`- ${f.url} (${f.type}) from ${f.ip}${f.ptr ? ` (${f.ptr})` : ''}`);
  }
  if (view.errors.length) lines.push('', 'JavaScript errors only on Hostfile:', ...view.errors.map(e => `- ${e.message} (${e.source})${e.count > 1 ? ` ${e.count} times` : ''}`));
  return lines.map(clean);
}
function filesText(view, pageURL) { return [`Dioptra: files that did not load on ${clean(pageURL)}`, '', ...filesLines(view)].join('\n').replace(CONTROL, ''); }

module.exports = { MAX_FILES, MAX_ERRORS, createRecord, responseOutcome, errorOutcome, consoleOutcome, recordFailure, recordLoaded, recordOld, recordError, paneSummary, filesView, filesLines, filesText, displayPath, fileName, header, serverName, sameDocument, fileKey };
