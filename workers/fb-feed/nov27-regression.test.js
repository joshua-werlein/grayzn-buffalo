import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker,{runImportPipeline,validateExtraction} from './worker.js';
import {harness} from './test-fixture.js';
import {canonicalizeSlotContent,reconcilePosterEvidence,WEEKDAY_ENCODING_MISMATCH} from './reconcile.js';
import {routeEventSource} from './events.js';
import {reconcileToday} from './guarded-auto.js';
import {reconcileDelivery} from './delivery.js';
import {resolveDeliveryDisplay} from '../../src/lib/delivery.js';

const [promotion,food]=JSON.parse(readFileSync(new URL('../../tests/fixtures/nov27-facebook-posters.json',import.meta.url)));
const [retail]=promotion.attempts,[daily]=food.attempts;
const day='2026-11-27',weekday=5,now='2026-11-27T15:49:00Z';
const validate=raw=>validateExtraction(JSON.stringify(raw),true,{today:day,weekday});
const route=(candidate,extra={})=>routeEventSource({candidate,postDate:day,canonicalize:canonicalizeSlotContent,...extra});
const giftOffers=['Buy $50 Gift Card Get $55','Buy $100 Gift Card Get $110!'];
const foodOffers=daily.offers.map(o=>o.content);

test('both Black Friday readings carry identical amounts and resolve to Nov 27 without a weekday number',()=>{
  assert.equal(promotion.attempts.length,2);
  for (const raw of promotion.attempts) {
    assert.deepEqual([raw.day_of_week,raw.day_evidence],[-1,'']);
    const result=validate(raw);
    assert.equal(result.validationReason,'retail promotion evidence');
    assert.equal(result.needsRepair,false);
    const event=route(JSON.parse(result.candidateJson));
    assert.deepEqual([event.route,event.publish,event.draft.event_date,event.draft.offers],['event',true,day,giftOffers]);
    assert.match(event.draft.evidence.date,/verified November post/);
  }
});

test('retail routing requires one-time evidence and withholds contradictory printed dates and amounts',()=>{
  for (const candidate of [
    {...retail,poster_evidence:'Black Friday Deal — 11/28'},
    {...retail,day_of_week:4,day_evidence:'Thursday'},
    {...retail,offers:[{...retail.offers[0],content:'Buy $50 Gift Card Get $65'},retail.offers[1]]},
  ]) {
    const result=route(candidate);
    assert.equal(result.route,'event');
    assert.equal(result.publish,false);
  }
  assert.equal(route(retail,{caption:'Tomorrow only'}).publish,false);
  assert.equal(route(retail,{postDate:'2026-11-28'}).publish,false);
  assert.equal(route(retail,{postDate:'2026-11-20'}).draft.event_date,day);
  assert.equal(route({...retail,poster_evidence:'Gift Card Deal Today'}).publish,true);
  assert.equal(route({...retail,poster_evidence:'One-Day-Only Gift Card Deal'}).publish,true);
  assert.equal(route({...retail,poster_evidence:'Gift Card Deal — Friday'}).route,'retail');
  assert.equal(route({...retail,poster_evidence:'Gift Card Deal Every Friday'}).route,'retail');
  assert.equal(route({...daily,day_of_week:5,poster_evidence:'Friday Daily Specials'}).route,'regular');
  assert.match(validate({...daily,offers:[...daily.offers,retail.offers[0]]}).validationReason,/Gift card offer requires Special Events/);
  const legacy=reconcilePosterEvidence([{...daily,day_of_week:5,day_evidence:'Friday',
    offers:[{...retail.offers[0],service_time:'Lunch'}]}],weekday,[],{today:day});
  assert.deepEqual(legacy.targets,[]);
  assert.match(legacy.rejectedSources[0].reason,/Gift card offer requires Special Events/);
});

test('numbered daily meals use the verified Chicago date and retain the three destinations',()=>{
  assert.equal(food.attempts.length,1);
  const validated=validate(daily);
  assert.equal(validated.validationResult,'ok');
  assert.equal(validated.needsRepair,false);
  const candidate=JSON.parse(validated.candidateJson);
  assert.deepEqual([candidate.day_of_week,candidate.day_evidence],[-1,'']);
  const plan=(c,verified=true)=>reconcilePosterEvidence([c],weekday,[],{
    today:day,verifiedSameDaySources:new Set(verified?[0]:[]),
  });
  assert.deepEqual(plan(candidate).targets.map(t=>[t.service,t.items.map(i=>[i.position,i.content])]),
    [['lunch',[[1,foodOffers[0]]]],['all-day',[[1,foodOffers[1]],[2,foodOffers[2]]]]]);
  assert.deepEqual(plan(candidate,false).targets.map(t=>t.service),['lunch']);
  assert.ok(plan(candidate,false).unresolvedTargets.some(t=>t.service==='unknown'));
  assert.equal(validate({...daily,day_of_week:-1,day_evidence:'Friday'}).validationReason,WEEKDAY_ENCODING_MISMATCH);
  assert.equal(validate({...daily,day_of_week:5,day_evidence:'Friday, November 28'}).validationResult,'rejected');
  assert.deepEqual(plan({...candidate,offers:[{...candidate.offers[0],date_evidence:'Saturday'},...candidate.offers.slice(1)]}).targets,[]);
});

function friday(t) {
  const f=harness(t,{now,candidate:retail});
  const db=new DatabaseSync(f.path);
  try {
    for (const migration of ['0022_delivery_automation.sql','0023_facebook_alert_incidents.sql','0024_facebook_alert_evidence.sql']) {
      db.exec(readFileSync(new URL(`../../migrations/${migration}`,import.meta.url),'utf8'));
    }
  } finally { db.close(); }
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-23',week_end_date='2026-11-29' WHERE id=9000");
  Object.assign(f.state.posts[0],promotion.post,{updated_time:promotion.post.created_time});
  Object.assign(f.env,{SPECIAL_EVENTS_MODE:'AUTO',SPECIALS_ALERT_MODE:'MOCK',SPECIALS_EVIDENCE_VERSION:'2',
    SPECIALS_VERIFICATION_STRATEGY:'conditional',FB_KV:{get:async()=>null,put:async()=>{}}});
  const addDaily=()=>{
    f.state.now+=60000;
    f.state.posts.unshift({...f.state.posts[0],...food.post,updated_time:food.post.created_time,
      full_picture:'https://cdn.example/daily.jpg'});
    f.state.candidate=structuredClone(daily);
  };
  const sent=[];
  return {...f,addDaily,sent,run:()=>runImportPipeline(f.env,{send:async m=>sent.push(m)}),
    events:()=>f.sql('SELECT title,event_date,status,origin,revision FROM special_events'),
    offers:()=>f.sql('SELECT content FROM special_event_offers ORDER BY position').map(r=>r.content),
    delivery:()=>f.sql('SELECT * FROM delivery_automation')[0],
    contents:()=>['lunch','all-day'].flatMap(service=>f.slots(weekday,service).map(r=>r.content).filter(Boolean))};
}

test('the real inputs publish one event, three daily slots and delivery across repeated cron and queue runs',async t=>{
  const f=friday(t);
  await f.run();
  f.addDaily();
  await f.run();
  assert.deepEqual(f.events(),[{title:'Black Friday Deal',event_date:day,status:'published',origin:'automation',revision:0}]);
  assert.deepEqual(f.offers(),giftOffers);
  assert.deepEqual(f.contents(),foodOffers);
  assert.equal(f.delivery().active,1);
  assert.equal(f.delivery().expires_at,'2026-11-27T19:30:00.000Z');
  const week=f.sql("SELECT revision FROM special_collections WHERE id='auto-week'");
  const waits=[];
  f.state.now+=31*60000;
  await worker.scheduled({},f.env,{waitUntil:job=>waits.push(job)});
  await Promise.all(waits);
  await worker.queue({messages:[{body:{type:'facebook-feed-change'}}]},f.env);
  await f.run();
  assert.equal(f.state.aiCalls,2);
  assert.equal(f.imports().length,2);
  assert.equal(f.events().length,1);
  assert.equal(f.sql("SELECT count(*) n FROM special_event_log WHERE action='created'")[0].n,1);
  assert.deepEqual(f.sql("SELECT revision FROM special_collections WHERE id='auto-week'"),week);
  assert.deepEqual(f.contents(),foodOffers);
  assert.deepEqual(f.sent,[]);
  assert.deepEqual(f.sql("SELECT * FROM facebook_alert_incidents WHERE state='attention'"),[]);
});

test('the stored rejection does not re-extract, duplicate the manual event or overwrite staff food edits',async t=>{
  const f=friday(t);
  f.sql(`INSERT INTO special_events(id,title,event_date,status,origin,manual_locked,date_basis,identity,fingerprint)
    VALUES('evt:staff','Black Friday Deal',?,'published','manual',1,'manual','staff:nov27','staff-fingerprint')`,day);
  const staffOffers=['Buy $50 Dollar Gift Card Get $55','Buy $100 Dollar Gift Card Get $110'];
  staffOffers.forEach((o,i)=>f.sql("INSERT INTO special_event_offers(event_id,position,content) VALUES('evt:staff',?,?)",i+1,o));
  await f.run();
  const [old]=f.imports();
  f.sql("UPDATE special_imports SET processing_status='failed',candidate_json=NULL,validation_result='rejected',validation_reason=? WHERE id=?",WEEKDAY_ENCODING_MISMATCH,old.id);
  f.addDaily();
  const lunch=f.slots(weekday,'lunch')[0],staffLunch='Staff corrected lunch $9.75';
  f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=1,manual_edited_at=? WHERE group_id=? AND position=1",
    staffLunch,now,lunch.group_id);
  await f.run();
  assert.equal(f.state.aiCalls,2);
  assert.equal(f.events().length,1);
  assert.equal(f.events()[0].origin,'manual');
  assert.deepEqual(f.offers(),staffOffers);
  assert.deepEqual(f.contents(),[staffLunch,...foodOffers.slice(1)]);
  assert.equal(f.delivery().active,1);

  // A genuine food ambiguity can remain for review while the explicit notice
  // independently stays active. A delivery ambiguity must veto that notice.
  const foodRow=f.imports().find(s=>s.fb_post_id===food.post.id);
  const uncertainFood=structuredClone(daily);
  uncertainFood.offers[2].uncertainties=['Price unreadable'];
  const checks=validate(uncertainFood);
  assert.equal(checks.validationResult,'ok');
  f.sql("UPDATE special_imports SET extracted_json=?,candidate_json=? WHERE id=?",JSON.stringify(uncertainFood),checks.candidateJson,foodRow.id);
  const sourceIds=f.imports().map(s=>s.id);
  const foodDecision=await reconcileToday(f.env,{sourceIds,today:day,weekday,inspectOnly:true});
  assert.ok(foodDecision.blocked.some(b=>b.reason==='Uncertain extracted offer'));
  const inspect=()=>reconcileDelivery(f.env,{sourceIds,observedAt:new Date(f.state.now).toISOString(),inspectOnly:true});
  assert.equal((await inspect()).expectedActive,true);
  // Conflicting image readings are a durable delivery hold, even when the
  // retained food reading still has a clearly printed delivery statement.
  f.sql('UPDATE special_imports SET candidate_json=? WHERE id=?',
    JSON.stringify({...JSON.parse(checks.candidateJson),delivery_blocked:true}),foodRow.id);
  assert.equal((await inspect()).status,'withheld');
  assert.equal(resolveDeliveryDisplay('hidden',f.delivery(),new Date(f.state.now)),'hidden');
  f.state.now=Date.parse('2026-11-27T19:30:00Z');
  assert.equal((await inspect()).status,'expired');
  assert.equal(resolveDeliveryDisplay('auto',f.delivery(),new Date(f.state.now)),'hidden');
});
