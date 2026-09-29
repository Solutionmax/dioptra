// OAuth uses strict TLS in its own partition. The original extension's session
// probe and embedded claude.ai UI must see the same cookies as that login page.
// Keep Chrome's token lifetime and Anthropic's cookie expiry/logout unchanged.
async function shareClaudeSession(web, auth) {
  const allowed = c => c.domain.replace(/^\./, '') === 'claude.ai';
  const key = c => JSON.stringify([c.domain, c.path, c.name]);
  const details = c => ({
    url: `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`,
    name: c.name, value: c.value, path: c.path, secure: c.secure,
    httpOnly: c.httpOnly, sameSite: c.sameSite,
    ...(!c.hostOnly ? { domain: c.domain } : {}),
    ...(!c.session ? { expirationDate: c.expirationDate } : {})
  });
  const find = async (store, cookie) => (await store.cookies.get({ name: cookie.name })).find(c => key(c) === key(cookie));
  const echoes = new Map([[web, new Map()], [auth, new Map()]]);
  const signature = (cookie, removed) => JSON.stringify([removed, details(cookie)]);
  const expect = (target, cookie, removed) => {
    const events = echoes.get(target), id = signature(cookie, removed);
    events.set(id, (events.get(id) || 0) + 1);
    return () => { const count = events.get(id); if (count > 1) events.set(id, count - 1); else events.delete(id); };
  };
  const copy = async (cookie, target, track = false) => {
    const existing = await find(target, cookie);
    if (!existing || JSON.stringify(details(existing)) !== JSON.stringify(details(cookie))) {
      const cancel = track ? expect(target, cookie, false) : () => {};
      try { await target.cookies.set(details(cookie)); } catch (error) { cancel(); throw error; }
    }
  };
  // Upgrade existing profiles: the strict login partition wins conflicts.
  const authCookies = (await auth.cookies.get({ domain: 'claude.ai' })).filter(allowed);
  const authKeys = new Set(authCookies.map(key));
  for (const cookie of (await web.cookies.get({ domain: 'claude.ai' })).filter(allowed)) {
    if (!authKeys.has(key(cookie))) await copy(cookie, auth);
  }
  for (const cookie of authCookies) await copy(cookie, web);
  let pending = Promise.resolve();
  const listen = (source, target) => source.cookies.on('changed', (_event, cookie, cause, removed) => {
    if (!allowed(cookie) || removed && cause === 'overwrite') return;
    const events = echoes.get(source), id = signature(cookie, removed), count = events.get(id);
    if (count) { if (count > 1) events.set(id, count - 1); else events.delete(id); return; }
    pending = pending.then(async () => {
      // External events stay ordered; echoes of our own writes never override a
      // later logout or rotation that arrived while a copy was still in flight.
      // Apply to both partitions: an earlier in-flight write may have replaced
      // the source value since this external event was received.
      for (const store of [source, target]) {
        if (!removed) { await copy(cookie, store, true); continue; }
        const existing = await find(store, cookie);
        if (!existing) continue;
        // Expire the exact domain/path tuple; remove(url, name) can match siblings.
        const cancel = expect(store, existing, true);
        try { await store.cookies.set({ ...details(existing), value: '', expirationDate: 1 }); }
        catch (error) { cancel(); throw error; }
      }
    }).catch(() => console.error('Claude session synchronization failed.'));
  });
  listen(auth, web); listen(web, auth);
  return {
    async flush() {
      let batch;
      do { batch = pending; await batch; } while (batch !== pending);
      await Promise.all([web.cookies.flushStore(), auth.cookies.flushStore()]);
    }
  };
}
module.exports = { shareClaudeSession };
