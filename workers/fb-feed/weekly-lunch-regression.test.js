import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {harness} from './test-fixture.js';
import {validateEvidence, WEEKLY_LUNCH_SHAPE_ERROR} from './reconcile.js';
import {PARSER_VERSION} from './classify.js';

const heading = 'WEEKLY SPECIALS 9/28-10/2 • 11am-1:30pm';
const entries = [
  'Grilled Chicken Cranberry Salad and a Drink',
  'Chicken Philly Wrap with Waffle Fries & a Drink',
  'Bacon Cheese Curd Burger with Beer Fries & a Drink',
  'Chicken Alfredo with Breadsticks and a Drink',
  'Fish Sandwich with French Fries & a Drink',
].map((content, i) => ({day_of_week:i+1, content}));
const weekly = (poster_evidence=heading) => ({type:'weekly-lunch',poster_evidence,date_range:'9/28-10/2',service_time:'11am-1:30pm',entries});
const emptyDaily = (poster_evidence=heading, day_evidence='') => ({day_of_week:-1,day_evidence,poster_evidence,offers:[]});
function currentWeek(t, candidate=weekly()) {
  const f = harness(t,{now:'2026-09-28T15:00:00Z',caption:'Weekly Specials 9/28-10/2',candidate});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-09-28',week_end_date='2026-10-04' WHERE id=9000");
  f.state.posts[0].created_time = f.state.posts[0].updated_time = '2026-09-28T12:58:14Z';
  return f;
}
const lunch = (f, day) => f.slots(day,'lunch')[0];
const allMeals = f => entries.forEach(e => assert.equal(lunch(f,e.day_of_week).content,e.content));

// AI responses are mocked: these exercise validation/publication, not live vision accuracy.
for (const label of [heading, 'Weekly Lunch Specials', 'Weekly Specials • 11-1:30']) {
  test(`weekly response publishes all five eligible days: ${label}`, async t => {
    const f = currentWeek(t,weekly(label));
    await f.run();
    allMeals(f);
    assert.equal(f.imports()[0].validation_reason,'weekly lunch evidence');
  });
}

test('overall date range with explicit dates beside weekday labels retries into weekly entries', async t => {
  const days = 'Monday 9/28 Tuesday 9/29 Wednesday 9/30 Thursday 10/1 Friday 10/2';
  const f = currentWeek(t);
  const requests = [];
  f.env.AI.run = async (_model, request) => {
    requests.push(structuredClone(request));
    return {response:JSON.stringify(requests.length===1 ? emptyDaily(heading,days) : weekly())};
  };
  await f.run();
  allMeals(f);
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0],requests[1]);
  assert.match(requests[0].messages[1].content[0].text,/individual dates beside each weekday are not required/);
  assert.match(requests[0].messages[1].content[0].text,/If individual dates are also printed/);
  assert.equal(f.sql("SELECT count(*) n FROM special_import_events WHERE event_type='retry'")[0].n,1);
  assert.equal(f.sql("SELECT count(*) n FROM special_import_events WHERE event_type='extract'")[0].n,2);
});

for (const label of [heading,'Weekly Lunch Specials','Weekly Specials 11-1:30','9/28–10/2 Lunch Specials','Mon–Fri 11 a.m.–1:30 p.m.']) {
  test(`daily shape cannot succeed for clear weekly lunch evidence: ${label}`, () => {
    assert.throws(()=>validateEvidence(emptyDaily(label)),{message:WEEKLY_LUNCH_SHAPE_ERROR});
  });
}

test('recognizable weekday schedule without weekly wording rejects daily shape', () => {
  assert.throws(()=>validateEvidence(emptyDaily('Lunch Specials','Monday Tuesday Wednesday Thursday Friday')),{message:WEEKLY_LUNCH_SHAPE_ERROR});
});

test('non-special image and ordinary single-day evidence retain their existing validation', () => {
  for (const label of ['', 'Monday Specials 11am-1:30pm', 'Weekly entertainment']) {
    assert.deepEqual(validateEvidence(emptyDaily(label)),emptyDaily(label));
  }
});

test('exact production empty result fails after one retry, publishes nothing and stays idempotent', async t => {
  const f = currentWeek(t,emptyDaily());
  await f.run();
  assert.equal(f.state.aiCalls,2);
  assert.equal(f.imports()[0].processing_status,'failed');
  assert.equal(f.imports()[0].validation_result,'rejected');
  assert.equal(f.imports()[0].validation_reason,WEEKLY_LUNCH_SHAPE_ERROR);
  assert.equal(f.imports()[0].candidate_json,null);
  entries.forEach(e=>assert.equal(lunch(f,e.day_of_week).content,''));
  await f.run();
  assert.equal(f.state.aiCalls,2);
});

test('weekly shape retry cannot exceed the existing daily AI budget', async t => {
  const f = currentWeek(t,emptyDaily());
  f.env.SPECIALS_AI_DAILY_LIMIT='1';
  await f.run();
  assert.equal(f.state.aiCalls,1);
  assert.equal(f.imports()[0].processing_status,'failed');
  assert.equal(f.sql("SELECT count(*) n FROM special_import_events WHERE event_type='retry'")[0].n,0);
});

test('daily Monday evidence survives, blanks fill, Friday recurring default is replaced; repeat makes no writes', async t => {
  const f = currentWeek(t);
  const monday = 'Grilled Chicken Cranberry Salad & a Drink $9.75';
  f.sql("UPDATE special_slots SET content=?,origin='automation',manual_locked=0,last_auto_value=? WHERE group_id=? AND position=1",monday,monday,lunch(f,1).group_id);
  f.sql("UPDATE special_slots SET content='Recurring fish and shrimp',origin='manual',manual_locked=0,last_auto_value=NULL WHERE group_id=? AND position=1",lunch(f,5).group_id);
  // A manually cleared slot has no lock and remains eligible.
  f.sql("UPDATE special_slots SET content='',origin='legacy',manual_locked=0,last_auto_value=NULL WHERE group_id=? AND position=1",lunch(f,2).group_id);
  await f.run();
  assert.equal(lunch(f,1).content,monday);
  entries.slice(1).forEach(e=>assert.equal(lunch(f,e.day_of_week).content,e.content));
  assert.equal(lunch(f,5).origin,'automation');
  assert.equal(lunch(f,5).last_auto_value,entries[4].content);
  const snapshot = f.sql("SELECT revision,mutation_token FROM special_collections WHERE id='auto-week'");
  const audits = f.sql('SELECT * FROM special_import_events');
  await f.run();
  assert.equal(f.state.aiCalls,1);
  assert.deepEqual(f.sql("SELECT revision,mutation_token FROM special_collections WHERE id='auto-week'"),snapshot);
  assert.deepEqual(f.sql('SELECT * FROM special_import_events'),audits);
});

for (const origin of ['manual','legacy','automation']) {
  test(`weekly evidence preserves locked ${origin} Lunch correction`, async t => {
    const f = currentWeek(t);
    f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=1,last_auto_value=? WHERE group_id=? AND position=1','Staff correction',origin,'Staff correction',lunch(f,5).group_id);
    await f.run();
    assert.equal(lunch(f,5).content,'Staff correction');
    assert.equal(lunch(f,5).manual_locked,1);
  });
}

test('staff edit during weekly publication invalidates the guarded transaction', async t => {
  const f = currentWeek(t);
  const batch = f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch = async statements => {
    if (statements[0].sql.startsWith('UPDATE special_collections SET revision=revision+1')) {
      f.sql("UPDATE special_slots SET content='Concurrent staff correction',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",lunch(f,5).group_id);
    }
    return batch(statements);
  };
  await f.run();
  assert.equal(lunch(f,5).content,'Concurrent staff correction');
  assert.equal(lunch(f,2).content,'');
  assert.equal(f.sql("SELECT count(*) n FROM special_import_events WHERE event_type='review'")[0].n,0);
});

const digest = (value,bytes) => createHash('sha256').update(value).digest('hex').slice(0,bytes*2);
function seedParser13(f) {
  const post = f.state.posts[0];
  const captionHash = digest(post.message,8);
  const imageVersion = `updated:${post.updated_time}`;
  const model = '@cf/google/gemma-4-26b-a4b-it';
  const idFor = version => digest(`test:${post.id}:${captionHash}:${imageVersion}:${version}:${model}`,16);
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,caption,caption_hash,image_source_version,parser_version,model_id,processing_status,validation_result,extracted_json,candidate_json)
    VALUES(?,?,?,?,?,?,13,?,'staged','ok',?,?)`,idFor(13),post.id,post.created_time,post.message,captionHash,imageVersion,model,JSON.stringify(emptyDaily()),JSON.stringify(emptyDaily()));
  return idFor;
}

test('parser 14 re-extracts the same current-day source with a new deterministic identity; parser 13 is untouched', async t => {
  const f = currentWeek(t);
  const idFor = seedParser13(f);
  const old = f.imports()[0];
  assert.equal(PARSER_VERSION,14);
  await f.run();
  assert.equal(f.state.aiCalls,1);
  assert.deepEqual(f.imports()[0],old);
  assert.equal(f.imports()[1].id,idFor(14));
  assert.notEqual(idFor(13),idFor(14));
  allMeals(f);
  await f.run();
  assert.equal(f.imports().length,2);
  assert.equal(f.state.aiCalls,1);
});

test('parser bump does not rediscover a previous-day source, even for the current week', async t => {
  const f = currentWeek(t);
  seedParser13(f);
  f.state.now = Date.parse('2026-09-29T15:00:00Z');
  await f.run();
  assert.equal(f.state.aiCalls,0);
  assert.equal(f.imports().length,1);
  entries.forEach(e=>assert.equal(lunch(f,e.day_of_week).content,''));
});
