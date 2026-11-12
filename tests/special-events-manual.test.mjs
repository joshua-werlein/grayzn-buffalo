import {builtRoute} from './built-output.mjs';
// Run the production build first: these tests exercise the compiled routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
const ev=loadTs('src/lib/special-events.ts');
const review=loadTs('src/lib/automation-review.ts');
const homePage=(await builtRoute('index')).default;
const specialsPage=(await builtRoute('specials')).default;
const adminPage=(await builtRoute('admin/specials')).default;
const automationPage=(await builtRoute('admin/automation')).default;
const container=await AstroContainer.create();
const cookie='gb_session='+'a'.repeat(32);
// Wednesday November 11 2026 (Veterans Day), 10:00 AM CST.
const NOW=new Date('2026-11-11T16:00:00Z');
const RID='11111111-2222-4333-8444-555555555555';
const VETERANS={action:'create-event',request_id:RID,title:'Veterans Day Special',event_date:'2026-11-11',hours_mode:'all-day',
  start_time:'',end_time:'',time_text:'',offer_1:'Choice of any burger and side with a drink $7.00'};
const PACKERS={action:'create-event',request_id:'22222222-2222-4333-8444-555555555555',title:'Packers Game Special',event_date:'2026-11-15',
  hours_mode:'hours',start_time:'12:00',end_time:'16:00',time_text:'',offer_1:'Game-day pulled pork sandwich $8'};

const setup=(t,options)=>{const f=fixture(t,options);f.env.SESSIONS={get:async()=>'1'};return f;};
const render=(page,f,path='/',now=NOW)=>container.renderToString(page,{request:new Request('http://localhost'+path,{headers:{cookie}}),locals:{runtime:{env:f.env,now}}});
const post=(f,fields,{origin='http://localhost',now=NOW,auth=true}={})=>{
  const body=new FormData();for(const [k,v] of Object.entries(fields)) body.set(k,String(v));
  return container.renderToResponse(adminPage,{request:new Request('http://localhost/admin/specials',{method:'POST',
    headers:{...(origin?{origin}:{}),...(auth?{cookie}:{})},body}),locals:{runtime:{env:f.env,now}}});
};
const events=f=>f.sql('SELECT * FROM special_events ORDER BY id');
const offers=(f,id)=>f.sql('SELECT content FROM special_event_offers WHERE event_id=? ORDER BY position',id).map(o=>o.content);
const section=html=>html.match(/<section id="special-events"[\s\S]*?<\/section>/)[0];
const cards=html=>(html.match(/<section class="event-specials"[\s\S]*?<\/section>/)??[''])[0];
function addImport(f,{id='imp-vets',post='583672228384067_1764187355249141',created='2026-11-11T14:03:00+0000',candidate}) {
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,permalink_url,candidate_json,processing_status,validation_result,image_r2_key,parser_version)
    VALUES(?,?,?,?,?,'staged','ok','special-imports/x.jpg',19)`,id,post,created,'https://www.facebook.com/583672228384067/posts/1764187355249141',JSON.stringify(candidate));
}
const offer=content=>({content,evidence:content,service_time:'',service_evidence:'',date_evidence:'',uncertainties:[]});
const heldPoster={day_of_week:-1,day_evidence:'',poster_evidence:'VETERANS DAY SPECIAL',delivery:{status:'none',evidence:'',date_evidence:'',uncertainties:[]},
  offers:[offer('Choice of any Burger & Side with a Drink $7.00')]};

test('staff create the Veterans Day example: all day, published, locked, and shown as Today with its price',async t=>{
  const f=setup(t);
  const res=await post(f,VETERANS);
  assert.equal(res.status,303);assert.equal(res.headers.get('location'),`/admin/specials?event=created#evt%3Astaff-${RID}`);
  const [e]=events(f);
  assert.deepEqual([e.id,e.title,e.event_date,e.start_time,e.end_time,e.status,e.origin,e.manual_locked,e.date_basis,e.identity,e.source_post_id,e.display_from],
    [`evt:staff-${RID}`,'Veterans Day Special','2026-11-11',null,null,'published','manual',1,'manual','veterans-day',null,null]);
  // Staff text gets the same house menu style automation publishes (normalizeMenuCase).
  assert.deepEqual(offers(f,e.id),['Choice of Any Burger and Side with a Drink $7.00']);
  assert.deepEqual(f.sql('SELECT action,detail FROM special_event_log'),[{action:'created',detail:'Created by staff'}]);
  for (const [page,path] of [[homePage,'/'],[specialsPage,'/specials']]) {
    const html=cards(await render(page,f,path));
    assert.match(html,/Veterans Day Special/);assert.match(html,/event-card__badge--today[^>]*>Today</);
    assert.match(html,/All day/);assert.match(html,/<span class="event-card__price"[^>]*>\$7\.00<\/span>/);
  }
  const admin=section(await render(adminPage,f,'/admin/specials?event=created'));
  assert.match(admin,/Event published\. Facebook will not change or duplicate it\./);
  assert.match(admin,/Active now · Shown on the website · Added by staff/);
});

test('staff schedule the Packers example ahead: Upcoming before its date, Later Today before noon, Today during, gone at 4 PM',async t=>{
  const f=setup(t);
  assert.equal((await post(f,PACKERS)).status,303);
  const [e]=events(f);
  assert.deepEqual([e.event_date,e.start_time,e.end_time,e.time_text],['2026-11-15','12:00','16:00','']);
  const badge=async now=>(cards(await render(specialsPage,f,'/specials',now)).match(/event-card__badge[^"]*"[^>]*>([^<]+)</)??[])[1];
  assert.equal(await badge(NOW),'Upcoming');
  assert.match(cards(await render(specialsPage,f,'/specials')),/12 PM–4 PM/);
  assert.equal(await badge(new Date('2026-11-15T17:59:00Z')),'Later Today');   // 11:59 AM CST: never active early
  assert.equal(await badge(new Date('2026-11-15T18:00:00Z')),'Today');         // 12:00 PM CST
  assert.equal(await badge(new Date('2026-11-15T21:59:00Z')),'Today');         // 3:59 PM CST
  assert.equal(await badge(new Date('2026-11-15T22:00:00Z')),undefined);       // 4:00 PM CST: expired, not deleted
  assert.equal(events(f)[0].status,'published');
});

test('event state: before its start an event is later, never active; all-day events are active all day (Chicago, DST-safe)',()=>{
  assert.equal(ev.eventState({event_date:'2026-11-15',start_time:'12:00',end_time:'16:00'},new Date('2026-11-15T17:59:00Z')),'later');
  assert.equal(ev.eventState({event_date:'2026-11-15',start_time:'12:00',end_time:'16:00'},new Date('2026-11-15T18:00:00Z')),'active');
  assert.equal(ev.eventState({event_date:'2026-11-11',start_time:null,end_time:null},new Date('2026-11-11T06:00:00Z')),'active');  // 12:00 AM CST
  // March 14 2027 (spring forward): 12:00 CDT is 17:00Z.
  assert.equal(ev.eventState({event_date:'2027-03-14',start_time:'12:00',end_time:'16:00'},new Date('2027-03-14T16:59:00Z')),'later');
  assert.equal(ev.eventState({event_date:'2027-03-14',start_time:'12:00',end_time:'16:00'},new Date('2027-03-14T17:00:00Z')),'active');
});

test('a repeated submit of the same form is idempotent: one event, one set of offers, one log entry',async t=>{
  const f=setup(t);
  for (let i=0;i<3;i++) assert.equal((await post(f,VETERANS)).status,303);
  assert.equal(events(f).length,1);assert.equal(offers(f,`evt:staff-${RID}`).length,1);
  assert.equal(f.sql('SELECT count(*) n FROM special_event_log')[0].n,1);
});

test('duplicates: the same holiday, or the same offers, on the same date is refused with the typed draft kept',async t=>{
  const f=setup(t);
  await post(f,VETERANS);
  for (const over of [{title:"Veteran's Day Burger Deal",offer_1:'Different $8'},{title:'Burger Wednesday',offer_1:'Choice of any burger and side with a drink $7.00'}]) {
    const res=await post(f,{...VETERANS,request_id:'33333333-2222-4333-8444-555555555555',...over});
    assert.equal(res.status,409);const html=section(await res.text());
    assert.match(html,/“Veterans Day Special” is already published for Wednesday, November 11/);
    assert.match(html,/<details class="event-create" open/);assert.ok(html.includes(`value="${over.title}"`),over.title);
  }
  // A different date or event is fine.
  assert.equal((await post(f,{...VETERANS,request_id:'44444444-2222-4333-8444-555555555555',title:'Thanksgiving Special',event_date:'2026-11-26'})).status,303);
  assert.equal(events(f).length,2);
});

test('server-side validation: hours, overnight, display date, past date and request id; nothing is written',async t=>{
  const f=setup(t);
  const cases=[[{hours_mode:'hours',start_time:'12:00',end_time:''},/both a start time and an end time/],
    [{hours_mode:'hours',start_time:'21:00',end_time:'01:00'},/after the start time on the same day.*second event/],
    [{hours_mode:'sometimes'},/All Day or Specific Hours/],
    [{display_from:'2026-11-12'},/on or before the event date/],[{display_from:'2026-13-01'},/valid website display date/],
    [{event_date:'2026-11-10'},/today or a future date/],[{request_id:'nope'},/Reload this page/],
    [{title:''},/event name/],[{offer_1:''},/at least one offer/],[{offer_1:'x'.repeat(151)},/150 characters/]];
  for (const [over,message] of cases) {
    const res=await post(f,{...VETERANS,...over});
    assert.equal(res.status,400,String(message));
    const html=section(await res.text());assert.match(html,message);assert.match(html,/role="alert"/);
  }
  // All Day ignores times left in the hidden inputs.
  assert.equal((await post(f,{...VETERANS,start_time:'21:00',end_time:'01:00'})).status,303);
  assert.deepEqual([events(f)[0].start_time,events(f)[0].end_time],[null,null]);
  assert.equal(events(f).length,1);
});

test('authentication and origin protect creation',async t=>{
  const f=fixture(t);f.env.SESSIONS={get:async()=>null};
  const res=await post(f,VETERANS);assert.equal(res.status,302);assert.equal(res.headers.get('location'),'/admin');
  const g=setup(t);
  for (const origin of ['https://evil.example',null]) {
    const denied=await post(g,VETERANS,{origin});assert.equal(denied.status,400);assert.match(await denied.text(),/Invalid request origin/);
  }
  assert.equal(events(f).length+events(g).length,0);
});

test('website display date: hidden publicly until then, listed for staff, offer dates unchanged; editable later',async t=>{
  const f=setup(t);
  await post(f,{...VETERANS,event_date:'2026-11-26',title:'Thanksgiving Special',display_from:'2026-11-20'});
  const [e]=events(f);assert.equal(e.display_from,'2026-11-20');
  assert.doesNotMatch(cards(await render(specialsPage,f,'/specials')),/Thanksgiving Special/);
  assert.match(cards(await render(specialsPage,f,'/specials',new Date('2026-11-20T06:00:00Z'))),/Thanksgiving Special[\s\S]*Upcoming|Upcoming[\s\S]*Thanksgiving Special/);
  const admin=section(await render(adminPage,f,'/admin/specials'));
  assert.match(admin,/Shown on the website from Friday, November 20/);assert.match(admin,/name="display_from"/);
  const res=await post(f,{action:'save-event',event_id:e.id,event_revision:0,title:'Thanksgiving Special',event_date:'2026-11-26',hours_mode:'all-day',display_from:'',offer_1:'Turkey Dinner $12'});
  assert.equal(res.status,303);
  assert.deepEqual([events(f)[0].display_from,events(f)[0].revision,events(f)[0].manual_locked],[null,1,1]);
  assert.match(cards(await render(specialsPage,f,'/specials')),/Thanksgiving Special/);
});

test('before migration 0028 staff can still create and edit; only the display date control is unavailable',async t=>{
  const f=setup(t,{beforeEventDisplayMigration:true});
  assert.equal((await post(f,VETERANS)).status,303);
  assert.equal(events(f)[0].display_from,undefined);
  const html=section(await render(adminPage,f,'/admin/specials'));
  assert.doesNotMatch(html,/name="display_from"/);assert.match(html,/Veterans Day Special/);
  assert.equal((await post(f,{...VETERANS,action:'save-event',event_id:`evt:staff-${RID}`,event_revision:0,title:'Veterans Day Burger Special'})).status,303);
  assert.equal(events(f)[0].title,'Veterans Day Burger Special');
});

test('edit and remove a staff event: revision-fenced, and a removed staff event never blocks other dates',async t=>{
  const f=setup(t);
  await post(f,PACKERS);const id='evt:staff-22222222-2222-4333-8444-555555555555';
  const stale=await post(f,{...PACKERS,action:'save-event',event_id:id,event_revision:5,title:'Stale'});
  assert.equal(stale.status,409);assert.equal(events(f)[0].title,'Packers Game Special');
  assert.equal((await post(f,{...PACKERS,action:'save-event',event_id:id,event_revision:0,hours_mode:'all-day'})).status,303);
  assert.deepEqual([events(f)[0].start_time,events(f)[0].end_time,events(f)[0].revision],[null,null,1]);
  assert.equal((await post(f,{action:'remove-event',event_id:id,event_revision:1})).status,303);
  assert.equal(events(f)[0].status,'rejected');
  assert.doesNotMatch(cards(await render(specialsPage,f,'/specials')),/Packers/);
});

test('Automation Review: a held Veterans Day post offers "Publish as a Special Event" prefilled, with no daily slot',async t=>{
  const f=setup(t);addImport(f,{candidate:heldPoster});
  const draft=review.eventDraftFor({candidate_json:JSON.stringify(heldPoster),caption:''},'2026-11-11');
  assert.deepEqual(draft,{kind:'event',values:{title:'Veterans Day Special',event_date:'2026-11-11',hours:'all-day',start_time:null,end_time:null,time_text:'',display_from:null,
    offers:['Choice of Any Burger & Side with a Drink $7.00'],details:''}});
  const html=await container.renderToString(automationPage,{request:new Request('http://localhost/admin/automation',{headers:{cookie}}),locals:{runtime:{env:f.env,now:NOW}}});
  const start=html.indexOf('id="import-imp-vets"'),entry=html.slice(start,html.indexOf('class="card-foot"',start));
  assert.match(entry,/<h4 id="event-imp-vets-route"[^>]*>Publish as a Special Event<span class="tag tag--ok"[^>]*>Recommended<\/span><\/h4>/);
  assert.match(entry,/<summary class="btn btn-primary"[^>]*>Review Special Event<\/summary>/);
  assert.match(entry,/name="action" value="create-event"/);assert.match(entry,/name="source_import_id" value="imp-vets"/);
  assert.match(entry,/name="return_to" value="automation"/);assert.match(entry,/value="Veterans Day Special"/);
  assert.match(entry,/value="Choice of Any Burger &amp; Side with a Drink \$7\.00"/);
  assert.match(entry,/name="hours_mode" value="all-day" checked/);
  // The event form needs no Lunch, All Day, Nightly or Soup destination.
  const form=entry.slice(entry.indexOf('Review Special Event'));
  assert.doesNotMatch(form.slice(0,form.indexOf('</form>')),/name="destination|Lunch · |All Day Specials · |Nightly · |Soup · /);
});

test('publishing the held post links the event to it, returns to Automation Review, and marks the post Published',async t=>{
  const f=setup(t);addImport(f,{candidate:heldPoster});
  const res=await post(f,{...VETERANS,source_import_id:'imp-vets',return_to:'automation'});
  assert.equal(res.status,303);assert.equal(res.headers.get('location'),'/admin/automation?event=published#import-imp-vets');
  const [e]=events(f);
  assert.deepEqual([e.source_post_id,e.source_import_id,e.manual_locked,e.origin,e.status],['583672228384067_1764187355249141','imp-vets',1,'manual','published']);
  assert.match(e.source_permalink,/facebook\.com/);
  const model=await review.readAutomationReview(f.env,'2026-11-11',NOW);
  const item=model.history.find(i=>i.id==='imp-vets');
  assert.equal(item.status,'Published');assert.match(item.reason,/Published as a special event: Veterans Day Special/);
  assert.equal(item.eventOption,null);
  // The same post cannot be published twice.
  const again=await post(f,{...VETERANS,request_id:'55555555-2222-4333-8444-555555555555',title:'Other Name',offer_1:'Other $1',source_import_id:'imp-vets'});
  assert.equal(again.status,409);assert.equal(events(f).length,1);
});

test('publishing takes over an event automation withheld for the same post (no second row, staff-locked)',async t=>{
  const f=setup(t);addImport(f,{candidate:heldPoster});
  f.sql(`INSERT INTO special_events(id,title,event_date,status,origin,manual_locked,date_basis,identity,source_post_id,source_import_id,review_reason,last_auto_json)
    VALUES('evt:auto-held','Veterans Day Special','2026-11-11','review','automation',0,'publication-date','veterans-day','583672228384067_1764187355249141','imp-vets','Withheld: Printed hours disagree','{}')`);
  const before=await review.readAutomationReview(f.env,'2026-11-11',NOW);
  const held=before.history.find(i=>i.id==='imp-vets');
  assert.equal(held.status,'Held');assert.match(held.reason,/Special event held: Printed hours disagree/);assert.equal(held.eventOption.kind,'event');
  assert.equal((await post(f,{...VETERANS,source_import_id:'imp-vets'})).status,303);
  assert.deepEqual(events(f).map(e=>[e.id,e.status,e.manual_locked,e.revision,e.date_basis]),[['evt:auto-held','published',1,1,'manual']]);
  assert.deepEqual(offers(f,'evt:auto-held'),['Choice of Any Burger and Side with a Drink $7.00']);
});

test('only today’s current posts can be linked; stale or foreign ids are refused',async t=>{
  const f=setup(t);addImport(f,{id:'imp-old',post:'p_old',created:'2026-11-10T14:00:00+0000',candidate:heldPoster});
  for (const id of ['imp-old','missing','bad id!']) {
    const res=await post(f,{...VETERANS,source_import_id:id});
    assert.equal(res.status,400);assert.match(await res.text(),/(today’s current Facebook posts|not available)/);
  }
  assert.equal(events(f).length,0);
});

test('mobile: the event form stacks to one column with 44px controls and no horizontal overflow',()=>{
  const fields=readFileSync('src/components/EventFields.astro','utf8').split('<style>').at(-1);
  assert.match(fields,/@media\(max-width:680px\)\{[\s\S]*\.event-fields__row\{grid-template-columns:1fr\}/);
  assert.match(fields,/min-width:0/);
  const create=readFileSync('src/components/EventCreateForm.astro','utf8').split('<style>')[1];
  assert.match(create,/min-height:44px/);assert.match(create,/@media\(max-width:680px\)/);
});

test('accessible controls: every new input is labelled and the hours choice is a labelled radio group',async t=>{
  const f=setup(t);
  const html=section(await render(adminPage,f,'/admin/specials'));
  for (const [,id] of html.matchAll(/<input[^>]*\bid="([^"]+)"/g)) assert.match(html,new RegExp(`for="${id}"`),id);
  assert.match(html,/<legend[^>]*>When the offer is valid<\/legend>/);
  assert.match(html,/<summary class="btn btn-primary"[^>]*>Add Special Event<\/summary>/);
});
