import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {runImportPipeline,requeueFailedImport,validateExtraction} from './worker.js';
import {beginAlertScan,finishAlertScan,dispatchVerifiedAlerts,revalidateAlert,readAlertHealth} from './alert-runtime.js';
import {ALERT_GRACE_MS,dispatchAlert} from './alert-store.js';
import {reconcileToday} from './guarded-auto.js';
import {emailTransport,alertTransport,alertMessage} from './alert-email.js';
import {imageAlertDetail} from './alert-detail.js';

function setup(t) {
  let db;t.after(()=>db?.close());
  const f=harness(t);
  db=new DatabaseSync(f.path);
  db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT); INSERT OR REPLACE INTO settings VALUES('delivery_display','auto');");
  for(const name of ['0022_delivery_automation.sql','0023_facebook_alert_incidents.sql','0024_facebook_alert_evidence.sql']) db.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  const DB={prepare(query) {
    const statement={sql:query,args:[],bind(...args){this.args=args;return this;},
      values(){return Object.fromEntries(this.args.map((v,i)=>[String(i+1),v]));},
      async first(){return db.prepare(query).get(this.values())??null;},
      async all(){return {results:db.prepare(query).all(this.values())};},
      async run(){return {meta:{changes:Number(db.prepare(query).run(this.values()).changes)}};}};
    return statement;
  },async batch(statements) {
    db.exec('BEGIN');
    try {
      const result=statements.map(s=>{
        const q=db.prepare(s.sql),values=s.values();
        if(/^\s*SELECT/i.test(s.sql)) return {results:q.all(values),meta:{changes:0}};
        return {results:[],meta:{changes:Number(q.run(values).changes)}};
      });db.exec('COMMIT');return result;
    } catch(e) {db.exec('ROLLBACK');throw e;}
  }};
  f.env.DB=DB;f.env.SPECIALS_ALERT_MODE='MOCK';
  const sent=[];
  return {...f,db,DB,sent,run:()=>runImportPipeline(f.env,{send:async m=>sent.push(m)}),
    advance:ms=>f.state.now+=ms,
    row:()=>db.prepare("SELECT * FROM facebook_alert_incidents WHERE scope='daily'").get(),
    all:()=>db.prepare('SELECT * FROM facebook_alert_incidents').all(),
    send:()=>dispatchVerifiedAlerts(f.env,{send:async m=>sent.push(m)})};
}
const permanent=f=>{f.env.AI.run=async()=>{throw Object.assign(Error('private-provider-detail'),{status:400});};};
async function failure(t) {const f=setup(t);permanent(f);await f.run();assert.equal(f.row()?.state,'attention');return f;}

async function october30HeldOffer(t) {
  const f=setup(t);
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.state.now=Date.parse('2026-10-30T15:12:40Z');
  f.state.candidate=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct30-daily-specials.json',import.meta.url),'utf8'));
  // A genuine remaining uncertainty must still alert after heading recognition.
  f.state.candidate.offers[1].uncertainties=['Side alternatives are unclear'];
  Object.assign(f.state.posts[0],{message:'',created_time:'2026-10-30T15:11:07Z',updated_time:'2026-10-30T15:11:07Z'});
  f.db.exec("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  // A staff correction recorded after the 15:11 post: that post never undoes it.
  f.db.prepare("UPDATE special_slots SET content=?,origin='manual',manual_locked=1,manual_edited_at='2026-10-30T15:12:00.000Z' WHERE group_id=? AND position=2")
    .run(f.state.candidate.offers[2].content,f.slots(5,'all-day')[0].group_id);
  await f.run();
  assert.equal(f.row()?.state,'attention');
  assert.equal(f.slots(5,'all-day')[0].content,'');
  assert.equal(f.slots(5,'all-day')[1].manual_locked,1);
  assert.equal(f.sent.length,0);
  return f;
}

test('October 30: an unresolved extracted offer stays alertable after the full grace period',async t=>{
  const f=await october30HeldOffer(t);
  f.advance(ALERT_GRACE_MS-1);await f.send();assert.equal(f.sent.length,0);
  f.advance(1);await f.send();assert.equal(f.sent.length,1);
  await f.send();assert.equal(f.sent.length,1);
});

test('October 30: audited staff correction before grace suppresses the held-offer email',async t=>{
  const f=await october30HeldOffer(t);
  f.advance(6*60000);
  const rows=f.state.candidate.offers.map((o,index)=>({index,service:index===0?'lunch':'all-day',
    groupId:f.slots(5,index===0?'lunch':'all-day')[0].group_id,position:index===2?2:1,content:o.content,sectionLink:''}));
  // Approval writes each row as a staff edit stamped with the approval time.
  for(const row of rows) f.db.prepare("UPDATE special_slots SET content=?,origin='manual',manual_locked=1,manual_edited_at=? WHERE group_id=? AND position=?")
    .run(row.content,new Date(f.state.now).toISOString(),row.groupId,row.position);
  const source=f.imports()[0];
  f.db.prepare("INSERT INTO special_import_events(import_id,event_type,detail) VALUES(?,'review',?)")
    .run(source.id,'STAFF_APPROVAL:'+JSON.stringify({version:1,day:'2026-10-30',complete:true,rows}));
  f.db.prepare("UPDATE special_imports SET review_status='accepted' WHERE id=?").run(source.id);
  f.db.exec("UPDATE special_collections SET revision=revision+1 WHERE id='auto-week'");
  await f.send();assert.equal(f.sent.length,0,'the saved staff change invalidates old dispatch proof immediately');
  // The website now shows exactly the approved source values: nothing is held, so the
  // outcome is resolved (formerly a suppressed staff-lock hold). No email either way.
  f.advance(12*60000);await f.run();assert.equal(f.row().state,'resolved');
  f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,0);
  assert.equal(f.slots(5,'all-day')[0].content,f.state.candidate.offers[1].content);
});

test('Worker: successful import, repeated cron and read-only assessment are silent',async t=>{
  const f=setup(t);await f.run();f.advance(ALERT_GRACE_MS);await f.run();
  assert.equal(f.all().length,0);assert.equal(f.sent.length,0);
  const before=f.db.prepare('SELECT * FROM special_slots ORDER BY group_id,position').all();
  await reconcileToday(f.env,{sourceIds:f.imports().map(s=>s.id),today:'2030-01-09',weekday:3,inspectOnly:true});
  assert.deepEqual(f.db.prepare('SELECT * FROM special_slots ORDER BY group_id,position').all(),before);
});

test('Worker: permanent extraction failure observes grace, sends once and groups the cause',async t=>{
  const f=await failure(t);assert.equal(f.sent.length,0);
  assert.equal(JSON.parse(f.row().proof_json).cause,'validation_rejected');
  f.advance(ALERT_GRACE_MS);await f.run();await f.run();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].code,'validation_rejected');
  assert.equal(f.all().length,1);
  assert.ok(!JSON.stringify(f.all()).includes('private-provider-detail'));
  assert.ok(!JSON.stringify(f.sent).includes('private-provider-detail'));
});

test('Worker: budget exhaustion is actionable only for explicit current specials',async t=>{
  const f=setup(t);f.env.SPECIALS_AI_DAILY_LIMIT='0';await f.run();
  assert.equal(f.imports()[0].failure_kind,'budget');assert.equal(JSON.parse(f.row().proof_json).cause,'ai_budget_exhausted');
  f.advance(ALERT_GRACE_MS);await f.run();assert.equal(f.sent[0].code,'ai_budget_exhausted');
});

test('Worker: permanent image acquisition failure is distinct from no eligible posts',async t=>{
  const f=setup(t),fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async url=>new URL(url).hostname==='graph.facebook.com'?fetch(url):new Response('',{status:404}));
  await f.run();assert.equal(JSON.parse(f.row().proof_json).cause,'import_failed');
  f.advance(ALERT_GRACE_MS);await f.run();assert.equal(f.sent.length,1);
});

test('Worker: transient extraction retries stay pending until retries exhaust',async t=>{
  const f=setup(t);f.env.AI.run=async()=>{throw Object.assign(Error('temporary'),{status:503});};
  await f.run();assert.equal(f.imports()[0].processing_status,'pending');assert.equal(f.all().length,0);
  f.advance(31*60000);await f.run();assert.equal(f.all().length,0);
  f.advance(31*60000);await f.run();assert.equal(f.imports()[0].failure_kind,'exhausted');
  assert.equal(JSON.parse(f.row().proof_json).cause,'retry_exhausted');assert.equal(f.sent.length,0);
  f.advance(ALERT_GRACE_MS);await f.run();assert.equal(f.sent.length,1);
});

test('Worker: unknown image, old-day caption, weekly and Mexican sources do not invent daily terminal failures',async t=>{
  const f=setup(t);permanent(f);
  for(const caption of ['Hello friends','Tuesday Night Specials','Weekly Lunch Specials','Mexican Night',
    'Next Wednesday Night Specials','Wednesday Night Specials tomorrow','Wednesday Night Specials 2030-01-16']) {
    f.state.posts[0].message=caption;f.advance(1);await f.run();
    // An explicit weekly lunch or Mexican Night caption with a permanent extraction
    // failure is an incident in its own scope, never a daily terminal failure.
    assert.deepEqual(f.all().filter(r=>r.state==='attention' && !r.scope.startsWith('image_')).map(r=>r.scope),
      caption==='Weekly Lunch Specials'?['weekly']:caption==='Mexican Night'?['mexican']:[]);
    assert.equal(f.all().filter(r=>r.state==='attention' && r.scope.startsWith('image_')).length,caption==='Hello friends'?1:0,caption);
    assert.equal(f.sent.length,0);
  }
});

test('Worker: recovery before dispatch resolves original failure and keeps successful publication',async t=>{
  const f=await failure(t);
  f.db.exec("UPDATE special_imports SET processing_status='pending',retry_count=0,next_attempt_at=NULL");
  f.env.AI.run=async()=>({response:JSON.stringify(f.state.candidate)});
  f.advance(1000);await f.run();assert.equal(f.row().state,'resolved');
  f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,0);
  assert.match(f.slots()[0].content,/Wing/);
});

test('Worker: removed source suppresses the old incident after a complete empty scan',async t=>{
  const f=await failure(t);f.state.posts=[];f.advance(1);await f.run();
  assert.equal(f.row().state,'suppressed');f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,0);
});

for(const change of ['source','review','slot','revision','delivery']) test(`durable proof rejects later ${change} changes without a new Worker run`,async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);
  if(change==='source') f.db.exec("UPDATE special_imports SET caption='changed'");
  if(change==='review') f.db.exec("UPDATE special_imports SET review_status='dismissed'");
  if(change==='slot') f.db.exec("UPDATE special_slots SET content='Staff correction',manual_locked=1 WHERE group_id='auto-default-3-nightly'");
  if(change==='revision') f.db.exec('UPDATE special_collections SET revision=revision+1');
  if(change==='delivery') f.db.exec("UPDATE settings SET value='hidden' WHERE key='delivery_display'");
  // Fixture group IDs can vary; ensure the slot mutation actually changed rows.
  if(change==='slot') f.db.exec("UPDATE special_slots SET manual_locked=1 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id='auto-week')");
  assert.equal(await revalidateAlert(f.env,f.row()),false);await f.send();assert.equal(f.sent.length,0);
});

test('a newer incomplete Graph scan invalidates old proof and cannot signal recovery',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);
  await beginAlertScan(f.env,'2030-01-09');assert.equal(await revalidateAlert(f.env,f.row()),false);
  await f.send();assert.equal(f.sent.length,0);assert.equal(f.row().state,'attention');
});

test('concurrent verified dispatch claims send exactly once',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);
  await Promise.all(Array.from({length:8},()=>f.send()));assert.equal(f.sent.length,1);
});

test('mock email error quarantines uncertainty without changing import or exposing exception details',async t=>{
  const f=await failure(t),before=f.imports();f.advance(ALERT_GRACE_MS);
  await dispatchVerifiedAlerts(f.env,{send:async()=>{throw Error('secret-address@example.com');}});
  assert.equal(f.row().last_error,'send_failed');assert.deepEqual(f.imports(),before);
  await f.send();assert.equal(f.sent.length,0);f.advance(5*60000);await f.send();assert.equal(f.sent.length,0);
  assert.equal(f.row().dispatch_state,'uncertain');
});

test('same-day sent recurrence stays deduplicated',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,1);
  f.db.exec("UPDATE special_imports SET review_status='dismissed'");f.advance(1);await f.run();
  f.db.exec("UPDATE special_imports SET review_status='pending'");f.advance(1);await f.run();
  f.advance(ALERT_GRACE_MS);await f.run();assert.equal(f.sent.length,1);
});

test('service close, midnight and stale completed scans cannot dispatch',async t=>{
  const f=await failure(t);f.advance(91*60000);assert.equal(await revalidateAlert(f.env,f.row()),false);
  f.state.now=Date.parse('2030-01-10T02:00:00Z');await f.send();assert.equal(f.sent.length,0);
  f.state.now=Date.parse('2030-01-10T06:00:00Z');await f.send();assert.equal(f.sent.length,0);
});

test('proof expiring during revalidation cannot cross the final dispatch boundary',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);
  const expires=JSON.parse(f.row().proof_json).expires_ms;
  const result=await dispatchAlert(f.DB,async()=>assert.fail('expired proof'),{enabled:true,requireProof:true,
    revalidate:async row=>{assert.equal(await revalidateAlert(f.env,row),true);f.state.now=expires;return true;}});
  assert.equal(result.status,'superseded');assert.equal(f.row().sent_ms,null);
});

test('older concurrent scan cannot replace the newer complete outcome',async t=>{
  const f=await failure(t),older=await beginAlertScan(f.env,'2030-01-09');f.advance(1);
  const newer=await beginAlertScan(f.env,'2030-01-09');
  await finishAlertScan(f.env,newer,f.imports().map(s=>s.id));
  await finishAlertScan(f.env,older,[]);
  assert.equal(JSON.parse(f.row().proof_json).token,newer.token);assert.equal(f.row().state,'attention');
});

test('missing alert migration cannot alter food publication',async t=>{
  const f=setup(t);f.db.exec('DROP TABLE facebook_alert_scans');await f.run();
  assert.match(f.slots()[0].content,/Wing/);assert.equal(f.sent.length,0);
});

test('unsent recurrence after a staff resolution restarts the full grace',async t=>{
  const f=await failure(t);f.advance(20*60000);
  f.db.exec("UPDATE special_imports SET review_status='dismissed'");await f.run();
  f.advance(1);f.db.exec("UPDATE special_imports SET review_status='pending'");await f.run();
  f.advance(11*60000);await f.send();assert.equal(f.sent.length,0);
  f.advance(19*60000);await f.run();assert.equal(f.sent.length,1);
});

test('daily persistence failure preserves queue retry and creates a verified publication incident',async t=>{
  const f=setup(t),batch=f.DB.batch;
  f.DB.batch=async statements=>{
    if(statements.some(s=>s.sql.includes('UPDATE special_collections SET revision=revision+1,mutation_token'))) throw Error('mock write failure');
    return batch(statements);
  };
  await assert.rejects(f.run(),/mock write failure/);
  assert.equal(f.row().state,'attention');assert.equal(f.imports()[0].processing_status,'staged');
  f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,1);
  f.DB.batch=batch;f.advance(1);await f.run();assert.equal(f.row().state,'resolved');
  assert.match(f.slots()[0].content,/Wing/);
});

test('delivery failure is independent of successful food; recovery and staff hide are silent',async t=>{
  const f=setup(t);f.state.candidate.delivery={status:'available',evidence:'Delivery available 11-1:30',date_evidence:'Wednesday',uncertainties:[]};
  const prepare=f.DB.prepare;let fail=true;
  f.DB.prepare=query=>fail && query.startsWith('INSERT INTO delivery_automation')
    ? {bind(){return {async run(){throw Error('mock delivery persistence');}};}}:prepare(query);
  await f.run();assert.match(f.slots()[0].content,/Wing/);
  assert.equal(f.row(),undefined);assert.equal(f.all()[0]?.code,'delivery_failed');
  f.advance(ALERT_GRACE_MS);await f.run();assert.equal(f.sent.length,1);
  fail=false;f.advance(1);await f.run();assert.equal(f.all()[0].state,'resolved');
  f.db.exec("UPDATE settings SET value='hidden' WHERE key='delivery_display'");
  fail=true;f.advance(1);await f.run();assert.equal(f.all()[0].state,'suppressed');assert.equal(f.sent.length,1);
});

test('version skew: verified delivery assessment accepts the legacy deadline but reports an unknown deadline',async t=>{
  const f=setup(t);
  f.state.candidate.delivery={status:'available',evidence:'Delivery available 11-1:30',date_evidence:'Wednesday',uncertainties:[]};
  await f.run();
  f.db.exec("UPDATE delivery_automation SET expires_at='2030-01-09T21:00:00.000Z'");
  f.advance(1);
  const inspect=async()=>finishAlertScan(f.env,await beginAlertScan(f.env,'2030-01-09'),f.imports().map(s=>s.id));
  await inspect();
  assert.equal(f.all().length,0);assert.equal(f.sent.length,0);
  f.db.exec("UPDATE delivery_automation SET expires_at='2030-01-09T22:00:00.000Z'");
  f.advance(1);await inspect();
  assert.equal(f.all()[0].scope,'delivery');assert.equal(f.all()[0].state,'attention');
  f.advance(ALERT_GRACE_MS);await f.send();
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].detail.delivery.visibility,'hidden');
  assert.equal(f.sent[0].detail.delivery.compatible,false);
});

test('hidden delivery and cancellation never create a delivery incident',async t=>{
  const f=setup(t);f.state.candidate.delivery={status:'cancelled',evidence:'No delivery today',date_evidence:'Wednesday',uncertainties:[]};
  await f.run();assert.ok(!f.all().some(r=>r.scope==='delivery'));assert.equal(f.sent.length,0);
});

test('October 21 retained failed raw evidence recovers under durable revalidation with one Lunch',async t=>{
  const f=setup(t),fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct21-production.json',import.meta.url),'utf8'));
  const raw=JSON.parse(fixture[0].results[0].extracted_json);
  f.state.now=Date.parse('2026-10-21T21:00:00Z');f.state.posts[0].created_time='2026-10-21T14:00:00Z';
  f.state.posts[0].message='Wednesday Lunch Specials';f.state.candidate=raw;
  f.db.exec("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
  f.env.SPECIALS_EVIDENCE_VERSION='2';f.env.SPECIALS_IMPORT_MODE='DRY_RUN';await f.run();
  const bad=structuredClone(raw);bad.entries[1].content=bad.entries[1].content.replace('10.25','11.25');
  f.db.prepare("UPDATE special_imports SET processing_status='failed',validation_result='rejected',candidate_json=NULL,extracted_json=?").run(JSON.stringify(bad));
  f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';f.advance(1);await f.run();assert.equal(f.row().state,'attention');
  f.db.prepare('UPDATE special_imports SET extracted_json=?').run(JSON.stringify(raw));f.advance(1);await f.run();
  assert.equal(f.row().state,'resolved');assert.equal(f.imports()[0].processing_status,'failed');
  assert.equal(f.slots(3,'lunch').filter(s=>s.content).length,1);
  f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,0);
});

test('health counts distinguish missing heartbeat, incomplete scan, unresolved failure and transport failure',async t=>{
  const f=setup(t);assert.deepEqual({...await readAlertHealth(f.env)}, {last_completed_ms:null,last_scan_completed_ms:null,
    incomplete_scans:0,pending_evaluations:0,failed_evaluations:0,skipped_evaluations:0,uncertain_sends:0,actionable:0,send_failures:0});
  permanent(f);await f.run();f.advance(ALERT_GRACE_MS);
  await dispatchVerifiedAlerts(f.env,{send:async()=>{throw Error('mock');}});
  const health=await readAlertHealth(f.env);assert.equal(health.actionable,1);assert.equal(health.send_failures,1);assert.ok(health.last_completed_ms);
  await beginAlertScan(f.env,'2030-01-09');assert.equal((await readAlertHealth(f.env)).incomplete_scans,1);
});

async function localD1(t,f) {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  const tables=f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  for(const table of tables) await DB.prepare(table.sql).run();
  const inserts=[DB.prepare('PRAGMA defer_foreign_keys=ON')];
  for(const {name} of tables) for(const row of f.db.prepare(`SELECT * FROM ${name}`).all()) {
    const keys=Object.keys(row);
    inserts.push(DB.prepare(`INSERT INTO ${name} (${keys.join(',')}) VALUES (${keys.map((_,i)=>'?'+(i+1)).join(',')})`).bind(...Object.values(row)));
  }
  await DB.batch(inserts);
  for(const {sql} of f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'facebook_alert_%'").all()) await DB.prepare(sql).run();
  return DB;
}

test('real local D1: durable proof, concurrent dispatch, and later staff edit',async t=>{
  const f=await failure(t),DB=await localD1(t,f);
  f.env.DB=DB;f.advance(ALERT_GRACE_MS);
  assert.equal(await revalidateAlert(f.env,f.row()),true);
  await Promise.all(Array.from({length:5},()=>dispatchAlert(DB,async m=>f.sent.push(m),{
    enabled:true,requireProof:true,revalidate:row=>revalidateAlert(f.env,row,{withEvidence:true})})));
  assert.equal(f.sent.length,1);
  await DB.prepare("UPDATE special_imports SET review_status='dismissed'").run();
  assert.equal(await revalidateAlert(f.env,f.row()),false);
});

test('real local D1: committed dismissal after validation fences the atomic authorization',async t=>{
  const f=await failure(t),DB=await localD1(t,f);f.advance(ALERT_GRACE_MS);let edited=false;
  f.env.DB={batch:statements=>DB.batch(statements),prepare(query){
    const s=DB.prepare(query);
    if(!query.includes("SET dispatch_state='uncertain'")) return s;
    return {bind(...args){const bound=s.bind(...args);return {async first(){
      await DB.prepare("UPDATE special_imports SET review_status='dismissed'").run();edited=true;
      return bound.first();
    }};}};
  }};
  await f.send();assert.equal(edited,true);assert.equal(f.sent.length,0);
  const incident=await DB.prepare('SELECT dispatch_state,authorized_ms FROM facebook_alert_incidents').first();
  assert.equal(incident.dispatch_state,'ready');assert.equal(incident.authorized_ms,null);
});

test('real local D1: snapshot fences preserve successful imports, row-change guards and staff locks',async t=>{
  const f=setup(t),DB=await localD1(t,f);f.env.DB=DB;
  const changed=await DB.prepare("UPDATE settings SET value='auto' WHERE key='delivery_display'").run();
  assert.equal(changed.meta.changes,1);
  await f.run();
  const rows=await DB.prepare("SELECT * FROM special_slots WHERE content<>''").all();
  assert.ok(rows.results.some(s=>/Wing/.test(s.content)));
  const slot=rows.results.find(s=>/Wing/.test(s.content));
  await DB.prepare("UPDATE special_slots SET content='Staff correction',manual_locked=1 WHERE group_id=?1 AND position=?2").bind(slot.group_id,slot.position).run();
  f.advance(1);await f.run();
  const saved=await DB.prepare('SELECT content,manual_locked FROM special_slots WHERE group_id=?1 AND position=?2').bind(slot.group_id,slot.position).first();
  assert.equal(saved.content,'Staff correction');assert.equal(saved.manual_locked,1);assert.equal(f.sent.length,0);
});

test('disabled and unapproved email configuration performs no provider calls',async t=>{
  let calls=0;const binding={send:async()=>{calls++;return {messageId:'mock'};}};
  for(const mode of ['OFF','OBSERVE','MOCK','EMAIL']) {
    assert.equal(emailTransport({SPECIALS_ALERT_MODE:mode,ALERT_EMAIL:binding}),null);
  }
  assert.equal(calls,0);
});

test('email adapter uses fixed plain text and validated configuration, with mocked native binding',async()=>{
  const messages=[];
  const env={SPECIALS_ALERT_MODE:'EMAIL',SPECIALS_ALERT_EMAIL_APPROVED:'true',SPECIALS_ALERT_FROM:'alerts@example.com',
    SPECIALS_ALERT_TO:'owner@example.com',ALERT_EMAIL:{send:async m=>{messages.push(m);return {messageId:'mock'};}}};
  await emailTransport(env)({day:'2030-01-09',code:'retry_exhausted',message:'untrusted content',signal:new AbortController().signal});
  assert.equal(messages.length,1);assert.ok(!messages[0].text.includes('untrusted'));assert.ok(!('html' in messages[0]));
  assert.equal(emailTransport({...env,SPECIALS_ALERT_TO:'owner@example.com\r\nBcc: attacker@example.com'}),null);
  await assert.rejects(emailTransport({...env,ALERT_EMAIL:{send:async()=>({})}})({day:'2030-01-09',code:'import_failed'}));
});

// Fake credentials only; the example recipient is deliberately not approved.
const resendEnv={SPECIALS_ALERT_MODE:'EMAIL',SPECIALS_ALERT_EMAIL_APPROVED:'true',SPECIALS_ALERT_PROVIDER:'RESEND',
  SPECIALS_ALERT_FROM:'alerts@grayznbuffalo.com',SPECIALS_ALERT_TO:'owner@example.com',ALERT_RESEND_API_KEY:'re_fakeTestKey_000000000000'};
for(const [name,overrides] of [
  ['unapproved recipient',{}],
  ['missing API key',{ALERT_RESEND_API_KEY:undefined}],
  ['unapproved sender',{SPECIALS_ALERT_FROM:'noreply@grayznbuffalo.com'}],
  ['unknown provider',{SPECIALS_ALERT_PROVIDER:'SENDGRID'}],
]) test(`Resend ${name} is unconfigured before any incident is claimed, with no fallback`,async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);let native=0;
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('network disabled');});
  Object.assign(f.env,resendEnv,overrides,{ALERT_EMAIL:{send:async()=>{native++;return {messageId:'native'};}}});
  assert.deepEqual(await dispatchVerifiedAlerts(f.env),{status:'unconfigured'});
  assert.equal(fetch.mock.callCount(),0);assert.equal(native,0);
  assert.equal(f.row().dispatch_state,'ready');assert.equal(f.row().attempts,0);assert.equal(f.row().authorized_ms,null);
});

test('alerts OFF and OBSERVE with complete Resend configuration never reach the provider',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('network disabled');});
  for(const mode of [undefined,'OFF','OBSERVE']) {
    Object.assign(f.env,resendEnv,{SPECIALS_ALERT_MODE:mode});
    assert.deepEqual(await dispatchVerifiedAlerts(f.env),{status:'disabled'});
  }
  Object.assign(f.env,{SPECIALS_ALERT_MODE:'EMAIL',SPECIALS_ALERT_EMAIL_APPROVED:'false'});
  assert.deepEqual(await dispatchVerifiedAlerts(f.env),{status:'unconfigured'});
  assert.equal(fetch.mock.callCount(),0);assert.equal(f.row().dispatch_state,'ready');assert.equal(f.row().attempts,0);
});

// Interleave a committed business edit after hashing/reassessment, immediately
// before the final atomic authorization statement (the original preflight race).
function beforeAuthorization(f,action) {
  const prepare=f.DB.prepare;let changed=false;
  f.DB.prepare=query=>{
    if(!changed && query.includes("SET dispatch_state='uncertain'")) {changed=true;action();}
    return prepare(query);
  };
  return ()=>changed;
}

for(const [name,sql] of [
  ['staff dismissal',"UPDATE special_imports SET review_status='dismissed'"],
  ['staff slot lock',"UPDATE special_slots SET manual_locked=1"],
  ['import recovery',"UPDATE special_imports SET processing_status='pending'"],
  ['delivery override',"UPDATE settings SET value='hidden' WHERE key='delivery_display'"],
  ['week edit',"UPDATE weekly_specials SET week_end_date='2030-01-12'"],
  ['collection edit',"UPDATE special_collections SET revision=revision+1"],
  ['group edit',"UPDATE special_groups SET enabled=0"],
  ['delivery outcome',"INSERT OR REPLACE INTO delivery_automation VALUES(1,'2030-01-09',0,'2030-01-09T21:00:00.000Z','2030-01-09T15:00:00.000Z','[]')"],
  ['migration guard',"UPDATE special_migration_checks SET mismatches=mismatches+1"],
  ['source deletion',"DELETE FROM special_imports"],
]) test(`atomic authorization rejects ${name} committed after revalidation`,async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);
  const changed=beforeAuthorization(f,()=>f.db.exec(sql));
  await f.send();assert.equal(changed(),true);assert.equal(f.sent.length,0);
  assert.equal(f.row().dispatch_state,'ready');assert.equal(f.row().authorized_ms,null);
});

test('newer Worker scan committed before authorization prevents the old send',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);
  beforeAuthorization(f,()=>f.db.exec("UPDATE facebook_alert_scans SET token='new-worker',completed_ms=NULL,evaluation_state='pending',evaluated_ms=NULL"));
  await f.send();assert.equal(f.sent.length,0);assert.equal(f.row().dispatch_state,'ready');
});

test('staff change after authorization cannot recall provider invocation but never causes resend',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);let calls=0;
  await dispatchVerifiedAlerts(f.env,{send:async()=>{
    assert.equal(f.row().dispatch_state,'uncertain');
    f.db.exec("UPDATE special_imports SET review_status='dismissed'");calls++;
  }});
  assert.equal(calls,1);assert.equal(f.row().dispatch_state,'sent');
  f.advance(1);await f.run();assert.equal(f.row().state,'suppressed');assert.equal(f.sent.length,0);
});

test('native mocked send remains single across lease expiry and does not block Worker completion',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);let calls=0,accept;
  Object.assign(f.env,{SPECIALS_ALERT_MODE:'EMAIL',SPECIALS_ALERT_EMAIL_APPROVED:'true',
    SPECIALS_ALERT_FROM:'alerts@example.com',SPECIALS_ALERT_TO:'owner@example.com',
    ALERT_EMAIL:{send:()=>{calls++;return new Promise(resolve=>{accept=resolve;});}}});
  const before=f.imports();
  await runImportPipeline(f.env,{timeoutMs:10});
  assert.equal(calls,1);assert.equal(f.row().dispatch_state,'uncertain');
  assert.equal((await readAlertHealth(f.env)).uncertain_sends,1);
  assert.deepEqual(f.imports(),before);
  f.advance(5*60000+1);await runImportPipeline(f.env,{timeoutMs:10});
  assert.equal(calls,1);
  accept({messageId:'mock-accepted'});await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.row().dispatch_state,'sent');
});

for(const stage of ['snapshot','assessment','persistence']) test(`failed ${stage} cannot publish a healthy evaluation heartbeat`,async t=>{
  const f=setup(t);await f.run();f.advance(1);
  const context=await beginAlertScan(f.env,'2030-01-09');
  const batch=f.DB.batch,prepare=f.DB.prepare;
  if(stage==='snapshot') f.DB.batch=async()=>{throw Error('private snapshot detail');};
  if(stage==='assessment') f.DB.prepare=query=>{
    // reconcileToday uses a direct all() read; snapshot uses the batch API.
    const s=prepare(query);
    if(query.includes('weekly_specials')) s.all=async()=>{throw Error('private assessment detail');};
    return s;
  };
  if(stage==='persistence') f.DB.batch=async statements=>{
    if(statements.some(s=>s.sql.includes('INSERT INTO facebook_alert_incidents'))) {
      // Force a SQL error inside the transaction after the first statement.
      return batch([statements[0],prepare('INSERT INTO nonexistent_alert_test_table VALUES(1)'),...statements.slice(1)]);
    }
    return batch(statements);
  };
  await finishAlertScan(f.env,context,f.imports().map(s=>s.id));
  const health=await readAlertHealth(f.env);
  assert.equal(health.last_completed_ms,null);assert.equal(health.last_scan_completed_ms,f.state.now);
  assert.equal(health.failed_evaluations,1);assert.equal(health.pending_evaluations,0);
  assert.equal(f.all().length,0);assert.equal(f.sent.length,0);
  assert.equal(f.db.prepare('SELECT evaluation_error FROM facebook_alert_scans').get().evaluation_error,'evaluation_failed');
});

test('incident persistence failure rolls back an actionable observation and successful evaluation together',async t=>{
  const f=await failure(t),batch=f.DB.batch;
  const old=f.row();f.advance(1);const context=await beginAlertScan(f.env,'2030-01-09');
  f.DB.batch=async statements=>statements.some(s=>s.sql.includes('INSERT INTO facebook_alert_incidents'))
    ? batch([statements[0],f.DB.prepare('INSERT INTO nonexistent_alert_test_table VALUES(1)'),...statements.slice(1)]) : batch(statements);
  await finishAlertScan(f.env,context,f.imports().map(s=>s.id));
  assert.deepEqual(f.row(),old);assert.equal((await readAlertHealth(f.env)).failed_evaluations,1);
  f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,0);
});

test('total D1 write outage leaves pending health, never a false success, and later evaluation recovers',async t=>{
  const f=setup(t),context=await beginAlertScan(f.env,'2030-01-09'),prepare=f.DB.prepare;
  f.DB.prepare=query=>{const s=prepare(query);s.run=async()=>{throw Error('D1 writes unavailable');};return s;};
  await finishAlertScan(f.env,context,[]);
  let health=await readAlertHealth(f.env);
  assert.equal(health.last_completed_ms,null);assert.equal(health.pending_evaluations,1);assert.equal(health.incomplete_scans,1);
  f.DB.prepare=prepare;await finishAlertScan(f.env,context,[]);
  health=await readAlertHealth(f.env);assert.equal(health.pending_evaluations,0);assert.equal(health.last_completed_ms,f.state.now);
  assert.equal(health.actionable,0);
});

for(const reason of ['outside_window','evidence_changed']) test(`early ${reason} return is durably skipped, not healthy`,async t=>{
  const f=setup(t),context=await beginAlertScan(f.env,'2030-01-09');
  if(reason==='outside_window') f.state.now=Date.parse('2030-01-10T02:00:00Z');
  await finishAlertScan(f.env,context,reason==='evidence_changed'?['missing-source']:[]);
  const row=f.db.prepare('SELECT * FROM facebook_alert_scans').get();
  assert.equal(row.evaluation_state,'skipped');assert.equal(row.evaluation_error,reason);assert.equal(row.evaluated_ms,null);
  assert.equal((await readAlertHealth(f.env)).last_completed_ms,null);
});

test('business mutation immediately before evaluation persistence cannot certify old outcomes',async t=>{
  const f=await failure(t),old=f.row(),batch=f.DB.batch;f.advance(1);
  const context=await beginAlertScan(f.env,'2030-01-09');
  f.DB.batch=async statements=>{
    if(statements.some(s=>s.sql.includes('INSERT INTO facebook_alert_incidents'))) f.db.exec("UPDATE special_imports SET review_status='dismissed'");
    return batch(statements);
  };
  await finishAlertScan(f.env,context,f.imports().map(s=>s.id));
  assert.deepEqual(f.row(),old);assert.equal((await readAlertHealth(f.env)).skipped_evaluations,1);
});

test('uncertain sends survive retention and remain visible after business recovery and day rollover',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);
  await dispatchVerifiedAlerts(f.env,{send:async()=>{throw Error('ambiguous');}});
  f.db.exec("UPDATE facebook_alert_incidents SET incident_key='2029-12-01:daily:publication_blocked',day='2029-12-01',observed_ms=0,state='resolved'");
  f.state.posts=[]; // No current-day observation can refresh the retained row.
  f.advance(1);await f.run();
  assert.equal(f.all().length,1);assert.equal(f.row().dispatch_state,'uncertain');
  assert.equal((await readAlertHealth(f.env,Date.parse('2030-02-09T16:00:00Z'))).uncertain_sends,1);
});

test('rolled-back staff changes do not invalidate the current business snapshot',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);
  beforeAuthorization(f,()=>f.db.exec("BEGIN; UPDATE special_imports SET review_status='dismissed'; ROLLBACK;"));
  await f.send();assert.equal(f.sent.length,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'facebook_alert_%'").get().n,0);
});

test('newer source inserted after revalidation invalidates the previously current source',async t=>{
  const f=await failure(t);f.advance(ALERT_GRACE_MS);
  beforeAuthorization(f,()=>{
    const source=f.imports()[0],keys=Object.keys(source);
    f.db.prepare(`INSERT INTO special_imports (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`)
      .run(...keys.map(k=>k==='id'?source.id+'-new':source[k]));
  });
  await f.send();assert.equal(f.sent.length,0);assert.equal(f.row().dispatch_state,'ready');
});

const imageIncidents=f=>f.all().filter(r=>r.scope.startsWith('image_'));
function imageFailure(t,{exhaust=false}={}) {
  const f=setup(t);f.state.posts[0].message='';
  f.env.AI.run=async()=>{throw exhaust?Error('AiError: 8005: Internal server error'):Object.assign(Error('private-provider-detail'),{status:401});};
  return f;
}
test('November 8: captionless terminal image failure creates a technical incident, honors grace and sends once',async t=>{
  const f=imageFailure(t);await f.run();assert.equal(imageIncidents(f).length,1);
  assert.equal(imageIncidents(f)[0].state,'attention');assert.equal(imageIncidents(f)[0].code,'automation_failed');
  assert.equal(f.sent.length,0);f.advance(ALERT_GRACE_MS-1);await f.send();assert.equal(f.sent.length,0);
  f.advance(1);await Promise.all([f.send(),f.send()]);assert.equal(f.sent.length,1);
  const m=alertMessage(f.sent[0].day,f.sent[0].code,f.sent[0]);
  assert.match(m.text,/Image contents.*unverified/i);assert.match(m.text,/AI extraction/);assert.match(m.text,/Staff attention: required/);
  assert.match(m.text,/#import-/);assert.ok(!m.text.includes('private-provider-detail'));assert.ok(!m.text.includes('Wing Night'));
  await f.run();await f.send();assert.equal(f.sent.length,1);
});
test('November 8: recoverable image errors stay silent until exhaustion, then recovery resolves the same incident',async t=>{
  const f=imageFailure(t,{exhaust:true});const successful=f.state.candidate;
  for(let i=0;i<3;i++) {await f.run();assert.equal(imageIncidents(f).length,i<2?0:1);if(i<2)f.advance(30*60000);}
  assert.equal(imageIncidents(f)[0].state,'attention');assert.equal(f.sent.length,0);
  f.db.exec("UPDATE special_imports SET processing_status='pending',retry_count=0,next_attempt_at=NULL");
  f.env.AI.run=async()=>({response:JSON.stringify(successful)});f.advance(1);await f.run();
  assert.equal(imageIncidents(f)[0].state,'resolved');f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,0);
});
test('November 8: successful unrelated image and ambiguous extraction never create technical incidents',async t=>{
  const f=setup(t);f.state.posts[0].message='';f.state.candidate={day_of_week:-1,day_evidence:'',poster_evidence:'',offers:[]};
  await f.run();assert.deepEqual(imageIncidents(f),[]);
  f.state.posts[0].updated_time='2030-01-09T14:01:00Z';f.env.AI.run=async()=>({response:'not valid JSON'});f.advance(1);await f.run();
  assert.deepEqual(imageIncidents(f),[]);
});
test('November 8: dismissed or removed failed image suppresses its unsent technical alert',async t=>{
  const f=imageFailure(t);await f.run();assert.equal(imageIncidents(f)[0].state,'attention');
  f.db.exec("UPDATE special_imports SET review_status='dismissed'");f.advance(1);await f.run();
  assert.equal(imageIncidents(f)[0].state,'suppressed');f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,0);
  f.state.posts=[];f.advance(1);await f.run();assert.equal(imageIncidents(f)[0].state,'suppressed');
});
test('November 8: independent failed images have independent incident identities',async t=>{
  const f=imageFailure(t);f.state.posts.push({...f.state.posts[0],id:'p2'});await f.run();
  assert.equal(imageIncidents(f).length,2);f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,2);
  await f.send();assert.equal(f.sent.length,2);
});
test('November 8: technical incident dispatch uses Resend mock and quarantines rejection without resend',async t=>{
  const f=imageFailure(t);await f.run();f.advance(ALERT_GRACE_MS);
  const recipient='owner@example.test';const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(recipient)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  let calls=0;const send=await alertTransport({SPECIALS_ALERT_MODE:'EMAIL',SPECIALS_ALERT_PROVIDER:'RESEND',SPECIALS_ALERT_EMAIL_APPROVED:'true',
    SPECIALS_ALERT_FROM:'alerts@grayznbuffalo.com',SPECIALS_ALERT_TO:recipient,ALERT_RESEND_API_KEY:'re_fakeTestKey_000000000000'},
    {recipientSha256:digest,fetch:async(url,init)=>{calls++;assert.equal(url,'https://api.resend.com/emails');assert.match(JSON.parse(init.body).text,/Image contents.*unverified/i);return new Response('{}',{status:503});}});
  await dispatchVerifiedAlerts(f.env,{send});assert.equal(calls,1);assert.equal(imageIncidents(f)[0].dispatch_state,'uncertain');
  f.advance(10*60000);await dispatchVerifiedAlerts(f.env,{send});assert.equal(calls,1);
});

test('November 8: image download exhaustion alerts but invalid image content remains an intentional rejection',async t=>{
  const f=setup(t);f.state.posts[0].message='';const fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async url=>new URL(url).hostname==='graph.facebook.com'?fetch(url):new Response('',{status:503}));
  for(let i=0;i<3;i++){await f.run();if(i<2)f.advance(30*60000);}
  assert.equal(imageIncidents(f).length,1);assert.equal(imageIncidents(f)[0].state,'attention');
  f.advance(ALERT_GRACE_MS);await f.send();assert.match(f.sent[0].detail.category,/Image acquisition retries exhausted/);
  f.state.posts[0].updated_time='2030-01-09T14:01:00Z';
  t.mock.method(globalThis,'fetch',async url=>new URL(url).hostname==='graph.facebook.com'?fetch(url):new Response('not an image',{headers:{'content-type':'image/jpeg'}}));
  f.advance(1);await f.run();assert.equal(imageIncidents(f)[0].state,'suppressed');
});

test('November 8: recovered transient captionless image sends no technical email',async t=>{
  const f=setup(t);f.state.posts[0].message='';const run=f.env.AI.run;let first=true;
  f.env.AI.run=async(...args)=>{if(first){first=false;throw Error('AiError: 8005: Internal server error');}return run(...args);};
  await f.run();assert.deepEqual(imageIncidents(f),[]);f.advance(30*60000);await f.run();
  assert.deepEqual(imageIncidents(f),[]);assert.equal(f.sent.length,0);
});

test('November 8: successful Resend acceptance for a technical image incident sends once',async t=>{
  const f=imageFailure(t);await f.run();f.advance(ALERT_GRACE_MS);
  const recipient='owner@example.test',digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(recipient)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  let calls=0;const send=await alertTransport({SPECIALS_ALERT_MODE:'EMAIL',SPECIALS_ALERT_PROVIDER:'RESEND',SPECIALS_ALERT_EMAIL_APPROVED:'true',
    SPECIALS_ALERT_FROM:'alerts@grayznbuffalo.com',SPECIALS_ALERT_TO:recipient,ALERT_RESEND_API_KEY:'re_fakeTestKey_000000000000'},
    {recipientSha256:digest,fetch:async()=>{calls++;return Response.json({id:'49a3999c-0ce1-4ea6-ab68-afcd6dc2e794'});}});
  await dispatchVerifiedAlerts(f.env,{send});await dispatchVerifiedAlerts(f.env,{send});
  assert.equal(calls,1);assert.equal(imageIncidents(f)[0].dispatch_state,'sent');
});

test('November 8: technical email uses allowlisted diagnostics and cannot copy raw errors or injected URLs',()=>{
  const detail=imageAlertDetail({day:'2026-11-08',category:'private credential in raw failure',
    source:{id:'bad\nBcc: attacker@example.test',fb_post_id:'https://attacker.example',retry_count:999,
      caption:'private caption',last_error:'private credential'}});
  const message=alertMessage('2026-11-08','automation_failed',{detail});
  assert.match(message.text,/Failure category: Image processing/);assert.match(message.text,/Attempts used: unverified/);
  assert.ok(!/attacker|credential|private caption|Bcc/.test(message.text));
});

// November 10, 2026: the production Mexican Night poster. Its stored (second)
// reading matched every printed fact, but the model flagged 2 Soft Shell
// "unreadable text in title"; the whole menu was held and no scope alerted.
const NOV10=JSON.parse(readFileSync(new URL('../../tests/fixtures/nov10-mexican-night.json',import.meta.url),'utf8'));
const clean=menu=>({...menu,groups:menu.groups.map(g=>({...g,items:g.items.map(i=>({...i,uncertainties:[]}))}))});
// Production recurring template; Sunday seeds an unlocked copy into this week.
// Slots hold at most four items per group.
const MEXICAN_TEMPLATE=[['Mexican Night Favorites',['2 Soft Shell\nMeat, Shredded Cheese, Lettuce, Onion, Tomato & Black Olives.',
  'Burrito\nMeat, Refried Beans, Shredded Cheese, Lettuce, Onion & Tomato, Topped with Cheese, Olives & Enchilada Sauce.',
  'Chimichanga\nMeat, Refried Beans, Shredded Cheese & Onion, Fried and Topped with Enchilada Sauce, Olives & Cheese.',
  'Enchilada\nMeat, Refried Beans, Shredded Cheese & Onion, Topped with Enchilada Sauce, Olives & Cheese.']],
  ['Mexican Night Favorites',['Nacho Deluxe\nMeat, Lettuce, Onion, Tomato, Black Olives & Nacho Cheese Over Chips.',
  'Taco Salad | Large · Small · Mini\nMeat, Shredded Cheese, Lettuce, Onion, Tomato & Black Olives.',
  'Chips & Salsa or Chips & Cheese\nAdd Nacho Cheese or Salsa']],
  ['Substitutions & Add-ons',['Substitute Chicken','Add Nacho Cheese','Substitute Queso','Substitute Shredded Cheese For Nacho Cheese']]];
function november10(t,readings=[NOV10,NOV10],caption='Mexican Night 5-10pm') {
  const f=setup(t);
  f.state.now=Date.parse('2026-11-10T21:30:00Z');
  Object.assign(f.state.posts[0],{id:'583672228384067_1763389068662303',message:caption,created_time:'2026-11-10T21:29:15+0000',updated_time:'2026-11-10T21:29:15+0000'});
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.db.exec("UPDATE weekly_specials SET week_start_date='2026-11-09',week_end_date='2026-11-15' WHERE id=9000");
  for(const collection of ['mexican-night-defaults','mexican-night']) MEXICAN_TEMPLATE.forEach(([label,items],sort)=>{
    const id=`${collection}:${sort}`;
    f.db.prepare("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) VALUES(?,?,-1,'custom',?,'',?,1)").run(id,collection,label,sort);
    items.forEach((content,i)=>f.db.prepare("INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value) VALUES(?,?,?,'','','manual',0,NULL)").run(id,i+1,content));
  });
  f.db.exec("UPDATE special_collections SET section_week_start='2026-11-09',section_service_date='2026-11-10',section_source='recurring',updated_at='2026-11-09T01:00:24.461Z' WHERE id='mexican-night'");
  let call=0;f.requests=[];
  f.env.AI.run=async(_model,request)=>{f.requests.push(request);return {response:JSON.stringify(readings[Math.min(call++,readings.length-1)])};};
  f.menu=()=>f.db.prepare("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night' ORDER BY g.sort,s.position").all().map(s=>s.content);
  f.mexican=()=>f.all().filter(r=>r.scope==='mexican');
  f.mexicanSent=()=>f.sent.filter(m=>m.code==='mexican_night_failed');
  return f;
}

test('November 10: the production reading holds the whole menu, names the uncertain item and alerts once',async t=>{
  const f=november10(t);const before=f.menu();await f.run();
  const row=f.imports()[0];
  assert.equal(row.processing_status,'failed');assert.equal(row.validation_result,'rejected');assert.equal(row.failure_kind,'permanent');
  // Uncertainty is reported as uncertainty, naming the item, never as a fact mismatch.
  assert.equal(row.validation_reason,'Uncertain Mexican Night item: "2 Soft Shell ... $7.75"');
  // October 27 policy: one unverified item holds every item; nothing is partially published.
  assert.deepEqual(f.menu(),before);
  assert.equal(f.db.prepare("SELECT section_source FROM special_collections WHERE id='mexican-night'").get().section_source,'recurring');
  assert.equal(f.mexican()[0].state,'attention');assert.equal(f.mexicanSent().length,0);
  f.advance(ALERT_GRACE_MS-1);await f.send();assert.equal(f.mexicanSent().length,0);
  f.advance(1);await f.run();
  assert.equal(f.mexicanSent().length,1);
  const m=alertMessage(f.mexicanSent()[0].day,'mexican_night_failed',f.mexicanSent()[0]);
  assert.match(m.subject,/\(Mexican Night\)$/);assert.match(m.text,/Result: Poster validation/);
  assert.match(m.text,/3:29 PM \(Chicago\)/);assert.match(m.text,/#mexican-form/);assert.match(m.text,/#import-/);
  // Model text never enters the email.
  assert.ok(!m.text.includes('unreadable'));
  // Same incident on every later cron: deduplicated for the day.
  for(let i=0;i<3;i++){f.advance(30*60000);await f.run();}
  assert.equal(f.mexicanSent().length,1);assert.equal(f.mexican().length,1);
});

test('November 10: an actual size-price mismatch is reported distinctly from uncertainty',()=>{
  const swapped=clean(NOV10);swapped.groups[1].items[1].title='Taco Salad ... $8.50 | $9.00 | $6.00';
  const result=validateExtraction(JSON.stringify(swapped),true,{today:'2026-11-10',weekday:2});
  assert.equal(result.validationResult,'rejected');assert.equal(result.repairShape,'mexican-night');
  assert.equal(result.validationReason,'Mexican Night item facts differ from original evidence: "Taco Salad ... $8.50 | $9.00 | $6.00"');
  const missing=clean(NOV10);delete missing.groups[0].items[1].evidence;
  assert.match(validateExtraction(JSON.stringify(missing),true,{today:'2026-11-10',weekday:2}).validationReason,/^Missing Mexican Night item evidence: "Enchilada/);
});

// The complete poster as earlier real readings captured it: the Chips add-on
// printed beneath that dish continues in a second add-on group.
const complete=()=>{const m=clean(NOV10);m.groups.push({label:'Substitutions & Add-ons',items:[{title:'Add nacho cheese or salsa +$1.50',description:'',
  evidence:'Add nacho cheese or salsa +$1.50',uncertainties:[]}]});return m;};

test('November 10: a clean reread publishes every printed price, labelled Taco Salad sizes and standing add-ons',async t=>{
  const f=november10(t,[NOV10,clean(NOV10)]);await f.run();
  const row=f.imports()[0];
  assert.equal(row.processing_status,'staged');assert.equal(row.validation_result,'ok');
  assert.equal(f.db.prepare("SELECT section_source FROM special_collections WHERE id='mexican-night'").get().section_source,'facebook');
  const menu=f.menu();
  for(const price of ['2 Soft Shell ... $7.75','Enchilada ... $9.25','Burrito ... $10.25','Nacho Deluxe ... $9.75','Chimichanga ... $12.25','Chips & Salsa or Chips & Cheese ... $4.00'])
    assert.ok(menu.some(c=>c.startsWith(price)),price);
  // Taco Salad sizes are labelled from the printed size line, never bare.
  assert.ok(menu.some(c=>c.startsWith('Taco Salad ... Large $9.00 | Small $8.50 | Mini $6.00')),JSON.stringify(menu));
  // Standing substitutions/add-ons keep their individual prices (50c -> $0.50).
  for(const extra of ['Substitute Chicken $1.50','Add Nacho Cheese $1.50','Substitute Queso $0.50','Substitute Shredded Cheese for Nacho Cheese $0.50'])
    assert.ok(menu.some(c=>c.toLowerCase()===extra.toLowerCase()),extra);
});

test('November 10: the complete poster publishes with no Mexican Night incident or email',async t=>{
  const f=november10(t,[complete()]);await f.run();
  assert.ok(f.menu().some(c=>/^Add Nacho Cheese or Salsa \+?\$1\.50$/i.test(c)),JSON.stringify(f.menu()));
  assert.deepEqual(f.mexican(),[]); // Success creates no incident row.
  f.advance(ALERT_GRACE_MS);await f.run();assert.equal(f.mexicanSent().length,0);
});

test('November 10: a published menu missing the Chips add-on line alerts once, naming it, as missing information',async t=>{
  const f=november10(t,[NOV10,clean(NOV10)]);await f.run();
  // Publication is unchanged: the recurring line stays, without an invented price.
  assert.ok(f.menu().some(c=>c.startsWith('Chips & Salsa or Chips & Cheese ... $4.00\nAdd Nacho Cheese or Salsa')),JSON.stringify(f.menu()));
  assert.equal(f.mexican()[0].state,'attention');
  assert.equal(JSON.parse(f.mexican()[0].proof_json).cause,'mexican_night_incomplete');
  f.advance(ALERT_GRACE_MS);await f.run();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].code,'mexican_night_incomplete');
  const m=alertMessage(f.sent[0].day,f.sent[0].code,f.sent[0]);
  assert.match(m.subject,/\(Mexican Night: unconfirmed entries\)$/);
  assert.match(m.text,/Published — not a validation failure/);assert.match(m.text,/^- Add Nacho Cheese or Salsa$/m);
  assert.ok(!/Poster validation|could not be fully published/.test(m.text));
  // Exactly one entry: ingredient descriptions kept from the template are not reported.
  assert.deepEqual(f.sent[0].detail.entries,['Add Nacho Cheese or Salsa']);
  for(let i=0;i<3;i++){f.advance(30*60000);await f.run();}
  assert.equal(f.sent.length,1);assert.equal(f.mexican().length,1);
});

test('November 10: a recurring dish absent from the published poster is named without inventing a price',async t=>{
  const reading=complete();reading.groups[0].items=reading.groups[0].items.filter(i=>!i.title.startsWith('Burrito'));
  const f=november10(t,[reading]);await f.run();
  assert.ok(f.menu().some(c=>c.startsWith('Burrito\n')));
  f.advance(ALERT_GRACE_MS);await f.run();
  assert.deepEqual(f.sent.map(m=>m.code),['mexican_night_incomplete']);assert.deepEqual(f.sent[0].detail.entries,['Burrito']);
});

test('November 10: a staff price after publication suppresses the unconfirmed-entry email and is never overwritten',async t=>{
  const f=november10(t,[NOV10,clean(NOV10)]);await f.run();
  assert.equal(f.mexican()[0].state,'attention');
  // The staff editor saves the whole section as manual for this week.
  f.db.exec("UPDATE special_collections SET section_source='manual' WHERE id='mexican-night'");
  f.db.exec("UPDATE special_slots SET content='Chips & Salsa or Chips & Cheese - $4.00\nAdd Nacho Cheese or Salsa +$1.50',origin='manual' WHERE content LIKE 'Chips & Salsa%'");
  const before=f.menu();f.advance(60000);await f.run();
  assert.equal(f.mexican()[0].state,'suppressed');assert.deepEqual(f.menu(),before);
  f.advance(ALERT_GRACE_MS);await f.run();assert.equal(f.sent.length,0);
});

test('November 10: the reread is told which item was uncertain, never a generic fact mismatch',async t=>{
  const f=november10(t,[NOV10,clean(NOV10)]);await f.run();
  assert.equal(f.requests.length,2);
  const repair=f.requests[1].messages[1].content[0].text;
  assert.ok(repair.includes(JSON.stringify('Uncertain Mexican Night item: "2 Soft Shell ... $7.75"')),repair.slice(0,200));
  assert.ok(!repair.includes('item facts differ'));
  // The repair keeps the instruction to preserve genuine uncertainty.
  assert.match(repair,/Preserve uncertainty if the image cannot establish the association/);
});

test('November 10: a rejected import stays requeueable; recovery before grace resolves without email',async t=>{
  const f=november10(t);await f.run();
  const row=f.imports()[0];assert.equal(f.mexican()[0].state,'attention');
  f.env.AI.run=async()=>({response:JSON.stringify(complete())});
  await requeueFailedImport(f.env,row.id);f.advance(60000);await f.run();
  assert.ok(f.menu().some(c=>c.startsWith('2 Soft Shell ... $7.75')));
  assert.equal(f.mexican()[0].state,'resolved');
  f.advance(ALERT_GRACE_MS);await f.run();assert.equal(f.mexicanSent().length,0);
});

test('November 10: a staff correction is never overwritten and suppresses the Mexican Night alert',async t=>{
  const f=november10(t);
  // A real staff save after the 21:29 post (the editor marks the section and stamps updated_at).
  f.db.exec("UPDATE special_slots SET content='Burrito - $11.00',manual_locked=1 WHERE group_id='mexican-night:0' AND position=2");
  f.db.exec("UPDATE special_collections SET section_source='manual',updated_at='2026-11-10 21:29:45' WHERE id='mexican-night'");
  const before=f.menu();await f.run();
  assert.deepEqual(f.menu(),before);
  assert.notEqual(f.mexican()[0]?.state,'attention');
  f.advance(ALERT_GRACE_MS);await f.run();assert.equal(f.mexicanSent().length,0);
});

test('November 10: Tuesdays without a Mexican Night post, or with an unrelated poster, create no Mexican Night incident',async t=>{
  const f=november10(t,[{day_of_week:2,day_evidence:'TUESDAY',poster_evidence:'TUESDAY SPECIALS',offers:[]},
    {type:'mexican-night',poster_evidence:'',groups:[]}],'');
  await f.run();assert.deepEqual(f.mexican().filter(r=>r.state==='attention'),[]);
  f.state.posts=[];f.advance(60000);await f.run();
  f.advance(ALERT_GRACE_MS);await f.run();
  assert.deepEqual(f.mexican().filter(r=>r.state==='attention'),[]);assert.equal(f.mexicanSent().length,0);
});

test('November 10: Resend rejection of a Mexican Night alert is recorded, never silently dropped or resent',async t=>{
  const f=november10(t);await f.run();f.advance(ALERT_GRACE_MS);
  const recipient='owner@example.test',digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(recipient)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  let calls=0;const send=await alertTransport({SPECIALS_ALERT_MODE:'EMAIL',SPECIALS_ALERT_PROVIDER:'RESEND',SPECIALS_ALERT_EMAIL_APPROVED:'true',
    SPECIALS_ALERT_FROM:'alerts@grayznbuffalo.com',SPECIALS_ALERT_TO:recipient,ALERT_RESEND_API_KEY:'re_fakeTestKey_000000000000'},
    {recipientSha256:digest,fetch:async(url,init)=>{calls++;assert.match(JSON.parse(init.body).subject,/Mexican Night/);return new Response('{}',{status:503});}});
  await dispatchVerifiedAlerts(f.env,{send});
  assert.equal(calls,1);assert.equal(f.mexican()[0].dispatch_state,'uncertain');assert.equal(f.mexican()[0].last_error,'send_failed');
  assert.equal((await readAlertHealth(f.env)).send_failures,1);
  f.advance(10*60000);await dispatchVerifiedAlerts(f.env,{send});assert.equal(calls,1);
});
