import {composeMexicanItem} from '../../src/lib/mexican-item.js';
// Evidence is persisted separately from the website's final group structure.
// A poster-level night heading does NOT make every offer a night-only offer.
const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
export const WEEKDAY_ENCODING_MISMATCH = 'numeric day does not match explicit weekday evidence';

// Canonical display strings for recurring specials that are intentionally multiline.
// These are deterministic — we replace whatever the AI extracted with the known
// authoritative text rather than inheriting arbitrary whitespace from vision output.
const WING_NIGHT_CANONICAL = 'Wing Night!\n$.89 Boneless Wings\n$.99 Bone In Wings\nAdd Fries';
const PIZZA_NIGHT_CANONICAL = '12" 3-Topping Pizza $13.50\n16" 3-Topping Pizza $16';
const STIR_FRY_CANONICAL = 'Chicken Stir Fry $12.99\nSteak Stir Fry $13.99';

export function canonicalizeSlotContent(content, weekday, service) {
  // Wednesday nightly Wing Night → fixed multiline canonical
  if (weekday === 3 && service === 'nightly' && /\bwing\s+night\b/i.test(content))
    return WING_NIGHT_CANONICAL;
  // Thursday nightly Pizza Night → fixed multiline canonical
  if (weekday === 4 && service === 'nightly' && /\bpizza\b/i.test(content))
    return PIZZA_NIGHT_CANONICAL;
  // Friday all-day Stir Fry → fixed multiline canonical
  if (weekday === 5 && service === 'all-day' && /\bstir\s*fry\b/i.test(content))
    return STIR_FRY_CANONICAL;
  // ALL CAPS Facebook poster text → title case before publication.
  // Only fires when every Unicode letter in the string is uppercase; prices
  // ($9.75, $.89), punctuation (—, &), and non-letter characters are untouched.
  // Explicit allowlist — only known specials abbreviations stay ALL-CAPS.
  const ABBREVS = new Set(['BLT', 'BBQ', 'FF']);
  const letters = content.replace(/\P{L}/gu, '');
  if (letters.length > 0 && letters === letters.toUpperCase()) {
    content = content.replace(/\p{L}+/gu, (word, offset, str) => {
      if (word.toUpperCase() === 'W' && str[offset + word.length] === '/') return 'w';
      if (ABBREVS.has(word.toUpperCase())) return word.toUpperCase();
      return word[0].toUpperCase() + word.slice(1).toLowerCase();
    });
  }
  // Default: collapse all internal whitespace runs (newlines, tabs, multiple spaces) to one space
  return content.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}
export function offerKey(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/\bw\s*\//g, ' with ')
    .replace(/\$\s*(\d*\.\d+|\d+)/g, (_, n) => ` price${Math.round(Number(n)*100)}c `)
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function serviceOf(text) {
  const t = text.toLowerCase().replace(/[–—]/g,'-').replace(/\./g,'');
  const services = [];
  if (/\blunch\b|\b11\s*(?::00)?\s*(?:am)?\s*-\s*1:30\s*(?:pm)?\b/.test(t)) services.push('lunch');
  if (/\bnight(?:ly)?\b|\b5\s*(?::00)?\s*(?:pm)?\s*-\s*10\s*(?::00)?\s*(?:pm)?\b/.test(t)) services.push('nightly');
  if (/\ball[ -]+day\b/.test(t)) services.push('all-day');
  return services.length === 1 ? services[0] : services.length ? 'conflict' : 'unknown';
}
export function normalizeOfferContent(content) {
  return content.replace(/\b(?:only|special)!?\s+(?=\$\.?\d)/gi, '').trim();
}
function normalizeOfferPrice(offer) {
  let content=normalizeOfferContent(offer.content), service_time=offer.service_time;
  if (!service_time.includes('$')) return {content,service_time,evidence:offer.evidence};
  // Recover one unambiguously associated price, never partial malformed tokens
  // or multiple prices whose size/item associations would require guessing.
  const pricePattern=/(?<![\w$.,–—−+-])\$\s*(?:\d+(?:\.\d{2})?|\.\d{2})(?![\w.,])/g;
  const prices=text=>[...text.matchAll(pricePattern)];
  const found=prices(service_time);
  if (found.length!==1 || service_time.replace(found[0][0],'').includes('$')) throw Error('Ambiguous service_time price');
  const price=found[0][0], cents=value=>Math.round(Number(value.replace(/[$\s]/g,''))*100);
  service_time=service_time.replace(price,'').trim();
  // Parse the entire remainder, rather than deleting numeric punctuation that
  // could conceal a price range, negative amount or unexplained numeric suffix.
  const heading='(?:lunch|night(?:ly)?|all[ -]day)(?: specials?)?';
  const clock='(?:1[0-2]|[1-9])(?::[0-5]\\d)?\\s*(?:[ap]\\.?m\\.?)?';
  const time=`${clock}\\s*[-–—]\\s*${clock}`;
  const servicePattern=new RegExp(`^(?:${heading}|(?:${heading}\\s+)?(?:${time}|\\(${time}\\)))$`,'i');
  if ((service_time && (!servicePattern.test(service_time) || ['unknown','conflict'].includes(serviceOf(service_time))))
    || !Number.isSafeInteger(cents(price))) throw Error('Ambiguous service_time price');
  const existing=prices(content);
  if (content.includes('$') && (existing.length!==1 || cents(existing[0][0])!==cents(price)
    || content.replace(pricePattern,'').includes('$')
    || /^\s*[-–—/]\s*(?:\$|\d)/.test(content.slice(existing[0].index+existing[0][0].length)))) throw Error('Conflicting offer price');
  if (!existing.length) {
    // Recovery requires corroboration of the whole offer, not a detached
    // add-on/size/discount amount. Unknown associations remain for review.
    const evidence=normalizeOfferContent(offer.evidence);
    const modifier=/\b(?:add(?:[ -]?ons?)?|extra|upcharge|surcharge|substitut\w*|discount|save|off|upgrade|modifier|small|medium|large|size|optional)\b|^\s*(?:\d+[).]\s*)?side\b/i;
    const evidencePrices=prices(evidence);
    if (modifier.test(evidence) || /[-–—−+]\s*\$/.test(evidence)
      || (evidence.includes('$') && (evidencePrices.length!==1 || cents(evidencePrices[0][0])!==cents(price) || evidence.replace(pricePattern,'').includes('$')))
      || ![offerKey(content),offerKey(`${content} ${price}`)].includes(offerKey(evidence))) throw Error('Ambiguous offer price evidence');
    content=`${content} ${price.replace(/\s/g,'')}`;
  }
  if (content.length>150) throw Error('Offer with recovered price exceeds 150 characters');
  return {content,service_time,evidence:offer.evidence};
}
export const WEEKLY_LUNCH_SHAPE_ERROR = 'Weekly lunch evidence requires weekday entries, not daily offers';
export const MEXICAN_NIGHT_SHAPE_ERROR = 'Mexican Night evidence requires the mexican-night shape, not daily offers';
function hasWeeklyLunchEvidence(text) {
  const normalized = text.toLowerCase().replace(/[–—]/g, '-');
  const schedule = /\bweekly\b/.test(normalized)
    || /\b\d{1,2}\/\d{1,2}\s*-\s*\d{1,2}\/\d{1,2}\b/.test(normalized)
    || ['mon(?:day)?','tue(?:sday)?','wed(?:nesday)?','thu(?:rsday)?','fri(?:day)?']
      .filter(day => new RegExp(`\\b${day}\\b`).test(normalized)).length >= 2;
  return schedule && serviceOf(normalized) === 'lunch';
}
export function validateEvidence(value) {
  const str = (v,n) => typeof v === 'string' && v.length <= n;
  if (!value || Array.isArray(value) || !Number.isInteger(value.day_of_week) || value.day_of_week < -1 || value.day_of_week > 6 ||
      !str(value.day_evidence,160) || !str(value.poster_evidence,160) || !Array.isArray(value.offers) || value.offers.length > 12) throw Error('Invalid poster evidence');
  // Reject the wrong response shape; never infer meals from a weekly heading.
  if (hasWeeklyLunchEvidence(`${value.poster_evidence} ${value.day_evidence}`)) throw Error(WEEKLY_LUNCH_SHAPE_ERROR);
  // Reject daily-offers shape when the poster clearly says "Mexican Night"; require the dedicated shape.
  if (/\bmexican\s+night\b/i.test(`${value.poster_evidence} ${value.day_evidence}`)) throw Error(MEXICAN_NIGHT_SHAPE_ERROR);
  // Internal encoding only: current-day eligibility remains authoritative in forToday().
  const days=DAYS.flatMap((d,i)=>new RegExp(`\\b${d}\\b`,'i').test(value.day_evidence)?[i]:[]);
  if (days.length===1 && value.day_of_week!==days[0]) throw Error(WEEKDAY_ENCODING_MISMATCH);
  const offers = value.offers.map(o => {
    if (!o || !str(o.content,150) || !o.content.trim() || !str(o.service_time,80) || !str(o.evidence,160)) throw Error('Invalid offer evidence');
    return normalizeOfferPrice(o);
  });
  if (new Set(offers.map(o=>offerKey(o.content))).size !== offers.length) throw Error('Duplicate extracted offer');
  return {day_of_week:value.day_of_week,day_evidence:value.day_evidence,poster_evidence:value.poster_evidence,offers};
}
export function validateWeeklyLunch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid weekly lunch: not an object');
  if (value.type !== 'weekly-lunch') throw Error('Invalid weekly lunch: type must be weekly-lunch');
  const str = (v, n) => typeof v === 'string' && v.length <= n;
  const posterEvidence = value.poster_evidence != null ? value.poster_evidence : '';
  if (!str(posterEvidence, 160)) throw Error('Invalid weekly lunch: poster_evidence must be string ≤ 160 chars');
  const serviceTime = value.service_time != null ? value.service_time : '';
  if (!str(serviceTime, 80)) throw Error('Invalid weekly lunch: service_time must be string ≤ 80 chars');
  let dateRange = value.date_range != null ? value.date_range : null;
  if (dateRange !== null) {
    if (typeof dateRange !== 'string' || dateRange.length > 20) throw Error('Malformed date_range: must be null or string ≤ 20 chars');
    if (!/^\d{1,2}\/\d{1,2}-\d{1,2}\/\d{1,2}$/.test(dateRange)) throw Error('Malformed date_range: expected M/D-M/D format');
    const parts = dateRange.match(/^(\d{1,2})\/(\d{1,2})-(\d{1,2})\/(\d{1,2})$/);
    const [sm, sd, em, ed] = [Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4])];
    if (sm < 1 || sm > 12 || em < 1 || em > 12) throw Error('Malformed date_range: month must be 1-12');
    if (sd < 1 || sd > 31 || ed < 1 || ed > 31) throw Error('Malformed date_range: day must be 1-31');
  }
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 5) throw Error('Invalid weekly lunch: entries must be array with 1-5 items');
  const entries = value.entries.map((e, i) => {
    if (!e || typeof e !== 'object') throw Error(`Invalid weekly lunch: entry ${i} is not an object`);
    if (!Number.isInteger(e.day_of_week) || e.day_of_week < 1 || e.day_of_week > 5) throw Error(`Invalid weekly lunch: entry ${i} day_of_week must be integer weekday 1-5`);
    if (typeof e.content !== 'string' || !e.content.trim() || e.content.length > 150) throw Error(`Invalid weekly lunch: entry ${i} content must be non-empty string ≤ 150 chars`);
    return {day_of_week: e.day_of_week, content: e.content};
  });
  const days = entries.map(e => e.day_of_week);
  if (new Set(days).size !== days.length) throw Error('Invalid weekly lunch: duplicate day_of_week in entries');
  return {type: 'weekly-lunch', poster_evidence: posterEvidence, date_range: dateRange, service_time: serviceTime, entries};
}
// Match warning phrases, never ordinary ingredient words. Normalization is for
// detection only; accepted menu text is not stripped or rewritten.
export function containsConsumerAdvisory(text) {
  if (typeof text !== 'string') return false;
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  return /\bfood\s*borne illness(?:es)?\b/.test(normalized)
    || /\bconsuming (?:raw|under\s*cooked)\b/.test(normalized)
    || (/\bincrease (?:your |the )?risk\b/.test(normalized) && /\b(?:raw|under\s*cooked)\b/.test(normalized));
}

export function validateMexicanNight(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Mexican Night: not an object');
  if (value.type !== 'mexican-night') throw Error('Invalid Mexican Night: type must be mexican-night');
  const str = (v, n) => typeof v === 'string' && v.length <= n;
  const posterEvidence = value.poster_evidence != null ? value.poster_evidence : '';
  if (!str(posterEvidence, 160)) throw Error('Invalid Mexican Night: poster_evidence must be string ≤ 160 chars');
  if (!/\bmexican\s+night\b/i.test(posterEvidence)) throw Error('Invalid Mexican Night: poster_evidence must contain "Mexican Night"');
  const schedule = value.schedule != null ? value.schedule : '';
  if (!str(schedule, 80)) throw Error('Invalid Mexican Night: schedule must be string ≤ 80 chars');
  if (!Array.isArray(value.groups) || value.groups.length < 1 || value.groups.length > 12) throw Error('Invalid Mexican Night: groups must be array with 1-12 groups');
  const groups = value.groups.map((g, i) => {
    if (!g || typeof g !== 'object') throw Error(`Invalid Mexican Night: group ${i} is not an object`);
    if (typeof g.label !== 'string' || !g.label.trim() || g.label.length > 80) throw Error(`Invalid Mexican Night: group ${i} label must be non-empty string ≤ 80 chars`);
    if (containsConsumerAdvisory(g.label)) throw Error(`Invalid Mexican Night: consumer advisory in group ${i} label`);
    if (!Array.isArray(g.items) || g.items.length < 1 || g.items.length > 4) throw Error(`Invalid Mexican Night: group ${i} items must be array with 1-4 items`);
    const items = g.items.map((item, j) => {
      if (!item || typeof item !== 'object') throw Error(`Invalid Mexican Night: group ${i} item ${j} is not an object`);
      if (typeof item.title !== 'string' || !item.title.trim()) throw Error(`Invalid Mexican Night: group ${i} item ${j} title must be non-empty text`);
      const content = composeMexicanItem(item.title, item.description);
      if (containsConsumerAdvisory(content)) throw Error(`Invalid Mexican Night: consumer advisory in group ${i} item ${j}`);
      return {title: item.title, description: item.description};
    });
    return {label: g.label, items};
  });
  return {type: 'mexican-night', poster_evidence: posterEvidence, schedule, groups};
}
function forToday(value,weekday) {
    // Dedicated weekly/section evidence belongs to its own reconciliation path.
    if (['weekly-lunch','mexican-night'].includes(value?.type) && !('offers' in value)) return null;
    const p=validateEvidence(value);
    const days=DAYS.flatMap((d,i)=>new RegExp(`\\b${d}\\b`,'i').test(p.day_evidence)?[i]:[]);
    const isExplicitToday=p.day_of_week===weekday && days.length===1 && days[0]===weekday;
    // Accept posters where the AI found no printed weekday (day=-1, empty evidence).
    // Guard against "tomorrow", "this weekend", "next Friday", and similar forward-looking
    // headings that describe a future day's special posted the day before.
    const headingText=`${p.day_evidence} ${p.poster_evidence}`.toLowerCase().replace(/[–—]/g,'-');
    const hasFutureRef=/\btomorrow\b/.test(headingText)
      || /\bthis\s+weekend\b/.test(headingText)
      || /\bnext\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|week)\b/.test(headingText)
      || /\blater\s+this\s+week\b/.test(headingText);
    const isDayUnknown=p.day_of_week===-1 && days.length===0 && !hasFutureRef;
    if (!isExplicitToday && !isDayUnknown) return null;
    const offers=p.offers.map(o=>({...o,service:serviceOf(o.service_time)}));
    if (offers.some(o=>o.service==='conflict')) throw Error('Conflicting offer service evidence');
    return {...p,offers,service:serviceOf(p.poster_evidence)};
}
const setKey = items => items.map(o=>offerKey(o.content)).sort().join('|');
const unique = (sets,count) => {
  const full=sets.filter(s=>s.length===count && new Set(s.map(o=>offerKey(o.content))).size===count);
  return full.length && full.length===sets.length && new Set(full.map(setKey)).size===1 ? full[0] : null;
};
export function reconcilePosters(candidates,weekday,existingAllDay=[]) {
  return reconcilePosterEvidence(candidates,weekday,existingAllDay).targets;
}
export function reconcilePosterEvidence(candidates,weekday,existingAllDay=[]) {
  const rejectedSources=[],validIndices=[];
  const posters=candidates.map((c,index)=>{
    try { const p=forToday(c,weekday); if (p) validIndices.push(index); return p; }
    catch(error) { rejectedSources.push({index,reason:error.message}); return null; }
  }).filter(Boolean);
  // An invalid source cannot disappear and manufacture agreement, even if its
  // visible content happens to match. We cannot establish agreement with it.
  if (rejectedSources.length) return {targets:[],rejectedSources};
  const targets=mapPosters(posters,weekday,existingAllDay);
  if (!targets.length && posters.length>1) {
    validIndices.forEach(index=>rejectedSources.push({index,reason:'Conflicting or unresolved daily source agreement'}));
  }
  return {targets,rejectedSources};
}
function mapPosters(posters,weekday,existingAllDay) {
  const proposals={'lunch':[],'all-day':[],'nightly':[]};
  for (const p of posters) {
    // Restaurant weekday pattern: generic three-offer posters list Lunch first,
    // then the two All Day offers, even when no lunch time is printed.
    // Explicit evidence must agree with those positions; never reinterpret a
    // night poster (including Wing Night) or apply this pattern on weekends.
    const heading=`${p.day_evidence} ${p.poster_evidence}`;
    const orderedDaytime=p.offers.length===3 &&
      /\bspecials?\b/i.test(heading) && !/\bweekly\b/i.test(heading) && serviceOf(heading)==='unknown' &&
      p.offers.every((o,i)=>['unknown',i===0?'lunch':'all-day'].includes(o.service) &&
        !['nightly','conflict'].includes(serviceOf(o.content)));
    if (orderedDaytime) {
      proposals.lunch.push(p.offers.slice(0,1));
      proposals['all-day'].push(p.offers.slice(1));
      continue;
    }
    const lunch=p.offers.filter(o=>o.service==='lunch');
    const untimed=p.offers.filter(o=>o.service==='unknown');
    const explicit=p.offers.filter(o=>o.service==='all-day');
    if (lunch.length) proposals.lunch.push(lunch);
    // One printed lunch offer plus exactly two untimed offers is a day poster.
    if (p.service!=='nightly' && p.service!=='conflict') {
      if (explicit.length) proposals['all-day'].push(explicit);
      else if (lunch.length===1 && untimed.length===2 && p.offers.length===3) proposals['all-day'].push(untimed);
      else if (p.service==='all-day') proposals['all-day'].push(untimed);
      if (p.service==='lunch' && p.offers.length===1 && !lunch.length) proposals.lunch.push(p.offers);
    }
  }
  let allDay=unique(proposals['all-day'],2);
  // Preserve published text and order when a redesigned poster repeats it.
  if (allDay && existingAllDay.length===2 && setKey(allDay)===setKey(existingAllDay)) allDay=existingAllDay;
  const repeats=allDay || (proposals['all-day'].length ? [] : existingAllDay);
  const repeatKeys=new Set(repeats.map(o=>offerKey(o.content)));
  for (const p of posters) {
    const explicit=p.offers.filter(o=>o.service==='nightly');
    const hasAllDayPair=repeats.length===2 && repeats.every(r=>p.offers.some(o=>offerKey(o.content)===offerKey(r.content)));
    let nightly=explicit;
    if (p.service==='nightly' && hasAllDayPair) nightly=p.offers.filter(o=>!repeatKeys.has(offerKey(o.content)) && ['nightly','unknown'].includes(o.service));
    // A night-only poster is safe by itself when it has precisely the expected
    // count. Larger posters remain staged until the repeated pair is known.
    const count=[1,5].includes(weekday)?2:1;
    if (p.service==='nightly' && p.offers.length===count && !explicit.length) nightly=p.offers;
    nightly=nightly.filter(o=>!repeatKeys.has(offerKey(o.content)));
    if (weekday===3 && !nightly.every(o=>/\bwing\s+night\b/i.test(`${o.content} ${o.evidence}`))) nightly=[];
    if (![0,2,6].includes(weekday) && nightly.length) proposals.nightly.push(nightly);
  }
  const result=[];
  for (const [service,count] of [['lunch',1],['all-day',2],['nightly',[1,5].includes(weekday)?2:1]]) {
    const items=service==='all-day'?allDay:unique(proposals[service],count);
    if (items) result.push({day_of_week:weekday,service,items:items.map(o=>({content:canonicalizeSlotContent(o.content,weekday,service)}))});
  }
  if (result.length) return result;
  // Four-item Monday/Friday night fallback: deterministic position mapping when
  // the normal path produces nothing, the poster_evidence itself explicitly names
  // "Monday Night" or "Friday Night", exactly 4 offers, and no all-day pair is
  // known from either the current posters or prior automation.
  if ([1,5].includes(weekday) && !allDay && existingAllDay.length===0) {
    const dayLabel=weekday===1?'monday':'friday';
    for (const p of posters) {
      if (p.offers.length !== 4) continue;
      // Check poster_evidence directly, not combined with day_evidence.
      // "Night Specials 5-10" does not qualify; "Monday Night Specials" does.
      if (!new RegExp(`\\b${dayLabel}\\s+night\\b`,'i').test(p.poster_evidence)) continue;
      // All four offers must be non-empty and well-formed.
      if (p.offers.some(o=>!o.content || !o.content.trim())) continue;
      return [
        {day_of_week:weekday,service:'nightly',items:[{content:canonicalizeSlotContent(p.offers[0].content,weekday,'nightly')},{content:canonicalizeSlotContent(p.offers[1].content,weekday,'nightly')}]},
        {day_of_week:weekday,service:'all-day',items:[{content:canonicalizeSlotContent(p.offers[2].content,weekday,'all-day')},{content:canonicalizeSlotContent(p.offers[3].content,weekday,'all-day')}]},
      ];
    }
  }
  return result;
}
