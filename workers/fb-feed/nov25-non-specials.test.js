// November 25 2026 follow-up: ordinary Facebook announcements (holiday closures,
// greetings, general news, photos) are non-actionable. The classification is
// structural (a complete reading with no offers, no delivery, no uncertainty and
// no specials wording or price in the heading or caption), never a holiday or
// topic keyword list. All AI responses are mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';
import {reconcileToday} from './guarded-auto.js';
import {noActionableSpecials} from './evidence.js';

const offer=(content,service_time='')=>({content,evidence:content,service_time,service_evidence:service_time,date_evidence:'',uncertainties:[]});
const noDelivery={status:'none',evidence:'',date_evidence:'',uncertainties:[]};
const reading=(poster_evidence,offers=[],day_of_week=-1,day_evidence='',extra={})=>({evidence_version:2,day_of_week,day_evidence,poster_evidence,delivery:noDelivery,offers,...extra});

const THANKSGIVING=reading("GRAYZ'N BUFFALO BAR & GRILL WE ARE CLOSED THANKSGIVING DAY 11/26 HAVE A SAFE AND HAPPY THANKSGIVING");
const CHRISTMAS=reading('CLOSED CHRISTMAS EVE AND CHRISTMAS DAY 12/24 12/25 MERRY CHRISTMAS');
const GREETING=reading('HAPPY NEW YEAR FROM ALL OF US');
const HIRING=reading('NOW HIRING COOKS AND SERVERS APPLY IN PERSON');
const PHOTO=reading('');

test('structural classification: announcements with nothing to publish are non-actionable', () => {
  for (const [r,caption] of [[THANKSGIVING,'We will be closed Thanksgiving Day. Have a safe and happy holiday!'],
    [CHRISTMAS,''],[GREETING,'Cheers!'],[HIRING,'Come join our team'],[PHOTO,'Great crowd tonight at the bar'.replace('tonight','today')],
    [{day_of_week:-1,day_evidence:'',poster_evidence:'BAND THIS SATURDAY',offers:[]},'']])
    assert.equal(noActionableSpecials(r,caption),true,JSON.stringify([r.poster_evidence,caption]));
});

test('any specials signal keeps a post actionable', () => {
  const actionable=[
    [reading('WEDNESDAY SPECIALS',[],3,'Wednesday'),''],                         // specials heading, unreadable offers
    [reading('CLOSED THANKSGIVING 11/26',[offer('Burger $10')]),''],              // mixed: closure plus a meal
    [reading('LUNCH 11-1:30'),''],                                                // a service heading
    [reading('PRIME RIB $24'),''],                                                // a printed price
    [reading('HAPPY THANKSGIVING'),"Today's specials are in the comments"],       // the caption names specials
    [reading('THANKSGIVING EVE'),'Wing Night $.89 wings'],                         // a caption price
    [reading('WE ARE OPEN',[],-1,'',{delivery:{status:'available',evidence:'Delivery available 11-1:30',date_evidence:'',uncertainties:[]}}),''],
    [reading('WE ARE OPEN',[],-1,'',{delivery:{status:'ambiguous',evidence:'',date_evidence:'',uncertainties:['faded']}}),''],
    [reading('CLOSED EARLY',[],-1,'',{uncertainties:['text partly hidden']}),''],
    [{type:'weekly-lunch',entries:[]},''],[{type:'mexican-night',groups:[]},''],
    [null,''],[[],''],[{offers:[]},''],                                           // unreadable or malformed
  ];
  for (const [r,caption] of actionable) assert.equal(noActionableSpecials(r,caption),false,JSON.stringify([r,caption]));
});

// ── November 25 timeline (8:36 AM specials, 1:13 PM closure) ──
const SPECIALS='CAPTION-NOV25-SPECIALS',CLOSURE='CAPTION-NOV25-CLOSURE';
const wednesday=reading('WEDNESDAY SPECIALS',[
  offer('Loaded Chicken Mac N Cheese Bowl and a Drink $9.75','11-1:30'),
  offer('Olive Burger with Side Salad, Chili or Coleslaw $10.25'),
  offer('Grilled Ham & Cheese with Cup of Chili or Coleslaw $7.25')],3,'Wednesday');
const PUBLISHED=['Loaded Chicken Mac N Cheese Bowl and a Drink $9.75',
  'Olive Burger with Side Salad, Chili or Coleslaw $10.25','Grilled Ham & Cheese with Cup of Chili or Coleslaw $7.25'];

function day(t,announcement,caption=CLOSURE) {
  const f=harness(t,{now:'2026-11-25T14:40:00Z',candidate:wednesday});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-23',week_end_date='2026-11-29' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'583672228384067_1780934790241064',message:SPECIALS,created_time:'2026-11-25T14:36:00Z',updated_time:'2026-11-25T14:36:00Z'});
  const responses=new Map([[SPECIALS,wednesday]]);
  f.env.AI.run=async(_model,request)=>{
    f.state.aiCalls++;
    const text=request.messages[1].content[0].text;
    return {response:JSON.stringify([...responses].find(([k])=>text.includes(k))?.[1] ?? announcement)};
  };
  const announce=async()=>{
    f.state.now=Date.parse('2026-11-25T19:20:00Z');
    f.state.posts.push({...f.state.posts[0],id:'583672228384067_1781190773548799',message:caption,
      created_time:'2026-11-25T19:13:00Z',updated_time:'2026-11-25T19:13:00Z',full_picture:'https://cdn.example/announcement.jpg'});
    await f.run();
    return f.imports().find(i=>i.fb_post_id.endsWith('1781190773548799'));
  };
  const values=()=>[...f.slots(3,'lunch').slice(0,1),...f.slots(3,'all-day').slice(0,2)].map(s=>s.content);
  const events=id=>f.sql("SELECT detail FROM special_import_events WHERE import_id=? AND event_type='review' ORDER BY id",id).map(e=>e.detail);
  const inspect=()=>reconcileToday(f.env,{sourceIds:f.imports().map(i=>i.id),today:'2026-11-25',weekday:3,inspectOnly:true});
  return {f,announce,values,events,inspect};
}

for (const [name,announcement,reason] of [
  ['Thanksgiving closure (another printed date)',THANKSGIVING,'Printed calendar date does not match current Chicago date'],
  ['Christmas closure naming two other weekdays',reading('CLOSED THURSDAY AND FRIDAY FOR CHRISTMAS',[],-1,''),null],
  ['holiday greeting',GREETING,null],
  ['general business announcement',HIRING,null],
]) test(`${name}: no block, no conflict, no staff task; Wednesday specials unchanged`,async t=>{
  const d=day(t,announcement);
  await d.f.run();
  assert.deepEqual(d.values(),PUBLISHED);
  const source=await d.announce();
  if (reason) assert.equal(source.validation_reason,reason); // the import-level date safeguard still records it
  assert.deepEqual(d.values(),PUBLISHED);
  const r=await d.inspect();
  assert.deepEqual([r.rejectedSources,r.blocked],[[],[]]);
  assert.ok(r.excludedSourceIds.includes(source.id));
  assert.ok(!d.events(source.id).some(e=>/CONFLICT/.test(e)),'no conflict audit on the announcement');
});

test('a conflict recorded before the fix is resolved once by a clean run; values and revision otherwise untouched',async t=>{
  const d=day(t,THANKSGIVING);
  await d.f.run();
  const specials=d.f.imports()[0];
  // The 1:15 PM audit the previous release wrote to both posts.
  const stale='GUARDED_AUTO_CONFLICT: 2026-11-25; blocked proposals: []; rejected sources: [{"reason":"Printed calendar date does not match current Chicago date"}]';
  d.f.sql("INSERT INTO special_import_events(import_id,event_type,detail) VALUES(?,'review','GUARDED_AUTO: 2026-11-25; no publication; CONFLICT: 1 rejected source(s), review required'),(?,'review',?)",specials.id,specials.id,stale);
  await d.announce();
  assert.deepEqual(d.values(),PUBLISHED);
  assert.match(d.events(specials.id).at(-1),/^GUARDED_AUTO: 2026-11-25; reconciled \d source\(s\); 0 slot\(s\)$/);
  const revision=d.f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision;
  const count=d.events(specials.id).length;
  await d.f.run();
  assert.equal(d.events(specials.id).length,count,'no repeated audit');
  assert.equal(d.f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision,revision);
});

test('legitimate specials with an incorrect date stay protected: not published, still held for review',async t=>{
  const d=day(t,reading('THURSDAY SPECIALS',[offer('Turkey Dinner $12.50')],4,'Thursday'));
  await d.f.run();
  const source=await d.announce();
  assert.equal(source.validation_reason,'Printed weekday does not match current Chicago day');
  assert.equal(noActionableSpecials(JSON.parse(source.extracted_json),source.caption),false);
  assert.deepEqual(d.values(),PUBLISHED);
  assert.ok(!d.values().some(v=>/Turkey/.test(v)));
});

test('a self-contradictory specials poster still blocks today (not treated as an announcement)',async t=>{
  const d=day(t,reading('WEDNESDAY SPECIALS',[offer('Turkey Dinner $12.50')],4,'Wednesday'));
  await d.f.run();
  await d.announce();
  const r=await d.inspect();
  assert.equal(r.rejectedSources.length,1);
});

test('mixed content: a closure notice beside a current special is handled as specials, not an announcement',async t=>{
  const mixed=reading('WEDNESDAY SPECIALS',[offer('Pumpkin Pie and Coffee $4.50'),offer('Closed tomorrow for Thanksgiving')],3,'Wednesday');
  assert.equal(noActionableSpecials(mixed,'Closed tomorrow!'),false);
  const d=day(t,mixed,'CAPTION-NOV25-MIXED Closed tomorrow!');
  await d.f.run();
  const source=await d.announce();
  const r=await d.inspect();
  assert.ok(!r.excludedSourceIds.includes(source.id));
});
