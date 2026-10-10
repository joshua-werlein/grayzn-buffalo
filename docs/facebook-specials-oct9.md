# October 9 Facebook specials investigation and local correction

Baseline inspected: clean `main`, `e0ecd06` (parser 17). Parser 18 implementation and validation were completed locally before deployment. The owner subsequently confirmed successful deployment of Worker `grayzn-fb-feed`, Cloudflare version `3608abae-9808-4809-baf6-f28a509af8d5`. This confirms deployment, not live extraction/publication from future Facebook posts; that verification remains pending. October 9 production findings below come from the supplied investigation; repository code was traced independently. The follow-up deployment preflight used read-only Cloudflare metadata checks. No remote D1 modifications, historical replay, migrations or secret/resource changes are part of the documentation and commit task.

## Confirmed root causes

1. **Lunch shape mismatch.** Caption classification is audit metadata, not an image eligibility gate. Empty-caption image posts reach the general `anyOf` extraction schema. The AI returned `weekly-lunch` even though its heading was Friday Lunch Specials and every extracted entry had weekday 5. `validateExtraction()` dispatched straight to `validateWeeklyLunch()`, which correctly rejected duplicate weekdays. That validation failure was permanent and not in the targeted shape-retry list. The failed dedicated response was then excluded from daily reconciliation. Food and prices were present, but no daily proposals reached D1.
2. **Night repeat identification and option grouping.** Per-offer service time is intentionally independent of poster-level time. Only fish carried a printed individual 5–10 PM time. Nightly expansion required a complete, price-sensitive match to an established All Day pair. The lunch rejection prevented establishing that pair, and even after recovering lunch the $10.25/$10.75 mismatch prevented matching it. Only one explicitly timed offer remained for Friday's expected two Nightly offers. Removing the repetitions still left three extracted rows because Chicken and Steak Stir Fry had been split into separate offers. The old reconciler had no general way to recognize those as one choice-based offer.
3. **Defaults and rendering are not the blocker.** Daily guarded writes already permit untouched recurring defaults (`origin=manual`, `manual_locked=0`) and unchanged unlocked automation values. Populated staff corrections and edited automation values remain protected. The normalized model supports multiple groups and four positions each. `SpecialGroup.astro` renders `displayedSpecial(slot)` and the saved group service window; prices embedded in content are visible even with an empty separate `price` field. Existing failed reconciliation left recurring defaults and old automation text on the page; no price-rendering change is required.

## Correction

- `workers/fb-feed/worker.js`: normalize a strictly identifiable mistaken single-day lunch response before the weekly validator; preserve raw extracted JSON.
- `workers/fb-feed/reconcile.js`: identify that daily shape conservatively, reuse the existing three-meal daytime mapping under a Lunch heading, retain Soup separately, identify repeated All Day dishes without declaring conflicting prices equivalent, and group clear adjacent variations. Canonical readable case remains the publication layer; Soup now uses it too.
- `workers/fb-feed/extraction.js`: explicitly distinguish single-weekday lunch from a weekly schedule and instruct extraction to retain printed choice/portion grouping without inventing price associations.
- `workers/fb-feed/classify.js`: parser 18 gives current-day sources a new extraction identity rather than silently reusing parser-17 failures.
- `workers/fb-feed/guarded-auto.js`: a rejected daily response cannot bypass source rejection merely because its raw AI type was `weekly-lunch`; genuine dedicated weekly/section evidence keeps its existing behavior.
- `workers/fb-feed/oct9-regression.test.js` (new): exact October 9 fixtures and ownership/order/price/grouping/rejection checks.
- `workers/fb-feed/guarded-auto.test.js`, `workers/fb-feed/daytime.test.js`: existing daily conflict expectations now permit unrelated Nightly publication; daytime parser identity assertions advance to 18.
- `workers/fb-feed/weekly-lunch-regression.test.js`, `workers/fb-feed/mexican-night.test.js`: parser identity assertions advance to 18 while retaining the existing routing and extraction checks.
- `docs/facebook-specials-oct9.md` (new), `docs/facebook-specials-auto.md`: investigation, corrected pipeline behavior and recovery limitations.

`auto-week.js`, schema, public rendering, admin ownership logic and transaction fences do not need modification. All proposed slot writes, collection revision changes and conflict audits still commit in one existing snapshot-guarded D1 batch. Source versions, pending recovery, group/slot snapshots and manual edits still invalidate a stale plan. Malformed/rejected sources retain the existing whole-plan rejection semantics.

## Conservative option grouping

Owner clarification: explicit grouping is sufficient, and adjacent unambiguous variations of one base dish may also be combined; a literal OR is not required.

The deterministic variation rule applies only after a night poster's repeated All Day pair has been independently identified, on a Monday/Friday poster with three remaining Nightly rows. Two source-adjacent rows must each have one complete price, differ by exactly one leading alphabetic choice word, and share the same multiword dish name. Included-side connectors and size/modifier prefixes are excluded. Exactly one possible pairing must exist. The combined text must fit 150 characters. The rule contains no food names, dates or prices. It does not consume the heading to assign all night-poster rows to Nightly, and it never groups merely to satisfy capacity. Explicitly grouped extraction content can already occupy one slot without this rule.

Examples: Chicken Stir Fry / Steak Stir Fry and Lentil Curry Bowl / Chickpea Curry Bowl qualify. Chicken Stir Fry / Steak Dinner, size-based amounts, incomplete prices, nonadjacent matches and three-way possible pairings remain under review. More complex variation names may need explicit grouping in the extraction or staff review. Overlength content is rejected or staged; never truncated. The same conservative rule cannot establish a fish portion-to-price association from an unlabeled slash price, so its original choices and both amounts remain together unchanged.

## Expected October 9 result

| Section | Position | Published offer |
|---|---|---|
| Lunch, 11 AM–1:30 PM | 1 | Fish Sandwich w/ Fries + Drink $9.75 |
| All Day | 1 | Cheeseburger or Fish Sandwich w/ Side Salad, Soup or Coleslaw $10.25 |
| All Day | 2 | Chicken Salad Sandwich w/ Cup of Soup or Coleslaw $7.25 |
| Nightly, 5–10 PM | 1 | 1 or 2 Piece Fish + 3 Jumbo Shrimp + Fries & Coleslaw or Side Salad $12.99/$13.99 |
| Nightly, 5–10 PM | 2 | Chicken Stir Fry $12.99<br>OR Steak Stir Fry $13.99 |
| Soup | independent reserved group | French Onion or Chili |

Existing readable-case normalization preserves the printed numbered meal prefixes and wording; this table omits numbering for readability. Ordinary slots remain within 150 characters. The night poster's repeated $10.75 value remains in durable extraction evidence and a blocked All Day conflict audit. The daytime $10.25 stays published. Neither price is declared correct by the code. The fish offer does not assert which portion corresponds to which amount. Verify that association against the actual poster before making a more explicit manual correction.

## Production recovery procedure — document only; do not execute automatically

First inspect the deployed revision, parser/model, bindings, migration history, both original imports/events and retained images read-only. Back up the relevant week, source evidence, ownership/lock fields and collection revision before an authorized recovery. Resolve no conflicting price by guessing. Do not blindly replay historical migration instructions in the pipeline guide; this patch itself requires no new migration.

**If deployed on October 9 before the 8 PM America/Chicago cutoff:** parser 18 produces new source IDs on the normal complete current-day Graph scan. Unchanged parser-17 staged/failed rows remain audit history. Eligible posts can be re-extracted and reconciled by the normal cron, within the existing AI budget, attempt leases and source/slot fences. Confirm the live images and captions still represent these posters, the target week is uniquely October 5–11, recurring slots remain eligible and staff decisions/locks have not changed. Observe the resulting six slot changes (including Soup), preserved $10.25, and blocked $10.75 conflict; inspect protected-slot reasons if fewer changes apply. Do not force processing after cutoff or reuse old candidates by relabeling their parser version.

**If October 9 has ended, or the original source is no longer current/available:** historical recovery is necessary. The current Worker intentionally has no historical daily replay path. `requeueFailedImport()` handles only pending-review failed imports, does not handle a staged import, and cannot bypass current parser/model, source scan, current-day window or cutoff. Do not change the clock, source timestamps, parser fields, lease state or review status to force a replay.

Use the existing authenticated admin editor to select the October 5–11 week explicitly. Review the original poster images and extraction with the owner; save the five ordinary values and the independent Soup value through the existing revision-checked `saveCollection()` flow, preserving all unrelated groups and existing staff corrections. Confirm both meal choices/prices, drink/sides and group windows before saving. Retain $10.25 unless staff explicitly resolves the $10.75 discrepancy; retain the original conflicting import/event evidence. Populated manual corrections acquire locks through the normal save path. If a lock is already present, resolve it with staff rather than bypassing it. If automated historical replay is desired, it needs a separately reviewed operator-only entry point with explicit date/source/target selection and the same concurrency/ownership protections; this patch does not introduce one.

The public specials page filters out prior dates. Correcting an October 9 record after October 9 repairs historical saved data but does not make a past special appear as today's offer.

## Validation

All verification uses fixtures, mocked Graph/Workers AI/R2 and temporary SQLite or local Miniflare D1 databases. The 38 new October 9 tests exercise exact supplied extractions, both arrival orders and repeated cron idempotence; single-day and true-weekly routing; independent Soup; price conflict auditing; preserved portion amounts and grouped choice prices; missing/malformed prices; unrelated/ambiguous/size/nonadjacent/overlength grouping; readable case; default replacement and locked staff corrections. Existing suites cover weekly lunches, weekday encoding, Mexican Night, ownership, source races, transaction rollback and rendering.

Initial October 9 correction results: **816/816 full Worker/application tests passed**, **93/93 focused October 9 and adversarial source/price tests passed**, `npm run build` passed, and `git diff --check` passed. Logs: `audit/oct9-verified-suite.log`, `audit/oct9-fencing-tests.log`, `audit/oct9-build-final.log` (ignored by Git).

The first sandboxed full run failed five local D1 tests because loopback access was blocked, and an old Thursday test still expected a price conflict to suppress unrelated Nightly publication. The expected behavior was updated and D1 tests reran with local runtime access. Follow-up runs exposed a dash-as-negative price parsing regression and a night-first conflict-audit case-normalization revision bump; both were corrected and their regressions now pass. The sandboxed build initially hit dependency `EPERM`; the local runtime rerun succeeded. No production calls were needed for that initial correction.

## Parser 18 follow-up: authoritative source prices

The existing canonicalizer contained two dangerous runtime substitutions: Thursday Pizza Night forced historical 12/16-inch descriptions and $13.50/$16 prices; Friday All Day Stir Fry forced Chicken/Steak choices at $12.99/$13.99. Both constants and their weekday/keyword replacement branches are removed. Current Facebook prices take precedence over historical values. Canonicalization now formats source text only, preserving complete labelled choices on separate lines without inventing food, sizes, descriptions or prices. Readable capitalization leaves currency tokens unchanged. Wing Night's dedicated source-labelled bone-in/boneless handling remains intact.

Missing/malformed prices and uncertain size/choice associations in the formerly rewritten families hold the affected service for review, retaining raw extraction and unresolved-target evidence. Other eligible services remain publishable. This does not loosen the existing October 9 fish price-range preservation, grouping, repeated-price conflict isolation, Soup independence, ownership checks or snapshot-guarded transactions. Parser stays 18; no schema or production migration is needed.

Production source inspection found no other fixed price/description replacements of this kind. Fixture prices, recurring defaults and extraction examples are not imported-price authorities. Mexican Night and Wing Night normalize source amounts rather than replacing them with fixed menu prices.

Follow-up files: `reconcile.js`, `canonical-content.test.js`, new `dynamic-prices.test.js`, updated multiline expectations in `oct9-regression.test.js`, and the two Facebook-specials guides. Dynamic-price tests cover historical and changed pizza prices, alternate sizes/descriptions, a single pizza, changed Friday choices, missing/ambiguous prices, readable case, source-to-storage/display preservation, eligible defaults, protected manual/edited automation, overlength rejection and independent valid services. The original October 9 tests still cover both post arrival orders.

The first follow-up targeted run exposed an overly broad slash-range rejection for a clearly labelled next pizza size. The guard now distinguishes an explicit next size (for example `/ 16 inch`) from an unlabelled price suffix; unlabelled ranges remain rejected. Final follow-up results: **218/218 targeted tests passed**, **843/843 full Worker/application tests passed** (no failures or skips), `npm run build` passed, Worker deployment dry run passed, and `git diff --check` passed. Full diff review found no unrelated application, schema, configuration or credential changes. Follow-up logs are `audit/parser18-prices-targeted.log`, `audit/parser18-prices-full.log`, `audit/parser18-prices-build.log`, and `audit/parser18-worker-dry-run.log` (ignored by Git).

## Production preflight, completed deployment and live verification status

Cloudflare account `Grayznbar@outlook.com's Account` (`a79e3b4a2bb8dad70c75bceac4b1d3f9`) and Worker `grayzn-fb-feed` match `workers/fb-feed/wrangler.toml`. Before deployment, read-only checks verified version `d0d3cd33-9ee8-42b5-aad9-085b419e7efc`, deployed at 100% on `2026-10-08T01:04:33.156184Z`. That version is historical preflight evidence. The owner has now confirmed successful Parser 18 production deployment as version `3608abae-9808-4809-baf6-f28a509af8d5`; no deployment timestamp or new rollout percentage is inferred from that confirmation.

The pre-deployment live `GUARDED_AUTO` mode, Gemma model, AI daily limit, webhook RUN mode, feed/webhook routes, half-hour cron, KV/R2/D1/AI bindings, import queue consumer settings and dead-letter queue matched the local configuration. Secret binding names/types were checked without exposing values. The dry run confirmed the local bundle and bindings; the dry run itself made no deployment. Webhook/queue/cron handlers and the Wrangler configuration are unchanged by this patch.

The Worker deployment command is preserved for reference, from the repository root. Deployment is already complete; do not rerun it for this documentation/commit task:

```powershell
npx wrangler deploy --config workers/fb-feed/wrangler.toml --keep-vars
```

Successful deployment is distinct from live behavior verification. The local suites prove the fixture cases, including both October 9 arrival orders and dynamic-price preservation. Future live Facebook posts still need read-only observation of eligible imports, extracted evidence, reconciliation events, published values and protected/reviewed targets before their end-to-end behavior can be marked verified. No such future-post verification is claimed here.

Do not redeploy, modify production D1, replay historical imports, run migrations, change secrets/resources or deploy Astro Pages as part of this documentation/commit task. Preserve the recovery procedures above as operator guidance requiring separate authorization. Do not alter historical October 9 records to make past specials appear today.
