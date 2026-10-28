import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {reconcileDelivery} from './delivery.js';
import {observeDeliveryOutcome} from './alert-outcomes.js';
import {dispatchAlert,ALERT_GRACE_MS} from './alert-store.js';

async function setup(t) {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  await DB.prepare(`CREATE TABLE special_imports(id TEXT PRIMARY KEY,fb_post_id TEXT,parser_version INTEGER,
    fb_created_time TEXT,processing_status TEXT,validation_result TEXT,review_status TEXT,
    image_r2_key TEXT,extracted_json TEXT,candidate_json TEXT)`).run();
  await DB.prepare('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)').run();
  for(const name of ['0022_delivery_automation.sql','0023_facebook_alert_incidents.sql']) {
    const sql=readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8');
    for(const stmt of sql.split(';').map(s=>s.trim()).filter(Boolean)) await DB.prepare(stmt).run();
  }
  const raw={day_of_week:4,day_evidence:'Thursday',poster_evidence:'Thursday Lunch Specials',offers:[],
    delivery:{status:'available',evidence:'Delivery available 11-1:30',date_evidence:'Thursday',uncertainties:[]}};
  await DB.prepare(`INSERT INTO special_imports VALUES('source_1','post_1',19,'2026-10-22T14:00:00Z',
    'staged','ok','pending','image',?1,?1)`).bind(JSON.stringify(raw)).run();
  let now=Date.parse('2026-10-22T15:00:00Z'),fail=false;
  t.mock.method(Date,'now',()=>now);t.mock.method(console,'error',()=>{});
  const env={SPECIALS_ALERT_MODE:'OBSERVE',SPECIALS_EVIDENCE_VERSION:'2',DB:{prepare(sql){
    const statement=DB.prepare(sql);
    if(fail && sql.startsWith('INSERT INTO delivery_automation'))return {bind(){return {async run(){throw Error('mock delivery storage failure');}};}};
    return statement;
  }}};
  const reconcile=()=>reconcileDelivery(env,{sourceIds:['source_1'],observedAt:new Date(now).toISOString()});
  return {DB,env,raw,now:()=>now,advance:ms=>now+=ms,fail:value=>fail=value,reconcile,
    run:async()=>{const o=await reconcile();await observeDeliveryOutcome(env,o);return o;},
    incident:()=>DB.prepare('SELECT * FROM facebook_alert_incidents').first(),
    change:async obj=>DB.prepare('UPDATE special_imports SET extracted_json=?1,candidate_json=?1').bind(JSON.stringify(obj)).run()};
}

test('verified delivery write failure opens incident; persistent failure dispatches one mocked notification; recovery closes',async t=>{
  const f=await setup(t);f.fail(true);
  assert.equal((await f.run()).status,'failed');assert.equal((await f.incident()).state,'attention');
  let sends=0;const options={enabled:true,now:f.now};
  assert.equal((await dispatchAlert(f.DB,async()=>sends++,options)).status,'idle');
  f.advance(ALERT_GRACE_MS);await f.run();
  await Promise.all(Array.from({length:5},()=>dispatchAlert(f.DB,async()=>sends++,options)));assert.equal(sends,1);
  f.fail(false);f.advance(1);assert.equal((await f.run()).status,'published');assert.equal((await f.incident()).state,'resolved');
  assert.equal((await f.DB.prepare('SELECT active FROM delivery_automation').first()).active,1);
});

test('successful recovery before grace suppresses failure including delayed stale outcome',async t=>{
  const f=await setup(t);f.fail(true);const failed=await f.run();
  f.advance(1);f.fail(false);await f.run();await observeDeliveryOutcome(f.env,failed);
  assert.equal((await f.incident()).state,'resolved');f.advance(ALERT_GRACE_MS);
  assert.equal((await dispatchAlert(f.DB,async()=>assert.fail('recovered'),{enabled:true,now:f.now})).status,'idle');
});

test('same-scan successful write wins over a failure with the same timestamp',async t=>{
  const f=await setup(t);f.fail(true);const failed=await f.run();f.fail(false);await f.run();
  await observeDeliveryOutcome(f.env,failed);assert.equal((await f.incident()).state,'resolved');
});

test('failed refresh when matching delivery is already active is not an outage',async t=>{
  const f=await setup(t);await f.run();f.advance(1000);f.fail(true);await f.run();
  assert.equal(await f.incident(),null);
});

test('no evidence, cancellation and ambiguity are correctly hidden, never failures',async t=>{
  const f=await setup(t);
  for(const status of ['none','cancelled','ambiguous']) {
    f.advance(1000);await f.change({...f.raw,delivery:{...f.raw.delivery,status,evidence:status==='cancelled'?'No delivery today':''}});
    const o=await f.run();assert.ok(['hidden','withheld'].includes(o.status));assert.equal(await f.incident(),null);
    assert.equal((await f.DB.prepare('SELECT active FROM delivery_automation').first()).active,0);
  }
});

test('pending retries and retained failed records do not invent affirmative delivery',async t=>{
  const f=await setup(t);
  for(const status of ['pending','processing','failed']) {
    await f.DB.prepare('UPDATE special_imports SET processing_status=?1').bind(status).run();f.advance(1000);
    await f.run();assert.equal(await f.incident(),null);
  }
});

test('manual overrides suppress incidents and stale setting/source snapshots are rejected',async t=>{
  const f=await setup(t);f.fail(true);await f.run();f.advance(1);const failed=await f.reconcile();
  await f.DB.prepare("INSERT INTO settings VALUES('delivery_display','hidden')").run();
  await observeDeliveryOutcome(f.env,failed);assert.equal((await f.incident()).state,'suppressed');
  f.advance(1000);const stale=await f.reconcile();
  await f.DB.prepare("UPDATE special_imports SET review_status='dismissed'").run();
  await observeDeliveryOutcome(f.env,stale);assert.equal((await f.incident()).observed_ms,Date.parse(failed.observedAt));
});

test('source edit between reconciliation and incident persistence rejects the observation atomically',async t=>{
  const f=await setup(t);f.fail(true);const o=await f.reconcile();
  await f.change({...f.raw,delivery:{...f.raw.delivery,status:'cancelled',evidence:'No delivery today'}});
  await observeDeliveryOutcome(f.env,o);assert.equal(await f.incident(),null);
});

test('newer source version and delayed previous success cannot clear a current incident',async t=>{
  const f=await setup(t);const success=await f.reconcile();
  await f.DB.prepare(`INSERT INTO special_imports SELECT 'source_2',fb_post_id,parser_version,fb_created_time,
    processing_status,validation_result,review_status,image_r2_key,extracted_json,candidate_json FROM special_imports`).run();
  await observeDeliveryOutcome(f.env,success);assert.equal(await f.incident(),null);
});

test('duplicate scans losing the delivery write fence report superseded, not failure',async t=>{
  const f=await setup(t);await f.run();assert.equal((await f.run()).status,'superseded');assert.equal(await f.incident(),null);
});

test('1:30 PM, midnight and OFF mode do not create delivery incidents',async t=>{
  const f=await setup(t);f.env.SPECIALS_ALERT_MODE='OFF';f.fail(true);await f.run();assert.equal(await f.incident(),null);
  f.env.SPECIALS_ALERT_MODE='OBSERVE';f.advance(5*60*60*1000);assert.equal((await f.run()).status,'expired');assert.equal(await f.incident(),null);
  f.advance(9*60*60*1000);assert.equal((await f.run()).expectedActive,false);assert.equal(await f.incident(),null);
});

test('missing alert table is isolated from successful delivery publication',async t=>{
  const f=await setup(t);await f.DB.prepare('DROP TABLE facebook_alert_incidents').run();
  assert.equal((await f.run()).status,'published');
  assert.equal((await f.DB.prepare('SELECT active FROM delivery_automation').first()).active,1);
});
