import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';
import {normalizeEvidenceOffer,analyzeDailyEvidence} from './evidence.js';
import {reconcileToday} from './guarded-auto.js';
import {dailyAlertDetail,NEWER_STAFF_EDIT} from './alert-detail.js';
import {dailyPublicationObservation} from './alert-policy.js';

// November 12, 2026 (import 8e9b4071d8f2b219c1a3e03e3f7e987e, parser 19): the three
// extracted meals and their verbatim evidence exactly as stored in production D1.
// Heading, weekday and posting time also match production (THURSDAY SPECIALS, day 4,
// THURSDAY, created 2026-11-12T14:22:43Z). AI responses are mocked.
const WRAP='Crispy Chicken Bacon Ranch Wrap, French Fries and a Drink $9.75';
const WESTERN='Western Burger with Side Salad, Chili or Coleslaw $10.25';
const HAM='Grilled Ham and Cheese with Cup of Chili or Coleslaw $7.25';
const NOV12=[
  {content:WRAP,evidence:'*1) CRISPY CHICKEN BACON RANCH WRAP, FRENCH FRIES AND A DRINK-* $9.75',service_time:''},
  {content:WESTERN,evidence:'*2) WESTERN BURGER WITH SIDE SALAD, CHILI OR COLESLAW -* $10.25',service_time:''},
  {content:HAM,evidence:'*3) GRILLED HAM AND CHEESE WITH CUP OF CHILI OR COLESLAW -* $7.25',service_time:''},
];
const none={status:'none',evidence:'',date_evidence:'',uncertainties:[]};
const reading=(offers=NOV12,heading='THURSDAY SPECIALS')=>({day_of_week:4,day_evidence:'THURSDAY',poster_evidence:heading,delivery:none,
  offers:offers.map(o=>({service_evidence:'',date_evidence:'',uncertainties:[],...o}))});
// Posted 8:22 AM Central; staff approved at 10:05 AM Central.
const POST={id:'583672228384067_1765416185126258',caption:'morning-poster',created:'2026-11-12T14:22:43+0000',reading:reading()};
const APPROVED_AT='2026-11-12T16:05:49.151Z';

function setup(t,now='2026-11-12T14:24:00Z') {
  const f=harness(t,{now,caption:'',candidate:reading()});
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-09',week_end_date='2026-11-15' WHERE id=9000");
  const readings=new Map();
  f.env.AI.run=async(_model,request)=>{
    f.state.aiCalls++;
    const text=JSON.stringify(request.messages);
    for(const [caption,value] of readings) if(text.includes(caption)) return {response:JSON.stringify(value)};
    throw Error('Unexpected caption');
  };
  f.scan=(at,posts)=>{
    f.state.now=Date.parse(at);
    f.state.posts=posts.map(({id,caption,created,updated=created,reading})=>{
      readings.set(caption,reading);
      return {id,message:caption,created_time:created,updated_time:updated,full_picture:`https://cdn.example/${id}.jpg`};
    });
    return f.run();
  };
  f.lunch=()=>f.slots(4,'lunch')[0];
  f.allDay=()=>f.slots(4,'all-day').slice(0,2).map(s=>s.content);
  f.revision=()=>f.sql("SELECT revision r FROM special_collections WHERE id='auto-week'")[0].r;
  f.conflicts=()=>f.sql("SELECT detail FROM special_import_events WHERE detail LIKE 'GUARDED_AUTO_CONFLICT%' ORDER BY id").map(e=>e.detail);
  f.set=(service,position,sql,...args)=>f.sql(`UPDATE special_slots SET ${sql} WHERE position=?${args.length+1} AND group_id IN
    (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=4 AND service=?${args.length+2})`,...args,position,service);
  return f;
}

// ── 1. The validator ─────────────────────────────────────────────────────────

test('November 12: all three meals pass evidence validation with their printed prices',()=>{
  assert.deepEqual(NOV12.map(o=>normalizeEvidenceOffer(o).content),[WRAP,WESTERN,HAM]);
  assert.deepEqual(analyzeDailyEvidence(reading()).issues.filter(i=>i.reason!=='Service not established by evidence'),[]);
});
test('decorated list markers are presentation; every food fact is still compared',()=>{
  const ok=(content,evidence)=>{try{normalizeEvidenceOffer({content,evidence,service_time:''});return true;}catch{return false;}};
  for(const mark of ['*1) ','•1) ','* 1) ','#1. ','~1) ','1) ','  *1)  ']) assert.ok(ok(WRAP,`${mark}CRISPY CHICKEN BACON RANCH WRAP, FRENCH FRIES AND A DRINK-* $9.75`),mark);
  const E='*2) WESTERN BURGER WITH SIDE SALAD, CHILI OR COLESLAW -* $10.25';
  for(const wrong of [
    'Western Burger with Side Salad, Soup or Coleslaw $10.25',   // chili vs soup
    'Western Burger with Side Salad, Chili and Coleslaw $10.25',  // or vs and
    'Western Burger with Side Salad, Chili or Coleslaw $10.50',   // another price
    'Western Burger with Chili or Coleslaw $10.25',               // missing side
    'Western Burger with Side Salad, Chili or Coleslaw or Fries $10.25', // added side
    'Large Western Burger with Side Salad, Chili or Coleslaw $10.25',    // size added
    'Western Burger $10.25',                                       // missing choices
  ]) assert.equal(ok(wrong,E),false,wrong);
  // A quantity is never mistaken for a marker, decorated or not.
  assert.equal(ok('1 Piece Fish with Fries $9.00','*2 PIECE FISH WITH FRIES $9.00'),false);
  assert.equal(ok('1 Piece Fish with Fries $9.00','*1) 2 PIECE FISH WITH FRIES $9.00'),false);
  assert.equal(ok('2 Piece Fish with Fries $9.00','*1) 2 PIECE FISH WITH FRIES $9.00'),true);
  assert.equal(ok('Large Pizza $12.00','*1) SMALL PIZZA $12.00'),false);
  // Letters, digits and "$" are never decoration before a marker.
  assert.equal(ok('Burger $9.00','A1) BURGER $9.00'),false);
  assert.equal(ok('Burger $9.00','$1) BURGER $9.00'),false);
});

// ── 2. Publication of the November 12 poster ─────────────────────────────────

test('November 12: Lunch #1 gets the wrap, All Day #1 the Western Burger, All Day #2 the ham and cheese',async t=>{
  const f=setup(t);
  await f.scan('2026-11-12T14:24:00Z',[POST]);
  assert.equal(f.lunch().content,WRAP);
  assert.deepEqual(f.allDay(),[WESTERN,HAM]);
  assert.deepEqual(f.conflicts(),[]);
  const revision=f.revision();
  await f.scan('2026-11-12T14:54:00Z',[POST]);
  assert.equal(f.revision(),revision,'the same unchanged source writes nothing again');
});

// ── 3. Facebook replaces every kind of previous website value ────────────────

for(const [name,sql] of [
  ['an old automatic value',"content='Old Wrap and a Drink $9.00',origin='automation',manual_locked=0,last_auto_value='Old Wrap and a Drink $9.00'"],
  ['a recurring default',"content='Crispy Chicken Bacon Ranch Wrap with French Fries and a Drink',origin='manual',manual_locked=0,last_auto_value=NULL"],
  ['a staff edit made before the post',"content='Staff Wrap $8.00',origin='manual',manual_locked=0,manual_edited_at='2026-11-11T20:00:00.000Z'"],
  ['a staff-locked value',"content='Locked Wrap $8.00',origin='manual',manual_locked=1,manual_edited_at='2026-11-11T20:00:00.000Z'"],
  ['a legacy value',"content='Legacy Wrap',origin='legacy',manual_locked=0"],
  ['a value changed since automation',"content='Changed Wrap',origin='automation',manual_locked=0,last_auto_value='Old Wrap'"],
  ['a value with a separate price',"content='Old Wrap',price='$8.00',origin='manual',manual_locked=0"],
  ['a value with a section link',"content='Old Wrap',section_link='mexican-night',origin='manual',manual_locked=0"],
  ['a staff lock blank of content',"content='',origin='manual',manual_locked=1"],
  ['a blank staff cleared without a recorded time',"content='',origin='legacy',manual_locked=0,last_auto_value='Old Wrap'"],
]) test(`a new Facebook source replaces ${name}`,async t=>{
  const f=setup(t);
  f.set('lunch',1,sql);
  await f.scan('2026-11-12T14:24:00Z',[POST]);
  const slot=f.lunch();
  assert.deepEqual([slot.content,slot.price,slot.section_link,slot.origin,slot.manual_locked,slot.last_auto_value,slot.manual_edited_at],
    [WRAP,'','','automation',0,WRAP,null]);
  assert.deepEqual(f.conflicts(),[]);
});

// A lock saved before edit times existed (the November 4 lunch correction) cannot be
// shown older than any post: kept, as an informational hold, until its week rolls over.
test('a legacy staff lock with no recorded edit time is kept and reported as a newer staff edit',async t=>{
  const f=setup(t);
  f.set('lunch',1,"content='Locked Wrap $8.00',origin='manual',manual_locked=1");
  await f.scan('2026-11-12T14:24:00Z',[POST]);
  assert.equal(f.lunch().content,'Locked Wrap $8.00');
  assert.deepEqual(f.allDay(),[WESTERN,HAM]);
  assert.match(f.conflicts().at(-1),/Newer staff edit retained/);
});

// ── 4. Staff corrections and approvals against unchanged versus newer sources ─

test('a staff correction after the post stays through repeated scans of the same unchanged source',async t=>{
  const f=setup(t);
  await f.scan('2026-11-12T14:24:00Z',[POST]);
  f.set('lunch',1,"content='Crispy Chicken Bacon Ranch Wrap, Fries and a Drink $9.50',origin='manual',manual_locked=0,manual_edited_at='2026-11-12T15:00:00.000Z'");
  for(const at of ['2026-11-12T15:30:00Z','2026-11-12T16:00:00Z','2026-11-12T16:30:00Z']) {
    await f.scan(at,[POST]);
    assert.equal(f.lunch().content,'Crispy Chicken Bacon Ranch Wrap, Fries and a Drink $9.50');
  }
  assert.deepEqual(f.allDay(),[WESTERN,HAM],'the other destinations are unaffected');
});
test('a newer post, or the same post with an actually edited image, replaces the staff correction',async t=>{
  for(const newer of [
    {id:'583672228384067_2',caption:'newer-poster',created:'2026-11-12T17:00:00+0000',reading:reading([{...NOV12[0],content:'Philly Wrap and a Drink $9.75',evidence:'*1) PHILLY WRAP AND A DRINK-* $9.75'},...NOV12.slice(1)])},
    {...POST,caption:'edited-poster',updated:'2026-11-12T17:00:00+0000',reading:reading([{...NOV12[0],content:'Philly Wrap and a Drink $9.75',evidence:'*1) PHILLY WRAP AND A DRINK-* $9.75'},...NOV12.slice(1)])},
  ]) {
    const f=setup(t);
    await f.scan('2026-11-12T14:24:00Z',[POST]);
    f.set('lunch',1,"content='Staff Wrap $9.50',origin='manual',manual_locked=1,manual_edited_at='2026-11-12T15:00:00.000Z'");
    await f.scan('2026-11-12T17:10:00Z',newer.id===POST.id?[newer]:[POST,newer]);
    assert.equal(f.lunch().content,'Philly Wrap and a Drink $9.75',newer.caption);
    assert.equal(f.lunch().manual_edited_at,null);
  }
});
test('November 12 lifecycle: a staff-approved import is not redundantly replaced; a newer post replaces the approved values',async t=>{
  const f=setup(t);
  // 10:05 AM: staff approved the three extracted values (approval writes a locked staff edit with its time).
  f.set('lunch',1,"content=?1,origin='manual',manual_locked=1,manual_edited_at=?2",WRAP,APPROVED_AT);
  f.set('all-day',1,"content=?1,origin='manual',manual_locked=1,manual_edited_at=?2",WESTERN,APPROVED_AT);
  f.set('all-day',2,"content=?1,origin='manual',manual_locked=1,manual_edited_at=?2",HAM,APPROVED_AT);
  const before=f.revision();
  // 10:30 AM: the same 8:22 AM source again. Formerly "Protected or ineligible destination slot" x3.
  await f.scan('2026-11-12T16:30:00Z',[POST]);
  assert.equal(f.revision(),before,'no redundant replacement');
  assert.deepEqual(f.conflicts(),[],'and no hold: the website already shows these values');
  assert.equal(f.lunch().manual_locked,1);
  // A newer verified poster for those destinations.
  const changed=reading([NOV12[0],{content:'Patty Melt with Side Salad, Chili or Coleslaw $10.25',evidence:'*2) PATTY MELT WITH SIDE SALAD, CHILI OR COLESLAW -* $10.25',service_time:''},NOV12[2]]);
  await f.scan('2026-11-12T18:10:00Z',[POST,{id:'583672228384067_3',caption:'afternoon-poster',created:'2026-11-12T18:00:00+0000',reading:changed}]);
  assert.deepEqual(f.allDay(),['Patty Melt with Side Salad, Chili or Coleslaw $10.25',HAM]);
  assert.equal(f.slots(4,'all-day')[0].origin,'automation');
});
test('a held correction is an intentional, non-alerting outcome; equal values are not a hold at all',async t=>{
  const f=setup(t);
  f.set('lunch',1,"content='Staff Wrap $9.50',origin='manual',manual_locked=0,manual_edited_at='2026-11-12T15:00:00.000Z'");
  await f.scan('2026-11-12T15:10:00Z',[POST]);
  const sourceIds=f.sql('SELECT id FROM special_imports').map(r=>r.id);
  const result=await reconcileToday(f.env,{sourceIds,today:'2026-11-12',weekday:4,inspectOnly:true});
  assert.deepEqual(result.blocked.map(b=>[b.service,b.position,b.reason]),[['lunch',1,NEWER_STAFF_EDIT]]);
  const data=[f.sql('SELECT * FROM special_imports'),f.sql('SELECT * FROM weekly_specials'),f.sql('SELECT * FROM special_collections'),f.sql('SELECT * FROM special_groups'),f.sql('SELECT * FROM special_slots')];
  const detail=dailyAlertDetail(result,data,'2026-11-12',4);
  assert.equal(detail.informational,true);
  assert.equal(detail.destinations[0].reason,'Staff edit is newer than this Facebook post; existing website value retained');
});

// ── 5. Nightly posters repeating the All Day pair ────────────────────────────

test('a Thursday night poster repeating the approved All Day pair publishes only its night offer',async t=>{
  const f=setup(t);
  f.set('all-day',1,"content=?1,origin='manual',manual_locked=1,manual_edited_at=?2",WESTERN,APPROVED_AT);
  f.set('all-day',2,"content=?1,origin='manual',manual_locked=1,manual_edited_at=?2",HAM,APPROVED_AT);
  const night=reading([
    {content:'Prime Rib Dinner with Baked Potato and Salad $21.99',evidence:'PRIME RIB DINNER WITH BAKED POTATO AND SALAD $21.99',service_time:''},
    {content:WESTERN,evidence:'WESTERN BURGER WITH SIDE SALAD, CHILI OR COLESLAW $10.25',service_time:''},
    {content:HAM,evidence:'GRILLED HAM AND CHEESE WITH CUP OF CHILI OR COLESLAW $7.25',service_time:''},
  ],'THURSDAY NIGHT SPECIALS 5-10');
  await f.scan('2026-11-12T22:10:00Z',[POST,{id:'583672228384067_4',caption:'night-poster',created:'2026-11-12T22:00:00+0000',reading:night}]);
  assert.deepEqual(f.slots(4,'nightly').map(s=>s.content),['Prime Rib Dinner with Baked Potato and Salad $21.99','','','']);
  assert.deepEqual(f.allDay(),[WESTERN,HAM],'no duplicate and no All Day meal published as Nightly');
  assert.deepEqual(f.conflicts(),[]);
});

// ── 6. Unverified evidence and concurrency ───────────────────────────────────

test('unverified evidence never overwrites correct content, and the failure is actionable',async t=>{
  const f=setup(t);
  await f.scan('2026-11-12T14:24:00Z',[POST]);
  const uncertain=reading([{...NOV12[0],content:'Philly Wrap and a Drink $9.75',evidence:'*1) PHILLY WRAP AND A DRINK-* $9.75',uncertainties:['Price partly obscured']},...NOV12.slice(1)]);
  await f.scan('2026-11-12T17:10:00Z',[POST,{id:'583672228384067_5',caption:'blurry-poster',created:'2026-11-12T17:00:00+0000',reading:uncertain}]);
  assert.equal(f.lunch().content,WRAP,'the verified value stays');
  assert.match(f.conflicts().at(-1),/Uncertain extracted offer/);
  const sourceIds=f.sql('SELECT id FROM special_imports').map(r=>r.id);
  const result=await reconcileToday(f.env,{sourceIds,today:'2026-11-12',weekday:4,inspectOnly:true});
  assert.equal(dailyPublicationObservation(result).state,'attention');
});
test('a mismatched meal still fails validation and alerts instead of publishing',async t=>{
  const f=setup(t);
  const wrong=reading([{...NOV12[0],content:'Crispy Chicken Bacon Ranch Wrap, Onion Rings and a Drink $9.75'},...NOV12.slice(1)]);
  await f.scan('2026-11-12T14:24:00Z',[{...POST,reading:wrong}]);
  assert.equal(f.lunch().content,'');
  assert.match(f.conflicts().join(),/Meal facts differ from original evidence/);
  const sourceIds=f.sql('SELECT id FROM special_imports').map(r=>r.id);
  assert.equal(dailyPublicationObservation(await reconcileToday(f.env,{sourceIds,today:'2026-11-12',weekday:4,inspectOnly:true})).state,'attention');
});
test('a staff save racing the reconciliation invalidates the whole plan; nothing is overwritten',async t=>{
  const f=setup(t);
  const batch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{
    if(statements[0].sql.startsWith('UPDATE special_collections'))
      f.set('lunch',1,"content='Racing Staff Wrap',origin='manual',manual_locked=0,manual_edited_at='2026-11-12T14:23:30.000Z'");
    return batch(statements);
  };
  await f.scan('2026-11-12T14:24:00Z',[POST]);
  assert.equal(f.lunch().content,'Racing Staff Wrap');
  assert.deepEqual(f.allDay(),['',''],'the stale plan wrote nothing at all');
  f.env.DB.batch=batch;
  await f.scan('2026-11-12T14:54:00Z',[POST]);
  assert.equal(f.lunch().content,'Racing Staff Wrap','the 8:22 post is older than that edit');
  assert.deepEqual(f.allDay(),[WESTERN,HAM]);
});
