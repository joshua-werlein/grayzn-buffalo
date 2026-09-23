// Caption-based classification for specials import. Pure functions; no I/O.
// Increment PARSER_VERSION whenever these rules change so the source-version
// id changes and existing staged records are not silently reclassified.
export const PARSER_VERSION = 2;

// Day-of-week mapping: 0=Sunday … 6=Saturday
const DAY_BY_NAME = new Map([
  ['sunday', 0], ['monday', 1], ['tuesday', 2], ['wednesday', 3],
  ['thursday', 4], ['friday', 5], ['saturday', 6],
]);

/**
 * Classify a Facebook post caption into a specials import target.
 *
 * @param {string|null|undefined} caption
 * @returns {{ kind: 'week'|'section'|'ambiguous'|'ignored',
 *             day: number|null, service: 'lunch'|'nightly'|null,
 *             collectionId: string|null, reason: string }}
 *
 * kind meanings:
 *   'week'      – maps to a specific week collection; day and/or service known
 *   'section'   – maps to a named section (e.g. 'mexican-night')
 *   'ambiguous' – day identified but service unknown; stage for manual review
 *   'ignored'   – no actionable pattern; skip AI and D1 staging
 *
 * Rules (evaluated in order; first match wins):
 *   1. empty / non-string caption                          → ignored
 *   2. contains "Mexican Night"                            → section:mexican-night
 *   3. contains "Weekly" + "Lunch"                        → week, day=null, lunch
 *   4. contains "Weekly" + "Night"/"Nightly"              → week, day=null, nightly
 *   5. contains [Day] + "Lunch"                           → week, day, lunch
 *   6. contains [Day] + "Night"/"Nightly"                 → week, day, nightly
 *   7. contains [Day] + "Special(s)"                      → ambiguous, day
 *   8. everything else                                     → ignored
 *
 * Post creation time is NOT used to infer a missing day or week.
 */
export function classifyCaption(caption) {
  if (typeof caption !== 'string' || !caption.trim()) {
    return { kind: 'ignored', day: null, service: null, collectionId: null,
      reason: 'empty or non-string caption' };
  }

  const text = caption.trim();

  // Rule 1 (checked above)

  // Rule 2: Mexican Night
  if (/\bmexican\s+night\b/i.test(text)) {
    return { kind: 'section', day: -1, service: null, collectionId: 'mexican-night',
      reason: 'Mexican Night phrase detected' };
  }

  // Rules 3-4: Weekly patterns (no specific day)
  const hasWeekly = /\bweekly\b/i.test(text);
  if (hasWeekly) {
    if (/\blunch\b/i.test(text)) {
      return { kind: 'week', day: null, service: 'lunch', collectionId: null,
        reason: 'Weekly Lunch pattern' };
    }
    if (/\b(?:night|nightly)\b/i.test(text)) {
      return { kind: 'week', day: null, service: 'nightly', collectionId: null,
        reason: 'Weekly Nightly pattern' };
    }
  }

  // Rules 5-7: Day-specific patterns
  for (const [name, day] of DAY_BY_NAME) {
    if (!new RegExp(`\\b${name}\\b`, 'i').test(text)) continue;
    // First matching day name wins. Multiple days in one post are unusual
    // and better handled by the 'ambiguous' path than by silently picking one.
    if (/\blunch\b/i.test(text)) {
      return { kind: 'week', day, service: 'lunch', collectionId: null,
        reason: `${cap(name)} Lunch pattern` };
    }
    if (/\b(?:night|nightly)\b/i.test(text)) {
      return { kind: 'week', day, service: 'nightly', collectionId: null,
        reason: `${cap(name)} Nightly pattern` };
    }
    if (/\bspecials?\b/i.test(text)) {
      return { kind: 'ambiguous', day, service: null, collectionId: null,
        reason: `${cap(name)} Specials — service not specified` };
    }
    // Day name present but no recognizable service or specials keyword.
    // Fall through and try the next day name (shouldn't happen in practice
    // since a post typically mentions only one day).
  }

  return { kind: 'ignored', day: null, service: null, collectionId: null,
    reason: 'no matching specials pattern' };
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
