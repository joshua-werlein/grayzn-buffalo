# October 10, 2026 Facebook specials publication recovery

Prepared from repository inspection and read-only production D1 queries on October 10, 2026, around 10:07–10:10 AM America/Chicago. During investigation, no production writes or deployment were performed. The working tree was clean before this change.

## Approved deployment and verified recovery

The user subsequently approved the Worker-only deployment. `grayzn-fb-feed` was deployed before the October 10, 10:30 AM Chicago cron as Worker version **`6bb59719-6fed-4528-9ca0-28d9a545b5d7`**. The deployment retained the existing routes, queue producer/consumer, `*/30 * * * *` schedule, Parser 18, Gemma 4 and GUARDED_AUTO. No Pages deployment, manual D1 write, schema change, AI replay, or additional code change was performed.

Live Worker logging observed the next scheduled cron on this exact version with outcome `ok`, no exceptions, wall time 755 ms, and CPU time 26 ms. Its scheduled timestamp was `2026-10-10T15:30:44Z`; the execution event timestamp was `2026-10-10T15:31:06.331Z`.

Read-only D1 verification after that completed run confirmed:

- All four destination values exactly match the expected publication table below, including the complete burger/sandwich sides and prices.
- Reserved group `soup:9c8b3ff1-10c1-49b8-bd5c-e0ed9d820218:6` exists with service custom, label Soup, enabled 1, empty service time, sort 99, and position 1 containing `French Onion, Chili or Beer Cheese Soup`.
- Published slots have origin automation, manual_locked 0, last_auto_value equal to content, and empty separate price fields.
- Collection revision advanced from 8 to 9; weekly updated_at is `2026-10-10 15:31:06` UTC (10:31:06 AM Chicago). Saturday Nightly remains disabled and blank.
- Import `494c0b4742408f02c26da116cc39c2a9` remains staged, validation ok, review pending, Parser 18, retry count 1. Its processed_at is still `2026-10-10T14:23:09.937Z`.
- Reconciliation review event **238**, recorded at `2026-10-10 15:31:06` UTC, says exactly: `GUARDED_AUTO: 2026-10-10; reconciled 1 source(s); 4 slot(s)`.
- The sole extraction event remains event 235 from the original processing attempt; no new AI extraction event was recorded.

At approximately 10:31:20 AM Chicago, fresh HTTP reads of both `https://grayznbuffalo.com/` and `https://grayznbuffalo.com/specials` returned HTTP 200, Cloudflare cache status DYNAMIC, and displayed all three exact meal strings in today's Saturday article. Each article contained exactly one separate Soup paragraph: `Soup: French Onion, Chili or Beer Cheese Soup`. Production recovery is complete.

## Approved Pages layout deployment

After approving the centered Soup layout, the user authorized a separate Pages production deployment, conditional on weekend data and menu image checks. On October 10, around 10:54 AM Chicago, Pages deployment **`a2ea98d5-4655-466c-9fb2-6c14050b4711`** succeeded on production branch `main`: https://a2ea98d5.grayzn-buffalo.pages.dev. This deployment used the reviewed, then-uncommitted build; its Cloudflare source metadata therefore references the preceding commit `0fb9086`. The verified source and this record are committed afterward as requested.

Before deployment, a read-only D1 query confirmed Saturday's four published values and Sunday's existing enabled groups: Sunday Special `16” 3-Topping Pizza & 12 Wings`, and All Day `Chicken Salad Sandwich with cup of Chili or Coleslaw`. Sunday has no standalone Soup entry. Both public pages rendered these values correctly. All 12 unique menu thumbnail/full-size image URLs returned HTTP 200 with nonempty WebP bodies.

Food sections now occupy their own grid, with Soup as a separate full-width sibling row. Shared Soup styling centers the text without changing typography, spacing or colors. Two-group weekends retain balanced columns, three-group weekdays retain their existing responsive layout, and mobile stacks in reading order.

Final rendering tests passed 12/12, including Saturday and Thursday examples with and without Soup; the production build and whitespace checks passed. Earlier local browser checks covered two- and three-group examples at 375, 768, 1024 and 1440 pixels. After deployment, live browser verification of both https://grayznbuffalo.com/ and https://grayznbuffalo.com/specials at all four widths confirmed correct Saturday/Sunday content, two balanced food columns at desktop/tablet widths, stacked mobile groups, exactly one centered Saturday Soup row below food, no Sunday Soup placeholder, and no horizontal overflow. Homepage menu/welcome images decoded successfully. Desktop and mobile screenshots are saved in ignored `.wrangler/specials-layout/production-*.jpg` files.

The Facebook Worker was not redeployed during this Pages release. No D1 writes, schema changes, parser changes or specials content edits were performed.

## Confirmed cause

Post `583672228384067_1729295168738360`, import `494c0b4742408f02c26da116cc39c2a9`, contains a separate `Soups:` offer. Both daily reconciliation and the shared standalone Soup reader recognized only `Soup:`. All four offers consequently remained in the food list, preventing the existing three-offer daytime/weekend rule from proposing any targets. With no eligible changes, reconciliation returned without a review event. Extraction itself succeeded.

Production has Parser 18, `@cf/google/gemma-4-26b-a4b-it`, `staged`, validation `ok`, review `pending`, retry count 1, a stored image key, and only fetch/classify/extract/validate/stage events. The emoji caption classified as ignored, but the image was correctly extracted and staged; classification is not the publication blocker.

The exact extracted JSON is preserved in `tests/fixtures/oct10-saturday.json`. Before the fix, its plural-label mapping returned no targets; the new regression run failed 12 of 16 tests. Singular-label weekend mapping already passed.

## Change

- `src/lib/daily-soup.js`: shared anchored Soup/Soups label detection and singular/plural standalone-name extraction; generic `Soups` and `no soups` remain invalid names.
- `workers/fb-feed/reconcile.js`: use the shared detector in both ordinary daily reconciliation and single-day lunch recovery. Included Soup sides remain in their original meal descriptions.
- `tests/fixtures/oct10-saturday.json`: exact production extraction.
- `workers/fb-feed/oct10-regression.test.js`: 16 regressions for exact extraction, singular/plural labels, Saturday/Sunday mapping, single-day lunch, matching evidence, included sides, staged recovery, recurring defaults, staff/disabled/extra-slot protection, hidden Soup, cron idempotence, and the 8 PM cutoff.
- This recovery report.

No extraction prompt, parser version, schema, import lifecycle, or guarded-write policy changed.

## Read-only production findings

Exactly one saved week covers today: weekly ID `9067071494112`, October 5–11, collection `9c8b3ff1-10c1-49b8-bd5c-e0ed9d820218`, revision 8. The existing migration check is version 15 with zero mismatches. Only the affected import was present among October 10 source rows at inspection; there were no additional pending or processing October 10 rows.

| Saturday group | Configuration | Populated content | Origin / lock / last auto |
| --- | --- | --- | --- |
| Saturday Special (`lunch`) | Enabled, empty time, sort 0 | Position 1: Philly & French Fries | manual / 0 / null |
| All Day Specials | Enabled, empty time, sort 1 | Position 1 blank; position 2: Chicken Salad Sandwich with cup of Chili or Coleslaw | manual / 0 / null |
| Nightly | Disabled, 5–10 PM, sort 2 | All blank | manual / 0 / null |
| Reserved Soup | Absent | — | — |

All existing weekly Saturday positions have origin manual, manual_locked 0, last_auto_value null, empty price and empty section_link; unused positions are blank. These are eligible copied recurring defaults under the existing guard. The defaults collection itself is revision 13 and retains its own locks; automatic publication targets the saved week only.

## Expected automatic D1 changes

Provided the production snapshot and current Facebook source version remain eligible:

| Destination | Content |
| --- | --- |
| Saturday Special, position 1 | Philly & Fries – $11 |
| All Day, position 1 | German Burger w/ Side Salad, Soup or Coleslaw – $10.25 |
| All Day, position 2 | Chicken Salad Sandwich w/ cup of Soup or Coleslaw – $7.25 |
| Soup, position 1 | French Onion, Chili or Beer Cheese Soup |

The guarded batch updates those four values with origin automation, manual_locked 0, last_auto_value equal to the content, and empty separate price fields (prices remain in content). It creates reserved group `soup:9c8b3ff1-10c1-49b8-bd5c-e0ed9d820218:6` with service custom, label Soup, empty time, sort 99, enabled 1, four slots, and positions 2–4 blank. Collection revision advances once (8 to 9 if unchanged), weekly updated_at changes, and a `review` event records `GUARDED_AUTO: 2026-10-10; reconciled 1 source(s); 4 slot(s)`.

The import remains staged/pending and reusable; extracted_json, candidate_json, Parser 18 and retry count 1 stay intact. No new extraction event is needed. Recurring defaults, Nightly and other days retain their values. Further unchanged cron runs produce no additional revision or review churn. Staff changes made before publication are respected by the existing eligibility and atomic snapshot checks; protected proposals receive conflict audit details while independent eligible slots can publish.

## Validation

All final checks passed:

- Focused Worker regressions: 193/193 (`node --test workers/fb-feed/oct10-regression.test.js workers/fb-feed/daytime.test.js workers/fb-feed/soup-wing.test.js workers/fb-feed/recurring-soup.test.js workers/fb-feed/oct9-regression.test.js`). This includes all 16 new October 10 cases.
- Complete Worker suite: 737/737 (`node --test workers/fb-feed/*.test.js`), including real local D1 atomic rollback, concurrency and recovery tests.
- Public Soup rendering/admin tests after rebuilding: 8/8 (`node --test tests/daily-soup.test.mjs`).
- `npm run build`: passed.
- `npx wrangler deploy --dry-run --config workers/fb-feed/wrangler.toml`: passed; 135.85 KiB bundle, 33.46 KiB gzip; expected production bindings and GUARDED_AUTO variables.
- `git diff --check`: passed.

Initial sandboxed runs hit Windows file-resolution restrictions during build and loopback access restrictions in the local D1 tests. The final build and focused/full Worker runs completed successfully outside those restrictions. The final dry run used an ignored writable local Wrangler log path. At validation time no production deployment had been performed; the subsequent approved deployment is recorded above. Test logs are in ignored `.wrangler/oct10-focused-tests.log` and `.wrangler/oct10-worker-tests.log`.

## Minimum safe deployment and recovery

1. Obtain approval to deploy only `grayzn-fb-feed`. The application build has been verified; no Pages deployment or database migration is required to publish today's values.
2. From the repository root, deploy the reviewed Worker with `npx wrangler deploy --config workers/fb-feed/wrangler.toml`. Preserve Parser 18, Gemma 4, GUARDED_AUTO and the existing every-30-minute cron. Capture the resulting deployment version for rollback.
3. Let the next ordinary cron perform its complete current-day Facebook scan. It supplies the current source IDs, fails to claim this already-staged row for extraction, and then reconciles the saved candidate JSON with the fixed soup reader. No import replay, AI rerun, parser bump, or manual D1 action is required.
4. After that run, inspect D1 read-only for the four values, reserved Soup configuration, collection revision, the review event, retry count 1, and unchanged extraction evidence. Confirm the homepage and Specials page show the same content and Soup once. On another ordinary run, verify no revision/review churn.
5. If publication is held, inspect the Worker run and read-only state for incomplete Graph scans, edited/removed source versions, new pending imports, overlapping weeks, or staff protection conflicts. Keep the guards intact and review the specific hold before taking further action.

The processing cutoff is 8:00 PM Chicago on October 10, exclusive (`2026-10-11T01:00:00Z`). The last scheduled opportunity is 7:30 PM Chicago; deploy before that run with operational margin. At or after 8 PM the cron does not reconcile today's evidence, and tomorrow's cron will not publish yesterday's staged row. Any recovery after the cutoff requires a separately approved course of action.

If Facebook has edited this source since extraction, the scan creates a different import identity and may need new extraction for that new version; the existing staged row is reused only for the same current identity. This cannot be guaranteed by a D1 snapshot alone.
