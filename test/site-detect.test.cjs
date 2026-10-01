const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectSite } = require('../src/site-detect.cjs');

test('WordPress shop: versions from generator tags, theme and plugins from paths, PHP and server from headers', () => {
  const site = detectSite({
    headers: { 'X-Powered-By': ['PHP/8.3.33'], Server: 'LiteSpeed' },
    generators: ['WordPress 7.0.6', 'WooCommerce 10.9.1', 'Powered by WPBakery Page Builder - drag and drop page builder for WordPress.'],
    urls: ['https://x.test/wp-content/themes/basel/style.css', 'https://x.test/wp-content/themes/basel/a.js', 'https://x.test/wp-content/plugins/mollie-payments-for-woocommerce/a.js', 'https://x.test/wp-content/plugins/woocommerce/a.js']
  });
  assert.deepEqual(site, { platform: 'WordPress', version: '7.0.6', source: 'generator tag', shop: 'WooCommerce', shopVersion: '10.9.1', theme: 'Basel', extras: ['Mollie Payments For Woocommerce'], php: '8.3.33', server: 'LiteSpeed' });
});
test('WordPress with hidden version is recognised from paths', () => {
  const site = detectSite({ urls: ['/wp-includes/js/jquery.js'] });
  assert.equal(site.platform, 'WordPress'); assert.equal(site.version, ''); assert.equal(site.source, 'file paths in the page');
});
test('Laravel from its session cookie, no version', () => {
  const site = detectSite({ cookies: ['XSRF-TOKEN', 'laravel_session'], headers: { 'x-powered-by': 'PHP/8.2.24' } });
  assert.equal(site.platform, 'Laravel'); assert.equal(site.version, ''); assert.equal(site.php, '8.2.24');
});
test('Drupal from header or generator, other platforms from their marks', () => {
  assert.equal(detectSite({ headers: { 'X-Generator': 'Drupal 10 (https://www.drupal.org)' } }).version, '10');
  assert.equal(detectSite({ generators: ['Drupal 9 (https://www.drupal.org)'] }).platform, 'Drupal');
  assert.equal(detectSite({ urls: ['https://cdn.shopify.com/s/files/1/a.js'] }).platform, 'Shopify');
  assert.equal(detectSite({ urls: ['/_next/static/chunks/main.js'] }).platform, 'Next.js');
  assert.equal(detectSite({ generators: ['Joomla! - Open Source Content Management'] }).platform, 'Joomla');
  const hugo = detectSite({ generators: ['Hugo 0.120.4'] });
  assert.equal(hugo.platform, 'Hugo'); assert.equal(hugo.version, '0.120.4');
});
test('no evidence means no claim; PHP alone is still reported', () => {
  assert.equal(detectSite({ headers: { server: 'nginx/1.25.3' }, urls: ['/css/site.css'] }), null);
  assert.equal(detectSite(), null);
  const php = detectSite({ headers: { 'x-powered-by': 'PHP/7.4.33', server: 'Apache/2.4.58 (Unix)' } });
  assert.equal(php.platform, ''); assert.equal(php.php, '7.4.33'); assert.equal(php.server, 'Apache');
});
test('hostile input stays bounded and plain', () => {
  const site = detectSite({ generators: ['WordPress ' + '9'.repeat(500), 'x'.repeat(5000)], urls: Array(5000).fill('/wp-content/plugins/' + 'a'.repeat(300) + '/x.js'), headers: { server: 'S'.repeat(500) } });
  assert.ok(site.version.length <= 80 && site.server.length <= 30 && site.extras.length <= 8);
});
