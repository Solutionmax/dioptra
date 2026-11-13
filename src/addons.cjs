// Add-ons (1.4): extra tools that live outside the app, installed with a personal code and updated from their own feed.
// An add-on is one signed manifest (addon.json + addon.json.sig), one code file and one data file. Dioptra runs the code
// in its main process, so the one rule is: nothing runs unless the manifest carries SolutionMAX's signature and both
// files match the hashes in that manifest. This is checked on install, on every update and again on every start.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

// SolutionMAX add-on signing key (ed25519, SPKI DER, base64). The private half never leaves the release machine.
const ADDON_PUBLIC_KEY = 'MCowBQYDK2VwAyEAH3+EAPc/esZsNw+UcXO2MVGCXe5aW/ZveX/nuHiLrPE=';
const FORMAT = 1, API = 1;
const MAX_MANIFEST = 64 * 1024, MAX_SIG = 512, MAX_FILE = 8 * 1024 * 1024, FEED_TIMEOUT_MS = 20000, SCAN_TIMEOUT_MS = 30000;
// Requests one scan may make to each server. 30: WP Leak Check asks up to 26 addresses of a server (1.4.0-beta.3; it was 8 for
// both servers together). Counted per server, so what the new server uses does not come out of what Live may be asked.
const MAX_FETCHES_PER_SIDE = 30, CODE_PREFIX = 'DIOPTRA-';
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/, FILE = /^[a-z0-9][a-z0-9._-]{0,63}$/, VERSION = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})(?:-beta\.(\d{1,5}))?$/, SHA256 = /^[0-9a-f]{64}$/;

class AddonError extends Error {}
const fail = message => { throw new AddonError(message); };
// Text from a manifest or a report: one line, capped, and nothing that makes it read differently from what it is
// (control characters, zero width and bidi marks): a command shown on screen must be the command that is copied.
// Characters that show nothing or change the direction of the text: C1 controls, zero width and bidi marks, the Arabic
// letter mark, the Hangul and Mongolian fillers, and the tag characters (U+E0000 to U+E007F).
const HIDDEN = /[\u0080-\u009f\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// What is copied to a terminal: printable ASCII and the newline, nothing that can look like another character.
const ascii = value => String(value ?? '').replace(/[^\x20-\x7e\n]/g, '');
const text = (value, max) => String(value ?? '').replace(HIDDEN, '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// 1.4.0-beta.2 < 1.4.0: a release is newer than its own betas.
function compareVersions(a, b) {
  const pa = VERSION.exec(a), pb = VERSION.exec(b);
  if (!pa || !pb) fail('Not a version number.');
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
  const ba = pa[4] === undefined ? Infinity : Number(pa[4]), bb = pb[4] === undefined ? Infinity : Number(pb[4]);
  return ba === bb ? 0 : ba < bb ? -1 : 1;
}

// A feed address: https on a named host, no credentials, query or fragment, ending in a slash. Plain http is only for a
// test on this computer; a bare IP address is refused, so a pasted code cannot make Dioptra call a device on the LAN.
function feedAddress(value, allowLocal) {
  let url;
  try { url = new URL(String(value)); } catch { fail('This is not an add-on code.'); }
  const local = allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) fail('The add-on address must use https.');
  if (url.username || url.password || url.search || url.hash) fail('This is not an add-on code.');
  if (!local && (/^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[') || !url.hostname.includes('.'))) fail('The add-on address must be a host name.');
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}
const TOKEN = /^[A-Za-z0-9._~-]{16,200}$/;
// The personal code holds where the add-on lives and the key to it.
function parseCode(input, { allowLocal = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw.startsWith(CODE_PREFIX) || raw.length > 2000) fail('This is not an add-on code.');
  let data;
  try { data = JSON.parse(Buffer.from(raw.slice(CODE_PREFIX.length), 'base64url').toString('utf8')); } catch { fail('This is not an add-on code.'); }
  const url = feedAddress(data?.u, allowLocal), token = String(data?.t ?? '');
  if (!TOKEN.test(token)) fail('This is not an add-on code.');
  return { url, token };
}
const makeCode = (url, token) => CODE_PREFIX + Buffer.from(JSON.stringify({ u: url, t: token })).toString('base64url');

function cleanFile(entry, what) {
  if (!entry || !FILE.test(String(entry.file)) || !SHA256.test(String(entry.sha256)) || !Number.isInteger(entry.size) || entry.size < 1 || entry.size > MAX_FILE) fail(`The add-on manifest has no valid ${what} file.`);
  return { file: entry.file, sha256: entry.sha256, size: entry.size };
}
const lines = (list, max) => (Array.isArray(list) ? list : []).slice(0, max).map(x => text(x, 160)).filter(Boolean);
function cleanManifest(value) {
  if (!value || typeof value !== 'object' || value.format !== FORMAT) fail('This add-on needs a newer Dioptra.');
  if (!ID.test(String(value.id))) fail('The add-on manifest has no valid id.');
  if (!VERSION.test(String(value.version))) fail('The add-on manifest has no valid version.');
  if (!VERSION.test(String(value.minDioptra))) fail('The add-on manifest does not say which Dioptra it needs.');
  const code = cleanFile(value.code, 'code'), data = cleanFile(value.data, 'data');
  if (code.file === data.file) fail('The add-on manifest names one file twice.');
  const name = text(value.name, 60), tab = text(value.tab?.label, 24);
  if (!name || !tab) fail('The add-on manifest has no name.');
  // scope site: scanned once per whole-site run (on the home page) instead of on every page. Older manifests have no scope: page.
  return { id: value.id, name, by: text(value.by, 60), version: value.version, minDioptra: value.minDioptra, scope: value.scope === 'site' ? 'site' : 'page',
    tab: { label: tab, sub: text(value.tab?.sub, 80) }, adds: lines(value.adds, 6), may: lines(value.may, 6), code,
    data: { ...data, version: text(value.data.version, 24), label: text(value.data.label, 24) || 'Threat list', rules: Number.isInteger(value.data.rules) && value.data.rules >= 0 ? value.data.rules : 0 } };
}

// The signature covers the exact bytes of addon.json. Anything else (no signature, another key, one changed byte) fails.
function verifyManifest(bytes, signature, publicKey = ADDON_PUBLIC_KEY) {
  const refused = 'This add-on is not signed by SolutionMAX, or it was changed after signing. Nothing from it was run.';
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MANIFEST) fail(refused);
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    const sig = Buffer.from(String(signature).trim(), 'base64');
    ok = key.asymmetricKeyType === 'ed25519' && sig.length === 64 && crypto.verify(null, bytes, key, sig);
  } catch { ok = false; }
  if (!ok) fail(refused);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(refused); }
  return cleanManifest(value);
}
function checkFile(bytes, entry) {
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) fail(`${entry.file} does not match the signed manifest. Nothing from it was run.`);
  return bytes;
}

/* What an add-on returns is drawn by Dioptra. The add-on is signed, but its strings come from web pages: keep the
   shape, cap every string, drop the rest. */
const TONES = new Set(['bad', 'warn', 'ok']);
const count = n => (Number.isInteger(n) && n >= 0 && n < 10000 ? n : 0);
function cleanItem(item, sides) {
  const values = {}, bad = {};
  for (const side of sides) { values[side] = text(item?.values?.[side], 160); bad[side] = item?.bad?.[side] === true; }
  const fix = (Array.isArray(item?.fix) ? item.fix : []).slice(0, 12).map(x => (x && typeof x === 'object' ? { code: text(ascii(x.code), 160) } : String(x ?? '').replace(HIDDEN, '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').slice(0, 300)));
  const commands = (Array.isArray(item?.commands) ? item.commands : []).slice(0, 12).map(c => ({ found: text(c?.found, 200), where: text(c?.where, 200), command: text(ascii(c?.command), 400) }));
  const action = item?.action && text(ascii(item.action.text), 4000) ? { label: text(item.action.label, 24) || 'Copy', text: ascii(item.action.text).slice(0, 4000) } : null;
  return { title: text(item?.title, 200), tone: item?.tone === 'worse' ? 'worse' : 'differs', values, bad, fix, commands, action };
}
function cleanReport(report, sides) {
  if (!report || typeof report !== 'object') fail('The add-on gave no result.');
  const groups = (Array.isArray(report.groups) ? report.groups : []).slice(0, 12).map((g, n) => ({
    id: ID.test(String(g?.id)) ? g.id : `g${n}`, label: text(g?.label, 40),
    items: (Array.isArray(g?.items) ? g.items : []).slice(0, 20).map(item => cleanItem(item, sides)),
  })).filter(g => g.label && g.items.length);
  groups.forEach(g => g.items.forEach((item, i) => { item.id = `${g.id}-${i}`; }));
  const counts = { problems: count(report.counts?.problems), differ: count(report.counts?.differ), passed: count(report.counts?.passed), total: count(report.counts?.total) };
  return {
    sides: [...sides], label: counts.problems ? text(report.label, 16) : '', tone: report.tone === 'warn' ? 'warn' : 'bad', counts, sub: text(report.sub, 160), groups,
    summary: (Array.isArray(report.summary) ? report.summary : []).slice(0, 4).map(s => ({ tone: TONES.has(s?.tone) ? s.tone : 'ok', text: text(s?.text, 40) })).filter(s => s.text),
    passed: (Array.isArray(report.passed) ? report.passed : []).slice(0, 40).map(p => ({ name: text(p?.name, 60) })).filter(p => p.name),
    note: text(report.note, 400),
  };
}
// Lines for Ask Claude: they go inside the untrusted block of the summary.
function reportLines(name, report) {
  if (!report) return [];
  const c = report.counts, warn = report.tone === 'warn', out = [`${name} (${c.problems} ${warn ? 'problems' : 'threats'}, ${c.differ} ${warn ? 'differences' : 'warnings'}, ${c.passed} ${warn ? 'fine' : 'clean'}):`];
  for (const g of report.groups) for (const item of g.items) out.push(`- [${item.tone === 'worse' ? (warn ? 'problem' : 'threat') : (warn ? 'difference' : 'warning')}] ${g.label}: ${item.title}. ${report.sides.map(s => `${s === 'hostfile' ? 'Hostfile' : 'Live'} ${item.values[s] || 'n/a'}`).join('; ')}`);
  return out;
}

// One bounded download from the feed. The key goes in a header and only to the feed's own address: no redirects.
async function download(fetchImpl, base, token, file, max) {
  const target = new URL(file, base);
  if (!target.href.startsWith(base)) fail('The add-on feed names a file outside its own address.');
  let response;
  try { response = await fetchImpl(target.href, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(FEED_TIMEOUT_MS) }); }
  catch (error) { fail(`The add-on server could not be reached (${text(error?.cause?.code || error?.name || 'error', 40)}).`); }
  if (response.status === 401 || response.status === 403) fail('The add-on server does not accept this code. Ask for a new one.');
  if (!response.ok) fail(`The add-on server answered ${response.status} for ${file}.`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > max) fail(`${file} is larger than an add-on file may be.`); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}

/**
 * @param {{ dir: string, appVersion: string, publicKey?: string, fetchImpl?: typeof fetch, allowLocal?: boolean, load?: (file: string) => unknown, log?: (message: string) => void }} options
 */
// Compile the bytes that were just checked. require(path) would read the file a second time, and whoever can write
// the profile could swap it in between.
function compile(file, code) {
  const Module = require('node:module'), mod = new Module(file);
  mod.filename = file; mod.paths = [];
  mod._compile(code.toString('utf8'), file);
  return mod.exports;
}
function createAddons({ dir, appVersion, publicKey = ADDON_PUBLIC_KEY, fetchImpl = fetch, allowLocal = false, load = compile, log = () => {}, scanTimeoutMs = SCAN_TIMEOUT_MS }) {
  const installed = new Map(); // id -> { manifest, source, module, runSha, data, status, message, restart, update }
  let pending = null, queue = Promise.resolve();
  // Install, update, switch and remove all touch the same folders: one at a time, in the order they were asked.
  const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  const folder = id => path.join(dir, id);
  const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const writeFile = (file, bytes) => fs.writeFile(file, bytes, { mode: 0o600 });

  async function fetchSigned(source) {
    const bytes = await download(fetchImpl, source.url, source.token, 'addon.json', MAX_MANIFEST);
    const signature = (await download(fetchImpl, source.url, source.token, 'addon.json.sig', MAX_SIG)).toString('utf8');
    const manifest = verifyManifest(bytes, signature, publicKey);
    if (compareVersions(manifest.minDioptra, appVersion) > 0) fail(`${manifest.name} ${manifest.version} needs Dioptra ${manifest.minDioptra} or newer. Update Dioptra first.`);
    return { bytes, signature, manifest };
  }
  // Everything of one version lands in a fresh folder first; only a complete, checked set replaces the old one.
  async function store(source, signed, have = {}) {
    const { manifest } = signed, target = folder(manifest.id), fresh = `${target}.new`;
    const code = have.code || checkFile(await download(fetchImpl, source.url, source.token, manifest.code.file, MAX_FILE), manifest.code);
    const data = have.data || checkFile(await download(fetchImpl, source.url, source.token, manifest.data.file, MAX_FILE), manifest.data);
    try { JSON.parse(data.toString('utf8')); } catch { fail(`${manifest.data.file} is not valid data.`); }
    await fs.rm(fresh, { recursive: true, force: true });
    await fs.mkdir(fresh, { recursive: true, mode: 0o700 });
    await Promise.all([writeFile(path.join(fresh, 'addon.json'), signed.bytes), writeFile(path.join(fresh, 'addon.json.sig'), signed.signature),
      writeFile(path.join(fresh, manifest.code.file), code), writeFile(path.join(fresh, manifest.data.file), data),
      writeFile(path.join(fresh, 'source.json'), JSON.stringify({ ...source, checkedAt: new Date().toISOString() }))]);
    // The old set steps aside and only goes when the new one is in place; a start in between puts it back (loadAll).
    const old = `${target}.old`;
    await fs.rm(old, { recursive: true, force: true });
    const had = await fs.rename(target, old).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    try { await fs.rename(fresh, target); } catch (error) { if (had) await fs.rename(old, target).catch(() => {}); throw error; }
    await fs.rm(old, { recursive: true, force: true });
    return { code, data };
  }
  // Read one installed add-on from disk and check it again as if it had just arrived.
  async function readInstalled(id) {
    const target = folder(id), bytes = await fs.readFile(path.join(target, 'addon.json'));
    const manifest = verifyManifest(bytes, await fs.readFile(path.join(target, 'addon.json.sig'), 'utf8'), publicKey);
    if (manifest.id !== id) fail('The add-on folder does not match its manifest.');
    const code = checkFile(await fs.readFile(path.join(target, manifest.code.file)), manifest.code);
    const data = checkFile(await fs.readFile(path.join(target, manifest.data.file)), manifest.data);
    // source.json is not signed (it holds the personal key): the same rules as for a pasted code.
    const source = await readJSON(path.join(target, 'source.json'));
    if (!TOKEN.test(String(source.token))) fail('The add-on key on this computer is damaged. Install the add-on again with your code.');
    return { manifest, code, data: JSON.parse(data.toString('utf8')), source: { url: feedAddress(source.url, allowLocal), token: String(source.token), checkedAt: text(source.checkedAt, 40), enabled: source.enabled !== false } };
  }
  function start(entry) {
    if (compareVersions(entry.manifest.minDioptra, appVersion) > 0) fail(`Needs Dioptra ${entry.manifest.minDioptra} or newer.`);
    const mod = load(path.join(folder(entry.manifest.id), entry.manifest.code.file), entry.code);
    if (!mod || mod.api !== API || typeof mod.scan !== 'function') fail('This add-on was made for another Dioptra.');
    return mod;
  }
  // Left behind by a stop half way through an update: put the old set back when the new one never arrived.
  async function recover() {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const e of entries.filter(x => x.isDirectory() && /\.(old|new)$/.test(x.name))) {
      const id = e.name.slice(0, -4), spare = path.join(dir, e.name);
      const present = await fs.stat(folder(id)).then(() => true, () => false);
      if (e.name.endsWith('.old') && ID.test(id) && !present) await fs.rename(spare, folder(id)).catch(error => log(`Add-on ${id} could not be put back: ${error?.message || error}`));
      else await fs.rm(spare, { recursive: true, force: true });
    }
  }
  async function loadAll() {
    await recover();
    let names = [];
    try { names = (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory() && ID.test(e.name)).map(e => e.name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const id of names) {
      try {
        const entry = await readInstalled(id);
        installed.set(id, { ...entry, module: start(entry), runSha: entry.manifest.code.sha256, status: 'active', message: '', restart: false, update: null });
      } catch (error) {
        log(`Add-on ${id} was not loaded: ${error?.message || error}`);
        // Keep what can be shown, so it can be removed or installed again. Its code does not run.
        let manifest = { id, name: id, by: '', version: '', tab: { label: '', sub: '' }, adds: [], may: [], data: { version: '', rules: 0 } };
        try { manifest = verifyManifest(await fs.readFile(path.join(folder(id), 'addon.json')), await fs.readFile(path.join(folder(id), 'addon.json.sig'), 'utf8'), publicKey); } catch { /* shown by its folder name */ }
        installed.set(id, { manifest, source: null, module: null, data: null, status: 'error', message: error instanceof AddonError ? error.message : 'This add-on could not be loaded.', restart: false, update: null });
      }
    }
  }
  const active = entry => Boolean(entry?.module && entry.status === 'active' && entry.source?.enabled);

  // Step one of installing: fetch and check the manifest, show what it is. Nothing is stored and no code is fetched yet.
  async function preview(input) {
    pending = null;
    const source = parseCode(input, { allowLocal }), signed = await fetchSigned(source);
    const have = installed.get(signed.manifest.id);
    if (have?.source && have.source.url !== source.url) fail(`${signed.manifest.name} is already installed from another address. Remove it first if you want to switch.`);
    if (have?.manifest.version && compareVersions(signed.manifest.version, have.manifest.version) < 0) fail(`${signed.manifest.name} ${have.manifest.version} is installed; this code offers the older ${signed.manifest.version}.`);
    pending = { source, signed };
    return view(signed.manifest);
  }
  const install = () => serial(async () => {
    if (!pending) fail('Enter an add-on code first.');
    const { source, signed } = pending; pending = null;
    const was = installed.get(signed.manifest.id);
    await store({ ...source, enabled: true }, signed);
    const entry = await readInstalled(signed.manifest.id), sha = entry.manifest.code.sha256;
    // Code that already runs stays in memory until Dioptra restarts, with the data it started with unless the new set
    // holds that very code; a first install starts right away.
    if (was?.module) installed.set(entry.manifest.id, { ...entry, module: was.module, runSha: was.runSha, data: was.runSha === sha ? entry.data : was.data, status: 'active', message: '', restart: was.runSha !== sha, update: null });
    else installed.set(entry.manifest.id, { ...entry, module: start(entry), runSha: sha, status: 'active', message: '', restart: false, update: null });
    return entry.manifest.id;
  });
  const remove = id => serial(async () => {
    if (!ID.test(String(id)) || !installed.has(id)) fail('That add-on is not installed.');
    await fs.rm(folder(id), { recursive: true, force: true });
    installed.delete(id);
  });
  const setEnabled = (id, on) => serial(async () => {
    const entry = installed.get(id);
    if (!entry?.source) fail('That add-on is not installed.');
    entry.source = { ...entry.source, enabled: Boolean(on) };
    await writeFile(path.join(folder(id), 'source.json'), JSON.stringify(entry.source));
  });
  // Updates: a newer signed manifest replaces the files. New data counts at once; new code after a restart.
  const check = id => serial(async () => {
    const entry = installed.get(id);
    // Removed in the meantime, or never loaded: say so, the caller's loop goes on.
    if (!entry?.source) return { status: 'error', message: 'That add-on is not installed.', at: new Date().toISOString() };
    try {
      const signed = await fetchSigned(entry.source), next = signed.manifest, now = entry.manifest;
      if (next.id !== id) fail('The add-on server offers another add-on than the one installed.');
      const order = now.version ? compareVersions(next.version, now.version) : 1;
      if (order < 0) fail(`The add-on server offers ${next.version}, older than the installed ${now.version}. Nothing was changed.`);
      if (order === 0 && next.code.sha256 !== now.code.sha256) fail('The add-on server changed the code without a new version. Nothing was changed.');
      const changed = order > 0 || next.data.sha256 !== now.data.sha256;
      if (changed) {
        const sameCode = next.code.sha256 === now.code?.sha256 && next.code.file === now.code.file;
        const have = sameCode ? { code: await fs.readFile(path.join(folder(id), now.code.file)).then(bytes => checkFile(bytes, next.code)) } : {};
        await store(entry.source, signed, have);
        const fresh = await readInstalled(id);
        // The code in memory is known by its own hash: it only gets new data when the new set holds that very code.
        const runs = entry.runSha === fresh.manifest.code.sha256;
        Object.assign(entry, { manifest: fresh.manifest, source: fresh.source, restart: !runs });
        if (runs) entry.data = fresh.data;
      } else {
        entry.source = { ...entry.source, checkedAt: new Date().toISOString() };
        await writeFile(path.join(folder(id), 'source.json'), JSON.stringify(entry.source));
      }
      entry.update = { status: changed ? 'updated' : 'current', message: !changed ? 'Up to date.' : entry.restart ? `Version ${next.version} is ready. Restart Dioptra to use it.` : `Threat list ${next.data.version} is in use.`, at: new Date().toISOString() };
    } catch (error) {
      entry.update = { status: 'error', message: error instanceof AddonError ? error.message : 'The update check failed.', at: new Date().toISOString() };
      if (!(error instanceof AddonError)) log(`Add-on ${id} update check failed: ${error?.stack || error}`);
    }
    return entry.update;
  });

  /**
   * Run one add-on on a page. pages: { hostfile?, live? } as fetched by Dioptra; fetchPage(side, target, headers) is
   * Dioptra's own bounded fetch. The add-on gets at most MAX_FETCHES_PER_SIDE requests per server, only to the page's own host.
   * What the add-on gets (its scan context): url, pages, data (its own data file), fetch(side, target, options), and
   * rescan: true when the user asked for a fresh result (Compare again, or a whole-site run), false for a scan that
   * follows an ordinary page load or a tab switch. An add-on that remembers answers should ask again when it is true.
   * Add-ons from before 1.4.0-beta.4 do not look at it.
   */
  async function scan(id, { url, pages, fetchPage, rescan = false }) {
    const entry = installed.get(id);
    if (!active(entry)) fail('That add-on is not active.');
    const sides = ['hostfile', 'live'].filter(side => pages[side]), base = new URL(url), host = base.hostname.replace(/^www\./, '');
    const calls = { hostfile: 0, live: 0 };
    let over = false; // set when the scan has returned or timed out: an add-on that keeps going gets nothing more
    const ctx = { url, pages, data: entry.data, rescan: rescan === true, fetch: async (side, target, options = {}) => {
      if (over) throw new Error('The scan has ended.');
      if (!sides.includes(side)) throw new Error('That side was not scanned.');
      if (++calls[side] > MAX_FETCHES_PER_SIDE) throw new Error('Too many requests for one scan.');
      const to = new URL(String(target));
      if (!['http:', 'https:'].includes(to.protocol) || to.protocol !== base.protocol || to.port !== base.port || to.hostname.replace(/^www\./, '') !== host || to.username || to.password) throw new Error('An add-on may only ask the site itself.');
      // The new server is reached through the rule of exactly this host name: another name of the site (www or not) would
      // go to Live through DNS and come back labelled Hostfile.
      if (side === 'hostfile' && to.hostname !== base.hostname) throw new Error('The new server may only be asked by its own host name.');
      const headers = {};
      if (options.userAgent) headers['User-Agent'] = text(options.userAgent, 300);
      if (options.referer) headers.Referer = text(options.referer, 300);
      // The last argument lets a request that has to wait its turn find out that this scan is over by then.
      return fetchPage(side, to.href, headers, () => !over);
    } };
    let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(() => entry.module.scan(ctx)), new Promise((_resolve, reject) => { timer = setTimeout(reject, scanTimeoutMs, new AddonError('The scan took too long and was stopped.')); })]);
      return cleanReport(result, sides);
    } finally { over = true; clearTimeout(timer); }
  }

  const view = manifest => ({ id: manifest.id, name: manifest.name, by: manifest.by, version: manifest.version, tab: manifest.tab, adds: manifest.adds, may: manifest.may, data: { version: manifest.data.version, rules: manifest.data.rules, label: manifest.data.label || 'Threat list' } });
  // What the window may know. The feed address and the key stay in the main process.
  const snapshot = () => ({
    installed: [...installed.values()].map(e => ({ ...view(e.manifest), status: e.status, message: e.message, enabled: Boolean(e.source?.enabled), restart: e.restart, checkedAt: e.source?.checkedAt || '', update: e.update })),
    pending: pending ? view(pending.signed.manifest) : null,
  });
  return { loadAll, preview, install, cancel: () => { pending = null; }, remove, setEnabled, check, scan, snapshot,
    active: () => [...installed.values()].filter(active).map(e => ({ id: e.manifest.id, name: e.manifest.name, by: e.manifest.by, scope: e.manifest.scope === 'site' ? 'site' : 'page', tab: e.manifest.tab })) };
}

module.exports = { HIDDEN, createAddons, parseCode, makeCode, verifyManifest, cleanManifest, cleanReport, reportLines, compareVersions, AddonError, ADDON_PUBLIC_KEY };
