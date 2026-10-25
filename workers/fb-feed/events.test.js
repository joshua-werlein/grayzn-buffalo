import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {eventCue,regularHeading,resolveEventDate,eventTime,routeEventSource,routeStoredSources,eventsModeOf,addDays} from './events.js';
import {canonicalizeSlotContent as canonicalize} from './reconcile.js';

// Public poster transcriptions (stored October 23 and 25 extractions). Their
// production captions are empty (read-only D1 check, October 25). Captions and
// posters marked HYPOTHETICAL are rule tests, not production evidence.
const read=name=>JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`,import.meta.url),'utf8'));
const {brewers_event:brewers,friday_night:fridayNight}=read('oct23-friday-night.json');
const {packers_event:packers,sunday_specials:sunday}=read('oct25-sunday-soup.json');
const route=(candidate,caption='',postDate='2026-10-25')=>routeEventSource({candidate:structuredClone(candidate),caption,postDate,canonicalize});
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

test('mode defaults to OFF for missing or unknown values',()=>{
  assert.equal(eventsModeOf({}),'OFF');assert.equal(eventsModeOf({SPECIAL_EVENTS_MODE:'on'}),'OFF');
  assert.equal(eventsModeOf({SPECIAL_EVENTS_MODE:'REVIEW'}),'REVIEW');assert.equal(eventsModeOf({SPECIAL_EVENTS_MODE:'AUTO'}),'AUTO');
});

test('event cues: teams and holidays are specific; game and generic phrases are not; recurring house nights are not events',()=>{
  assert.deepEqual(eventCue("TONIGHT'S BREWERS GAME SPECIAL"),{identity:'brewers',kind:'team',specific:true});
  assert.deepEqual(eventCue('Go Pack! Packers game day'),{identity:'packers',kind:'team',specific:true});
  assert.equal(eventCue('Thanksgiving Eve special').identity,'thanksgiving');
  assert.equal(eventCue('St. Patrick’s Day corned beef').identity,'st-patricks');
  assert.deepEqual(eventCue('Game day special'),{identity:'game-day',kind:'game',specific:false});
  assert.equal(eventCue('Fundraiser for the fire department').specific,false);
  for(const text of ['Wing Night!','Pizza Night 5-10','Mexican Night','Friday Fish Fry','Sunday Specials','Daily Specials','Lunch Specials 11-1:30','Sunday Special',"Tonight's special"])
    assert.equal(eventCue(text),null,text);
  // "Bearsden"/"Buckshot" are not team names.
  assert.equal(eventCue('Buckshot burger, Bearsden fries'),null);
});

test('regular templates: plural day/service specials headings are regular; the singular weekend label is not',()=>{
  for(const text of ['SUNDAY SPECIALS','Friday Night Specials 5-10pm','Monday Lunch Specials','DAILY SPECIALS','Weekly Specials','Wing Night'])
    assert.ok(regularHeading(text),text);
  for(const text of ['Sunday Special',"TONIGHT'S BREWERS GAME SPECIAL",'Packers Game Day']) assert.ok(!regularHeading(text),text);
});

test('printed weekday: all 49 posting/printed weekday pairs resolve to the next occurrence within six days',()=>{
  // 2026-10-25 is a Sunday; walk a full week of post dates.
  for(let p=0;p<7;p++) {
    const postDate=addDays('2026-10-25',p);
    for(let d=0;d<7;d++) {
      const r=resolveEventDate({image:`${DAYS[d]} Special`,postDate});
      const expected=addDays(postDate,(d-p+7)%7);
      assert.equal(r.date,expected,`${DAYS[d]} posted ${postDate}`);
      assert.equal(r.basis,'printed-weekday');
      assert.equal(new Date(`${r.date}T12:00:00Z`).getUTCDay(),d);
    }
  }
});

test('relative words and no date words use the verified post date; tomorrow is the next day',()=>{
  assert.deepEqual(resolveEventDate({image:"TONIGHT'S BREWERS GAME SPECIAL",postDate:'2026-10-23'}).date,'2026-10-23');
  assert.equal(resolveEventDate({image:'Today only',postDate:'2026-10-23'}).basis,'relative');
  assert.equal(resolveEventDate({image:'Tomorrow: Packers game',postDate:'2026-10-24'}).date,'2026-10-25');
  const none=resolveEventDate({image:'Game Day Special',caption:'',postDate:'2026-10-25'});
  assert.deepEqual([none.date,none.basis],['2026-10-25','publication-date']);
});

test('printed dates: numeric, named and ISO dates; year rollover only December to January',()=>{
  assert.equal(resolveEventDate({image:'Packers 10/25',postDate:'2026-10-23'}).date,'2026-10-25');
  assert.equal(resolveEventDate({image:'October 25th',postDate:'2026-10-23'}).date,'2026-10-25');
  assert.equal(resolveEventDate({image:'Oct. 25, 2026',postDate:'2026-10-23'}).date,'2026-10-25');
  assert.equal(resolveEventDate({image:'2026-11-01',postDate:'2026-10-23'}).date,'2026-11-01');
  assert.equal(resolveEventDate({image:"New Year's Day 1/1",postDate:'2026-12-30'}).date,'2027-01-01');
  assert.equal(resolveEventDate({image:'Sunday 10/25',postDate:'2026-10-23'}).basis,'printed-date');
  // Fractions are not dates.
  assert.equal(resolveEventDate({image:'1/2 price burgers',postDate:'2026-10-23'}).basis,'publication-date');
});

test('ambiguous or contradictory date evidence is held for review',()=>{
  const review=(image,caption='',postDate='2026-10-23')=>resolveEventDate({image,caption,postDate}).review;
  assert.match(review('Sunday 10/24'),/disagree/);                        // 10/24/2026 is a Saturday
  assert.match(review('10/20'),/before the post date/);
  assert.match(review('next Sunday'),/Next/);
  assert.match(review('Saturday and Sunday'),/More than one weekday/);
  assert.match(review('Sundays'),/Recurring/);
  assert.match(review('this weekend'),/Relative/);
  assert.match(review('13/40'),/Unreadable/);
  assert.match(review('Sunday Special','Saturday!'),/Image and caption dates disagree/);
  assert.match(review('Game Day','next Sunday'),/^Caption:/);
});

test('event times: printed windows become Chicago wall-clock times; otherwise only a label',()=>{
  assert.deepEqual(eventTime('Kickoff party 11am-2pm'),{time_text:'11am-2pm',start_time:'11:00',end_time:'14:00'});
  assert.deepEqual(eventTime('5-10pm'),{time_text:'5-10pm',start_time:'17:00',end_time:'22:00'});
  assert.deepEqual(eventTime('11-2pm'),{time_text:'11-2pm',start_time:'11:00',end_time:'14:00'});
  assert.deepEqual(eventTime('12:30 PM - 3:15 PM'),{time_text:'12:30 PM - 3:15 PM',start_time:'12:30',end_time:'15:15'});
  assert.deepEqual(eventTime("TONIGHT'S BREWERS GAME SPECIAL"),{time_text:'Tonight',start_time:null,end_time:null});
  assert.deepEqual(eventTime('Sunday Special'),{time_text:'',start_time:null,end_time:null});
  // A window crossing midnight is not stored as times (events end at midnight in v1).
  assert.deepEqual(eventTime('9pm-1am'),{time_text:'9pm-1am',start_time:null,end_time:null});
});

test('October 23 Brewers poster: Tier A event from the printed heading, dated tonight, price verbatim',()=>{
  const r=route(brewers,'','2026-10-23');
  assert.equal(r.route,'event');assert.equal(r.tier,'A');
  assert.equal(r.draft.event_date,'2026-10-23');assert.equal(r.draft.date_basis,'relative');
  assert.equal(r.draft.identity,'brewers');assert.equal(r.draft.title,'Brewers Game Special');
  assert.deepEqual(r.draft.offers,['Pulled Pork Sandwich With Chips and Side of Coleslaw $7.25']);
  assert.equal(r.draft.time_text,'Tonight');assert.deepEqual(r.draft.review_reasons,[]);
});

test('October 25 Packers poster with its empty production caption is NOT recognized as an event',()=>{
  // Verified production evidence: caption empty; image heading "Sunday Special".
  // Nothing establishes a Packers promotion, so it stays on the regular path
  // (its existing review warning stands) and staff add the event manually.
  assert.equal(route(packers,'').route,'regular');
  assert.equal(route(packers,'   ').route,'regular');
  assert.equal(route(packers,'Come watch with us!').route,'regular');
});

test('empty captions: the Brewers image cue alone is sufficient; the regular October 23 and 25 posters stay regular',()=>{
  assert.equal(route(brewers,'','2026-10-23').tier,'A');
  assert.equal(route(fridayNight,'','2026-10-23').route,'regular');
  assert.equal(route(sunday,'').route,'regular');
});

// HYPOTHETICAL posters below (not production evidence) exercise the rules.
const poster=(heading,content,day=-1,day_evidence='')=>({day_of_week:day,day_evidence,poster_evidence:heading,
  delivery:{status:'none',evidence:'',date_evidence:'',uncertainties:[]},
  offers:[{content,evidence:content,service_time:'',service_evidence:'',date_evidence:'',uncertainties:[]}]});

test('caption-only cues: a specific team or holiday caption routes a small poster to review, never to automatic publication',()=>{
  const p=poster('Saturday Special','BRAT & CHIPS $5',6,'Saturday');
  const r=route(p,'Badgers kickoff at 11!','2026-10-24');
  assert.equal(r.route,'event');assert.equal(r.tier,'review');
  assert.match(r.draft.review_reasons[0],/only in the Facebook caption/);
  // Generic caption phrases never reroute.
  assert.equal(route(p,'Game day special!','2026-10-24').route,'regular');
  // Caption cues never reroute a larger poster.
  const big=poster('Saturday Special','BRAT $5',6,'Saturday');
  big.offers.push(...['BURGER $6','WRAP $7'].map(c=>({...big.offers[0],content:c,evidence:c})));
  assert.equal(route(big,'Badgers game!','2026-10-24').route,'regular');
});

test('generic printed event phrases are routed for review; specific printed cues may publish',()=>{
  assert.equal(route(poster('GAME DAY SPECIAL','PULLED PORK SANDWICH $4'),'','2026-10-25').tier,'review');
  assert.equal(route(poster('BADGERS GAME DAY SPECIAL','PULLED PORK SANDWICH $4'),'','2026-10-25').tier,'A');
});

test('advance announcement: a printed-weekday event posted Friday is scheduled for Sunday, not Friday',()=>{
  const r=route(poster('BADGERS GAME DAY SPECIAL','PULLED PORK SANDWICH $4',0,'SUNDAY'),'','2026-10-23');
  assert.equal(r.tier,'A');assert.equal(r.draft.event_date,'2026-10-25');assert.equal(r.draft.date_basis,'printed-weekday');
});

test('regular posters never reroute because of a caption, and stay regular with a cue only in the caption',()=>{
  assert.equal(route(sunday,'Go Badgers!').route,'regular');
  assert.equal(route(fridayNight,'Brewers game tonight!','2026-10-23').route,'regular');
});

test('mixed poster: an event line inside a regular poster keeps regular planning and creates a review draft',()=>{
  const p=structuredClone(sunday);
  p.offers.push({content:'BADGERS GAME: PULLED PORK SANDWICH $4',evidence:'BADGERS GAME: PULLED PORK SANDWICH $4',service_time:'',service_evidence:'',date_evidence:'',uncertainties:[]});
  const r=route(p);
  assert.equal(r.route,'mixed');assert.equal(r.tier,'review');
  assert.match(r.draft.review_reasons[0],/regular specials poster/);
  assert.deepEqual(r.draft.offers,['Badgers Game: Pulled Pork Sandwich $4']);
});

test('offers: missing price, caption-only price and uncertain offers are held; prices are never added',()=>{
  const unpriced=structuredClone(brewers);unpriced.offers[0]={...unpriced.offers[0],content:'PULLED PORK SANDWICH WITH CHIPS',evidence:'PULLED PORK SANDWICH WITH CHIPS'};
  const r1=route(unpriced,'Brewers special $7.25','2026-10-23');
  assert.ok(r1.draft.review_reasons.some(r=>/Missing meal price/.test(r)));
  assert.deepEqual(r1.draft.offers,[]);
  const uncertain=structuredClone(brewers);uncertain.offers[0].uncertainties=['price partly hidden'];
  assert.ok(route(uncertain,'','2026-10-23').draft.review_reasons.some(r=>/Uncertain/.test(r)));
  const mismatch=structuredClone(brewers);mismatch.offers[0].evidence='PULLED PORK SANDWICH WITH CHIPS AND SIDE OF COLESLAW $7.50';
  assert.ok(route(mismatch,'','2026-10-23').draft.review_reasons.length);
  const multi=structuredClone(brewers);multi.offers[0]={...multi.offers[0],content:'1 or 2 Brats $4/$7',evidence:'1 or 2 Brats $4/$7'};
  assert.deepEqual(route(multi,'','2026-10-23').draft.offers,['1 or 2 Brats $4/$7']);
});

test('cancellation posts are recognized only with an event cue and no regular template',()=>{
  // HYPOTHETICAL cancellation posters.
  const c=poster('BADGERS SPECIAL CANCELLED','',-1);c.offers=[];
  const r=route(c);
  assert.equal(r.cancellation,true);assert.equal(r.verified,true);assert.equal(r.cue.identity,'badgers');
  const captionOnly=poster('TODAY','SORRY, NO SPECIAL TODAY',-1);captionOnly.offers=[];
  const byCaption=route(captionOnly,'Badgers watch party cancelled');
  assert.equal(byCaption.cancellation,true);assert.equal(byCaption.verified,false);
  const regularCancel=structuredClone(sunday);regularCancel.poster_evidence='SUNDAY SPECIALS CANCELLED';
  assert.notEqual(route(regularCancel,'Badgers').cancellation,true);
});

test('stored rows: only posts created today in Chicago are routed; failed rows use their raw extraction',()=>{
  const row=(candidate,created,extra={})=>({processing_status:'staged',candidate_json:JSON.stringify(candidate),extracted_json:null,
    fb_created_time:created,caption:'',...extra});
  const routes=routeStoredSources([
    row(brewers,'2026-10-23T15:13:45-05:00'),
    row(brewers,'2026-10-22T23:30:00-05:00'),
    row(null,'2026-10-23T15:13:45-05:00',{processing_status:'failed',extracted_json:JSON.stringify(brewers)}),
    row(brewers,'not a time'),
  ],{today:'2026-10-23',canonicalize});
  assert.deepEqual(routes.map(r=>r.route),['event','regular','event','regular']);
});

test('daylight-saving boundaries: Chicago dates around November 1 2026 and March 14 2027 resolve correctly',()=>{
  // 2026-11-01 06:30Z is 01:30 CDT; 07:30Z is 01:30 CST (the repeated hour).
  const stored=created=>routeStoredSources([{processing_status:'staged',candidate_json:JSON.stringify({...brewers,poster_evidence:'BREWERS GAME SPECIAL'}),fb_created_time:created,caption:''}],{today:'2026-11-01',canonicalize})[0];
  assert.equal(stored('2026-11-01T06:30:00Z').route,'event');
  assert.equal(stored('2026-11-01T07:30:00Z').route,'event');
  assert.equal(stored('2026-11-01T04:59:00Z').route,'regular');         // 23:59 CDT October 31
  assert.equal(stored('2026-11-02T05:59:00Z').route,'event');           // 23:59 CST November 1
  assert.equal(stored('2026-11-02T06:00:00Z').route,'regular');         // 00:00 CST November 2
  assert.equal(resolveEventDate({image:'Sunday',postDate:'2027-03-12'}).date,'2027-03-14');
});
