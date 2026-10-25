import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {reconcileToday} from './guarded-auto.js';

// Public poster transcriptions (stored extractions). Production captions for
// these posts are empty (read-only D1 check, October 25), so every post below
// has an empty caption unless a test says it is HYPOTHETICAL.
const read=name=>JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`,import.meta.url),'utf8'));
const morningRaw=read('oct23-delivery.json');
const {friday_night:nightRaw,brewers_event:brewersRaw}=read('oct23-friday-night.json');
const {sunday_specials:sundayRaw,packers_event:packersRaw}=read('oct25-sunday-soup.json');
const BREWERS_OFFER='Pulled Pork Sandwich With Chips and Side of Coleslaw $7.25';

function friday(t,mode) {
  const f=harness(t,{now:'2026-10-23T14:26:05.441Z',candidate:structuredClone(morningRaw)});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'morning',message:'',created_time:'2026-10-23T09:24:45-05:00',updated_time:'2026-10-23T09:24:45-05:00'});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  if (mode) f.env.SPECIAL_EVENTS_MODE=mode;
  const post=(id,created,candidate,at,extra={})=>{
    f.state.now=Date.parse(at);f.state.candidate=structuredClone(candidate);
    const existing=f.state.posts.find(p=>p.id===id);
    if (existing) Object.assign(existing,{updated_time:created,...extra});
    else f.state.posts.push({...f.state.posts[0],id,created_time:created,updated_time:created,...extra});
  };
  return {...f,post,
    addNight:()=>post('night','2026-10-23T15:00:53-05:00',nightRaw,'2026-10-23T20:02:14.635Z'),
    addBrewers:(candidate=brewersRaw,id='brewers',at='2026-10-23T20:15:08.911Z',created='2026-10-23T15:13:45-05:00')=>post(id,created,candidate,at),
    events:()=>f.sql('SELECT * FROM special_events ORDER BY created_at,id'),
    offers:id=>f.sql('SELECT content FROM special_event_offers WHERE event_id=? ORDER BY position',id).map(o=>o.content),
    log:()=>f.sql('SELECT action,detail,source_post_id FROM special_event_log ORDER BY id'),
    slots:()=>f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),
    conflicts:()=>f.sql("SELECT detail FROM special_import_events WHERE event_type='review' AND detail LIKE 'GUARDED_AUTO_CONFLICT%'").map(e=>e.detail)};
}

async function brewersDay(t,mode) {
  const f=friday(t,mode);
  await f.run();f.addNight();await f.run();f.addBrewers();await f.run();
  return f;
}

test('OFF (default): the Brewers post creates no event and the daily specials behave exactly as before',async t=>{
  const off=await brewersDay(t);
  assert.equal(off.env.SPECIAL_EVENTS_MODE,undefined);
  assert.deepEqual(off.events(),[]);
  assert.deepEqual(off.log(),[]);
  const auto=await brewersDay(t,'AUTO');
  // Same slot contents; events never touch weekly specials.
  const contents=f=>f.slots().map(s=>[s.group_id,s.position,s.content,s.origin,s.manual_locked,s.last_auto_value]);
  assert.deepEqual(contents(auto),contents(off));
  assert.ok(!auto.slots().some(s=>/pulled pork/i.test(s.content??'')));
});

test('OFF: the Worker never queries or writes any special-event table, even with event posters in the scan',async t=>{
  const recorded=async mode=>{
    const f=friday(t,mode);
    const sql=[];const prepare=f.env.DB.prepare.bind(f.env.DB),batch=f.env.DB.batch.bind(f.env.DB);
    f.env.DB={...f.env.DB,prepare(query){sql.push(query);return prepare(query);},batch(statements){return batch(statements);}};
    await f.run();f.addNight();await f.run();f.addBrewers();await f.run();
    f.state.now+=30*60000;await f.run();
    return sql;
  };
  const off=await recorded(undefined);
  assert.ok(off.length>20);
  assert.deepEqual(off.filter(q=>/special_event/i.test(q)),[]);
  // The same instrumentation does see event queries once the mode is on.
  assert.ok((await recorded('REVIEW')).some(q=>/special_event/i.test(q)));
});

test('AUTO: the October 23 Brewers poster publishes one event for tonight and no longer blocks Friday specials',async t=>{
  const off=await brewersDay(t);
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  assert.equal(f.events().length,1);
  assert.deepEqual([e.status,e.origin,e.manual_locked,e.event_date,e.title,e.identity,e.date_basis,e.time_text,e.source_post_id],
    ['published','automation',0,'2026-10-23','Brewers Game Special','brewers','relative','Tonight','brewers']);
  assert.deepEqual(f.offers(e.id),[BREWERS_OFFER]);
  assert.equal(e.last_auto_json,JSON.stringify({title:e.title,event_date:e.event_date,time_text:e.time_text,start_time:null,end_time:null,details:'',offers:[BREWERS_OFFER]}));
  assert.match(e.evidence_json,/TONIGHT'S BREWERS GAME SPECIAL/);
  // OFF reports the Brewers post as a daily conflict; AUTO does not.
  assert.ok(off.conflicts().length>0);
  assert.deepEqual(f.conflicts(),[]);
});

test('AUTO: the Brewers scan no longer logs "Specials import requires attention"; OFF still does',async t=>{
  const counts=[];
  for (const mode of [undefined,'AUTO']) {
    const f=friday(t,mode);
    await f.run();f.addNight();await f.run();f.addBrewers();
    const warn=t.mock.method(console,'warn',()=>{});
    await f.run();
    counts.push(warn.mock.calls.filter(c=>c.arguments[0]==='Specials import requires attention').length);
    warn.mock.restore();
  }
  assert.deepEqual(counts,[1,0]);
});

test('AUTO: rescans are idempotent: no new row, revision, log entry, slot change or AI call',async t=>{
  const f=await brewersDay(t,'AUTO');
  const before={events:f.events(),log:f.log(),slots:f.slots(),ai:f.state.aiCalls,audit:f.sql('SELECT count(*) n FROM special_import_events')[0].n};
  f.state.now+=30*60000;await f.run();
  f.state.now+=30*60000;await f.run();
  assert.deepEqual(f.events(),before.events);assert.deepEqual(f.log(),before.log);assert.deepEqual(f.slots(),before.slots);
  assert.equal(f.state.aiCalls,before.ai);
  assert.equal(f.sql('SELECT count(*) n FROM special_import_events')[0].n,before.audit);
});

test('REVIEW: the Brewers event is held for staff approval, never published',async t=>{
  const f=await brewersDay(t,'REVIEW');
  const [e]=f.events();
  assert.equal(e.status,'review');assert.match(e.review_reason,/Review mode/);
});

test('a missing special_events table behaves exactly like OFF',async t=>{
  const f=friday(t,'AUTO');
  f.sql('DROP TABLE special_event_offers');f.sql('DROP TABLE special_event_log');f.sql('DROP TABLE special_events');
  await f.run();f.addNight();await f.run();f.addBrewers();await f.run();
  const off=await brewersDay(t);
  const contents=x=>x.slots().map(s=>[s.group_id,s.position,s.content]);
  assert.deepEqual(contents(f),contents(off));
});

test('alert inspection: the Brewers source is excluded, not reported as a blocked daily offer',async t=>{
  const f=await brewersDay(t,'AUTO');
  const ids=f.imports().map(i=>i.id);
  const r=await reconcileToday(f.env,{sourceIds:ids,today:'2026-10-23',weekday:5,inspectOnly:true});
  const brewersImport=f.imports().find(i=>i.fb_post_id==='brewers').id;
  assert.ok(r.excludedSourceIds.includes(brewersImport));
  assert.ok(!r.blocked.some(b=>/pulled pork/i.test(b.content??'')));
  assert.ok(!r.alertSnapshot?.sources.some(s=>s.id===brewersImport));
});

function sundaySetup(t,mode) {
  const f=harness(t,{now:'2026-10-25T14:29:01.923Z',candidate:structuredClone(sundayRaw)});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'sunday',message:'',created_time:'2026-10-25T09:27:36-05:00',updated_time:'2026-10-25T09:27:36-05:00'});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  if (mode) f.env.SPECIAL_EVENTS_MODE=mode;
  return {...f,addPackers:()=>{
    f.state.now=Date.parse('2026-10-25T15:35:08.068Z');f.state.candidate=structuredClone(packersRaw);
    f.state.posts.push({...f.state.posts[0],id:'packers',message:'',created_time:'2026-10-25T10:33:50-05:00',updated_time:'2026-10-25T10:33:50-05:00'});
  }};
}

test('October 25 Packers post with its empty caption: no event is created in any mode and its regular warning is unchanged',async t=>{
  const outcomes=[];
  for (const mode of [undefined,'REVIEW','AUTO']) {
    const f=sundaySetup(t,mode);await f.run();f.addPackers();await f.run();
    assert.deepEqual(f.sql('SELECT * FROM special_events'),[],String(mode));
    const ids=f.imports().map(i=>i.id);
    const r=await reconcileToday(f.env,{sourceIds:ids,today:'2026-10-25',weekday:0,inspectOnly:true});
    outcomes.push({blocked:r.blocked,slots:f.sql('SELECT group_id,position,content FROM special_slots ORDER BY group_id,position'),
      conflicts:f.sql("SELECT count(*) n FROM special_import_events WHERE detail LIKE 'GUARDED_AUTO_CONFLICT%'")[0].n});
  }
  // The unresolved "Sunday Special" offer remains a legitimate review condition.
  assert.ok(outcomes[0].blocked.length>=1);
  assert.deepEqual(outcomes[1],outcomes[0]);assert.deepEqual(outcomes[2],outcomes[0]);
});

test('October 25 Packers post identified by staff: with events on, its regular warning stops; with OFF nothing changes',async t=>{
  const results={};
  for (const mode of [undefined,'REVIEW']) {
    const f=sundaySetup(t,mode);await f.run();f.addPackers();await f.run();
    // What the admin "Create event from this post" action stores.
    f.sql(`INSERT INTO special_events(id,title,event_date,status,origin,manual_locked,date_basis,source_post_id)
      VALUES('evt:packers','Packers Game Day Special','2026-10-25','published','manual',1,'manual','packers')`);
    f.sql("INSERT INTO special_event_offers VALUES('evt:packers',1,'Pulled Pork Sandwich w/ Chips $4')");
    const ids=f.imports().map(i=>i.id);
    const r=await reconcileToday(f.env,{sourceIds:ids,today:'2026-10-25',weekday:0,inspectOnly:true});
    const packersImport=f.imports().find(i=>i.fb_post_id==='packers').id;
    results[String(mode)]={blocked:r.blocked.length,excluded:r.excludedSourceIds.includes(packersImport)};
    const before=f.sql('SELECT * FROM special_events');
    f.state.now+=30*60000;await f.run();
    assert.deepEqual(f.sql('SELECT * FROM special_events'),before,'automation never edits the staff event');
  }
  assert.deepEqual(results.undefined,{blocked:results.undefined.blocked,excluded:false});
  assert.ok(results.undefined.blocked>=1);
  assert.deepEqual(results.REVIEW,{blocked:0,excluded:true});
});

test('staff decisions win: a locked or edited event is never overwritten by an edited Facebook post',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  // Staff edit (what the admin save does): new values, locked.
  f.sql("UPDATE special_events SET title='Brewers Playoff Special',manual_locked=1,revision=revision+1 WHERE id=?",e.id);
  const edited=structuredClone(brewersRaw);
  edited.offers[0]={...edited.offers[0],content:'PULLED PORK SANDWICH WITH CHIPS AND SIDE OF COLESLAW $7.50',evidence:'PULLED PORK SANDWICH WITH CHIPS AND SIDE OF COLESLAW $7.50'};
  f.addBrewers(edited,'brewers','2026-10-23T21:00:00Z','2026-10-23T15:55:00-05:00');
  await f.run();
  const [after]=f.events();
  assert.equal(after.title,'Brewers Playoff Special');assert.deepEqual(f.offers(e.id),[BREWERS_OFFER]);
  assert.equal(f.events().length,1);
  assert.ok(f.log().some(l=>l.action==='protected'));
});

test('an unlocked automation event follows its own edited Facebook post',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  const edited=structuredClone(brewersRaw);
  edited.offers[0]={...edited.offers[0],content:'PULLED PORK SANDWICH WITH CHIPS AND SIDE OF COLESLAW $7.50',evidence:'PULLED PORK SANDWICH WITH CHIPS AND SIDE OF COLESLAW $7.50'};
  f.addBrewers(edited,'brewers','2026-10-23T21:00:00Z','2026-10-23T15:55:00-05:00');
  await f.run();
  const [after]=f.events();
  assert.equal(f.events().length,1);assert.equal(after.id,e.id);assert.equal(after.revision,e.revision+1);
  assert.deepEqual(f.offers(e.id),['Pulled Pork Sandwich With Chips and Side of Coleslaw $7.50']);
  assert.ok(f.log().some(l=>l.action==='updated'));
});

test('a rejected (removed) automation event is a tombstone: rescans and edits never recreate or republish it',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  f.sql("UPDATE special_events SET status='rejected',manual_locked=1,revision=revision+1 WHERE id=?",e.id);
  f.state.now+=30*60000;await f.run();
  const edited=structuredClone(brewersRaw);edited.poster_evidence="TONIGHT'S BREWERS GAME SPECIALS!";
  f.addBrewers(edited,'brewers','2026-10-23T21:30:00Z','2026-10-23T16:10:00-05:00');await f.run();
  assert.equal(f.events().length,1);assert.equal(f.events()[0].status,'rejected');
});

test('an identical reminder post never creates a second card',async t=>{
  const f=await brewersDay(t,'AUTO');
  f.addBrewers(brewersRaw,'brewers-reminder','2026-10-23T22:00:00Z','2026-10-23T16:45:00-05:00');await f.run();
  assert.equal(f.events().length,1);assert.equal(f.events()[0].status,'published');
  assert.ok(f.log().some(l=>l.action==='duplicate' && l.source_post_id==='brewers-reminder'));
});

test('a conflicting second post for the same event fails closed: both are held for review',async t=>{
  const f=await brewersDay(t,'AUTO');
  const other=structuredClone(brewersRaw);
  other.offers[0]={...other.offers[0],content:'BRAT WITH CHIPS $5',evidence:'BRAT WITH CHIPS $5'};
  f.addBrewers(other,'brewers-2','2026-10-23T22:00:00Z','2026-10-23T16:45:00-05:00');await f.run();
  const events=f.events();
  assert.equal(events.length,2);
  assert.deepEqual(events.map(e=>e.status),['review','review']);
  assert.ok(f.log().some(l=>l.action==='conflict'));
});

test('a conflicting post never changes a staff-locked event; only the new one is held',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  f.sql('UPDATE special_events SET manual_locked=1,revision=revision+1 WHERE id=?',e.id);
  const other=structuredClone(brewersRaw);
  other.offers[0]={...other.offers[0],content:'BRAT WITH CHIPS $5',evidence:'BRAT WITH CHIPS $5'};
  f.addBrewers(other,'brewers-2','2026-10-23T22:00:00Z','2026-10-23T16:45:00-05:00');await f.run();
  const byId=Object.fromEntries(f.events().map(x=>[x.source_post_id,x.status]));
  assert.deepEqual(byId,{brewers:'published','brewers-2':'review'});
});

test('manual events are never touched by automation',async t=>{
  const f=friday(t,'AUTO');
  f.sql(`INSERT INTO special_events(id,title,event_date,status,origin,manual_locked,date_basis,identity,fingerprint)
    VALUES('evt:manual','Brewers Watch Party','2026-10-23','published','manual',1,'manual','brewers','x')`);
  f.sql("INSERT INTO special_event_offers(event_id,position,content) VALUES('evt:manual',1,'Brats $3')");
  await f.run();f.addBrewers();await f.run();
  const manual=f.sql("SELECT * FROM special_events WHERE id='evt:manual'")[0];
  assert.deepEqual([manual.title,manual.status,manual.revision],['Brewers Watch Party','published',0]);
  assert.deepEqual(f.offers('evt:manual'),['Brats $3']);
  // The automated Brewers post differs from the staff event: held, not published beside it.
  assert.equal(f.sql("SELECT status FROM special_events WHERE source_post_id='brewers'")[0].status,'review');
});

test('a printed cancellation cancels the matching automation event; hypothetical cancellation poster',async t=>{
  const f=await brewersDay(t,'AUTO');
  // HYPOTHETICAL poster: not production evidence.
  const cancel={...structuredClone(brewersRaw),poster_evidence:"TONIGHT'S BREWERS GAME SPECIAL CANCELLED",offers:[]};
  f.addBrewers(cancel,'brewers-cancel','2026-10-23T22:30:00Z','2026-10-23T17:15:00-05:00');await f.run();
  assert.equal(f.sql("SELECT status FROM special_events WHERE source_post_id='brewers'")[0].status,'cancelled');
  assert.equal(f.events().length,1);
  assert.ok(f.log().some(l=>l.action==='cancelled'));
});

test('schema: offers stay within 1-4 positions and 150 characters; source posts are unique; manual events have no source',t=>{
  const f=friday(t);
  const insert=(id,source,origin='automation')=>f.sql(`INSERT INTO special_events(id,title,event_date,status,origin,date_basis,source_post_id)
    VALUES(?,'T','2026-10-23','review',?,'manual',?)`,id,origin,source);
  insert('evt:a','p1');
  assert.throws(()=>insert('evt:b','p1'),/UNIQUE/);
  assert.throws(()=>insert('evt:c','p2','manual'),/CHECK/);
  assert.throws(()=>f.sql("INSERT INTO special_event_offers(event_id,position,content) VALUES('evt:a',5,'x')"),/CHECK/);
  assert.throws(()=>f.sql("INSERT INTO special_event_offers(event_id,position,content) VALUES('evt:a',1,?)",'x'.repeat(151)),/CHECK/);
  assert.throws(()=>f.sql("INSERT INTO special_events(id,title,event_date,status,origin,date_basis) VALUES('bad','T','2026-10-23','review','manual','manual')"),/CHECK/);
  assert.throws(()=>f.sql("INSERT INTO special_events(id,title,event_date,status,origin,date_basis,start_time,end_time) VALUES('evt:t','T','2026-10-23','review','manual','manual','14:00','11:00')"),/CHECK/);
});
