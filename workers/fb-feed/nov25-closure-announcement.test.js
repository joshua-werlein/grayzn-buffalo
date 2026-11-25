// November 25 2026 (Wednesday). The 8:36 AM Wednesday Specials poster
// (583672228384067_1780934790241064) published All Day (2) and Lunch (1). The
// 1:13 PM closure poster (583672228384067_1781190773548799) printed only
// "WE ARE CLOSED THANKSGIVING DAY 11/26": no meals, no specials wording. Its
// import was correctly held ("Printed calendar date does not match current
// Chicago date"), but the daily reconciler then re-raised that stored failure as
// a blocking rejected source: a daily "date check" correction alert was sent and
// every later daily write that day would have been held. Production D1 was not
// readable from this session; the transcriptions below follow the posters and
// the contract-2 prompt (heading in poster_evidence, no offers on a closure).
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';
import {reconcileToday} from './guarded-auto.js';
import {planDailyEvidence} from './evidence.js';
import {validateCurrentDay,canonicalizeSlotContent} from './reconcile.js';

const SPECIALS='CAPTION-NOV25-SPECIALS',CLOSURE='CAPTION-NOV25-CLOSURE';
const offer=(content,service_time='')=>({content,evidence:content,service_time,service_evidence:service_time,date_evidence:'',uncertainties:[]});
const daily=(poster_evidence,offers,day_of_week=3,day_evidence='Wednesday')=>({evidence_version:2,day_of_week,day_evidence,poster_evidence,
  delivery:{status:'none',evidence:'',date_evidence:'',uncertainties:[]},offers});
const wednesday=daily('WEDNESDAY SPECIALS',[
  offer('Loaded Chicken Mac N Cheese Bowl and a Drink $9.75','11-1:30'),
  offer('Olive Burger with Side Salad, Chili or Coleslaw $10.25'),
  offer('Grilled Ham & Cheese with Cup of Chili or Coleslaw $7.25')]);
const closure=daily("GRAYZ'N BUFFALO BAR & GRILL WE ARE CLOSED THANKSGIVING DAY 11/26",[],-1,'');

function setup(t,closureReading=closure) {
  const f=harness(t,{now:'2026-11-25T19:20:00Z',candidate:wednesday});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-23',week_end_date='2026-11-29' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'583672228384067_1780934790241064',message:SPECIALS,
    created_time:'2026-11-25T14:36:00Z',updated_time:'2026-11-25T14:36:00Z'});
  f.state.posts.push({...f.state.posts[0],id:'583672228384067_1781190773548799',message:CLOSURE,
    created_time:'2026-11-25T19:13:00Z',updated_time:'2026-11-25T19:13:00Z',full_picture:'https://cdn.example/closure.jpg'});
  f.env.AI.run=async(_model,request)=>{
    f.state.aiCalls++;
    return {response:JSON.stringify(request.messages[1].content[0].text.includes(CLOSURE)?closureReading:wednesday)};
  };
  return f;
}
const values=f=>[...f.slots(3,'lunch').slice(0,1),...f.slots(3,'all-day').slice(0,2)].map(s=>s.content);

test('a future-dated closure announcement is excluded: it neither blocks nor alerts the daily specials',async t=>{
  const f=setup(t);
  await f.run();
  const held=f.imports().find(i=>i.fb_post_id.endsWith('1781190773548799'));
  // The import-level date safeguard still holds the announcement itself.
  assert.equal(held.processing_status,'failed');
  assert.equal(held.validation_reason,'Printed calendar date does not match current Chicago date');
  assert.deepEqual(values(f),['Loaded Chicken Mac N Cheese Bowl and a Drink $9.75',
    'Olive Burger with Side Salad, Chili or Coleslaw $10.25','Grilled Ham & Cheese with Cup of Chili or Coleslaw $7.25']);
  const r=await reconcileToday(f.env,{sourceIds:f.imports().map(i=>i.id),today:'2026-11-25',weekday:3,inspectOnly:true});
  assert.deepEqual(r.rejectedSources,[]);
  assert.ok(r.excludedSourceIds.includes(held.id));
});

test('a corrected specials post later the same day still publishes beside the closure announcement',async t=>{
  const f=setup(t);
  await f.run();
  f.state.now=Date.parse('2026-11-25T19:40:00Z');
  f.state.posts.push({...f.state.posts[0],id:'583672228384067_9999',message:`${SPECIALS} corrected`,
    created_time:'2026-11-25T19:35:00Z',updated_time:'2026-11-25T19:35:00Z',full_picture:'https://cdn.example/fix.jpg'});
  const corrected=daily('WEDNESDAY SPECIALS',[...wednesday.offers.slice(0,2),offer('Grilled Ham & Cheese with Cup of Chili or Coleslaw $7.50')]);
  const run=f.env.AI.run;
  f.env.AI.run=async(model,request)=>request.messages[1].content[0].text.includes('corrected')
    ? (f.state.aiCalls++,{response:JSON.stringify(corrected)}) : run(model,request);
  await f.run();
  assert.equal(f.slots(3,'all-day')[1].content,'Grilled Ham & Cheese with Cup of Chili or Coleslaw $7.50');
});

// Planner level: only positive other-day evidence excludes a non-specials poster.
const plan=candidate=>planDailyEvidence([candidate],3,{today:'2026-11-25',validateDay:validateCurrentDay,canonicalize:canonicalizeSlotContent});
test('planner: an offerless announcement is excluded only by printed other-day evidence',()=>{
  assert.deepEqual(plan(closure).excludedSources,[{index:0,reason:'Printed calendar date does not match current Chicago date'}]);
  assert.deepEqual(plan(daily('WE ARE CLOSED THANKSGIVING DAY THURSDAY',[],4,'Thursday')).excludedSources.map(e=>e.reason),
    ['Printed weekday does not match current Chicago day']);
  // Today-dated, undated or self-contradictory announcements are not proven to be
  // elsewhere; they keep the existing behavior (skipped here, stored failure applies).
  for(const c of [daily('HAPPY THANKSGIVING 11/25',[],-1,''),daily('HAVE A SAFE AND HAPPY THANKSGIVING',[],-1,''),
    daily('CLOSED EARLY',[],4,'Wednesday')]) {
    const r=plan(c);
    assert.deepEqual([r.excludedSources,r.rejectedSources,r.targets],[[],[],[]]);
  }
});
