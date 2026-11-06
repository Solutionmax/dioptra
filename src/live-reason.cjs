// Why Live (the site through normal DNS) could not be reached, in words for the window. Pure: main.cjs passes the failed
// Live result of fetchDocument (code, address, port, error) and, when the error names no address (a server that does not
// answer), the IP of one dns.lookup. A certificate problem is not a reason here: it keeps its own flow (Continue anyway),
// and so does any other failure that is not about reaching the server.
const DNS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_NODATA', 'ENODATA']);
const TIMEOUT = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN']);
// Chromium names, for a failure through Electron's fetch instead of Node's https.
const NET_ERRORS = [[/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/, 'dns'], [/ERR_CONNECTION_REFUSED/, 'refused'], [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, 'timeout'], [/ERR_ADDRESS_UNREACHABLE/, 'unreachable']];
const CERTIFICATE_CODE = /CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_(GET|VERIFY)|HOSTNAME_MISMATCH/;
// The kinds that mean "there is no old site to compare with": Speed and Checks then judge the new server on its own.
const SOLO = new Set(['dns', 'refused', 'timeout', 'unreachable']);
const SHORT = { dns: 'no DNS record', refused: 'connection refused', timeout: 'no answer', unreachable: 'unreachable' };
const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const clean = (text, max = 200) => String(text ?? '').replace(CONTROL, ' ').trim().slice(0, max);
const bareIP = ip => clean(ip, 64).replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');

// '' when Live answered; otherwise dns, refused, timeout, unreachable, certificate or other.
function failureKind(live) {
  if (!live || live.ok) return '';
  const code = clean(live.code, 40).toUpperCase(), text = clean(live.error);
  if (CERTIFICATE_CODE.test(code) || /certificate|ERR_CERT_/i.test(text)) return 'certificate';
  if (DNS.has(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (TIMEOUT.has(code) || /^The request timed out after /.test(text)) return 'timeout';
  if (UNREACHABLE.has(code)) return 'unreachable';
  for (const [pattern, kind] of NET_ERRORS) if (pattern.test(text)) return kind;
  return 'other';
}
// The host of the request that failed: the last redirect, else the page itself.
function failingHost(url, live) {
  try { return new URL(live?.redirects?.at(-1)?.location || url).hostname.toLowerCase(); } catch { return ''; }
}
// A refused or silent server: the error often names no address (always for the timeout), so main looks it up once.
const needsAddress = live => ['refused', 'timeout', 'unreachable'].includes(failureKind(live)) && !bareIP(live.address);

// The reason for the window, or null when Live answered or failed for another reason (the beta.2 behaviour stays).
function liveReason(live, { url = '', ip = '', checkedAt = '' } = {}) {
  const kind = failureKind(live);
  if (!SOLO.has(kind)) return null;
  const host = failingHost(url, live), at = bareIP(live.address) || bareIP(ip), port = Number(live.port) || 443;
  const server = at ? `the old server ${at}` : 'the old server';
  const why = kind === 'dns' ? `${host} has no DNS record` : kind === 'refused' ? `${server} refused the connection on port ${port}`
    : kind === 'timeout' ? `${server} did not answer on port ${port}` : `${server} cannot be reached from this computer`;
  return { kind, host, ip: at, port, why, short: SHORT[kind], text: `Live could not be reached: ${why}.`, detail: clean(live.error || live.code), checkedAt: clean(checkedAt, 40) };
}

// What stands out without Live: the reason first (a calm note, not an error), and none of the findings that only compare
// the new server with an empty page (the failed request itself, domains "only on Hostfile").
const ONE_SIDED = [/^The Live request failed:/, / loads only on Hostfile\b/, /other external domains? only on Hostfile:/];
function soloFindings(findings = [], reason) {
  const kept = findings.filter(f => !f.calm && !ONE_SIDED.some(pattern => pattern.test(f.text)))
    .map(f => (/ appears only on Hostfile:/.test(f.text) ? { ...f, text: f.text.replace(' appears only on Hostfile:', ' appears on Hostfile:') } : f));
  return [{ severity: 'info', calm: true, text: reason.text, detail: 'Speed and Checks judged the new server on its own; comparing with Live waits until Live answers.' }, ...kept];
}

module.exports = { failureKind, failingHost, needsAddress, liveReason, soloFindings };
