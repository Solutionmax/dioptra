const fs = require('node:fs/promises');
const path = require('node:path');
const { extensionId, verifiedZip } = require('./crx.cjs');
const { net } = require('electron');
const yauzl = require('yauzl');
const { ID } = require('./claude.cjs');
const directoryName = 'claude-extension';
async function installClaude(profile) {
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome}&acceptformat=crx3&x=id%3D${ID}%26uc`;
  // Default network session keeps certificate verification enabled.
  const response = await net.fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Claude download failed (${response.status}).`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 30 * 1024 * 1024) throw new Error('Extension download is too large.'); chunks.push(chunk); }
  const crx = Buffer.concat(chunks);
  const payload = verifiedZip(crx,ID);
  const temp = await fs.mkdtemp(path.join(profile,'claude-install-'));
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
    const destination = path.join(profile,directoryName);
    // Installation is first-time only; removal/reinstall is explicit in the UI.
    await fs.rename(temp,destination);
    return { directory:destination, version:manifest.version };
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
}
module.exports = { installClaude, directoryName, extensionId };
