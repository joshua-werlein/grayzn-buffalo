import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from '../workers/fb-feed/test-fixture.js';
import {validateExtraction} from '../workers/fb-feed/worker.js';
import {loadTs} from './load-ts.mjs';
const {approvalModel}=loadTs('src/lib/automation-approval.ts');

// November 3, 2026: the lunch meal printed "(11–130)". Review Specials must offer
// its Lunch destination, while a genuinely held meal stays for staff to place.
const now=new Date('2026-11-03T16:00:00Z'),day='2026-11-03',window={today:day,weekday:2};
const offer=(content,evidence)=>({content,evidence,service_time:'',service_evidence:'',date_evidence:'',uncertainties:[]});
const poster=time=>({day_of_week:2,day_evidence:'TUESDAY',poster_evidence:'TUESDAY LUNCH SPECIALS',
  delivery:{status:'none',evidence:'',date_evidence:'',uncertainties:[]},
  offers:[offer('Hoagie Sandwich With Waffle Fries and A Drink $9.75',`1) HOAGIE SANDWICH WITH WAFFLE FRIES\nAND A DRINK (${time}) $9.75`),
    offer('Turkey Club On Rye With Side Salad, Chili or Coleslaw $10.25','2) TURKEY CLUB ON RYE\nWITH SIDE SALAD, CHILI OR COLESLAW — $10.25'),
    offer('Grilled Ham and Cheese With Cup of Chili or Coleslaw $7.25','3) GRILLED HAM AND CHEESE\nWITH CUP OF CHILI OR COLESLAW — $7.25')]});
async function model(t,raw) {
  const f=harness(t,{now:now.toISOString(),candidate:raw});
  f.env.SESSIONS={get:async()=>'1'};
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-02',week_end_date='2026-11-08' WHERE id=9000");
  const {candidateJson,validationResult,validationReason}=validateExtraction(JSON.stringify(raw),true,window);
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,parser_version,image_r2_key,candidate_json,extracted_json,processing_status,validation_result,validation_reason)
    VALUES('test','post','2026-11-03T15:35:04+0000',19,'test.jpg',?,?,'staged',?,?)`,candidateJson,JSON.stringify(raw),validationResult,validationReason);
  return approvalModel(f.env,'test',day,now);
}
// The same lookup AutomationApproval.astro uses to preselect a destination.
const destinations=m=>m.entries.map(e=>m.destinations.find(d=>d.service===e.suggestedService && d.position===e.suggestedPosition)?.id??null);

for (const time of ['11–130','11-130']) test(`review preselects Lunch and both All Day spots for "${time}"`,async t=>{
  const m=await model(t,poster(time));
  assert.deepEqual(m.entries.map(e=>[e.suggestedService,e.suggestedPosition]),[['lunch',1],['all-day',1],['all-day',2]]);
  assert.ok(destinations(m).every(Boolean),'every special has a destination');
});

test('a meal held for another time stays unassigned for staff; All Day keeps its spots',async t=>{
  const m=await model(t,poster('11–230'));
  assert.deepEqual(m.entries.slice(1).map(e=>[e.suggestedService,e.suggestedPosition]),[['all-day',1],['all-day',2]]);
  assert.equal(destinations(m)[0],null);
});
