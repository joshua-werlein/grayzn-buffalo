// Shared Menu options panels: Wraps, Salads (dressings, greens, shells) and the reorderable
// Substitute Sides section. Build first. Local SQLite fixtures only; nothing touches D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { fixture } from './specials-fixture.mjs';
import { SALAD_OPTIONS_KEY, SUBSTITUTE_SIDES_KEY, WRAP_OPTIONS_KEY, greensText } from '../src/lib/menu-options.js';

const baseline = JSON.parse(readFileSync('src/data/menu-baseline.json', 'utf8'));
const schema = readFileSync('schema.sql', 'utf8');
const menu = (await import('../dist/_worker.js/pages/menu.astro.mjs')).page().default;
const admin = (await import('../dist/_worker.js/pages/admin/menu.astro.mjs')).page().default;
const menuJson = (await import('../dist/_worker.js/pages/menu.json.astro.mjs')).page();
const container = await AstroContainer.create();
const cookie = 'gb_session=' + 'a'.repeat(32);
// From JJ's printed menu.
const DRESSINGS = ['French', 'Fat Free French', 'Ranch', 'Fat Free Ranch', 'Low Cal Ranch', 'Bleu Cheese', 'Raspberry Vinaigrette',
  'Italian', 'Thousand Island', 'Caesar', 'Honey Mustard', 'White Balsamic Shallot Vinaigrette'];
const SHELL_SALADS = ['Chef Salad', 'Taco Salad', 'Grilled/Crispy Chicken Salad', 'Caesar Salad'];
const SIDES = ['French Fries or Tots', 'Beer Fries, Sweet Potato Fries, or Waffle Fries', 'Steamed Broccoli or Side Salad', 'Mac ’n’ Cheese or Onion Rings'];
const WRAP_NOTES = ['Chicken can be Grilled or Crispy where applicable.', 'Any sandwich can be made into a wrap.',
  'All Wraps Served with Chips and a Pickle. See Substitute Sides.'];
const SIDES_NOTE = 'Available as substitutions for Wraps, Sandwiches and Burgers.';
const tableSql = table => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0];
const PRICE = /\$|¢|€|£|price|charg|surcharge|for free|no (?:extra )?(?:cost|charge)|included free|\bextra\b|\+\s*\d|\d+\.\d{2}/i;

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
const decode = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const setting = (f, key) => f.sql('SELECT value FROM settings WHERE key=?', key)[0]?.value ?? null;
async function post(f, fields, headers = { origin: 'http://localhost' }) {
  const body = new FormData();
  const optionsKey = { 'wrap-options': WRAP_OPTIONS_KEY, 'salad-options': SALAD_OPTIONS_KEY, 'substitute-sides': SUBSTITUTE_SIDES_KEY }[fields.action];
  if (optionsKey && !Object.hasOwn(fields, 'options_snapshot')) body.set('options_snapshot', setting(f, optionsKey) ?? '');
  if (fields.action === 'reorder-sections') {
    body.set('sort_sauces_snapshot', setting(f, 'menu_sauces_sort') ?? '');
    body.set('sort_sides_snapshot', setting(f, 'menu_substitute_sides_sort') ?? '');
  }
  for (const [key, value] of Object.entries(fields)) for (const v of [value].flat()) body.append(key, String(v));
  return container.renderToResponse(admin, request(f, '/admin/menu', { method: 'POST', headers, body }));
}
const panel = (html, cls) => [...html.matchAll(new RegExp(`<aside class="${cls}" data-options-panel[\\s\\S]*?<\\/aside>`, 'g'))].map(m => m[0]);
const listed = aside => [...aside.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(m => decode(m[1].replace(/<[^>]+>/g, '')));
// One category or virtual section of a tab, by heading.
function section(html, tab, heading) {
  const start = html.indexOf(`id="panel-${tab}"`), end = tab === 'daily' ? html.indexOf('id="panel-late-night"') : html.indexOf('class="consumer-advisory"');
  return [...html.slice(start, end).matchAll(/<section class="cat-section[^"]*"[^>]*>\s*<h2[^>]*>(.*?)<\/h2>([\s\S]*?)<\/section>/g)]
    .find(m => decode(m[1]) === heading)?.[2] ?? null;
}
function layout(html, tab) {
  const start = html.indexOf(`id="panel-${tab}"`), end = tab === 'daily' ? html.indexOf('id="panel-late-night"') : html.indexOf('class="consumer-advisory"');
  return html.slice(start, end).split('<div class="menu-column"').slice(1)
    .map(column => [...column.matchAll(/<section class="cat-section[^"]*"[^>]*>\s*<h2[^>]*>(.*?)<\/h2>/g)].map(m => decode(m[1])));
}
// Visible item names: the screen-reader-only text removed, the aria-hidden mark kept.
const itemNames = body => [...body.matchAll(/<strong[^>]*>(.*?)<\/strong>/g)]
  .map(m => decode(m[1].replace(/<span class="sr-only"[^>]*>.*?<\/span>/, '').replace(/<span aria-hidden="true"[^>]*>(.*?)<\/span>/, '$1')));
const visible = html => decode(html.replace(/<span class="sr-only"[^>]*>.*?<\/span>/g, '').replace(/<[^>]+>/g, ''));
const chips = html => [...html.matchAll(/<div class="chip-links"[^>]*>([\s\S]*?)<\/div>/g)][0][1].match(/>([^<]+)<\/a>/g).map(s => decode(s.slice(1, -4)));

test('defaults: every shared panel uses one design, sits under its heading and above the items, and shows no prices', async t => {
  const html = await render(menuFixture(t));
  for (const [heading, cls] of [['Wraps', 'wrap-options'], ['Salads', 'salad-options'], ['Pizzas', 'pizza-options'], ['Sauces', 'sauce-options'], ['Substitute Sides', 'substitute-sides-options']]) {
    const body = section(html, 'daily', heading);
    assert.ok(body, heading);
    const at = body.indexOf(`<aside class="${cls}" data-options-panel`);
    assert.ok(at >= 0, `${heading} has its panel`);
    const firstItem = body.indexOf('class="item"');
    if (firstItem >= 0) assert.ok(at < firstItem, `${heading}: panel before the items`);
    const aside = panel(body, cls)[0];
    assert.doesNotMatch(aside, /class="item"|<h2/, `${heading}: no items or section heading inside the panel`);
    assert.doesNotMatch(aside, PRICE, `${heading}: no prices`);
    assert.match(aside, /aria-label="[^"]+"/);
  }
});

test('Wraps: the three printed-menu notes, no tortilla list, and every wrap unchanged', async t => {
  const html = await render(menuFixture(t));
  const body = section(html, 'daily', 'Wraps');
  assert.deepEqual(listed(panel(body, 'wrap-options')[0]), WRAP_NOTES);
  assert.doesNotMatch(body, /tortilla|flavou?r/i);
  const wraps = baseline.items.filter(i => i.active === 1 && i.category_id === baseline.categories.find(c => c.name === 'Wraps').id).sort((a, b) => a.sort - b.sort);
  assert.deepEqual(itemNames(body), wraps.map(i => i.name));
  for (const wrap of wraps.filter(w => w.description)) assert.ok(decode(body).includes(wrap.description), wrap.name);
  // Sandwiches are untouched: no panel, no new asterisks.
  const sandwiches = section(html, 'daily', 'Sandwiches');
  assert.doesNotMatch(sandwiches, /data-options-panel/);
  assert.ok(itemNames(sandwiches).every(n => !n.startsWith('*')));
  const sections = await json(menuFixture(t));
  assert.deepEqual(sections.find(s => s.name === 'Wraps').wrapOptions, { notes: WRAP_NOTES });
});

test('Salads: all 12 dressings, Iceberg or Spinach Mix, and the shell notes, in one panel above the salads', async t => {
  const html = await render(menuFixture(t));
  const body = section(html, 'daily', 'Salads');
  const aside = panel(body, 'salad-options')[0];
  assert.deepEqual([...aside.matchAll(/<dt[^>]*>(.*?)<\/dt>/g)].map(m => m[1]), ['Dressings', 'Greens', 'Shells']);
  const dressings = listed(aside.match(/<dt[^>]*>Dressings<\/dt>[\s\S]*?<\/dd>/)[0]);
  assert.deepEqual(dressings, DRESSINGS);
  assert.equal(dressings.length, 12);
  assert.match(aside, /Choice of Iceberg or Spinach Mix\./);
  assert.ok(visible(aside).includes('† Indicates Salad Comes with a Shell. No Shells for Lighter Side Salads.'));
  assert.match(aside, /<span aria-hidden="true"[^>]*>†<\/span><span class="sr-only"[^>]*>Salads marked with a dagger:<\/span>/, 'screen readers hear words, not "dagger"');
  assert.doesNotMatch(aside, /\*/, 'no asterisk in the salad panel');
  assert.equal(greensText(['Iceberg']), 'Choice of Iceberg.');
  assert.equal(greensText(['Iceberg', 'Romaine', 'Spinach Mix']), 'Choice of Iceberg, Romaine or Spinach Mix.');
});

test('shell daggers mark exactly the four printed salads, never other salads, Lighter Side or Mexican Night', async t => {
  const f = menuFixture(t);
  const html = await render(f);
  const salads = itemNames(section(html, 'daily', 'Salads'));
  const marked = salads.filter(n => n.startsWith('†')).map(n => n.slice(1));
  assert.deepEqual(marked.sort(), [...SHELL_SALADS].sort());
  assert.ok(salads.every(n => !n.startsWith('*')), 'no salad uses the asterisk');
  for (const name of ['Side Salad', 'Chicken Chipotle Salad', 'Gyro Salad', 'Chicken Cranberry Salad', 'Hawaiian Chicken Salad']) assert.ok(salads.includes(name), name);
  assert.equal((section(html, 'daily', 'Salads').match(/<span class="sr-only"[^>]*> \(comes with a shell\)<\/span>/g) ?? []).length, 4);
  assert.ok(itemNames(section(html, 'daily', 'Mexican Night')).includes('Taco Salad'), 'Mexican Night Taco Salad stays unmarked');
  assert.ok(itemNames(section(html, 'daily', 'On The Lighter Side')).every(n => !/^[*†]/.test(n)));
  // Burgers keep their own (raw meat advisory) asterisk, on both tabs.
  assert.ok(itemNames(section(html, 'daily', 'Burgers')).every(n => n.startsWith('*') && !n.includes('†')));
  assert.ok(itemNames(section(html, 'late-night', 'Burgers')).every(n => n.startsWith('*')));
  assert.match(html, /\* Consuming raw or undercooked meat/);
  // Stored names are never changed.
  for (const name of SHELL_SALADS) assert.equal(f.sql('SELECT count(*) AS n FROM items WHERE name=?', name)[0].n, name === 'Taco Salad' ? 2 : 1);
  const sections = await json(f);
  const salad = sections.find(s => s.name === 'Salads');
  assert.deepEqual(salad.items.filter(i => i.shell).map(i => i.name).sort(), [...SHELL_SALADS].sort());
  assert.deepEqual(salad.saladOptions, { dressings: DRESSINGS, greens: ['Iceberg', 'Spinach Mix'], greensNote: 'Choice of Iceberg or Spinach Mix.',
    shellNote: '† Indicates Salad Comes with a Shell. No Shells for Lighter Side Salads.' });
  assert.ok(!sections.find(s => s.name === 'Mexican Night').items.some(i => i.shell));
});

test('Substitute Sides: its own section, last on the Daily Menu by default, off Late Night by default, with the four printed choices', async t => {
  const f = menuFixture(t);
  const html = await render(f);
  const body = section(html, 'daily', 'Substitute Sides');
  const aside = panel(body, 'substitute-sides-options')[0];
  assert.ok(decode(aside).includes(SIDES_NOTE));
  assert.deepEqual(listed(aside), SIDES);
  assert.doesNotMatch(aside, PRICE);
  assert.match(html, /<section class="cat-section substitute-sides-section"[^>]*id="menu-substitute-sides"/);
  const columns = layout(html, 'daily');
  const last = baseline.categories.filter(c => baseline.items.some(i => i.active && i.category_id === c.id)).sort((a, b) => a.sort - b.sort).at(-1).name;
  const column = columns.find(c => c.includes(last));
  assert.equal(column[column.indexOf(last) + 1], 'Substitute Sides', 'after the last section, in its column');
  assert.equal(chips(html).at(-1), 'Substitute Sides');
  assert.equal(section(html, 'late-night', 'Substitute Sides'), null, 'not on Late Night by default');
  const sections = await json(f);
  assert.deepEqual(sections.at(-1), { name: 'Substitute Sides', note: SIDES_NOTE, substituteSides: SIDES, lateNight: false });
  // The Baskets accompaniments are untouched.
  const baskets = decode(section(html, 'daily', 'Baskets'));
  for (const item of baseline.items.filter(i => i.active === 1 && i.description && i.category_id === baseline.categories.find(c => c.name === 'Baskets').id))
    assert.ok(baskets.includes(item.description), item.name);
  assert.doesNotMatch(baskets, /data-options-panel/);
});

test('Admin saves Wrap, Salad and Substitute Sides options; they persist across requests and reach the Menu and menu.json', async t => {
  const f = menuFixture(t);
  const adminHtml = await render(f, admin, '/admin/menu');
  for (const id of ['wrap-options', 'salad-options', 'substitute-sides-options']) assert.match(adminHtml, new RegExp(`<details class="pizza-manager options-manager" id="${id}"`));
  // Every salad item has a shell checkbox; the four printed ones start checked.
  for (const name of SHELL_SALADS) assert.match(adminHtml, new RegExp(`name="salad_shells" value="${name.replace('/', '\\/')}" checked`));
  assert.match(adminHtml, /name="salad_shells" value="Side Salad"(?! checked)/);

  let r = await post(f, { action: 'wrap-options', wrap_notes: 'Grilled or Crispy chicken on any wrap.\n\n  Any sandwich can be a wrap.  ' });
  assert.equal(r.headers.get('location'), '/admin/menu?options=wrap-options#wrap-options');
  r = await post(f, { action: 'salad-options', salad_dressings: 'RANCH\nfrench\nRanch\nlow cal ranch', salad_greens: 'iceberg\nromaine', salad_shells: ['Chef Salad', 'Side Salad'] });
  assert.equal(r.headers.get('location'), '/admin/menu?options=salad-options#salad-options');
  r = await post(f, { action: 'substitute-sides', substitute_sides: 'French Fries or Tots\nMac ’n’ Cheese or Onion Rings' });
  assert.equal(r.headers.get('location'), '/admin/menu?options=substitute-sides-options#substitute-sides-options');
  assert.deepEqual(JSON.parse(setting(f, WRAP_OPTIONS_KEY)), { notes: ['Grilled or Crispy chicken on any wrap.', 'Any sandwich can be a wrap.'] });
  assert.deepEqual(JSON.parse(setting(f, SALAD_OPTIONS_KEY)), { dressings: ['Ranch', 'French', 'Low Cal Ranch'], greens: ['Iceberg', 'Romaine'], shells: ['Chef Salad', 'Side Salad'] },
    'choice names take the house capitalization and duplicates are dropped');
  assert.deepEqual(JSON.parse(setting(f, SUBSTITUTE_SIDES_KEY)), { sides: ['French Fries or Tots', 'Mac ’n’ Cheese or Onion Rings'], lateNight: false }, 'lines are kept as typed');
  for (let n = 0; n < 2; n++) {
    const html = await render(f);
    assert.deepEqual(listed(panel(section(html, 'daily', 'Wraps'), 'wrap-options')[0]), ['Grilled or Crispy chicken on any wrap.', 'Any sandwich can be a wrap.']);
    const salads = section(html, 'daily', 'Salads');
    assert.deepEqual(listed(panel(salads, 'salad-options')[0]), ['Ranch', 'French', 'Low Cal Ranch']);
    assert.match(salads, /Choice of Iceberg or Romaine\./);
    assert.deepEqual(itemNames(salads).filter(n => n.startsWith('†')).sort(), ['†Chef Salad', '†Side Salad']);
    assert.deepEqual(listed(panel(section(html, 'daily', 'Substitute Sides'), 'substitute-sides-options')[0]), ['French Fries or Tots', 'Mac ’n’ Cheese or Onion Rings']);
  }
  const reloaded = await render(f, admin, '/admin/menu?options=salad-options');
  assert.match(reloaded, /Salad options saved\./);
  assert.match(reloaded, /<textarea id="salad-dressings"[^>]*>Ranch\nFrench\nLow Cal Ranch<\/textarea>/);
  assert.match(reloaded, /name="salad_shells" value="Side Salad" checked/);
  const sections = await json(f);
  assert.deepEqual(sections.find(s => s.sauces === undefined && s.substituteSides)?.substituteSides, ['French Fries or Tots', 'Mac ’n’ Cheese or Onion Rings']);
  assert.deepEqual(sections.find(s => s.name === 'Wraps').wrapOptions.notes, ['Grilled or Crispy chicken on any wrap.', 'Any sandwich can be a wrap.']);
  // Menu items, categories and their order are untouched by any of these saves.
  assert.deepEqual(f.sql('SELECT id,name,description,sort,active,category_id FROM items ORDER BY id'),
    baseline.items.map(({ id, name, description, sort, active, category_id }) => ({ id, name, description, sort, active, category_id })).sort((a, b) => a.id - b.id));
  assert.deepEqual(f.sql('SELECT id,name,sort FROM categories ORDER BY id'), baseline.categories.map(({ id, name, sort }) => ({ id, name, sort })).sort((a, b) => a.id - b.id));
});

test('invalid input is refused with the draft kept; cross-origin and signed-out saves change nothing', async t => {
  const f = menuFixture(t);
  for (const [fields, key] of [
    [{ action: 'wrap-options', wrap_notes: Array.from({ length: 7 }, (_, i) => `Note ${i}`).join('\n') }, WRAP_OPTIONS_KEY],
    [{ action: 'wrap-options', wrap_notes: 'x'.repeat(161) }, WRAP_OPTIONS_KEY],
    [{ action: 'salad-options', salad_dressings: 'y'.repeat(81), salad_greens: 'Iceberg' }, SALAD_OPTIONS_KEY],
    [{ action: 'salad-options', salad_dressings: 'Ranch', salad_greens: Array.from({ length: 7 }, (_, i) => `Green ${i}`).join('\n') }, SALAD_OPTIONS_KEY],
    [{ action: 'substitute-sides', substitute_sides: Array.from({ length: 9 }, (_, i) => `Side ${i}`).join('\n') }, SUBSTITUTE_SIDES_KEY],
  ]) {
    const html = await (await post(f, fields)).text();
    assert.match(html, /characters or fewer each/, JSON.stringify(fields).slice(0, 60));
    assert.equal(setting(f, key), null, 'nothing saved');
    const typed = Object.entries(fields).find(([k]) => k !== 'action' && String(fields[k]).length > 20)[1];
    assert.ok(decode(html).includes(typed.split('\n')[0]), 'the draft is shown for correction');
  }
  for (const action of ['wrap-options', 'salad-options', 'substitute-sides']) {
    assert.equal((await post(f, { action, wrap_notes: '', salad_dressings: '', salad_greens: '', substitute_sides: '' }, { origin: 'https://evil.example' })).status, 403);
  }
  const signedOut = { ...f, env: { ...f.env, SESSIONS: { get: async () => null } } };
  const body = new FormData();
 body.set('action', 'substitute-sides'); body.set('substitute_sides', '');
  const r = await container.renderToResponse(admin, { request: new Request('http://localhost/admin/menu', { method: 'POST', headers: { origin: 'http://localhost' }, body }), locals: { runtime: { env: signedOut.env } } });
  assert.equal(r.status, 302);
  for (const key of [WRAP_OPTIONS_KEY, SALAD_OPTIONS_KEY, SUBSTITUTE_SIDES_KEY]) assert.equal(setting(f, key), null);
});

test('empty lists hide only what they hold; unreadable settings fall back to the printed defaults', async t => {
  const f = menuFixture(t);
  await post(f, { action: 'wrap-options', wrap_notes: '' });
  await post(f, { action: 'substitute-sides', substitute_sides: '   \n ' });
  await post(f, { action: 'salad-options', salad_dressings: '', salad_greens: '', salad_shells: ['Taco Salad'] });
  let html = await render(f);
  assert.equal(panel(section(html, 'daily', 'Wraps'), 'wrap-options').length, 0);
  assert.equal(section(html, 'daily', 'Substitute Sides'), null);
  assert.ok(!chips(html).includes('Substitute Sides'));
  const salad = panel(section(html, 'daily', 'Salads'), 'salad-options')[0];
  assert.deepEqual([...salad.matchAll(/<dt[^>]*>(.*?)<\/dt>/g)].map(m => m[1]), ['Shells'], 'only the shell explanation remains');
  assert.match(await render(f, admin, '/admin/menu'), /Hidden on the Menu: the substitute sides list is empty/);
  let sections = await json(f);
  assert.ok(!sections.some(s => s.substituteSides) && !('wrapOptions' in sections.find(s => s.name === 'Wraps')));
  await post(f, { action: 'salad-options', salad_dressings: '', salad_greens: '' });
  html = await render(f);
  assert.equal(panel(section(html, 'daily', 'Salads'), 'salad-options').length, 0, 'nothing left to show: no empty panel');
  assert.ok(itemNames(section(html, 'daily', 'Salads')).every(n => !n.startsWith('†')), 'no unexplained daggers');
  for (const key of [WRAP_OPTIONS_KEY, SALAD_OPTIONS_KEY, SUBSTITUTE_SIDES_KEY]) f.sql('UPDATE settings SET value=? WHERE key=?', '{not json', key);
  html = await render(f);
  assert.deepEqual(listed(panel(section(html, 'daily', 'Substitute Sides'), 'substitute-sides-options')[0]), SIDES);
  assert.equal(listed(panel(section(html, 'daily', 'Wraps'), 'wrap-options')[0]).length, 3);
  sections = await json(f);
  assert.deepEqual(sections.find(s => s.name === 'Salads').saladOptions.dressings, DRESSINGS);
});

test('Substitute Sides Late Night checkbox: off by default, persists, shows the section once per tab in order, and turns off cleanly', async t => {
  const f = menuFixture(t);
  let adminHtml = await render(f, admin, '/admin/menu');
  assert.match(adminHtml, /<input type="checkbox" name="substitute_sides_late_night"(?! checked)[^>]*> Also show Substitute Sides on the Late Night Menu/);
  assert.equal((await post(f, { action: 'substitute-sides', substitute_sides: SIDES.join('\n'), substitute_sides_late_night: 'on' })).headers.get('location'),
    '/admin/menu?options=substitute-sides-options#substitute-sides-options');
  assert.deepEqual(JSON.parse(setting(f, SUBSTITUTE_SIDES_KEY)), { sides: SIDES, lateNight: true });
  for (let n = 0; n < 2; n++) {
    const html = await render(f);
    const late = section(html, 'late-night', 'Substitute Sides'), daily = section(html, 'daily', 'Substitute Sides');
    assert.ok(late && daily, 'both tabs');
    assert.deepEqual(listed(panel(late, 'substitute-sides-options')[0]), SIDES);
    assert.doesNotMatch(panel(late, 'substitute-sides-options')[0], PRICE);
    assert.equal((html.match(/class="cat-section substitute-sides-section"/g) ?? []).length, 2, 'exactly one per tab');
    assert.equal((html.match(/id="menu-substitute-sides"/g) ?? []).length, 1, 'one anchor (Daily)');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(ids.filter((v, i) => ids.indexOf(v) !== i), []);
    assert.equal(chips(html).filter(c => c === 'Substitute Sides').length, 1, 'one navigation link');
    const lateCols = layout(html, 'late-night');
    assert.equal(lateCols.flat().at(-1), 'Substitute Sides', 'last on Late Night by default');
  }
  adminHtml = await render(f, admin, '/admin/menu');
  assert.match(adminHtml, /name="substitute_sides_late_night" checked/);
  assert.match(adminHtml, /4 choices · Daily and Late Night/);
  assert.equal((await json(f)).find(s => s.substituteSides).lateNight, true);
  // The saved order applies to Late Night too.
  const body = { action: 'reorder-sections' };
  for (const c of f.sql('SELECT id,sort FROM categories')) body[`sort_${c.id}`] = c.sort;
  const burgers = baseline.categories.find(c => c.name === 'Burgers');
  assert.equal((await post(f, { ...body, sort_sides: burgers.sort, sort_sides_was: 9 })).headers.get('location'), '/admin/menu?sm=s3');
  let html = await render(f);
  for (const tab of ['daily', 'late-night']) {
    const column = layout(html, tab).find(c => c.includes('Burgers'));
    assert.equal(column[column.indexOf('Burgers') + 1], 'Substitute Sides', tab);
  }
  // A failed save keeps the ticked box in the draft and changes nothing.
  const failed = await (await post(f, { action: 'substitute-sides', substitute_sides: 'z'.repeat(121), substitute_sides_late_night: 'on' })).text();
  assert.match(failed, /characters or fewer each/);
  assert.match(failed, /name="substitute_sides_late_night" checked/);
  assert.deepEqual(JSON.parse(setting(f, SUBSTITUTE_SIDES_KEY)), { sides: SIDES, lateNight: true });
  // Turning it off removes it from Late Night only.
  await post(f, { action: 'substitute-sides', substitute_sides: SIDES.join('\n') });
  html = await render(f);
  assert.equal(section(html, 'late-night', 'Substitute Sides'), null);
  assert.ok(section(html, 'daily', 'Substitute Sides'));
  assert.deepEqual(JSON.parse(setting(f, SUBSTITUTE_SIDES_KEY)), { sides: SIDES, lateNight: false });
});

test('Substitute Sides is reorderable in Manage Sections and persists, validates and resists name collisions like Sauces', async t => {
  const f = menuFixture(t);
  const adminHtml = await render(f, admin, '/admin/menu');
  const rows = [...adminHtml.matchAll(/class="sm-sort-input"[^>]*name="(sort_[a-z0-9]+)"[^>]*value="(\d+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(rows.at(-1), ['sort_sides', String(Math.max(...baseline.categories.map(c => c.sort)))], 'listed last, at the last section’s number');
  assert.match(adminHtml, /aria-label="Sort order for Substitute Sides"/);
  const reorder = async fields => {
    const body = { action: 'reorder-sections' };
    for (const c of f.sql('SELECT id,sort FROM categories')) body[`sort_${c.id}`] = c.sort;
    return (await post(f, { ...body, ...fields })).headers.get('location');
  };
  const burgers = baseline.categories.find(c => c.name === 'Burgers');
  assert.equal(await reorder({ sort_sides: burgers.sort, sort_sides_was: 9 }), '/admin/menu?sm=s3');
  assert.equal(setting(f, 'menu_substitute_sides_sort'), String(burgers.sort));
  for (let n = 0; n < 2; n++) {
    const html = await render(f);
    const column = layout(html, 'daily').find(c => c.includes('Burgers'));
    assert.equal(column[column.indexOf('Burgers') + 1], 'Substitute Sides');
    const names = (await json(f)).map(s => s.name);
    assert.equal(names[names.indexOf('Burgers') + 1], 'Substitute Sides');
    assert.equal(section(html, 'late-night', 'Substitute Sides'), null, 'still Daily only');
  }
  // Both virtual sections at once keep their own positions.
  assert.equal(await reorder({ sort_sauces: burgers.sort, sort_sauces_was: 0, sort_sides: burgers.sort, sort_sides_was: burgers.sort }), '/admin/menu?sm=s3');
  const column = layout(await render(f), 'daily').find(c => c.includes('Burgers'));
  assert.deepEqual(column.slice(column.indexOf('Burgers'), column.indexOf('Burgers') + 3), ['Burgers', 'Sauces', 'Substitute Sides']);
  // Invalid numbers are refused, the whole save included.
  const before = f.sql('SELECT id,sort FROM categories ORDER BY id');
  assert.equal(await reorder({ sort_sides: '1000', sort_sides_was: burgers.sort, [`sort_${burgers.id}`]: 50 }), '/admin/menu?sm=e7');
  assert.deepEqual(f.sql('SELECT id,sort FROM categories ORDER BY id'), before);
  assert.match(await render(f, admin, '/admin/menu?sm=e7'), /Substitute Sides order must be a whole number from 0 to 999\./);
  // A staff section named "SUBSTITUTE sides" keeps its name and items; this one is renamed on screen only.
  f.sql("INSERT INTO categories (name,sort) VALUES ('SUBSTITUTE sides', 20)");
  f.sql("INSERT INTO items (category_id,name,description,sort,active,late_night) VALUES ((SELECT id FROM categories WHERE name='SUBSTITUTE sides'),'Staff Side','',0,1,0)");
  const html = await render(f);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids.filter((v, i) => ids.indexOf(v) !== i), []);
  assert.ok(section(html, 'daily', 'SUBSTITUTE sides').includes('Staff Side'));
  assert.ok(section(html, 'daily', 'Substitute Side Choices').includes('substitute-sides-options'));
  const names = (await json(f)).map(s => s.name.toLowerCase());
  assert.deepEqual(names.filter((v, i) => names.indexOf(v) !== i), []);
});
