import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {loadTs} from './load-ts.mjs';
import {harness} from '../workers/fb-feed/test-fixture.js';
const r=loadTs('src/lib/automation-review.ts');
const now=new Date('2026-10-26T23:00:00Z');
const day='2026-10-26';
const posters=JSON.parse(readFileSync('tests/fixtures/oct26-monday-night.json','utf8'));
const page=(await import('../dist/_worker.js/pages/admin/automation.astro.mjs')).page().default;
const container=await AstroContainer.create();
const request=(date='',method='GET',authenticated=true)=>new Request('https://grayznbuffalo.com/admin/automation'+date,{method,headers:authenticated?{cookie:'gb_session='+'a'.repeat(32)}:{}});
const locals=env=>({runtime:{env,now}});
const addImport=(f,id,candidate,created='2026-10-26T14:00:00Z')=>f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,candidate_json,processing_status,validation_result,fetched_at)
  VALUES(?,?,?,?,'staged','ok',?)`,id,'post-'+id,created,JSON.stringify(candidate),created);
function setup(t) {
  const f=harness(t,{now:now.toISOString(),candidate:posters.morning});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  f.env.SESSIONS={get:async()=> '1'};
  return f;
}
test('review defaults to Chicago date and rejects malformed, future and out-of-retention dates',()=>{
  assert.equal(r.reviewDate(null,new Date('2026-10-27T01:00:00Z')),day);
  for(const bad of ['2026-02-30','2026-10-27','2026-09-26','x',"2026-10-26' OR 1=1"]) assert.throws(()=>r.reviewDate(bad,now));
  assert.equal(r.reviewDate('2026-09-27',now),'2026-09-27');
});
test('historical status uses publication audits, including partial and recovered failed imports',()=>{
  const source={processing_status:'failed',validation_reason:'Rejected extracted evidence'};
  const review=detail=>({event_type:'review',detail});
  assert.equal(r.importOutcome(source,[]).status,'Failed');
  assert.equal(r.importOutcome(source,[review('GUARDED_AUTO_CONFLICT: blocked proposals')]).status,'Held');
  assert.equal(r.importOutcome(source,[review('GUARDED_AUTO_CONFLICT: blocked proposals'),review('GUARDED_AUTO: 2026-10-26; reconciled 2 source(s); 3 slot(s); CONFLICT: 1 blocked proposal(s)')]).status,'Partially Published');
  assert.equal(r.importOutcome(source,[review('GUARDED_AUTO: 2026-10-26; reconciled 2 source(s); 3 slot(s)')]).status,'Published');
  assert.equal(r.importOutcome(source,[review('GUARDED_MEXICAN_NIGHT: fb_created=2026-10-26; 2 group(s); 4 item(s)')]).status,'Published');
});
test('weekly associations require the verified printed range or source creation week; shared price is retained',()=>{
  const week={week_start_date:day};
  const raw={type:'weekly-lunch',date_range:'10/26-10/30',poster_evidence:'Weekly Lunch Specials $9.75',entries:[{day_of_week:1,content:'Pizza and Drink'}]};
  const source={candidate_json:JSON.stringify(raw),fb_created_time:'2026-10-25T14:00:00Z'};
  const result=r.extractedForDay(source,day,week);
  assert.equal(result.scope,'Weekly Lunch'); assert.match(result.values[0],/\$9\.75/);
  assert.deepEqual(r.extractedForDay(source,day,{week_start_date:'2026-11-02'}).values,[]);
  assert.deepEqual(r.extractedForDay({...source,candidate_json:JSON.stringify({...raw,date_range:'10/26-10/31'})},day,week).values,[]);
});
test('malformed or oversized evidence and unsafe Facebook links fail closed',()=>{
  for(const raw of ['{','null','a'.repeat(24001)]) assert.equal(r.parseReviewEvidence(raw),null);
  for(const link of ['javascript:alert(1)','https://facebook.com.evil.example/post','https://user:secret@facebook.com/post','https://facebook.com:8080/post']) {
    assert.equal(r.facebookLink(link),null);
  }
  assert.equal(r.facebookLink('https://www.facebook.com/post?tracking=secret'),'https://www.facebook.com/post');
  assert.doesNotMatch(r.reviewText('<script>alert(1)</script> https://evil.example x@y.example'),/[<>]|https:|@/);
});
test('review queries preserve all rows and show ownership, protected slots and actual daily date without guessing a slot',async t=>{
  const f=setup(t);addImport(f,'monday',posters.night);addImport(f,'sunday',posters.morning,'2026-10-25T14:00:00Z');
  const group=f.slots(1,'nightly')[0].group_id;
  f.sql("UPDATE special_slots SET content='Staff correction $15',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",group);
  f.sql("INSERT INTO special_import_events(import_id,event_type,detail) VALUES('monday','review','GUARDED_AUTO_CONFLICT: Service not established by evidence')");
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  const model=await r.readAutomationReview(f.env,day,now);
  assert.equal(model.history.length,1);assert.equal(model.history[0].id,'monday');assert.equal(model.history[0].status,'Held');
  assert.match(model.history[0].editor,/week=9000#weekly-day-0/);
  const slot=model.groups.find(g=>g.id===group).slots[0];assert.equal(slot.owner,'Staff corrected');assert.equal(slot.protection,'Yes — staff locked');
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.equal(f.sql('SELECT COUNT(*) n FROM special_import_events')[0].n,1);
});
test('unauthenticated and expired sessions are rejected before database access',async()=>{
  for(const authed of [false,true]) {
    const env={SESSIONS:{get:async()=>null},DB:{prepare(){throw Error('Must not read D1');}}};
    const response=await container.renderToResponse(page,{request:request('', 'GET',authed),locals:locals(env)});
    assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/admin');
  }
});
test('authenticated page escapes evidence, exposes correction navigation and rejects POST without writes',async t=>{
  const f=setup(t);addImport(f,'unsafe',{...posters.night,offers:[{content:'<img src=x onerror=alert(1)> Burger $14'}]});
  const response=await container.renderToResponse(page,{request:request('?date='+day),locals:locals(f.env)});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const html=await response.text();assert.match(html,/Automation Review/);assert.match(html,/week=9000#weekly-day-0/);assert.match(html,/Burger \$14/);
  assert.doesNotMatch(html,/<img src=x|<script>alert\(1\)/);
  assert.match(html,/No identical saved text/);
  const post=await container.renderToResponse(page,{request:request('','POST'),locals:locals(f.env)});
  assert.equal(post.status,405);
  const bad=await container.renderToResponse(page,{request:request('?date=2026-02-30'),locals:locals(f.env)});
  assert.equal(bad.status,400);
});
test('bounded history and optional missing event records degrade explicitly; only SELECT queries run',async t=>{
  const f=setup(t),queries=[];addImport(f,'monday',posters.morning);
  const original=f.env.DB.prepare;
  f.env.DB.prepare=sql=>{queries.push(sql);assert.match(sql,/^SELECT/);if(sql.includes('FROM special_events')) throw Error('missing table');return original(sql);};
  const model=await r.readAutomationReview(f.env,day,now);
  assert.equal(model.eventsUnavailable,true);assert.equal(model.history.length,1);
  assert.ok(queries.every(sql=>/LIMIT/.test(sql)));
  const imports=queries.find(sql=>sql.includes('FROM special_imports'));
  assert.match(imports,/julianday\(CASE WHEN fb_created_time GLOB/);assert.doesNotMatch(imports,/julianday\(fb_created_time\)/);
});

test('conflict reasons are human readable without raw JSON or guessed associations',()=>{
  const detail='GUARDED_AUTO_CONFLICT: 2026-10-26; blocked proposals: '+JSON.stringify([{reason:'Service not established by evidence',content:'private raw evidence'},{reason:'Service not established by evidence'}]);
  assert.equal(r.reviewReason(detail),'Service not established by evidence (2 items)');
  assert.doesNotMatch(r.reviewReason(detail),/private|group_id|\{|\}/);
});
test('special events link only by exact source import ID and expired events stay hidden',async t=>{
  const f=setup(t);addImport(f,'event-source',posters.night);addImport(f,'other-source',posters.morning);
  f.sql(`INSERT INTO special_events(id,title,event_date,end_time,status,origin,manual_locked,date_basis,source_import_id)
    VALUES('evt:test','Game Day','2026-10-26','12:00','published','automation',0,'printed-date','event-source')`);
  f.sql("INSERT INTO special_event_offers(event_id,position,content) VALUES('evt:test',1,'Event Burger $8')");
  const model=await r.readAutomationReview(f.env,day,now);
  assert.equal(model.specialEvents[0].visibility,'Saved; not currently visible');
  assert.equal(model.history.find(i=>i.id==='event-source').editor,'/admin/specials#special-events');
  assert.notEqual(model.history.find(i=>i.id==='other-source').editor,'/admin/specials#special-events');
});
test('date filtering includes late Chicago posts stored on the next UTC date',async t=>{
  const f=setup(t);addImport(f,'late',posters.night,'2026-10-27T01:00:00Z');
  addImport(f,'tomorrow',posters.night,'2026-10-27T06:00:00Z');
  const model=await r.readAutomationReview(f.env,day,new Date('2026-10-27T02:00:00Z'));
  assert.deepEqual(model.history.map(i=>i.id),['late']);
});
test('timestamps are normalized to UTC and service clocks retain minutes',()=>{
  assert.equal(r.reviewTimestamp('2026-10-26T16:21:12-05:00'),'2026-10-26 21:21:12');
  assert.equal(r.reviewTimestamp('2026-10-26 21:21:12'),'2026-10-26 21:21:12');
  assert.equal(r.reviewTimestamp('not a time'),'');
  assert.equal(r.reviewServiceTime('11 AM–1:30 PM'),'11 AM–1:30 PM');
});

// Facebook Graph timestamps are stored verbatim with a +0000 offset, which
// SQLite date functions reject. These mirror the three October 26 production
// imports (morning, weekly lunch and Monday Night) as historical fixtures.
const weeklyLunch={type:'weekly-lunch',evidence_version:2,poster_evidence:'WEEKLY LUNCH SPECIALS • $9.75 • 10/26-10/30',date_range:'10/26-10/30',service_time:'11 AM-1:30 PM',
  entries:['3 Topping Personal Pizza & a Drink','Chicken Bacon Ranch Wrap w/ French Fries & a Drink','Patty Melt w/ Beer Fries & a Drink','Chicken Alfredo w/ Garlic Bread & a Drink','Fish Sandwich w/ French Fries & a Drink']
    .map((content,i)=>({day_of_week:i+1,content,evidence:content,uncertainties:[]}))};
const addFacebookImport=(f,id,candidate,created,link='https://www.facebook.com/grayznbuffalo/posts/'+id+'?tracking=x')=>f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,permalink_url,candidate_json,processing_status,validation_result,fetched_at)
  VALUES(?,?,?,?,?,'staged','ok',?)`,id,'post-'+id,created,link,JSON.stringify(candidate),created);
function oct26(f) {
  addFacebookImport(f,'0f4721505f4f1e0cca16a15ebdac28bb',posters.morning,'2026-10-26T13:56:03+0000');
  addFacebookImport(f,'weekly-lunch-1026',weeklyLunch,'2026-10-26T13:00:00+0000');
  addFacebookImport(f,'2bf18eb7324993a80d60d7e7392faa17',posters.night,'2026-10-26T21:22:00+0000');
}
test('SQLite rejects the stored Facebook +0000 offset unless normalized',async t=>{
  const f=setup(t);
  const [row]=f.sql("SELECT julianday('2026-10-26T13:56:03+0000') raw,julianday('2026-10-26T13:56:03+00:00') normalized");
  assert.equal(row.raw,null);assert.ok(row.normalized>0);
});
test('October 26 Facebook imports with +0000 timestamps appear on October 26',async t=>{
  const f=setup(t);oct26(f);
  const model=await r.readAutomationReview(f.env,day,now);
  assert.deepEqual(model.history.map(i=>i.id).sort(),['0f4721505f4f1e0cca16a15ebdac28bb','2bf18eb7324993a80d60d7e7392faa17','weekly-lunch-1026']);
  assert.equal(model.history.find(i=>i.id==='0f4721505f4f1e0cca16a15ebdac28bb').created,'2026-10-26 13:56:03');
  const lunch=model.history.find(i=>i.id==='weekly-lunch-1026');
  assert.equal(lunch.scope,'Weekly Lunch');assert.deepEqual(lunch.values.map(v=>v.value),['3 Topping Personal Pizza & a Drink - $9.75']);
  assert.ok(model.history.find(i=>i.id==='2bf18eb7324993a80d60d7e7392faa17').values.some(v=>/2 Burgers/.test(v.value)));
  assert.equal(model.truncated,false);
});
test('+0000 timestamps crossing the UTC date follow the Chicago calendar date, including the DST change',async t=>{
  const f=setup(t);
  for(const [id,created] of [['cdt-late','2026-10-27T04:59:59+0000'],['cdt-next','2026-10-27T05:00:00+0000'],['cdt-early','2026-10-26T05:00:00+0000'],['cdt-prev','2026-10-26T04:59:59+0000'],
    ['cst-late','2026-11-02T05:59:59+0000'],['cst-next','2026-11-02T06:00:00+0000'],['cst-offset','2026-11-01T23:30:00-0600'],['cst-prev','2026-11-01T04:59:59+0000']]) addFacebookImport(f,id,posters.night,created);
  assert.deepEqual((await r.readAutomationReview(f.env,day,now)).history.map(i=>i.id).sort(),['cdt-early','cdt-late']);
  const nov1=await r.readAutomationReview(f.env,'2026-11-01',new Date('2026-11-02T18:00:00Z'));
  assert.deepEqual(nov1.history.map(i=>i.id).sort(),['cst-late','cst-offset']);
});
test('a weekly lunch import posted the prior Sunday evening stays associated with each weekday',async t=>{
  const f=setup(t);addFacebookImport(f,'weekly-sunday',weeklyLunch,'2026-10-26T02:00:00+0000');
  for(const [date,meal] of [['2026-10-26','3 Topping'],['2026-10-28','Patty Melt'],['2026-10-30','Fish Sandwich']]) {
    const model=await r.readAutomationReview(f.env,date,new Date('2026-10-31T18:00:00Z'));
    const lunch=model.history.find(i=>i.id==='weekly-sunday');
    assert.ok(lunch,date);assert.equal(lunch.scope,'Weekly Lunch');
    assert.equal(lunch.values.length,1);assert.match(lunch.values[0].value,new RegExp(meal+'.* - \\$9\\.75$'));
  }
});
test('malformed Facebook timestamps are excluded without hiding valid imports',async t=>{
  const f=setup(t);oct26(f);
  for(const [id,created] of [['bad-text','not a time'],['bad-offset','2026-10-26T13:56:03+00'],['bad-date','2026-02-30T13:56:03+0000'],['empty','']]) addFacebookImport(f,id,posters.night,created);
  const model=await r.readAutomationReview(f.env,day,now);
  assert.equal(model.history.length,3);assert.ok(model.history.every(i=>!i.id.startsWith('bad')&&i.id!=='empty'));
  assert.equal(r.reviewTimestamp('2026-10-26T13:56:03+0000'),'2026-10-26 13:56:03');
  assert.equal(r.reviewTimestamp('2026-10-26T13:56:03+00'),'');
});
test('October 26 page shows +0000 imports with correction links and sanitized Facebook links; unauthenticated access still redirects',async t=>{
  const f=setup(t);oct26(f);
  const html=await (await container.renderToResponse(page,{request:request('?date='+day),locals:locals(f.env)})).text();
  assert.match(html,/2bf18eb7324993a80d60d7e7392faa17|post-2bf18eb7324993a80d60d7e7392faa17/);
  assert.match(html,/3 Topping Personal Pizza &amp; a Drink - \$9\.75/);
  assert.match(html,/week=9000#weekly-day-0/);
  assert.match(html,/https:\/\/www\.facebook\.com\/grayznbuffalo\/posts\/weekly-lunch-1026"/);assert.doesNotMatch(html,/tracking=x/);
  const anonymous=await container.renderToResponse(page,{request:request('?date='+day,'GET',false),locals:locals({...f.env,SESSIONS:{get:async()=>null}})});
  assert.equal(anonymous.status,302);assert.equal(anonymous.headers.get('location'),'/admin');
});
