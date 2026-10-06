import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';
import {requeueFailedImport} from './worker.js';

// Tuesday 2030-01-08 (Jan 8, 2030 is a Tuesday): within the default harness week 2030-01-07/2030-01-13.
const TUESDAY_NOW  = '2030-01-08T15:00:00Z';  // 9 AM Chicago, within processing hours
const TUESDAY_POST = '2030-01-08T14:00:00Z';  // 8 AM Chicago, same calendar day

function tuesdayHarness(t, overrides = {}) {
  const f = harness(t, {now: TUESDAY_NOW, caption: 'specials tonight', ...overrides});
  Object.assign(f.state.posts[0], {created_time: TUESDAY_POST, updated_time: TUESDAY_POST});
  return f;
}

const emptyOffersPoster = () => ({
  day_of_week: -1, day_evidence: '', poster_evidence: "TONIGHT @ GRAYZ'N BUFFALO 5-10PM!", offers: [],
});

const validMexicanNight = () => ({
  type: 'mexican-night', poster_evidence: 'Mexican Night', schedule: 'Tuesdays 5–10 PM',
  groups: [{label: 'Entrees', items: [{title: 'Burrito $9.00', description: 'Meat and refried beans'}]}],
});

// Test 1: Tuesday generic offers:[] → targeted retry → valid Mexican Night → routes to mexican-night
test('Tuesday empty offers triggers MN targeted retry; success routes to mexican-night', async t => {
  const f = tuesdayHarness(t);
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => {
    callCount++;
    if (callCount === 1) return {response: JSON.stringify(emptyOffersPoster())};
    return {response: JSON.stringify(validMexicanNight())};
  });
  await f.run();
  const row = f.imports()[0];
  assert.equal(row.validation_result, 'ok');
  assert.equal(row.validation_reason, 'mexican night evidence');
  assert.equal(row.target_kind, 'section');
  assert.equal(row.target_collection_id, 'mexican-night');
  assert.equal(row.processing_status, 'staged');
  assert.equal(callCount, 2);
});

// Test 2: Generic daily shape with visible Mexican Night in evidence → shape-error retry → Mexican Night
test('Daily shape with Mexican Night in evidence triggers shape-error retry', async t => {
  const f = tuesdayHarness(t);
  // AI returns a daily-offers shape but includes "Mexican Night" in poster_evidence
  const wrongShape = {
    day_of_week: 2, day_evidence: '', poster_evidence: 'Mexican Night Tuesday 5-10 PM',
    offers: [{content: 'Burrito $9', service_time: '', evidence: ''}],
  };
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => {
    callCount++;
    if (callCount === 1) return {response: JSON.stringify(wrongShape)};
    return {response: JSON.stringify(validMexicanNight())};
  });
  await f.run();
  const row = f.imports()[0];
  assert.equal(row.validation_result, 'ok');
  assert.equal(row.target_collection_id, 'mexican-night');
  assert.equal(callCount, 2);
});

// Test 3: Tuesday ordinary daily specials with non-empty offers and no Mexican Night evidence → no retry
test('Tuesday non-empty ordinary offers with no MN evidence: no retry, not rerouted', async t => {
  const f = tuesdayHarness(t, {caption: 'Tuesday Specials'});
  const ordinary = {
    day_of_week: 2, day_evidence: 'Tuesday', poster_evidence: 'Tuesday Specials',
    offers: [{content: 'Chicken Caesar $9.75', service_time: '', evidence: ''}],
  };
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => { callCount++; return {response: JSON.stringify(ordinary)}; });
  await f.run();
  const row = f.imports()[0];
  assert.equal(row.validation_result, 'ok');
  assert.equal(callCount, 1, 'only one AI call; no retry needed');
  assert.notEqual(row.target_collection_id, 'mexican-night');
});

// Test 4: Tuesday empty offers → targeted retry cannot confirm Mexican Night → fails closed
test('Tuesday empty offers then MN retry returns empty groups: fails closed', async t => {
  const f = tuesdayHarness(t);
  const failedMN = {type: 'mexican-night', poster_evidence: '', groups: []};
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => {
    callCount++;
    if (callCount === 1) return {response: JSON.stringify(emptyOffersPoster())};
    return {response: JSON.stringify(failedMN)};
  });
  await f.run();
  const row = f.imports()[0];
  assert.equal(row.processing_status, 'failed');
  assert.equal(row.validation_result, 'rejected');
  assert.equal(callCount, 2, 'both attempts consumed');
  assert.notEqual(row.target_collection_id, 'mexican-night');
});

// Test 5: Non-Tuesday empty offers → no Tuesday Mexican retry
test('Non-Tuesday empty offers does not trigger MN retry', async t => {
  // Wednesday (default harness)
  const f = harness(t, {caption: 'Specials'});
  const emptyWed = {day_of_week: -1, day_evidence: '', poster_evidence: 'Specials', offers: []};
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => { callCount++; return {response: JSON.stringify(emptyWed)}; });
  await f.run();
  assert.equal(callCount, 1, 'no retry on non-Tuesday');
  const row = f.imports()[0];
  // Empty offers → valid poster evidence, staged
  assert.equal(row.validation_result, 'ok');
  assert.notEqual(row.target_collection_id, 'mexican-night');
});

// Test 6: Generic extractor directly returns valid type:'mexican-night' → Option B routing
test('Generic extractor returns valid mexican-night directly: Option B routing, no unnecessary retry', async t => {
  const f = tuesdayHarness(t, {caption: 'tonight specials'});
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => { callCount++; return {response: JSON.stringify(validMexicanNight())}; });
  await f.run();
  const row = f.imports()[0];
  assert.equal(row.validation_result, 'ok');
  assert.equal(row.target_collection_id, 'mexican-night');
  assert.equal(row.target_kind, 'section');
  assert.equal(callCount, 1, 'no retry when first extraction already returns mexican-night');
});

// Test 7: Explicit Mexican Night caption + valid extraction remains correct
test('Explicit Mexican Night caption with valid MN extraction preserves routing', async t => {
  const f = tuesdayHarness(t, {caption: 'Mexican Night @ Grayzn Buffalo!'});
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => { callCount++; return {response: JSON.stringify(validMexicanNight())}; });
  await f.run();
  const row = f.imports()[0];
  assert.equal(row.validation_result, 'ok');
  assert.equal(row.target_collection_id, 'mexican-night');
  assert.equal(callCount, 1);
});

// Test 8: Unrelated Tuesday poster says "Tonight" and shows 5–10 PM but non-empty offers → never rerouted
test('Unrelated Tuesday poster (Tonight, 5-10PM, non-empty offers) is never rerouted to mexican-night', async t => {
  const f = tuesdayHarness(t, {caption: 'TONIGHT @ GRAYZN BUFFALO 5-10PM!'});
  const nonEmptyPoster = {
    day_of_week: -1, day_evidence: '', poster_evidence: "TONIGHT @ GRAYZ'N BUFFALO 5-10PM!",
    offers: [{content: 'Fish Fry $11.50', service_time: '', evidence: ''}],
  };
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => { callCount++; return {response: JSON.stringify(nonEmptyPoster)}; });
  await f.run();
  assert.equal(callCount, 1, 'no retry: poster has non-empty offers');
  const row = f.imports()[0];
  assert.equal(row.validation_result, 'ok');
  assert.notEqual(row.target_collection_id, 'mexican-night', 'must not be rerouted just because of Tonight/5-10PM');
});

// Test 9: Budget/event accounting records both extraction attempts when retry occurs
test('Both extraction attempts produce extract events; retry produces a retry event', async t => {
  const f = tuesdayHarness(t);
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => {
    callCount++;
    if (callCount === 1) return {response: JSON.stringify(emptyOffersPoster())};
    return {response: JSON.stringify(validMexicanNight())};
  });
  await f.run();
  const row = f.imports()[0];
  const events = f.sql("SELECT event_type,detail FROM special_import_events WHERE import_id=? ORDER BY rowid", row.id);
  const extractEvents = events.filter(e => e.event_type === 'extract');
  const retryEvents  = events.filter(e => e.event_type === 'retry');
  assert.equal(extractEvents.length, 2, 'two extract budget reservations');
  assert.equal(retryEvents.length, 1, 'one retry event');
  assert.match(retryEvents[0].detail, /mexican\s+night/i, 'retry detail identifies Mexican Night');
  assert.equal(callCount, 2);
});

// Test 10: Pending/reprocess path on Tuesday gets the same Tuesday-retry behavior
test('Pending reprocess path on Tuesday also triggers MN targeted retry', async t => {
  const f = tuesdayHarness(t);
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => {
    callCount++;
    // First run: attempt 0 empty offers → attempt 1 fails (empty groups) → record failed
    if (callCount === 1) return {response: JSON.stringify(emptyOffersPoster())};
    if (callCount === 2) return {response: JSON.stringify({type:'mexican-night', poster_evidence:'', groups:[]})};
    // Second run (reprocess): attempt 0 empty offers → attempt 1 valid MN → success
    if (callCount === 3) return {response: JSON.stringify(emptyOffersPoster())};
    return {response: JSON.stringify(validMexicanNight())};
  });

  // First run: should fail (retry can't confirm MN)
  await f.run();
  const failedRow = f.imports()[0];
  assert.equal(failedRow.processing_status, 'failed', 'first run fails closed');

  // Requeue the failed import
  await requeueFailedImport(f.env, failedRow.id);
  const afterRequeue = f.sql('SELECT processing_status FROM special_imports WHERE id=?', failedRow.id)[0];
  assert.equal(afterRequeue.processing_status, 'pending');

  // Second run: reprocess the pending record on the same Tuesday
  await f.run();
  const reprocessedRow = f.sql('SELECT * FROM special_imports WHERE id=?', failedRow.id)[0];
  assert.equal(reprocessedRow.processing_status, 'staged', 'reprocess succeeds');
  assert.equal(reprocessedRow.target_collection_id, 'mexican-night');
  assert.equal(reprocessedRow.validation_reason, 'mexican night evidence');
  assert.equal(callCount, 4);
});

// Test 11: End-to-end retry reaches reconcileMexicanNight() → section_source='facebook'
test('Successful Tuesday retry reaches reconcileMexicanNight and sets section_source=facebook', async t => {
  const f = tuesdayHarness(t, {caption: 'TONIGHT @ GRAYZN BUFFALO 5-10PM'});
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => {
    callCount++;
    if (callCount === 1) return {response: JSON.stringify(emptyOffersPoster())};
    return {response: JSON.stringify(validMexicanNight())};
  });
  await f.run();
  const row = f.imports()[0];
  assert.equal(row.validation_result, 'ok');
  assert.equal(row.target_collection_id, 'mexican-night');
  // reconcileMexicanNight should have written to the section
  const collection = f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0];
  assert.equal(collection.section_source, 'facebook', 'reconcileMexicanNight wrote facebook source');
  const groups = f.sql("SELECT * FROM special_groups WHERE collection_id='mexican-night'");
  assert.ok(groups.length > 0, 'Mexican Night groups written');
  const slots = f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night'");
  assert.ok(slots.some(s => s.content.includes('Burrito')), 'menu item persisted');
});

// Tuesday misclassification: the October 6, 2026 poster came back in the weekly-lunch
// shape with a malformed date_range. The targeted Mexican Night request gets one retry.
const malformedWeeklyLunch = () => ({
  type: 'weekly-lunch', poster_evidence: "TONIGHT @ GRAYZ'N BUFFALO 5-10PM!", date_range: '5-10PM',
  service_time: '5-10 PM', entries: [{day_of_week: 2, content: 'Mexican Night'}],
});
const validWeeklyLunch = () => ({
  type: 'weekly-lunch', poster_evidence: 'Weekly Lunch Specials', date_range: '1/7-1/11', service_time: '11 AM-1:30 PM',
  entries: [{day_of_week: 1, content: 'G Mac Salad & a Drink'}, {day_of_week: 2, content: 'Chicken Caesar Wrap & a Drink'}],
});
const schemaName = request => request?.response_format?.json_schema?.name ?? null;

test('Tuesday weekly-lunch misread with malformed date_range recovers through one Mexican Night retry', async t => {
  const f = tuesdayHarness(t, {caption: "Tonight at Grayz'n Buffalo from 5-10"});
  const requests = [];
  t.mock.method(f.env.AI, 'run', async (_model, request) => {
    requests.push(request);
    return {response: JSON.stringify(requests.length === 1 ? malformedWeeklyLunch() : validMexicanNight())};
  });
  await f.run();
  const row = f.imports()[0];
  assert.equal(requests.length, 2, 'exactly one retry');
  assert.equal(schemaName(requests[1]), 'mexican_night_extraction', 'retry uses the Mexican-Night-only request');
  assert.equal(row.processing_status, 'staged');
  assert.equal(row.validation_reason, 'mexican night evidence');
  assert.equal(row.target_collection_id, 'mexican-night');
  const retries = f.sql("SELECT detail FROM special_import_events WHERE import_id=? AND event_type='retry'", row.id);
  assert.equal(retries.length, 1);
  assert.match(retries[0].detail, /Mexican Night targeted retry/);
  assert.equal(f.sql("SELECT section_source FROM special_collections WHERE id='mexican-night'")[0].section_source, 'facebook');
});

test('Tuesday weekly-lunch misread fails closed when the targeted retry finds no Mexican Night heading', async t => {
  const f = tuesdayHarness(t);
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => {
    callCount++;
    return {response: JSON.stringify(callCount === 1 ? malformedWeeklyLunch() : {type: 'mexican-night', poster_evidence: '', groups: []})};
  });
  const before = f.sql("SELECT * FROM special_collections WHERE id='mexican-night'");
  await f.run();
  const row = f.imports()[0];
  assert.equal(callCount, 2);
  assert.equal(row.processing_status, 'failed');
  assert.equal(row.validation_result, 'rejected');
  assert.notEqual(row.target_collection_id, 'mexican-night', 'a weekly-lunch reading is never converted without Mexican Night evidence');
  assert.deepEqual(f.sql("SELECT * FROM special_collections WHERE id='mexican-night'"), before);
});

test('Non-Tuesday malformed weekly-lunch response gets no Mexican Night retry', async t => {
  const f = harness(t, {caption: 'Specials'});
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => { callCount++; return {response: JSON.stringify(malformedWeeklyLunch())}; });
  await f.run();
  const row = f.imports()[0];
  assert.equal(callCount, 1, 'no retry outside Tuesday');
  assert.equal(row.processing_status, 'failed');
  assert.equal(row.validation_reason, 'Malformed date_range: expected M/D-M/D format');
  assert.notEqual(row.target_collection_id, 'mexican-night');
});

test('Valid Tuesday weekly-lunch poster stays weekly lunch with no Mexican Night retry', async t => {
  const f = tuesdayHarness(t, {caption: 'Weekly Lunch Specials'});
  let callCount = 0;
  t.mock.method(f.env.AI, 'run', async () => { callCount++; return {response: JSON.stringify(validWeeklyLunch())}; });
  await f.run();
  const row = f.imports()[0];
  assert.equal(callCount, 1);
  assert.equal(row.processing_status, 'staged');
  assert.equal(row.validation_reason, 'weekly lunch evidence');
  assert.notEqual(row.target_collection_id, 'mexican-night');
});
