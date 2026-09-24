import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../../tests/specials-fixture.mjs';
import {automaticWeekRange,ensureAutomaticWeek} from './auto-week.js';
import {harness} from './test-fixture.js';
import {loadTs} from '../../tests/load-ts.mjs';
const store=loadTs('src/lib/specials-store.ts');

for(const [date,day,hour,start,end] of [
  ['2026-09-27',0,18,'2026-09-21','2026-09-27'],
  ['2026-09-27',0,19,'2026-09-28','2026-10-04'],
  ['2026-09-28',1,7,'2026-09-28','2026-10-04'],
  ['2026-12-27',0,19,'2026-12-28','2027-01-03'],
  ['2027-01-03',0,19,'2027-01-04','2027-01-10'],
  ['2026-03-08',0,19,'2026-03-09','2026-03-15'],
  ['2026-11-01',0,19,'2026-11-02','2026-11-08'],
]) test(`week range ${date} hour ${hour}`,()=>{
  assert.deepEqual(automaticWeekRange(date,day,hour),{start,end});
});
for(const [now,start] of [
  ['2030-01-14T00:59:59Z','2030-01-07'], // Sunday 6:59 CST
  ['2030-01-14T01:00:00Z','2030-01-14'], // Sunday 7 CST
  ['2030-01-14T01:30:00Z','2030-01-14'],
  ['2030-01-14T03:00:00Z','2030-01-14'], // Sunday 9 PM provisioning retry
  ['2030-01-14T15:00:00Z','2030-01-14'], // Monday fallback
  ['2030-01-16T15:00:00Z','2030-01-14'], // Wednesday fallback
]) test(`cron ensures ${start} at ${now}`,async t=>{
  const f=harness(t,{now,week:false});f.state.posts=[];await f.run();
  assert.equal(f.sql('SELECT * FROM weekly_specials WHERE week_start_date=?',start).length,1);
  if (start==='2030-01-07') assert.equal(f.sql("SELECT * FROM weekly_specials WHERE week_start_date='2030-01-14'").length,0);
});
test('atomic creation copies exact recurring structure; populated defaults lock and blanks become eligible',async t=>{
  const f=fixture(t);f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  f.sql("UPDATE special_slots SET content=NULL,price='',section_link='' WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id='defaults')");
  const id=f.sql("SELECT id FROM special_groups WHERE collection_id='defaults' ORDER BY id")[0].id;
  f.sql("UPDATE special_slots SET content='Owner recurring offer',price='$7.25' WHERE group_id=? AND position=1",id);
  await Promise.all(Array.from({length:3},()=>ensureAutomaticWeek(f.env,{today:'2030-01-14',weekday:1,hour:7})));
  const weeks=f.sql("SELECT * FROM weekly_specials WHERE week_start_date='2030-01-14'");assert.equal(weeks.length,1);
  const w=await store.readWeek(f.env,weeks[0].id);const defaults=await store.readCollection(f.env,'defaults');
  assert.equal(w.collection.groups.length,defaults.groups.length);
  for(const g of defaults.groups) {
    const copy=w.collection.groups.find(c=>c.id.endsWith(':'+g.id));
    for(const key of ['day_of_week','service','label','service_time','sort','enabled']) assert.equal(copy[key],g[key]);
    for(const s of g.slots) {
      const c=copy.slots.find(c=>c.position===s.position);
      assert.equal(c.content,s.content??'');assert.equal(c.price,s.price);assert.equal(c.section_link,s.section_link);
      assert.equal(c.manual_locked,s.content?1:0);assert.equal(c.origin,s.content?'manual':'legacy');assert.equal(c.last_auto_value,null);
    }
  }
});
test('overlapping week fails closed; existing exact week is never changed',async t=>{
  const f=fixture(t);f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(9876,'2030-01-15','2030-01-20')");
  const before=f.sql('SELECT * FROM weekly_specials');await ensureAutomaticWeek(f.env,{today:'2030-01-14',weekday:1,hour:7});assert.deepEqual(f.sql('SELECT * FROM weekly_specials'),before);
});
test('week transaction failure leaves no orphan week or partial template',async t=>{
  const f=fixture(t);f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';const batch=f.env.DB.batch;
  f.env.DB.batch=s=>batch([...s,{sql:'INSERT INTO missing_table VALUES(1)',args:[]}]);
  const before=f.sql('SELECT * FROM weekly_specials');await assert.rejects(()=>ensureAutomaticWeek(f.env,{today:'2030-01-14',weekday:1,hour:7}));assert.deepEqual(f.sql('SELECT * FROM weekly_specials'),before);
});
for(const mode of ['OFF','DRY_RUN']) test(`Sunday ${mode} never creates future week`,async t=>{
  const f=harness(t,{mode,now:'2030-01-14T01:00:00Z',week:false});f.state.posts=[];const before=f.sql('SELECT * FROM weekly_specials');await f.run();assert.deepEqual(f.sql('SELECT * FROM weekly_specials'),before);
});
test('admin current week selection is read-only and uses Chicago date; ambiguity returns no selection',async t=>{
  const f=fixture(t);f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(9000,'2030-01-07','2030-01-13')");
  const before=f.sql('SELECT * FROM weekly_specials');
  assert.equal(await store.currentSavedWeekId(f.env,new Date('2030-01-14T05:59:59Z')),9000);
  assert.equal(await store.currentSavedWeekId(f.env,new Date('2030-01-14T06:00:00Z')),null);
  assert.deepEqual(f.sql('SELECT * FROM weekly_specials'),before);
  f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(9001,'2030-01-08','2030-01-12')");
  assert.equal(await store.currentSavedWeekId(f.env,new Date('2030-01-09T15:00:00Z')),null);
});
