import assert from 'node:assert/strict';
import test from 'node:test';
import {harness,poster,offer} from './test-fixture.js';
import {reconcileToday} from './guarded-auto.js';
import {validateEvidence,WEEKDAY_ENCODING_MISMATCH} from './reconcile.js';
import {extractionPrompt} from './extraction.js';
const pizza='16" 3-Topping Pizza & 12 Wings $30';
const hawaiian='Crispy Hawaiian - Crispy chicken with ham, swiss cheese and pineapple, with side salad, chili or coleslaw $10.25';
const sandwich='Chicken Salad Sandwich with cup of Chili or Coleslaw $7.25';
const western='Western Burger with Side Salad, Chili or Coleslaw $10.25';
function sunday(t) {
  const f=harness(t,{now:'2026-09-27T15:00:00Z',caption:'',candidate:poster(0,'Sunday Specials 11am-10pm',[offer(pizza),offer(hawaiian),offer(sandwich)])});
  f.sql("UPDATE weekly_specials SET week_start_date='2020-09-21',week_end_date='2020-09-27' WHERE week_start_date='2026-09-21'");
  f.sql("UPDATE weekly_specials SET week_start_date='2026-09-21',week_end_date='2026-09-27' WHERE id=9000");
  f.state.posts[0].created_time=f.state.posts[0].updated_time='2026-09-27T13:40:54Z';
  for(const [service,position,content] of [['lunch',1,pizza],['all-day',1,western],['all-day',2,sandwich]])
    f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=0 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=0 AND service=?) AND position=?",content,service,position);
  return f;
}
const calls=f=>f.sql("SELECT count(*) n FROM special_import_events WHERE event_type='extract'")[0].n;

const mondayNightItems=[
  '2 Burgers and 1 Order of Fries – $14',
  'Half Rack Ribs with Mac n Cheese & Coleslaw – $18.75',
  'California Burger with Side Salad – $10.25',
  'Chicken Salad Sandwich with Coleslaw – $7.25',
];
const mondayNight=day=>({...poster(day,'MONDAY NIGHT SPECIALS',mondayNightItems.map(s=>offer(s))),day_evidence:'MONDAY'});
function monday(t,candidate=mondayNight(0)) {
  const f=harness(t,{now:'2030-01-07T23:00:00Z',caption:'',candidate});
  f.state.posts[0].created_time=f.state.posts[0].updated_time='2030-01-07T20:00:00Z';
  return f;
}
const retries=f=>f.sql("SELECT detail FROM special_import_events WHERE event_type='retry'");

test('Monday production mismatch retries once and publishes Nightly while preserving repeated All Day',async t=>{
  const f=monday(t,poster(1,'Monday Specials',[
    offer('Lunch meal $9','Lunch'),...mondayNightItems.slice(2).map(s=>offer(s,'All Day')),
  ]));
  await f.run();
  const established=f.slots(1,'all-day');
  assert.deepEqual(established.slice(0,2).map(s=>s.content),mondayNightItems.slice(2));
  f.state.posts=[{...f.state.posts[0],id:'monday-night'}];
  const requests=[];
  f.env.AI.run=async(_model,request)=>{
    requests.push(structuredClone(request));f.state.aiCalls++;
    return {response:JSON.stringify(mondayNight(requests.length===1?0:1))};
  };
  const before=calls(f);
  await f.run();
  assert.equal(requests.length,2);assert.equal(calls(f)-before,2);
  assert.deepEqual(requests[0],requests[1]);
  assert.deepEqual(f.slots(1,'nightly').map(s=>s.content),[...mondayNightItems.slice(0,2),'','']);
  assert.deepEqual(f.slots(1,'all-day'),established);
  assert.equal(f.imports().at(-1).validation_result,'ok');
  assert.equal(JSON.parse(f.imports().at(-1).extracted_json).day_of_week,1);
  assert.deepEqual(retries(f),[{detail:`Weekday encoding mismatch retry: ${WEEKDAY_ENCODING_MISMATCH}`}]);
  await f.run();assert.equal(requests.length,2);
});

test('persistent Monday encoding mismatch fails closed after exactly two calls',async t=>{
  const f=monday(t);await f.run();
  assert.equal(f.state.aiCalls,2);assert.equal(calls(f),2);assert.equal(retries(f).length,1);
  assert.equal(f.imports()[0].validation_result,'rejected');
  assert.equal(f.imports()[0].validation_reason,WEEKDAY_ENCODING_MISMATCH);
  assert.equal(f.imports()[0].candidate_json,null);
  assert.equal(JSON.parse(f.imports()[0].extracted_json).day_of_week,0);
  for(const service of ['lunch','nightly','all-day']) assert.ok(f.slots(1,service).every(s=>s.content===''));
});

test('consistent Tuesday / 2 on Wednesday is rejected without retry or coercion',async t=>{
  const f=harness(t,{candidate:poster(2,'Tuesday Specials',[
    offer('Lunch $9','Lunch'),offer('Burger $10','All Day'),offer('Sandwich $7','All Day'),
  ])});
  await f.run();assert.equal(f.state.aiCalls,1);assert.equal(calls(f),1);
  assert.deepEqual(retries(f),[]);
  for(const day of [2,3]) for(const service of ['lunch','nightly','all-day'])
    assert.ok(f.slots(day,service).every(s=>s.content===''));
});

test('unknown weekday retains publication behavior without mismatch retry',async t=>{
  const contents=['Lunch $9','Burger $10','Sandwich $7'];
  const f=harness(t,{candidate:{day_of_week:-1,day_evidence:'',poster_evidence:'Specials',offers:contents.map(s=>offer(s))}});
  await f.run();assert.equal(f.state.aiCalls,1);assert.equal(calls(f),1);
  assert.deepEqual(retries(f),[]);assert.equal(f.imports()[0].validation_result,'ok');
  assert.equal(f.slots(3,'lunch')[0].content,contents[0]);
  assert.deepEqual(f.slots(3,'all-day').slice(0,2).map(s=>s.content),contents.slice(1));
});

test('weekday consistency validator checks all seven full names without rewriting input',()=>{
  for(const [day,name] of ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].entries()) {
    const candidate={...mondayNight(day),day_evidence:name.toUpperCase()};
    assert.equal(validateEvidence(candidate).day_of_week,day);
    candidate.day_of_week=(day+1)%7;
    assert.throws(()=>validateEvidence(candidate),{message:WEEKDAY_ENCODING_MISMATCH});
    assert.equal(candidate.day_of_week,(day+1)%7);
  }
  assert.throws(()=>validateEvidence({...mondayNight(-1),day_evidence:'Monday'}),{message:WEEKDAY_ENCODING_MISMATCH});
});

test('multiple or absent explicit weekday names do not trigger encoding retry',async t=>{
  for(const day_evidence of ['Monday Tuesday','', 'Mon']) {
    const f=monday(t,{...mondayNight(0),day_evidence});
    await f.run();assert.equal(f.state.aiCalls,1);assert.deepEqual(retries(f),[]);
    assert.ok(f.slots(1,'nightly').every(s=>s.content===''));
  }
});

test('daily prompt specifies the complete weekday mapping and unknown-day rule',()=>{
  assert.ok(extractionPrompt('').includes('0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.'));
  assert.match(extractionPrompt(''),/Use -1 and empty day_evidence only if no weekday is visible/);
});
test('exact Sunday image-only poster replaces unlocked Western Burger and maps all three offers',async t=>{
  const f=sunday(t);await f.run();
  assert.equal(f.slots(0,'lunch')[0].content,pizza);
  assert.deepEqual(f.slots(0,'all-day').slice(0,2).map(s=>s.content),[hawaiian,sandwich]);
  assert.equal(f.slots(0,'all-day')[0].last_auto_value,hawaiian);
  assert.equal(f.imports()[0].validation_result,'ok');
});
for(const origin of ['manual','legacy']) test(`Sunday ${origin} locked correction remains protected`,async t=>{
  const f=sunday(t);const slot=f.slots(0,'all-day')[0];
  f.sql('UPDATE special_slots SET origin=?,manual_locked=1 WHERE group_id=? AND position=1',origin,slot.group_id);
  await f.run();assert.equal(f.slots(0,'all-day')[0].content,western);
});
test('Sunday retry uses identical full instructions and schema and counts two actual calls',async t=>{
  const f=sunday(t);const requests=[];
  f.env.AI.run=async(_model,request)=>{requests.push(structuredClone(request));return {choices:[{message:{content:requests.length===1?'not JSON':JSON.stringify(f.state.candidate)}}]};};
  await f.run();assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
  assert.match(requests[1].messages[1].content[0].text,/For a weekly schedule/);
  assert.equal(calls(f),2);assert.equal(f.slots(0,'all-day')[0].content,hawaiian);
  await f.run();assert.equal(requests.length,2);
});
test('one remaining AI call prevents retry, including across later pipeline runs',async t=>{
  const f=sunday(t);f.env.SPECIALS_AI_DAILY_LIMIT='1';
  f.env.AI.run=async()=>{f.state.aiCalls++;return {response:'prose'};};
  await f.run();assert.equal(f.state.aiCalls,1);assert.equal(calls(f),1);
  f.state.posts[0].updated_time='2026-09-27T14:45:00Z';
  await f.run();assert.equal(f.state.aiCalls,1);assert.equal(f.imports().at(-1).processing_status,'skipped');
});
test('schema error retries once, retains failure reason and counts both invocations',async t=>{
  const f=sunday(t);f.env.AI.run=async()=>{f.state.aiCalls++;throw Error("JSON Mode couldn't be met");};
  await f.run();assert.equal(f.state.aiCalls,2);assert.equal(calls(f),2);
  assert.match(f.imports()[0].last_error,/JSON Mode/);assert.equal(f.slots(0,'all-day')[0].content,western);
});
test('pending current-day reprocessing uses shared retry contract without resetting budget',async t=>{
  const f=sunday(t);await f.run();const id=f.imports()[0].id;
  f.sql("UPDATE special_imports SET processing_status='pending',processed_at=NULL WHERE id=?",id);
  const requests=[];f.env.AI.run=async(_model,request)=>{requests.push(structuredClone(request));return {response:requests.length===1?'bad':f.state.candidate};};
  await f.run();assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(calls(f),3);
});
test('prior-day pending row is ignored with no inference or publication',async t=>{
  const f=sunday(t);await f.run();const id=f.imports()[0].id;
  f.sql("UPDATE special_imports SET processing_status='pending',processed_at=NULL,fb_created_time='2026-09-26T15:00:00Z' WHERE id=?",id);
  f.state.posts=[];const before=f.state.aiCalls;await f.run();
  assert.equal(f.state.aiCalls,before);assert.equal(f.imports()[0].processing_status,'pending');
});
test('reconciler independently rejects stale evidence even when handed its id',async t=>{
  const f=sunday(t);await f.run();const id=f.imports()[0].id;
  f.sql("UPDATE special_imports SET fb_created_time='2026-09-20T15:00:00Z' WHERE id=?",id);
  const slot=f.slots(0,'all-day')[0];f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=0,last_auto_value=NULL WHERE group_id=? AND position=1",western,slot.group_id);
  await reconcileToday(f.env,{sourceIds:[id],today:'2026-09-27',weekday:0});
  assert.equal(f.slots(0,'all-day')[0].content,western);
});
test('missing R2 object does not count as an AI invocation',async t=>{
  const f=sunday(t);f.env.PHOTOS.get=async()=>null;await f.run();
  assert.equal(calls(f),0);assert.equal(f.state.aiCalls,0);assert.equal(f.imports()[0].processed_at,null);
});
test('overlong Sunday content fails closed without a semantic retry',async t=>{
  const f=sunday(t);f.state.candidate.offers[1].content='x'.repeat(151);await f.run();
  assert.equal(f.state.aiCalls,1);assert.equal(f.imports()[0].validation_result,'rejected');assert.equal(f.slots(0,'all-day')[0].content,western);
});


test('current-week lunch evidence fills today and future days but never elapsed weekdays',async t=>{
  const f=harness(t,{candidate:{type:'weekly-lunch',poster_evidence:'Weekly Lunch Specials',date_range:'1/7-1/11',service_time:'11-1:30',entries:[1,2,3,4,5].map(day_of_week=>({day_of_week,content:`Lunch ${day_of_week} $10`}))}});
  await f.run();
  for(const day of [1,2]) assert.equal(f.slots(day,'lunch')[0].content,'');
  for(const day of [3,4,5]) assert.equal(f.slots(day,'lunch')[0].content,`Lunch ${day} $10`);
});
