import {builtRoute} from './built-output.mjs';
// November 21 maintenance: bounded request bodies, explicit-column readers,
// server-side staff limits and sanitized staff errors. Build first.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';

const {readBodyBytes, readFormData, BodyTooLarge} = loadTs('src/lib/request-body.ts');
const {staffErrorMessage} = loadTs('src/lib/staff-error.ts');
const events = loadTs('src/lib/special-events.ts');
const {getMenu} = loadTs('src/lib/db.ts');
const container = await AstroContainer.create();
const origin = 'https://grayznbuffalo.com';
const cookie = 'gb_session=' + 'a'.repeat(32);

/** An endless body without Content-Length; counts the bytes it was asked for. */
function endless(chunk = 64 * 1024) {
  const state = {pulled: 0, cancelled: false};
  const stream = new ReadableStream({
    pull(controller) { state.pulled += chunk; controller.enqueue(new Uint8Array(chunk)); },
    cancel() { state.cancelled = true; },
  });
  return {stream, state};
}
const streamed = (url, stream, headers = {}) =>
  new Request(url, {method: 'POST', body: stream, duplex: 'half', headers: {origin, ...headers}});

test('bounded reader stops an endless or dishonest body at its limit', async () => {
  const {stream, state} = endless();
  await assert.rejects(readBodyBytes(streamed(origin + '/x', stream), 100 * 1024), BodyTooLarge);
  assert.ok(state.cancelled, 'the body is cancelled, not drained');
  assert.ok(state.pulled <= 256 * 1024, 'reading stops near the limit');
  // A declared length above the limit is rejected before reading.
  const declared = {headers: {get: name => name === 'content-length' ? '99999999' : null}, body: {cancel: async () => {}, getReader() { throw Error('read'); }}};
  await assert.rejects(readBodyBytes(declared, 1024), BodyTooLarge);
  // A small header does not let a larger body through.
  const lying = endless(4096);
  const request = streamed(origin + '/x', lying.stream);
  const liar = {headers: {get: name => name === 'content-length' ? '10' : request.headers.get(name)}, body: request.body};
  await assert.rejects(readBodyBytes(liar, 8192), BodyTooLarge);
  // Ordinary bodies and forms are unchanged.
  const body = new FormData(); body.set('action', 'add'); body.set('name', 'Wings');
  const form = await readFormData(new Request(origin + '/x', {method: 'POST', body}), 4096);
  assert.equal(form.get('action'), 'add'); assert.equal(form.get('name'), 'Wings');
  assert.equal((await readBodyBytes(new Request(origin + '/x', {method: 'POST', body: 'abc'}), 3)).byteLength, 3);
});

test('public contact and Facebook click endpoints reject oversized bodies without calling providers or D1', async (t) => {
  const outbound = t.mock.method(globalThis, 'fetch', async () => { throw Error('no network'); });
  const {POST: contact} = loadTs('src/pages/api/contact.ts');
  const env = {TURNSTILE_SECRET: 's', RESEND_API_KEY: 'k', CONTACT_TO_EMAIL: 'owner@example.com',
    DB: {prepare() { throw Error('Unexpected D1 access'); }}};
  const {stream, state} = endless();
  const response = await contact({request: streamed(origin + '/api/contact', stream, {'content-type': 'application/json'}), locals: {runtime: {env}}});
  assert.equal(response.status, 413);
  assert.ok(state.cancelled);
  assert.equal(outbound.mock.callCount(), 0);
  // A normal message still reaches validation (missing token, no provider call).
  const ok = await contact({request: new Request(origin + '/api/contact', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({name: 'Pat', email: 'pat@example.com', message: 'Hello'})}), locals: {runtime: {env}}});
  assert.equal(ok.status, 400);
  assert.match((await ok.json()).error, /Verification failed/);
  assert.equal(outbound.mock.callCount(), 0);

  const {POST: click} = loadTs('src/pages/api/facebook-click.ts');
  const big = endless();
  const clicked = await click({request: streamed(origin + '/api/facebook-click', big.stream), locals: {runtime: {env}}, url: new URL(origin + '/api/facebook-click')});
  assert.equal(clicked.status, 413);
  assert.ok(big.state.pulled <= 128 * 1024);
});

test('photo APIs reject an oversized upload body before parsing it or touching R2 and D1', async () => {
  for (const path of ['menu-photo', 'welcome-photo']) {
    const {POST} = loadTs('src/pages/api/' + path + '.ts');
    const {stream, state} = endless(1024 * 1024);
    const untouched = {get() { throw Error('Unexpected R2'); }, put() { throw Error('Unexpected R2'); }, delete() { throw Error('Unexpected R2'); }};
    const response = await POST({request: streamed(origin + '/api/' + path, stream, {'content-type': 'multipart/form-data; boundary=x'}),
      cookies: {get: () => ({value: 'a'.repeat(32)})},
      locals: {runtime: {env: {SESSIONS: {get: async () => '1'}, PHOTOS: untouched, DB: {prepare() { throw Error('Unexpected D1'); }}}}}});
    assert.equal(response.status, 413, path);
    assert.ok(state.cancelled && state.pulled <= 22 * 1024 * 1024, path);
    assert.match((await response.json()).error, /too big/);
  }
});

test('staff error messages keep validation text and hide database, storage and runtime details', () => {
  const fallback = 'Something went wrong.';
  assert.equal(staffErrorMessage(new Error('Item name is required.'), fallback), 'Item name is required.');
  for (const error of [new Error('D1_ERROR: no such column: secret_internal_column: SQLITE_ERROR'),
    new Error('UNIQUE constraint failed: items.id'), new Error('Network connection lost.'),
    new TypeError("Cannot read properties of undefined (reading 'x')"), 'raw string', new Error('')]) {
    assert.equal(staffErrorMessage(error, fallback), fallback);
  }
});

test('event readers select display columns only, never stored evidence, and still work before migration 0028', async (t) => {
  const now = new Date('2026-10-23T20:30:00Z');
  for (const beforeEventDisplayMigration of [false, true]) {
    const f = fixture(t, {beforeEventDisplayMigration});
    f.sql(`INSERT INTO special_events(id,title,event_date,time_text,status,origin,manual_locked,date_basis,evidence_json,last_auto_json,revision)
      VALUES('evt:a','Game Day','2026-10-23','','published','automation',0,'relative',?,?,1)`, 'E'.repeat(20000), 'L'.repeat(5000));
    f.sql("INSERT INTO special_event_offers(event_id,position,content) VALUES('evt:a',1,'Wings $1')");
    const queries = [];
    const prepare = f.env.DB.prepare;
    const env = {DB: {...f.env.DB, prepare(sql) { queries.push(sql); return prepare(sql); }}};
    const [visible] = await events.readVisibleEvents(env, now);
    assert.equal(visible.title, 'Game Day');
    assert.deepEqual(visible.offers, ['Wings $1']);
    assert.equal('evidence_json' in visible || 'last_auto_json' in visible || 'mutation_token' in visible, false);
    const [admin] = await events.readAdminEvents(env, now);
    assert.equal(admin.revision, 1);
    assert.equal((await events.readEvent(env, 'evt:a')).id, 'evt:a');
    const reads = queries.filter(sql => /FROM special_events/.test(sql) && /^\s*SELECT/.test(sql));
    assert.ok(reads.length >= 3);
    for (const sql of reads) assert.doesNotMatch(sql, /SELECT \*|evidence_json|last_auto_json|mutation_token/);
    if (!beforeEventDisplayMigration) assert.ok('display_from' in visible);
  }
});

test('public menu reader names its columns', async () => {
  const queries = [];
  const env = {DB: {prepare(sql) { queries.push(sql); return {all: async () => ({results: sql.includes('categories')
    ? [{id: 1, name: 'Wings', sort: 0, subtitle: '', note: ''}] : [{id: 2, category_id: 1, name: 'Bone-In', description: '', sort: 0, active: 1, photo_key: null, photo_orientation: 'portrait', late_night: 0}]})}; }}};
  const menu = await getMenu(env);
  assert.equal(menu.items[0].name, 'Bone-In');
  assert.equal(queries.length, 2);
  for (const sql of queries) assert.doesNotMatch(sql, /\*/);
});

// ── Compiled staff pages ──
const menuPage = (await builtRoute('admin/menu')).default;
const adminPage = (await builtRoute('admin')).default;
const schema = readFileSync('schema.sql', 'utf8');
const tableSql = table => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0];
function menuFixture(t) {
  const f = fixture(t);
  f.env.SESSIONS = {get: async () => '1'};
  f.sql(tableSql('categories')); f.sql(tableSql('items'));
  f.sql("INSERT INTO categories(id,name,sort) VALUES(1,'Wings',0)");
  f.sql("INSERT INTO items(id,category_id,name,description,sort) VALUES(1,1,'Bone-In Wings','Six wings',0)");
  return f;
}
const menuPost = (f, fields) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
  return container.renderToResponse(menuPage, {request: new Request('http://localhost/admin/menu', {method: 'POST', body,
    headers: {cookie, origin: 'http://localhost', accept: 'application/json'}}), locals: {runtime: {env: f.env}}});
};

test('Admin Menu enforces item name and description limits server-side; valid saves are unchanged', async (t) => {
  const f = menuFixture(t);
  const items = () => f.sql('SELECT id,name,description FROM items ORDER BY id');
  for (const [fields, message] of [
    [{name: 'x'.repeat(121)}, /Item name must be 120 characters or fewer/],
    [{name: '   '}, /Item name is required/],
    [{name: 'Boneless', description: 'd'.repeat(1001)}, /Item description must be 1000 characters or fewer/],
  ]) {
    const response = await menuPost(f, {action: 'add', category_id: 1, description: '', ...fields});
    assert.match((await response.json()).error, message);
  }
  const edit = await menuPost(f, {action: 'edit', id: 1, category_id: 1, name: 'n'.repeat(121), description: 'Six wings',
    was_name: 'Bone-In Wings', was_description: 'Six wings', was_category_id: 1, was_late_night: 0});
  assert.match((await edit.json()).error, /120 characters/);
  assert.deepEqual(items(), [{id: 1, name: 'Bone-In Wings', description: 'Six wings'}]);
  // Boundary values save.
  const added = await menuPost(f, {action: 'add', category_id: 1, name: 'n'.repeat(120), description: 'd'.repeat(1000)});
  assert.equal((await added.json()).ok, true);
  assert.equal(items().length, 2);
  // The editor's inputs carry the same limits.
  const html = await container.renderToString(menuPage, {request: new Request('http://localhost/admin/menu', {headers: {cookie}}), locals: {runtime: {env: f.env}}});
  assert.match(html, /id="add-name" name="name" required maxlength="120"/);
  assert.match(html, /id="add-desc" name="description" rows="3" maxlength="1000"/);
});

test('Admin Menu hides unexpected database errors from staff responses and rejects oversized forms', async (t) => {
  const f = menuFixture(t);
  const prepare = f.env.DB.prepare;
  f.env.DB = {...f.env.DB, prepare(sql) {
    if (/^DELETE FROM items/.test(sql)) throw new Error('D1_ERROR: no such table: secret_internal_table: SQLITE_ERROR');
    return prepare(sql);
  }};
  const response = await menuPost(f, {action: 'delete', id: 1});
  const {error} = await response.json();
  assert.doesNotMatch(error, /D1_ERROR|secret_internal|SQLITE/);
  assert.match(error, /Nothing was saved/);
  const {stream} = endless();
  const big = await container.renderToResponse(menuPage, {request: new Request('http://localhost/admin/menu', {method: 'POST', body: stream, duplex: 'half',
    headers: {cookie, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded'}}), locals: {runtime: {env: f.env}}});
  assert.equal(big.status, 413);
});

test('announcements are length-checked server-side and saved together in one batch', async () => {
  const batches = [];
  const env = {SESSIONS: {get: async () => '1'}, DB: {
    prepare: sql => ({bind: (...args) => ({sql, args}), first: async () => null}),
    batch: async statements => { batches.push(statements); return statements.map(() => ({})); },
  }};
  const post = fields => container.renderToResponse(adminPage, {request: new Request(origin + '/admin', {method: 'POST',
    headers: {origin, cookie}, body: new URLSearchParams(fields)}), locals: {runtime: {env}}});
  const long = await post({action: 'save-announcements', announcement_1: 'a'.repeat(141), announcement_2: '', announcement_3: ''});
  assert.equal(long.status, 303);
  assert.equal(long.headers.get('location'), '/admin?settings=1&saved=ann-long');
  assert.equal(batches.length, 0);
  const saved = await post({action: 'save-announcements', announcement_1: ' Trivia tonight ', announcement_2: 'a'.repeat(140), announcement_3: ''});
  assert.equal(saved.headers.get('location'), '/admin?settings=1&saved=ann');
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(s => s.args), [['announcement_1', 'Trivia tonight'], ['announcement_2', 'a'.repeat(140)], ['announcement_3', '']]);
});
