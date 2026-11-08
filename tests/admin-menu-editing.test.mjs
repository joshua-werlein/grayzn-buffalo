import {builtRoute} from './built-output.mjs';
// Admin Menu editing: the item editor and section filter, saving and refreshing, and staff
// working from more than one tab. Build first. Local SQLite fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { fixture } from './specials-fixture.mjs';

const admin = (await builtRoute('admin/menu')).default;
const login = (await builtRoute('admin')).default;
const container = await AstroContainer.create();
const baseline = JSON.parse(readFileSync('src/data/menu-baseline.json', 'utf8'));
const schema = readFileSync('schema.sql', 'utf8');
const tableSql = table => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0];
const cookie = 'gb_session=' + 'a'.repeat(32);
const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ── Server: compiled page against a real SQLite copy of the baseline menu ────

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
const request = (f, path, init = {}) => ({ request: new Request('http://localhost' + path, { ...init, headers: { cookie, origin: 'http://localhost', ...(init.headers ?? {}) } }), locals: { runtime: { env: f.env } } });
/** One staff tab: the Admin Menu page as a fresh load renders it. */
const load = (f, path = '/admin/menu') => container.renderToString(admin, request(f, path));
async function post(f, fields, { json = false } = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
  return container.renderToResponse(admin, request(f, '/admin/menu', { method: 'POST', body, headers: json ? { accept: 'application/json' } : {} }));
}
const itemHtml = (html, id) => { const start = html.indexOf(`id="item-${id}"`); return html.slice(start, html.indexOf('</li>', start)); };
/** What an item editor in this tab would submit, as the browser parses the page. */
function editor(html, id) {
  const block = itemHtml(html, id);
  const fields = Object.fromEntries([...block.matchAll(/name="(was_[a-z_]+)"(?: value="([^"]*)")?/g)].map(m => [m[1], decode(m[2] ?? '').replace(/\r\n?/g, '\n')]));
  const name = decode(block.match(/name="name" value="([^"]*)"/)[1]);
  const description = decode(block.match(/<textarea[^>]*name="description"[^>]*>([\s\S]*?)<\/textarea>/)[1]);
  const category = block.match(/<option value="(\d+)" selected/)[1];
  return { action: 'edit', id, name, description, category_id: category, ...fields };
}
/** What this tab's Save order button would submit. */
function orderForm(html) {
  const fields = { action: 'reorder-sections' };
  for (const m of html.matchAll(/name="(sort_\d+|was_\d+|sort_sauces|sort_sauces_was|sort_sides|sort_sides_was)" value="(\d+)"/g)) fields[m[1]] = m[2];
  for (const m of html.matchAll(/name="(sort_(?:sauces|sides)_snapshot)"(?: value="([^"]*)")?/g)) fields[m[1]] = decode(m[2] ?? '');
  return fields;
}
/** What the Edit section panel submits after its Edit button copies the row's values. */
function sectionForm(html, id) {
  // Astro writes an empty attribute without a value; the browser reads it as ''.
  const m = html.match(new RegExp(`data-id="${id}" data-name="([^"]*)" data-subtitle(?:="([^"]*)")? data-note(?:="([^"]*)")?`));
  const [name, subtitle, note] = m.slice(1).map(v => decode(v ?? ''));
  return { action: 'edit-section', category_id: id, name, subtitle, note, was_name: name, was_subtitle: subtitle, was_note: note };
}
const sectionOf = (html, id) => {
  const at = html.indexOf(`id="item-${id}"`);
  const heads = [...html.slice(0, at).matchAll(/<div class="cat" id="[^"]*" data-category-id="(\d+)"/g)];
  return Number(heads.at(-1)[1]);
};
const itemsIn = (html, categoryId) => {
  const start = html.indexOf(`data-category-id="${categoryId}"`);
  const next = html.indexOf('<div class="cat"', start + 1);
  return [...html.slice(start, next === -1 ? undefined : next).matchAll(/<li id="item-(\d+)"/g)].map(m => Number(m[1]));
};
const row = (f, id) => f.sql('SELECT name, description, category_id, late_night, active, sort FROM items WHERE id = ?', id)[0];
const firstItem = f => f.sql('SELECT id, category_id FROM items ORDER BY id LIMIT 1')[0];
const sectionId = (f, name) => f.sql('SELECT id FROM categories WHERE name = ?', name)[0].id;

test('saving an item, then refreshing, shows the saved text in its new section at the end, editor closed', async t => {
  const f = menuFixture(t);
  const { id } = firstItem(f);
  const salads = sectionId(f, 'Salads');
  const saladsBefore = f.sql('SELECT id FROM items WHERE category_id = ? ORDER BY sort, id', salads).map(r => r.id);
  const draft = { ...editor(await load(f), id), name: 'house burger', description: 'with fries', category_id: salads };
  const response = await post(f, draft, { json: true });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual([data.ok, data.message, data.name, data.description, data.category_id], [true, 'Saved.', 'House Burger', 'With Fries', salads]);
  assert.deepEqual(row(f, id).category_id, salads);

  for (let refresh = 0; refresh < 2; refresh++) {
    const html = await load(f);
    assert.equal(sectionOf(html, id), salads, 'the item is listed only under its new section');
    assert.deepEqual(itemsIn(html, salads), [...saladsBefore, id], 'moved items go to the end, where the page put it before refreshing');
    const block = itemHtml(html, id);
    assert.doesNotMatch(block, /<details class="editor"[^>]*\sopen/, 'the editor starts closed');
    assert.deepEqual(editor(html, id), { action: 'edit', id, name: 'House Burger', description: 'With Fries', category_id: String(salads),
      was_name: 'House Burger', was_description: 'With Fries', was_category_id: String(salads), was_late_night: '0' });
  }
});

test('repeated saves from one tab succeed, including multi-line descriptions', async t => {
  const f = menuFixture(t);
  const { id } = firstItem(f);
  let form = editor(await load(f), id);
  for (const description of ['one', 'line one\nline two', 'line one\nline two\nline three']) {
    // The browser submits CRLF; the page then keeps the saved text as the editor's loaded values.
    const data = await (await post(f, { ...form, description: description.replace(/\n/g, '\r\n') }, { json: true })).json();
    assert.equal(data.ok, true, description);
    form = { ...form, was_name: data.name, was_description: data.description.replace(/\r\n/g, '\n'), was_category_id: String(data.category_id), was_late_night: String(data.late_night) };
  }
  assert.equal(row(f, id).description, 'Line One\r\nLine Two\r\nLine Three');
  // A tab loaded after those saves can save again.
  assert.equal((await (await post(f, { ...editor(await load(f), id), name: 'again' }, { json: true })).json()).ok, true);
});

test('two staff sessions: an older tab cannot overwrite a newer item save, and is told why', async t => {
  const f = menuFixture(t);
  const { id } = firstItem(f);
  const original = row(f, id);
  const [tabA, tabB] = [editor(await load(f), id), editor(await load(f), id)];
  assert.equal((await (await post(f, { ...tabB, description: 'b newer description' }, { json: true })).json()).ok, true);

  const response = await post(f, { ...tabA, name: 'a stale name' }, { json: true });
  const data = await response.json();
  assert.equal(response.status, 409);
  assert.deepEqual([data.ok, data.code], [false, 'conflict']);
  assert.match(data.error, /Someone else changed this item.*not saved.*Refresh/);
  assert.deepEqual([row(f, id).name, row(f, id).description], [original.name, 'B Newer Description'], 'B\'s save is kept and A\'s is not applied');

  // After refreshing, A's change applies on top of B's.
  assert.equal((await (await post(f, { ...editor(await load(f), id), name: 'a stale name' }, { json: true })).json()).ok, true);
  assert.deepEqual([row(f, id).name, row(f, id).description], ['A Stale Name', 'B Newer Description']);

  // A form without loaded values (a tab opened before this check) is refused, never applied.
  const legacy = await post(f, { action: 'edit', id, name: 'legacy', description: '', category_id: original.category_id }, { json: true });
  assert.equal(legacy.status, 409);
  assert.match((await legacy.json()).error, /out of date/);
  assert.equal(row(f, id).name, 'A Stale Name');
});

test('repeated Hide leaves an item hidden, from any number of tabs', async t => {
  const f = menuFixture(t);
  const { id } = firstItem(f);
  const hide = { action: 'toggle', id, active: 0 };
  assert.match(itemHtml(await load(f), id), /name="active" value="0"/, 'a visible item\'s button asks to hide it');
  for (const tab of ['A', 'B', 'A again']) {
    const data = await (await post(f, hide, { json: true })).json();
    assert.deepEqual([data.ok, data.active, data.message], [true, 0, 'Item hidden.'], tab);
    assert.equal(row(f, id).active, 0, tab);
  }
  assert.match(itemHtml(await load(f), id), /name="active" value="1"[\s\S]*>Show</, 'after refreshing, the button offers Show');
  assert.equal((await (await post(f, { action: 'toggle', id, active: 1 }, { json: true })).json()).active, 1);
  assert.equal(row(f, id).active, 1);
  // An old blind toggle (no requested state) changes nothing.
  const blind = await post(f, { action: 'toggle', id }, { json: true });
  assert.equal((await blind.json()).ok, false);
  assert.equal(row(f, id).active, 1);
});

test('editing, hiding or moving into records deleted by someone else reports failure, not success', async t => {
  const f = menuFixture(t);
  const { id } = firstItem(f);
  const tab = await load(f);
  const form = editor(tab, id);
  f.sql('DELETE FROM items WHERE id = ?', id);
  let response = await post(f, { ...form, name: 'ghost' }, { json: true });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /deleted by someone else.*not saved/);
  response = await post(f, { action: 'toggle', id, active: 0 }, { json: true });
  assert.equal(response.status, 404);
  assert.equal(f.sql('SELECT COUNT(*) AS n FROM items WHERE id = ?', id)[0].n, 0);

  // Moving an item into a section that was deleted meanwhile.
  const other = f.sql('SELECT id, category_id FROM items ORDER BY id LIMIT 1')[0];
  f.sql("INSERT INTO categories (id, name, sort) VALUES (900, 'Temporary', 90)");
  const moving = { ...editor(await load(f), other.id), category_id: 900 };
  f.sql('DELETE FROM categories WHERE id = 900');
  response = await post(f, moving, { json: true });
  assert.equal(response.ok, false);
  assert.match((await response.json()).error, /section was deleted by someone else.*not saved/);
  assert.equal(row(f, other.id).category_id, other.category_id);

  // Sections: edit and delete of a section removed elsewhere.
  f.sql("INSERT INTO categories (id, name, sort) VALUES (901, 'Dips', 91)");
  const sectionTab = sectionForm(await load(f), 901);
  f.sql('DELETE FROM categories WHERE id = 901');
  response = await post(f, { ...sectionTab, subtitle: 'changed' });
  assert.equal(response.headers.get('location'), '/admin/menu?sm=e8');
  assert.match(await load(f, '/admin/menu?sm=e8'), /That section was deleted by someone else\. Nothing was saved\./);
  assert.equal((await post(f, { action: 'delete-section', category_id: 901 })).headers.get('location'), '/admin/menu?sm=e8');
});

test('two staff sessions: an older tab cannot undo another staff member\'s section changes', async t => {
  const f = menuFixture(t);
  const sorts = () => Object.fromEntries(f.sql('SELECT id, sort FROM categories').map(c => [c.id, c.sort]));
  const [first, second] = f.sql('SELECT id, sort FROM categories ORDER BY sort, id LIMIT 2');
  const last = f.sql('SELECT id, sort FROM categories ORDER BY sort DESC, id DESC LIMIT 1')[0];
  const [tabA, tabB] = [orderForm(await load(f)), orderForm(await load(f))];

  // B swaps the first two sections.
  assert.equal((await post(f, { ...tabB, [`sort_${first.id}`]: second.sort, [`sort_${second.id}`]: first.sort })).headers.get('location'), '/admin/menu?sm=s3');
  // A, still on the old page, renumbers a different section: applied, and B's swap survives.
  assert.equal((await post(f, { ...tabA, [`sort_${last.id}`]: last.sort + 5 })).headers.get('location'), '/admin/menu?sm=s3');
  assert.deepEqual([sorts()[first.id], sorts()[second.id], sorts()[last.id]], [second.sort, first.sort, last.sort + 5]);

  // A then changes a section B already moved, together with Sauces: refused as a whole.
  const before = sorts();
  const settings = () => f.sql('SELECT key, value FROM settings ORDER BY key');
  const settingsBefore = settings();
  const stale = await post(f, { ...tabA, [`sort_${first.id}`]: 40, sort_sauces: 77 });
  assert.equal(stale.headers.get('location'), '/admin/menu?sm=e10');
  assert.deepEqual(sorts(), before, 'no section number changed');
  assert.deepEqual(settings(), settingsBefore, 'the Sauces number in the same save was rolled back');
  assert.match(await load(f, '/admin/menu?sm=e10'), /Someone else changed the section order since you opened the page\. Nothing was saved\./);

  // A section deleted after the page loaded is also a conflict.
  f.sql("INSERT INTO categories (id, name, sort) VALUES (902, 'Specials Board', 95)");
  const tabC = orderForm(await load(f));
  f.sql('DELETE FROM categories WHERE id = 902');
  assert.equal((await post(f, { ...tabC, sort_902: 1 })).headers.get('location'), '/admin/menu?sm=e10');

  // A refreshed tab saves normally; a form without loaded numbers cannot change any.
  assert.equal((await post(f, { ...orderForm(await load(f)), [`sort_${first.id}`]: 40 })).headers.get('location'), '/admin/menu?sm=s3');
  assert.equal(sorts()[first.id], 40);
  assert.equal((await post(f, { action: 'reorder-sections', [`sort_${first.id}`]: 3 })).headers.get('location'), '/admin/menu?sm=e10');
  assert.equal(sorts()[first.id], 40);

  // Section details: an older Edit panel cannot overwrite a newer rename.
  const [panelA, panelB] = [sectionForm(await load(f), first.id), sectionForm(await load(f), first.id)];
  assert.equal((await post(f, { ...panelB, name: 'starters' })).headers.get('location'), '/admin/menu?sm=s2');
  assert.equal((await post(f, { ...panelA, subtitle: 'From 11 am' })).headers.get('location'), '/admin/menu?sm=e9');
  assert.deepEqual(f.sql('SELECT name, subtitle FROM categories WHERE id = ?', first.id)[0], { name: 'Starters', subtitle: '' });
  assert.equal((await post(f, { ...sectionForm(await load(f), first.id), subtitle: 'From 11 am' })).headers.get('location'), '/admin/menu?sm=s2');
  assert.deepEqual(f.sql('SELECT name, subtitle FROM categories WHERE id = ?', first.id)[0], { name: 'Starters', subtitle: 'From 11 am' });
});

test('expired sessions: in-page saves get a JSON 401, forms return to Admin Menu after sign-in, nothing saved', async t => {
  const f = menuFixture(t);
  const { id } = firstItem(f);
  const form = editor(await load(f), id);
  const before = row(f, id);
  f.env.SESSIONS = { get: async () => null };
  for (const fields of [{ ...form, name: 'lost' }, { action: 'toggle', id, active: 0 }, { action: 'add', category_id: before.category_id, name: 'lost' }]) {
    const response = await post(f, fields, { json: true });
    assert.equal(response.status, 401, fields.action);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const data = await response.json();
    assert.deepEqual([data.ok, data.code], [false, 'auth']);
    assert.match(data.error, /session expired.*not saved/);
  }
  assert.deepEqual(row(f, id), before);
  assert.equal(f.sql("SELECT COUNT(*) AS n FROM items WHERE name = 'Lost'")[0].n, 0);

  const section = await post(f, { action: 'edit-section', category_id: before.category_id, name: 'lost', subtitle: '', note: '' });
  assert.equal(section.headers.get('location'), '/admin?next=/admin/menu&expired=1');
  const visit = await container.renderToResponse(admin, request(f, '/admin/menu'));
  assert.equal(visit.headers.get('location'), '/admin?next=/admin/menu');

  // The sign-in page explains the lost change and returns to Admin Menu.
  const page = await container.renderToString(login, { request: new Request('http://localhost/admin?next=/admin/menu&expired=1'), locals: { runtime: { env: { SESSIONS: { get: async () => null } } } } });
  assert.match(page, /Your session expired, so your last change was not saved\./);
  assert.match(page, /name="next" value="\/admin\/menu"/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true }));
  const env = { ADMIN_PASSWORD: 'pw', TURNSTILE_SITEKEY: 'k', TURNSTILE_SECRET: 's', SESSIONS: { get: async () => null, put: async () => {} } };
  for (const [next, expected] of [['/admin/menu', '/admin/menu'], ['https://evil.example/admin/menu', '/admin/specials'], ['//evil.example', '/admin/specials'], ['/admin/menu?x=1', '/admin/specials']]) {
    const body = new FormData();
    for (const [key, value] of Object.entries({ action: 'login', password: 'pw', 'cf-turnstile-response': 't', next })) body.set(key, value);
    const response = await container.renderToResponse(login, { request: new Request('http://localhost/admin', { method: 'POST', body, headers: { origin: 'http://localhost' } }), locals: { runtime: { env } } });
    assert.equal(response.headers.get('location'), expected, next);
  }
});

// ── Client: the item editor, section filter and in-place saves ──────────────

function script() {
  const source = readFileSync('src/pages/admin/menu.astro', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
const slice = (from, to) => { const s = script(); const start = s.indexOf(from); assert.ok(start >= 0, from); return s.slice(start, s.indexOf(to, start)); };

class Node {
  constructor(props = {}) { Object.assign(this, { hidden: false, dataset: {}, value: '', textContent: '' }, props); this.handlers = new Map(); }
  addEventListener(type, fn) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); }
  async emit(type, event = {}) { for (const fn of this.handlers.get(type) ?? []) await fn(event); }
  focus() {}
}
class HTMLInputElement extends Node {}
class HTMLTextAreaElement extends Node {}
class HTMLSelectElement extends Node {
  get value() { return this.options.find(o => o.selected)?.value ?? ''; }
  set value(v) { this.options?.forEach(o => { o.selected = o.value === v; }); }
}
const SECTIONS = [['1', 'Burgers'], ['2', 'Salads']];
function itemDouble(id, section, name) {
  const input = new HTMLInputElement({ type: 'text', value: name, defaultValue: name });
  const description = new HTMLTextAreaElement({ value: '', defaultValue: '' });
  const select = new HTMLSelectElement({ options: SECTIONS.map(([value, textContent]) => ({ value, textContent, selected: value === section, defaultSelected: value === section })) });
  const hidden = new HTMLInputElement({ type: 'hidden', value: name });
  const form = new Node({ elements: [hidden, input, description, select] });
  form.reset = () => { input.value = input.defaultValue; description.value = description.defaultValue; select.options.forEach(o => { o.selected = o.defaultSelected; }); };
  const item = new Node({ dataset: { section, itemName: name, description: '', active: '1', late: '0' } });
  const editor = new Node({ open: false });
  editor.querySelector = s => (s === 'form.edit-form' ? form : null);
  editor.closest = () => item;
  item.querySelector = s => (s === '.editor' ? editor : null);
  return { item, editor, form, input, description, select };
}
function filterPage() {
  const burger = itemDouble('11', '1', 'Burger'), salad = itemDouble('21', '2', 'Salad');
  const items = [burger, salad];
  const cats = SECTIONS.map(([id]) => Object.assign(new Node({ dataset: { categoryId: id } }), { querySelectorAll: () => items.filter(i => i.item.dataset.section === id).map(i => i.item) }));
  const sectionFilter = new HTMLSelectElement({ options: [['', 'All'], ...SECTIONS].map(([value]) => ({ value, selected: value === '' })) });
  const controls = {
    'item-search': new Node({ value: '' }), 'filter-section': sectionFilter, 'filter-visibility': new Node({ value: 'all' }),
    'filter-late': new Node({ checked: false }), 'filter-count': new Node(), 'clear-filters': new Node(), 'menu-filters': new Node({ hidden: true }),
  };
  const prompts = [];
  let accept = true;
  const document = {
    getElementById: id => controls[id] ?? null,
    querySelector: s => controls[s.slice(1)] ?? null,
    querySelectorAll: s => s === '.menu-item' ? items.map(i => i.item) : s === '.cat' ? cats
      : s === '.menu-item .editor[open]' ? items.map(i => i.editor).filter(e => e.open) : [],
  };
  vm.runInNewContext(slice("const search = document.getElementById('item-search')", '// Section manager'), {
    document, createdItem: null, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement,
    confirm: message => { prompts.push(message); return accept; },
  });
  const choose = async value => { sectionFilter.value = value; await sectionFilter.emit('input'); };
  return { burger, salad, cats, sectionFilter, controls, prompts, choose, accept: v => { accept = v; } };
}

test('REPORTED: switching sections closes the open item editor and shows only that section', async () => {
  const page = filterPage();
  page.burger.editor.open = true;
  await page.choose('2');
  assert.equal(page.burger.editor.open, false, 'the Burgers item editor no longer stays at the top');
  assert.equal(page.burger.item.hidden, true);
  assert.equal(page.cats[0].hidden, true, 'the Burgers section is hidden');
  assert.deepEqual([page.salad.item.hidden, page.cats[1].hidden], [false, false]);
  assert.equal(page.prompts.length, 0, 'an editor without changes closes without asking');
  assert.match(page.controls['filter-count'].textContent, /^1 matching item\.$/);
  // Opening an editor in the new section, then switching back, clears it the same way.
  page.salad.editor.open = true;
  await page.choose('1');
  assert.deepEqual([page.salad.editor.open, page.salad.item.hidden, page.burger.item.hidden], [false, true, false]);
});

test('switching sections with an unsaved draft asks first; keeping it leaves the editor and section as they were', async () => {
  const page = filterPage();
  page.burger.editor.open = true;
  page.burger.input.value = 'Burger draft';
  page.accept(false);
  await page.choose('2');
  assert.match(page.prompts[0], /Discard your unsaved changes to Burger\?/);
  assert.equal(page.sectionFilter.value, '', 'the section choice is undone');
  assert.deepEqual([page.burger.editor.open, page.burger.input.value, page.burger.item.hidden], [true, 'Burger draft', false]);

  page.accept(true);
  await page.choose('2');
  assert.deepEqual([page.burger.editor.open, page.burger.input.value, page.burger.item.hidden], [false, 'Burger', true], 'the draft is discarded and the editor shows saved values');
  // Clear filters is a section change too.
  page.salad.editor.open = true;
  await page.controls['clear-filters'].emit('click');
  assert.deepEqual([page.salad.editor.open, page.sectionFilter.value, page.burger.item.hidden], [false, '', false]);
});

class FormDataDouble extends FormData {
  constructor(form) { super(); for (const [key, value] of form?.fields ?? []) this.set(key, value); }
}
function editPage(response) {
  const node = props => new Node(props);
  const fields = new Map([['action', 'edit'], ['id', '1'], ['name', 'house burger'], ['description', 'with fries'], ['category_id', '2'],
    ['was_name', 'Burger'], ['was_description', ''], ['was_category_id', '1'], ['was_late_night', '0']]);
  const inputs = { name: node({ value: 'house burger', defaultValue: 'Burger' }), description: node({ value: 'with fries', defaultValue: '' }) };
  const select = node({ value: '2', options: SECTIONS.map(([value, textContent]) => ({ value, textContent, selected: value === '2', defaultSelected: value === '1' })) });
  const was = Object.fromEntries(['was_name', 'was_description', 'was_category_id', 'was_late_night'].map(k => [k, node({ value: fields.get(k) })]));
  const submit = node({ disabled: false, textContent: 'Save changes' });
  const editor = node({ open: true });
  const form = node({ fields });
  form.closest = s => (s === 'details.editor' ? editor : null);
  form.querySelector = s => ({ 'input[name="action"]': { value: 'edit' }, 'input[name="id"]': { value: '1' }, 'button[type="submit"]': submit,
    'input[name="name"]': inputs.name, 'textarea[name="description"]': inputs.description, 'select[name="category_id"]': select,
    ...Object.fromEntries(Object.entries(was).map(([k, v]) => [`input[name="${k}"]`, v])) })[s] ?? null;
  const parts = { strong: node(), desc: node({ classList: { toggle() {} } }), label: node({ textContent: 'Burgers' }) };
  const item = node({ parentElement: 'burgers-list' });
  item.querySelector = s => ({ '.who strong': parts.strong, '.desc': parts.desc, '.item-section': parts.label })[s] ?? null;
  const moved = [];
  const destination = { append: el => { moved.push(el); el.parentElement = 'salads-list'; } };
  const toasts = [];
  const document = { querySelectorAll: () => [form], getElementById: () => item, querySelector: s => (s.includes('data-category-id="2"') ? destination : null), createElement: () => node() };
  vm.runInNewContext(slice('// Existing items update in place.', 'function paint('), {
    document, addForm: null, FormData: FormDataDouble, toast: (message, kind) => toasts.push([kind, message]), applyFilters() {},
    fetch: async () => response(), confirm: () => true, Response,
  });
  return { form, editor, inputs, select, was, submit, parts, moved, toasts, item, save: () => form.emit('submit', { preventDefault() {} }) };
}

test('a successful item save closes the editor, says Saved, and becomes the editor\'s new starting point', async () => {
  const page = editPage(() => Response.json({ ok: true, message: 'Saved.', name: 'House Burger', description: 'With Fries', category_id: 2, late_night: 0 }));
  await page.save();
  assert.deepEqual(page.toasts.at(-1), ['ok', 'Saved.']);
  assert.equal(page.editor.open, false);
  assert.deepEqual([page.inputs.name.value, page.inputs.name.defaultValue, page.inputs.description.defaultValue], ['House Burger', 'House Burger', 'With Fries']);
  assert.deepEqual(page.select.options.map(o => o.defaultSelected), [false, true]);
  assert.deepEqual(Object.values(page.was).map(i => i.value), ['House Burger', 'With Fries', '2', '0'], 'the next save compares with what is saved now');
  assert.deepEqual([page.parts.strong.textContent, page.parts.label.textContent, page.item.dataset.section], ['House Burger', 'Salads', '2']);
  assert.equal(page.moved.length, 1, 'the item moves to the end of its new section');
  assert.equal(page.submit.disabled, false);
});

for (const [label, response, message] of [
  ['someone else changed it', () => Response.json({ ok: false, code: 'conflict', error: 'Someone else changed this item since you opened it. Your changes were not saved.' }, { status: 409 }), /Someone else changed this item/],
  ['the session expired', () => Response.json({ ok: false, code: 'auth', error: 'Your session expired, so this change was not saved.' }, { status: 401 }), /session expired, so this change was not saved/],
  ['an HTML page came back', () => new Response('<!DOCTYPE html><p>Sign in</p>', { headers: { 'content-type': 'text/html' } }), /could not be confirmed as saved/],
  ['the server failed', () => Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 }), /Something went wrong/],
]) test(`a failed item save (${label}) keeps the editor open with the draft and shows an error, not Saved`, async () => {
  const page = editPage(response);
  await page.save();
  const [kind, text] = page.toasts.at(-1);
  assert.equal(kind, 'bad');
  assert.match(text, message);
  assert.doesNotMatch(text, /Saved/);
  assert.equal(page.editor.open, true);
  assert.deepEqual([page.inputs.name.value, page.inputs.description.value], ['house burger', 'with fries']);
  assert.deepEqual(Object.values(page.was).map(i => i.value), ['Burger', '', '1', '0'], 'loaded values are unchanged');
  assert.equal(page.parts.strong.textContent, '');
  assert.equal(page.moved.length, 0);
  assert.equal(page.submit.disabled, false);
});

test('Show/Hide shows the state the server saved and asks for the opposite next time', async () => {
  const fields = new Map([['action', 'toggle'], ['id', '1'], ['active', '0']]);
  const submit = new Node({ textContent: 'Hide' });
  const next = new Node({ value: '0' });
  const form = new Node({ fields });
  form.closest = () => null;
  form.querySelector = s => ({ 'input[name="action"]': { value: 'toggle' }, 'input[name="id"]': { value: '1' }, 'button[type="submit"]': submit, 'input[name="active"]': next })[s] ?? null;
  const badge = new Node({ hidden: true });
  const item = new Node({ classList: { toggle(name, on) { item.inactive = on; } } });
  item.querySelector = s => (s === '.hidden-badge' ? badge : null);
  let saved = 0;
  vm.runInNewContext(slice('// Existing items update in place.', 'function paint('), {
    document: { querySelectorAll: () => [form], getElementById: () => item }, addForm: null, FormData: FormDataDouble, toast() {}, applyFilters() {},
    fetch: async (_url, init) => Response.json({ ok: true, active: (saved = Number(init.body.get('active'))), message: 'x' }), confirm: () => true,
  });
  await form.emit('submit', { preventDefault() {} });
  assert.deepEqual([saved, submit.textContent, next.value, badge.hidden, item.dataset.active], [0, 'Show', '1', false, '0']);
  fields.set('active', next.value);
  await form.emit('submit', { preventDefault() {} });
  assert.deepEqual([saved, submit.textContent, next.value, badge.hidden, item.dataset.active], [1, 'Hide', '0', true, '1']);
});


test('a pristine select with an implicit first option does not invent an unsaved draft', async () => {
  const page = filterPage();
  page.burger.select.options.forEach(option => { option.defaultSelected = false; });
  page.burger.editor.open = true;
  await page.choose('2');
  assert.equal(page.prompts.length, 0);
  assert.equal(page.burger.editor.open, false);
});
