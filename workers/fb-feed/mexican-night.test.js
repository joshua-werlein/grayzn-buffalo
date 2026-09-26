import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMexicanNight,containsConsumerAdvisory} from './reconcile.js';
import {harness, offer, poster} from './test-fixture.js';
import {reconcileMexicanNight} from './guarded-auto.js';
import {PARSER_VERSION} from './classify.js';
import {composeMexicanItem,splitMexicanItem} from '../../src/lib/mexican-item.js';

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
  for(const item of [{content:'Old v9 shape'}, {description:''}, {title:'',description:''}, {title:'T'}, {title:'T',description:null}, {title:2,description:''}, {title:'T\nX',description:''}, {title:'T'.repeat(75),description:'D'.repeat(75)}]) assert.throws(()=>validate(item));
  const item={title:'T'.repeat(75),description:'D'.repeat(74)};
  assert.deepEqual(validate(item).groups[0].items[0],item);
  assert.equal(composeMexicanItem(item.title,item.description).length,150);
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
  assert.equal(PARSER_VERSION,12);
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

test('validateMexicanNight rejects item content over 150 chars', () => {
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: [{label: 'Group', items: [{description: '', title: 'A'.repeat(151)}]}]}),
    /title|150/i
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

test('second poster removes items from the first poster and replaces with new menu', async t => {
  const f = mnHarness(t);
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  f.state.posts = [{...f.state.posts[0], id: 'p2', created_time: '2030-01-14T14:30:00Z', updated_time: '2030-01-14T14:30:00Z'}];
  f.state.candidate = mexicanNightCandidate({groups: [{label: 'Limited Menu', items: [{description: '', title: 'Special Burrito $10'}]}]});
  await f.run();
  assert.equal(mnGroups(f).length, 1);
  assert.ok(mnSlots(f).some(s => s.content === 'Special Burrito $10'));
  assert.ok(!mnSlots(f).some(s => s.content === entrees[0].title));
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

test('replacement is atomic: old items absent and new items present after replacement', async t => {
  const f = mnHarness(t);
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  const oldContents = mnSlots(f).map(s => s.content);
  f.state.posts = [{...f.state.posts[0], id: 'p2', created_time: '2030-01-14T14:30:00Z', updated_time: '2030-01-14T14:30:00Z'}];
  const newItems = [{description: '', title: 'New Taco $7'}, {description: '', title: 'New Burrito $8'}];
  f.state.candidate = mexicanNightCandidate({groups: [{label: 'New Menu', items: newItems}]});
  await f.run();
  const newSlots = mnSlots(f);
  for (const old of oldContents) {
    assert.ok(!newSlots.some(s => s.content === old), `old item still present: ${old}`);
  }
  for (const item of newItems) {
    assert.ok(newSlots.some(s => s.content === item.title), `new item missing: ${item.title}`);
  }
  assert.equal(newSlots.length, newItems.length);
});
