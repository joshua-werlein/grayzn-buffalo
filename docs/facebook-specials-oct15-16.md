# October 15–16 Facebook specials repair

Local proposal only. No production writes, deployment, live settings changes,
historical replay, schema changes, dependencies or appearance changes.

## Verified baseline

On October 17, 2026, freshly fetched main and origin/main both resolved to
`d77a0166d55e7a9a71068ce85dabdd398a99dd43`. Cloudflare reports 100% deployment
`a66c8bc8-62d0-452a-80ba-02c9408a7a1c`, created October 13 at 23:50:20 UTC.
The downloaded active Worker multipart contains the exact locally built baseline
worker.js bundle. Active bindings match repository configuration: evidence 2,
parser 19, GUARDED_AUTO, conditional verification, Gemma 4 26B, AI limit 50,
webhook RUN. The comparison used read-only Cloudflare requests and a local
Wrangler dry-run build.

The four supplied D1 exports are retained in
`tests/fixtures/oct15-16-production.json`, including original extracted_json and
candidate_json strings, events, slots and migration/week checks. Every export
reports zero rows written. Migration 15 has zero mismatches and each affected
date has exactly one saved week. The affected All Day slots were unlocked.
`target_kind=ignored` describes caption classification; all three images were
extracted successfully and staged.

## Root causes and outcome

* Thursday `1734461774888366`: every meal had the same bare `11-1:30` in both
  service fields, but none had that window in its verbatim meal evidence.
  The heading said DAILY LUNCH SPECIALS but omitted the time. Exact heading-text
  deduplication missed these copied labels, so all three became Lunch and two
  exceeded capacity. The validated house layout now produces Spaghetti Lunch
  $9.75, Hawaiian Chicken All Day 1 $10.25, Ham and Cheese All Day 2 $7.25,
  and French Onion or Chili Soup, retaining the actual extracted wording.
* Friday daytime `1735522564782287`: evidence began `1)`, `2)`, `3)` while
  content omitted those presentation markers. Exact token comparison rejected
  all three. The first meal's printed lunch time is already removed from meal
  comparison independently. Additionally, no printed weekday meant the house
  layout could not resolve the two untimed meals. The new gated fallback yields
  Fish Sandwich w/ Fries + Drink $9.75, Cheeseburger OR Fish Sandwich with the
  printed sides $10.25, Chicken Salad Sandwich with the printed sides $7.25,
  and French Onion or Chili Soup. Canonical capitalization is unchanged.
* Friday evening `1735877881413422`: all five service labels repeat the night
  heading, so they do not independently establish five Nightly offers. The
  chicken salad is an exact All Day repeat. The cheeseburger-or-fish meal has
  a conflicting $10.75 versus daytime $10.25. `w/Side` without a space also
  escaped the existing dish conflict comparison; that delimiter is corrected.
  The fish/shrimp offer retains `1 or 2 Piece` and both $12.99/$13.99 amounts
  without assigning prices to portions. Chicken Stir Fry $12.99 and Steak Stir
  Fry $13.99 remain separate offers. There are three possible night meals for
  two destinations, with no established grouping in this stored evidence.
  No grouping or portion-price association is invented. Evening alone remains
  held. Together, Lunch and Soup publish independently; the conflicting All Day
  service and unresolved evening offers stay held. Already published daytime
  values remain unchanged. No broader evening publication policy is introduced.

## Precise boundaries

1. List normalization removes only one leading integer followed by `)` or `.`
   and whitespace, for meal fact comparison. It does not change stored evidence,
   strip bare quantities, reorder words, alter OR/AND, or forgive price changes.
2. Copied-window recovery requires exactly three priced meals, a Lunch heading,
   identical bare lunch windows on all three, no service in any verbatim meal
   evidence, and empty or matching bare service_evidence. Distinct windows,
   explicit service labels, corroborated individual times and conflicting
   evidence survive. House-layout date, heading and night-content guards still
   apply. A genuine individual time equal to a heading is not discarded.
3. Missing-weekday layout inference requires a separately supplied trusted
   source index from guarded-auto, based on a finite, nonfuture stored Facebook
   timestamp on today's Chicago date. AI JSON cannot grant this trust. The
   poster must have day_of_week=-1, empty day_evidence, and an exact case-insensitive
   DAILY SPECIALS heading, on Monday–Friday, with exactly three meals, each with
   one printed price in its verbatim evidence.
   Explicit services must agree with Lunch / All Day / All Day. Soup is separate.
   All offer content, verbatim evidence, service fields and date evidence pass the
   existing date validator. Wrong dates/days, future references, weekly headings,
   night headings, other formats and missing meal prices cannot establish this
   layout. Weekend conventions continue to require their existing printed day.
4. Ownership, enabled destinations, capacity, source snapshots, collection
   revisions, atomic audit/write batches and concurrent-edit fences are unchanged.
   Accepted content contains the prices; origin=automation, manual_locked=0 and
   last_auto_value=content retain their existing meaning. Staff edits remain
   protected; eligible untouched defaults and unchanged automation may update.

Parser identity remains 19: this repairs deterministic reconciliation of the
current evidence contract. Current-day staged evidence is revalidated through
the normal scan. Earlier dates do not become eligible and are not replayed.

## Changed files

* `workers/fb-feed/evidence.js`: list comparison, time provenance, narrow house
  fallback and no-space w/ conflict recognition.
* `workers/fb-feed/reconcile.js`: passes trusted source indices into contract 2.
* `workers/fb-feed/guarded-auto.js`: independently verifies timestamp eligibility
  before passing those indices; original timestamp rejection and write fences stay.
* `workers/fb-feed/extraction.js`: clarifies heading/offer time scope and verbatim
  corroboration, preserving list markers and quantities.
* `workers/fb-feed/oct15-16-regression.test.js`: exact production reproductions,
  adversarial boundaries, local pipeline/ownership/idempotence/concurrency tests.
* `tests/fixtures/oct15-16-production.json`: all four original read-only exports.
* `tests/specials-rendering.test.mjs`: compiled display checks for original prices
  and choices from both daytime candidates.
* This document and `facebook-specials-auto.md`: scope and operating boundary.

## Approval-gated production plan

1. Obtain explicit approval; recheck remote source, active Worker version and
   bindings for drift. Review this diff and the recorded local test results.
2. Deploy only the reviewed fb-feed Worker with its existing configuration. No
   Pages deployment, migration, staging environment or setting changes are needed.
3. Observe the next eligible future post through the ordinary cron/webhook flow.
   Read import evidence and review events; confirm source date, prices, service
   mapping, independent held offers and protected ownership. Read the website to
   confirm display. Do not replay October 15–16 or manually modify live slots.
4. If behavior regresses, with approval roll back to
   `a66c8bc8-62d0-452a-80ba-02c9408a7a1c` after checking it is still the intended
   baseline. Rollback restores code, not D1 values already written; any data
   correction requires separate approval. Retain evidence and audit history.

## Local validation

Validation: full Worker suite **1003/1003 passed**; application suite **127/127
passed**; focused evidence/house-layout suite **99/99 passed**; final production
fixture suite **32/32 passed**; final compiled price/choice rendering check
**1/1 passed**. Build passed; Astro check reported **0 errors, 0 warnings**
(6 existing hints). Final diff whitespace check passed. Original baseline code
also reproduced all three recorded failures from stored candidates. The four
fixture payloads were compared structurally against the original exports and
match exactly. Logs in the project root named `oct15-16-*.log` are ignored by Git.
The first sandboxed application run could not connect to its temporary local
Miniflare database (localhost EACCES); the verification run uses local runtime
access. No test connects to production D1 or calls live AI.
