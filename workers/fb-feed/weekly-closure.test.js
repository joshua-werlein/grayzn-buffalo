import assert from 'node:assert/strict';
import test from 'node:test';
import {harness} from './test-fixture.js';

const START = '2026-11-23';
const CLOSED = 'Closed — Happy Thanksgiving';
const SERVICES = ['lunch','all-day','nightly'];

function setup(t, {text=CLOSED, heading='WEEKLY LUNCH SPECIALS 11/23-11/27 11–1:30 $9.75', row=`THURSDAY: ${text}`}={}) {
  const f = harness(t,{
    now:'2026-11-23T15:00:00Z', caption:'Weekly Lunch Specials',
    candidate:{type:'weekly-lunch',poster_evidence:heading,service_time:'11–1:30',entries:[
      {day_of_week:1,content:'GMAC SALAD & A DRINK',evidence:'MONDAY: GMAC SALAD & A DRINK',uncertainties:[]},
      {day_of_week:4,content:text,evidence:row,uncertainties:[]},
    ]},
  });
  f.env.SPECIALS_EVIDENCE_VERSION = '2';
  f.env.SPECIALS_VERIFICATION_STRATEGY = 'conditional';
  Object.assign(f.state.posts[0], {created_time:'2026-11-23T14:56:03Z',updated_time:'2026-11-23T14:56:03Z'});
  f.sql("UPDATE weekly_specials SET week_start_date=?,week_end_date='2026-11-29' WHERE id=9000", START);
  for (const service of SERVICES) {
    f.slots(4,service).slice(0,2).forEach(slot => {
      f.sql("UPDATE special_slots SET content='Recurring Meal',price='$7',origin='manual',last_auto_value=NULL WHERE group_id=? AND position=?",slot.group_id,slot.position);
    });
  }
  return f;
}

const contents = (f, service) => f.slots(4,service).map(s => s.content).filter(Boolean);

test('dated full closure replaces recurring food once in each service and keeps a shared lunch price off the closure', async t => {
  const f = setup(t);
  f.sql("UPDATE special_slots SET content='Recurring Ribs' WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id='defaults' AND day_of_week=4 AND service='nightly') AND position=1");
  await f.run();
  for (const service of SERVICES) {
    assert.deepEqual(contents(f,service), [CLOSED]);
    assert.ok(f.slots(4,service).every(s => !s.price && !s.section_link));
  }
  assert.match(f.slots(1,'lunch')[0].content, /Gmac Salad & a Drink.*\$9\.75/i);
  const revision = () => f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision;
  const before = revision();
  f.state.now += 30 * 60_000;
  await f.run();
  assert.equal(revision(),before);
  assert.equal(f.state.aiCalls,1);

  // The original staged post remains in D1 but is never applied to the new week.
  f.state.now = Date.parse('2026-11-30T15:00:00Z');
  f.state.posts = [];
  await f.run();
  const next = f.sql(`SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id
    JOIN special_collections c ON c.id=g.collection_id JOIN weekly_specials w ON w.id=c.weekly_special_id
    WHERE w.week_start_date='2026-11-30' AND g.day_of_week=4 AND g.service='nightly' AND s.position=1`);
  assert.deepEqual(next,[{content:'Recurring Ribs'}]);
});

test('the dated closure keeps newer staff corrections and respects disabled service groups', async t => {
  const f = setup(t);
  f.sql("UPDATE special_slots SET content='Staff correction',price='',manual_edited_at='2026-11-23T14:59:00Z',manual_locked=1 WHERE group_id=? AND position=1",f.slots(4,'nightly')[0].group_id);
  f.sql('UPDATE special_groups SET enabled=0 WHERE id=?', f.slots(4,'all-day')[0].group_id);
  await f.run();
  assert.deepEqual(contents(f,'lunch'), [CLOSED]);
  assert.deepEqual(contents(f,'all-day'), ['Recurring Meal','Recurring Meal']);
  assert.equal(f.slots(4,'nightly')[0].content,'Staff correction');
  assert.equal(f.slots(4,'nightly')[0].manual_locked,1);
});

for (const text of ['Kitchen closed', 'No lunch service', 'No delivery', 'Closing early', 'Bar open but kitchen closed', 'Happy Thanksgiving']) {
  test(`${text} does not close All Day or Nightly`, async t => {
    const f = setup(t,{text});
    await f.run();
    for (const service of ['all-day','nightly']) assert.deepEqual(contents(f,service),['Recurring Meal','Recurring Meal']);
  });
}

for (const [reason, options] of [
  ['no printed date range', {heading:'WEEKLY LUNCH SPECIALS 11–1:30'}],
  ['competing date ranges', {heading:'WEEKLY LUNCH SPECIALS 11/23-11/27 or 11/30-12/4'}],
  ['different date on the weekday row', {row:`THURSDAY 11/25: ${CLOSED}`}],
  ['weekday missing from source row', {row:CLOSED}],
  ['a qualified source row', {row:'THURSDAY: KITCHEN CLOSED — HAPPY THANKSGIVING'}],
]) {
  test(`${reason} holds the restaurant closure`, async t => {
    const f = setup(t,options);
    await f.run();
    for (const service of SERVICES) assert.deepEqual(contents(f,service),['Recurring Meal','Recurring Meal']);
  });
}

test('a Friday scan does not backfill a Thursday closure', async t => {
  const f = setup(t);
  f.state.now = Date.parse('2026-11-27T15:00:00Z');
  Object.assign(f.state.posts[0], {created_time:'2026-11-27T14:56:00Z',updated_time:'2026-11-27T14:56:00Z'});
  await f.run();
  for (const service of SERVICES) assert.deepEqual(contents(f,service),['Recurring Meal','Recurring Meal']);
});
