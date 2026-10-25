# Facebook alerts — resume checkpoint

Updated 2026-10-24. **Notifications remain disabled and NOT operational.** See the authoritative **2026-10-24 implementation checkpoint** and final verification at the end. Current-day daily/delivery terminal lifecycle, durable revalidation, Worker mocked dispatch, gated email adapter and local monitoring signals are implemented. Production configuration/approval and documented coverage limits remain. Earlier handoffs are historical.

## Baseline and boundaries

- Local main / HEAD and freshly fetched origin/main remain ae2d8add8c6b76445adfd0e6c2b02891058ae63d.
- All seven untracked increment-1 files were read and preserved. Five tracked files are now modified and nine task files remain untracked; exact inventory below.
- Last verified production baseline, from increment 1: Worker a37829f3-6063-4d8c-83a7-45d270a27062 at 100%; Pages fb10af37-af69-418b-8f57-e7624af41465 / ae2d8ad. Production was not re-queried this increment.
- No commits, pushes, deployments, production D1 operations, emails, subscriptions or Cloudflare configuration changes. No production migrations. No email configuration or independent monitoring work was started.
- Recipient was confirmed privately in this chat during increment 1. Do not copy the address into versioned documentation or infer it from account metadata. Activation still requires explicit approval.

## Completed increment 2

1. Delivery reconciliation returns structured per-scan/per-source outcomes while retaining the existing evidence decisions and write fences. Successful persistence, intended hidden state, pending work, withheld evidence, superseded writes, expiration and persistence exceptions are distinct.
2. A failed persistence operation is actionable only when independently validated current-day evidence establishes that automatic delivery should be active. Existing valid active delivery is not treated as an outage merely because a refresh failed. Historical failed imports, missing fields, cancellation, ambiguity and staff choices do not invent delivery evidence.
3. Daily reconciliation attaches a source/collection revision snapshot for evaluated proposals/rejections or verified pending work. This distinguishes actual publication from extraction status. Dedicated weekly/Mexican no-ops do not resolve daily incidents.
4. New alert-outcomes.js connects those results to alert-policy.js and alert-store.js. SPECIALS_ALERT_MODE must equal OBSERVE to record anything; missing/OFF/other values do not access the alert table. Wrangler config was not changed. Neither adapter invokes dispatchAlert or a real transport.
5. Conditional incident upserts atomically revalidate source evidence/status/review/parser/newer versions. Delivery also fences staff setting and saved delivery scan; daily publication fences collection revision and pending work. Old delayed results cannot overwrite a newer verified result. Same-timestamp recovery is accepted only with the database guards.
6. Normal outcomes create no incident rows. Recovery, suppression and pending observations update existing incidents only. Day/subsystem scopes (daily and delivery) deduplicate triggers. Known pending daily retries pause queued incidents. Staff-locked and uniquely disabled destinations are non-actionable. Existing alert grace/send-claim/backoff semantics are retained.
7. October 21 regression: current rejection -> pending retry -> successful publication resolves the incident while the original import remains failed/rejected; exactly one Lunch remains enforced. Staff revision invalidates an old result.
8. October 22 regression: a simulated delivery persistence failure creates a delivery incident while food still publishes; recovery resolves it without additional AI calls. Cancellation/no evidence/expiry and staff protections remain intact.

Durable information uses the existing delivery row, collection revision/audits and incident table. Raw source snapshots and per-source outcome detail remain transient, not email/log content. No extra schema was introduced; prepared migration 0023 is unchanged and remains unapplied in production.

## Exact file inventory

Modified tracked files:
- workers/fb-feed/delivery.js
- workers/fb-feed/guarded-auto.js
- workers/fb-feed/worker.js
- workers/fb-feed/oct21-regression.test.js
- workers/fb-feed/oct22-delivery.test.js

Updated files originally untracked from increment 1:
- docs/facebook-alerts-progress.md
- docs/facebook-automation-alerts.md
- workers/fb-feed/alert-policy.js
- workers/fb-feed/alert-store.js

Preserved unchanged from increment 1:
- migrations/0023_facebook_alert_incidents.sql
- workers/fb-feed/alerts.test.js
- workers/fb-feed/alerts-d1.test.js

New increment-2 files:
- workers/fb-feed/alert-outcomes.js
- workers/fb-feed/alert-outcomes.test.js

## Tests and results

| Check | Result |
| --- | --- |
| Full Worker suite | 1,099/1,099 passed; zero skipped |
| Combined alert + October 21/22 suite | 72/72 passed |
| Final alert policy/SQLite/local-D1 rerun | 30/30 passed |
| Final five new pipeline regressions | 5/5 passed |
| Application suite | 150/150 passed; zero skipped |
| npm run build | Passed |
| Final Wrangler bundle dry run | Passed; no deployment |
| git diff --check | Passed |

The broad Worker/72-test runs began before the final no-noise adjustment. The final 30-test and five-test reruns cover those changes; a comment-only clarification followed. The application source is unchanged. The final dry run includes the final runtime changes. Do not represent the broad run as a second exact-final-revision run.

Initial failures: one new midnight test incorrectly expected the weekday pre-3-PM window to be closed; corrected it to assert yesterday's source cannot activate or create an incident. One new pipeline fixture lacked settings; added that table to the fixture. No unresolved test failures. Existing October 21/22 and delivery regression run initially passed 74/75 with that fixture failure; the corrected test and broader runs subsequently passed.

Logs under ignored .wrangler: alerts2-worker.log, alerts2-final-focused.log, alerts2-policy-final.log, alerts2-final-pipeline.log, alerts2-app.log, alerts2-build.log, alerts2-dryrun.log. Earlier diagnostic logs remain local. No real notifications were sent; D1 tests use disposable local runtimes.

## Remaining work and known limits

- Delivery covers confirmed expected activation plus persistence failure, not every extraction omission or every blocked affirmative source. Missing or conflicting evidence remains unknown/withheld. Database outages may also prevent incident recording.
- Daily publication covers evaluated proposals/rejections. Separate terminal-import, weekly-lunch and Mexican Night outcome adapters remain unfinished. Missing saved week/extraction, removed daily sources and unverified concurrency exits need explicit lifecycle treatment.
- Persistent pending timeout, retention/bounded draining, incident grouping across future import categories, and freshness revalidation immediately before real dispatch remain unfinished. The injected dispatcher is not production-ready merely because its storage tests pass.
- There is no per-source outcome-history table. The integrated day/subsystem scopes use authoritative business state and current snapshots; do not claim complete per-offer auditing.
- Protected-extra-slot suppression is conservative if a group mixes staff locks and technical problems; document/refine if finer distinctions become necessary.
- Existing Cloudflare setup limitations from increment 1 are unchanged: no email binding, zero verified Email Routing destinations, routing unconfigured; native Monitor access/entitlement unknown due denied policy API reads. No email/monitor setup belongs to this completed increment.
- Before future activation: review configuration, verify sender/recipient privately, finish integration and independent monitoring, approve migration 0023 and deployment, and verify actual notification receipt/failure/recovery. Provider acceptance is not inbox delivery; crash-after-acceptance duplication remains possible without provider idempotency.

## Exact next action / recommended increment 3

Re-read this checkpoint and the increment-2 section of facebook-automation-alerts.md; verify Git and preserve all 14 task files. Then implement safe lifecycle handling for currently uncovered daily outcomes and terminal imports, beginning with eligible pre-extraction failures and removed/superseded sources. Do not resolve them from historical status or a generic no-op. Add a current-snapshot revalidation step before mocked dispatch so a later staff/source change cannot send an obsolete queued incident. Extend to weekly/Mexican outcomes only with their own verified publication contracts. Keep real transport and production configuration disabled unless separately authorized.

## Safe resume commands

```powershell
git status --short
git log -3 --oneline
git fetch origin main
git rev-parse HEAD origin/main
node --test workers/fb-feed/alert-outcomes.test.js workers/fb-feed/alerts.test.js workers/fb-feed/alerts-d1.test.js workers/fb-feed/oct21-regression.test.js workers/fb-feed/oct22-delivery.test.js
node --test --test-concurrency=4 workers/fb-feed/*.test.js
npm run build
node --test --test-concurrency=4 tests/*.test.mjs
npx wrangler deploy --dry-run --config workers/fb-feed/wrangler.toml --outdir .wrangler/alerts2-dryrun
```

Local D1 tests need localhost permission. Do not reset, clean, discard uncommitted work, commit diagnostics, or push main (CI deploys Pages).

Continuation prompt: Read docs/facebook-alerts-progress.md and the increment-2 section of docs/facebook-automation-alerts.md. Preserve all local work. Delivery and evaluated daily-specials observations are integrated and tested behind OBSERVE mode. Next implement missing import/daily lifecycle cases and current-state revalidation before mocked dispatch. Keep production notifications, migrations, deployment and email/monitor configuration disabled unless explicitly authorized.

## Increment 3 in progress — bounded safety checkpoint

2026-10-22: Prior work preserved. User requested a safe stopping point and Claude Code handoff due remaining model usage. Implementing only a bounded dispatch race fix before broad validation: final claim check now requires the claimed observed_ms and an elapsed due_ms. Permanent tests interleave recovery/recurrence or newer attention after claim. Tests pending. This does NOT complete terminal-import integration or durable business-state revalidation; do not wire dispatch into the Worker yet. No configuration or migration changes.

## CLAUDE CODE HANDOFF — Increment 3 bounded checkpoint (authoritative)

The full Increment 3 request is NOT complete. The user requested stopping at a tested logical boundary because model usage is low. Only dispatcher race hardening was added in this increment; no half-built terminal-import adapter or schema change exists. Earlier sections remain the history of increments 1 and 2.

### Current implementation and exact change

- Existing observation adapters are wired into the Worker only behind SPECIALS_ALERT_MODE=OBSERVE. Default/missing configuration is OFF. Production config is unchanged; dispatchAlert is not called by worker.js.
- In alert-store.js, the final post-claim SELECT now requires observed_ms to equal the claimed observation and due_ms to have elapsed. A recovery followed by recurrence between claim and check cannot bypass the restarted grace. A newer attention observation invalidates the old claim even if its original grace elapsed.
- alerts.test.js has two permanent interleaving tests. They also prove eventual dispatch after restarted grace / expired lease. Superseded claims retain their existing lease until expiry (at most five minutes); no immediate retry loop was introduced.
- This checks durable INCIDENT state only. It does NOT reread the source, collection or staff setting before dispatch. Source snapshots are currently transient and only fenced when recording observations. Do not describe this as complete business-state freshness validation or connect it to a real sender.
- Existing behavior remains: one accepted send per day/scope/code, even after same-day recurrence; unsent recurrence restarts grace; new day has a distinct key. Transport is injected and mocked in tests. No success or recovery messages.

### Every task file and Git status

Baseline main / HEAD and freshly fetched origin/main: ae2d8add8c6b76445adfd0e6c2b02891058ae63d. Five modified tracked files and nine untracked files, all preserved; nothing staged or committed. Ordinary git diff omits the nine untracked files, so read them explicitly.

| Git | File | Responsibility / increment 3 change |
| --- | --- | --- |
| M | workers/fb-feed/delivery.js | Structured fenced delivery outcomes; unchanged in increment 3 |
| M | workers/fb-feed/guarded-auto.js | Daily outcome/source/revision snapshots and intentional staff suppression; unchanged in increment 3 |
| M | workers/fb-feed/worker.js | OBSERVE-only adapters after reconciliation; no dispatcher; unchanged in increment 3 |
| M | workers/fb-feed/oct21-regression.test.js | Failed historical source recovery, pending suppression, staff revision/lock regressions; unchanged in increment 3 |
| M | workers/fb-feed/oct22-delivery.test.js | Independent delivery persistence failure/recovery while food publishes; unchanged in increment 3 |
| ?? | docs/facebook-alerts-progress.md | This complete checkpoint; updated in increment 3 |
| ?? | docs/facebook-automation-alerts.md | Design/history and current limitations; updated in increment 3 |
| ?? | migrations/0023_facebook_alert_incidents.sql | Prepared incident table/index; unchanged and never applied to production |
| ?? | workers/fb-feed/alert-outcomes.js | Delivery/daily adapters; unchanged in increment 3 |
| ?? | workers/fb-feed/alert-outcomes.test.js | Twelve disposable local D1 outcome tests; unchanged in increment 3 |
| ?? | workers/fb-feed/alert-policy.js | Explicit import/daily/delivery classifications; import policy still has no pipeline adapter; unchanged in increment 3 |
| ?? | workers/fb-feed/alert-store.js | Durable lifecycle/claims/backoff; final claim observation/grace fence added in increment 3 |
| ?? | workers/fb-feed/alerts-d1.test.js | Real local D1 concurrent dispatch/recovery/backoff; unchanged in increment 3 |
| ?? | workers/fb-feed/alerts.test.js | Nineteen policy/SQLite lifecycle tests, including two new claim-race regressions |

New diagnostics/build artifacts are ignored under .wrangler and dist. Preserve permanent test source files above when transferring; do not transfer only a git diff or omit untracked files. No new source files were created in increment 3.

### Production and configuration

Read-only deployment listings reconfirmed Worker a37829f3-6063-4d8c-83a7-45d270a27062 at 100%, and latest production Pages fb10af37-af69-418b-8f57-e7624af41465 / ae2d8ad. No production D1 access in increment 3. No deployment, migration, email, reset, discard, commit or push occurred.

Still required later, with separate explicit authorization: verify the privately supplied recipient and sender/domain, configure restricted email binding, establish independent monitoring after confirming native Monitor entitlement/access, review/apply additive migration, deploy OFF, validate observation mode, approve activation and actual receipt/failure/recovery testing. Prior investigation found no email binding, zero verified routing destinations and routing unconfigured; Monitor policy API access was denied. These account configuration facts were NOT re-queried this increment. No email/monitor configuration work should begin during this handoff.

### Next implementation steps, in priority order

1. Implement a verified terminal-import outcome adapter. Begin at runImportPipeline / processImportAttempt in worker.js, recovery.js and reconcileToday in guarded-auto.js. Use the COMPLETE current Graph source set, parser/version, Chicago day and staff state. Distinguish pending retry, permanent image/extraction failure, budget/exhausted retries and intentional skips. Eligibility must be established independently; a failed import or an image alone is not proof of an advertised current-day offer.
2. Make actual fenced publication recovery override retained failed/rejected status (October 21). Do not treat staged/ok or a generic daily no-op as successful publication. Handle missing saved week, removed/superseded sources and terminal sources blocking other current-day proposals; isolate weekly/Mexican outcomes. Avoid duplicate primary-import and downstream-publication incidents.
3. Add durable business-state proof/revalidation immediately before mocked dispatch. Current incident table has no persisted source identity/fingerprint/revision snapshot. Decide the minimal justified durable contract; do not parse historical audit strings as proof. Recheck current sources/reviews, saved collection revision, staff overrides, delivery deadline, day and newer recovery. Treat missing/unknown evidence conservatively. Retain atomic claims and the new final observation/grace check.
4. Only after those contracts are correct, wire a bounded mock-only orchestration path and test stale staff/source changes, pending/exhausted/budget cases, transport retries, concurrent cron/webhook calls and appropriate recurrence. Do not enable production dispatch or choose real transport now.
5. Rerun the complete suites below; preserve exactly one Lunch, October 21/22 behavior, dedicated weekly/Mexican logic and staff ownership. Update both docs as each stage completes. Persistent-pending timeout, bounded drain/retention, mixed staff/technical suppression and independent outage reporting remain unfinished.

Safety limitations: D1 outage may prevent incident storage; Worker self-reporting cannot detect every missed execution. External provider acceptance followed by a crash before acknowledgement can duplicate a message without provider idempotency. In-flight sends cannot be recalled. No code currently verifies inbox receipt. Main pushes trigger Pages CI; do not push. Keep all alerts disabled and all changes uncommitted until the user explicitly changes these boundaries.

### Increment 3 verification commands / current results

```powershell
node --test workers/fb-feed/alerts.test.js
node --test --test-concurrency=4 workers/fb-feed/*.test.js
node --test --test-concurrency=4 tests/*.test.mjs
npm run build
npx astro check
npx wrangler deploy --dry-run --config workers/fb-feed/wrangler.toml --outdir .wrangler/alerts3-dryrun
git diff --check
```

Focused SQLite/policy: 19/19 passed. Application: 150/150 passed. Build and Wrangler dry run passed. Astro check: zero errors, zero warnings, six hints. Whitespace check passed. Full Worker run is still pending at this intermediate checkpoint; see final result appended below before resuming. No known failing tests or incomplete code edits. Local D1 runtimes require localhost permission. Logs: .wrangler/alerts3-worker.log, alerts3-app.log, alerts3-build.log, alerts3-check.log, alerts3-dryrun.log. Read-only production diagnostics: alerts3-production-worker.log and alerts3-production-pages.log (local only; do not commit account metadata).

Continuation prompt: In C:\Users\Jwerl\dev\Grayzn Buffalo, read the authoritative CLAUDE CODE HANDOFF and final results in docs/facebook-alerts-progress.md, then docs/facebook-automation-alerts.md. Preserve all 14 task files, including nine untracked files. Baseline main and origin/main are ae2d8add8c6b76445adfd0e6c2b02891058ae63d. Increments 1/2 provide OBSERVE-only delivery/daily observations; increment 3 added tested incident claim/grace race fences only. Complete terminal-import eligibility/recovery integration first, then durable current-business-state validation before mock dispatch. Do not repeat completed account investigation or claim staged/ok proves publication. Keep alerts disabled. No reset, discard, commit, push, migration, deployment, email or Cloudflare configuration. Update both docs at each safe boundary.

### Final increment 3 verification — safe stopping point

Complete Worker suite: **1,101/1,101 passed**, zero failed/cancelled/skipped, 292.5 seconds, covering the final runtime and test changes. This includes the alert local-D1 suites, October 21/22 pipeline regressions, delivery, weekly/Mexican and Lunch protections. Focused policy/SQLite: **19/19 passed**. Application: **150/150 passed**. Astro build, Astro check (0 errors, 0 warnings, 6 hints), Wrangler dry run and final git diff --check passed. No failing tests and no running test processes remain. Only documentation was updated after these runs.

Final Git status is exactly the 5 M + 9 ?? inventory above; baseline unchanged. Increment 3 modified only alert-store.js, alerts.test.js and both docs. No partial source edits are left. Terminal-import integration, durable business-state revalidation and Worker-level mock dispatch remain UNIMPLEMENTED; the full requested increment is not complete. Stop here per the user's usage/handoff instruction, and continue from priority step 1 only in the next authorized session. All alerts remain disabled. No reset, discard, commit, push, migration, deployment or email occurred.

## 2026-10-24 continuation — implementation stage 1

Verified main/HEAD/fresh origin/main ae2d8ad and all 14 previous work files. No additional unrelated tracked/untracked changes were present. Started durable scan/hash proof and read-only reconciliation assessment. Added local-only migration 0024 (proof_json + scan table), alert-runtime.js and alert-email.js. Dispatcher now supports required evidence revalidation; Worker invokes the isolated coordinator after existing reconciliations. OFF remains the configured default (no config edited). Tests pending; this section is an in-progress checkpoint, not activation approval. Existing 0023 and business write SQL are preserved.

### 2026-10-24 stage 2 validation

New Worker/mock/email/durable-evidence suite passed 29/29, including real disposable Miniflare D1 with concurrent dispatch and later staff edits. Initial test fixture omitted delivery_automation and closed SQLite after fixture cleanup; corrected both fixture issues, then all tests passed. Added explicit future-date caption exclusion using the existing validator and aligned dispatch hours with the existing 7 AM–8 PM processing window; final full-suite validation follows. No production activity or configuration changes.

## 2026-10-24 — authoritative implementation checkpoint

This section supersedes the incomplete Increment-3 handoff above. All work remains LOCAL and UNCOMMITTED. Alerts are OFF by default. No real email, production database access/write, migration, deployment, Cloudflare configuration, commit or push occurred in this continuation.

### Completed local scope

- Increments 1 and 2 remain intact. The remaining Increment-3 work is implemented for the existing current-day daily-specials and delivery alert scopes: terminal-import decisions, durable business-state proof, pre-dispatch revalidation and Worker-level mocked dispatch.
- Explicit current-day specials captions establish eligibility for pre-extraction terminal image/AI/budget/exhausted-retry failures. Existing date validation rejects future/other-day captions. Pending retries are quiet. Unknown images, ambiguous coverage without eligibility, and dedicated weekly/Mexican sources are not invented daily failures.
- Daily and delivery reconcilers now have read-only inspectOnly paths. Existing publication decisions and guarded write SQL are unchanged. Inspection detects outstanding publication work, rejected evidence and missing current week, and recognizes recoverable historical failed records using actual current reconciliation rules. No review-audit string is interpreted as success.
- One daily incident groups primary import and downstream publication failure, with a fixed cause code in its proof. This prevents duplicate messages for one blocked daily reconciliation. Delivery remains independently scoped. Staff choices suppress terminal candidates; current source review, slot contents/locks, revisions and delivery settings participate in revalidation.
- Each complete Graph scan has a durable day/token. Starting a newer scan invalidates older proofs, including if the newer scan fails or is incomplete. Older overlapping scans cannot certify a newer observation. Only the latest complete scan may write verified incidents.
- The proof contains only version, scan token, parser version, SHA-256 business-state hash, fixed cause code and expiry. Scan storage contains source IDs and times, not poster text, recipient addresses, credentials or provider errors. Full source/specials data is read transiently in a D1 batch, hashed, assessed without writes and read again to detect changes. Dispatch repeats those checks and then checks incident state/lease/observation/proof/scan token/due time and expiry immediately before transport.
- Proofs expire after 90 minutes or service close, whichever is earlier. Dispatch follows the existing 7 AM–8 PM Chicago processing window; delivery also stops at 3 PM on weekdays. Crossing expiry during revalidation is explicitly tested. Grace starts no earlier than scan completion. Same-day/scope/code accepted sends never repeat; unsent recurrence after recovery restarts grace. Next-day keys are distinct.
- Worker observation/dispatch errors are isolated from import/publication outcomes. Daily publication exceptions are observed where the current data can still be read, then rethrown to retain existing queue retries. If D1 is unavailable, the alert subsystem emits a fixed error signal and cannot self-report by email.
- Dispatch is bounded to two candidates per cycle. Transport errors retain safe send_failed state with exponential backoff. Retention deletes at most 100 incidents older than 14 days per completed cycle and old scan rows; today's deduplication records remain.
- alert-email.js implements the native structured Cloudflare send_email adapter locally. It requires EMAIL mode, SPECIALS_ALERT_EMAIL_APPROVED=true, a binding and validated sender/recipient variables. No configuration is supplied. Content is fixed plain text containing cause, Chicago date and the fixed admin URL. All provider calls in tests are mocked; an acceptance messageId is required.
- Content-free observation/dispatch/health telemetry is implemented. readAlertHealth returns last completed scan, incomplete scan count, stored actionable-candidate count and transport-error count. An empty table still returns a health row. Independent monitoring configuration remains a separately authorized operational prerequisite.

### Exact current file inventory

HEAD/main and freshly fetched origin/main: ae2d8add8c6b76445adfd0e6c2b02891058ae63d. Five modified tracked files + thirteen untracked files = eighteen task files. No staging/commits. Prior fourteen files were preserved. No additional unrelated changes were present when this continuation began, and none were altered. In particular, no production migration tracking was reconciled or changed.

| Git | File | Current responsibility / change this continuation |
| --- | --- | --- |
| M | workers/fb-feed/delivery.js | Existing structured outcomes plus read-only inspection; write guards preserved |
| M | workers/fb-feed/guarded-auto.js | Existing daily snapshots plus read-only publication assessment; weekly/Mexican writers unchanged |
| M | workers/fb-feed/worker.js | Begin latest scan; isolated completion/dispatch; keep original queue error semantics |
| M | workers/fb-feed/oct21-regression.test.js | Prior increment tests preserved, unchanged this continuation |
| M | workers/fb-feed/oct22-delivery.test.js | Prior increment tests preserved, unchanged this continuation |
| ?? | docs/facebook-alerts-progress.md | This authoritative checkpoint and rollout/handoff |
| ?? | docs/facebook-automation-alerts.md | Updated design, current contracts and limits |
| ?? | migrations/0023_facebook_alert_incidents.sql | Prior prepared incident migration preserved unchanged |
| ?? | migrations/0024_facebook_alert_evidence.sql | NEW: proof_json column and latest-scan table; production unapplied |
| ?? | workers/fb-feed/alert-policy.js | Prior policy preserved unchanged |
| ?? | workers/fb-feed/alert-store.js | Required-proof callback, exact proof/scan fence, final expiry check, fixed cause payload |
| ?? | workers/fb-feed/alert-outcomes.js | Prior observation adapters preserved; legacy OBSERVE fallback only when coordinator unavailable |
| ?? | workers/fb-feed/alert-outcomes.test.js | Prior local D1 regressions preserved unchanged |
| ?? | workers/fb-feed/alerts.test.js | Prior 19 policy/lifecycle regressions preserved unchanged |
| ?? | workers/fb-feed/alerts-d1.test.js | Prior real local D1 tests preserved unchanged |
| ?? | workers/fb-feed/alert-runtime.js | NEW: complete-scan lifecycle, read-only assessment, proof/revalidation, bounded dispatch/retention, health |
| ?? | workers/fb-feed/alert-email.js | NEW: default-disabled native binding adapter, fixed text and validated config |
| ?? | workers/fb-feed/alert-runtime.test.js | NEW: 30 permanent Worker/SQLite/D1/mock-email regressions |

Ordinary git diff omits all untracked modules/migrations/tests/docs. Transfer all eighteen files if changing tools. Ignored .wrangler logs and dist outputs are diagnostics, not source. No dependencies, package files, application pages, Wrangler configuration, Mexican Night rules, event handling or unrelated incident fixes changed.

### Validation and diagnostics

Final focused alert suite: 62/62 passed, including all 30 new runtime tests and final proof-expiry race regression. Application suite: 150/150 passed. Astro build passed; Astro check reported 0 errors, 0 warnings, 6 hints. Final Worker Wrangler dry run passed. Full final Worker run is in progress; its exact final result is appended below when complete. Expected total is previous 1,101 + 30 new tests = 1,131. No old tests were removed or weakened.

Initial new-test failure was fixture setup: missing delivery table and SQLite handle cleanup order; both fixed. The 29-test runtime stage then passed. Review added one expiry-during-validation regression and guard, making 30 runtime / 62 total alert tests. Do not confuse the earlier broad run with the final-code rerun.

```powershell
node --test workers/fb-feed/alert-runtime.test.js workers/fb-feed/alerts.test.js workers/fb-feed/alerts-d1.test.js workers/fb-feed/alert-outcomes.test.js
node --test --test-concurrency=4 workers/fb-feed/*.test.js
node --test --test-concurrency=4 tests/*.test.mjs
npm run build
npx astro check
npx wrangler deploy --dry-run --config workers/fb-feed/wrangler.toml --outdir .wrangler/alerts4-dryrun-final
git diff --check
```

Ignored logs: alerts4-runtime.log, alerts4-final-focused.log, alerts4-worker.log (earlier broad run), alerts4-worker-final.log (final code), alerts4-app.log, alerts4-build.log, alerts4-check.log, alerts4-dryrun.log and alerts4-dryrun-final.log under .wrangler. Tests use local/disposable SQLite or Miniflare D1 and mocked Graph, AI and email. Local D1 requires permission for localhost.

### Remaining limitations and production readiness

Local implementation is ready for deployment/configuration review, NOT immediate production activation. The application does not establish whether an unknown image contains an unextracted offer. Dedicated weekly-lunch and Mexican Night per-offer publication completeness remains outside the daily/delivery incident contract; this pass preserves those reconcilers and verifies their regressions without adding new business behavior. Explicit staff-protection suppression is intentionally conservative in mixed protected/technical groups.

A changed hash invalidates dispatch and waits for a fresh completed scan; it does not itself declare recovery. The hash includes all special collections/groups/slots, so even an unrelated staff save may conservatively defer a candidate until the next scan. A last completed Graph scan cannot prove a post was not removed afterward; new scans invalidate old proofs and the 90-minute lifetime bounds staleness. Late failures whose grace ends after closing remain recorded but will not send a stale next-day email.

External email cannot be transacted with D1. Concurrent ordinary claims are deduplicated, but crash-after-provider-acceptance/before-D1-acknowledgement can duplicate an external email; the native binding does not provide this code a documented idempotency key or cancellation API. Its abort signal can be checked before sending, but an in-flight binding send cannot be recalled/cancelled. Provider acceptance is not verified inbox receipt. These limitations must be accepted/reviewed before activation; no exactly-once inbox-delivery claim is made.

Independent detection of missed cron runs, global D1 failure, DLQ buildup and alert-send trouble is NOT configured. Local health/log signals are ready for it. Do not enable email without an independently verified monitoring path and an approved receipt/failure/recovery test. No unresolved test failure or partially written source change is expected at this checkpoint; see final validation below.

### Required configuration and safest reviewed rollout (NOT EXECUTED)

1. Obtain explicit authorization for production preparation; refresh production Worker/version and D1 schema/migration-tracking READS. Current live state was not queried this continuation. October-22 deployment IDs in earlier history are last-known values, not a fresh October-24 production claim. Check whether migration numbers 0023/0024 collide with any externally applied work before proceeding; never replay business migrations or mutate tracking to force them through.
2. Review all eighteen task files, including both untracked migrations. Confirm scoped behavior/limitations and independently review email and evidence proofs. Approve the exact deployment version.
3. Privately verify the user-confirmed recipient and chosen sender/domain. Configure a restricted ALERT_EMAIL send_email binding, SPECIALS_ALERT_FROM and SPECIALS_ALERT_TO only with explicit authorization. Keep SPECIALS_ALERT_MODE absent/OFF and SPECIALS_ALERT_EMAIL_APPROVED absent/false. Do not place private addresses in versioned files. No paid plan or new service is presumed necessary/authorized.
4. Confirm native Monitor entitlement/access or approve an alternative independent monitor. During 7 AM–8 PM Chicago, monitor missing/stale completion over 90 minutes, persistent incomplete scans, fixed subsystem-unavailable errors and send_failures; separately watch queue DLQ. Query aggregates that return a row even with zero records. Treat health actionable as stored candidates, not permission to bypass business revalidation. Validate the independent route can notify when this Worker or D1 is down. Configuration facts from increment 1 (no binding/destinations, Monitor API denial) need fresh verification, not assumptions.
5. After separate migration approval, apply ONLY the additive incident/evidence schema changes to the verified database. Never alter specials data, replay imports or reconcile historical migration tracking during alert rollout.
6. After deployment approval, deploy the reviewed Worker with alerts OFF. Check existing feed/import/weekly/Mexican/delivery behavior. Then, with approval, set OBSERVE to validate incident lifecycle and hashes on current sources without email. Verify manual overrides and resolved historical failures produce no actionable emails.
7. After explicit activation/test-send approval, configure EMAIL plus SPECIALS_ALERT_EMAIL_APPROVED=true and confirm actual receipt of a controlled approved actionable test, recovery suppression, retries and independent monitor delivery. Do not create a false production incident by corrupting business data. Acceptance alone does not prove receipt.
8. Roll back by disabling alert mode first. Preserve incident/sent records; do not drop the outbox or alter source/food/delivery rows. Restore a reviewed Worker version if needed. Never push main casually: existing CI deploys Pages.

Stop after final validation and documentation. The separate October 22 Pizza Night price issue, October 23 Friday Night issue and separate delivery failure are NOT investigated or changed here.

### FINAL verification — 2026-10-24

- Final Worker suite: **1,131/1,131 passed**, 0 failed/cancelled/skipped, 316.1 seconds. This is the full final-runtime-code run, including October 21/22, weekly lunch, Mexican Night, delivery, ownership and Lunch regressions. Difference from prior 1,101 is exactly 30 new permanent alert-runtime tests; none removed.
- Focused alert suite: **62/62 passed** (30 runtime + 19 policy/lifecycle + 12 delivery outcome + 1 prior D1 test). The new runtime suite includes an additional real local D1 test.
- Application suite: **150/150 passed**, unchanged count.
- Astro build: passed. Astro check: 0 errors, 0 warnings, 6 existing hints. Final Wrangler dry run: passed. Final whitespace check: passed.
- Earlier broad run: 1,130/1,130 before the final expiry-race test/guard; superseded by the 1,131 final run.
- No failing tests, unfinished source edits or running test processes remain. Only documentation and a transport-description comment changed after final runtime validation.
- Final Git status remains 5 modified tracked + 13 untracked task files, all inventoried above. main/HEAD/origin/main remain ae2d8add8c6b76445adfd0e6c2b02891058ae63d. No commits, pushes, deployments, production migrations/writes, real emails or Cloudflare configuration changes.

Local daily/delivery alert implementation and mock validation are complete. Production activation is NOT approved or ready to turn on without the reviewed prerequisites/sequence above. Dedicated weekly/Mexican per-offer completeness, independent monitor provisioning and actual email receipt remain explicitly outside what has been validated here. Stop; do not start the separate October 22–23 incident investigations automatically.

Continuation for a future authorized rollout review: Read the authoritative 2026-10-24 sections and FINAL verification in both alert documents. Preserve all 18 task files, including 13 untracked files. Review the completed local current-day daily/delivery lifecycle, durable proof/revalidation, mock dispatch, email adapter and health signals. Tests passed 1,131 Worker / 150 application / 62 focused. Verify current production versions and schema/tracking before proposing any additive migration. Follow the eight-step reviewed rollout, with explicit authorization for every production/configuration/activation action. Do not mix in the separate Pizza Night, Friday Night or delivery incident investigation.

## Superseding production preflight — 2026-10-24: BLOCKED

Read [facebook-alerts-production-readiness.md](facebook-alerts-production-readiness.md) before any rollout. This supersedes earlier readiness wording, without changing the historical test results.

Read-only production review confirmed migrations 0020–0022 are in the ledger, the 0021 recovery schema and 0022 delivery table exist, and only 0023 then 0024 are pending. Neither alert table exists. Do not replay or alter the separate migration-tracking reconciliation. A Time Travel bookmark was retrieved; an export/restore backup has NOT been verified. Current Worker version is a37829f3-6063-4d8c-83a7-45d270a27062. No alert variables or email binding are configured; no verified routing recipients were returned. Monitoring policy/type reads returned 403, so independent monitoring remains unverified.

Three local mocked/disposable-database reproductions demonstrate release blockers: (1) a stalled native send can be duplicated after the five-minute claim expires and delays pipeline completion; (2) staff dismissal after business revalidation but before the final incident-only SQL check can still send a stale alert; (3) completed_ms can report a healthy completion even when outcome snapshot/assessment fails. These are outstanding defects, not fixed by this read-only review. The existing 1,131 Worker / 150 application / 62 focused passes remain historical validation, not proof these new cases pass. Three diagnostic assertions passed by reproducing the undesirable behaviors; permanent regression tests and fixes are still required.

Exact local reproduction command: `node .wrangler/alerts-preflight-repro.mjs`; final log `.wrangler/alerts-preflight-repro.log`. Both are ignored local handoff artifacts; preserve them or convert their scenarios into permanent tests during authorized remediation. Other private preflight evidence is under `.wrangler/alerts-preflight-*`. No production writes, deployments, real emails, config changes, commits or pushes occurred. Only the new readiness document, these two documentation appendices and ignored local diagnostics were written during preflight. Application source and the original eighteen work files were preserved.

Git checkpoint: main, HEAD and freshly fetched origin/main ae2d8add8c6b76445adfd0e6c2b02891058ae63d. Final expected inventory is five modified tracked + fourteen untracked task files (the original eighteen plus the readiness document). `git diff --check` passes. Recheck for concurrent changes before editing. Pushing main triggers Pages deployment; no push is authorized.

Continuation: request authorization for LOCAL remediation of the three findings and permanent regressions first. Read the readiness document for exact findings, all nineteen files, production evidence and the eight-stage gated rollout. Keep notifications OFF and email mocked. After fixes/review, obtain separate approval for verified backup handling and additive migrations, then Worker OFF, OBSERVE, restricted isolated receipt test, independent monitoring and eventual activation. Never treat this document as deployment approval. Do not begin the separate October 22–23 incidents.

## Blocker remediation in progress — 2026-10-24

Authorized LOCAL fixes only. Baseline main/HEAD/fresh origin/main remains ae2d8ad; all nineteen task files and preflight artifacts preserved. Initial implementation now quarantines provider uncertainty before invocation, bounds transport waiting, uses a trigger-maintained transactional business-generation fence, and separates scan completion from atomic outcome/evaluation persistence. Unapplied 0023/0024 definitions are being amended locally; no production migration/configuration/deployment/email occurred. Permanent regression coverage and full validation are IN PROGRESS; do not interpret this stage as release approval. See final checkpoint below when available.

### Remediation stage 2 — focused validation complete

All 91 focused alerts tests pass (previous 62 + 29 new permanent regressions). The original three defects now have desired-behavior assertions in permanent tests, including real local D1 with the generation triggers. Full Worker/application runs are in progress; build and dry run pass, Astro check reports 0 errors/0 warnings/6 existing hints. Initial test-expectation/fault-injection issues were corrected; the final focused run has no failures. Production remains untouched and OFF. Do not use the archived preflight reproduction script as a current passing suite: it intentionally asserts the old defects and is preserved unchanged.

### Remediation stage 3 — final design supersedes the trigger prototype

A real local D1 compatibility regression caught that trigger writes inflate meta.changes and would interfere with existing business guards. The prototype generation table/triggers were removed BEFORE release; no business writer was changed. Final authorization and outcome/evaluation persistence instead compare all eight current evidence rowsets inside the atomic SQL write, using transient bound JSON and balanced predicates compatible with D1 expression limits. The final 0024 contains NO business triggers or generation table. Stage 1/2 references to triggers describe superseded work only.

Real local D1 now verifies concurrent dispatch, staff dismissal between revalidation and authorization, unchanged row-change counts, successful imports and manual locks. Application suite passes 150/150 with required localhost permission. Initial application run failed only on local Miniflare EACCES; the authorized rerun passed. The earlier 1,160 Worker run passed but predates the final snapshot-fence implementation and is NOT final-code validation. Final focused/full Worker runs are in progress. Final dry run passes. All email remains mocked and alerts OFF.

## Local release-blocker fixes — authoritative implementation checkpoint (October 24)

All three local corrections are implemented. See the final remediation section of [facebook-alerts-production-readiness.md](facebook-alerts-production-readiness.md) for precise semantics, schema deltas, reviewed recovery procedure and remaining rollout gates. Production activation remains BLOCKED; local review is the next step, not deployment.

- P1 dispatch: final atomic authorization writes ready -> uncertain BEFORE provider invocation. Only ready preparation claims expire/retry. Provider waiting is bounded to five seconds per candidate (maximum two candidates); a timeout is never cancellation. Late acknowledgement is token-guarded. Errors, lost responses, failed acknowledgements and process loss never automatically resend. Uncertain rows survive retention and business recovery and remain visible across days.
- P1 eligibility: final SQL atomically compares the entire transient current business snapshot, together with incident/scan/proof guards. Staff dismissals, edits, imports and publication changes committed BEFORE that decision prevent stale authorization. Raw evidence stays in transient bound JSON; the stored proof remains a hash. Balanced predicates work within D1 expression limits. Changes AFTER authorization cannot recall external email. There are NO business triggers, generation table or business-writer changes in the final implementation.
- P2 health: scan completed_ms is separate from evaluated_ms/evaluation_state/evaluation_error. Both scope observations and successful evaluation commit in one fenced transaction. Snapshot/assessment/write failures are recorded as failed when D1 permits; early returns record skipped. Total D1 failure leaves pending/stale completion plus fixed error logs, requiring independent monitoring. Zero candidates is distinct from unsuccessful evaluation and uncertain delivery.

Unapplied 0023 adds dispatch_state and authorized_ms. Unapplied 0024 adds evaluation fields to facebook_alert_scans; proof_json remains. Both definitions require renewed review and production restore rehearsal. If an older definition has been applied since the preflight, STOP and prepare a forward migration rather than replaying either file. 0020–0022 and their tracking reconciliation were untouched.

Exactly eleven existing files edited in this pass: the two 0023/0024 migrations; alert-store.js, alert-runtime.js, alert-email.js, alerts.test.js, alerts-d1.test.js, alert-runtime.test.js under workers/fb-feed; and all three alert documentation files. Original tracked Worker/delivery/guarded-auto/regression changes remain unchanged. No new release-source files were added. Git remains main at ae2d8add8c6b76445adfd0e6c2b02891058ae63d, matching freshly fetched origin/main; five modified tracked + fourteen untracked files (nineteen total). The preflight artifact names/sizes remain unchanged. New ignored alerts5-* logs/bundles are diagnostic artifacts, not source to commit wholesale.

Validation commands:

```powershell
node --test workers/fb-feed/alert-runtime.test.js workers/fb-feed/alerts.test.js workers/fb-feed/alerts-d1.test.js workers/fb-feed/alert-outcomes.test.js
node --test --test-concurrency=4 workers/fb-feed/*.test.js
node --test --test-concurrency=4 tests/*.test.mjs
npm run build
npx astro check
npx wrangler deploy --dry-run --config workers/fb-feed/wrangler.toml --outdir .wrangler/alerts5-dryrun-final
git diff --check
```

Miniflare requires localhost permission. All transports/Graph/AI are mocked; D1 is local/disposable. The archived preflight script deliberately asserts the OLD defects and was preserved unchanged; permanent tests now assert the corrected behavior. Focused suite is 93 tests (previous 62 + 31), application 150; build/check/dry-run pass. The full Worker result and final log inventory follow in the final verification entry. A retention test was strengthened to use an actually old-day uncertain row, so evaluation cannot refresh its age; its targeted rerun passed. This is additional validation of unchanged runtime code.

Safe continuation: review this implementation and the readiness document. Keep alerts OFF and email mocked. Unknown provider acceptance stays quarantined; absence from an inbox or lease expiration is NOT permission to rearm. Any future repair/rearm requires definite outcome/termination evidence, an audit and separate authorization. Production still needs a verified backup/restore rehearsal, fresh schema/tracking verification, restricted sender/recipient configuration, receipt test, independent monitoring (previous access was 403), OFF deployment and OBSERVE validation before separately approved activation. No commits, pushes, migrations, production writes, real emails, configuration changes or deployments were made. Do not start the October 22–23 incident investigations.

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

## Backup verification and local migration rehearsal — October 25, 2026

**PASS: existing backup verification and direct-SQLite migration rehearsal. BLOCKED: production rollout pending review and the Wrangler recovery-path limitation below.** This entry supersedes earlier statements that no backup or rehearsal exists. Alerts remain OFF. Source checkpoint is codex/facebook-automation-alerts at 6d91ffed4a6c52b1505a575bf734ea0c4666b9ce; local origin/main remains ae2d8add8c6b76445adfd0e6c2b02891058ae63d (not freshly fetched in this local resumption). Working tree was clean on resume. No implementation or migration files changed.

### Backup and protection evidence

Exactly one authorized export of grayzn-db (c998bfd4-7031-4ae2-9eea-df86f16ddb15) completed October 25 01:56:40–01:56:43 UTC (October 24, 20:56 Chicago), approximately 2.8 seconds. No export was repeated. Size: **639,855 bytes**. SHA-256: **0D31559282BB3E5964D7A222875DC79897CF4CA358FC034BFC97F15FF0988C2F**, reverified against the privately recorded export result.

User verified BitLocker 100%, XTS-AES128, protection ON. Backup root inheritance is disabled; recursive inspection of 35 existing artifacts found zero unexpected allow rules (only the user and SYSTEM). Permissions were not weakened. Files remain under the approved private AppData/Local/GrayznBuffalo/D1Backups directory; exact location is in ignored .wrangler/alerts6-private-path.txt. Backup, baseline, manifests and logs must remain private and retained pending an explicit retention decision.

At the export gate, D1 analytics showed zero reads/writes in the preceding five minutes. Website traffic analytics lacked entitlement; the gate used D1 workload telemetry, which is delayed evidence, not a zero-disruption guarantee. Post-export production reads succeeded; all 17 source-table counts were stable. Production ledger had 23 entries including filenames 0020–0022; exactly 0023/0024 were pending. These are export-time observations, not a claim about current production state.

### Restore, migrations and unchanged data

The complete, unmodified SQL export restored successfully through node:sqlite inside the protected folder. All 17 tables, original schema and 23 ledger entries matched saved source manifests. Unsafe-integer checks before export found zero rows outside exact JavaScript integer range. Baseline and final SQLite integrity_check returned ok; foreign_key_check returned zero violations. This is a faithful SQLite recovery test of the saved SQL and its recorded schema/counts, not a production D1 restoration test. Source manifests were not a transactionally frozen full-content digest of production; full typed row digests establish preservation across the LOCAL migration steps, not independent byte-for-byte proof against live production.

0023 was already completed before interruption; it was not replayed. 0024 was completed on resume after checking the existing ledger. Each exact committed migration ran in its own local SQLite transaction with a corresponding local ledger insert; Wrangler migration bookkeeping itself was NOT exercised. Both migration file hashes remain the reviewed values in the private plan. Original 23 ledger rows are unchanged; local ledger now has 25 rows. No production ledger was changed.

All **16 pre-existing business tables** retain identical counts and canonical full typed-row digests. Existing schema/indexes/triggers and non-ledger sequences remain unchanged. Final alert schema matches execution of the exact committed SQL: incidents has 16 columns including proof_json; scans has 9; due index columns are day/state/sent_ms/due_ms. Both alert tables remain empty. Eleven synthetic default/state/error/uniqueness checks passed and were rolled back; final contents were reverified. A separate in-memory check confirms 0024 fails without 0023.

### Wrangler limitation and regression results

The original local Wrangler restore failed before populating its D1 file with an internal runtime error. A fresh, empty local persistence directory in the SAME protected folder also fails on SELECT 1 with an internal error. This isolates the failure from production SQL content, but does not establish its root cause. Do not relax ACLs or move production records into ordinary workspace/temp directories to bypass it. Installed Wrangler is 4.148.0. Direct SQLite passed; protected-path Wrangler/Miniflare recovery and normal Wrangler migration tracking remain unverified. Resolve this with synthetic data first before any approved full D1 recovery-path rehearsal.

Focused command: node --test workers/fb-feed/alerts.test.js workers/fb-feed/alerts-d1.test.js workers/fb-feed/alert-outcomes.test.js workers/fb-feed/alert-runtime.test.js
Result: **93/93 passed**, zero failures/cancelled/skipped, including disposable local D1 coverage and mocked email. Log: .wrangler/alerts6-focused-resume.log. These passing synthetic D1 tests do not negate the protected-path restore failure. No runtime source changed, so full Worker 1,162/application 150/build/check/dry-run results remain the previous checkpoint evidence, not newly rerun results.

### Durable artifacts, next gate and scope

Ignored scripts: alerts6-local-rehearsal.mjs (restore/per-migration checks), alerts6-final-verify.mjs (hash, baseline/final contents, exact schema, dependency and rolled-back constraints), alerts6-inspect.mjs and alerts6-traffic.mjs (prior read-only source/traffic evidence). Private reports include export-verification.json, before/after-source-manifest.json, baseline-manifest.json, 0023/0024-verified-manifest.json and final-verification.json. Original SQL and verified-baseline.sqlite are preserved. Private runtime-probe logs preserve the reproducible Wrangler limitation. Do not rerun restore or migration phases against existing files; final-verify is the safe recheck. Never repeat the production export under this authorization.

Only the three existing alert documentation files were modified during resumption, plus ignored local diagnostics/plan. No commit, push, merge, deployment, production D1 write/migration, Cloudflare configuration, email or activation occurred.

**Next step: review these results and resolve the protected-path Wrangler issue using synthetic data. No production operation is recommended while that recovery-path limitation is unresolved.** The next production-changing operation requiring separate explicit authorization is applying exactly migrations 0023 then 0024, only after fresh read-only identity/schema/pending-list/reconciliation checks and backup freshness/recovery review. Stop on drift or unexpected pending files; never replay 0020–0022 or blindly rerun non-idempotent 0024. No new export is authorized by this checkpoint. Subsequent Worker OFF deployment, OBSERVE validation, restricted sender/recipient configuration, controlled receipt testing, independent monitoring (prior visibility 403), and EMAIL activation each retain their separate approval gates. Ordinary rollback retains additive tables and history; whole-database restore could destroy newer writes and requires its own authorization.

## Synthetic Wrangler investigation — October 25, 2026 (latest readiness decision)

**Local investigation PASS; the protected-path failure is no longer a demonstrated blocker to remote production migration. Production changes remain unauthorized, and activation remains BLOCKED by the rollout gates below.** This supersedes the preceding requirement to resolve the local failure before considering any production migration. No production calls, export/restore, dependency upgrades or application changes were made during this investigation.

### Evidence and limits

Node is v24.19.0; Wrangler is 4.148.0. Tests import top-level Miniflare 4.20260114.0; Wrangler imports its separate Miniflare 5.20261006.0-alpha. Ten synthetic runtime cases were exercised:

| Location/control | Miniflare v4 | Wrangler's Miniflare v5 |
| --- | --- | --- |
| Ordinary workspace path | PASS | PASS |
| Longer path inside protected backup root | SQLITE_CANTOPEN/internal error | Internal error |
| Workspace path with copied user/SYSTEM-only restricted ACL | PASS | PASS |
| Longer ordinary workspace path | SQLITE_CANTOPEN/internal error | Internal error |
| Short path inside unchanged protected backup root | PASS | PASS |

The same restrictions work at short paths. Long-path controls fail outside the protected folder too. This establishes a local path-dependent runtime/filesystem problem and a working short-path mitigation, not an alert migration SQL defect or a need to weaken ACLs. Exact Windows/workerd path handling and its threshold were NOT established; do not assert a specific MAX_PATH limit or attribute the failure to BitLocker. The old failure directories/logs remain intact.

Installed Wrangler code distinguishes executeLocally (Miniflare/local persistence) from executeRemotely (authenticated Cloudflare D1 API). The migrations apply handler forwards the selected local/remote flag into executeSql. Therefore the local persistence failure is not on the remote migration execution path. This is source-inspection evidence, NOT a remote write test or a guarantee of remote availability, authorization or migration success.

### Successful synthetic CLI rehearsal

A fresh short protected subdirectory w7 contains only invented records, copied reviewed migrations and a local-only config. Installed Wrangler imported synthetic.sql with --local, then applied 0023 and 0024 using normal migrations apply tracking. Subsequent SELECTs preserved the synthetic business row and returned exactly both ledger filenames; migrations list reported no pending migrations. A read-only node:sqlite check of that synthetic database matched the exact committed alert schema, returned integrity ok and zero foreign-key violations. The combined CLI PRAGMA verification attempt returned SQLITE_AUTH; it is retained as a diagnostic, not hidden. Supported D1 SELECTs passed, and offline read-only SQLite performed the restricted integrity/schema checks. No application schema was altered to bypass the authorizer.

Evidence: ignored .wrangler/alerts7-runtime-matrix.mjs and matrix/isolate/short logs; alerts7-cli-synthetic-restore.log; alerts7-cli-migrations.log; alerts7-cli-verification.log (rejected PRAGMA batch); alerts7-cli-data-verified.log; alerts7-cli-pending.log; alerts7-verify-synthetic.mjs and alerts7-synthetic-verified.log. All existing alerts6 artifacts and the verified backup remain preserved; original backup SHA-256 was checked again and is unchanged. This task did NOT restore production data into Wrangler. The earlier full-data SQLite recovery/preservation verification plus this synthetic Wrangler import/tracking test are complementary evidence; full-data Wrangler recovery remains unexercised.

No application tests were rerun for documentation-only changes. Previous focused 93/93, Worker 1,162/1,162 and application 150/150 results retain their original dates/scope. Synthetic expected failures above are environment controls, not new application regressions.

### Remaining gates and exact next handoff

1. Read this latest section, the preceding backup report, and the maintenance backlog in POST_LAUNCH_CHECKLIST.md. Inspect branch/HEAD/status and preserve current uncommitted documentation and ignored/private evidence. Expected source is codex/facebook-automation-alerts at 6d91ffed4a6c52b1505a575bf734ea0c4666b9ce. Do not rerun export or migrations against an existing rehearsal state. To recheck the synthetic result, run node .wrangler/alerts7-verify-synthetic.mjs with access to the private folder; it performs read-only database checks and writes no backup data.
2. Verify/update the vulnerable local/CI Node toolchain under a separate maintenance task before release operations; record executable/version and rerun applicable validation after any runtime change. No Node upgrade occurred here.
3. Refresh production identity, schema, migration ledger, exact pending files (only 0023/0024), current Worker/version/config, reconciliation-workstream status and backup freshness through read-only inspection. The earlier ledger/traffic observations are historical. Any new export, copy of production data into a different recovery environment, or production restore needs its own approval; a repeat export is not authorized. Review whether the existing verified recovery evidence meets the operator's recovery requirements; if a full-data Wrangler restore is required, obtain authorization for that specific protected short-path rehearsal.
4. **Next production-changing operation requiring explicit authorization: apply exactly 0023 then 0024 to the verified production D1 using normal remote migration tracking, after the preceding gates pass.** Local path mitigation is not authorization. Stop for unexpected pending files, drift, concurrent reconciliation, failed checks or ambiguous partial application. Never replay 0020–0022 or blindly rerun 0024. Plan for possible migration availability impact.
5. Separately authorize reviewed Worker deployment with alerts OFF, after a current dry run and Wrangler source-map policy review. Then separately authorize OBSERVE validation through eligible Chicago cycles/grace periods. Preserve existing publication/staff protections.
6. Resolve restricted sender/recipient/binding configuration, controlled real-email receipt testing and independent failure monitoring (prior visibility 403) under separate approvals. Review fresh candidates and uncertain attempts before separate EMAIL activation. None is authorized now.
7. Rollback should disable alerts/restore the reviewed prior Worker while retaining additive schema and incident history. Whole-D1 restore risks overwriting newer business writes and requires a separate recovery decision. Unknown email acceptance cannot be safely retried without evidence.

Only documentation and ignored synthetic diagnostics changed in this investigation. No production writes/migrations, deployment, push, merge, commit, email, Cloudflare configuration, dependency change or unrelated incident work occurred. Stop for review.
