const test = require('node:test');
const assert = require('node:assert/strict');
const { claudeFeatureHeaders } = require('../src/claude-network.cjs');
const url = 'https://api.anthropic.com/api/bootstrap/features/claude_in_chrome';
const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36';
test('worker and panel feature requests identify the same installed extension and Chromium browser', () => {
  const worker = { Authorization: 'Bearer synthetic-test', 'Content-Type': 'application/json', 'User-Agent': chrome.replace('Chrome/', 'Dioptra/0.4.4 Chrome/').replace(' Safari/', ' Electron/44.4.5 Safari/') };
  const panel = { ...worker, 'anthropic-client-platform': 'claude_browser_extension', 'anthropic-client-version': '1.0.94' };
  const result = claudeFeatureHeaders(url, worker, '1.0.94');
  assert.deepEqual(result, claudeFeatureHeaders(url, panel, '1.0.94'));
  assert.equal(result['User-Agent'], chrome);
  assert.equal(result.Authorization, worker.Authorization);
  assert.equal(result['anthropic-client-version'], '1.0.94');
  assert.equal(worker['anthropic-client-version'], undefined, 'Input headers are not mutated');
});
test('feature compatibility does not change other API requests or web traffic', () => {
  const headers = { 'User-Agent': 'Dioptra/0.4.4 Electron/44.4.5', Authorization: 'Bearer synthetic-test' };
  for (const target of ['https://api.anthropic.com/v1/messages', 'https://claude.ai/api/bootstrap', 'https://api.anthropic.com.evil.test/api/bootstrap/features/claude_in_chrome', 'http://api.anthropic.com/api/bootstrap/features/claude_in_chrome']) assert.deepEqual(claudeFeatureHeaders(target, headers, '1.0.94'), headers);
  assert.deepEqual(claudeFeatureHeaders(url, headers, null), headers, 'No rewrite before the extension is installed');
});
test('existing client headers are case insensitive and Chrome user agents remain unchanged', () => {
  const headers = { 'user-agent': chrome, 'Anthropic-Client-Platform': 'claude_browser_extension', 'Anthropic-Client-Version': '1.0.94' };
  assert.deepEqual(claudeFeatureHeaders(url, headers, '1.0.94'), headers);
});
