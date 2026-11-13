// A small add-on for the tests, not a real scanner. Threats: a page that names a host from its data, and a page that
// redirects visitors who come from Google. MARK tells one version of this file from the next.
const MARK = 'v1';
const plural = n => `${n} threat${n === 1 ? '' : 's'}`;

module.exports = {
  api: 1,
  async scan(ctx) {
    const sides = Object.keys(ctx.pages), hosts = Object.keys(ctx.data?.domains || {}), groups = [], findings = [];
    const loads = side => hosts.filter(host => ctx.pages[side].body.includes(`//${host}/`));
    const per = fn => Object.fromEntries(sides.map(side => [side, fn(side)]));
    const hit = [...new Set(sides.flatMap(loads))];
    if (hit.length) {
      groups.push({ id: 'script', label: 'Injected script', items: hit.map(host => ({
        title: `${MARK}: a script loads from ${host}`, tone: 'worse',
        values: per(side => (loads(side).includes(host) ? host : 'not found')), bad: per(side => loads(side).includes(host)),
        fix: ['remove it from ', { code: 'footer.php' }, ' and change all passwords.'],
        action: { label: 'Copy all', text: `grep -rl '${host}' .` },
        commands: [{ found: `https://${host}/jq.min.js`, where: 'script in the page', command: `grep -rl '${host}' wp-content/` }, { found: 'listed in the test list', where: 'no command' }],
      })) });
      findings.push({ text: `Malware: a script loads from ${hit[0]}.`, detail: sides.length === 2 && sides.every(side => loads(side).includes(hit[0])) ? 'It came along with the copy.' : '', severity: 'high' });
    }
    const moved = {};
    for (const side of sides) {
      const answer = await ctx.fetch(side, ctx.url, { referer: 'https://www.google.com/' });
      if (answer.status >= 300 && answer.status < 400) moved[side] = answer.headers.location;
    }
    if (Object.keys(moved).length) {
      groups.push({ id: 'redirect', label: 'Redirect', items: [{ title: 'Visitors from Google are sent to another site', tone: 'worse',
        values: per(side => (moved[side] ? `302 to ${moved[side]}` : '200 OK')), bad: per(side => Boolean(moved[side])), fix: ['look in ', { code: '.htaccess' }, '.'] }] });
      findings.push({ text: 'Visitors from Google are redirected.', severity: 'high' });
    }
    const problems = groups.reduce((n, g) => n + g.items.length, 0);
    const passed = [!hit.length && 'blocklist', !Object.keys(moved).length && 'redirect from Google'].filter(Boolean).map(name => ({ name }));
    return { label: 'Malware', counts: { problems, differ: 0, passed: passed.length, total: problems + passed.length },
      summary: [{ tone: problems ? 'bad' : 'ok', text: problems ? plural(problems) : 'No threats' }, { tone: 'ok', text: `${passed.length} clean` }],
      sub: `2 scans on ${sides.length === 2 ? 'both servers' : 'this server'}`, groups, passed, findings, note: 'A clean scan is no proof of a clean site.' };
  },
};
