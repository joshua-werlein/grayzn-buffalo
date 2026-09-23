import { isIsoCalendarDate, mondayForIsoDate, standardWeekEndDate } from './weekly-specials';

export const SPECIAL_LIMIT = 150;
export const DAY_NUMBERS = [1, 2, 3, 4, 5, 6, 0];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export type SpecialSlot = {
  position: number; content: string | null; price: string; section_link: string;
  origin: 'legacy' | 'manual' | 'automation'; manual_locked: number; last_auto_value: string | null;
};
export type SpecialGroup = {
  id: string; day_of_week: number; service: string; label: string; service_time: string;
  sort: number; enabled: number; slots: SpecialSlot[];
};
export type SpecialCollection = {
  id: string; kind: 'week' | 'defaults' | 'section'; weekly_special_id: number | null;
  title: string; schedule: string; revision: number; groups: SpecialGroup[];
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
export const visibleGroups = (groups: SpecialGroup[], day?: number) => groups
  .filter(group => group.enabled === 1 && (day === undefined || group.day_of_week === day) && visibleSlots(group).length)
  .sort((a,b) => a.sort-b.sort);
export const slotValue = (slot: SpecialSlot) => JSON.stringify([slot.content, slot.price, slot.section_link]);
export function blankGroup(day: number, sort = 0): SpecialGroup {
  return { id: `new:${crypto.randomUUID()}`, day_of_week: day, service: 'custom', label: '', service_time: '', sort, enabled: 1,
    slots: [1,2,3,4].map(position => ({ position, content: '', price: '', section_link: '', origin: 'manual', manual_locked: 1, last_auto_value: null })) };
}
export function newWeekFromDefaults(defaults: SpecialCollection): SpecialCollection {
  return { id: '', kind: 'week', weekly_special_id: null, title: '', schedule: '', revision: 0,
    groups: defaults.groups.map(group => ({ ...group, id: `new:${crypto.randomUUID()}`,
      slots: group.slots.map(slot => ({ ...slot, content: slot.content ?? '', origin: 'manual', manual_locked: 1, last_auto_value: null })) })) };
}

// These readers intentionally have no legacy fallback. A missing migration is
// an unavailable editor, never permission to write to a second content model.
export async function readCollection(env: any, id: string): Promise<SpecialCollection> {
  const row = await env.DB.prepare('SELECT id,kind,weekly_special_id,title,schedule,revision FROM special_collections WHERE id=?1 AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)').bind(id).first();
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
export async function getWeeklySpecialsForDateRange(env: any, start: string, end: string): Promise<WeeklySpecial[]> {
  try {
    const { results } = await env.DB.prepare('SELECT id FROM weekly_specials WHERE week_start_date<=?2 AND week_end_date>=?1 ORDER BY week_start_date').bind(start,end).all();
    return await Promise.all((results ?? []).map((row: any) => readWeek(env, row.id)));
  } catch { return []; }
}
export async function getMexicanNight(env: any): Promise<SpecialCollection | null> {
  try { return await readCollection(env, 'mexican-night'); } catch { return null; }
}

/** Parse only editable values. Ownership/automatic baselines never come from a form. */
export function collectionFromForm(form: FormData, baseline: SpecialCollection): SpecialCollection {
  const value = (key: string) => String(form.get(key) ?? '').replace(/\r\n?/g,'\n');
  const count = Number(value('group_count'));
  if (!Number.isInteger(count) || count < 0 || count > 84) throw new Error('Invalid group count.');
  const groups = Array.from({ length: count }, (_, index): SpecialGroup => {
    const p = `g${index}_`, id = value(p+'id');
    const old = baseline.groups.find(g => g.id === id);
    if (!old && !/^new:[0-9a-f-]{36}$/.test(id)) throw new Error('Unknown special group.');
    return { id, day_of_week: Number(value(p+'day')), service: old?.service ?? value(p+'service'), label: value(p+'label'),
      service_time: value(p+'time'), sort: old?.sort ?? index, enabled: form.has(p+'enabled') ? 1 : 0,
      slots: [1,2,3,4].map(position => {
        const prior = old?.slots.find(s => s.position === position);
        // Unavailable default is explicit and separate from an intentional blank.
        let content: string | null = baseline.kind === 'defaults' && form.has(p+position+'_unavailable') ? null : value(p+position+'_content');
        // Browsers normalize textarea line endings. An untouched legacy CRLF
        // value must not become a manual correction merely because of that.
        if (prior?.content != null && content === prior.content.replace(/\r\n?/g,'\n')) content = prior.content;
        return { position, content, price: value(p+position+'_price'), section_link: value(p+position+'_link'),
          origin: prior?.origin ?? 'manual', manual_locked: prior?.manual_locked ?? 1, last_auto_value: prior?.last_auto_value ?? null };
      }) };
  });
  return { ...baseline, revision: Number(value('revision')), title: baseline.kind==='section' ? value('title') : baseline.title,
    schedule: baseline.kind==='section' ? value('schedule') : baseline.schedule, groups };
}
export function validateCollection(next: SpecialCollection, previous?: SpecialCollection): void {
  if (!Number.isSafeInteger(next.revision) || next.revision < 0) throw new Error('Invalid saved revision.');
  if (next.title.length > 80 || next.schedule.length > 80) throw new Error('Title and schedule allow 80 characters each.');
  if (next.kind === 'section' && !next.title.trim()) throw new Error('Enter a section title.');
  const ids = new Set<string>();
  for (const group of next.groups) {
    if (ids.has(group.id)) throw new Error('Duplicate group.');
    ids.add(group.id);
    if (!Number.isInteger(group.day_of_week) || (next.kind === 'section' ? group.day_of_week !== -1 : group.day_of_week < 0 || group.day_of_week > 6)) throw new Error('Invalid weekday.');
    if (!['lunch','all-day','nightly','custom'].includes(group.service) || ![0,1].includes(group.enabled)) throw new Error('Invalid group.');
    if (group.label.length > 80 || group.service_time.length > 80) throw new Error('Group labels and times allow 80 characters each.');
    if (!group.label.trim() && group.slots.some(s => (s.content ?? '').trim())) throw new Error('Enter a label for each populated group.');
    if (group.slots.length !== 4 || new Set(group.slots.map(s => s.position)).size !== 4 || group.slots.some(s => ![1,2,3,4].includes(s.position))) throw new Error('Each group must have four ordered slots.');
    for (const slot of group.slots) {
      if (slot.content === null && next.kind !== 'defaults') throw new Error('Saved slots must use an explicit blank.');
      if (displayedSpecial(slot).length > SPECIAL_LIMIT) throw new Error('Each special, including its price, must be 150 characters or fewer.');
      if (!(slot.content ?? '').trim() && (slot.price || slot.section_link)) throw new Error('A price or link requires special text.');
      if (!['','mexican-night'].includes(slot.section_link)) throw new Error('Invalid section link.');
    }
  }
  if (previous) for (const old of previous.groups) {
    const group = next.groups.find(g => g.id === old.id);
    if (!group || group.day_of_week !== old.day_of_week || group.service !== old.service) throw new Error('Existing groups cannot be removed or reassigned. Clear their slots or hide the group instead.');
  }
}

/** One transactional batch; every dependent write requires the same unique
 * mutation token. A failed compare-and-swap makes ALL later writes no-ops. */
export async function saveCollection(env: any, next: SpecialCollection, dates?: { start: string; end: string }): Promise<{ id: number | null; collectionId: string; groupIds: Record<string,string>; revision: number }> {
  const fresh = next.id ? await readCollection(env, next.id) : undefined;
  if (fresh && fresh.revision !== next.revision) throw new SpecialConflict();
  validateCollection(next, fresh);
  if (next.kind === 'week') {
    if (!dates || !isIsoCalendarDate(dates.start) || !isIsoCalendarDate(dates.end) || dates.start > dates.end) throw new Error('Enter valid week dates.');
    if (!fresh && (mondayForIsoDate(dates.start) !== dates.start || standardWeekEndDate(dates.start) !== dates.end)) throw new Error('New weeks must run Monday through Sunday.');
  }
  const editable = (c: SpecialCollection) => JSON.stringify([c.title,c.schedule,c.groups.map(g => [g.id,g.day_of_week,g.service,g.label,g.service_time,g.sort,g.enabled,g.slots.map(slotValue)])]);
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
  if (!fresh) {
    if (next.kind !== 'week') throw new Error('Unknown collection.');
    writes.push(prepare('INSERT INTO weekly_specials(id,week_start_date,week_end_date) SELECT ?1,?2,?3 WHERE NOT EXISTS(SELECT 1 FROM weekly_specials WHERE week_start_date<=?3 AND week_end_date>=?2)',weekId,dates!.start,dates!.end));
    writes.push(prepare("INSERT INTO special_collections(id,kind,weekly_special_id,revision,mutation_token) SELECT ?1,'week',?2,1,?3 WHERE EXISTS(SELECT 1 FROM weekly_specials WHERE id=?2)",collectionId,weekId,token));
  } else {
    const overlap = next.kind==='week' ? ' AND NOT EXISTS(SELECT 1 FROM weekly_specials WHERE id<>?6 AND week_start_date<=?8 AND week_end_date>=?7)' : '';
    writes.push(prepare('UPDATE special_collections SET revision=revision+1,mutation_token=?1,title=?2,schedule=?3 WHERE id=?4 AND revision=?5'+overlap,
      ...[token,next.title,next.schedule,collectionId,next.revision,...(next.kind==='week' ? [weekId,dates!.start,dates!.end] : [])]));
  }
  const gate = 'EXISTS(SELECT 1 FROM special_collections WHERE id=?1 AND mutation_token=?2)';
  if (next.kind==='week') writes.push(prepare(`UPDATE weekly_specials SET week_start_date=?3,week_end_date=?4,updated_at=CURRENT_TIMESTAMP WHERE id=?5 AND ${gate}`,collectionId,token,dates!.start,dates!.end,weekId));
  const groupRows: any[][] = [];
  const slotWrites: any[] = [];
  for (const group of next.groups) {
    const previous = fresh?.groups.find(g => g.id===group.id);
    const groupId = previous ? group.id : crypto.randomUUID();
    if (!previous) groupIds[group.id] = groupId;
    groupRows.push([groupId,group.day_of_week,group.service,group.label,group.service_time,group.sort,group.enabled]);
    const changedSlots: {slot: SpecialSlot; old?: SpecialSlot}[] = [];
    for (const slot of group.slots) {
      const old = previous?.slots.find(s=>s.position===slot.position);
      if (old && slotValue(old)===slotValue(slot)) continue;
      changedSlots.push({slot,old});
    }
    if (changedSlots.length) {
      const args: any[] = [collectionId,token,groupId];
      const selects = changedSlots.map(({slot,old}) => {
        const offset=args.length+1;
        args.push(slot.position,slot.content,slot.price,slot.section_link,old?.last_auto_value ?? null);
        return `SELECT ?3,?${offset},?${offset+1},?${offset+2},?${offset+3},'manual',1,?${offset+4} WHERE ${gate}`;
      });
      slotWrites.push(prepare(`INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value)
        ${selects.join(' UNION ALL ')}
        ON CONFLICT(group_id,position) DO UPDATE SET content=excluded.content,price=excluded.price,section_link=excluded.section_link,origin='manual',manual_locked=1`,...args));
    }
  }
  // Keep each statement below D1's parameter cap and avoid one query per item.
  for (let index=0;index<groupRows.length;index+=10) {
    const args: any[]=[collectionId,token];
    const selects=groupRows.slice(index,index+10).map(row=>{
      const n=args.length+1;args.push(...row);
      return `SELECT ?${n},?1,?${n+1},?${n+2},?${n+3},?${n+4},?${n+5},?${n+6} WHERE ${gate}`;
    });
    writes.push(prepare(`INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled)
      ${selects.join(' UNION ALL ')} ON CONFLICT(id) DO UPDATE SET label=excluded.label,service_time=excluded.service_time,sort=excluded.sort,enabled=excluded.enabled`,...args));
  }
  writes.push(...slotWrites);
  writes.push(prepare('SELECT id FROM special_collections WHERE id=?1 AND mutation_token=?2',collectionId,token));
  const results = await env.DB.batch(writes);
  if (!results.at(-1)?.results?.length) throw new SpecialConflict();
  return { id: weekId, collectionId, groupIds, revision:next.revision+1 };
}
