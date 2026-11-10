// Run the production build first: checks the generated dist/server/wrangler.json.
//
// The site route grayznbuffalo.com/* is dashboard-managed. With a `routes` entry,
// `wrangler deploy` PUTs the Worker's full route list and deletes any route not in
// config, so the site config must not declare routes, a route or custom domains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchRoutes, parseRoutes } from 'miniflare';

const source = readFileSync('wrangler.toml', 'utf8');
const generated = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
const facebookRoutes = [...readFileSync('workers/fb-feed/wrangler.toml', 'utf8')
  .matchAll(/pattern\s*=\s*"([^"]+)"/g)].map(m => m[1]);

test('site Worker has no workers.dev address or preview URLs', () => {
  assert.match(source, /^workers_dev\s*=\s*false\s*$/m);
  assert.match(source, /^preview_urls\s*=\s*false\s*$/m);
  assert.equal(generated.workers_dev, false);
  assert.equal(generated.preview_urls, false);
});

test('site Worker config never manages routes or custom domains', () => {
  assert.doesNotMatch(source, /^\s*(routes|route)\s*=/m);
  assert.doesNotMatch(source, /^\s*\[\[?routes\]?\]/m);
  assert.doesNotMatch(source, /custom_domain/);
  assert.equal(generated.routes, undefined);
  assert.equal(generated.route, undefined);
});

test('private diagnostics persist without invocation logs, query strings, traces or external destinations', () => {
  assert.equal(generated.observability.enabled, true);
  assert.equal(generated.observability.redact_query_string, true);
  assert.equal(generated.observability.logs.enabled, true);
  assert.equal(generated.observability.logs.persist, true);
  assert.equal(generated.observability.logs.head_sampling_rate, 1);
  assert.equal(generated.observability.logs.invocation_logs, false);
  assert.deepEqual(generated.observability.logs.destinations, []);
  assert.equal(generated.observability.traces.enabled, false);
  assert.equal(generated.observability.issues.enabled, false);
});

test('site Worker keeps the Pages D1/KV/R2 resources and serves only client assets', () => {
  assert.equal(generated.name, 'grayzn-buffalo');
  assert.deepEqual(generated.d1_databases.map(d => [d.binding, d.database_id]),
    [['DB', 'c998bfd4-7031-4ae2-9eea-df86f16ddb15']]);
  assert.deepEqual(generated.kv_namespaces.map(k => [k.binding, k.id]),
    [['SESSIONS', '3c31559924b64014844778c431b80ef1']]);
  assert.deepEqual(generated.r2_buckets.map(r => [r.binding, r.bucket_name]), [['PHOTOS', 'grayzn-photos']]);
  assert.deepEqual(generated.assets, { binding: 'ASSETS', directory: '../client' });
  assert.equal(generated.upload_source_maps, false);
});

test('Facebook Worker routes stay more specific than the site route', () => {
  assert.deepEqual(facebookRoutes,
    ['grayznbuffalo.com/api/facebook-feed', 'grayznbuffalo.com/api/facebook-webhook*']);
  const live = parseRoutes(new Map([
    ['grayzn-buffalo', ['grayznbuffalo.com/*']],
    ['grayzn-fb-feed', facebookRoutes],
  ]));
  const target = url => matchRoutes(live, new URL(url)) ?? null;
  for (const path of ['/', '/menu', '/specials', '/admin/menu', '/api/contact', '/api/facebook-click'])
    assert.equal(target('https://grayznbuffalo.com' + path), 'grayzn-buffalo', path);
  for (const path of ['/api/facebook-feed', '/api/facebook-webhook', '/api/facebook-webhook?hub.mode=subscribe'])
    assert.equal(target('https://grayznbuffalo.com' + path), 'grayzn-fb-feed', path);
  // Exact feed pattern does not match a query string; production returns 404 for it today.
  assert.equal(target('https://grayznbuffalo.com/api/facebook-feed?x=1'), 'grayzn-buffalo');
  assert.equal(target('https://www.grayznbuffalo.com/'), null);

  // Rollback: removing only the site route returns non-Facebook traffic to the Pages origin.
  const rollback = parseRoutes(new Map([['grayzn-fb-feed', facebookRoutes]]));
  assert.equal(matchRoutes(rollback, new URL('https://grayznbuffalo.com/menu')) ?? null, null);
  assert.equal(matchRoutes(rollback, new URL('https://grayznbuffalo.com/api/facebook-feed')), 'grayzn-fb-feed');
});
