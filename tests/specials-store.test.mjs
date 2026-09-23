import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
const s=loadTs('src/lib/specials-store.ts');
test('new weeks copy templates once; saved weeks and deliberate blanks never inherit later changes',async t=>{
  const f=fixture(t); const defaults=await s.readCollection(f.env,'defaults');
  const week=s.newWeekFromDefaults(defaults);
  const lunch=week.groups.find(g=>g.day_of_week===1 && g.service==='lunch');
  assert.equal(lunch.slots[0].content,'');
  const saved=await s.saveCollection(f.env,week,{start:'2030-01-07',end:'2030-01-13'});
  defaults.groups.find(g=>g.day_of_week===1 && g.service==='lunch').slots[0].content='New default';
  await s.saveCollection(f.env,defaults);
  const reread=await s.readWeek(f.env,saved.id);
  assert.equal(reread.collection.groups.find(g=>g.day_of_week===1 && g.service==='lunch').slots[0].content,'');
  assert.equal(f.sql('SELECT count(*) n FROM weekly_special_days')[0].n,42);
  await assert.rejects(()=>s.saveCollection(f.env,s.newWeekFromDefaults(defaults),{start:'2030-01-07',end:'2030-01-13'}),s.SpecialConflict);
  assert.equal(f.sql("SELECT count(*) n FROM weekly_specials WHERE week_start_date='2030-01-07'")[0].n,1);
});
test('manual changes and manual blanks lock only changed slots and preserve automatic baseline',async t=>{
  const f=fixture(t); const id=f.sql("SELECT id FROM special_collections WHERE kind='week' LIMIT 1")[0].id;
  const before=await s.readCollection(f.env,id); const g=before.groups.find(g=>g.service==='nightly' && g.day_of_week===1);
  f.sql("UPDATE special_slots SET content='Imported',origin='automation',manual_locked=0,last_auto_value='baseline' WHERE group_id=? AND position IN (1,2,3)",g.id);
  const next=await s.readCollection(f.env,id); const group=next.groups.find(x=>x.id===g.id);
  group.slots[0].content='Corrected'; group.slots[1].content='';
  const week=f.sql('SELECT * FROM weekly_specials WHERE id=?',next.weekly_special_id)[0];
  await s.saveCollection(f.env,next,{start:week.week_start_date,end:week.week_end_date});
  const slots=f.sql('SELECT * FROM special_slots WHERE group_id=? ORDER BY position',g.id);
  for(const slot of slots.slice(0,2)) { assert.equal(slot.origin,'manual'); assert.equal(slot.manual_locked,1); assert.equal(slot.last_auto_value,'baseline'); }
  assert.equal(slots[1].content,''); assert.equal(slots[2].origin,'automation'); assert.equal(slots[2].manual_locked,0);
});
test('stale saves and races between read and transactional batch cannot partially change data',async t=>{
  const f=fixture(t); const first=await s.readCollection(f.env,'defaults'); const second=structuredClone(first);
  first.groups[0].slots[0].content='First editor'; await s.saveCollection(f.env,first);
  second.groups[0].slots[0].content='Stale editor'; await assert.rejects(()=>s.saveCollection(f.env,second),s.SpecialConflict);
  const next=await s.readCollection(f.env,'defaults'); next.groups[0].slots[0].content='Race loser';
  const batch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{f.sql("UPDATE special_collections SET revision=revision+1 WHERE id='defaults'"); return batch(statements)};
  await assert.rejects(()=>s.saveCollection(f.env,next),s.SpecialConflict);
  assert.equal((await s.readCollection(f.env,'defaults')).groups[0].slots[0].content,'First editor');
});
test('failed statement rolls back revision and all prior writes in the batch',async t=>{
  const f=fixture(t);const next=await s.readCollection(f.env,'defaults');const revision=next.revision;
  const batch=f.env.DB.batch; f.env.DB.batch=statements=>batch([...statements,{sql:'INSERT INTO table_that_does_not_exist VALUES(1)',args:[]}]);
  next.groups[0].slots[0].content='Must roll back';await assert.rejects(()=>s.saveCollection(f.env,next));
  assert.equal((await s.readCollection(f.env,'defaults')).revision,revision);
});
test('Mexican menu editing is isolated from all saved weeks and defaults',async t=>{
  const f=fixture(t); const before=f.sql("SELECT * FROM special_slots ORDER BY group_id,position");
  const next=await s.readCollection(f.env,'mexican-night'); const group=s.blankGroup(-1); group.label='Staff supplied test group'; group.slots[0].content='Staff supplied test item'; next.groups=[group];
  const result=await s.saveCollection(f.env,next); assert.ok(result.groupIds[group.id]);
  assert.deepEqual(f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id<>'mexican-night' ORDER BY s.group_id,s.position"),before);
  assert.equal((await s.readCollection(f.env,'mexican-night')).groups[0].slots[0].content,'Staff supplied test item');
});
test('unchanged repeated saves do not bump revision or rewrite content',async t=>{
  const f=fixture(t);const defaults=await s.readCollection(f.env,'defaults');
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  const result=await s.saveCollection(f.env,defaults);
  assert.equal(result.revision,defaults.revision);
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
});
test('form parsing preserves untouched CRLF bytes and ignores client ownership fields',async t=>{
  const f=fixture(t);const original=await s.readCollection(f.env,'defaults');
  original.groups[0].slots[0].content='Line one\r\nLine two';
  const body=new FormData();body.set('group_count',String(original.groups.length));body.set('revision','0');
  original.groups.forEach((g,i)=>{
    for(const [key,value] of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time})) body.set(`g${i}_${key}`,String(value));
    if(g.enabled) body.set(`g${i}_enabled`,'on');
    g.slots.forEach(slot=>{
      body.set(`g${i}_${slot.position}_content`,(slot.content??'').replaceAll('\r\n','\n'));
      if(slot.content===null) body.set(`g${i}_${slot.position}_unavailable`,'on');
    });
  });
  body.set('origin','automation');body.set('manual_locked','0');
  const parsed=s.collectionFromForm(body,original);
  assert.equal(parsed.groups[0].slots[0].content,'Line one\r\nLine two');
  assert.equal(parsed.groups[0].slots[0].origin,'legacy');assert.equal(parsed.groups[0].slots[0].manual_locked,1);
});
