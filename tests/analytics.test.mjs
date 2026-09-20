import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTs } from './load-ts.mjs';

const a = loadTs('src/lib/analytics.ts');
const db = loadTs('src/lib/db.ts');
const { POST, ALL } = loadTs('src/pages/api/facebook-click.ts');
const { trackFacebookActivation } = loadTs('src/lib/facebook-click-client.ts');
const limits = { enabled: true, maxDuration: 8035200, maxPageSize: 10000, notOlderThan: 15897600 };
const now = new Date('2026-09-20T18:00:00Z');
const config = { CF_ANALYTICS_API_TOKEN: 'test-secret', CF_ANALYTICS_ACCOUNT_ID: 'a'.repeat(32), CF_ANALYTICS_SITE_TAG: 'b'.repeat(32) };
const reply = value => Response.json({ data: { viewer: { accounts: [value] } }, errors: null });

test('30 Chicago calendar days, year/month rollover, and DST boundaries', () => {
  assert.equal(a.reportingWindow(now).start, '2026-08-22');
  assert.equal(a.reportingWindow(new Date('2026-01-01T05:59:00Z')).today, '2025-12-31');
  assert.equal(a.reportingWindow(new Date('2026-01-01T06:00:00Z')).today, '2026-01-01');
  assert.equal(a.reportingWindow(new Date('2026-03-10T18:00:00Z')).start, '2026-02-09');
  assert.equal(a.chicagoMidnight('2026-03-09') - a.chicagoMidnight('2026-03-08'), 23 * 3600000);
  assert.equal(a.chicagoMidnight('2026-11-02') - a.chicagoMidnight('2026-11-01'), 25 * 3600000);
  assert.equal(new Date(a.chicagoMidnight('2026-09-01')).toISOString(), '2026-09-01T05:00:00.000Z');
});

test('available history uses account retention and contiguous bounded chunks', () => {
  const chunks = a.historyChunks(now.getTime(), limits);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0][0], now.getTime() - 184 * 86400000 + 120000);
  assert.equal(chunks.at(-1)[1], now.getTime());
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(chunks[i][1] > chunks[i][0]);
    assert.ok(chunks[i][1] - chunks[i][0] <= limits.maxDuration * 1000);
    if (i) assert.equal(chunks[i - 1][1], chunks[i][0]);
  }
});

test('public filtering and hostname source grouping reject misleading matches', () => {
  for (const path of ['/admin', '/admin/', '/admin/analytics', '/api', '/api/facebook-feed', '/img/a', '/_astro/a', '/cdn-cgi/a', '/menu.json']) assert.equal(a.isPublicPath(path), false);
  for (const path of ['/', '/menu', '/specials', '/contact']) assert.equal(a.isPublicPath(path), true);
  for (const host of ['google.com', 'www.google.co.uk', 'WWW.GOOGLE.COM.', 'google.ca']) assert.equal(a.sourceGroup(host), 'Google');
  for (const host of ['facebook.com', 'm.facebook.com', 'lm.facebook.com', 'l.facebook.com']) assert.equal(a.sourceGroup(host), 'Facebook');
  for (const host of ['', 'google.com.evil.net', 'notfacebook.com', 'bing.com']) assert.equal(a.sourceGroup(host), 'Direct / Other');
  const filter = a.publicFilter('site', 0, 1000);
  assert.ok(filter.requestPath_notin.includes('/admin'));
  assert.ok(filter.AND.some(row => row.requestPath_notlike === '/admin/%'));
});

function provider(overrides = {}) {
  return async (url, options) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    const { query, variables } = JSON.parse(options.body);
    if (query.includes('settings{')) return reply({ settings: { rumPageloadEventsAdaptiveGroups: limits } });
    if (query.includes('hours:')) {
      const sample = [
        ['2026-07-01T05:00:00Z', 4], ['2026-08-22T04:00:00Z', 9],
        ['2026-08-22T05:00:00Z', 2], ['2026-09-20T17:00:00Z', 3],
      ].filter(([stamp]) => Date.parse(stamp) >= Date.parse(variables.filter.datetime_geq) && Date.parse(stamp) < Date.parse(variables.filter.datetime_lt));
      return reply({ hours: sample.map(([datetimeHour, visits]) => ({ dimensions: { datetimeHour }, sum: { visits } })) });
    }
    return reply({ pages: [
      { dimensions: { requestPath: '/specials' }, count: 8 }, { dimensions: { requestPath: '/menu' }, count: 15 },
    ], sources: [
      { dimensions: { refererHost: 'www.google.com' }, sum: { visits: 2 } },
      { dimensions: { refererHost: 'lm.facebook.com' }, sum: { visits: 1 } },
      { dimensions: { refererHost: '' }, sum: { visits: 2 } },
    ], ...overrides });
  };
}

test('normalizes verified response shape, pageviews, recent/history totals and months', async () => {
  const r = await a.loadAnalytics(config, now, provider());
  assert.equal(r.status, 'ok');
  assert.equal(r.data.recentVisits, 5);
  assert.equal(r.data.historyVisits, 18);
  assert.equal(r.data.daily.length, 30);
  assert.equal(r.data.daily[0].date, '2026-09-20');  // newest first
  assert.equal(r.data.daily[29].date, '2026-08-22'); // oldest last
  assert.equal(r.data.monthly.length, 6);
  assert.equal(r.data.monthly[0].visits, 3);
  assert.equal(r.data.monthly[0].partial, true);   // current month: always partial
  assert.equal(r.data.monthly[1].visits, 11);
  assert.equal(r.data.monthly[1].partial, false);
  assert.equal(r.data.monthly[2].visits, 4);
  assert.equal(r.data.monthly[2].partial, false);
  assert.equal(r.data.monthly[3].visits, 0);        // Jun 2026: no traffic in sample
  assert.equal(r.data.monthly[3].partial, false);   // Jun 1 is after history start (~Mar 20)
  assert.equal(r.data.monthly[4].visits, 0);        // May 2026
  assert.equal(r.data.monthly[5].visits, 0);        // Apr 2026
  assert.equal(r.data.pages[0].path, '/menu');
  assert.equal(r.data.pages[0].views, 15);
  assert.deepEqual(r.data.sources.map(s => s.visits), [2, 1, 2]);
});

test('missing configuration, denied token and provider/GraphQL failures never become zeros', async () => {
  assert.deepEqual(await a.loadAnalytics({}, now, () => { throw Error('must not fetch'); }), { status: 'configuration' });
  for (const [response, status] of [
    [() => new Response('', { status: 403 }), 'permission'],
    [() => new Response('', { status: 429 }), 'provider'],
    [() => Response.json({ errors: [{ message: 'Authentication error test-secret' }] }), 'permission'],
    [() => Response.json({ errors: [{ message: 'Query failed' }] }), 'provider'],
    [() => new Response('bad JSON'), 'provider'],
    [() => { throw Error('private'); }, 'provider'],
  ]) assert.deepEqual(await a.loadAnalytics(config, now, async () => response()), { status });
  assert.equal((await a.loadAnalytics(config, now, provider({ pages: null }))).status, 'provider');
  assert.equal((await a.loadAnalytics(config, now, provider({ sources: Array(10000).fill({}) }))).status, 'provider');
});

function fakeDb() {
  const writes = []; let total = 0;
  return { writes, DB: { prepare(sql) {
    let params = [];
    const stmt = { bind(...values) { params = values; return stmt; },
      async first() { return sql.includes('settings') ? { value: '2026-09-20' } : { total }; },
      async run() { writes.push({ sql, params }); total++; return { success: true }; },
    }; return stmt;
  } } };
}
test('counter uses a single atomic upsert with only the server Chicago date', async () => {
  const env = fakeDb();
  await Promise.all(Array.from({ length: 10 }, () => db.incrementFacebookClicks(env, now)));
  assert.equal(env.writes.length, 10);
  for (const write of env.writes) {
    assert.match(write.sql, /ON CONFLICT\(date\) DO UPDATE SET count = facebook_outbound_clicks_daily.count \+ 1/);
    assert.deepEqual(write.params, ['2026-09-20']);
  }
  assert.deepEqual(await db.getFacebookClicks(env, '2026-08-22', '2026-09-20'), { status: 'ok', count: 10, started: '2026-09-20' });
  assert.equal((await db.getFacebookClicks({}, '2026-08-22', '2026-09-20')).status, 'unavailable');
});

test('endpoint rejects client fields, wrong origin/host, and non-POST; errors are private', async () => {
  const env = fakeDb();
  const send = (url = 'https://grayznbuffalo.com/api/facebook-click', options = {}) => POST({
    request: new Request(url, { method: 'POST', headers: { Origin: 'https://grayznbuffalo.com' }, ...options }),
    url: new URL(url), locals: { runtime: { env } },
  });
  assert.equal((await send()).status, 204);
  assert.equal((await send(undefined, { body: JSON.stringify({ count: 100, date: '2020-01-01', event: 'other' }) })).status, 400);
  assert.equal((await send(undefined, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await send('https://preview.pages.dev/api/facebook-click')).status, 403);
  assert.equal((await send('https://grayznbuffalo.com/api/facebook-click?count=100')).status, 403);
  assert.equal(ALL().status, 405);
  assert.equal(env.writes.length, 1);
});

test('Facebook links count once per activation without cancelling navigation or suppressing repeats', async (t) => {
  class FakeElement {
    constructor(href, eligible = true, opener = false) { this.href = href; this.eligible = eligible; this.opener = opener; }
    closest(selector) { return selector === 'a[href]' ? this : this.opener ? this : null; }
    hasAttribute() { return false; }
    matches() { return this.eligible; }
  }
  const previous = globalThis.Element;
  globalThis.Element = FakeElement;
  t.after(() => { if (previous === undefined) delete globalThis.Element; else globalThis.Element = previous; });
  const page = new URL('https://grayznbuffalo.com/');
  const calls = [];
  const send = (...args) => { calls.push(args); return Promise.reject(Error('offline')); };
  const event = { type: 'click', button: 0, isTrusted: true, defaultPrevented: false,
    target: new FakeElement('https://www.facebook.com/grayznbuffalo/'), preventDefault() { assert.fail('must not cancel'); } };
  trackFacebookActivation(event, page, send); trackFacebookActivation(event, page, send);
  trackFacebookActivation({ ...event, type: 'auxclick', button: 1 }, page, send);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ['/api/facebook-click', { method: 'POST', keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' }]);
  for (const extra of [{ defaultPrevented: true }, { isTrusted: false }, { button: 2 },
    { target: new FakeElement('https://google.com') }, { target: new FakeElement('https://facebook.com.evil.net') },
    { target: new FakeElement('https://facebook.com/post', false) }, { target: new FakeElement('https://facebook.com/post', true, true) }]) trackFacebookActivation({ ...event, ...extra }, page, send);
  trackFacebookActivation(event, new URL('https://grayznbuffalo.com/admin/analytics'), send);
  assert.equal(calls.length, 3);
  assert.doesNotThrow(() => trackFacebookActivation(event, page, () => { throw Error('offline'); }));
  await Promise.resolve();
});

test('admin page authenticates before loading and nav has no shared logout forms', () => {
  const page = readFileSync('src/pages/admin/analytics.astro', 'utf8');
  assert.ok(page.indexOf('await isAuthed') < page.indexOf('Promise.all'));
  const base = readFileSync('src/layouts/Base.astro', 'utf8');
  assert.ok(!base.includes('value="logout"'));
  assert.ok(base.includes('class="admin-analytics-circle"'));
  assert.ok(base.includes('Admin Analytics'));
  const settings = readFileSync('src/pages/admin/index.astro', 'utf8');
  assert.match(settings, /<form method="post" action="\/admin" class="signout-form">\s*<input type="hidden" name="action" value="logout"/);
});
