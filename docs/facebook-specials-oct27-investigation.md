# October 27 investigation, local fixes and deployment gate

## Resumed authorized release — preflight passed

The user refreshed local Wrangler OAuth and explicitly authorized the Worker-first
release, followed by merging/pushing main and the existing GitHub Actions Pages
deployment. No manual Pages deployment, migration, historical replay, real approval,
protected-special correction or runtime variable change is authorized.

At `2026-10-27T23:02:55Z`, read-only production checks using the refreshed credential
and account `a79e3b4a2bb8dad70c75bceac4b1d3f9` passed. All seven protected slots,
including all six externally corrected sandwiches and their locks, match the latest
baseline. Schema, all 26 migration-ledger entries, Worker settings/schedules and the
previous deployment match. The saved week remains revision 14. Private evidence is
in ignored `.wrangler/oct27-release-preflight.json`.

A fresh private D1 export was restored locally and verified at `23:04:55Z`:
729,402 bytes, SHA-256
`14201923017e1101d38c8cc2c3aad8ae9f7b5c5ea4325d3421309cbd5f1c6665`.
Integrity and foreign-key checks passed; all 22 table counts, schema, migration
ledger and protected rows match production. The backup directory ACL permits only
the owner and SYSTEM, beneath the existing private backup directory. Its location
and verification evidence remain private. A local comparison initially rejected
identical SQLite rows because of their JavaScript object prototypes; normalizing
that local comparison verified the same original export without repeating it.
There was no production restore or D1 data write.

Locked `npm ci`, Astro check (0 errors, 0 warnings, 12 existing hints), build and
Worker dry-run passed. npm's existing dependency audit reports 19 findings,
including the Astro/Sharp AVIF advisory GHSA-26w7-cxv4-gfx2. Inspection confirms the
Cloudflare adapter's production `compile` image endpoint proxies same-origin bytes
and does not call Sharp; there are no Astro Image/Picture transformations in this
application. This release does not introduce runtime AVIF optimization. Existing
dependency maintenance remains the separate Astro upgrade already tracked in
`POST_LAUNCH_CHECKLIST.md`; no dependency or lockfile changes are included here.
The fresh complete application suite passed **226/226** and the Worker suite
passed **1,366/1,366**, with no failures, cancellations or skips. Logs are retained
in ignored `.wrangler/oct27-release-{app,worker}-tests.log`. Existing staff sessions
successfully read Automation Review. Alert health has zero incomplete scans,
pending/failed evaluations, uncertain sends, actionable unsent alerts or send
failures. Fresh origin/main still matches implementation baseline `1dd1fce` and
the existing Pages workflow is active. Deployed versions are recorded below when
available. The earlier authentication failure below is historical and resolved.

## Authorized release attempt — stopped at authentication preflight

On October 27 the user explicitly authorized the production release, Git commit,
push and safe task-branch cleanup, conditional on the documented safety checks.
That authorization supersedes the earlier deployment stop for those operations;
historical import replay, real approval tests and manual production D1 corrections
remain unauthorized.

The latest `CLAUDE.md`, this report, working tree, branch, HEAD, remote and release
workflow were inspected. A fresh `git fetch origin --prune` succeeded. Both HEAD
and `origin/main` remain `1dd1fce`; no upstream divergence or Git conflict was found.
The task set contains 24 files when the two poster fixtures are counted separately.
The Pages workflow runs on pushes to `main`, so a manual Pages deployment must not
duplicate that trigger. The established release order remains Worker first, then
one website release path.

**The first fresh production preflight failed.** Cloudflare rejected the existing
OAuth credential on the read-only D1 query endpoint for `grayzn-db`
(`c998bfd4-7031-4ae2-9eea-df86f16ddb15`), returning **API error 10000,
"Authentication error"**. No source snapshot was obtained in this release attempt.
Consequently the current six sandwich values, October 27 corrections, locks,
production settings and backup freshness could not be reverified. The prior
5:17 PM snapshot below remains historical evidence, not a fresh release check.

Per the user's explicit stop-on-preflight-failure instruction, the release stopped
immediately. No backup export or restore, Git staging/commit/push/merge, deployment,
branch cleanup, production D1 write, migration, environment change, import replay,
real approval or test notification occurred. Only this documentation entry and an
ignored local read-only inspection script were added during the release attempt.

Cloudflare reauthentication for the production account is required before resuming.
After access is restored, repeat the fresh production preflight and obtain/verify
the authorized fresh private backup before any commit, push or deployment. Do not
skip the failed gate or delete the task branch while the work remains unmerged.

Production inspection was read-only on October 27, 2026. No import was replayed,
approved, or changed. No production deployment, migration, unlock, or write ran.
Private evidence is retained in ignored `.wrangler/oct27-production-before.json`,
the two `oct27-poster-*.jpg` source images, and `oct27-deployed-worker.txt`.

## Repository baseline

The clean checkout started at `d9e2ec9` on `codex/facebook-automation-alerts`.
Freshly fetched `origin/main` is `1dd1fce`, a descendant containing Automation
Review and newer event, delivery, alert, and reconciliation changes absent from
the initial checkout. The user explicitly authorized a fast-forward, which
completed without discarding the report or other work. Implementation is based
on `1dd1fce`. No commit, push, branch replacement or production deployment occurred.

## Daily import

Source: https://www.facebook.com/1664619028539308/posts/1746887030312507

Import `81f2184402ed86ee1bcde26882c032af`, created `2026-10-27T15:04:39+0000`,
staged with validation `ok` and two per-offer issues. Audit events 509 and 512
retain both AI readings. Events 513–516 retain validation and reconciliation.

The first reading marked only Grilled Ham and Cheese uncertain. The retry also
marked Bacon Cheeseburger uncertain. Both warnings question whether the price
printed before a continuation line belongs to the meal or its included side.
The final extraction contains:

- Gyro Sandwich with Beer Fries & a Drink $9.75; service `11-1:30`.
- Bacon Cheeseburger with Side Salad, $10.25 Soup or Coleslaw; uncertain.
- Grilled Ham and Cheese with a Cup of Soup or Coleslaw $7.25; uncertain;
  verbatim evidence places `$7.25` before `Soup or Coleslaw`.

Visual inspection establishes one right-aligned amount for each complete bullet.
There is no separately priced side. The warning arose from linear text order
losing the poster's two-dimensional association. The established Tuesday daytime
layout establishes Lunch followed by two All Day offers. Uncertainty correctly
prevented the current code from publishing those flagged offers; it should not
be erased indiscriminately. Extraction guidance and deterministic presentation
need to distinguish a wrapped meal from genuinely ambiguous price associations.

The reconciliation audit records two blocked All Day proposals and zero writes
in that batch. This does not establish which earlier operation populated Lunch.
The current saved database cannot be used as a pre-failure snapshot.

Exact-text matching was not the blocker. Existing `safe()` logic already permits
unlocked recurring defaults (`origin='manual', manual_locked=0`) to be replaced
without a dish-name match. Repeated-offer identity logic has a separate purpose.

Both currently populated All Day slots are `origin='manual', manual_locked=1`.
Their exact values are retained privately for a final read-only comparison.

## Mexican Night import

Source: https://www.facebook.com/1664619028539308/posts/1747196153614928

Import `6102c9a98f8f1941c2277f43365b21b4`, created `2026-10-27T20:44:38+0000`,
failed with `Mexican Night item facts differ from original evidence` and null
candidate JSON. Both readings, retained in events 520 and 523, contain **zero
uncertainty flags on all 12 menu entries**.

The first reading's first five entree evidence fields contained only headings
and prices, omitting their descriptions. The original fact checker therefore
correctly required a reread. The retry supplied that missing evidence.

The exact failed item in the retry is Taco Salad. Its extracted title contains bare
prices `$9.00 | $8.50 | $6.00`; the description includes the printed labeled run
`Large $9.00 • Small $8.50 • Mini $6.00`. `labelBareSizePrices()` adds those labels
to the title. `sameMenuItemFacts()` subsequently compares that title plus the
unchanged description against original evidence. Labels now occur twice in the
proposed text and once in evidence, so its word multiset comparison fails. This
was reproduced locally; the other 11 entries pass the same comparison.

The deployed retry used the general schema for this fact-check failure. Only a
specific size-label validation error selected the Mexican targeted repair.
The retry fixed the description-evidence omissions but repeated the same Taco
Salad representation, leaving the deterministic normalization problem unresolved.

The public price-free menu is the retained recurring fallback, not evidence that
prices were deleted. The live collection is revision 12, `section_source='recurring'`,
week start October 26, service date October 27. No successful Mexican publication
audit exists for this import.

The review's “Uncertain extracted offer (2 items)” comes from daily reconciliation
events 526/528 attached to the Mexican import as well as the daily source. Those
two proposals concern the daily All Day offers, not Mexican menu items. Review
outcome and audit attribution need to respect dedicated source scope.

### Image verification

The archived image confirms these prices and associations:

| Entry | Amount |
|---|---|
| 2 Soft Shell | $7.75 |
| Enchilada | $9.25 |
| Burrito | $10.25 |
| Nacho Deluxe | $9.75 |
| Chimichanga | $12.25 |
| Taco Salad Large / Small / Mini | $9.00 / $8.50 / $6.00 |
| Chips & Salsa or Chips & Cheese | $4.00 |
| Substitute chicken | $1.50 |
| Add Nacho Cheese | $1.50 |
| Substitute Queso | 50c |
| Substitute Shredded Cheese for Nacho Cheese | 50c |
| Add nacho cheese or salsa, beneath the chips offer | +$1.50 |

The descriptions match the printed item associations. Burrito's unusual printed
description actually begins “lettuce, onion, and tomato”; do not insert remembered
meat/beans ingredients. The final chips add-on's association must remain available
even when stored in an accessory group. Taco Salad's repeated bare/labeled price
lines are presentation redundancy, not six distinct portion choices.

## Actual production configuration

- Worker active version: `82921dcb-4dc3-45c3-8864-8a945dbc16f9`, deployed
  October 27 at `00:39:14Z`.
- `SPECIALS_IMPORT_MODE=GUARDED_AUTO`, evidence contract 2, conditional verification,
  model `@cf/google/gemma-4-26b-a4b-it`, daily AI limit 50.
- Cron `*/30 * * * *`, webhook RUN, special events AUTO.
- Alerts EMAIL through RESEND, approved flag true. Preserve these settings.
- Production migration ledger includes 0023, 0024 and 0025. The old checkout is
  missing migration 0025 and corresponding event code; never deploy from it.

## Implemented behavior

### Daily automation and defaults

The prompt now explains complete visual bullets, right-aligned prices and wrapped
side choices. A single price's linear placement alone does not justify uncertainty.
Real unreadability, multiple amounts or unclear meal boundaries still require a
hold. Existing October 27 uncertainties are not automatically erased or replayed.

`trailingDailyPrice()` moves one established meal amount to the end without
rewriting words, choices or amounts. Malformed prices, ranges, multiple prices,
modifiers and unit prices retain their existing handling. Wing Night and the
separate Mexican item contract remain intact. Formatting is idempotent and raw
`extracted_json` remains unchanged.

Default replacement already had the correct ownership rule; it was not changed
to require dish matching. Tests establish different unlocked recurring meals
are replaceable while manual corrections survive. Repeated-offer matching remains
independent. Review comparison copy now explicitly says identical text is not
required to replace an unlocked recurring default.

### Mexican Night

Fact comparison runs against the original title/description before presentation.
Size labels can be recovered only from the item's own matching price evidence.
An exactly matching, redundant terminal size-price run moves out of the description
once its labels are in the title. Ingredients and original evidence remain intact.
Swapped portions, missing facts and uncertain items still reject the complete menu.

All Mexican validation failures now request a focused, complete-menu reread,
retaining the requirement to inspect the original image. A regression runs the
two actual readings through the full Worker pipeline, verifies all 12 priced
entries, confirms no daily audit is misattributed to the Mexican import, and
checks repeat idempotence. No partial automatic Mexican menu publication was added.
Existing merge, fallback, ownership and Tuesday visibility rules remain in use.

### Direct staff approval

Today's supported daily and Mexican imports have editable approval panels in
Automation Review. Daily offers have individual selection, service/position
controls, current destination values, original extracted evidence and warnings.
Mexican Night has editable item/price titles and descriptions, retained groups,
and complete-menu approval. Unadvertised saved entries are retained; existing
groups and unselected positions are not cleared.

Staff verify the Facebook source, request a server-validated preview, inspect
exact before/after replacements, then click **Approve & Publish**. Different
protected values require a separate explicit override for each affected item.
The preview cannot write. Stale/error responses leave the browser draft intact.
Successful publication reloads current saved values and review status. Duplicate
request IDs return the original successful result without another write.
Thirty daily approval panels share seven D1 reads beyond the base review query
set, rather than rereading the same collection for each import. A regression
checks that budget and verifies cached GET and fresh POST evidence hashes agree.

The new operation does not call the older whole-group `applyCandidate()` helper.
It uses one D1 transaction with collection revision compare-and-swap, exact
collection/group/slot snapshots, source extraction/candidate guards, current-date
checks, unique destinations, and newer-import rejection. All dependent writes
require the successful claim's unique mutation token. Real local D1 concurrency
tests verify only one competing approval commits values and its receipt.

The API requires authenticated staff, same-origin JSON POSTs, bounded request
bodies and server-side validation. It loads source evidence from D1 rather than
accepting client-provided source facts. Approved prices must be supported by the
stored entry's original evidence, including size-price pairings; unsupported new
amounts still require the regular Specials editor. A wrongly formatted content
price can be corrected directly to its retained evidence amount. This deliberately
does not provide a factual-validation bypass.

Approved values are manual and locked. The existing import audit stores the
request ID, entry keys, import association, destination, before/after values,
revision, overrides and timestamp. Authentication supplies a shared staff session,
not a reliable named individual, so the audit does not invent a staff name.
No new tables or migrations are required. Existing import/audit retention applies.

Complete approval marks the source accepted and retains its independent delivery
evidence. Audited, unchanged protected destinations resolve their own AI issues in
the transient daily planner; original evidence stays immutable and unselected
uncertainties remain. A later change to a protected value invalidates that matching
approval evidence. The existing alert snapshot fences and deduplication remain.

Notifications now direct staff to Approve & Publish and include safe authenticated
review-entry deep links. Historical daily batch events are ignored when determining
the outcome of a dedicated Mexican/weekly import; future daily audits are attached
only to sources actually evaluated as daily evidence.

### Recurring Defaults preset removal

The Daily Sandwich Preset select, both hardcoded options, per-day preset markers,
event handler and obsolete preset CSS were removed. Both All Day fields remain
editable for all seven days. No migration, automatic rewrite or preset replacement
was introduced. Tests confirm GET does not mutate values, direct description/side/
price edits work, saved weeks remain unchanged and future new weeks inherit the
edited unlocked defaults.

## Interface verification

Headless Edge exercised the compiled page and actual approval handler through a
fixture-only localhost server, backed by a disposable SQLite database. Widths:
320, 360, 390, 430 and 1280 pixels. Each width passed document/dialog horizontal
overflow checks, displayed all 12 Mexican entries in confirmation, and preserved
the draft when Escape closed the daily preview. A real local staff publication
then reloaded the success message, protected saved value and partial review status.
No browser page errors occurred. Screenshots were visually inspected; excess
inherited section spacing and initial modal focus were corrected and reverified.
The modal is centered, begins at its heading, scrolls within the viewport, traps
focus natively, and exposes the confirmation buttons through scrolling/keyboard
navigation above the fixed admin navigation.

Private screenshots/results: `.wrangler/oct27-approval-*.png`,
`.wrangler/oct27-mexican-*.png`, `.wrangler/oct27-browser-results.json`.

## Final production preservation check

The final read-only snapshot was taken at **5:17 PM CDT, October 27**. Production
changed concurrently during this task: the saved week advanced from revision 13
to 14, and the second All Day sandwich values on Sunday, Tuesday, Wednesday,
Thursday, Friday and Saturday were updated. Each now reads `Grilled Ham and Cheese
with a Cup of Soup or Coleslaw $7.25`. All seven originally protected slots retain
manual ownership and their locks. Tuesday's first All Day correction is unchanged.
Mexican Night remains the same recurring section, revision 12. The migration ledger
and active Worker deployment are unchanged.

No production write was issued by this task. The change's external actor was not
identified by the shared-password authentication/audit model. Therefore the honest
verification result is **locks preserved, concurrent saved-value changes observed**,
not a claim that all production values stayed byte-for-byte unchanged. Preserve the
newer values; do not restore the initial snapshot. Private before/after snapshots
and `.wrangler/oct27-production-comparison.json` retain the evidence.

## Verification results

Verification used bundled Node **24.22.1**, which satisfies the repository engine
requirement. All final checks below passed:

| Check | Result | Private evidence |
|---|---|---|
| Complete Worker suite | **1,366 passed, 0 failed/skipped** | `.wrangler/oct27-worker-complete.log` |
| Complete application suite | **225 passed, 0 failed/skipped** | `.wrangler/oct27-app-complete.log` |
| Final UI/library regressions after read batching | **36 passed, 0 failed/skipped**, including one additional query-budget test | `.wrangler/oct27-ui-library-verified.log` |
| Final alert/Resend contract | **34 passed** | `.wrangler/oct27-alerts-verified.log` |
| Real local D1 concurrent approvals | Passed; also included in complete application suite | `.wrangler/oct27-approval-d1.log` |
| Production build | Passed | `.wrangler/oct27-build-delivery.log` |
| Astro check | 0 errors, 0 warnings; pre-existing hints remain | `.wrangler/oct27-astro-delivery.log` |
| New approval library/API TypeScript check | Passed, no diagnostics | `.wrangler/oct27-types-delivery.log` |
| Worker dry-run bundle | Passed; no upload/deployment | `.wrangler/oct27-dryrun-delivery.log` |
| Headless Edge | Five widths passed, no page errors; fixture publication succeeded | `.wrangler/oct27-browser-results.json` |
| Final diff whitespace check | Passed | `git diff --check` |

Initial sandbox runs failed existing Miniflare tests because localhost connections
were denied; rerunning with localhost access resolved those failures. Earlier
functional regression failures were fixed and rerun, including preservation of
the dedicated-shape failure audit and the new alert-link contract. There are no
unresolved test failures. Targeted totals overlap full suites and should not be
added to them as if all tests were distinct.

All write tests use synthetic disposable SQLite/Miniflare D1 databases. Resend,
Meta and AI calls in regression tests are intercepted. No test sends real email,
replays a production import or writes to production D1.

## Files changed

- `src/lib/automation-approval.ts` — source-backed planning and atomic targeted approval.
- `src/lib/automation-review.ts` — scoped outcome, approval status and comparison text.
- `src/components/AutomationApproval.astro` — editable review and confirmation interface.
- `src/pages/admin/automation/approve.ts` — authenticated, origin-checked approval API.
- `src/pages/admin/automation.astro` — approval panels, notices and historical read-only state.
- `src/pages/admin/specials.astro` — preset-only UI/behavior removal.
- `workers/fb-feed/staff-review.js` — audit parsing and exact protected-value confirmation.
- `workers/fb-feed/evidence.js` — lossless daily/size presentation and fact comparison.
- `workers/fb-feed/reconcile.js` — formatting contracts and Mexican normalization.
- `workers/fb-feed/extraction.js` — visual-price guidance and focused complete-menu repair.
- `workers/fb-feed/worker.js` — validate original Mexican facts before formatting.
- `workers/fb-feed/guarded-auto.js` — scoped audits and confirmed-offer handling.
- `workers/fb-feed/alert-detail.js` — review-entry links and approval guidance.
- `workers/fb-feed/alert-detail.test.js` — updated complete notification contract.
- `workers/fb-feed/alert-resend.test.js` — updated mocked email contract.
- `workers/fb-feed/oct27-regression.test.js` — original readings and automation regressions.
- `tests/automation-approval.test.mjs` — targeting, facts, locks, races, audit and delivery.
- `tests/automation-approval-http.test.mjs` — authorization, origin, body limits and requests.
- `tests/automation-approval-d1.test.mjs` — real local D1 concurrent transactions.
- `tests/recurring-default-fields.test.mjs` — preset removal and future-week-only edits.
- `tests/fixtures/oct27-production.json` — retained public-menu extraction readings.
- `tests/fixtures/oct27-daily.jpg` and `oct27-mexican.jpg` — inspected original posters.
- `docs/facebook-specials-oct27-investigation.md` — this report and release procedure.

## Deployment gate and exact proposed operations

The original implementation stopped before deployment; the explicit resumed
release authorization above now governs deployment. No migration, new runtime
variable, parser-version increment or dependency upgrade is required. The additive
approval audit uses the existing normalized schema and import events. Production
already has migrations 0015–0025; do not reapply them.

Only after explicit release authorization:

1. Review/commit the complete change set, including the new source files and
   fixtures. Fetch upstream and stop for conflicting or unreviewed concurrent work.
   Keep the current protected production values, including the revision-14 edits.
2. Verify the production account, database ID, migration ledger, active Worker,
   Pages project and all bindings/settings using read-only inspection. Compare
   against current production, not only this report's snapshot. Stop on drift.
   Verify a fresh private export with a local restore. Production restore remains
   unauthorized.
3. With supported Node (`.nvmrc`; verification used bundled Node 24.22.1), run:

   ```powershell
   npm ci
   npx astro check
   npm run build
   node --test --test-concurrency=8 tests/*.test.mjs
   node --test --test-concurrency=12 workers/fb-feed/*.test.js
   npx wrangler deploy --dry-run --config workers/fb-feed/wrangler.toml
   ```

4. Deploy the reviewed Worker, preserving verified production variables:

   ```powershell
   npx wrangler deploy --config workers/fb-feed/wrangler.toml --keep-vars
   ```

   Confirm D1, KV, R2, queue, cron, webhook, AI, delivery, events and Resend settings
   match the approved preflight. Keep evidence parser 19. Do not reset imports,
   clear locks, change recurring defaults or trigger historical recovery.
5. Merge and push the matching reviewed release to `main`. The existing GitHub
   workflow deploys Pages on that push. Wait for its successful deployment and
   verify its commit; do not deploy Pages manually or run the workflow twice.
6. Record both deployed versions and complete the checklist below. Stop on any
   failed integrity, ownership, concurrency or display check. Roll back application
   artifacts to their recorded prior versions if needed; retain D1 data and audit
   history. A database restore needs separate authorization.

### Post-deployment verification checklist

- Confirm existing protected daily corrections and recurring defaults are unchanged
  from the immediate release preflight, and all staff locks remain set.
- Confirm no October 27 import was replayed, approved, unlocked or republished.
- Confirm Mexican Night's fallback/prices and Tuesday visibility are consistent
  with its actual saved source; do not approve the held import as a release test.
- Confirm unauthenticated/expired sessions cannot read staff pages or publish;
  missing/foreign Origin and unsupported request bodies reject.
- Review a current eligible import: source link, original facts, complete prices,
  warnings, service/slot selection and full before/after preview must agree.
- Obtain separate staff authorization before any live approval test. Confirm only
  selected daily destinations change, or the intentionally approved complete Mexican
  menu changes; unrelated slots/groups survive and approved values become locked.
- Confirm a stale revision fails without partial writes, duplicates do not publish
  twice, and the audit/review status and refreshed values match the decision.
- Confirm full food approval preserves independent delivery evidence and resolved
  content does not generate a fresh repeated alert without a new problem.
- On the next genuinely new poster, inspect reliable auto publication, trailing
  daily prices, complete Mexican prices/portion labels, and actual source audit.
- Check mobile widths and desktop, keyboard confirmation, staff logout, analytics,
  event rendering and existing delivery behavior. No email is sent as a test unless
  separately authorized; verify provider behavior from existing delivery records.

## Remaining limits

This is locally verified code, not a deployed repair. No live AI inference was
charged; tests replay the stored readings with mocked AI. Future model behavior
cannot be guaranteed by prompt changes, so real uncertainty still goes to review.
Unsupported prices or facts missing from retained evidence require the normal
Specials editor rather than bypassing approval validation. Historical imports
cannot be approved into today's menu. Shared-password authentication cannot
attribute changes to a named individual. Production changed concurrently, as
documented above; the initial saved week is not a restoration baseline.
