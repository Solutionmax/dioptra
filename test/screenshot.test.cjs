// Pure parts of the camera button: tiles of a full page, the file name, a free name in Downloads, saving and the clipboard call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { tilePlan, fileName, freeName, savePng, copyPng, MAX_SIDE, MAX_WIDTH_CSS, PIXEL_BUDGET } = require('../src/screenshot.cjs');

test('a short page is one tile at its own height', () => {
  assert.deepEqual(tilePlan(2914, 1, 1424), { width: 1424, height: 2914, cut: false, tiles: [{ y: 0, h: 2914 }] });
});

test('a long page is split into tiles of 8000 device pixels that cover it exactly', () => {
  const plan = tilePlan(10000, 2);
  assert.equal(plan.cut, false);
  assert.deepEqual(plan.tiles, [{ y: 0, h: 4000 }, { y: 4000, h: 4000 }, { y: 8000, h: 2000 }]);
  assert.equal(plan.tiles.reduce((sum, t) => sum + t.h, 0), 10000);
});

test('a page taller than one canvas can hold is cut, with room left for the label bars', () => {
  const plan = tilePlan(50000, 2);
  assert.equal(plan.cut, true);
  assert.ok(plan.height * 2 + 220 <= MAX_SIDE, `${plan.height} css px at 2x leaves no room`);
  assert.equal(plan.tiles.at(-1).y + plan.tiles.at(-1).h, plan.height);
});

test('a page that makes itself absurdly wide is cut to the maximum width and stays within the pixel budget', () => {
  const plan = tilePlan(3000, 2, 5000000);
  assert.equal(plan.width, MAX_WIDTH_CSS); assert.equal(plan.cut, true);
  assert.ok(plan.width * plan.height * 4 <= PIXEL_BUDGET, `${plan.width} x ${plan.height} at 2x is over the budget`);
});

test('Compare shares the pixel budget between the panes', () => {
  const one = tilePlan(100000, 2, 3000, 1), two = tilePlan(100000, 2, 3000, 2);
  assert.ok(two.height < one.height);
  assert.ok(2 * two.width * two.height * 4 <= PIXEL_BUDGET);
});

test('nonsense sizes still give one valid tile', () => {
  assert.deepEqual(tilePlan(0, 0).tiles, [{ y: 0, h: 1 }]);
  assert.deepEqual(tilePlan(Number.NaN, Number.NaN).tiles, [{ y: 0, h: 1 }]);
});

test('file name has the host, what was captured, date and time like a macOS screenshot', () => {
  const when = new Date(2026, 10, 8, 14, 32, 5);
  assert.equal(fileName('northwind-bakery.test', 'compare', when), 'Dioptra northwind-bakery.test compare 2026-11-08 at 14.32.png');
  assert.equal(fileName('Shop.Example.COM', 'new server', when), 'Dioptra shop.example.com new server 2026-11-08 at 14.32.png');
});

test('file name keeps only safe characters from the host', () => {
  const when = new Date(2026, 0, 2, 3, 4);
  assert.equal(fileName('../../etc/passwd', 'live', when), 'Dioptra etcpasswd live 2026-01-02 at 03.04.png');
  assert.equal(fileName('', 'live', when), 'Dioptra page live 2026-01-02 at 03.04.png');
  assert.equal(fileName('xn--bcher-kva.example', 'live', when), 'Dioptra xn--bcher-kva.example live 2026-01-02 at 03.04.png');
});

test('a name that exists gets (2), (3) and so on', () => {
  const taken = new Set(['a.png', 'a (2).png']);
  assert.equal(freeName('b.png', n => taken.has(n)), 'b.png');
  assert.equal(freeName('a.png', n => taken.has(n)), 'a (3).png');
});

test('savePng writes into a new folder and never overwrites', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-shot-')), 'Downloads');
  try {
    const one = savePng(dir, 'x.png', Buffer.from('first')), two = savePng(dir, 'x.png', Buffer.from('second'));
    assert.equal(path.basename(one), 'x.png'); assert.equal(path.basename(two), 'x (2).png');
    assert.equal(fs.readFileSync(one, 'utf8'), 'first'); assert.equal(fs.readFileSync(two, 'utf8'), 'second');
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

test('copyPng hands one image/png item to the async clipboard', async () => {
  const written = [];
  class Item { constructor(items) { this.items = items; } }
  await copyPng({ write: async list => { written.push(...list); } }, Item, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(written.length, 1);
  const blob = written[0].items['image/png'];
  assert.equal(blob.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
});
