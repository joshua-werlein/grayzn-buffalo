import {builtRoute} from './built-output.mjs';
// Run the production build first: these tests exercise the compiled routes.
// Special Event entry, Event Message, text normalization, the two Automation
// Review workflows and the public event layout (November 11 2026 follow-up).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
const store=loadTs('src/lib/specials-store.ts');
const review=loadTs('src/lib/automation-review.ts');
const specialsPage=(await builtRoute('specials')).default;
const homePage=(await builtRoute('index')).default;
const adminPage=(await builtRoute('admin/specials')).default;
const automationPage=(await builtRoute('admin/automation')).default;
const container=await AstroContainer.create();
const cookie='gb_session='+'a'.repeat(32);
const NOW=new Date('2026-11-11T16:00:00Z');   // Wednesday November 11 2026, 10:00 AM CST
const RID='11111111-2222-4333-8444-555555555555';
// The values staff actually published on November 11, typed as the poster printed them.
const CAPS={action:'create-event',request_id:RID,title:'VETERANS DAY SPECIAL',event_date:'2026-11-11',hours_mode:'all-day',
  start_time:'',end_time:'',time_text:'',offer_1:'CHOICE OF ANY BURGER AND SIDE WITH A DRINK $7'};
const OFFER='Choice of Any Burger and Side with a Drink $7',MESSAGE='Thank You To All Who Served';

const setup=(t,options)=>{const f=fixture(t,options);f.env.SESSIONS={get:async()=>'1'};return f;};
const render=(page,f,path='/',now=NOW)=>container.renderToString(page,{request:new Request('http://localhost'+path,{headers:{cookie}}),locals:{runtime:{env:f.env,now}}});
const post=(f,fields,{now=NOW}={})=>{
  const body=new FormData();for(const [k,v] of Object.entries(fields)) body.set(k,String(v));
  return container.renderToResponse(adminPage,{request:new Request('http://localhost/admin/specials',{method:'POST',headers:{origin:'http://localhost',cookie},body}),locals:{runtime:{env:f.env,now}}});
};
const events=f=>f.sql('SELECT * FROM special_events ORDER BY id');
const offers=(f,id)=>f.sql('SELECT content FROM special_event_offers WHERE event_id=? ORDER BY position',id).map(o=>o.content);
const section=html=>html.match(/<section id="special-events"[\s\S]*?<\/section>/)[0];
const cards=html=>(html.match(/<section class="event-specials"[\s\S]*?<\/section>/)??[''])[0];
const createForm=html=>{const s=section(html);return s.slice(s.indexOf('class="event-create"'),s.indexOf('</form>',s.indexOf('class="event-create"')));};
const offerRows=form=>[...form.matchAll(/<div class="event-fields__offer"[^>]*?(hidden)?[^>]*>/g)].map(m=>/\bhidden\b/.test(m[0])?'hidden':'shown');

// Wednesday's three regular specials on the board, as production published them.
const WEDNESDAY=['Mushroom and Swiss with Beer Fries and a Drink $9.75','Grilled Chicken Bacon Ranch Sandwich with Side Salad, Chili or Coleslaw $10.25','Grilled Ham and Cheese with Cup of Chili or Coleslaw $7.25'];
async function wednesdayBoard(f) {
  const draft=store.newWeekFromDefaults(await store.readCollection(f.env,'defaults'));
  const wed=draft.groups.filter(g=>g.day_of_week===3);
  wed.find(g=>g.service==='lunch').slots[0].content=WEDNESDAY[2];
  const allDay=wed.find(g=>g.service==='all-day');allDay.slots[0].content=WEDNESDAY[0];allDay.slots[1].content=WEDNESDAY[1];
  await store.saveCollection(f.env,draft,{start:'2026-11-09',end:'2026-11-15'});
}
const offer=(content,extra={})=>({content,evidence:content,service_time:'',service_evidence:'',date_evidence:'',uncertainties:[],...extra});
const daily=(heading,list)=>({day_of_week:-1,day_evidence:'',poster_evidence:heading,delivery:{status:'none',evidence:'',date_evidence:'',uncertainties:[]},offers:list});
function addImport(f,{id,post,created,candidate,audit}) {
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,permalink_url,candidate_json,processing_status,validation_result,image_r2_key,parser_version)
    VALUES(?,?,?,?,?,'staged','ok','special-imports/x.jpg',19)`,id,post,created,`https://www.facebook.com/${post.replace('_','/posts/')}`,JSON.stringify(candidate));
  if(audit) f.sql("INSERT INTO special_import_events(import_id,event_type,detail) VALUES(?,'review',?)",id,audit);
}
// Both November 11 posts were audited together: three slots published, one proposal blocked.
const JOINT_AUDIT='GUARDED_AUTO: 2026-11-11; reconciled 2 source(s); 3 slot(s); CONFLICT: 1 blocked proposal(s), review required';
const wednesdayPost=f=>addImport(f,{id:'imp-wed',post:'583672228384067_1764217808579429',created:'2026-11-11T14:35:00+0000',
  candidate:daily('DAILY SPECIALS',[offer(WEDNESDAY[0]),offer(WEDNESDAY[1]),offer(WEDNESDAY[2])]),audit:JOINT_AUDIT});
const automationEntry=(html,id)=>{const start=html.indexOf(`id="import-${id}"`);return html.slice(start,html.indexOf('class="card-foot"',start));};

test('entry: one Special and Price field, Add Another Special, and an optional Event Message',async t=>{
  const f=setup(t);
  const form=createForm(await render(adminPage,f,'/admin/specials'));
  assert.deepEqual(offerRows(form),['shown','hidden','hidden','hidden']);
  assert.match(form,/<label for="new-event-offer-1"[^>]*>Special and Price<\/label>/);
  assert.match(form,/<label for="new-event-offer-2"[^>]*>Special and Price 2<\/label>/);
  assert.match(form,/name="offer_1"[^>]*required|required[^>]*name="offer_1"/);
  assert.doesNotMatch(form,/name="offer_2"[^>]*required/);
  assert.match(form,/<button type="button" class="btn btn-ghost event-fields__add"[^>]*data-add-offer[^>]*hidden[^>]*>\+ Add Another Special<\/button>/);
  assert.equal((form.match(/data-remove-offer/g)||[]).length,3);   // Fields 2–4; the first is required.
  // Without JavaScript every field is shown and the add/remove buttons stay hidden.
  assert.match(form,/<noscript><style>\.event-fields \[data-offer-row\]\[hidden\]\{display:grid !important\}<\/style><\/noscript>/);
  assert.match(form,/<label for="new-event-details"[^>]*>Event Message <span/);
  assert.match(form,/<textarea id="new-event-details"[^>]*name="details"[^>]*maxlength="300"/);
  for (const control of ['name="title"','name="event_date"','name="hours_mode" value="all-day"','name="hours_mode" value="hours"','name="display_from"']) assert.ok(form.includes(control),control);
});

test('one special, no extra fields: the November 11 example saves one offer, the message, and normalized text',async t=>{
  const f=setup(t);
  const res=await post(f,{...CAPS,details:'THANK YOU TO ALL WHO SERVED'});
  assert.equal(res.status,303);
  const [e]=events(f);
  assert.deepEqual([e.title,e.details,e.status,e.origin,e.manual_locked],['Veterans Day Special',MESSAGE,'published','manual',1]);
  assert.deepEqual(offers(f,e.id),[OFFER]);
  for (const [page,path] of [[homePage,'/'],[specialsPage,'/specials']]) {
    const html=cards(await render(page,f,path));
    assert.match(html,/<span class="event-card__offer"[^>]*>Choice of Any Burger and Side with a Drink<\/span><span class="event-card__price"[^>]*>\$7<\/span>/);
    // The message is a separate, secondary line, never an offer row.
    assert.match(html,new RegExp(`<p class="event-card__details"[^>]*>${MESSAGE}</p>`));
    assert.equal((html.match(/class="event-card__offer"/g)||[]).length,1);
  }
  const admin=section(await render(adminPage,f,'/admin/specials'));
  assert.match(admin,new RegExp(`<p class="event-entry__details"[^>]*>${MESSAGE}</p>`));
  assert.match(admin,new RegExp(`<textarea id="evt-staff-${RID}-details"[^>]*>${MESSAGE}</textarea>`));
});

test('a greeting typed as a special is refused with a pointer to Event Message; nothing is written',async t=>{
  const f=setup(t);
  const res=await post(f,{...CAPS,offer_2:'THANK YOU TO ALL WHO SERVED'});
  assert.equal(res.status,400);
  const html=section(await res.text());
  assert.match(html,/“Thank You To All Who Served” is a message, not a special\. Move it to Event Message\./);
  // The typed draft comes back with both fields shown.
  assert.deepEqual(offerRows(createForm(html)),['shown','shown','hidden','hidden']);
  assert.equal(events(f).length,0);
  for (const [over,message] of [[{offer_2:'Pulled pork sandwich'},/Add the price to “Pulled Pork Sandwich”/],
    [{details:'Burgers just $7 today'},/Prices belong in Special and Price/],[{details:'x'.repeat(301)},/event message allows 300 characters/],
    [{offer_2:'choice of any burger and side with a drink $7'},/same special is entered twice/]]) {
    const r=await post(f,{...CAPS,...over});
    assert.equal(r.status,400,String(message));assert.match(section(await r.text()),message);
  }
  // Price words are prices: free, half off, BOGO, percent off.
  for (const [i,special] of ['Free pie with any burger','Half off appetizers','BOGO tacos','20% off pitchers'].entries())
    assert.equal((await post(f,{...CAPS,request_id:`${i}1111111-2222-4333-8444-555555555555`,title:`Promo ${i}`,event_date:`2026-11-1${2+i}`,offer_1:special})).status,303,special);
  assert.equal(events(f).length,4);
});

test('adding and removing specials: blanks are dropped, order kept, and saved events reopen with only their fields',async t=>{
  const f=setup(t);
  // Field 2 was added, then removed (cleared); fields 1 and 3 remain.
  assert.equal((await post(f,{...CAPS,offer_2:'',offer_3:'Kids burger $4'})).status,303);
  const [e]=events(f);
  assert.deepEqual(offers(f,e.id),[OFFER,'Kids Burger $4']);
  const edit=section(await render(adminPage,f,'/admin/specials'));
  const editForm=edit.slice(edit.indexOf('name="action" value="save-event"'));
  assert.deepEqual(offerRows(editForm.slice(0,editForm.indexOf('</form>'))),['shown','shown','hidden','hidden']);
  // Four is the limit; a fifth field is never read.
  const four={offer_1:'Burger $7',offer_2:'Brat $5',offer_3:'Wings $9',offer_4:'Fries $3',offer_5:'Extra $1'};
  assert.equal((await post(f,{...CAPS,request_id:'99999999-2222-4333-8444-555555555555',title:'Packers Game Special',event_date:'2026-11-15',...four})).status,303);
  assert.deepEqual(offers(f,'evt:staff-99999999-2222-4333-8444-555555555555'),['Burger $7','Brat $5','Wings $9','Fries $3']);
});

test('normalization is idempotent: editing and re-saving gives the same text; acronyms, brands and prices are kept',async t=>{
  const f=setup(t);
  await post(f,{...CAPS,offer_1:'BBQ PULLED PORK & MILLER LITE $7.50',details:'THANK YOU TO ALL WHO SERVED',time_text:'KICKOFF 12 PM'});
  const id=`evt:staff-${RID}`,first=events(f)[0];
  assert.deepEqual([first.time_text,offers(f,id)],['Kickoff 12 PM',['BBQ Pulled Pork & Miller Lite $7.50']]);
  // Re-save exactly what the form shows.
  const save=values=>post(f,{action:'save-event',event_id:id,title:values.title,event_date:values.event_date,hours_mode:'all-day',time_text:values.time_text,
    offer_1:offers(f,id)[0],details:values.details,event_revision:values.revision});
  assert.equal((await save(first)).status,303);
  const second=events(f)[0];
  assert.deepEqual([second.title,second.details,second.time_text,offers(f,id)],[first.title,first.details,first.time_text,['BBQ Pulled Pork & Miller Lite $7.50']]);
  assert.deepEqual([second.revision,second.manual_locked],[1,1]);
  // An edit in capitals is normalized the same way.
  assert.equal((await post(f,{action:'save-event',event_id:id,event_revision:1,title:'VETERANS DAY SPECIAL',event_date:'2026-11-11',hours_mode:'all-day',
    offer_1:'CHOICE OF ANY BURGER AND SIDE WITH A DRINK $7',details:''})).status,303);
  assert.deepEqual([events(f)[0].details,offers(f,id)],['',[OFFER]]);
});

test('Automation Review: the ordinary Wednesday poster takes only the daily workflow (no event option)',async t=>{
  const f=setup(t);await wednesdayBoard(f);wednesdayPost(f);
  const item=(await review.readAutomationReview(f.env,'2026-11-11',NOW)).history.find(i=>i.id==='imp-wed');
  assert.equal(item.status,'Partially Published');   // The joint audit still flags it for review.
  assert.ok(item.values.every(v=>v.onWebsite));
  assert.equal(item.eventOption,null);
  const entry=automationEntry(await render(automationPage,f,'/admin/automation'),'imp-wed');
  assert.doesNotMatch(entry,/Special Event|create-event/);
  // Linking it anyway is refused server-side: its specials are already on today's board.
  const res=await post(f,{...CAPS,source_import_id:'imp-wed',return_to:'automation'});
  assert.equal(res.status,409);assert.match(await res.text(),/already on today’s daily specials/);
  assert.equal(events(f).length,0);
});

test('Automation Review: a genuine holiday poster leads with the event workflow; daily specials come second',async t=>{
  const f=setup(t);await wednesdayBoard(f);wednesdayPost(f);
  // Withheld by automation (here: two printed windows disagree), so it needs staff.
  addImport(f,{id:'imp-vets',post:'583672228384067_1764187355249141',created:'2026-11-11T14:03:00+0000',
    candidate:daily('VETERANS DAY SPECIAL',[offer('CHOICE OF ANY BURGER AND SIDE WITH A DRINK $7'),offer('THANK YOU TO ALL WHO SERVED')])});
  f.sql(`UPDATE special_imports SET caption='Veterans Day special 11am-2pm, dine in 5-9pm' WHERE id='imp-vets'`);
  const option=review.eventDraftFor(f.sql("SELECT * FROM special_imports WHERE id='imp-vets'")[0],'2026-11-11');
  assert.equal(option.kind,'event');
  assert.deepEqual([option.values.title,option.values.offers,option.values.details],['Veterans Day Special',[OFFER],MESSAGE]);
  const entry=automationEntry(await render(automationPage,f,'/admin/automation'),'imp-vets');
  const eventAt=entry.indexOf('>Publish as a Special Event<span class="tag tag--ok"'),dailyAt=entry.indexOf('>Publish as Daily Specials</h4>');
  assert.ok(eventAt>0 && dailyAt>eventAt,'event route first');
  assert.match(entry,/<summary class="btn btn-primary"[^>]*>Review Special Event<\/summary>/);
  assert.match(entry,new RegExp(`<textarea id="event-imp-vets-details"[^>]*>${MESSAGE}</textarea>`));
  assert.match(entry,/Only if this is not a one-time event/);
});

test('manual override: a misclassified held poster offers a collapsed Special Event fallback and publishes once',async t=>{
  const f=setup(t);await wednesdayBoard(f);wednesdayPost(f);
  // Before the Veterans Day fix this heading was not recognized: a regular, held post.
  addImport(f,{id:'imp-vets',post:'583672228384067_1764187355249141',created:'2026-11-11T14:03:00+0000',
    candidate:daily('VETERANS SPECIAL',[offer('CHOICE OF ANY BURGER AND SIDE WITH A DRINK $7'),offer('THANK YOU TO ALL WHO SERVED')]),audit:JOINT_AUDIT});
  const item=(await review.readAutomationReview(f.env,'2026-11-11',NOW)).history.find(i=>i.id==='imp-vets');
  assert.equal(item.eventOption.kind,'override');
  assert.deepEqual([item.eventOption.values.title,item.eventOption.values.offers,item.eventOption.values.details],['',[OFFER],MESSAGE]);
  const entry=automationEntry(await render(automationPage,f,'/admin/automation'),'imp-vets');
  assert.ok(entry.indexOf('>Publish as Daily Specials</h4>')<entry.indexOf('>Publish as a Special Event</h4>'),'daily route first');
  assert.match(entry,/<summary class="btn btn-ghost"[^>]*>Publish as a Special Event instead<\/summary>/);
  assert.match(entry,/Nothing from this post is on the website yet/);
  const fields={...CAPS,title:'Veterans Day Special',details:MESSAGE,source_import_id:'imp-vets',return_to:'automation'};
  for (let i=0;i<2;i++) assert.equal((await post(f,fields)).status,303);   // Repeated submit: idempotent.
  assert.equal((await post(f,{...fields,request_id:'77777777-2222-4333-8444-555555555555'})).status,409);
  assert.deepEqual(events(f).map(e=>[e.source_import_id,e.manual_locked,e.details]),[['imp-vets',1,MESSAGE]]);
  // Wednesday's specials are untouched and the post now reads as published.
  assert.deepEqual(f.sql(`SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id JOIN special_collections c ON c.id=g.collection_id
    JOIN weekly_specials w ON w.id=c.weekly_special_id WHERE c.kind='week' AND w.week_start_date='2026-11-09' AND g.day_of_week=3 AND g.service IN ('lunch','all-day') AND s.content<>'' ORDER BY g.service DESC,s.position`).map(s=>s.content),[WEDNESDAY[2],WEDNESDAY[0],WEDNESDAY[1]]);
  const after=(await review.readAutomationReview(f.env,'2026-11-11',NOW)).history.find(i=>i.id==='imp-vets');
  assert.deepEqual([after.status,after.eventOption],['Published',null]);
});

test('public layout: events opt out of the global section padding and keep the specials width; the message is secondary',()=>{
  const css=readFileSync('src/components/EventSpecials.astro','utf8').split('<style>')[1];
  const block=css.match(/\.event-specials\{[\s\S]*?\}/)[0];
  assert.match(block,/padding:0/);assert.doesNotMatch(block,/max-width|margin:[^;]*auto/);
  assert.match(readFileSync('src/layouts/Base.astro','utf8'),/section\{padding:var\(--section-block\) var\(--section-inline\)\}/);
  assert.match(css,/\.event-card__details\{[^}]*italic[^}]*white-space:pre-line/);
  assert.match(css,/@media \(max-width:599px\)/);
});
