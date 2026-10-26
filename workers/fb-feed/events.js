// Special events (game days, holidays, one-time promotions): pure routing, date
// resolution and offer validation. No database or AI access. Routing happens
// after extraction, on stored evidence. Events publish automatically when the
// evidence is sufficient; nothing waits for staff approval.
import {analyzeDailyEvidence,factKey,serviceFromEvidence} from './evidence.js';

// OFF is the emergency switch. Any other value, including the retired REVIEW, is OFF.
export const EVENT_MODES=['OFF','AUTO'];
export const eventsModeOf=env=>EVENT_MODES.includes(env?.SPECIAL_EVENTS_MODE) ? env.SPECIAL_EVENTS_MODE : 'OFF';

const DAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
// Team names and the printed cheers that name them (October 25: the poster
// headline "LET'S GO PACK!"). A bare "pack" or an amount in "bucks" is not a team.
const TEAMS=[['packers',/\bpackers\b|\bgo\s+pack\b|\bpack\s+attack\b/],['brewers',/\bbrewers\b|\bbrew\s+crew\b/],
  ['badgers',/\bbadgers\b|\bon,?\s+wisconsin\b/],['bucks',/(?<![\d$][\d.]*\s?)\bbucks\b|\bfear\s+the\s+deer\b/],
  ['vikings',/\bvikings\b|\bskol\b/],['bears',/\bbears\b/]];
const TEAM_NAMES={packers:'Packers',brewers:'Brewers',badgers:'Badgers',bucks:'Bucks',vikings:'Vikings',bears:'Bears'};
const HOLIDAY_NAMES={thanksgiving:'Thanksgiving',christmas:'Christmas','new-years':"New Year's",halloween:'Halloween',
  'st-patricks':"St. Patrick's Day",easter:'Easter','memorial-day':'Memorial Day','labor-day':'Labor Day',
  'independence-day':'Fourth of July',valentines:"Valentine's Day",'mothers-day':"Mother's Day",'fathers-day':"Father's Day",'super-bowl':'Super Bowl'};
const HOLIDAYS=[
  ['thanksgiving',/\bthanksgiving\b/],['christmas',/\bchristmas\b/],['new-years',/\bnew\s+year'?s\b/],
  ['halloween',/\bhalloween\b/],['st-patricks',/\bst\.?\s+(?:patrick|paddy)'?s\b/],['easter',/\beaster\b/],
  ['memorial-day',/\bmemorial\s+day\b/],['labor-day',/\blabor\s+day\b/],
  ['independence-day',/\b(?:4th|fourth)\s+of\s+july\b|\bindependence\s+day\b/],['valentines',/\bvalentine'?s\b/],
  ['mothers-day',/\bmother'?s\s+day\b/],['fathers-day',/\bfather'?s\s+day\b/],['super-bowl',/\bsuper\s*bowl\b/]];
const GAME=/\bgame\s*day\b|\bgame\s+specials?\b|\bkick\s*-?\s*off\b|\btailgate\b|\bwatch\s+party\b/;
const GENERIC=/\bspecial\s+event\b|\bone\s+day\s+only\b|\bfundraiser\b|\bbenefit\b/;
// Recurring house promotions and plural "<day>/<service> specials" templates are never events.
const REGULAR=[/\bwing\s+night\b/,/\bpizza\s+night\b/,/\bfish\s+fry\b/,/\bfriday\s+fish\b/,/\bmexican\s+night\b/,/\btaco\s+tuesday\b/,
  /\b(?:daily|lunch|night(?:ly)?|weekly|weekend|all[\s-]+day)\s+specials\b/,
  new RegExp(String.raw`\b(?:${DAYS.join('|')})(?:'s)?\s+(?:(?:lunch|night(?:ly)?|all[\s-]+day)\s+)?specials\b`)];
const CANCELLED=/\bcancel+ed\b|\bpostponed\b|\bno\s+longer\b/;
const norm=s=>String(s??'').normalize('NFKC').replace(/[‘’]/g,"'").toLowerCase();

// The cue identifies WHICH event (identity) and whether the phrase alone is
// specific enough to publish (a team or a holiday, not "game day" or "benefit").
export function eventCue(text) {
  const t=norm(text);
  const teams=TEAMS.flatMap(([team,pattern])=>pattern.test(t)?[team]:[]);
  if (teams.length) return {identity:teams.sort().join('+'),kind:'team',specific:true};
  const holiday=HOLIDAYS.find(([,pattern])=>pattern.test(t));
  if (holiday) return {identity:holiday[0],kind:'holiday',specific:true};
  if (GAME.test(t)) return {identity:'game-day',kind:'game',specific:false};
  if (GENERIC.test(t)) return {identity:'special-event',kind:'event',specific:false};
  return null;
}
export const regularHeading=text=>REGULAR.some(pattern=>pattern.test(norm(text)));

const isoDate=(y,m,d)=>{
  const date=new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y && date.getUTCMonth()===m-1 && date.getUTCDate()===d ? date.toISOString().slice(0,10) : null;
};
export function addDays(date,days) {
  const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+days);
  return value.toISOString().slice(0,10);
}
const weekdayOf=date=>new Date(`${date}T12:00:00Z`).getUTCDay();
export const chicagoDateOf=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));

// One text source (image or caption). Every printed date word must agree.
function readDate(text,postDate) {
  const t=norm(text).replace(/[–—]/g,'-');
  const found=[],review=reason=>({review:reason});
  if (/\bthis\s+weekend\b|\blater\s+this\s+week\b|\bnext\s+week\b|\bupcoming\b/.test(t)) return review('Relative date needs review');
  if (new RegExp(String.raw`\b(?:next|last)\s+(?:${DAYS.join('|')})\b`).test(t)) return review('"Next" or "last" weekday needs review');
  if (new RegExp(String.raw`\b(?:${DAYS.join('|')})s\b`).test(t)) return review('Recurring weekday needs review');
  if (/\btonight\b|\btoday\b/.test(t)) found.push({date:postDate,basis:'relative',note:'"tonight"/"today"'});
  if (/\btomorrow\b/.test(t)) found.push({date:addDays(postDate,1),basis:'relative',note:'"tomorrow"'});
  const days=DAYS.flatMap((day,i)=>new RegExp(`\\b${day}\\b`).test(t)?[i]:[]);
  if (days.length>1) return review('More than one weekday printed');
  if (days.length) found.push({date:addDays(postDate,(days[0]-weekdayOf(postDate)+7)%7),basis:'printed-weekday',note:`printed weekday "${DAYS[days[0]]}"`});
  const [postYear,postMonth]=postDate.split('-').map(Number);
  const printed=[];
  for (const [,y,m,d] of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) printed.push([+y,+m,+d,true]);
  // "1/2 price" and similar fractions are not dates.
  for (const [,m,d,y] of t.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])(?!\s*(?:price|off|lb|pound|rack|order|pizza))/g))
    printed.push([y ? +y+(y.length===2?2000:0) : null,+m,+d,!!y]);
  const named=new RegExp(String.raw`\b(${MONTHS.map(m=>`${m}|${m.slice(0,3)}`).join('|')})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`,'g');
  for (const [,month,d,y] of t.matchAll(named)) printed.push([y ? +y : null,MONTHS.findIndex(m=>m.startsWith(month))+1,+d,!!y]);
  for (const [y,m,d,explicitYear] of printed) {
    // The post's year; only an obvious December post about January rolls over.
    const year=explicitYear ? y : postMonth===12 && m===1 ? postYear+1 : postYear;
    const date=isoDate(year,m,d);
    if (!date) return review('Unreadable printed date');
    if (date<postDate) return review('Printed date is before the post date');
    found.push({date,basis:'printed-date',note:`printed date ${m}/${d}`});
  }
  if (new Set(found.map(f=>f.date)).size>1) return review(days.length && printed.length ? 'Printed weekday and date disagree' : 'Printed date words disagree');
  if (!found.length) return {};
  const best=found.find(f=>f.basis==='printed-date') ?? found.find(f=>f.basis==='printed-weekday') ?? found[0];
  return {date:best.date,basis:best.basis,note:found.map(f=>f.note).join(' + ')};
}
// Image and caption are both evidence; they must agree. No date words at all
// means the verified Facebook post date (Chicago).
export function resolveEventDate({image='',caption='',postDate}) {
  const a=readDate(image,postDate),b=readDate(caption,postDate);
  if (a.review) return {review:a.review};
  if (b.review) return {review:`Caption: ${b.review}`};
  if (a.date && b.date && a.date!==b.date) return {review:'Image and caption dates disagree'};
  const chosen=a.date ? a : b.date ? b : null;
  if (!chosen) return {date:postDate,basis:'publication-date',note:`no date words; Facebook post date ${postDate}`};
  return {date:chosen.date,basis:chosen.basis,note:`${chosen.note} + post date ${postDate}`};
}

// A printed window becomes Chicago wall-clock start/end; otherwise only a label.
const WINDOW=/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])?\.?\s*m?\.?\s*[-–—]\s*(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?/i;
export function eventTime(...texts) {
  for (const text of texts) {
    const m=WINDOW.exec(String(text??''));
    if (!m) continue;
    const endMeridiem=m[6].toLowerCase();
    let startMeridiem=(m[3]??endMeridiem).toLowerCase();
    // "11-2pm": a start hour above the end hour without its own marker is morning.
    if (!m[3] && endMeridiem==='p' && +m[1]>+m[4] && +m[1]!==12) startMeridiem='a';
    const clock=(h,min,mer)=>`${String((+h%12)+(mer==='p'?12:0)).padStart(2,'0')}:${min??'00'}`;
    const start=clock(m[1],m[2],startMeridiem),end=clock(m[4],m[5],endMeridiem);
    return {time_text:m[0].trim(),start_time:end>start?start:null,end_time:end>start?end:null};
  }
  const relative=texts.map(norm).join(' ');
  return {time_text:/\btonight\b/.test(relative)?'Tonight':'',start_time:null,end_time:null};
}

const stripEmoji=s=>String(s??'').replace(/[\p{Extended_Pictographic}️‍]/gu,'').replace(/#\w+/g,'').replace(/\s+/g,' ').trim();
function eventTitle(heading,cue,canonicalize) {
  // A printed heading names the event; relative date words and prices belong
  // elsewhere. Otherwise the title only restates the recognized identity.
  const fromText=text=>{
    if (text.includes('$')) return null;
    const title=canonicalize(stripEmoji(text).replace(/^\s*(?:tonight|today)'?s\s+/i,'')
      .replace(/\s*\b(?:today|tonight|tomorrow)\b\s*/gi,' ').replace(/[!.:,\s]+$/,'').replace(/\s+/g,' ').trim(),-1,'custom');
    return title && title.length<=80 && eventCue(title) ? title : null;
  };
  if (eventCue(heading)) { const title=fromText(heading); if (title) return title; }
  if (cue.kind==='team') return `${cue.identity.split('+').map(team=>TEAM_NAMES[team]).join(' & ')} Game Day Special`;
  if (cue.kind==='holiday') return `${HOLIDAY_NAMES[cue.identity] ?? 'Holiday'} Special`;
  return cue.kind==='event' ? 'Special Event' : 'Game Day Special';
}

const offerText=o=>[o?.content,o?.evidence,o?.service_evidence,o?.service_time].filter(Boolean).join(' ');
const isSoup=o=>/^\s*soups?\b/i.test(o?.content??'');

// Classify one stored source. "event": the whole poster is a one-time
// promotion, so regular planning skips it, and the draft publishes unless its
// review_reasons (insufficient or contradictory evidence) withhold it.
// "mixed": event wording inside a regular poster; regular planning is unchanged
// and no event is created. Nothing here asks staff to approve anything.
export function routeEventSource({candidate,caption='',postDate,canonicalize}) {
  if (!candidate || typeof candidate!=='object' || !Array.isArray(candidate.offers)) return {route:'regular'};
  const heading=`${candidate.day_evidence??''} ${candidate.poster_evidence??''}`;
  const offers=candidate.offers;
  const headingCue=eventCue(heading),offerCues=offers.map(o=>eventCue(offerText(o)));
  const imageCue=headingCue ?? (offers.length && offerCues.every(Boolean) ? offerCues[0] : null);
  const captionCue=eventCue(caption);
  const regular=regularHeading(heading) || offers.some(isSoup)
    || offers.some(o=>serviceFromEvidence(`${o?.service_time??''} ${o?.service_evidence??''}`)!=='unknown');
  const cue=imageCue ?? (captionCue?.specific ? captionCue : null);
  // Only a printed cue may cancel automatically; a caption cue is only logged.
  if (cue && !regular && CANCELLED.test(norm(`${heading} ${caption}`)))
    return {route:'event',cancellation:true,verified:!!imageCue,cue,date:resolveEventDate({image:heading,caption,postDate})};
  if (regular) {
    if (!headingCue && !offerCues.some(Boolean)) return {route:'regular'};
    return {route:'mixed',reason:'Event wording on a regular specials poster; published as regular specials only'};
  }
  if (!offers.length) return {route:'regular'};
  // A cue printed on the poster image (October 23: "TONIGHT'S BREWERS GAME
  // SPECIAL") routes up to four offers. A team or holiday named only in the
  // Facebook caption routes a small poster: one or two meals, no soup. A generic
  // caption phrase alone never reroutes anything, and a plain "Sunday Special"
  // poster with no cue stays a regular special.
  // A printed event with too many offers is withheld by buildEventDraft, never
  // sent back into daily planning as a misleading ordinary-specials failure.
  if (!imageCue && !(captionCue?.specific && offers.length<=2)) return {route:'regular'};
  const draft=buildEventDraft({candidate,caption,postDate,cue,indices:offers.map((_,i)=>i),canonicalize});
  return {route:'event',publish:!draft.review_reasons.length,draft};
}

export function buildEventDraft({candidate,caption,postDate,cue,indices,canonicalize}) {
  const review_reasons=[];
  let analyzed;
  try { analyzed=analyzeDailyEvidence(candidate); }
  catch (error) { analyzed={offers:[],issues:[]};review_reasons.push(error.message); }
  const chosen=indices.filter(i=>analyzed.offers[i]);
  if (chosen.length>4) review_reasons.push('More than four event offers');
  for (const issue of analyzed.issues)
    if (chosen.includes(issue.index) && issue.reason!=='Service not established by evidence') review_reasons.push(`offer ${issue.index+1}: ${issue.reason}`);
  const usable=chosen.filter(i=>!analyzed.issues.some(v=>v.index===i && v.reason!=='Service not established by evidence')).slice(0,4);
  const offers=usable.map(i=>canonicalize(analyzed.offers[i].content,-1,'custom'));
  if (!offers.length) review_reasons.push('No printed, priced event offer');
  const heading=`${candidate.day_evidence??''} ${candidate.poster_evidence??''}`;
  const image=[heading,...chosen.map(i=>analyzed.offers[i]?.date_evidence)].filter(Boolean).join(' ');
  const date=resolveEventDate({image,caption,postDate});
  if (date.review) review_reasons.push(date.review);
  const event_date=date.date ?? postDate;
  const time=eventTime(heading,...chosen.map(i=>analyzed.offers[i]?.service_time),caption);
  return {title:eventTitle(candidate.poster_evidence??'',cue,canonicalize),event_date,...time,details:'',offers,
    identity:cue.identity,date_basis:date.basis ?? 'publication-date',review_reasons,
    fingerprint:`${event_date}|${offers.map(factKey).sort().join('|')}`,
    evidence:{heading:heading.trim(),offers:chosen.map(i=>String(candidate.offers[i]?.evidence ?? candidate.offers[i]?.content ?? '')),
      date:date.review ? `withheld: ${date.review}` : date.note,caption:String(caption??'').slice(0,600)}};
}

// Stored import rows (current scan only). Event routing applies to today's
// verified posts; anything else keeps the regular, unchanged behavior.
export function routeStoredSources(rows,{today,canonicalize}) {
  return rows.map(row=>{
    let candidate=null;
    try { candidate=JSON.parse(String((row.processing_status==='failed' ? row.extracted_json : row.candidate_json) ?? '').replace(/^```(?:json)?\n?|\n?```$/gm,'').trim()); }
    catch { return {route:'regular'}; }
    const created=Date.parse(row.fb_created_time);
    if (!Number.isFinite(created) || chicagoDateOf(created)!==today) return {route:'regular'};
    return routeEventSource({candidate,caption:row.caption ?? '',postDate:today,canonicalize});
  });
}
