import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWeeklyLunch} from './reconcile.js';
import {harness} from './test-fixture.js';
import {reconcileWeeklyLunch} from './guarded-auto.js';

const WEEK_START = '2030-01-07'; // Monday
const WEEK_END   = '2030-01-13'; // Sunday (the harness week)
const entries = [
  {day_of_week:1, content:'G Mac Salad & a Drink'},
  {day_of_week:2, content:'Crispy Chicken Caesar Wrap w/ French Fries & a Drink'},
  {day_of_week:3, content:'Mac n Cheese Burger w/ Beer Fries & a Drink'},
  {day_of_week:4, content:'Sausage Biscuits and Gravy & a Drink'},
  {day_of_week:5, content:'Fish Sandwich w/ FF & a Drink'},
];
const weeklyLunchCandidate = (dateRange='1/7-1/11') => ({
  type:'weekly-lunch', poster_evidence:'Weekly Lunch Specials',
  date_range:dateRange, service_time:'11 AM-1:30 PM', entries:[...entries],
});

// ── validateWeeklyLunch unit tests ────────────────────────────────────────────

test('validateWeeklyLunch accepts complete valid Monday-Friday poster', () => {
  const result = validateWeeklyLunch(weeklyLunchCandidate());
  assert.equal(result.type, 'weekly-lunch');
  assert.equal(result.poster_evidence, 'Weekly Lunch Specials');
  assert.equal(result.date_range, '1/7-1/11');
  assert.equal(result.service_time, '11 AM-1:30 PM');
  assert.equal(result.entries.length, 5);
  assert.deepEqual(result.entries, entries);
});

test('validateWeeklyLunch rejects duplicate weekday entries', () => {
  const candidate = weeklyLunchCandidate();
  candidate.entries = [{day_of_week:1, content:'Monday item'}, {day_of_week:1, content:'Another Monday item'}];
  assert.throws(() => validateWeeklyLunch(candidate), err => /duplicate/i.test(err.message));
});

test('validateWeeklyLunch rejects weekend day 0', () => {
  const candidate = weeklyLunchCandidate();
  candidate.entries = [{day_of_week:0, content:'Sunday special'}];
  assert.throws(() => validateWeeklyLunch(candidate), err => /weekday/i.test(err.message));
});

test('validateWeeklyLunch rejects weekend day 6', () => {
  const candidate = weeklyLunchCandidate();
  candidate.entries = [{day_of_week:6, content:'Saturday special'}];
  assert.throws(() => validateWeeklyLunch(candidate), err => /weekday/i.test(err.message));
});

test('validateWeeklyLunch rejects empty entries array', () => {
  const candidate = weeklyLunchCandidate();
  candidate.entries = [];
  assert.throws(() => validateWeeklyLunch(candidate), err => /1-5/i.test(err.message));
});

test('validateWeeklyLunch rejects malformed date_range bad-format', () => {
  const candidate = weeklyLunchCandidate('bad-format');
  assert.throws(() => validateWeeklyLunch(candidate), err => /alformed/i.test(err.message));
});

test('validateWeeklyLunch rejects content over 150 chars', () => {
  const candidate = weeklyLunchCandidate();
  candidate.entries = [{day_of_week:1, content:'A'.repeat(151)}];
  assert.throws(() => validateWeeklyLunch(candidate), err => /content/i.test(err.message));
});

test('validateWeeklyLunch rejects empty/whitespace content', () => {
  const candidate = weeklyLunchCandidate();
  candidate.entries = [{day_of_week:1, content:'   '}];
  assert.throws(() => validateWeeklyLunch(candidate), err => /content/i.test(err.message));
});

test('validateWeeklyLunch accepts partial (1-4 day) poster', () => {
  const candidate = weeklyLunchCandidate();
  candidate.entries = entries.slice(0, 3);
  const result = validateWeeklyLunch(candidate);
  assert.equal(result.entries.length, 3);
});

test('validateWeeklyLunch accepts poster without date_range (null)', () => {
  const candidate = weeklyLunchCandidate();
  candidate.date_range = null;
  const result = validateWeeklyLunch(candidate);
  assert.equal(result.date_range, null);
});

// ── Integration tests ─────────────────────────────────────────────────────────

test('Mon-Fri weekly lunch poster populates all five Lunch slots', async t => {
  const f = harness(t, {now:'2030-01-07T15:00:00Z', caption:'Weekly Lunch Specials', candidate:weeklyLunchCandidate('1/7-1/11')});
  f.state.posts[0].created_time = '2030-01-07T14:00:00Z';
  await f.run();
  for (const entry of entries) {
    assert.equal(f.slots(entry.day_of_week, 'lunch')[0].content, entry.content);
  }
  [1,2,3,4,5].forEach(d => {
    assert.ok(f.slots(d, 'all-day').every(s => s.content === ''), `all-day day ${d} should be empty`);
    assert.ok(f.slots(d, 'nightly').every(s => s.content === ''), `nightly day ${d} should be empty`);
  });
});

test('weekly lunch: no printed price means no invented price', async t => {
  const candidate = weeklyLunchCandidate('1/7-1/11');
  candidate.entries = [{day_of_week:1, content:'G Mac Salad & a Drink'}];
  const f = harness(t, {now:'2030-01-07T15:00:00Z', caption:'Weekly Lunch Specials', candidate});
  f.state.posts[0].created_time = '2030-01-07T14:00:00Z';
  await f.run();
  assert.equal(f.slots(1, 'lunch')[0].content, 'G Mac Salad & a Drink');
});

test('explicit date range selects the correct saved week, not a different week', async t => {
  const f = harness(t, {now:'2030-01-07T15:00:00Z', caption:'Weekly Lunch Specials', candidate:weeklyLunchCandidate('1/7-1/11')});
  f.state.posts[0].created_time = '2030-01-07T14:00:00Z';
  // Create a second week (next week)
  f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(9001,'2030-01-14','2030-01-20')");
  f.sql("INSERT INTO special_collections(id,kind,weekly_special_id) VALUES('next-week','week',9001)");
  f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) SELECT 'nw-'||id,'next-week',day_of_week,service,label,service_time,sort,enabled FROM special_groups WHERE collection_id='defaults'");
  f.sql("INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value) SELECT g.id,p.position,'','','','legacy',0,null FROM special_groups g JOIN special_slots p ON p.group_id=replace(g.id,'nw-','') WHERE g.collection_id='next-week'");
  await f.run();
  // auto-week (1/7) should have lunch populated
  assert.equal(f.slots(1, 'lunch')[0].content, entries[0].content);
  // next-week should remain empty
  const nwLunch = f.sql('SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=? AND g.day_of_week=1 AND g.service=? ORDER BY position', 'next-week', 'lunch');
  assert.ok(nwLunch.every(s => s.content === ''), 'next-week lunch slots should remain empty');
});

test('weekly lunch does not touch All Day or Nightly slots', async t => {
  const f = harness(t, {now:'2030-01-07T15:00:00Z', caption:'Weekly Lunch Specials', candidate:weeklyLunchCandidate('1/7-1/11')});
  f.state.posts[0].created_time = '2030-01-07T14:00:00Z';
  await f.run();
  [1,2,3,4,5].forEach(d => {
    assert.ok(f.slots(d, 'all-day').every(s => s.content === ''), `all-day day ${d} should be empty`);
    assert.ok(f.slots(d, 'nightly').every(s => s.content === ''), `nightly day ${d} should be empty`);
  });
});

test('staff/manual Monday Lunch is preserved; safe Tue-Fri Lunch slots populate', async t => {
  const f = harness(t, {now:'2030-01-07T15:00:00Z', caption:'Weekly Lunch Specials', candidate:weeklyLunchCandidate('1/7-1/11')});
  f.state.posts[0].created_time = '2030-01-07T14:00:00Z';
  const mondayLunchGroupId = f.slots(1, 'lunch')[0].group_id;
  // Lock Monday lunch as manual
  f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=? WHERE group_id=? AND position=1',
    'Staff Monday Special', 'manual', 1, mondayLunchGroupId);
  await f.run();
  // Monday stays unchanged
  assert.equal(f.slots(1, 'lunch')[0].content, 'Staff Monday Special');
  // Tue-Fri should be populated
  for (const entry of entries.slice(1)) {
    assert.equal(f.slots(entry.day_of_week, 'lunch')[0].content, entry.content);
  }
});

test('later day-specific poster can update automation-owned weekly Lunch value', async t => {
  // First run: weekly lunch pipeline writes Monday Lunch
  const f = harness(t, {now:'2030-01-07T15:00:00Z', caption:'Weekly Lunch Specials', candidate:weeklyLunchCandidate('1/7-1/11')});
  f.state.posts[0].created_time = '2030-01-07T14:00:00Z';
  await f.run();
  assert.equal(f.slots(1, 'lunch')[0].content, 'G Mac Salad & a Drink');
  assert.equal(f.slots(1, 'lunch')[0].origin, 'automation');
  // Second run: daily Monday poster with updated content
  f.state.now = Date.parse('2030-01-07T20:00:00Z');
  const {poster, offer} = await import('./test-fixture.js');
  const dailyMonday = poster(1, 'Monday Specials', [
    offer('G Mac Salad & a Drink - $8.50', '11-1:30'),
    offer('Burger w/ Fries $10'),
    offer('Chicken Wrap $9'),
  ]);
  f.state.posts = [{...f.state.posts[0], id:'p2', created_time:'2030-01-07T14:00:00Z', updated_time:'2030-01-07T19:00:00Z', full_picture:'https://cdn.example/photo2.jpg'}];
  f.state.candidate = dailyMonday;
  await f.run();
  assert.equal(f.slots(1, 'lunch')[0].content, 'G Mac Salad & a Drink - $8.50');
});

test('later day-specific poster cannot overwrite a staff Monday Lunch correction', async t => {
  // First run: weekly lunch pipeline writes Monday Lunch via automation
  const f = harness(t, {now:'2030-01-07T15:00:00Z', caption:'Weekly Lunch Specials', candidate:weeklyLunchCandidate('1/7-1/11')});
  f.state.posts[0].created_time = '2030-01-07T14:00:00Z';
  await f.run();
  const mondayLunchGroupId = f.slots(1, 'lunch')[0].group_id;
  // Staff corrects Monday Lunch manually
  f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=?,last_auto_value=? WHERE group_id=? AND position=1',
    'Staff Lunch', 'manual', 1, 'G Mac Salad & a Drink', mondayLunchGroupId);
  // Second run: daily Monday poster tries to update
  f.state.now = Date.parse('2030-01-07T20:00:00Z');
  const {poster, offer} = await import('./test-fixture.js');
  const dailyMonday = poster(1, 'Monday Specials', [
    offer('G Mac Salad & a Drink - $8.50', '11-1:30'),
    offer('Burger w/ Fries $10'),
    offer('Chicken Wrap $9'),
  ]);
  f.state.posts = [{...f.state.posts[0], id:'p2', created_time:'2030-01-07T14:00:00Z', updated_time:'2030-01-07T19:00:00Z', full_picture:'https://cdn.example/photo2.jpg'}];
  f.state.candidate = dailyMonday;
  await f.run();
  // Monday Lunch should remain the staff correction
  assert.equal(f.slots(1, 'lunch')[0].content, 'Staff Lunch');
});

test('duplicate weekday in extracted weekly lunch evidence fails closed', async t => {
  const candidate = weeklyLunchCandidate('1/7-1/11');
  candidate.entries = [...entries, {day_of_week:1, content:'Duplicate Monday'}];
  const f = harness(t, {now:'2030-01-07T15:00:00Z', caption:'Weekly Lunch Specials', candidate});
  f.state.posts[0].created_time = '2030-01-07T14:00:00Z';
  await f.run();
  // Validation should fail; no slots written
  [1,2,3,4,5].forEach(d => {
    assert.ok(f.slots(d, 'lunch').every(s => s.content === ''), `lunch day ${d} should remain empty`);
  });
  const imports = f.sql('SELECT * FROM special_imports');
  assert.equal(imports[0].validation_result, 'rejected');
});

test('weekly lunch with no matching week fails closed', async t => {
  const candidate = weeklyLunchCandidate('9/1-9/5');
  const f = harness(t, {now:'2030-01-07T15:00:00Z', caption:'Weekly Lunch Specials', candidate});
  f.state.posts[0].created_time = '2030-01-07T14:00:00Z';
  await f.run();
  // Evidence stored but no week found; no slots written
  [1,2,3,4,5].forEach(d => {
    assert.ok(f.slots(d, 'lunch').every(s => s.content === ''), `lunch day ${d} should remain empty`);
  });
});

test('Sunday-posted weekly lunch poster populates once the upcoming week is created', async t => {
  // Start with no week (Sunday before the target week)
  const f = harness(t, {week:false, now:'2030-01-06T20:00:00Z', caption:'Weekly Lunch Specials', candidate:weeklyLunchCandidate('1/7-1/11')});
  f.state.posts[0].created_time = '2030-01-06T20:00:00Z';
  await f.run();
  // Evidence stored but no matching week yet
  const imports = f.sql('SELECT * FROM special_imports');
  assert.equal(imports.length, 1, 'evidence should be stored');
  assert.equal(imports[0].validation_result, 'ok', 'evidence should be valid');
  // Still no slots written (no week exists)
  // Now create the upcoming week
  f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(9001,'2030-01-07','2030-01-13')");
  f.sql("INSERT INTO special_collections(id,kind,weekly_special_id) VALUES('next-week','week',9001)");
  f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) SELECT 'nw-'||id,'next-week',day_of_week,service,label,service_time,sort,enabled FROM special_groups WHERE collection_id='defaults'");
  f.sql("INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value) SELECT g.id,p.position,'','','','legacy',0,null FROM special_groups g JOIN special_slots p ON p.group_id=replace(g.id,'nw-','') WHERE g.collection_id='next-week'");
  // Advance time to Monday morning (within processing hours), no new Graph posts
  f.state.now = Date.parse('2030-01-07T15:00:00Z');
  f.state.posts = [];
  await f.run();
  // Now reconcileWeeklyLunch should find the stored evidence and write to next-week
  const nwSlots = (day, service) => f.sql(
    'SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=? AND g.day_of_week=? AND g.service=? ORDER BY position',
    'next-week', day, service
  );
  for (const entry of entries) {
    assert.equal(nwSlots(entry.day_of_week, 'lunch')[0].content, entry.content,
      `next-week lunch day ${entry.day_of_week} should be populated`);
  }
});
