// What staff must look at for Wing Wednesday. The admin notice, /admin/automation and
// email alerts all use this one decision, so a poster can't be resolved in one and
// still open in another. Read-only.
export const WING_HOLD = Object.freeze({
  prices: 'Missing, malformed or ambiguous wing prices',
  day: 'Poster does not establish Wednesday',
  two: 'Poster shows more than one wing offer',
  conflict: 'Posters at the same time disagree on wing prices',
  failed: 'The Facebook reading failed validation',
  promotion: 'Wednesday poster advertises a different nightly promotion',
  group: 'Wing options group is missing',
  fit: 'Printed wing options do not fit the stored items',
  unpublished: 'Verified wing prices could not be published to Wing Wednesday',
});
export const WING_HOLD_REASONS = new Set(Object.values(WING_HOLD));
export const wingHoldDetail = (reason,mask) => mask===3 ? reason : `${reason}|${mask}`;
export const wingHoldReason = detail => String(detail).replace(/\|[12]$/,'');

// Old holds without a mask apply to both options. Resolve only the options staff
// have explicitly locked. A newer decision or dismissal still ends the old review.
const requested = `CASE substr(d.detail,-2) WHEN '|1' THEN 1 WHEN '|2' THEN 2 ELSE 3 END`;
const unresolved = `(${requested}) & ~COALESCE((SELECT SUM(1 << (s.position-1))
  FROM special_slots s WHERE s.group_id='ww-live:ww-default:wings' AND s.position IN (1,2) AND s.manual_locked=1),0)`;
export const wingAttentionQuery = `SELECT d.import_id,d.detail,d.week_start,d.rowid AS decision_rowid,
      i.permalink_url,i.fb_post_id,i.fb_created_time,
      i.image_hash,i.candidate_json,i.extracted_json,c.revision,c.section_service_date,(${unresolved}) AS unresolved_mask
    FROM wing_wednesday_decisions d
    JOIN special_imports i ON i.id=d.import_id
    JOIN special_collections c ON c.id='wing-wednesday' AND c.section_week_start=d.week_start
    WHERE d.outcome='held' AND (${unresolved})<>0
      AND i.review_status IN ('pending','accepted')
      AND d.rowid=(SELECT MAX(l.rowid) FROM wing_wednesday_decisions l WHERE l.week_start=d.week_start)
      AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=i.fb_post_id
        AND newer.parser_version=i.parser_version AND newer.rowid>i.rowid) LIMIT 1`;

export async function readWingAttention(env) {
  const row = await env.DB.prepare(wingAttentionQuery).first();
  return row ? {...row,detail:wingHoldReason(row.detail)} : null;
}
