import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {runImportPipeline} from './worker.js';
import {ALERT_GRACE_MS} from './alert-store.js';
import {dailyAlertDetail,deliveryAlertDetail,plainValue,formatAlertText} from './alert-detail.js';
import {alertMessage} from './alert-email.js';

// Verified-snapshot shape: [imports, weeks, collections, groups, slots, ...].
const group=(id,service,day=1,enabled=1)=>({id,collection_id:'week:77',day_of_week:day,service,enabled});
const slot=(group_id,position,content,origin='automation')=>({group_id,position,content,origin});
const DATA=[[],[{id:77,week_start_date:'2026-10-26',week_end_date:'2026-11-01'}],[{id:'week:77',kind:'week',weekly_special_id:77}],
  [group('l','lunch'),group('a','all-day'),group('n','nightly'),group('s','custom'),group('n2','nightly',2)],
  [slot('l',1,'3 Topping Personal Pizza & a Drink - $9.75'),
   slot('a',1,'Grilled Honey Mustard Chicken Sandwich with Side Salad, Soup or Coleslaw $10.25'),
   slot('a',2,'Grilled Ham and Cheese with a Cup of Soup or Coleslaw $7.25'),
   slot('n',1,'2 Burgers and 1 Order of Fries','manual'),slot('n',2,'Half Rack Ribs w/ Mac n Cheese & Coleslaw','manual'),
   slot('s',1,'Chicken Noodle'),slot('n2',1,'Tuesday value')]];
// The production October 26 reconciliation: three meals with no established service.
const OCT26={blocked:[1,2,3].map(position=>({day_of_week:1,service:'unknown',group_id:null,position,content:'',reason:'Service not established by evidence'})),rejectedSources:[]};
const send=detail=>alertMessage('2026-10-26','publication_blocked',{detail,firstSeenMs:Date.parse('2026-10-26T21:30:00Z')});

test('October 26 alert reports a classification failure without guessing slots',()=>{
  const detail=dailyAlertDetail(OCT26,DATA,'2026-10-26',1);
  assert.deepEqual(detail.holds,[{category:'Unidentified service',reason:'Service not established by evidence',count:3,stage:'classification'}]);
  assert.deepEqual(detail.current,[]);
  const {subject,text}=send(detail);
  assert.equal(subject,"Grayz'n Buffalo automation needs review — 2026-10-26 (Unidentified service)");
  const expectedLines=[
    'Available Facebook evidence could not be fully published.',
    'Date: Monday, 2026-10-26 (Chicago)',
    'First detected: 4:30 PM',
    'Stage: classification',
    '',
    'Held:',
    '- Unidentified service: 3 items, Service not established by evidence',
    '  (The service could not be identified, so no slot is named.)',
    '',
    'Published by automation today: Lunch (1), All Day (2), Soup (1)',
    '',
    'Automatic retry: none pending',
    'Correction: needed for Monday. Review the held imports and use Approve & Publish; approved values are protected from automation. The specials editor is also available.',
    'Open: https://grayznbuffalo.com/admin/specials?week=77#weekly-day-0',
    'Review imports: https://grayznbuffalo.com/admin/automation?date=2026-10-26',
  ];
  for(const line of expectedLines.filter(Boolean)) assert.ok(text.split('\n').includes(line),line);
  assert.match(text,/Result: Partially Published/);
  assert.match(text,/Published value: Monday Lunch #1: 3 Topping Personal Pizza/);
});

test('identified holds show the stored values and the staff-protected count',()=>{
  const detail=dailyAlertDetail({blocked:[
    {service:'all-day',position:1,reason:'Conflicting source offers'},
    {service:'nightly',position:1,reason:'Protected or ineligible destination slot'}]},DATA,'2026-10-26',1);
  assert.deepEqual(detail.holds,[{category:'All Day',reason:'Conflicting source offers',count:1,stage:'cross-post agreement'}]);
  assert.equal(detail.protectedCount,0); // No matching fenced staff lock was supplied.
  const {text}=send(detail);
  assert.match(text,/\nNow showing for All Day: Grilled Honey Mustard Chicken Sandwich with Side Salad, Soup or Coleslaw \$10\.25 \| Grilled Ham and Cheese with a Cup of Soup or Coleslaw \$7\.25\n/);
  assert.match(text,/Destination slot is missing/);
  assert.match(text,/\nStage: cross-post agreement\n/);
});

test('unknown or Facebook-derived reasons collapse to a fixed label',()=>{
  const detail=dailyAlertDetail({blocked:[{service:'nightly',reason:'Repeated All Day price conflict; retained Visit http://evil.example now $1'}],
    rejectedSources:[{source_id:'x',fb_post_id:'y',reason:'Unresolved weekly meals: [{"day":1,"reason":"<script>"}]'}]},DATA,'2026-10-26',1);
  assert.deepEqual(detail.holds.map(h=>[h.category,h.reason,h.stage]),
    [['Nightly','Other reconciliation hold','reconciliation'],['Facebook post','Other reconciliation hold','reconciliation']]);
  const {text}=send(detail);
  for(const bad of ['evil','http://','<','script','Repeated','retained','Unresolved weekly','fb_post'])
    assert.ok(!text.includes(bad),bad);
});

test('stored values are reduced to bounded plain words with no links, markup or control text',()=>{
  assert.equal(plainValue('Burger <b>$10</b>\n‮evil\u0007 visit https://evil.example/x or www.evil.com, mail a@b.co'),'Burger b $10 /b evil visit or mail');
  assert.equal(plainValue('Half Rack Ribs w/ Mac n Cheese & Coleslaw — $18.75'),'Half Rack Ribs w/ Mac n Cheese & Coleslaw — $18.75');
  assert.equal(plainValue('St. Louis Ribs $9.75 or 2 a.m. snack'),'St. Louis Ribs $9.75 or 2 a.m. snack');
  const long=plainValue('A'.repeat(500));
  assert.equal(long.length,80);assert.ok(long.endsWith('…'));
  const detail=dailyAlertDetail({blocked:[{service:'nightly',reason:'Missing meal price'}]},
    [...DATA.slice(0,4),[slot('n',1,'Ribs [click](https://evil.example) <a href="x">'+'B'.repeat(300))]],'2026-10-26',1);
  const showing=send(detail).text.split('\n').find(l=>l.startsWith('Now showing for Nightly: '));
  assert.ok(showing.length<=25+80);
  assert.ok(!/https?:|evil|[<>\[\]]/.test(showing),showing);
});

test('missing week, invalid input and delivery alerts fall back to fixed links',()=>{
  assert.equal(dailyAlertDetail(OCT26,[[],[],[],[],[]],'2026-10-26',1).editorUrl,'https://grayznbuffalo.com/admin/specials');
  assert.equal(dailyAlertDetail(OCT26,DATA,'bad',1),null);
  assert.equal(dailyAlertDetail(OCT26,DATA,'2026-10-26',9),null);
  const {text}=alertMessage('2026-10-26','delivery_failed');
  assert.match(text,/\nStage: delivery activation\n/);
  assert.match(text,/\nOpen: https:\/\/grayznbuffalo\.com\/admin#delivery-display$/);
  // A diagnostic for another day is never attached.
  assert.doesNotMatch(formatAlertText({day:'2026-10-27',code:'publication_blocked',summary:'s',detail:dailyAlertDetail(OCT26,DATA,'2026-10-26',1)}),/Held:/);
  assert.match(alertMessage('2026-10-26','retry_exhausted').text,/\nAutomatic retry: exhausted\n/);
});

// ── Integration: the verified dispatch carries the diagnostic, still once ─────

function setup(t,options={candidate:{evidence_version:2,day_of_week:3,day_evidence:'Wednesday',poster_evidence:'Wednesday Specials',
    offers:['Burger $10','Fish Fry $12'].map(content=>({content,evidence:content,service_time:'',service_evidence:'',date_evidence:'',uncertainties:[]}))}}) {
  let db;t.after(()=>db?.close());
  const f=harness(t,options);
  db=new DatabaseSync(f.path);
  db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT); INSERT OR REPLACE INTO settings VALUES('delivery_display','auto');");
  for(const name of ['0022_delivery_automation.sql','0023_facebook_alert_incidents.sql','0024_facebook_alert_evidence.sql']) db.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  const DB={prepare(query) {
    const statement={sql:query,args:[],bind(...args){this.args=args;return this;},
      values(){return Object.fromEntries(this.args.map((v,i)=>[String(i+1),v]));},
      async first(){return db.prepare(query).get(this.values())??null;},
      async all(){return {results:db.prepare(query).all(this.values())};},
      async run(){return {meta:{changes:Number(db.prepare(query).run(this.values()).changes)}};}};
    return statement;
  },async batch(statements) {
    db.exec('BEGIN');
    try {
      const result=statements.map(s=>{
        const q=db.prepare(s.sql),values=s.values();
        if(/^\s*SELECT/i.test(s.sql)) return {results:q.all(values),meta:{changes:0}};
        return {results:[],meta:{changes:Number(q.run(values).changes)}};
      });db.exec('COMMIT');return result;
    } catch(e) {db.exec('ROLLBACK');throw e;}
  }};
  Object.assign(f.env,{DB,SPECIALS_ALERT_MODE:'MOCK',SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  const sent=[];
  return {...f,db,sent,run:()=>runImportPipeline(f.env,{send:async m=>sent.push(m)})};
}

test('verified unclassified offers email once with the classification diagnostic and editor link',async t=>{
  const f=setup(t);
  await f.run();
  assert.equal(f.sent.length,0); // grace period
  f.state.now+=ALERT_GRACE_MS;
  await f.run();await f.run();
  assert.equal(f.sent.length,1);
  const [m]=f.sent;
  assert.equal(m.code,'publication_blocked');
  assert.deepEqual(m.detail.holds,[{category:'Unidentified service',reason:'Service not established by evidence',count:2,stage:'classification'}]);
  assert.equal(m.detail.editorUrl,'https://grayznbuffalo.com/admin/specials?week=9000#weekly-day-2');
  assert.ok(Number.isSafeInteger(m.firstSeenMs));
  const {text}=alertMessage(m.day,m.code,{detail:m.detail,firstSeenMs:m.firstSeenMs});
  assert.match(text,/^Available Facebook evidence could not be fully published\.\nDate: Wednesday, 2030-01-09 \(Chicago\)\nFirst detected: /);
  assert.ok(!text.includes('Burger') && !text.includes('Fish'),'unidentified offer text is never included');
});

const OCT28=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct28-delivery-alert.json',import.meta.url),'utf8'));
test('delivery diagnostic distinguishes a compatible expiration mismatch from current expiry without claiming history',()=>{
  const data=[[{id:OCT28.importId,fb_created_time:OCT28.postedAt,candidate_json:JSON.stringify(OCT28.candidate),extracted_json:JSON.stringify(OCT28.candidate)}],[],[],[],[],[{value:'auto'}],
    [{id:1,day:'2026-10-28',active:1,expires_at:OCT28.storedExpiry}],[]];
  const before=deliveryAlertDetail(data,{status:'expected',sourceOutcomes:[{id:OCT28.importId,status:'available'}]},Date.parse('2026-10-28T16:45:00Z'));
  assert.equal(before.mismatch,true);assert.equal(before.compatible,true);assert.equal(before.visibility,'available');
  assert.equal(before.expectedExpiry,'2026-10-28T18:30:00.000Z');
  const detail={day:'2026-10-28',weekday:'Wednesday',delivery:before};
  assert.match(alertMessage(detail.day,'publication_blocked',{detail}).text,/recognized legacy deadline; rendering still ends at 1:30 PM Chicago/);
  data[6][0].active=0;
  detail.delivery=deliveryAlertDetail(data,{status:'expired'},Date.parse('2026-10-28T22:00:00Z'));
  const {text}=alertMessage(detail.day,'publication_blocked',{detail});
  assert.match(text,/visibility at .*: hidden/);
  assert.match(text,/does not establish whether delivery was active earlier/);
  assert.match(text,/Delivery Available 11-1:30/);
  assert.doesNotMatch(text,/delivery failure/i);
});

test('verified destination details distinguish disabled, locked and other ineligible slots and strip unsafe content',()=>{
  const data=structuredClone(DATA);
  data[3].find(g=>g.id==='n').enabled=0;
  data[4].find(s=>s.group_id==='a' && s.position===2).manual_locked=1;
  const detail=dailyAlertDetail({blocked:[
    {service:'all-day',group_id:'a',position:2,content:'Ham <script> https://evil.example a@b.com \u202e $7.25',reason:'Protected or ineligible destination slot'},
    {service:'nightly',group_id:null,position:1,content:'Ribs $18',reason:'Missing, disabled or ambiguous destination'}]},data,'2026-10-26',1);
  assert.equal(detail.informational,true);
  assert.equal(detail.destinations[0].staffLocked,true);
  assert.equal(detail.destinations[1].disabled,true);
  const {text}=send(detail);
  assert.doesNotMatch(text,/[<>\u202e]|evil\.example|a@b\.com/);
  assert.match(text,/Staff-disabled destination/);
  data[4].find(s=>s.group_id==='a' && s.position===2).manual_locked=0;
  assert.equal(dailyAlertDetail({blocked:[{service:'all-day',group_id:'a',position:2,reason:'Protected or ineligible destination slot'}]},data,'2026-10-26',1).informational,false);
});

function october28(t) {
  const f=setup(t,{now:'2026-10-28T16:16:00Z',caption:'Daily Specials',candidate:structuredClone(OCT28.candidate)});
  f.db.exec("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:OCT28.postId,created_time:OCT28.postedAt,updated_time:OCT28.postedAt});
  const held=f.slots(3,'all-day')[1];
  f.db.prepare("UPDATE special_slots SET content=?,origin='manual',manual_locked=1,last_auto_value=NULL WHERE group_id=? AND position=2").run(OCT28.retained,held.group_id);
  return f;
}

test('October 28: staff-protection-only hold retains the locked value and sends no email',async t=>{
  const f=october28(t);
  await f.run();
  assert.equal(f.slots(3,'lunch')[0].content,OCT28.candidate.offers[0].content);
  assert.equal(f.slots(3,'all-day')[0].content,OCT28.candidate.offers[1].content);
  for(let i=0;i<4;i++){f.state.now+=ALERT_GRACE_MS;await f.run();}
  assert.equal(f.sent.length,0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM facebook_alert_incidents WHERE scope='daily' AND state='attention'").get().n,0);
  assert.equal(f.slots(3,'all-day')[1].content,OCT28.retained);
  assert.equal(f.slots(3,'all-day')[1].manual_locked,1);
  // The import record itself is unchanged and remains visible for review.
  assert.ok(f.db.prepare('SELECT id FROM special_imports WHERE fb_post_id=?').get(OCT28.postId));
});

test('staff protection alongside a genuine hold still sends the existing review email',async t=>{
  const f=october28(t);
  const lunch=f.slots(3,'lunch')[0];
  f.db.prepare("UPDATE special_slots SET price='$9.00' WHERE group_id=? AND position=1").run(lunch.group_id);
  await f.run();
  for(let i=0;i<3;i++){f.state.now+=ALERT_GRACE_MS;await f.run();}
  assert.equal(f.sent.length,1);
  const [message]=f.sent;
  assert.equal(message.code,'publication_blocked');
  const {subject,text}=alertMessage(message.day,message.code,{detail:message.detail,firstSeenMs:message.firstSeenMs});
  assert.match(subject,/automation needs review/);
  assert.match(text,/Staff lock: yes/);
  assert.match(text,/separate price/);
  assert.equal(f.slots(3,'all-day')[1].content,OCT28.retained);
  assert.equal(f.slots(3,'all-day')[1].manual_locked,1);
});

test('after the email, a staff correction is kept and the incident is never re-sent',async t=>{
  const f=setup(t);
  await f.run();
  f.state.now+=ALERT_GRACE_MS;
  await f.run();
  assert.equal(f.sent.length,1);
  // Staff correct the held day in the editor (saveCollection locks populated slots).
  for(const [position,content] of [[1,'Burger $10'],[2,'Fish Fry $12']])
    f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=1 WHERE group_id=(SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=3 AND service='all-day') AND position=?",content,position);
  for(let i=0;i<3;i++){f.state.now+=31*60*1000;await f.run();}
  assert.equal(f.sent.length,1);
  assert.deepEqual(f.slots(3,'all-day').slice(0,2).map(s=>[s.content,s.origin,s.manual_locked]),
    [['Burger $10','manual',1],['Fish Fry $12','manual',1]]);
});

// ── October 26 exact records through the alert pipeline ───────────────────────

const OCT26_RECORDS=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct26-monday-night.json',import.meta.url),'utf8'));
async function october26Alerts(t,night) {
  const f=setup(t,{now:'2026-10-26T15:00:00Z',caption:'Monday Specials',candidate:structuredClone(OCT26_RECORDS.morning)});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  Object.assign(f.state.posts[0],{created_time:'2026-10-26T14:00:00Z',updated_time:'2026-10-26T14:00:00Z'});
  const slots=f.slots(1,'nightly');
  ['2 Burgers and 1 Order of Fries','Half Rack Ribs w/ Mac n Cheese & Coleslaw'].forEach((content,i)=>
    f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=0,last_auto_value=NULL WHERE group_id=? AND position=?",content,slots[i].group_id,i+1));
  await f.run();
  f.state.now=Date.parse('2026-10-26T21:30:00Z');
  f.state.posts.unshift({...f.state.posts[0],id:'night',message:'Monday Night Specials',created_time:'2026-10-26T21:22:00Z',updated_time:'2026-10-26T21:22:00Z'});
  f.state.candidate=night;
  await f.run();
  // Past the grace period, with further cron runs.
  for(let i=0;i<3;i++){f.state.now+=ALERT_GRACE_MS;await f.run();}
  return f;
}
const incidents=f=>f.db.prepare("SELECT code,state,sent_ms FROM facebook_alert_incidents WHERE scope='daily'").all();

test('October 26 exact records: fully resolved publication sends no email',async t=>{
  const f=await october26Alerts(t,structuredClone(OCT26_RECORDS.night));
  assert.equal(f.sent.length,0);
  assert.ok(incidents(f).every(i=>i.state!=='attention' && i.sent_ms==null),JSON.stringify(incidents(f)));
  assert.deepEqual(f.slots(1,'nightly').slice(0,2).map(s=>s.content),
    ['2 Burgers and 1 Order of Fries — $14','Half Rack Ribs w/ Mac n Cheese & Coleslaw — $18.75']);
});

test('a genuine October 26 price conflict sends one detailed email with the Monday editor link',async t=>{
  const night=structuredClone(OCT26_RECORDS.night);
  Object.assign(night.offers[2],{content:'Grilled Chicken Honey Mustard Sandwich w/ Side Salad, Soup or Coleslaw — $10.75',
    evidence:'• Grilled Chicken Honey Mustard Sandwich w/ Side Salad, Soup or Coleslaw — $10.75'});
  const f=await october26Alerts(t,night);
  assert.equal(f.sent.length,1);
  const [m]=f.sent;
  assert.equal(m.detail.editorUrl,'https://grayznbuffalo.com/admin/specials?week=9000#weekly-day-0');
  assert.ok(m.detail.holds.length>0);
  const {subject,text}=alertMessage(m.day,m.code,{detail:m.detail,firstSeenMs:m.firstSeenMs});
  assert.match(subject,/— 2026-10-26 \(/);
  assert.match(text,/\nDate: Monday, 2026-10-26 \(Chicago\)\n/);
  assert.match(text,/\nHeld:\n- /);
  assert.match(text,/\nOpen: https:\/\/grayznbuffalo\.com\/admin\/specials\?week=9000#weekly-day-0\nReview imports: https:\/\/grayznbuffalo\.com\/admin\/automation\?date=2026-10-26\nPending import:/);
  assert.equal((text.match(/Pending import: https:\/\/grayznbuffalo\.com\/admin\/automation\?date=2026-10-26#import-[a-f0-9]{32}/g)??[]).length,2);
  // The disputed evening reprint text is never copied into the email.
  assert.ok(!text.includes('$10.75'));
  // The morning All Day values stay published.
  assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),OCT26_RECORDS.morning.offers.slice(1).map(o=>o.content));
});
