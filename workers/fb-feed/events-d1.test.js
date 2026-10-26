import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {reconcileToday} from './guarded-auto.js';
import {reconcileEvents} from './event-store.js';

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
  assert.ok((await recorded('AUTO')).some(q=>/special_event/i.test(q)));
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

test('the retired REVIEW value behaves exactly like OFF: no event rows, the same daily specials',async t=>{
  const review=await brewersDay(t,'REVIEW'),off=await brewersDay(t);
  assert.deepEqual(review.events(),[]);assert.deepEqual(review.log(),[]);
  const contents=x=>x.slots().map(s=>[s.group_id,s.position,s.content]);
  assert.deepEqual(contents(review),contents(off));
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
  return {...f,addPackers:(candidate=packersRaw)=>{
    f.state.now=Date.parse('2026-10-25T15:35:08.068Z');f.state.candidate=structuredClone(candidate);
    f.state.posts.push({...f.state.posts[0],id:'packers',message:'',created_time:'2026-10-25T10:33:50-05:00',updated_time:'2026-10-25T10:33:50-05:00'});
  }};
}

test('October 25 Packers post with its empty caption: no event is created in any mode and its regular warning is unchanged',async t=>{
  const outcomes=[];
  for (const mode of [undefined,'AUTO']) {
    const f=sundaySetup(t,mode);await f.run();f.addPackers();await f.run();
    assert.deepEqual(f.sql('SELECT * FROM special_events'),[],String(mode));
    const ids=f.imports().map(i=>i.id);
    const r=await reconcileToday(f.env,{sourceIds:ids,today:'2026-10-25',weekday:0,inspectOnly:true});
    outcomes.push({blocked:r.blocked,slots:f.sql('SELECT group_id,position,content FROM special_slots ORDER BY group_id,position'),
      conflicts:f.sql("SELECT count(*) n FROM special_import_events WHERE detail LIKE 'GUARDED_AUTO_CONFLICT%'")[0].n});
  }
  // The unresolved "Sunday Special" offer remains a legitimate review condition.
  assert.ok(outcomes[0].blocked.length>=1);
  assert.deepEqual(outcomes[1],outcomes[0]);
});

test('October 25 Packers poster read with its printed "LET\'S GO PACK!" headline publishes automatically and stops blocking Sunday',async t=>{
  const results={};
  for (const mode of [undefined,'AUTO']) {
    const f=sundaySetup(t,mode);await f.run();
    // The contract-2 prompt now keeps printed banners in poster_evidence.
    f.addPackers({...structuredClone(packersRaw),poster_evidence:"LET'S GO PACK! Sunday Special"});await f.run();
    const ids=f.imports().map(i=>i.id);
    const r=await reconcileToday(f.env,{sourceIds:ids,today:'2026-10-25',weekday:0,inspectOnly:true});
    const packersImport=f.imports().find(i=>i.fb_post_id==='packers').id;
    results[String(mode)]={blocked:r.blocked.length,excluded:(r.excludedSourceIds??[]).includes(packersImport),
      events:f.sql('SELECT status,origin,identity,event_date FROM special_events').map(e=>({...e}))};
  }
  assert.ok(results.undefined.blocked>=1);assert.equal(results.undefined.excluded,false);assert.deepEqual(results.undefined.events,[]);
  assert.deepEqual(results.AUTO,{blocked:0,excluded:true,events:[{status:'published',origin:'automation',identity:'packers',event_date:'2026-10-25'}]});
});

test('a removed event is a tombstone that also keeps its poster out of the daily specials',async t=>{
  const f=sundaySetup(t,'AUTO');await f.run();
  f.addPackers({...structuredClone(packersRaw),poster_evidence:"LET'S GO PACK! Sunday Special"});await f.run();
  const sundaySlots=f.sql('SELECT group_id,position,content FROM special_slots ORDER BY group_id,position');
  f.sql("UPDATE special_events SET status='rejected',manual_locked=1,revision=revision+1");
  f.state.now+=30*60000;await f.run();
  assert.deepEqual(f.sql('SELECT status FROM special_events').map(e=>e.status),['rejected']);
  assert.deepEqual(f.sql('SELECT group_id,position,content FROM special_slots ORDER BY group_id,position'),sundaySlots);
  const ids=f.imports().map(i=>i.id),packersImport=f.imports().find(i=>i.fb_post_id==='packers').id;
  assert.ok((await reconcileToday(f.env,{sourceIds:ids,today:'2026-10-25',weekday:0,inspectOnly:true})).excludedSourceIds.includes(packersImport));
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

test('staff removal blocks identical and differing reposts while the original is in the feed',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  f.sql("UPDATE special_events SET status='rejected',manual_locked=1,revision=revision+1 WHERE id=?",e.id);
  const before=f.events();
  f.addBrewers(brewersRaw,'brewers-repost','2026-10-23T21:00:00Z','2026-10-23T15:55:00-05:00');await f.run();
  const other=structuredClone(brewersRaw);
  other.offers[0]={...other.offers[0],content:'BRAT WITH CHIPS $5',evidence:'BRAT WITH CHIPS $5'};
  f.addBrewers(other,'brewers-replacement','2026-10-23T22:00:00Z','2026-10-23T16:45:00-05:00');await f.run();
  assert.deepEqual(f.events(),before);
  assert.ok(f.log().some(l=>l.action==='protected' && l.source_post_id==='brewers-replacement'));
});

test('feed aging and nominal deletion errors never release a removed original, even after repeated scans',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  f.sql("UPDATE special_events SET status='rejected',manual_locked=1,revision=revision+1 WHERE id=?",e.id);
  const before=f.events();
  // Original disappeared from the limited feed. That cannot distinguish aging,
  // deletion, hidden content or lost per-object access. Graph responses are mocked.
  f.state.posts=f.state.posts.filter(p=>p.id!=='brewers');
  const previousFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async (input,options)=>{
    const url=new URL(input);
    if(url.hostname==='graph.facebook.com' && !url.pathname.endsWith('/posts'))
      return Response.json({error:{code:100,error_subcode:33}},{status:400});
    return previousFetch(input,options);
  });
  f.addBrewers(brewersRaw,'brewers-replacement','2026-10-23T21:00:00Z','2026-10-23T15:55:00-05:00');
  for(let i=0;i<3;i++) { await f.run();f.state.now+=31*60000; }
  assert.deepEqual(f.events(),before);
  assert.ok(f.log().some(l=>l.action==='protected' && /no verified deletion authority/.test(l.detail)));
});

test('legacy two-error deletion markers are not trusted as permission to resurrect an event',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  const evidence={...JSON.parse(e.evidence_json),source_missing_at:f.state.now-3600000,source_deleted_at:f.state.now-1800000};
  f.sql("UPDATE special_events SET status='rejected',manual_locked=1,evidence_json=? WHERE id=?",JSON.stringify(evidence),e.id);
  const before=f.events();
  f.state.posts=f.state.posts.filter(p=>p.id!=='brewers');
  f.addBrewers(brewersRaw,'brewers-replacement','2026-10-23T21:00:00Z','2026-10-23T15:55:00-05:00');await f.run();
  assert.deepEqual(f.events(),before);
});

test('a staff date edit followed by removal also blocks a repost of the original event date',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  f.sql("UPDATE special_events SET event_date='2026-10-24',status='rejected',manual_locked=1,revision=revision+1 WHERE id=?",e.id);
  const other=structuredClone(brewersRaw);
  other.offers[0]={...other.offers[0],content:'BRAT WITH CHIPS $5',evidence:'BRAT WITH CHIPS $5'};
  f.addBrewers(other,'brewers-repost','2026-10-23T21:00:00Z','2026-10-23T15:55:00-05:00');await f.run();
  assert.equal(f.events().length,1);assert.equal(f.events()[0].status,'rejected');
});

test('concurrent different posts for the same event create only one card atomically',async t=>{
  const f=await brewersDay(t,'AUTO');
  f.addBrewers(brewersRaw,'brewers-repost','2026-10-23T21:00:00Z','2026-10-23T15:55:00-05:00');await f.run();
  const rows=f.imports().filter(r=>r.fb_post_id.startsWith('brewers'));
  f.sql('DELETE FROM special_event_offers');f.sql('DELETE FROM special_event_log');f.sql('DELETE FROM special_events');
  await Promise.all(rows.map(r=>reconcileEvents(f.env,{sourceIds:[r.id],today:'2026-10-23'})));
  assert.equal(f.events().length,1);
  assert.equal(f.log().filter(l=>l.action==='created').length,1);
});

test('a tombstone arriving between the duplicate read and insert blocks the new post',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [original]=f.events();
  f.addBrewers(brewersRaw,'brewers-repost','2026-10-23T21:00:00Z','2026-10-23T15:55:00-05:00');await f.run();
  const row=f.imports().find(r=>r.fb_post_id==='brewers-repost');
  f.sql('DELETE FROM special_event_offers');f.sql('DELETE FROM special_event_log');f.sql('DELETE FROM special_events');
  const batch=f.env.DB.batch.bind(f.env.DB);let inserted=false;
  f.env.DB.batch=async statements=>{
    if(!inserted && statements.some(s=>/INSERT INTO special_events\(/.test(s.sql))) {
      inserted=true;
      f.sql(`INSERT INTO special_events(id,title,event_date,status,origin,manual_locked,date_basis,source_post_id,fingerprint,identity,last_auto_json)
        VALUES(?,?,?,'rejected','automation',1,'relative',?,?,?,?)`,original.id,original.title,original.event_date,
        original.source_post_id,original.fingerprint,original.identity,original.last_auto_json);
    }
    return batch(statements);
  };
  await reconcileEvents(f.env,{sourceIds:[row.id],today:'2026-10-23'});
  assert.equal(inserted,true);assert.deepEqual(f.events().map(e=>[e.id,e.status]),[[original.id,'rejected']]);
  assert.deepEqual(f.offers(original.id),[]);assert.deepEqual(f.log(),[]);
});

test('an identical reminder post never creates a second card',async t=>{
  const f=await brewersDay(t,'AUTO');
  f.addBrewers(brewersRaw,'brewers-reminder','2026-10-23T22:00:00Z','2026-10-23T16:45:00-05:00');await f.run();
  assert.equal(f.events().length,1);assert.equal(f.events()[0].status,'published');
  assert.ok(f.log().some(l=>l.action==='duplicate' && l.source_post_id==='brewers-reminder'));
});

test('a differing second post for the same event never creates a second card; the first stays published',async t=>{
  const f=await brewersDay(t,'AUTO');
  const other=structuredClone(brewersRaw);
  other.offers[0]={...other.offers[0],content:'BRAT WITH CHIPS $5',evidence:'BRAT WITH CHIPS $5'};
  f.addBrewers(other,'brewers-2','2026-10-23T22:00:00Z','2026-10-23T16:45:00-05:00');await f.run();
  const events=f.events();
  assert.equal(events.length,1);assert.equal(events[0].source_post_id,'brewers');assert.equal(events[0].status,'published');
  assert.ok(f.log().some(l=>l.action==='conflict' && l.source_post_id==='brewers-2'));
  // Repeated crons record that decision once.
  f.state.now+=30*60000;await f.run();
  assert.equal(f.log().filter(l=>l.source_post_id==='brewers-2').length,1);
});
test('a differing post never changes a staff-edited event and creates nothing beside it',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  f.sql('UPDATE special_events SET manual_locked=1,revision=revision+1 WHERE id=?',e.id);
  const other=structuredClone(brewersRaw);
  other.offers[0]={...other.offers[0],content:'BRAT WITH CHIPS $5',evidence:'BRAT WITH CHIPS $5'};
  f.addBrewers(other,'brewers-2','2026-10-23T22:00:00Z','2026-10-23T16:45:00-05:00');await f.run();
  assert.deepEqual(f.events().map(x=>[x.source_post_id,x.status,x.revision]),[['brewers','published',e.revision+1]]);
});

test('insufficient evidence is withheld internally: never shown, never an approval task, no daily-special block',async t=>{
  const f=friday(t,'AUTO');
  await f.run();f.addNight();await f.run();
  const unpriced=structuredClone(brewersRaw);
  unpriced.offers[0]={...unpriced.offers[0],content:'PULLED PORK SANDWICH WITH CHIPS AND SIDE OF COLESLAW',evidence:'PULLED PORK SANDWICH WITH CHIPS AND SIDE OF COLESLAW'};
  const warn=t.mock.method(console,'warn',()=>{});
  f.addBrewers(unpriced);await f.run();
  const [e]=f.events();
  assert.equal(e.status,'review');assert.match(e.review_reason,/^Withheld: .*Missing meal price/);
  assert.ok(warn.mock.calls.some(c=>c.arguments[0]==='Special event withheld'));
  assert.ok(!warn.mock.calls.some(c=>c.arguments[0]==='Specials import requires attention'));
  assert.deepEqual(f.conflicts(),[]);
  // A corrected Facebook post publishes the same event automatically.
  f.addBrewers(brewersRaw,'brewers','2026-10-23T21:00:00Z','2026-10-23T15:55:00-05:00');await f.run();
  assert.deepEqual(f.events().map(x=>[x.id,x.status,x.review_reason]),[[e.id,'published','']]);
  assert.deepEqual(f.offers(e.id),[BREWERS_OFFER]);
});

test('an automation event is withdrawn when its own Facebook post no longer shows an event',async t=>{
  const f=await brewersDay(t,'AUTO');
  const [e]=f.events();
  const plain={...structuredClone(brewersRaw),poster_evidence:'Friday Night Specials 5-10pm',day_of_week:5,day_evidence:'Friday'};
  f.addBrewers(plain,'brewers','2026-10-23T21:00:00Z','2026-10-23T15:55:00-05:00');await f.run();
  const [after]=f.events();
  assert.equal(after.id,e.id);assert.equal(after.status,'review');assert.match(after.review_reason,/no longer shows an event/);
});
test('staff-controlled events with the same identity are never touched, and no second card is created',async t=>{
  const f=friday(t,'AUTO');
  f.sql(`INSERT INTO special_events(id,title,event_date,status,origin,manual_locked,date_basis,identity,fingerprint)
    VALUES('evt:manual','Brewers Watch Party','2026-10-23','published','manual',1,'manual','brewers','x')`);
  f.sql("INSERT INTO special_event_offers(event_id,position,content) VALUES('evt:manual',1,'Brats $3')");
  await f.run();f.addBrewers();await f.run();
  const manual=f.sql("SELECT * FROM special_events WHERE id='evt:manual'")[0];
  assert.deepEqual([manual.title,manual.status,manual.revision],['Brewers Watch Party','published',0]);
  assert.deepEqual(f.offers('evt:manual'),['Brats $3']);
  assert.equal(f.sql("SELECT count(*) n FROM special_events WHERE source_post_id='brewers'")[0].n,0);
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
