// Wing Wednesday prices arrive on the ordinary Wednesday daily poster, so this only
// reads evidence the daily pipeline already staged. It makes no AI call and writes
// nothing the daily reconciler reads. Failures here never affect other specials.
import {automaticWeekRange} from './auto-week.js';
import {parserVersionFor} from './classify.js';
import {dailyPosterWeekday} from './guarded-auto.js';
import {verifyWingOptions,isWingOffer} from './wing-night.js';
import {validateCurrentDay} from './reconcile.js';
import {composeMexicanItem,splitMexicanItem} from '../../src/lib/mexican-item.js';
import {WING_HOLD,wingHoldDetail} from './wing-review.js';
import {factKey,serviceFromEvidence} from './evidence.js';
import {sectionIdFor} from '../../src/lib/section-links.js';
import {WING_OPTIONS_GROUP,splitWingPrice,wingItemName,wingOptionPositions,wingOptionSlots,wingPriceText} from '../../src/lib/wing-wednesday.js';

const dateOf=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const chicagoHour=value=>Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',hourCycle:'h23'}).format(new Date(value)));
const shift=(date,days)=>{const next=new Date(`${date}T12:00:00Z`);next.setUTCDate(next.getUTCDate()+days);return next.toISOString().slice(0,10);};
const scanKey='wing_wednesday_complete_scan';
const currentScan=parameter=>`EXISTS(SELECT 1 FROM settings WHERE key='${scanKey}' AND value=${parameter})`;

// Cron and webhook runs can overlap. A newer complete scan, even an empty one,
// invalidates an older run before it can use its in-memory source IDs.
export async function recordWingScan(env,started) {
  const token=`${String(started).padStart(16,'0')}:${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO settings(key,value) VALUES(?1,?2)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE substr(excluded.value,1,16)>=substr(settings.value,1,16)`).bind(scanKey,token).run();
  return token;
}

/** Reads one poster. Returns verified lines, or the reason it must be held. */
export function wingPosterEvidence(candidate,createdTime,serviceDate) {
  const offers=Array.isArray(candidate?.offers) ? candidate.offers.filter(isWingOffer) : [];
  if(!offers.length) return null;
  if(dailyPosterWeekday(candidate,createdTime,serviceDate)!==3) return {hold:WING_HOLD.day};
  if(offers.length!==1) return {hold:WING_HOLD.two};
  const offer=offers[0];
  const optionIssues=new Set(['Conflicting offer price','Meal facts differ from original evidence',
    'Uncertain extracted offer','Service not established by evidence']);
  if(candidate.issues?.some(issue=>issue.index===candidate.offers.indexOf(offer) && !optionIssues.has(issue.reason)))
    return {hold:WING_HOLD.prices};
  try { validateCurrentDay({...candidate,poster_evidence:`${candidate.poster_evidence} ${offer.date_evidence ?? ''}`},3,serviceDate); }
  catch { return {hold:WING_HOLD.day}; }
  const service=serviceFromEvidence(`${offer.service_time ?? ''} ${offer.service_evidence ?? ''}`);
  if(!['nightly','unknown'].includes(service) || /\$/.test(`${offer.service_time ?? ''} ${offer.service_evidence ?? ''}`))
    return {hold:WING_HOLD.prices};
  let [boneIn,boneless]=verifyWingOptions(offer.content,offer.evidence);
  for(const note of Array.isArray(offer.uncertainties) ? offer.uncertainties : offer.uncertainties ? [''] : []) {
    const bone=/\bbone[\s-]*in\b/i.test(note), less=/\bboneless\b/i.test(note);
    if(bone || !less) boneIn=null;
    if(less || !bone) boneless=null;
  }
  return boneIn || boneless ? {boneIn,boneless} : {hold:WING_HOLD.prices};
}

// A verified poster is the current price, replacing any earlier one, staff-entered
// included. It writes only the price: staff's name and description stay. The wing type
// named on the item decides which price it takes, so reordered items stay correct and an
// item naming no clear type is held. Add Fries belongs to the nightly card, so a printed
// fries line never reaches this section.
function plannedSlots(slots,evidence) {
  const typed=wingOptionSlots(slots), spots=wingOptionPositions(slots);
  const writes=[];
  let missing=0,ambiguous=false;
  for(const [type,printed] of [['boneIn',evidence.boneIn],['boneless',evidence.boneless]]) {
    const slot=typed[type];
    if(!slot || !printed) missing|=1<<(spots[type]-1);
    if(!slot) { ambiguous||=!!printed; continue; }
    const {title,description}=splitMexicanItem(slot.content);
    const price=wingPriceText(title);
    // Unverified: an earlier poster's price comes off, and a staff price stays for review.
    if(!printed && (!price || price!==wingPriceText(splitMexicanItem(slot.last_auto_value).title))) continue;
    const content=composeMexicanItem([wingItemName(title),printed ? splitWingPrice(printed).price : ''].filter(Boolean).join(' '),description);
    if(content!==slot.content) writes.push([slot.position,content]);
  }
  const staffLeft=slots.some(s=>s.position<=2 && s.manual_locked && !writes.some(([position])=>position===s.position));
  return {missing,ambiguous,writes,source:staffLeft ? 'manual' : writes.length ? 'facebook' : null};
}

const readCandidate=source=>{
  try { return JSON.parse(String(source.candidate_json ?? source.extracted_json).replace(/^```(?:json)?\n?|\n?```$/gm,'').trim()); }
  catch { return null; }
};
// Today's Wednesday nightly special, when automation published something other than
// wings. Staff values are never a promotion to report; those are intentional.
async function otherNightlyPromotion(env,today) {
  if(new Date(`${today}T12:00:00Z`).getUTCDay()!==3) return null;
  const {results}=await env.DB.prepare(`SELECT s.content,s.section_link FROM special_slots s
    JOIN special_groups g ON g.id=s.group_id AND g.day_of_week=3 AND g.service='nightly' AND g.enabled=1
    JOIN special_collections c ON c.id=g.collection_id AND c.kind='week'
    JOIN weekly_specials w ON w.id=c.weekly_special_id AND w.week_start_date<=?1 AND w.week_end_date>=?1
    WHERE s.position=1 AND s.origin='automation' AND s.manual_locked=0 AND s.content=s.last_auto_value`).bind(today).all();
  const slot=results?.length===1 ? results[0] : null;
  if(!slot?.content?.trim() || sectionIdFor({day_of_week:3,service:'nightly'},slot)) return null;
  return slot.content;
}

export async function reconcileWingWednesday(env,{sourceIds,today,scanToken}={}) {
  const stage=reason=>({written:false,reason});
  if(!scanToken || !sourceIds?.length || today!==dateOf(Date.now())) return stage('No current sources');
  const scan=JSON.stringify(sourceIds);
  const unresolved=`EXISTS(SELECT 1 FROM special_imports WHERE id IN (SELECT value FROM json_each(?1))
    AND processing_status IN ('pending','processing'))`;
  if(await env.DB.prepare(`SELECT 1 WHERE ${unresolved}`).bind(scan).first()) return stage('Current sources awaiting recovery');
  const weekday=new Date(`${today}T12:00:00Z`).getUTCDay();
  const {start}=automaticWeekRange(today,weekday,weekday===0 ? 19 : 0);
  const serviceDate=shift(start,2);
  if(today>serviceDate) return stage('Outside the Wing Wednesday window');
  const promotion=await otherNightlyPromotion(env,today);
  // A reading the daily pipeline rejected can only ever be held, never published.
  const {results:rows}=await env.DB.prepare(`SELECT * FROM special_imports WHERE id IN (SELECT value FROM json_each(?1))
    AND parser_version=?2 AND ${currentScan('?3')}
    AND ((processing_status='staged' AND validation_result='ok')
      OR (processing_status='failed' AND validation_result='rejected' AND extracted_json IS NOT NULL))
    AND image_r2_key IS NOT NULL AND review_status IN ('pending','accepted')
    AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=special_imports.fb_post_id
      AND newer.parser_version=?2 AND newer.rowid>special_imports.rowid)`).bind(scan,parserVersionFor(env),scanToken).all();
  // Only the newest current-week poster counts. An older one can never replace it,
  // and a newest poster that must be held leaves the published values in place.
  const posters=(rows ?? []).flatMap(source=>{
    const created=Date.parse(source.fb_created_time);
    if(!Number.isFinite(created) || created>Date.now()) return [];
    const date=dateOf(created);
    if(date!==today) return [];
    const candidate=readCandidate(source);
    let evidence=null;
    try { evidence=wingPosterEvidence(candidate,source.fb_created_time,serviceDate); } catch { /* not a daily poster */ }
    if(evidence && source.processing_status==='failed') evidence={hold:WING_HOLD.failed};
    // The night's published special is another promotion, printed on this poster.
    if(!evidence && promotion && source.processing_status==='staged' && date===today
      && candidate?.offers?.some?.(o=>typeof o?.content==='string' && factKey(o.content)===factKey(promotion))) evidence={hold:WING_HOLD.promotion};
    return evidence ? [{source,evidence,created}] : [];
  }).sort((a,b)=>b.created-a.created);
  if(!posters.length) return stage('No current-week wing poster');
  const {source}=posters[0];
  // Same-time verified posters with different prices: neither one is newer.
  const peers=posters.filter(p=>p.created===posters[0].created);
  const evidence={...posters[0].evidence};
  const conflicts=['boneIn','boneless'].filter(key=>peers.some(p=>p.evidence[key]!==evidence[key]));
  for(const key of conflicts) evidence[key]=null;
  if(conflicts.length && !evidence.boneIn && !evidence.boneless) evidence.hold=WING_HOLD.conflict;
  // A publication that failed is the one decision that is retried.
  const prior=await env.DB.prepare('SELECT outcome,detail FROM wing_wednesday_decisions WHERE import_id=?1').bind(source.id).first();
  if(prior && (prior.outcome!=='held' || prior.detail!==WING_HOLD.unpublished)) return stage('Newest poster already decided');
  const decide=async(outcome,detail)=>{
    await env.DB.prepare(`INSERT INTO wing_wednesday_decisions(import_id,week_start,outcome,detail)
      SELECT ?1,?2,?3,?4 WHERE ${currentScan('?6')}
      ON CONFLICT(import_id) DO UPDATE SET outcome=excluded.outcome,detail=excluded.detail
      WHERE wing_wednesday_decisions.outcome='held' AND wing_wednesday_decisions.detail=?5`).bind(source.id,start,outcome,detail,WING_HOLD.unpublished,scanToken).run();
    return stage(detail);
  };
  const collection=await env.DB.prepare("SELECT * FROM special_collections WHERE id='wing-wednesday' AND kind='section'").first();
  // Sunday before 7 PM the weekly transaction hasn't run yet, which is normal.
  if(!collection || collection.section_week_start!==start) {
    if(weekday===0 && chicagoHour(Date.now())<19) return stage('Wing Wednesday is not prepared for this week');
    return evidence.hold ? stage('Wing Wednesday is not prepared for this week') : decide('held',WING_HOLD.unpublished);
  }
  if(evidence.hold) return decide('held',evidence.hold);
  const {results:slots}=await env.DB.prepare('SELECT * FROM special_slots WHERE group_id=?1 ORDER BY position').bind(WING_OPTIONS_GROUP).all();
  if(slots?.length!==4) return decide('held',WING_HOLD.group);
  let plan;
  try { plan=plannedSlots(slots,evidence); } catch { return decide('held',WING_HOLD.fit); }
  const {writes,missing}=plan;
  const detail=missing ? wingHoldDetail(plan.ambiguous ? WING_HOLD.fit : conflicts.length ? WING_HOLD.conflict : WING_HOLD.prices,missing)
    : `fb_created=${source.fb_created_time}; ${writes.length} option(s) changed`;
  const token=crypto.randomUUID();
  const prepare=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  const gate="EXISTS(SELECT 1 FROM special_collections WHERE id='wing-wednesday' AND mutation_token=?1)";
  let results;
  try { results=await env.DB.batch([
    // The revision check makes a staff save or reseed since the read above a no-op.
    prepare(`UPDATE special_collections SET revision=revision+1,mutation_token=?1,updated_at=?2,
      section_source=COALESCE(?9,section_source)
      WHERE id='wing-wednesday' AND kind='section' AND revision=?3 AND section_week_start=?4
      AND ${currentScan('?8')}
      AND NOT EXISTS(SELECT 1 FROM special_imports WHERE id IN (SELECT value FROM json_each(?7))
        AND processing_status IN ('pending','processing'))
      AND EXISTS(SELECT 1 FROM special_imports i WHERE i.id=?5 AND i.candidate_json=?6 AND i.processing_status='staged'
        AND i.validation_result='ok' AND i.review_status IN ('pending','accepted')
        AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=i.fb_post_id
          AND newer.parser_version=i.parser_version AND newer.rowid>i.rowid))`,
      token,new Date(Date.now()).toISOString(),collection.revision,start,source.id,source.candidate_json,scan,scanToken,plan.source),
    ...writes.map(([position,content])=>prepare(`UPDATE special_slots SET content=?2,price='',origin=?3,manual_locked=0,last_auto_value=?4,manual_edited_at=NULL
      WHERE group_id=?5 AND position=?6 AND ${gate}`,token,content,content ? 'automation' : 'legacy',content || null,WING_OPTIONS_GROUP,position)),
    prepare(`INSERT OR REPLACE INTO wing_wednesday_decisions(import_id,week_start,outcome,detail) SELECT ?2,?3,?4,?5 WHERE ${gate}`,token,source.id,start,missing ? 'held' : 'published',detail),
    prepare("SELECT id FROM special_collections WHERE id='wing-wednesday' AND mutation_token=?1",token),
  ]); } catch { return decide('held',WING_HOLD.unpublished); }
  return results.at(-1)?.results?.length ? {written:true,reason:detail} : stage('Concurrent change; nothing written');
}
