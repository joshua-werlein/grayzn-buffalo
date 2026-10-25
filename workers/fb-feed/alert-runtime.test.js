import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {runImportPipeline} from './worker.js';
import {beginAlertScan,finishAlertScan,dispatchVerifiedAlerts,revalidateAlert,readAlertHealth} from './alert-runtime.js';
import {ALERT_GRACE_MS,dispatchAlert} from './alert-store.js';
import {reconcileToday} from './guarded-auto.js';
import {emailTransport} from './alert-email.js';

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
    assert.ok(!f.all().some(r=>r.state==='attention'));assert.equal(f.sent.length,0);
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
