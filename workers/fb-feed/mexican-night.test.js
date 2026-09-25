import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMexicanNight} from './reconcile.js';
import {harness, offer, poster} from './test-fixture.js';
import {reconcileMexicanNight} from './guarded-auto.js';
import {PARSER_VERSION} from './classify.js';

const entrees = [
  {content: '2 Soft Shell $8.50'},
  {content: 'Burrito $9.00'},
  {content: 'Chimichanga $9.00'},
  {content: 'Enchilada $8.50'},
];
const extras = [
  {content: 'Nacho Deluxe'},
  {content: 'Taco Salad — Large $9.50 / Small $7.50 / Mini $5.50'},
  {content: 'Chips & Salsa or Chips & Cheese'},
];
const addons = [
  {content: 'Substitute chicken $1.00'},
  {content: 'Add nacho cheese $0.75'},
  {content: 'Substitute queso $0.75'},
  {content: 'Substitute shredded cheese for nacho cheese $0.75'},
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

test('validateMexicanNight accepts valid complete poster', () => {
  const result = validateMexicanNight(mexicanNightCandidate());
  assert.equal(result.type, 'mexican-night');
  assert.equal(result.poster_evidence, 'Mexican Night');
  assert.equal(result.schedule, 'Tuesdays 5–10 PM');
  assert.equal(result.groups.length, 3);
  assert.equal(result.groups[0].items.length, 4);
  assert.equal(result.groups[0].items[0].content, '2 Soft Shell $8.50');
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
  const manyGroups = Array.from({length: 13}, (_, i) => ({label: `Group ${i}`, items: [{content: 'Item'}]}));
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: manyGroups}),
    /1-12/
  );
});

test('validateMexicanNight rejects group with empty label', () => {
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: [{label: '', items: [{content: 'Item'}]}]}),
    /label/i
  );
});

test('validateMexicanNight rejects group with more than 4 items', () => {
  const tooManyItems = Array.from({length: 5}, () => ({content: 'Item'}));
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: [{label: 'Group', items: tooManyItems}]}),
    /1-4/
  );
});

test('validateMexicanNight rejects item with whitespace-only content', () => {
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: [{label: 'Group', items: [{content: '   '}]}]}),
    /content/i
  );
});

test('validateMexicanNight rejects item content over 150 chars', () => {
  assert.throws(
    () => validateMexicanNight({...mexicanNightCandidate(), groups: [{label: 'Group', items: [{content: 'A'.repeat(151)}]}]}),
    /content/i
  );
});

test('validateMexicanNight accepts null schedule (defaults to empty string)', () => {
  const result = validateMexicanNight({...mexicanNightCandidate(), schedule: null});
  assert.equal(result.schedule, '');
});

test('validateMexicanNight preserves prices, sizes, and add-on text exactly', () => {
  const result = validateMexicanNight(mexicanNightCandidate());
  assert.equal(result.groups[0].items[1].content, entrees[1].content);
});

test('clear Mexican Night poster replaces all groups and items', async t => {
  const f = mnHarness(t);
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  assert.ok(mnSlots(f).some(s => s.content === entrees[0].content));
  assert.ok(mnSlots(f).some(s => s.content === extras[0].content));
  assert.ok(mnSlots(f).some(s => s.content === addons[0].content));
  assert.equal(f.imports()[0].validation_result, 'ok');
});

test('second poster removes items from the first poster and replaces with new menu', async t => {
  const f = mnHarness(t);
  await f.run();
  assert.equal(mnGroups(f).length, 3);
  f.state.posts = [{...f.state.posts[0], id: 'p2', created_time: '2030-01-14T14:30:00Z', updated_time: '2030-01-14T14:30:00Z'}];
  f.state.candidate = mexicanNightCandidate({groups: [{label: 'Limited Menu', items: [{content: 'Special Burrito $10'}]}]});
  await f.run();
  assert.equal(mnGroups(f).length, 1);
  assert.ok(mnSlots(f).some(s => s.content === 'Special Burrito $10'));
  assert.ok(!mnSlots(f).some(s => s.content === entrees[0].content));
});

test('prices, sizes, and add-ons are preserved verbatim', async t => {
  const f = mnHarness(t);
  await f.run();
  assert.ok(mnSlots(f).some(s => s.content === 'Taco Salad — Large $9.50 / Small $7.50 / Mini $5.50'));
  for (const addon of addons) {
    assert.ok(mnSlots(f).some(s => s.content === addon.content), `missing addon: ${addon.content}`);
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
  f.state.candidate = {type: 'mexican-night', poster_evidence: 'Tuesday Specials', groups: [{label: 'A', items: [{content: 'B'}]}]};
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
  f.state.candidate = mexicanNightCandidate({groups: [{label: 'New', items: [{content: 'New item $5'}]}]});
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
  const newItems = [{content: 'New Taco $7'}, {content: 'New Burrito $8'}];
  f.state.candidate = mexicanNightCandidate({groups: [{label: 'New Menu', items: newItems}]});
  await f.run();
  const newSlots = mnSlots(f);
  for (const old of oldContents) {
    assert.ok(!newSlots.some(s => s.content === old), `old item still present: ${old}`);
  }
  for (const item of newItems) {
    assert.ok(newSlots.some(s => s.content === item.content), `new item missing: ${item.content}`);
  }
  assert.equal(newSlots.length, newItems.length);
});
