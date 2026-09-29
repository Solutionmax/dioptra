// Runs in the official extension page. Return only these public compatibility
// fields, never cookies, tokens, account details, chat text or the full cache.
async function readClaudeDiagnostics() {
  const stored = await chrome.storage.local.get(['features', 'browserControlPermissionAccepted']);
  const flag = stored.features?.payload?.features?.chrome_ext_cowork_iframe?.on;
  const frame = [...document.querySelectorAll('iframe')].find(frame => {
    try { const url = new URL(frame.src); return url.origin === 'https://claude.ai' && url.pathname.startsWith('/cic/'); } catch { return false; }
  });
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    interface: frame ? 'new' : location.pathname === '/options.html' ? 'settings' : 'classic-or-loading',
    newInterfaceEnabled: typeof flag === 'boolean' ? flag : null,
    featureCachePresent: Boolean(stored.features?.payload?.features),
    featureCacheAgeSeconds: typeof stored.features?.timestamp === 'number' ? Math.max(0, Math.floor((Date.now() - stored.features.timestamp) / 1000)) : null,
    browserPermissionAccepted: stored.browserControlPermissionAccepted === true
  };
}
module.exports = { readClaudeDiagnostics };
