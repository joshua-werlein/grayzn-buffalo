# Facebook is the canonical source for specials

**Policy (owner, November 12, 2026):**

> Grayz'n Buffalo Facebook posts and images are the canonical source for specials.
> Correctly verified new Facebook evidence updates the corresponding website
> specials, regardless of previous automatic values, recurring defaults, staff
> edits, staff locks, or approvals. Website edits are immediate corrections, not
> permanent barriers to newer Facebook content. The same unchanged Facebook source
> must not repeatedly overwrite a subsequent correction. Meal accuracy,
> date/service validation, nightly duplication rules, and database concurrency
> safeguards remain mandatory.

Future maintenance must not reintroduce "staff-owned" or "locked" website values
that block newer verified Facebook content. If a change seems to need one, it
needs the owner's approval first.

## The one ownership rule

A destination's previous value never decides whether verified Facebook content
may replace it. Only *time* does:

| Previous website value | Verified Facebook post published **after** it | The same unchanged post (published **before** it) |
|---|---|---|
| Blank | Replaced | Replaced |
| Automation value | Replaced | Replaced (or no change when equal) |
| Recurring default (new week from defaults) | Replaced | Replaced |
| Legacy value of unknown origin | Replaced | Replaced |
| Separate price or section link | Replaced; the old separate price and link are cleared with it | Replaced |
| Staff edit (`manual_edited_at` recorded) | Replaced | **Kept** — reason `Newer staff edit retained` |
| Staff lock (`manual_locked=1`) with an edit time | Replaced | **Kept** when the edit time is after the post |
| Staff approval of an import | Replaced | **Kept** — the approval records its time |
| Legacy staff lock with **no** recorded edit time | Kept (see below) | Kept |

"Published" is the verified Facebook time from `verifiedPostTimes()` in
`workers/fb-feed/guarded-auto.js`: the post's creation time, or its updated time
only when the stored image or caption actually changed (an edited poster). A
comment that bumps Facebook's `updated_time` proves nothing. Import processing
time never counts.

When the website already shows exactly the Facebook value, nothing is written and
nothing is reported, whoever owns the slot.

Every staff save of a weekly special (including Soup) records `manual_edited_at`.
Staff approval records it too, and so does a lock-only save submitted by an editor
page opened before the lock control was retired. A value without a recorded edit
time (default, legacy, automation drift) is not a correction made after the post, so
a verified post replaces it.

**One narrow legacy exception:** a non-blank staff lock saved before edit times were
recorded (`manual_locked=1`, `manual_edited_at IS NULL`, for example the November 4
lunch correction) has an unknown edit time. No post can be shown to be newer than it,
and replacing it could let the same old post undo a correction. Automation keeps it
and reports `Newer staff edit retained` (informational). The editor can no longer
create such a slot. A read-only production check on November 12, 2026 found **none**
in the current week (week of 2026-11-09), so the exception affects no live specials;
it disappears as weeks roll over.

### Where it is implemented

- Daily specials and Soup: `facebookMayReplace()` in `workers/fb-feed/guarded-auto.js`
  (`reconcileToday`).
- Weekly lunch: `applyWeeklyLunch()` in the same file. Facebook-vs-Facebook
  precedence is unchanged there: a same-day daily poster outranks a weekly
  poster, and a weekly value from another current weekly poster is replaced only
  by one verified as newer.
- Mexican Night: `applyMexicanNight()`. A staff-saved or staff-approved menu
  (`section_source='manual'` or staff-edited slots) is replaced by a Mexican Night
  post published after the collection's last staff save (`updated_at`). Each post
  is still applied at most once, so the same post never undoes a later staff edit.
- Wing Wednesday already worked this way: a verified poster's price replaces any
  earlier price, staff-entered included.
- Staff editor: `src/lib/specials-store.ts` records the edit time; the editor no
  longer offers a "keep even when Facebook posts something newer" lock.

## What remains mandatory (safety, not ownership)

These are unchanged and must stay:

- Facebook Page and post verification, image/caption hashing and source versions.
- Chicago date and weekday validation; service (Lunch, All Day, Nightly, Weekly
  Lunch, Mexican Night, Special Events) routing.
- Meal-fact comparison against the verbatim printed evidence
  (`normalizeEvidenceOffer()` in `workers/fb-feed/evidence.js`): dishes, sides,
  choices, quantities, connectors and prices must match. Only presentation —
  capitalization, spacing, punctuation, and a leading list marker such as `1)`,
  `*1)` or `•2.` — is ignored.
- Ambiguous or uncertain readings are withheld and alerted; nothing is invented
  and no previous website value is ever treated as Facebook evidence.
- The nightly-poster rule: a night poster that repeats the two All Day specials
  does not duplicate them or publish them as Nightly (`houseLayout()`/`sameOffer()`
  in `evidence.js`).
- Duplicate-post and newer-version handling, revision compare-and-swap claims,
  full snapshot fences and single D1 batches.
- Administrative authentication and authorization.
- Delivery notices.

Structural holds also remain: a disabled or missing destination, or extra filled
slots beyond a service's capacity, still hold publication and are reported.

## Special events

Special events are keyed to their own Facebook post. A newer post creates its own
event, so staff edits to an earlier post's event never block it. A staff edit to an
event keeps that event's values for that same post (see `docs/special-events.md`).
