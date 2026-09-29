const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLibrary } = require('../src/library.cjs');
function fixture(t, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-library-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'library.json');
  if (data !== undefined) fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}
const record = (id, state = 'completed') => ({ id: String(id), name: 'file.zip', path: '/tmp/file.zip', url: 'https://example.com/file.zip', state, received: 50, total: 100, paused: false, canResume: false });
test('bookmarks toggle normalized URLs and persist without exposing mutable records', t => {
  const file = fixture(t), library = createLibrary(file);
  assert.equal(library.bookmark('https://EXAMPLE.com', 'Example'), true);
  const snapshot = library.snapshot(); snapshot.bookmarks[0].title = 'changed';
  assert.deepEqual(createLibrary(file).snapshot().bookmarks, [{ url: 'https://example.com/', title: 'Example' }]);
  assert.equal(library.snapshot().bookmarks[0].title, 'Example');
  assert.equal(library.bookmark('https://example.com/', 'Example'), false);
  library.bookmark('http://localhost:8080', 'local');
  library.removeBookmark('http://localhost:8080/');
  assert.deepEqual(createLibrary(file).snapshot().bookmarks, []);
});
test('history keeps latest visits first, deduplicates and clears independently', t => {
  const file = fixture(t), library = createLibrary(file);
  library.bookmark('https://example.com', 'saved');
  library.visit('https://example.com/one', 'one'); library.visit('https://example.com/two', 'two');
  library.visit('https://example.com/one', 'updated');
  const history = createLibrary(file).snapshot().history;
  assert.equal(history.length, 2); assert.equal(history[0].title, 'updated');
  assert.ok(Number.isFinite(history[0].visitedAt));
  library.clearHistory();
  assert.deepEqual(createLibrary(file).snapshot().history, []);
  assert.equal(library.snapshot().bookmarks.length, 1);
});
test('rejects unsafe URLs and excludes account and auth callback history', t => {
  const library = createLibrary(fixture(t));
  for (const url of ['javascript:alert(1)', 'file:///tmp/secret', 'https://user:pass@example.com', 'about:blank', 'bad']) {
    assert.throws(() => library.bookmark(url, 'bad')); assert.equal(library.visit(url, 'bad'), false);
  }
  for (const url of ['https://claude.ai/chat/123', 'https://console.anthropic.com/', 'https://accounts.google.com/', 'https://example.com/oauth/callback', 'https://example.com/auth/login', 'https://example.com/return?code=secret', 'https://example.com/#access_token=secret']) assert.equal(library.visit(url, 'private'), false);
  assert.equal(library.visit('https://example.com/article', 'a'.repeat(4000)), true);
  assert.ok(library.snapshot().history[0].title.length <= 512);
});
test('bounds persisted collections and drops their oldest entries', t => {
  const file = fixture(t, {
    bookmarks: Array.from({ length: 505 }, (_, i) => ({ url: `https://example.com/${i}`, title: String(i) })),
    history: Array.from({ length: 1005 }, (_, i) => ({ url: `https://example.com/${i}`, title: String(i), visitedAt: 10000 - i })),
    downloads: Array.from({ length: 105 }, (_, i) => record(i))
  });
  const library = createLibrary(file);
  library.bookmark('https://example.com/new', 'new'); library.visit('https://example.com/new', 'new'); library.download(record('new'));
  const result = createLibrary(file).snapshot();
  assert.equal(result.bookmarks.length, 500); assert.equal(result.history.length, 1000); assert.equal(result.downloads.length, 100);
  assert.equal(result.bookmarks[0].title, 'new'); assert.equal(result.history[0].title, 'new'); assert.equal(result.downloads[0].id, 'new');
});
test('download upserts preserve live state, restart marks incomplete and clearing retains active work', t => {
  const file = fixture(t), library = createLibrary(file);
  library.download(record('done')); library.download({ ...record('active', 'progressing'), paused: true, canResume: true });
  library.download({ ...record('active', 'progressing'), received: 75, canResume: true });
  assert.equal(library.snapshot().downloads.length, 2); assert.equal(library.snapshot().downloads[0].received, 75);
  library.clearDownloads(); assert.equal(library.snapshot().downloads.length, 1);
  const restarted = createLibrary(file);
  assert.equal(restarted.snapshot().downloads[0].state, 'interrupted');
  assert.equal(restarted.snapshot().downloads[0].canResume, false); assert.equal(restarted.snapshot().downloads[0].paused, false);
  restarted.clearDownloads(); assert.deepEqual(restarted.snapshot().downloads, []);
});
test('filters malformed entries but refuses to overwrite corrupt documents', t => {
  const file = fixture(t, { bookmarks: [null, { url: 'file:///secret' }, { url: 'https://example.com/', title: 'ok' }, { url: 'https://example.com/', title: 'duplicate' }], history: [{ url: 'https://example.com/', visitedAt: 'bad' }], downloads: [null, { id: 'bad' }, record('good')] });
  const library = createLibrary(file);
  assert.equal(library.snapshot().bookmarks.length, 1); assert.deepEqual(library.snapshot().history, []); assert.equal(library.snapshot().downloads.length, 1);
  for (const corrupt of ['{broken', 'null', '[]', '{"bookmarks":42}']) {
    fs.writeFileSync(file, corrupt); assert.throws(() => createLibrary(file)); assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  }
});
test('download persistence retains files with blob, data or private source URLs', t => {
  const file = fixture(t), library = createLibrary(file);
  for (const [id, url] of [['blob', 'blob:https://example.com/id'], ['data', 'data:text/plain,secret'], ['auth', 'https://example.com/callback?access_token=secret'], ['empty', '']]) {
    library.download({ ...record(id), url });
  }
  const downloads = createLibrary(file).snapshot().downloads;
  assert.equal(downloads.length, 4);
  assert.ok(downloads.every(item => item.url === '' && item.path === '/tmp/file.zip' && item.state === 'completed'));
  assert.equal(fs.readFileSync(file, 'utf8').includes('secret'), false);
});
test('token-bearing bookmarks are rejected and legacy sensitive sources sanitized', t => {
  const file = fixture(t), library = createLibrary(file);
  for (const url of ['https://example.com/?access_token=secret', 'https://example.com/#/callback?access_token=secret', 'https://example.com/#/return?code=secret']) assert.throws(() => library.bookmark(url, 'secret'));
  assert.equal(library.bookmark('https://claude.ai/', 'Claude'), true);
  assert.equal(library.bookmark('https://example.com/?category=books', 'Books'), true);
  fs.writeFileSync(file, JSON.stringify({ bookmarks: [{ url: 'https://example.com/?code=secret', title: 'secret' }], downloads: [{ ...record('legacy'), url: 'https://example.com/?token=secret' }] }));
  const restored = createLibrary(file);
  assert.deepEqual(restored.snapshot().bookmarks, []);
  assert.equal(restored.snapshot().downloads[0].url, '');
});
test('hash-router authentication and callback tokens stay out of automatic history', t => {
  const library = createLibrary(fixture(t));
  for (const url of ['https://example.com/#/callback?access_token=secret', 'https://example.com/#/return?code=secret', 'https://example.com/#!/oauth/authorize', 'https://example.com/#/auth/login', 'https://example.com/#/return?refresh_token=secret']) assert.equal(library.visit(url, 'private'), false);
  assert.equal(library.visit('https://example.com/#/article?category=books', 'Article'), true);
});
