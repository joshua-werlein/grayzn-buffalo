// November 25 2026: the Thanksgiving closure post showed "Needs Review" in the
// admin Automation page. Non-actionable announcements get a neutral "No
// Specials" status; real specials keep every existing review status.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
const r=loadTs('src/lib/automation-review.ts');

const review=detail=>({event_type:'review',detail});
const noDelivery={status:'none',evidence:'',date_evidence:'',uncertainties:[]};
const reading=(poster_evidence,offers=[],extra={})=>JSON.stringify({evidence_version:2,day_of_week:-1,day_evidence:'',poster_evidence,delivery:noDelivery,offers,...extra});
const source=(extracted_json,extra={})=>({processing_status:'failed',validation_result:'rejected',
  validation_reason:'Printed calendar date does not match current Chicago date',caption:'',extracted_json,candidate_json:null,...extra});
// Events are newest first, as readAutomationReview loads them.
const STALE=[review('GUARDED_AUTO_CONFLICT: 2026-11-25; blocked proposals: []; rejected sources: [{"reason":"Printed calendar date does not match current Chicago date"}]'),
  review('GUARDED_AUTO: 2026-11-25; no publication; CONFLICT: 1 rejected source(s), review required')];
const attention=status=>['review','failed'].includes(r.statusBadge(status).tone);

test('the November 25 Thanksgiving closure is No Specials, not Needs Review, even with the stale conflict audit', () => {
  const closure=source(reading("GRAYZ'N BUFFALO BAR & GRILL WE ARE CLOSED THANKSGIVING DAY 11/26 HAVE A SAFE AND HAPPY THANKSGIVING"),
    {caption:'We will be closed Thanksgiving Day. Have a safe and happy holiday!'});
  for (const events of [[],STALE]) {
    const outcome=r.importOutcome(closure,events);
    assert.equal(outcome.status,'No Specials');
    assert.equal(attention(outcome.status),false);
  }
  assert.deepEqual(r.statusBadge('No Specials'),{label:'No Specials',tone:'neutral',help:r.statusBadge('No Specials').help});
});

test('Christmas closures, greetings and general announcements are No Specials whether held or staged', () => {
  for (const heading of ['CLOSED CHRISTMAS EVE AND CHRISTMAS DAY 12/24 12/25','MERRY CHRISTMAS FROM OUR FAMILY TO YOURS','NOW HIRING COOKS AND SERVERS'])
    for (const extra of [{},{processing_status:'staged',validation_result:'ok',validation_reason:'poster evidence v2'}])
      assert.equal(r.importOutcome(source(reading(heading),extra),[]).status,'No Specials',heading);
});

test("Wednesday's specials post shows Published again once a clean run records the resolution", () => {
  const specials=source(reading('WEDNESDAY SPECIALS',[{content:'Olive Burger $10.25',evidence:'Olive Burger $10.25',service_time:'',service_evidence:'',date_evidence:'',uncertainties:[]}]),
    {processing_status:'staged',validation_result:'ok',validation_reason:'poster evidence v2'});
  const published=review('GUARDED_AUTO: 2026-11-25; reconciled 1 source(s); 3 slot(s)');
  // Before the fix's clean run: the stale conflict is still the latest audit.
  assert.equal(r.importOutcome(specials,[...STALE,published]).status,'Partially Published');
  assert.equal(r.importOutcome(specials,[review('GUARDED_AUTO: 2026-11-25; reconciled 2 source(s); 0 slot(s)'),...STALE,published]).status,'Published');
});

test('real specials keep their review statuses: unreadable, wrong-date, specials heading without offers, mixed content', () => {
  // Unreadable: no extraction at all.
  assert.equal(r.importOutcome(source(null,{validation_reason:'response is not valid JSON'}),[]).status,'Failed');
  // Legitimate specials printed for another day.
  assert.equal(r.importOutcome(source(reading('THURSDAY SPECIALS',[{content:'Turkey Dinner $12.50',evidence:'Turkey Dinner $12.50'}])),[]).status,'Failed');
  // A specials heading whose offers were not read is never silently dismissed.
  assert.equal(r.importOutcome(source(reading('WEDNESDAY SPECIALS')),[]).status,'Failed');
  // Mixed: a closure notice beside a meal.
  assert.equal(r.importOutcome(source(reading('CLOSED THANKSGIVING 11/26',[{content:'Pie and Coffee $4.50',evidence:'Pie and Coffee $4.50'}])),STALE).status,'Held');
  // The caption announces specials the image reading did not find.
  assert.equal(r.importOutcome(source(reading('HAPPY THANKSGIVING'),{caption:"Today's specials: turkey dinner $12"}),[]).status,'Failed');
  // Still processing: never reclassified early.
  assert.equal(r.importOutcome(source(reading('HAPPY THANKSGIVING'),{processing_status:'pending',validation_result:null,validation_reason:null}),[]).status,'Processing');
});

test('existing publication statuses are unchanged by the multi-run count', () => {
  const s=source(null,{processing_status:'staged',validation_result:'ok'});
  assert.equal(r.importOutcome(s,[review('GUARDED_AUTO_CONFLICT: blocked proposals')]).status,'Held');
  assert.equal(r.importOutcome(s,[review('GUARDED_AUTO_CONFLICT: blocked proposals'),review('GUARDED_AUTO: 2026-10-26; reconciled 2 source(s); 3 slot(s); CONFLICT: 1 blocked proposal(s)')]).status,'Partially Published');
  assert.equal(r.importOutcome(s,[review('GUARDED_AUTO: 2026-10-26; reconciled 2 source(s); 3 slot(s)')]).status,'Published');
  assert.equal(r.importOutcome(s,[]).status,'Staged — publication unconfirmed');
});
