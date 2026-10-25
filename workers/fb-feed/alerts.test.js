import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {importAlertObservation, dailyPublicationObservation} from './alert-policy.js';
import {recordAlertObservation, dispatchAlert, ALERT_GRACE_MS, ALERT_LEASE_MS} from './alert-store.js';
import {deliveryWindow} from '../../src/lib/delivery.js';

const migration = readFileSync(new URL('../../migrations/0023_facebook_alert_incidents.sql',import.meta.url),'utf8');
function fixture(t, date='2026-10-22T15:00:00Z') {
  const sql = new DatabaseSync(':memory:'); sql.exec(migration); t.after(()=>sql.close());
  const DB = {prepare(query) {
    const s=sql.prepare(query); let values=[];
    const args=()=>Object.fromEntries(values.map((v,i)=>[String(i+1),v]));
    return {bind(...v){values=v;return this;},async run(){return {meta:{changes:Number(s.run(args()).changes)}};},async first(){return s.get(args())??null;}};
  }};
  let clock=Date.parse(date);
  return {DB,sql,now:()=>clock,advance:ms=>clock+=ms,
    record:async(state='attention',extra={})=>recordAlertObservation(DB,{day:deliveryWindow(new Date(clock)).day,scope:'source_1',code:'import_failed',state,observedAt:clock,...extra}),
    row:()=>sql.prepare('SELECT * FROM facebook_alert_incidents').get()};
}

test('terminal failure classification requires eligible, currently unresolved evidence',()=>{
  for (const [source,code] of [
    [{processing_status:'failed',failure_kind:'permanent'},'import_failed'],
    [{processing_status:'failed',validation_result:'rejected'},'validation_rejected'],
    [{processing_status:'skipped',failure_kind:'budget'},'ai_budget_exhausted'],
    [{processing_status:'failed',failure_kind:'exhausted'},'retry_exhausted'],
  ]) {
    assert.deepEqual(importAlertObservation(source,{eligible:true,resolution:'unresolved'}),{state:'attention',code});
    assert.equal(importAlertObservation(source,{eligible:true}).state,'unknown');
    assert.equal(importAlertObservation(source).state,'unknown');
    assert.equal(importAlertObservation(source,{eligible:true,resolution:'recovered'}).state,'resolved');
  }
});
test('pending retries and staff reviews never become terminal import alerts',()=>{
  for (const status of ['pending','processing']) assert.equal(importAlertObservation({processing_status:status,failure_kind:'exhausted'},{eligible:true,resolution:'unresolved'}).state,'pending');
  for (const review of ['edited','kept','dismissed']) assert.equal(importAlertObservation({review_status:review,processing_status:'failed'},{eligible:true,resolution:'unresolved'}).state,'suppressed');
});
test('partial publication alerts even when some slots were written; staff locks are suppressed',()=>{
  assert.equal(dailyPublicationObservation({written:true,reason:'reconciled',blocked:[{reason:'Missing or malformed lunch price'}]}).state,'attention');
  assert.equal(dailyPublicationObservation({written:false,reason:'conflict',blocked:[{reason:'Protected or ineligible destination slot'}]}).state,'suppressed');
  assert.equal(dailyPublicationObservation({written:false,reason:'conflict',rejectedSources:[{reason:'capacity'}]}).state,'attention');
});
test('normal no-post days, retries, unknown evidence, and successful reconciliations remain distinct',()=>{
  assert.equal(dailyPublicationObservation({reason:'No current sources'}).state,'resolved');
  assert.equal(dailyPublicationObservation({reason:'No unambiguous eligible changes'}).state,'resolved');
  for (const reason of ['Current sources awaiting recovery','Concurrent change; nothing written']) assert.equal(dailyPublicationObservation({reason}).state,'pending');
  assert.equal(dailyPublicationObservation({reason:'No extracted evidence'}).state,'unknown');
  assert.equal(dailyPublicationObservation({written:true,reason:'reconciled',blocked:[],rejectedSources:[]}).state,'resolved');
  assert.equal(dailyPublicationObservation({written:true,reason:'new unknown format'}).state,'unknown');
});
test('disabled dispatcher makes no database or transport calls',async()=>{
  assert.equal((await dispatchAlert(null,()=>{throw Error('must not send');})).status,'disabled');
});
test('grace, duplicate observations and concurrent dispatch yield one notification',async t=>{
  const f=fixture(t);let sent=0;
  await Promise.all([f.record(),f.record()]);
  assert.equal((await dispatchAlert(f.DB,async()=>sent++,{enabled:true,now:f.now})).status,'idle');
  f.advance(ALERT_GRACE_MS);await f.record();
  await Promise.all(Array.from({length:8},()=>dispatchAlert(f.DB,async()=>sent++,{enabled:true,now:f.now})));
  assert.equal(sent,1);assert.equal(f.row().attempts,1);
  f.advance(ALERT_GRACE_MS);await f.record();await dispatchAlert(f.DB,async()=>sent++,{enabled:true,now:f.now});assert.equal(sent,1);
});
test('retry recovery closes an unsent incident and stale failures cannot reopen it',async t=>{
  const f=fixture(t);const old=f.now();await f.record();f.advance(1000);await f.record('resolved');
  await f.record('attention',{observedAt:old});f.advance(ALERT_GRACE_MS);
  assert.equal((await dispatchAlert(f.DB,async()=>assert.fail('recovered'),{enabled:true,now:f.now})).status,'idle');
  assert.equal(f.row().state,'resolved');
});
test('unknown does not close; pending resets grace for an unsent incident',async t=>{
  const f=fixture(t);await f.record();f.advance(1000);await f.record('unknown');assert.equal(f.row().state,'attention');
  await f.record('pending');f.advance(ALERT_GRACE_MS);await f.record();
  assert.equal((await dispatchAlert(f.DB,async()=>assert.fail('new grace'),{enabled:true,now:f.now})).status,'idle');
});
test('ambiguous send failure persists only safe code and never automatically retries',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);
  const opts={enabled:true,now:f.now};let calls=0;
  const send=async m=>{calls++;assert.equal(m.message,'An eligible Facebook source could not be imported.');assert.ok(!('raw' in m));if(calls===1)throw Error('secret provider payload');};
  assert.equal((await dispatchAlert(f.DB,send,opts)).status,'uncertain');assert.equal(f.row().last_error,'send_failed');
  assert.equal((await dispatchAlert(f.DB,send,opts)).status,'idle');f.advance(5*60*1000);
  assert.equal((await dispatchAlert(f.DB,send,opts)).status,'idle');assert.equal(calls,1);assert.equal(f.row().dispatch_state,'uncertain');
});
test('successful send during concurrent recovery is remembered without reopening',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);
  await dispatchAlert(f.DB,async()=>{f.advance(1);await f.record('resolved');},{enabled:true,now:f.now});
  assert.equal(f.row().state,'resolved');assert.notEqual(f.row().sent_ms,null);
  f.advance(1);await f.record();f.advance(ALERT_GRACE_MS);
  assert.equal((await dispatchAlert(f.DB,async()=>assert.fail('same incident already sent'),{enabled:true,now:f.now})).status,'idle');
});
test('crashed preparation lease can be reclaimed before any provider authorization',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);
  f.sql.prepare('UPDATE facebook_alert_incidents SET lease_token=?,lease_until_ms=?').run('crashed',f.now()+ALERT_LEASE_MS);
  assert.equal((await dispatchAlert(f.DB,async()=>{}, {enabled:true,now:f.now})).status,'idle');
  f.advance(ALERT_LEASE_MS);assert.equal((await dispatchAlert(f.DB,async()=>{}, {enabled:true,now:f.now})).status,'sent');
});
test('Chicago midnight expires old unsent incidents; new day has a distinct key',async t=>{
  const f=fixture(t,'2026-10-23T04:20:00Z');const key=await f.record();f.advance(41*60*1000);
  assert.equal((await dispatchAlert(f.DB,async()=>assert.fail('yesterday'),{enabled:true,now:f.now})).status,'idle');
  assert.notEqual(await f.record(),key);
});
test('Chicago daylight-saving changes preserve the local incident date',async t=>{
  for (const [date,day] of [['2026-03-08T07:59:59Z','2026-03-08'],['2026-03-08T08:00:00Z','2026-03-08'],['2026-11-01T06:59:59Z','2026-11-01'],['2026-11-01T07:00:00Z','2026-11-01']]) {
    const f=fixture(t,date);await f.record();assert.equal(f.row().day,day);
  }
});
test('reject malformed date, identifiers, codes and grace before SQL',async t=>{
  const f=fixture(t);
  for(const extra of [{day:'2026-10-21'},{scope:'private@example.com'},{code:'raw error'},{observedAt:NaN}]) await assert.rejects(f.record('attention',extra),TypeError);
  assert.equal(f.row(),undefined);
});
test('staff suppression cancels unsent incidents without success email',async t=>{
  const f=fixture(t);await f.record();f.advance(1);await f.record('suppressed');f.advance(ALERT_GRACE_MS);
  assert.equal((await dispatchAlert(f.DB,async()=>assert.fail('staff override'),{enabled:true,now:f.now})).status,'idle');
});
test('queued delivery incident expires at 3 PM Chicago instead of sending late',async t=>{
  const f=fixture(t,'2026-10-22T19:40:00Z');await f.record('attention',{code:'delivery_failed'});f.advance(ALERT_GRACE_MS);
  assert.equal((await dispatchAlert(f.DB,async()=>assert.fail('expired delivery'),{enabled:true,now:f.now})).status,'idle');
});
test('old send failure cannot shorten a restarted grace period after recovery',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);
  await dispatchAlert(f.DB,async()=>{
    f.advance(1);await f.record('resolved');f.advance(1);await f.record();throw Error('mock late failure');
  },{enabled:true,now:f.now});
  f.advance(5*60*1000);
  assert.equal((await dispatchAlert(f.DB,async()=>assert.fail('grace must remain'),{enabled:true,now:f.now})).status,'idle');
});

// Interleave a durable observation after the atomic claim, before its final check.
function afterClaim(DB, action) {
  return {prepare(query) {
    const statement=DB.prepare(query);
    if (!query.includes('RETURNING *')) return statement;
    return {bind(...values){statement.bind(...values);return this;},async first(){
      const row=await statement.first();
      if(row) await action();
      return row;
    }};
  }};
}

test('recovery and recurrence after claim cannot bypass the restarted grace',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);
  const DB=afterClaim(f.DB,async()=>{
    f.advance(1);await f.record('resolved');f.advance(1);await f.record();
  });
  assert.equal((await dispatchAlert(DB,async()=>assert.fail('restarted grace'),{enabled:true,now:f.now})).status,'superseded');
  assert.equal(f.row().sent_ms,null);
  f.advance(ALERT_GRACE_MS);
  assert.equal((await dispatchAlert(f.DB,async()=>{}, {enabled:true,now:f.now})).status,'sent');
});

test('newer attention evidence invalidates the old claim even when already due',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);
  const DB=afterClaim(f.DB,async()=>{f.advance(1);await f.record();});
  assert.equal((await dispatchAlert(DB,async()=>assert.fail('old observation'),{enabled:true,now:f.now})).status,'superseded');
  assert.equal(f.row().sent_ms,null);
  f.advance(ALERT_LEASE_MS);
  assert.equal((await dispatchAlert(f.DB,async()=>{}, {enabled:true,now:f.now})).status,'sent');
});

test('unresolved provider call returns within a bound and cannot overlap after lease expiry',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);
  let calls=0,accept;
  const send=()=>{calls++;return new Promise(resolve=>{accept=resolve;});};
  const options={enabled:true,now:f.now,timeoutMs:10};
  assert.equal((await dispatchAlert(f.DB,send,options)).status,'uncertain');
  assert.equal(f.row().dispatch_state,'uncertain');assert.ok(f.row().authorized_ms);
  f.advance(ALERT_LEASE_MS+1);
  await Promise.all(Array.from({length:6},()=>dispatchAlert(f.DB,send,options)));
  assert.equal(calls,1);
  accept();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.row().dispatch_state,'sent');assert.notEqual(f.row().sent_ms,null);
});

test('late provider rejection leaves durable uncertainty without an unhandled rejection',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);let reject;
  await dispatchAlert(f.DB,()=>new Promise((_,r)=>{reject=r;}),{enabled:true,now:f.now,timeoutMs:10});
  reject(Error('private provider detail'));await new Promise(resolve=>setTimeout(resolve,10));
  f.advance(ALERT_LEASE_MS+1);
  assert.equal((await dispatchAlert(f.DB,()=>assert.fail('must remain quarantined'),{enabled:true,now:f.now})).status,'idle');
  assert.equal(f.row().last_error,'send_failed');
});

test('process loss after durable authorization never becomes an expired retry',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);
  f.sql.prepare("UPDATE facebook_alert_incidents SET dispatch_state='uncertain',authorized_ms=?,lease_token='lost',lease_until_ms=?").run(f.now(),f.now()+ALERT_LEASE_MS);
  f.advance(ALERT_LEASE_MS+1);
  assert.equal((await dispatchAlert(f.DB,()=>assert.fail('unknown acceptance'),{enabled:true,now:f.now})).status,'idle');
  f.advance(1);await f.record('resolved');f.advance(1);await f.record();f.advance(ALERT_GRACE_MS);
  assert.equal((await dispatchAlert(f.DB,()=>assert.fail('recurrence cannot erase uncertainty'),{enabled:true,now:f.now})).status,'idle');
});

test('provider acceptance followed by acknowledgement failure cannot retry',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);let calls=0;
  const DB={prepare(query){
    if(query.includes('SET sent_ms=')) return {bind(){return this;},async run(){throw Error('D1 unavailable');}};
    return f.DB.prepare(query);
  }};
  assert.equal((await dispatchAlert(DB,async()=>calls++,{enabled:true,now:f.now})).status,'uncertain');
  f.advance(ALERT_LEASE_MS+1);await dispatchAlert(f.DB,async()=>calls++,{enabled:true,now:f.now});
  assert.equal(calls,1);assert.equal(f.row().dispatch_state,'uncertain');
});

test('lost authorization response is fail-closed even when the durable write committed',async t=>{
  const f=fixture(t);await f.record();f.advance(ALERT_GRACE_MS);
  const DB={prepare(query){
    const s=f.DB.prepare(query);
    if(!query.includes("SET dispatch_state='uncertain'")) return s;
    return {bind(...args){s.bind(...args);return this;},async first(){await s.first();throw Error('lost response');}};
  }};
  await assert.rejects(dispatchAlert(DB,()=>assert.fail('no authorization response'),{enabled:true,now:f.now}),/lost response/);
  f.advance(ALERT_LEASE_MS+1);
  assert.equal((await dispatchAlert(f.DB,()=>assert.fail('no resend'),{enabled:true,now:f.now})).status,'idle');
});
