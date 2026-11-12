import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';
import {eventCue,eventTime,eventHoursReview,routeEventSource,routeStoredSources,isEventMessage} from './events.js';
import {reconcileToday} from './guarded-auto.js';
import {canonicalizeSlotContent as canonicalize} from './reconcile.js';

// November 11 2026 (Wednesday, Veterans Day). Production D1 (read-only, Wrangler
// 4.158.0): import 29fa68804c48f6eb7a6db890a59fd721, post
// 583672228384067_1764187355249141, 8:03 AM Chicago, staged/ok, parser 19, and
// no special_events row for 2026-11-11. The poster printed "Veterans Day
// Special" and one offer with no hours. The stored candidate_json itself was not
// read; the transcription below follows the reported poster and the contract-2
// prompt (headline in poster_evidence, no service evidence). HYPOTHETICAL
// variants are marked.
const VETERANS_POST='583672228384067_1764187355249141',WEDNESDAY_POST='583672228384067_1764217808579429';
const offer=(content,extra={})=>({content,evidence:content,service_time:'',service_evidence:'',date_evidence:'',uncertainties:[],...extra});
const daily=(heading,offers,day=-1,day_evidence='')=>({day_of_week:day,day_evidence,poster_evidence:heading,
  delivery:{status:'none',evidence:'',date_evidence:'',uncertainties:[]},offers});
const VETERANS_OFFER='Choice of Any Burger & Side with a Drink $7.00';
const veterans=daily('VETERANS DAY SPECIAL',[offer('Choice of any Burger & Side with a Drink $7.00')]);
// The 8:35 AM regular poster: the three specials the alert reported as published.
const wednesday=daily('DAILY SPECIALS',[
  offer('Mushroom and Swiss with Beer Fries and a Drink $9.75'),
  offer('Grilled Chicken Bacon Ranch Sandwich with Side Salad, Chili or Coleslaw $10.25'),
  offer('Grilled Ham and Cheese with Cup of Chili or Coleslaw $7.25')]);
const route=(candidate,caption='',postDate='2026-11-11')=>routeEventSource({candidate:structuredClone(candidate),caption,postDate,canonicalize});

test('Veterans Day is a recognized holiday in every printed spelling; nearby words are not',()=>{
  for(const text of ['VETERANS DAY SPECIAL',"Veteran's Day Special","Veterans' Day",'Happy Veterans Day!','veterans day'])
    assert.deepEqual(eventCue(text),{identity:'veterans-day',kind:'holiday',specific:true},text);
  for(const text of ['Veterans discount every day','Thank you veterans','Wednesday Specials']) assert.equal(eventCue(text),null,text);
});

test('November 11 regression: the Veterans Day poster publishes as an all-day event, not a held daily item',()=>{
  const r=route(veterans);
  assert.equal(r.route,'event');assert.equal(r.publish,true);
  assert.deepEqual(r.draft.review_reasons,[]);
  assert.equal(r.draft.title,'Veterans Day Special');assert.equal(r.draft.identity,'veterans-day');
  assert.equal(r.draft.event_date,'2026-11-11');assert.equal(r.draft.date_basis,'publication-date');
  // No hours printed: all day, no invented window.
  assert.deepEqual([r.draft.time_text,r.draft.start_time,r.draft.end_time],['',null,null]);
  assert.deepEqual(r.draft.offers,[VETERANS_OFFER]);
  // The evidence keeps the printed heading verbatim for audit.
  assert.equal(r.draft.evidence.heading,'VETERANS DAY SPECIAL');
});

test('before this fix the same poster routed to the daily specials (the confirmed root cause)',()=>{
  // Without the holiday the heading is not an event cue, so the poster was a
  // regular source whose one offer had no service evidence: "Unidentified service".
  const unrecognized=daily('VETERANS SPECIAL',veterans.offers);
  assert.equal(route(unrecognized).route,'regular');
});

test('the Wednesday regular poster is never an event, even beside a Veterans Day caption',()=>{
  for(const caption of ['','Happy Veterans Day! Here are today’s specials','Veterans Day special pricing inside!'])
    assert.equal(route(wednesday,caption).route,'regular',caption);
  const stored=routeStoredSources([
    {processing_status:'staged',candidate_json:JSON.stringify(veterans),fb_created_time:'2026-11-11T14:03:00+0000',caption:''},
    {processing_status:'staged',candidate_json:JSON.stringify(wednesday),fb_created_time:'2026-11-11T14:35:00+0000',caption:''},
  ],{today:'2026-11-11',canonicalize});
  assert.deepEqual(stored.map(r=>r.route),['event','regular']);
});

test('caption-only holidays: a promotion caption routes a small poster; a greeting alone does not (HYPOTHETICAL)',()=>{
  const plain=daily('SPECIAL',veterans.offers);
  assert.equal(route(plain,'Veterans Day special: burger and side with a drink!').route,'event');
  assert.equal(route(plain,'Happy Veterans Day! Thank you for your service.').route,'regular');
  // Team captions keep their existing behavior.
  assert.equal(route(plain,'Packers kickoff at noon!').route,'event');
});

test('Veterans Day is November 11: an undated poster posted on another day is held, never re-dated',()=>{
  const r=route(veterans,'','2026-11-10');
  assert.equal(r.route,'event');assert.equal(r.publish,false);
  assert.match(r.draft.review_reasons.join(' '),/Veterans Day is November 11/);
  // "Tomorrow" or a printed date on the day before resolves to November 11 and publishes.
  assert.equal(route(daily('VETERANS DAY SPECIAL TOMORROW',veterans.offers),'','2026-11-10').publish,true);
  assert.equal(route(daily('VETERANS DAY SPECIAL 11/11',veterans.offers),'','2026-11-09').draft.event_date,'2026-11-11');
  // A conflicting printed date never publishes.
  assert.equal(route(daily('VETERANS DAY SPECIAL 11/12',veterans.offers),'','2026-11-10').publish,false);
});

test('hours: printed windows are kept; overnight and conflicting hours hold the event (HYPOTHETICAL)',()=>{
  const timed=route(daily('PACKERS GAME SPECIAL 12-4pm',[offer('Brat and Chips $5')]),'','2026-11-15');
  assert.equal(timed.publish,true);assert.deepEqual([timed.draft.start_time,timed.draft.end_time],['12:00','16:00']);
  const overnight=route(daily('PACKERS GAME SPECIAL 7pm-1am',[offer('Brat and Chips $5')]),'','2026-11-15');
  assert.equal(overnight.publish,false);assert.match(overnight.draft.review_reasons.join(' '),/cross midnight/);
  const conflicting=route(daily('PACKERS GAME SPECIAL 12-4pm',[offer('Brat and Chips $5')]),'Specials 11am-3pm today!','2026-11-15');
  assert.equal(conflicting.publish,false);assert.match(conflicting.draft.review_reasons.join(' '),/hours disagree/);
  // The same window repeated in the caption agrees.
  assert.equal(route(daily('PACKERS GAME SPECIAL 12-4pm',[offer('Brat and Chips $5')]),'Game day 12-4pm','2026-11-15').publish,true);
  assert.equal(eventHoursReview('no hours'),null);
  assert.deepEqual(eventTime('9pm-1am'),{time_text:'9pm-1am',start_time:null,end_time:null});
});

// End to end through the Worker on November 11: both real posts, real timestamps.
function november11(t,mode='AUTO') {
  const f=harness(t,{now:'2026-11-11T14:04:00Z',candidate:structuredClone(veterans)});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-09',week_end_date='2026-11-15' WHERE id=9000");
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  if(mode) f.env.SPECIAL_EVENTS_MODE=mode;
  Object.assign(f.state.posts[0],{id:VETERANS_POST,message:'',created_time:'2026-11-11T14:03:00+0000',updated_time:'2026-11-11T14:03:00+0000'});
  const addWednesday=()=>{
    f.state.now=Date.parse('2026-11-11T14:36:00Z');f.state.candidate=structuredClone(wednesday);
    f.state.posts.push({...f.state.posts[0],id:WEDNESDAY_POST,created_time:'2026-11-11T14:35:00+0000',updated_time:'2026-11-11T14:35:00+0000'});
  };
  const wednesdaySlots=()=>f.sql(`SELECT g.service,s.position,s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id
    WHERE g.collection_id='auto-week' AND g.day_of_week=3 AND s.content<>'' AND g.service IN ('lunch','all-day') ORDER BY g.service,s.position`);
  return {...f,addWednesday,wednesdaySlots,events:()=>f.sql('SELECT * FROM special_events'),
    offers:id=>f.sql('SELECT content FROM special_event_offers WHERE event_id=? ORDER BY position',id).map(o=>o.content)};
}
const REGULAR=[
  {service:'all-day',position:1,content:'Grilled Chicken Bacon Ranch Sandwich with Side Salad, Chili or Coleslaw $10.25'},
  {service:'all-day',position:2,content:'Grilled Ham and Cheese with Cup of Chili or Coleslaw $7.25'},
  {service:'lunch',position:1,content:'Mushroom and Swiss with Beer Fries and a Drink $9.75'}];

test('November 11 end to end: Veterans Day publishes as an event and Wednesday’s three specials publish unchanged',async t=>{
  const f=november11(t);
  await f.run();f.addWednesday();await f.run();
  const [e]=f.events();
  assert.equal(f.events().length,1);
  assert.deepEqual([e.title,e.event_date,e.status,e.origin,e.manual_locked,e.identity,e.source_post_id,e.start_time,e.end_time],
    ['Veterans Day Special','2026-11-11','published','automation',0,'veterans-day',VETERANS_POST,null,null]);
  assert.deepEqual(f.offers(e.id),[VETERANS_OFFER]);
  assert.deepEqual(f.wednesdaySlots().map(({service,position,content})=>({service,position,content})),REGULAR);
  // No held daily item: the event post is excluded from the daily specials.
  const ids=f.imports().map(i=>i.id);
  const result=await reconcileToday(f.env,{sourceIds:ids,today:'2026-11-11',weekday:3,inspectOnly:true});
  assert.deepEqual(result.blocked,[]);assert.deepEqual(result.rejectedSources,[]);
  assert.ok(result.excludedSourceIds.includes(f.imports().find(i=>i.fb_post_id===VETERANS_POST).id));
  // Retried scans are idempotent: no second event, revision or slot change.
  const before=[f.events(),f.wednesdaySlots()];
  f.state.now+=30*60000;await f.run();f.state.now+=30*60000;await f.run();
  assert.deepEqual([f.events(),f.wednesdaySlots()],before);
});

test('November 11: a staff-entered Veterans Day event prevents a duplicate from the Facebook poster',async t=>{
  const f=november11(t);
  f.sql(`INSERT INTO special_events(id,title,event_date,status,origin,manual_locked,date_basis,identity,fingerprint)
    VALUES('evt:staff-1','Veterans Day Special','2026-11-11','published','manual',1,'manual','veterans-day','staff')`);
  f.sql("INSERT INTO special_event_offers(event_id,position,content) VALUES('evt:staff-1',1,'Any Burger, Side and Drink $7')");
  await f.run();f.addWednesday();await f.run();
  assert.deepEqual(f.events().map(e=>[e.id,e.status]),[['evt:staff-1','published']]);
  assert.deepEqual(f.offers('evt:staff-1'),['Any Burger, Side and Drink $7']);
  assert.ok(f.sql("SELECT detail FROM special_event_log WHERE action='conflict'").some(l=>/veterans-day/.test(l.detail)));
  assert.deepEqual(f.wednesdaySlots().map(({service,position,content})=>({service,position,content})),REGULAR);
});

test('November 11: a staff removal of the Veterans Day event is never undone by the next scan',async t=>{
  const f=november11(t);
  await f.run();
  f.sql("UPDATE special_events SET status='rejected',manual_locked=1,review_reason='Removed by staff',revision=revision+1");
  f.state.now+=30*60000;await f.run();f.addWednesday();await f.run();
  assert.deepEqual(f.events().map(e=>e.status),['rejected']);
  // The removed poster also stays out of the daily specials.
  assert.deepEqual(f.wednesdaySlots().map(({service,position,content})=>({service,position,content})),REGULAR);
});

test('November 11: a staff-linked event (published from Automation Review) keeps a held poster out of the daily specials',async t=>{
  // HYPOTHETICAL: a poster the classifier cannot recognize, published by staff.
  const f=november11(t);
  f.state.candidate=daily('THANK YOU FOR YOUR SERVICE',veterans.offers);
  await f.run();
  const source=f.imports()[0];
  let held=await reconcileToday(f.env,{sourceIds:[source.id],today:'2026-11-11',weekday:3,inspectOnly:true});
  assert.equal(held.blocked.length,1);   // Held as an unidentified-service item.
  f.sql(`INSERT INTO special_events(id,title,event_date,status,origin,manual_locked,date_basis,identity,source_post_id,source_import_id)
    VALUES('evt:staff-2','Veterans Day Special','2026-11-11','published','manual',1,'manual','veterans-day',?,?)`,source.fb_post_id,source.id);
  f.sql("INSERT INTO special_event_offers(event_id,position,content) VALUES('evt:staff-2',1,?)",VETERANS_OFFER);
  held=await reconcileToday(f.env,{sourceIds:[source.id],today:'2026-11-11',weekday:3,inspectOnly:true});
  assert.deepEqual(held.blocked??[],[]);assert.ok(held.excludedSourceIds.includes(source.id));
  f.state.now+=30*60000;await f.run();
  assert.deepEqual(f.events().map(e=>[e.id,e.status,e.origin]),[['evt:staff-2','published','manual']]);
});

test('November 11 with events OFF: unchanged emergency behavior (no event; the poster is a daily hold)',async t=>{
  const f=november11(t,null);
  await f.run();
  assert.deepEqual(f.events(),[]);
  const held=await reconcileToday(f.env,{sourceIds:f.imports().map(i=>i.id),today:'2026-11-11',weekday:3,inspectOnly:true});
  assert.equal(held.blocked.length,1);
});

// The published Veterans Day card showed "THANK YOU TO ALL WHO SERVED" as a second
// offer. A greeting is the event message, never an offer, and never holds the event.
const VETERANS_CAPS=daily('VETERANS DAY SPECIAL',[offer('CHOICE OF ANY BURGER AND SIDE WITH A DRINK $7'),offer('THANK YOU TO ALL WHO SERVED')]);

test('Veterans Day poster with a greeting: one priced offer, the greeting is the event message, both in house case',()=>{
  const r=route(VETERANS_CAPS);
  assert.equal(r.route,'event');assert.equal(r.publish,true);assert.deepEqual(r.draft.review_reasons,[]);
  assert.deepEqual(r.draft.offers,['Choice of Any Burger and Side with a Drink $7']);
  assert.equal(r.draft.details,'Thank You To All Who Served');
  // The fingerprint covers priced offers only; the printed evidence stays verbatim for audit.
  assert.equal(r.draft.fingerprint,route(daily('VETERANS DAY SPECIAL',[VETERANS_CAPS.offers[0]])).draft.fingerprint);
  assert.deepEqual(r.draft.evidence.offers,['CHOICE OF ANY BURGER AND SIDE WITH A DRINK $7']);
  assert.deepEqual(r.draft.evidence.message,['THANK YOU TO ALL WHO SERVED']);
});

test('event messages are greetings and conditions only; anything priced or uncertain stays an offer',()=>{
  for(const text of ['THANK YOU TO ALL WHO SERVED','Happy Veterans Day!','We salute our veterans','Dine-in only','While supplies last','GO PACK GO!','With valid military ID'])
    assert.equal(isEventMessage(offer(text)),true,text);
  for(const text of ['Thank you! $5 burgers','Happy hour $2 off taps','Free pie with any meal','PULLED PORK SANDWICH','Burger and fries','Join us for $3 pints','Limit 2 per customer'])
    assert.equal(isEventMessage(offer(text)),false,text);
  assert.equal(isEventMessage(offer('Thank you to all who served',{uncertainties:['partly hidden']})),false);
  assert.equal(isEventMessage(offer('Thank you to all who served',{evidence:'THANK YOU... $7'})),false);
});

test('an unpriced line that is not a greeting still holds the event: no invented price (HYPOTHETICAL)',()=>{
  const r=route(daily('VETERANS DAY SPECIAL',[VETERANS_CAPS.offers[0],offer('PULLED PORK SANDWICH')]));
  assert.equal(r.route,'event');assert.equal(r.publish,false);
  assert.match(r.draft.review_reasons.join(' '),/offer 2: Missing meal price/);
  // Only greetings: no priced offer, held.
  const only=route(daily('VETERANS DAY SPECIAL',[offer('THANK YOU TO ALL WHO SERVED')]));
  assert.equal(only.publish,false);assert.match(only.draft.review_reasons.join(' '),/No printed, priced event offer/);
});

test('November 11 end to end with the greeting: one offer, the message stored in details, and rescans change nothing',async t=>{
  const f=november11(t);
  f.state.candidate=structuredClone(VETERANS_CAPS);
  await f.run();f.addWednesday();await f.run();
  const [e]=f.events();
  assert.deepEqual([f.events().length,e.status,e.title,e.details],[1,'published','Veterans Day Special','Thank You To All Who Served']);
  assert.deepEqual(f.offers(e.id),['Choice of Any Burger and Side with a Drink $7']);
  // Normalized once: the stored automation snapshot matches, so a rescan never rewrites it.
  assert.equal(JSON.parse(e.last_auto_json).details,'Thank You To All Who Served');
  assert.deepEqual(f.wednesdaySlots().map(({service,position,content})=>({service,position,content})),REGULAR);
  const before=[f.events(),f.offers(e.id)];
  f.state.now+=30*60000;await f.run();
  assert.deepEqual([f.events(),f.offers(e.id)],before);
});
