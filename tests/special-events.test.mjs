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
const adminPage=(await import('../dist/_worker.js/pages/admin/specials.astro.mjs')).page().default;
const retiredEventsPage=(await import('../dist/_worker.js/pages/admin/events.astro.mjs')).page().default;
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
  return container.renderToResponse(adminPage,{request:new Request('http://localhost/admin/specials',{method:'POST',
    headers:{...(origin?{origin}:{}),...(auth?{cookie}:{})},body}),locals:{runtime:{env:f.env,now}}});
};
const setup=t=>{const f=fixture(t);f.env.SESSIONS={get:async()=>'1'};return f;};
const event=(f,id)=>f.sql('SELECT * FROM special_events WHERE id=?',id)[0];
const offers=(f,id)=>f.sql('SELECT content FROM special_event_offers WHERE event_id=? ORDER BY position',id).map(o=>o.content);
const fields=(over={})=>({title:'Packers Game Day Special',event_date:'2026-10-25',time_text:'',start_time:'',end_time:'',offer_1:'Pulled Pork Sandwich w/ Chips $4',...over});
const save=(f,id,revision,over={},options)=>post(f,{action:'save-event',event_id:id,event_revision:revision,...fields(over)},options);
const remove=(f,id,revision,options)=>post(f,{action:'remove-event',event_id:id,event_revision:revision},options);
const section=html=>html.match(/<section id="special-events"[\s\S]*?<\/section>/)[0];

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

test('visible events: published only, today and every upcoming date, unexpired, with offers, in date order',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:today'});
  seed(f,{id:'evt:sunday',title:'Packers Game Day Special',date:'2026-10-25',offers:['Pulled Pork Sandwich w/ Chips $4']});
  seed(f,{id:'evt:ended',date:'2026-10-23',end:'14:00'});
  seed(f,{id:'evt:past',date:'2026-10-22'});
  seed(f,{id:'evt:far',date:'2026-10-30'});
  seed(f,{id:'evt:edge',date:'2026-10-29'});
  for (const status of ['review','disabled','rejected','cancelled']) seed(f,{id:`evt:${status}`,status});
  seed(f,{id:'evt:empty',offers:[]});
  seed(f,{id:'evt:thanksgiving',date:'2026-11-26'});
  assert.deepEqual((await ev.readVisibleEvents(f.env,NOW)).map(e=>e.id),['evt:today','evt:sunday','evt:edge','evt:far','evt:thanksgiving']);
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

test('the homepage shows at most three events; /specials shows all current and upcoming',async t=>{
  const f=setup(t);
  for (let i=0;i<5;i++) seed(f,{id:`evt:${i}`,title:`Event ${i}`,date:`2026-10-2${3+i}`});
  assert.equal(((await render(homePage,f,'/')).match(/class="event-card"/g)||[]).length,3);
  assert.equal(((await render(specialsPage,f,'/specials')).match(/class="event-card"/g)||[]).length,5);
});

test('event text is escaped everywhere it is rendered',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:xss',title:'<img src=x onerror=alert(1)>',offers:['<script>alert(1)</script> $4']});
  f.sql(`UPDATE special_events SET title='"><img src=x onerror=alert(1)>' WHERE id='evt:xss'`);
  for (const html of [await render(homePage,f,'/'),await render(specialsPage,f,'/specials'),await render(adminPage,f,'/admin/specials')]) {
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

// ── Special Events section of /admin/specials ──
test('admin: /admin/events is retired: it redirects signed-in staff to the Special Events section and others to sign-in',async t=>{
  const f=setup(t);
  const go=(auth,method='GET')=>container.renderToResponse(retiredEventsPage,{request:new Request('http://localhost/admin/events',{method,
    headers:auth?{cookie,origin:'http://localhost'}:{}}),locals:{runtime:{env:f.env,now:NOW}}});
  let res=await go(true);assert.equal(res.status,303);assert.equal(res.headers.get('location'),'/admin/specials#special-events');
  res=await go(true,'POST');assert.equal(res.status,303);
  f.env.SESSIONS={get:async()=>null};
  res=await go(false);assert.equal(res.status,302);assert.equal(res.headers.get('location'),'/admin');
  assert.deepEqual(f.sql('SELECT * FROM special_events'),[]);
});

test('admin: no Events navigation item or link to a separate events page',async t=>{
  const f=setup(t);
  const html=await render(adminPage,f,'/admin/specials');
  assert.doesNotMatch(html,/href="\/admin\/events/);
  assert.doesNotMatch(readFileSync('src/layouts/Base.astro','utf8'),/\/admin\/events/);
});

test('admin: four matching collapsible sections in order, Special Events collapsed by default, Weekly Specials below',async t=>{
  const f=setup(t);seed(f,{id:'evt:today'});
  const html=await render(adminPage,f,'/admin/specials');
  const summaries=[...html.matchAll(/<details class="recurring-defaults"[^>]*>\s*<summary[^>]*>([^<]+)<\/summary>/g)].map(m=>m[1]);
  assert.deepEqual(summaries,['Recurring Defaults','Recurring Mexican Night Defaults','This Week’s Mexican Night','Special Events']);
  assert.ok(html.indexOf('>Special Events</summary>')<html.search(/<h3[^>]*>Weekly Specials<\/h3>/));
  // Same white container class and the same cream summary details as the other three.
  assert.match(html,/<section id="special-events" class="recurring-defaults-form special-events-admin"[^>]*>\s*<details class="recurring-defaults"(?![^>]*\bopen\b)[^>]*>/);
});

test('admin: forms are never nested, so event controls cannot submit the Specials editors',async t=>{
  const f=setup(t);seed(f,{id:'evt:today'});seed(f,{id:'evt:sunday',date:'2026-10-25'});
  const html=await render(adminPage,f,'/admin/specials');
  let depth=0;
  for (const [tag] of html.matchAll(/<\/?form\b/g)) { depth+=tag==='<form'?1:-1; assert.ok(depth===0||depth===1,'nested form'); }
  assert.equal(depth,0);
  const events=section(html);
  assert.equal((events.match(/<form\b/g)||[]).length,4);   // Edit and Remove for each event
  for (const form of events.match(/<form[\s\S]*?<\/form>/g)) assert.match(form,/name="action" value="(?:save-event|remove-event)"/);
});

test('admin: only current and upcoming published events are listed, earliest first, with only Edit and Remove',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:later',title:'Thanksgiving Eve Special',date:'2026-11-25',offers:['Prime Rib $19.99']});
  seed(f,{id:'evt:sunday',title:'Packers Game Day Special',date:'2026-10-25',offers:['Pulled Pork Sandwich w/ Chips - $4'],start:'11:00',end:'15:00'});
  seed(f,{id:'evt:today',timeText:'Tonight'});
  seed(f,{id:'evt:ended',title:'Ended Lunch Event',end:'14:00'});
  seed(f,{id:'evt:past',title:'Yesterday Event',date:'2026-10-22'});
  for (const status of ['review','disabled','rejected','cancelled']) seed(f,{id:`evt:${status}`,title:`Status ${status}`,date:'2026-10-24',status});
  const html=section(await render(adminPage,f,'/admin/specials'));
  assert.deepEqual([...html.matchAll(/<h4 id="[^"]+"[^>]*>([^<]+)<\/h4>/g)].map(m=>m[1]),['Brewers Game Special','Packers Game Day Special','Thanksgiving Eve Special']);
  assert.match(html,/Friday, October 23/);assert.match(html,/Tonight/);assert.match(html,/11 AM–3 PM/);
  assert.match(html,/Pulled Pork Sandwich w\/ Chips<\/span><span class="event-entry__price"[^>]*>\$4</);
  assert.equal((html.match(/>Edit<span/g)||[]).length,3);assert.equal((html.match(/>Remove<span/g)||[]).length,3);
  for (const removed of [/Needs review/i,/Approve/,/Reject/,/\bHide\b/,/Restore/,/Recent Facebook posts/i,/Create event/i,/Create an event/i,/Expired events/i,/Allow Facebook updates/,/Delete permanently/,/name="details"/])
    assert.doesNotMatch(html,removed);
  assert.doesNotMatch(html,/Ended Lunch Event|Yesterday Event|Status /);
});

test('admin: events disappear automatically after their Chicago date, including across daylight-saving changes',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:fallback',title:'Fall Back Event',date:'2026-11-01'});
  seed(f,{id:'evt:spring',title:'Spring Forward Event',date:'2027-03-14',end:'12:00'});
  const listed=async now=>[...section(await render(adminPage,f,'/admin/specials',now)).matchAll(/<h4 id="[^"]+"[^>]*>([^<]+)<\/h4>/g)].map(m=>m[1]);
  assert.deepEqual(await listed(new Date('2026-11-02T05:59:00Z')),['Fall Back Event','Spring Forward Event']);  // 11:59 PM CST
  assert.deepEqual(await listed(new Date('2026-11-02T06:00:00Z')),['Spring Forward Event']);                     // midnight CST
  assert.deepEqual(await listed(new Date('2027-03-14T16:59:00Z')),['Spring Forward Event']);                     // 11:59 AM CDT
  assert.deepEqual(await listed(new Date('2027-03-14T17:00:00Z')),[]);                                            // printed end
  for (const [page,path] of [[homePage,'/'],[specialsPage,'/specials']])
    assert.doesNotMatch(await render(page,f,path,new Date('2027-03-14T17:00:00Z')),/class="event-card"/);
});

test('admin: unauthenticated visitors are redirected and cannot edit or remove',async t=>{
  const f=fixture(t);f.env.SESSIONS={get:async()=>null};seed(f,{id:'evt:today'});
  for (const res of [await save(f,'evt:today',0),await remove(f,'evt:today',0)]) {
    assert.equal(res.status,302);assert.equal(res.headers.get('location'),'/admin');
  }
  assert.deepEqual([event(f,'evt:today').revision,event(f,'evt:today').status],[0,'published']);
});

test('admin: a foreign or missing Origin is rejected without writing',async t=>{
  const f=setup(t);seed(f,{id:'evt:today'});
  for (const origin of ['https://evil.example',null]) {
    for (const res of [await save(f,'evt:today',0,{},{origin}),await remove(f,'evt:today',0,{origin})]) {
      assert.equal(res.status,400);assert.match(await res.text(),/Invalid request origin/);
    }
  }
  assert.deepEqual([event(f,'evt:today').revision,event(f,'evt:today').status],[0,'published']);
});

test('admin: Edit saves name, date, time and offers, and locks the event against Facebook changes',async t=>{
  const f=setup(t);
  seed(f,{id:'evt:auto',origin:'automation',locked:0,source:'brewers',revision:2,lastAuto:'{}'});
  const res=await save(f,'evt:auto',2,{title:'Brewers Playoff Special',event_date:'2026-10-24',start_time:'17:00',end_time:'22:00',time_text:'5-10 PM',offer_1:'Pulled Pork Sandwich $7.25',offer_2:'Brats $3'});
  assert.equal(res.status,303);assert.equal(res.headers.get('location'),'/admin/specials?event=saved#special-events');
  const e=event(f,'evt:auto');
  assert.deepEqual([e.title,e.event_date,e.start_time,e.end_time,e.time_text,e.manual_locked,e.status,e.revision,e.origin,e.source_post_id],
    ['Brewers Playoff Special','2026-10-24','17:00','22:00','5-10 PM',1,'published',3,'automation','brewers']);
  assert.deepEqual(offers(f,'evt:auto'),['Pulled Pork Sandwich $7.25','Brats $3']);
  const after=await render(adminPage,f,'/admin/specials?event=saved');
  assert.match(after,/Event saved\. Facebook will not change it\./);
  assert.match(after,/<details class="recurring-defaults" open/);
  assert.match(await render(specialsPage,f,'/specials'),/Brewers Playoff Special/);
});

test('admin: a stale revision is a 409 conflict that changes nothing and keeps the typed draft open',async t=>{
  const f=setup(t);seed(f,{id:'evt:auto',origin:'automation',locked:0,source:'brewers',revision:2});
  const stale=await save(f,'evt:auto',1,{title:'Typed but stale',offer_1:'Changed $1'});
  assert.equal(stale.status,409);const html=await stale.text();
  assert.match(html,/changed after you opened it/);assert.match(html,/value="Typed but stale"/);
  assert.match(section(html),/<details class="event-action event-action--edit" open/);
  assert.deepEqual([event(f,'evt:auto').title,event(f,'evt:auto').revision],['Brewers Game Special',2]);
  assert.equal((await remove(f,'evt:auto',1)).status,409);assert.equal(event(f,'evt:auto').status,'published');
});

test('admin: missing or malformed event revisions cannot silently become revision zero',async t=>{
  const f=setup(t);seed(f,{id:'evt:auto',origin:'automation',locked:0,source:'brewers'});
  for(const value of [null,'',' ','-1','0.0','1e0','9007199254740992']) {
    const data={action:'remove-event',event_id:'evt:auto',...(value===null?{}:{event_revision:value})};
    const res=await post(f,data);
    assert.equal(res.status,400);assert.match(await res.text(),/Invalid saved revision/);
  }
  assert.deepEqual([event(f,'evt:auto').status,event(f,'evt:auto').revision],['published',0]);
});

test('admin: JSON clients receive a 409 for a stale event revision without changing data',async t=>{
  const f=setup(t);seed(f,{id:'evt:auto',origin:'automation',locked:0,source:'brewers',revision:2});
  const body=new FormData();
  for(const [key,value] of Object.entries({action:'remove-event',event_id:'evt:auto',event_revision:'1'})) body.set(key,value);
  const res=await container.renderToResponse(adminPage,{request:new Request('http://localhost/admin/specials',
    {method:'POST',headers:{cookie,origin:'http://localhost',accept:'application/json'},body}),locals:{runtime:{env:f.env,now:NOW}}});
  assert.equal(res.status,409);assert.equal((await res.json()).ok,false);
  assert.deepEqual([event(f,'evt:auto').status,event(f,'evt:auto').revision],['published',2]);
});

test('admin: server-side validation rejects bad input and keeps the draft',async t=>{
  const f=setup(t);seed(f,{id:'evt:today'});
  const cases=[[{title:''},/event name/],[{title:'x'.repeat(81)},/80 characters/],[{event_date:'2026-02-30'},/valid event date/],
    [{offer_1:''},/at least one offer/],[{offer_1:'x'.repeat(151)},/150 characters/],[{start_time:'25:00'},/HH:MM/],
    [{start_time:'15:00',end_time:'11:00'},/after the start time/],[{time_text:'x'.repeat(81)},/80 characters/]];
  for (const [over,message] of cases) {
    const res=await save(f,'evt:today',0,{title:'Kept draft title',...over});
    assert.equal(res.status,400);const html=await res.text();
    assert.match(section(html),message);assert.match(section(html),/role="alert"/);
    if (over.title===undefined) assert.match(html,/value="Kept draft title"/);
  }
  assert.equal((await post(f,{action:'save-event',event_id:'evt:today',event_revision:'x',...fields()})).status,400);
  assert.equal((await save(f,'evt:missing',0)).status,400);
  assert.deepEqual([event(f,'evt:today').title,event(f,'evt:today').revision],['Brewers Game Special',0]);
});

test('admin: Remove hides the event everywhere and keeps a locked tombstone so Facebook cannot recreate it',async t=>{
  const f=setup(t);seed(f,{id:'evt:auto',origin:'automation',locked:0,source:'brewers'});
  const confirm=section(await render(adminPage,f,'/admin/specials'));
  assert.match(confirm,/<summary class="btn btn-ghost[^"]*"[^>]*>Remove<span class="visually-hidden"[^>]*> “Brewers Game Special”<\/span><\/summary>/);
  assert.match(confirm,/Remove “Brewers Game Special” from the website\? It will not come back from Facebook\./);
  const res=await remove(f,'evt:auto',0);
  assert.equal(res.status,303);assert.equal(res.headers.get('location'),'/admin/specials?event=removed#special-events');
  const e=event(f,'evt:auto');
  assert.deepEqual([e.status,e.manual_locked,e.source_post_id,e.revision],['rejected',1,'brewers',1]);
  assert.deepEqual(offers(f,'evt:auto'),['Pulled Pork Sandwich With Chips and Side of Coleslaw $7.25']);
  for (const [page,path] of [[homePage,'/'],[specialsPage,'/specials']]) assert.doesNotMatch(await render(page,f,path),/Brewers Game Special/);
  const after=await render(adminPage,f,'/admin/specials?event=removed');
  assert.match(after,/Event removed\. Facebook will not recreate it\./);assert.doesNotMatch(section(after),/<h4/);
  assert.match(section(after),/No current or upcoming special events\./);
  // A removed event cannot be edited or removed again.
  assert.equal((await save(f,'evt:auto',1)).status,409);assert.equal((await remove(f,'evt:auto',1)).status,409);
});

test('admin: accessible controls: every input is labelled; Edit and Remove name their event; mobile stacks',async t=>{
  const f=setup(t);seed(f,{id:'evt:today'});
  const html=section(await render(adminPage,f,'/admin/specials'));
  for (const [,id] of html.matchAll(/<input[^>]*\bid="([^"]+)"/g)) assert.match(html,new RegExp(`for="${id}"`),id);
  assert.match(html,/>Edit<span class="visually-hidden"[^>]*> “Brewers Game Special”<\/span>/);
  assert.match(html,/<li class="event-entry"[^>]*aria-labelledby="evt-today-name"/);
  const css=readFileSync('src/components/EventAdminEntry.astro','utf8').split('<style>')[1];
  assert.match(css,/@media\(max-width:680px\)\{[\s\S]*grid-template-columns:minmax\(0,1fr\)[\s\S]*min-height:44px/);
  assert.match(css,/overflow-wrap:anywhere/);
});
