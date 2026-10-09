// Recognises what a website runs on from what the page itself gives away: generator tags, asset paths, cookie names
// and response headers. Evidence based only: no platform found means no claim (never "plain HTML").
// Limit: a fixed list of well known platforms; add a rule here when a platform is missed.
const text = (value, max = 80) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const version = value => (String(value || "").match(/\d{1,6}(?:\.\d{1,6}){0,3}/) || [""])[0];
const pretty = slug => text(slug.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase()), 40);

// name, generator pattern, asset url pattern, cookie name pattern, header test
const PLATFORMS = [
  ['WordPress', /^WordPress\b/i, /\/wp-(?:content|includes)\//i],
  ['Drupal', /^Drupal\b/i, /\/sites\/(?:default|all)\/(?:files|themes|modules)\/|\/core\/misc\/drupal/i, null, h => /Drupal/i.test(h['x-generator'] || '') ? h['x-generator'] : ''],
  ['Joomla', /^Joomla/i, /\/media\/(?:jui|system|vendor)\/|\/components\/com_/i],
  ['Magento', /^Magento/i, /\/static\/version\d+\/|\/pub\/static\/|\/static\/frontend\//i, /^X-Magento-Vary$/i],
  ['Shopify', /^Shopify/i, /cdn\.shopify\.com/i, /^_shopify_/i, h => h['x-shopify-stage'] || /Shopify/i.test(h['powered-by'] || '') ? 'Shopify' : ''],
  ['Wix', /^Wix\.com/i, /static\.(?:wixstatic|parastorage)\.com/i],
  ['Squarespace', /^Squarespace/i, /static1\.squarespace\.com|squarespace-cdn\.com/i],
  ['Webflow', /^Webflow/i, /assets\.website-files\.com|cdn\.prod\.website-files\.com/i],
  ['PrestaShop', /^PrestaShop/i, null, /^PrestaShop-/i],
  ['TYPO3', /^TYPO3/i, /\/typo3(?:conf|temp)\//i],
  ['Ghost', /^Ghost\b/i],
  ['Craft CMS', /^Craft CMS/i, null, /^CraftSessionId$/i, h => /Craft CMS/i.test(h['x-powered-by'] || '') ? 'Craft CMS' : ''],
  ['Statamic', /^Statamic/i, null, null, h => /Statamic/i.test(h['x-powered-by'] || '') ? 'Statamic' : ''],
  ['Laravel', null, null, /^laravel_session$/i],
  ['Next.js', /^Next\.js/i, /\/_next\/static\//i, null, h => /Next\.js/i.test(h['x-powered-by'] || '') ? h['x-powered-by'] : ''],
  ['Nuxt', /^Nuxt/i, /\/_nuxt\//i],
  ['ASP.NET', null, null, /^ASP\.NET_SessionId$|^\.AspNetCore\./i, h => /ASP\.NET/i.test(h['x-powered-by'] || '') || h['x-aspnet-version'] ? `ASP.NET ${h['x-aspnet-version'] || ''}` : ''],
  ['Express', null, null, null, h => /^Express$/i.test(h['x-powered-by'] || '') ? 'Express' : '']
];

function detectSite({ headers = {}, cookies = [], generators = [], urls = [] } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), text(Array.isArray(v) ? v.join(', ') : v, 200)]));
  generators = generators.slice(0, 20).map(g => text(g, 120)).filter(Boolean);
  const assets = urls.slice(0, 600).map(u => String(u).slice(0, 400)).join('\n');
  const result = { platform: '', version: '', source: '', shop: '', shopVersion: '', theme: '', builder: '', builderVersion: '', extras: [], php: '', server: '' };

  for (const [name, generator, asset, cookie, header] of PLATFORMS) {
    const tag = generator && generators.find(g => generator.test(g)), fromHeader = header ? header(h) : '';
    const source = tag ? 'generator tag' : fromHeader ? 'response header' : asset && asset.test(assets) ? 'file paths in the page' : cookie && cookies.some(c => cookie.test(c)) ? 'cookie name' : '';
    if (!source) continue;
    Object.assign(result, { platform: name, version: version((tag || fromHeader || '').replace(/^\D*?(?=\d)/, '')), source });
    break;
  }
  // Any other tool that names itself in a generator tag (Hugo, Jekyll, ...). Page builders say "for WordPress" and are extras, not the platform.
  if (!result.platform) { const tag = generators.find(g => !/WooCommerce|page builder|for WordPress|Site Kit|Elementor/i.test(g)); if (tag) Object.assign(result, { platform: text(tag.replace(/\s*v?\d+(?:\.\d+)*.*$/, ''), 40) || text(tag, 40), version: version(tag), source: 'generator tag' }); }

  const woo = generators.find(g => /^WooCommerce\b/i.test(g));
  if (woo || /\/plugins\/woocommerce\//i.test(assets)) Object.assign(result, { shop: 'WooCommerce', shopVersion: version(woo) });
  if (result.platform === 'WordPress') {
    const count = (pattern, skip = []) => { const seen = new Map(); for (const m of assets.matchAll(pattern)) if (!skip.includes(m[1].toLowerCase())) seen.set(m[1].toLowerCase(), (seen.get(m[1].toLowerCase()) || 0) + 1); return [...seen].sort((a, b) => b[1] - a[1]).map(([slug]) => slug); };
    const elementor = generators.find(g => /^Elementor\b/i.test(g));
    if (elementor || /\/plugins\/elementor(?:-pro)?\//i.test(assets)) { result.builder='Elementor'; result.builderVersion=version(elementor); }
    result.theme = pretty(count(/\/wp-content\/themes\/([a-z0-9][a-z0-9_-]{0,60})\//gi)[0] || '');
    result.extras = count(/\/wp-content\/plugins\/([a-z0-9][a-z0-9_-]{0,60})\//gi, ['woocommerce', 'elementor', 'elementor-pro']).slice(0, 8).map(pretty);
  }
  result.php = version((h['x-powered-by'] || '').match(/PHP\/([\d.]+)/i)?.[1]);
  result.server = text((h.server || '').split(/[\/ (]/)[0], 30);
  return result.platform || result.php || result.server ? result : null;
}
module.exports = { detectSite };
