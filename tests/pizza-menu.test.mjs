// Build first. All writes use an isolated local SQLite fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { PIZZA_OPTIONS_KEY, getPizzaOptions, pizzaOptionsFromForm } from '../src/lib/pizza-options.js';

const baseline = JSON.parse(readFileSync('src/data/menu-baseline.json', 'utf8'));
const schema = readFileSync('schema.sql', 'utf8');
const page = async name => (await import(`../dist/_worker.js/pages/${name}.astro.mjs`)).page();
const admin = (await page('admin/menu')).default;
const menu = (await page('menu')).default;
const menuJson = (await import('../dist/_worker.js/pages/menu.json.astro.mjs')).page();
const container = await AstroContainer.create();
const cookie = 'gb_session=' + 'a'.repeat(32);
// JJ's transcription of the original printed menu, independent of app defaults.
const printedToppings = ['Sausage', 'Pepperoni', 'Canadian Bacon', 'Beef', 'Bacon',
  'Diced Chicken', 'Onions', 'Green Peppers', 'Tomatoes', 'Sauerkraut', 'Jalapenos',
  'Green Olives', 'Black Olives', 'Mushrooms', 'Pineapple', 'Banana Peppers',
  'Pickles', 'Spinach', 'Feta Cheese', 'Bleu Cheese Crumbles'];

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const table of ['categories', 'items', 'settings']) {
    db.exec(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0]);
  }
  for (const table of ['categories', 'items']) for (const row of baseline[table]) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  }
  const rows = table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => ({ ...row }));
  const env = { SESSIONS: { get: async () => '1' }, DB: { prepare(sql) {
    const statement = db.prepare(sql);
    const query = args => ({
      bind: (...args) => query(args),
      first: async () => statement.get(...args) ?? null,
      all: async () => ({ results: statement.all(...args) }),
      run: async () => ({ meta: { last_row_id: Number(statement.run(...args).lastInsertRowid) } }),
    });
    return query([]);
  } } };
  return { db, env, rows };
}
const form = (sizes = ['Personal', '12 Inch', '16 Inch'], crusts = ['Thin', 'Regular', 'Deep Dish'], toppings = '') => {
  const f = new FormData();
  f.set('action', 'pizza-options');
  for (const size of sizes) f.append('pizza_sizes', size);
  for (const crust of crusts) f.append('pizza_crusts', crust);
  f.set('pizza_toppings', toppings);
  return f;
};
const render = (component, f, path = '/menu') => container.renderToString(component, {
  request: new Request('http://localhost' + path, { headers: { cookie } }), locals: { runtime: { env: f.env } },
});
const post = (f, body, headers = { cookie, origin: 'http://localhost' }) => container.renderToResponse(admin, {
  request: new Request('http://localhost/admin/menu', { method: 'POST', headers, body }), locals: { runtime: { env: f.env } },
});

test('printed-menu defaults show only confirmed options, exclude Pizza Fries, and preserve every item', async t => {
  const f = fixture(t);
  const settingsRow = () => f.db.prepare('SELECT value FROM settings WHERE key=?').get(PIZZA_OPTIONS_KEY);
  assert.equal(settingsRow(), undefined, 'the production settings key need not exist');
  const html = await render(menu, f);
  assert.equal((html.match(/aria-label="Pizza choices"/g) ?? []).length, 2);
  assert.match(html, /Personal · 12 Inch · 16 Inch/);
  assert.match(html, /Thin · Regular · Deep Dish/);
  const sections = [...html.matchAll(/<aside class="pizza-options"[\s\S]*?<\/aside>/g)].map(match => match[0]);
  assert.equal(sections.length, 2);
  for (const section of sections) {
    assert.deepEqual([...section.matchAll(/<dt[^>]*>(.*?)<\/dt>/g)].map(match => match[1]), ['Sizes', 'Crusts', 'Additional toppings']);
    assert.deepEqual([...section.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(match => match[1]), printedToppings);
    assert.match(section, /For all pizzas\. Excludes Pizza Fries, which has its own sizes\./);
    assert.doesNotMatch(section, /\$|€|£|price|charg|surcharge|ask at the bar|\b6(?:&quot;|&#34;| Inch)/i);
  }
  assert.deepEqual(await getPizzaOptions(f.env), {
    sizes: ['Personal', '12 Inch', '16 Inch'], crusts: ['Thin', 'Regular', 'Deep Dish'], toppings: printedToppings,
  });
  const adminHtml = await render(admin, f, '/admin/menu');
  assert.ok(adminHtml.includes(printedToppings.join('\n')));
  const adminPanel = adminHtml.match(/<details class="pizza-manager"[\s\S]*?<\/details>/)?.[0];
  assert.ok(adminPanel);
  assert.doesNotMatch(adminPanel, /\$|€|£|price|charg|surcharge|ask at the bar/i);
  const json = await (await menuJson.GET({ locals: { runtime: { env: f.env } } })).json();
  assert.deepEqual(json.sections.find(section => section.name === 'Pizzas').pizzaOptions.toppings, printedToppings);
  assert.match(json.sections.find(section => section.name === 'Pizzas').pizzaOptions.scope, /Excludes Pizza Fries/);
  for (const item of baseline.items.filter(item => item.active)) {
    assert.ok(html.includes(`id="menu-item-${item.id}"`), item.name);
  }
  assert.ok(html.includes('Pizza Fries'));
  assert.equal(settingsRow(), undefined, 'displaying defaults never writes settings');
});

test('authenticated save persists across requests, normalizes extras, updates public menus and JSON, leaves all menu data untouched', async t => {
  const f = fixture(t);
  const before = { items: f.rows('items'), categories: f.rows('categories') };
  // Test input only: these are not seeded or approved additional toppings.
  const response = await post(f, form(['12 Inch'], ['Thin'], 'TEST TOPPING AND BBQ\ntest topping and bbq'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/admin/menu?pizza=saved#pizza-options');
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT value FROM settings WHERE key=?').get(PIZZA_OPTIONS_KEY).value),
    { sizes: ['12 Inch'], crusts: ['Thin'], toppings: ['Test Topping and BBQ'] });
  const adminHtml = await render(admin, f, '/admin/menu?pizza=saved');
  assert.match(adminHtml, /Pizza options saved/);
  assert.match(adminHtml, /Test Topping and BBQ/);
  assert.match(adminHtml, /value="12 Inch" checked/);
  assert.doesNotMatch(adminHtml, /value="Personal" checked/);
  const html = await render(menu, f);
  assert.equal((html.match(/Test Topping and BBQ/g) ?? []).length, 2);
  const json = await (await menuJson.GET({ locals: { runtime: { env: f.env } } })).json();
  assert.deepEqual(json.sections.find(section => section.name === 'Pizzas').pizzaOptions.toppings, ['Test Topping and BBQ']);
  assert.equal(json.sections.filter(section => section.pizzaOptions).length, 1);
  assert.deepEqual(f.rows('items'), before.items);
  assert.deepEqual(f.rows('categories'), before.categories);
  await post(f, form([], [], ''));
  assert.deepEqual(await getPizzaOptions(f.env), { sizes: [], crusts: [], toppings: [] });
  assert.doesNotMatch(await render(menu, f), /<dt[^>]*>(?:Sizes|Crusts|Additional toppings)/);
});

test('invalid input, missing sessions and cross-origin saves cannot alter saved choices', async t => {
  const f = fixture(t);
  await post(f, form());
  const before = await getPizzaOptions(f.env);
  for (const body of [form(['6"']), form(['12"']), form(['16"']), form(['18"']), form([], ['Stuffed']), form([], [], 'x'.repeat(81)), form([], [], Array(41).fill('Test').join('\n'))]) {
    const response = await post(f, body, { cookie, origin: 'http://localhost', accept: 'application/json' });
    assert.equal((await response.json()).ok, false);
  }
  assert.equal((await post(f, form([], [], 'Test'), { cookie, origin: 'https://other.example' })).status, 403);
  assert.equal((await post(f, form([], [], 'Test'), { origin: 'http://localhost' })).status, 302);
  assert.deepEqual(await getPizzaOptions(f.env), before);
  assert.throws(() => pizzaOptionsFromForm(form([], [], 'x'.repeat(3241))));
});

test('topping markup is escaped in Menu and admin, and database errors never report a successful save', async t => {
  const f = fixture(t);
  await post(f, form([], [], '<script>alert(1)</script>'));
  for (const [component, path] of [[menu, '/menu'], [admin, '/admin/menu']]) {
    const html = await render(component, f, path);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
  }
  const broken = { env: { SESSIONS: f.env.SESSIONS, DB: { prepare() { throw new Error('Local database unavailable.'); } } } };
  const response = await post(broken, form(), { cookie, origin: 'http://localhost', accept: 'application/json' });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).ok, false);
});

test('failed HTML saves keep the topping draft available for correction', async t => {
  const f = fixture(t);
  const draft = 'x'.repeat(81);
  const html = await (await post(f, form(['Personal'], ['Regular'], draft))).text();
  assert.ok(html.includes(draft));
  assert.match(html, /80 characters or fewer/);
  assert.match(html, /value="Regular" checked/);
});

// Optional fixture export includes the build's actual styles and scripts.
// PIZZA_REVIEW=1 node --test tests/pizza-menu.test.mjs
if (process.env.PIZZA_REVIEW) test('export styled local fixture pages for browser review', async t => {
  const f = fixture(t);
  const manifestFile = readdirSync('dist/_worker.js').find(name => /^manifest_.*\.mjs$/.test(name));
  const { manifest } = await import(`../dist/_worker.js/${manifestFile}`);
  mkdirSync('dist/local-review', { recursive: true });
  for (const [component, path, file] of [[menu, '/menu', 'menu.html'], [admin, '/admin/menu', 'admin.html']]) {
    let html = await render(component, f, path);
    const route = manifest.routes.find(route => route.routeData.pathname === path);
    const styles = route.styles.map(style => `<link rel="stylesheet" href="${style.src}">`).join('');
    html = html.replace('</head>', styles + '</head>').replace(/src="([^"]+\?astro&type=script[^\"]*)"/g, (match, source) => {
      const built = manifest.entryModules[source];
      assert.ok(built, source);
      return `src="/${built}"`;
    });
    assert.ok(styles.includes('.css'));
    writeFileSync(`dist/local-review/${file}`, html);
  }
});
