import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalizeSlotContent, reconcilePosters} from './reconcile.js';
import {harness, offer, poster} from './test-fixture.js';

// ── 1. Ordinary extracted specials with internal newlines are normalized ──────

test('ordinary lunch special: internal newlines collapsed to single space', () => {
  assert.equal(
    canonicalizeSlotContent('Grilled Chicken Salad\nwith French Fries and a Drink', 1, 'lunch'),
    'Grilled Chicken Salad with French Fries and a Drink'
  );
});

test('ordinary all-day special: tabs and multiple spaces collapsed', () => {
  assert.equal(
    canonicalizeSlotContent('Jalapeno Burger\tw/ Side Salad,  Chili or Coleslaw  $10.25', 2, 'all-day'),
    'Jalapeno Burger w/ Side Salad, Chili or Coleslaw $10.25'
  );
});

test('ordinary nightly special: leading/trailing whitespace trimmed', () => {
  assert.equal(
    canonicalizeSlotContent('  Steak with Potatoes $18.75  ', 4, 'nightly'),
    'Steak with Potatoes $18.75'
  );
});

test('ordinary nightly special with embedded newline is normalized to one line', () => {
  assert.equal(
    canonicalizeSlotContent('Half Rack Ribs\nwith Mac & Cheese & Coleslaw $18.75', 1, 'nightly'),
    'Half Rack Ribs with Mac & Cheese & Coleslaw $18.75'
  );
});

// ── 2. Wednesday Wing Night → canonical multiline ─────────────────────────────

test('Wednesday Wing Night raw AI extraction → canonical multiline', () => {
  assert.equal(
    canonicalizeSlotContent('Wing Night — Bone-In $.89 each / Boneless $.99 each', 3, 'nightly'),
    'Wing Night!\n$.89 Boneless Wings\n$.99 Bone In Wings\nAdd Fries'
  );
});

test('Wednesday Wing Night already-multiline input → canonical (idempotent)', () => {
  assert.equal(
    canonicalizeSlotContent('Wing Night\n$.89 Boneless Wings\n$.99 Bone In Wings', 3, 'nightly'),
    'Wing Night!\n$.89 Boneless Wings\n$.99 Bone In Wings\nAdd Fries'
  );
});

test('Wednesday Wing Night canonical stored in DB via reconcilePosters', async t => {
  const f = harness(t);
  await f.run();
  assert.equal(
    f.slots(3, 'nightly')[0].content,
    'Wing Night!\n$.89 Boneless Wings\n$.99 Bone In Wings\nAdd Fries'
  );
});

// ── 3. Thursday Pizza Night → canonical multiline ────────────────────────────

test('Thursday nightly pizza: raw extraction → canonical two-line format', () => {
  assert.equal(
    canonicalizeSlotContent('3-Topping Pizza 12" $13.50 / 16" $16', 4, 'nightly'),
    '12" 3-Topping Pizza $13.50\n16" 3-Topping Pizza $16'
  );
});

test('Thursday nightly pizza: space-separated extraction → canonical two-line format', () => {
  assert.equal(
    canonicalizeSlotContent('12" 3-Topping Pizza $13.50 or 16" 3-Topping Pizza $16', 4, 'nightly'),
    '12" 3-Topping Pizza $13.50\n16" 3-Topping Pizza $16'
  );
});

test('Thursday nightly pizza canonical stored via reconcilePosters', () => {
  const p = poster(4, 'Thursday Night Specials 5-10 PM', [
    offer('12 inch 3-Topping Pizza $13.50 and 16 inch 3-Topping Pizza $16', '5-10 PM'),
  ]);
  const result = reconcilePosters([p], 4);
  const nightly = result.find(g => g.service === 'nightly');
  assert.equal(nightly?.items[0].content, '12" 3-Topping Pizza $13.50\n16" 3-Topping Pizza $16');
});

// ── 4. Friday Stir Fry all-day → canonical multiline ─────────────────────────

test('Friday all-day stir fry: slash-separated extraction → canonical two-line format', () => {
  assert.equal(
    canonicalizeSlotContent('Chicken Stir Fry $12.99 / Steak Stir Fry $13.99', 5, 'all-day'),
    'Chicken Stir Fry $12.99\nSteak Stir Fry $13.99'
  );
});

test('Friday all-day stir fry: newline-separated extraction → canonical two-line format', () => {
  assert.equal(
    canonicalizeSlotContent('Chicken Stir Fry $12.99\nSteak Stir Fry $13.99', 5, 'all-day'),
    'Chicken Stir Fry $12.99\nSteak Stir Fry $13.99'
  );
});

test('Friday all-day stir fry canonical stored via reconcilePosters (3-offer daytime poster)', () => {
  // Friday daytime 3-offer pattern: offer[0]=lunch, offer[1]=all-day stir fry, offer[2]=all-day sandwich
  const p = poster(5, 'Friday Specials', [
    offer('Chicken Mashed Potato Bowl and a Drink $9.75'),
    offer('Chicken Stir Fry $12.99 / Steak Stir Fry $13.99'),
    offer('Chicken Salad Sandwich w/ Cup of Chili or Coleslaw $7.25'),
  ]);
  const result = reconcilePosters([p], 5);
  const allDay = result.find(g => g.service === 'all-day');
  assert.ok(allDay, 'all-day produced');
  assert.equal(allDay.items[0].content, 'Chicken Stir Fry $12.99\nSteak Stir Fry $13.99');
  assert.equal(allDay.items[1].content, 'Chicken Salad Sandwich w/ Cup of Chili or Coleslaw $7.25');
});

// ── 5. Other Friday specials stay single-line ─────────────────────────────────

test('Friday all-day Chicken Salad Sandwich is not a stir fry: stays single-line', () => {
  assert.equal(
    canonicalizeSlotContent('Chicken Salad Sandwich w/ Cup of Chili or Coleslaw $7.25', 5, 'all-day'),
    'Chicken Salad Sandwich w/ Cup of Chili or Coleslaw $7.25'
  );
});

test('Friday nightly offers without stir fry are collapsed, not canonicalized', () => {
  assert.equal(
    canonicalizeSlotContent('2 Burgers and 1 Order\nof Fries $14', 5, 'nightly'),
    '2 Burgers and 1 Order of Fries $14'
  );
});

test('canonicalizeSlotContent: stir fry on non-Friday day is only whitespace-collapsed', () => {
  // Stir Fry canonical only fires on Friday (weekday=5) all-day
  assert.equal(
    canonicalizeSlotContent('Chicken Stir Fry $12.99 / Steak Stir Fry $13.99', 3, 'all-day'),
    'Chicken Stir Fry $12.99 / Steak Stir Fry $13.99'
  );
});

// ── 6. Mexican Night path is untouched ───────────────────────────────────────

test('canonicalizeSlotContent: Mexican Night-style multiline item is only whitespace-collapsed, no canonical override', () => {
  // The Mexican Night collection never calls canonicalizeSlotContent; its items
  // go through composeMexicanItem and applyMexicanNight. Verifying that passing
  // such content directly to canonicalizeSlotContent does not trigger any
  // day-specific override (it only whitespace-normalizes).
  const raw = 'Burrito $9.00\nMeat and refried beans';
  // weekday=-1, service='custom' — Mexican Night slot attributes
  assert.equal(canonicalizeSlotContent(raw, -1, 'custom'), 'Burrito $9.00 Meat and refried beans');
  // No exception pattern fires; the function only collapses whitespace
});

test('canonicalizeSlotContent: Tuesday (Mexican Night day) nightly content is not pizza/wing/stirfry', () => {
  const raw = 'Tacos $8.00\nWith choice of meat';
  assert.equal(canonicalizeSlotContent(raw, 2, 'nightly'), 'Tacos $8.00 With choice of meat');
});

// ── 7. Manual-locked slots remain untouched by automation ────────────────────

test('manual-locked Wednesday nightly slot is protected from canonical Wing Night write', async t => {
  const f = harness(t);
  const nightGroup = f.sql("SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=3 AND service='nightly'")[0];
  f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=? WHERE group_id=? AND position=1',
    'Staff special wing night entry', 'manual', 1, nightGroup.id);
  await f.run();
  // manual_locked=1 + populated content → protected by safe() regardless of canonical override
  assert.equal(f.slots(3, 'nightly')[0].content, 'Staff special wing night entry');
  assert.equal(f.slots(3, 'nightly')[0].manual_locked, 1);
});

test('manual-locked Thursday nightly slot is protected from canonical Pizza Night write', async t => {
  const pizzaPoster = poster(4, 'Thursday Night Specials 5-10 PM', [
    offer('12 inch 3-Topping Pizza $13.50 and 16 inch pizza $16', '5-10 PM'),
  ]);
  const f = harness(t, {now: '2030-01-10T15:00:00Z', candidate: pizzaPoster});
  f.state.posts[0].created_time = '2030-01-10T14:00:00Z';
  const nightGroup = f.sql("SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=4 AND service='nightly'")[0];
  f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=? WHERE group_id=? AND position=1',
    'Thursday staff entry', 'manual', 1, nightGroup.id);
  await f.run();
  assert.equal(f.slots(4, 'nightly')[0].content, 'Thursday staff entry');
  assert.equal(f.slots(4, 'nightly')[0].manual_locked, 1);
});
