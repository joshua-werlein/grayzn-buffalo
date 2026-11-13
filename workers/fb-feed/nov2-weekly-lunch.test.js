import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {runImportPipeline,validateExtraction} from './worker.js';
import {weeklyEntryEvidence} from './evidence.js';
import {dispatchVerifiedAlerts,beginAlertScan,finishAlertScan,readAlertHealth} from './alert-runtime.js';
import {ALERT_GRACE_MS,ALERT_LEASE_MS} from './alert-store.js';
import {alertMessage} from './alert-email.js';
import {weeklyAlertDetail} from './alert-detail.js';
import {normalizeMenuCase} from '../../src/lib/text-case.js';

// November 2, 2026: two equivalent weekly lunch posters printed decorated
// weekday labels. AI responses are mocked; these exercise validation,
// publication and alerting, not live vision accuracy.
const MEALS = [
  'Chicken Bacon Ranch Wrap with Chips and a Drink $10.50',
  'Taco Salad and a Drink $10.50',
  'Hot Ham and Cheese with Fries and a Drink $10.50',
  'Meatloaf with Mashed Potatoes and a Drink $10.50',
  'Fish Fry with Coleslaw and a Drink $10.50',
];
const DAYS = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'];
const decor = {plain:d=>`${d} `, asterisk:d=>`* ${d} * `, emdash:d=>`— ${d} — `};
const weekly = (style='asterisk', mutate=e=>e) => ({type:'weekly-lunch',
  poster_evidence:'WEEKLY LUNCH SPECIALS 11/2-11/6 11am-1:30pm',date_range:'11/2-11/6',service_time:'11am-1:30pm',
  entries:MEALS.map((m,i)=>mutate({day_of_week:i+1,content:m,evidence:decor[style](DAYS[i])+m,uncertainties:[]},i))});
const window = {today:'2026-11-02',weekday:1};
const check = candidate => validateExtraction(JSON.stringify(candidate),true,window);

// ── Validation ───────────────────────────────────────────────────────────────

for (const style of Object.keys(decor)) test(`weekly rows with ${style} weekday labels validate all five days`, () => {
  const result = check(weekly(style));
  assert.equal(result.validationResult,'ok',result.validationReason);
  assert.equal(result.validationReason,'weekly lunch evidence');
  assert.deepEqual(JSON.parse(result.candidateJson).entries.map(e=>e.content),MEALS);
});

test('decorated label stripping is limited to this row\'s own weekday and fixed marks', () => {
  assert.equal(weeklyEntryEvidence('*MONDAY*\nTaco Salad',1),'Taco Salad');
  assert.equal(weeklyEntryEvidence('• Mon 11/2 • Taco Salad',1),'Taco Salad');
  assert.equal(weeklyEntryEvidence('** FRIDAY ** Fish Fry',5),'Fish Fry');
  assert.equal(weeklyEntryEvidence('* TUESDAY * Taco Salad',1),'* TUESDAY * Taco Salad');
  assert.equal(weeklyEntryEvidence('Monterey Chicken Wrap',1),'Monterey Chicken Wrap');
  assert.equal(weeklyEntryEvidence('* MONDAY * $10.50 Taco Salad',1),'$10.50 Taco Salad');
});

test('a contradictory weekday label holds only that row', () => {
  const result = check(weekly('asterisk',(e,i)=>i===0?{...e,evidence:'* TUESDAY * '+MEALS[0]}:e));
  assert.equal(result.validationResult,'ok');
  const c = JSON.parse(result.candidateJson);
  assert.deepEqual(c.entries.map(e=>e.day_of_week),[2,3,4,5]);
  assert.deepEqual(c.unresolved_days.map(d=>d.day),[1]);
});

test('missing or conflicting meal details are never repaired', () => {
  const differs = check(weekly('emdash',(e,i)=>i===1?{...e,content:'Taco Salad with Chips and a Drink $10.50'}:e));
  assert.deepEqual(JSON.parse(differs.candidateJson).unresolved_days,[{day:2,reason:'Meal facts differ from original evidence'}]);
  const price = check(weekly('emdash',(e,i)=>i===2?{...e,content:MEALS[2].replace('$10.50','$9.50')}:e));
  assert.equal(JSON.parse(price.candidateJson).unresolved_days[0].day,3);
  const uncertain = check(weekly('emdash',(e,i)=>i===4?{...e,uncertainties:['Price unreadable']}:e));
  assert.equal(JSON.parse(uncertain.candidateJson).unresolved_days[0].day,5);
});

test('every row unverified reports per-row reasons, not the entry-count shape error', () => {
  const result = check(weekly('asterisk',e=>({...e,evidence:`* ${DAYS[(e.day_of_week)%5]} * ${e.content}`})));
  assert.equal(result.validationResult,'rejected');
  assert.match(result.validationReason,/^No verified weekly meals: /);
  assert.doesNotMatch(result.validationReason,/1-5 items/);
});

test('conflicting printed date range still rejects the poster', () => {
  const result = check({...weekly(),date_range:'11/9-11/13'});
  assert.equal(result.validationResult,'rejected');
  assert.match(result.validationReason,/Conflicting printed weekly date range/);
});

// ── Pipeline and alerts ──────────────────────────────────────────────────────

function setup(t, {now='2026-11-02T15:20:00Z'}={}) {
  let db;t.after(()=>db?.close());
  const f = harness(t,{now,caption:'Weekly lunch specials!',candidate:weekly()});
  db = new DatabaseSync(f.path);
  db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT); INSERT OR REPLACE INTO settings VALUES('delivery_display','auto');");
  for (const name of ['0022_delivery_automation.sql','0023_facebook_alert_incidents.sql','0024_facebook_alert_evidence.sql'])
    db.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  const DB = {prepare(query) {
    return {sql:query,args:[],bind(...args){this.args=args;return this;},
      values(){return Object.fromEntries(this.args.map((v,i)=>[String(i+1),v]));},
      async first(){return db.prepare(query).get(this.values())??null;},
      async all(){return {results:db.prepare(query).all(this.values())};},
      async run(){return {meta:{changes:Number(db.prepare(query).run(this.values()).changes)}};}};
  },async batch(statements) {
    db.exec('BEGIN');
    try {
      const result = statements.map(s=>{
        const q=db.prepare(s.sql),values=s.values();
        if (/^\s*SELECT/i.test(s.sql)) return {results:q.all(values),meta:{changes:0}};
        return {results:[],meta:{changes:Number(q.run(values).changes)}};
      });db.exec('COMMIT');return result;
    } catch(e) {db.exec('ROLLBACK');throw e;}
  }};
  Object.assign(f.env,{DB,SPECIALS_ALERT_MODE:'MOCK',SPECIALS_EVIDENCE_VERSION:'2'});
  db.exec("UPDATE weekly_specials SET week_start_date='2026-11-02',week_end_date='2026-11-08' WHERE id=9000");
  f.state.posts = [
    {id:'583672228384067_1753746309626579',message:'Weekly lunch specials!',created_time:'2026-11-02T14:51:28+0000',updated_time:'2026-11-02T14:51:28+0000',full_picture:'https://cdn.example/a.jpg'},
    {id:'583672228384067_1753759926291884',message:'Weekly lunch specials!!',created_time:'2026-11-02T15:06:02+0000',updated_time:'2026-11-02T15:06:02+0000',full_picture:'https://cdn.example/b.jpg'},
  ];
  // Per-post readings keyed by caption text present in the extraction request.
  const readings = new Map();
  f.env.AI.run = async (_model, request) => {
    f.state.aiCalls++;
    const text = JSON.stringify(request.messages);
    for (const [caption, reading] of readings) if (text.includes(caption)) {
      if (reading instanceof Error) throw reading;
      return {response:JSON.stringify(reading)};
    }
    return {response:JSON.stringify(f.state.candidate)};
  };
  const sent = [];
  const lunch = day => db.prepare(`SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id
    WHERE g.collection_id='auto-week' AND g.day_of_week=? AND g.service='lunch' AND s.position=1`).get(day);
  return {...f,db,sent,readings,lunch,
    run:()=>runImportPipeline(f.env,{send:async m=>sent.push(m)}),
    send:()=>dispatchVerifiedAlerts(f.env,{send:async m=>sent.push(m)}),
    advance:ms=>{f.state.now+=ms;},
    // The current weekly incident is the attention row when one exists.
    incident:scope=>db.prepare("SELECT * FROM facebook_alert_incidents WHERE scope=? ORDER BY state='attention' DESC,observed_ms DESC").get(scope),
    incidents:scope=>db.prepare('SELECT * FROM facebook_alert_incidents WHERE scope=? ORDER BY first_seen_ms,rowid').all(scope),
    weeklyWrites:()=>db.prepare("SELECT count(*) n FROM special_import_events WHERE detail LIKE 'GUARDED_WEEKLY_LUNCH:%'").get().n};
}
const unverified = () => weekly('asterisk',e=>({...e,evidence:`* ${DAYS[e.day_of_week%5]} * ${e.content}`}));
// A staff correction recorded after both posters (14:51 and 15:06).
const correct = (f,day,content='Staff meal $9') => f.db.prepare("UPDATE special_slots SET content=?,origin='manual',manual_locked=1,manual_edited_at='2026-11-02T15:10:00.000Z' WHERE group_id=? AND position=1").run(content,f.lunch(day).group_id);

test('November 2: two equivalent decorated posters publish once and raise no alert', async t => {
  const f = setup(t);
  await f.run();
  const imports = f.imports();
  assert.equal(imports.length,2);
  assert.ok(imports.every(i=>i.processing_status==='staged' && i.validation_result==='ok'),JSON.stringify(imports.map(i=>i.validation_reason)));
  MEALS.forEach((m,i)=>assert.equal(f.lunch(i+1).content,m));
  assert.equal(f.weeklyWrites(),1,'the equivalent second source causes no redundant write');
  const revision = f.db.prepare("SELECT revision FROM special_collections WHERE id='auto-week'").get().revision;
  f.advance(ALERT_GRACE_MS);await f.run();
  assert.equal(f.db.prepare("SELECT revision FROM special_collections WHERE id='auto-week'").get().revision,revision);
  assert.equal(f.incident('weekly'),undefined);
  assert.equal(f.sent.length,0);
});

test('weekly validation rejection produces one Weekly Lunch alert after grace', async t => {
  const f = setup(t);f.state.candidate = unverified();
  await f.run();
  assert.ok(f.imports().every(i=>i.processing_status==='failed' && i.validation_result==='rejected'));
  const row = f.incident('weekly');
  assert.equal(row.state,'attention');assert.equal(row.code,'weekly_lunch_failed');
  assert.equal(JSON.parse(row.proof_json).cause,'validation_rejected');
  assert.notEqual(f.incident('daily')?.state,'attention');
  f.advance(ALERT_GRACE_MS-1);await f.send();assert.equal(f.sent.length,0,'grace period is preserved');
  f.advance(1);await f.send();await f.run();await f.send();
  assert.equal(f.sent.length,1,'two failed posters and repeated scans collapse into one email');
  const message = alertMessage(f.sent[0].day,f.sent[0].code,f.sent[0]);
  assert.match(message.subject,/\(Weekly Lunch\)$/);
  assert.match(message.text,/^Weekly Lunch: /);
  assert.match(message.text,/Affected week: week of 2026-11-02 \(printed 11\/2-11\/6\)/);
  assert.match(message.text,/Failure category: validation/);
  assert.match(message.text,/Result: Held for Review/);
  assert.match(message.text,/Published by automation: none verified/);
  assert.match(row.incident_key,/^2026-11-02:weekly:weekly_lunch_failed:[0-9a-f]{16}$/);
  assert.equal(f.incidents('weekly').length,1,'equivalent posters share one fingerprint');
  assert.match(message.text,/Open: https:\/\/grayznbuffalo\.com\/admin\/specials\?week=9000/);
  for (const meal of MEALS) assert.ok(!message.text.includes(meal.split(' ')[0]+' '+meal.split(' ')[1]),'no meal text from AI output');
  assert.ok(!message.text.includes('uncertainties') && !message.text.includes('{'),'no raw AI response structure');
});

test('weekly publication failure produces an alert; a staff correction newer than the post does not', async t => {
  const f = setup(t);
  // Tuesday's destination is ambiguous (two Lunch groups): an actionable publication failure.
  ambiguous(f,2);
  // Wednesday was corrected by staff after both posters: intentional, retained, not a failure.
  correct(f,3);
  await f.run();
  assert.equal(f.lunch(1).content,MEALS[0]);assert.equal(f.lunch(2).content,'');assert.equal(f.lunch(3).content,'Staff meal $9');
  const row = f.incident('weekly');
  assert.equal(row.state,'attention');assert.equal(JSON.parse(row.proof_json).cause,'publication_blocked');
  f.advance(ALERT_GRACE_MS);await f.send();
  assert.equal(f.sent.length,1);
  const text = alertMessage(f.sent[0].day,f.sent[0].code,f.sent[0]).text;
  assert.match(text,/- Tuesday: Lunch destination is missing or ambiguous/);
  assert.doesNotMatch(text,/- Wednesday/);
  assert.match(text,/Staff corrections newer than the post, or disabled \(kept, not a failure\): Wednesday/);
  assert.match(text,/Published by automation: Monday, Thursday, Friday/);
  assert.match(text,/Result: Partially Published/);
});

test('staff corrections newer than the posters alone are suppressed', async t => {
  const f = setup(t);
  for (const day of [1,2,3,4,5]) correct(f,day);
  await f.run();f.advance(ALERT_GRACE_MS);await f.run();
  assert.notEqual(f.incident('weekly')?.state,'attention');
  assert.equal(f.sent.length,0);
});

test('partial weekly publication with an unverified row alerts for that day only', async t => {
  const f = setup(t);
  f.state.candidate = weekly('emdash',(e,i)=>i===3?{...e,content:'Meatloaf with Fries and a Drink $10.50'}:e);
  await f.run();
  assert.equal(f.lunch(4).content,'');[1,2,3,5].forEach(d=>assert.equal(f.lunch(d).content,MEALS[d-1]));
  assert.equal(JSON.parse(f.incident('weekly').proof_json).cause,'validation_rejected');
  f.advance(ALERT_GRACE_MS);await f.send();
  const text = alertMessage(f.sent[0].day,f.sent[0].code,f.sent[0]).text;
  assert.match(text,/- Thursday: Meal facts could not be verified against the poster/);
  assert.match(text,/Result: Partially Published/);
  assert.match(text,/Published by automation: Monday, Tuesday, Wednesday, Friday/);
});

test('a failed poster equivalent to a fully published poster is resolved', async t => {
  const f = setup(t);
  f.readings.set('Weekly lunch specials!!',unverified());
  await f.run();
  const [good,bad] = f.imports();
  assert.equal(good.processing_status,'staged');assert.equal(bad.processing_status,'failed');
  f.advance(ALERT_GRACE_MS);await f.run();
  assert.notEqual(f.incident('weekly')?.state,'attention');assert.equal(f.sent.length,0);
});

test('a failed poster with different meals still alerts beside a published poster', async t => {
  const f = setup(t);
  const other = unverified();other.entries[0].content = other.entries[0].content.replace('Wrap','Sandwich');
  f.readings.set('Weekly lunch specials!!',other);
  await f.run();
  assert.equal(f.incident('weekly').state,'attention');
});

test('daily success does not suppress an unrelated weekly failure', async t => {
  const f = setup(t);
  f.state.candidate = unverified();
  f.state.posts.push({id:'583672228384067_1753802986287578',message:'Monday lunch special',created_time:'2026-11-02T15:10:58+0000',updated_time:'2026-11-02T15:10:58+0000',full_picture:'https://cdn.example/c.jpg'});
  f.readings.set('Monday lunch special',{evidence_version:2,day_of_week:1,day_evidence:'Monday',poster_evidence:'Monday Lunch Special 11am-1:30pm',
    offers:[{content:'Patty Melt with Fries and a Drink $10.25',evidence:'Patty Melt with Fries and a Drink $10.25',service_time:'11am-1:30pm',service_evidence:'Lunch Special 11am-1:30pm',uncertainties:[]}]});
  await f.run();
  assert.equal(f.lunch(1).content,'Patty Melt with Fries and a Drink $10.25');
  assert.notEqual(f.incident('daily')?.state,'attention');
  assert.equal(f.incident('weekly').state,'attention');
  f.advance(ALERT_GRACE_MS);await f.send();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].incidentKey,f.incident('weekly').incident_key);
  assert.match(f.sent[0].incidentKey,/^2026-11-02:weekly:weekly_lunch_failed:/);
});

test('a weekly poster deleted before grace is not alerted or reprocessed', async t => {
  const f = setup(t);f.state.candidate = unverified();
  await f.run();assert.equal(f.incident('weekly').state,'attention');
  const calls = f.state.aiCalls;
  f.state.posts = [];
  f.advance(10*60000);await f.run();
  assert.equal(f.incident('weekly').state,'suppressed');
  f.advance(ALERT_GRACE_MS);await f.send();await f.run();
  assert.equal(f.sent.length,0);assert.equal(f.state.aiCalls,calls);
  assert.ok(f.imports().every(i=>i.processing_status==='failed'),'historical evidence is not republished');
});

test('a weekly failure resolved by staff entry before grace sends nothing', async t => {
  const f = setup(t);f.state.candidate = unverified();
  await f.run();
  for (const id of f.imports().map(i=>i.id)) f.db.prepare("UPDATE special_imports SET review_status='edited' WHERE id=?").run(id);
  f.advance(10*60000);await f.run();
  assert.equal(f.incident('weekly').state,'suppressed');
  f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,0);
});

test('weekly alert detail exposes only fixed reasons and validated dates', () => {
  const detail = weeklyAlertDetail({day:'2026-11-02',data:[[],[{id:9000,week_start_date:'2026-11-02'}]],
    sources:[{id:'a',fb_post_id:'1_2',fb_created_time:'2026-11-02T14:51:28Z',extracted_json:'{"date_range":"<b>x</b>"}'}],
    failures:[{category:'validation',reason:'validation_rejected',days:[1,2]},{category:'publication',reason:'<script>',day:3}]});
  assert.equal(detail.dateRange,null);
  assert.deepEqual(detail.weeklyHolds,[{category:'validation',reason:'Weekly poster failed validation; no weekday meal was verified',days:['Monday','Tuesday']}]);
  const text = alertMessage('2026-11-02','validation_rejected',{detail}).text;
  assert.ok(!text.includes('<'));
});

// ── Review follow-up: coverage, dispatch capacity, fingerprints ─────────────

// Facebook is the canonical source: a staff value holds only against posts published
// before its recorded edit time (docs/facebook-specials-source-of-truth.md).
const lock = (f,day,content='Staff meal $9',edited='2026-11-02T15:10:00.000Z') => f.db.prepare("UPDATE special_slots SET content=?,origin='manual',manual_locked=1,manual_edited_at=? WHERE group_id=? AND position=1").run(content,edited,f.lunch(day).group_id);
const post = (id,message,created) => ({id,message,created_time:created,updated_time:created,full_picture:'https://cdn.example/'+id+'.jpg'});

test('a staff-locked weekday is not proof that a failed equivalent poster was published', async t => {
  const f = setup(t);lock(f,3);
  f.readings.set('Weekly lunch specials!!',unverified());
  await f.run();
  assert.equal(f.imports()[1].processing_status,'failed');
  const row = f.incident('weekly');
  assert.equal(row?.state,'attention');assert.equal(JSON.parse(row.proof_json).cause,'validation_rejected');
});

test('a staff lock holding the identical meal is still not automation publication proof', async t => {
  const f = setup(t);lock(f,2,MEALS[1]);
  f.readings.set('Weekly lunch specials!!',unverified());
  await f.run();
  assert.equal(f.incident('weekly')?.state,'attention');
});

test('a disabled weekday is not proof for a failed equivalent poster', async t => {
  const f = setup(t);
  f.db.prepare('UPDATE special_groups SET enabled=0 WHERE id=?').run(f.lunch(5).group_id);
  f.readings.set('Weekly lunch specials!!',unverified());
  await f.run();
  assert.equal(f.incident('weekly')?.state,'attention');
});

test('a retained automated value with no current daily poster is not proof for a failed equivalent poster', async t => {
  const f = setup(t);
  f.db.prepare("UPDATE special_slots SET content='Daily poster meal $9',origin='automation',manual_locked=0,last_auto_value='Daily poster meal $9' WHERE group_id=? AND position=1").run(f.lunch(1).group_id);
  f.readings.set('Weekly lunch specials!!',unverified());
  await f.run();
  assert.equal(f.lunch(1).content,'Daily poster meal $9');
  assert.equal(f.incident('weekly')?.state,'attention');
});

test('the same staff lock without a failed poster stays silent (intentional protection)', async t => {
  const f = setup(t);lock(f,3);
  await f.run();f.advance(ALERT_GRACE_MS);await f.run();
  assert.notEqual(f.incident('weekly')?.state,'attention');assert.equal(f.sent.length,0);
});

test('one dispatch pass delivers daily and weekly alerts past a superseded stale claim', async t => {
  const f = setup(t);f.state.candidate = unverified();
  f.state.posts.push(post('583672228384067_1753802986287578','Monday Lunch Specials','2026-11-02T15:10:58+0000'));
  f.readings.set('Monday Lunch Specials',Object.assign(Error('provider rejected'),{status:400}));
  await f.run();
  assert.equal(f.incident('daily')?.state,'attention');assert.equal(f.incident('weekly')?.state,'attention');
  // A stale, unverifiable ready incident sorts first and is superseded, never sent.
  f.db.prepare("INSERT INTO facebook_alert_incidents(incident_key,day,scope,code,state,first_seen_ms,observed_ms,due_ms,proof_json)"
    +" VALUES('2026-11-02:weekly:weekly_lunch_failed:0000000000000000','2026-11-02','weekly','weekly_lunch_failed','attention',1,1,1,'{\"version\":1}')").run();
  f.advance(ALERT_GRACE_MS);
  const counts = await f.send();
  assert.deepEqual(counts,{sent:2,uncertain:0,superseded:1});
  assert.deepEqual(f.sent.map(m=>m.incidentKey.split(':')[1]).sort(),['daily','weekly']);
  assert.equal(f.db.prepare("SELECT sent_ms FROM facebook_alert_incidents WHERE incident_key LIKE '%:0000000000000000'").get().sent_ms,null);
});

test('an equivalent later repost does not send a second weekly email', async t => {
  const f = setup(t);f.state.candidate = unverified();
  await f.run();f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,1);
  f.state.posts.push(post('583672228384067_1753900000000000','Weekly lunch specials (repost)','2026-11-02T16:00:00+0000'));
  f.advance(10*60000);await f.run();f.advance(ALERT_GRACE_MS);await f.send();await f.run();await f.send();
  assert.equal(f.sent.length,1);assert.equal(f.incidents('weekly').length,1);
});

test('a materially different later weekly failure is alerted, not absorbed', async t => {
  const f = setup(t);f.state.candidate = unverified();
  await f.run();f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,1);
  const changed = unverified();changed.entries[2].content = 'Hot Turkey with Fries and a Drink $10.50';
  f.readings.set('Weekly lunch CORRECTED',changed);
  f.state.posts.push(post('583672228384067_1753900000000001','Weekly lunch CORRECTED','2026-11-02T15:55:00+0000'));
  f.advance(10*60000);await f.run();
  const rows = f.incidents('weekly');
  assert.equal(rows.length,2);assert.notEqual(rows[0].incident_key,rows[1].incident_key);
  assert.equal(rows[0].state,'suppressed','the sent original is superseded, never resent');
  f.advance(ALERT_GRACE_MS-1);await f.send();assert.equal(f.sent.length,1,'the new failure observes its own grace');
  f.advance(1);await f.send();assert.equal(f.sent.length,2);
  assert.equal(f.sent[1].incidentKey,rows[1].incident_key);
});

test('a different failure before the first is sent replaces it: one email', async t => {
  const f = setup(t);f.state.candidate = unverified();
  await f.run();
  const changed = unverified();changed.entries[2].content = 'Hot Turkey with Fries and a Drink $10.50';
  f.readings.set('Weekly lunch CORRECTED',changed);
  f.state.posts.push(post('583672228384067_1753900000000001','Weekly lunch CORRECTED','2026-11-02T15:25:00+0000'));
  f.advance(10*60000);await f.run();
  f.advance(2*ALERT_GRACE_MS);await f.send();await f.send();
  assert.equal(f.sent.length,1);
  assert.equal(f.incidents('weekly').filter(r=>r.state==='attention').length,1);
});

test('a resolved weekly failure clears every fingerprinted incident of the day', async t => {
  const f = setup(t);f.state.candidate = unverified();
  await f.run();
  f.state.posts = [];f.advance(10*60000);await f.run();
  assert.ok(f.incidents('weekly').every(r=>r.state==='suppressed'));
  f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,0);
});

test('a deleted post after its email was sent is not resent or republished', async t => {
  const f = setup(t);f.state.candidate = unverified();
  await f.run();f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,1);
  f.state.posts = [];f.advance(10*60000);await f.run();await f.send();
  assert.equal(f.sent.length,1);assert.equal(f.incident('weekly').state,'suppressed');
  [1,2,3,4,5].forEach(d=>assert.equal(f.lunch(d).content,''));
});

// ── Review follow-up 2: conflict fingerprints, provenance, precedence ───────

// A valid poster that differs from MEALS only on Monday.
const mondayAs = meal => weekly('asterisk',(e,i)=>i===0?{...e,content:meal,evidence:'* MONDAY * '+meal}:e);

// Posters with the same posting time cannot be ordered, so a difference stays a conflict.
const samePostingTime = f => Object.assign(f.state.posts[1],{created_time:f.state.posts[0].created_time,updated_time:f.state.posts[0].updated_time});

test('Monday conflict A/B alerted, then B changes to C: the new conflict gets a new fingerprint', async t => {
  const f = setup(t);samePostingTime(f);
  f.readings.set('Weekly lunch specials!!',mondayAs('Patty Melt with Fries and a Drink $10.50'));
  await f.run();
  assert.ok(f.imports().every(i=>i.processing_status==='staged'));
  assert.equal(f.lunch(1).content,'','conflicting Monday is never published');
  assert.equal(f.lunch(2).content,MEALS[1],'agreed weekdays still publish');
  const first = f.incident('weekly');
  assert.equal(first.state,'attention');
  f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,1);
  // Poster B is replaced at the same posting time by a third Monday meal (C).
  f.readings.set('Weekly lunch REVISED',mondayAs('Reuben with Chips and a Drink $10.50'));
  f.state.posts[1]=post('583672228384067_1753900000000003','Weekly lunch REVISED',f.state.posts[0].created_time);
  f.advance(5*60000);await f.run();
  const second = f.incident('weekly');
  assert.equal(second.state,'attention');
  assert.notEqual(second.incident_key,first.incident_key,'a materially different conflict is a new incident');
  f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,2);
});

test('an equivalent repost of a conflicting poster keeps the same conflict fingerprint', async t => {
  const f = setup(t);samePostingTime(f);
  const b = mondayAs('Patty Melt with Fries and a Drink $10.50');
  f.readings.set('Weekly lunch specials!!',b);
  await f.run();
  const first = f.incident('weekly');
  f.advance(ALERT_GRACE_MS);await f.send();assert.equal(f.sent.length,1);
  f.readings.set('Weekly lunch B again',b);
  f.state.posts.push(post('583672228384067_1753900000000002','Weekly lunch B again',f.state.posts[0].created_time));
  f.advance(5*60000);await f.run();
  assert.equal(f.incident('weekly').incident_key,first.incident_key);
  f.advance(ALERT_GRACE_MS);await f.send();await f.run();await f.send();
  assert.equal(f.sent.length,1);
});

const slotSet = (f,day,sql,...args) => f.db.prepare(`UPDATE special_slots SET ${sql} WHERE group_id=? AND position=1`).run(...args,f.lunch(day).group_id);
// A second Lunch group makes the weekday's destination ambiguous: publication cannot proceed.
const ambiguous = (f,day) => f.db.prepare("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) VALUES(?,'auto-week',?,'lunch','Extra Lunch','',98,1)").run(`extra-lunch-${day}`,day);
const unambiguous = (f,day) => f.db.prepare('DELETE FROM special_groups WHERE id=?').run(`extra-lunch-${day}`);

test('matching text without automation provenance is republished by the verified poster, then counts', async t => {
  const f = setup(t);
  slotSet(f,2,"content=?,origin='automation',manual_locked=0,last_auto_value=NULL",MEALS[1]);
  f.readings.set('Weekly lunch specials!!',unverified());
  await f.run();
  const s = f.lunch(2);
  assert.deepEqual([s.content,s.origin,s.last_auto_value],[MEALS[1],'automation',MEALS[1]]);
  assert.notEqual(f.incident('weekly')?.state,'attention');
});

test('matching automated text with a separate price is replaced; the separate price is cleared', async t => {
  const f = setup(t);
  slotSet(f,4,"content=?,origin='automation',manual_locked=0,last_auto_value=?,price='$2.00'",MEALS[3],MEALS[3]);
  await f.run();
  assert.deepEqual([f.lunch(4).content,f.lunch(4).price],[MEALS[3],'']);
  assert.notEqual(f.incident('weekly')?.state,'attention');
});

test('a current daily poster for the weekday is explicit precedence: suppressed, no email', async t => {
  const f = setup(t);
  f.state.posts.push(post('583672228384067_1753802986287578','Monday lunch special','2026-11-02T14:40:00+0000'));
  f.readings.set('Monday lunch special',{evidence_version:2,day_of_week:1,day_evidence:'Monday',poster_evidence:'Monday Lunch Special 11am-1:30pm',
    offers:[{content:'Patty Melt with Fries and a Drink $10.25',evidence:'Patty Melt with Fries and a Drink $10.25',service_time:'11am-1:30pm',service_evidence:'Lunch Special 11am-1:30pm',uncertainties:[]}]});
  // An earlier weekly incident lets the store record the explicit outcome.
  f.db.prepare("INSERT INTO facebook_alert_incidents(incident_key,day,scope,code,state,first_seen_ms,observed_ms,due_ms) VALUES('2026-11-02:weekly:weekly_lunch_failed:1111111111111111','2026-11-02','weekly','weekly_lunch_failed','pending',1,1,1)").run();
  await f.run();
  assert.equal(f.lunch(1).content,'Patty Melt with Fries and a Drink $10.25','the daily poster keeps Monday');
  [2,3,4,5].forEach(d=>assert.equal(f.lunch(d).content,MEALS[d-1]));
  assert.equal(f.incident('weekly').state,'suppressed','precedence is explicit, not resolved');
  f.advance(ALERT_GRACE_MS);await f.run();await f.send();assert.equal(f.sent.length,0);
});

test('a retained automated value without a current daily poster alerts as a discrepancy', async t => {
  const f = setup(t);
  slotSet(f,3,"content='Older weekly meal $9',origin='automation',manual_locked=0,last_auto_value='Older weekly meal $9'");
  await f.run();
  assert.equal(f.lunch(3).content,'Older weekly meal $9','automation never overwrites it');
  const row = f.incident('weekly');
  assert.equal(row?.state,'attention');assert.equal(JSON.parse(row.proof_json).cause,'publication_blocked');
  f.advance(ALERT_GRACE_MS);await f.send();
  const text = alertMessage(f.sent[0].day,f.sent[0].code,f.sent[0]).text;
  assert.match(text,/- Wednesday: Website shows a different automated meal that this poster cannot replace/);
  assert.doesNotMatch(text,/Older weekly meal/);
});

test('a held weekday later corrected by staff is suppressed; fixed and published is resolved', async t => {
  const f = setup(t);
  ambiguous(f,2);
  await f.run();assert.equal(f.incident('weekly').state,'attention');
  unambiguous(f,2);correct(f,2);
  f.advance(5*60000);await f.run();
  assert.equal(f.incident('weekly').state,'suppressed');
  const g = setup(t);
  ambiguous(g,2);
  await g.run();assert.equal(g.incident('weekly').state,'attention');
  unambiguous(g,2);
  g.advance(5*60000);await g.run();
  assert.equal(g.lunch(2).content,MEALS[1]);
  assert.equal(g.incident('weekly').state,'resolved','every weekday verified published');
  g.advance(ALERT_GRACE_MS);await g.send();assert.equal(g.sent.length,0);
});

// ── Corrected poster replacement (original deleted, corrected uploaded) ─────

const priced = amount => weekly('asterisk',e=>({...e,content:e.content.replace('$10.50',amount),evidence:e.evidence.replace('$10.50',amount)}));
const NEW = MEALS.map(m=>m.replace('$10.50','$11.00'));
const original = f => { f.state.posts = [f.state.posts[0]]; };
const corrected = (f,created='2026-11-02T15:30:00+0000',reading=priced('$11.00')) => {
  f.readings.set('Weekly lunch CORRECTED',reading);
  f.state.posts.push(post('583672228384067_1753999999999999','Weekly lunch CORRECTED',created));
};
const DAILY = {evidence_version:2,day_of_week:1,day_evidence:'Monday',poster_evidence:'Monday Lunch Special 11am-1:30pm',
  offers:[{content:'Patty Melt with Fries and a Drink $10.25',evidence:'Patty Melt with Fries and a Drink $10.25',service_time:'11am-1:30pm',service_evidence:'Lunch Special 11am-1:30pm',uncertainties:[]}]};
const withDaily = f => {
  f.state.posts.push(post('583672228384067_1753802986287578','Monday lunch special','2026-11-02T14:55:00+0000'));
  f.readings.set('Monday lunch special',DAILY);
};
const graph = (t,respond) => {
  const images = globalThis.fetch;
  t.mock.method(globalThis,'fetch',async input=>new URL(input).hostname==='graph.facebook.com' ? respond(new URL(input)) : images(input));
};
const allSlots = f => f.db.prepare('SELECT * FROM special_slots ORDER BY group_id,position').all();
const revision = f => f.db.prepare("SELECT revision FROM special_collections WHERE id='auto-week'").get().revision;

test('original weekly poster publishes Monday through Friday', async t => {
  const f = setup(t);original(f);
  await f.run();
  MEALS.forEach((m,i)=>assert.equal(f.lunch(i+1).content,m));
  assert.equal(f.weeklyWrites(),1);
});

test('original deleted, corrected poster appears: unchanged automation slots are replaced', async t => {
  const f = setup(t);original(f);
  await f.run();
  f.state.posts = [];corrected(f);
  f.advance(20*60000);await f.run();
  NEW.forEach((m,i)=>assert.equal(f.lunch(i+1).content,m));
  for (const d of [1,2,3,4,5]) { const s=f.lunch(d);assert.equal(s.origin,'automation');assert.equal(s.last_auto_value,s.content);assert.equal(s.manual_locked,0); }
  assert.match(f.db.prepare("SELECT detail FROM special_import_events WHERE detail LIKE 'GUARDED_WEEKLY_LUNCH:%' ORDER BY id DESC").get().detail,/replaced 5 superseded poster value\(s\)/);
  // Idempotent: a repeated scan writes nothing more and raises no alert.
  const rev = revision(f);
  f.advance(ALERT_GRACE_MS);await f.run();await f.send();
  assert.equal(revision(f),rev);
  assert.notEqual(f.incident('weekly')?.state,'attention');assert.equal(f.sent.length,0);
});

test('a corrected poster replaces staff edits made before it; a later edit, a legacy lock and a disabled slot are untouched', async t => {
  const f = setup(t);original(f);
  await f.run();
  lock(f,2,'Staff Tuesday meal $9');                                    // edited 15:10, before the 15:30 poster
  slotSet(f,3,"content='Staff Wednesday edit $9',origin='manual',manual_locked=1");  // a lock with no edit time
  slotSet(f,4,"content=?",MEALS[3]+' (staff note)');                    // changed since automation
  f.db.prepare('UPDATE special_groups SET enabled=0 WHERE id=?').run(f.lunch(5).group_id);
  f.state.posts = [];corrected(f);
  f.advance(20*60000);await f.run();
  [1,2,4].forEach(d=>assert.equal(f.lunch(d).content,NEW[d-1]));
  assert.equal(f.lunch(3).content,'Staff Wednesday edit $9','a lock saved before edit times existed is kept');
  assert.equal(f.lunch(2).manual_locked,0);
  assert.equal(f.lunch(5).content,MEALS[4],'disabled destination is not written');
  // A staff correction after the corrected poster stays through later scans of it.
  lock(f,2,'Staff Tuesday meal $9','2026-11-02T15:45:00.000Z');
  f.advance(10*60000);await f.run();
  assert.equal(f.lunch(2).content,'Staff Tuesday meal $9');
});

test('a corrected poster never overwrites a current daily poster value', async t => {
  const f = setup(t);original(f);withDaily(f);
  await f.run();
  assert.equal(f.lunch(1).content,normalizeMenuCase(DAILY.offers[0].content));
  f.state.posts = f.state.posts.filter(p=>p.message==='Monday lunch special');corrected(f);
  f.advance(20*60000);await f.run();
  assert.equal(f.lunch(1).content,normalizeMenuCase(DAILY.offers[0].content),'daily offer kept');
  [2,3,4,5].forEach(d=>assert.equal(f.lunch(d).content,NEW[d-1]));
  assert.notEqual(f.incident('weekly')?.state,'attention','actual daily publication is legitimate precedence');
});

test('original still present beside a newer corrected poster: the newer poster controls', async t => {
  const f = setup(t);original(f);
  await f.run();
  corrected(f);
  f.advance(20*60000);await f.run();
  NEW.forEach((m,i)=>assert.equal(f.lunch(i+1).content,m));
  assert.notEqual(f.incident('weekly')?.state,'attention');
});

test('an equivalent corrected repost after deletion causes no redundant write', async t => {
  const f = setup(t);original(f);
  await f.run();
  f.state.posts = [];corrected(f,'2026-11-02T15:30:00+0000',weekly());
  const writes = f.weeklyWrites(),rev = revision(f);
  f.advance(20*60000);await f.run();
  MEALS.forEach((m,i)=>assert.equal(f.lunch(i+1).content,m));
  assert.equal(f.weeklyWrites(),writes);assert.equal(revision(f),rev);
});

test('a staged poster deleted before its held day became eligible never publishes stale meals', async t => {
  const f = setup(t);original(f);
  ambiguous(f,2);
  await f.run();
  assert.equal(f.lunch(2).content,'');
  f.state.posts = [];unambiguous(f,2);
  f.advance(20*60000);await f.run();
  assert.equal(f.lunch(2).content,'','deleted evidence is not reused');
  f.advance(ALERT_GRACE_MS);await f.run();await f.send();assert.equal(f.sent.length,0);
});

test('a deleted poster with no replacement leaves existing specials in place', async t => {
  const f = setup(t);original(f);
  await f.run();
  const before = allSlots(f);
  f.state.posts = [];
  f.advance(20*60000);await f.run();
  assert.deepEqual(allSlots(f),before);
});

test('a corrected poster on Wednesday never republishes Monday or Tuesday', async t => {
  const f = setup(t);original(f);
  await f.run();
  f.state.now = Date.parse('2026-11-04T15:20:00Z');
  f.state.posts = [];corrected(f,'2026-11-04T15:00:00+0000');
  await f.run();
  assert.equal(f.lunch(1).content,MEALS[0]);assert.equal(f.lunch(2).content,MEALS[1]);
  [3,4,5].forEach(d=>assert.equal(f.lunch(d).content,NEW[d-1]));
});

for (const [name,respond] of [
  ['HTTP failure',()=>new Response('',{status:500})],
  ['malformed body',()=>Response.json({error:{message:'bad'}})],
  ['looping pagination',()=>Response.json({data:[],paging:{next:'https://graph.facebook.com/next',cursors:{after:'same'}}})],
  ['exception',()=>{throw Error('network down');}],
]) test(`Facebook ${name} never masquerades as an empty scan`, async t => {
  const f = setup(t);f.state.candidate = unverified();
  await f.run();
  assert.equal(f.incident('weekly').state,'attention');
  const before = allSlots(f);
  graph(t,respond);
  const calls = f.state.aiCalls;
  f.advance(10*60000);await f.run();
  assert.equal(f.incident('weekly').state,'attention','an outage is not a deletion');
  assert.deepEqual(allSlots(f),before);
  assert.equal(f.state.aiCalls,calls);
  assert.equal((await readAlertHealth(f.env)).incomplete_scans,1,'the unavailable scan stays visibly incomplete');
});

test('after a Facebook outage the unresolved weekly failure is still alerted once', async t => {
  const f = setup(t);f.state.candidate = unverified();
  await f.run();
  const restore = globalThis.fetch;
  graph(t,()=>new Response('',{status:503}));
  f.advance(ALERT_GRACE_MS);await f.run();await f.send();
  assert.equal(f.sent.length,0,'no send from evidence the outage could not re-verify');
  t.mock.method(globalThis,'fetch',restore);
  // The superseded outage claim holds the normal dispatch lease (5 minutes);
  // the next scheduled scan re-verifies the still-unresolved failure and sends.
  f.advance(ALERT_LEASE_MS);await f.run();await f.send();await f.run();await f.send();
  assert.equal(f.sent.length,1);
});

test('a staged daily poster without its actual publication is not precedence', async t => {
  const f = setup(t);original(f);withDaily(f);
  await f.run();
  assert.notEqual(f.incident('weekly')?.state,'attention');
  // The slot now shows an automated value that is NOT the daily poster's offer.
  slotSet(f,1,"content='Older weekly meal $9',last_auto_value='Older weekly meal $9'");
  f.advance(60000);
  await finishAlertScan(f.env,await beginAlertScan(f.env,'2026-11-02',f.state.now),f.imports().map(s=>s.id),{send:async m=>f.sent.push(m)});
  assert.equal(f.incident('weekly')?.state,'attention');
  f.advance(ALERT_GRACE_MS);await f.send();
  // The daily scope independently reports its own unpublished offer.
  const weeklyMessage = f.sent.find(m=>m.incidentKey.includes(':weekly:'));
  assert.ok(weeklyMessage);
  assert.match(alertMessage(weeklyMessage.day,weeklyMessage.code,weeklyMessage).text,/- Monday: Website shows a different automated meal/);
});
