// Evidence contract 2: pure normalization and planning, with no database or AI access.
// Original extracted_json remains immutable; candidate_json can store this richer shape.
import {standaloneSoup} from '../../src/lib/daily-soup.js';
import {validateWingNight} from './wing-night.js';

export const EVIDENCE_VERSION=2;
const clock=String.raw`(?:1[0-2]|[1-9])(?::[0-5]\d)?\s*(?:[ap]\.?m\.?)?`;
const windowPattern=String.raw`${clock}\s*[-–—]\s*${clock}`;
const windows=()=>new RegExp(windowPattern,'gi');
const pricePattern=()=>/(?<![\w$.,−+])\$\s*(?:\d+(?:\.\d{2})?|\.\d{2})(?![\w.,])/g;
const prices=s=>[...s.matchAll(pricePattern())].map(m=>({text:m[0],cents:Math.round(Number(m[0].replace(/[$\s]/g,''))*100)}));
const clean=s=>s.normalize('NFKC').replace(/\r\n?/g,'\n').replace(/[\t ]+/g,' ').trim();
const soupLabel=s=>/^\s*soups?\s*(?::|[–—-]|\r?\n)/i.test(s);
function readSoup(o) {
  const label=s=>s.replace(/^\s*soups?\s*(?::|[–—-]|\r?\n)\s*/i,'Soup: ').replace(/\s*\n\s*/g,', ');
  return standaloneSoup({...o,content:label(o.content),evidence:label(o.evidence)});
}
export const factKey=s=>clean(s).toLowerCase().replace(/\bw\s*\//g,' with ')
  .replace(/(\d)\s*(?:''|’’|″|”)/g,'$1"').replace(/[&+]/g,' and ')
  .replace(pricePattern(),m=>` price${Math.round(Number(m.replace(/[$\s]/g,''))*100)}c `)
  .replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function serviceFromEvidence(s) {
  const t=String(s??'').toLowerCase().replace(/[–—]/g,'-').replace(/\./g,'');
  const found=[];
  if (/\blunch\b|\b11\s*(?::00)?\s*(?:am)?\s*-\s*1:30\s*(?:pm)?\b/.test(t)) found.push('lunch');
  if (/\bnight(?:ly)?\b|\b5\s*(?::00)?\s*(?:pm)?\s*-\s*10\s*(?::00)?\s*(?:pm)?\b/.test(t)) found.push('nightly');
  if (/\ball[ -]+day\b/.test(t)) found.push('all-day');
  return found.length===1?found[0]:found.length?'conflict':'unknown';
}
function withoutService(s) {
  return s.replace(windows(),' ').replace(/\b(?:all[ -]+day|lunch|nightly)\s*(?:specials?)?\s*:?/gi,' ')
    .replace(/[()]/g,' ').replace(/\s+/g,' ').trim();
}
// Only a leading punctuated list marker is presentation. Bare quantities,
// including "1 or 2 Piece Fish", remain part of the exact fact comparison.
const withoutListMarker=s=>s.replace(/^\s*\d+[).]\s+(?=\S)/u,'');
function priceFacts(s) {
  const p=prices(s);
  // A minus attached to the amount (-$9.75), or a leading one with nothing
  // before it, is a negative price. A spaced hyphen after text ("Drink - $9.75")
  // is a separator, like the printed dash it transcribes.
  if (s.replace(pricePattern(),'').includes('$') || /[−+]\s*\$|[-–—]\$|^\s*-\s*\$/.test(s)
    || /\$\s*(?:\d+(?:\.\d{2})?|\.\d{2})\s*[-–—/]\s*\d/.test(s)) throw Error('Ambiguous price evidence');
  return p;
}
function normalizedTime(s) {
  if (!s.trim()) return '';
  const found=[...s.matchAll(windows())].map(m=>m[0]);
  // Collapse duplicate windows only after checking the entire residual text.
  const residual=s.replace(windows(),'').replace(/[()]/g,'').trim();
  if (found.length>1 && new Set(found.map(f=>factKey(f))).size===1 && !residual) return found[0].trim();
  return s.trim();
}
// POSTER_FORMATTING_RULES instruct the model to join a visually established
// bundle printed over separate lines with "&" (e.g. a pizza and wings box for one
// price). That added "&" is presentation. Every other word, price and printed
// connector (including "or") must match the evidence in order; an "&" may only
// be ADDED, never substituted for or dropped from printed text.
function sameTokensAllowingBundleConnectors(content,evidence) {
  const c=factKey(content).split(' ').filter(Boolean),e=factKey(evidence).split(' ').filter(Boolean);
  let added=(content.match(/&/g)??[]).length-(evidence.match(/&/g)??[]).length,i=0,j=0;
  while(i<c.length||j<e.length) {
    if(i<c.length&&j<e.length&&c[i]===e[j]) {i++;j++;continue;}
    if(i<c.length&&c[i]==='and'&&added>0) {i++;added--;continue;}
    return false;
  }
  return true;
}
export function normalizeEvidenceOffer(input) {
  if (!input || typeof input.content!=='string' || !input.content.trim() || input.content.length>1200
    || typeof input.evidence!=='string' || input.evidence.length>2400
    || typeof input.service_time!=='string' || input.service_time.length>240
    || (input.service_evidence!=null && (typeof input.service_evidence!=='string' || input.service_evidence.length>600))
    || (input.date_evidence!=null && (typeof input.date_evidence!=='string' || input.date_evidence.length>600))
    || (input.uncertainties!=null && (!Array.isArray(input.uncertainties) || input.uncertainties.length>8
      || input.uncertainties.some(s=>typeof s!=='string'||s.length>300)))) throw Error('Invalid offer evidence');
  const evidence=input.evidence;
  let content=clean(input.content), time=clean(input.service_time);
  const cp=priceFacts(content), ep=priceFacts(evidence), tp=priceFacts(time);
  if(cp.length && !ep.length) throw Error('Missing price in original meal evidence');
  if (tp.length) {
    if (tp.length!==1) throw Error('Ambiguous service_time price');
    const price=tp[0];
    // A price separator after a complete time is presentation; a leading minus is not.
    time=time.replace(/\s+[–—]\s+(?=\$)/g,' ').replace(pricePattern(),'').trim();
    time=normalizedTime(time);
    const residual=time.replace(windows(),'').replace(/\b(?:lunch|night(?:ly)?|all[ -]day)(?: specials?)?\b/gi,'').replace(/[()]/g,'').trim();
    if (residual || (time && ['unknown','conflict'].includes(serviceFromEvidence(time)))) throw Error('Ambiguous service_time price');
    if (cp.length && (cp.length!==1 || cp[0].cents!==price.cents)) throw Error('Conflicting offer price');
    if (!cp.length && (ep.length!==1 || ep[0].cents!==price.cents)) throw Error('Missing corroborating price evidence');
  } else time=normalizedTime(time);
  const cCore=withoutService(withoutListMarker(content)).replace(pricePattern(),'');
  const eCore=withoutService(withoutListMarker(evidence)).replace(pricePattern(),'');
  // Full meal evidence, unlike a bare service label, must preserve every token.
  if (ep.length && !sameTokensAllowingBundleConnectors(cCore,eCore)) throw Error('Meal facts differ from original evidence');
  if (cp.length && ep.length && JSON.stringify(cp.map(p=>p.cents))!==JSON.stringify(ep.map(p=>p.cents))) throw Error('Conflicting offer price');
  if (!cp.length && ep.length) {
    if (ep.length!==1 || /\b(?:add|extra|upcharge|substitute|discount|upgrade|optional|modifier)\b/i.test(evidence)) throw Error('Ambiguous offer price evidence');
    content=`${content} ${ep[0].text.replace(/\s/g,'')}`;
  }
  // Missing connectors cannot be silently repaired using a remembered menu.
  if (/\bsoup\s+coleslaw\b/i.test(content)) throw Error('Ambiguous side alternatives');
  if (content.length>150) throw Error('Offer exceeds 150 characters without lossless representation');
  return {content,service_time:time,evidence,...(input.service_evidence!=null?{service_evidence:input.service_evidence}:{})};
}

// Keep invalid offers in their original positions. They participate in conflict
// scope and never disappear to manufacture agreement or shift another slot.
export function analyzeDailyEvidence(value) {
  if (!value || !Number.isInteger(value.day_of_week) || value.day_of_week < -1 || value.day_of_week>6
    || typeof value.day_evidence!=='string' || value.day_evidence.length>600
    || typeof value.poster_evidence!=='string' || value.poster_evidence.length>2400
    || !Array.isArray(value.offers) || value.offers.length>48) throw Error('Invalid poster evidence');
  const issues=[];
  const offers=value.offers.map((raw,index)=>{
    try {
      const o=normalizeEvidenceOffer(raw);
      const soup=soupLabel(o.content)||soupLabel(o.evidence);
      if (soup && !readSoup(o)) throw Error('Ambiguous standalone Soup evidence');
      if (!soup && !prices(o.content).length) throw Error('Missing meal price');
      const service=serviceFromEvidence(`${o.service_time} ${o.service_evidence??''}`);
      if (service==='conflict') throw Error('Conflicting offer service evidence');
      if (Array.isArray(raw.uncertainties) && raw.uncertainties.length) throw Error('Uncertain extracted offer');
      if(!soup && service==='unknown') issues.push({index,reason:'Service not established by evidence',service});
      return {...o,...(raw.date_evidence?{date_evidence:raw.date_evidence}:{}),...(raw.uncertainties?{uncertainties:raw.uncertainties}:{} )};
    } catch(error) {
      issues.push({index,reason:error.message,service:serviceFromEvidence(`${raw?.service_time??''} ${raw?.service_evidence??''}`)});
      return raw;
    }
  });
  return {evidence_version:EVIDENCE_VERSION,day_of_week:value.day_of_week,day_evidence:value.day_evidence,
    poster_evidence:value.poster_evidence,offers,issues};
}

// Friday Nightly displays up to four specials (October 23 approval); Monday two.
const capacityOf=(service,weekday)=>service==='lunch'||service==='soup'?1:service==='all-day'?2
  :[0,2,6].includes(weekday)?0:weekday===5?4:weekday===1?2:1;
// Printed evidence positively placing a whole poster on another day. Such a
// post cannot conflict with today's offers, so it is excluded rather than
// blocking them. Unreadable or self-contradictory day evidence still blocks.
export const OTHER_DAY_REASONS=new Set(['Printed weekday does not match current Chicago day',
  'Printed calendar date does not match current Chicago date','Poster references another or future date; review required']);

// Existing content anchors identity only, never price or service. An offer
// already displayed in a slot (including a protected staff slot) keeps that
// slot; every other offer keeps its printed position unless an anchor occupies
// it, then takes the lowest free position not reserved by an unresolved offer.
function assignPositions(items,service,capacity,slotLayout,reserved) {
  const identity=s=>factKey(s.replace(pricePattern(),''));
  const anchors=items.map(item=>{
    const matches=slotLayout.filter(s=>s.service===service&&s.content&&s.position<=capacity&&identity(s.content)===identity(item.content));
    return matches.length===1?matches[0].position:null;
  });
  const anchored=anchors.filter(p=>p!==null);
  if(new Set(anchored).size!==anchored.length) return null;
  const taken=new Set(anchored);
  const placed=items.map((item,i)=>anchors[i]!==null?{...item,position:anchors[i]}:null);
  for(let i=0;i<items.length;i++) {
    if(placed[i]) continue;
    let position=items[i].position;
    if(taken.has(position)) {
      position=null;
      for(let p=1;p<=capacity;p++) if(!taken.has(p)&&!reserved.has(p)&&!items.some((o,j)=>j!==i&&!anchors[j]&&o.position===p)) {position=p;break;}
      if(position===null) return null;
    }
    taken.add(position);placed[i]={...items[i],position};
  }
  // Invariant: one offer per slot. Never write two offers to the same position.
  return new Set(placed.map(i=>i.position)).size===placed.length?placed:null;
}

// ── Service resolution ──
// Order of authority for each offer: (1) offer-level evidence (its own printed
// time/label); (2) a narrowly defined, established house layout that fills ONLY
// offers still lacking service evidence; (3) otherwise unresolved. A
// service_evidence that merely repeats the poster heading is heading scope, not
// offer evidence: copying "MONDAY NIGHT SPECIALS" onto All Day repeats must not
// make them night offers.
const isMeal=o=>!soupLabel(o?.content??'')&&!soupLabel(o?.evidence??'');
function offerService(o,p) {
  const heading=` ${factKey(`${p.day_evidence} ${p.poster_evidence}`)} `;
  const labels=[o?.service_time??'',o?.service_evidence??''].filter(s=>s.trim());
  const own=labels.filter(s=>serviceFromEvidence(o.evidence??'')!=='unknown' || !heading.includes(` ${factKey(s)} `));
  // A repeated bare lunch window, absent from every meal's verbatim text,
  // under a Lunch Specials heading is copied scope in the three-meal layout.
  // Explicit labels, distinct windows and any corroborating meal text survive.
  const meals=p.offers.filter(isMeal);
  const bare=s=>!!s.trim() && !s.replace(windows(),'').replace(/[()]/g,'').trim();
  const copied=meals.length===3 && headingService(p)==='lunch'
    && meals.every(m=>pricedMeal(m) && serviceFromEvidence(m.evidence??'')==='unknown'
      && bare(m.service_time??'') && factKey(m.service_time)===factKey(meals[0].service_time)
      && (!(m.service_evidence??'').trim() || (bare(m.service_evidence) && factKey(m.service_evidence)===factKey(m.service_time))))
    && serviceFromEvidence(meals[0].service_time)==='lunch';
  if(copied) return 'unknown';
  return serviceFromEvidence(`${own.join(' ')} ${o.evidence??''}`);
}
// A meal is identifiable by layout when it carries unambiguous printed price(s),
// even if its wording is held for another reason (e.g. a missing printed "or").
function pricedMeal(o) {
  try { return priceFacts(o?.evidence||o?.content||'').length>0; }
  catch { return false; }
}
// The same offer, allowing only the dish-name words to be read in another order
// (October 26: "Grilled Honey Mustard Chicken Sandwich" in the morning,
// "Grilled Chicken Honey Mustard Sandwich" at night). The dish name keeps its
// first and last word; everything from the first "with" on (sides,
// alternatives, connectors and every price) must match exactly and in order.
export function sameOffer(a,b) {
  const x=factKey(a),y=factKey(b);
  if(x===y) return true;
  const parts=s=>{const m=/^(.+?) with (.+)$/.exec(s);return m?[m[1].split(' '),m[2]]:null;};
  const p=parts(x),q=parts(y);
  if(!p || !q || p[1]!==q[1] || p[0].length<3 || p[0].length!==q[0].length
    || p[0][0]!==q[0][0] || p[0].at(-1)!==q[0].at(-1) || !/\bprice\d+c\b/.test(p[1])) return false;
  return [...p[0]].sort().join(' ')===[...q[0]].sort().join(' ');
}
const headingService=p=>serviceFromEvidence(`${p.day_evidence} ${p.poster_evidence}`);
const headingNames=(p,pattern)=>pattern.test(`${p.day_evidence} ${p.poster_evidence}`);

// Established house layouts, each applied only when ALL of its identifying
// conditions hold and every explicit label agrees with its assignment.
// Returns Map(offerIndex → service) or null. Never used to repair facts.
function houseLayout(p,isExplicitToday,weekday,known,explicit,verifiedSameDay=false) {
  if(headingNames(p,/\bweekly\b/i)) return null;
  const meals=p.offers.flatMap((o,i)=>isMeal(o)?[i]:[]);
  if(!meals.length || !meals.every(i=>pricedMeal(p.offers[i]))) return null;
  const agree=assignment=>meals.every((i,k)=>['unknown',assignment[k]].includes(explicit[i]))?new Map(meals.map((i,k)=>[i,assignment[k]])):null;
  const nightText=i=>['nightly','conflict'].includes(serviceFromEvidence(p.offers[i].content));
  const heading=headingService(p);
  // Timestamp trust comes from the guarded publisher, never extracted JSON.
  // Only the weekday DAILY SPECIALS three-priced-meal format gets this fallback.
  const sameDayLayout=verifiedSameDay && weekday>=1 && weekday<=5
    && /^\s*daily\s+specials\s*$/i.test(p.poster_evidence)
    && !p.day_evidence.trim() && p.day_of_week===-1 && meals.length===3
    && meals.every(i=>prices(p.offers[i].evidence??'').length===1);
  // The same trusted timestamp also dates an undated "TONIGHT" night poster
  // (October 22: "TONIGHT IS PIZZA NIGHT / SPECIAL IS 5-10PM"). It reaches only
  // the night-heading layouts below, never Tuesday (Mexican Night owns that
  // night) or weekends. planDailyEvidence has already checked every printed
  // field of a trusted source for another weekday, date or future reference.
  const sameDayNight=verifiedSameDay && [1,3,4,5].includes(weekday) && heading==='nightly'
    && !p.day_evidence.trim() && p.day_of_week===-1 && /\btonight\b/i.test(p.poster_evidence);
  if(isExplicitToday!==true && !sameDayLayout && !sameDayNight) return null;
  // Day poster: one Lunch/Day Special meal, then two All Day meals.
  if(meals.length===3 && headingNames(p,/\bspecials?\b/i) && ['unknown','lunch'].includes(heading) && !meals.some(nightText))
    return agree(['lunch','all-day','all-day']);
  if(isExplicitToday!==true && !sameDayNight) return null;
  // Wednesday Wing Night poster: the Wing Night offer plus two daytime meals.
  if(isExplicitToday===true && weekday===3 && meals.length===3 && ['unknown','nightly'].includes(heading)) {
    const wing=meals.filter(i=>/\bwing\s+night\b/i.test(`${p.offers[i].content} ${p.offers[i].evidence}`));
    const others=meals.filter(i=>!wing.includes(i));
    if(wing.length===1 && ['unknown','nightly'].includes(explicit[wing[0]]) && !others.some(nightText))
      return agree(meals.map(i=>i===wing[0]?'nightly':'all-day'));
  }
  if(heading==='nightly') {
    const capacity=capacityOf('nightly',weekday);
    if(!capacity) return null;
    // Repeats are recognized only by IDENTICAL facts (dish, description, price).
    const repeat=meals.map(i=>known.some(k=>sameOffer(k,p.offers[i].content)));
    const repeats=meals.filter((_,k)=>repeat[k]);
    // Friday Night Specials (October 16 and 23 template): every priced meal
    // under the printed "Friday Night" heading is a Nightly special, including
    // a night-priced version of an All Day dish, except an identical repeat of
    // today's verified All Day offer. Today's All Day evidence is required so a
    // repeat can be recognized; more Nightly specials than Friday's four slots
    // hold the whole poster rather than dropping any.
    if(weekday===5 && isExplicitToday===true && known.length && headingNames(p,/\bfriday\s+night\b/i)) {
      const night=meals.filter((_,k)=>!repeat[k]).length;
      return night && night<=capacity ? agree(meals.map((_,k)=>repeat[k]?'all-day':'nightly')) : null;
    }
    // The established Monday/Friday layouts below pair exactly two night meals.
    const pair=[1,5].includes(weekday)?2:capacity;
    if(repeats.length && meals.length-repeats.length===pair)
      return agree(meals.map((_,k)=>repeat[k]?'all-day':'nightly'));
    // Monday/Friday four-offer night poster with no known All Day pair: two
    // night meals, then the two All Day meals. Only as printed: after variants
    // were joined, the last two meals are not known to be the All Day pair.
    if([1,5].includes(weekday) && meals.length===4 && !known.length && !p.joined_offers
      && headingNames(p,new RegExp(String.raw`\b${weekday===1?'monday':'friday'}\s+night\b`,'i')))
      return agree(['nightly','nightly','all-day','all-day']);
    if(!repeats.length && meals.length===pair) return agree(meals.map(()=>'nightly'));
    return null;
  }
  // A single-service heading covering no more meals than that service holds.
  if(['lunch','all-day'].includes(heading) && meals.length<=capacityOf(heading,weekday)) return agree(meals.map(()=>heading));
  return null;
}

// One pizza printed in several sizes is ONE special (the house convention and
// the Thursday recurring default: one slot, one size per line). The model may
// read each size box as its own offer. Join only an adjacent run of complete,
// certain, singly priced "<size> <same pizza>" offers with distinct sizes and
// identical service fields, each price corroborated by its own evidence, on a
// night poster. Content and evidence are joined verbatim, one size per line,
// so every printed size and price survives and nothing is invented. Any other
// shape is left untouched for the ordinary checks.
// A complete, certain, singly priced offer whose printed text starts with a
// variant label: {variant, dish, service}, or null.
function variantOffer(o,pattern) {
  if(!o || typeof o.content!=='string' || typeof o.evidence!=='string' || typeof o.service_time!=='string'
    || (o.uncertainties?.length) || (o.date_evidence??'').trim()) return null;
  let cp,ep;
  try { cp=priceFacts(o.content);ep=priceFacts(o.evidence); } catch { return null; }
  if(cp.length!==1 || ep.length!==1 || cp[0].cents!==ep[0].cents) return null;
  const m=pattern.exec(clean(o.content).replace(pricePattern(),'').trim());
  return m?{variant:m[1].toLowerCase(),dish:factKey(m[2]),service:factKey(`${o.service_time}|${o.service_evidence??''}`)}:null;
}
function joinVariants(value,variantOf) {
  if(!value || !Array.isArray(value.offers) || serviceFromEvidence(`${value.day_evidence??''} ${value.poster_evidence??''}`)!=='nightly') return value;
  const offers=[];
  for(let i=0;i<value.offers.length;) {
    const first=variantOf(value.offers[i]);let j=i+1;
    while(first && j<value.offers.length) {
      const next=variantOf(value.offers[j]);
      if(!next || next.dish!==first.dish || next.service!==first.service
        || value.offers.slice(i,j).some(o=>variantOf(o).variant===next.variant)) break;
      j++;
    }
    if(j-i<2) {offers.push(value.offers[i]);i++;continue;}
    const run=value.offers.slice(i,j);
    offers.push({...run[0],content:run.map(o=>clean(o.content)).join('\n'),evidence:run.map(o=>o.evidence).join('\n'),uncertainties:[]});
    i=j;
  }
  return offers.length===value.offers.length?value:{...value,offers,joined_offers:true};
}
const SIZE=String.raw`(\d{1,2})\s*(?:-\s*)?(?:inch(?:es)?\b|in\.|"|”|″|'')`;
const pizzaSize=o=>{
  const v=variantOffer(o,new RegExp(String.raw`^\s*${SIZE}\s+(.+?)\s*$`,'iu'));
  return v && /\bpizza\b/.test(v.dish)?v:null;
};
export const joinPizzaSizes=value=>joinVariants(value,pizzaSize);
// The same dish printed once per protein ("Chicken Stir Fry $12.99", "Steak
// Stir Fry $13.99") is ONE special with its labelled prices, under the same
// rules. The shared dish name must be at least two words, so unrelated
// one-word dishes ("Chicken Wrap", "Steak Wrap") are not drawn together merely
// by a shared noun. Nothing is joined to fit capacity: unrelated offers stay apart.
const proteinVariant=o=>{
  const v=variantOffer(o,/^\s*(chicken|steak|beef|pork|shrimp)\s+(.+?)\s*$/iu);
  return v && v.dish.split(' ').length>=2?v:null;
};
export const joinProteinVariants=value=>joinVariants(value,proteinVariant);

export function planDailyEvidence(candidates,weekday,{validateDay,canonicalize,today,existingAllDay=[],slotLayout=[],verifiedSameDaySources=new Set()}) {
  const rejectedSources=[],excludedSources=[],unresolvedTargets=[],blocked=new Set();
  const sources=[];
  for (let source=0;source<candidates.length;source++) {
    let p,isExplicitToday;
    try {
      const raw=candidates[source];
      if (['weekly-lunch','mexican-night'].includes(raw?.type) && !('offers' in raw)) continue;
      const joined=joinProteinVariants(joinPizzaSizes(raw));
      p={...analyzeDailyEvidence(joined),joined_offers:joined.joined_offers===true};
      if(!p.offers.length && !/\bspecials?|menu|lunch|night|soup\b/i.test(`${p.day_evidence} ${p.poster_evidence}`)) continue;
      isExplicitToday=validateDay(p,weekday,today);
    } catch(error) {
      if(OTHER_DAY_REASONS.has(error.message)) excludedSources.push({index:source,reason:error.message});
      else {rejectedSources.push({index:source,reason:error.message});blocked.add('*');}
      continue;
    }
    try {
      // An offer-level date may differ from a correct heading; that cannot be
      // proof the whole poster is elsewhere, so it blocks rather than excludes.
      if(!isExplicitToday && verifiedSameDaySources.has(source)) {
        // Check all printed fields before allowing the narrowly scoped fallback.
        validateDay({...p,poster_evidence:[p.poster_evidence,...p.offers.flatMap(o=>
          [o.content,o.evidence,o.service_time,o.service_evidence,o.date_evidence])].filter(Boolean).join(' ')},weekday,today);
      }
      for (const o of p.offers) if(o?.date_evidence) validateDay({...p,poster_evidence:`${p.poster_evidence} ${o.date_evidence}`},weekday,today);
    } catch(error) {rejectedSources.push({index:source,reason:error.message});blocked.add('*');continue;}
    sources.push({source,p,isExplicitToday,explicit:p.offers.map(o=>isMeal(o)?offerService(o,p):'soup')});
  }
  const contentIssue=(p,i)=>p.issues.find(v=>v.index===i && v.reason!=='Service not established by evidence');
  const known=existingAllDay.map(e=>({content:e.content,source:-1}));
  const knownFrom=source=>known.filter(k=>k.source!==source).map(k=>k.content);
  const resolve=s=>{
    const layout=houseLayout(s.p,s.isExplicitToday,weekday,knownFrom(s.source),s.explicit,verifiedSameDaySources.has(s.source));
    return s.explicit.map((service,i)=>{
      if(service==='soup') return 'soup';
      if(service==='unknown' && layout?.has(i)) return layout.get(i);
      // Established automation may identify an exact repeat; defaults never establish facts.
      if(service==='unknown' && !contentIssue(s.p,i) && knownFrom(s.source).some(k=>sameOffer(k,s.p.offers[i].content))) return 'all-day';
      // Friday's four Nightly slots never repeat an identical All Day offer,
      // even one labelled with night evidence: All Day already covers the night.
      if(weekday===5 && service==='nightly' && !contentIssue(s.p,i)
        && knownFrom(s.source).some(k=>sameOffer(k,s.p.offers[i].content))) return 'all-day';
      return service;
    });
  };
  // Same-cron repeats: verified All Day offers from posters NOT headed as night
  // posters identify identical repeats on this run's night posters.
  for(const s of sources) if(headingService(s.p)!=='nightly') {
    s.services=resolve(s);
    s.services.forEach((service,i)=>{if(service==='all-day' && !contentIssue(s.p,i)) known.push({content:s.p.offers[i].content,source:s.source});});
  }
  for(const s of sources) if(!s.services) s.services=resolve(s);

  // Build per-source proposals with stable reading-order positions per service.
  // The dish named before its sides/price: similar-looking offers share it.
  const dishName=text=>factKey(text.replace(pricePattern(),'').split(/\s+(?:w\/\s*|with\s+)|\s+[-–—]\s*$/i)[0]);
  const proposals=new Map(),reserved=new Map(),pending=[];
  for(const {source,p,services} of sources) {
    const positions=new Map(),sourceItems=new Map(),placedAt=[];
    services.forEach((service,i)=>{
      if(['unknown','conflict'].includes(service)) return;
      const pos=(positions.get(service)??0)+1;positions.set(service,pos);placedAt[i]=pos;
    });
    const unresolved=services.flatMap((service,i)=>['unknown','conflict'].includes(service)?[i]:[]);
    // Every unpublishable meal on any post is evidence that could contradict a
    // similar-looking offer elsewhere (checked once all posts are planned).
    services.forEach((service,i)=>{if(service!=='soup' && (unresolved.includes(i)||contentIssue(p,i))) pending.push({source,content:p.offers[i]?.content??''});});
    unresolved.forEach(i=>unresolvedTargets.push({service:'unknown',position:i+1,content:'',
      reason:contentIssue(p,i)?.reason??(services[i]==='conflict'?'Conflicting offer service evidence':'Service not established by evidence')}));
    for(let i=0;i<p.offers.length;i++) {
      const service=services[i];
      if(['unknown','conflict'].includes(service)) continue;
      const o=p.offers[i],pos=placedAt[i],capacity=capacityOf(service,weekday);
      const hold=reason=>{
        unresolvedTargets.push({service,position:pos,content:'',reason});
        const r=reserved.get(service)??new Map();r.set(pos,source);reserved.set(service,r);
      };
      const issue=contentIssue(p,i);
      if(issue) {hold(issue.reason);continue;}
      if(pos>capacity) {blocked.add(service);unresolvedTargets.push({service,position:pos,content:'',reason:'Destination capacity exceeded'});continue;}
      if(service!=='soup') {
        // An unresolved meal competes for this offer's slot only if it could be
        // in the same service AHEAD of it while capacity remains. An identical
        // repeat of another post's verified All Day offer takes that post's slot,
        // so its own poster's layout cannot displace it.
        const repeat=service==='all-day' && knownFrom(source).some(k=>sameOffer(k,o.content));
        if(!repeat && unresolved.some(u=>u<i && (positions.get(service)??0)<capacity)) {hold('Unresolved sibling could compete for this slot');continue;}
      }
      let content=service==='soup'?readSoup(o):o.content;
      if(weekday===3 && service==='nightly') content=validateWingNight(o.content,o.evidence);
      if(!content) {hold('Missing, malformed or ambiguous Wing Night prices');continue;}
      const items=sourceItems.get(service)??[];
      content=canonicalize(content,weekday,service==='soup'?'custom':service);
      // An equivalent offer already displayed in canonical form keeps its
      // wording, whichever post is read first: a reprint with other punctuation
      // or dish-word order never rewrites it. A non-canonical display (such as
      // an uppercase reading) is still corrected to the canonical text.
      const svc=service==='soup'?'custom':service;
      const shown=service==='soup'?null:slotLayout.find(s=>s.service===service && s.content && s.content!==content
        && canonicalize(s.content,weekday,svc)===s.content && sameOffer(s.content,content));
      items.push({position:pos,content:shown?.content??content,source});sourceItems.set(service,items);
    }
    // Separate posts must agree. Identical facts repeated on another post are
    // consistent; a subset is consistent; anything else (including the same dish
    // at another price) is a conflict for that service only.
    for(const [service,items] of sourceItems) {
      const existing=proposals.get(service);
      const within=(a,b)=>a.every(o=>b.some(e=>sameOffer(o.content,e.content)));
      if(!existing) proposals.set(service,items);
      else if(within(items,existing)) continue;
      else if(within(existing,items)) proposals.set(service,items);
      else {blocked.add(service);unresolvedTargets.push({service,position:1,content:'',reason:'Conflicting source offers'});}
    }
  }
  const targets=[];
  for(const [service,items] of proposals) {
    if(blocked.has('*')||blocked.has(service)) continue;
    // Never assume similar-looking offers match: an unresolved meal with the same
    // dish name but different facts (price, sides, wording) holds this service.
    if(service!=='soup' && items.some(item=>pending.some(u=>dishName(u.content)===dishName(item.content) && factKey(u.content)!==factKey(item.content)))) {
      unresolvedTargets.push({service,position:1,content:'',reason:'Unresolved offer could contradict this offer'});continue;
    }
    if(new Set(items.map(o=>factKey(o.content))).size!==items.length) continue;
    // A slot held by another post's unresolved offer is contested: hold the service.
    const holds=reserved.get(service)??new Map();
    if(items.some(item=>holds.has(item.position) && holds.get(item.position)!==item.source)) {
      unresolvedTargets.push({service,position:1,content:'',reason:'Slot contested by another post'});continue;
    }
    // Soup has a single reserved destination and no identity anchors.
    const positioned=service==='soup'?items
      :assignPositions(items,service,capacityOf(service,weekday),slotLayout,new Set(holds.keys()));
    if(!positioned) {
      unresolvedTargets.push({service,position:1,content:'',reason:'Ambiguous existing slot assignment'});continue;
    }
    targets.push({day_of_week:weekday,service:service==='soup'?'custom':service,...(service==='soup'?{role:'soup'}:{}),partial:true,
      items:positioned.map(({source:_source,...item})=>item)});
  }
  return {targets,rejectedSources,excludedSources,unresolvedTargets};
}

// A weekly row's verbatim evidence normally begins with its own weekday label
// (optionally with a date). Remove only a label naming THIS entry's day; any
// other weekday label is a day-association error and remains in the comparison.
const WEEKDAY_LABELS=[null,'mon(?:day)?','tue(?:s(?:day)?)?','wed(?:nesday)?','thu(?:r(?:s(?:day)?)?)?','fri(?:day)?'];
export function weeklyEntryEvidence(evidence,day) {
  const label=WEEKDAY_LABELS[day];
  if(!label) return evidence;
  return evidence.replace(new RegExp(String.raw`^\s*${label}\.?(?:\s+\d{1,2}\/\d{1,2})?\s*(?:[:.–—-]\s*|\n\s*|\s+(?=\S))`,'i'),'');
}
// Same facts, ignoring service labels/windows and presentation punctuation.
// Word ORDER is significant: a reordered meal can change sides or alternatives.
export const sameMealFacts=(content,evidence)=>sameTokensAllowingBundleConnectors(withoutService(content),withoutService(evidence));

// Presentation only, after the caller establishes the meal/price association.
// Never reposition choices, modifiers, malformed prices or price ranges.
export function trailingDailyPrice(content) {
  const found=[...content.matchAll(pricePattern())];
  if(found.length!==1 || content.replace(pricePattern(),'').includes('$')
    || /[−+]\s*\$|[-–—]\$|\$\s*\d+(?:\.\d{2})?\s*[-–—/]\s*\d/.test(content)
    || /\b(?:add|extra|upcharge|substitut\w*|discount|upgrade|optional|modifier)\b/i.test(content)) return content;
  const price=found[0];
  if(/^\s*(?:each\b|per\b|\/)/i.test(content.slice(price.index+price[0].length))) return content;
  const meal=(content.slice(0,price.index)+content.slice(price.index+price[0].length)).replace(/\s+/g,' ').trim();
  return meal ? `${meal} ${price[0].replace(/\s/g,'')}` : content;
}

// Recover size labels and move their already-printed run out of the description.
// The raw item must pass factual comparison BEFORE this lossless presentation.
export function normalizeMexicanSizeItem(item) {
  const title=labelBareSizePrices(item.title,item.evidence??item.description);
  let description=item.description;
  const pairs=s=>[...String(s).matchAll(/\b(large|small|medium|mini)\s+(\$\s*(?:\d+(?:\.\d{2})?|\.\d{2}))/gi)];
  const a=pairs(title),b=pairs(description);
  if(a.length>1 && a.length===b.length && a.every((p,i)=>factKey(p[0])===factKey(b[i][0]))) {
    const suffix=description.slice(b[0].index);
    if(/^[\s|/•·,]*$/.test(suffix.replace(/\b(?:large|small|medium|mini)\s+\$\s*(?:\d+(?:\.\d{2})?|\.\d{2})/gi,'')))
      description=description.slice(0,b[0].index).trimEnd();
  }
  return {...item,title,description};
}
// A title that lists BARE size prices ("Taco Salad ... $9.00 | $8.50 | $6.00")
// while its own verbatim evidence prints exactly one LABELLED run with the same
// amounts in the same order ("Large $9.00 • Small $8.50 • Mini $6.00") gets
// those printed labels back. Labels and pairings come only from the evidence;
// any difference in count, order or amount, or more than one candidate run,
// leaves the title unchanged so the fact check still rejects it.
export function labelBareSizePrices(title,evidence) {
  if(typeof title!=='string' || typeof evidence!=='string') return title;
  const P=String.raw`\$\s*(?:\d+(?:\.\d{2})?|\.\d{2})`,SEP=String.raw`\s*[|/•,]\s*`;
  const cents=p=>Math.round(Number(p.replace(/[$\s]/g,''))*100);
  const bare=[...title.matchAll(new RegExp(`${P}(?:${SEP}${P})+`,'g'))];
  if(bare.length!==1) return title;
  const amounts=[...bare[0][0].matchAll(new RegExp(P,'g'))].map(m=>cents(m[0]));
  const pair=String.raw`([A-Za-z][A-Za-z-]*)\s+(${P})`;
  const runs=[...evidence.matchAll(new RegExp(`${pair}(?:${SEP}${pair})+`,'g'))].map(run=>
    [...run[0].matchAll(new RegExp(pair,'g'))].map(m=>({label:m[1],price:m[2].replace(/\s/g,'')})));
  const matches=runs.filter(run=>run.length===amounts.length && run.every((p,i)=>cents(p.price)===amounts[i]));
  if(matches.length!==1) return title;
  return title.replace(bare[0][0],matches[0].map(p=>`${p.label} ${p.price}`).join(' | '));
}

// Mexican Night titles deliberately gather separately printed size/price lines
// (prompt rule), so order can legitimately differ, and a poster may print the
// same amounts twice (unlabelled beside the dish, labelled on a size line).
// Require: the identical multiset of words; the identical SET of price amounts
// (none dropped or invented); and every label-to-price pairing in the item
// printed in the evidence (no swapped size prices). "+" before an add-on price
// is notation, not a word.
export function sameMenuItemFacts(title,description,evidence) {
  const isPrice=t=>/^price\d+c$/.test(t);
  const tokens=s=>factKey(s.replace(/\+\s*(?=\$)/g,'')).split(' ').filter(Boolean);
  const source=tokens(evidence);
  const words=list=>JSON.stringify(list.filter(t=>!isPrice(t)).sort());
  const amounts=list=>JSON.stringify([...new Set(list.filter(isPrice))].sort());
  const pairs=list=>new Set(list.flatMap((t,i)=>isPrice(t)?[`${list[i-1]??''}:${t}`]:[]));
  const printed=pairs(source);
  const matches=item=>words(item)===words(source) && amounts(item)===amounts(source) && [...pairs(item)].every(p=>printed.has(p));
  return matches(tokens(`${title}\n${description??''}`))
    || matches(tokens(`${labelBareSizePrices(title,evidence)}\n${description??''}`));
}

// Recover a printed overall weekly range without binding an old undated poster
// to whichever week happens to be current when a later cron executes.
// A printed range as M/D-M/D, from "10/12-10/16" or "OCT 12-16" forms.
function parseWeeklyRange(text) {
  const t=String(text??'').replace(/[–—]/g,'-');
  const slash=/\b(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\b/.exec(t);
  const names=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const named=/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\s*-\s*(\d{1,2})\b/i.exec(t);
  const month=named?names.indexOf(named[1].slice(0,3).toLowerCase())+1:0;
  return slash?`${+slash[1]}/${+slash[2]}-${+slash[3]}/${+slash[4]}`:named?`${month}/${+named[2]}-${month}/${+named[3]}`:null;
}
export function normalizeWeeklyRange(value) {
  const given=value.date_range?.trim()||null;
  const printed=parseWeeklyRange(value.poster_evidence);
  // The model may copy the printed form ("OCT 12-16") instead of M/D-M/D. The
  // same range in another format is not a conflict; a different range is.
  const range=given?(parseWeeklyRange(given)??given):null;
  if(range && printed && range!==printed) throw Error('Conflicting printed weekly date range');
  return {...value,date_range:range??printed};
}
