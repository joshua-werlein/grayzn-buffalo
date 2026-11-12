# November 11 2026: Veterans Day special held as an unidentified daily item

Local change only. Nothing here has been committed, deployed or applied to production.

## What happened

- 8:03 AM Chicago: post `583672228384067_1764187355249141` (import
  `29fa68804c48f6eb7a6db890a59fd721`, parser 19, staged/ok) printed
  **Veterans Day Special**, "Choice of any burger and side with a drink $7.00",
  and no hours.
- 8:35 AM: post `583672228384067_1764217808579429` (import
  `054fb8ad17abd13fe569ba6914679c8d`) printed Wednesday's regular specials. Lunch 1,
  All Day 1 and All Day 2 published normally.
- Production `special_events` had no row for 2026-11-11.

## Root cause

**Classification.** The holiday list in `workers/fb-feed/events.js` had no
Veterans Day. `eventCue("VETERANS DAY SPECIAL")` returned `null`, so
`routeEventSource` sent the poster down the regular route. The daily planner
then found one priced offer with no service evidence and no house layout to
place it, so it held the offer as **Unidentified service**. That matches the
alert: one held item, no staff lock, no retry. Because the event reconciler
never saw an event route, no `special_events` row was written. That is
consistent with the empty production query.

**A review gap made it worse.** Automation Review's approval only offers
daily destinations (Lunch, All Day, Nightly, Soup). Staff had no way to
publish the correctly read offer as an event, and the daily alert could not
point them anywhere better.

Ruled out from the evidence: reconciliation (no event route ever reached it),
a mode mismatch (`SPECIAL_EVENTS_MODE = "AUTO"`, and the three regular specials
published), and missing evidence (the offer was read and validated). One thing
is still unconfirmed: whether the stored `poster_evidence` holds the heading
verbatim. Read-only check 1 below confirms it.

## Fix

- `events.js`: Veterans Day is a recognized holiday (`Veterans`, `Veteran's`
  and `Veterans'`). It is a fixed-date holiday, so an undated poster resolving
  to any date other than November 11 is held, never re-dated. A window that
  crosses midnight, or two printed windows that disagree, now holds the event
  instead of producing an all-day card. A holiday named only in the caption
  reroutes a small poster only when the caption calls it a special, deal or
  offer; "Happy Veterans Day!" alone does not.
- `extraction.js`: the contract-2 prompt names holiday/event headings as
  banners to copy into `poster_evidence`. The parser version is unchanged.
- Admin Specials: **Add Special Event** (name, date, All Day or Specific Hours,
  up to four offers, optional *Show on website starting* date). Staff events are
  locked and identity-matched, so a later Facebook post for the same event logs
  a conflict instead of publishing a duplicate. A repeated submit is idempotent.
- Automation Review: a held daily post offers **Publish as a Special Event**,
  prefilled from the reading. The event is linked to the post, which keeps the
  poster out of the daily specials. It also takes over an event automation
  withheld for that post.
- Public cards: a timed event shows **Later Today** before its start (never
  **Today**). Staff all-day events show **All day**.
- Alerts: a recognized but withheld event raises its own `event` /
  `special_event_held` email ("(Special Event)"), separate from daily specials.
  The daily Unidentified-service text points to Publish as a Special Event.

## Migration

`migrations/0028_special_event_display.sql`: one nullable column,
`special_events.display_from`. It is additive. The site works without it: until
it is applied, the display-date control is hidden and everything else works.

## Read-only production checks (owner)

```powershell
# 1. Stored evidence for the Veterans Day reading (confirms poster_evidence and caption)
npx wrangler d1 execute grayzn-db --remote --command "SELECT id,substr(caption,1,300) caption,json_extract(candidate_json,'$.poster_evidence') poster,json_extract(candidate_json,'$.day_evidence') day,json_array_length(json_extract(candidate_json,'$.offers')) offers,substr(json_extract(candidate_json,'$.offers[0]'),1,600) offer1 FROM special_imports WHERE id='29fa68804c48f6eb7a6db890a59fd721';"
# 2. Event decisions logged for either post (expect none: the regular route logs nothing)
npx wrangler d1 execute grayzn-db --remote --command "SELECT id,event_id,source_post_id,action,substr(detail,1,200) detail,occurred_at FROM special_event_log WHERE source_post_id IN ('583672228384067_1764187355249141','583672228384067_1764217808579429') ORDER BY id LIMIT 20;"
# 3. Daily hold audit for the Veterans Day import
npx wrangler d1 execute grayzn-db --remote --command "SELECT id,event_type,substr(detail,1,400) detail,occurred_at FROM special_import_events WHERE import_id='29fa68804c48f6eb7a6db890a59fd721' ORDER BY id DESC LIMIT 8;"
# 4. Before applying 0028: confirm the column does not exist yet
npx wrangler d1 execute grayzn-db --remote --command "SELECT name FROM pragma_table_info('special_events') WHERE name='display_from';"
```

## Deployment (after review and commit)

1. Back up D1: `npx wrangler d1 export grayzn-db --remote --output backups/grayzn-db-pre-0028.sql`.
2. Run check 4, then apply 0028:
   `npx wrangler d1 execute grayzn-db --remote --file migrations/0028_special_event_display.sql`.
   Old Worker and site code ignore the new column.
3. Deploy the Worker: `cd workers/fb-feed && npx wrangler deploy`.
4. Build and deploy the website the usual way.
5. Verify: Admin Specials shows Add Special Event, and Automation Review loads.

Rollback: redeploy the previous Worker and site versions. The column can stay
(it is nullable and unused by old code). Staff events created meanwhile remain
valid rows for the old code (origin `manual`, locked). Emergency switch without
a deploy: set `SPECIAL_EVENTS_MODE` to `OFF` (routes nothing; staff events stay
visible).

## Recovering November 11

Do **not** replay the imports. Wednesday's specials are correct, and a replay
would only re-run the same routing. After the site is deployed, staff can
publish it in Automation Review (Publish as a Special Event, today only) or Add
Special Event. If the Worker is deployed first, the next scan the same day
routes the stored reading as a Veterans Day event and publishes it
automatically, provided check 1 shows the heading in `poster_evidence`. After
November 11 it would expire immediately anyway, so recovery only matters that
day.

## Follow-up: event entry, text case, event message and layout (after `6e28b53`)

Local change only; nothing committed, deployed or written to production.

### Causes

- **ALL CAPS on the live card.** `normalizeMenuCase()` (`src/lib/text-case.js`)
  runs inside `canonicalizeSlotContent()` (`workers/fb-feed/reconcile.js`), which
  every automated path uses: daily slots, `buildEventDraft()` for event offers and
  titles, and the Automation Review prefill. Staff saves of daily specials
  normalize in `saveCollection()` (`specials-store.ts`). The Special Event form
  (`eventInputFromForm()` in `src/lib/special-events.ts`) stored exactly what was
  typed, so it was the only path that skipped normalization. An automated event
  cannot store "CHOICE OF ANY BURGER…" in capitals, so the live row was entered
  through the staff form (check 5 below confirms it).
- **"THANK YOU TO ALL WHO SERVED" as an offer.** The form offered four "Offers"
  inputs and no place for wording that is not a priced special. The schema
  already had `special_events.details` (0025, ≤300 characters, rendered on public
  cards), but no form wrote it. On the automated side, an unpriced greeting is
  a "Missing meal price" issue that withholds the whole event.
- **Wednesday poster offered "Publish as a Special Event".** The option was
  shown for any daily post needing attention. Both November 11 posts share one
  `GUARDED_AUTO` audit row ("3 slot(s); CONFLICT: 1 blocked proposal"), so the
  regular poster also read as *Partially Published* and got an event form
  prefilled with its three regular specials.
- **Whitespace around the event card.** `Base.astro` applies
  `section{padding:var(--section-block) var(--section-inline)}` to every section.
  `<section class="event-specials">` inherited it, adding large vertical
  padding and narrowing the card. `.week-section` already opts out with
  `padding:0`.

### Changes

- Form: one **Special and Price** field, **Add Another Special** (up to four),
  **Remove** on added fields, and an optional **Event Message** (stored in
  `details`; no migration). Without JavaScript all four fields show. Server
  validation normalizes title, specials, message and time note with
  `normalizeMenuCase()` (idempotent; re-saving never changes them again). It
  refuses a special with no price ("…is a message, not a special. Move it to
  Event Message."), a price in the message, and the same special twice.
- Automation: `isEventMessage()` (`events.js`) moves unpriced greetings and house
  conditions ("Thank you…", "Happy…", "Dine-in only", "With valid military ID")
  into the event message, and only those. Any other unpriced line still holds the
  event. Facebook evidence, including the message line, is kept verbatim in
  `evidence_json`.
- Automation Review: posts the classifier routes to an event show **Publish as a
  Special Event** (Recommended) first and **Publish as Daily Specials** second.
  A daily post gets only a collapsed "Publish as a Special Event instead" override,
  and only when none of its specials are on the website and staff have not approved
  any of them. `createEvent()` repeats that check server-side, so a post whose
  specials are on today's daily board is refused (409).
- Public cards: `.event-specials` has `padding:0`, so it uses the same width as the
  weekly specials. The message is a secondary italic line under the offers.

### Read-only check 5 (owner)

```powershell
# Which path created the live Veterans Day card, and its stored text.
npx wrangler d1 execute grayzn-db --remote --command "SELECT e.id,e.origin,e.manual_locked,e.title,e.details,json_extract(e.evidence_json,'$.created_by') created_by,(SELECT group_concat(o.position||': '||o.content,' | ') FROM special_event_offers o WHERE o.event_id=e.id) offers FROM special_events e WHERE e.event_date='2026-11-11';"
```

Existing rows are not rewritten. To fix the live card after deploying: open it
in Admin Specials → Edit, move "Thank you to all who served" from the second
special into **Event Message**, and save. Saving normalizes the text.
