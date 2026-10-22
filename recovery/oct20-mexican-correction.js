// Prepared only. Calling this with a production binding requires separate approval.
// D1 batch is atomic. Exact snapshot + ownership checks make stale/repeated calls no-ops.
import {protectedMexicanSlots} from '../workers/fb-feed/mexican-night-defaults.js';
export async function correctOctober20MexicanNight(DB) {
  const token=crypto.randomUUID();
  const old='Taco Salad ... $9.00 | $8.50 | $6.00\nMeat, shredded cheese, lettuce, onion, tomato, and black olives served in a shell bowl';
  const corrected=old.replace('$9.00 | $8.50 | $6.00','Large $9.00 | Small $8.50 | Mini $6.00');
  const gate="EXISTS(SELECT 1 FROM special_collections WHERE id='mexican-night' AND mutation_token=?1)";
  const results=await DB.batch([
    DB.prepare(`UPDATE special_collections SET title='Mexican Night',schedule='Every Tuesday • 5–10 PM',
      section_source='manual',revision=revision+1,mutation_token=?1
      WHERE id='mexican-night' AND revision=11 AND section_week_start='2026-10-19' AND section_source='facebook'
      AND title=?2 AND schedule='Every Tuesday Night 5-10pm' AND NOT ${protectedMexicanSlots}
      AND EXISTS(SELECT 1 FROM special_slots WHERE group_id='mn:bd5bead4:1' AND position=2
        AND content=?3 AND last_auto_value=?3 AND origin='automation' AND manual_locked=0 AND price='')`)
      .bind(token,"TONIGHT @ GRAYZ'N BUFFALO 5-10PM! Mexican Night Every Tuesday Night 5-10pm",old),
    DB.prepare(`UPDATE special_slots SET content=?2,origin='manual',manual_locked=1
      WHERE group_id='mn:bd5bead4:1' AND position=2 AND ${gate}`).bind(token,corrected),
    DB.prepare(`INSERT INTO special_import_events(import_id,event_type,detail)
      SELECT 'bd5bead40405e72a00840a216584e429','review','STAFF_CORRECTION: October 20 poster verified; restored Taco Salad size labels and canonical heading; original evidence retained'
      WHERE ${gate}`).bind(token),
    DB.prepare(`SELECT id,revision,title,schedule,section_source FROM special_collections WHERE id='mexican-night' AND mutation_token=?1`).bind(token),
  ]);
  return results.at(-1)?.results ?? [];
}
