# October 11, 2026 weekday-evidence reconciliation recovery

## Confirmed failure

Read-only production investigation found post `583672228384067_1730327925301751`, import `7276d795cf8df30e7627cf85ebb27fe6`, created October 11 at 9:39:46 AM America/Chicago and first fetched at 9:41:05.360 AM. The import was staged, validation ok, review pending, Parser 18, Gemma 4, retry count 1. Audit events 239–243 recorded fetch/classify/extract/validate/stage; no retry or publication event existed.

Both raw extraction and validated candidate retained all three meals, their $30/$10.25/$7.25 prices, and separate `Soups: Beer Cheese, French Onion or Chili` evidence. The stored heading was `SUNDAY SPECIALS` with numeric weekday 0, but `day_evidence` was empty. Validation accepted this shape while `forToday()` ignored weekday names in the heading and silently excluded the whole candidate before soup separation or routing. The deployed Worker and main reproduced the same outcome offline. The extraction's pizza string lacks the printed ampersand and uses `16''`; the deterministic fix preserves stored wording instead of inventing text.

## Implementation

- `workers/fb-feed/reconcile.js`: shared weekday consistency validation checks both evidence fields, accepts exactly one matching heading weekday, and rejects conflicting names/numbers. Current-day reconciliation validates the printed weekday against the Chicago day, explicit ISO/slash/named-month calendar dates, and other/future-date references. No printed weekday permits the existing same-day source fallback with numeric -1 or today's matching day. Exclusions now report reasons instead of returning null silently.
- `workers/fb-feed/guarded-auto.js`: retains timestamp-ineligible source evidence for the existing guarded conflict audit, blocks publication on invalid/future/other-day timestamps, passes the current Chicago date into reconciliation, and includes creation time in the atomic source snapshot. Existing conflict deduplication prevents repeated review/revision churn. Staff ownership, default replacement, soup creation, prices and guarded batch writes remain intact.
- `tests/fixtures/oct11-sunday.json`: exact production extraction, without credentials or operational fencing tokens.
- `workers/fb-feed/oct11-regression.test.js`: exact poster; all seven matching heading weekdays; unknown-day fallback; weekday/date conflicts; Sunday/Saturday/Monday publication; prices/options/soups; staff/default ownership; diagnostics and idempotence; cutoff/later dates; atomic timestamp race protection.
- Existing weekday consistency tests now supply consistent headings and account for the existing encoding retry when a heading contradicts the numeric day. The local real-D1 application test clock now matches its 2030 source fixture, preserving the future-timestamp guard.

Sunday mapping was already documented and tested: first meal goes to service `lunch` labelled Sunday Special, remaining pair to All Day, and separate Soup to its reserved custom group. Sunday Special has no weekday lunch window; weekend Nightly remains disabled. No new service rule was introduced.

Changed files: `workers/fb-feed/reconcile.js`, `workers/fb-feed/guarded-auto.js`, `workers/fb-feed/oct11-regression.test.js`, `workers/fb-feed/current-day.test.js`, `workers/fb-feed/guarded-auto.test.js`, `workers/fb-feed/weekly-lunch-regression.test.js`, `tests/specials-auto-d1.test.mjs`, `tests/fixtures/oct11-sunday.json`, `docs/facebook-specials-auto.md`, and this recovery record. Runtime code changes are limited to the two Worker modules; no extraction prompt, parser version, model, Worker entry point, Pages source, dependency or configuration file changed.

## Production baseline

Worker before deployment: `6bb59719-6fed-4528-9ca0-28d9a545b5d7` at 100%. Read-only preflight verified account `a79e3b4a2bb8dad70c75bceac4b1d3f9`, Worker `grayzn-fb-feed`, D1 `DB` binding to `grayzn-db` (`c998bfd4-7031-4ae2-9eea-df86f16ddb15`), existing routes/KV/R2/AI/queue bindings, half-hour schedule, GUARDED_AUTO, Gemma 4, daily budget 50 and webhook RUN. Pages uses the same D1 database. Main and the initial clean checkout were `fc1c3bb611119d92b9ae939ebc705f6477d91497`.

Week October 5–11: weekly ID `9067071494112`, collection `9c8b3ff1-10c1-49b8-bd5c-e0ed9d820218`, revision 9. Sunday Special position 1 held `16” 3-Topping Pizza & 12 Wings`; All Day position 1 was blank, position 2 held `Chicken Salad Sandwich with cup of Chili or Coleslaw`. All other Sunday positions were blank; Nightly was disabled and Soup absent. Every Sunday slot had empty price/section_link, origin manual, lock 0, and null last_auto_value: eligible recurring-default copies, not Facebook publication.

## Deployment and scheduled verification

Final validation passed: **784/784 Worker tests**, including **47 new October 11 regressions**, and **126/126 application tests**. Worker dry run and `git diff --check` passed. The first sandboxed application run hit local D1 loopback restrictions; the successful final suites ran with local runtime access. Older tests with contradictory heading/numeric fixtures were corrected to enforce the new rules, and the real-D1 fixture clock now matches its source date.

The user explicitly authorized production deployment. At **12:15:16 PM Chicago on October 11**, `wrangler deploy --config workers/fb-feed/wrangler.toml --keep-vars` deployed only `grayzn-fb-feed`, version **`7538dae5-7638-4a50-bac1-6fe9726b5f17`**. The deployment API confirmed 100% traffic. Downloaded source contains the shared weekday checks and timestamp snapshot guard, with Parser 18. Live binding/variable definitions exactly match the preflight snapshot; the cron remains `*/30 * * * *`. No Pages deployment, environment-variable change, migration/manual correction, forced invocation, retry or historical import replay was performed.

The noon cron was missed while implementation/tests were underway. The next normal **12:30 PM Chicago** cron ran on the new version: scheduled time **12:30:41 PM**, event timestamp **12:30:41.143 PM**, outcome **ok**, no exceptions. D1 recorded publication at **12:30:45 PM**. Review event **244**, attached to the existing import, says `GUARDED_AUTO: 2026-10-11; reconciled 1 source(s); 4 slot(s)`. Collection revision advanced **9 → 10**.

| Destination | Before cron | After cron |
| --- | --- | --- |
| Sunday Special, position 1 | 16” 3-Topping Pizza & 12 Wings; no price | 16'' 3-Topping Pizza 12 Wings $30 |
| All Day, position 1 | Empty | Olive Burger w/ Side Salad, Soup Or Coleslaw $10.25 |
| All Day, position 2 | Chicken Salad Sandwich with cup of Chili or Coleslaw; no price | Chicken Salad Sandwich w/ Cup Of Soup Or Coleslaw $7.25 |
| Soup, position 1 | Group absent | Beer Cheese, French Onion or Chili |

All four published slots have `origin=automation`, `manual_locked=0`, and `last_auto_value` equal to content. Prices are retained in meal content; the separate price field remains empty, consistent with this pipeline. The new enabled custom Soup group has empty service time, sort 99, and three additional blank slots. Existing Sunday service definitions and disabled Nightly are unchanged.

A SELECT-only comparison of all slots, groups, collections, weeks, imports and audit events against the pre-deployment snapshot found exactly three existing meal-slot updates, the new Soup group/four slots, the current collection revision and week timestamp, and one review event. No other existing rows changed. Recurring templates, protected staff slots and other days remained unchanged. All 35 import rows were identical, including stored extraction, candidate, parser/model, processed time, staged/pending status and retry count 1. All existing extraction/audit events were unchanged; no new extraction or retry event appeared. Recovery reused stored evidence without rerunning Workers AI.

Both public reads returned **HTTP 200**, Cloudflare cache status **DYNAMIC**, and their Sunday sections contained all three exact meal strings with **$30, $10.25 and $7.25**, plus **Soup: Beer Cheese, French Onion or Chili**: homepage `https://grayznbuffalo.com/` and specials page `https://grayznbuffalo.com/specials`. Publication succeeded without manual correction or import replay. Local changes remain uncommitted; no further production changes were made.
