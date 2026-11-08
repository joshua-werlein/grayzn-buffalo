import {builtRoute} from './built-output.mjs';
// Run the production build first: these tests exercise the compiled routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
import {ensureAutomaticWeek} from '../workers/fb-feed/auto-week.js';
import {presentSpecial,sectionIdFor,sectionLinkFor,SECTION_LINKS,wingPriceEligible} from '../src/lib/section-links.js';
import {mexicanNightDetailVisible} from '../src/lib/mexican-night-visibility.js';
const store=loadTs('src/lib/specials-store.ts');
const page=async name=>(await builtRoute(name)).default;
const home=await page('index'),specials=await page('specials'),automation=await page('admin/automation');
const {POST:approve}=await builtRoute('admin/automation/wing');
const container=await AstroContainer.create();
const cookie='gb_session='+'a'.repeat(32);
const nightly=day=>({day_of_week:day,service:'nightly'});

test('both identifiers map to the exact customer labels and their anchors',()=>{
  assert.deepEqual(Object.keys(SECTION_LINKS),['mexican-night','wing-wednesday']);
  assert.equal(SECTION_LINKS['mexican-night'].label,'Mexican Night →');
  assert.equal(SECTION_LINKS['wing-wednesday'].label,'Wing Wednesday →');
  assert.equal(SECTION_LINKS['mexican-night'].href,'/specials#mexican-night');
  assert.equal(SECTION_LINKS['wing-wednesday'].href,'/specials#wing-wednesday');
});
test('a link needs its section home or an explicit stored identifier, never the words alone',()=>{
  assert.equal(sectionIdFor(nightly(3),{content:'Wing Night!'}),'wing-wednesday');
  assert.equal(sectionIdFor(nightly(3),{content:'Wing Wednesday!'}),'wing-wednesday');
  assert.equal(sectionIdFor(nightly(2),{content:'Mexican Night!'}),'mexican-night');
  assert.equal(sectionIdFor(nightly(5),{content:'Wing Night!'}),null,'wrong night');
  assert.equal(sectionIdFor({day_of_week:3,service:'all-day'},{content:'Wing Night!'}),null,'wrong service');
  assert.equal(sectionIdFor(nightly(3),{content:'Pizza Night'}),null,'another promotion');
  assert.equal(sectionIdFor(nightly(3),{content:'Bone-In Ribeye $20'}),null,'bone-in, but not wings');
  assert.equal(sectionIdFor(nightly(3),{content:'Boneless Pork Chop $12'}),null,'boneless, but not wings');
  assert.equal(sectionIdFor(nightly(3),{content:'Bone In Wings $1'}),'wing-wednesday');
  assert.equal(sectionIdFor({day_of_week:5,service:'lunch'},{content:'Tacos',section_link:'mexican-night'}),'mexican-night','stored identifier');
  assert.equal(sectionIdFor(nightly(3),{content:'Pizza',section_link:'unknown'}),null);
});
test('a hidden section never gets a link',()=>{
  assert.equal(sectionLinkFor(nightly(3),{content:'Wing Night!'},[]),null);
  assert.equal(sectionLinkFor(nightly(3),{content:'Wing Night!'},['mexican-night']),null);
  assert.equal(sectionLinkFor(nightly(3),{content:'Wing Night!'},['wing-wednesday']).label,'Wing Wednesday →');
});

// Week of Jan 14, 2030; Chicago is UTC-6. Prepared Sunday Jan 13 at 7 PM.
const PREPARED='2030-01-14T01:00:00Z';
async function setup(t) {
  const f=fixture(t);f.env.SESSIONS={get:async()=>'1'};f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  t.mock.timers.enable({apis:['Date'],now:Date.parse(PREPARED)});
  // A Mexican menu so that section has something to show.
  const mexican=await store.readCollection(f.env,'mexican-night-defaults');
  const group=store.blankGroup(-1,0);group.label='Favorites';group.slots[0].content='Burrito';
  mexican.groups=[group];await store.saveCollection(f.env,mexican);
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  const set=(day,text)=>f.sql("UPDATE special_slots SET content=? WHERE position=1 AND group_id IN (SELECT g.id FROM special_groups g JOIN special_collections c ON c.id=g.collection_id WHERE c.kind='week' AND g.day_of_week=? AND g.service='nightly')",text,day);
  set(2,'Mexican Night! Ask to see our Menu!');
  set(3,'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each');
  return f;
}
const render=(component,f,at,path)=>{
  return container.renderToString(component,{request:new Request('http://localhost'+path,{headers:{cookie}}),locals:{runtime:{env:f.env,now:new Date(at)}}});
};
async function links(t,f,at,component,path) {
  t.mock.timers.setTime(Date.parse(at));
  const html=await render(component,f,at,path);
  return {html,mexican:/data-section-link="mexican-night"/.test(html),wing:/data-section-link="wing-wednesday"/.test(html),
    mexicanSection:/placard--mexican/.test(html),wingSection:/placard--wing/.test(html),
    mexicanCard:/href="#mexican-night"/.test(html),wingCard:/href="#wing-wednesday"/.test(html)};
}
test('the same decision controls each section, its daily link and its recurring card, up to the exact cutoff',async t=>{
  const f=await setup(t);
  for(const [at,mexican,wing,label] of [
    ['2030-01-15T18:00:00Z',true,true,'Tuesday noon'],
    ['2030-01-16T07:59:00Z',true,true,'Wednesday 1:59 AM'],
    ['2030-01-16T08:00:00Z',false,true,'Wednesday 2:00 AM'],
    ['2030-01-17T07:59:00Z',false,true,'Thursday 1:59 AM'],
    ['2030-01-17T08:00:00Z',false,false,'Thursday 2:00 AM'],
    ['2030-01-18T18:00:00Z',false,false,'Friday noon'],
  ]) {
    const page=await links(t,f,at,specials,'/specials');
    assert.equal(page.mexicanSection,mexican,`${label}: Mexican section`);assert.equal(page.mexicanCard,mexican,`${label}: Mexican card`);
    assert.equal(page.wingSection,wing,`${label}: Wing section`);assert.equal(page.wingCard,wing,`${label}: Wing card`);
    const board=await links(t,f,at,home,'/');
    // A day has left the board once its date passes; a link can only be there while visible.
    if(!mexican) assert.equal(board.mexican,false,`${label}: homepage Mexican link`);
    if(!wing) assert.equal(board.wing,false,`${label}: homepage Wing link`);
  }
});
// Slots as Facebook publishes them, so their prices count as verified.
const verifySlot=(f,day,text)=>f.sql("UPDATE special_slots SET content=?1,origin='automation',manual_locked=0,last_auto_value=?1 WHERE position=1 AND group_id IN (SELECT g.id FROM special_groups g JOIN special_collections c ON c.id=g.collection_id WHERE c.kind='week' AND g.day_of_week=?2 AND g.service='nightly')",text,day);
const linkCount=(html,id)=>(html.match(new RegExp(`data-section-link="${id}"`,'g')) ?? []).length;
for(const [component,path,name] of [[home,'/','homepage'],[specials,'/specials','specials page']]) test(`${name}: each promotion's heading is its one link, with no duplicate heading`,async t=>{
  const f=await setup(t);verifySlot(f,3,'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each');
  const board=await links(t,f,'2030-01-15T18:00:00Z',component,path);
  assert.equal(linkCount(board.html,'mexican-night'),1);assert.equal(linkCount(board.html,'wing-wednesday'),1);
  assert.match(board.html,/<a class="special-group__section-link"[^>]*href="\/specials#mexican-night"[^>]*>Mexican Night →<\/a>/);
  assert.match(board.html,/<a class="special-group__section-link"[^>]*href="\/specials#wing-wednesday"[^>]*>Wing Wednesday →<\/a>/);
  assert.doesNotMatch(board.html,/View the Menu|View Wing Wednesday|View Mexican Night|Wing Night!|Mexican Night!|Ask to see our Menu/);
  // The heading comes first, with the verified prices beside their own options. The homepage card is only the link.
  if(component===specials) assert.match(board.html,/Wing Wednesday →<\/a><span[^>]*>Bone-In Wings \$1 each\nBoneless Wings \$2 each\nAdd Fries<\/span>/);
  else assert.doesNotMatch(board.html,/Bone-In Wings|Boneless Wings|Add Fries/);
  // Presentation only: what's stored keeps its printed wording.
  assert.match(f.sql("SELECT content FROM special_slots s JOIN special_groups g ON g.id=s.group_id JOIN special_collections c ON c.id=g.collection_id WHERE c.kind='week' AND g.day_of_week=3 AND g.service='nightly' AND s.position=1")[0].content,/^Wing Night!/);
  assert.equal(f.sql("SELECT count(*) n FROM special_slots WHERE section_link='wing-wednesday'")[0].n,0);
});
test('Thursday: next Tuesday and Wednesday are still on the board, but with no dead link',async t=>{
  const f=await setup(t);
  const board=await links(t,f,'2030-01-17T18:00:00Z',home,'/');
  assert.equal(board.mexican,false);assert.equal(board.wing,false);
  assert.doesNotMatch(board.html,/specials#mexican-night|specials#wing-wednesday/);
});
test('the Tuesday special keeps its full text with no link once Mexican Night is hidden',async t=>{
  const f=await setup(t);
  const shown=await links(t,f,'2030-01-15T18:00:00Z',specials,'/specials');
  assert.ok(shown.mexican);
  // Wednesday 1 AM keeps Tuesday off the page by date, so check the component rule directly.
  assert.deepEqual(presentSpecial(nightly(2),{content:'Mexican Night! Ask to see our Menu!'},[]),{link:null,text:'Mexican Night! Ask to see our Menu!'});
});
test('Mexican Night cutoff is exact across daylight saving',()=>{
  const sunday='2030-07-07T22:00:00Z';
  assert.equal(mexicanNightDetailVisible(sunday,new Date('2030-07-10T06:59:59Z')),true,'CDT Wednesday 1:59:59 AM');
  assert.equal(mexicanNightDetailVisible(sunday,new Date('2030-07-10T07:00:00Z')),false,'CDT Wednesday 2:00 AM');
  const january='2030-01-14T01:00:00Z';
  assert.equal(mexicanNightDetailVisible(january,new Date('2030-01-16T07:59:59Z')),true,'CST Wednesday 1:59:59 AM');
  assert.equal(mexicanNightDetailVisible(january,new Date('2030-01-16T08:00:00Z')),false,'CST Wednesday 2:00 AM');
  // Week of the fall change: Sunday Nov 3, 2030.
  const fall='2030-11-04T01:00:00Z';
  assert.equal(mexicanNightDetailVisible(fall,new Date('2030-11-06T07:59:59Z')),true);
  assert.equal(mexicanNightDetailVisible(fall,new Date('2030-11-06T08:00:00Z')),false);
});

// ── Mandatory price rule ──
const OLD_TEMPLATE='Wing Night!\n\n$.89 Boneless Wings\n$.99 Bone In Wings\nAdd Fries';
const fromTemplate={content:OLD_TEMPLATE,price:'',origin:'manual',manual_locked:0,last_auto_value:null,section_link:''};
const wed=nightly(3),live=['wing-wednesday'];
test('a recurring template price never shows: not linked, and not once hidden',()=>{
  assert.equal(wingPriceEligible(fromTemplate),false);
  assert.deepEqual(presentSpecial(wed,fromTemplate,live).text,'Bone-In Wings\nBoneless Wings\nAdd Fries');
  assert.equal(presentSpecial(wed,fromTemplate,[]).text,'Wing Night!\nBone-In Wings\nBoneless Wings\nAdd Fries');
  // Older, unowned values are no better.
  assert.doesNotMatch(presentSpecial(wed,{...fromTemplate,origin:'legacy'},live).text,/\$/);
  // Changed since automation wrote it, with no staff edit recorded: not the verified value.
  assert.doesNotMatch(presentSpecial(wed,{...fromTemplate,origin:'automation',last_auto_value:'Wing Night!\nBone-In Wings $5'},live).text,/\$/);
});
test('verified poster and staff prices show beside their options',()=>{
  const content='Wing Wednesday!\nBone-In Wings $1 each\nBoneless Wings $2 each';
  const shown='Bone-In Wings $1 each\nBoneless Wings $2 each';
  assert.equal(presentSpecial(wed,{...fromTemplate,content,origin:'automation',last_auto_value:content},live).text,shown,'verified poster');
  assert.equal(presentSpecial(wed,{...fromTemplate,content,manual_locked:1},live).text,shown,'staff lock');
  assert.equal(presentSpecial(wed,{...fromTemplate,content,manual_edited_at:'2030-01-15T00:00:00Z'},live).text,shown,'staff edit');
});
test('a staff-approved section price replaces a stale or uncorrected nightly price, never staff\'s own',()=>{
  const lines=['Bone-In Wings $3 each','Boneless Wings $4 each'],wing={lines,priced:true,source:'manual'};
  const verified='Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each';
  assert.equal(presentSpecial(wed,fromTemplate,live,wing).text,lines.join('\n'));
  assert.equal(presentSpecial(wed,{...fromTemplate,content:verified,origin:'automation',last_auto_value:verified},live,wing).text,lines.join('\n'));
  assert.match(presentSpecial(wed,{...fromTemplate,content:verified,manual_locked:1},live,wing).text,/\$1 each/);
  // Hidden: last section's prices can't reach another Wednesday.
  assert.doesNotMatch(presentSpecial(wed,fromTemplate,[],wing).text,/\$/);
  // A section with no price has nothing to add.
  assert.doesNotMatch(presentSpecial(wed,fromTemplate,live,{lines:['Bone-In Wings','Boneless Wings'],priced:false,source:'manual'}).text,/\$/);
});
test('another Wednesday promotion and other nights keep their printed text and prices',()=>{
  const pizza={...fromTemplate,content:'Pizza Night! 16" Pizza $16'};
  assert.deepEqual(presentSpecial(wed,pizza,live),{link:null,text:'Pizza Night! 16" Pizza $16'});
  const steak={...fromTemplate,content:'Bone-In Ribeye $20'};
  assert.deepEqual(presentSpecial(wed,steak,live),{link:null,text:'Bone-In Ribeye $20'});
  const friday={...fromTemplate,content:'Chicken Stir Fry $12.99'};
  assert.deepEqual(presentSpecial(nightly(5),friday,live),{link:null,text:'Chicken Stir Fry $12.99'});
  // Mexican Night's extra items stay when its heading becomes the link.
  assert.equal(presentSpecial(nightly(2),{...fromTemplate,content:'Mexican Night!\nTacos $3'},['mexican-night']).text,'Tacos $3');
  assert.equal(presentSpecial(nightly(2),{...fromTemplate,content:'Mexican Night!  Ask to see our Menu!'},['mexican-night']).text,'');
  assert.equal(presentSpecial(nightly(2),{...fromTemplate,content:'Mexican Night!  Ask to see our Menu!'},[]).text,'Mexican Night!  Ask to see our Menu!');
});
// Add Fries stands on the nightly card and never reaches the section.
const NIGHT='2030-01-15T18:00:00Z';
const wingCard=html=>html.match(/Wing Wednesday →<\/a><span[^>]*>([^<]*)<\/span>/)?.[1];
const defaultsSlot="(SELECT g.id FROM special_groups g WHERE g.collection_id='defaults' AND g.day_of_week=3 AND g.service='nightly' LIMIT 1)";
test('Add Fries stays on the card when a poster omits it, with no price invented',async t=>{
  const f=await setup(t);verifySlot(f,3,'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each');
  const page=await links(t,f,NIGHT,specials,'/specials');
  assert.equal(wingCard(page.html),'Bone-In Wings $1 each\nBoneless Wings $2 each\nAdd Fries');
  const section=page.html.match(/<article class="placard placard--wing[\s\S]*?<\/article>/)[0];
  assert.doesNotMatch(section,/fries/i,'the section stays bone-in, boneless and sauces');
});
test('a poster that prints a fries price shows it once, without a second fries line',async t=>{
  const f=await setup(t);verifySlot(f,3,'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each\nAdd Fries $3');
  const board=await links(t,f,NIGHT,specials,'/specials');
  assert.equal(wingCard(board.html),'Bone-In Wings $1 each\nBoneless Wings $2 each\nAdd Fries $3');
});
test('a fries price from an earlier poster never carries forward: the next card reads plain Add Fries',async t=>{
  const f=await setup(t);verifySlot(f,3,'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each\nAdd Fries $3');
  verifySlot(f,3,'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each');
  const board=await links(t,f,NIGHT,specials,'/specials');
  assert.doesNotMatch(wingCard(board.html),/\$3/);assert.match(wingCard(board.html),/Add Fries$/);
});
test('removing Add Fries from Recurring Defaults ends it',async t=>{
  const f=await setup(t);verifySlot(f,3,'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each');
  f.sql(`UPDATE special_slots SET content='Wing Night!' WHERE group_id=${defaultsSlot} AND position=1`);
  const without=await links(t,f,NIGHT,specials,'/specials');
  assert.doesNotMatch(wingCard(without.html),/fries/i);
});
test('a staff-written card stands as written, without an added Add Fries',async t=>{
  const second=await setup(t);
  second.sql("UPDATE special_slots SET content='Wing Night!\nBone-In Wings\nBoneless Wings',manual_locked=1 WHERE position=1 AND group_id IN (SELECT g.id FROM special_groups g JOIN special_collections c ON c.id=g.collection_id WHERE c.kind='week' AND g.day_of_week=3 AND g.service='nightly')");
  const staff=await links(t,second,NIGHT,specials,'/specials');
  assert.doesNotMatch(wingCard(staff.html),/fries/i);
});
test('the rendered page shows no template price, and agrees with the section',async t=>{
  const f=await setup(t);
  f.sql("UPDATE special_slots SET content=?1,origin='manual',manual_locked=0,last_auto_value=NULL WHERE position=1 AND group_id IN (SELECT g.id FROM special_groups g JOIN special_collections c ON c.id=g.collection_id WHERE c.kind='week' AND g.day_of_week=3 AND g.service='nightly')",OLD_TEMPLATE);
  const board=await links(t,f,'2030-01-15T18:00:00Z',home,'/');
  assert.doesNotMatch(board.html,/\$\.89|\$\.99/);
  assert.equal(linkCount(board.html,'wing-wednesday'),1);
  const page=await links(t,f,'2030-01-15T18:00:00Z',specials,'/specials');
  assert.match(page.html,/Wing Wednesday →<\/a><span[^>]*>Bone-In Wings\nBoneless Wings\nAdd Fries<\/span>/);
  assert.doesNotMatch(page.html,/\$\.89|\$\.99/);
  assert.match(page.html,/Call or check Facebook for this week’s prices\./);
  // After staff approve a price on the section, the card matches it.
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups.find(g=>g.id==='ww-live:ww-default:wings').slots[0].content='Bone-In Wings $3 each';
  await store.saveCollection(f.env,live);
  const corrected=await links(t,f,'2030-01-15T18:00:00Z',specials,'/specials');
  assert.match(corrected.html,/Wing Wednesday →<\/a><span[^>]*>Bone-In Wings \$3 each\nBoneless Wings\nAdd Fries<\/span>/);
});
test('this week\'s section can never link or price a later Wednesday on the board',async t=>{
  const f=await setup(t);
  const {sectionsFor,wingOptions}=await store.readPublicSections(f.env,new Date('2030-01-15T18:00:00Z'));
  assert.ok(sectionsFor('2030-01-16').includes('wing-wednesday'));
  assert.equal(sectionsFor('2030-01-23').includes('wing-wednesday'),false);
  assert.equal(wingOptions.priced,false);
});

// ── /admin/automation ──
const addImport=(f,id,candidate,{created='2030-01-16T14:00:00Z',status='staged',result='ok'}={})=>f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,fb_updated_time,caption,caption_hash,image_hash,permalink_url,image_r2_key,target_kind,classification_reason,candidate_json,extracted_json,processing_status,validation_result,review_status,fetched_at,processed_at,parser_version)
  VALUES(?,?,?,?,'','c','i','https://www.facebook.com/1/posts/2','r2','week','',?,?,?,?,'pending',?,?,18)`,id,`post-${id}`,created,created,JSON.stringify(candidate),JSON.stringify(candidate),status,result,created,created);
const uncertain={day_of_week:3,day_evidence:'Wednesday',poster_evidence:'Wing Night',offers:[{content:'Wing Night Bone-In Boneless',evidence:'Wing Night Bone-In Boneless',service_time:'5-10 PM'}]};
const AT='2030-01-16T16:00:00Z';
async function review(t,f) {
  t.mock.timers.setTime(Date.parse(AT));
  return render(automation,f,AT,'/admin/automation?date=2030-01-16');
}
const post=(f,body)=>approve({request:new Request('http://localhost/admin/automation/wing',{method:'POST',headers:{origin:'http://localhost',cookie,'content-type':'application/json'},body:JSON.stringify(body)}),
  cookies:{get:()=>({value:'a'.repeat(32)})},locals:{runtime:{env:f.env}},url:new URL('http://localhost/admin/automation/wing')});
const hold=(f,id,detail='Missing, malformed or ambiguous wing prices')=>f.sql("INSERT INTO wing_wednesday_decisions(import_id,week_start,outcome,detail) VALUES(?,'2030-01-14','held',?)",id,detail);

test('a held poster shows its source, proposal, reason and approval on the normal review card',async t=>{
  const f=await setup(t);addImport(f,'held',uncertain);hold(f,'held');
  const html=await review(t,f);
  const card=html.slice(html.indexOf('id="import-held"'));
  assert.match(card,/Needs Review/);assert.match(card,/Wing Wednesday section/);
  assert.match(card,/Missing, malformed or ambiguous wing prices/);
  assert.match(card,/Wing Night Bone-In Boneless/);
  assert.match(card,/Approve &amp; Publish to Wing Wednesday/);
  assert.match(card,/href="\/admin\/specials#wing-form"/);
  assert.match(card,/https:\/\/www\.facebook\.com\/1\/posts\/2/);
  assert.match(html,/1 post needs your attention/);
});
test('approval follows wing type when staff reordered the items, and a newer poster can still replace it',async t=>{
  const f=await setup(t);addImport(f,'held',uncertain);hold(f,'held');
  f.sql("UPDATE special_slots SET content='Boneless Wings\nHand breaded' WHERE group_id='ww-live:ww-default:wings' AND position=1");
  f.sql("UPDATE special_slots SET content='Bone-In Wings\nSmoked' WHERE group_id='ww-live:ww-default:wings' AND position=2");
  const {revision}=f.sql("SELECT revision FROM special_collections WHERE id='wing-wednesday'")[0];
  const reply=await post(f,{importId:'held',revision,boneIn:'Bone-In Wings $1 each',boneless:'Boneless Wings $2 each'});
  assert.equal(reply.status,200);
  const slots=f.sql("SELECT content FROM special_slots WHERE group_id='ww-live:ww-default:wings' ORDER BY position").map(s=>s.content);
  assert.deepEqual(slots.slice(0,2),['Boneless Wings $2 each\nHand breaded','Bone-In Wings $1 each\nSmoked']);
});
test('a published daily post still shows Needs Review for a Wing Wednesday hold',async t=>{
  const f=await setup(t);addImport(f,'held',uncertain);hold(f,'held','Wednesday poster advertises a different nightly promotion');
  f.sql("INSERT INTO special_import_events(import_id,event_type,detail) VALUES('held','review','GUARDED_AUTO: fb_created=x; 1 slot(s)')");
  const html=await review(t,f);
  assert.match(html,/daily specials from this post are done/);
  assert.match(html,/Wednesday poster advertises a different nightly promotion/);
  assert.match(html,/1 post needs your attention/);
});
test('other posts on the page are unaffected and no notice appears without a decision',async t=>{
  const f=await setup(t);addImport(f,'plain',{day_of_week:3,day_evidence:'Wednesday',poster_evidence:'Specials',offers:[{content:'Burger $10',evidence:'Burger $10',service_time:''}]});
  const html=await review(t,f);
  assert.doesNotMatch(html,/Wing Wednesday section/);
});
test('approval publishes the checked values with manual protection, keeps sauces and ends the review',async t=>{
  const f=await setup(t);addImport(f,'held',uncertain);hold(f,'held');
  f.sql("INSERT INTO special_import_events(import_id,event_type,detail) VALUES('held','review','GUARDED_AUTO: fb_created=x; 1 slot(s)')");
  const {revision}=f.sql("SELECT revision FROM special_collections WHERE id='wing-wednesday'")[0];
  const sauces=()=>f.sql("SELECT content FROM special_slots WHERE group_id='ww-live:ww-default:sauces' AND position=1")[0].content;
  const before=sauces();
  const reply=await post(f,{importId:'held',revision,boneIn:'Bone-In Wings $1 each',boneless:'Boneless Wings $2 each'});
  assert.equal(reply.status,200);
  const slots=f.sql("SELECT content,manual_locked FROM special_slots WHERE group_id='ww-live:ww-default:wings' ORDER BY position");
  assert.equal(slots[0].content,'Bone-In Wings $1 each');assert.equal(slots[1].content,'Boneless Wings $2 each');
  assert.equal(slots[0].manual_locked,1);assert.equal(sauces(),before);
  assert.equal(f.sql("SELECT section_source FROM special_collections WHERE id='wing-wednesday'")[0].section_source,'manual');
  assert.equal(f.sql('SELECT outcome FROM wing_wednesday_decisions')[0].outcome,'approved');
  assert.equal(f.sql("SELECT candidate_json FROM special_imports WHERE id='held'")[0].candidate_json,JSON.stringify(uncertain),'original reading kept');
  const html=await review(t,f);
  assert.match(html,/Nothing needs your attention/);assert.doesNotMatch(html,/Approve &amp; Publish to Wing Wednesday/);
});
test('approval refuses a stale form, another post, cross-site requests and blank values',async t=>{
  const f=await setup(t);addImport(f,'held',uncertain);hold(f,'held');
  const {revision}=f.sql("SELECT revision FROM special_collections WHERE id='wing-wednesday'")[0];
  const good={importId:'held',revision,boneIn:'Bone-In Wings $1',boneless:'Boneless Wings $2'};
  const before=f.sql("SELECT content FROM special_slots WHERE group_id='ww-live:ww-default:wings'");
  assert.equal((await post(f,{...good,revision:revision-1})).status,409);
  assert.equal((await post(f,{...good,importId:'other'})).status,400);
  assert.equal((await post(f,{...good,boneIn:' '})).status,400);
  const cross=await approve({request:new Request('http://localhost/admin/automation/wing',{method:'POST',headers:{origin:'https://evil.example',cookie,'content-type':'application/json'},body:JSON.stringify(good)}),
    cookies:{get:()=>({value:'a'.repeat(32)})},locals:{runtime:{env:f.env}},url:new URL('http://localhost/admin/automation/wing')});
  assert.equal(cross.status,403);
  assert.deepEqual(f.sql("SELECT content FROM special_slots WHERE group_id='ww-live:ww-default:wings'"),before);
});

const pendingApproval=f=>{
  addImport(f,'held',uncertain);hold(f,'held');
  const {revision}=f.sql("SELECT revision FROM special_collections WHERE id='wing-wednesday'")[0];
  return {importId:'held',revision,boneIn:'Bone-In Wings $1',boneless:'Boneless Wings $2'};
};
const wingState=f=>[
  f.sql("SELECT * FROM special_collections WHERE id='wing-wednesday'"),
  f.sql("SELECT * FROM special_slots WHERE group_id='ww-live:ww-default:wings' ORDER BY position"),
  f.sql('SELECT * FROM wing_wednesday_decisions'),
];

test('approval can correct only one option and keeps the other in review',async t=>{
  const f=await setup(t);
  const body=pendingApproval(f);
  t.mock.timers.setTime(Date.parse(AT));
  const first=await post(f,{...body,boneless:null});
  assert.equal(first.status,200);
  const {revision}=await first.json();
  const [,slots,decisions]=wingState(f);
  assert.equal(slots[0].manual_locked,1);
  assert.equal(slots[1].manual_locked,0);
  assert.equal(decisions[0].outcome,'held');
  const html=await review(t,f);
  assert.doesNotMatch(html,/name="boneIn"/);
  assert.match(html,/name="boneless"/);
  assert.equal((await post(f,{...body,revision,boneIn:null})).status,200);
  assert.equal(wingState(f)[2][0].outcome,'approved');
});

test('approval from last Wednesday expires before Sunday rollover and cannot claim the new week',async t=>{
  const f=await setup(t);
  const body=pendingApproval(f),before=wingState(f);
  t.mock.timers.setTime(Date.parse('2030-01-20T20:00:00Z'));
  const reply=await post(f,body);
  assert.equal(reply.status,400);
  assert.match((await reply.json()).error,/expired/i);
  assert.deepEqual(wingState(f),before);
});

for(const phase of ['before reload','before batch']) test(`approval rejects a concurrent staff edit ${phase}`,async t=>{
  const f=await setup(t);
  const body=pendingApproval(f);
  t.mock.timers.setTime(Date.parse(AT));
  const edit=()=>{
    f.sql("UPDATE special_collections SET revision=revision+1,section_source='manual' WHERE id='wing-wednesday'");
    f.sql("UPDATE special_slots SET content='Bone-In Wings $3',manual_locked=1 WHERE group_id='ww-live:ww-default:wings' AND position=1");
  };
  const {prepare,batch}=f.env.DB;
  if(phase==='before reload') f.env.DB.prepare=query=>{
    const statement=prepare(query);
    if(!query.includes('FROM wing_wednesday_decisions d')) return statement;
    return {...statement,async first(){const held=await statement.first();edit();return held;}};
  };
  else f.env.DB.batch=async statements=>{edit();return batch(statements);};
  assert.equal((await post(f,body)).status,409);
  const [head,slots,decisions]=wingState(f);
  assert.equal(head[0].revision,body.revision+1);
  assert.equal(slots[0].content,'Bone-In Wings $3');
  assert.equal(slots[1].content,'Boneless Wings');
  assert.equal(decisions[0].outcome,'held');
});

test('approval recording failure rolls back the published prices, staff locks and revision',async t=>{
  const f=await setup(t);
  const body=pendingApproval(f),before=wingState(f);
  t.mock.timers.setTime(Date.parse(AT));
  f.sql(`CREATE TRIGGER reject_wing_approval BEFORE UPDATE OF outcome ON wing_wednesday_decisions
    WHEN NEW.outcome='approved' BEGIN SELECT RAISE(ABORT,'database approval failure'); END`);
  assert.equal((await post(f,body)).status,400);
  assert.deepEqual(wingState(f),before);
});
// The homepage Wednesday card, the same way Tuesday's reads.
const WED_NIGHTLY="(SELECT g.id FROM special_groups g JOIN special_collections c ON c.id=g.collection_id JOIN weekly_specials w ON w.id=c.weekly_special_id AND w.week_start_date='2030-01-14' WHERE c.kind='week' AND g.day_of_week=3 AND g.service='nightly')";
const NIGHTLY_TEXT=/Bone-In Wings|Boneless Wings|Add Fries/;
const hideWing=f=>f.sql("UPDATE special_groups SET enabled=0 WHERE collection_id='wing-wednesday'");
async function saveWedNightly(f,content) {
  const id=f.sql("SELECT c.id FROM special_collections c JOIN weekly_specials w ON w.id=c.weekly_special_id AND w.week_start_date='2030-01-14' WHERE c.kind='week'")[0].id;
  const week=await store.readCollection(f.env,id);
  Object.assign(week.groups.find(g=>g.day_of_week===3 && g.service==='nightly').slots[0],{content,staff_edited:true});
  await store.saveCollection(f.env,week,{start:'2030-01-14',end:'2030-01-20'});
}
for(const [label,prepare] of [
  ['the recurring default',f=>f.sql(`UPDATE special_slots SET content=?1 WHERE position=1 AND group_id=${WED_NIGHTLY}`,'Wing Night!\nBone-In Wings\nBoneless Wings\nAdd Fries')],
  ['a verified poster',f=>verifySlot(f,3,'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each\nAdd Fries $3')],
]) test(`homepage Wednesday from ${label} is only the link, and what is stored stays`,async t=>{
  const f=await setup(t);prepare(f);
  const stored=()=>f.sql(`SELECT content FROM special_slots WHERE position=1 AND group_id IN (${WED_NIGHTLY},${defaultsSlot}) ORDER BY group_id`);
  const before=stored();
  const board=await links(t,f,NIGHT,home,'/');
  assert.equal(linkCount(board.html,'wing-wednesday'),1);
  assert.match(board.html,/Wing Wednesday →<\/a><\/li>/);
  assert.doesNotMatch(board.html,NIGHTLY_TEXT);
  assert.deepEqual(stored(),before);
  assert.ok(before.some(row=>/Bone-In Wings/.test(row.content) && /Add Fries/.test(row.content)));
  const page=await links(t,f,NIGHT,specials,'/specials');
  assert.match(wingCard(page.html),/Bone-In Wings[\s\S]*Add Fries/,'the specials page card is unchanged');
});
test('homepage Wednesday shows its full nightly text with no link once the section is hidden',async t=>{
  const f=await setup(t);verifySlot(f,3,'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each');hideWing(f);
  const board=await links(t,f,NIGHT,home,'/');
  assert.equal(linkCount(board.html,'wing-wednesday'),0);
  assert.match(board.html,/Wing Night!\nBone-In Wings \$1 each\nBoneless Wings \$2 each\nAdd Fries/);
});
for(const [label,mark] of [
  ['locked',"manual_locked=1,manual_edited_at=NULL"],
  ['edited without a lock',"manual_locked=0,manual_edited_at='2030-01-15T00:00:00Z'"],
]) test(`homepage Wednesday shows a staff entry naming wings as written, without the link: ${label}`,async t=>{
  const f=await setup(t);
  f.sql(`UPDATE special_slots SET content=?1,origin='manual',${mark} WHERE position=1 AND group_id=${WED_NIGHTLY}`,'Wing Night!\nBone-In Wings $5 each');
  const board=await links(t,f,NIGHT,home,'/');
  assert.equal(linkCount(board.html,'wing-wednesday'),0);
  assert.match(board.html,/Wing Night!\nBone-In Wings \$5 each/);
  assert.doesNotMatch(board.html,/Add Fries/,'staff text stands without an added line');
});
test('homepage Wednesday follows a staff save: their special shows, and clearing it brings the link back',async t=>{
  const f=await setup(t);
  await saveWedNightly(f,'Prime Rib Night $25');
  const entered=await links(t,f,NIGHT,home,'/');
  assert.equal(linkCount(entered.html,'wing-wednesday'),0);
  assert.match(entered.html,/Prime Rib Night \$25/);
  await saveWedNightly(f,'');
  const cleared=await links(t,f,NIGHT,home,'/');
  assert.equal(linkCount(cleared.html,'wing-wednesday'),1);
  assert.match(cleared.html,/Wing Wednesday →<\/a><\/li>/);
  assert.doesNotMatch(cleared.html,/Prime Rib/);
  assert.equal(f.sql(`SELECT content FROM special_slots WHERE position=1 AND group_id=${WED_NIGHTLY}`)[0].content,'','the link is never stored');
});
test('an empty Wednesday field shows no link while its section is hidden',async t=>{
  const f=await setup(t);
  f.sql(`UPDATE special_slots SET content='' WHERE group_id=${WED_NIGHTLY}`);hideWing(f);
  const board=await links(t,f,NIGHT,home,'/');
  assert.equal(linkCount(board.html,'wing-wednesday'),0);
  assert.doesNotMatch(board.html,/Wing Wednesday/,'no stand-in text either');
});
test('an empty Wednesday group staff switched off stays off',async t=>{
  const f=await setup(t);
  f.sql(`UPDATE special_slots SET content='' WHERE group_id=${WED_NIGHTLY}`);
  f.sql(`UPDATE special_groups SET enabled=0 WHERE id=${WED_NIGHTLY}`);
  assert.equal(linkCount((await links(t,f,NIGHT,home,'/')).html,'wing-wednesday'),0);
});
test('another promotion from Facebook still reads as printed on the homepage',async t=>{
  const f=await setup(t);verifySlot(f,3,'Pizza Night! 16" Pizza $16');
  const board=await links(t,f,NIGHT,home,'/');
  assert.equal(linkCount(board.html,'wing-wednesday'),0);
  assert.match(board.html,/Pizza Night!/);
});
test('Tuesday keeps its Mexican Night link on the homepage',async t=>{
  const f=await setup(t);
  const board=await links(t,f,NIGHT,home,'/');
  assert.match(board.html,/Mexican Night →<\/a><\/li>/);
});
