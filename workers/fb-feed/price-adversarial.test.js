import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEvidence,reconcilePosters} from './reconcile.js';
import {reconcileToday} from './guarded-auto.js';
import {harness,offer,poster} from './test-fixture.js';
import {PARSER_VERSION} from './classify.js';

const lunch=(content='Fish sandwich',service_time='$9.75',evidence=content)=>poster(5,'Friday Lunch Specials',[offer(content,evidence,service_time)]);
const input={today:'2030-01-11',weekday:5};
const setup=t=>harness(t,{now:'2030-01-11T15:00:00Z',caption:'Friday Lunch Specials',candidate:lunch()});
function stage(f,id,candidate,{failed=false}={}) {
  const raw=typeof candidate==='string' ? candidate : JSON.stringify(candidate);
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,parser_version,image_r2_key,candidate_json,extracted_json,processing_status,validation_result)
    VALUES(?,?,'2030-01-11T14:00:00Z',?,'special-imports/test.jpg',?,?,?,?)`,id,id,PARSER_VERSION,failed?null:raw,raw,failed?'failed':'staged',failed?'rejected':'ok');
}
const audit=f=>f.sql("SELECT * FROM special_import_events WHERE event_type='review' ORDER BY id");
const revision=f=>f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision;

for (const time of [
  '$9.75-10.25','$9.75–10.25','$9.75–$10.25','$9.75 - $10.25','-$9.75','- $9.75',
  '$9.75/10.25','$9.75 / $10.25','$9.75 10.25','$9.750','$9.75foo','$9.75.2','$9.75,25',
  '$9.75-11 AM - 1:30 PM','$9.75 99-99','$9.75 (11 AM - 99 PM)','$9.75 10-11','−$9.75',
]) test(`price parser rejects complete ambiguous input: ${time}`,()=>{
  const p=lunch('Fish sandwich',time);
  assert.throws(()=>validateEvidence(p),/price/);
  assert.deepEqual(reconcilePosters([p],5),[]);
});
for (const [time,price,remaining] of [
  ['$10.25','$10.25',''],['$.99','$.99',''],['$ 10.25','$10.25',''],
  ['(11 AM - 1:30 PM) $9.75','$9.75','(11 AM - 1:30 PM)'],
  ['11am–1:30pm $9.75','$9.75','11am–1:30pm'],
  ['$9.75 Lunch 11 AM - 1:30 PM','$9.75','Lunch 11 AM - 1:30 PM'],
]) test(`unambiguous price and complete time survive: ${time}`,()=>{
  const normalized=validateEvidence(lunch('Fish sandwich',time));
  assert.equal(normalized.offers[0].content,`Fish sandwich ${price}`);
  assert.equal(normalized.offers[0].service_time,remaining);
  assert.deepEqual(validateEvidence(normalized),normalized);
  assert.deepEqual(reconcilePosters([lunch('Fish sandwich',time)],5),[{day_of_week:5,service:'lunch',items:[{content:`Fish sandwich ${price}`}]}]);
});
test('existing correct price is not duplicated, and multiple existing prices are never rewritten',()=>{
  const p=lunch('Fish $10.25','$10.25');
  assert.equal(validateEvidence(p).offers[0].content,'Fish $10.25');
  for (const content of ['Small Fish $9.75 Large Fish $10.25','Fish $9.75 / $9.75','Fish $9.75-10.25','Fish -$9.75','Fish $9.75.2']) {
    assert.throws(()=>validateEvidence(lunch(content,'$9.75')),/price/);
  }
  const multi=lunch('Small Fish $9.75 Large Fish $10.25','Lunch');
  assert.equal(validateEvidence(multi).offers[0].content,multi.offers[0].content);
});
for (const evidence of [
  'Add fries $2','Side salad $2','Fish sandwich upcharge $2','Substitute fries $2',
  'Fish sandwich discount $2','Upgrade to large $2','Small $2','Modifier $2',
  'Fish sandwich with optional side $2','Extra sauce $2','Fries $2','','$2',
  'Fish sandwich -$2','Fish sandwich $2-3','Fish sandwich −$2','Fish sandwich +$2',
]) test(`detached or ambiguous evidence cannot price the meal: ${JSON.stringify(evidence)}`,()=>{
  assert.throws(()=>validateEvidence(lunch('Fish sandwich','$2',evidence)),/price/);
  assert.deepEqual(reconcilePosters([lunch('Fish sandwich','$2',evidence)],5),[]);
});
test('matching whole-meal evidence can include its price and normal included sides',()=>{
  const content='Fish sandwich with side salad';
  assert.equal(validateEvidence(lunch(content,'$10.25',`${content} $10.25`)).offers[0].content,`${content} $10.25`);
});
test('numbered side-only evidence remains unresolved even when it matches extracted content',()=>{
  assert.throws(()=>validateEvidence(lunch('2) Side salad','$2','2) Side salad')),/price/);
});
test('exact Astra conflicting sources cannot manufacture agreement after rejecting source B',()=>{
  const a=lunch('Fish $9.75','Lunch'),b=lunch('Fish $10.25','Lunch $11.25');
  assert.deepEqual(reconcilePosters([a,b],5),[]);
  assert.deepEqual(reconcilePosters([b,a],5),[]);
});
test('even a non-contradictory malformed source cannot establish agreement with a valid source',()=>{
  const a=lunch('Fish $9.75','Lunch'),b=lunch('Fish $9.75','Lunch $9.750');
  assert.deepEqual(reconcilePosters([a,b],5),[]);
});
for (const [name,b] of [
  ['normalization rejected',lunch('Fish $10.25','Lunch $11.25')],
  ['valid but conflicting',lunch('Fish $10.25','Lunch')],
  ['malformed but matching',lunch('Fish $9.75','Lunch $9.750')],
  ['unparseable JSON','not JSON'],
]) test(`staged ${name} source blocks writes and leaves deduplicated source audit`,async t=>{
  const f=setup(t);stage(f,'a',lunch('Fish $9.75','Lunch'));stage(f,'b',b);
  const before=f.sql('SELECT * FROM special_slots');
  const result=await reconcileToday(f.env,{...input,sourceIds:['a','b']});
  assert.equal(result.written,false);assert.deepEqual(f.sql('SELECT * FROM special_slots'),before);
  assert.ok(result.rejectedSources.some(r=>r.source_id==='b' && r.reason));
  for (const id of ['a','b']) {
    const events=audit(f).filter(e=>e.import_id===id);
    assert.match(events[0].detail,/no publication; CONFLICT/);
    assert.match(events.at(-1).detail,/GUARDED_AUTO_CONFLICT:.*rejected sources:.*"source_id":"b"/);
  }
  const events=audit(f),rev=revision(f);
  await reconcileToday(f.env,{...input,sourceIds:['a','b']});
  assert.deepEqual(audit(f),events);assert.equal(revision(f),rev);
});
test('newly failed normalization participates in current-day agreement without AI retries',async t=>{
  const f=setup(t);
  f.state.posts[0].created_time=f.state.posts[0].updated_time='2030-01-11T14:00:00Z';
  f.state.posts.push({...f.state.posts[0],id:'second'});
  const candidates=[lunch('Fish $9.75','Lunch'),lunch('Fish $10.25','Lunch $11.25')];
  f.env.AI.run=async()=>({response:JSON.stringify(candidates[f.state.aiCalls++])});
  await f.run();assert.equal(f.state.aiCalls,2);
  assert.equal(f.imports()[1].processing_status,'failed');
  assert.equal(f.slots(5,'lunch')[0].content,'');
  assert.match(audit(f).at(-1).detail,/Conflicting offer price/);
  const events=audit(f),rev=revision(f);await f.run();
  assert.equal(f.state.aiCalls,2);assert.equal(revision(f),rev);assert.deepEqual(audit(f),events);
});
test('failed-source snapshot race prevents conflict audit and revision claim',async t=>{
  const f=setup(t);stage(f,'a',lunch('Fish $9.75','Lunch'));stage(f,'b',lunch('Fish $10.25','Lunch $11.25'),{failed:true});
  const batch=f.env.DB.batch;
  f.env.DB.batch=statements=>{
    f.sql("UPDATE special_imports SET extracted_json='changed during reconciliation' WHERE id='b'");
    return batch(statements);
  };
  assert.equal((await reconcileToday(f.env,{...input,sourceIds:['a','b']})).written,false);
  assert.equal(revision(f),0);assert.deepEqual(audit(f),[]);assert.equal(f.slots(5,'lunch')[0].content,'');
});
test('valid dedicated weekly evidence does not poison daily reconciliation',()=>{
  const weekly={type:'weekly-lunch',poster_evidence:'Weekly Lunch Specials',entries:[]};
  assert.deepEqual(reconcilePosters([lunch('Fish $9.75','Lunch'),weekly],5),reconcilePosters([lunch('Fish $9.75','Lunch')],5));
});
test('failed daily source never publishes using stale valid candidate data',async t=>{
  const f=setup(t);stage(f,'a',lunch('Fish $9.75','Lunch'));stage(f,'b',lunch('Fish $9.75','Lunch'),{failed:true});
  f.sql('UPDATE special_imports SET candidate_json=? WHERE id=?',JSON.stringify(lunch('Fish $9.75','Lunch')),'b');
  const result=await reconcileToday(f.env,{...input,sourceIds:['a','b']});
  assert.equal(result.written,false);assert.equal(f.slots(5,'lunch')[0].content,'');
  assert.ok(result.rejectedSources.some(r=>r.source_id==='b'));
});
test('wrong dedicated type cannot conceal invalid daily offers',()=>{
  const b={...lunch('Fish $10.25','Lunch $11.25'),type:'weekly-lunch'};
  assert.deepEqual(reconcilePosters([lunch('Fish $9.75','Lunch'),b],5),[]);
});
