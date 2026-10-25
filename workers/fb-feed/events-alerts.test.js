import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {runImportPipeline} from './worker.js';
import {ALERT_GRACE_MS} from './alert-store.js';

// Combined release coverage: special events (0025) and failure alerts (0023/0024)
// running through the same Worker pipeline. Alerts use MOCK transport only.
const read=name=>JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`,import.meta.url),'utf8'));
const morningRaw=read('oct23-delivery.json');
const {friday_night:nightRaw,brewers_event:brewersRaw}=read('oct23-friday-night.json');
const {sunday_specials:sundayRaw,packers_event:packersRaw}=read('oct25-sunday-soup.json');

function combined(t,options,{events,alerts='MOCK'}={}) {
  let db;t.after(()=>db?.close());
  const f=harness(t,options);
  db=new DatabaseSync(f.path);
  db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT); INSERT OR REPLACE INTO settings VALUES('delivery_display','auto');");
  for(const name of ['0022_delivery_automation.sql','0023_facebook_alert_incidents.sql','0024_facebook_alert_evidence.sql']) db.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  const DB={prepare(query) {
    return {sql:query,args:[],bind(...args){this.args=args;return this;},
      values(){return Object.fromEntries(this.args.map((v,i)=>[String(i+1),v]));},
      async first(){return db.prepare(query).get(this.values())??null;},
      async all(){return {results:db.prepare(query).all(this.values())};},
      async run(){return {meta:{changes:Number(db.prepare(query).run(this.values()).changes)}};}};
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
  Object.assign(f.env,{DB,SPECIALS_ALERT_MODE:alerts,SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  if(events) f.env.SPECIAL_EVENTS_MODE=events;
  const sent=[];
  const q=(sql,...args)=>db.prepare(sql).all(...args).map(r=>({...r}));
  return {...f,db,sent,q,run:()=>runImportPipeline(f.env,{send:async m=>sent.push(m)}),
    advance:ms=>f.state.now+=ms,
    incidents:()=>q('SELECT scope,code,state,dispatch_state,proof_json FROM facebook_alert_incidents ORDER BY incident_key'),
    attention:()=>q("SELECT scope,code FROM facebook_alert_incidents WHERE state='attention'"),
    events:()=>q('SELECT status,origin FROM special_events')};
}

function friday(t,modes) {
  const f=combined(t,{now:'2026-10-23T14:26:05.441Z',candidate:structuredClone(morningRaw)},modes);
  f.db.exec("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'morning',message:'',created_time:'2026-10-23T09:24:45-05:00',updated_time:'2026-10-23T09:24:45-05:00'});
  const post=(id,created,candidate,at)=>{
    f.state.now=Date.parse(at);f.state.candidate=structuredClone(candidate);
    f.state.posts.push({...f.state.posts[0],id,created_time:created,updated_time:created});
  };
  return {...f,
    addNight:()=>post('night','2026-10-23T15:00:53-05:00',nightRaw,'2026-10-23T20:02:14.635Z'),
    addBrewers:()=>post('brewers','2026-10-23T15:13:45-05:00',brewersRaw,'2026-10-23T20:15:08.911Z')};
}

async function brewersDay(t,modes) {
  const f=friday(t,modes);
  await f.run();
  f.morningDelivery=f.q('SELECT active,day FROM delivery_automation WHERE id=1');
  f.addNight();await f.run();f.addBrewers();await f.run();
  // Past the grace period, two more crons: any qualifying incident would dispatch.
  f.advance(ALERT_GRACE_MS+60000);await f.run();f.advance(60000);await f.run();
  return f;
}

test('events REVIEW + alerts: the event-only Brewers poster is routed to review and raises no incident or email',async t=>{
  const f=await brewersDay(t,{events:'REVIEW'});
  assert.deepEqual(f.events(),[{status:'review',origin:'automation'}]);
  assert.deepEqual(f.attention(),[]);
  assert.equal(f.sent.length,0);
  // Friday's regular Nightly specials and the morning delivery evidence still publish.
  const nightly=f.q("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='auto-week' AND g.day_of_week=5 AND g.service='nightly' AND s.content<>'' ORDER BY s.position");
  assert.equal(nightly.length,3); // The real October 23 poster printed three; capacity is four.
  assert.ok(!nightly.some(s=>/pulled pork/i.test(s.content)));
  // Delivery published from the morning poster, then expired at 3 PM (final crons run ~3:47 PM).
  assert.deepEqual(f.morningDelivery,[{active:1,day:'2026-10-23'}]);
  assert.deepEqual(f.q('SELECT active,day FROM delivery_automation WHERE id=1'),[{active:0,day:'2026-10-23'}]);
  assert.ok(!f.incidents().some(r=>r.scope==='delivery' && r.state==='attention'));
});

test('events AUTO + alerts: a published event never produces a daily incident',async t=>{
  const f=await brewersDay(t,{events:'AUTO'});
  assert.equal(f.events().length,1);
  assert.deepEqual(f.attention(),[]);
  assert.equal(f.sent.length,0);
});

test('events OFF + alerts: without event routing the Brewers poster is a daily incident (REVIEW must precede EMAIL)',async t=>{
  const f=await brewersDay(t,{});
  assert.deepEqual(f.events(),[]);
  assert.deepEqual(f.attention(),[{scope:'daily',code:'publication_blocked'}]);
  // Deduplicated: one email for the day, never one per cron.
  assert.equal(f.sent.length,1);
});

test('events REVIEW + alerts: a genuine permanent extraction failure is still detected and sent once',async t=>{
  const f=combined(t,{},{events:'REVIEW'});
  f.env.AI.run=async()=>{throw Object.assign(Error('private-provider-detail'),{status:400});};
  await f.run();
  assert.deepEqual(f.attention(),[{scope:'daily',code:'publication_blocked'}]);
  assert.equal(JSON.parse(f.incidents()[0].proof_json).cause,'validation_rejected');
  assert.equal(f.sent.length,0,'grace period first');
  f.advance(ALERT_GRACE_MS);await f.run();await f.run();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].code,'validation_rejected');
  f.advance(60000);await f.run();assert.equal(f.sent.length,1,'deduplicated');
  assert.deepEqual(f.events(),[]);
});

test('events REVIEW + alerts: a successful regular day is silent',async t=>{
  const f=combined(t,{},{events:'REVIEW'});
  await f.run();f.advance(ALERT_GRACE_MS);await f.run();
  assert.deepEqual(f.attention(),[]);assert.equal(f.sent.length,0);
});

test('October 25 Packers post (empty caption) is not misclassified as an event in any alerting mode',async t=>{
  const outcome={};
  for(const events of [undefined,'REVIEW','AUTO']) {
    const f=combined(t,{now:'2026-10-25T14:29:01.923Z',candidate:structuredClone(sundayRaw)},{events});
    f.db.exec("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
    Object.assign(f.state.posts[0],{id:'sunday',message:'',created_time:'2026-10-25T09:27:36-05:00',updated_time:'2026-10-25T09:27:36-05:00'});
    await f.run();
    f.state.now=Date.parse('2026-10-25T15:35:08.068Z');f.state.candidate=structuredClone(packersRaw);
    f.state.posts.push({...f.state.posts[0],id:'packers',created_time:'2026-10-25T10:33:50-05:00',updated_time:'2026-10-25T10:33:50-05:00'});
    await f.run();f.advance(ALERT_GRACE_MS+60000);await f.run();
    assert.deepEqual(f.events(),[],String(events));
    outcome[String(events)]={attention:f.attention(),sent:f.sent.map(m=>m.code)};
  }
  t.diagnostic(`Packers outcome=${JSON.stringify(outcome.undefined)}`);
  // Event mode does not change alerting for a poster it does not route.
  assert.deepEqual(outcome.REVIEW,outcome.undefined);
  assert.deepEqual(outcome.AUTO,outcome.undefined);
});

test('alerts OBSERVE with events REVIEW records incidents but never constructs a transport',async t=>{
  const f=combined(t,{},{events:'REVIEW',alerts:'OBSERVE'});
  Object.assign(f.env,{SPECIALS_ALERT_PROVIDER:'RESEND',SPECIALS_ALERT_EMAIL_APPROVED:'true',
    SPECIALS_ALERT_FROM:'alerts@grayznbuffalo.com',SPECIALS_ALERT_TO:'owner@example.com',ALERT_RESEND_API_KEY:'re_testonly_notreal'});
  f.env.AI.run=async()=>{throw Object.assign(Error('permanent'),{status:400});};
  const calls=f.state.calls.length;
  await f.run();f.advance(ALERT_GRACE_MS);await f.run();
  assert.equal(f.attention().length,1);
  assert.equal(f.incidents()[0].dispatch_state,'ready');
  assert.ok(!f.state.calls.slice(calls).some(u=>u.hostname==='api.resend.com'));
  assert.equal(f.sent.length,0);
});
