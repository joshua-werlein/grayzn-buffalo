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
    'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each'
  );
});

test('Wednesday Wing Night already-multiline input → canonical (idempotent)', () => {
  assert.equal(
    canonicalizeSlotContent('Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each', 3, 'nightly'),
    'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each'
  );
});

test('Wednesday Wing Night canonical stored in DB via reconcilePosters', async t => {
  const f = harness(t);
  await f.run();
  assert.equal(
    f.slots(3, 'nightly')[0].content,
    'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each'
  );
});

// ── 3. Thursday Pizza Night → canonical multiline ────────────────────────────

test('Thursday nightly pizza: raw extraction → canonical two-line format', () => {
  assert.equal(
    canonicalizeSlotContent('3-Topping Pizza 12" $13.50 / 16" $16', 4, 'nightly'),
    '3-Topping Pizza 12" $13.50\n16" $16'
  );
});

test('Thursday nightly pizza: space-separated extraction → canonical two-line format', () => {
  assert.equal(
    canonicalizeSlotContent('12" 3-Topping Pizza $13.50 or 16" 3-Topping Pizza $16', 4, 'nightly'),
    '12" 3-Topping Pizza $13.50\nor 16" 3-Topping Pizza $16'
  );
});

test('Thursday nightly pizza canonical stored via reconcilePosters', () => {
  const p = poster(4, 'Thursday Night Specials 5-10 PM', [
    offer('12 inch 3-Topping Pizza $13.50 and 16 inch 3-Topping Pizza $16', '5-10 PM'),
  ]);
  const result = reconcilePosters([p], 4);
  const nightly = result.find(g => g.service === 'nightly');
  assert.equal(nightly?.items[0].content, '12 inch 3-Topping Pizza $13.50\nand 16 inch 3-Topping Pizza $16');
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

test('complete grouped prices format consistently regardless of weekday', () => {
  assert.equal(
    canonicalizeSlotContent('Chicken Stir Fry $12.99 / Steak Stir Fry $13.99', 3, 'all-day'),
    'Chicken Stir Fry $12.99\nSteak Stir Fry $13.99'
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

// ── 8. ALL CAPS normalization ─────────────────────────────────────────────────

// Required weekly-lunch regression cases (this week's uppercase Facebook poster)
test('ALL CAPS: CHICKEN STRIPS W/ FRENCH FRIES & DRINK — $9.75 → title case, W/ lowercase, price preserved', () => {
  assert.equal(
    canonicalizeSlotContent('CHICKEN STRIPS W/ FRENCH FRIES & DRINK — $9.75', 1, 'lunch'),
    'Chicken Strips w/ French Fries & Drink — $9.75'
  );
});

test('ALL CAPS: MAC N CHEESE BURGER W/ SWEET POTATO FRIES → title case, W/ lowercase', () => {
  assert.equal(
    canonicalizeSlotContent('MAC N CHEESE BURGER W/ SWEET POTATO FRIES', 3, 'lunch'),
    'Mac N Cheese Burger w/ Sweet Potato Fries'
  );
});

test('ALL CAPS: HOAGIE BURGER W/ BEER FRIES → title case, W/ lowercase', () => {
  assert.equal(
    canonicalizeSlotContent('HOAGIE BURGER W/ BEER FRIES', 2, 'lunch'),
    'Hoagie Burger w/ Beer Fries'
  );
});

test('ALL CAPS: BEEF STEW W/ BISCUITS → title case, W/ lowercase', () => {
  assert.equal(
    canonicalizeSlotContent('BEEF STEW W/ BISCUITS', 4, 'lunch'),
    'Beef Stew w/ Biscuits'
  );
});

test('ALL CAPS: FISH SANDWICH W/ FRENCH FRIES → title case, W/ lowercase', () => {
  assert.equal(
    canonicalizeSlotContent('FISH SANDWICH W/ FRENCH FRIES', 5, 'lunch'),
    'Fish Sandwich w/ French Fries'
  );
});

// Normal words that look like consonant-clusters must NOT stay upper-case
test('ALL CAPS: FRY is a normal word and title-cases to Fry (FISH FRY W/ FF)', () => {
  assert.equal(
    canonicalizeSlotContent('FISH FRY W/ FF', 1, 'lunch'),
    'Fish Fry w/ FF'
  );
});

test('ALL CAPS: DRY is a normal word and title-cases to Dry (DRY RUB RIBS)', () => {
  assert.equal(
    canonicalizeSlotContent('DRY RUB RIBS', 2, 'all-day'),
    'Dry Rub Ribs'
  );
});

// Unicode letter handling — accented characters must not produce malformed output
test('ALL CAPS: JALAPEÑO BURGER W/ FRIES → Jalapeño Burger w/ Fries', () => {
  assert.equal(
    canonicalizeSlotContent('JALAPEÑO BURGER W/ FRIES', 2, 'all-day'),
    'Jalapeño Burger w/ Fries'
  );
});

// Already normally capitalized content must not be damaged
test('already title-cased content is not modified', () => {
  assert.equal(
    canonicalizeSlotContent('Chicken Strips w/ French Fries & Drink $9.75', 1, 'lunch'),
    'Chicken Strips w/ French Fries & Drink $9.75'
  );
});

test('mixed-case content (not all-caps) passes through whitespace-collapsing only', () => {
  assert.equal(
    canonicalizeSlotContent('Grilled Chicken Caesar Wrap  w/ Waffle Fries', 2, 'lunch'),
    'Grilled Chicken Caesar Wrap w/ Waffle Fries'
  );
});

// Price and punctuation preservation
test('ALL CAPS with $10.25 price preserved exactly', () => {
  assert.equal(
    canonicalizeSlotContent('JALAPENO BURGER W/ SIDE SALAD $10.25', 2, 'all-day'),
    'Jalapeno Burger w/ Side Salad $10.25'
  );
});

test('ALL CAPS with $.89 price preserved exactly', () => {
  assert.equal(
    canonicalizeSlotContent('WING SPECIAL $.89 EACH', 1, 'all-day'),
    'Wing Special $.89 Each'
  );
});

test('ALL CAPS em-dash and & preserved exactly', () => {
  assert.equal(
    canonicalizeSlotContent('CHICKEN STRIPS & DRINK — $9.75', 1, 'lunch'),
    'Chicken Strips & Drink — $9.75'
  );
});

// Explicit allowlist abbreviations (BLT, BBQ, FF) stay ALL-CAPS
test('ALL CAPS: BLT stays BLT (explicit allowlist)', () => {
  assert.equal(
    canonicalizeSlotContent('BLT SANDWICH W/ FRIES', 2, 'lunch'),
    'BLT Sandwich w/ Fries'
  );
});

test('ALL CAPS: BBQ stays BBQ (explicit allowlist)', () => {
  assert.equal(
    canonicalizeSlotContent('BBQ PULLED PORK SANDWICH', 3, 'all-day'),
    'BBQ Pulled Pork Sandwich'
  );
});

test('ALL CAPS: FF stays FF (explicit allowlist)', () => {
  assert.equal(
    canonicalizeSlotContent('FISH SANDWICH W/ FF & DRINK', 5, 'lunch'),
    'Fish Sandwich w/ FF & Drink'
  );
});

// Existing multiline canonicals are not damaged by the new path
test('Wing Night ALL CAPS with missing prices stays unresolved', () => {
  assert.equal(
    canonicalizeSlotContent('WING NIGHT $.89 BONELESS', 3, 'nightly'),
    null
  );
});

test('single Pizza ALL CAPS retains only the printed description and price', () => {
  assert.equal(
    canonicalizeSlotContent('3-TOPPING PIZZA $13.50', 4, 'nightly'),
    '3-Topping Pizza $13.50'
  );
});

test('Stir Fry ALL CAPS preserves labelled prices in readable multiline form', () => {
  assert.equal(
    canonicalizeSlotContent('CHICKEN STIR FRY $12.99 / STEAK STIR FRY $13.99', 5, 'all-day'),
    'Chicken Stir Fry $12.99\nSteak Stir Fry $13.99'
  );
});
