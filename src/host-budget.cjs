/* How much Dioptra asks of one site on behalf of add-ons and whole-site runs (1.4.0-beta.4). One counter per host over a
   rolling window, shared by every add-on and every run, and at most a few requests at a time per server. A limit per
   scan alone is not enough: each address is a new scan and add-ons run side by side.
   Every request is booked in that counter under who asked for it:
     browse   a scan that followed an ordinary page load. It may use BROWSE_LIMIT of what browsing booked.
     compare  a comparison of one page the user started. COMPARE_LIMIT, and what browsing booked counts against it.
     site     a whole-site run. Its own explicit limit (siteLimit), and everything booked counts against it.
   So an add-on cannot get past the small limit by scanning page after page, and a run the user asked for does not
   leave browsing without scans for the next ten minutes. */
const WINDOW_MS = 10 * 60 * 1000;
// 120: a page load scans with three add-ons at up to a few requests each; this leaves room for normal browsing and
// stops an add-on that walks every address of a site.
const BROWSE_LIMIT = 120;
// A comparison the user starts: every add-on on both servers (WP Leak Check alone asks up to 26 of each).
const COMPARE_LIMIT = 360;
// A whole-site run: per page the two documents plus the add-on requests of that page, and once the site-wide part.
const SITE_PER_PAGE = 20, SITE_ONCE = 120;
const AT_ONCE = 4;
const siteLimit = pages => COMPARE_LIMIT + SITE_ONCE + SITE_PER_PAGE * Math.max(1, pages);
const RANK = { browse: 0, compare: 1, site: 2 };
const BROWSE = { kind: 'browse', limit: BROWSE_LIMIT }, COMPARE = { kind: 'compare', limit: COMPARE_LIMIT }, forSite = pages => ({ kind: 'site', limit: siteLimit(pages) });
const bareHost = host => String(host || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
// More hosts than this in the counter: the ones without a recent request are dropped.
const SWEEP_AT = 200;

class BudgetError extends Error {}
// The one who asked is gone (the scan ended, the run was cancelled) while the request waited for its turn.
class StoppedError extends Error {}

// now: a clock that only goes forward (performance.now), so setting the computer's clock neither blocks nor resets a budget.
function createBudget({ now = () => performance.now(), windowMs = WINDOW_MS, atOnce = AT_ONCE } = {}) {
  const spent = new Map(), lanes = new Map();
  const recent = host => { const t = now() - windowMs, list = (spent.get(host) || []).filter(entry => entry.at > t); if (list.length) spent.set(host, list); else spent.delete(host); return list; };
  // Book one request to this host, or refuse it when the window already holds the limit of who asks.
  function take(host, { kind, limit }) {
    const key = bareHost(host), list = recent(key), rank = RANK[kind] ?? 0;
    if (list.filter(entry => entry.rank <= rank).length >= limit) throw new BudgetError('Too many requests to this site in a short time. Dioptra stopped asking.');
    list.push({ at: now(), rank }); spent.set(key, list);
    if (spent.size > SWEEP_AT) for (const other of [...spent.keys()]) recent(other);
  }
  // At most atOnce requests at a time per host and side; the rest wait their turn.
  async function lane(host, side, fn) {
    const key = `${bareHost(host)}|${side}`, state = lanes.get(key) || { busy: 0, queue: [] };
    lanes.set(key, state);
    // A request that waited takes over the place of the one that finished, so a newcomer cannot slip in between.
    if (state.busy >= atOnce) await new Promise(resolve => state.queue.push(resolve)); else state.busy++;
    try { return await fn(); } finally { const next = state.queue.shift(); if (next) next(); else if (!--state.busy) lanes.delete(key); }
  }
  // who: BROWSE, COMPARE or forSite(pages). wanted: asked again when the request gets its turn, before it is booked and
  // sent: a request that waited while its scan ended or its run was cancelled is not made any more.
  const ask = (host, side, who, fn, wanted = null) => lane(host, side, async () => { if (wanted && !wanted()) throw new StoppedError('The scan has ended.'); take(host, who); return fn(); });
  return { ask, take, used: host => recent(bareHost(host)).length, hosts: () => spent.size };
}

module.exports = { createBudget, BudgetError, StoppedError, siteLimit, forSite, bareHost, BROWSE, COMPARE, BROWSE_LIMIT, COMPARE_LIMIT, SITE_PER_PAGE, SITE_ONCE, AT_ONCE, WINDOW_MS };
