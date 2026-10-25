// Run the production build first: these tests exercise the compiled routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
const ev=loadTs('src/lib/special-events.ts');
const homePage=(await import('../dist/_worker.js/pages/index.astro.mjs')).page().default;
const specialsPage=(await import('../dist/_worker.js/pages/specials.astro.mjs')).page().default;
const adminPage=(await import('../dist/_worker.js/pages/admin/events.astro.mjs')).page().default;
const container=await AstroContainer.create();
const cookie='gb_session='+'a'.repeat(32);
// Friday October 23 2026, 3:30 PM CDT.
const NOW=new Date('2026-10-23T20:30:00Z');

function seed(f,{id,title='Brewers Game Special',date='2026-10-23',status='published',origin='manual',locked=1,offers=['Pulled Pork Sandwich With Chips and Side of Coleslaw $7.25'],start=null,end=null,timeText='',source=null,lastAuto=null,revision=0}) {
  f.sql(`INSERT INTO special_events(id,title,event_date,time_text,start_time,end_time,status,origin,manual_locked,date_basis,source_post_id,last_auto_json,revision)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,title,date,timeText,start,end,status,origin,locked,origin==='manual'?'manual':'relative',source,lastAuto,revision);
  offers.forEach((content,i)=>f.sql('INSERT INTO special_event_offers(event_id,position,content) VALUES(?,?,?)',id,i+1,content));
}
const render=(page,f,path='/',now=NOW)=>container.renderToString(page,{request:new Request('http://localhost'+path,{headers:{cookie}}),locals:{runtime:{env:f.env,now}}});
const post=(f,fields,{origin='http://localhost',now=NOW,auth=true}={})=>{
  const body=new FormData();for(const [k,v] of Object.entries(fields)) body.set(k,String(v));
  return container.renderToResponse(adminPage,{request:new Request('http://localhost/admin/events',{method:'POST',
    headers:{...(origin?{origin}:{}),...(auth?{cookie}:{})},body}),locals:{runtime:{env:f.env,now}}});
};
const setup=t=>{const f=fixture(t);f.env.SESSIONS={get:async()=>'1'};return f;};
const event=(f,id)=>f.sql('SELECT * FROM special_events WHERE id=?',id)[0];
const offers=(f,id)=>f.sql('SELECT content FROM special_event_offers WHERE event_id=? ORDER BY position',id).map(o=>o.content);
const fields=(over={})=>({title:'Packers Game Day Special',event_date:'2026-10-25',time_text:'',start_time:'',end_time:'',details:'',offer_1:'Pulled Pork Sandwich w/ Chips $4',...over});

test('event state uses Chicago wall-clock time: today, upcoming, end-time expiry and midnight expiry',()=>{
  assert.equal(ev.eventState({event_date:'2026-10-23',end_time:null},NOW),'active');
  assert.equal(ev.eventState({event_date:'2026-10-25',end_time:null},NOW),'upcoming');
  assert.equal(ev.eventState({event_date:'2026-10-22',end_time:null},NOW),'expired');
  assert.equal(ev.eventState({event_date:'2026-10-23',end_time:'15:30'},NOW),'expired');
  assert.equal(ev.eventState({event_date:'2026-10-23',end_time:'15:31'},NOW),'active');
  // 23:59 CDT is still the event date; 00:00 the next day is not.
  assert.equal(ev.eventState({event_date:'2026-10-23',end_time:null},new Date('2026-10-24T04:59:00Z')),'active');
  assert.equal(ev.eventState({event_date:'2026-10-23',end_time:null},new Date('2026-10-24T05:00:00Z')),'expired');
  // November 1 2026 (clocks fall back) and March 14 2027 (spring forward).
  assert.equal(ev.eventState({event_date:'2026-11-01',end_time:'12:00'},new Date('2026-11-01T17:59:00Z')),'active');   // 11:59 CST
  assert.equal(ev.eventState({event_date:'2026-11-01',end_time:'12:00'},new Date('2026-11-01T18:00:00Z')),'expired');  // 12:00 CST
  assert.equal(ev.eventState({event_date:'2026-11-01',end_time:null},new Date('2026-11-02T05:59:00Z')),'active');      // 23:59 CST
  assert.equal(ev.eventState({event_date:'2027-03-14',end_time:'12:00'},new Date('2027-03-14T16:59:00Z')),'active');   // 11:59 CDT
  assert.equal(ev.eventState({event_date:'2027-03-14',end_time:'12:00'},new Date('2027-03-14T17:00:00Z')),'expired');
  assert.equal(ev.chicagoClock(new Date('2026-11-01T06:30:00Z')),'01:30');
  assert.equal(ev.chicagoClock(new Date('2026-11-01T07:30:00Z')),'01:30');
});

test('display helpers: one trailing price splits out; other prices stay inline; times format plainly',()=>{
  assert.deepEqual(ev.splitTrailingPrice('Pulled Pork Sandwich w/ Chips - $4'),{text:'Pulled Pork Sandwich w/ Chips',price:'$4'});
  assert.deepEqual(ev.splitTrailingPrice('Brats $3.50'),{text:'Brats',price:'$3.50'});
  assert.deepEqual(ev.splitTrailingPrice('1 or 2 Brats $4/$7'),{text:'1 or 2 Brats $4/$7',price:''});
  assert.deepEqual(ev.splitTrailingPrice('$5 pitchers all game'),{text:'$5 pitchers all game',price:''});
  assert.deepEqual(ev.splitTrailingPrice('$4'),{text:'$4',price:''});
  assert.equal(ev.formatEventTime({time_text:'Tonight',start_time:null,end_time:null}),'Tonight');
  assert.equal(ev.formatEventTime({time_text:'x',start_time:'11:00',end_time:'14:30'}),'11 AM–2:30 PM');
  assert.equal(ev.formatEventTime({time_text:'',start_time:'12:00',end_time:null}),'From 12 PM');
  assert.equal(ev.formatEventDate('2026-10-25'),'Sun, Oct 25');
});

test('visible events: published only, today through six days ahead, unexpired, with offers, in date order',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:today'});
  seed(f,{id:'evt:sunday',title:'Packers Game Day Special',date:'2026-10-25',offers:['Pulled Pork Sandwich w/ Chips $4']});
  seed(f,{id:'evt:ended',date:'2026-10-23',end:'14:00'});
  seed(f,{id:'evt:past',date:'2026-10-22'});
  seed(f,{id:'evt:far',date:'2026-10-30'});
  seed(f,{id:'evt:edge',date:'2026-10-29'});
  for (const status of ['review','disabled','rejected','cancelled']) seed(f,{id:`evt:${status}`,status});
  seed(f,{id:'evt:empty',offers:[]});
  assert.deepEqual((await ev.readVisibleEvents(f.env,NOW)).map(e=>e.id),['evt:today','evt:sunday','evt:edge']);
});

test('a missing events table or database never breaks the pages',async t=>{
  const f=setup(t);
  for (const table of ['special_event_offers','special_event_log','special_events']) f.sql(`DROP TABLE ${table}`);
  assert.deepEqual(await ev.readVisibleEvents(f.env,NOW),[]);
  assert.deepEqual(await ev.readVisibleEvents({},NOW),[]);
  for (const [page,path] of [[homePage,'/'],[specialsPage,'/specials']]) assert.doesNotMatch(await render(page,f,path),/event-specials/);
});

test('homepage and /specials render events once, above the ordinary specials, never inside a day card',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:today',timeText:'Tonight'});
  seed(f,{id:'evt:sunday',title:'Packers Game Day Special',date:'2026-10-25',offers:['Pulled Pork Sandwich w/ Chips $4'],start:'11:00',end:'15:00'});
  for (const [page,path,anchor] of [[homePage,'/','id="home-weekly-title"'],[specialsPage,'/specials','class="week-section"']]) {
    const html=await render(page,f,path);
    assert.equal((html.match(/class="event-specials"/g)||[]).length,1,path);
    assert.equal((html.match(/class="event-card"/g)||[]).length,2,path);
    const section=html.match(/<section class="event-specials"[\s\S]*?<\/section>/)[0];
    assert.match(section,/Brewers Game Special/);assert.match(section,/Pulled Pork Sandwich With Chips and Side of Coleslaw/);
    assert.match(section,/<span class="event-card__price"[^>]*>\$7\.25<\/span>/);
    assert.match(section,/event-card__badge--today[^>]*>Today</);
    assert.match(section,/>Upcoming</);assert.match(section,/<time datetime="2026-10-25T11:00"[^>]*>Sun, Oct 25<\/time>/);
    assert.match(section,/11 AM–3 PM/);assert.match(section,/Tonight/);
    // The upcoming Sunday offer is never labelled Today and appears only in the event section.
    assert.equal((html.match(/Pulled Pork Sandwich w\/ Chips/g)||[]).length,1);
    if (html.includes(anchor)) assert.ok(html.indexOf('class="event-specials"')<html.indexOf(anchor),`${path}: events above specials`);
  }
});

test('the homepage shows at most three events; /specials shows all in the window',async t=>{
  const f=setup(t);
  for (let i=0;i<5;i++) seed(f,{id:`evt:${i}`,title:`Event ${i}`,date:`2026-10-2${3+i}`});
  assert.equal(((await render(homePage,f,'/')).match(/class="event-card"/g)||[]).length,3);
  assert.equal(((await render(specialsPage,f,'/specials')).match(/class="event-card"/g)||[]).length,5);
});

test('event text is escaped everywhere it is rendered',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:xss',title:'<img src=x onerror=alert(1)>',offers:['<script>alert(1)</script> $4']});
  f.sql(`UPDATE special_events SET title='"><img src=x onerror=alert(1)>' WHERE id='evt:xss'`);
  for (const html of [await render(homePage,f,'/'),await render(specialsPage,f,'/specials'),await render(adminPage,f,'/admin/events')]) {
    // Quoted attribute values are inert; outside them nothing is unescaped,
    // and a quote in the title cannot end an attribute.
    const outsideAttributes=html.replace(/="[^"]*"/g,'=""');
    assert.doesNotMatch(outsideAttributes,/<img src=x|<script>alert/);assert.match(html,/&lt;img src=x/);
    assert.doesNotMatch(html,/="[^"]*"><img src=x/);
  }
});

test('event card CSS: one antique-gold style, horizontal on desktop, stacked on mobile, no overflow and no animation',()=>{
  const css=readFileSync('src/components/EventSpecials.astro','utf8').split('<style>')[1];
  assert.match(css,/grid-template-columns:minmax\(12rem,1\.1fr\) minmax\(9rem,\.7fr\) minmax\(0,2\.4fr\)/);
  assert.match(css,/@media \(max-width:599px\)\{[\s\S]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css,/overflow-wrap:anywhere/);
  assert.doesNotMatch(css,/animation|transition|@keyframes|brewers|packers|team/i);
});

test('admin: unauthenticated visitors are redirected and cannot post',async t=>{
  const f=fixture(t);f.env.SESSIONS={get:async()=>null};
  const res=await post(f,fields());
  assert.equal(res.status,302);assert.equal(res.headers.get('location'),'/admin');
  assert.deepEqual(f.sql('SELECT * FROM special_events'),[]);
});

test('admin: a foreign or missing Origin is rejected without writing',async t=>{
  const f=setup(t);
  for (const origin of ['https://evil.example',null]) {
    const res=await post(f,{op:'create',...fields()},{origin});
    assert.equal(res.status,400);assert.match(await res.text(),/Invalid request origin/);
  }
  assert.deepEqual(f.sql('SELECT * FROM special_events'),[]);
});

test('admin: staff create a locked, published manual event; it shows on the public pages',async t=>{
  const f=setup(t);
  const res=await post(f,{op:'create',...fields({start_time:'11:00',end_time:'15:00',offer_2:'Brats $3'})});
  assert.equal(res.status,303);assert.match(res.headers.get('location'),/^\/admin\/events\?done=created#evt%3A/);
  const [e]=f.sql('SELECT * FROM special_events');
  assert.deepEqual([e.title,e.event_date,e.status,e.origin,e.manual_locked,e.date_basis,e.start_time,e.end_time,e.source_post_id],
    ['Packers Game Day Special','2026-10-25','published','manual',1,'manual','11:00','15:00',null]);
  assert.deepEqual(offers(f,e.id),['Pulled Pork Sandwich w/ Chips $4','Brats $3']);
  assert.match(await render(specialsPage,f,'/specials'),/Packers Game Day Special/);
});

test('admin: server-side validation rejects bad input and keeps the draft',async t=>{
  const f=setup(t);
  const cases=[[{title:''},/event name/],[{title:'x'.repeat(81)},/80 characters/],[{event_date:'2026-02-30'},/valid event date/],
    [{offer_1:''},/at least one offer/],[{offer_1:'x'.repeat(151)},/150 characters/],[{start_time:'25:00'},/HH:MM/],
    [{start_time:'15:00',end_time:'11:00'},/after the start time/],[{details:'x'.repeat(301)},/300 characters/],[{time_text:'x'.repeat(81)},/80 characters/]];
  for (const [over,message] of cases) {
    const res=await post(f,{op:'create',...fields({title:'Kept draft title',...over})});
    assert.equal(res.status,400);const html=await res.text();
    assert.match(html,message);
    if (over.title===undefined) assert.match(html,/value="Kept draft title"/);
  }
  assert.deepEqual(f.sql('SELECT * FROM special_events'),[]);
});

test('admin: saving an automation event locks it; a stale revision is a 409 conflict that changes nothing',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:auto',origin:'automation',locked:0,status:'review',source:'brewers',revision:2});
  const res=await post(f,{op:'save',id:'evt:auto',revision:2,...fields({title:'Brewers Game Special',event_date:'2026-10-23',offer_1:'Pulled Pork Sandwich $7.25'})});
  assert.equal(res.status,303);
  let e=event(f,'evt:auto');
  assert.deepEqual([e.manual_locked,e.status,e.revision,e.origin],[1,'review',3,'automation']);
  assert.deepEqual(offers(f,'evt:auto'),['Pulled Pork Sandwich $7.25']);
  const stale=await post(f,{op:'save',id:'evt:auto',revision:2,...fields({offer_1:'Changed $1'})});
  assert.equal(stale.status,409);assert.match(await stale.text(),/changed after you opened it/);
  assert.deepEqual(offers(f,'evt:auto'),['Pulled Pork Sandwich $7.25']);
  // Approve-and-save publishes in one step.
  assert.equal((await post(f,{op:'save-approve',id:'evt:auto',revision:3,...fields({title:'Brewers Game Special',event_date:'2026-10-23',offer_1:'Pulled Pork Sandwich $7.25'})})).status,303);
  e=event(f,'evt:auto');assert.deepEqual([e.status,e.review_reason,e.revision],['published','',4]);
});

test('admin: approve, reject, hide and publish are staff decisions that lock the event',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:r',origin:'automation',locked:0,status:'review',source:'p1'});
  assert.equal((await post(f,{op:'approve',id:'evt:r',revision:0})).status,303);
  assert.deepEqual([event(f,'evt:r').status,event(f,'evt:r').manual_locked],['published',1]);
  assert.equal((await post(f,{op:'approve',id:'evt:r',revision:1})).status,400);           // only review events
  assert.equal((await post(f,{op:'disable',id:'evt:r',revision:1})).status,303);
  assert.equal(event(f,'evt:r').status,'disabled');
  assert.equal((await post(f,{op:'enable',id:'evt:r',revision:2})).status,303);
  assert.equal((await post(f,{op:'reject',id:'evt:r',revision:3})).status,303);
  assert.equal(event(f,'evt:r').status,'rejected');
  assert.equal((await post(f,{op:'reject',id:'evt:r',revision:3})).status,409);            // stale
  assert.equal((await post(f,{op:'explode',id:'evt:r',revision:4})).status,400);
});

test('admin: only manual events can be deleted; Facebook events stay as tombstones',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:fb',origin:'automation',locked:0,source:'p1'});seed(f,{id:'evt:m'});
  assert.equal((await post(f,{op:'delete',id:'evt:fb',revision:0})).status,400);
  assert.ok(event(f,'evt:fb'));
  assert.equal((await post(f,{op:'delete',id:'evt:m',revision:0})).status,303);
  assert.equal(event(f,'evt:m'),undefined);assert.deepEqual(offers(f,'evt:m'),[]);
});

test('admin: "Allow Facebook updates" unlocks only active Facebook events and records the current values',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:fb',origin:'automation',locked:1,source:'p1'});seed(f,{id:'evt:m'});
  assert.equal((await post(f,{op:'allow-automation',id:'evt:m',revision:0})).status,400);
  assert.equal((await post(f,{op:'allow-automation',id:'evt:fb',revision:0})).status,303);
  const e=event(f,'evt:fb');
  assert.equal(e.manual_locked,0);
  assert.deepEqual(JSON.parse(e.last_auto_json),{title:'Brewers Game Special',event_date:'2026-10-23',time_text:'',start_time:null,end_time:null,details:'',offers:['Pulled Pork Sandwich With Chips and Side of Coleslaw $7.25']});
});

// The October 25 Packers poster (stored extraction, empty production caption)
// is not recognized automatically; staff identify it from the recent posts list.
function packersImport(f) {
  const {packers_event:packers}=JSON.parse(readFileSync('tests/fixtures/oct25-sunday-soup.json','utf8'));
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,caption,permalink_url,parser_version,processing_status,validation_result,extracted_json,candidate_json,fetched_at,image_r2_key)
    VALUES('imp-packers','1744742333860310','2026-10-25T15:33:50+0000','','https://www.facebook.com/example/posts/1',19,'staged','ok',?,?,?,'special-imports/packers.jpg')`,
    JSON.stringify(packers),JSON.stringify(packers),'2026-10-25T15:35:08.068Z');
}
const SUNDAY=new Date('2026-10-25T16:00:00Z');

test('admin: the Packers post is listed for staff, prefills its printed offer and Sunday, and staff supply the name',async t=>{
  const f=setup(t);packersImport(f);
  const list=await render(adminPage,f,'/admin/events',SUNDAY);
  assert.match(list,/Recent Facebook posts/);assert.match(list,/Sunday Sunday Special|Sunday Special/);
  assert.match(list,/href="\/admin\/events\?from=1744742333860310#create-event"/);
  const form=await render(adminPage,f,'/admin/events?from=1744742333860310',SUNDAY);
  const create=form.match(/<details class="events-panel" id="create-event"[\s\S]*?<\/details>/)[0];
  assert.match(create,/ open/);
  assert.match(create,/name="source_post_id" value="1744742333860310"/);
  assert.match(create,/value="PULLED PORK SANDWICH W\/ CHIPS - \$4"/);
  assert.match(create,/name="event_date"[^>]*value="2026-10-25"/);
  assert.match(create,/name="title"[^>]* value(?:="")?[ >]/);   // never invented
});

test('admin: creating an event from the Packers post links it once; a second link is refused',async t=>{
  const f=setup(t);packersImport(f);
  const res=await post(f,{op:'create',source_post_id:'1744742333860310',...fields({event_date:'2026-10-25'})},{now:SUNDAY});
  assert.equal(res.status,303);
  const [e]=f.sql('SELECT * FROM special_events');
  assert.deepEqual([e.origin,e.manual_locked,e.status,e.source_post_id,e.source_permalink],['manual',1,'published','1744742333860310','https://www.facebook.com/example/posts/1']);
  const again=await post(f,{op:'create',source_post_id:'1744742333860310',...fields()},{now:SUNDAY});
  assert.equal(again.status,400);assert.match(await again.text(),/already has an event/);
  assert.equal(f.sql('SELECT count(*) n FROM special_events')[0].n,1);
  // The linked post is no longer suggested.
  assert.doesNotMatch(await render(adminPage,f,'/admin/events',SUNDAY),/from=1744742333860310/);
  // Unknown posts cannot be linked.
  assert.equal((await post(f,{op:'create',source_post_id:'nope',...fields()},{now:SUNDAY})).status,400);
});

test('admin page: sections, labelled controls, text status badges and evidence for review items',async t=>{
  const f=setup(t);
  f.sql(`INSERT INTO special_events(id,title,event_date,status,origin,manual_locked,date_basis,source_post_id,evidence_json,review_reason)
    VALUES('evt:rev','Brewers Game Special','2026-10-23','review','automation',0,'relative','brewers',?,'Review mode: approve to publish')`,
    JSON.stringify({heading:"TONIGHT'S BREWERS GAME SPECIAL",offers:['PULLED PORK SANDWICH $7.25'],date:'"tonight" + post date 2026-10-23',image_key:'special-imports/b.jpg'}));
  f.sql("INSERT INTO special_event_offers VALUES('evt:rev',1,'Pulled Pork Sandwich $7.25')");
  const html=await render(adminPage,f,'/admin/events');
  for (const heading of ['Needs review','Today and upcoming','Hidden, removed and cancelled']) assert.match(html,new RegExp(`<h3[^>]*>${heading}`));
  assert.match(html,/>Needs review</);assert.match(html,/Review mode: approve to publish/);
  assert.match(html,/TONIGHT'S BREWERS GAME SPECIAL|TONIGHT&#39;S BREWERS GAME SPECIAL/);
  assert.match(html,/href="\/admin\/img\/special-imports\/b\.jpg"/);
  assert.match(html,/Approve and publish “Brewers Game Special”/);
  // Every input has a label.
  for (const [,id] of html.matchAll(/<input[^>]*\bid="([^"]+)"/g)) assert.match(html,new RegExp(`for="${id}"`),id);
});
