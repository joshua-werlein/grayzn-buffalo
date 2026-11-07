import test from 'node:test';
import {normalizeMenuCase} from '../../src/lib/text-case.js';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {deliveryEvidence,deliveryReadingsAgree} from './delivery.js';
import {DELIVERY_TEXT,deliveryWindow,resolveDeliveryDisplay} from '../../src/lib/delivery.js';

// The rule: today's daily poster saying "delivery" turns on the website notice.
// AI responses are mocked; these exercise detection and publication, not vision.
const migration=readFileSync(new URL('../../migrations/0022_delivery_automation.sql',import.meta.url),'utf8');
const NOW='2026-11-03T15:36:00Z',CUTOFF='2026-11-03T19:30:00Z';
const tuesday=deliveryWindow(new Date(NOW));
const LUNCH='Hoagie Sandwich With Waffle Fries and A Drink $9.75';
const TURKEY='Turkey Club On Rye With Side Salad, Chili or Coleslaw $10.25';
const HAM='Grilled Ham and Cheese With Cup of Chili or Coleslaw $7.25';
const offer=(content,uncertainties=[])=>({content,evidence:content,service_time:'',service_evidence:'',date_evidence:'',uncertainties});
const notice=(evidence,extra={})=>({status:'available',evidence,date_evidence:'',uncertainties:[],...extra});
const NONE={status:'none',evidence:'',date_evidence:'',uncertainties:[]};
const PRINTED='DELIVERY AVAILABLE 11-1:30';
const poster=(delivery,first=offer(LUNCH))=>({day_of_week:2,day_evidence:'TUESDAY',poster_evidence:'TUESDAY LUNCH SPECIALS',delivery,offers:[first,offer(TURKEY),offer(HAM)]});
const undated=(heading,delivery=notice(PRINTED))=>({day_of_week:-1,day_evidence:'',poster_evidence:heading,delivery,offers:[offer(LUNCH),offer(TURKEY),offer(HAM)]});
// An uncertain meal forces the one conditional reread, whatever delivery says.
const uncertain=delivery=>poster(delivery,offer(LUNCH,['Price partly hidden']));

function setup(t,reads,{now=NOW,caption='',posts=[['daily','2026-11-03T15:35:04+0000']]}={}) {
  const f=harness(t,{now,caption});
  f.sql(migration);
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-02',week_end_date='2026-11-08' WHERE id=9000");
  f.state.posts=posts.map(([id,created_time])=>({id,message:caption,created_time,updated_time:created_time,full_picture:`https://cdn.example/${id}.jpg`}));
  f.env.AI.run=async()=>({response:JSON.stringify(reads[Math.min(f.state.aiCalls++,reads.length-1)])});
  const row=()=>f.sql('SELECT * FROM delivery_automation')[0];
  return {...f,row,display:()=>resolveDeliveryDisplay('auto',row(),new Date(f.state.now)),
    candidate:(i=0)=>JSON.parse(f.imports()[i].candidate_json)};
}

// ── The keyword ──────────────────────────────────────────────────────────────

for (const evidence of [
  'Delivery','delivery','DELIVERY','Delivery Available','Delivery 11-130','Delivery Available Within Mondovi City Limits',
  PRINTED,'DELIVERY AVAILABLE 11–1:30','DELIVERY AVAILABLE 11-130',"DELIVERY AVAILABLE 11–1:30 • TODAY'S FEATURE",'DELIVERY AVAILABLE • 11-1:30',
  'Free delivery!','Delivery until 2','We offer delivery today','(Delivery)','Delivery if driver available',
]) test(`poster saying ${JSON.stringify(evidence)} activates`,async t=>{
  assert.equal(deliveryEvidence(poster(notice(evidence)),tuesday),'available');
  const f=setup(t,[poster(notice(evidence))]);
  await f.run();
  assert.equal(f.display(),'available');
  assert.equal(f.row().active,1);
});

for (const [name,reading] of [
  ['the poster heading',{...poster(NONE),poster_evidence:'TUESDAY LUNCH SPECIALS DELIVERY AVAILABLE'}],
  ['a meal line',poster(NONE,offer(`${LUNCH} Delivery`))],
  ['a service field',poster(NONE,{...offer(LUNCH),service_evidence:'Delivery 11-1:30'})],
  ['a reading with no delivery field',(({delivery:_delivery,...rest})=>({...rest,poster_evidence:'TUESDAY DELIVERY SPECIALS'}))(poster(NONE))],
]) test(`the word in ${name} activates`,()=>{
  assert.equal(deliveryEvidence(reading,tuesday),'available');
});

for (const status of ['available','ambiguous','none'])
  test(`the model's ${status} label does not override the word`,()=>{
    assert.equal(deliveryEvidence(poster(notice(PRINTED,{status})),tuesday),'available');
  });

test('a model uncertainty does not stop the word, and its text does not count as the poster',()=>{
  assert.equal(deliveryEvidence(poster(notice(PRINTED,{uncertainties:['Footer partly hidden']})),tuesday),'available');
  assert.equal(deliveryEvidence(poster(notice('',{status:'none',uncertainties:['A delivery line may be hidden']})),tuesday),'none');
});

for (const evidence of ['','DINE IN OR TAKEOUT','Deliveryman wanted','Deliveries welcome','We are delivering','Redelivery','Delivered fresh'])
  test(`no whole word stays off: ${JSON.stringify(evidence)}`,()=>{
    assert.equal(deliveryEvidence(poster(notice(evidence)),tuesday),'none');
  });

test('missing delivery text never activates',()=>{
  const {delivery:_delivery,...absent}=poster(NONE);
  for (const raw of [absent,poster(NONE),poster({status:'available'}),poster({...notice(PRINTED),evidence:null}),null])
    assert.equal(deliveryEvidence(raw,tuesday),'none',JSON.stringify(raw?.delivery));
});

test('a caption is not the poster',async t=>{
  const f=setup(t,[poster(NONE)],{caption:'Delivery available today!'});
  await f.run();
  assert.equal(f.display(),'hidden');
  const g=setup(t,[poster(notice(PRINTED))],{caption:'No delivery tomorrow, no substitutions'});
  await g.run();
  assert.equal(g.display(),'available');
});

test('weekly and Mexican Night menus are not daily posters',()=>{
  for (const type of ['weekly-lunch','mexican-night'])
    assert.equal(deliveryEvidence({...poster(notice(PRINTED)),type},tuesday),'none',type);
});

// ── Cancellations ────────────────────────────────────────────────────────────

for (const evidence of ['NO DELIVERY TODAY','No delivery','DELIVERY NOT AVAILABLE','Delivery unavailable','DELIVERY CANCELLED','Delivery canceled today','DELIVERY PAUSED','Delivery suspended',"NO DELIVERY • TODAY'S FEATURE"])
  test(`cancellation turns delivery off: ${JSON.stringify(evidence)}`,async t=>{
    assert.equal(deliveryEvidence(poster(notice(evidence)),tuesday),'cancelled');
    const f=setup(t,[poster(notice(evidence))]);
    await f.run();
    assert.equal(f.display(),'hidden');
    assert.equal(f.row().active,0);
    assert.equal(f.slots(2,'lunch')[0].content,normalizeMenuCase(LUNCH),'food still publishes');
  });

test('the model reporting a cancellation turns delivery off',()=>{
  assert.equal(deliveryEvidence(poster(notice('',{status:'cancelled'})),tuesday),'cancelled');
});

test('a cancellation anywhere on the poster wins over a notice',()=>{
  assert.equal(deliveryEvidence({...poster(notice(PRINTED)),poster_evidence:'TUESDAY LUNCH SPECIALS\nNO DELIVERY TODAY'},tuesday),'cancelled');
});

for (const evidence of [
  'DELIVERY CLOSED','Delivery closed today','Delivery is closed','delivery, not available','Delivery: unavailable','Delivery — cancelled',
  'Delivery is not available today','Delivery will not be available','Delivery isn’t available',"Delivery won't be running",
  'Sorry, delivery is unavailable','CANCELLED DELIVERY','No more delivery today','Not offering delivery today',
]) test(`cancelling word applied to delivery turns it off: ${JSON.stringify(evidence)}`,()=>{
  assert.equal(deliveryEvidence(poster(notice(evidence)),tuesday),'cancelled');
});

test('DELIVERY CLOSED turns off the alert end to end and keeps food',async t=>{
  const f=setup(t,[poster(notice('DELIVERY CLOSED'))]);
  await f.run();
  assert.equal(f.display(),'hidden');assert.equal(f.row().active,0);
  assert.equal(f.slots(2,'lunch')[0].content,normalizeMenuCase(LUNCH));
});

for (const evidence of [
  'Delivery available, no substitutions','DELIVERY AVAILABLE, NO SUBSTITUTIONS','Delivery, no substitutions','No substitutions, delivery available',
  'No substitutions delivery available','Delivery available, closed Sundays','Delivery today 11-1:30. No substitutions.',
  'DELIVERY AVAILABLE • NO SUBSTITUTIONS','No substitutions\nDelivery available','Delivery available 11-130 no substitutions',
]) test(`a "no" or "closed" about something else stays on: ${JSON.stringify(evidence)}`,async t=>{
  assert.equal(deliveryEvidence(poster(notice(evidence)),tuesday),'available');
  const f=setup(t,[poster(notice(evidence))]);
  await f.run();
  assert.equal(f.display(),'available');assert.equal(f.row().active,1);
});

test('a cancellation on one current post turns off another post',async t=>{
  const f=setup(t,[poster(notice(PRINTED)),poster(notice('NO DELIVERY TODAY',{status:'cancelled'}))],
    {posts:[['lunch','2026-11-03T15:00:00+0000'],['update','2026-11-03T15:20:00+0000']]});
  await f.run();
  assert.equal(f.display(),'hidden');assert.equal(f.row().active,0);
});

// ── The poster must belong to today ──────────────────────────────────────────

test('the word cannot activate another day',()=>{
  assert.equal(deliveryEvidence({...poster(notice('Delivery')),day_of_week:3,day_evidence:'WEDNESDAY'},tuesday),'none');
  assert.equal(deliveryEvidence(poster(notice('Delivery',{date_evidence:'Tomorrow'})),tuesday),'none');
  assert.equal(deliveryEvidence(poster(notice('Delivery',{date_evidence:'11/4'})),tuesday),'none');
  assert.equal(deliveryEvidence(poster(notice('DELIVERY TOMORROW')),tuesday),'none');
  assert.equal(deliveryEvidence({...poster(NONE),poster_evidence:'TUESDAY SPECIALS DELIVERY NEXT WEEK'},tuesday),'none');
});

const BRANDED="GRAYZ'N BUFFALO BAR & GRILL DAILY SPECIALS";
for (const heading of ['DAILY SPECIALS',BRANDED,'GRAYZ’N BUFFALO BAR AND GRILL\nDAILY SPECIALS'])
  test(`undated template with a same-day Facebook timestamp: ${JSON.stringify(heading)}`,()=>{
    assert.equal(deliveryEvidence(undated(heading,notice('Delivery')),tuesday,{trustedSameDay:true}),'available');
    assert.equal(deliveryEvidence(undated(heading,notice('Delivery')),tuesday),'none','the timestamp is still required');
  });

test('the undated template keeps its date protections',()=>{
  const saturday=deliveryWindow(new Date('2026-11-07T15:00:00Z'));
  assert.equal(deliveryEvidence(undated(BRANDED),saturday,{trustedSameDay:true}),'none');
  for (const heading of [`${BRANDED} NEXT WEEK`,`THURSDAY ${BRANDED}`])
    assert.equal(deliveryEvidence(undated(heading),tuesday,{trustedSameDay:true}),'none',heading);
  assert.equal(deliveryEvidence(undated(BRANDED,notice(PRINTED,{date_evidence:'11/4'})),tuesday,{trustedSameDay:true}),'none');
  assert.equal(deliveryEvidence(undated(BRANDED,notice('NO DELIVERY TODAY')),tuesday,{trustedSameDay:true}),'cancelled');
});

test('the real October 30 branded poster shape publishes delivery end to end',async t=>{
  const fixture=JSON.parse(readFileSync('tests/fixtures/oct30-daily-specials.json','utf8'));
  const f=setup(t,[{...fixture,delivery:notice('Delivery')}]);
  await f.run();
  assert.equal(f.state.aiCalls,1);
  assert.equal(f.row().active,1);assert.equal(f.display(),'available');
});

// ── Rereads ──────────────────────────────────────────────────────────────────

test('readings agree when they reach the same result, whatever the wording',()=>{
  const read=delivery=>({delivery});
  for (const [a,b] of [
    [notice(PRINTED),notice('Delivery')],[notice(PRINTED),notice('delivery 11-130 ')],
    [notice(PRINTED),notice(PRINTED,{status:'ambiguous',uncertainties:['Footer hidden']})],
    [notice(PRINTED),notice(PRINTED,{date_evidence:'TUESDAY'})],
    [NONE,{...NONE,evidence:' '}],[notice('NO DELIVERY'),notice('Delivery unavailable')],
  ]) assert.ok(deliveryReadingsAgree(read(a),read(b)),`${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  for (const [a,b] of [
    [notice(PRINTED),NONE],[NONE,notice(PRINTED)],[notice(PRINTED),undefined],
    [notice(PRINTED),notice('NO DELIVERY TODAY')],[notice('NO DELIVERY TODAY'),notice(PRINTED)],
  ]) assert.equal(deliveryReadingsAgree(read(a),read(b)),false,`${JSON.stringify(a)} / ${JSON.stringify(b)}`);
});

test('a reread differing only by wording keeps delivery; the uncertain meal stays held',async t=>{
  const f=setup(t,[uncertain(notice(PRINTED)),uncertain(notice('delivery 11-130'))]);
  await f.run();
  assert.equal(f.state.aiCalls,2);
  assert.equal(f.candidate().delivery_blocked,undefined);
  assert.equal(f.display(),'available');
  assert.equal(f.slots(2,'lunch')[0].content,'','delivery never releases a held meal');
});

for (const [name,first,second] of [
  ['a reread that no longer sees the word',notice(PRINTED),NONE],
  ['a reread that cancels',notice(PRINTED),notice('NO DELIVERY TODAY',{status:'cancelled'})],
  ['a reread that cannot override a cancellation',notice('NO DELIVERY TODAY',{status:'cancelled'}),notice(PRINTED)],
]) test(`${name} keeps delivery off`,async t=>{
  const f=setup(t,[uncertain(first),uncertain(second)]);
  await f.run();
  assert.equal(f.candidate().delivery_blocked,true);
  assert.equal(f.display(),'hidden');
});

const MEXICAN={type:'mexican-night',poster_evidence:'MEXICAN NIGHT',schedule:'Tuesdays 5-10 PM',groups:[{label:'Entrees',items:[{title:'Burrito $9.00',description:'Meat and beans',evidence:'Burrito $9.00 Meat and beans',uncertainties:[]}]}]};
const nightFirstRead=delivery=>({day_of_week:2,day_evidence:'TUESDAY',poster_evidence:'TUESDAY NIGHT',delivery,offers:[]});
const twoPosts=[['lunch','2026-11-03T15:00:00+0000'],['menu','2026-11-03T15:20:00+0000']];

test('a repaired Mexican Night poster with no notice cannot block the lunch poster',async t=>{
  const f=setup(t,[poster(notice(PRINTED)),nightFirstRead(NONE),MEXICAN],{posts:twoPosts});
  await f.run();
  assert.equal(f.state.aiCalls,3);
  assert.equal(f.candidate(1).type,'mexican-night');assert.equal(f.candidate(1).delivery_blocked,undefined);
  assert.equal(f.display(),'available');
});

test('a Mexican Night first reading that printed a cancellation still turns delivery off',async t=>{
  const f=setup(t,[poster(notice(PRINTED)),nightFirstRead(notice('NO DELIVERY TODAY',{status:'cancelled'})),MEXICAN],{posts:twoPosts});
  await f.run();
  assert.equal(f.candidate(1).delivery_blocked,true);
  assert.equal(f.display(),'hidden');
});

// ── Lifecycle, staff settings and the website wording ────────────────────────

test('repeat processing reuses the first reading and never changes the deadline or wording',async t=>{
  const f=setup(t,[poster(notice('Delivery'))]);
  await f.run();
  assert.equal(f.state.aiCalls,1);
  const row=f.row();
  assert.equal(row.active,1);assert.equal(row.expires_at,tuesday.expiresAt);assert.equal(row.expires_at,CUTOFF.replace('Z','.000Z'));
  const slots=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  await f.run();
  assert.deepEqual(f.row(),row);
  f.state.now+=30*60000;await f.run();
  assert.equal(f.state.aiCalls,1);assert.equal(f.row().active,1);assert.equal(f.row().expires_at,row.expires_at);
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),slots);
});

test('the word cannot change hours: other printed hours still expire at 1:30 PM',async t=>{
  const f=setup(t,[poster(notice('Delivery 11-5'))]);
  await f.run();assert.equal(f.display(),'available');
  f.state.now=Date.parse(CUTOFF)-1000;assert.equal(f.display(),'available');
  f.state.now=Date.parse(CUTOFF);assert.equal(f.display(),'hidden');
  await f.run();assert.equal(f.row().active,0);
  f.state.now+=60000;await f.run();
  assert.equal(f.row().active,0);assert.equal(f.display(),'hidden');assert.equal(f.state.aiCalls,1);
});

test('a poster first processed after the cutoff never activates',async t=>{
  const f=setup(t,[poster(notice('Delivery'))],{now:'2026-11-03T19:31:00Z'});
  await f.run();
  assert.notEqual(f.row()?.active,1);
  assert.equal(resolveDeliveryDisplay('auto',f.row()??null,new Date(f.state.now)),'hidden');
});

test('delivery never carries to the next day, and staff settings win over the word and a cancellation',async t=>{
  const f=setup(t,[poster(notice('Delivery'))]);
  await f.run();
  const row=f.row();
  assert.equal(resolveDeliveryDisplay('auto',row,new Date('2026-11-04T15:00:00Z')),'hidden');
  for (const manual of ['available','unavailable','hidden']) {
    assert.equal(resolveDeliveryDisplay(manual,row,new Date(NOW)),manual);
    assert.equal(resolveDeliveryDisplay(manual,{...row,active:0},new Date(NOW)),manual);
  }
});

test('automation stores only timing state; the website owns the banner wording',async t=>{
  const f=setup(t,[poster(notice('Delivery'))]);
  await f.run();
  assert.deepEqual(Object.keys(f.row()).sort(),['active','day','expires_at','id','observed_at','source_ids']);
  assert.equal(DELIVERY_TEXT,'Delivery M–F 11 AM–1:30 PM, within Mondovi city limits.');
});
