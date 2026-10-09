const fs = require('node:fs/promises');
const path = require('node:path');
const { stageClaude, directoryName } = require('./claude-install.cjs');
const backupName = `${directoryName}-backup`;
function compareVersions(a, b) {
  const parts = value => {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(value)) throw new Error('Invalid extension version.');
    const numbers = value.split('.').map(Number);
    if (numbers.some(n => n > 65535)) throw new Error('Invalid extension version.');
    return numbers;
  };
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 4; i++) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0) ? 1 : -1;
  return 0;
}
async function exists(directory) { try { await fs.access(directory); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function recoverClaudeUpdate(profile) {
  const destination = path.join(profile, directoryName), backup = path.join(profile, backupName);
  if (await exists(backup)) {
    await fs.rm(destination, {recursive:true, force:true});
    await fs.rename(backup, destination);
  }
  for (const name of await fs.readdir(profile)) if (name.startsWith('claude-stage-')) await fs.rm(path.join(profile,name), {recursive:true, force:true});
}
function createClaudeUpdates({ profile, getVersion, unload, load, changed = () => {}, stage = stageClaude }) {
  let state = {status:'idle', version:'', message:'Not checked yet.'}, busy = false, candidate = null;
  const destination = path.join(profile, directoryName), backup = path.join(profile, backupName);
  const set = value => { state = {...state, ...value}; changed(); };
  const discard = async () => { const staged = candidate; candidate = null; if (staged) await fs.rm(staged.directory, {recursive:true, force:true}); };
  async function run(action) {
    if (busy) throw new Error('Wait for the current Claude operation to finish.');
    busy = true;
    try { return await action(); } finally { busy = false; changed(); }
  }
  return {
    get state() { return state; }, get busy() { return busy; }, run,
    async clear() { await discard(); set({status:'idle', version:'', message:'Not checked yet.', checkedAt:undefined}); },
    check() { return run(async () => {
      const installed = getVersion();
      if (!installed) throw new Error('Install Claude before checking for updates.');
      set({status:'checking', version:'', message:'Checking the Chrome Web Store…'});
      try {
        await discard();
        candidate = await stage(profile);
        const version = candidate.version;
        const newer = compareVersions(version, installed) > 0;
        if (!newer) await discard();
        set({status:newer ? 'available' : 'current', version:newer ? version : installed, checkedAt:new Date().toISOString(), message:newer ? `Claude ${version} is ready to install.` : 'Claude is up to date.'});
      } catch (error) { await discard().catch(failure => console.error('Claude stage cleanup:', failure.message)); set({status:'error', version:'', message:error.message}); throw error; }
    }); },
    install({initial = false} = {}) { return run(async () => {
      if (!initial && !candidate) throw new Error('Check for a Claude update before installing.');
      set({status:'installing', message:initial ? 'Downloading Claude from the Chrome Web Store…' : 'Installing Claude update…'});
      let previous = false, swapped = false, unloaded = false;
      try {
        if (initial) { await discard(); candidate = await stage(profile); }
        if (await exists(backup)) throw new Error('A previous Claude update needs recovery. Restart Dioptra.');
        previous = await exists(destination);
        // Keep the old directory until both the worker and the panel reopen.
        unloaded = true; await unload();
        if (previous) await fs.rename(destination, backup);
        await fs.rename(candidate.directory, destination); candidate = null; swapped = true;
        const extension = await load(destination);
        // Retire the backup atomically before cleanup, so an interrupted deletion
        // cannot be mistaken for a recoverable previous installation at startup.
        if (previous) {
          const retired = path.join(profile, `claude-stage-retired-${Date.now()}`);
          await fs.rename(backup, retired);
          await fs.rm(retired, {recursive:true, force:true}).catch(error => console.error('Claude backup cleanup:', error.message));
        }
        set({status:'current', version:extension.version, message:initial ? 'Claude installed.' : 'Claude update installed.'});
        return extension;
      } catch (error) {
        let restored = false, recoveryError;
        try {
          if (unloaded) {
            await unload();
            if (swapped) await fs.rm(destination, {recursive:true, force:true});
            if (await exists(backup)) await fs.rename(backup, destination);
            if (previous) { await load(destination); restored = true; }
          }
        } catch (failure) { recoveryError = failure; }
        await discard().catch(failure => console.error('Claude stage cleanup:', failure.message));
        const message = `${error.message}${restored ? ' Previous Claude version restored.' : ''}${recoveryError ? ` Recovery failed: ${recoveryError.message}. Previous files are retained; restart Dioptra.` : ''}`;
        set({status:'error', version:'', message});
        throw new Error(message, {cause:error});
      }
    }); }
  };
}
module.exports = { createClaudeUpdates, recoverClaudeUpdate, compareVersions };
