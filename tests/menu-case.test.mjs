// House capitalization for Menu and Specials text (src/lib/text-case.js).
// Run the production build first: the menu admin test exercises the compiled route.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {normalizeMenuCase,normalizeChangedMenuCase} from '../src/lib/text-case.js';
import {plan} from '../scripts/menu-case-backfill.mjs';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
const store=loadTs('src/lib/specials-store.ts');

// ── The rule ─────────────────────────────────────────────────────────────────

test('approved house examples: major words capitalized; a, an, the, and, or, of, with lowercase',()=>{
  for(const [input,expected] of [
    ['CHICKEN BACON RANCH WRAP','Chicken Bacon Ranch Wrap'],
    ['BURGER WITH FRIES','Burger with Fries'],
    ['BASKET OF FRIES','Basket of Fries'],
    ['A HALF POUND BURGER','A Half Pound Burger'],
    ['SOUP OR SALAD','Soup or Salad'],
    ['THE BEST BURGER IN TOWN','The Best Burger In Town'],
    ['CHICKEN AND BACON WRAP','Chicken and Bacon Wrap'],
    ['burger AND fries','Burger and Fries'],
    ['pulled pork OR chicken','Pulled Pork or Chicken'],
    ['ADD FRIES','Add Fries'],
  ]) assert.equal(normalizeMenuCase(input),expected,input);
});

test('uppercase, lowercase and mixed-case input reach the same result',()=>{
  const expected='Grilled Chicken Caesar Wrap w/ Waffle Fries and a Drink';
  for(const input of ['GRILLED CHICKEN CAESAR WRAP W/ WAFFLE FRIES AND A DRINK','grilled chicken caesar wrap w/ waffle fries and a drink','gRILLED Chicken cAESAR WRAP w/ Waffle FRIES And A Drink'])
    assert.equal(normalizeMenuCase(input),expected,input);
});

test('only the seven exception words stay lowercase; in, on, at, to, by and for are capitalized',()=>{
  assert.equal(normalizeMenuCase('FISH FRY WITH AN ORDER OF FRIES AND THE SOUP OF THE DAY'),'Fish Fry with an Order of Fries and the Soup of the Day');
  assert.equal(normalizeMenuCase('WINGS ON THE SIDE FOR 2 BY THE DOZEN TO GO AT 5'),'Wings On the Side For 2 By the Dozen To Go At 5');
  // Only whole words: "Orange", "Andouille", "Anchovy" and "Theater" are ordinary words.
  assert.equal(normalizeMenuCase('ORANGE CHICKEN OR ANDOUILLE WITH ANCHOVY THEATER'),'Orange Chicken or Andouille with Anchovy Theater');
  assert.equal(normalizeMenuCase('SOUP AND/OR SALAD'),'Soup and/or Salad');
  assert.equal(normalizeMenuCase('rock-AND-roll burger'),'Rock-and-Roll Burger');
});

test('the first word of an entry or line is capitalized; punctuation does not restart the entry',()=>{
  assert.equal(normalizeMenuCase('OR CHILI'),'Or Chili');
  assert.equal(normalizeMenuCase('the g mac'),'The G Mac');
  assert.equal(normalizeMenuCase('an order of fries'),'An Order of Fries');
  assert.equal(normalizeMenuCase('(with fries)'),'(With Fries)');
  assert.equal(normalizeMenuCase('burrito $9\nwith refried beans'),'Burrito $9\nWith Refried Beans');
  assert.equal(normalizeMenuCase('lettuce and mayo. with texas toast!'),'Lettuce and Mayo. with Texas Toast!');
  // A dot leader is not the end of a sentence.
  assert.equal(normalizeMenuCase('burrito ... with salsa'),'Burrito ... with Salsa');
});

test('recognized acronyms and brand capitalization are preserved',()=>{
  assert.equal(normalizeMenuCase('bbq chicken pizza'),'BBQ Chicken Pizza');
  assert.equal(normalizeMenuCase('blt w/ ff'),'BLT w/ FF');
  assert.equal(normalizeMenuCase('PBR AND MGD $2 DURING THE NFL GAME'),'PBR and MGD $2 During the NFL Game');
  assert.equal(normalizeMenuCase("BBQ'S BEST"),"BBQ's Best");
  assert.equal(normalizeMenuCase('McRib and DiGiorno'),'McRib and DiGiorno');
  assert.equal(normalizeMenuCase('rumchata shots and lacroix'),'RumChata Shots and LaCroix');
  assert.equal(normalizeMenuCase('PowerAde'),'PowerAde');
  // Stray capitals are not a brand.
  assert.equal(normalizeMenuCase('BuRgEr'),'Burger');
});

test('punctuation, apostrophes, hyphens, prices, amounts and measurements are preserved',()=>{
  for(const [input,expected] of [
    ["GRAYZ'N BURGER","Grayz'n Burger"],
    ["mom's MEATLOAF & o'brien potatoes","Mom's Meatloaf & O'Brien Potatoes"],
    ['bone-in wings $1.10 each','Bone-In Wings $1.10 each'],
    ['16” 3-TOPPING PIZZA $16','16” 3-Topping Pizza $16'],
    ['12 inch pizza $13.50/$16','12 inch Pizza $13.50/$16'],
    ['8 OZ STEAK — $18.75','8 oz Steak — $18.75'],
    ['12oz ribeye, 2nd basket half off','12oz Ribeye, 2nd Basket Half Off'],
    ["80's NIGHT: 16\"s and 12''s","80's Night: 16\"s and 12''s"],
    ['$.89 boneless wings (dine in only!)','$.89 Boneless Wings (Dine In Only!)'],
    ['lunch 11 am – 1:30 pm','Lunch 11 AM – 1:30 PM'],
    ['1/2 RACK RIBS w/o slaw','1/2 Rack Ribs w/o Slaw'],
  ]) {
    const output=normalizeMenuCase(input);
    assert.equal(output,expected,input);
    assert.equal(output.length,input.length,'only letter case changes');
  }
});

test('multiline specials keep every line break and blank line',()=>{
  const input='WING NIGHT!\n\n$.89 boneless wings\r\n$.99 BONE IN WINGS\nadd fries';
  assert.equal(normalizeMenuCase(input),'Wing Night!\n\n$.89 Boneless Wings\r\n$.99 Bone In Wings\nAdd Fries');
});

test('URLs, emails, handles, paths and markup are never rewritten',()=>{
  assert.equal(normalizeMenuCase('ORDER AT grayznbuffalo.com OR EMAIL Info@GrayznBuffalo.com'),'Order At grayznbuffalo.com or Email Info@GrayznBuffalo.com');
  assert.equal(normalizeMenuCase('see https://Example.com/Menu?ID=A and www.Example.com'),'See https://Example.com/Menu?ID=A and www.Example.com');
  assert.equal(normalizeMenuCase('follow @GrayznBuffalo #WingWednesday /img/Photo.webp'),'Follow @GrayznBuffalo #WingWednesday /img/Photo.webp');
  assert.equal(normalizeMenuCase('<b class="Hot">HOT</b> wings'),'<b class="Hot">Hot</b> Wings');
});

test('normalization is idempotent and leaves non-text values alone',()=>{
  for(const input of ['CHICKEN STRIPS W/ FRENCH FRIES & DRINK — $9.75','mac n cheese burger','Taco Salad | Large · Small · Mini\nMeat and cheese','']) {
    const once=normalizeMenuCase(input);
    assert.equal(normalizeMenuCase(once),once,input);
  }
  for(const value of [null,undefined,'','   ','$9.75','12 | 16']) assert.equal(normalizeMenuCase(value),value);
  assert.equal(normalizeChangedMenuCase('taco tuesday','Taco Tuesday'),'Taco Tuesday');
  assert.equal(normalizeChangedMenuCase('taco tuesday','taco tuesday'),'taco tuesday','unchanged stored values keep their form');
});

test('numbered entries, quoted URLs, entities and branded names keep intentional formatting',()=>{
  for (const [input, expected] of [
    ['1) THE BURGER\n• WITH FRIES', '1) The Burger\n• With Fries'],
    ['🌮 #1 THE BURGER\n$9.75 WITH FRIES', '🌮 #1 The Burger\n$9.75 With Fries'],
    ['1 OR 2 PIECE FISH', '1 or 2 Piece Fish'],
    ['WRAP $11\r\nOR SALAD $12', 'Wrap $11\r\nor Salad $12'],
    ['order at (Example.com/Menu) and iPhone or eBay', 'Order At (Example.com/Menu) and iPhone or eBay'],
    ['see https://Example.com/Menu?ID=A&amp;meal=BBQ', 'See https://Example.com/Menu?ID=A&amp;meal=BBQ'],
    ["McDonald's USDA BEEF &amp; bbq", "McDonald's USDA Beef &amp; BBQ"],
    ['GRAYZ’N BUFFALO’S BURGER', 'Grayz’n Buffalo’s Burger'],
  ]) {
    assert.equal(normalizeMenuCase(input),expected);
    assert.equal(normalizeMenuCase(expected),expected);
    assert.equal(input.length,expected.length);
  }
});

test('changing a link alone leaves the stored special text and automation baseline untouched',()=>{
  const previous={id:'test',kind:'week',title:'',groups:[{id:'g',label:'Lunch',slots:[{
    position:1,content:'legacy text',price:'',section_link:'',origin:'automation',manual_locked:0,last_auto_value:'legacy text',
  }]}]};
  const next=structuredClone(previous);next.groups[0].slots[0].section_link='mexican-night';
  assert.equal(store.withMenuCase(next,previous).groups[0].slots[0].content,'legacy text');
});

// ── Staff editors ────────────────────────────────────────────────────────────

const weekFor=async f=>{
  const id=f.sql("SELECT id FROM special_collections WHERE kind='week' LIMIT 1")[0].id;
  const collection=await store.readCollection(f.env,id);
  const week=f.sql('SELECT * FROM weekly_specials WHERE id=?',collection.weekly_special_id)[0];
  return {collection,dates:{start:week.week_start_date,end:week.week_end_date}};
};
const slotRow=(f,group,position)=>f.sql('SELECT * FROM special_slots WHERE group_id=? AND position=?',group,position)[0];

test('weekly editor saves the house capitalization; untouched legacy text and its ownership stay exactly as stored',async t=>{
  const f=fixture(t);const {collection,dates}=await weekFor(f);
  const lunch=collection.groups.find(g=>g.service==='lunch' && g.day_of_week===1);
  const nightly=collection.groups.find(g=>g.service==='nightly' && g.day_of_week===1);
  // An automation value written before this rule existed.
  f.sql("UPDATE special_slots SET content='chicken strips w/ fries',origin='automation',manual_locked=0,last_auto_value='chicken strips w/ fries',manual_edited_at=NULL WHERE group_id=? AND position=1",nightly.id);
  const next=await store.readCollection(f.env,collection.id);
  next.groups.find(g=>g.id===lunch.id).slots[0].content='PULLED PORK OR CHICKEN SANDWICH AND A DRINK $9.75';
  await store.saveCollection(f.env,next,dates);
  assert.equal(slotRow(f,lunch.id,1).content,'Pulled Pork or Chicken Sandwich and a Drink $9.75');
  const untouched=slotRow(f,nightly.id,1);
  assert.deepEqual([untouched.content,untouched.origin,untouched.manual_locked,untouched.last_auto_value,untouched.manual_edited_at],
    ['chicken strips w/ fries','automation',0,'chicken strips w/ fries',null]);
});

test('repeated saves are idempotent: retyping a special in another case is not a staff edit',async t=>{
  const f=fixture(t);const {collection,dates}=await weekFor(f);
  const lunch=collection.groups.find(g=>g.service==='lunch' && g.day_of_week===2);
  f.sql("UPDATE special_slots SET content='Taco Salad and a Drink $9.75',origin='automation',manual_locked=0,last_auto_value='Taco Salad and a Drink $9.75',manual_edited_at=NULL WHERE group_id=? AND position=1",lunch.id);
  const before=await store.readCollection(f.env,collection.id);
  const retyped=structuredClone(before);retyped.groups.find(g=>g.id===lunch.id).slots[0].content='TACO SALAD AND A DRINK $9.75';
  const saved=await store.saveCollection(f.env,retyped,dates);
  assert.equal(saved.revision,before.revision,'nothing to write');
  const slot=slotRow(f,lunch.id,1);
  assert.deepEqual([slot.content,slot.origin,slot.last_auto_value,slot.manual_edited_at],['Taco Salad and a Drink $9.75','automation','Taco Salad and a Drink $9.75',null]);
  // Saving the saved value again changes nothing either.
  const again=await store.saveCollection(f.env,await store.readCollection(f.env,collection.id),dates);
  assert.equal(again.revision,before.revision);
});

test('recurring defaults are normalized and new weeks copy them with their default ownership',async t=>{
  const f=fixture(t);const defaults=await store.readCollection(f.env,'defaults');
  const group=defaults.groups.find(g=>g.day_of_week===1 && g.service==='lunch');
  group.slots[0].content='hot ham AND a drink $9.75';
  await store.saveCollection(f.env,defaults);
  const saved=await store.readCollection(f.env,'defaults');
  assert.equal(saved.groups.find(g=>g.id===group.id).slots[0].content,'Hot Ham and a Drink $9.75');
  const week=store.newWeekFromDefaults(saved);
  const copied=week.groups.find(g=>g.day_of_week===1 && g.service==='lunch').slots[0];
  assert.deepEqual([copied.content,copied.origin,copied.manual_locked],['Hot Ham and a Drink $9.75','manual',0]);
});

test('Mexican Night editor normalizes title, group label and multiline items without touching prices or the schedule',async t=>{
  const f=fixture(t);const mexican=await store.readCollection(f.env,'mexican-night');
  const group=store.blankGroup(-1,0);group.label='COMBO PLATTERS';
  group.slots[0].content='CHIMICHANGA....$11.99\nflour tortilla FILLED with beef AND beans\n\nsour cream OR guacamole';
  mexican.groups=[group];mexican.title='mexican night';mexican.schedule='Tuesdays · 5 – 10 pm';
  await store.saveCollection(f.env,mexican);
  const saved=await store.readCollection(f.env,'mexican-night');
  assert.equal(saved.title,'Mexican Night');
  assert.equal(saved.schedule,'Tuesdays · 5 – 10 pm','schedules are times, never rewritten');
  assert.equal(saved.groups[0].label,'Combo Platters');
  assert.equal(saved.groups[0].slots[0].content,'Chimichanga....$11.99\nFlour Tortilla Filled with Beef and Beans\n\nSour Cream or Guacamole');
});

test('Wing Wednesday editor: a case-only name edit never claims a price; a staff price still locks',async t=>{
  t.mock.method(Date,'now',()=>Date.parse('2030-01-08T18:00:00Z'));
  const f=fixture(t);const wing=await store.readCollection(f.env,'wing-wednesday');
  const options=wing.groups.find(g=>g.id==='ww-live:ww-default:wings');
  options.slots[0].content='BONE-IN WINGS $1.25 EACH\nstaff description';
  options.slots[1].content='boneless wings';
  await store.saveCollection(f.env,wing);
  const [boneIn,boneless]=[slotRow(f,options.id,1),slotRow(f,options.id,2)];
  assert.equal(boneIn.content,'Bone-In Wings $1.25 each\nStaff Description');
  assert.equal(boneIn.manual_locked,1,'a price staff entered is locked');
  assert.equal(boneless.content,'Boneless Wings');
  assert.equal(boneless.manual_locked,0,'a name without a price is not');
});

test('accepting an import candidate normalizes the content staff publish',async t=>{
  const f=fixture(t);
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,target_kind,target_day,target_service,target_collection_id,candidate_json,processing_status,validation_result,review_status,fetched_at)
    VALUES('menu-case','post','2030-01-01T00:00:00Z','section',-1,'custom','mexican-night',?, 'staged','ok','pending','2020-01-01T00:00:00')`,
    JSON.stringify([{label:'TACO TUESDAY',day_of_week:-1,service:'custom',items:[{content:'TACOS AL PASTOR',price:'$13'}]}]));
  const before=await store.readCollection(f.env,'mexican-night');
  await store.applyCandidate(f.env,'menu-case',null,before.revision);
  const after=await store.readCollection(f.env,'mexican-night');
  const group=after.groups.find(g=>g.label==='Taco Tuesday');
  assert.equal(group?.slots[0].content,'Tacos Al Pastor $13');
  assert.equal(f.sql("SELECT candidate_json FROM special_imports WHERE id='menu-case'")[0].candidate_json.includes('TACOS AL PASTOR'),true,'import evidence is never rewritten');
});

// ── Menu editor ──────────────────────────────────────────────────────────────

const menuTables=f=>{
  const schema=readFileSync('schema.sql','utf8');
  for(const table of ['categories','items']) f.sql(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0]);
  f.sql("INSERT INTO categories(id,name,sort) VALUES(1,'Burgers',0)");
};

test('compiled menu editor saves item names, descriptions and section names in the house capitalization',async t=>{
  const page=(await import('../dist/_worker.js/pages/admin/menu.astro.mjs')).page().default;
  const container=await AstroContainer.create();
  const f=fixture(t);menuTables(f);f.env.SESSIONS={get:async()=>'1'};
  const post=fields=>{
    const body=new FormData();for(const [k,v] of Object.entries(fields)) body.set(k,v);
    return container.renderToResponse(page,{request:new Request('http://localhost/admin/menu',{method:'POST',
      headers:{origin:'http://localhost',cookie:'gb_session='+'a'.repeat(32),accept:'application/json'},body}),locals:{runtime:{env:f.env}}});
  };
  assert.equal((await (await post({action:'add',category_id:'1',name:'BBQ BACON BURGER',description:'bacon, cheddar AND bbq sauce. lettuce OR tomato.'})).json()).ok,true);
  const added=f.sql('SELECT id,name,description FROM items')[0];
  assert.deepEqual([added.name,added.description],['BBQ Bacon Burger','Bacon, Cheddar and BBQ Sauce. Lettuce or Tomato.']);
  const loaded={was_name:added.name,was_description:added.description,was_category_id:'1',was_late_night:'0'};
  const edited=await (await post({action:'edit',id:String(added.id),category_id:'1',name:"grayz'n burger",description:'ham, cheddar AND swiss',...loaded})).json();
  assert.deepEqual([edited.name,edited.description],["Grayz'n Burger",'Ham, Cheddar and Swiss'],'the editor shows the saved text');
  assert.deepEqual(f.sql('SELECT name,description FROM items WHERE id=?',added.id)[0],{name:"Grayz'n Burger",description:'Ham, Cheddar and Swiss'});
  await post({action:'edit-section',category_id:'1',name:'on the lighter side',subtitle:'Tuesdays · 5–10 pm',note:'ask about substitutions',was_name:'Burgers',was_subtitle:'',was_note:''});
  assert.deepEqual(f.sql('SELECT name,subtitle,note FROM categories WHERE id=1')[0],{name:'On the Lighter Side',subtitle:'Tuesdays · 5–10 pm',note:'ask about substitutions'});
});

// ── Existing content backfill ────────────────────────────────────────────────

test('backfill plans guarded, idempotent updates for live Menu and Specials text only',async t=>{
  const f=fixture(t);menuTables(f);
  f.sql("INSERT INTO items(id,category_id,name,description) VALUES(1,1,'CHICKEN BACON RANCH WRAP','bacon AND ranch'),(2,1,'Taco Salad','')");
  const {collection}=await weekFor(f);
  f.sql("UPDATE weekly_specials SET week_end_date='2099-12-31' WHERE id=?",collection.weekly_special_id);
  const live=collection.groups.find(g=>g.service==='lunch' && g.day_of_week===1).id;
  const staff=collection.groups.find(g=>g.service==='lunch' && g.day_of_week===2).id;
  const risky=collection.groups.find(g=>g.service==='lunch' && g.day_of_week===3).id;
  f.sql("UPDATE special_slots SET content='hot ham AND a drink',origin='automation',manual_locked=0,last_auto_value='hot ham AND a drink' WHERE group_id=? AND position=1",live);
  f.sql("UPDATE special_slots SET content='staff BURGER',origin='manual',manual_locked=0,last_auto_value='Old Poster' WHERE group_id=? AND position=1",staff);
  // Normalizing this staff value would equal its automation baseline and look automation-owned.
  f.sql("UPDATE special_slots SET content='TACO SALAD',origin='manual',manual_locked=0,last_auto_value='Taco Salad' WHERE group_id=? AND position=1",risky);
  // A past week and Facebook import evidence are history and stay untouched.
  f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(4242,'2001-01-01','2001-01-07')");
  f.sql("INSERT INTO special_collections(id,kind,weekly_special_id) VALUES('week:past','week',4242)");
  f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label) VALUES('past:lunch','week:past',1,'lunch','lunch')");
  f.sql("INSERT INTO special_slots(group_id,position,content) VALUES('past:lunch',1,'OLD SPECIAL')");
  f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time,caption,candidate_json) VALUES('evidence','post','2030-01-01T00:00:00Z','HOT HAM AND A DRINK','{\"offers\":[{\"content\":\"HOT HAM\"}]}')");
  const db=new DatabaseSync(f.path);
  try {
    const {changes,skipped}=plan(db,'2030-01-01');
    const labels=changes.map(c=>c.label);
    assert.ok(labels.includes('items.name id=1') && labels.includes('items.description id=1') && !labels.some(l=>/\bid=2\b/.test(l)));
    assert.ok(!labels.some(l=>l.includes('past:lunch')),'past weeks are history');
    assert.deepEqual(skipped.map(s=>s.after),['Taco Salad']);
    db.exec('BEGIN');for(const c of changes) db.prepare(c.apply).run();db.exec('COMMIT');
    const row=group=>db.prepare('SELECT content,origin,manual_locked,last_auto_value FROM special_slots WHERE group_id=? AND position=1').get(group);
    assert.deepEqual({...row(live)},{content:'Hot Ham and a Drink',origin:'automation',manual_locked:0,last_auto_value:'Hot Ham and a Drink'},'automation keeps ownership');
    assert.deepEqual({...row(staff)},{content:'Staff Burger',origin:'manual',manual_locked:0,last_auto_value:'Old Poster'},'staff edit stays a staff edit');
    assert.equal(row(risky).content,'TACO SALAD');
    assert.equal(row('past:lunch').content,'OLD SPECIAL');
    assert.deepEqual({...db.prepare("SELECT caption,candidate_json FROM special_imports WHERE id='evidence'").get()},{caption:'HOT HAM AND A DRINK',candidate_json:'{"offers":[{"content":"HOT HAM"}]}'});
    assert.equal(db.prepare('SELECT name FROM items WHERE id=1').get().name,'Chicken Bacon Ranch Wrap');
    assert.equal(plan(db,'2030-01-01').changes.length,0,'a second run has nothing to change');
    let reapplied=0;for(const c of changes) reapplied+=Number(db.prepare(c.apply).run().changes);
    assert.equal(reapplied,0,'re-running apply.sql changes nothing');
    for(const c of changes) db.prepare(c.rollback).run();
    assert.deepEqual({...row(live)},{content:'hot ham AND a drink',origin:'automation',manual_locked:0,last_auto_value:'hot ham AND a drink'},'rollback restores the exact prior values');
  } finally { db.close(); }
});

test('a backfill skips a concurrent ownership or parent revision change even when text is unchanged',t=>{
  const f=fixture(t);menuTables(f);
  const group=f.sql("SELECT id FROM special_groups WHERE collection_id='defaults' LIMIT 1")[0].id;
  f.sql("UPDATE special_slots SET content='STAFF SPECIAL',origin='manual',manual_locked=0 WHERE group_id=? AND position=1",group);
  const db=new DatabaseSync(f.path);
  try {
    const change=plan(db,'2030-01-01').changes.find(c=>c.label===`special_slots.content group_id='${group}' AND position=1`);
    assert.ok(change);
    db.prepare('UPDATE special_slots SET manual_locked=1 WHERE group_id=? AND position=1').run(group);
    assert.equal(Number(db.prepare(change.apply).run().changes),0,'a new staff lock fences the exported plan');
    db.prepare('UPDATE special_slots SET manual_locked=0 WHERE group_id=? AND position=1').run(group);
    db.exec("UPDATE special_collections SET revision=revision+1 WHERE id='defaults'");
    assert.equal(Number(db.prepare(change.apply).run().changes),0,'a concurrent collection save fences the exported plan');
    assert.equal(db.prepare('SELECT content FROM special_slots WHERE group_id=? AND position=1').get(group).content,'STAFF SPECIAL');
  } finally {db.close();}
});
