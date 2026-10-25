# Facebook alerts production preflight — 2026-10-24

> Local remediation update (October 24): the three findings below have been corrected locally with permanent regression coverage. The final design uses atomic business-snapshot comparisons, NOT triggers. Final validation and the revised recovery/rollout conditions are recorded in the remediation section at the end. Production activation remains BLOCKED by operational prerequisites and requires separate authorization. The original preflight below is retained as history.

## Verdict: BLOCKED

This read-only production preflight supersedes earlier readiness wording in the two implementation documents. Increments 1–3 are implemented and previously validated for current-day daily/delivery outcomes, but three newly reproduced defects block release approval. No application code was changed during this review. Notifications remain OFF/unconfigured locally and in the inspected production Worker. No production migrations, email, deployments, configuration changes, commits or pushes were performed.

### Findings requiring local remediation and regression coverage

1. **P1: unresolved sends can overlap after lease expiration.** `alert-store.js:84–132` claims for five minutes and awaits transport. `alert-email.js:9–17` checks the supplied abort signal only before calling the native binding; the signal does not bound or cancel that call. Holding the first mocked provider call open, advancing the clock past five minutes and dispatching again produces TWO provider calls for the same incident. This is more than the already documented crash-after-acceptance ambiguity. A stalled send also delays completion of the import pipeline that awaits it. Establish a bounded dispatch lifecycle and a deliberate durable policy for uncertain provider acceptance; a Promise timeout alone cannot cancel the underlying email and must not make it immediately retryable. Test overlapping executions, slow acceptance, lease expiry, process loss and acknowledgement failure. Do not promise exactly-once external delivery without provider support.
2. **P1: staff acknowledgement can become stale before final dispatch.** `alert-runtime.js:149–154` hashes/reassesses business state, but the final SQL at `alert-store.js:108–113` checks only incident/scan state. A staff dismissal committed after revalidation but before that SQL still permits a send. Reproduced with one mocked notification. Tie final eligibility to guarded business-state evidence or a shared generation/fence updated by relevant writers, with explicit concurrency semantics. A further unguarded read merely narrows the race. External transport cannot be atomic with D1; document the final decision boundary and residual post-decision changes honestly.
3. **P2: heartbeat does not certify successful alert evaluation.** `finishAlertScan` sets `completed_ms` before snapshots, assessment and incident persistence (`alert-runtime.js:190–200`). Injecting a snapshot failure leaves a fresh `last_completed_ms`, zero incomplete scans and no incident. The fixed error log helps only if an independent monitor sees it. Separate Graph-fetch completion from successful alert evaluation, or expose durable evaluation failure/completion health; test read/write/assessment failures and early returns before calling this a healthy alert cycle.

Review-only reproduction: `node .wrangler/alerts-preflight-repro.mjs`; output `.wrangler/alerts-preflight-repro.log`. Three assertions pass because they demonstrate the defects, NOT because the desired behavior passes. The first attempt failed to resolve Miniflare from a data URL; the local harness was corrected and the final three checks completed successfully. All business state was disposable SQLite and email/Graph/AI were mocked. These ignored diagnostic files are local evidence, not committed regression coverage; preserve them for the next local remediation or convert the scenarios into permanent tests.

No additional secret leakage or unsafe SQL interpolation was identified in the reviewed alert payload/telemetry paths. This is a scoped review, not a security certification. The existing fixed messages do not contain source text, tokens, provider errors or recipient addresses. Dedicated weekly-lunch/Mexican Night per-offer completeness and unknown image-only omissions remain outside the alert coverage contract; successful existing publication behavior was not changed by this review.

## Source and validation checkpoint

Branch `main`; HEAD and freshly fetched `origin/main`: `ae2d8add8c6b76445adfd0e6c2b02891058ae63d`. Initial diff: five tracked files, 139 insertions/18 deletions; thirteen untracked task files. Reviewed all eighteen files below. Pre-existing files were preserved. No concurrent source changes were observed during preflight; recheck status/hashes before subsequent editing.

Modified tracked files:

- `workers/fb-feed/delivery.js`
- `workers/fb-feed/guarded-auto.js`
- `workers/fb-feed/oct21-regression.test.js`
- `workers/fb-feed/oct22-delivery.test.js`
- `workers/fb-feed/worker.js`

Existing untracked files:

- `docs/facebook-alerts-progress.md`
- `docs/facebook-automation-alerts.md`
- `migrations/0023_facebook_alert_incidents.sql`
- `migrations/0024_facebook_alert_evidence.sql`
- `workers/fb-feed/alert-email.js`
- `workers/fb-feed/alert-outcomes.js`
- `workers/fb-feed/alert-outcomes.test.js`
- `workers/fb-feed/alert-policy.js`
- `workers/fb-feed/alert-runtime.js`
- `workers/fb-feed/alert-runtime.test.js`
- `workers/fb-feed/alert-store.js`
- `workers/fb-feed/alerts-d1.test.js`
- `workers/fb-feed/alerts.test.js`

This preflight adds this nineteenth task file and appends a superseding checkpoint to both existing documents. Expected final status: five modified tracked + fourteen untracked files. Ignored `.wrangler/alerts-preflight-*` diagnostics/read-only outputs are additional local artifacts, not release source. Some provider CLI diagnostics contain account identity metadata; keep them private and do not commit logs wholesale.

Previous implementation validation (not rerun in this read-only review): Worker **1,131**, application **150**, focused alerts **62**, all passed; build, Astro check and Wrangler dry run passed. The 1,131 count is 1,101 + 30 runtime tests. Preflight executed three additional defect reproductions and `git diff --check`; it did not change or replace those suites. The new reproductions do not increase the permanent suite count.

## Production evidence and unresolved configuration

- Live Worker inspected: `grayzn-fb-feed`, 100% version `a37829f3-6063-4d8c-83a7-45d270a27062`, deployment timestamp `2026-10-22T19:28:30.364Z`. Refresh before rollout; this is not a guarantee it remains current.
- Account is the existing Worker-config account ending `b1d3f9`. Database `grayzn-db`, ID `c998bfd4-7031-4ae2-9eea-df86f16ddb15`, is shared with the application. Use the root `wrangler.toml` for the root migration directory; explicitly select the verified account because root config does not set `account_id`.
- Production ledger contains filenames **0020, 0021 and 0022**, all with recorded applied time `2026-10-19 00:51:52`. Numeric ledger row **id 23 is migration 0022**, not migration filename 0023. Recovery columns/index from 0021 and the 0022 delivery table exist. `special_migration_checks` version 15 reports zero mismatches. Ledger timestamps alone do not prove how the separate reconciliation occurred or prove every 0020 data effect. Do not rewrite tracking or replay 0020–0022; coordinate a fresh checkpoint with that workstream before any migration.
- Neither alert table exists; neither 0023 nor 0024 appears in tracking. Wrangler pending list contains exactly `0023_facebook_alert_incidents.sql`, then `0024_facebook_alert_evidence.sql`. Schema/ledger SELECT results reported zero rows written. 0023 creates only incidents/index; 0024 adds `proof_json` and scans, and requires 0023. 0024 is not idempotent. Both preserve existing business data by design; rehearse against a current backup to verify compatibility.
- D1 Time Travel returned a current bookmark, stored privately in `.wrangler/alerts-preflight-time-travel.json`. This confirms bookmark availability, NOT a verified export or successful restore. No backup export or restore rehearsal was performed. The initial root-config query failed account selection; repeating with the existing verified account succeeded without config edits.
- Production settings contain no alert mode/approval vars and **zero send_email bindings**. The account's routing destination list returned zero entries/verified recipients. Zone Email Routing reports disabled/unconfigured. This does not by itself establish every Email Service sender-domain prerequisite; sender onboarding remains unverified. The user-approved recipient is recorded in the conversation, for actionable failures only; configure privately, never in versioned config or diagnostics.
- Observability/persisted invocation logging is enabled with sampling 1; traces are disabled. Alerting types/policies reads returned **403**. Independent monitoring entitlement/configuration is therefore **unverified**, not proven absent. Resolve access or inspect through an authorized account; do not presume a paid plan is needed or authorized.
- OFF skips alert work. OBSERVE records evidence/incidents without dispatch. MOCK requires an injected function. EMAIL additionally requires approval flag, addresses and binding. The flag is an application gate, not proof of verified recipient or inbox delivery. Provider acceptance is not receipt.
- Native structured binding references: [Workers send API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) and [send binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/). No documented cancellation/idempotency facility in the used call establishes exactly-once delivery. Recheck official documentation when implementing the remedy or configuring production.

## Ordered rollout plan — NOT EXECUTED

Each gate requires evidence and explicit authorization for its mutations. Stop on any failed or ambiguous verification. Do not use this plan as authorization to act.

### 1. Local fixes, checkpoint and source control

Obtain authorization to remediate the three findings locally. Preserve all nineteen task files and unrelated work; inspect Git status/diff and current file hashes before editing. Add permanent regressions, rerun full Worker/application suites, focused alerts, Astro build/check, dry run and whitespace validation using commands in the progress checkpoint. Review changed migration needs again if remediation changes schema. Keep OFF and all delivery mocked.

After separate commit authorization, make a reviewed source checkpoint with explicit file selection on an approved branch; do not stage unrelated changes or ignored logs. Record commit and artifact hashes for deployed source. Do not push `main`: `.github/workflows/deploy.yaml` automatically deploys Pages on pushes there. Worker release and Pages release are separate decisions. Stop unless tests pass, findings are resolved/reviewed, and external-delivery limitations are accepted.

### 2. Fresh production checkpoint and verified backup

Re-read live Worker/version/bindings, schema, ledger, pending migrations and separate reconciliation status. Record existing config privately without printing secrets. Resolve unexpected pending migrations, schema drift or concurrently active release work before proceeding.

For future approved shell commands set the process-only account selector to the exact `account_id` from `workers/fb-feed/wrangler.toml`; do not change root config merely to run the CLI. After approval for private backup handling, export using:

```powershell
npx wrangler d1 time-travel info grayzn-db --config wrangler.toml --json
npx wrangler d1 export grayzn-db --remote --config wrangler.toml --output <approved-private-backup-path.sql>
```

Record UTC time, database ID, bookmark, file size and SHA-256. Restore the export into an isolated local/disposable database, never production; verify integrity, schema, ledger and business-table counts against the export snapshot. Document retention and access protection because the export contains business data. Verify the actual Time Travel recovery window for this account. Stop if export/restore is incomplete or backup identity cannot be proved. A bookmark alone is insufficient.

### 3. Migration rehearsal and separately approved application

Apply 0023 then 0024 to the restored disposable database. Verify tables, `proof_json`, due index, scan primary key and unchanged business rows/counts. Confirm compatible old Worker behavior with additive tables. Recheck production pending list immediately before the authorized operation:

```powershell
npx wrangler d1 migrations list grayzn-db --remote --config wrangler.toml
# ONLY after explicit migration approval and exact two-file pending-list verification:
npx wrangler d1 migrations apply grayzn-db --remote --config wrangler.toml
```

Wrangler applies all pending migrations, so **stop if the list is anything other than the reviewed 0023 and 0024**. Do not use direct SQL execution to bypass migration tracking. Verify both filenames in the ledger and exact resulting schema after application. On any partial failure, inspect schema/tracking first; do not blindly replay non-idempotent 0024 or edit tracking to force progress. Leave business data intact. This is the first planned production-changing operation, after all preceding gates.

### 4. Deploy reviewed Worker with notifications OFF

After deployment/config authorization, ensure the reviewed deployment artifact explicitly keeps `SPECIALS_ALERT_MODE=OFF` and approval absent/false; no real send path should be reachable. Preserve existing bindings, routes, queues, import mode and business behavior. Dry-run the exact artifact, then only with authorization:

```powershell
npx wrangler deploy --config workers/fb-feed/wrangler.toml
```

Record resulting version and pre-release rollback version. Verify existing feed, normal scheduled/queue processing, publication/staff protections and absence of alert dispatch. Use normal traffic; do not fabricate production import failures or trigger broad replay. Stop on changed publication behavior, elevated errors or config drift. No Pages deployment is part of this operation.

### 5. OBSERVE validation

After explicit mode-change approval deploy the reviewed config with OBSERVE and approval false. Observe at least two scheduled cycles and the grace interval during eligible Chicago hours; delivery validation requires an eligible weekday before 3 PM, daily before 8 PM. Verify scan/evaluation completion, lifecycle transitions, current-day proof freshness, pending-retry quietness, recovery/staff suppression, no accepted sends and acceptable D1 overhead. Exercise failure/concurrency cases in isolated staging with mock email; lack of a real failure in production is not proof of coverage. Stop on stale candidates, misleading heartbeat, duplicates or publication changes.

### 6. Restricted email configuration and controlled receipt test

Obtain explicit configuration AND test-email approval. Verify the approved recipient, sender/domain and restricted `ALERT_EMAIL` binding through the actual Email Service setup. Keep production OBSERVE. Use an isolated test Worker and separate test D1 with the reviewed code and one synthetic actionable candidate, never the shared production business database. There is no reviewed one-shot production test endpoint today; prepare/review the harness before authorizing its execution. Do not turn production EMAIL on merely to test the binding because every eligible production candidate could send.

Authorize exactly the controlled message, confirm inbox receipt/sender/content and durable acknowledgement; confirm retries/failures/recovery with mocks and the reviewed uncertainty policy. Ensure no tokens, raw source or provider exceptions appear in content/logs. Remove/disable test dispatch afterward. Stop if only API acceptance is known, restrictions are unverified or duplicate/stale behavior occurs.

### 7. Independent monitoring and separate activation

Before activation, prove an independent route detects missing successful evaluations, Worker/D1 unavailability, dispatch failures/uncertain sends and queue/DLQ trouble. It must work when this Worker cannot run, D1 cannot be read or the alert email route fails; use an authorized independent delivery path. Resolve the 403 visibility gap. Test monitoring delivery and escalation ownership. Do not treat `completed_ms` as successful evaluation until finding 3 is fixed. Use content-free metrics; distinguish zero candidates from no heartbeat.

With explicit activation approval, review fresh pending candidates, proof age and delivery uncertainty, then deploy EMAIL plus `SPECIALS_ALERT_EMAIL_APPROVED=true` and verified restricted configuration. Monitor through multiple cycles/current-day cutoff and verify sent bookkeeping, quiet recovery, retries, ownership and existing publication behavior. Stop/disable on duplicates, stale notifications, lost heartbeat, import impact or unexplained dispatch errors. Success emails remain out of scope.

### 8. Recovery and rollback

First disable the mode and approval in a separately authorized deployment; an already invoked provider send cannot be recalled. Track in-flight/uncertain sends to prevent accidental resend on reactivation. If application regression persists, restore the exact freshly recorded pre-release Worker version through the reviewed Cloudflare rollback procedure, preserving its binding/config compatibility. Reverify active version and import/feed health.

Leave additive alert tables and sent history in place; old code does not require dropping them. Do not reset incidents to force a retry, rerun business migrations or restore the entire shared D1 merely to undo alert schema. Whole-database Time Travel/export restoration is a disaster-recovery operation requiring separate authorization and a plan to preserve staff/import writes since the backup. The safe ordinary rollback is code/config rollback plus retained data.

## Next authorization and handoff

**Next authorization requested: local remediation of the three reproduced readiness findings, with permanent regression tests and renewed review. No production-changing operation is recommended yet.** Expected local impact is alert dispatch/health logic and tests; business publication paths should remain unchanged. Preserve the current working tree and ignored reproductions. Do not start the separate October 22–23 incident fixes.

After the blockers, backup and rehearsal are cleared, the first production-changing operation requiring its own explicit approval is applying the reviewed additive 0023→0024 migrations to the verified database. Expected impact: two alert tables, one index and one additional incident column, no business-row changes. Ordinary rollback retains this additive schema and restores OFF/previous Worker; destructive schema or shared-database restoration is not an automatic rollback.


## Local blocker remediation — authoritative final design, 2026-10-24

This section supersedes the preflight's unresolved-code findings and prototype progress notes. Local implementation is complete; final full-suite results are recorded in the final verification entry below. Production activation remains BLOCKED pending review, backup/rehearsal, verified email configuration/receipt testing, independent monitoring and explicit authorization. No production actions are included in this remediation.

### 1. Bounded transport and durable uncertainty

The preparation lease remains five minutes and is reclaimable ONLY while dispatch_state is ready. Immediately before any provider invocation, an atomic UPDATE transitions ready -> uncertain, records authorized_ms and retains the attempt token. No other Worker can claim an uncertain or sent incident, regardless of lease expiry, repeated observations, recovery/recurrence or an interrupted process. A lost authorization response fails closed: the provider is not called, and the committed uncertainty remains for review.

The dispatcher waits at most five seconds per transport attempt (up to two candidates per invocation). The timer bounds the caller's wait, including a stalled acknowledgement write; it does NOT cancel the underlying email. Tests can inject a shorter bound, never a longer one. Late successful acceptance may acknowledge only the matching uncertain attempt as sent. A transport exception, absent acceptance receipt, timeout, process loss or failed/lost D1 acknowledgement leaves uncertainty. The safe stored error remains send_failed; raw provider messages are not persisted or logged. Uncertain records are exempt from retention and counted across days, including after business-state recovery.

There is intentionally NO automatic transport retry once invocation is authorized. The native provider interface cannot establish definite non-acceptance for arbitrary failures. Existing Facebook import retry safeguards are unchanged. This prioritizes avoiding duplicate provider calls over guaranteed notification delivery; an authorized attempt interrupted before invocation can also remain uncertain without any email being sent. sent records provider acceptance, NOT inbox receipt. No exactly-once external delivery claim is made.

### 2. Atomic business-state eligibility

Revalidation still reads a transactional snapshot, checks its SHA-256 against the durable proof and reassesses the current failure. It then supplies the complete transient evidence to the final UPDATE. That one statement checks the lease/token/proof/current evaluated scan and compares row counts and every selected column of all eight evidence rowsets: current source versions (including newer-version detection), current weeks, collections, groups, slots, delivery setting, delivery outcome and migration guards.

A committed dismissal, lock, recovery, new source version, deleted source, publication edit or override before this UPDATE prevents authorization. The UPDATE is the precise authorization boundary. Concurrent database writers serialize with that atomic decision; no extra unguarded SELECT is treated as authorization. Changes committed after authorization cannot recall an already authorized external send. Rolled-back changes do not invalidate otherwise matching evidence. Raw evidence is transient, parameter-bound and never added to the incident proof or telemetry. Fixed table/filter definitions and restricted database-derived column identifiers prevent SQL injection. Balanced comparisons respect D1's expression-depth limit.

The same evidence fence protects the atomic batch that persists both incident outcomes and successful evaluation. No trigger or business-writer modification is used. A prototype trigger-based approach was rejected by real local D1 testing because trigger side effects increase meta.changes and would alter existing guarded-write semantics. The final migrations contain no generation table or business triggers. D1 regressions now check normal successful publication, unchanged row-change counts and staff-lock protection, as well as concurrent notification claims and the original dismissal race.

### 3. Truthful evaluation health

completed_ms records completed source-scan context and does not certify alert evaluation. New evaluated_ms, evaluation_state and evaluation_error track pending/complete/failed/skipped evaluation separately. Both incident observations and successful evaluation commit in one D1 batch. A failing write rolls back the whole batch. Missing/changed evidence and a closing-window early return are durably skipped; assessment/read/write failures are durably failed where D1 remains writable. A newer scan token cannot be overwritten by an older completion/failure. Duplicate completion of the same already-complete token is ignored.

readAlertHealth.last_completed_ms now means successful evaluation, while last_scan_completed_ms reports source-scan completion. Separate pending_evaluations, failed_evaluations and skipped_evaluations distinguish zero candidates from unsuccessful assessment. uncertain_sends reports all retained uncertain attempts, independent of business resolution/date. Existing actionable and send_failures counts remain stored incident aggregates, not dispatch authorization.

A total D1 outage cannot durably record its own failure. In that case the scan remains pending/missing completion and the subsystem emits its fixed safe error. Independent monitoring must treat unreadable health, stale completion and pending/skipped/failed evaluations as unhealthy, not as zero actionable incidents. Successful observation with zero incidents is separately tested. Provider uncertainty does not erase a successful evaluation; independent monitoring must watch both evaluation health and dispatch uncertainty.

### Revised unapplied schema

- **0023** additionally defines dispatch_state (ready/uncertain/sent, default ready) and authorized_ms on facebook_alert_incidents. Existing business-state and last_error checks remain intact.
- **0024** still adds proof_json and creates facebook_alert_scans, now with evaluated_ms, evaluation_state (pending/complete/failed/skipped) and fixed evaluation_error codes. NO generation table or triggers remain in the final file.
- These are edits to LOCAL UNAPPLIED definitions, based on the preflight proving neither migration was deployed. No production migration state was changed. Freshly verify that fact before rollout. If either old definition has since been applied anywhere, STOP and design a separate forward migration; CREATE IF NOT EXISTS must never be used to hide a mismatched 0023 schema, and 0024 is not replay-safe.
- The prior migration review must be renewed for these definitions. Rehearse exact current files, validate column/default/check definitions, index and ledger, and preserve business-row contents. Migrations 0020–0022 and their separate tracking reconciliation remain untouched.

### Safe uncertain-send recovery procedure (future authorized operation only)

1. Keep notifications OFF while investigating. Preserve the incident, its attempt token, authorized_ms, sent_ms, business state and safe error. Record an operator audit/checkpoint outside the incident row; no reset/delete/retry is automatic.
2. Determine provider acceptance and whether the original execution or an external request can still finish. Inbox absence, timeout and lease expiry are NOT proof of non-acceptance. If outcome remains unknown, leave the row uncertain indefinitely and use independent escalation for the business issue. Ordinary business recovery does not clear this dispatch history.
3. If acceptance is positively confirmed, a separately reviewed/authorized guarded update may acknowledge the SAME attempt as sent without invoking the provider. If it already became sent through late acknowledgement, do nothing. Provider acceptance still does not guarantee inbox receipt.
4. Rearming is permitted only under separate explicit authorization after definite non-acceptance and termination of the old execution/request are established. Require matching incident/attempt token, uncertain state and null sent_ms; preserve an audit of the old attempt, then clear its authorization/lease and return to ready with a new full grace period. Normal current-day/fresh-proof/business-state authorization must still pass. Never rearm an unknown/in-flight attempt or force yesterday's incident into today's eligibility. No rearm endpoint or automatic repair job was added.

### Changes made in this remediation

Exactly eleven of the existing nineteen task files were edited:

- migrations/0023_facebook_alert_incidents.sql
- migrations/0024_facebook_alert_evidence.sql
- workers/fb-feed/alert-store.js
- workers/fb-feed/alert-runtime.js
- workers/fb-feed/alert-email.js (clarifies pre-invocation abort semantics)
- workers/fb-feed/alerts.test.js
- workers/fb-feed/alerts-d1.test.js
- workers/fb-feed/alert-runtime.test.js
- docs/facebook-alerts-production-readiness.md
- docs/facebook-alerts-progress.md
- docs/facebook-automation-alerts.md

All original five tracked modifications, including Worker integration and delivery fixes, were preserved unchanged by this remediation. The existing nineteen-file Git inventory remains five modified tracked plus fourteen untracked files, with no new release-source file. Preflight artifacts remain untouched. New ignored .wrangler/alerts5-* files are local test logs/bundles, not files to stage wholesale. main/HEAD/fresh origin/main remain ae2d8add8c6b76445adfd0e6c2b02891058ae63d; no commit, push, stash, reset, production configuration, D1 write, migration, deployment or real email occurred.

### Verification and next gate

Permanent regressions replace the archived preflight assertions with desired behavior: one mocked provider invocation across lease expiry; no dispatch for a dismissal committed before authorization (also real D1); no healthy evaluation after snapshot/assessment/persistence failure. Additional tests cover late acceptance/rejection, process loss, acknowledgement failure, lost authorization response, concurrent source/slot/group/week/collection/delivery/guard changes, atomic outcome rollback, total D1 write outage, early returns, retained uncertainty and normal publication/manual locks.

Final focused result: **93/93**, up from 62 by **31** new permanent tests. No original tests were removed; transport-failure expectations now assert quarantine instead of unsafe automatic resend. Application **150/150**. Build, Astro check (0 errors, 0 warnings, 6 existing hints), final dry run and whitespace validation pass. Full final Worker result is recorded below when its running validation completes. Earlier 91-focused/1,160-Worker runs preceded the final snapshot design and are superseded, not final release evidence. Initial sandbox EACCES, prototype trigger incompatibility, predicate-depth and fault-injection failures were resolved and retained in private logs for traceability.

Next safe step is review of the final code, tests, revised migrations and the conservative uncertain-send policy. The original eight rollout stages still apply AFTER review, with the new schema and health/recovery semantics above. Do not replay the prototype or restore an older alert-enabled prototype against the new uncertain rows: it did not honor dispatch_state. Ordinary rollback is OFF plus the freshly verified pre-alert production Worker, retaining alert tables/history. Whole-database restoration and any manual incident repair require separate authorization. Email setup/receipt, independent monitoring access (previously 403), backup/restore rehearsal and actual production activation remain unverified and unauthorized. No October 22–23 incident or special-event work is included.

## FINAL verified checkpoint — October 24, 2026 (resumed after usage-limit pause)

**READY for local code/schema review. All three identified code blockers are fixed and validated. Production activation remains BLOCKED pending operational prerequisites and explicit authorization.** Alerts remain OFF; no real email, production D1 write/migration, configuration change, deployment, commit or push occurred.

The resumed inspection found the same HEAD/origin/main ae2d8add8c6b76445adfd0e6c2b02891058ae63d, same nineteen-file inventory (5 modified tracked + 14 untracked), unchanged tracked diff (139 additions/18 deletions), and no evidence of intervening source changes. Latest runtime/store/email/migrations and documentation were reviewed again. The full Worker process had completed during the pause; its saved completion was verified rather than redundantly rerunning it. Preflight artifacts remain preserved with unchanged names/sizes.

Final results:

| Validation | Result | Local evidence |
| --- | --- | --- |
| Complete Worker suite, final runtime code | **1,162/1,162 passed**, 0 failed/cancelled/skipped | .wrangler/alerts5-worker-snapshot-final.log |
| Focused alerts, final tests including strengthened retention fixture | **93/93 passed**, 0 failed/cancelled/skipped | .wrangler/alerts5-focused-final-complete.log |
| Application suite | **150/150 passed**, 0 failed/cancelled/skipped | .wrangler/alerts5-app-final.log |
| Astro build | Passed | .wrangler/alerts5-build.log |
| Astro check | 0 errors, 0 warnings, 6 existing hints | .wrangler/alerts5-check.log |
| Final Worker dry run | Passed, no deployment | .wrangler/alerts5-dryrun-final.log |
| Git whitespace validation | Passed | git diff --check |

Worker count increased from 1,131 to 1,162, and focused alerts from 62 to 93: exactly **31 new permanent regressions**; no tests removed. Application count remains 150. The full Worker run used final production source; the only subsequent test change strengthened the old-day retention fixture without changing runtime code or test count. That test passed separately and the entire focused suite passed again after resumption. The earlier optional rerun was not executed because automatic approval review hit a usage limit (not a safety rejection); the resumed authorized rerun completed successfully. No failing tests or unfinished source changes remain.

The original three scenarios now assert the required behavior: unresolved transport makes one provider call even beyond lease expiry and returns control; a staff dismissal committed before the atomic authorization prevents sending (including real local D1); snapshot/assessment/persistence failures do not certify healthy evaluation. Extra tests cover process loss, late outcomes, lost acknowledgements/authorization responses, concurrent edits, real D1 limits/row-count semantics, atomic rollback, D1 outage, early returns, publication/manual locks and retention.

Changed-file summary remains the eleven files listed above: three alert implementation files, three alert test files, both unapplied migrations and all three documentation files. The original nineteen task files and unrelated tracked changes remain preserved. No release source changed during resumption; only this final documentation and the final focused test log were added/updated.

Remaining risks/limits: external acceptance cannot be transacted with D1 or recalled after authorization; an uncertain attempt can represent an accepted email OR an attempt that never reached the provider. It stays quarantined until evidence-backed, separately authorized operator action; exactly-once inbox delivery is not promised. A total D1 outage needs independent detection. Atomic snapshot comparison covers full selected rowsets and should be measured against production-sized restored data before rollout; unrelated edits may conservatively defer notification. Dedicated weekly/Mexican per-offer completeness and unknown-image omission coverage remain outside scope. Independent monitoring, verified recipient/sender/binding, real receipt testing and backup/restore rehearsal remain outstanding.

**Next step: user review of final code, conservative uncertainty recovery policy, and revised 0023/0024 definitions.** Renew the production preflight and migration rehearsal only under separate authorization. If any earlier migration definition has since been applied, stop and design a forward migration. Do not deploy or begin the separate October 22–23 incident work automatically.
