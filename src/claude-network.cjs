// The vendor worker omits the client headers sent by its panel, but both write
// the same feature cache. Use the panel's identity for this one configuration
// endpoint. Keep credentials and all other traffic unchanged.
function claudeFeatureHeaders(url, headers, version) {
  const result = { ...headers };
  const target = new URL(url);
  if (!version || target.origin !== 'https://api.anthropic.com' || target.pathname !== '/api/bootstrap/features/claude_in_chrome') return result;
  const key = name => Object.keys(result).find(k => k.toLowerCase() === name);
  if (!key('anthropic-client-platform')) result['anthropic-client-platform'] = 'claude_browser_extension';
  if (!key('anthropic-client-version')) result['anthropic-client-version'] = version;
  const agent = key('user-agent');
  if (agent && typeof result[agent] === 'string') result[agent] = result[agent].replace(/\s(?:Dioptra|Hostlane|Migratiebrowser|Electron)\/[^\s]+/gi, '');
  return result;
}
module.exports = { claudeFeatureHeaders };
