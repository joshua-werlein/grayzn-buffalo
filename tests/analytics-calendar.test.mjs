import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './load-ts.mjs';

const { calendarMonths, chicagoMidnight, loadAnalytics } = loadTs('src/lib/analytics.ts');
const { initializeMonthChart } = loadTs('src/lib/analytics-month-client.ts');
const config = { CF_ANALYTICS_API_TOKEN: 'private-token', CF_ANALYTICS_ACCOUNT_ID: 'a'.repeat(32), CF_ANALYTICS_SITE_TAG: 'b'.repeat(32) };
const limits = { enabled: true, maxDuration: 8035200, maxPageSize: 10000, notOlderThan: 15897600 };
const reply = value => Response.json({ data: { viewer: { accounts: [value] } } });

test('compiled chart renders covered calendar rows; provider failure keeps metrics unavailable and Facebook clicks independent', async t => {
  const { experimental_AstroContainer: AstroContainer } = await import('astro/container');
  const page = (await import('../dist/_worker.js/pages/admin/analytics.astro.mjs')).page().default;
  const container = await AstroContainer.create();
  const env = { ...config, SESSIONS: { get: async () => '1' }, DB: { prepare(sql) {
    const statement = { bind() { return statement; }, all: async () => ({ results: [] }),
      first: async () => sql.includes('settings') ? { value: '2026-01-01' } : { total: 18 } };
    return statement;
  } } };
  let fail = false;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    if (fail) return Response.json({ errors: [{ message: 'upstream unavailable confidential' }] }, { status: 503 });
    const { query } = JSON.parse(options.body);
    return query.includes('settings{') ? reply({ settings: { rumPageloadEventsAdaptiveGroups: limits } })
      : query.includes('hours:') ? reply({ hours: [] }) : reply({ pages: [], sources: [] });
  });
  const render = () => container.renderToString(page, {
    request: new Request('https://grayznbuffalo.com/admin/analytics', { headers: { cookie: `gb_session=${'c'.repeat(32)}` } }),
    locals: { runtime: { env } },
  });
  const success = await render();
  assert.match(success, /Previous Month/);
  assert.match(success, /Next Month/);
  assert.match(success, /aria-live="polite"/);
  assert.match(success, /Partial historical coverage begins/);
  assert.match(success, /Today is incomplete/);
  assert.match(success, /Unavailable/); // Dates before retention are unknown, not zero.
  assert.ok((success.match(/data-calendar-month/g) ?? []).length >= 6);
  fail = true;
  const unavailable = await render();
  assert.match(unavailable, /Website analytics is temporarily unavailable/);
  assert.match(unavailable, /Daily visits unavailable/);
  assert.doesNotMatch(unavailable, /data-month-chart|Previous Month|confidential/);
  assert.match(unavailable, /Facebook outbound clicks/);
  assert.match(unavailable, /class="metric-value"[^>]*>18</);
});

test('calendar months cross the year and include every date of leap and non-leap February', () => {
  for (const [year, length] of [[2024, 29], [2026, 28]]) {
    const months = calendarMonths(new Map(), chicagoMidnight(`${year - 1}-12-15`), new Date(`${year}-03-02T18:00:00Z`));
    assert.deepEqual(months.map(m => m.month), [`${year}-03`, `${year}-02`, `${year}-01`, `${year - 1}-12`]);
    assert.equal(months[1].days.length, length);
    assert.equal(months[1].days.at(-1).date, `${year}-02-${length}`);
    assert.ok(months[1].days.every(d => d.visits === 0 && d.coverage === 'complete'));
  }
});

test('partial coverage and future dates remain distinct from complete zero-visit days', () => {
  const months = calendarMonths(new Map([['2026-09-15', 7], ['2026-10-18', 3]]),
    chicagoMidnight('2026-09-15') + 3600000, new Date('2026-10-18T18:00:00Z'));
  assert.equal(months.length, 2);
  assert.deepEqual(months[1].days[13], { date: '2026-09-14', visits: null, coverage: 'unavailable' });
  assert.deepEqual(months[1].days[14], { date: '2026-09-15', visits: 7, coverage: 'partial' });
  assert.deepEqual(months[1].days[15], { date: '2026-09-16', visits: 0, coverage: 'complete' });
  assert.deepEqual(months[0].days[17], { date: '2026-10-18', visits: 3, coverage: 'today' });
  assert.deepEqual(months[0].days[18], { date: '2026-10-19', visits: null, coverage: 'future' });
  assert.equal(months[0].days.length, 31);
});

test('Chicago DST days and UTC month rollover preserve calendar coverage', () => {
  for (const [date, following, hours] of [['2026-03-08', '2026-03-09', 23], ['2026-11-01', '2026-11-02', 25]]) {
    assert.equal(chicagoMidnight(following) - chicagoMidnight(date), hours * 3600000);
    const months = calendarMonths(new Map([[date, 8]]), chicagoMidnight(date), new Date(`${following}T18:00:00Z`));
    const day = months[0].days.find(d => d.date === date);
    assert.deepEqual(day, { date, visits: 8, coverage: 'complete' });
  }
  const months = calendarMonths(new Map(), chicagoMidnight('2025-12-01'), new Date('2026-01-01T05:59:00Z'));
  assert.deepEqual(months.map(m => m.month), ['2025-12']);
  assert.equal(months[0].days.at(-1).coverage, 'today');
});

function chartFixture(count) {
  const panels = Array.from({ length: count }, (_, i) => ({ dataset: { monthLabel: `Month ${i}` }, hidden: false }));
  const previous = { disabled: false, addEventListener(_, fn) { this.click = fn; } };
  const next = { ...previous };
  const navigation = { hidden: true }, label = { textContent: '' };
  const selectors = { '.month-navigation': navigation, '[data-previous-month]': previous, '[data-next-month]': next, '[data-selected-month]': label };
  initializeMonthChart({ querySelectorAll: () => panels, querySelector: selector => selectors[selector] });
  return { panels, previous, next, navigation, label };
}
test('month controls stop at available history/current month and switch only existing panels', () => {
  const c = chartFixture(3);
  assert.equal(c.navigation.hidden, false);
  assert.equal(c.next.disabled, true);
  assert.deepEqual(c.panels.map(p => p.hidden), [false, true, true]);
  c.next.click(); assert.equal(c.label.textContent, 'Month 0');
  c.previous.click(); assert.equal(c.label.textContent, 'Month 1');
  assert.equal(c.next.disabled, false);
  c.previous.click(); assert.equal(c.previous.disabled, true);
  c.previous.click(); assert.equal(c.label.textContent, 'Month 2');
  c.next.click(); c.next.click();
  assert.equal(c.next.disabled, true);
  assert.deepEqual(c.panels.map(p => p.hidden), [false, true, true]);
  const single = chartFixture(1);
  assert.equal(single.previous.disabled, true);
  assert.equal(single.next.disabled, true);
});

test('diagnostics identify settings/history/recent failures without leaking provider messages', async () => {
  for (const stage of ['settings', 'history', 'recent']) {
    const diagnostics = [];
    const request = async (_, options) => {
      const { query } = JSON.parse(options.body);
      const current = query.includes('settings{') ? 'settings' : query.includes('hours:') ? 'history' : 'recent';
      if (current === stage) return Response.json({ errors: [{ message: 'unknown field private-token visitor.example /private' }] }, { status: 400 });
      return current === 'settings' ? reply({ settings: { rumPageloadEventsAdaptiveGroups: limits } }) : reply({ hours: [] });
    };
    const result = await loadAnalytics(config, new Date('2026-10-18T18:00:00Z'), request, d => diagnostics.push(d));
    // The word token is deliberately in the error: raw text is never emitted even for access failures.
    assert.equal(result.status, 'permission');
    assert.equal(diagnostics[0].stage, stage);
    assert.equal(diagnostics[0].httpStatus, 400);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-token|visitor|\/private/);
    assert.equal(result.data, undefined);
  }
});

test('runtime retention/duration and timeout failures report the failing stage and no zero totals', async () => {
  for (const [override, reason] of [[{ notOlderThan: 86400 * 7 }, 'insufficient-retention'], [{ maxDuration: 86400 * 20 }, 'recent-duration']]) {
    const diagnostics = [];
    const result = await loadAnalytics(config, new Date('2026-10-18T18:00:00Z'), async () => reply({ settings: { rumPageloadEventsAdaptiveGroups: { ...limits, ...override } } }), d => diagnostics.push(d));
    assert.deepEqual(result, { status: 'provider' });
    assert.equal(diagnostics[0].stage, 'history');
    assert.equal(diagnostics[0].reason, reason);
  }
  const diagnostics = [];
  assert.deepEqual(await loadAnalytics(config, new Date(), async () => { throw new DOMException('sensitive', 'TimeoutError'); }, d => diagnostics.push(d)), { status: 'provider' });
  assert.equal(diagnostics[0].reason, 'timeout');
  assert.doesNotMatch(JSON.stringify(diagnostics), /sensitive/);
});
