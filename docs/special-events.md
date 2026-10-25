# Special events (local implementation, not deployed)

Game-day, holiday and other one-time promotions are stored and shown separately
from the regular Lunch, All Day, Nightly and Soup specials. Base: `main` at
`b277ffa` (includes the capitalization fix). Nothing here is committed,
migrated or deployed.

## What it does

- **Public pages.** Published events from today through the next six days
  appear as one antique-gold card style above the ordinary specials: inside
  the homepage Specials card (up to three) and above the weekly sections on
  `/specials` (all). Desktop shows name, date/time and offers with prices in
  one row; 600–839 px uses two rows; under 600 px stacks. An event never
  appears inside a day's specials card. "Today" marks an active event;
  later ones say "Upcoming" with their date. No animation or team colors.
- **Expiry** is computed when a page is read: an event ends at its end time,
  otherwise at Chicago midnight after its date. Nothing is deleted on a schedule.
  Chicago wall-clock comparisons (no fixed offsets) keep daylight-saving days correct.
- **Staff administration** at `/admin/events` (desktop admin navigation, and a
  link with the review count on `/admin/specials`): create, edit, approve,
  reject (a tombstone for Facebook events), hide/publish, delete (staff events
  only), and "Allow Facebook updates" to unlock a Facebook event. Any staff
  save or decision locks the event against automation. Saves are fenced by a
  revision and a per-save token; a stale save returns 409 and keeps the draft.
  Existing session authentication and the explicit Origin check apply; all
  fields are validated server-side and all output is escaped.
- **Recent Facebook posts** on the admin page lists stored posts from the last
  seven days with printed, priced offers that no event claims. "Create event
  from this post" prefills the offers and resolved date; staff must name the
  event. The event links that post (`source_post_id`).

## Facebook automation (`SPECIAL_EVENTS_MODE`)

`workers/fb-feed/wrangler.toml` sets `SPECIAL_EVENTS_MODE = "OFF"`.

| Mode | Behavior |
|---|---|
| `OFF` (default) | Exactly the current behavior: no routing and no event writes. Proven by the full existing suites plus explicit OFF-versus-AUTO comparisons. |
| `REVIEW` | Event posters are routed out of the daily specials and stored as review items; nothing is published automatically. Staff-linked posts stop counting as regular specials. |
| `AUTO` | As REVIEW, but an event with a team or holiday printed on the poster image, complete printed prices and an unambiguous date is published. |

A missing `special_events` table behaves as OFF in the Worker, and public
pages show no events.

Routing (`workers/fb-feed/events.js`) runs after extraction on stored evidence.
There is no prompt, schema or parser-version change, and no extra AI call.

- **Printed specific cue** (team or holiday on the image heading, or on every
  offer), no regular template heading, no Soup line, no offer with lunch/night/
  all-day evidence, at most four offers: event, eligible for AUTO.
- **Printed generic cue** ("Game Day Special", "Special Event"): event, review only.
- **Specific cue only in the Facebook caption**, poster with at most two
  offers: event, review only.
- **Generic caption phrase only**: not an event (regular path unchanged).
- **Event line inside a regular poster**: regular planning unchanged; event
  created for review.
- Regular templates are never events: plural `<day>/daily/lunch/night/weekly
  specials`, Wing Night, Pizza Night, Fish Fry, Mexican Night.

Dates: a printed date, or an unambiguous printed weekday (the next occurrence
within six days of the post), or tonight/today/tomorrow; with no date words, the
verified Facebook post date. Next/last weekday, recurring weekdays, several
weekdays, a date before the post, a weekday/date mismatch or image/caption
disagreement go to review. Prices come only from printed offer evidence; a
missing, uncertain or mismatched price goes to review. Nothing is invented.

Reconciliation (`workers/fb-feed/event-store.js`) has its own D1 batches and
revisions and never touches the weekly collection fence:

- One event per Facebook post. An edited post updates its event only while the
  event is unlocked and still exactly what automation wrote.
- An identical reminder post is a duplicate: no second card.
- A different post for the same event and date with different offers fails
  closed: both go to review (a staff-locked event is never changed).
- A printed cancellation cancels exactly one matching unlocked automation
  event; a caption-only or ambiguous cancellation asks staff.
- Decisions are logged in `special_event_log`, de-duplicated across scans.

Effect on the daily publisher (`reconcileToday`): routed event sources are
removed before planning, so they no longer produce `GUARDED_AUTO_CONFLICT`
audits, the "Specials import requires attention" warning, or alert-monitor
`publication_blocked` observations. Alert inspection receives them as
`excludedSourceIds`. Every non-event condition still blocks exactly as before.

## October 23 and 25 evidence and the Packers limitation

A read-only production query (October 25) confirmed that the stored captions
for the October 23 posts (ending 400745, 040200, 372743) and the October 25
Packers post (ending 860310) are **empty**.

- **Brewers, October 23**: the poster image prints "TONIGHT'S BREWERS GAME
  SPECIAL". This printed team cue alone is sufficient. In AUTO it becomes a
  published event for October 23 ("Tonight", ends at midnight), the Friday
  Nightly specials are unchanged, and the daily conflict/warning disappears.
- **Packers, October 25**: the stored extraction has only the heading "Sunday
  Special" and "PULLED PORK SANDWICH W/ CHIPS - $4", with an empty caption.
  Nothing establishes a game-day promotion, and "Sunday Special" is also the
  regular weekend label. **It is deliberately not recognized automatically**:
  it stays on the regular path in every mode and its existing review warning
  remains, because suppressing it would hide a legitimate unresolved offer.
  Staff identify it from "Recent Facebook posts" on `/admin/events`. With
  REVIEW or AUTO enabled, that staff link also stops the post from counting
  as a regular special. With OFF, staff can still publish the event, but the
  regular warning is unchanged.

Automatic recognition of a poster like the Packers one would need actual
evidence, any of:

1. The event printed on the poster image (team name, "Game Day", holiday), as
   on the Brewers poster; or
2. A Facebook caption naming the team or holiday (this routes to review only); or
3. A future extraction field that records a printed logo or other visual event
   marker as verbatim evidence. That would be a prompt, schema and parser-version
   change with real-image evaluation, deliberately not part of this work.

No regression fixture invents a Packers caption. Rule tests that need a caption
or a printed team use clearly labelled hypothetical posters (Badgers).

## Database: migration 0025 (local only)

`migrations/0025_special_events.sql` is additive: `special_events`,
`special_event_offers`, `special_event_log`, and their indexes. Plain `CREATE`,
so an accidental replay fails loudly. `schema.sql` carries the same definitions
for new databases, and the test fixture applies 0025.

Sequencing: `wrangler d1 migrations apply` applies **all** pending migrations,
and production still has `0023_facebook_alert_incidents.sql` and
`0024_facebook_alert_evidence.sql` pending. 0025 must not be applied before
them, and tracking must not be bypassed with `d1 execute --file`. Order:

1. 0023 then 0024 under their own approval (already rehearsed).
2. A fresh `wrangler d1 export` and Time Travel bookmark (the October 25
   01:56 UTC export is stale for this).
3. Rehearse 0025 on the restored copy; confirm business-table counts and ledger.
4. Confirm `migrations list` shows exactly `0025` pending; apply under approval.

## Rollout and rollback

1. After migrations: deploy Pages (push to `main`). With an empty table nothing
   public changes; verify `/admin/events`.
2. Deploy the Worker with `SPECIAL_EVENTS_MODE=OFF` (no behavior change), then
   `REVIEW`, observing game-day posts become review items without daily warnings.
3. `AUTO` under separate approval.

Rollback: set `SPECIAL_EVENTS_MODE=OFF` (restores current routing) or roll back
the Worker version; roll back the Pages deployment. Leave the additive tables in
place; never restore the whole shared database to undo this.

## Not included

- Extraction prompt or parser changes (see the Packers section).
- An alert code for events awaiting review.
- Events running past midnight (end time must be after start time on the same day).
- Detecting deletion of an announcement posted on an earlier day (the scan
  reads only today's posts); staff control covers this.
- Skipping the extra verification AI call for advance announcements: the
  extraction loop always rereads rejected results, and changing that loop is
  outside this work.
- The mobile admin bar is unchanged; Events is reachable from the desktop
  navigation and from `/admin/specials`.

## Tests

- `workers/fb-feed/events.test.js` (20): cues, templates, all 49 weekday
  pairs, dates, review conditions, times, Brewers, empty-caption Packers,
  caption-only and generic cues, mixed posters, prices, cancellation,
  stored-row dating, daylight-saving boundaries.
- `workers/fb-feed/events-d1.test.js` (19): real SQLite pipeline in OFF (no event-table SQL at all), REVIEW
  and AUTO; Brewers publication with Friday specials unchanged; daily conflict
  and warning removed only when on; idempotent rescans with no AI calls;
  missing table; alert inspection; Packers unchanged in every mode; staff-linked
  Packers post; locks, edits, tombstones, duplicates, conflicts, manual events,
  cancellation; schema constraints.
- `tests/special-events.test.mjs` (19): Chicago expiry including daylight-saving
  days, display helpers, the visible window, missing table, compiled homepage and
  `/specials` placement and badges, homepage limit, escaping, card CSS, and admin
  authentication, Origin, validation with draft retention, locks, 409 conflicts,
  actions, deletion rules, unlocking, and Packers post linking.
- `tests/daily-soup.test.mjs` and `tests/specials-rendering.test.mjs` now find
  their shared renderer chunk by content instead of by its Vite file name.

## Included fix: Soup text contrast on /specials

`src/components/DailySoup.astro` used `color:inherit`, so on `/specials` the
Soup line took the page's dark ink on the dark-blue Today card. It now uses the
card's own special-text token, `color:var(--sg-text,inherit)`: #f0ddb8 on
#1a3d50 (about 8.6:1) on Today and denim cards, #f0e0c4 on brick (about 8.0:1)
and #1a0e06 on saddle (about 5.1:1), all WCAG AA. The homepage Specials card
already sets `--sg-text` to its cream text color, so it renders unchanged. The
label, placement and layout are untouched. Coverage: the token/contrast test in
`tests/daily-soup.test.mjs`.
