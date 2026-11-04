import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';
import {validateExtraction} from './worker.js';
import {reconcilePosterEvidence} from './reconcile.js';
import {serviceFromEvidence} from './evidence.js';

// November 3, 2026: the poster printed the lunch window without its colon beside
// the lunch meal only. AI responses are mocked from the printed poster text; these
// exercise validation and publication, not live vision accuracy.
const LUNCH='Hoagie Sandwich With Waffle Fries and A Drink $9.75';
const TURKEY='Turkey Club On Rye With Side Salad, Chili or Coleslaw $10.25';
const HAM='Grilled Ham and Cheese With Cup of Chili or Coleslaw $7.25';
const WEEKLY='Hoagie Sandwich With Waffle Fries and A Drink';
const PRINTED='1) HOAGIE SANDWICH WITH WAFFLE FRIES\nAND A DRINK (11–130) $9.75';
const offer=(content,evidence,service_time='')=>({content,evidence,service_time,service_evidence:service_time,date_evidence:'',uncertainties:[]});
const poster=first=>({day_of_week:2,day_evidence:'TUESDAY',poster_evidence:'TUESDAY LUNCH SPECIALS',
  delivery:{status:'none',evidence:'',date_evidence:'',uncertainties:[]},
  offers:[first,offer(TURKEY,'2) TURKEY CLUB ON RYE\nWITH SIDE SALAD, CHILI OR COLESLAW — $10.25'),offer(HAM,'3) GRILLED HAM AND CHEESE\nWITH CUP OF CHILI OR COLESLAW — $7.25')]});
const window={today:'2026-11-03',weekday:2};
const plan=first=>{
  const result=validateExtraction(JSON.stringify(poster(first)),true,window);
  assert.equal(result.validationResult,'ok',result.validationReason);
  const candidate=JSON.parse(result.candidateJson);
  return {result,candidate,...reconcilePosterEvidence([candidate],2,[],{today:window.today,verifiedSameDaySources:new Set([0])})};
};
const lunchTarget=p=>p.targets.find(t=>t.service==='lunch');
const allDayTarget=p=>p.targets.find(t=>t.service==='all-day');

// ── Validation ───────────────────────────────────────────────────────────────

for (const [name,evidence,time] of [
  ['en dash in evidence',PRINTED,''],
  ['hyphen in evidence',PRINTED.replace('–','-'),''],
  ['em dash in evidence',PRINTED.replace('–','—'),''],
  ['labelled hours in evidence',PRINTED.replace('11–130','11am–130pm'),''],
  ['window also in service_time',PRINTED,'11-130'],
]) test(`compact lunch window is presentation: ${name}`,()=>{
  const p=plan(offer(LUNCH,evidence,time));
  assert.equal(p.result.needsRepair,false,'no repair read is spent on a valid poster');
  assert.deepEqual(lunchTarget(p).items,[{position:1,content:LUNCH}]);
  assert.deepEqual(allDayTarget(p).items.map(i=>i.content),[TURKEY,HAM]);
  assert.deepEqual(p.unresolvedTargets,[]);
});

for (const [name,change,reason] of [
  ['another end time',e=>e.replace('11–130','11–230'),'Meal facts differ from original evidence'],
  ['another start time',e=>e.replace('11–130','10–130'),'Meal facts differ from original evidence'],
  ['missing digit',e=>e.replace('11–130','11–30'),'Meal facts differ from original evidence'],
  ['extra digit',e=>e.replace('11–130','11–1305'),'Meal facts differ from original evidence'],
  ['attached word',e=>e.replace('(11–130)','(11–130x)'),'Meal facts differ from original evidence'],
  ['bare number, not a window',e=>e.replace('(11–130)','130'),'Meal facts differ from original evidence'],
  ['changed side',e=>e.replace('WAFFLE','FRENCH'),'Meal facts differ from original evidence'],
  ['dropped drink',e=>e.replace('AND A DRINK ',''),'Meal facts differ from original evidence'],
  ['added item',e=>e.replace('AND A DRINK','AND A COOKIE AND A DRINK'),'Meal facts differ from original evidence'],
  ['changed price',e=>e.replace('$9.75','$8.75'),'Conflicting offer price'],
  ['missing price',e=>e.replace(' $9.75',''),'Missing price in original meal evidence'],
]) test(`stays held: ${name}`,()=>{
  const p=plan(offer(LUNCH,change(PRINTED)));
  assert.equal(lunchTarget(p),undefined);
  assert.ok(p.unresolvedTargets.some(t=>t.reason===reason),JSON.stringify(p.unresolvedTargets));
});

test('content that differs from a correct window reading is still held',()=>{
  const p=plan(offer('Hoagie Sandwich With French Fries and A Drink $9.75',PRINTED));
  assert.equal(lunchTarget(p),undefined);
  assert.equal(p.unresolvedTargets[0].reason,'Meal facts differ from original evidence');
});

test('the compact window is not service evidence; the colon form still is',()=>{
  for (const lunch of ['11-1:30','11:00 am - 1:30 pm']) assert.equal(serviceFromEvidence(lunch),'lunch',lunch);
  for (const other of ['11-130','11–130','(11—130)','11am-130pm','11-230','10-130','11-30','11-1305','130']) assert.equal(serviceFromEvidence(other),'unknown',other);
});

test('without an established layout the compact window publishes nothing',()=>{
  const held=(raw,verifiedSameDay)=>{
    const result=validateExtraction(JSON.stringify(raw),true,window);
    assert.equal(result.validationResult,'ok',result.validationReason);
    const p=reconcilePosterEvidence([JSON.parse(result.candidateJson)],2,[],{today:window.today,verifiedSameDaySources:new Set(verifiedSameDay?[0]:[])});
    assert.deepEqual(p.targets,[]);
    assert.ok(p.unresolvedTargets.length && p.unresolvedTargets.every(t=>t.reason==='Service not established by evidence'),JSON.stringify(p.unresolvedTargets));
  };
  // Two meals are not the three-meal day poster, and "Specials" names no service.
  const twoMeals=poster(offer(LUNCH,PRINTED));
  twoMeals.poster_evidence='TUESDAY SPECIALS';twoMeals.offers=twoMeals.offers.slice(0,2);
  held(twoMeals,true);
  // An undated poster with no trusted Facebook timestamp establishes no day.
  held({...poster(offer(LUNCH,PRINTED)),day_of_week:-1,day_evidence:'',poster_evidence:'DAILY SPECIALS'},false);
  // Unrelated headings acquire no layout from the printed window.
  held({...poster(offer(LUNCH,PRINTED)),day_of_week:-1,day_evidence:'',poster_evidence:"TODAY'S FEATURE"},true);
});

test('a weekly row printing the compact window keeps its meal and day',()=>{
  const MEALS=['Taco Salad and a Drink','Patty Melt and a Drink','Meatloaf and a Drink','Stampede Burger and a Drink','Fish Fry and a Drink'];
  const weekly=first=>({type:'weekly-lunch',poster_evidence:'WEEKLY LUNCH SPECIALS 11/2-11/6',date_range:'11/2-11/6',service_time:'11-1:30',
    entries:MEALS.map((m,i)=>({day_of_week:i+1,content:m,evidence:i?m:first,uncertainties:[]}))});
  const check=first=>JSON.parse(validateExtraction(JSON.stringify(weekly(first)),true,{today:'2026-11-02',weekday:1}).candidateJson);
  assert.equal(check(`${MEALS[0]} (11–130)`).unresolved_days,undefined);
  assert.deepEqual(check(`${MEALS[0]} (11–230)`).unresolved_days.map(d=>d.day),[1]);
});

test('an All Day special printing the compact window never publishes into the Lunch slot',()=>{
  const turkey=(evidence,time='')=>offer(TURKEY,evidence,time);
  for (const [name,first,second] of [
    ['only the All Day meal prints it',offer(LUNCH,LUNCH),turkey(`${TURKEY} (11-130)`)],
    ['both meals print it',offer(LUNCH,PRINTED),turkey(`${TURKEY} (11-130)`)],
    ['labelled All Day in its evidence',offer(LUNCH,PRINTED),turkey(`All Day ${TURKEY} (11-130)`)],
    ['labelled All Day in its service fields',offer(LUNCH,LUNCH),turkey(`${TURKEY} (11-130)`,'All Day')],
  ]) {
    const raw=poster(first);raw.offers[1]=second;
    const result=validateExtraction(JSON.stringify(raw),true,window);
    const {targets}=reconcilePosterEvidence([JSON.parse(result.candidateJson)],2,[],{today:window.today,verifiedSameDaySources:new Set([0])});
    assert.deepEqual(targets.find(t=>t.service==='lunch')?.items,[{position:1,content:LUNCH}],name);
    assert.deepEqual(targets.find(t=>t.service==='all-day')?.items,[{position:1,content:TURKEY},{position:2,content:HAM}],name);
  }
});

// ── Pipeline ─────────────────────────────────────────────────────────────────

function setup(t,candidate=poster(offer(LUNCH,PRINTED))) {
  const f=harness(t,{now:'2026-11-03T15:36:00Z',caption:'',candidate});
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-02',week_end_date='2026-11-08' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'583672228384067_1754922809508929',created_time:'2026-11-03T15:35:04+0000',updated_time:'2026-11-03T15:35:04+0000'});
  const setLunch=(day,sql,...args)=>f.sql(`UPDATE special_slots SET ${sql} WHERE position=1 AND group_id IN
    (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=? AND service='lunch')`,...args,day);
  // Monday's priceless weekly poster already published each weekday's meal.
  for (const day of [2,3]) setLunch(day,"content=?,origin='automation',manual_locked=0,last_auto_value=?",WEEKLY,WEEKLY);
  return {...f,setLunch};
}

test('November 3: the daily poster prices an automation-owned weekly lunch and fills All Day',async t=>{
  const f=setup(t);
  await f.run();
  assert.equal(f.state.aiCalls,1);
  const lunch=f.slots(2,'lunch')[0];
  assert.equal(lunch.content,LUNCH);
  assert.equal(lunch.origin,'automation');assert.equal(lunch.last_auto_value,LUNCH);assert.equal(lunch.manual_locked,0);
  assert.deepEqual(f.slots(2,'all-day').slice(0,2).map(s=>s.content),[TURKEY,HAM]);
  assert.equal(f.slots(3,'lunch')[0].content,WEEKLY,'another weekday is untouched');
  const source=f.imports()[0];
  assert.equal(source.processing_status,'staged');assert.equal(source.validation_reason,'poster evidence v2');
  assert.equal(f.sql("SELECT count(*) n FROM special_import_events WHERE detail LIKE 'GUARDED_AUTO_CONFLICT%'")[0].n,0);
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  await f.run();
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before,'a repeated scan writes nothing');
});

test('an All Day meal printing the compact window cannot overwrite the Lunch slot end to end',async t=>{
  const raw=poster(offer(LUNCH,LUNCH));raw.offers[1]=offer(TURKEY,`${TURKEY} (11-130)`);
  const f=setup(t,raw);
  await f.run();
  assert.equal(f.slots(2,'lunch')[0].content,LUNCH);
  assert.deepEqual(f.slots(2,'all-day').slice(0,2).map(s=>s.content),[TURKEY,HAM]);
});

test('a mismatched meal stays held and keeps the priceless weekly lunch, All Day still publishes',async t=>{
  const f=setup(t,poster(offer(LUNCH,PRINTED.replace('11–130','11–230'))));
  await f.run();
  assert.equal(f.slots(2,'lunch')[0].content,WEEKLY);
  assert.deepEqual(f.slots(2,'all-day').slice(0,2).map(s=>s.content),[TURKEY,HAM]);
  assert.match(f.sql("SELECT detail FROM special_import_events WHERE detail LIKE 'GUARDED_AUTO_CONFLICT%'")[0].detail,/Meal facts differ from original evidence/);
});

test('a staff-locked lunch is never replaced by the poster or a later post; other days are unaffected',async t=>{
  const STAFF='Hoagie Sandwich With Waffle Fries and A Drink $9.50';
  const f=setup(t);
  f.setLunch(2,"content=?,origin='manual',manual_locked=1",STAFF);
  await f.run();
  assert.equal(f.slots(2,'lunch')[0].content,STAFF);
  assert.deepEqual(f.slots(2,'all-day').slice(0,2).map(s=>s.content),[TURKEY,HAM]);
  f.state.candidate=poster(offer(LUNCH.replace('9.75','10.00'),PRINTED.replace('9.75','10.00')));
  f.state.posts=[{...f.state.posts[0],id:'583672228384067_2',message:'Corrected',created_time:'2026-11-03T15:50:00+0000',updated_time:'2026-11-03T15:50:00+0000'}];
  f.state.now+=20*60000;
  await f.run();
  const lunch=f.slots(2,'lunch')[0];
  assert.equal(lunch.content,STAFF);assert.equal(lunch.manual_locked,1);assert.equal(lunch.origin,'manual');
  assert.equal(f.slots(3,'lunch')[0].content,WEEKLY);
  assert.match(f.sql("SELECT detail FROM special_import_events WHERE detail LIKE 'GUARDED_AUTO_CONFLICT%' ORDER BY id DESC")[0].detail,/Protected or ineligible destination slot/);
});
