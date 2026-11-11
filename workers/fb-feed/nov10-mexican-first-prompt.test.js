// November 10, 2026: the generic contract-2 first reading of the Mexican Night
// poster degenerated into whitespace after item 1's evidence until the 4,096-token
// limit (production attempt 0: 78 s, invalid JSON), and the generic reread then
// hedged 2 Soft Shell. A caption that alone identifies Mexican Night now starts
// with the Mexican-only request. Validation, retry limits and staff locks are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {confidentMexicanNightCaption} from './classify.js';

const NOV10=JSON.parse(readFileSync(new URL('../../tests/fixtures/nov10-mexican-night.json',import.meta.url),'utf8'));
const clean=()=>{const m=structuredClone(NOV10);for(const g of m.groups) for(const i of g.items) i.uncertainties=[];
  m.groups.push({label:'Substitutions & Add-ons',items:[{title:'Add nacho cheese or salsa +$1.50',description:'',evidence:'Add nacho cheese or salsa +$1.50',uncertainties:[]}]});return m;};
// Production attempt 0, verbatim up to the degeneration point, then the padding.
const TRUNCATED=`{
  "type": "mexican-night",
  "poster_evidence": "TONIGHT @ GRAYZ'N BUFFALO 5-10PM! Mexican Night Every Tuesday Night 5-10pm",
  "schedule": "Every Tuesday Night 5-10pm",
  "groups": [
    {
      "label": "Entrees",
      "items": [
        {
          "title": "2 Soft Shell ... $7.75",
          "description": "Meat, shredded cheese, lettuce, onion, tomato, and black olives"
        ,
        "evidence": "2 Soft Shell ... $7.75  Meat, shredded cheese, lettuce, onion, tomato, and black olives"${' '.repeat(31456)}`;
const tuesdayDaily={day_of_week:2,day_evidence:'TUESDAY',poster_evidence:'TUESDAY SPECIALS',offers:[
  {content:'Jalapeno Burger with Side Salad, Chili or Coleslaw $10.25',evidence:'Jalapeno Burger with Side Salad, Chili or Coleslaw - $10.25',
    service_time:'',service_evidence:'',date_evidence:'',uncertainties:[]}]};

function setup(t,readings,caption='Mexican Night 5-10pm') {
  const f=harness(t,{now:'2026-11-10T21:30:00Z',caption});
  Object.assign(f.state.posts[0],{created_time:'2026-11-10T21:29:15+0000',updated_time:'2026-11-10T21:29:15+0000'});
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-09',week_end_date='2026-11-15' WHERE id=9000");
  f.requests=[];
  f.env.AI.run=async(_model,request)=>{
    const reading=readings[Math.min(f.requests.length,readings.length-1)];f.requests.push(request);
    return {response:typeof reading==='string'?reading:JSON.stringify(reading)};
  };
  f.schema=i=>f.requests[i].response_format.json_schema.name;
  f.prompt=i=>f.requests[i].messages[1].content[0].text;
  f.menu=()=>f.sql("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night' ORDER BY g.sort,s.position").map(s=>s.content);
  f.events=type=>f.sql('SELECT detail FROM special_import_events WHERE event_type=? ORDER BY id',type).map(e=>e.detail);
  return f;
}

test('November 10: only a caption that alone identifies Mexican Night selects the Mexican request',()=>{
  for(const caption of ['Mexican Night 5-10pm','MEXICAN NIGHT tonight!','Tuesday Mexican Night 5–10 PM','Join us for Mexican Night 🌮'])
    assert.equal(confidentMexicanNightCaption(caption),true,caption);
  for(const caption of ['','Tuesday Specials','Taco Tuesday 5-10pm','Mexican food tonight','Mexican Night and Tuesday lunch specials',
    'Delivery available 11-130. Mexican Night tonight','Mexican Night tonight; Wednesday wings','Weekly specials + Mexican Night',null])
    assert.equal(confidentMexicanNightCaption(caption),false,String(caption));
});

test('November 10: a Mexican Night caption starts with the Mexican-only request and publishes on one call',async t=>{
  const f=setup(t,[clean()]);await f.run();
  assert.equal(f.requests.length,1);
  assert.equal(f.schema(0),'specials_evidence_v2_mexican');
  assert.match(f.prompt(0),/Read the ORIGINAL image\. Return the complete menu/);
  assert.doesNotMatch(f.prompt(0),/previous reading needs repair/);
  // The existing fail-closed instruction for a poster without the heading is retained.
  assert.match(f.prompt(0),/If that evidence is absent or uncertain, return exactly/);
  const row=f.imports()[0];
  assert.equal(row.processing_status,'staged');assert.equal(row.validation_result,'ok');
  assert.ok(f.menu().some(c=>c.startsWith('2 Soft Shell ... $7.75')));
  assert.ok(f.menu().some(c=>c.startsWith('Taco Salad ... Large $9.00 | Small $8.50 | Mini $6.00')));
  assert.deepEqual(f.events('retry'),[]);
});

test('November 10: a truncated Mexican reading is reread in the Mexican shape, never the generic one',async t=>{
  const f=setup(t,[TRUNCATED,clean()]);await f.run();
  assert.equal(f.requests.length,2);
  assert.equal(f.schema(0),'specials_evidence_v2_mexican');assert.equal(f.schema(1),'specials_evidence_v2_mexican');
  assert.ok(f.prompt(1).includes(JSON.stringify('response is not valid JSON')));
  // The 31 KB of padding is never echoed into the reread.
  assert.ok(f.prompt(1).length<f.prompt(0).length+400);
  assert.deepEqual(f.events('retry'),['Mexican Night targeted retry: determining from image whether poster is Mexican Night']);
  assert.equal(f.imports()[0].validation_result,'ok');
  assert.ok(f.menu().some(c=>c.startsWith('2 Soft Shell ... $7.75')));
});

test('November 10: two unusable Mexican readings still hold the whole menu within the existing retry limit',async t=>{
  const f=setup(t,[TRUNCATED,NOV10]);const before=f.menu();await f.run();
  assert.equal(f.requests.length,2);
  assert.equal(f.events('extract').length,2);
  const row=f.imports()[0];
  assert.equal(row.processing_status,'failed');assert.equal(row.validation_result,'rejected');assert.equal(row.failure_kind,'permanent');
  assert.equal(row.validation_reason,'Uncertain Mexican Night item: "2 Soft Shell ... $7.75"');
  assert.deepEqual(f.menu(),before);
  // A later cron never spends another AI call on the permanent failure.
  f.state.now+=30*60000;await f.run();assert.equal(f.requests.length,2);
});

test('November 10: a Mexican caption on a poster without the heading falls back to the generic reread',async t=>{
  const f=setup(t,[{type:'mexican-night',poster_evidence:'',schedule:'',groups:[]},tuesdayDaily]);await f.run();
  assert.equal(f.requests.length,2);
  assert.equal(f.schema(0),'specials_evidence_v2_mexican');
  assert.equal(f.schema(1),'specials_evidence_v2');
  assert.deepEqual(f.menu(),[]);
  assert.equal(f.imports()[0].validation_result,'ok');
  assert.equal(JSON.parse(f.imports()[0].candidate_json).day_of_week,2);
});

test('November 10: captions that do not confidently identify Mexican Night keep the generic first request',async t=>{
  for(const caption of ['','Tuesday Specials and Mexican Night tonight']) {
    await t.test(caption || '(empty caption)',async t=>{
      const f=setup(t,[clean()],caption);await f.run();
      assert.equal(f.schema(0),'specials_evidence_v2');
      assert.doesNotMatch(f.prompt(0),/^Examine the image and determine whether this poster is a Mexican Night/);
    });
  }
});

test('November 10: a staff-locked Mexican Night item is never overwritten by the Mexican-first reading',async t=>{
  const f=setup(t,[clean()]);
  f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) VALUES('staff','mexican-night',-1,'custom','Entrees','',0,1)");
  f.sql("INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value) VALUES('staff',1,'Burrito - $11.00','','','manual',1,NULL)");
  await f.run();
  assert.deepEqual(f.menu(),['Burrito - $11.00']);
  assert.equal(f.sql("SELECT section_source FROM special_collections WHERE id='mexican-night'")[0].section_source,'recurring');
});
