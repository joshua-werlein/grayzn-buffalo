import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {validateExtraction} from './worker.js';
import {reconcilePosterEvidence} from './reconcile.js';
import {hasUnresolvedUncertainty} from './evidence.js';

// November 4, 2026: both AI reads recognized the $9.75 lunch but noted that the
// printed "(11-130)" might be a typo, which held the lunch. The fixture is the
// stored production reading; AI responses are mocked from it.
const {reading:STORED,fb_created_time:CREATED}=JSON.parse(readFileSync(new URL('../../tests/fixtures/nov4-daily.json',import.meta.url),'utf8'));
const LUNCH='Chicken Alfredo with Breadsticks and a Drink $9.75';
const JALAPENO='Jalapeno Burger with Side Salad, Chili or Coleslaw $10.25';
const HAM='Grilled Ham and Cheese with Cup of Chili or Coleslaw $7.25';
const WEEKLY='Chicken Fettuccine Alfredo with Breadsticks and a Drink';
const NOTE="Time '11-130' is likely a typo for 11-1:30";
const window={today:'2026-11-04',weekday:3};
const edit=first=>({...STORED,offers:STORED.offers.map((o,i)=>i?o:{...o,...first})});
const plan=raw=>{
  const result=validateExtraction(JSON.stringify(raw),true,window);
  assert.equal(result.validationResult,'ok',result.validationReason);
  return {result,...reconcilePosterEvidence([JSON.parse(result.candidateJson)],3,[],{today:window.today,verifiedSameDaySources:new Set([0])})};
};
const lunch=p=>p.targets.find(t=>t.service==='lunch')?.items;
const allDay=p=>p.targets.find(t=>t.service==='all-day')?.items.map(i=>i.content);
const reasons=p=>p.unresolvedTargets.map(t=>`${t.service}#${t.position}: ${t.reason}`);

// ── Validation ───────────────────────────────────────────────────────────────

test('the stored November 4 reading validates without a repair and publishes all three offers',()=>{
  const p=plan(STORED);
  assert.equal(p.result.needsRepair,false,'no second AI read is spent on a valid poster');
  assert.equal(p.result.validationReason,'poster evidence v2');
  assert.deepEqual(lunch(p),[{position:1,content:LUNCH}]);
  assert.deepEqual(allDay(p),[JALAPENO,HAM]);
  assert.deepEqual(p.unresolvedTargets,[]);
});
test('the note stays in the stored evidence; only its effect on publication changes',()=>{
  assert.deepEqual(JSON.parse(plan(STORED).result.candidateJson).offers[0].uncertainties,[NOTE]);
});

for (const note of [
  NOTE,
  'time 11–130 is likely a typo for 11–1:30',
  'Printed time (11-130) is missing a colon',
  '11-130 appears to be a typo',
  "Lunch window '11am-130pm' is written in a compact format",
  "Time '11-130' could be 11 to 1:30",
  "Time '11-130' should be 11:00 am - 1:30 pm",
]) test(`a note only about the printed window does not hold the meal: ${note}`,()=>{
  assert.deepEqual(lunch(plan(edit({uncertainties:[note]}))),[{position:1,content:LUNCH}]);
});

for (const note of [
  'Price partly obscured',
  'Price $9.75 is hard to read',
  "Time '11-130' is likely a typo and the price is unclear",
  "Time '11-130' is likely a typo for 11-1:30; price may be $9.25",
  "Time '11-130' is likely a typo for 11-2:30",
  "Time '11-130' could be 10-1:30",
  "Time '11-130' is not a typo",
  "Time '11-130' is a typo; dish may be Chicken Fettuccine Alfredo",
  "Time '11-130' is a typo; side may be coleslaw",
  'Breadsticks may be garlic bread',
  'Time is likely a typo',
  'Time 11-1:30 is unclear',
  '11-230 is likely a typo',
  'Uncertain',
  '',
]) test(`genuine uncertainty still holds lunch and only lunch: ${JSON.stringify(note)}`,()=>{
  const p=plan(edit({uncertainties:[note]}));
  assert.equal(lunch(p),undefined);
  assert.ok(reasons(p).includes('lunch#1: Uncertain extracted offer'),JSON.stringify(reasons(p)));
  assert.deepEqual(allDay(p),[JALAPENO,HAM],'valid All Day offers still publish');
  assert.equal(p.result.needsRepair,true);
});

test('a window note alongside a genuine note still holds the meal',()=>{
  assert.equal(lunch(plan(edit({uncertainties:[NOTE,'Price partly obscured']}))),undefined);
});
test('the note is only excused when this meal prints the window itself',()=>{
  for (const [name,fields] of [
    ['no window in its evidence',{evidence:'1) CHICKEN ALFREDO WITH BREADSTICKS AND A DRINK – $9.75',service_time:'',service_evidence:''}],
    ['another service field',{service_time:'All Day',service_evidence:''}],
    ['another window in its service field',{service_time:'11-2:30',service_evidence:''}],
    ['a second window in its evidence',{evidence:'1) CHICKEN ALFREDO WITH BREADSTICKS AND A DRINK (11-130) (5-10 PM) – $9.75'}],
    ['an All Day label in its evidence',{evidence:'ALL DAY CHICKEN ALFREDO WITH BREADSTICKS AND A DRINK (11-130) – $9.75'}],
  ]) assert.equal(hasUnresolvedUncertainty({...STORED.offers[0],...fields}),true,name);
});
test('a meal printing another window is still held',()=>{
  assert.equal(lunch(plan(edit({evidence:'1) CHICKEN ALFREDO WITH BREADSTICKS AND A DRINK (11-230) – $9.75',service_time:'11-230',service_evidence:'(11-230)'}))),undefined);
});
test('a changed price or dish is held even when the note itself is excused',()=>{
  const price=plan(edit({evidence:STORED.offers[0].evidence.replace('9.75','8.75')}));
  assert.equal(lunch(price),undefined);assert.ok(reasons(price).includes('lunch#1: Conflicting offer price'));
  const dish=plan(edit({content:'Chicken Fettuccine Alfredo with Breadsticks and a Drink $9.75'}));
  assert.equal(lunch(dish),undefined);assert.ok(reasons(dish).includes('lunch#1: Meal facts differ from original evidence'));
});
test('malformed uncertainty values stay uncertain',()=>{
  assert.equal(hasUnresolvedUncertainty({...STORED.offers[0],uncertainties:'11-130 is a typo'}),true);
  assert.equal(hasUnresolvedUncertainty({...STORED.offers[0],uncertainties:[]}),false);
  assert.equal(hasUnresolvedUncertainty({...STORED.offers[0],uncertainties:undefined}),false);
});

const MEALS=['Taco Salad and a Drink','Patty Melt and a Drink','Meatloaf and a Drink','Stampede Burger and a Drink','Fish Fry and a Drink'];
const weekly=(evidence,note)=>({type:'weekly-lunch',poster_evidence:'WEEKLY LUNCH SPECIALS 11/2-11/6',date_range:'11/2-11/6',service_time:'11-1:30',
  entries:MEALS.map((m,i)=>({day_of_week:i+1,content:m,evidence:i?m:evidence,uncertainties:i?[]:[note]}))});
test('a weekly row follows the same rule',()=>{
  const check=(evidence,note)=>JSON.parse(validateExtraction(JSON.stringify(weekly(evidence,note)),true,{today:'2026-11-02',weekday:1}).candidateJson);
  assert.equal(check(`${MEALS[0]} (11-130)`,NOTE).unresolved_days,undefined);
  assert.deepEqual(check(`${MEALS[0]} (11-130)`,'Price unclear').unresolved_days.map(d=>d.day),[1]);
  assert.deepEqual(check(MEALS[0],NOTE).unresolved_days.map(d=>d.day),[1]);
});
test('a Mexican Night item with any note is still rejected',()=>{
  const menu=uncertainties=>({type:'mexican-night',poster_evidence:'Mexican Night',schedule:'',groups:[{label:'Entrees',items:[{title:'Burrito $9.00',description:'',evidence:'Burrito $9.00',uncertainties}]}]});
  const check=u=>validateExtraction(JSON.stringify(menu(u)),true,{today:'2026-11-03',weekday:2}).validationResult;
  assert.equal(check([]),'ok');assert.equal(check([NOTE]),'rejected');
});

// ── Pipeline ─────────────────────────────────────────────────────────────────

function setup(t,candidate=STORED) {
  const f=harness(t,{now:'2026-11-04T15:49:55Z',caption:'',candidate});
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-02',week_end_date='2026-11-08' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'583672228384067_1756146729386537',created_time:CREATED,updated_time:CREATED});
  // The priceless weekly poster already published the meal.
  f.setLunch=(sql,...args)=>f.sql(`UPDATE special_slots SET ${sql} WHERE position=1 AND group_id IN
    (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=3 AND service='lunch')`,...args);
  f.setLunch("content=?,origin='automation',manual_locked=0,last_auto_value=?",WEEKLY,WEEKLY);
  f.conflicts=()=>f.sql("SELECT detail FROM special_import_events WHERE detail LIKE 'GUARDED_AUTO_CONFLICT%' ORDER BY id").map(e=>e.detail);
  f.revision=()=>f.sql("SELECT revision r FROM special_collections WHERE id='auto-week'")[0].r;
  return f;
}
test('November 4 end to end: lunch and All Day publish on one read, and repeated scans change nothing',async t=>{
  const f=setup(t);
  await f.run();
  assert.equal(f.state.aiCalls,1);
  const slot=f.slots(3,'lunch')[0];
  assert.equal(slot.content,LUNCH);assert.equal(slot.origin,'automation');assert.equal(slot.manual_locked,0);assert.equal(slot.last_auto_value,LUNCH);
  assert.deepEqual(f.slots(3,'all-day').slice(0,2).map(s=>s.content),[JALAPENO,HAM]);
  assert.equal(f.imports()[0].validation_reason,'poster evidence v2');
  assert.deepEqual(f.conflicts(),[]);
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),revision=f.revision();
  await f.run();await f.run();
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.equal(f.revision(),revision);assert.equal(f.state.aiCalls,1);
});
test('a genuinely uncertain lunch keeps the weekly value, publishes All Day and rereads once',async t=>{
  const f=setup(t,edit({uncertainties:['Price partly obscured']}));
  await f.run();
  assert.equal(f.state.aiCalls,2);
  assert.equal(f.slots(3,'lunch')[0].content,WEEKLY);
  assert.deepEqual(f.slots(3,'all-day').slice(0,2).map(s=>s.content),[JALAPENO,HAM]);
  assert.match(f.conflicts()[0],/"service":"lunch","position":1,"content":"","reason":"Uncertain extracted offer"/);
});
test('the November 4 staff correction stays protected and unchanged when the reading is rechecked',async t=>{
  const STAFF='Chicken Fettuccine Alfredo With Breadsticks and A Drink $9.75',AUTO='Chicken Fettuccine Alfredo With Breadsticks and A Drink';
  const f=setup(t);
  f.setLunch("content=?,price='',origin='manual',manual_locked=1,last_auto_value=?",STAFF,AUTO);
  await f.run();await f.run();
  const slot=f.slots(3,'lunch')[0];
  assert.equal(slot.content,STAFF);assert.equal(slot.origin,'manual');assert.equal(slot.manual_locked,1);assert.equal(slot.last_auto_value,AUTO);
  assert.deepEqual(f.slots(3,'all-day').slice(0,2).map(s=>s.content),[JALAPENO,HAM]);
  assert.match(f.conflicts()[0],/Protected or ineligible destination slot/);
});
