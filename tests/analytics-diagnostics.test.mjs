import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './load-ts.mjs';

const { loadAnalytics } = loadTs('src/lib/analytics.ts');
const env = { CF_ANALYTICS_API_TOKEN: 'private-token', CF_ANALYTICS_ACCOUNT_ID: 'a'.repeat(32), CF_ANALYTICS_SITE_TAG: 'b'.repeat(32) };
const now = new Date('2026-11-09T03:47:30Z');
const limits = { enabled: true, maxDuration: 8035200, maxPageSize: 10000, notOlderThan: 15897600 };
const reply = value => Response.json({ data: { viewer: { accounts: [value] } } });
const normal = query => query.includes('settings{') ? reply({ settings: { rumPageloadEventsAdaptiveGroups: limits } })
  : query.includes('hours:') ? reply({ hours: [] }) : reply({ pages: [], sources: [] });

test('diagnostics distinguish request timeout from body parsing and preserve HTTP status without provider text', async t => {
  for (const scenario of [
    { response: () => { throw new DOMException('private-token', 'TimeoutError'); }, phase: 'fetch', reason: 'timeout', httpStatus: undefined },
    { response: () => new Response('private-token visitor information', { status: 502 }), phase: 'json', reason: 'network-or-json', httpStatus: 502 },
    { response: () => ({ status: 200, json: async () => { throw new DOMException('private-token', 'AbortError'); } }), phase: 'json', reason: 'timeout', httpStatus: 200 },
    { response: () => Response.json({ errors: [{ message: 'Unknown field confidential visitor information' }] }), phase: 'validate', reason: 'query-schema', httpStatus: 200 },
    { response: () => new Response('', { status: 403 }), phase: 'fetch', reason: 'http', httpStatus: 403 },
  ]) {
    await t.test(`${scenario.phase}/${scenario.reason}/${scenario.httpStatus}`, async () => {
      const diagnostics = [];
      const result = await loadAnalytics(env, now, async () => scenario.response(), d => diagnostics.push(d));
      assert.deepEqual(result, { status: scenario.httpStatus === 403 ? 'permission' : 'provider' });
      assert.equal(diagnostics.length, 1);
      const d = diagnostics[0];
      assert.equal(d.stage, 'settings');
      assert.equal(d.phase, scenario.phase);
      assert.equal(d.reason, scenario.reason);
      assert.equal(d.httpStatus, scenario.httpStatus);
      assert.ok(Number.isSafeInteger(d.elapsedMs) && d.elapsedMs >= 0);
      assert.ok(Number.isSafeInteger(d.queryElapsedMs) && d.queryElapsedMs >= 0 && d.queryElapsedMs <= d.elapsedMs);
      assert.doesNotMatch(JSON.stringify(d), /private-token|confidential|visitor information|Unknown field/);
    });
  }
});

test('history failures identify the exact chunk, total wall time and current query time', async t => {
  let clock = 1000, calls = 0;
  t.mock.method(Date, 'now', () => clock);
  const diagnostics = [];
  const result = await loadAnalytics(env, now, async (_, options) => {
    const { query } = JSON.parse(options.body);
    assert.ok(options.signal instanceof AbortSignal);
    calls++;
    if (calls === 4) { clock += 12000; throw new DOMException('confidential', 'TimeoutError'); }
    clock += 25;
    return normal(query);
  }, d => diagnostics.push(d));
  assert.deepEqual(result, { status: 'provider' });
  assert.deepEqual(diagnostics, [{ stage: 'history', reason: 'timeout', httpStatus: undefined,
    limits, chunk: 3, phase: 'fetch', elapsedMs: 12075, queryElapsedMs: 12000 }]);
});

test('recent query status does not inherit a history response and diagnostics cannot break safe failure', async () => {
  const diagnostics = [];
  const result = await loadAnalytics(env, now, async (_, options) => {
    const { query } = JSON.parse(options.body);
    if (query.includes('pages:')) throw Error('confidential network failure');
    return normal(query);
  }, d => { diagnostics.push(d); throw Error('diagnostic sink unavailable'); });
  assert.deepEqual(result, { status: 'provider' });
  assert.equal(diagnostics[0].stage, 'recent');
  assert.equal(diagnostics[0].chunk, undefined);
  assert.equal(diagnostics[0].httpStatus, undefined);
  assert.equal(diagnostics[0].phase, 'fetch');
  assert.equal(diagnostics[0].reason, 'network-or-json');
  assert.doesNotMatch(JSON.stringify(diagnostics), /confidential/);
});

test('normalization failures retain safe response metadata; successful loads emit no failure diagnostics', async () => {
  const diagnostics = [];
  const result = await loadAnalytics(env, now, async (_, options) => {
    const { query } = JSON.parse(options.body);
    return query.includes('pages:') ? reply({ pages: null, sources: [] }) : normal(query);
  }, d => diagnostics.push(d));
  assert.deepEqual(result, { status: 'provider' });
  assert.equal(diagnostics[0].stage, 'normalize');
  assert.equal(diagnostics[0].phase, 'normalize');
  assert.equal(diagnostics[0].httpStatus, 200);
  const successDiagnostics = [];
  assert.equal((await loadAnalytics(env, now, async (_, options) => normal(JSON.parse(options.body).query),
    d => successDiagnostics.push(d))).status, 'ok');
  assert.deepEqual(successDiagnostics, []);
});

test('immediate pre-response failures distinguish invalid headers and native invocation/API errors privately', async () => {
  for (const [token, error, reason] of [
    ['private\ncredential', new TypeError('sensitive header contents'), 'request-headers'],
    ['private-token', new TypeError('Illegal invocation private-token'), 'fetch-invocation'],
    ['private-token', new TypeError('AbortSignal.timeout is not a function private-token'), 'runtime-api'],
    ['private-token', new TypeError('sensitive transport contents'), 'fetch-type'],
  ]) {
    const diagnostics = [];
    assert.deepEqual(await loadAnalytics({ ...env, CF_ANALYTICS_API_TOKEN: token }, now,
      async () => { throw error; }, d => diagnostics.push(d)), { status: 'provider' });
    assert.equal(diagnostics[0].reason, reason);
    assert.equal(diagnostics[0].phase, 'fetch');
    assert.equal(diagnostics[0].httpStatus, undefined);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private|credential|sensitive|Illegal invocation|AbortSignal/);
  }
});
