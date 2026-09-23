import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../../tests/specials-fixture.mjs';
import {loadTs} from '../../tests/load-ts.mjs';
import {runImportPipeline,chicagoDayWindow} from './worker.js';
import {pruneImportHistory} from './guarded-auto.js';
const store=loadTs('src/lib/specials-store.ts');
const NOW='2030-01-09T15:00:00Z'; // Wednesday, 9 AM CST

function harness(t, options={}) {
  const f=fixture(t);
  const state={now:Date.parse(options.now ?? NOW),calls:[],aiCalls:0,images:new Map(),
    posts:[{id:'p1',message:options.caption ?? 'Wednesday Night Specials',created_time:'2030-01-09T14:00:00Z',updated_time:'2030-01-09T14:00:00Z',full_picture:'https://cdn.example/photo.jpg'}],
    candidate:options.candidate ?? [{label:'Nightly',day_of_week:3,service:'nightly',items:[{content:'Dinner $14'}]}]};
  t.mock.method(Date,'now',()=>state.now);
  t.mock.method(console,'error',()=>{});
  t.mock.method(globalThis,'fetch',async input=>{
    const url=new URL(input);state.calls.push(url);
    if(url.hostname==='graph.facebook.com') return Response.json({data:state.posts});
    return new Response(new Uint8Array([255,216,255]),{headers:{'content-type':'image/jpeg'}});
  });
  const env={...f.env,SPECIALS_IMPORT_MODE:options.mode ?? 'GUARDED_AUTO',FB_PAGE_ID:'test',FB_SYSTEM_TOKEN:'fake',
    AI:{run:async()=>{state.aiCalls++;return {response:JSON.stringify(state.candidate)}}},
    PHOTOS:{put:async(key,data,meta)=>state.images.set(key,{data,meta,uploaded:new Date(state.now)}),
      get:async key=>{const r=state.images.get(key);return r ? {arrayBuffer:async()=>r.data,httpMetadata:r.meta.httpMetadata}:null},
      list:async()=>({objects:[...state.images].map(([key,r])=>({key,uploaded:r.uploaded})),truncated:false}),
      delete:async key=>state.images.delete(key)}};
  if(options.week!==false) {
    f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(9000,'2030-01-07','2030-01-13')");
    f.sql("INSERT INTO special_collections(id,kind,weekly_special_id) VALUES('auto-week','week',9000)");
    f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) SELECT 'auto-'||id,'auto-week',day_of_week,service,label,service_time,sort,enabled FROM special_groups WHERE collection_id='defaults'");
    f.sql("INSERT INTO special_slots(group_id,position,content,origin,manual_locked) SELECT g.id,p.position,'','automation',0 FROM special_groups g JOIN special_slots p ON p.group_id=substr(g.id,6) WHERE g.collection_id='auto-week'");
  }
  const slots=(day=3,service='nightly')=>f.sql('SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=? AND g.day_of_week=? AND g.service=? ORDER BY position','auto-week',day,service);
  return {...f,env,state,slots,run:()=>runImportPipeline(env),imports:()=>f.sql('SELECT * FROM special_imports ORDER BY rowid')};
}

test('Chicago midnight resolves spring/fall DST and year boundaries',()=>{
  for(const [now,start,end] of [
    ['2026-03-08T17:00:00Z','2026-03-08T06:00:00Z','2026-03-09T05:00:00Z'],
    ['2026-11-01T18:00:00Z','2026-11-01T05:00:00Z','2026-11-02T06:00:00Z'],
    ['2027-01-01T02:00:00Z','2026-12-31T06:00:00Z','2027-01-01T06:00:00Z'],
  ]) {
    const w=chicagoDayWindow(new Date(now));
    assert.equal(w.since,Date.parse(start)/1000);assert.equal(w.until,Date.parse(end)/1000);
  }
});

test('Graph queries bound today at Chicago midnight; yesterday, future and malformed creation times never reach AI',async t=>{
  const f=harness(t);const p=f.state.posts[0];
  f.state.posts.push({...p,id:'yesterday',created_time:'2030-01-09T05:59:59Z',updated_time:NOW},
    {...p,id:'tomorrow',created_time:'2030-01-10T06:00:00Z'},{...p,id:'bad',created_time:'invalid'});
  await f.run();
  const url=f.state.calls[0];assert.equal(url.searchParams.get('since'),String(Date.parse('2030-01-09T06:00:00Z')/1000));
  assert.equal(url.searchParams.get('until'),String(Date.parse('2030-01-10T06:00:00Z')/1000));
  assert.notEqual(url.searchParams.get('limit'),'20');assert.equal(f.state.aiCalls,1);assert.equal(f.imports().length,1);
});

test('today-only pagination retains bounds and processes beyond twenty posts',async t=>{
  const f=harness(t,{mode:'DRY_RUN'});const urls=[];
  t.mock.method(globalThis,'fetch',async input=>{
    const url=new URL(input);urls.push(url);
    const offset=url.searchParams.has('after')?20:0;
    return Response.json({data:Array.from({length:offset?1:20},(_,i)=>({...f.state.posts[0],id:String(offset+i),full_picture:null})),
      ...(offset?{}:{paging:{next:'https://untrusted.example/never-follow',cursors:{after:'page2'}}})});
  });
  await f.run();assert.equal(f.imports().length,21);assert.equal(urls.length,2);
  assert.equal(urls[0].searchParams.get('since'),urls[1].searchParams.get('since'));
  assert.equal(urls[1].hostname,'graph.facebook.com');
});

for(const [hour,expected] of [['12:59:59',0],['13:00:00',1],['01:59:59',1],['02:00:00',0]]) {
  test(`Chicago processing boundary ${hour} UTC`,async t=>{
    const late=hour.startsWith('0');const f=harness(t,{now:`2030-01-${late?'10':'09'}T${hour}Z`});
    f.state.posts[0].created_time='2030-01-09T12:00:00Z';await f.run();assert.equal(f.state.aiCalls,expected);
  });
}

for(const [caption,service,count] of [['Wednesday Lunch Specials','lunch',1],['Wednesday Night Specials','nightly',1],['Wednesday Nightly Specials','nightly',1],['Wednesday All Day Specials','all-day',2]]) {
  test(`${caption} auto-writes exact inline content and an atomic audit`,async t=>{
    const items=Array.from({length:count},(_,i)=>({content:`Offer ${i+1} $7.25`}));
    const f=harness(t,{caption,candidate:[{label:'Test',day_of_week:3,service,items}]});
    await f.run();
    const slots=f.slots(3,service);
    items.forEach((item,i)=>{assert.equal(slots[i].content,item.content);assert.equal(slots[i].last_auto_value,item.content);assert.equal(slots[i].origin,'automation');assert.equal(slots[i].manual_locked,0);assert.equal(slots[i].price,'')});
    assert.equal(f.imports()[0].review_status,'accepted');assert.match(f.imports()[0].review_reason,/GUARDED_AUTO/);
    assert.equal(f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision,1);
    assert.ok(f.sql("SELECT * FROM special_import_events WHERE event_type='review'").length);
  });
}

for(const caption of ['Wednesday Specials','Specials Today','Weekly Lunch Specials','Weekly Night Specials','Thursday Night Specials','Tuesday Night Specials','Mexican Night','Wednesday Lunch and Night Specials','Wednesday and Friday Night Specials']) {
  test(`${caption} never auto-writes`,async t=>{
    const f=harness(t,{caption});const before=f.slots();await f.run();assert.deepEqual(f.slots(),before);
    assert.ok(f.imports().every(r=>r.review_status==='pending'));
  });
}

for(const condition of ['no week','overlap','missing group','disabled group','duplicate group']) {
  test(`${condition} fails closed`,async t=>{
    const f=harness(t,{week:condition!=='no week'});
    if(condition==='overlap') f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(9001,'2030-01-08','2030-01-12')");
    if(condition==='missing group') f.sql("DELETE FROM special_groups WHERE collection_id='auto-week' AND day_of_week=3 AND service='nightly'");
    if(condition==='disabled group') f.sql("UPDATE special_groups SET enabled=0 WHERE collection_id='auto-week'");
    if(condition==='duplicate group') f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label) VALUES('extra','auto-week',3,'nightly','Extra')");
    const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');await f.run();
    assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);assert.equal(f.imports()[0].review_status,'pending');
  });
}

for(const [name,content,origin,lock,baseline,expected] of [
  ['unlocked legacy blank','','legacy',0,null,'Dinner $14'],
  ['manual nonblank','Manual','manual',0,null,'Manual'],
  ['manual blank','','manual',0,null,''],
  ['locked blank','','automation',1,null,''],
  ['locked nonblank','Old','automation',1,'Old','Old'],
  ['automation matches baseline','Old','automation',0,'Old','Dinner $14'],
  ['automation has no baseline','Old','automation',0,null,'Old'],
  ['bartender changed without revision','Corrected','automation',0,'Old','Corrected'],
  ['bartender blanked without revision','','automation',0,'Old',''],
  ['legacy nonblank','Legacy','legacy',0,'Legacy','Legacy'],
]) {
  test(`ownership guard: ${name}`,async t=>{
    const f=harness(t);f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=?,last_auto_value=? WHERE group_id=? AND position=1',content,origin,lock,baseline,f.slots()[0].group_id);
    await f.run();assert.equal(f.slots()[0].content,expected);
  });
}

test('unchanged and concurrent versions run AI once; edited source updates only baseline-owned values',async t=>{
  const f=harness(t);await Promise.all([f.run(),f.run()]);assert.equal(f.state.aiCalls,1);assert.equal(f.imports().length,1);
  await f.run();assert.equal(f.state.aiCalls,1);
  f.state.posts[0].updated_time='2030-01-09T14:30:00Z';f.state.candidate[0].items[0].content='New Dinner $15';
  await f.run();assert.equal(f.state.aiCalls,2);assert.equal(f.slots()[0].content,'New Dinner $15');
  f.state.posts[0].message+=' Updated menu';await f.run();assert.equal(f.state.aiCalls,3);assert.equal(f.imports().length,3);
});

for(const manualValue of ['Bartender correction $13','']) {
  test(`admin change ${JSON.stringify(manualValue)} permanently wins over future automation`,async t=>{
    const f=harness(t);await f.run();
    const week=await store.readWeek(f.env,9000);week.collection.groups.find(g=>g.day_of_week===3&&g.service==='nightly').slots[0].content=manualValue;
    await store.saveCollection(f.env,week.collection,{start:week.week_start_date,end:week.week_end_date});
    f.state.posts[0].updated_time='2030-01-09T14:30:00Z';f.state.candidate[0].items[0].content='Later automatic offer $17';await f.run();
    assert.equal(f.slots()[0].content,manualValue);assert.equal(f.slots()[0].origin,'manual');assert.equal(f.slots()[0].manual_locked,1);
  });
}

for(const mode of ['OFF','DRY_RUN','UNKNOWN']) {
  test(`${mode} never writes specials`,async t=>{
    const f=harness(t,{mode});const before=f.slots();await f.run();assert.deepEqual(f.slots(),before);
    assert.equal(f.state.aiCalls,mode==='DRY_RUN'?1:0);
  });
}

for(const failure of ['AI throws','malformed JSON','null group','too many items','blank item','wrong day','wrong service','no image','invalid image']) {
  test(`${failure} never writes specials`,async t=>{
    const f=harness(t);
    if(failure==='AI throws') f.env.AI.run=async()=>{throw Error('AI failed')};
    if(failure==='malformed JSON') f.env.AI.run=async()=>({response:'bad JSON'});
    if(failure==='null group') f.state.candidate=[null];
    if(failure==='too many items') f.state.candidate[0].items.push({content:'Extra'});
    if(failure==='blank item') f.state.candidate[0].items[0].content=' ';
    if(failure==='wrong day') f.state.candidate[0].day_of_week=4;
    if(failure==='wrong service') f.state.candidate[0].service='lunch';
    if(failure==='no image') delete f.state.posts[0].full_picture;
    if(failure==='invalid image') t.mock.method(globalThis,'fetch',async input=>String(input).includes('graph.facebook.com')?Response.json({data:f.state.posts}):new Response('<html>not an image</html>',{headers:{'content-type':'image/jpeg'}}));
    const before=f.slots();await f.run();assert.deepEqual(f.slots(),before);assert.equal(f.imports()[0].review_status,'pending');
  });
}

test('manual race blocks the entire candidate; failing audit rolls back slots and revision',async t=>{
  const f=harness(t,{caption:'Wednesday All Day Specials',candidate:[{label:'All Day',day_of_week:3,service:'all-day',items:[{content:'One $1'},{content:'Two $2'}]}]});
  const batch=f.env.DB.batch;const groupId=f.slots(3,'all-day')[0].group_id;
  f.env.DB.batch=async statements=>{
    if(statements[0].sql.startsWith('UPDATE special_collections')) f.sql("UPDATE special_slots SET content='Racing manual edit',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",groupId);
    return batch(statements);
  };
  await f.run();assert.equal(f.slots(3,'all-day')[0].content,'');assert.equal(f.slots(3,'all-day')[1].content,'Racing manual edit');
  assert.equal(f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision,0);
  f.sql("UPDATE special_slots SET content='',origin='automation',manual_locked=0 WHERE group_id=?",groupId);
  f.state.posts[0].updated_time='2030-01-09T14:30:00Z';
  f.env.DB.batch=statements=>batch(statements[0].sql.startsWith('UPDATE special_collections')?[...statements,{sql:'INSERT INTO missing_table VALUES(1)',args:[]}]:statements);
  await f.run();assert.ok(f.slots(3,'all-day').every(s=>s.content===''));
  assert.equal(f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision,0);
  assert.equal(f.sql("SELECT count(*) n FROM special_import_events WHERE event_type='review'")[0].n,0);
});

test('90-day cleanup removes old events and parents only, preserving cutoff, recent and all specials',async t=>{
  const f=harness(t);await f.run();const record=f.imports()[0];
  const cutoff=new Date(f.state.now-90*86400000).toISOString();
  for(const [id,date] of [['old',new Date(Date.parse(cutoff)-1000).toISOString()],['boundary',cutoff],['recent',NOW]]) {
    f.sql('INSERT INTO special_imports(id,fb_post_id,fb_created_time,fetched_at) VALUES(?,?,?,?)',id,id,NOW,date);
    f.sql("INSERT INTO special_import_events(import_id,event_type) VALUES(?,'stage')",id);
  }
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  await pruneImportHistory(f.env,new Date(f.state.now));
  assert.equal(f.sql("SELECT * FROM special_imports WHERE id='old'").length,0);
  assert.equal(f.sql("SELECT * FROM special_import_events WHERE import_id='old'").length,0);
  for(const id of ['boundary','recent',record.id]) assert.equal(f.sql('SELECT * FROM special_imports WHERE id=?',id).length,1);
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
});

test('cleanup failures are isolated; R2 still removes only images older than 30 days',async t=>{
  const f=harness(t);const batch=f.env.DB.batch;
  f.env.DB.batch=statements=>statements[0].sql.startsWith('DELETE')?Promise.reject(Error('cleanup failed')):batch(statements);
  f.state.images.set('special-imports/old.jpg',{uploaded:new Date(f.state.now-31*86400000)});
  f.state.images.set('special-imports/new.jpg',{uploaded:new Date(f.state.now-29*86400000)});
  await f.run();assert.equal(f.slots()[0].content,'Dinner $14');
  assert.equal(f.state.images.has('special-imports/old.jpg'),false);assert.equal(f.state.images.has('special-imports/new.jpg'),true);
});

for(const [day,date] of [[1,'2030-01-07'],[5,'2030-01-11']]) {
  test(`day ${day}: repeated All Day offers do not become extra Nightly specials`,async t=>{
    const f=harness(t,{now:date+'T15:00:00Z',caption:`${day===1?'Monday':'Friday'} Night Specials`,candidate:[
      {label:'Nightly',day_of_week:day,service:'nightly',items:[{content:'Dinner $14'},{content:'Ribs $18.75'},{content:'Sandwich $7.25'},{content:'Burger $10.25'}]},
      {label:'All Day',day_of_week:day,service:'all-day',items:[{content:'Sandwich $7.25'},{content:'Burger $10.25'}]},
    ]});
    f.state.posts[0].created_time=date+'T14:00:00Z';f.state.posts[0].updated_time=date+'T14:00:00Z';
    await f.run();assert.deepEqual(f.slots(day,'nightly').map(s=>s.content),['Dinner $14','Ribs $18.75','','']);
    assert.ok(f.slots(day,'all-day').every(s=>s.content===''),'caption authorizes Nightly only');
    assert.equal(f.imports()[0].review_status,'pending','other extracted groups remain reviewable');
  });
}

test('slow AI crossing 8 PM stages without publishing',async t=>{
  const f=harness(t,{now:'2030-01-10T01:59:59Z'});
  f.env.AI.run=async()=>{f.state.now=Date.parse('2030-01-10T02:00:00Z');return {response:JSON.stringify(f.state.candidate)}};
  await f.run();assert.equal(f.slots()[0].content,'');assert.equal(f.imports()[0].review_status,'pending');
});

test('unchanged value from an edited source does not bump collection revision again',async t=>{
  const f=harness(t);await f.run();const revision=f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision;
  f.state.posts[0].updated_time='2030-01-09T14:30:00Z';await f.run();
  assert.equal(f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision,revision);
  assert.equal(f.state.aiCalls,2);
});
