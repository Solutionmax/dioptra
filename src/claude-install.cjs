const fs = require('node:fs/promises');
const path = require('node:path');
const { extensionId, verifiedZip } = require('./crx.cjs');
const yauzl = require('yauzl');
const { ID } = require('./claude.cjs');
const directoryName = 'claude-extension';
function downloadResponse(url, {signal}) {
  return new Promise((resolve, reject) => {
    const request = require('electron').net.request({url, redirect:'manual', credentials:'omit'});
    let body;
    const abort = () => { const error = new Error('Claude download timed out.'); body?.destroy(error); request.abort(); reject(error); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once:true});
    request.on('error', error => {cleanup(); reject(error);});
    request.on('redirect', (status, _method, location) => {
      // Electron net.fetch rejects manual redirects; the native request exposes
      // their target before any next request, so stageClaude can enforce HTTPS.
      cleanup(); resolve(new Response(null, {status, headers:{location}})); request.abort();
    });
    request.on('response', response => {
      body = response; response.once('end', cleanup); response.once('error', cleanup);
      resolve({ok:response.statusCode >= 200 && response.statusCode < 300, status:response.statusCode, body:response});
    });
    if (signal.aborted) abort(); else request.end();
  });
}
async function stageClaude(profile, fetch = downloadResponse) {
  let url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome}&acceptformat=crx3&x=id%3D${ID}%26uc`;
  // Default network session keeps TLS strict and bypasses migration routing.
  const signal = AbortSignal.timeout(60000);
  let response;
  for (let redirects = 0; ; redirects++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Claude downloads require HTTPS without credentials.');
    response = await fetch(target.href, {signal, redirect:'manual', credentials:'omit'});
    if (![301,302,303,307,308].includes(response.status)) break;
    await response.body?.cancel();
    if (redirects >= 5 || !response.headers.get('location')) throw new Error('Invalid Claude download redirect.');
    url = new URL(response.headers.get('location'), target).href;
  }
  if (!response.ok) throw new Error(`Claude download failed (${response.status}).`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 30 * 1024 * 1024) throw new Error('Extension download is too large.'); chunks.push(chunk); }
  const crx = Buffer.concat(chunks);
  const payload = verifiedZip(crx,ID);
  const temp = await fs.mkdtemp(path.join(profile,'claude-stage-'));
  try {
    await new Promise((resolve,reject) => yauzl.fromBuffer(payload,{ lazyEntries:true },(error,zip) => {
      if (error) return reject(error);
      let total = 0, count = 0;
      zip.on('error',reject); zip.on('end',resolve);
      zip.on('entry',async entry => {
        try {
          const filename = entry.fileName;
          if (++count > 5000 || (total += entry.uncompressedSize) > 100 * 1024 * 1024) throw new Error('Extension archive exceeds extraction limits.');
          if (filename.includes('\\') || filename.split('/').includes('..') || path.isAbsolute(filename) || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error('Unsafe extension archive path.');
          const target = path.join(temp,filename);
          if (filename.endsWith('/')) await fs.mkdir(target,{recursive:true});
          else {
            await fs.mkdir(path.dirname(target),{recursive:true});
            await new Promise((done,fail) => zip.openReadStream(entry,async(err,stream) => { if(err) return fail(err); try { await fs.writeFile(target,stream,{flag:'wx'}); done(); } catch(e) { fail(e); } }));
          }
          zip.readEntry();
        } catch(e) { zip.close(); reject(e); }
      });
      zip.readEntry();
    }));
    const manifest = JSON.parse(await fs.readFile(path.join(temp,'manifest.json'),'utf8'));
    if (extensionId(Buffer.from(manifest.key || '','base64')) !== ID || manifest.manifest_version !== 3 || manifest.background?.service_worker !== 'service-worker-loader.js') throw new Error('Unexpected Claude extension identity or layout.');
    if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version) || manifest.version.split('.').some(n => Number(n) > 65535)) throw new Error('Invalid extension version.');
    return { directory:temp, version:manifest.version };
  } catch (error) { await fs.rm(temp,{recursive:true,force:true}); throw error; }
}
module.exports = { stageClaude, directoryName, extensionId };
