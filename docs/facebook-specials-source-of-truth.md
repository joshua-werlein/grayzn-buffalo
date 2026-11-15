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
| Legacy staff lock with **no** recorded edit time | Replaced by verified evidence after the edit-time migration | Kept against pre-migration evidence |

"Published" is the verified Facebook time from `verifiedPostTimes()` in
`workers/fb-feed/graph.js`: the post's creation time, or its updated time
only when the stored image or caption actually changed (an edited poster). A
comment that bumps Facebook's `updated_time` proves nothing. Import processing
time never counts. A change to Facebook's update time triggers an image comparison
when the caption is unchanged. Matching bytes reuse the existing import and its
validation, review state and retry history.

When the website already shows exactly the Facebook value, nothing is written and
nothing is reported, whoever owns the slot.

Every staff save of a weekly special (including Soup) records `manual_edited_at`.
Staff approval records it too, and so does a lock-only save submitted by an editor
page opened before the lock control was retired. A value without a recorded edit
time (default, legacy, automation drift) is not a correction made after the post, so
a verified post replaces it.

A populated pre-timestamp staff lock has an unknown edit time. Automation uses
the verified production application time of migration 0026, November 5, 2026 at
07:19:50 UTC, as its upper bound. A later verified poster can replace the lock.
The November 14 production check found zero such locks in the current week.

### Where it is implemented

- Daily specials and Soup: `reconcileToday` compares publication and staff-edit
  times. The same D1 batch records the latest verified publication time per
  destination in `settings.facebook_daily_post_times` so an older scan cannot
  restore superseded specials. Only the current Chicago day's map is used.
  For a previously published slot with no entry, the saved week's last update
  provides a conservative upper bound on the prior publication. A post must be
  verifiably later than that bound to replace the value. If the bound is unavailable,
  automation retains the saved value.
- Weekly lunch: `applyWeeklyLunch()` in the same file. Facebook-vs-Facebook
  precedence is unchanged there: a same-day daily poster outranks a weekly
  poster, and a weekly value from another current weekly poster is replaced only
  by one verified as newer.
- Mexican Night: `applyMexicanNight()`. A staff-saved or staff-approved menu
  (`section_source='manual'` or staff-edited slots) is replaced by a Mexican Night
  post published after the collection's last staff save (`updated_at`). Each post
  is still applied at most once, so the same post never undoes a later staff edit.
- Wing Wednesday applies the same ordering to recorded staff price edits
  and prior poster decisions.
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

A newer verified poster that matches a single existing event can update its offers
and other printed fields on the same card. A staff edit protects the card against
unchanged or older posts. A staff removal and an explicit cancellation retain their
existing lifecycle rules.
