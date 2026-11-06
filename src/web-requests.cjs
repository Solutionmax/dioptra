// Electron keeps one listener per webRequest event and session: a second registration replaces the first.
// Parts of Dioptra that only watch finished requests (Claude's diagnostics, the file check) subscribe here, so
// each gets every request of the session. onResponseStarted and onBeforeRequest stay in main.cjs (observeConnections). One failing observer never stops the others.
const hubs = new WeakMap();
const EVENTS = new Set(['onCompleted', 'onErrorOccurred']);

function observeRequests(ses, event, listener) {
  if (!EVENTS.has(event)) throw new Error(`Unsupported webRequest event: ${event}`);
  let hub = hubs.get(ses);
  if (!hub) { hub = new Map(); hubs.set(ses, hub); }
  if (!hub.has(event)) {
    const listeners = [];
    hub.set(event, listeners);
    ses.webRequest[event](details => {
      for (const observe of listeners) {
        try { observe(details); } catch (error) { console.error(`webRequest ${event} observer failed:`, error?.message || error); }
      }
    });
  }
  hub.get(event).push(listener);
}

module.exports = { observeRequests };
