const test = require('node:test');
const assert = require('node:assert/strict');
const { createBudget, BudgetError, StoppedError, siteLimit, forSite, BROWSE, COMPARE, BROWSE_LIMIT, COMPARE_LIMIT, AT_ONCE, WINDOW_MS, SITE_PER_PAGE, SITE_ONCE } = require('../src/host-budget.cjs');

test('review 11: one counter per site for all add-ons and all pages, over a rolling ten minutes', async () => {
  let clock = 1000000;
  const budget = createBudget({ now: () => clock });
  // Three add-ons scanning many different pages of one site: every request counts for the same host, www or not.
  let done = 0;
  for (let i = 0; i < BROWSE_LIMIT; i++) { await budget.ask(i % 2 ? 'www.shop.example' : 'Shop.Example.', i % 3 ? 'hostfile' : 'live', BROWSE, async () => { done++; }); }
  assert.equal(done, 120); assert.equal(budget.used('shop.example'), 120);
  let reached = false;
  await assert.rejects(budget.ask('shop.example', 'hostfile', BROWSE, async () => { reached = true; }), error => error instanceof BudgetError && /Too many requests to this site/.test(error.message));
  assert.equal(reached, false, 'request 121 never reaches the site');
  // Another site has its own counter.
  await budget.ask('other.example', 'hostfile', BROWSE, async () => {});
  // A comparison the user starts may go further, booked in the same counter; browsing stays refused meanwhile.
  await budget.ask('shop.example', 'hostfile', COMPARE, async () => { done++; });
  assert.equal(budget.used('shop.example'), 121);
  await assert.rejects(budget.ask('shop.example', 'live', BROWSE, async () => {}), BudgetError);
  // What browsing booked counts against a comparison: 120 + 240 is its 360.
  for (let i = 0; i < COMPARE_LIMIT - 121; i++) budget.take('shop.example', COMPARE);
  assert.throws(() => budget.take('shop.example', COMPARE), BudgetError);
  // Ten minutes later the window is empty again.
  clock += WINDOW_MS + 1;
  assert.equal(budget.used('shop.example'), 0);
  await budget.ask('shop.example', 'hostfile', BROWSE, async () => { done++; });
  assert.equal(done, 122);
});

test('review 11: at most four requests at a time per server of a site, whoever asks', async () => {
  const budget = createBudget();
  let now = 0, most = 0, live = 0, mostLive = 0; const release = [];
  const slow = () => new Promise(resolve => { now++; most = Math.max(most, now); release.push(() => { now--; resolve(); }); });
  // Twelve requests from "three add-ons" at the same moment, plus two for the other server.
  const all = Array.from({ length: 12 }, () => budget.ask('shop.example', 'hostfile', COMPARE, slow));
  const other = Array.from({ length: 2 }, () => budget.ask('shop.example', 'live', COMPARE, async () => { live++; mostLive = Math.max(mostLive, live); await new Promise(r => setImmediate(r)); live--; }));
  for (let round = 0; round < 12; round++) { await new Promise(r => setImmediate(r)); assert.ok(now <= AT_ONCE, `${now} at a time`); release.shift()?.(); await new Promise(r => setImmediate(r)); }
  while (release.length) { release.shift()(); await new Promise(r => setImmediate(r)); }
  await Promise.all([...all, ...other]);
  assert.equal(most, 4); assert.equal(AT_ONCE, 4); assert.ok(mostLive >= 1 && mostLive <= 4, 'the other server has its own lane');
  // A request that fails gives its place back.
  await assert.rejects(budget.ask('shop.example', 'hostfile', COMPARE, async () => { throw new Error('boom'); }), /boom/);
  await budget.ask('shop.example', 'hostfile', COMPARE, async () => {});
});

test('a whole-site run has its own explicit limit, through the same counter', async () => {
  assert.equal(siteLimit(20), COMPARE_LIMIT + SITE_ONCE + 20 * SITE_PER_PAGE); assert.equal(siteLimit(20), 880); assert.equal(siteLimit(50), 1480); assert.equal(siteLimit(0), siteLimit(1));
  const budget = createBudget(), run = forSite(5);
  assert.deepEqual(run, { kind: 'site', limit: siteLimit(5) });
  // What browsing and a comparison booked counts against the run.
  for (let i = 0; i < 10; i++) budget.take('shop.example', BROWSE);
  for (let i = 0; i < 20; i++) budget.take('shop.example', COMPARE);
  for (let i = 0; i < run.limit - 30; i++) budget.take('shop.example', run);
  assert.throws(() => budget.take('shop.example', run), BudgetError, 'the run has reached its limit');
  assert.equal(budget.used('shop.example'), run.limit);
  // A run the user asked for does not leave browsing without scans: browsing still has what is left of its own 120.
  for (let i = 0; i < BROWSE_LIMIT - 10; i++) budget.take('shop.example', BROWSE);
  assert.throws(() => budget.take('shop.example', BROWSE), BudgetError);
});

test('review 7 of beta.4: the counter forgets hosts without recent requests and does not follow the clock of the computer', async () => {
  let clock = 0;
  const budget = createBudget({ now: () => clock });
  for (let i = 0; i < 300; i++) { budget.take(`site${i}.example`, BROWSE); clock += 1000; }
  assert.equal(budget.hosts(), 300, 'all within ten minutes');
  clock += WINDOW_MS;
  budget.take('one-more.example', BROWSE);
  assert.equal(budget.hosts(), 1, 'the map does not grow with every site ever visited');
  // The default clock only goes forward: putting the computer's clock back or forward changes nothing.
  const real = createBudget(), was = Date.now;
  try {
    for (let i = 0; i < BROWSE_LIMIT; i++) real.take('shop.example', BROWSE);
    Date.now = () => was() + 24 * 3600 * 1000;
    assert.throws(() => real.take('shop.example', BROWSE), BudgetError, 'a clock set a day ahead does not reset the budget');
    Date.now = () => was() - 24 * 3600 * 1000;
    assert.throws(() => real.take('shop.example', BROWSE), BudgetError, 'a clock set back does not either');
    real.take('other.example', BROWSE);
  } finally { Date.now = was; }
});

test('review 5 of beta.4: a request whose asker is gone when its turn comes is neither counted nor sent', async () => {
  const budget = createBudget({ atOnce: 1 });
  let wanted = true, sent = 0; const gate = []; const slow = () => new Promise(resolve => { sent++; gate.push(resolve); });
  const first = budget.ask('shop.example', 'hostfile', COMPARE, slow, () => wanted), second = budget.ask('shop.example', 'hostfile', COMPARE, slow, () => wanted), third = budget.ask('shop.example', 'hostfile', COMPARE, slow);
  await new Promise(r => setImmediate(r));
  wanted = false; gate.shift()();
  await first;
  await assert.rejects(second, error => error instanceof StoppedError && error.message === 'The scan has ended.');
  await new Promise(r => setImmediate(r)); gate.shift()(); await third;
  assert.equal(sent, 2, 'the second request never left'); assert.equal(budget.used('shop.example'), 2);
});
