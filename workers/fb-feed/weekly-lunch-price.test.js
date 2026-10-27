import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';
import {sharedWeeklyLunchPrice,applySharedWeeklyLunchPrice,SHARED_WEEKLY_PRICE_AMBIGUOUS} from './reconcile.js';

// October 26-30, 2026 poster: one shared $9.75 price in the heading, five
// weekday meals without their own price. Monday is the published production
// meal; the other rows are representative meals in the same layout.
const HEADING='WEEKLY LUNCH SPECIALS • $9.75 • 10/26-10/30';
const MEALS=[
  '3 Topping Personal Pizza & a Drink',
  'Chicken Bacon Ranch Wrap w/ French Fries & a Drink',
  'Patty Melt w/ Beer Fries & a Drink',
  'Chicken Alfredo w/ Garlic Bread & a Drink',
  'Fish Sandwich w/ French Fries & a Drink',
];
const LABELS=['','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'];
const weekly=({heading=HEADING,meals=MEALS,service_time='11 AM-1:30 PM'}={})=>({type:'weekly-lunch',evidence_version:2,
  poster_evidence:heading,date_range:'10/26-10/30',service_time,
  entries:meals.map((content,i)=>({day_of_week:i+1,content,evidence:`${LABELS[i+1]} ${content}`,uncertainties:[]}))});
const priced=meal=>`${meal} - $9.75`;

function octoberWeek(t,candidate=weekly(),version='2') {
  const f=harness(t,{now:'2026-10-26T16:00:00Z',caption:'Weekly Lunch Specials 10/26-10/30',candidate});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  if(version==='2') Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  Object.assign(f.state.posts[0],{created_time:'2026-10-26T13:00:00Z',updated_time:'2026-10-26T13:00:00Z'});
  return f;
}
const lunch=(f,day)=>f.slots(day,'lunch')[0];
const setSlot=(f,day,content,origin,locked,lastAuto=content)=>f.sql(
  'UPDATE special_slots SET content=?,origin=?,manual_locked=?,last_auto_value=? WHERE group_id=? AND position=1',
  content,origin,locked,lastAuto,lunch(f,day).group_id);
const snapshot=f=>({collection:f.sql("SELECT revision,mutation_token FROM special_collections WHERE id='auto-week'"),
  slots:f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),events:f.sql('SELECT * FROM special_import_events')});

// ── Shared heading price evidence ──────────────────────────────────────────────

test('one heading price is the shared weekly lunch price',()=>{
  assert.deepEqual(sharedWeeklyLunchPrice({poster_evidence:HEADING,service_time:'11 AM-1:30 PM'}),{price:'$9.75',ambiguous:false});
  assert.deepEqual(sharedWeeklyLunchPrice({poster_evidence:'WEEKLY LUNCH SPECIALS $ 9.75',service_time:''}),{price:'$9.75',ambiguous:false});
  // The price may be read into the overall service line instead of the heading.
  assert.deepEqual(sharedWeeklyLunchPrice({poster_evidence:'WEEKLY SPECIALS 10/26-10/30',service_time:'11-1:30 • $9.75'}),{price:'$9.75',ambiguous:false});
  // The same amount printed twice is still one price.
  assert.deepEqual(sharedWeeklyLunchPrice({poster_evidence:'WEEKLY LUNCH SPECIALS $9.75',service_time:'11-1:30 $9.75'}),{price:'$9.75',ambiguous:false});
});

test('no heading price leaves weekly rows unchanged',()=>{
  assert.deepEqual(sharedWeeklyLunchPrice({poster_evidence:'WEEKLY LUNCH SPECIALS 10/26-10/30',service_time:'11 AM-1:30 PM'}),{price:null,ambiguous:false});
  const value={poster_evidence:'Weekly Lunch Specials',service_time:'11 AM-1:30 PM',entries:[{day_of_week:1,content:MEALS[0]}]};
  assert.deepEqual(applySharedWeeklyLunchPrice(value).entries,value.entries);
});

for(const [label,poster_evidence,service_time] of [
  ['conflicting amounts','WEEKLY LUNCH SPECIALS $9.75 • $10.50','11 AM-1:30 PM'],
  ['add-on price','WEEKLY LUNCH SPECIALS $9.75 • ADD A CUP OF SOUP $2','11 AM-1:30 PM'],
  ['surcharge price','WEEKLY LUNCH SPECIALS $9.75 +$1 BONELESS','11 AM-1:30 PM'],
  ['discount wording','WEEKLY LUNCH SPECIALS $2 OFF','11 AM-1:30 PM'],
  ['nightly heading price','WEEKLY NIGHT SPECIALS $12','5-10 PM'],
  ['heading without lunch service','WEEKLY SPECIALS $9.75',''],
  ['malformed price','WEEKLY LUNCH SPECIALS $9.7.5','11 AM-1:30 PM'],
  ['zero price','WEEKLY LUNCH SPECIALS $0','11 AM-1:30 PM'],
]) test(`ambiguous heading price holds unpriced rows: ${label}`,()=>{
  assert.deepEqual(sharedWeeklyLunchPrice({poster_evidence,service_time}),{price:null,ambiguous:true});
  const result=applySharedWeeklyLunchPrice({poster_evidence,service_time,entries:[
    {day_of_week:1,content:MEALS[0]},{day_of_week:2,content:'Burger & a Drink $11'}]});
  // A row with its own printed price never depends on the heading.
  assert.deepEqual(result.entries,[{day_of_week:2,content:'Burger & a Drink $11'}]);
  assert.deepEqual(result.unresolved_days,[{day:1,reason:SHARED_WEEKLY_PRICE_AMBIGUOUS}]);
});

test('shared price never exceeds the 150-character limit; long rows are held',()=>{
  const exact='A'.repeat(150-' - $9.75'.length), long=exact+'B';
  const result=applySharedWeeklyLunchPrice({poster_evidence:HEADING,service_time:'',entries:[
    {day_of_week:1,content:exact},{day_of_week:2,content:long}]});
  assert.deepEqual(result.entries.map(e=>e.content),[`${exact} - $9.75`]);
  assert.equal(result.entries[0].content.length,150);
  assert.deepEqual(result.unresolved_days.map(d=>d.day),[2]);
});

// ── Publication ────────────────────────────────────────────────────────────────

test('October 26-30 shared $9.75 price publishes on all five Lunch specials only',async t=>{
  const f=octoberWeek(t);
  await f.run();
  MEALS.forEach((meal,i)=>{
    const slot=lunch(f,i+1);
    assert.equal(slot.content,priced(meal));
    assert.equal(slot.last_auto_value,priced(meal));
    assert.equal(slot.origin,'automation');
    assert.equal(slot.price,'');
  });
  assert.equal(lunch(f,1).content,'3 Topping Personal Pizza & a Drink - $9.75');
  for(const day of [0,1,2,3,4,5,6]) for(const service of ['all-day','nightly'])
    assert.ok(f.slots(day,service).every(s=>s.content===''),`${service} day ${day} must stay empty`);
  // Durable evidence stays the faithful reading; the price is derived on reconciliation.
  assert.deepEqual(JSON.parse(f.imports()[0].candidate_json).entries.map(e=>e.content),MEALS);
});

test('rerunning the October 26 import writes nothing and does not duplicate the price',async t=>{
  const f=octoberWeek(t);
  await f.run();
  const before=snapshot(f);
  await f.run();
  f.state.now+=31*60*1000;
  await f.run();
  assert.equal(f.state.aiCalls,1);
  assert.deepEqual(snapshot(f),before);
  assert.equal(lunch(f,1).content.match(/\$9\.75/g).length,1);
});

test('legacy evidence contract applies the same shared price',async t=>{
  const candidate=weekly();
  delete candidate.evidence_version;
  candidate.entries=candidate.entries.map(({day_of_week,content})=>({day_of_week,content}));
  const f=octoberWeek(t,candidate,'1');
  await f.run();
  MEALS.forEach((meal,i)=>assert.equal(lunch(f,i+1).content,priced(meal)));
});

test('individual printed prices are preserved beside the shared price',async t=>{
  const meals=[...MEALS];meals[3]='Steak Sandwich w/ French Fries & a Drink $12.50';
  const f=octoberWeek(t,weekly({meals}));
  await f.run();
  assert.equal(lunch(f,4).content,'Steak Sandwich w/ French Fries & a Drink $12.50');
  [0,1,2,4].forEach(i=>assert.equal(lunch(f,i+1).content,priced(MEALS[i])));
});

test('weekly poster without a heading price still publishes unpriced meals',async t=>{
  const f=octoberWeek(t,weekly({heading:'WEEKLY LUNCH SPECIALS 10/26-10/30'}));
  await f.run();
  MEALS.forEach((meal,i)=>assert.equal(lunch(f,i+1).content,meal));
});

test('conflicting heading prices publish no unpriced Lunch special and keep recurring defaults',async t=>{
  const f=octoberWeek(t,weekly({heading:'WEEKLY LUNCH SPECIALS • $9.75 • $10.50 • 10/26-10/30'}));
  setSlot(f,5,'Recurring fish fry','manual',0,null);
  await f.run();
  [1,2,3,4].forEach(day=>assert.equal(lunch(f,day).content,''));
  assert.equal(lunch(f,5).content,'Recurring fish fry');
  assert.equal(lunch(f,5).origin,'manual');
  assert.equal(f.sql("SELECT count(*) n FROM special_import_events WHERE event_type='review'")[0].n,0);
});

// ── Correcting the published price-less October 26 rows ──────────────────────

test('price-less automation rows from the same poster gain the shared price; staff values stay protected',async t=>{
  const f=octoberWeek(t);
  // State left by the earlier reconciliation that dropped the heading price.
  MEALS.forEach((meal,i)=>setSlot(f,i+1,meal,'automation',0));
  // Staff corrected Tuesday by hand (locked) and replaced Wednesday entirely.
  setSlot(f,2,'Chicken Bacon Ranch Wrap w/ French Fries & a Drink - $9.50','manual',1);
  setSlot(f,3,'Staff Wednesday lunch','automation',1,MEALS[2]);
  // Thursday holds a different automation value (e.g. a daily poster) and is not upgraded.
  setSlot(f,4,'Chicken Alfredo & a Drink $10','automation',0);
  await f.run();
  assert.equal(lunch(f,1).content,priced(MEALS[0]));
  assert.equal(lunch(f,1).last_auto_value,priced(MEALS[0]));
  assert.equal(lunch(f,5).content,priced(MEALS[4]));
  assert.equal(lunch(f,2).content,'Chicken Bacon Ranch Wrap w/ French Fries & a Drink - $9.50');
  assert.equal(lunch(f,2).manual_locked,1);
  assert.equal(lunch(f,3).content,'Staff Wednesday lunch');
  assert.equal(lunch(f,3).manual_locked,1);
  assert.equal(lunch(f,4).content,'Chicken Alfredo & a Drink $10');
  const before=snapshot(f);
  await f.run();
  assert.deepEqual(snapshot(f),before);
});

test('staff-edited price-less row (no longer the automation value) is not upgraded',async t=>{
  const f=octoberWeek(t);
  // Content matches the poster but last_auto_value differs: someone else owns it.
  setSlot(f,1,MEALS[0],'automation',0,'Older automatic lunch');
  await f.run();
  assert.equal(lunch(f,1).content,MEALS[0]);
  MEALS.slice(1).forEach((meal,i)=>assert.equal(lunch(f,i+2).content,priced(meal)));
});

test('weekly price is limited to Lunch: All Day and Nightly values are untouched',async t=>{
  const f=octoberWeek(t);
  const allDay=f.slots(1,'all-day')[0], nightly=f.slots(1,'nightly')[0];
  for(const slot of [allDay,nightly]) f.sql("UPDATE special_slots SET content=?,origin='automation',manual_locked=0,last_auto_value=? WHERE group_id=? AND position=1",MEALS[0],MEALS[0],slot.group_id);
  await f.run();
  assert.equal(f.slots(1,'all-day')[0].content,MEALS[0]);
  assert.equal(f.slots(1,'nightly')[0].content,MEALS[0]);
  assert.equal(lunch(f,1).content,priced(MEALS[0]));
});
