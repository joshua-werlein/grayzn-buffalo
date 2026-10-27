// Saving one corrected special through the editor locks only that slot.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadTs} from './load-ts.mjs';
import {harness} from '../workers/fb-feed/test-fixture.js';
const s=loadTs('src/lib/specials-store.ts');
const records=JSON.parse(readFileSync('tests/fixtures/oct26-monday-night.json','utf8'));
const dates={start:'2026-10-26',end:'2026-11-01'};

// The editor posts every visible field of the week, edited or not.
function formFor(collection) {
  const form=new FormData();
  form.set('group_count',String(collection.groups.length));
  form.set('revision',String(collection.revision));
  collection.groups.forEach((g,i)=>{
    for(const [key,value] of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time})) form.set(`g${i}_${key}`,String(value));
    if(g.enabled) form.set(`g${i}_enabled`,'on');
    for(const slot of g.slots) if(slot.position<=s.specialInputCount(g)) form.set(`g${i}_${slot.position}_content`,s.displayedSpecial(slot).replace(/\r\n?/g,'\n'));
  });
  return form;
}
const allSlots=f=>f.sql('SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=? ORDER BY s.group_id,s.position','auto-week');

test('correcting one Monday Nightly special locks only that slot and survives the next import',async t=>{
  const f=harness(t,{now:'2026-10-26T15:00:00Z',caption:'Monday Specials',candidate:structuredClone(records.morning)});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  Object.assign(f.state.posts[0],{created_time:'2026-10-26T14:00:00Z',updated_time:'2026-10-26T14:00:00Z'});
  const nightly=f.slots(1,'nightly');
  ['2 Burgers and 1 Order of Fries','Half Rack Ribs w/ Mac n Cheese & Coleslaw'].forEach((content,i)=>
    f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=0,last_auto_value=NULL WHERE group_id=? AND position=?",content,nightly[i].group_id,i+1));
  // A Tuesday automation value elsewhere in the same week.
  f.sql("UPDATE special_slots SET content='Tuesday Burger $11',origin='automation',manual_locked=0,last_auto_value='Tuesday Burger $11' WHERE group_id=? AND position=1",f.slots(2,'all-day')[0].group_id);
  await f.run(); // morning post: Lunch and the All Day pair, by automation

  const before=allSlots(f);
  const week=await s.readWeek(f.env,9000);
  const form=formFor(week.collection);
  const index=week.collection.groups.findIndex(g=>g.day_of_week===1 && g.service==='nightly');
  form.set(`g${index}_1_content`,'2 Burgers and 1 Order of Fries $14');
  await s.saveCollection(f.env,s.collectionFromForm(form,week.collection),dates);

  const after=allSlots(f);
  const edited=after.find(x=>x.group_id===nightly[0].group_id && x.position===1);
  assert.deepEqual([edited.content,edited.origin,edited.manual_locked],['2 Burgers and 1 Order of Fries $14','manual',1]);
  // Every other slot in the week, including the other Nightly default, Lunch,
  // the automation-owned All Day pair, soup and other days, is unchanged.
  const others=rows=>rows.filter(x=>!(x.group_id===nightly[0].group_id && x.position===1));
  assert.deepEqual(others(after),others(before));
  assert.equal(after.filter(x=>x.manual_locked===1).length,before.filter(x=>x.manual_locked===1).length+1);

  // The Monday Night import cannot overwrite the correction; the unlocked
  // Nightly default beside it still receives its printed price.
  f.state.now=Date.parse('2026-10-26T21:30:00Z');
  f.state.posts.unshift({...f.state.posts[0],id:'night',message:'Monday Night Specials',created_time:'2026-10-26T21:22:00Z',updated_time:'2026-10-26T21:22:00Z'});
  f.state.candidate=structuredClone(records.night);
  await f.run();
  assert.deepEqual(f.slots(1,'nightly').slice(0,2).map(x=>[x.content,x.origin,x.manual_locked]),
    [['2 Burgers and 1 Order of Fries $14','manual',1],['Half Rack Ribs w/ Mac n Cheese & Coleslaw — $18.75','automation',0]]);
  assert.equal(f.slots(2,'all-day')[0].manual_locked,0);
});
