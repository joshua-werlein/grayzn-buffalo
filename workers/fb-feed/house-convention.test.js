// Gated house layout (approved fallback): when a day poster prints no service
// labels, one Lunch/Day Special meal followed by two All Day meals is inferred
// ONLY if every condition holds. Explicit labels/evidence always come first;
// anything undetermined stays held and the recurring defaults remain visible.
// All AI responses are mocked; none of these tests evaluates a real image.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reconcilePosterEvidence} from './reconcile.js';
import {harness} from './test-fixture.js';

const fixture=name=>JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}.json`,import.meta.url),'utf8'));
const OCT10=fixture('oct10-saturday'),OCT11=fixture('oct11-sunday');
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const TODAY={0:'2026-10-11',1:'2026-10-12',2:'2026-10-13',3:'2026-10-14',4:'2026-10-15',5:'2026-10-16',6:'2026-10-10'};
const offer=(content,service_time='',evidence=content)=>({content,service_time,evidence});
const v2=(day,heading,offers,day_evidence=DAYS[day])=>({evidence_version:2,day_of_week:day,day_evidence,poster_evidence:heading,offers});
const route=(poster,day=poster.day_of_week)=>reconcilePosterEvidence([poster],day,[],{today:TODAY[day]});
const services=r=>r.targets.map(t=>[t.role??t.service,t.items.map(i=>i.content)]);
const withoutSoup=p=>({...p,offers:p.offers.filter(o=>!/^\s*soups?\s*:/i.test(o.content))});
const MEALS=[offer('Philly & Fries $11'),offer('German Burger w/ Side Salad, Soup or Coleslaw $10.25'),offer('Chicken Salad Sandwich w/ cup of Soup or Coleslaw $7.25')];

// ── October 10 and 11 posters, with and without the soup list ──
test('October 10 Saturday poster: Saturday Special, two All Day meals and the Soups list',()=>{
  assert.deepEqual(services(route({...OCT10,evidence_version:2})),[
    ['lunch',['Philly & Fries – $11']],
    ['all-day',['German Burger w/ Side Salad, Soup or Coleslaw – $10.25','Chicken Salad Sandwich w/ cup of Soup or Coleslaw – $7.25']],
    ['soup',['French Onion, Chili or Beer Cheese Soup']]]);
});
test('October 10 Saturday poster without a soup list: same meal mapping, no Soup target',()=>{
  assert.deepEqual(services(route(withoutSoup({...OCT10,evidence_version:2}))),[
    ['lunch',['Philly & Fries – $11']],
    ['all-day',['German Burger w/ Side Salad, Soup or Coleslaw – $10.25','Chicken Salad Sandwich w/ cup of Soup or Coleslaw – $7.25']]]);
});
test('October 11 Sunday poster (weekday only in the heading): Sunday Special, two All Day meals and the Soups list',()=>{
  assert.deepEqual(services(route({...OCT11,evidence_version:2})),[
    ['lunch',['16" 3-Topping Pizza 12 Wings $30']],
    ['all-day',['Olive Burger w/ Side Salad, Soup Or Coleslaw $10.25','Chicken Salad Sandwich w/ Cup Of Soup Or Coleslaw $7.25']],
    ['soup',['Beer Cheese, French Onion or Chili']]]);
});
test('October 11 Sunday poster without a soup list: same meal mapping, no Soup target',()=>{
  assert.deepEqual(services(route(withoutSoup({...OCT11,evidence_version:2}))).map(([s])=>s),['lunch','all-day']);
});

// ── Explicit evidence first; the convention only fills missing labels ──
test('labels that agree with the house layout are honored; missing ones are filled',()=>{
  const r=route(v2(1,'Monday Specials',[offer(MEALS[0].content,'Lunch 11-1:30'),MEALS[1],MEALS[2]]));
  assert.deepEqual(services(r).map(([s])=>s),['lunch','all-day']);
});
test('a label that contradicts the house position disables the convention; only the explicitly labeled meal publishes',()=>{
  // Meal 1 says All Day, so meal 1 cannot be the lunch the convention would assume.
  // Meals 2-3 stay unresolved; they FOLLOW meal 1, so they cannot take its slot.
  const r=route(v2(1,'Monday Specials',[offer(MEALS[0].content,'All Day'),MEALS[1],MEALS[2]]));
  assert.deepEqual(services(r),[['all-day',['Philly & Fries $11']]]);
  assert.deepEqual(r.unresolvedTargets.map(u=>[u.position,u.reason]),[[2,'Service not established by evidence'],[3,'Service not established by evidence']]);
});
test('an unresolved meal printed AHEAD of a labeled meal could take its slot: that service is held',()=>{
  const r=route(v2(1,'Monday Specials',[MEALS[1],offer(MEALS[2].content,'All Day')]));
  assert.deepEqual(r.targets,[]);
  assert.ok(r.unresolvedTargets.some(u=>u.reason==='Unresolved sibling could compete for this slot'));
});
test('an unresolved meal never competes for a full service: the labeled Lunch publishes',()=>{
  const r=route(v2(1,'Monday Specials',[MEALS[1],offer(MEALS[0].content,'Lunch 11-1:30')]));
  assert.deepEqual(services(r),[['lunch',['Philly & Fries $11']]]);
});
test('an unresolved sibling that is the same dish at another price contradicts the offer: held',()=>{
  const r=route(v2(1,'Monday Specials',[offer('Burger $10','All Day'),offer('Burger $12')]));
  assert.deepEqual(r.targets,[]);
});
test('fully labeled posters route by evidence alone, without the convention',()=>{
  const r=route(v2(1,'Monday Specials',[offer('Fish Fry $12','All Day'),offer(MEALS[0].content,'Lunch'),offer('Ribs $15','5-10 PM')]));
  assert.deepEqual(services(r),[['all-day',['Fish Fry $12']],['lunch',['Philly & Fries $11']],['nightly',['Ribs $15']]]);
});

// ── Changed offer counts ──
test('labeled posters with other offer counts publish: two All Day only',()=>{
  assert.deepEqual(services(route(v2(1,'Monday Specials',[offer(MEALS[1].content,'All Day'),offer(MEALS[2].content,'All Day')]))).map(([s,i])=>[s,i.length]),[['all-day',2]]);
});
test('labeled posters with other offer counts publish: one Lunch only',()=>{
  assert.deepEqual(services(route(v2(1,'Monday Specials',[offer(MEALS[0].content,'11-1:30')]))),[['lunch',['Philly & Fries $11']]]);
});
test('labeled Monday poster with five offers fills Lunch, All Day and two Nightly',()=>{
  const r=route(v2(1,'Monday Specials',[offer('Caesar Salad $9.75','Lunch'),offer(MEALS[1].content,'All Day'),offer(MEALS[2].content,'All Day'),
    offer('Ribs $15','Night 5-10'),offer('Steak $20','Night 5-10')]));
  assert.deepEqual(services(r).map(([s,i])=>[s,i.length]),[['lunch',1],['all-day',2],['nightly',2]]);
});
for(const count of [2,4]) test(`unlabeled poster with ${count} meals is not the house layout: held, defaults remain`,()=>{
  const meals=[...MEALS,offer('Fish Fry $12')].slice(0,count);
  const r=route(v2(1,'Monday Specials',meals));
  assert.deepEqual(r.targets,[]);
  assert.equal(r.unresolvedTargets.length,count);
});
test('unlabeled three meals plus a soup list still use the convention; soup never counts as a meal',()=>{
  const r=route(v2(1,'Monday Specials',[...MEALS,offer('Soups: Chili or French Onion')]));
  assert.deepEqual(services(r).map(([s])=>s),['lunch','all-day','soup']);
});

// ── Ambiguous layouts: every gate holds or nothing is inferred ──
const held=(name,poster)=>test(`ambiguous: ${name} → unlabeled meals held`,()=>{
  const r=route(poster);
  assert.deepEqual(r.targets.filter(t=>t.service!=='custom'),[]);
});
held('heading prints no weekday',v2(1,"Today's Specials",MEALS,''));
held('heading is not a Specials heading',v2(1,'Monday Menu',MEALS));
held('heading is a night heading',v2(1,'Monday Night Specials',MEALS));
held('heading is an All Day heading',v2(1,'Monday All Day Specials',MEALS));
held('heading is a weekly heading',v2(1,'Monday Weekly Specials',MEALS));
held('one meal lacks a price',v2(1,'Monday Specials',[MEALS[0],offer('German Burger w/ Side Salad'),MEALS[2]]));
// The layout is identified by three priced meals; a meal whose wording or price
// reading is uncertain keeps its slot (default stays) while verified siblings publish.
test('layout still identified when one meal is uncertain: it alone is held in its slot',()=>{
  const r=route(v2(1,'Monday Specials',[MEALS[0],{...MEALS[1],uncertainties:['price partly obscured']},MEALS[2]]));
  assert.deepEqual(services(r),[['lunch',['Philly & Fries $11']],['all-day',['Chicken Salad Sandwich w/ cup of Soup or Coleslaw $7.25']]]);
  assert.deepEqual(r.targets.find(t=>t.service==='all-day').items.map(i=>i.position),[2]);
  assert.deepEqual(r.unresolvedTargets.map(u=>[u.service,u.position,u.reason]),[['all-day',1,'Uncertain extracted offer']]);
});
test('layout still identified when one meal lacks its printed "or": it alone is held in its slot',()=>{
  const r=route(v2(1,'Monday Specials',[MEALS[0],MEALS[1],offer('Chicken Salad Sandwich w/ Cup of Soup Coleslaw $7.25')]));
  assert.deepEqual(services(r),[['lunch',['Philly & Fries $11']],['all-day',['German Burger w/ Side Salad, Soup or Coleslaw $10.25']]]);
  assert.deepEqual(r.unresolvedTargets.map(u=>[u.service,u.position,u.reason]),[['all-day',2,'Ambiguous side alternatives']]);
});
held('a meal names a night service in its own text',v2(1,'Monday Specials',[MEALS[0],MEALS[1],offer('Nightly Ribs $15')]));
test('weekend convention never publishes Nightly; weekend Nightly stays disabled downstream',()=>{
  const r=route(v2(6,'Saturday Specials',MEALS));
  assert.ok(!r.targets.some(t=>t.service==='nightly'));
});

// ── Integration through the guarded publisher ──
function setupDay(t,candidate,{now,weekStart,weekEnd,created}) {
  const f=harness(t,{now,candidate});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  Object.assign(f.state.posts[0],{created_time:created,updated_time:created});
  f.sql('UPDATE weekly_specials SET week_start_date=?,week_end_date=? WHERE id=9000',weekStart,weekEnd);
  return f;
}
const SUNDAY={now:'2026-10-11T17:30:00Z',weekStart:'2026-10-05',weekEnd:'2026-10-11',created:'2026-10-11T14:39:46Z'};
test('integration October 11: Sunday Special and All Day publish, a staff-locked slot and disabled Nightly are untouched',async t=>{
  const f=setupDay(t,{...OCT11,evidence_version:2},SUNDAY);
  const allDay=f.slots(0,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Staff Reuben $11',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",allDay);
  await f.run();
  assert.equal(f.slots(0,'lunch')[0].content,'16" 3-Topping Pizza 12 Wings $30');
  const [one,two]=f.slots(0,'all-day');
  assert.deepEqual([one.content,one.origin],['Olive Burger w/ Side Salad, Soup Or Coleslaw $10.25','automation']);
  assert.deepEqual([two.content,two.origin,two.manual_locked],['Staff Reuben $11','manual',1]);
  assert.ok(f.slots(0,'nightly').every(s=>!s.content));
  const soup=f.sql("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='auto-week' AND g.day_of_week=0 AND g.label='Soup' AND s.position=1");
  assert.deepEqual(soup,[{content:'Beer Cheese, French Onion or Chili'}]);
  // A protected proposal is audited, never forced; repeated crons are idempotent.
  const revision=()=>f.sql("SELECT revision FROM special_collections WHERE id='auto-week'");
  const before=revision();await f.run();await f.run();
  assert.deepEqual(revision(),before);
  assert.equal(f.state.aiCalls,1);
});
test('integration October 10: an edited repost keeps each All Day meal in its published slot',async t=>{
  const f=setupDay(t,{...OCT10,evidence_version:2},{now:'2026-10-10T16:00:00Z',weekStart:'2026-10-05',weekEnd:'2026-10-11',created:'2026-10-10T14:00:00Z'});
  const allDay=f.slots(6,'all-day')[0].group_id;
  // Earlier automation published the pair in the opposite order.
  const set=(position,content)=>f.sql("UPDATE special_slots SET content=?,origin='automation',manual_locked=0,last_auto_value=? WHERE group_id=? AND position=?",content,content,allDay,position);
  set(1,'Chicken Salad Sandwich w/ cup of Soup or Coleslaw – $7.25');
  set(2,'German Burger w/ Side Salad, Soup or Coleslaw – $10.25');
  await f.run();
  assert.deepEqual(f.slots(6,'all-day').slice(0,2).map(s=>s.content),
    ['Chicken Salad Sandwich w/ cup of Soup or Coleslaw – $7.25','German Burger w/ Side Salad, Soup or Coleslaw – $10.25']);
  assert.equal(f.slots(6,'lunch')[0].content,'Philly & Fries – $11');
});
test('integration: an undetermined layout fails silently and keeps the recurring defaults',async t=>{
  const f=setupDay(t,v2(1,'Monday Specials',MEALS.slice(0,2)),{now:'2026-10-12T16:00:00Z',weekStart:'2026-10-12',weekEnd:'2026-10-18',created:'2026-10-12T14:00:00Z'});
  const allDay=f.slots(1,'all-day')[0].group_id,lunch=f.slots(1,'lunch')[0].group_id;
  f.sql("UPDATE special_slots SET content='Recurring Lunch',origin='manual',manual_locked=0 WHERE group_id=? AND position=1",lunch);
  f.sql("UPDATE special_slots SET content='Recurring All Day',origin='manual',manual_locked=0 WHERE group_id=? AND position=2",allDay);
  await f.run();
  assert.equal(f.slots(1,'lunch')[0].content,'Recurring Lunch');
  assert.equal(f.slots(1,'all-day')[1].content,'Recurring All Day');
  assert.deepEqual([...new Set(f.state.calls.map(u=>u.hostname))].sort(),['cdn.example','graph.facebook.com']);
});
