# Facebook automation alerts — investigation and design

Status: local daily/delivery alert implementation completed, 2026-10-24, pending final verification below and production preparation/approval. See the authoritative 2026-10-24 design section and facebook-alerts-progress.md for exact scope, coverage limitations and rollout. Earlier partial Increment-3 notes are historical. No alert system activated.

## Verified baseline

Local main and freshly fetched origin/main: ae2d8add8c6b76445adfd0e6c2b02891058ae63d. Initial working tree clean. Production Worker and Pages versions are verified below.

## Boundaries

Local changes and mocked tests authorized. No deployment, production migration, production data writes, DNS changes, paid subscriptions, or email to an unconfirmed recipient. Never persist private recipient addresses or credentials here.

## Initial findings

The October 21 investigation establishes that staged/ok is not proof of publication. Original failed records can remain after successful reconciliation. Its attention warning is logging only. October 22 recovery preserves food while independently recovering delivery evidence; missing evidence is not proof of affirmative delivery. Exactly one Lunch and the established one Lunch/two All Day mapping must remain unchanged.

## Pending investigation

Production deployments, current pipeline failure paths, migration contracts and account email setup were inspected. Notification-policy access is denied; native Monitor entitlement remains unknown. The isolated local increment is implemented below. Pipeline integration and external configuration remain pending.

## Verified production and account state (2026-10-22)

- Worker: a37829f3-6063-4d8c-83a7-45d270a27062, 100%, deployed 19:28:30 UTC.
- Pages production: fb10af37-af69-418b-8f57-e7624af41465, main / ae2d8ad.
- Live Worker settings: persisted invocation logs enabled, head sampling 1; traces disabled. Bindings include DB, AI, PHOTOS, FB_KV and IMPORT_TRIGGER. No send_email binding or alert-recipient variable is present. Secret values were not printed.
- Email Routing API: zero destination addresses; domain routing disabled/unconfigured. Zone plan: Free Website (does not establish the Workers billing plan).
- Alert availability and policy APIs: 403 with the working Wrangler credential. Existing platform notification policies and Monitors entitlement are UNKNOWN, not absent. An older credential location returned authentication failures; the current credential successfully read Worker and Email Routing settings.
- User explicitly confirmed a recipient in this chat. Do not place the address in versioned files. Use it only for actionable failures. User reaffirmed that activation requires separate explicit approval, verified configuration and passing tests.

## Pipeline and detection findings

| Stage | Current evidence | Alert implications |
| --- | --- | --- |
| Discovery | Complete Graph scan registers deterministic source versions in special_imports before processing | A failed/incomplete scan is unknown, never recovery; no-post days are normal |
| Image | R2 key/hash and source version saved behind attempt lease | Transient download failure retries; permanent missing evidence needs eligibility proof |
| AI | Reservation audit, extract/validate events, preserved raw response | Budget and extraction failure are distinct; never include raw audit payloads in notifications |
| Validation/staging | validation_result, failure_kind, candidate_json and processing_status | staged/ok proves neither complete food nor delivery publication |
| Retry | 20-minute lease, 30-minute retry interval, maximum three processing attempts | Pending/processing must not alert as terminal; expired/exhausted work is different |
| Daily publication | reconcileToday returns blocked/rejectedSources/written/reason; fenced D1 writes and review audits | Partial writes still require attention; retained failed imports can recover without status rewrite |
| Weekly/Mexican | Dedicated reconcilers and review audits | Daily no-op cannot establish their success; weekly code can skip destinations silently |
| Delivery | Independent validators, candidate.delivery_recovery/delivery_blocked, singleton with snapshot fences | Current function returns no structured outcome and does not report whether its write won the fence |
| Cron/queue | Cron catches import error and logs it; queue rethrows for retries then DLQ | Invocation success alone misses caught application failures; DLQ needs independent observation |

The October 21 warning fires after daily reconciliation for blocked or rejected arrays, awaiting recovery, missing evidence/week, and concurrent changes. It contains date, source count, written, blocked/rejected counts and status only. It is neither an incident lifecycle nor an email. It may recur every scan, includes staff-protected slots, and does not cover delivery, weekly/Mexican errors, pre-reconciliation failures or missed execution.

Latest fenced reconciliation must take precedence over retained original failure. A no-op can mean already correct OR no relevant daily proposals; never use it to resolve all import/delivery/weekly incidents. Daily classifier results are scoped to daily publication only. Import classifier requires explicit current eligibility and resolution evidence from a future adapter.

Detectable: accepted targets blocked by capacity, explicit price conflicts, missing destinations, rejected evidence preventing publication, and technical failure with independently confirmed affirmative delivery. Not detectable from a single omitted model field: an unseen offer, a price the model never extracted, or an unobserved delivery notice. Missing delivery coverage can be recorded as unknown coverage but must not claim delivery was advertised. Staff locks/overrides, explicit cancellation, lack of affirmative evidence, weekends and the 3 PM Chicago expiry must remain non-errors. A protected-or-ineligible legacy reason conflates cases; the initial policy suppresses that reason conservatively until a fenced slot adapter distinguishes them.

Exactly one Lunch and the supported one Lunch plus two All Day mapping remain unchanged. Genuine lunch-only overflow remains a conflict. The October 22 food-preserving delivery reread is untouched.

## Notification options and selected direction

Current official documentation checked on 2026-10-22:

- [Cloudflare Alerts](https://developers.cloudflare.com/observability/alerts/): email destinations exist on all plans. Built-in alerts cover predefined platform events, not this application's completeness rules.
- [Monitors](https://developers.cloudflare.com/notifications/monitors/): scheduled SQL queries over entitled datasets, configurable execution/repeat intervals. A query returning no rows has no signal. Use a count that actually returns zero for missing heartbeat detection; validate on this account. A log-string threshold alone cannot implement source recovery and business-specific deduplication. Dataset/plan entitlement and alert routing remain unverified because API access is denied. Destination verification, delivery testing and retry guarantees need account-level confirmation.
- [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/): sends to verified destination addresses are free on all plans. Arbitrary-recipient sending requires Workers Paid, with 3,000 included/month then $0.35/1,000. We do not need arbitrary recipients or a new subscription for one verified owner recipient.
- [Send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/): native binding can restrict recipients; sender requires an onboarded domain. Domain onboarding/required DNS and sender identity must be reviewed before any changes. No domain onboarding or recipient-verification email has been initiated.

Provisional minimum: an additive incident/outbox table in existing D1, application observations after fenced reconciliation, Cloudflare Email Service to the explicitly chosen verified recipient, and an independent native Monitor for missing cron completions, persistent pipeline/storage errors, DLQ backlog and alert-send failures if the account supports the needed datasets. Reuse the existing cron for dispatch; add no queue or Tail Worker initially. If native monitoring is unavailable, evaluate one independent heartbeat monitor before choosing any paid/third-party service. That fallback has not been selected or configured. A monitor driven solely by the failed Worker is insufficient.

Native Monitors may be enough for infrastructure, but do not replace durable business incident state. Application email failures are retried locally; outages of D1 or email can prevent self-reporting, so an independent route is required. Provider acceptance is not inbox delivery; actual receipt/bounce behavior must be verified before calling this operational.

Cost estimate: verified-owner email has no per-email charge under the documented terms; incremental D1/Worker usage should be small at this traffic but depends on actual plan/quota. No new paid resources selected. Native Monitor/query/log cost and upcoming observability pricing must be verified before activation; no claim of zero total operating cost.

## First local implementation increment

Not wired into worker.js and not deployable as a complete alert system.

- alert-policy.js: explicit import and daily-publication observations; no raw payload forwarding; unresolved/unknown/retry/staff suppression distinctions.
- alert-store.js: durable monotonic observations, 30-minute attention grace, atomic send lease, one accepted send per day/scope/code, capped exponential send retry, default-disabled injected transport.
- Migration 0023 prepares one isolated incident table and index. Durable storage is required because cron and webhook execute concurrently and KV cannot provide the needed atomic claims. No production migration has run.
- alerts.test.js: policy and real SQLite lifecycle tests. alerts-d1.test.js: disposable Miniflare D1 SQL/concurrency test.

Store contract: adapters supply a current fenced snapshot, stable scope, fixed category, and timestamp tied to that snapshot. Unknown does not close incidents. Older/equal observations cannot overwrite newer ones. A recovery or staff suppression closes pending sends; new attention after an unsent recovery restarts grace. Once sent, the same day/scope/code never sends again, including recurrence. A next-day incident uses a distinct key. Send failures persist only a fixed safe code, never exception content. Dispatch ignores previous-day incidents.

Transport receives a 60-second abort signal and must honor it. Atomic leases prevent overlapping ordinary dispatch, but a crash after provider acceptance and before D1 acknowledgement can still duplicate a message. Exactly-once external delivery requires provider idempotency; this limitation cannot be solved by a D1 transaction around an external email call. In-flight messages cannot be recalled after recovery. No success/recovery emails are produced.

## Required next increments / unresolved design details

1. Add structured, fenced reconciliation outcome adapters for daily/import resolution, delivery (including persisted write result), weekly lunch and Mexican Night. Include confirmed source identity, current parser/version and staff state. Do not infer recovery by scanning an older audit string.
2. Choose stable incident scopes and suppress secondary publication alerts caused by the same primary import failure. Close superseded source incidents only after complete current-source observation. Extend incident key/category policy if category changes would otherwise duplicate one underlying incident.
3. Add a per-day or per-snapshot ordering fence so results from concurrent source snapshots cannot be ordered solely by wall clock; store supports monotonic times but cannot validate business snapshot freshness itself.
4. Wire observation/dispatch behind an explicit OFF default, with errors isolated from publication, and bounded dispatch/retention. Daily pending/concurrent conditions also need a persistence timeout to detect stuck work without premature warnings. Current first increment deliberately does not infer this timeout.
5. Implement native email transport, verified sender/recipient configuration, independent monitor, alert-delivery failure reporting and test-send operation. Keep all real sends disabled pending approval.
6. Integration tests for actual pipeline source edits, snapshot races, delivery-specific technical failures, staff state, weekly/Mexican outcomes, and confirmed omission/price coverage. Existing regression suites protect business behavior but do not prove alert integration.

## Release plan (future approval required)

After completing integration and all regressions: refresh production baseline; verify account Monitors/data access and independent heartbeat zero-count behavior; review sender domain onboarding and any DNS changes; verify the user-confirmed recipient privately; review migration 0023; obtain explicit production approval. Apply only the additive migration, deploy a reviewed Worker with alerts OFF, validate observation-only state against current sources, then explicitly enable after approval. Send one approved test message and verify receipt plus failure/recovery behavior with safe controlled tests. No Pages deployment should be required for this increment. Never push main casually: existing CI deploys Pages on pushes.

Rollback: turn alert feature OFF, restore the recorded reviewed Worker version if necessary, leave the additive table intact. Do not revert specials/delivery data or replay imports. Preserve incident records to avoid duplicate sends on reactivation. Monitor delivery failures independently. No production operation in this release plan has been executed.

## Additional production evidence and validation checkpoint

Read-only D1 SELECTs on recent sources returned one failed/rejected/permanent record and two staged/ok records. For all three, the latest review event class is reconciled (no CONFLICT marker). This directly confirms that alerting on processing_status=failed alone would send a stale warning. It does not prove all image content or delivery information was captured. Both queries reported changes=0 and rows_written=0. Diagnostic outputs remain ignored locally.

Final focused tests pass 18/18, including real local D1. Added safeguards suppress pending delivery notifications at/after 3 PM Chicago and prevent an old send failure from shortening a restarted grace period. All 150 application tests pass; application build and Worker dry run pass. Full Worker suite passed 1,079/1,079 (zero failures/skips); final isolated changes were subsequently verified by the focused suite, as detailed in the progress checkpoint. Tests never send real email.


Policy adapter contract clarification: resolved/pending/suppressed observations have no new category. Apply them to previously stored incident codes within their own source/subsystem scope, never blindly to every incident that day. Use primary cause grouping to avoid both import and downstream publication emails for one failure. The initial dispatcher sends one due incident per invocation; production wiring must use a bounded drain and define retention, so this foundation is not yet a runnable monitoring service.


## Increment 2 — outcome integration (authoritative current behavior)

The earlier sections describe increment 1. Delivery and daily-specials outcome adapters are now wired locally; production remains unchanged and notifications remain disabled.

### Verified outcome contract

`reconcileDelivery` returns the decision and whether the existing fenced persistence actually succeeded: published, hidden, pending, withheld, superseded, expired, or failed. It reports per-source eligibility/evidence states in memory. Original source evidence and business decisions are unchanged. A write exception yields failed with independently determined expectedActive; a zero-row fenced write is superseded, not a failure. Read errors remain isolated by the existing pipeline catch. No missing/ambiguous delivery field is interpreted as advertised availability.

`reconcileToday` attaches an ephemeral snapshot for evaluated daily targets/rejections and verified pending work. It identifies the source versions, collection and revision that produced the result. A successful write carries the incremented revision; an idempotent result carries the current revision. Dedicated weekly/Mexican no-ops, absent evidence and unverified early returns do not assert daily success. Existing review history is not rewritten. The October 21 test demonstrates an incident opening on current rejection, pausing during a retry, then resolving after publication while the original failed/rejected import remains failed.

### Recording and race protection

`alert-outcomes.js` records only when SPECIALS_ALERT_MODE is exactly OBSERVE. Missing/OFF/other values perform no alert storage access. No runtime configuration was changed, and neither adapter invokes dispatchAlert or any real email service.

Both adapters use the existing incident table; migration 0023 is unchanged. Conditional INSERT/UPSERT checks the exact source evidence, review/status, image, parser and newer versions atomically. Delivery additionally checks the staff setting and authoritative delivery row, including scan timestamp; daily publication checks collection revision and pending current sources. These predicates protect against stale results beyond timestamp ordering alone. A same-timestamp recovery can supersede failure only after those guards establish current state. A delivery refresh failure while a valid same-day banner is already active is not an outage.

Incidents use day/subsystem scopes (delivery and daily), so cron/webhook processing the same source set does not open one incident per trigger. Normal success, no affirmative evidence, cancellation, staff decisions and pending work do not create incident rows. Their observations only update existing incidents. Original generic lifecycle APIs retain their increment-1 behavior; this no-noise rule applies to guarded pipeline observations. No raw snapshot is persisted in incident content or logged.

Daily rejected/blocked proposals remain actionable even when other food slots publish. Staff-locked destinations are suppressed. A uniquely disabled destination and additional existing slots involving a staff lock are conservatively treated as intentional based on the fenced group/slot snapshot. This can withhold a warning in a mixed protected group; it avoids notifying about deliberate staff choices. Lunch capacity remains exactly one.

### Limits retained for the next increment

- Delivery detection currently covers confirmed affirmative activation prevented by a technical persistence failure. Failed extraction without independent affirmative evidence, candidate delivery_blocked, and incomplete rereads remain unknown/withheld rather than invented delivery failures. Global database unavailability can also prevent recording the alert.
- Daily publication covers actual evaluated outcomes, not every terminal import failure before evidence/reconciliation. No separate import-category adapter, weekly-lunch adapter or Mexican Night adapter has been activated. Missing saved week, missing extraction, removed daily sources and early concurrency exits still need explicit lifecycle policies.
- A new pending daily snapshot pauses a queued incident; persistent pending timeout and freshness checks before any future real dispatch are unfinished. The dispatcher itself is still an injectable test facility and does not revalidate changing staff/source state immediately before a real send. It must not be connected to production until that is addressed.
- The source-level detail is transient; durable state is the existing delivery row, current collection revision/audits and day/subsystem incident record. No per-source outcome-history table was added. This is sufficient for the integrated scopes, not a claim of full per-offer coverage auditing.
- Future activation needs mock-to-real transport work and configuration review, but email configuration and independent monitoring are explicitly out of scope for increment 2. No such work was started.

### Increment 2 files

Modified existing tracked files: workers/fb-feed/delivery.js, guarded-auto.js, worker.js, oct21-regression.test.js, oct22-delivery.test.js.

Updated prior untracked files: alert-policy.js, alert-store.js and these two documentation files. Preserved migration 0023 and the prior alerts.test.js/alerts-d1.test.js. New files: workers/fb-feed/alert-outcomes.js and alert-outcomes.test.js. All prior work remains local; no commits/pushes/deployment/database changes/emails.

### Increment 2 testing checkpoint

New local D1 policy/outcome suite: 30/30 passed, including the final no-noise rule. October 21 and October 22 pipeline tests separately passed. Broader suites are running; final counts will be recorded in facebook-alerts-progress.md. Initial test issues were an incorrect midnight expectation and a missing settings table in the fixture, both fixed without changing production behavior.

### Final increment 2 validation

Worker suite 1,099/1,099; combined alert/October 21/22 suite 72/72; final targeted alert/D1 tests 30/30 and new pipeline tests 5/5; application suite 150/150. Build, final Worker dry run and whitespace check passed. Broad runs started before the last no-noise refinement, which the final targeted reruns cover. Full timing details, exact file inventory and next actions are in facebook-alerts-progress.md. No production changes or notifications occurred.


## Increment 3 in progress

Bounded dispatch safety work: reject a claim when a newer observation arrives or recovery/recurrence restarts grace before transport. Regression tests added in alerts.test.js; validation pending. Full terminal-import and business-state dispatch revalidation remain unfinished. Alerts remain OFF; no production actions authorized.

## Increment 3 — bounded implementation and Claude Code transfer

This section supersedes the earlier in-progress note. Increment 3 is PARTIAL, deliberately stopped at a tested boundary at the user's request to conserve remaining usage. The complete file-by-file handoff, commands, results and ordered continuation steps are in the CLAUDE CODE HANDOFF section of facebook-alerts-progress.md.

Only alert-store.js, alerts.test.js and these two documentation files changed during increment 3. All five prior tracked modifications and all nine untracked task files were preserved. No new schema or source files, no partial adapter and no configuration changes.

The dispatcher's final post-claim SELECT now requires the original observed_ms and an elapsed due_ms. This prevents recovery/recurrence from bypassing a restarted grace, and invalidates claims based on older observations. Two permanent SQLite tests interleave these updates after the claim and establish eventual dispatch after grace/lease expiry. A superseded claim retains its lease until expiry, bounded by five minutes.

This is incident-state race hardening, NOT complete pre-send validation against current source/publication/staff state. The latter remains necessary, as does terminal-import pipeline integration. The import classifier still requires caller-supplied eligibility and explicit resolution; it is not wired to the pipeline. Daily/delivery adapters remain OBSERVE-only, with no dispatcher invocation in worker.js. No real sender exists. All outbound calls in tests are mocked. Same-day/scope/code incidents still send at most once after acknowledgement, even after recurrence.

Priority continuation: establish independently eligible terminal-import outcomes using complete current source sets; handle actual fenced recovery, source removal and missing daily week without historical false alarms; design minimal durable business-state proof for dispatch revalidation; then connect bounded mock-only orchestration. Keep weekly/Mexican ownership and exactly-one-Lunch rules intact. Do not begin email or independent monitor configuration under the current authorization.

Fresh read-only production listings confirm unchanged Worker a37829f3-6063-4d8c-83a7-45d270a27062 and Pages fb10af37-af69-418b-8f57-e7624af41465 / ae2d8ad. Fresh fetch leaves HEAD and origin/main at ae2d8add8c6b76445adfd0e6c2b02891058ae63d. No commit, push, migration, deployment, real email or production D1 access this increment. Configuration prerequisites remain as recorded earlier and were not modified.

Validation so far: focused policy/SQLite 19/19, application 150/150, Astro build, Wrangler dry run, whitespace check pass. Astro check reports zero errors/warnings and six hints. Full Worker results will be appended below when the active run completes. There are no known failing tests or incomplete source edits. Do not mistake prior increment results for this final run; consult the final appended result.

### Final increment 3 verification

Final-code Worker suite: **1,101/1,101 passed**, no failures/skips/cancellations. Focused policy/SQLite: **19/19**. Application: **150/150**. Astro build, Astro check (0 errors, 0 warnings, 6 hints), Wrangler dry run and whitespace checks passed. No running test process or incomplete source edit remains. Five modified tracked files plus nine untracked files remain, as fully inventoried in facebook-alerts-progress.md. No commit or production change. The requested terminal-import integration, durable business-state revalidation and Worker-level mock dispatch are still unfinished; this increment stops at the completed claim-race fix for safe transfer to Claude Code.

## 2026-10-24 continuation (in progress)

Implementation adds a scan token and content-free SHA-256 business-state proof, read-only daily/delivery assessments, aggregate daily incidents (one primary cause rather than duplicate import/publication alerts), and isolated Worker dispatch. Native structured Email Service transport is implemented locally behind EMAIL plus an explicit approval flag; no binding/configuration/recipient is installed. MOCK uses an injected function. Migration 0024 is prepared only. Validation and final limitations will follow in the final checkpoint.

Stage 2: 29 new permanent regressions passed, including Worker lifecycle, typed publication errors, terminal image/AI/budget/retry failures, actual historical recovery, independent delivery outcomes, content-free health counters and mocked native email acceptance. Added final date-eligibility/hour alignment before broad validation. New source files are alert-runtime.js, alert-email.js, alert-runtime.test.js; prepared migration is 0024_facebook_alert_evidence.sql.

## 2026-10-24 — authoritative completed local design

The previous incomplete Increment-3 notes are historical. Current-day daily/delivery terminal lifecycle, durable business-state revalidation and Worker-level mocked dispatch are implemented locally. Increments 1/2 are preserved. Email adapter code and content-free monitoring signals are also implemented, with all configuration and production activation still disabled. Full file inventory, tests and an eight-step approval-gated rollout are in the authoritative 2026-10-24 checkpoint in facebook-alerts-progress.md.

### Durable evidence and lifecycle

Prepared migration 0024 adds proof_json to the prepared 0023 incident table and creates facebook_alert_scans. Neither migration has been run on production. A scan token is recorded before Graph fetching; a newer or incomplete scan invalidates older notification proofs. Only the latest completed scan supplies source IDs/parser and may certify observations.

Read-only inspectOnly paths reuse daily/delivery reconciliation rules without modifying publication, ownership, staff locks or audit state. Current-day terminal image/extraction/budget/exhausted failures require explicit eligible caption evidence and the existing date validator. Pending work is quiet; unknown coverage is not fabricated failure. Current reconciliation, not raw processing_status or an audit string, resolves historical recovered failures. A single daily incident groups import/downstream causes; delivery stays separate. Weekly/Mexican behavior and exactly-one-Lunch rules are unchanged.

A transactional read captures current sources, newer-version flags, current weeks, collections, groups/slots, delivery state/setting and migration guards. Its canonical SHA-256 hash is computed before and after read-only assessment. Only that hash, token, parser, fixed cause and expiry enter proof_json. Source text, provider messages and recipient data are not persisted in alert content or emitted in new telemetry. Current business tables retain their original audit data.

Before transport, a claimed incident must still have the same proof/observation, attention state, no sent acknowledgement, elapsed due time and valid lease. The latest completed scan must match; current database hash and reassessed failure must match. A final check enforces proof expiry even when validation crosses a boundary. Proof lifetime is at most 90 minutes, within 7 AM–8 PM Chicago and the separate delivery 3 PM weekday cutoff. Same-day/scope/code accepted sends do not repeat; unsent recovery/recurrence restarts grace. Two candidates maximum per cycle; bounded 14-day retention preserves today's deduplication records.

### Email and monitoring

Modes: absent/OFF does nothing; OBSERVE records only; MOCK requires an injected test function; EMAIL additionally requires SPECIALS_ALERT_EMAIL_APPROVED=true, valid SPECIALS_ALERT_FROM/SPECIALS_ALERT_TO and ALERT_EMAIL binding. No active Wrangler config, address, binding or approval flag was added. emailTransport uses fixed plain text and the structured send method, requiring a returned messageId. Tests mock the binding; none send real email. Transport errors persist only send_failed and back off without changing import outcomes.

The adapter follows the official [send binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/) and [Workers send API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), checked October 24. A recipient-restricted binding and onboarded sender are deployment prerequisites. Native send cannot be cancelled after invocation and has no documented idempotency key in this interface; external crash-after-acceptance duplication and inbox delivery require operational review, not an exactly-once claim.

New logs report fixed subsystem failure, observation states, dispatch counts and content-free health. readAlertHealth returns one row even if empty, including latest completed time, incomplete scans, stored candidate count and send-error count. Independent monitoring must watch missing completion, D1/Worker outages and DLQ/send trouble through a separately configured route. It has NOT been configured. Do not rely solely on a failing Worker to report itself.

### Limits and release status

No complete per-offer omission audit or dedicated weekly/Mexican publication outcome coverage is claimed. Unknown image-only failures remain unclassified, and staff-protected mixed groups are conservatively suppressed. Hash changes defer dispatch until a new scan; all collections/slots participate, so unrelated staff saves can conservatively defer alerts. A complete Graph scan has finite freshness, not continuous knowledge of Facebook. Late failures may pass closing before grace ends and remain recorded without a stale next-day message.

The local implementation is ready for reviewed production preparation, not immediate activation. Required next steps are explicit approval, fresh production schema/version/tracking verification, review of unapplied 0023/0024, recipient/sender/binding verification, independent monitoring, OFF deployment, OBSERVE validation and separately approved receipt/recovery testing. No production actions, configuration, commits or pushes occurred. Do not investigate the separate October 22/23 incidents during this task.

### Validation checkpoint

62/62 focused alert tests pass, including 30 new Worker/mock/SQLite/local-D1 regressions and the final expiry-during-validation case. Application 150/150; build, Astro check (0 errors/warnings, 6 hints), final Wrangler dry run pass. Exact final full-Worker result follows below after the final-code run. Prior test setup errors were corrected (missing local delivery table and SQLite close ordering); no known source/test failure remains.

### FINAL verification — 2026-10-24

Final complete Worker run passed **1,131/1,131**, with zero failures/cancellations/skips: prior 1,101 plus 30 new permanent runtime regressions. Focused alert suite **62/62**; application **150/150**. Astro build, check (0 errors/warnings, 6 existing hints), final Wrangler dry run and whitespace checks passed. No unfinished source edit or running test process remains. Only documentation and a descriptive comment followed runtime validation. All 18 task files remain local/uncommitted (5 modified tracked, 13 untracked) at ae2d8ad; no production mutation, deployment, real email or configuration change. The authoritative progress checkpoint contains the exact inventory, tested scope, remaining coverage/operational limits and the reviewed approval-gated rollout. Stop here; unrelated October 22–23 investigations are separate tasks.

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
