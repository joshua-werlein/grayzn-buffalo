# Automatic Facebook Specials

## Configuration and release status

Parser 18 includes the October 9 correction and removal of historical pizza/stir-fry price substitutions. The owner confirmed successful production deployment to `grayzn-fb-feed`, Cloudflare version `3608abae-9808-4809-baf6-f28a509af8d5`. Deployment success does not establish correct extraction or publication from future live Facebook posts: that still requires observation of new eligible imports and reconciliation events. Local regression tests and the production preflight passed, but no future-post live verification is claimed here. This patch requires no new production database migration; older migration instructions later in this guide describe their original release and must not be blindly rerun.

| Item | Value |
|---|---|
| Deployed parser version (October 9 and dynamic-price fixes) | 18 |
| AI model | `@cf/google/gemma-4-26b-a4b-it` (Gemma 4, Workers AI) |
| `SPECIALS_IMPORT_MODE` | `GUARDED_AUTO` |
| Production Worker version (deployment confirmed by owner) | `3608abae-9808-4809-baf6-f28a509af8d5` |
| Production Worker | `grayzn-fb-feed` |
| Account ID | `a79e3b4a2bb8dad70c75bceac4b1d3f9` |

The production configuration is `workers/fb-feed/wrangler.toml`. Read-only checks before deployment verified that its routes, half-hour cron, webhook queue consumer and dead-letter queue, vars, KV/R2/D1/AI bindings matched the live settings. The Worker dry run passed. The deployment command is retained as a technical reference; the deployment is complete and must not be rerun as part of documenting it:

```powershell
npx wrangler deploy --config workers/fb-feed/wrangler.toml --keep-vars
```

`--keep-vars` preserves dashboard variables; the configuration retains the preflight-verified bindings, routes and triggers. No secret values are supplied by this command. No production D1 modifications, migrations, historical replay or Astro Pages deployment are part of this documentation/commit task.

## Pipeline Overview

For the October 9 correction, exact expected slot contents, grouping limits and the production recovery procedure, see [October 9 investigation and recovery](facebook-specials-oct9.md). Parser 18 deployment is complete; verification against future live Facebook posts remains pending.

Each half-hour cron in `GUARDED_AUTO` mode:

1. Scans today's Facebook image posts (America/Chicago, 7 AM inclusive – 8 PM exclusive).
2. Registers the complete scan, conditionally claims new or due recovery attempts, and extracts images using Gemma 4 via Workers AI.
3. Validates extraction output against one of three shapes.
4. Runs deterministic reconciliation against stored evidence.
5. Writes eligible specials to D1 in a single guarded transaction.

`SPECIALS_IMPORT_MODE` controls behavior:

- `OFF` — pipeline disabled entirely
- `DRY_RUN` — writes import/audit/recovery state, but never publishes specials
- `GUARDED_AUTO` — full extraction and publication

The scan paginates only posts created today in America/Chicago and excludes future timestamps. The public four-post feed is unchanged.

## Extraction Shapes

Three shapes are offered via an `anyOf` schema:

| Shape | Key fields |
|---|---|
| `daily-offers` | `day_of_week` (-1..6), `day_evidence`, `poster_evidence`, `offers[]` |
| `weekly-lunch` | `poster_evidence`, `date_range`, `service_time`, `entries[]` (weekday 1–5 with `content`) |
| `mexican-night` | `poster_evidence`, `schedule`, `groups[]` (label and `items[]`) |

The extraction records the printed weekday, poster heading, and each offer's own time and heading. The weekday must match today. A `day_of_week` of `-1` with empty `day_evidence` is accepted as same-day evidence (no-weekday fallback). Posts with recognizable future date references are rejected. Posting time never assigns service.

## Same-Day Routing

A generic day poster with one explicit lunch offer and two untimed offers establishes one Lunch and two All Day values. Explicit All Day evidence also establishes that pair. A night poster alone never establishes All Day.

All Day agreement is compared by complete normalized dish and price. Case, spacing, punctuation, `w/` versus `with`, ampersands, and dollar formatting normalize; different dishes or prices do not agree. Existing automation-owned All Day text and order are retained when the pair matches. Once a complete All Day pair is independently established, dish-only matching (ignoring a leading printed list number and prices) may identify its repetitions on a night poster. Each dish must match exactly once. A different repeated price records a blocked All Day proposal containing the conflicting price and the retained baseline; it never replaces the baseline. Those repeated dishes are excluded from Nightly so unrelated valid night offers can publish in the existing guarded transaction.

- A Monday/Friday four-offer night poster needs the repeated pair identified before its two remaining offers publish.
- Wednesday publishes only one explicit Wing Night offer; Thursday allows one night-specific offer.
- Tuesday Nightly retains its recurring behavior; the separate Mexican Night collection uses its own reconciliation path.
- Weekend Nightly stays disabled; configured weekend Lunch/All Day groups remain subject to their existing enabled settings and capacities.

## Source prices and formatting

Current Facebook evidence supplies imported dish descriptions, sizes, choices, sides and prices. Canonicalization controls readable case and whitespace/multiline formatting, not food prices. The former Thursday Pizza Night and Friday All Day Stir Fry replacements have been removed: neither weekday nor keywords can substitute historical prices or invent additional sizes/options. Individually labelled, complete priced choices can display on separate lines; printed OR/and connectors are retained. A single printed pizza remains a single offer.

For the previously rewritten pizza/stir-fry families, missing, malformed or ambiguous choice prices hold the affected service proposal for review. Raw extraction and the unresolved-price audit remain available; eligible proposals in other services can still publish. Unlabelled multiple prices are never assigned to sizes or proteins by guessing. The established October 9 fish text remains intact, including its unassigned portion/price range. The 150-character validation is unchanged and never truncates.

Wing Night still uses its dedicated labelled bone-in/boneless price validation and source-derived formatting. Weekly Lunch, independent Soup and Mexican Night retain their existing workflows. No other runtime historical price/description substitutions were found in the production pipeline: extraction examples are illustrative, recurring menu values are fallback defaults, and Mexican Night/Wing Night normalizers preserve source amounts.

## Weekly Lunch

A clearly single-day Lunch Specials heading with several weekly-shaped entries all carrying that same weekday is normalized into daily evidence before weekly validation. Weekly headings, date ranges, multiple weekdays and conflicting weekday labels are never converted. The complete raw extraction remains in the import audit. Each ordinary recovered meal requires one clear printed price; Soup retains its independent validation. The restaurant's existing three-meal daytime pattern applies to Lunch Specials headings as well as generic Specials: first meal Lunch, remaining pair All Day. The recovered overall lunch window belongs to the first meal, not to the All Day pair.

If `poster_evidence` or `day_evidence` carries weekly lunch signals but the AI returned `daily-offers` shape, `WEEKLY_LUNCH_SHAPE_ERROR` triggers a retry with the weekly-lunch-only schema.

## Mexican Night Retry and Routing

Two paths can route to Mexican Night extraction:

- If evidence contains "Mexican Night" but the AI returned `daily-offers` shape, `MEXICAN_NIGHT_SHAPE_ERROR` triggers a retry with the mexican-night-only schema.
- On Tuesday, if the first attempt returned valid poster evidence with empty offers, a targeted Mexican Night retry fires regardless of caption text. The targeted prompt instructs the model to return `groups: []` when "Mexican Night" text is absent or uncertain; empty groups fail validation, so the poster fails closed rather than publishing wrong data.

A successful `mexican-night` extraction routes to the Mexican Night section:

- `target_kind='section'`
- `target_collection_id='mexican-night'`

`reconcileMexicanNight()` queries staged imports with that target and `applyMexicanNight()` writes the groups and items to the `special_collections` record with `section_source='facebook'`.

## Manual Edit Protection

Populated staff corrections remain protected. Existing blank-slot eligibility is unchanged; untouched recurring defaults and unchanged automatic values remain eligible according to the current ownership rules. All eligible group changes commit in one transaction with the collection revision, full snapshots of today's groups/slots and source evidence, and audit events. A race affecting an All Day baseline invalidates the night plan as well.

## Fail-Closed Safeguards

- Night-first evidence is retained; explicit unambiguous groups may publish first.
- A later day poster can establish Lunch/All Day and resolve a staged night poster automatically.
- Conflicting or incomplete groups fail closed.
- The next cron reconciles unchanged, successfully extracted current versions, so a write race can recover without another AI call.
- Source edits replace prior versions for reconciliation; historical versions remain for audit.

## AI Budget and Durable Claims

Each Page/post/caption/image/parser/model version retains the same deterministic ID. Processing attempts are claimed conditionally in D1, with a unique `attempt_token` and a 20-minute `lease_expires_at`. The lease is longer than the scheduled invocation's documented 15-minute wall-time limit. Expired/superseded attempts cannot update image pointers, extraction results, status, or completion audit. AI reservations also require current ownership and pending staff review. Uploads use attempt-specific R2 keys so a delayed upload cannot overwrite a newer attempt's image.

The 50-call Chicago-day budget (`SPECIALS_AI_DAILY_LIMIT`) is reserved atomically immediately before each provider invocation, including existing within-attempt retries and failed calls. A reservation lost to interruption is conservatively retained. Reconciliation reuses evidence without invoking vision. Exactly-once provider billing across a crash cannot be guaranteed: an unrecorded successful provider response may require another accounted call.

### Recovery lifecycle

| State/outcome | Action |
|---|---|
| New matching source | Durable `pending` row; atomically claim as `processing`. |
| Temporary provider/network error | `pending`, `failure_kind='transient_ai'`, durable next-attempt time. |
| Temporary image HTTP/network failure, missing stored image | `pending`, `transient_image`; retry from a freshly verified matching Graph source. Missing stored objects clear the pointer. |
| Temporary R2/D1 attempt failure | Pending recovery when D1 can record it; otherwise the processing lease remains reclaimable. |
| Valid extraction | `staged`; clear lease and next-attempt time; use existing guarded reconciliation. |
| Invalid/ambiguous extraction after existing targeted retries | `failed`, `permanent`; no automatic retry. |
| Missing/invalid/oversized image, nontransient image HTTP error | `skipped`, `permanent`; no automatic retry. |
| Application daily AI budget reached | `skipped`, `budget`; no automatic next-day retry. |
| Expired processing lease | Reclaim only after the next-attempt time, if attempts remain and the source is still eligible. |
| Third failed attempt, or third attempt abandoned | `failed`, `exhausted`; no fourth automatic attempt. |
| Day ended or 8 PM cutoff reached | Pending/expired work becomes `failed`, `expired`; never backfilled. A live attempt may save its result while its lease is valid, but publication retains the existing cutoff checks. |

`retry_count` counts **started attempts including the initial attempt**: 1, 2, 3. Every claim consumes one attempt even if interrupted before AI. `next_attempt_at` is 30 minutes after that attempt's claim. No retry starts earlier; the unchanged half-hour cron runs it on the first eligible tick (often 30–60 minutes later, depending on timing). Lease expiry at 20 minutes revokes ownership but does not shorten the 30-minute backoff. Success, exhaustion and permanent outcomes clear the due time.

Transient provider classification recognizes HTTP 408/425/429/5xx, explicit network/timeout/capacity errors and Workers AI timeout/aborted/capacity codes. Known invalid request/model, permission, account-blocked and allocation-exhaustion errors are permanent. Unknown provider errors are conservatively permanent. JSON-mode/schema errors retain their existing within-attempt retry behavior, not automatic repeated cron retries. See [Workers AI error codes](https://developers.cloudflare.com/workers-ai/platform/errors/).

All attempts require a complete current-day Graph scan containing the **same deterministic source version**, the current parser/model, pending staff review, and the 7 AM–8 PM Chicago window. A failed/incomplete Graph scan delays recovery without consuming an attempt. Fresh Graph data supplies refreshed image URLs; URLs are not persisted as retry credentials. Changed posts receive a distinct source ID; older versions are not reclaimed. Removed posts are not automatically retried. Existing validated weekly-lunch evidence keeps its separate today/future-weekday lifecycle.

Daily publication waits if any source in that complete scan is pending/processing; the transaction checks that condition again alongside existing source and staff snapshots. Weekly-lunch and Mexican Night keep their separate reconciliation and precedence rules. Recurring content remains available while processing is unresolved. Accepted, edited, kept or dismissed staff decisions cannot be automatically reclaimed or overwritten by a late completion.

Historical `failed`/`skipped` rows are not automatically reclassified by the migration: their old generic errors do not reliably distinguish temporary failure from unsafe evidence. Legacy `processing` rows receive a lease/due time based on `fetched_at`, and consume the initial attempt. Explicit `requeueFailedImport()` remains an operator-only helper for unreviewed failures; it resets the attempt allowance but retains all historical accounting/events. It is not exposed through the public endpoint and cannot make prior-day work eligible.

History and orphaned attempt images retain the existing 30-day cleanup. No feed hook, webhook, public processing endpoint, polling-frequency change, parser change, or new AI prompt is part of this release.

## Week Creation

In `GUARDED_AUTO` only:

- Sunday crons at/after 7 PM Chicago ensure the upcoming Monday–Sunday week (including retries later that evening).
- On other runs during processing hours, the current Monday–Sunday week is ensured before scanning.
- No future week is created earlier.

Overlap checks and template copying happen in one transaction. Existing/overlapping weeks are left unchanged. Group structure and recurring values copy exactly; recurring slots start with manual origin and `manual_locked=0`, while `NULL`/empty slots become explicit empty strings. Staff edits acquire manual protection. Slots with a price or section link remain protected from daily automatic replacement.

`OFF` and `DRY_RUN` never create weeks. The admin's default view reads the unique week containing today's Chicago date. Explicit week selection and the explicit new-week action retain their behavior. No GET creates weeks. Recovery requires migration 0021; it does not change the weekly/Mexican defaults lifecycle.

## Manual production release steps

The project policy reserves production migration/deployment for the human reviewer. Nothing was deployed or applied remotely during implementation.

1. Verify the deployed Worker revision, active bindings and D1 migration history. Back up D1. `0020_mexican_night_price_free_defaults.sql` is a separate existing data migration; do not blindly replay it or older migrations.
2. Temporarily disable imports with `SPECIALS_IMPORT_MODE=OFF`, leaving the feed and 30-minute cron intact. Confirm the old importer is disabled and wait at least 20 minutes after the last old invocation could have started. Old Worker code does not honor fencing tokens and must be drained before recovery is enabled.
3. Apply **only** the reviewed `migrations/0021_special_import_recovery.sql` to `grayzn-db` using the project's transactional migration procedure. Verify all four new columns, the recovery index, legacy processing lease initialization, and unchanged staff review/specials values. Do not rerun this ALTER TABLE migration blindly.
4. Deploy the new `grayzn-fb-feed` Worker with its existing KV/R2/D1/AI bindings and `SPECIALS_IMPORT_MODE=GUARDED_AUTO`. Its configuration is `workers/fb-feed/wrangler.toml`; the repository's Pages deployment workflow does not deploy this Worker. Keep `*/30 * * * *` unchanged. No Pages deployment is required for recovery.
5. Observe the next normal cron: verify feed freshness, due-attempt claims, extract reservations, successful staging/reconciliation and any terminal reasons. Inspect `processing_status`, `retry_count`, `attempt_token`, `lease_expires_at`, `next_attempt_at`, `failure_kind`, and `special_import_events`. Do not force prior-day imports or edit staff specials to test recovery.

If rolling back, disable imports and drain current attempts first; avoid running unfenced old code concurrently with recovery. The additive columns may remain. Do not reset claims/counters or remove audit history as a rollback shortcut.

## Testing

October 6 local validation: complete Worker suite **551/551 passed** (including 38 new recovery tests); application suite **113/113 passed**; `npm run build` passed. Worker/application tests ran with local runtime access for Miniflare D1. The first sandboxed build hit an installed-dependency `EPERM`; the normal local rerun succeeded. No production services were invoked by the tests.

Recovery coverage includes real local D1 transaction rollback/concurrency, in addition to SQLite-backed interruption, late completion/upload, image, budget, manual ownership, calendar, weekly-lunch and Mexican Night tests. Logs are `audit/recovery-worker-suite.log`, `audit/recovery-app-suite.log`, and `audit/recovery-build.log` (ignored by Git).

## Recovery implementation files

| Files | Purpose |
|---|---|
| `workers/fb-feed/worker.js` | Shared processing path for initial and recovery attempts; safe image recovery; fenced AI accounting; guarded operator requeue. |
| `workers/fb-feed/recovery.js` (new) | Conditional D1 claims, lease tokens, bounded attempts, failure classification, atomic status/audit completion and expiry. |
| `workers/fb-feed/guarded-auto.js` | Daily publication waits for unfinished current sources, including an atomic write-time check. |
| `migrations/0021_special_import_recovery.sql` (new), `schema.sql` | Recovery metadata/index and conservative legacy-claim initialization. |
| `workers/fb-feed/recovery.test.js`, `workers/fb-feed/recovery-d1.test.js` (new) | Recovery behavior and native D1 concurrency/rollback tests. |
| `workers/fb-feed/worker.test.js` | Replace the SQL-string mock with the real transactional fixture. |
| `workers/fb-feed/ai.test.js`, `workers/fb-feed/current-day.test.js` | Assert the new retryable error and expired-state behavior. |
| `tests/specials-fixture.mjs`, `tests/sqlite-specials.py` | Apply recovery schema and support testing the pre-migration database. |
| `docs/facebook-specials-auto.md` | Lifecycle, limitations, validation and manual release steps. |

## Related Documentation

- [Mexican Night Automation](MEXICAN_NIGHT_AUTOMATION.md) — Mexican Night section lifecycle and migration history
