// Evidence is persisted separately from the website's final group structure.
// A poster-level night heading does NOT make every offer a night-only offer.
const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
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
export function validateEvidence(value) {
  const str = (v,n) => typeof v === 'string' && v.length <= n;
  if (!value || Array.isArray(value) || !Number.isInteger(value.day_of_week) || value.day_of_week < -1 || value.day_of_week > 6 ||
      !str(value.day_evidence,160) || !str(value.poster_evidence,160) || !Array.isArray(value.offers) || value.offers.length > 12) throw Error('Invalid poster evidence');
  const offers = value.offers.map(o => {
    if (!o || !str(o.content,150) || !o.content.trim() || !str(o.service_time,80) || !str(o.evidence,160)) throw Error('Invalid offer evidence');
    return {content:o.content,service_time:o.service_time,evidence:o.evidence};
  });
  if (new Set(offers.map(o=>offerKey(o.content))).size !== offers.length) throw Error('Duplicate extracted offer');
  return {day_of_week:value.day_of_week,day_evidence:value.day_evidence,poster_evidence:value.poster_evidence,offers};
}
function forToday(value,weekday) {
  try {
    const p=validateEvidence(value);
    const days=DAYS.flatMap((d,i)=>new RegExp(`\\b${d}\\b`,'i').test(p.day_evidence)?[i]:[]);
    if (p.day_of_week!==weekday || days.length!==1 || days[0]!==weekday) return null;
    const offers=p.offers.map(o=>({...o,service:serviceOf(`${o.service_time} ${o.evidence}`)}));
    if (offers.some(o=>o.service==='conflict')) return null;
    return {...p,offers,service:serviceOf(p.poster_evidence)};
  } catch { return null; }
}
const setKey = items => items.map(o=>offerKey(o.content)).sort().join('|');
const unique = (sets,count) => {
  const full=sets.filter(s=>s.length===count && new Set(s.map(o=>offerKey(o.content))).size===count);
  return full.length && full.length===sets.length && new Set(full.map(setKey)).size===1 ? full[0] : null;
};
export function reconcilePosters(candidates,weekday,existingAllDay=[]) {
  const posters=candidates.map(c=>forToday(c,weekday)).filter(Boolean);
  const proposals={'lunch':[],'all-day':[],'nightly':[]};
  for (const p of posters) {
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
    if (items) result.push({day_of_week:weekday,service,items:items.map(o=>({content:o.content}))});
  }
  return result;
}
