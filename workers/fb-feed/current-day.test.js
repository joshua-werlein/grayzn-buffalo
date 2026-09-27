import assert from 'node:assert/strict';
import test from 'node:test';
import {harness,poster,offer} from './test-fixture.js';
import {reconcileToday} from './guarded-auto.js';
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
