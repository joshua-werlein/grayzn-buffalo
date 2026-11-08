# November 8 — bounded AI retries and image-processing alerts

Initial user-authorized scope: implement, validate and deploy the Facebook Worker only, then stop before requeueing today's failed import. Follow-up authorization expressly approved the documented guarded requeue of import `2eda918eaaf9ed3a701673db381b3f8d` only, verification through normal Worker processing, and preservation of the deployed fixes in source control. No transcribed-meal publication, Pages deployment, alert-setting change or migration is authorized.

## Implementation

- `workers/fb-feed/recovery.js`: recognize binding-style AI internal code 8005. Explicit permanent HTTP statuses and existing permanent AI/schema codes retain precedence. Existing 30-minute retry eligibility, three-attempt limit, leases, source-version fences, current-day window and audit accounting are unchanged.
- `workers/fb-feed/image-alert.js`: classify terminal image-processing coverage separately from poster contents. Pending attempts remain silent; successful extraction resolves technical coverage; ambiguous/malformed extracted facts are not reclassified as technical failures. Staff review decisions suppress alerts. Terminal AI failures, marked image acquisition failures and image AI-budget holds are actionable without a caption.
- `workers/fb-feed/worker.js`: mark image-acquisition errors with a fixed stage prefix. Retain existing invalid-image/no-image decisions and the same retry transitions. No parser version change and no automatic reset of failed rows.
- `workers/fb-feed/alert-runtime.js`: persist one technical incident per day and Facebook post (hashed identity). Use existing 30-minute grace, snapshot proof, atomic send authorization, uncertainty quarantine and deduplication. Suppress removed/superseded sources. Known daily, weekly and section cases keep their existing alert routes; do not double-notify them.
- `workers/fb-feed/alert-detail.js`: technical email identifies the import review link, a validated public Facebook URL when available, a fixed failure category and attempt count. It states that image contents are unverified and staff attention is required. No caption, raw provider error, credentials, poster meals or stored staff values enter this message.
- Tests: extended recovery and alert-runtime suites; public-text-only Sunday fixture at `tests/fixtures/nov8-sunday-specials.json`. The fixture is synthetic test input, never a substitute for production image extraction.

No D1 migration, parser/mapping change, dependency update, alert configuration change, Pages deployment or staff-data change is part of this release.

## Verification record

The first nine new checks were run before implementation: eight failed against the old behavior; the protective unrelated/ambiguous-extraction check already passed. Those nine passed after implementation. Additional checks cover acquisition exhaustion, successful recovery without notification, mocked Resend acceptance, diagnostic sanitization and publication of all three Sunday offers.

A complete Worker run exposed duplicate fallback alerting for an explicit Weekly Lunch failure. The technical fallback now excludes known weekly and section cases; the complete alert-runtime rerun passed 73/73 at that checkpoint. An additional diagnostic-sanitization test was added before the final complete suite.

The first application run used previously built artifacts before the fresh build completed. Nine existing menu integration checks failed in that run; all nine passed against the finished fresh build. A full application rerun uses the completed build. No menu source was edited.

Astro check: 35 files, zero errors/warnings, 21 existing hints. Production build passed. Final Wrangler dry run passed with logging directed into the workspace. An earlier dry run's global log write was sandbox-restricted; the final run has no such log failure.

Final complete suites: **1,730/1,730 Worker tests**, **409/409 application tests**, zero failures/cancellations/skips. All 66 pre-existing Worker test files remain present. The final source, test and fixture hashes are in the ignored release manifest. No production error or test email was generated.

## Production release

Deployed November 8 at **10:56:51.722 AM CST** to `grayzn-fb-feed`, Grayz'n Buffalo account `a79e3b4a2bb8dad70c75bceac4b1d3f9`.

- Deployment ID: `12fa954f-d3ea-4fa3-94a8-bbd61ac03256`.
- Active version: `eb32d3f0-f0bc-47a9-9b92-21282c359dfd`, 100%.
- Deployment base commit: `c8876d854363358c1b1b6c560e5c9ed7646ae7a5`. The release was initially deployed from the verified working tree. Follow-up authorization expressly permitted source-control preservation: the eight source/test/fixture files were committed as `5108403e44873717d784b3dc5d51fbb015970291` at 11:11:50 AM CST. Every committed file's bytes match the verified release manifest. No push occurred and Pages CI was not triggered.
- Exact uploaded module SHA-256: `bea610afa8061b8582ac5f42b1ddac79fd27097d07dc7a41c8086b27090b777d`. Downloaded the active module and verified byte-for-byte hash equality with the tested dry-run artifact.
- Postdeployment comparison at 10:58:03 AM CST: alert/import settings, secret-binding presence, queue binding/consumer settings, cron expressions and Pages deployment unchanged. All Sunday slots, today's import and original audit events unchanged. Both public pages HTTP 200 and dynamic/no-store.
- Routes remain `/api/facebook-feed` and `/api/facebook-webhook*`; cron remains `*/30 * * * *`. Queue keeps batch 10, 30-second wait, three retries, 120-second retry delay, concurrency 1 and the existing dead-letter queue.
- The normal next cron is observed separately below. No manual import/requeue or production D1 write was executed. Routine Worker writes after deployment remain governed by its existing scheduled pipeline and the newly authorized alert logic.

The production module contains the tested retry classifier and new technical incident path. Live 8005 errors have not been deliberately generated; recovery, exhaustion, provider acceptance/rejection and uncertainty are verified with mocks/local D1. Historical telemetry API access remains 403; sanitized live tail is available.

## First normal production executions

Observed the deployed version through sanitized live tail:

| CST time | Verified result |
| --- | --- |
| 11:00:15.858 AM | Normal Facebook webhook queue invocation; outcome `ok`, zero exceptions. Alert scan started 11:00:15.966, completed 11:00:17.967. One actionable technical incident, zero sends or uncertain attempts. |
| 11:00:22.890 AM | Actual cron scheduled timestamp for `*/30 * * * *`; invocation event timestamp 11:00:25.545. Outcome `ok`, zero exceptions. |
| 11:00:25.903–11:00:29.457 AM | Cron scan began, completed at 11:00:28.179 and successfully evaluated. The same one technical incident remains actionable; no duplicate incident or send. |
| 11:00:42–11:00:50 AM | Read-only final comparison: original import, all original audit events, Sunday slots, import/alert settings, queue consumer and Pages deployment remain identical to predeployment. Public homepage and `/specials` remain HTTP 200. |

The new incident is `2026-11-08:image_fa6984a0d57bea77e47bdc64:automation_failed`, state attention, dispatch ready, no authorization/sent timestamp, zero attempts. First seen 11:00:15.966; due **11:30:17.967 AM CST**. The subsequent cron preserved that first-seen time and due deadline. Normal grace, deduplication and transport selection worked; no test notification was sent. The actual Resend acceptance/inbox-delivery boundary has intentionally not been exercised in production.

Today's import remains `failed/permanent`, retry count 1, no next attempt, no candidate/extraction. The site still shows fallback pizza and Grilled Ham & Cheese with Soup; Dovi Burger is absent. The classifier fix does not silently reset an existing terminal record. Only a separately authorized recovery can make this record eligible again.

At the final check it is still November 8 within the 7 AM–8 PM CST processing window. Current Sunday slots are unlocked and have no staff edit timestamps; their values and ownership have not changed since predeployment. Refresh these checks again at any approved recovery execution.

## Today's targeted recovery — approved and executed

Target database: `grayzn-db`, `c998bfd4-7031-4ae2-9eea-df86f16ddb15`, account `a79e3b4a2bb8dad70c75bceac4b1d3f9`.

Exact source:

- Import `2eda918eaaf9ed3a701673db381b3f8d`.
- Facebook post `583672228384067_1760770382257505`, created `2026-11-08T15:57:06+0000` (9:57:06 AM CST).
- Parser 19, model `@cf/google/gemma-4-26b-a4b-it`, image hash `4f6f59ec671397c5`.
- Expected status failed/permanent, pending review, attempt count 1, null candidate/raw extraction and next-attempt deadline; original error `Workers AI extraction failed: AiError: 8005: Internal server error`.

Immediately before the authorized recovery, the exact record, full source-version history, recent completed Graph scan/public feed, current Sunday collection, and slot values/locks/edit timestamps were rechecked. The active production version and import/alert/webhook settings also matched. All conditions remained unchanged and within today's processing window. No import trigger was issued; normal cron/webhook processing is observed separately below.

The approved two-statement D1 batch below uses one fresh, unique operation token as `?1`. Execution added atomic predicates pinning the current collection revision/mutation token, every Sunday slot's content/price/link/ownership/lock/edit timestamp/automation baseline, and the Sunday groups' identities and enabled flags. A concurrent staff save or direct slot change therefore vetoes the reset. This is the completed operation's review record, not an instruction to repeat it.

```sql
UPDATE special_imports
SET processing_status='pending', extracted_json=NULL, candidate_json=NULL,
    validation_result=NULL, validation_reason='', processed_at=NULL,
    last_error=NULL, failure_kind=NULL, retry_count=0, attempt_token=?1,
    lease_expires_at=NULL, next_attempt_at=NULL
WHERE id='2eda918eaaf9ed3a701673db381b3f8d'
  AND fb_post_id='583672228384067_1760770382257505'
  AND fb_created_time='2026-11-08T15:57:06+0000'
  AND parser_version=19
  AND model_id='@cf/google/gemma-4-26b-a4b-it'
  AND image_hash='4f6f59ec671397c5'
  AND processing_status='failed' AND review_status='pending'
  AND failure_kind='permanent' AND retry_count=1
  AND last_error='Workers AI extraction failed: AiError: 8005: Internal server error'
  AND extracted_json IS NULL AND candidate_json IS NULL
  AND next_attempt_at IS NULL AND lease_expires_at IS NULL
  AND julianday('now')>=julianday('2026-11-08T13:00:00Z')
  AND julianday('now')<julianday('2026-11-09T02:00:00Z')
  AND NOT EXISTS (
    SELECT 1 FROM special_imports newer
    WHERE newer.fb_post_id='583672228384067_1760770382257505'
      AND newer.parser_version=19
      AND newer.rowid>(SELECT rowid FROM special_imports
        WHERE id='2eda918eaaf9ed3a701673db381b3f8d')
  );

INSERT INTO special_import_events(import_id,event_type,detail)
SELECT id,'requeue','manually requeued for reprocessing (operation:'||?1||')'
FROM special_imports
WHERE id='2eda918eaaf9ed3a701673db381b3f8d'
  AND processing_status='pending' AND attempt_token=?1
  AND NOT EXISTS (
    SELECT 1 FROM special_import_events
    WHERE import_id='2eda918eaaf9ed3a701673db381b3f8d'
      AND event_type='requeue'
      AND detail='manually requeued for reprocessing (operation:'||?1||')'
  );
```

Require exactly one update and one inserted audit event; verify their individual D1 results. Retain all original audit events, source identity, image pointer/hash and discovered timestamp. No other import, slot, default, alert configuration or migration record is manually changed. Do not use the menu-backfill guarded-apply tool: it deliberately supports a different set of tables and operations.

The exact plan was first rehearsed against in-memory SQLite: target update/audit, another-post isolation, repeated-operation idempotence, staff dismissal, past-day source, changed attempt count, expired window and newer-source guards all pass. The audit's unique operation marker prevents a repeated token from inserting a second receipt.

Authorized execution began **11:10:50.401 AM CST**, with postchecks complete at **11:10:51.729 AM**. D1 reported exactly **one update and one audit insert**. The target became pending with retry count 0; image/source identity and all earlier audit events were retained. A comparison of all other import rows and all current Sunday slots proved they were unchanged. The guarded batch SHA-256 is `902d3a40f7750db1b597cb78220a21deee042a195cebbafdd32da5d08e3f7696`. The local one-attempt receipt is confirmed; no retry of that manual operation is allowed or needed.

This resets the permitted attempt budget for this one explicitly approved recovery while preserving its earlier attempt in the audit history. It may later publish newly verified Sunday evidence into eligible Sunday Special and All Day slots. Newer staff edits, locks, date eligibility and deterministic reconciliation still govern each potential write. Successful extraction can resolve the technical alert; a prior sent email remains deduplicated.

## Verified recovery outcome

The normal **11:30 AM CST cron** processed the pending record without any manual import trigger. Its observed scheduled timestamp was 11:30:22.890; invocation event timestamp 11:30:32.244. It ran active version `eb32d3f0-f0bc-47a9-9b92-21282c359dfd`, completed with platform outcome `ok` and zero exceptions.

| CST time | Verified event |
| --- | --- |
| 11:30:35.074 AM | Normal attempt claimed the approved source; audit 729–730. |
| 11:30:36.203–11:30:46.080 AM | Workers AI processed the original saved poster image successfully; the response contains all three offers, original prices and Chili sides. No transcribed fixture or manually entered meal data was used. |
| 11:30:46.321 AM | Validation `ok`, processing status `staged`; audit 733–734. One recovery attempt used, no pending retry or failure kind. |
| 11:30:48 AM | Guarded reconciliation published exactly three Sunday slots; audit 735 records `GUARDED_AUTO: 2026-11-08; reconciled 1 source(s); 3 slot(s)`. |
| 11:30:52.687–11:30:56.549 AM | Scan completed and alert evaluation succeeded. Technical incident became `resolved`; actionable count zero, email sends zero, uncertainty zero. |
| 11:31:06 AM onward | D1, both public HTTP responses, both browser accessibility trees and a rendered Specials screenshot confirm all three offers in the Today cards. |

Both the homepage and `/specials` now display:

1. `16" 3 Topping Pizza and 12 Wings $30`
2. `Dovi Burger with Side Salad, Chili or Coleslaw $10.25`
3. `Grilled Ham and Cheese with Cup of Chili or Coleslaw $7.25`

The displayed inch mark is correctly normalized by the existing publisher even though the raw AI response used two apostrophes. Both side descriptions preserve Chili. All three saved rows are automation-owned, unlocked and exactly match their automatic baselines. Other Sunday rows, including recurring defaults and historical weeks, are byte-for-byte unchanged. All six original failure audit events and the single approved requeue receipt remain intact.

The same technical incident is now `resolved`, with null authorized/sent timestamps, dispatch attempts 0 and no send error. It was resolved before dispatch authorization, so no failure email was sent. A read-only check while the source was pending also proved the earlier failed-source snapshot could no longer authorize a stale notification.

Current import status is staged/ok, review pending, recovery attempt count 1; no failure kind, next attempt or lease remains. The pending review label is independent of successful guarded publication: the publication audit and saved/public values prove recovery.

Cron, webhook and queue configuration, alert configuration, Pages deployment and active Worker version remain unchanged. The committed sources still match the exact deployed artifact; no redeployment was necessary after the commit. No new code changes or repeated production requeue were made during recovery. The earlier 1,730 Worker and 409 application test passes continue to cover the unchanged committed release.

**Outcome: recovered and verified.** The deployed fixes are preserved in source control as `5108403e44873717d784b3dc5d51fbb015970291`; no push or Pages deployment occurred. The completed recovery report and original investigation are retained with the repository documentation.

The processing window ends November 8 at 8 PM CST (`2026-11-09T02:00:00Z`). If authorization arrives after that, do not backfill or move the post to another day. Safe alternatives are leaving history intact for review, or a separately authorized staff correction to the appropriate current website content.

## Rollback

If the release causes repeated alert-evaluation failures, duplicate notification authorization or unexpected publication, stop and review the sanitized logs/state before any further production action. The previous Worker version is `3c5734fb-b3e8-45ea-bb6b-a26674bc07b9`; restoring its code needs no migration reversal. Retain alert history and any legitimate newer staff changes. No rollback or recovery command is executed as part of preparing this plan.
