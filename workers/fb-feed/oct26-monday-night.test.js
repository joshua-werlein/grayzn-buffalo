import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {sameOffer} from './evidence.js';
import {reconcilePosterEvidence} from './reconcile.js';

// The exact production candidate_json records for October 26, 2026: the
// morning MONDAY SPECIALS post (Lunch + two All Day) and the 4:22 PM MONDAY
// NIGHT SPECIALS post, which reprinted the All Day pair with the chicken
// sandwich's dish words reordered. Production held three offers as
// "Service not established by evidence" and wrote only the soup.
const FIXTURE=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct26-monday-night.json',import.meta.url),'utf8'));
const MORNING=()=>structuredClone(FIXTURE.morning), NIGHT=()=>structuredClone(FIXTURE.night);
const [LUNCH,CHICKEN,HAM]=FIXTURE.morning.offers.map(o=>o.content);
const [BURGERS,RIBS]=FIXTURE.night.offers.map(o=>o.content);
const DEFAULT_NIGHTLY=['2 Burgers and 1 Order of Fries','Half Rack Ribs w/ Mac n Cheese & Coleslaw'];
const reprint=content=>({content,service_time:'',evidence:`• ${content}`,service_evidence:'',uncertainties:[]});

function monday(t) {
  const f=harness(t,{now:'2026-10-26T15:00:00Z',caption:'Monday Specials',candidate:MORNING()});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  Object.assign(f.state.posts[0],{created_time:'2026-10-26T14:00:00Z',updated_time:'2026-10-26T14:00:00Z'});
  // The unlocked, price-less recurring Nightly defaults shown that morning.
  const slots=f.slots(1,'nightly');
  DEFAULT_NIGHTLY.forEach((content,i)=>f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=0,last_auto_value=NULL WHERE group_id=? AND position=?",content,slots[i].group_id,i+1));
  return f;
}
async function evening(f,night=NIGHT()) {
  f.state.now=Date.parse('2026-10-26T21:30:00Z');
  f.state.posts.unshift({...f.state.posts[0],id:'night',message:'Monday Night Specials',created_time:'2026-10-26T21:22:00Z',updated_time:'2026-10-26T21:22:00Z'});
  f.state.candidate=night;
  await f.run();
  return f;
}
async function october26(t,night) {const f=monday(t);await f.run();return evening(f,night);}
const rows=(f,service)=>f.slots(1,service).slice(0,2);
const contents=(f,service)=>rows(f,service).map(s=>s.content);
const soup=f=>f.sql("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='auto-week' AND g.day_of_week=1 AND g.service='custom' AND s.position=1").map(r=>r.content);
const snapshot=f=>({collection:f.sql("SELECT revision,mutation_token FROM special_collections WHERE id='auto-week'"),
  slots:f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),events:f.sql('SELECT * FROM special_import_events')});
const conflicts=f=>f.sql("SELECT detail FROM special_import_events WHERE event_type='review' AND detail LIKE 'GUARDED_AUTO_CONFLICT%'").map(r=>r.detail);

test('October 26 morning record publishes Lunch and the All Day pair, leaving the Nightly defaults',async t=>{
  const f=monday(t);await f.run();
  assert.equal(f.slots(1,'lunch')[0].content,LUNCH);
  assert.deepEqual(contents(f,'all-day'),[CHICKEN,HAM]);
  assert.deepEqual(contents(f,'nightly'),DEFAULT_NIGHTLY);
});

test('October 26 exact records: both Nightly prices publish, the morning All Day pair is unchanged, soup publishes, no conflict',async t=>{
  const f=monday(t);await f.run();
  const allDayBefore=rows(f,'all-day');
  await evening(f);
  assert.deepEqual(contents(f,'nightly'),[BURGERS,RIBS]);
  assert.match(BURGERS,/\$14$/);assert.match(RIBS,/\$18\.75$/);
  assert.ok(rows(f,'nightly').every(s=>s.origin==='automation' && s.last_auto_value===s.content && s.manual_locked===0));
  assert.deepEqual(rows(f,'all-day'),allDayBefore);
  assert.deepEqual(soup(f),['Chicken Noodle']);
  assert.deepEqual(conflicts(f),[]);
});

test('the stored records keep their original evidence fields and issues',()=>{
  assert.equal(FIXTURE.night.offers[1].evidence,'• Half Rack Ribs with Mac n Cheese & Coleslaw — $18.75');
  assert.deepEqual(FIXTURE.night.issues.map(i=>[i.index,i.reason]),[0,1,2,3].map(i=>[i,'Service not established by evidence']));
  assert.deepEqual(FIXTURE.morning.issues.map(i=>i.index),[1,2]);
});

test('either source order keeps the morning wording and agrees on All Day',()=>{
  const existing=[{content:CHICKEN},{content:HAM}];
  const slotLayout=[{service:'all-day',position:1,content:CHICKEN},{service:'all-day',position:2,content:HAM}];
  for(const candidates of [[MORNING(),NIGHT()],[NIGHT(),MORNING()]]) {
    const r=reconcilePosterEvidence(candidates,1,existing,{today:'2026-10-26',slotLayout,verifiedSameDaySources:new Set([0,1])});
    const by=Object.fromEntries(r.targets.map(t=>[t.service,t.items.map(i=>i.content)]));
    assert.deepEqual(by['all-day'],[CHICKEN,HAM]);
    assert.deepEqual(by.nightly,[BURGERS,RIBS]);
    assert.deepEqual(r.unresolvedTargets,[]);
  }
});

test('rerunning the October 26 records is idempotent',async t=>{
  const f=await october26(t);
  const before=snapshot(f);
  await f.run();f.state.now+=31*60*1000;await f.run();
  assert.deepEqual(snapshot(f),before);
  assert.equal(f.state.aiCalls,2);
});

test('a staff-locked Nightly correction is kept; the other Nightly slot still publishes',async t=>{
  const f=monday(t);await f.run();
  f.sql("UPDATE special_slots SET content='Ribs corrected by staff $19',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",rows(f,'nightly')[1].group_id);
  await evening(f);
  assert.deepEqual(contents(f,'nightly'),[BURGERS,'Ribs corrected by staff $19']);
  assert.equal(rows(f,'nightly')[1].manual_locked,1);
});

test('a missing Nightly price is held and never borrowed from the default',async t=>{
  const night=NIGHT();night.offers[0]=reprint('2 Burgers and 1 Order of Fries');
  const f=await october26(t,night);
  assert.equal(contents(f,'nightly')[0],DEFAULT_NIGHTLY[0]);
  assert.equal(rows(f,'nightly')[0].origin,'manual');
});

// ── Genuine conflicts stay conflicts (October 5 safeguards) ────────────────────

for(const [label,chicken] of [
  ['different price','Grilled Chicken Honey Mustard Sandwich w/ Side Salad, Soup or Coleslaw — $10.75'],
  ['different sides','Grilled Chicken Honey Mustard Sandwich w/ Fries — $10.25'],
  ['reordered side alternatives','Grilled Chicken Honey Mustard Sandwich w/ Soup, Side Salad or Coleslaw — $10.25'],
  ['different dish','Crispy Chicken Honey Mustard Sandwich w/ Side Salad, Soup or Coleslaw — $10.25'],
  ['different head noun','Grilled Chicken Honey Mustard Wrap w/ Side Salad, Soup or Coleslaw — $10.25'],
]) test(`evening All Day reprint with ${label} is never treated as the morning offer`,async t=>{
  const night=NIGHT();night.offers[2]=reprint(chicken);
  const f=monday(t);await f.run();
  const allDayBefore=rows(f,'all-day');
  await evening(f,night);
  assert.deepEqual(rows(f,'all-day'),allDayBefore);
  assert.ok(conflicts(f).length>0,'the disagreement is recorded for review');
  assert.ok(!contents(f,'all-day').includes(chicken));
});

test('sameOffer allows only interior dish-word order to differ',()=>{
  assert.ok(sameOffer(CHICKEN,FIXTURE.night.offers[2].content));
  assert.ok(sameOffer(HAM,FIXTURE.night.offers[3].content));
  for(const other of ['Grilled Chicken Honey Mustard Sandwich w/ Side Salad, Soup or Coleslaw — $10.75',
    'Grilled Chicken Honey Mustard Sandwich w/ Side Salad or Coleslaw — $10.25',
    'Grilled Mustard Honey Chicken Sandwich w/ Coleslaw, Soup or Side Salad — $10.25',
    'Sandwich Chicken Honey Mustard Grilled w/ Side Salad, Soup or Coleslaw — $10.25',
    'Grilled Chicken Mustard Sandwich w/ Side Salad, Soup or Coleslaw — $10.25'])
    assert.ok(!sameOffer(CHICKEN,other),other);
  // Two-word dishes and offers without a "with" clause or price never use the reorder rule.
  assert.ok(!sameOffer('Steak Chicken with Fries $10','Chicken Steak with Fries $10'));
  assert.ok(!sameOffer('Chicken Fried Steak $12','Steak Fried Chicken $12'));
  assert.ok(!sameOffer('Grilled Honey Mustard Chicken Sandwich with Fries','Grilled Chicken Honey Mustard Sandwich with Fries'));
});
