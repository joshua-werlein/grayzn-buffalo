import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../../tests/specials-fixture.mjs';
import {loadTs} from '../../tests/load-ts.mjs';
import {withSoupControls,isSoupGroup,soupGroupId} from '../../src/lib/daily-soup.js';
import {ensureAutomaticWeek} from './auto-week.js';
import {harness,offer,poster} from './test-fixture.js';
const s=loadTs('src/lib/specials-store.ts');
const dates={start:'2030-01-07',end:'2030-01-13'};
const soup=(c,day)=>c.groups.find(g=>g.id===soupGroupId(c.id,day));
function formFor(c) {
  const form=new FormData();form.set('revision',String(c.revision));form.set('group_count',String(c.groups.length));
  c.groups.forEach((g,i)=>{
    for(const [key,value]of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time}))form.set(`g${i}_${key}`,String(value));
    if(isSoupGroup(g)){if(c.kind==='week'&&!g.enabled)form.set(`g${i}_hide`,'on');}else if(g.enabled)form.set(`g${i}_enabled`,'on');
    g.slots.forEach(slot=>form.set(`g${i}_${slot.position}_content`,s.displayedSpecial(slot)));
  });return form;
}
async function setDefaults(f,values={3:'Tomato Basil',4:'French Onion'}) {
  const baseline=withSoupControls(await s.readCollection(f.env,'defaults')),form=formFor(baseline);
  for(const [day,content]of Object.entries(values))form.set(`g${baseline.groups.indexOf(soup(baseline,Number(day)))}_1_content`,content);
  await s.saveCollection(f.env,s.collectionFromForm(form,baseline));
  return s.readCollection(f.env,'defaults');
}
test('old defaults are read-only compatible; optional Soup saves and reloads per weekday, clears without disabling, stale saves fail',async t=>{
  const f=fixture(t),old=await s.readCollection(f.env,'defaults');
  assert.ok(!old.groups.some(isSoupGroup));
  const before=f.sql('SELECT * FROM special_groups');
  const controls=withSoupControls(old);assert.equal(controls.groups.filter(isSoupGroup).length,7);
  assert.ok(controls.groups.filter(isSoupGroup).every(g=>g.slots.every(slot=>slot.content==='')));
  assert.deepEqual(f.sql('SELECT * FROM special_groups'),before);
  const defaults=await setDefaults(f);
  assert.equal(soup(defaults,3).slots[0].content,'Tomato Basil');assert.equal(soup(defaults,4).slots[0].content,'French Onion');
  assert.equal(soup(defaults,1).slots[0].content,null);
  assert.deepEqual(defaults.groups.filter(g=>!isSoupGroup(g)),old.groups);
  assert.equal(withSoupControls(defaults).groups.length,defaults.groups.length);
  const cleared=await setDefaults(f,{3:''});assert.equal(soup(cleared,3).slots[0].content,null);assert.equal(soup(cleared,3).enabled,1);
  await assert.rejects(()=>s.saveCollection(f.env,defaults),s.SpecialConflict);
});
for(const automatic of [false,true]) test(`${automatic?'automatic':'admin'} week copies only latest weekday defaults, retains unlocked ownership, never rewrites saved weeks`,async t=>{
  const f=fixture(t);f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';const defaults=await setDefaults(f);
  async function create(start,end){
    if(automatic){await ensureAutomaticWeek(f.env,{today:start,weekday:1,hour:7});return s.readWeek(f.env,f.sql('SELECT id FROM weekly_specials WHERE week_start_date=?',start)[0].id);}
    const draft=withSoupControls(s.newWeekFromDefaults(await s.readCollection(f.env,'defaults')));
    const parsed=s.collectionFromForm(formFor(draft),withSoupControls(s.newWeekFromDefaults(await s.readCollection(f.env,'defaults'))));
    const result=await s.saveCollection(f.env,parsed,{start,end});return s.readWeek(f.env,result.id);
  }
  let week=await create(dates.start,dates.end);
  for(const day of [3,4]){
    const slot=soup(week.collection,day).slots[0];assert.equal(slot.content,soup(defaults,day).slots[0].content);
    assert.equal(slot.origin,'manual');assert.equal(slot.manual_locked,0);assert.equal(slot.last_auto_value,null);
  }
  assert.ok(soup(week.collection,1).slots.every(slot=>!slot.content));
  const snapshot=structuredClone(week);
  await setDefaults(f,{3:'Chili',4:''});assert.deepEqual(await s.readWeek(f.env,week.id),snapshot);
  const staff=structuredClone(week.collection);soup(staff,1).slots[0].content='Previous week only';await s.saveCollection(f.env,staff,dates);
  const next=await create('2030-01-14','2030-01-20');
  assert.equal(soup(next.collection,3).slots[0].content,'Chili');assert.equal(soup(next.collection,4).slots[0].content,'');assert.equal(soup(next.collection,1).slots[0].content,'');
  if(automatic)assert.deepEqual(await create('2030-01-14','2030-01-20'),next);
  else {const result=await s.saveCollection(f.env,next.collection,{start:'2030-01-14',end:'2030-01-20'});assert.equal(result.revision,next.collection.revision);}
  assert.equal(next.collection.groups.filter(isSoupGroup).length,7);
  assert.equal(new Set(next.collection.groups.filter(isSoupGroup).map(g=>g.day_of_week)).size,7);
});
for(const action of ['untouched','omission','manual','hide','clear'])test(`Facebook ${action}: recurring Soup replacement and staff protection`,async t=>{
  const candidate=poster(3,'Wednesday Night Specials',[offer('Soup: Chili','Soup: Chili')]);
  const f=harness(t,{week:false,candidate});const defaults=await setDefaults(f);
  const draft=withSoupControls(s.newWeekFromDefaults(defaults));
  const result=await s.saveCollection(f.env,s.collectionFromForm(formFor(draft),withSoupControls(s.newWeekFromDefaults(defaults))),dates);
  let week=await s.readWeek(f.env,result.id);
  if(['manual','hide','clear'].includes(action)){
    const form=formFor(week.collection),i=week.collection.groups.indexOf(soup(week.collection,3));
    if(action==='hide')form.set(`g${i}_hide`,'on');else form.set(`g${i}_1_content`,action==='clear'?'':'Staff Soup');
    await s.saveCollection(f.env,s.collectionFromForm(form,week.collection),dates);
  }
  if(action==='omission')f.state.candidate=poster(3,'Wing Night',[offer('Wing Night — Bone-In $.89 each / Boneless $.99 each','Wing Night Bone-In $.89 each / Boneless $.99 each')]);
  await f.run();week=await s.readWeek(f.env,result.id);const group=soup(week.collection,3),slot=group.slots[0];
  assert.equal(slot.content,action==='untouched'?'Chili':action==='manual'?'Staff Soup':action==='clear'?'':'Tomato Basil');
  assert.equal(group.enabled,['hide','clear'].includes(action)?0:1);
  assert.equal(slot.manual_locked,action==='manual'?1:0);
  assert.equal(slot.origin,action==='untouched'?'automation':action==='clear'?'legacy':'manual');
  assert.equal(slot.last_auto_value,action==='untouched'?'Chili':null);
  const snapshot=structuredClone(week);await f.run();assert.deepEqual(await s.readWeek(f.env,result.id),snapshot);
});
