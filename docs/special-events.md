# Special events (automatic publishing)

Game-day, holiday and other one-time promotions are published automatically
from Facebook and shown separately from the regular Lunch, All Day, Nightly and
Soup specials. Nobody approves events. Staff can only correct (Edit) or take
down (Remove) an event, in the Special Events section of `/admin/specials`.
Base: `main` at `5abd91f`. Migration 0025 is already applied in production;
this work needs no new migration.

## What it does

- **Public pages.** Every published event that has not expired, today and
  upcoming (shown before its date), earliest first, as one antique-gold card
  style above the ordinary specials: inside the homepage Specials card (up to
  three) and above the weekly sections on `/specials` (all). Desktop shows name,
  date/time and offers with prices in one row; 600–839 px uses two rows; under
  600 px stacks. "Today" marks an active event; later ones say "Upcoming".
- **Expiry** is computed when a page is read (America/Chicago wall clock, so
  daylight-saving days are correct): an event ends at its verified end time,
  otherwise at the start of the next Chicago calendar day. Expired events
  disappear from the homepage, `/specials` and the admin list automatically.
  Rows stay internally for audit and duplicate prevention; nothing is deleted.
- **Administration** is the fourth collapsible section of `/admin/specials`,
  after Recurring Defaults, Recurring Mexican Night Defaults and This Week's
  Mexican Night, with the same white container and cream heading, collapsed by
  default. It lists exactly what the public sees (current and upcoming published
  events, earliest first). Each entry shows name, date, time, offers and prices
  with two controls:
  - **Edit** opens a form for name, date, start/end time, time label and up to
    four offers with prices. Saving locks the event: later Facebook changes never
    overwrite it.
  - **Remove** asks for confirmation, then hides the event everywhere. The row
    stays as a locked tombstone with its Facebook post id, so rescans or edits of
    that post never recreate it, and its poster never falls back into the daily
    specials.

  Each control is its own form (no nesting with the Specials editors). Session
  authentication, the explicit Origin check, server-side validation and a
  per-event revision (stale saves return 409 and keep the typed draft) apply.
  `/admin/events` is retired: it redirects signed-in staff to
  `/admin/specials#special-events` and others to sign-in. There is no Events
  navigation item, review queue, approve/reject/hide control, manual creation
  form, recent-posts list or expired list.

## Facebook automation (`SPECIAL_EVENTS_MODE`)

| Value | Behavior |
|---|---|
| `AUTO` | Normal workflow. Event posters are routed out of the daily specials and published automatically when the evidence is sufficient. |
| `OFF` (anything else, including the retired `REVIEW`) | Emergency switch: no routing and no event-table SQL at all. |

`workers/fb-feed/wrangler.toml` sets `"AUTO"` for the owner-authorized release,
with Resend EMAIL alerts. A missing `special_events` table behaves as OFF.

### Recognition (`workers/fb-feed/events.js`, stored evidence)

- **Cues.** Teams by name or printed cheer (Packers / "Go Pack" / "Let's Go
  Pack" / "Pack Attack"; Brewers / "Brew Crew"; Badgers / "On Wisconsin"; Bucks
  / "Fear the Deer", never an amount such as "5 bucks"; Vikings / "Skol";
  Bears), holidays, and generic phrases ("Game Day", "Special Event",
  "Fundraiser", "Benefit").
- **Whole-poster event:** a cue printed on the poster heading (or on every
  offer), at most four offers, no regular template, no Soup line, no offer with
  lunch/night/all-day evidence. Or a team/holiday named in the Facebook caption
  for a poster with one or two offers. A generic caption phrase alone never
  reroutes anything; a plain "Sunday Special" poster with no cue stays regular.
- **Regular specials are never events:** plural day/daily/lunch/night/weekly
  specials headings, Wing Night, Pizza Night, Fish Fry, Friday Fish, Mexican
  Night, Taco Tuesday, Soup lines, delivery/weekly-lunch/Mexican Night shapes.
- **Mixed poster** (event wording inside a regular poster): the regular
  specials publish unchanged; no event is created; one log entry.
- **Title:** the printed heading when it names the event (e.g. "Brewers Game
  Special"); otherwise "<Team> Game Day Special", "<Holiday> Special", "Game Day
  Special" or "Special Event". Nothing else is invented.
- **Date:** a printed date, an unambiguous printed weekday (next occurrence),
  or tonight/today/tomorrow; with no date words, the verified post date.
- **Offers and prices** come only from printed offer evidence (up to four).

### Insufficient or contradictory evidence

Missing, uncertain or mismatched prices, more than four offers, relative or
contradictory dates (next/last weekday, recurring weekdays, image/caption
disagreement, a date before the post) **withhold** the event. It is stored with
status `review` and a `Withheld: …` reason, never shown publicly or in the
admin, and is not an approval task. Staff see nothing to act on, and one
`console.warn('Special event withheld', {reasonCount})` is emitted. A
corrected Facebook post publishes it automatically. The poster still stays out
of the daily specials, so it never produces a misleading daily-specials
failure alert.

### Reconciliation (`workers/fb-feed/event-store.js`)

Own D1 batches and per-event revisions; the weekly collection fence is never
touched.

- One event per Facebook post. An edited post updates its event while the event
  is still exactly what automation wrote; a staff-edited, removed or cancelled
  event is never changed (logged `protected`).
- A post that no longer shows an event withdraws the automation event it created
  (unless staff edited it).
- Another post with the same offers on the same date is a duplicate; another
  post for the same event and date with different offers is logged as a
  conflict. Neither creates a second card; the first event stays.
- **Removal and replacement safety:** identical and differing reposts of a
  removed event stay blocked. The same original Facebook post stays blocked
  through reprocessing and edits, including when staff corrected the event's
  date before removing it. Duplicate/tombstone checks also run atomically in
  the insert statement, so concurrent posts and a newly arrived tombstone
  cannot create a second card. The original automation date remains part of
  matching after a staff date edit.
  Legacy removals created by the retired manual workflow may have no event
  identity. Without enough identity to distinguish a repost, these conservatively
  block all new automatic event cards on the tombstone's known date. They do not
  block other dates; no identity is invented or backfilled from ambiguous text.
- A printed cancellation cancels exactly one matching unlocked automation event;
  a caption-only or ambiguous cancellation is logged only (staff can Remove).
- Decisions are logged once in `special_event_log`.

### Verified deletion versus inaccessible content

**Automatic publication of a replacement after deletion is not implemented.**
The current Graph GET can establish that the exact original post is readable
(`exists`); failures are `unknown`. Code 100/subcode 33 is ambiguous: absent
objects, permissions and unsupported operations share it. A successful Page
scan, two identical errors thirty minutes apart, a 404, or aging out of the
limited current-day feed does not resolve that ambiguity. No such response
releases a removal tombstone. Legacy `source_missing_at`/`source_deleted_at`
fields from the unfinished two-error implementation are not trusted or changed.

The current webhook verifies signatures but queues only a general rescan; it
does not persist authenticated, per-post deletion evidence. No supported,
positive deletion authority has been validated or integrated in this change.
Meta's documentation endpoints returned HTTP 429 during this review, so this is
not a claim that no future supported mechanism exists. Adding one would require
separate specification, identity/order/replay validation and tests. Until then,
even a genuinely deleted original cannot automatically release the same-event
replacement. Removal is preserved; do not manually delete tombstones or infer
deletion from Graph errors to work around it.

Effect on the daily publisher and alerts: routed event sources (and posts whose
event staff edited or removed) are removed before daily planning, so they never
produce `GUARDED_AUTO_CONFLICT`, "Specials import requires attention", or a
`publication_blocked` alert observation. Genuine import, publication and
delivery failures are still detected (`events-alerts.test.js`). Do not set
events to OFF while alerts send email: event posters would then alert as daily
specials.

## October 23 and 25 evidence

- **Brewers, October 23**: the poster prints "TONIGHT'S BREWERS GAME SPECIAL".
  It publishes automatically for October 23 ("Tonight", until midnight); the
  Friday Nightly specials are unchanged.
- **Packers, October 25**: the stored caption is empty and the stored
  extraction kept only the "Sunday Special" ribbon and "PULLED PORK SANDWICH W/
  CHIPS - $4". The original image (read-only R2 check) also prints a large
  **"LET'S GO PACK!"** headline that the extraction dropped. Two changes follow
  from that evidence:
  1. "Go Pack" / "Let's Go Pack" are now Packers cues.
  2. The contract-2 extraction prompt now asks for large promotional banners or
     headlines to be copied verbatim into `poster_evidence` (no schema or
     parser-version change). A real-image evaluation remains outstanding; the
     owner authorized this release with validation against future actual posts.

  With the headline captured, such a poster publishes "LET'S GO PACK! Sunday
  Special" automatically and no longer blocks Sunday. The already stored
  October 25 extraction has no cue, so it stays a regular special (and its one
  `publication_blocked` alert remains legitimate). A plain "Sunday Special"
  poster is never treated as a Packers event.

## Database

Migration 0025 (already applied) is unchanged. The new code writes only the
statuses `published`, `review` (withheld), `rejected` (removed) and `cancelled`,
and the log actions `created`, `updated`, `duplicate`, `protected`, `conflict`,
`cancelled` and `cancellation-review`, all allowed by the existing CHECK
constraints. Compiled-route and pipeline tests use local production-schema
fixtures; a separate Miniflare test executes event reconciliation against
unchanged 0025 in local D1, including concurrent inserts and retained legacy
tombstones. This continuation did not access or mutate the production database.

## Rollout and rollback

1. Build and release Pages from the reviewed `main` commit: the admin section
   and `/admin/events` redirect. Verify the production deployment succeeds.
2. Dry-run and deploy the Worker with events and alerts OFF; verify the release.
3. Deploy the same Worker with `SPECIAL_EVENTS_MODE=AUTO`,
   `SPECIALS_ALERT_PROVIDER=RESEND`, `SPECIALS_ALERT_MODE=EMAIL`,
   `SPECIALS_ALERT_EMAIL_APPROVED=true` and the approved sender, preserving the
   existing recipient/API-key secrets and automation settings. Verify live
   configuration and 100% traffic before reporting activation.

Rollback: deploy with `SPECIAL_EVENTS_MODE=OFF` or roll back the Worker
version; roll back the Pages deployment. Leave the tables in place.

The owner explicitly authorized commit, push, Pages/Worker release and final
AUTO/EMAIL activation after local validation, accepting the conservative
replacement limitation and deferring real-image evaluation to actual posts.
Keep the Resend integration and all existing Facebook fixes. If alerts are
already emailing, disable their dispatch before turning event routing OFF to
avoid reclassifying event posters as daily failures. If email activation fails,
revert alert mode to OFF. Independent dead-man monitoring remains future work.

## Tests

- `workers/fb-feed/events.test.js`: cues and cheers, templates, weekday pairs,
  dates, withholding conditions, times, Brewers, stored and banner Packers,
  caption cues, generic cues, upcoming events, regular specials never events,
  mixed posters, prices, cancellation, stored-row dating, daylight saving.
- `workers/fb-feed/events-d1.test.js`: real SQLite pipeline in OFF (no event
  SQL), retired REVIEW (= OFF) and AUTO; Brewers publication; idempotent
  rescans; missing table; alert inspection; Packers stored and banner; removal
  tombstones keep posters out of daily specials; edits; staff locks;
  duplicates; differing reposts; withheld and withdrawn events; cancellation;
  schema.
- `workers/fb-feed/events-alerts.test.js`: events and failure alerts together.
- `tests/special-events.test.mjs`: Chicago expiry and daylight saving, display,
  visibility, page placement, escaping, card CSS, the retired route, navigation,
  accordion order and default state, no nested forms, listing and sorting,
  Edit/Remove, authentication, Origin, validation, 409 conflicts, accessibility.

## Soup text contrast on /specials

`src/components/DailySoup.astro` uses the card's special-text token,
`color:var(--sg-text,inherit)`, so the Soup line is light on the dark-blue
Today card (WCAG AA on every card). Unchanged by this work.

## Local completion validation — October 25, 2026

Using the existing portable Node 24.22.1, the final Worker suite passed
1,313 tests and the full website suite passed 186 tests, with no failures or
skips. Production build passed; Astro check reported zero errors, zero warnings
and six hints. Local Miniflare D1 exercised unchanged migration 0025, concurrent
publication and retained removal tombstones. The final Wrangler deployment
dry run passed with events OFF (271.96 KiB, 67.17 KiB gzip). No deployment,
production writes, emails or live AI calls were performed.

The compiled admin preview was checked at desktop and mobile widths: four
accordions in the required order, Edit/Remove only, no horizontal overflow,
and an edit form that fits the mobile viewport. Authentication and mutation
behavior are covered separately by compiled-route tests. Complete local logs,
the exact file list and original review instructions are in the ignored
`.wrangler/events-completion-report.md`. The later owner authorization above
supersedes that report's original deployment hold; live release results must be
verified separately.
