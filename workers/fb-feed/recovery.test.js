import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {harness,poster,offer} from './test-fixture.js';
import {fixture} from '../../tests/specials-fixture.mjs';
import worker,{requeueFailedImport} from './worker.js';
import {isTransientFailure,IMPORT_RETRY_MS,IMPORT_LEASE_MS} from './recovery.js';
import {reconcileToday} from './guarded-auto.js';

const advance=f=>{f.state.now+=IMPORT_RETRY_MS;};
const row=f=>f.imports()[0];
const calls=f=>f.sql("SELECT count(*) n FROM special_import_events WHERE event_type='extract'")[0].n;
const events=f=>f.sql('SELECT * FROM special_import_events ORDER BY id');
const temporary=()=>Object.assign(new Error('temporary provider unavailable'),{status:503});
function failOnce(f) {
  const run=f.env.AI.run;let first=true;
  f.env.AI.run=async(...args)=>{if(first){first=false;f.state.aiCalls++;throw temporary();}return run(...args);};
}
function deferred() {
  let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};
}

test('transient provider failure recovers only when due; success remains idempotent',async t=>{
  const f=harness(t);failOnce(f);await f.run();
  assert.equal(row(f).processing_status,'pending');assert.equal(row(f).failure_kind,'transient_ai');
  assert.equal(row(f).retry_count,1);assert.equal(Date.parse(row(f).next_attempt_at),f.state.now+IMPORT_RETRY_MS);
  assert.equal(calls(f),1);assert.ok(f.slots().every(s=>s.content===''));
  const image=row(f).image_r2_key;
  f.state.now+=IMPORT_RETRY_MS-1;await f.run();assert.equal(f.state.aiCalls,1);
  f.state.now++;await f.run();
  assert.equal(row(f).processing_status,'staged');assert.equal(row(f).retry_count,2);
  assert.equal(row(f).image_r2_key,image);assert.equal(row(f).next_attempt_at,null);assert.equal(row(f).lease_expires_at,null);
  assert.equal(calls(f),2);assert.ok(f.slots()[0].content);
  const saved=f.slots(),audit=events(f);advance(f);await f.run();
  assert.equal(f.state.aiCalls,2);assert.deepEqual(f.slots(),saved);assert.deepEqual(events(f),audit);
});

for(const error of [Object.assign(new Error('provider throttled'),{status:429}),new TypeError('fetch failed'),new Error('ETIMEDOUT')]) {
  test(`transient error is recoverable: ${error}`,async t=>{
    const f=harness(t);const run=f.env.AI.run;
    f.env.AI.run=async()=>{f.state.aiCalls++;throw error;};await f.run();
    assert.equal(row(f).processing_status,'pending');assert.equal(row(f).validation_result,null);
    advance(f);f.env.AI.run=run;await f.run();assert.equal(row(f).processing_status,'staged');assert.equal(calls(f),2);
  });
}

test('temporary CDN failure retries using a fresh matching Graph image URL',async t=>{
  const f=harness(t);const fetch=globalThis.fetch;let fail=true;const images=[];
  t.mock.method(globalThis,'fetch',async input=>{
    if(String(input).includes('graph.facebook.com')) return fetch(input);
    images.push(String(input));return fail ? new Response('',{status:503}) : fetch(input);
  });
  await f.run();assert.equal(row(f).failure_kind,'transient_image');assert.equal(row(f).image_r2_key,null);assert.equal(calls(f),0);
  const id=row(f).id;f.state.posts[0].full_picture+='?fresh-signature=yes';fail=false;advance(f);await f.run();
  assert.equal(row(f).id,id);assert.equal(row(f).processing_status,'staged');assert.equal(calls(f),1);
  assert.match(images.at(-1),/fresh-signature/);
});

for(const operation of ['put','get']) test(`temporary R2 ${operation} failure recovers`,async t=>{
  const f=harness(t);const original=f.env.PHOTOS[operation];let fail=true;
  f.env.PHOTOS[operation]=async(...args)=>{if(fail)throw Error('R2 temporarily unavailable');return original(...args);};
  await f.run();assert.equal(row(f).processing_status,'pending');assert.equal(calls(f),0);
  fail=false;advance(f);await f.run();assert.equal(row(f).processing_status,'staged');assert.equal(calls(f),1);
});

test('missing stored image clears pointer and safely redownloads on the next attempt',async t=>{
  const f=harness(t);const get=f.env.PHOTOS.get;f.env.PHOTOS.get=async()=>null;
  await f.run();assert.equal(row(f).processing_status,'pending');assert.equal(row(f).image_r2_key,null);assert.equal(calls(f),0);
  f.env.PHOTOS.get=get;advance(f);await f.run();assert.equal(row(f).processing_status,'staged');assert.equal(calls(f),1);
});

test('expired lease is fenced before reclaim; next due attempt wins over late AI result',async t=>{
  const f=harness(t);const entered=deferred(),release=deferred();const run=f.env.AI.run;
  f.env.AI.run=async(...args)=>{f.state.aiCalls++;entered.resolve();return release.promise;};
  const abandoned=f.run();await entered.promise;const token=row(f).attempt_token;
  f.state.now+=IMPORT_LEASE_MS;await f.run();assert.equal(row(f).attempt_token,token);assert.equal(calls(f),1);
  f.state.now+=IMPORT_RETRY_MS-IMPORT_LEASE_MS;
  f.env.AI.run=run;await Promise.all([f.run(),f.run()]);
  assert.equal(row(f).retry_count,2);assert.notEqual(row(f).attempt_token,token);assert.equal(calls(f),2);
  const saved=row(f),audit=events(f),slots=f.slots();
  release.resolve({response:'unusable late response'});await abandoned;
  assert.deepEqual(row(f),saved);assert.deepEqual(events(f),audit);assert.deepEqual(f.slots(),slots);
});

test('late completion after lease expiry cannot stage evidence even before another claim',async t=>{
  const f=harness(t);const entered=deferred(),release=deferred();
  f.env.AI.run=async()=>{f.state.aiCalls++;entered.resolve();return release.promise;};
  const abandoned=f.run();await entered.promise;f.state.now+=IMPORT_LEASE_MS;
  const before=events(f);release.resolve({response:JSON.stringify(f.state.candidate)});await abandoned;
  assert.equal(row(f).processing_status,'processing');assert.equal(row(f).candidate_json,null);
  assert.deepEqual(events(f),before);assert.ok(f.slots().every(s=>s.content===''));
});

test('late R2 upload cannot overwrite recovered evidence or start another AI call',async t=>{
  const f=harness(t);const entered=deferred(),release=deferred(),put=f.env.PHOTOS.put;let first=true;
  f.env.PHOTOS.put=async(...args)=>{if(first){first=false;entered.resolve();await release.promise;}return put(...args);};
  const abandoned=f.run();await entered.promise;advance(f);await f.run();
  const saved=row(f),audit=events(f);release.resolve();await abandoned;
  assert.equal(f.state.aiCalls,1);assert.equal(saved.retry_count,2);assert.deepEqual(row(f),saved);assert.deepEqual(events(f),audit);
  assert.equal(f.state.images.size,2);assert.ok(f.state.images.has(saved.image_r2_key));
});

test('three attempts are a hard automatic limit, including AI reservations',async t=>{
  const f=harness(t);f.env.AI.run=async()=>{f.state.aiCalls++;throw temporary();};
  for(let n=1;n<=3;n++){await f.run();assert.equal(row(f).retry_count,n);advance(f);}
  assert.equal(row(f).processing_status,'failed');assert.equal(row(f).failure_kind,'exhausted');assert.equal(row(f).next_attempt_at,null);
  await f.run();assert.equal(calls(f),3);assert.equal(f.state.aiCalls,3);
});

test('crash on the last attempt is retired rather than reclaimed a fourth time',async t=>{
  const f=harness(t);failOnce(f);await f.run();
  f.sql("UPDATE special_imports SET processing_status='processing',retry_count=3,lease_expires_at=?,next_attempt_at=? WHERE id=?",
    new Date(f.state.now+IMPORT_LEASE_MS).toISOString(),new Date(f.state.now+IMPORT_RETRY_MS).toISOString(),row(f).id);
  advance(f);await f.run();assert.equal(row(f).failure_kind,'exhausted');assert.equal(row(f).processing_status,'failed');assert.equal(calls(f),1);
});

test('budget counts failures and reservations across recovery and prevents another provider call',async t=>{
  const f=harness(t);f.env.SPECIALS_AI_DAILY_LIMIT='1';failOnce(f);await f.run();advance(f);await f.run();
  assert.equal(calls(f),1);assert.equal(f.state.aiCalls,1);assert.equal(row(f).processing_status,'skipped');assert.equal(row(f).failure_kind,'budget');
});

test('crash after reservation conservatively keeps the charge and recovers without exceeding budget',async t=>{
  const f=harness(t);f.env.SPECIALS_AI_DAILY_LIMIT='1';const entered=deferred(),release=deferred();
  const prepare=f.env.DB.prepare.bind(f.env.DB);let trap=true;
  f.env.DB.prepare=sql=>{
    const stmt=prepare(sql);if(!sql.includes("SELECT ?3,'extract'"))return stmt;
    return {bind(...args){
      const bound=stmt.bind(...args);
      return {...bound,async run(){
        const result=await bound.run();if(trap){trap=false;entered.resolve();await release.promise;}return result;
      }};
    }};
  };
  const abandoned=f.run();await entered.promise;assert.equal(calls(f),1);assert.equal(f.state.aiCalls,0);
  advance(f);await f.run();assert.equal(row(f).failure_kind,'budget');
  release.resolve();await abandoned;assert.equal(f.state.aiCalls,0);assert.equal(calls(f),1);
});

for(const review of ['accepted','edited','kept','dismissed']) test(`staff review ${review} prevents recovery`,async t=>{
  const f=harness(t);failOnce(f);await f.run();f.sql('UPDATE special_imports SET review_status=? WHERE id=?',review,row(f).id);
  const saved=row(f);advance(f);await f.run();assert.deepEqual(row(f),saved);assert.equal(calls(f),1);
});

test('staff review during AI prevents completion and automatic requeue',async t=>{
  const f=harness(t);f.env.AI.run=async()=>{
    f.state.aiCalls++;f.sql("UPDATE special_imports SET review_status='dismissed' WHERE id=?",row(f).id);throw temporary();
  };
  await f.run();assert.equal(row(f).review_status,'dismissed');assert.equal(row(f).processing_status,'processing');
  advance(f);await f.run();assert.equal(calls(f),1);assert.ok(f.slots().every(s=>s.content===''));
});

test('manual slot correction between attempts wins over recovered Facebook evidence',async t=>{
  const f=harness(t);failOnce(f);await f.run();const slot=f.slots()[0];
  f.sql("UPDATE special_slots SET content='Staff correction',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",slot.group_id);
  advance(f);await f.run();assert.equal(row(f).processing_status,'staged');assert.equal(f.slots()[0].content,'Staff correction');
});

for(const hour of ['2030-01-10T02:00:00Z','2030-01-10T15:00:00Z']) test(`cutoff/no backfill at ${hour}`,async t=>{
  const f=harness(t);failOnce(f);await f.run();f.state.now=Date.parse(hour);await f.run();
  assert.equal(calls(f),1);assert.equal(row(f).failure_kind,'expired');assert.equal(row(f).processing_status,'failed');
  assert.ok(f.slots().every(s=>s.content===''));
});

test('temporary failure near closing is not retried after 8 PM',async t=>{
  const f=harness(t,{now:'2030-01-10T01:45:00Z'});failOnce(f);await f.run();advance(f);await f.run();
  assert.equal(row(f).failure_kind,'expired');assert.equal(calls(f),1);
});

for(const reply of ['invalid JSON',JSON.stringify({nonsense:true})]) test('invalid evidence is permanent after existing within-attempt retries',async t=>{
  const f=harness(t);f.env.AI.run=async()=>{f.state.aiCalls++;return {response:reply};};
  await f.run();const count=calls(f);assert.equal(row(f).failure_kind,'permanent');assert.equal(row(f).processing_status,'failed');
  advance(f);await f.run();assert.equal(calls(f),count);assert.equal(row(f).retry_count,1);
});

test('permanent provider/configuration errors and invalid images never auto-retry',async t=>{
  const f=harness(t);f.env.AI.run=async()=>{f.state.aiCalls++;throw Object.assign(new Error('unauthorized'),{status:401});};
  await f.run();advance(f);await f.run();assert.equal(calls(f),1);assert.equal(row(f).failure_kind,'permanent');
  f.state.posts=[{...f.state.posts[0],id:'bad-image'}];const fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',input=>String(input).includes('graph.facebook.com')?fetch(input):Promise.resolve(new Response('not image',{headers:{'content-type':'image/jpeg'}})));
  await f.run();const bad=f.imports().at(-1);assert.equal(bad.processing_status,'skipped');assert.equal(bad.failure_kind,'permanent');
  advance(f);await f.run();assert.equal(f.imports().at(-1).retry_count,1);assert.equal(calls(f),1);
});

test('failed Graph scan defers recovery, and edited source replaces old pending version',async t=>{
  const f=harness(t);failOnce(f);await f.run();advance(f);const fetch=globalThis.fetch;
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));await f.run();
  assert.equal(calls(f),1);assert.equal(row(f).processing_status,'pending');mock.mock.restore();
  f.state.posts[0].updated_time=new Date(f.state.now).toISOString();await f.run();
  assert.equal(f.imports().length,2);assert.equal(row(f).retry_count,1);assert.equal(f.imports()[1].processing_status,'staged');assert.equal(calls(f),2);
});

test('daily reconciliation waits for all current recoverable evidence and then detects conflict',async t=>{
  const f=harness(t,{candidate:poster(3,'Lunch Specials',[offer('Meal $9','Lunch')])});
  f.state.posts.push({...f.state.posts[0],id:'second'});let n=0;
  f.env.AI.run=async()=>{f.state.aiCalls++;if(++n===2)throw temporary();return {response:JSON.stringify(poster(3,'Lunch Specials',[offer(n===1?'Meal $9':'Meal $12','Lunch')]))};};
  await f.run();assert.equal(f.imports()[1].processing_status,'pending');assert.equal(f.slots(3,'lunch')[0].content,'');
  advance(f);await f.run();assert.equal(f.imports()[1].processing_status,'staged');assert.equal(f.slots(3,'lunch')[0].content,'');
});

test('pending source appearing during publication invalidates the transaction',async t=>{
  const f=harness(t);await f.run();const id=row(f).id;
  f.sql("UPDATE special_slots SET content='',last_auto_value=NULL WHERE group_id=?",f.slots()[0].group_id);
  f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time,processing_status) VALUES('other','other','2030-01-09T14:00:00Z','skipped')");
  const batch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{
    if(statements[0].sql.startsWith('UPDATE special_collections'))f.sql("UPDATE special_imports SET processing_status='pending' WHERE id='other'");
    return batch(statements);
  };
  const result=await reconcileToday(f.env,{sourceIds:[id,'other'],today:'2030-01-09',weekday:3});
  assert.equal(result.written,false);assert.equal(f.slots()[0].content,'');
});

test('weekly lunch recovery fills today/future days without backfilling elapsed weekdays',async t=>{
  const f=harness(t,{candidate:{type:'weekly-lunch',poster_evidence:'Weekly Lunch Specials',date_range:'1/7-1/11',service_time:'11-1:30',
    entries:[1,2,3,4,5].map(day_of_week=>({day_of_week,content:`Lunch ${day_of_week} $10`}))}});
  failOnce(f);await f.run();advance(f);await f.run();
  for(const day of [1,2])assert.equal(f.slots(day,'lunch')[0].content,'');
  for(const day of [3,4,5])assert.equal(f.slots(day,'lunch')[0].content,`Lunch ${day} $10`);
});

for(const manual of [false,true]) test(`Mexican Night recovery retains separate collection and manual protection (${manual})`,async t=>{
  const f=harness(t,{now:'2030-01-08T15:00:00Z',candidate:{type:'mexican-night',poster_evidence:'Mexican Night',schedule:'5-10 PM',groups:[{label:'Entrees',items:[{title:'Taco $5',description:'Beef'}]}]}});
  f.state.posts[0].created_time=f.state.posts[0].updated_time='2030-01-08T14:00:00Z';
  if(manual)f.sql("UPDATE special_collections SET section_source='manual' WHERE id='mexican-night'");
  failOnce(f);await f.run();advance(f);await f.run();assert.equal(row(f).processing_status,'staged');
  assert.equal(f.sql("SELECT section_source FROM special_collections WHERE id='mexican-night'")[0].section_source,manual?'manual':'facebook');
  assert.ok(f.slots(2,'nightly').every(s=>s.content===''));
});

test('scheduled feed publication succeeds while import attempt awaits recovery; public GET starts no attempt',async t=>{
  const f=harness(t);failOnce(f);f.state.posts[0].permalink_url='https://facebook.com/p1';let feed=null;
  f.env.FB_KV={get:async()=>feed,put:async(_key,value)=>{feed=JSON.parse(value);}};
  const tasks=[];await worker.scheduled({},f.env,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);
  assert.equal(feed.posts[0].id,'p1');assert.equal(row(f).processing_status,'pending');
  const before=calls(f),requests=f.state.calls.length;
  const previous=Object.getOwnPropertyDescriptor(globalThis,'caches');
  Object.defineProperty(globalThis,'caches',{configurable:true,value:{default:{match:async()=>null,put:async()=>{}}}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'caches',previous);else delete globalThis.caches;});
  const response=await worker.fetch(new Request('https://example.com/api/facebook-feed'),f.env,{waitUntil:()=>{}});
  assert.equal(response.status,200);assert.equal(calls(f),before);assert.equal(f.state.calls.length,requests);
});

test('migration preserves failed evidence/staff decisions and makes legacy claims recoverable',t=>{
  const f=fixture(t,{beforeRecoveryMigration:true});
  for(const [id,status,review] of [['active','processing','pending'],['bad','failed','pending'],['reviewed','failed','dismissed']])
    f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time,fetched_at,processing_status,review_status,last_error) VALUES(?,?,'2030-01-09T14:00:00+0000','2030-01-09T15:00:00Z',?,?,'original error')",id,id,status,review);
  const statements=readFileSync('migrations/0021_special_import_recovery.sql','utf8').split(';').filter(s=>s.trim()).map(sql=>({sql,args:[]}));
  f.execute({statements});const rows=f.sql('SELECT * FROM special_imports ORDER BY id');
  assert.equal(rows[0].retry_count,1);assert.equal(rows[0].attempt_token,'legacy:active');
  assert.equal(rows[0].lease_expires_at,'2030-01-09T15:20:00.000Z');assert.equal(rows[0].next_attempt_at,'2030-01-09T15:30:00.000Z');
  assert.equal(rows[1].processing_status,'failed');assert.equal(rows[1].last_error,'original error');assert.equal(rows[2].review_status,'dismissed');
});

test('manual requeue resets attempts only for unreviewed failed records and retains audit accounting',async t=>{
  const f=harness(t);f.env.AI.run=async()=>{f.state.aiCalls++;throw Object.assign(new Error('bad credentials'),{status:401});};
  await f.run();await requeueFailedImport(f.env,row(f).id);assert.equal(row(f).retry_count,0);assert.equal(calls(f),1);
  await f.run();f.sql("UPDATE special_imports SET review_status='dismissed' WHERE id=?",row(f).id);
  await assert.rejects(()=>requeueFailedImport(f.env,row(f).id));assert.equal(calls(f),2);
});

test('transient classification is conservative about semantic and authorization errors',()=>{
  for(const value of ['JSON Mode schema failure','invalid model','bad response','3023: Service unavailable for account','3036: Account limited',Object.assign(Error('temporarily unauthorized'),{status:403})])assert.equal(isTransientFailure(value),false);
  for(const status of [408,425,429,500,502,503,504])assert.equal(isTransientFailure({status}),true);
  for(const code of [3007,3008,3040])assert.equal(isTransientFailure({code}),true);
});
