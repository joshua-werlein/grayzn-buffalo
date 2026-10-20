import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';
import {validateMexicanNight} from './reconcile.js';
import {mergeMexicanMenu,scheduleKey} from './mexican-menu.js';

// Visually verified against the archived Oct 20 poster, including its size line.
export const october20 = {type:'mexican-night',poster_evidence:"TONIGHT @ GRAYZ'N BUFFALO 5-10PM! Mexican Night Every Tuesday Night 5-10pm",schedule:'Every Tuesday Night 5-10pm',groups:[
  {label:'Entrees',items:[['2 Soft Shell ... $7.75','Meat, shredded cheese, lettuce, onion, tomato, and black olives'],['Enchilada ... $9.25',''],['Burrito ... $10.25',''],['Nacho Deluxe ... $9.75','']].map(([title,description])=>({title,description}))},
  {label:'Entrees',items:[{title:'Chimichanga ... $12.25',description:''},{title:'Taco Salad ... Large $9.00 | Small $8.50 | Mini $6.00',description:'Meat, shredded cheese, lettuce, onion, tomato, and black olives served in a shell bowl'},{title:'Chips & Salsa or Chips & Cheese ... $4.00',description:''}]},
  {label:'Substitutions & Add-ons',items:['Substitute chicken $1.50','Add nacho cheese $1.50','Substitute queso $0.50','Substitute shredded cheese for nacho cheese $0.50'].map(title=>({title,description:''}))},
  {label:'Substitutions & Add-ons',items:[{title:'Add nacho cheese or salsa +$1.50',description:''}]},
]};
const one=(title,description='')=>[{label:'Entrees',items:[{title,description}]}];
function setup(t,candidate=structuredClone(october20)) {
  const f=harness(t,{now:'2026-10-20T15:00:00Z',caption:'Mexican Night',candidate});
  Object.assign(f.state.posts[0],{created_time:'2026-10-20T14:00:00Z',updated_time:'2026-10-20T14:00:00Z'});
  return f;
}
const contents=f=>f.sql("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night' ORDER BY g.sort,s.position").map(s=>s.content);

test('October 20 complete import keeps all menu and accessory prices, canonical heading and repeat idempotency',async t=>{
  const f=setup(t);await f.run();
  const before=contents(f);
  for(const item of october20.groups.flatMap(g=>g.items)) assert.ok(before.some(c=>c.startsWith(item.title)),item.title);
  const collection=f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0];
  assert.equal(collection.title,'Mexican Night');assert.equal(scheduleKey(collection.schedule),'5pm-10pm');
  await f.run();assert.deepEqual(contents(f),before);
  assert.deepEqual(f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0],collection);
});
test('bare price lists fail closed even when the AI evidence repeats the same omission',()=>{
  const broken={...october20,groups:one('Taco Salad ... $9.00 | $8.50 | $6.00')};
  broken.groups[0].items[0].evidence=broken.groups[0].items[0].title;
  assert.throws(()=>validateMexicanNight(broken),/explicit labels/);
  broken.groups[0].items[0].evidence+=' Large $9.00 | Small $8.50 | Mini $6.00';
  assert.match(validateMexicanNight(broken).groups[0].items[0].title,/Large \$9.00 \| Small \$8.50 \| Mini \$6.00/);
});
test('contract 2 rereads omitted labels once, then persists evidence-backed associations',async t=>{
  const f=setup(t);f.env.SPECIALS_EVIDENCE_VERSION='2';
  const title='Taco Salad ... $9.00 | $8.50 | $6.00';
  let attempts=0;
  t.mock.method(f.env.AI,'run',async()=>{
    attempts++;
    const evidence=title+(attempts===1?'':' Large $9.00 | Small $8.50 | Mini $6.00');
    return {response:JSON.stringify({...october20,groups:[{label:'Entrees',items:[{title,description:'',evidence,uncertainties:[]}]}]})};
  });
  await f.run();assert.equal(attempts,2);
  assert.ok(contents(f).some(c=>c.includes('Large $9.00 | Small $8.50 | Mini $6.00')));
});
test('promotional menu entries are excluded without losing genuine foods',()=>{
  const candidate=structuredClone(october20);
  candidate.groups.push({label:'Heading',items:[{title:candidate.poster_evidence,description:''}]});
  assert.equal(validateMexicanNight(candidate).groups.length,4);
});
test('partial changes retain descriptions, omitted foods and individual accessories',()=>{
  const baseline=structuredClone(october20.groups);
  baseline[0].items[2].description='Recurring recipe';
  const merged=mergeMexicanMenu(one('Burrito $11.25'),baseline).flatMap(g=>g.items);
  assert.equal(merged.length,12);
  assert.deepEqual(merged[0],{title:'Burrito $11.25',description:'Recurring recipe'});
  for(const item of baseline.flatMap(g=>g.items).filter(i=>!i.title.startsWith('Burrito'))) assert.ok(merged.some(i=>i.title===item.title));
  assert.throws(()=>mergeMexicanMenu(one('Taco Salad $10'),baseline),/complete labelled choices/);
});
test('schedule discrepancy creates one review flag and never changes the published menu',async t=>{
  const f=setup(t);await f.run();const before=contents(f);
  f.state.posts[0].id='changed-hours';f.state.candidate.schedule='Tuesday 6-10 PM';await f.run();await f.run();
  assert.deepEqual(contents(f),before);
  assert.equal(f.sql("SELECT * FROM special_import_events WHERE detail LIKE 'REVIEW_REQUIRED_MEXICAN_SCHEDULE:%'").length,1);
});
test('partial Facebook changes preserve the actual recurring template in D1',async t=>{
  const f=setup(t,{...october20,groups:one('Burrito $11.25')});
  f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,sort,enabled) VALUES('template','mexican-night-defaults',-1,'custom','Favorites',0,1)");
  for(const [position,content] of [[1,'Burrito\nStored recipe'],[2,'Taco Salad | Large · Small · Mini'],[3,'Nacho Deluxe'],[4,'Chips & Salsa or Chips & Cheese\nAdd nacho cheese or salsa']]) f.sql("INSERT INTO special_slots(group_id,position,content) VALUES('template',?,?)",position,content);
  await f.run();
  assert.ok(contents(f).includes('Burrito $11.25\nStored recipe'));
  assert.ok(contents(f).includes('Taco Salad | Large · Small · Mini'));
  assert.ok(contents(f).includes('Chips & Salsa or Chips & Cheese\nAdd nacho cheese or salsa'));
});
