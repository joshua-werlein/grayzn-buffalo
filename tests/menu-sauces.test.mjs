// Sauces as its own, reorderable public Menu section. Build first. Local SQLite fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { fixture } from './specials-fixture.mjs';
import { loadTs } from './load-ts.mjs';
const { saucesIndex, validSaucesSort, SAUCES_SORT_KEY } = loadTs('src/lib/menu-sauces.ts');

const baseline = JSON.parse(readFileSync('src/data/menu-baseline.json', 'utf8'));
const schema = readFileSync('schema.sql', 'utf8');
const menu = (await import('../dist/_worker.js/pages/menu.astro.mjs')).page().default;
const admin = (await import('../dist/_worker.js/pages/admin/menu.astro.mjs')).page().default;
const menuJson = (await import('../dist/_worker.js/pages/menu.json.astro.mjs')).page();
const container = await AstroContainer.create();
const cookie = 'gb_session=' + 'a'.repeat(32);
// Seeded by migrations/0027_wing_wednesday.sql: the only verified sauce list.
const seeded = ['Sweet Chili', 'BBQ', 'Honey BBQ', 'Jack BBQ', 'Sweet & Sour', 'Honey Garlic', 'Ranch', 'Chipotle Ranch',
  'Mango Habanero', 'Boom Boom', 'Sriracha Ranch', 'Buffalo', 'Teriyaki', 'Honey Mustard', 'Garlic Parmesan', 'Signature'];
const NOTE = 'Pair any sauce with anything on the menu. Available every day.';
const LIVE = 'ww-live:ww-default:sauces';
const tableSql = table => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0];

function menuFixture(t) {
  const f = fixture(t);
  f.env.SESSIONS = { get: async () => '1' };
  for (const table of ['categories', 'items']) {
    f.sql(tableSql(table));
    for (const row of baseline[table]) {
      const keys = Object.keys(row);
      f.sql(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...Object.values(row));
    }
  }
  return f;
}
const request = (f, path, init = {}) => ({ request: new Request('http://localhost' + path, { ...init, headers: { cookie, ...(init.headers ?? {}) } }), locals: { runtime: { env: f.env } } });
const render = (f, page = menu, path = '/menu') => container.renderToString(page, request(f, path));
const json = async f => (await (await menuJson.GET({ locals: { runtime: { env: f.env } } })).json()).sections;
const sortsOf = f => Object.fromEntries(f.sql('SELECT id,sort FROM categories ORDER BY id').map(r => [r.id, r.sort]));
const saved = f => f.sql('SELECT value FROM settings WHERE key=?', SAUCES_SORT_KEY)[0]?.value ?? null;
async function reorder(f, fields) {
  const body = new FormData();
  body.set('action', 'reorder-sections');
  for (const [id, sort] of Object.entries(sortsOf(f))) body.set(`sort_${id}`, String(sort));
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
  const response = await container.renderToResponse(admin, request(f, '/admin/menu', { method: 'POST', headers: { origin: 'http://localhost' }, body }));
  return response.headers.get('location');
}
const setCategorySort = (f, name, sort) => f.sql('UPDATE categories SET sort=? WHERE name=?', sort, name);
const decode = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// Section headings per column of one tab, in page order.
function layout(html, tab) {
  const start = html.indexOf(`id="panel-${tab}"`);
  const end = tab === 'daily' ? html.indexOf('id="panel-late-night"') : html.indexOf('class="consumer-advisory"');
  return html.slice(start, end).split('<div class="menu-column"').slice(1)
    .map(column => [...column.matchAll(/<section class="cat-section[^"]*"[^>]*>\s*<h2[^>]*>(.*?)<\/h2>/g)].map(m => decode(m[1])));
}
const sauceSections = html => [...html.matchAll(/<section class="cat-section sauces-section"[\s\S]*?<\/section>/g)].map(m => m[0]);
const chips = html => [...html.matchAll(/<div class="chip-links"[^>]*>([\s\S]*?)<\/div>/g)][0][1].match(/>([^<]+)<\/a>/g).map(s => decode(s.slice(1, -4)));
const options = html => [...html.matchAll(/<option value="(#[^"]+)"[^>]*>([^<]+)<\/option>/g)].map(m => [m[1], decode(m[2])]);
const left = (columns, name) => columns.findIndex(c => c.includes(name));
const after = (columns, first, second) => { const c = columns.find(col => col.includes(first)); return !!c && c.indexOf(second) === c.indexOf(first) + 1; };

test('position rules: tie goes after, default after Appetizers, inputs are whole numbers 0–999', () => {
  const cats = [{ name: 'Appetizers', sort: 0 }, { name: 'Baskets', sort: 1 }, { name: 'Pizzas', sort: 5 }];
  assert.equal(saucesIndex(cats, null), 1);
  assert.equal(saucesIndex(cats, 0), 1);
  assert.equal(saucesIndex(cats, 5), 3);
  assert.equal(saucesIndex(cats, 3), 2);
  assert.equal(saucesIndex([{ name: 'Burgers', sort: 4 }], null), 1, 'no Appetizers: last');
  assert.equal(saucesIndex([{ name: 'Burgers', sort: 4 }], 2), 0, 'below every section: first');
  for (const bad of ['-1', '1.5', 'abc', '1000', '', ' ', null, undefined, '1e2']) assert.equal(validSaucesSort(bad), null, String(bad));
  assert.equal(validSaucesSort('007'), 7);
  assert.equal(validSaucesSort(' 999 '), 999);
});

test('default: one Sauces section per tab, right after Appetizers, styled as a section with the disclaimer and no prices', async t => {
  const f = menuFixture(t);
  const html = await render(f);
  const found = sauceSections(html);
  assert.equal(found.length, 2, 'Daily and Late Night each show it exactly once');
  for (const section of found) {
    assert.match(section, /<h2[^>]*>Sauces<\/h2>/);
    assert.ok(section.includes(NOTE.replace(/'/g, '&#39;')) || section.includes(NOTE));
    assert.deepEqual([...section.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(m => decode(m[1])), seeded);
    assert.doesNotMatch(section, /\$|¢|price|charg|surcharge|\bfree\b|every appetizer|all appetizers|included/i);
  }
  assert.equal((html.match(/id="menu-sauces"/g) ?? []).length, 1, 'one anchor, on the Daily tab');
  assert.doesNotMatch(html, /id="sec-sauces"/, 'never a category-style anchor');
  assert.doesNotMatch(html, /class="sauce-options"/, 'no longer nested inside Appetizers');
  const daily = layout(html, 'daily'), late = layout(html, 'late-night');
  assert.ok(after(daily, 'Appetizers', 'Sauces') && after(late, 'Appetizers', 'Sauces'));
  assert.equal(chips(html).slice(0, 3).join('|'), 'Appetizers|Sauces|Baskets');
  assert.deepEqual(options(html).slice(0, 2), [['#sec-appetizers', 'Appetizers'], ['#menu-sauces', 'Sauces']]);
  // Every other section keeps its column (Sauces only joins its neighbour's column).
  const withoutSauces = cols => cols.map(c => c.filter(name => name !== 'Sauces'));
  const before = layout(await render((() => { const g = menuFixture(t); g.sql("UPDATE special_groups SET enabled=0 WHERE id=?", LIVE); return g; })()), 'daily');
  assert.deepEqual(withoutSauces(daily), before);
  // Pizza choices and every active item are still on the page.
  assert.equal((html.match(/aria-label="Pizza choices"/g) ?? []).length, 2);
  for (const item of baseline.items.filter(i => i.active === 1)) assert.ok(html.includes(item.name.replace(/&/g, '&amp;').replace(/'/g, '&#39;')), item.name);
  const sections = await json(f);
  assert.deepEqual(sections.slice(0, 3).map(s => s.name), ['Appetizers', 'Sauces', 'Baskets']);
  assert.deepEqual(sections[1], { name: 'Sauces', note: NOTE, sauces: seeded });
  assert.equal(sections.filter(s => s.name === 'Sauces').length, 1);
  assert.ok(!('sauceOptions' in sections[0]));
});

test('Admin lists Sauces in Manage Sections at its position, with a link to edit names in Wing Wednesday', async t => {
  const f = menuFixture(t);
  const html = await render(f, admin, '/admin/menu');
  const rows = [...html.matchAll(/class="sm-sort-input"[^>]*name="(sort_[a-z0-9]+)"[^>]*value="(\d+)"/g)].map(m => [m[1], m[2]]);
  const at = rows.findIndex(([name]) => name === 'sort_sauces');
  assert.equal(rows[at - 1][0], `sort_${baseline.categories.find(c => c.name === 'Appetizers').id}`);
  assert.equal(rows[at][1], String(baseline.categories.find(c => c.name === 'Appetizers').sort), 'shows its effective number');
  assert.match(html, /aria-label="Sort order for Sauces"/);
  assert.match(html, /<a class="sm-sauces-link" href="\/admin\/specials"[^>]*>Edit sauces<\/a>/);
  assert.match(html, /16 sauces from Wing Wednesday/);
  assert.doesNotMatch(html, /class="sm-edit-btn"[^>]*data-name="Sauces"/, 'not a category: no rename or delete');
});

test('reordering persists in D1, survives later requests, and applies to both tabs and menu.json', async t => {
  const f = menuFixture(t);
  const categoriesBefore = sortsOf(f);
  const pizzas = baseline.categories.find(c => c.name === 'Pizzas');
  assert.equal(await reorder(f, { sort_sauces: pizzas.sort, sort_sauces_was: 0 }), '/admin/menu?sm=s3');
  assert.equal(saved(f), String(pizzas.sort));
  assert.deepEqual(sortsOf(f), categoriesBefore, 'category order untouched');
  for (let request = 0; request < 2; request++) {
    const html = await render(f);
    const daily = layout(html, 'daily'), late = layout(html, 'late-night');
    assert.ok(after(daily, 'Pizzas', 'Sauces'), JSON.stringify(daily));
    assert.ok(after(late, 'Pizzas', 'Sauces'), 'Late Night follows the same order, in Pizzas’ column');
    assert.equal(sauceSections(html).length, 2);
    const order = chips(html);
    assert.equal(order[order.indexOf('Pizzas') + 1], 'Sauces');
    const names = (await json(f)).map(s => s.name);
    assert.equal(names[names.indexOf('Pizzas') + 1], 'Sauces');
    assert.equal(names.filter(n => n === 'Sauces').length, 1);
  }
  const adminRows = [...(await render(f, admin, '/admin/menu')).matchAll(/name="(sort_[a-z0-9]+)"[^>]*value="(\d+)"/g)].map(m => m[1]);
  assert.equal(adminRows[adminRows.indexOf('sort_sauces') - 1], `sort_${pizzas.id}`);

  // Above everything: give the sections higher numbers and Sauces 0.
  for (const [id, sort] of Object.entries(categoriesBefore)) f.sql('UPDATE categories SET sort=? WHERE id=?', sort + 10, id);
  assert.equal(await reorder(f, { sort_sauces: 0, sort_sauces_was: pizzas.sort }), '/admin/menu?sm=s3');
  const html = await render(f);
  assert.equal(layout(html, 'daily')[0][0], 'Sauces');
  assert.equal(layout(html, 'late-night')[0][0], 'Sauces');
  assert.equal(chips(html)[0], 'Sauces');
  assert.equal((await json(f))[0].name, 'Sauces');
});

test('an unchanged Sauces number is not saved, so the default keeps following Appetizers', async t => {
  const f = menuFixture(t);
  assert.equal(await reorder(f, { sort_sauces: 0, sort_sauces_was: 0 }), '/admin/menu?sm=s3');
  assert.equal(saved(f), null);
  setCategorySort(f, 'Appetizers', 7);
  const html = await render(f);
  assert.ok(after(layout(html, 'daily'), 'Appetizers', 'Sauces'));
  assert.ok(after(layout(html, 'late-night'), 'Appetizers', 'Sauces'));
});

test('invalid Sauces numbers are rejected and change nothing', async t => {
  const f = menuFixture(t);
  const before = sortsOf(f);
  for (const bad of ['-1', '1.5', 'abc', '1000', '']) {
    assert.equal(await reorder(f, { sort_sauces: bad, sort_sauces_was: 0, [`sort_${baseline.categories[0].id}`]: 42 }), '/admin/menu?sm=e6', bad);
    assert.equal(saved(f), null);
    assert.deepEqual(sortsOf(f), before, 'the whole save is refused, categories included');
  }
  assert.match(await render(f, admin, '/admin/menu?sm=e6'), /Sauces order must be a whole number from 0 to 999\./);
  // A post without the Sauces field (an older page) still saves category order.
  const body = new FormData(); body.set('action', 'reorder-sections'); body.set(`sort_${baseline.categories[1].id}`, '30');
  await container.renderToResponse(admin, request(f, '/admin/menu', { method: 'POST', headers: { origin: 'http://localhost' }, body }));
  assert.equal(sortsOf(f)[baseline.categories[1].id], 30);
  assert.equal(saved(f), null);
});

test('reads the live Wing Wednesday slot staff edit; empty, disabled or missing data hides Sauces everywhere', async t => {
  const f = menuFixture(t);
  f.sql('UPDATE special_slots SET content=? WHERE group_id=? AND position=1', 'Ranch\nBuffalo, Garlic Parmesan\nRanch', LIVE);
  f.sql("UPDATE special_slots SET content='Defaults Only' WHERE group_id='ww-default:sauces' AND position=1");
  let html = await render(f);
  assert.deepEqual([...sauceSections(html)[0].matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(m => m[1]), ['Ranch', 'Buffalo', 'Garlic Parmesan']);
  assert.doesNotMatch(html, /Defaults Only/);

  for (const hide of [() => f.sql('UPDATE special_groups SET enabled=0 WHERE id=?', LIVE), () => f.sql("UPDATE special_slots SET content='  ' WHERE group_id=?", LIVE)]) {
    hide();
    html = await render(f);
    assert.equal(sauceSections(html).length, 0);
    assert.ok(!chips(html).includes('Sauces'));
    assert.ok(!options(html).some(([href]) => href === '#menu-sauces'));
    assert.ok(!(await json(f)).some(s => s.name === 'Sauces'));
    assert.match(html, /Mozzarella Sticks/);
    assert.match(await render(f, admin, '/admin/menu'), /Hidden on the Menu: the Wing Wednesday sauce list is empty/);
  }

  // A database without the specials schema (as in the pizza fixture) still renders the Menu.
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const table of ['categories', 'items', 'settings']) db.exec(tableSql(table));
  for (const table of ['categories', 'items']) for (const row of baseline[table]) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  }
  const env = { DB: { prepare(sql) { const st = db.prepare(sql); const q = a => ({ bind: (...b) => q(b), first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }) }); return q([]); } } };
  html = await container.renderToString(menu, { request: new Request('http://localhost/menu'), locals: { runtime: { env } } });
  assert.equal(sauceSections(html).length, 0);
  assert.match(html, /Mozzarella Sticks/);
});

test('sauce text is escaped', async t => {
  const f = menuFixture(t);
  f.sql('UPDATE special_slots SET content=? WHERE group_id=?', '<img src=x onerror=alert(1)>\nRanch', LIVE);
  const html = await render(f);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(sauceSections(html)[0], /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// ── Collision with an ordinary category named "Sauces" (Sol's review) ────────
async function section(f, action, fields) {
  const body = new FormData();
  body.set('action', action);
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
  return (await container.renderToResponse(admin, request(f, '/admin/menu', { method: 'POST', headers: { origin: 'http://localhost' }, body }))).headers.get('location');
}
const ids = html => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const duplicates = list => list.filter((value, i) => list.indexOf(value) !== i);
const headings = html => [...html.matchAll(/<section class="cat-section[^"]*"[^>]*>\s*<h2[^>]*>(.*?)<\/h2>/g)].map(m => decode(m[1]));
// Everything a collision could break, on every surface.
async function assertNoCollision(f, staffName) {
  const html = await render(f);
  assert.deepEqual(duplicates(ids(html)), [], 'every HTML id is unique');
  const wing = sauceSections(html);
  assert.equal(wing.length, 2, 'one Wing Wednesday sauce section per tab');
  for (const s of wing) {
    assert.deepEqual([...s.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(m => decode(m[1])), seeded);
    assert.ok(s.includes(NOTE));
    assert.doesNotMatch(s, /\$|price|surcharge/i);
  }
  const wingName = decode(wing[0].match(/<h2[^>]*>(.*?)<\/h2>/)[1]);
  assert.notEqual(wingName.toLowerCase(), staffName.toLowerCase(), 'the two sections have different headings');
  for (const tab of ['daily', 'late-night']) {
    const names = layout(html, tab).flat();
    assert.deepEqual(duplicates(names.map(n => n.toLowerCase())), [], `${tab}: no repeated section heading`);
  }
  assert.ok(headings(html).includes(staffName), 'the staff section is still shown');
  assert.match(html, /Staff Dip/, 'with its items');
  const chipNames = chips(html), opts = options(html);
  assert.deepEqual(duplicates(chipNames.map(n => n.toLowerCase())), [], 'unambiguous jump links');
  assert.deepEqual(duplicates(opts.map(([href]) => href)), [], 'unique jump targets');
  for (const [href] of opts) assert.equal(ids(html).filter(id => '#' + id === href).length, 1, `${href} has exactly one target`);
  assert.ok(chipNames.includes(staffName) && chipNames.includes(wingName));
  const sections = await json(f);
  assert.deepEqual(duplicates(sections.map(s => s.name.toLowerCase())), [], 'menu.json names are unique');
  assert.equal(sections.filter(s => s.sauces).length, 1, 'one Wing Wednesday sauce list in menu.json');
  assert.deepEqual(sections.find(s => s.sauces), { name: wingName, note: NOTE, sauces: seeded });
  assert.deepEqual(sections.find(s => s.name === staffName).items.map(i => i.name), ['Staff Dip']);
  const adminHtml = await render(f, admin, '/admin/menu');
  assert.equal((adminHtml.match(/name="sort_sauces"/g) ?? []).length, 1);
  assert.match(adminHtml, new RegExp(`data-name="${staffName}"`), 'the staff section stays editable');
  assert.match(adminHtml, new RegExp(`aria-label="Sort order for ${wingName}"`));
  return { html, wingName };
}
const addStaffItem = (f, name) => {
  const id = f.sql('SELECT id FROM categories WHERE name=?', name)[0].id;
  f.sql("INSERT INTO items (category_id,name,description,sort,active,late_night) VALUES (?,'Staff Dip','',0,1,1)", id);
  return id;
};

test('COLLISION: a section created in Admin as "Sauces" keeps its items and never duplicates the sauce section', async t => {
  const f = menuFixture(t);
  assert.equal(await section(f, 'add-section', { name: 'Sauces', subtitle: '', note: '' }), '/admin/menu?sm=s1');
  addStaffItem(f, 'Sauces');
  const { wingName } = await assertNoCollision(f, 'Sauces');
  assert.equal(wingName, 'Wing Wednesday Sauces');
  assert.equal(f.sql("SELECT count(*) AS n FROM categories WHERE name='Sauces'")[0].n, 1, 'the staff section is not renamed or removed');
});

test('COLLISION: renaming a section to "sauces" in any case, and older mixed-case data, are handled', async t => {
  const f = menuFixture(t);
  assert.equal(await section(f, 'add-section', { name: 'Dips', subtitle: '', note: '' }), '/admin/menu?sm=s1');
  const id = addStaffItem(f, 'Dips');
  assert.equal(await section(f, 'edit-section', { category_id: id, name: '  sauces ', subtitle: 'House made', note: '' }), '/admin/menu?sm=s2');
  assert.equal(f.sql('SELECT name FROM categories WHERE id=?', id)[0].name, 'Sauces');
  await assertNoCollision(f, 'Sauces');
  // Data saved before house capitalization, or edited elsewhere.
  f.sql("UPDATE categories SET name='SAUCES' WHERE id=?", id);
  await assertNoCollision(f, 'SAUCES');
  // A second-level collision still yields a unique heading.
  f.sql("INSERT INTO categories (name,sort) VALUES ('Wing Wednesday Sauces',50)");
  f.sql("INSERT INTO items (category_id,name,description,sort,active,late_night) VALUES ((SELECT id FROM categories WHERE name='Wing Wednesday Sauces'),'Other','',0,1,0)");
  const sections = await json(f);
  assert.deepEqual(duplicates(sections.map(s => s.name.toLowerCase())), []);
  assert.equal(sections.find(s => s.sauces).name, 'Wing Wednesday Sauces 2');
  assert.deepEqual(duplicates(ids(await render(f))), []);
});

test('COLLISION: saved order still moves only the Wing Wednesday sauce section; the staff section keeps its own number', async t => {
  const f = menuFixture(t);
  await section(f, 'add-section', { name: 'Sauces', subtitle: '', note: '' });
  addStaffItem(f, 'Sauces');
  const staffSort = f.sql("SELECT sort FROM categories WHERE name='Sauces'")[0].sort;
  const pizzas = baseline.categories.find(c => c.name === 'Pizzas');
  assert.equal(await reorder(f, { sort_sauces: pizzas.sort, sort_sauces_was: 0 }), '/admin/menu?sm=s3');
  assert.equal(saved(f), String(pizzas.sort));
  assert.equal(f.sql("SELECT sort FROM categories WHERE name='Sauces'")[0].sort, staffSort);
  const { html, wingName } = await assertNoCollision(f, 'Sauces');
  for (const tab of ['daily', 'late-night']) assert.ok(after(layout(html, tab), 'Pizzas', wingName), tab);
  const names = (await json(f)).map(s => s.name);
  assert.equal(names[names.indexOf('Pizzas') + 1], wingName);
  assert.equal(names.at(-1), 'Sauces', 'the staff section stays at its own position (added last)');
});
