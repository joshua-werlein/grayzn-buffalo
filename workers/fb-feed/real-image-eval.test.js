// End-to-end publication from the 2026-10-12 real-image evaluation. Each test
// runs the full Worker pipeline (discovery → contract-2 validation → staging →
// guarded D1 publication) with the AI mocked to return ACTUAL Workers AI outputs
// for the original R2 poster images (tests/fixtures/contract2-eval/*.json).
// Weekly and Mexican Night rereads are the ACTUAL outputs of the final two
// authorized calls (*.final-reread.json). Assertions are the publication
// the poster IMAGE supports, verified by hand, not merely withheld data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateExtraction} from './worker.js';
import {normalizeEvidenceOffer} from './evidence.js';
import {harness} from './test-fixture.js';

const load=name=>JSON.parse(readFileSync(new URL(`../../tests/fixtures/contract2-eval/${name}.json`,import.meta.url),'utf8'));
const WEEK={'2026-10-05':['2026-10-05','2026-10-11'],'2026-10-06':['2026-10-05','2026-10-11'],'2026-10-07':['2026-10-05','2026-10-11'],
  '2026-10-10':['2026-10-05','2026-10-11'],'2026-10-11':['2026-10-05','2026-10-11'],'2026-10-12':['2026-10-12','2026-10-18']};
// Posted 09:00 Chicago, processed 10:00 Chicago (CDT, UTC-5).
function setup(t,today,responses) {
  const f=harness(t,{now:`${today}T15:00:00Z`});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  Object.assign(f.state.posts[0],{message:'',created_time:`${today}T14:00:00Z`,updated_time:`${today}T14:00:00Z`});
  f.sql('UPDATE weekly_specials SET week_start_date=?,week_end_date=? WHERE id=9000',...WEEK[today]);
  const requests=[];
  f.env.AI.run=async(_model,request)=>{
    requests.push(request);f.state.aiCalls++;
    return {response:JSON.stringify(responses[Math.min(requests.length,responses.length)-1])};
  };
  return {...f,requests};
}
const content=(f,day,service)=>f.slots(day,service).map(s=>s.content);
const owned=(f,day,service)=>f.slots(day,service).filter(s=>s.content).every(s=>s.origin==='automation' && s.last_auto_value===s.content);
const soup=(f,day)=>f.sql("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='auto-week' AND g.day_of_week=? AND g.label='Soup' AND s.position=1",day)[0]?.content;
const mexicanMenu=f=>f.sql("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night' ORDER BY g.sort,s.position").map(r=>r.content);
const readings=name=>{const x=load(name);return [x.first_reading,...(x.repair_reading?[x.repair_reading]:[])];};

// ── Decoding trap (documented failure of the original schema) ──
test('real output under the original contract-2 schema was trapped in the mexican-night shape',()=>{
  const {reading}=load('oct12-mon-daily.schema-trap');
  assert.deepEqual([reading.type,reading.groups,reading.poster_evidence],['mexican-night',[],'MONDAY SPECIALS 10/12']);
});

// ── Daily posters ──
test('Oct 10 Saturday (real reading): Saturday Special, both All Day meals and the Soups list, one AI call',async t=>{
  const f=setup(t,'2026-10-10',readings('oct10-sat-daily'));await f.run();
  assert.equal(content(f,6,'lunch')[0],'Philly & Fries $11');
  assert.deepEqual(content(f,6,'all-day').slice(0,2),['German Burger w/ Side Salad, Soup or Coleslaw $10.25','Chicken Salad Sandwich w/ cup of Soup or Coleslaw $7.25']);
  assert.equal(soup(f,6),'French Onion, Chili or Beer Cheese Soup');
  assert.ok(content(f,6,'nightly').every(c=>!c)); // weekend Nightly stays disabled/blank
  assert.ok(owned(f,6,'lunch') && owned(f,6,'all-day'));
  assert.equal(f.state.aiCalls,1);
});
test('Oct 11 Sunday (real reading): pizza-and-wings bundle, both All Day meals and the Soups list, one AI call',async t=>{
  const f=setup(t,'2026-10-11',readings('oct11-sun-daily'));await f.run();
  assert.equal(content(f,0,'lunch')[0],'16” 3-Topping Pizza & 12 Wings $30');
  assert.deepEqual(content(f,0,'all-day').slice(0,2),['Olive Burger w/ Side Salad, Soup or Coleslaw $10.25','Chicken Salad Sandwich w/ Cup of Soup or Coleslaw $7.25']);
  assert.equal(soup(f,0),'Beer Cheese, French Onion or Chili');
  assert.equal(f.state.aiCalls,1);
});
test('Oct 12 Monday (real readings): Lunch $9.75 and Cheddar BLT publish; the meal printed without "or" keeps its recurring default',async t=>{
  const f=setup(t,'2026-10-12',readings('oct12-mon-daily'));
  const allDay=f.slots(1,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Chicken Salad Sandwich with cup of Chili or Coleslaw',origin='manual',manual_locked=0 WHERE group_id=? AND position=2",allDay);
  await f.run();
  assert.equal(content(f,1,'lunch')[0],'Grilled Chicken Caesar Salad and a Drink - $9.75');
  assert.deepEqual(content(f,1,'all-day').slice(0,2),['Cheddar BLT w/ Side Salad, Soup or Coleslaw - $10.25','Chicken Salad Sandwich with cup of Chili or Coleslaw']);
  assert.equal(f.slots(1,'all-day')[1].origin,'manual'); // genuinely ambiguous: never invented, default untouched
  assert.equal(f.state.aiCalls,2); // one factual repair for the ambiguous meal; it re-read the same text
});

// ── Night posters ──
test('Oct 5 Monday night (real reading): two Nightly meals and the two All Day meals, in printed order',async t=>{
  const f=setup(t,'2026-10-05',readings('oct05-mon-night'));await f.run();
  assert.deepEqual(content(f,1,'nightly').slice(0,2),['2 Burgers and 1 Order of Fries - $14','Half Rack Ribs with Mac n Cheese & Coleslaw - $18.75']);
  assert.deepEqual(content(f,1,'all-day').slice(0,2),['BLT on Texas Toast w/ Side Salad or Coleslaw - $10.25','Chicken Salad Sandwich w/ Cup of Coleslaw - $7.25']);
  assert.equal(f.state.aiCalls,1); // a missing label is not repaired: the earlier reread copied the heading onto All Day meals
});
test('Oct 5 Monday night (real REPAIR reading, heading copied onto every offer): same correct publication',async t=>{
  const [,repair]=readings('oct05-mon-night');
  const f=setup(t,'2026-10-05',[repair]);await f.run();
  assert.deepEqual(content(f,1,'nightly').slice(0,2),['2 Burgers and 1 Order of Fries - $14','Half Rack Ribs with Mac n Cheese & Coleslaw - $18.75']);
  assert.deepEqual(content(f,1,'all-day').slice(0,2),['BLT on Texas Toast w/ Side Salad or Coleslaw - $10.25','Chicken Salad Sandwich w/ Cup of Coleslaw - $7.25']);
});
test('Oct 7 Wednesday (real reading): Wing Night, both All Day meals and the Soup list',async t=>{
  const f=setup(t,'2026-10-07',readings('oct07-wed-night'));await f.run();
  assert.equal(content(f,3,'nightly')[0],'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each');
  assert.deepEqual(content(f,3,'all-day').slice(0,2),['Crispy Chipotle Chicken Sandwich w/ Side Salad, Soup or Coleslaw – $10.25','Chicken Salad Sandwich with Cup of Soup or Coleslaw – $7.25']);
  assert.equal(soup(f,3),'French Onion or Chili');
  assert.equal(f.state.aiCalls,1);
});

// ── Whole-week lunch (ACTUAL weekly-only reread from the final authorized call) ──
const WEEKLY=['Grilled Chicken Caesar Salad & a Drink','Enchilada & a Drink','Chicken Philly Tots & a Drink','Spaghetti and Meatballs and Breadsticks & a Drink','Fish Sandwich and French Fries & a Drink'];
const weeklyReads=()=>[load('oct12-weekly').first_reading,load('oct12-weekly.final-reread').reading];
test('Oct 12 weekly (real first reading + real reread): one weekly-only reread; all five printed lunches publish to 10/12-10/16',async t=>{
  const f=setup(t,'2026-10-12',weeklyReads());
  await f.run();
  assert.equal(f.state.aiCalls,2);
  assert.equal(f.requests[1].response_format.json_schema.name,'specials_evidence_v2_weekly');
  assert.deepEqual([1,2,3,4,5].map(day=>content(f,day,'lunch')[0]),WEEKLY);
  assert.ok([1,2,3,4,5].every(day=>owned(f,day,'lunch')));
  // The model wrote the printed "OCT 12-16"; it is the same range as the heading.
  assert.equal(load('oct12-weekly.final-reread').reading.date_range,'OCT 12-16');
  assert.equal(JSON.parse(f.imports()[0].candidate_json).date_range,'10/12-10/16');
});
test('Oct 12 as it happened (all real readings): weekly lunch at 8:31, daily poster at 8:48 replaces Monday Lunch with its priced reading',async t=>{
  const f=setup(t,'2026-10-12',weeklyReads());await f.run();
  assert.equal(content(f,1,'lunch')[0],WEEKLY[0]);
  f.state.posts.push({...f.state.posts[0],id:'daily',created_time:'2026-10-12T14:30:00Z',updated_time:'2026-10-12T14:30:00Z'});
  const daily=readings('oct12-mon-daily');let n=0;
  f.env.AI.run=async()=>{f.state.aiCalls++;return {response:JSON.stringify(daily[Math.min(++n,daily.length)-1])};};
  f.state.now+=30*60*1000;await f.run();
  assert.equal(content(f,1,'lunch')[0],'Grilled Chicken Caesar Salad and a Drink - $9.75');
  assert.equal(content(f,1,'all-day')[0],'Cheddar BLT w/ Side Salad, Soup or Coleslaw - $10.25');
  assert.deepEqual([2,3,4,5].map(day=>content(f,day,'lunch')[0]),WEEKLY.slice(1));
});
test('weekly: a model date_range that differs from the printed heading is still a conflict',()=>{
  const reading=structuredClone(load('oct12-weekly.final-reread').reading);reading.date_range='OCT 19-23';
  assert.equal(validateExtraction(JSON.stringify(reading),true,{weekday:1,today:'2026-10-12'}).validationReason,'Conflicting printed weekly date range');
});

// ── Mexican Night (ACTUAL Mexican-only reread from the final authorized call) ──
// Every item printed on the Oct 6 poster, in printed order; accessory amounts in
// the publisher's existing $0.00 format. Verified against the image by hand.
const MEXICAN_MENU=[
  '2 Soft Shell ... $7.75\nMeat, shredded cheese, lettuce, onion, tomato, and black olives',
  'Enchilada ... $9.25\nMeat, refried beans, shredded cheese, and onion rolled up in a tortilla. Topped with enchilada sauce, black olives, and shredded cheese. Lettuce and tomato on the side',
  'Burrito ... $10.25\nMeat, refried beans, shredded cheese, lettuce, onion, and tomato rolled up in a tortilla. Topped with shredded cheese, black olives, and enchilada sauce',
  'Nacho Deluxe ... $9.75\nMeat, lettuce, onion, tomato, black olives, and nacho cheese served on top of chips',
  'Chimichanga ... $12.25\nMeat, refried beans, shredded cheese, and onion rolled up in a tortilla and fried. Topped with enchilada sauce, black olives, and shredded cheese. Lettuce and tomato on the side',
  'Taco Salad ... Large $9.00 | Small $8.50 | Mini $6.00\nMeat, shredded cheese, lettuce, onion, tomato, and black olives served in a shell bowl',
  'Chips & Salsa or Chips & Cheese ... $4.00',
  'Substitute chicken $1.50','Add Nacho Cheese $1.50','Substitute Queso $0.50','Substitute Shredded Cheese for Nacho Cheese $0.50',
  'Add nacho cheese or salsa +$1.50'];
const mexicanReads=()=>[load('oct06-mexican-night').first_reading,load('oct06-mexican-night.final-reread').reading];
test('Oct 6 Mexican Night (real first reading + real reread): one Mexican-only reread; the COMPLETE printed menu publishes',async t=>{
  const f=setup(t,'2026-10-06',mexicanReads());
  await f.run();
  assert.equal(f.state.aiCalls,2);
  assert.equal(f.requests[1].response_format.json_schema.name,'specials_evidence_v2_mexican');
  assert.deepEqual(mexicanMenu(f),MEXICAN_MENU);
  assert.ok(content(f,2,'nightly').every(c=>!c)); // never published as daily Tuesday offers
});
test('Mexican Night: the real reread dropped Taco Salad size labels; they are restored only from its own printed evidence',()=>{
  const reading=load('oct06-mexican-night.final-reread').reading;
  const taco=reading.groups.flatMap(g=>g.items).find(i=>/taco salad/i.test(i.title));
  assert.equal(taco.title,'Taco Salad ... $9.00 | $8.50 | $6.00'); // actual model output
  const v=validateExtraction(JSON.stringify(reading),true,{weekday:2,today:'2026-10-06'});
  assert.equal(JSON.parse(v.candidateJson).groups.flatMap(g=>g.items).find(i=>/taco salad/i.test(i.title)).title,'Taco Salad ... Large $9.00 | Small $8.50 | Mini $6.00');
});
for(const [name,title] of [['amounts in another order','Taco Salad ... $8.50 | $9.00 | $6.00'],['a missing amount','Taco Salad ... $9.00 | $8.50'],
  ['swapped size labels','Taco Salad ... Large $8.50 | Small $9.00 | Mini $6.00']])
  test(`Mexican Night: a reread with ${name} is rejected; the existing menu stays`,async t=>{
    const reread=structuredClone(load('oct06-mexican-night.final-reread').reading);
    reread.groups.flatMap(g=>g.items).find(i=>/taco salad/i.test(i.title)).title=title;
    const f=setup(t,'2026-10-06',[load('oct06-mexican-night').first_reading,reread]);
    const before=mexicanMenu(f);await f.run();
    assert.deepEqual(mexicanMenu(f),before);
    assert.ok(content(f,2,'nightly').every(c=>!c));
  });
test('Mexican Night: a reread that finds no printed Mexican Night heading keeps the first reading and publishes nothing for Tuesday night',async t=>{
  const f=setup(t,'2026-10-06',[load('oct06-mexican-night').first_reading,{type:'mexican-night',poster_evidence:'',schedule:'',groups:[]}]);
  const before=mexicanMenu(f);await f.run();
  assert.deepEqual(mexicanMenu(f),before);
  assert.ok(content(f,2,'nightly').every(c=>!c));
  assert.equal(f.imports()[0].processing_status,'staged');
});

// ── Validator precision around the real-image fixes ──
test('attached or leading minus signs remain negative prices; spaced separators do not',()=>{
  for(const c of ['Burger -$9.75','- $9.75 Burger','Burger −$9.75']) assert.throws(()=>normalizeEvidenceOffer({content:c,service_time:'',evidence:c}),/Ambiguous price/,c);
  for(const c of ['Burger - $9.75','Burger – $9.75','Burger — $9.75']) assert.equal(normalizeEvidenceOffer({content:c,service_time:'',evidence:c}).content,c);
});
test('bundle tolerance only ADDS "&": substituting it for a printed "or", or dropping printed words, still fails',()=>{
  const check=(c,e)=>()=>normalizeEvidenceOffer({content:c,service_time:'',evidence:e});
  assert.doesNotThrow(check('Pizza & 12 Wings $30','Pizza  12 Wings $30'));
  assert.throws(check('Burger w/ Soup & Coleslaw $10','Burger w/ Soup or Coleslaw $10'),/Meal facts differ/);
  assert.throws(check('Burger & Fries $10','Burger Fries and Salad $10'),/Meal facts differ/);
  assert.throws(check('Burger Fries $10','Burger & Fries $10'),/Meal facts differ/);
});
test('weekly heading in a daily-shaped reading is a shape error with a weekly-only repair',()=>{
  const r=validateExtraction(JSON.stringify(load('oct12-weekly').first_reading),true,{weekday:1,today:'2026-10-12'});
  assert.deepEqual([r.validationResult,r.repairShape],['rejected','weekly-lunch']);
});
