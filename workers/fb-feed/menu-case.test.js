// House capitalization (src/lib/text-case.js) on every automated Specials write.
// Raw Facebook evidence, verified prices, locks and ownership are unaffected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,offer,poster} from './test-fixture.js';
import {ensureAutomaticWeek} from './auto-week.js';
import {canonicalizeSlotContent} from './reconcile.js';
import {formatWingNight} from './wing-night.js';
import {normalizeMenuCase} from '../../src/lib/text-case.js';
import {loadTs} from '../../tests/load-ts.mjs';
const store=loadTs('src/lib/specials-store.ts');

const MONDAY={now:'2030-01-07T23:00:00Z',posted:'2030-01-07T14:00:00Z'};
const mondayPoster=(lunch,first,second)=>poster(1,'Specials',[offer(lunch,'11-1:30'),offer(first),offer(second)]);
const contents=(f,day,service)=>f.slots(day,service).map(s=>s.content);
const revision=f=>f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision;
const daily=(f,candidate)=>{f.state.candidate=candidate;f.state.posts[0].created_time=MONDAY.posted;return f;};

test('a mixed-case daily poster publishes the house capitalization with its verified prices; a repeat scan writes nothing',async t=>{
  const f=daily(harness(t,{now:MONDAY.now}),mondayPoster('chicken bacon ranch QUESADILLA & a drink $9.75',
    'JALAPENO BURGER W/ SIDE SALAD, CHILI OR COLESLAW $10.25','chicken salad sandwich w/ cup of chili or coleslaw $7.25'));
  await f.run();
  assert.deepEqual(contents(f,1,'lunch')[0],'Chicken Bacon Ranch Quesadilla & a Drink $9.75');
  assert.deepEqual(contents(f,1,'all-day').slice(0,2),['Jalapeno Burger w/ Side Salad, Chili or Coleslaw $10.25','Chicken Salad Sandwich w/ Cup of Chili or Coleslaw $7.25']);
  for(const slot of [...f.slots(1,'lunch').slice(0,1),...f.slots(1,'all-day').slice(0,2)])
    assert.deepEqual([slot.origin,slot.manual_locked,slot.last_auto_value],['automation',0,slot.content],'automation owns exactly what it published');
  // Raw extraction evidence keeps the poster's own capitalization.
  assert.match(f.imports()[0].candidate_json,/chicken bacon ranch QUESADILLA/);
  const before=revision(f);f.state.now+=30*60000;await f.run();
  assert.equal(revision(f),before,'the same poster normalized again is the same text: no write');
});

test('a staff-locked special keeps the exact text staff saved, whatever its case',async t=>{
  const f=daily(harness(t,{now:MONDAY.now}),mondayPoster('HOT HAM AND A DRINK $9.75','BURGER $10.25','SANDWICH $7.25'));
  const group=f.slots(1,'lunch')[0].group_id;
  f.sql("UPDATE special_slots SET content='staff LUNCH special $9',origin='manual',manual_locked=1,manual_edited_at='2030-01-07T15:00:00Z' WHERE group_id=? AND position=1",group);
  await f.run();
  assert.deepEqual([f.slots(1,'lunch')[0].content,f.slots(1,'lunch')[0].manual_locked],['staff LUNCH special $9',1]);
  assert.deepEqual(contents(f,1,'all-day').slice(0,2),['Burger $10.25','Sandwich $7.25'],'other offers still publish');
});

test('a backfilled automation value stays automation-owned and a newer poster still replaces it',async t=>{
  const f=daily(harness(t,{now:MONDAY.now}),mondayPoster('TACO SALAD AND A DRINK $9.75','BURGER $10.25','SANDWICH $7.25'));
  const group=f.slots(1,'lunch')[0].group_id;
  // apply.sql moves content and last_auto_value together.
  f.sql("UPDATE special_slots SET content='Old Lunch Special $9',last_auto_value='Old Lunch Special $9',origin='automation',manual_locked=0 WHERE group_id=? AND position=1",group);
  await f.run();
  assert.equal(f.slots(1,'lunch')[0].content,'Taco Salad and a Drink $9.75');
});

test('Mexican Night automation publishes the house capitalization; prices, sizes and raw evidence are exact',async t=>{
  const candidate={type:'mexican-night',poster_evidence:'MEXICAN NIGHT',schedule:'Tuesdays 5–10 PM',groups:[
    {label:'ENTREES',items:[{title:'BURRITO $9.00',description:'MEAT AND REFRIED BEANS\nTOPPED WITH CHEESE OR SALSA'},
      {title:'taco salad large $12 · small $10',description:'served in a SHELL bowl'}]},
    {label:'add-ons',items:[{title:'SUBSTITUTE CHICKEN 50c',description:''}]},
  ]};
  const f=harness(t,{now:'2030-01-14T15:00:00Z',caption:'Mexican Night',candidate});
  Object.assign(f.state.posts[0],{created_time:'2030-01-14T14:00:00Z',updated_time:'2030-01-14T14:00:00Z'});
  await f.run();
  const groups=f.sql("SELECT * FROM special_groups WHERE collection_id='mexican-night' ORDER BY sort,id");
  const slots=f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night' ORDER BY g.sort,g.id,s.position").filter(s=>s.content);
  assert.deepEqual(groups.map(g=>g.label),['Entrees','Add-Ons']);
  assert.deepEqual(slots.map(s=>s.content),['Burrito $9.00\nMeat and Refried Beans\nTopped with Cheese or Salsa',
    'Taco Salad Large $12 · Small $10\nServed In a Shell Bowl','Substitute Chicken $0.50']);
  assert.ok(slots.every(s=>s.origin==='automation' && s.last_auto_value===s.content));
  assert.match(f.imports()[0].candidate_json,/BURRITO \$9\.00/,'evidence keeps the printed text');
});

test('weekly rollover copies recurring defaults exactly as saved',async t=>{
  const f=harness(t,{now:'2030-01-14T01:00:00Z',week:false});
  const defaults=await store.readCollection(f.env,'defaults');
  defaults.groups.find(g=>g.day_of_week===1 && g.service==='lunch').slots[0].content='hot ham AND a drink $9.75';
  await store.saveCollection(f.env,defaults);
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  const copied=f.sql(`SELECT s.content,s.origin,s.manual_locked FROM special_slots s JOIN special_groups g ON g.id=s.group_id
    JOIN special_collections c ON c.id=g.collection_id JOIN weekly_specials w ON w.id=c.weekly_special_id
    WHERE w.week_start_date='2030-01-14' AND g.day_of_week=1 AND g.service='lunch' AND s.position=1`)[0];
  assert.equal(copied.content,'Hot Ham and a Drink $9.75');
  assert.equal(copied.manual_locked,0,'a copied default stays replaceable by Facebook');
});

test('Wing Night and Wing Wednesday presentation is already in the house capitalization',()=>{
  const wing=formatWingNight('Wing Night — Bone-In $.89 each / Boneless $.99 each');
  assert.equal(wing,'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each');
  assert.equal(canonicalizeSlotContent('WING NIGHT BONE-IN $.89 EACH / BONELESS $.99 EACH',3,'nightly'),'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each');
  for(const text of [wing,'Wing Wednesday!\nBone-In Wings $1.25 each\nBoneless Wings $1.10 each\nAdd Fries $3']) assert.equal(normalizeMenuCase(text),text);
  const choices=canonicalizeSlotContent('CHICKEN STIR FRY $12.99 OR STEAK STIR FRY $13.99',5,'nightly');
  assert.equal(choices,'Chicken Stir Fry $12.99\nor Steak Stir Fry $13.99');
  assert.equal(normalizeMenuCase(choices),choices,'staff saves and backfill preserve published choice-line capitalization');
});

test('a legacy-cased weekly automation value gains its printed shared price without a backfill',async t=>{
  const content='Mac n Cheese Burger with Fries and a Drink';
  const candidate={type:'weekly-lunch',poster_evidence:'Weekly Lunch Specials $9.75',date_range:'1/7-1/11',service_time:'11 AM-1:30 PM',
    entries:[{day_of_week:1,content}]};
  const f=daily(harness(t,{now:MONDAY.now,caption:'Weekly Lunch Specials',candidate}),candidate);
  const group=f.slots(1,'lunch')[0].group_id;
  f.sql("UPDATE special_slots SET content=?,last_auto_value=?,origin='automation',manual_locked=0 WHERE group_id=? AND position=1",content,content,group);
  await f.run();
  assert.equal(f.slots(1,'lunch')[0].content,'Mac N Cheese Burger with Fries and a Drink - $9.75');
  const before=revision(f);await f.run();assert.equal(revision(f),before);
});
