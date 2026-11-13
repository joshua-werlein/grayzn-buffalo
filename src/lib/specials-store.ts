import { chicagoCalendarDate, isIsoCalendarDate, mondayForIsoDate, standardWeekEndDate } from './weekly-specials';
import {composeMexicanItem,splitMexicanItem,assertPriceFreeMexicanDefault,MEXICAN_ITEM_LIMIT} from './mexican-item.js';
import {isSoupGroup,soupGroupId} from './daily-soup.js';
import {mexicanNightDetailVisible} from './mexican-night-visibility.js';
import {isWingSauceGroup,wingPriceText,wingWednesdayVisible,wingWeekFor,WING_OPTIONS_GROUP} from './wing-wednesday.js';
import {priceFreeWingDefault} from './section-links.js';
import {normalizeMenuCase,normalizeChangedMenuCase} from './text-case.js';

export const SPECIAL_LIMIT = 150;
// Sections whose items carry a separate title and description, and full poster text.
const ITEM_SECTIONS = ['mexican-night','mexican-night-defaults','wing-wednesday','wing-wednesday-defaults'];
const PRICE_FREE_DEFAULTS: Record<string,string> = {'mexican-night-defaults':'Mexican Night','wing-wednesday-defaults':'Wing Wednesday'};
export const DAY_NUMBERS = [1, 2, 3, 4, 5, 6, 0];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export type SpecialSlot = {
  position: number; content: string | null; price: string; section_link: string;
  origin: 'legacy' | 'manual' | 'automation'; manual_locked: number; last_auto_value: string | null;
  manual_edited_at?: string | null; staff_edited?: boolean;
};
export type SpecialGroup = {
  id: string; day_of_week: number; service: string; label: string; service_time: string;
  sort: number; enabled: number; slots: SpecialSlot[];
};
export type SpecialCollection = {
  id: string; kind: 'week' | 'defaults' | 'section'; weekly_special_id: number | null;
  title: string; schedule: string; revision: number; updated_at?: string | null; groups: SpecialGroup[];
};
export type WeeklySpecial = {
  id: number; week_start_date: string; week_end_date: string; created_at: string; updated_at: string;
  collection: SpecialCollection;
};
export class SpecialConflict extends Error {
  constructor() { super('These specials changed after you opened them. Your draft is preserved. Open the latest saved version in another tab and compare before saving.'); }
}
export const displayedSpecial = (slot: Pick<SpecialSlot, 'content' | 'price'>) =>
  [slot.content ?? '', slot.price].filter(Boolean).join(' ');
export const visibleSlots = (group: SpecialGroup) => group.slots.filter(slot => (slot.content ?? '').trim()).sort((a,b) => a.position-b.position);
// Compare complete offers only; never guess that differently priced dishes match.
const offerKey = (text: string) => text.replace(/\s+/g,' ').trim().toLowerCase();
export function specialInputCount(group: Pick<SpecialGroup,'service'|'day_of_week'>): number {
  if (group.service === 'lunch') return 1;
  if (group.service === 'all-day') return 2;
  // Friday Nightly shows up to four specials; Monday two; other weeknights one.
  if (group.service === 'nightly') return [0,6].includes(group.day_of_week) ? 0 : group.day_of_week === 5 ? 4 : group.day_of_week === 1 ? 2 : 1;
  return group.day_of_week === -1 ? 4 : 1;
}
export const visibleGroups = (groups: SpecialGroup[], day?: number) => groups
  .map(group => [1,5].includes(group.day_of_week) && ['lunch','nightly'].includes(group.service)
    ? {...group, slots: group.slots.filter(slot => !groups.some(other => other.enabled === 1 && other.day_of_week === group.day_of_week && other.service === 'all-day' && visibleSlots(other).some(item => offerKey(displayedSpecial(item)) === offerKey(displayedSpecial(slot)))))}
    : group)
  .filter(group => group.enabled === 1 && (day === undefined || group.day_of_week === day) && visibleSlots(group).length)
  .sort((a,b) => a.sort-b.sort);
export const slotValue = (slot: SpecialSlot) => JSON.stringify([slot.content, slot.price, slot.section_link]);
export function blankGroup(day: number, sort = 0): SpecialGroup {
  return { id: `new:${crypto.randomUUID()}`, day_of_week: day, service: 'custom', label: '', service_time: '', sort, enabled: 1,
    slots: [1,2,3,4].map(position => ({ position, content: '', price: '', section_link: '', origin: 'manual', manual_locked: 1, last_auto_value: null })) };
}
export function newWeekFromDefaults(defaults: SpecialCollection): SpecialCollection {
  return { id: '', kind: 'week', weekly_special_id: null, title: '', schedule: '', revision: 0,
    groups: defaults.groups.map(group => ({ ...group, id: isSoupGroup(group) ? soupGroupId('',group.day_of_week) : `new:${crypto.randomUUID()}`,
      slots: group.slots.map(slot => {
        const priceFree = priceFreeWingDefault(group, slot);
        const content = priceFree ?? slot.content ?? '';
        // Blank default slots are immediately eligible for automation.
        // Populated default slots carry unlocked 'manual' origin so automation may replace
        // them with current-date Facebook evidence (manual_locked=0), but are
        // distinguishable from confirmed manual entries (manual_locked=1,'manual').
        if (!content.trim()) {
          return { ...slot, content: '', origin: 'legacy' as const, manual_locked: 0, last_auto_value: null };
        }
        return { ...slot, content, price: priceFree === null ? slot.price : '', origin: 'manual' as const, manual_locked: 0, last_auto_value: null };
      }) })) };
}

// These readers intentionally have no legacy fallback. A missing migration is
// an unavailable editor, never permission to write to a second content model.
export async function readCollection(env: any, id: string): Promise<SpecialCollection> {
  const row = await env.DB.prepare('SELECT id,kind,weekly_special_id,title,schedule,revision,updated_at FROM special_collections WHERE id=?1 AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)').bind(id).first();
  if (!row) throw new Error('Specials are unavailable. The normalized schema must be installed before using this editor.');
  const { results: groups } = await env.DB.prepare('SELECT id,day_of_week,service,label,service_time,sort,enabled FROM special_groups WHERE collection_id=?1 ORDER BY day_of_week,sort,id').bind(id).all();
  const { results: slots } = await env.DB.prepare('SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=?1 ORDER BY s.position').bind(id).all();
  return { ...row, groups: (groups ?? []).map((group: any) => ({ ...group, slots: (slots ?? []).filter((slot: any) => slot.group_id === group.id) })) };
}
export async function readWeek(env: any, id: number): Promise<WeeklySpecial> {
  const row = await env.DB.prepare('SELECT * FROM weekly_specials WHERE id=?1').bind(id).first();
  if (!row) throw new Error('That saved week no longer exists.');
  const collection = await env.DB.prepare("SELECT id FROM special_collections WHERE weekly_special_id=?1 AND kind='week'").bind(id).first();
  if (!collection) throw new Error('The normalized specials migration is not available.');
  return { ...row, collection: await readCollection(env, collection.id) };
}
/** Read-only default selection; ambiguity keeps the existing new-week view. */
export async function currentSavedWeekId(env: any, now = new Date()): Promise<number | null> {
  const {results} = await env.DB.prepare('SELECT id FROM weekly_specials WHERE week_start_date<=?1 AND week_end_date>=?1').bind(chicagoCalendarDate(now)).all();
  return results?.length === 1 ? results[0].id : null;
}
export async function getWeeklySpecialsForDateRange(env: any, start: string, end: string): Promise<WeeklySpecial[]> {
  try {
    const { results } = await env.DB.prepare('SELECT id FROM weekly_specials WHERE week_start_date<=?2 AND week_end_date>=?1 ORDER BY week_start_date').bind(start,end).all();
    return await Promise.all((results ?? []).map((row: any) => readWeek(env, row.id)));
  } catch { return []; }
}
export async function getMexicanNight(env: any): Promise<SpecialCollection | null> {
  try { return await readCollection(env, 'mexican-night'); } catch { return null; }
}
export async function getWingWednesday(env: any): Promise<(SpecialCollection & {section_week_start: string | null; section_service_date: string | null; section_source: string}) | null> {
  try {
    const collection = await readCollection(env, 'wing-wednesday');
    const row = await env.DB.prepare("SELECT section_week_start,section_service_date,section_source FROM special_collections WHERE id='wing-wednesday'").first();
    return {...collection, section_week_start: row?.section_week_start ?? null, section_service_date: row?.section_service_date ?? null, section_source: row?.section_source ?? ''};
  } catch { return null; }
}

// Until the weekly rollover, last week's section is about to be replaced. The editor
// shows what the coming Wednesday will start from, so a save holds exactly what staff
// saw instead of carrying last week's prices forward. Display only.
export function wingEditorValues(wing: SpecialCollection, defaults: SpecialCollection | null, weekStart: string | null, now = new Date()): SpecialCollection {
  const target = wingWeekFor(now);
  if (!defaults || (weekStart && weekStart >= target.weekStart)) return wing;
  return {...wing, title: defaults.title, schedule: defaults.schedule, groups: wing.groups.map(group => {
    const from = defaults.groups.find(d => `ww-live:${d.id}` === group.id);
    return {...group, label: from?.label ?? group.label, slots: group.slots.map(slot => ({...slot, price: '', content: from?.slots.find(s => s.position === slot.position)?.content ?? ''}))};
  })};
}

// The single decision for each section and every link pointing to it.
export async function readPublicSections(env: any, now = new Date()) {
  const [mexican,wing] = await Promise.all([getMexicanNight(env),getWingWednesday(env)]);
  const mexicanGroups = mexican ? visibleGroups(mexican.groups) : [];
  const wingGroups = wing ? visibleGroups(wing.groups) : [];
  const mexicanVisible = mexicanGroups.length > 0 && mexicanNightDetailVisible(mexican?.updated_at, now);
  const wingVisible = wingGroups.length > 0 && wingWednesdayVisible(wing?.section_service_date, now);
  const wingLines = wingGroups.filter(group => !isWingSauceGroup(group)).flatMap(group => visibleSlots(group).map(slot => splitMexicanItem(displayedSpecial(slot)).title));
  const addFries = await env.DB.prepare("SELECT 1 FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='defaults' AND g.day_of_week=3 AND g.service='nightly' AND g.enabled=1 AND s.content LIKE '%add fries%' LIMIT 1").first().catch(() => null);
  return {wing,mexicanGroups,wingGroups,mexicanVisible,wingVisible,
    // The Wing section describes one Wednesday; a later one on the board isn't it.
    sectionsFor:(date: string) => [...(mexicanVisible ? ['mexican-night'] : []),...(wingVisible && date === wing?.section_service_date ? ['wing-wednesday'] : [])],
    wingOptions:{lines:wingLines,priced:wingLines.some(line => line.includes('$')),source:wing?.section_source ?? '',
      corrected:wingGroups.some(group=>group.id===WING_OPTIONS_GROUP && group.slots.some(slot=>slot.manual_edited_at)),addFries:!!addFries}};
}

// ── Import review ─────────────────────────────────────────────────────────────

export type CandidateItem = { content: string; price?: string };
export type CandidateGroup = { label: string; day_of_week: number; service: string; items: CandidateItem[] };
export type ImportCandidate = {
  id: string; fb_post_id: string; fb_created_time: string; fb_updated_time: string | null;
  caption: string; permalink_url: string; image_r2_key: string | null;
  target_kind: string; target_day: number | null; target_service: string | null;
  target_collection_id: string | null; classification_reason: string;
  candidate_json: string | null; validation_result: string | null;
  processing_status: string; review_status: string; fetched_at: string;
};

export function parseCandidateJson(json: string | null): CandidateGroup[] {
  if (!json) return [];
  try { return normalizeCandidateGroups(JSON.parse(json)); } catch { return []; }
}

/** Accept older split-price candidates, but only write inline text from now on. */
export function normalizeCandidateGroups(input: CandidateGroup[]): CandidateGroup[] {
  if (!Array.isArray(input) || input.length > 84) throw new Error('Invalid candidate groups.');
  const groups = input.map(g => {
    if (!g || typeof g.label !== 'string' || !Number.isInteger(g.day_of_week) || g.day_of_week < -1 || g.day_of_week > 6 || !['lunch','all-day','nightly','custom'].includes(g.service) || !Array.isArray(g.items)) throw new Error('Invalid candidate group.');
    return {...g, items:g.items.map(item => {
      if (!item || typeof item.content !== 'string' || (item.price != null && typeof item.price !== 'string')) throw new Error('Invalid candidate item.');
      const content = displayedSpecial({content:item.content,price:item.price ?? ''});
      if (content.length > SPECIAL_LIMIT) throw new Error('Each special, including its price, must be 150 characters or fewer.');
      return {content};
    })};
  });
  return groups.map(g => {
    const items = [1,5].includes(g.day_of_week) && ['lunch','nightly'].includes(g.service)
      ? g.items.filter(item => !groups.some(other => other.day_of_week === g.day_of_week && other.service === 'all-day' && other.items.some(allDay => offerKey(allDay.content) === offerKey(item.content)))) : g.items;
    if (items.length > specialInputCount(g)) throw new Error('Too many specials for this service. Review the All Day items separately.');
    return {...g,items};
  });
}

export async function readImportCandidates(env: any): Promise<ImportCandidate[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id,fb_post_id,fb_created_time,fb_updated_time,caption,permalink_url,image_r2_key,
       target_kind,target_day,target_service,target_collection_id,classification_reason,
       candidate_json,validation_result,processing_status,review_status,fetched_at
       FROM special_imports
       WHERE review_status='pending' AND processing_status IN ('staged','failed','skipped')
       ORDER BY fb_created_time DESC LIMIT 50`
    ).all();
    return (results ?? []) as ImportCandidate[];
  } catch { return []; }
}

/** Presentation filter: for each Facebook source post keep only the most-recently-fetched
 *  candidate. Superseded versions from older parser runs stay in the database but are
 *  hidden from review until the newer version is resolved. */
export function deduplicateCandidatesByPost(candidates: ImportCandidate[]): ImportCandidate[] {
  const newest = new Map<string, ImportCandidate>();
  for (const c of candidates) {
    const existing = newest.get(c.fb_post_id);
    if (!existing || c.fetched_at > existing.fetched_at) newest.set(c.fb_post_id, c);
  }
  return [...newest.values()].sort((a, b) => b.fb_created_time.localeCompare(a.fb_created_time));
}

function applyCandidateGroupsToCollection(collection: SpecialCollection, candidateGroups: CandidateGroup[]): SpecialCollection {
  const groups = collection.groups.map(g => ({ ...g, slots: g.slots.map(s => ({ ...s })) }));
  for (const cg of normalizeCandidateGroups(candidateGroups)) {
    // Sections always use day_of_week=-1 regardless of what AI returned.
    const dayNum = collection.kind === 'section' ? -1 : cg.day_of_week;
    const existingIdx = groups.findIndex(g => g.day_of_week === dayNum && g.service === cg.service);
    const slots = ([1, 2, 3, 4] as const).map(pos => ({
      position: pos as number,
      content: cg.items[pos - 1]?.content ?? '',
      price: '',
      section_link: '',
      origin: cg.items[pos - 1]?.content.trim() ? 'manual' as const : 'legacy' as const,
      manual_locked: cg.items[pos - 1]?.content.trim() ? 1 : 0,
      last_auto_value: null as string | null,
    }));
    if (existingIdx >= 0) {
      const existing = groups[existingIdx];
      // Preserve last_auto_value baseline for slots that already exist.
      groups[existingIdx] = {
        ...existing,
        label: cg.label || existing.label,
        enabled: 1,
        slots: slots.map((s, i) => ({ ...s, last_auto_value: existing.slots[i]?.last_auto_value ?? null })),
      };
    } else {
      const newGroup = blankGroup(dayNum, groups.length);
      newGroup.label = cg.label;
      newGroup.service = cg.service as SpecialGroup['service'];
      newGroup.slots = slots;
      groups.push(newGroup);
    }
  }
  return { ...collection, groups };
}

/** Apply a staged import candidate to a live specials collection.
 *  Reads candidate_json and target metadata from D1; never trusts client-submitted
 *  candidate data or ownership fields.  overrideGroups lets staff correct AI values
 *  before accepting — those corrections are still written with manual ownership.
 *
 *  Stale-candidate detection: for week targets, compares the week's updated_at
 *  against the candidate's fetched_at.  For sections, compares expectedRevision
 *  against the live collection revision.  Either mismatch throws SpecialConflict.
 */
export async function applyCandidate(
  env: any,
  importId: string,
  targetWeekId: number | null,
  expectedRevision: number,
  overrideGroups?: CandidateGroup[]
): Promise<{ weeklySpecialId: number | null; collectionId: string }> {
  const record: ImportCandidate | null = await env.DB.prepare(
    `SELECT id,target_kind,target_day,target_service,target_collection_id,
     candidate_json,review_status,fetched_at FROM special_imports WHERE id=?1`
  ).bind(importId).first();
  if (!record) throw new Error('Import record not found.');
  if (record.review_status !== 'pending') throw new Error('This import has already been reviewed.');

  const candidateGroups = overrideGroups ?? parseCandidateJson(record.candidate_json);
  if (!candidateGroups.length) throw new Error('No candidate items to apply.');

  let collectionId: string;
  let weekDates: { start: string; end: string } | undefined;

  if (record.target_kind === 'section') {
    if (!record.target_collection_id) throw new Error('Missing section target.');
    collectionId = record.target_collection_id;
  } else if (record.target_kind === 'week' || record.target_kind === 'ambiguous') {
    if (!targetWeekId) throw new Error('Select a saved week to apply this candidate to.');
    // Validate the week exists and get its collection/dates.
    const weekRow: any = await env.DB.prepare(
      "SELECT ws.id,ws.week_start_date,ws.week_end_date,ws.updated_at,sc.id cid FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id WHERE ws.id=?1"
    ).bind(targetWeekId).first();
    if (!weekRow) throw new Error('That saved week no longer exists.');
    collectionId = weekRow.cid;
    weekDates = { start: weekRow.week_start_date, end: weekRow.week_end_date };
    // Stale detection: was this week saved more recently than the candidate was staged?
    if (record.fetched_at && weekRow.updated_at && weekRow.updated_at > record.fetched_at) {
      throw new SpecialConflict();
    }
  } else {
    throw new Error(`Cannot apply an import with kind "${record.target_kind}".`);
  }

  const collection = await readCollection(env, collectionId);
  // Stale detection for sections (no updated_at; use revision from page load).
  if (record.target_kind === 'section' && collection.revision !== expectedRevision) {
    throw new SpecialConflict();
  }

  const next = applyCandidateGroupsToCollection(collection, candidateGroups);
  const result = await saveCollection(env, next, weekDates);

  await env.DB.prepare(
    "UPDATE special_imports SET review_status='accepted',reviewed_at=CURRENT_TIMESTAMP WHERE id=?1"
  ).bind(importId).run();
  await env.DB.prepare(
    "INSERT INTO special_import_events(import_id,event_type,detail) VALUES(?1,'review','accepted')"
  ).bind(importId).run();

  return { weeklySpecialId: result.id, collectionId: result.collectionId };
}

/** Record a Keep or Dismiss decision without touching specials content. */
export async function recordReviewDecision(
  env: any,
  importId: string,
  decision: 'kept' | 'dismissed',
  reason: string = ''
): Promise<void> {
  const record: any = await env.DB.prepare(
    'SELECT review_status FROM special_imports WHERE id=?1'
  ).bind(importId).first();
  if (!record) throw new Error('Import record not found.');
  if (record.review_status !== 'pending') throw new Error('This import has already been reviewed.');

  await env.DB.prepare(
    "UPDATE special_imports SET review_status=?1,review_reason=?2,reviewed_at=CURRENT_TIMESTAMP WHERE id=?3"
  ).bind(decision, reason, importId).run();
  await env.DB.prepare(
    "INSERT INTO special_import_events(import_id,event_type,detail) VALUES(?1,'review',?2)"
  ).bind(importId, decision).run();
}

/** Unlock blank slots in a saved week so the guarded Worker may fill them.
 *  Only slots whose content is empty and that carry no manual value are affected.
 *  The slot content and last_auto_value are not changed; origin is set to 'legacy'
 *  so the Worker's safe() check (origin !== 'manual') will pass. */
export async function unlockBlankSlots(
  env: any,
  weekId: number,
  expectedRevision: number,
): Promise<{ collectionId: string; revision: number; unlockedCount: number }> {
  const weekRow: any = await env.DB.prepare(
    "SELECT sc.id cid, sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id AND sc.kind='week' WHERE ws.id=?1"
  ).bind(weekId).first();
  if (!weekRow) throw new Error('That saved week no longer exists.');
  if (weekRow.revision !== expectedRevision) throw new SpecialConflict();
  const token = crypto.randomUUID();
  const collectionId = weekRow.cid;
  const prepare = (sql: string, ...args: any[]) => env.DB.prepare(sql).bind(...args);
  const gate = 'EXISTS(SELECT 1 FROM special_collections WHERE id=?1 AND mutation_token=?2)';
  const results = await env.DB.batch([
    prepare('UPDATE special_collections SET revision=revision+1,mutation_token=?1 WHERE id=?2 AND revision=?3', token, collectionId, expectedRevision),
    prepare(`UPDATE special_slots SET manual_locked=0,origin='legacy'
      WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id=?1)
        AND (content='' OR content IS NULL) AND price='' AND section_link=''
        AND ${gate}`, collectionId, token),
    prepare('SELECT id FROM special_collections WHERE id=?1 AND mutation_token=?2', collectionId, token),
  ]);
  if (!results.at(-1)?.results?.length) throw new SpecialConflict();
  return { collectionId, revision: expectedRevision + 1, unlockedCount: results[1]?.meta?.changes ?? 0 };
}

/** Re-lock blank slots so the guarded Worker may not auto-fill them.
 *  Only blank slots are affected; populated values are never changed. */
export async function lockBlankSlots(
  env: any,
  weekId: number,
  expectedRevision: number,
): Promise<{ collectionId: string; revision: number; lockedCount: number }> {
  const weekRow: any = await env.DB.prepare(
    "SELECT sc.id cid, sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id AND sc.kind='week' WHERE ws.id=?1"
  ).bind(weekId).first();
  if (!weekRow) throw new Error('That saved week no longer exists.');
  if (weekRow.revision !== expectedRevision) throw new SpecialConflict();
  const token = crypto.randomUUID();
  const collectionId = weekRow.cid;
  const prepare = (sql: string, ...args: any[]) => env.DB.prepare(sql).bind(...args);
  const gate = 'EXISTS(SELECT 1 FROM special_collections WHERE id=?1 AND mutation_token=?2)';
  const results = await env.DB.batch([
    prepare('UPDATE special_collections SET revision=revision+1,mutation_token=?1 WHERE id=?2 AND revision=?3', token, collectionId, expectedRevision),
    prepare(`UPDATE special_slots SET manual_locked=1,origin='manual'
      WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id=?1)
        AND (content='' OR content IS NULL) AND price='' AND section_link=''
        AND ${gate}`, collectionId, token),
    prepare('SELECT id FROM special_collections WHERE id=?1 AND mutation_token=?2', collectionId, token),
  ]);
  if (!results.at(-1)?.results?.length) throw new SpecialConflict();
  return { collectionId, revision: expectedRevision + 1, lockedCount: results[1]?.meta?.changes ?? 0 };
}

/** Derive the Facebook blank-fill state from actual slot ownership.
 *  'on'       = all blank slots are eligible (manual_locked=0, origin≠manual)
 *  'off'      = all blank slots are locked
 *  'mixed'    = some eligible, some locked
 *  'no-blanks'= no blank slots to fill */
export async function readFbFillState(
  env: any,
  collectionId: string,
): Promise<'on' | 'off' | 'mixed' | 'no-blanks'> {
  const stats: any = await env.DB.prepare(
    `SELECT SUM(CASE WHEN ss.manual_locked=0 AND ss.origin<>'manual' THEN 1 ELSE 0 END) unlocked,
            COUNT(*) total
     FROM special_slots ss JOIN special_groups sg ON sg.id=ss.group_id
     WHERE sg.collection_id=?1
       AND (ss.content='' OR ss.content IS NULL) AND ss.price='' AND ss.section_link=''`
  ).bind(collectionId).first();
  const unlocked = Number(stats?.unlocked ?? 0);
  const total = Number(stats?.total ?? 0);
  if (total === 0) return 'no-blanks';
  if (unlocked === total) return 'on';
  if (unlocked === 0) return 'off';
  return 'mixed';
}

/** Parse only editable values. Ownership/automatic baselines never come from a form. */
export function collectionFromForm(form: FormData, baseline: SpecialCollection): SpecialCollection {
  const value = (key: string) => String(form.get(key) ?? '').replace(/\r\n?/g,'\n');
  const newWeek = baseline.kind === 'week' && !baseline.id;
  const count = Number(value('group_count'));
  if (!Number.isInteger(count) || count < 0 || count > 84) throw new Error('Invalid group count.');
  const groups = Array.from({ length: count }, (_, index): SpecialGroup => {
    const p = `g${index}_`, id = value(p+'id');
    let old = baseline.groups.find(g => g.id === id);
    if (!old && !/^new:[0-9a-f-]{36}$/.test(id)) throw new Error('Unknown special group.');
    // New-week UUIDs differ between GET and POST. Match only an unambiguous
    // server-side default group; never accept ownership from submitted fields.
    if (!old && newWeek) {
      const matches = baseline.groups.filter(g => g.day_of_week === Number(value(p+'day')) && g.service === value(p+'service'));
      if (matches.length === 1) old = matches[0];
    }
    const soup=old && isSoupGroup(old);
    const clearedSoup=soup && baseline.kind==='week' && !!old.slots[0].content?.trim() && !value(p+'1_content').trim();
    return { id, day_of_week: soup ? old.day_of_week : Number(value(p+'day')), service: old?.service ?? value(p+'service'), label: soup ? 'Soup' : value(p+'label'),
      service_time: soup ? '' : value(p+'time'), sort: old?.sort ?? index, enabled: soup ? (baseline.kind==='week' && (form.has(p+'hide') || clearedSoup) ? 0 : 1) : form.has(p+'enabled') ? 1 : 0,
      slots: [1,2,3,4].map(position => {
        const prior = old?.slots.find(s => s.position === position);
        const splitFields = ITEM_SECTIONS.includes(baseline.id) && form.has(p+position+'_title');
        // Facebook is the canonical source (docs/facebook-specials-source-of-truth.md):
        // a weekly edit is an immediate correction that a newer verified post replaces.
        // The editor no longer offers a lock; an older form's lock field still saves.
        const lockable = baseline.kind === 'week' && !soup;
        const lockShown = lockable && form.has(p+position+'_lock_shown');
        if (prior && !form.has(p+position+'_content') && !splitFields) return {...prior};
        // Blank textarea in a defaults collection means "no recurring default".
        let content: string | null = baseline.kind === 'defaults' && !value(p+position+'_content').trim() ? null : value(p+position+'_content');
        if (splitFields) content = composeMexicanItem(value(p+position+'_title'), value(p+position+'_description'));
        // Browsers normalize textarea line endings. An untouched legacy CRLF
        // value must not become a manual correction merely because of that.
        if (prior?.content != null && content === displayedSpecial(prior).replace(/\r\n?/g,'\n') && !form.has(p+position+'_price')) {
          const section_link = form.has(p+position+'_link') ? value(p+position+'_link') : prior.section_link;
          return {...prior, section_link, ...(newWeek && section_link !== prior.section_link ? {origin: 'manual' as const, manual_locked: 1} : {}),
            ...(lockShown && prior.content.trim() ? {manual_locked: form.has(p+position+'_locked') ? 1 : 0} : {})};
        }
        if (prior?.content != null && content === prior.content.replace(/\r\n?/g,'\n')) content = prior.content;
        const price = value(p+position+'_price');
        if (content?.trim() && price) content = displayedSpecial({content,price});
        const staffLock = !content?.trim() ? 0 : lockShown ? (form.has(p+position+'_locked') ? 1 : 0) : prior?.manual_locked ?? 0;
        return { position, content, price: '', section_link: content?.trim() ? (form.has(p+position+'_link') ? value(p+position+'_link') : prior?.section_link ?? '') : '',
          origin: soup && content?.trim() ? 'manual' : newWeek || !prior ? (content?.trim() ? 'manual' : 'legacy') : prior.origin,
          manual_locked: lockable ? staffLock : soup && content?.trim() ? 1 : newWeek || !prior ? (content?.trim() ? 1 : 0) : prior.manual_locked,
          last_auto_value: prior?.last_auto_value ?? null, manual_edited_at: prior?.manual_edited_at ?? null, ...(baseline.kind === 'week' ? {staff_edited: true} : {}) };
      }) };
  });
  return { ...baseline, revision: Number(value('revision')), title: baseline.kind==='section' ? value('title') : baseline.title,
    schedule: baseline.kind==='section' ? value('schedule') : baseline.schedule, groups };
}
export function validateCollection(next: SpecialCollection, previous?: SpecialCollection): void {
  const priceFreeName = PRICE_FREE_DEFAULTS[next.id];
  // A legacy priced value left untouched can't block an unrelated save: new weeks drop
  // it when copying. Anything newly typed here is rejected.
  if (next.id === 'defaults') for (const group of next.groups) for (const slot of group.slots) {
    const old = previous?.groups.find(g => g.id === group.id)?.slots.find(s => s.position === slot.position);
    if (priceFreeWingDefault(group, slot) !== null && (!old || slotValue(old) !== slotValue(slot))) assertPriceFreeMexicanDefault(displayedSpecial(slot),'Wing Wednesday');
  }
  if (priceFreeName) {
    for (const text of [next.title,next.schedule,...next.groups.flatMap(g => [g.label,g.service_time,...g.slots.map(s => s.content ?? '')])]) assertPriceFreeMexicanDefault(text,priceFreeName);
    if (next.groups.some(g => g.slots.some(s => s.price.trim()))) throw new Error(`Recurring ${priceFreeName} defaults cannot include prices. Clear the recurring price.`);
  }
  if (!Number.isSafeInteger(next.revision) || next.revision < 0) throw new Error('Invalid saved revision.');
  if (next.title.length > 80 || next.schedule.length > 80) throw new Error('Title and schedule allow 80 characters each.');
  if (next.kind === 'section' && !next.title.trim()) throw new Error('Enter a section title.');
  const ids = new Set<string>();
  // Section items carry full poster descriptions; every other special keeps SPECIAL_LIMIT.
  const itemLimit = ITEM_SECTIONS.includes(next.id) ? MEXICAN_ITEM_LIMIT : SPECIAL_LIMIT;
  for (const group of next.groups) {
    if (ids.has(group.id)) throw new Error('Duplicate group.');
    ids.add(group.id);
    if (isSoupGroup(group)) {
      if (!(next.kind==='week' || (next.kind==='defaults' && next.id==='defaults')) || group.id!==soupGroupId(next.id,group.day_of_week)
        || group.service!=='custom' || group.label!=='Soup' || group.service_time!==''
        || group.slots.some(s=>s.price || s.section_link || (s.position!==1 && (s.content ?? '').trim()))) throw new Error('Invalid reserved Soup group.');
    } else if (group.id.startsWith('soup:')) throw new Error('Invalid reserved Soup identity.');
    if (!Number.isInteger(group.day_of_week) || (next.kind === 'section' ? group.day_of_week !== -1 : group.day_of_week < 0 || group.day_of_week > 6)) throw new Error('Invalid weekday.');
    if (!['lunch','all-day','nightly','custom'].includes(group.service) || ![0,1].includes(group.enabled)) throw new Error('Invalid group.');
    if (group.label.length > 80 || group.service_time.length > 80) throw new Error('Group labels and times allow 80 characters each.');
    if (!group.label.trim() && group.slots.some(s => (s.content ?? '').trim())) throw new Error('Enter a label for each populated group.');
    if (group.slots.length !== 4 || new Set(group.slots.map(s => s.position)).size !== 4 || group.slots.some(s => ![1,2,3,4].includes(s.position))) throw new Error('Each group must have four ordered slots.');
    for (const slot of group.slots) {
      if (slot.content === null && next.kind !== 'defaults') throw new Error('Saved slots must use an explicit blank.');
      if (displayedSpecial(slot).length > itemLimit) throw new Error(`Each special, including its price, must be ${itemLimit} characters or fewer.`);
      if (!(slot.content ?? '').trim() && (slot.price || slot.section_link)) throw new Error('A price or link requires special text.');
      if (!['','mexican-night'].includes(slot.section_link)) throw new Error('Invalid section link.');
    }
  }
  if (previous) for (const old of previous.groups) {
    const group = next.groups.find(g => g.id === old.id);
    if (!group || group.day_of_week !== old.day_of_week || group.service !== old.service) throw new Error('Existing groups cannot be removed or reassigned. Clear their slots or hide the group instead.');
  }
}

const wingNamePrice = (content: string | null | undefined) => wingPriceText(splitMexicanItem(content ?? '').title);
// Marks a price staff entered, which ends the review of that option and stays until a
// newer verified poster replaces it. A name, description or sauce edit doesn't mark one.
const wingOptionLocked = (slot: SpecialSlot, old: SpecialSlot | undefined, claiming: boolean) => {
  const price = wingNamePrice(slot.content);
  if(!price) return 0;
  if(claiming || price!==wingNamePrice(old?.content)) return 1;
  return old?.manual_locked ?? 0;
};

/** House capitalization (text-case.js) for every title, label and special staff
 * changed. An untouched value keeps its stored form, so its ownership, lock and
 * automation baseline are unaffected. Schedules, times and prices are never changed. */
export function withMenuCase(next: SpecialCollection, previous?: SpecialCollection): SpecialCollection {
  return { ...next, title: next.kind === 'section' ? normalizeChangedMenuCase(next.title, previous?.title) : next.title,
    groups: next.groups.map(group => {
      const old = previous?.groups.find(g => g.id === group.id);
      return { ...group, label: normalizeChangedMenuCase(group.label, old?.label), slots: group.slots.map(slot => {
        const prior = old?.slots.find(s => s.position === slot.position);
        return prior && prior.content === slot.content ? slot : { ...slot, content: normalizeMenuCase(slot.content) };
      }) };
    }) };
}

/** One transactional batch; every dependent write requires the same unique
 * mutation token. A failed compare-and-swap makes ALL later writes no-ops. */
export async function saveCollection(env: any, next: SpecialCollection, dates?: { start: string; end: string }): Promise<{ id: number | null; collectionId: string; groupIds: Record<string,string>; revision: number }> {
  const fresh = next.id ? await readCollection(env, next.id) : undefined;
  if (fresh && fresh.revision !== next.revision) throw new SpecialConflict();
  next = withMenuCase(next, fresh);
  validateCollection(next, fresh);
  if (next.kind === 'week') {
    if (!dates || !isIsoCalendarDate(dates.start) || !isIsoCalendarDate(dates.end) || dates.start > dates.end) throw new Error('Enter valid week dates.');
    if (!fresh && (mondayForIsoDate(dates.start) !== dates.start || standardWeekEndDate(dates.start) !== dates.end)) throw new Error('New weeks must run Monday through Sunday.');
  }
  const editable = (c: SpecialCollection) => JSON.stringify([c.title,c.schedule,c.groups.map(g => [g.id,g.day_of_week,g.service,g.label,g.service_time,g.sort,g.enabled,g.slots.map(s => [slotValue(s),c.kind==='week' && !isSoupGroup(g) ? s.manual_locked : 0])])]);
  if (fresh && editable(next)===editable(fresh)) {
    const head = next.kind==='week' ? await env.DB.prepare('SELECT week_start_date,week_end_date FROM weekly_specials WHERE id=?1').bind(next.weekly_special_id).first() : null;
    if (next.kind!=='week' || (head?.week_start_date===dates?.start && head?.week_end_date===dates?.end)) return {id:next.weekly_special_id,collectionId:next.id,groupIds:{},revision:fresh.revision};
  }
  const token = crypto.randomUUID();
  const collectionId = next.id || crypto.randomUUID();
  // Existing weekly IDs are numeric; new IDs remain safe integers without a
  // separate non-transactional INSERT or reliance on connection-local last IDs.
  const words = crypto.getRandomValues(new Uint32Array(2));
  const weekId = next.weekly_special_id ?? (next.kind==='week' ? (words[0] & 0xffff)*4294967296 + words[1] + 1 : null);
  const writes: any[] = [];
  const groupIds: Record<string,string> = {};
  const prepare = (sql: string, ...args: any[]) => env.DB.prepare(sql).bind(...args);
  let claimingWing = false;
  if (!fresh) {
    if (next.kind !== 'week') throw new Error('Unknown collection.');
    writes.push(prepare('INSERT INTO weekly_specials(id,week_start_date,week_end_date) SELECT ?1,?2,?3 WHERE NOT EXISTS(SELECT 1 FROM weekly_specials WHERE week_start_date<=?3 AND week_end_date>=?2)',weekId,dates!.start,dates!.end));
    writes.push(prepare("INSERT INTO special_collections(id,kind,weekly_special_id,revision,mutation_token) SELECT ?1,'week',?2,1,?3 WHERE EXISTS(SELECT 1 FROM weekly_specials WHERE id=?2)",collectionId,weekId,token));
  } else {
    const overlap = next.kind==='week' ? ' AND NOT EXISTS(SELECT 1 FROM weekly_specials WHERE id<>?6 AND week_start_date<=?8 AND week_end_date>=?7)' : '';
    // A Wing Wednesday save claims its week, so a later rollover for that same week
    // can't replace it. It never claims backward: a week already started stays put.
    const wingWeek = next.id === 'wing-wednesday' ? wingWeekFor(new Date(Date.now())) : null;
    const wingRow = wingWeek ? await env.DB.prepare("SELECT section_week_start FROM special_collections WHERE id='wing-wednesday'").first() : null;
    claimingWing = !!wingWeek && (!wingRow?.section_week_start || wingRow.section_week_start < wingWeek.weekStart);
    const oldOptions = fresh.groups.find(g => g.id === WING_OPTIONS_GROUP);
    const staffPriced = !!wingWeek && !!next.groups.find(g => g.id === WING_OPTIONS_GROUP)?.slots.some(s => wingOptionLocked(s,oldOptions?.slots.find(o => o.position === s.position),claimingWing));
    const sectionOwner = next.id === 'mexican-night' || staffPriced ? ",section_source='manual'"
      : !wingWeek ? '' : claimingWing ? ",section_source='recurring'" : ",section_source=CASE WHEN section_source='manual' THEN 'recurring' ELSE section_source END";
    const claimWeek = wingWeek ? ",section_week_start=CASE WHEN section_week_start IS NULL OR section_week_start<?6 THEN ?6 ELSE section_week_start END,section_service_date=CASE WHEN section_week_start IS NULL OR section_week_start<?6 THEN ?7 ELSE section_service_date END" : '';
    const sectionFields = next.kind === 'section' ? ",updated_at=CURRENT_TIMESTAMP" + sectionOwner + claimWeek : '';
    writes.push(prepare('UPDATE special_collections SET revision=revision+1,mutation_token=?1,title=?2,schedule=?3'+sectionFields+' WHERE id=?4 AND revision=?5'+overlap,
      ...[token,next.title,next.schedule,collectionId,next.revision,...(next.kind==='week' ? [weekId,dates!.start,dates!.end] : []),...(wingWeek ? [wingWeek.weekStart,wingWeek.serviceDate] : [])]));
  }
  const gate = 'EXISTS(SELECT 1 FROM special_collections WHERE id=?1 AND mutation_token=?2)';
  if (next.kind==='week') writes.push(prepare(`UPDATE weekly_specials SET week_start_date=?3,week_end_date=?4,updated_at=CURRENT_TIMESTAMP WHERE id=?5 AND ${gate}`,collectionId,token,dates!.start,dates!.end,weekId));
  const groupRows: any[][] = [];
  const slotRows: any[][] = [];
  const editedAt = new Date(Date.now()).toISOString();
  for (const group of next.groups) {
    const previous = fresh?.groups.find(g => g.id===group.id);
    const soup=isSoupGroup(group);
    const groupId = previous ? group.id : soup ? soupGroupId(collectionId,group.day_of_week) : crypto.randomUUID();
    if (!previous) groupIds[group.id] = groupId;
    const clearedSoup=soup && next.kind==='week' && !!previous?.slots[0].content?.trim() && !group.slots[0].content?.trim();
    groupRows.push([groupId,group.day_of_week,group.service,group.label,group.service_time,group.sort,clearedSoup ? 0 : group.enabled]);
    const lockable = next.kind === 'week' && !soup;
    for (const slot of group.slots) {
      const old = previous?.slots.find(s=>s.position===slot.position);
      const isPopulated = (slot.content ?? '').trim().length > 0;
      if (old && next.id === 'wing-wednesday' && group.id === WING_OPTIONS_GROUP && slot.position<=2) {
        const locked=wingOptionLocked(slot,old,claimingWing);
        const priceChanged=wingNamePrice(old.content)!==wingNamePrice(slot.content);
        if (claimingWing || slotValue(old) !== slotValue(slot) || locked!==old.manual_locked) slotRows.push([groupId,slot.position,slot.content,slot.price,slot.section_link,old.last_auto_value ?? null,
          locked,isPopulated ? 'manual' : 'legacy',priceChanged || locked!==old.manual_locked ? editedAt : old.manual_edited_at ?? null]);
        continue;
      }
      if (old && slotValue(old)===slotValue(slot)) {
        if (!lockable || !isPopulated || old.manual_locked===slot.manual_locked) continue;
        // Lock control only (from a form opened before the lock control was retired). An
        // unchanged automation value stays automation-owned. Unlocking anything else makes it
        // a staff edit that only newer posts replace. Either change without a recorded edit
        // time counts as edited now, so it never creates a lock no post can be newer than.
        const automated = old.origin==='automation' && old.content===old.last_auto_value;
        const unlockedEdit = slot.manual_locked===0 && !automated;
        slotRows.push([groupId,slot.position,slot.content,slot.price,slot.section_link,old.last_auto_value ?? null,slot.manual_locked,
          unlockedEdit ? 'manual' : old.origin,unlockedEdit || slot.manual_locked===1 ? old.manual_edited_at ?? editedAt : old.manual_edited_at ?? null]);
        continue;
      }
      // New slots retain their server-prepared ownership (including defaults); a
      // weekly slot staff typed in records its edit time. Existing changed slots are
      // staff edits. Every weekly edit, Soup included, records its time: that time,
      // not ownership, is what keeps an older Facebook post from undoing it.
      slotRows.push([groupId,slot.position,slot.content,slot.price,slot.section_link,old?.last_auto_value ?? null,
        old === undefined ? (soup && fresh && isPopulated ? 1 : slot.manual_locked) : isPopulated ? lockable ? slot.manual_locked : 1 : 0,
        old === undefined ? (soup && isPopulated ? 'manual' : slot.origin) : isPopulated ? 'manual' : 'legacy',
        old === undefined ? ((slot.staff_edited || (soup && fresh)) && isPopulated ? editedAt : null) : next.kind === 'week' ? editedAt : old.manual_edited_at ?? null]);
    }
  }
  // JSON rowsets use one SELECT and three bound parameters per statement,
  // independent of week size. Keep every write in the same gated D1 batch.
  writes.push(prepare(`INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled)
    SELECT json_extract(value,'$[0]'),?1,json_extract(value,'$[1]'),json_extract(value,'$[2]'),
      json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]'),json_extract(value,'$[6]')
    FROM json_each(?3) WHERE ${gate}
    ON CONFLICT(id) DO UPDATE SET label=excluded.label,service_time=excluded.service_time,sort=excluded.sort,enabled=excluded.enabled`,
    collectionId,token,JSON.stringify(groupRows)));
  writes.push(prepare(`INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value,manual_edited_at)
    SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),
      json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[7]'),json_extract(value,'$[6]'),json_extract(value,'$[5]'),json_extract(value,'$[8]')
    FROM json_each(?3) WHERE ${gate}
    ON CONFLICT(group_id,position) DO UPDATE SET content=excluded.content,price=excluded.price,section_link=excluded.section_link,origin=excluded.origin,manual_locked=excluded.manual_locked,manual_edited_at=excluded.manual_edited_at`,
    collectionId,token,JSON.stringify(slotRows)));
  // A claimed week owes nothing to last week's poster.
  if (claimingWing) writes.push(prepare(`UPDATE special_slots SET origin='manual',last_auto_value=NULL,manual_edited_at=NULL WHERE group_id=?3 AND ${gate}`,collectionId,token,WING_OPTIONS_GROUP));
  writes.push(prepare('SELECT id FROM special_collections WHERE id=?1 AND mutation_token=?2',collectionId,token));
  const results = await env.DB.batch(writes);
  if (!results.at(-1)?.results?.length) throw new SpecialConflict();
  return { id: weekId, collectionId, groupIds, revision:next.revision+1 };
}
