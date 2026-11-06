const { test } = require('node:test');
const assert = require('node:assert/strict');
const { observeRequests } = require('../src/web-requests.cjs');

// Electron semantics: a second registration for the same event replaces the first.
function fakeSession() {
  const registered = {}, calls = {};
  const webRequest = new Proxy({}, { get: (_t, event) => listener => { registered[event] = listener; calls[event] = (calls[event] || 0) + 1; } });
  return { webRequest, fire: (event, details) => registered[event]?.(details), calls };
}

test('every observer sees every request, with one Electron listener per event', () => {
  const ses = fakeSession(), seen = [];
  observeRequests(ses, 'onCompleted', d => seen.push(['claude', d.url]));
  observeRequests(ses, 'onCompleted', d => seen.push(['files', d.url]));
  observeRequests(ses, 'onErrorOccurred', d => seen.push(['error', d.url]));
  ses.fire('onCompleted', { url: 'https://a.test/x.css' });
  ses.fire('onErrorOccurred', { url: 'https://a.test/y.js' });
  assert.deepEqual(seen, [['claude', 'https://a.test/x.css'], ['files', 'https://a.test/x.css'], ['error', 'https://a.test/y.js']]);
  assert.deepEqual(ses.calls, { onCompleted: 1, onErrorOccurred: 1 });
});

test('a failing observer does not stop the others, sessions stay apart, other events are refused', () => {
  const one = fakeSession(), two = fakeSession(), seen = [], original = console.error;
  console.error = () => {};
  try {
    observeRequests(one, 'onCompleted', () => { throw new Error('broken'); });
    observeRequests(one, 'onCompleted', d => seen.push(d.url));
    observeRequests(two, 'onCompleted', d => seen.push(`two ${d.url}`));
    one.fire('onCompleted', { url: 'https://a.test/' });
  } finally { console.error = original; }
  assert.deepEqual(seen, ['https://a.test/']);
  assert.throws(() => observeRequests(one, 'onBeforeRequest', () => {}), /Unsupported/);
});
