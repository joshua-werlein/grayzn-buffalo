import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMexicanNight,containsConsumerAdvisory,validateEvidence} from './reconcile.js';
import {harness, offer, poster} from './test-fixture.js';
import {reconcileMexicanNight} from './guarded-auto.js';
import {PARSER_VERSION} from './classify.js';
import {composeMexicanItem,splitMexicanItem,MEXICAN_ITEM_LIMIT,mexicanDisplayTitle,normalizeMexicanPrices} from '../../src/lib/mexican-item.js';
import {mexicanNightExtractionPrompt,extractionPrompt} from './extraction.js';

const entrees = [
  {description: '', title: '2 Soft Shell $8.50'},
  {description: '', title: 'Burrito $9.00'},
  {description: '', title: 'Chimichanga $9.00'},
  {description: '', title: 'Enchilada $8.50'},
];
const extras = [
  {description: '', title: 'Nacho Deluxe'},
  {description: '', title: 'Taco Salad — Large $9.50 / Small $7.50 / Mini $5.50'},
  {description: '', title: 'Chips & Salsa or Chips & Cheese'},
];
const addons = [
  {description: '', title: 'Substitute chicken $1.00'},
  {description: '', title: 'Add nacho cheese $0.75'},
  {description: '', title: 'Substitute queso $0.75'},
  {description: '', title: 'Substitute shredded cheese for nacho cheese $0.75'},
];

// Faithful extraction of the October 6, 2026 production poster: printed dot leaders,
// size labels, every column (including Nacho Deluxe) and the unlabeled add-on banner.
const octoberPosterGroups = () => [
  {label: 'Entrees', items: [
    {title: '2 Soft Shell ... $7.75', description: 'Meat, shredded cheese, lettuce, onion, tomato, and black olives'},
    {title: 'Burrito ... $10.25', description: 'Meat, refried beans, shredded cheese, lettuce, onion, and tomato rolled up in a tortilla. Topped with shredded cheese, black olives, and enchilada sauce'},
    {title: 'Chimichanga ... $12.25', description: 'Meat, refried beans, shredded cheese, and onion rolled up in a tortilla and fried. Topped with enchilada sauce, black olives, and shredded cheese. Lettuce and tomato on the side'},
    {title: 'Enchilada ... $9.25', description: 'Meat, refried beans, shredded cheese, and onion rolled up in a tortilla. Topped with enchilada sauce, black olives, and shredded cheese. Lettuce and tomato on the side'},
  ]},
  {label: 'More', items: [
    {title: 'Nacho Deluxe ... $9.75', description: 'Meat, lettuce, onion, tomato, black olives, and nacho cheese served on top of chips'},
    {title: 'Taco Salad ... Large $9.00 | Small $8.50 | Mini $6.00', description: 'Meat, shredded cheese, lettuce, onion, tomato, and black olives served in a shell bowl'},
    {title: 'Chips & Salsa or Chips & Cheese ... $4.00', description: 'Add nacho cheese or salsa +$1.50'},
  ]},
  {label: 'Substitutions & Add-ons', items: [
    {title: 'Substitute chicken $1.50', description: ''},
    {title: 'Add Nacho Cheese $1.50', description: ''},
    {title: 'Substitute queso 50c', description: ''},
    {title: 'Substitute Shredded Cheese for Nacho Cheese 50c', description: ''},
  ]},
];

function mexicanNightCandidate(overrides = {}) {
  return {
    type: 'mexican-night',
    poster_evidence: 'Mexican Night',
    schedule: 'Tuesdays 5–10 PM',
    groups: [
      {label: 'Entrees', items: entrees},
      {label: 'Extras', items: extras},
      {label: 'Add-Ons', items: addons},
    ],
    ...overrides,
  };
}

function mnHarness(t, options = {}) {
  const f = harness(t, {
    now: '2030-01-14T15:00:00Z',
    caption: 'Mexican Night',
    candidate: mexicanNightCandidate(),
    ...options,
  });
  Object.assign(f.state.posts[0], {created_time: '2030-01-14T14:00:00Z', updated_time: '2030-01-14T14:00:00Z'});
  return f;
}

const mnGroups = f => f.sql("SELECT * FROM special_groups WHERE collection_id='mexican-night' ORDER BY sort,id");
const mnSlots = f => f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night' ORDER BY g.sort,g.id,s.position");
const mnCollection = f => f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0];

const advisoryFooter = '*Consuming raw or undercooked meats, eggs, and seafood may cause foodborne illness.';
const alternateFooter = 'Consuming raw or undercooked meats, poultry, seafood, shellfish, or eggs may increase your risk of foodborne illness.';
for (const label of ['Entrees','Add-Ons','Substitutions']) {
  for (const field of ['title','description']) test(`consumer advisory in ${label} ${field} rejects the entire candidate`,()=>{
    const item={title:'Burrito $10.25',description:''};item[field]=advisoryFooter;
    assert.throws(()=>validateMexicanNight(mexicanNightCandidate({groups:[{label,items:[item]}]})),/consumer advisory/);
  });
}

test('advisory detection handles alternate wording, punctuation, case and split fields',()=>{
  for(const text of [alternateFooter,'*CONSUMING RAW / OR UNDER-COOKED MEATS: may cause FOOD-BORNE ILLNESS!','May increase your risk of foodborne illness.']) {
    assert.equal(containsConsumerAdvisory(text),true);
    assert.throws(()=>validateMexicanNight(mexicanNightCandidate({groups:[{label:'Food',items:[{title:'Taco',description:text}]}]})),/consumer advisory/);
  }
  assert.throws(()=>validateMexicanNight(mexicanNightCandidate({groups:[{label:'Food',items:[{title:'Consuming raw',description:'or undercooked meats'}]}]})),/consumer advisory/);
  assert.throws(()=>validateMexicanNight(mexicanNightCandidate({groups:[{label:'Foodborne illness warning',items:[{title:'Taco',description:''}]}]})),/consumer advisory/);
});

test('normal meat, egg, seafood descriptions and title-only add-ons remain valid verbatim',()=>{
  const items=[
    {title:'Burrito - $10.25',description:'Meat, refried beans, shredded cheese'},
    {title:'Taco Salad - Large $9.00 / Small $8.50 / Mini $6.00',description:'Meat, shredded cheese, lettuce'},
    {title:'Egg taco',description:'Egg, cheese and salsa'},
    {title:'Seafood taco',description:'Seafood, chicken and slaw'},
    {title:'Substitute chicken +$1.50',description:''},
    {title:'Add nacho cheese +$1.50',description:''},
  ];
  const candidate=mexicanNightCandidate({groups:[{label:'Entrees',items:items.slice(0,4)},{label:'Add-Ons',items:items.slice(4)}]});
  assert.deepEqual(validateMexicanNight(candidate),candidate);
  for(const item of items) assert.equal(containsConsumerAdvisory(composeMexicanItem(item.title,item.description)),false);
});

test('advisory rejection makes zero live menu writes and preserves the complete existing collection',async t=>{
  const f=mnHarness(t);await f.run();
  const snapshot=()=>JSON.stringify({collection:mnCollection(f),groups:mnGroups(f),slots:mnSlots(f)});
  const before=snapshot();
  // SQLite triggers count attempted menu mutations, including writes that might
  // otherwise leave the same final content. Import audit writes remain allowed.
  f.sql('CREATE TABLE menu_write_probe(n INTEGER)');
  for(const table of ['special_collections','special_groups','special_slots']) {
    for(const operation of ['INSERT','UPDATE','DELETE']) f.sql(`CREATE TRIGGER probe_${table}_${operation} AFTER ${operation} ON ${table} BEGIN INSERT INTO menu_write_probe VALUES(1); END`);
  }
  let index=0;
  for(const label of ['Entrees','Add-Ons']) for(const field of ['title','description']) {
    f.state.posts=[{...f.state.posts[0],id:`bad-${++index}`}];
    const item={title:'Burrito $10.25',description:''};item[field]=advisoryFooter;
    f.state.candidate=mexicanNightCandidate({groups:[{label,items:[item]}]});
    await f.run();
    const row=f.imports().at(-1);
    assert.equal(row.validation_result,'rejected');
    assert.match(row.validation_reason,/consumer advisory/);
    assert.equal(row.candidate_json,null);
    assert.equal(snapshot(),before);
  }
  assert.deepEqual(f.sql('SELECT * FROM menu_write_probe'),[]);
});

test('Mexican title/description contract rejects malformed items and enforces composed limit',()=>{
  const validate=item=>validateMexicanNight(mexicanNightCandidate({groups:[{label:'Entrees',items:[item]}]}));
  for(const item of [{content:'Old v9 shape'}, {description:''}, {title:'',description:''}, {title:'T'}, {title:'T',description:null}, {title:2,description:''}, {title:'T\nX',description:''}, {title:'T'.repeat(150),description:'D'.repeat(150)}]) assert.throws(()=>validate(item));
  const item={title:'T'.repeat(150),description:'D'.repeat(149)};
  assert.deepEqual(validate(item).groups[0].items[0],item);
  assert.equal(composeMexicanItem(item.title,item.description).length,MEXICAN_ITEM_LIMIT);
});

test('Mexican Night items between 151 and 300 characters validate; over 300 is rejected',()=>{
  const validate=item=>validateMexicanNight(mexicanNightCandidate({groups:[{label:'Entrees',items:[item]}]}));
  assert.equal(MEXICAN_ITEM_LIMIT,300);
  for(const length of [151,200,300]) {
    const item={title:'Burrito $10.25',description:'D'.repeat(length-'Burrito $10.25'.length-1)};
    assert.equal(composeMexicanItem(item.title,item.description).length,length);
    assert.deepEqual(validate(item).groups[0].items[0],item);
  }
  assert.throws(()=>validate({title:'Burrito $10.25',description:'D'.repeat(300-'Burrito $10.25'.length)}),/300 characters/);
  assert.throws(()=>composeMexicanItem('A'.repeat(301),''),/300 characters/);
});

test('ordinary daily offers still reject content over 150 characters',()=>{
  const daily=content=>validateEvidence({day_of_week:3,day_evidence:'Wednesday',poster_evidence:'Wednesday Specials',offers:[{content,service_time:'',evidence:''}]});
  assert.equal(daily('A'.repeat(150)).offers.length,1);
  assert.throws(()=>daily('A'.repeat(151)),/Invalid offer evidence/);
});

test('full-length October 6 poster descriptions validate verbatim with prices',async t=>{
  const f=mnHarness(t,{candidate:mexicanNightCandidate({groups:octoberPosterGroups()})});
  const validated=validateMexicanNight(mexicanNightCandidate({groups:octoberPosterGroups()}));
  assert.deepEqual(validated.groups,octoberPosterGroups());
  const lengths=validated.groups.flatMap(g=>g.items.map(i=>composeMexicanItem(i.title,i.description).length));
  assert.ok(lengths.filter(n=>n>150).length===3 && Math.max(...lengths)<=300,`lengths ${lengths}`);
  await f.run();
  assert.equal(mnCollection(f).section_source,'facebook');
  const contents=mnSlots(f).map(s=>s.content);
  // Food evidence is stored verbatim, including the printed leaders.
  for(const item of octoberPosterGroups().slice(0,2).flatMap(g=>g.items)) assert.ok(contents.includes(composeMexicanItem(item.title,item.description)),`missing ${item.title}`);
  assert.ok(contents.includes(composeMexicanItem('Nacho Deluxe ... $9.75','Meat, lettuce, onion, tomato, black olives, and nacho cheese served on top of chips')));
  assert.ok(contents.some(c=>c.startsWith('Taco Salad ... Large $9.00 | Small $8.50 | Mini $6.00\n')));
  // The banner becomes the one canonical accessory group, with every price in USD format.
  const accessoryGroups=mnGroups(f).filter(g=>g.label==='Substitutions & Add-ons');
  assert.equal(accessoryGroups.length,1);
  assert.deepEqual(f.sql('SELECT content FROM special_slots WHERE group_id=? ORDER BY position',accessoryGroups[0].id).map(s=>s.content),
    ['Substitute chicken $1.50','Add Nacho Cheese $1.50','Substitute queso $0.50','Substitute Shredded Cheese for Nacho Cheese $0.50']);
  assert.equal(mnSlots(f).length,11);
  assert.ok(mnSlots(f).every(s=>s.price===''));
  // Candidate evidence keeps the printed 50c; only the published accessory text is normalized.
  assert.match(f.imports()[0].candidate_json,/Substitute queso 50c/);
});

test('automated descriptions use canonical admin format across seven foods and add-ons',async t=>{
  const f=mnHarness(t);
  f.state.candidate.groups[0].items=f.state.candidate.groups[0].items.map(item=>({...item,description:'Beans\nSalsa'}));
  await f.run();
  const slots=mnSlots(f);
  assert.equal(slots.length,11);
  assert.equal(slots[0].content,composeMexicanItem(entrees[0].title,'Beans\nSalsa'));
  assert.deepEqual(splitMexicanItem(slots[0].content),{title:entrees[0].title,description:'Beans\nSalsa'});
  assert.equal(slots[7].content,addons[0].title);
  assert.equal(PARSER_VERSION,18);
});

test('validateMexicanNight accepts valid complete poster', () => {
  const result = validateMexicanNight(mexicanNightCandidate());
  assert.equal(result.type, 'mexican-night');
  assert.equal(result.poster_evidence, 'Mexican Night');
  assert.equal(result.schedule, 'Tuesdays 5–10 PM');
  assert.equal(result.groups.length, 3);
  assert.equal(result.groups[0].items.length, 4);
  assert.equal(result.groups[0].items[0].title, '2 Soft Shell $8.50');
});

test('validateMexicanNight rejects non-object', () => {
  assert.throws(() => validateMexicanNight(null));
  assert.throws(() => validateMexicanNight([]));
});

test('validateMexicanNight rejects wrong type field', () => {
  assert.throws(() => validateMexicanNight({...mexicanNightCandidate(), type: 'weekly-lunch'}));
  assert.throws(() => validateMexicanNight({...mexicanNightCandidate(), type: 'poster'}));
});

test('validateMexicanNight rejects poster_evidence without Mexican Night phrase', () => {
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), poster_evidence: 'Tuesday Specials'}),
    /mexican night/i
  );
});

test('validateMexicanNight rejects schedule over 80 chars', () => {
  assert.throws(() => validateMexicanNight({...mexicanNightCandidate(), schedule: 'A'.repeat(81)}));
});

test('validateMexicanNight rejects empty groups array', () => {
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: []}),
    /1-12/
  );
});

test('validateMexicanNight rejects more than 12 groups', () => {
  const manyGroups = Array.from({length: 13}, (_, i) => ({label: `Group ${i}`, items: [{description: '', title: 'Item'}]}));
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: manyGroups}),
    /1-12/
  );
});

test('validateMexicanNight rejects group with empty label', () => {
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: [{label: '', items: [{description: '', title: 'Item'}]}]}),
    /label/i
  );
});

test('validateMexicanNight rejects group with more than 4 items', () => {
  const tooManyItems = Array.from({length: 5}, () => ({description: '', title: 'Item'}));
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: [{label: 'Group', items: tooManyItems}]}),
    /1-4/
  );
});

test('validateMexicanNight rejects item with whitespace-only content', () => {
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: [{label: 'Group', items: [{description: '', title: '   '}]}]}),
    /title|150/i
  );
});

test('validateMexicanNight rejects item content over 300 chars', () => {
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: [{label: 'Group', items: [{description: '', title: 'A'.repeat(301)}]}]}),
    /title|300/i
  );
});

test('validateMexicanNight accepts null schedule (defaults to empty string)', () => {
  const result = validateMexicanNight({...mexicanNightCandidate(), schedule: null});
  assert.equal(result.schedule, '');
});

test('validateMexicanNight preserves prices, sizes, and add-on text exactly', () => {
  const result = validateMexicanNight(mexicanNightCandidate());
  assert.equal(result.groups[0].items[1].title, entrees[1].title);
});

test('clear Mexican Night poster replaces all groups and items', async t => {
  const f = mnHarness(t);
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  assert.ok(mnSlots(f).some(s => s.content === entrees[0].title));
  assert.ok(mnSlots(f).some(s => s.content === extras[0].title));
  assert.ok(mnSlots(f).some(s => s.content === addons[0].title));
  assert.equal(f.imports()[0].validation_result, 'ok');
});

test('second poster replaces food groups; accessory groups are preserved', async t => {
  const f = mnHarness(t);
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  f.state.posts = [{...f.state.posts[0], id: 'p2', created_time: '2030-01-14T14:30:00Z', updated_time: '2030-01-14T14:30:00Z'}];
  f.state.candidate = mexicanNightCandidate({groups: [{label: 'Limited Menu', items: [{description: '', title: 'Special Burrito $10'}]}]});
  await f.run();
  // Non-accessory groups replaced; Add-Ons group from first poster persists
  const groups = mnGroups(f);
  assert.equal(groups.length, 2);
  assert.ok(groups.some(g => g.label === 'Limited Menu'));
  assert.ok(groups.some(g => g.label === 'Add-Ons'));
  assert.ok(mnSlots(f).some(s => s.content === 'Special Burrito $10'));
  assert.ok(!mnSlots(f).some(s => s.content === entrees[0].title));
  // Add-Ons slots from first poster remain
  for (const addon of addons) assert.ok(mnSlots(f).some(s => s.content === addon.title), `missing: ${addon.title}`);
});

test('prices, sizes, and add-ons are preserved verbatim', async t => {
  const f = mnHarness(t);
  await f.run();
  assert.ok(mnSlots(f).some(s => s.content === 'Taco Salad — Large $9.50 / Small $7.50 / Mini $5.50'));
  for (const addon of addons) {
    assert.ok(mnSlots(f).some(s => s.content === addon.title), `missing addon: ${addon.title}`);
  }
});

test('no new Mexican Night post leaves the section unchanged', async t => {
  const f = mnHarness(t, {week: false});
  f.state.posts = [];
  await f.run();
  assert.equal(mnGroups(f).length, 0);
});

test('failed extraction leaves Mexican Night unchanged', async t => {
  const f = mnHarness(t);
  f.state.candidate = {type: 'mexican-night', poster_evidence: 'Tuesday Specials', groups: [{label: 'A', items: [{description: '', title: 'B'}]}]};
  await f.run();
  assert.equal(mnGroups(f).length, 0);
  assert.equal(f.imports()[0].validation_result, 'rejected');
});

test('accessory groups survive a Facebook update that omits them', async t => {
  const f = mnHarness(t);
  // First run seeds the collection with Entrees + Extras + Add-Ons
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  assert.ok(mnGroups(f).some(g => g.label === 'Add-Ons'));
  // Second post mentions only food items — no Substitutions or Add-Ons section
  f.state.posts = [{...f.state.posts[0], id: 'p2', created_time: '2030-01-14T14:30:00Z', updated_time: '2030-01-14T14:30:00Z'}];
  f.state.candidate = mexicanNightCandidate({groups: [{label: 'Entrees', items: entrees}]});
  await f.run();
  const groups = mnGroups(f);
  // Food group replaced; Add-Ons preserved because Facebook did not mention them
  assert.ok(groups.some(g => g.label === 'Entrees'));
  assert.ok(groups.some(g => g.label === 'Add-Ons'), 'Add-Ons group should survive update that omits it');
  for (const addon of addons) assert.ok(mnSlots(f).some(s => s.content === addon.title), `missing: ${addon.title}`);
  // Extras group from first poster removed (it is not an accessory group)
  assert.ok(!groups.some(g => g.label === 'Extras'));
});

test('Facebook with explicit accessory group replaces recurring accessory, no duplicates', async t => {
  const f = mnHarness(t);
  // First run: seeds Entrees + Extras + Add-Ons from defaults
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  const oldAddonSlots = mnSlots(f).filter(s => addons.some(a => a.title === s.content));
  assert.ok(oldAddonSlots.length > 0, 'should have existing Add-Ons slots');

  // Second post explicitly provides an updated "Add-Ons" group with changed values
  const newAddons = [
    {description: '', title: 'Substitute chicken +$2.00'},
    {description: '', title: 'Add queso +$1.00'},
  ];
  f.state.posts = [{...f.state.posts[0], id: 'p2', created_time: '2030-01-14T14:30:00Z', updated_time: '2030-01-14T14:30:00Z'}];
  f.state.candidate = mexicanNightCandidate({groups: [
    {label: 'Entrees', items: entrees},
    {label: 'Add-Ons', items: newAddons},
  ]});
  await f.run();

  const groups = mnGroups(f);
  const slots = mnSlots(f);

  // Exactly one Add-Ons group — no duplicate
  const addonGroups = groups.filter(g => g.label === 'Add-Ons');
  assert.equal(addonGroups.length, 1, 'must have exactly one Add-Ons group after FB explicit replacement');

  // Facebook's new values are present
  for (const item of newAddons) assert.ok(slots.some(s => s.content === item.title), `missing new addon: ${item.title}`);

  // Old recurring values are gone
  for (const old of addons) assert.ok(!slots.some(s => s.content === old.title), `stale old addon still present: ${old.title}`);

  // Entrees group present; no stale Extras group
  assert.ok(groups.some(g => g.label === 'Entrees'));
  assert.ok(!groups.some(g => g.label === 'Extras'), 'Extras from first poster should be gone');
});

test('ordinary Tuesday Specials poster does not touch Mexican Night', async t => {
  const f = harness(t, {
    now: '2030-01-14T15:00:00Z',
    caption: 'Tuesday Specials',
    candidate: poster(2, 'Tuesday Specials', [offer('Some special $9')]),
  });
  await f.run();
  assert.equal(mnGroups(f).length, 0);
});

test('source already applied: subsequent run does not overwrite admin edit', async t => {
  const f = mnHarness(t);
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  const groupId = mnGroups(f)[0].id;
  f.sql("UPDATE special_slots SET content=? WHERE group_id=? AND position=1", 'Admin Override Item', groupId);
  f.sql("UPDATE special_collections SET revision=revision+1 WHERE id='mexican-night'");
  await f.run();
  assert.ok(mnSlots(f).some(s => s.content === 'Admin Override Item'));
});

test('concurrent revision bump causes write to fail closed', async t => {
  const f = mnHarness(t);
  f.state.posts[0].created_time = '2030-01-14T14:00:00Z';
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  f.state.posts = [{...f.state.posts[0], id: 'p2', created_time: '2030-01-14T16:00:00Z', updated_time: '2030-01-14T16:00:00Z'}];
  f.state.candidate = mexicanNightCandidate({groups: [{label: 'New', items: [{description: '', title: 'New item $5'}]}]});
  const oldMode = f.env.SPECIALS_IMPORT_MODE;
  f.env.SPECIALS_IMPORT_MODE = 'DRY_RUN';
  await f.run();
  f.env.SPECIALS_IMPORT_MODE = oldMode;
  f.sql("UPDATE special_collections SET revision=revision+1 WHERE id='mexican-night'");
  const result = await reconcileMexicanNight(f.env);
  assert.equal(result.written, false);
  assert.ok(!mnSlots(f).some(s => s.content === 'New item $5'));
});

test('replacement is atomic: old food items absent, new food items present, accessory slots preserved', async t => {
  const f = mnHarness(t);
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  const oldFoodContents = mnSlots(f).filter(s => !addons.some(a => a.title === s.content)).map(s => s.content);
  f.state.posts = [{...f.state.posts[0], id: 'p2', created_time: '2030-01-14T14:30:00Z', updated_time: '2030-01-14T14:30:00Z'}];
  const newItems = [{description: '', title: 'New Taco $7'}, {description: '', title: 'New Burrito $8'}];
  f.state.candidate = mexicanNightCandidate({groups: [{label: 'New Menu', items: newItems}]});
  await f.run();
  const newSlots = mnSlots(f);
  for (const old of oldFoodContents) {
    assert.ok(!newSlots.some(s => s.content === old), `old food item still present: ${old}`);
  }
  for (const item of newItems) {
    assert.ok(newSlots.some(s => s.content === item.title), `new item missing: ${item.title}`);
  }
  // Accessory (Add-Ons) slots from the first poster are preserved
  for (const addon of addons) assert.ok(newSlots.some(s => s.content === addon.title), `missing addon: ${addon.title}`);
  assert.equal(newSlots.length, newItems.length + addons.length);
});

test('both Mexican Night prompts require every item, size labels and the unlabeled add-on banner',()=>{
  for(const prompt of [mexicanNightExtractionPrompt(''),extractionPrompt('')]) {
    assert.match(prompt,/every column, row, banner and ribbon/);
    assert.match(prompt,/never skip an item because of a multi-column layout/);
    assert.match(prompt,/size label with its price in the title/);
    assert.match(prompt,/never output size prices without their (?:printed )?labels/i);
    assert.match(prompt,/unlabeled banner or ribbon/);
    assert.match(prompt,/group labeled exactly "Substitutions & Add-ons"/);
    assert.doesNotMatch(prompt,/"label":"Add-Ons"/);
  }
});

test('public titles show " - " instead of dot leaders before a price; other text is unchanged',()=>{
  const cases=[
    ['2 Soft Shell ... $7.75','2 Soft Shell - $7.75'],
    ['Burrito ...... $10.25','Burrito - $10.25'],
    ['Taco Salad ... Large $9.00 | Small $8.50 | Mini $6.00','Taco Salad - Large $9.00 | Small $8.50 | Mini $6.00'],
    ['Chips & Salsa or Chips & Cheese … $4.00','Chips & Salsa or Chips & Cheese - $4.00'],
    ['Enchilada‥$9.25','Enchilada - $9.25'],
    ['Nacho Deluxe ⋯ $9.75','Nacho Deluxe - $9.75'],
    ['Queso ··· 50c','Queso - 50c'],
    ['Add nacho cheese or salsa +$1.50','Add nacho cheese or salsa +$1.50'],
    ['Substitute chicken $1.50','Substitute chicken $1.50'],
    ['Wait... there is more','Wait... there is more'],
    ['... $5','... $5'],
  ];
  for(const [stored,shown] of cases) assert.equal(mexicanDisplayTitle(stored),shown,stored);
});

test('accessory prices normalize to USD format without changing their value',()=>{
  const cases=[
    ['Substitute queso 50c','Substitute queso $0.50'],['Substitute queso 50¢','Substitute queso $0.50'],
    ['Add salsa 75c','Add salsa $0.75'],['Add salsa 75 cents','Add salsa $0.75'],['Add sour cream 5c','Add sour cream $0.05'],
    ['Add guacamole $2','Add guacamole $2.00'],['Add steak $12','Add steak $12.00'],
    ['Substitute chicken $1.5','Substitute chicken $1.50'],['Substitute chicken $1.50','Substitute chicken $1.50'],
    ['Add queso $.50','Add queso $0.50'],['Add nacho cheese or salsa +$1.50','Add nacho cheese or salsa +$1.50'],
    ['Substitute shredded cheese for nacho cheese','Substitute shredded cheese for nacho cheese'],['2 Soft Shell','2 Soft Shell'],['Code 1c2','Code 1c2'],
  ];
  for(const [raw,normalized] of cases) assert.equal(normalizeMexicanPrices(raw),normalized,raw);
});

const nextPost = f => { f.state.posts=[{...f.state.posts[0],id:'p2',created_time:'2030-01-14T14:30:00Z',updated_time:'2030-01-14T14:30:00Z'}]; };
const priceFreeDefaults = [{title:'Substitute chicken',description:''},{title:'Add nacho cheese',description:''}];
const accessorySlots = f => f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night' AND g.label='Substitutions & Add-ons' ORDER BY s.position");

test('any Facebook accessory group replaces recurring accessory defaults regardless of label',async t=>{
  const f=mnHarness(t,{candidate:mexicanNightCandidate({groups:[{label:'Entrees',items:entrees},{label:'Substitutions & Add-ons',items:priceFreeDefaults}]})});
  await f.run();
  nextPost(f);
  f.state.candidate=mexicanNightCandidate({groups:[{label:'Entrees',items:entrees},{label:'Add-Ons',items:[{title:'Substitute chicken $1.50',description:''},{title:'Substitute queso 50c',description:''}]}]});
  await f.run();
  assert.deepEqual(mnGroups(f).map(g=>g.label),['Entrees','Add-Ons'],'old differently labeled accessory group removed');
  const contents=mnSlots(f).map(s=>s.content);
  assert.ok(contents.includes('Substitute chicken $1.50') && contents.includes('Substitute queso $0.50'));
  assert.ok(!contents.includes('Substitute chicken') && !contents.includes('Add nacho cheese'),'no stale price-free defaults');
});

test('Facebook evidence without accessories keeps recurring accessory defaults exactly',async t=>{
  const f=mnHarness(t,{candidate:mexicanNightCandidate({groups:[{label:'Entrees',items:entrees},{label:'Substitutions & Add-ons',items:priceFreeDefaults}]})});
  await f.run();
  const before=accessorySlots(f);
  nextPost(f);
  f.state.candidate=mexicanNightCandidate({groups:[{label:'Entrees',items:octoberPosterGroups()[0].items}]});
  await f.run();
  assert.ok(mnSlots(f).some(s=>s.content.startsWith('Burrito ... $10.25')),'food replaced');
  assert.equal(before.length,2);
  assert.deepEqual(accessorySlots(f),before);
});

test('manual-locked accessory correction blocks Facebook accessory replacement',async t=>{
  const f=mnHarness(t);
  await f.run();
  const addonGroup=mnGroups(f).find(g=>g.label==='Add-Ons');
  f.sql("UPDATE special_slots SET content='Substitute chicken $1.25',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",addonGroup.id);
  const snapshot=()=>JSON.stringify([mnCollection(f),mnGroups(f),mnSlots(f)]);
  const before=snapshot();
  nextPost(f);
  f.state.candidate=mexicanNightCandidate({groups:octoberPosterGroups()});
  await f.run();
  assert.equal(snapshot(),before,'staff correction and the whole section are untouched');
});
