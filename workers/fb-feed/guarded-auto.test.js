import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,offer,poster} from './test-fixture.js';
import {chicagoDayWindow} from './worker.js';
import {offerKey,reconcilePosters} from './reconcile.js';
import {loadTs} from '../../tests/load-ts.mjs';
import {pruneImportHistory} from './guarded-auto.js';
const store=loadTs('src/lib/specials-store.ts');
const wing='Wing Night — Bone-In $.89 each / Boneless $.99 each';
const pair=[offer('Jalapeno Burger w/ Side Salad, Chili or Coleslaw $10.25'),offer('Chicken Salad Sandwich w/ Cup of Chili or Coleslaw $7.25')];
const lunch=offer('Chicken Bacon Ranch Quesadilla & a Drink $9.75','11-1:30');
const dayPoster=day=>poster(day,'Specials',[lunch,...pair]);
const nightPoster=day=>poster(day,day===3?'Specials':'Night Specials 5-10',[
  ...(day===3?[offer(wing,'Wing Night','5-10 PM')]:[offer('2 Burgers and 1 Order of Fries $14'),offer('Half Rack Ribs with Mac & Cheese & Coleslaw $18.75')]),
  ...pair.map(o=>offer(o.content.replace('w/','with').replace(' $',' — $'))),
]);
const contents=(f,day,service)=>f.slots(day,service).map(s=>s.content);

for (const caption of ['', 'Come join us!', 'Wednesday Specials']) test(`image with ${JSON.stringify(caption)} reaches vision without service caption`,async t=>{
  const f=harness(t,{caption,candidate:dayPoster(3)});await f.run();
  assert.equal(f.state.aiCalls,1);assert.deepEqual(contents(f,3,'lunch'),[lunch.content,'','','']);
  assert.deepEqual(contents(f,3,'all-day'),[...pair.map(o=>o.content),'','']);
});
for (const [day,date] of [[1,'2030-01-07'],[3,'2030-01-09'],[5,'2030-01-11']]) {
  for (const nightFirst of [false,true]) test(`day ${day}: ${nightFirst?'night before day':'day before night'} reconciles automatically with exactly one AI call per source`,async t=>{
    const f=harness(t,{now:date+'T23:00:00Z',caption:'Specials',candidate:nightFirst?nightPoster(day):dayPoster(day)});
    f.state.posts[0].created_time=date+'T14:00:00Z';f.state.posts[0].updated_time=date+'T14:00:00Z';
    await f.run();
    if (nightFirst) {assert.ok(contents(f,day,'all-day').every(s=>s===''));assert.equal(contents(f,day,'nightly')[0],day===3?wing:'');}
    const established=contents(f,day,'all-day');
    f.state.posts.push({...f.state.posts[0],id:'p2',created_time:date+'T20:00:00Z',updated_time:date+'T20:00:00Z'});
    f.state.candidate=nightFirst?dayPoster(day):nightPoster(day);await f.run();
    assert.equal(f.state.aiCalls,2);assert.equal(contents(f,day,'lunch')[0],lunch.content);
    assert.deepEqual(contents(f,day,'all-day'),[...pair.map(o=>o.content),'','']);
    assert.deepEqual(contents(f,day,'nightly'),day===3?[wing,'','','']:['2 Burgers and 1 Order of Fries $14','Half Rack Ribs with Mac & Cheese & Coleslaw $18.75','','']);
    if (!nightFirst) assert.deepEqual(contents(f,day,'all-day'),established);
    const rev=f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision;
    await f.run();assert.equal(f.state.aiCalls,2);assert.equal(f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision,rev);
  });
}
test('normalization preserves prices and dish identity while handling punctuation, case, spacing and w/',()=>{
  assert.equal(offerKey(' Chicken Salad Sandwich w/ Cup of Chili or Coleslaw $7.25 '),offerKey('CHICKEN Salad Sandwich with Cup of Chili or Coleslaw — $ 7.25'));
  assert.equal(offerKey('Ribs $14.00'),offerKey('Ribs $14'));
  assert.notEqual(offerKey('Ribs $14'),offerKey('Ribs $14.01'));
  assert.notEqual(offerKey('Chicken Salad $7.25'),offerKey('Chicken Sandwich $7.25'));
});
test('night poster with changed prices cannot replace All Day or publish unresolved night offers',async t=>{
  const f=harness(t,{now:'2030-01-07T23:00:00Z',candidate:dayPoster(1)});
  f.state.posts[0].created_time='2030-01-07T14:00:00Z';await f.run();
  const before=contents(f,1,'all-day');f.state.posts.push({...f.state.posts[0],id:'night'});
  f.state.candidate=nightPoster(1);f.state.candidate.offers[2].content=f.state.candidate.offers[2].content.replace('10.25','10.50');await f.run();
  assert.deepEqual(contents(f,1,'all-day'),before);assert.ok(contents(f,1,'nightly').every(s=>s===''));
});
for(const [name,content,origin,lock,baseline,expected] of [
  ['eligible blank','','legacy',0,null,wing],['manual value','Manual','manual',0,null,'Manual'],
  ['manual blank','','manual',0,null,''],['locked blank','','automation',1,null,''],
  ['locked value','Old','automation',1,'Old','Old'],['owned baseline','Old','automation',0,'Old',wing],
  ['missing baseline','Old','automation',0,null,'Old'],['manual edit','Corrected','automation',0,'Old','Corrected'],
  ['manual clear','','automation',0,'Old',''],['legacy value','Legacy','legacy',0,'Legacy','Legacy'],
]) test(`ownership: ${name}`,async t=>{
  const f=harness(t);f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=?,last_auto_value=? WHERE group_id=? AND position=1',content,origin,lock,baseline,f.slots()[0].group_id);
  await f.run();assert.equal(f.slots()[0].content,expected);
});
for(const value of ['Bartender correction','']) test(`admin save ${JSON.stringify(value)} wins`,async t=>{
  const f=harness(t);await f.run();const w=await store.readWeek(f.env,9000);w.collection.groups.find(g=>g.day_of_week===3&&g.service==='nightly').slots[0].content=value;
  await store.saveCollection(f.env,w.collection,{start:w.week_start_date,end:w.week_end_date});
  f.state.posts[0].updated_time='2030-01-09T14:30:00Z';await f.run();assert.equal(f.slots()[0].content,value);assert.equal(f.slots()[0].manual_locked,1);
});
test('concurrent unchanged claims extract once; changed source replaces only its previous evidence',async t=>{
  const f=harness(t,{candidate:dayPoster(3)});await Promise.all([f.run(),f.run()]);assert.equal(f.state.aiCalls,1);
  f.state.posts[0].updated_time='2030-01-09T14:30:00Z';f.state.candidate.offers[0].content='Pizza Bread & Drink $9.75';
  await f.run();assert.equal(f.state.aiCalls,2);assert.equal(f.slots(3,'lunch')[0].content,'Pizza Bread & Drink $9.75');
});
test('parser 3 source claim cannot block parser 4 extraction',async t=>{
  const f=harness(t);f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time,parser_version) VALUES('old','p1','2030-01-09T14:00:00Z',3)");
  await f.run();assert.equal(f.state.aiCalls,1);assert.equal(f.slots()[0].content,wing);
});
for(const mode of ['OFF','DRY_RUN','UNKNOWN']) test(`${mode} never writes specials or creates weeks`,async t=>{
  const f=harness(t,{mode,week:false});const before=f.sql('SELECT * FROM weekly_specials');await f.run();assert.deepEqual(f.sql('SELECT * FROM weekly_specials'),before);assert.equal(f.state.aiCalls,mode==='DRY_RUN'?1:0);
});
for(const failure of ['wrong day','missing weekday','conflicting weekdays','no image','malformed JSON','invalid image','two wings','non-wing Wednesday','conflicting service']) test(`${failure} fails closed`,async t=>{
  const f=harness(t);
  if(failure==='wrong day') f.state.candidate.day_of_week=4;
  if(failure==='missing weekday') f.state.candidate.day_evidence='';
  if(failure==='conflicting weekdays') f.state.candidate.day_evidence='Wednesday Thursday';
  if(failure==='no image') delete f.state.posts[0].full_picture;
  if(failure==='malformed JSON') f.env.AI.run=async()=>({response:'bad'});
  if(failure==='invalid image') t.mock.method(globalThis,'fetch',async input=>String(input).includes('graph.facebook.com')?Response.json({data:f.state.posts}):new Response('bad',{headers:{'content-type':'image/jpeg'}}));
  if(failure==='two wings') f.state.candidate.offers.push(offer('Wing Night $5','Wing Night'));
  if(failure==='non-wing Wednesday') f.state.candidate=poster(3,'Night Specials',[offer('Dinner $14','Night')]);
  if(failure==='conflicting service') f.state.candidate.offers[0].service_time='Lunch Night';
  await f.run();assert.equal(f.slots()[0].content,'');
});
test('Tuesday Mexican Night remains isolated, Thursday supports one night item, weekend keeps configured services',()=>{
  assert.deepEqual(reconcilePosters([poster(2,'Mexican Night',[offer('Tacos $5','Night')])],2),[]);
  assert.equal(reconcilePosters([poster(4,'Night Specials',[offer('Steak $15','5-10 PM')])],4)[0].items[0].content,'Steak $15');
  assert.deepEqual(reconcilePosters([poster(6,'Night Specials',[offer('Dinner $5','Night')])],6),[]);
  assert.equal(reconcilePosters([poster(6,'Lunch',[offer('Saturday Special $5','Lunch')])],6)[0].service,'lunch');
});
for(const condition of ['overlap','missing group','disabled group','duplicate group']) test(`${condition} fails closed`,async t=>{
  const f=harness(t);
  if(condition==='overlap') f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(9001,'2030-01-08','2030-01-12')");
  if(condition==='missing group') f.sql("DELETE FROM special_groups WHERE collection_id='auto-week' AND day_of_week=3 AND service='nightly'");
  if(condition==='disabled group') f.sql("UPDATE special_groups SET enabled=0 WHERE collection_id='auto-week'");
  if(condition==='duplicate group') f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label) VALUES('extra','auto-week',3,'nightly','Extra')");
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');await f.run();assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
});
test('manual race invalidates the whole plan; transaction failure rolls back writes and audit',async t=>{
  const f=harness(t,{candidate:dayPoster(3)});const batch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{if(statements[0].sql.startsWith('UPDATE special_collections')) f.sql("UPDATE special_slots SET content='Staff',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",f.slots(3,'all-day')[0].group_id);return batch(statements)};
  await f.run();assert.equal(f.slots(3,'lunch')[0].content,'');assert.equal(f.slots(3,'all-day')[1].content,'Staff');
  f.env.DB.batch=statements=>batch(statements[0].sql.startsWith('UPDATE special_collections')?[...statements,{sql:'INSERT INTO missing_table VALUES(1)',args:[]}]:statements);
  await assert.rejects(()=>f.run());assert.equal(f.slots(3,'lunch')[0].content,'');assert.equal(f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision,0);
});
test('yesterday, future and malformed creation dates never reach AI; Graph stays today-only',async t=>{
  const f=harness(t);const p=f.state.posts[0];f.state.posts.push({...p,id:'y',created_time:'2030-01-09T05:59:59Z'},{...p,id:'future',created_time:'2030-01-10T06:00:00Z'},{...p,id:'bad',created_time:'bad'});
  await f.run();assert.equal(f.state.aiCalls,1);assert.equal(f.state.calls[0].searchParams.get('since'),String(Date.parse('2030-01-09T06:00:00Z')/1000));assert.notEqual(f.state.calls[0].searchParams.get('limit'),'20');
});
for(const [hour,expected] of [['12:59:59',0],['13:00:00',1],['01:59:59',1],['02:00:00',0]]) test(`Chicago hour boundary ${hour}`,async t=>{
  const f=harness(t,{now:`2030-01-${hour.startsWith('0')?'10':'09'}T${hour}Z`});f.state.posts[0].created_time='2030-01-09T12:00:00Z';await f.run();assert.equal(f.state.aiCalls,expected);
});
test('slow AI crossing 8 PM saves evidence without publishing',async t=>{
  const f=harness(t,{now:'2030-01-10T01:59:59Z'});f.env.AI.run=async()=>{f.state.now=Date.parse('2030-01-10T02:00:00Z');return {response:JSON.stringify(f.state.candidate)}};
  await f.run();assert.equal(f.slots()[0].content,'');
});
test('Chicago date windows cover DST and year rollover',()=>{
  for(const [date,start,end] of [['2026-03-08T17:00:00Z','2026-03-08T06:00:00Z','2026-03-09T05:00:00Z'],['2026-11-01T18:00:00Z','2026-11-01T05:00:00Z','2026-11-02T06:00:00Z'],['2027-01-01T02:00:00Z','2026-12-31T06:00:00Z','2027-01-01T06:00:00Z']]) {
    const w=chicagoDayWindow(new Date(date));assert.equal(w.since,Date.parse(start)/1000);assert.equal(w.until,Date.parse(end)/1000);
  }
});
test('history cleanup removes only records beyond 90 days and cascades events',async t=>{
  const f=harness(t);await f.run();const before=f.slots();f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time,fetched_at) VALUES('old','old','2020-01-01','2020-01-01')");f.sql("INSERT INTO special_import_events(import_id,event_type) VALUES('old','stage')");await pruneImportHistory(f.env,new Date(f.state.now));assert.equal(f.sql("SELECT * FROM special_imports WHERE id='old'").length,0);assert.deepEqual(f.slots(),before);
});
test('saved automation All Day pair resolves a later night poster without rewriting the pair',async t=>{
  const f=harness(t,{now:'2030-01-07T23:00:00Z',candidate:dayPoster(1)});
  f.state.posts[0].created_time='2030-01-07T14:00:00Z';await f.run();
  const before=f.slots(1,'all-day');
  f.state.posts=[{...f.state.posts[0],id:'night'}];f.state.candidate=nightPoster(1);await f.run();
  assert.deepEqual(f.slots(1,'all-day'),before);assert.equal(f.slots(1,'nightly')[0].content,'2 Burgers and 1 Order of Fries $14');
});
test('different Page claims cannot reuse the same post ID extraction',async t=>{
  const f=harness(t);await f.run();f.env.FB_PAGE_ID='other-page';await f.run();
  assert.equal(f.state.aiCalls,2);assert.equal(f.imports().length,2);
});
test('concurrent scans reserve the daily AI limit atomically',async t=>{
  const f=harness(t);f.env.SPECIALS_AI_DAILY_LIMIT='1';
  f.state.posts.push({...f.state.posts[0],id:'second'});
  await Promise.all([f.run(),f.run()]);assert.equal(f.state.aiCalls,1);
});
test('today-only pagination processes more than twenty posts without following arbitrary next URLs',async t=>{
  const f=harness(t,{mode:'DRY_RUN'});const urls=[];
  t.mock.method(globalThis,'fetch',async input=>{
    const url=new URL(input);urls.push(url);const offset=url.searchParams.has('after')?20:0;
    return Response.json({data:Array.from({length:offset?1:20},(_,i)=>({...f.state.posts[0],id:String(offset+i),full_picture:null})),
      ...(offset?{}:{paging:{next:'https://untrusted.example/',cursors:{after:'page2'}}})});
  });
  await f.run();assert.equal(f.imports().length,21);assert.equal(urls.length,2);
  assert.equal(urls[0].searchParams.get('since'),urls[1].searchParams.get('since'));assert.equal(urls[1].hostname,'graph.facebook.com');
});
