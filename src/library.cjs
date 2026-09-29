const fs = require('node:fs');
const { saveSettings } = require('./core.cjs');

function webURL(value) {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid web address.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an http or https address without credentials.');
  return url.href;
}
function title(value, fallback) { return (typeof value === 'string' && value.trim() ? value.trim() : fallback).slice(0, 512); }
function fragmentParts(url) {
  const fragment = url.hash.slice(1).replace(/^!/, '');
  const query = fragment.indexOf('?');
  return { route: query < 0 ? fragment : fragment.slice(0, query), params: new URLSearchParams(query < 0 ? fragment : fragment.slice(query + 1)) };
}
function hasAuthToken(url) {
  const keys = [...url.searchParams.keys(), ...fragmentParts(url).params.keys()];
  return keys.some(key => /^(?:code|token|access_token|refresh_token|id_token|authorization|credential|assertion|session_token)$/i.test(key));
}
function privateVisit(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (['claude.ai', 'anthropic.com', 'accounts.google.com', 'auth0.com', 'login.microsoftonline.com', 'appleid.apple.com'].some(domain => host === domain || host.endsWith(`.${domain}`))) return true;
  const authPath = /(?:^|\/)(?:auth|oauth2?|authorize|login|signin|sign-in|callback)(?:\/|$)/i;
  return /^(auth|accounts|login|oauth)\./i.test(host) || authPath.test(url.pathname) || authPath.test(fragmentParts(url).route) || hasAuthToken(url);
}
function savedPage(record, history = false) {
  if (!record || typeof record !== 'object') throw new Error('Invalid page.');
  const url = webURL(record.url);
  if (hasAuthToken(new URL(url))) throw new Error('Authentication callback URLs cannot be saved.');
  const page = { url, title: title(record.title, url) };
  if (history) {
    if (privateVisit(url) || !Number.isFinite(record.visitedAt) || record.visitedAt < 0) throw new Error('Invalid visit.');
    page.visitedAt = record.visitedAt;
  }
  return page;
}
function savedDownload(record, restarting = false) {
  if (!record || typeof record.id !== 'string' || !record.id || record.id.length > 256 || !['progressing', 'interrupted', 'completed', 'cancelled'].includes(record.state)) throw new Error('Invalid download.');
  let sourceURL = '';
  try { const url = webURL(record.url); if (!privateVisit(url)) sourceURL = url; } catch { /* Downloads may originate from blob/data URLs. Save the file, not the source. */ }
  const result = {
    id: record.id, name: title(record.name, 'Download'),
    path: typeof record.path === 'string' ? record.path.slice(0, 16384) : '',
    url: sourceURL, state: record.state,
    received: Number.isFinite(record.received) && record.received >= 0 ? record.received : 0,
    total: Number.isFinite(record.total) && record.total >= 0 ? record.total : 0,
    paused: record.paused === true, canResume: record.canResume === true
  };
  if (Number.isFinite(record.createdAt) && record.createdAt >= 0) result.createdAt = record.createdAt;
  if (restarting || ['completed', 'cancelled'].includes(result.state)) {
    if (result.state === 'progressing') result.state = 'interrupted';
    result.paused = false; result.canResume = false;
  }
  return result;
}
function clean(records, normalize, key, limit) {
  const seen = new Set(), result = [];
  for (const record of records || []) {
    try {
      const value = normalize(record);
      if (!seen.has(value[key])) { result.push(value); seen.add(value[key]); }
      if (result.length === limit) break;
    } catch { /* A malformed individual record should not hide the other entries. */ }
  }
  return result;
}
function createLibrary(file) {
  let source = {};
  try { source = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!source || typeof source !== 'object' || Array.isArray(source) || ['bookmarks', 'history', 'downloads'].some(key => source[key] !== undefined && !Array.isArray(source[key]))) throw new Error('Invalid library file; the original file was preserved.');
  let data = {
    bookmarks: clean(source.bookmarks, record => savedPage(record), 'url', 500),
    history: clean(source.history, record => savedPage(record, true), 'url', 1000),
    downloads: clean(source.downloads, record => savedDownload(record, true), 'id', 100)
  };
  function replace(key, records) {
    const next = { ...data, [key]: records };
    saveSettings(file, next);
    data = next;
  }
  return {
    snapshot() { return structuredClone(data); },
    bookmark(url, label) {
      const record = savedPage({ url, title: label });
      const exists = data.bookmarks.some(item => item.url === record.url);
      const remaining = data.bookmarks.filter(item => item.url !== record.url);
      replace('bookmarks', exists ? remaining : [record, ...remaining].slice(0, 500));
      return !exists;
    },
    removeBookmark(url) { const normalized = webURL(url); replace('bookmarks', data.bookmarks.filter(item => item.url !== normalized)); },
    visit(url, label) {
      let record;
      try { record = savedPage({ url, title: label, visitedAt: Date.now() }, true); } catch { return false; }
      replace('history', [record, ...data.history.filter(item => item.url !== record.url)].slice(0, 1000));
      return true;
    },
    clearHistory() { replace('history', []); },
    download(input) {
      const record = savedDownload(input);
      replace('downloads', [record, ...data.downloads.filter(item => item.id !== record.id)].slice(0, 100));
    },
    clearDownloads() { replace('downloads', data.downloads.filter(item => item.state === 'progressing' || (item.state === 'interrupted' && item.canResume))); }
  };
}
module.exports = { createLibrary };
