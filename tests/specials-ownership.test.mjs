import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
import {harness, offer, poster} from '../workers/fb-feed/test-fixture.js';
const s=loadTs('src/lib/specials-store.ts');
const dates={start:'2030-01-07',end:'2030-01-13'};
const recurring="Crispy Grayz'n Chicken Sandwich w/Side Salad, Chili or Coleslaw $10.25";
const facebook='GRILLED CHICKEN SANDWICH W/ SIDE SALAD OR COLESLAW $10.25';
const publishedFacebook='Grilled Chicken Sandwich w/ Side Salad Or Coleslaw $10.25';
const saturday=c=>c.groups.find(g=>g.day_of_week===6 && g.service==='all-day');
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
async function defaultsFor(f) {
  const defaults=await s.readCollection(f.env,'defaults');
  Object.assign(saturday(defaults).slots[0],{content:recurring,price:'',section_link:''});
  return defaults;
}

test('newWeekFromDefaults → saveCollection preserves every supplied default ownership state',async t=>{
  const f=fixture(t), week=s.newWeekFromDefaults(await defaultsFor(f));
  const saved=await s.saveCollection(f.env,week,dates);
  const actual=(await s.readWeek(f.env,saved.id)).collection;
  for(const group of week.groups) {
    const stored=actual.groups.find(g=>g.id===saved.groupIds[group.id]);
    assert.deepEqual(stored.slots.map(x=>[x.content,x.origin,x.manual_locked,x.last_auto_value]),
      group.slots.map(x=>[x.content,x.origin,0,null]));
  }
  assert.equal(saturday(actual).slots[0].origin,'manual');
});

test('Admin new-week POST retains defaults across fresh UUIDs, protects edits, and ignores forged ownership',async t=>{
  const f=fixture(t), defaults=await defaultsFor(f);
  const draft=s.newWeekFromDefaults(defaults), form=formFor(draft);
  const group=saturday(draft), index=draft.groups.indexOf(group);
  form.set(`g${index}_2_content`,'Staff special $12');
  form.set(`g${index}_2_origin`,'automation');form.set(`g${index}_2_manual_locked`,'0');
  const baseline=s.newWeekFromDefaults(defaults);
  assert.notEqual(saturday(baseline).id,group.id);
  const next=s.collectionFromForm(form,baseline);
  const saved=await s.saveCollection(f.env,next,dates);
  const slots=saturday((await s.readWeek(f.env,saved.id)).collection).slots;
  assert.deepEqual(slots.slice(0,2).map(x=>[x.content,x.origin,x.manual_locked]),
    [[recurring,'manual',0],['Staff special $12','manual',1]]);
  assert.ok(slots.slice(2).every(x=>x.content==='' && x.origin==='legacy' && x.manual_locked===0));
});

for(const staffEdited of [false,true]) test(`Saturday Worker ${staffEdited?'protects a staff correction':'replaces an Admin-created recurring default'}`,async t=>{
  const f=harness(t,{week:false,now:'2030-01-12T17:00:00Z',caption:'Saturday Specials',
    candidate:poster(6,'Saturday Specials',[offer('Lunch and Drink $9.75','Lunch','11-1:30'),offer(facebook),offer('Ham Sandwich $7.25')])});
  f.state.posts[0].created_time='2030-01-12T14:00:00Z';
  f.state.posts[0].updated_time='2030-01-12T14:00:00Z';
  const defaults=await defaultsFor(f), draft=s.newWeekFromDefaults(defaults), form=formFor(draft);
  if(staffEdited) form.set(`g${draft.groups.indexOf(saturday(draft))}_1_content`,'Staff correction $12');
  const saved=await s.saveCollection(f.env,s.collectionFromForm(form,s.newWeekFromDefaults(defaults)),dates);
  await f.run();
  const slots=saturday((await s.readWeek(f.env,saved.id)).collection).slots;
  assert.equal(f.state.aiCalls,1);
  assert.deepEqual([slots[0].content,slots[0].origin,slots[0].manual_locked,slots[0].last_auto_value],
    staffEdited ? ['Staff correction $12','manual',1,null] : [publishedFacebook,'automation',0,publishedFacebook]);
  assert.equal(slots[1].content,'Ham Sandwich $7.25');
});

for(const origin of ['automation','manual']) test(`existing ${origin} slot survives unrelated Admin save; staff edit locks it`,async t=>{
  const f=fixture(t), saved=await s.saveCollection(f.env,s.newWeekFromDefaults(await defaultsFor(f)),dates);
  let collection=(await s.readWeek(f.env,saved.id)).collection;
  const groupId=saturday(collection).id;
  const autoValue=origin==='automation' ? recurring : null;
  f.sql('UPDATE special_slots SET origin=?,manual_locked=0,last_auto_value=? WHERE group_id=? AND position=1',origin,autoValue,groupId);
  collection=(await s.readWeek(f.env,saved.id)).collection;
  const index=collection.groups.findIndex(g=>g.id===groupId);
  const before=f.sql('SELECT * FROM special_slots WHERE group_id=? AND position=1',groupId)[0];
  let form=formFor(collection);form.set(`g${index}_2_content`,'Unrelated edit $8');
  await s.saveCollection(f.env,s.collectionFromForm(form,collection),dates);
  assert.deepEqual(f.sql('SELECT * FROM special_slots WHERE group_id=? AND position=1',groupId)[0],before);
  collection=(await s.readWeek(f.env,saved.id)).collection;
  form=formFor(collection);form.set(`g${index}_1_content`,'Actual staff edit $11');
  await s.saveCollection(f.env,s.collectionFromForm(form,collection),dates);
  const after=f.sql('SELECT * FROM special_slots WHERE group_id=? AND position=1',groupId)[0];
  assert.deepEqual([after.content,after.origin,after.manual_locked,after.last_auto_value],['Actual staff edit $11','manual',1,autoValue]);
});
