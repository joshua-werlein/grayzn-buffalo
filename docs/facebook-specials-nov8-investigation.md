# November 8, 2026 — Sunday specials investigation

Follow-up: the verified fixes were deployed and the explicitly authorized guarded recovery succeeded during the 11:30 AM CST cron. Both public pages now show all three offers and the technical incident is resolved. See [the completed release and recovery report](facebook-specials-nov8-fix.md). The findings below retain the investigation-time observations.

Investigation only. No implementation, production data, deployment, notification configuration, migration, manual requeue, or import trigger was changed. Local diagnostics and evidence are under ignored `.wrangler/nov8-*` files. All times below are America/Chicago, CST (UTC−06:00).

## Finding

Today's image-only Facebook post was discovered and its poster saved, but Workers AI threw `AiError: 8005: Internal server error`. The Worker classified this as a permanent failure after one attempt. There is no extraction to reconcile, so the existing Sunday defaults remain visible. This is a failed extraction with silent monitoring coverage, rather than a parser extracting only two of three offers.

The absence of an email is explained by a second, independent behavior: terminal daily-import alerts require a usable explicit current-day specials caption. This post's caption is empty. The failed image cannot supply affirmative specials evidence. The evaluator leaves daily coverage pending and creates no incident. A successful scan/healthy heartbeat therefore does not establish successful extraction or complete publication.

## Repository and production identity

- Initial tracked working tree clean; branch `main`, HEAD and local `origin/main` both `c8876d854363358c1b1b6c560e5c9ed7646ae7a5`. A read-only `git ls-remote` confirmed remote main at the same hash.
- Recent bartender menu commit `3481a30` and subsequent sauce-test repair are preserved. No branch or git ref was changed.
- Production Worker version `3c5734fb-b3e8-45ea-bb6b-a26674bc07b9`, deployed November 7 at 12:43:42.814 PM CST, serves 100%. Downloaded deployed source confirms the same retry classifier and caption-dependent alert evaluator as the inspected local source.
- Production settings: GUARDED_AUTO, evidence contract 2, conditional verification, Gemma model `@cf/google/gemma-4-26b-a4b-it`, webhook RUN. Alerts EMAIL, provider RESEND, approval true. API-key and recipient secret bindings are present; values were neither read out nor reported.

## Verified timeline

| Central time | Evidence |
| --- | --- |
| 9:57:06 AM | Facebook publication timestamp from both the import record and public feed, post `1760770382257505`. This corrects the approximate publication time in the report. |
| 9:58:24.173 AM | D1 import first-discovered/fetched timestamp. |
| 9:58:24.261 AM | Fetch/attempt and empty-caption classification audit events 722–723. The caption classification `ignored` does not skip image processing. |
| By 9:58:25.277 AM | Poster image persisted with R2 key and hash; AI extraction attempted, audit 724. |
| 9:58:26.036 AM | Error/validation/fail events 725–727: AI internal error, no raw extraction or candidate JSON. |
| 10:00:24.966 AM | Subsequent persisted alert scan started; completed 10:00:31.560, evaluated 10:00:33.346, state `complete`, same source. Historical invocation telemetry is forbidden, so these application timestamps do not independently establish the trigger type or platform outcome. |
| 10:19–10:24 AM | Repeated read-only checks: permanent failure, attempt count 1, no next attempt, no incident; public pages still show pizza and ham with Soup, no Dovi Burger. |
| 10:30:22.890 AM | Actual `scheduledTime` reported by live tail for `*/30 * * * *`; invocation event timestamp 10:30:23.773. These are observed timestamps, not an assumption of execution at exactly :00. |
| 10:30:24.037 AM | D1 alert scan started. Completed 10:30:27.934; evaluated 10:30:29.151, state `complete`. |
| 10:30:25.527–10:30:30.335 AM | Live invocation warned that specials need attention; daily alert observation was `pending`, actionable count 0, dispatch sent 0/uncertain 0/superseded 0. Platform outcome `ok`, no exceptions; tail received by 10:30:31.447. |
| 10:30:45–10:30:50 AM | Post-run D1/public verification: same one-attempt permanent failure, no new import events, all Sunday slots unchanged, no incident. Both public pages still omit Dovi Burger and retain Soup; both HTTP 200/dynamic/no-store. |

The initial 9:58 attempt is between cron boundaries and consistent with the enabled webhook queue. Its exact trigger is unverified because historical invocation log access returns 403. Do not infer cron failure or success from that timestamp alone.

**Final status: the 10:30 execution occurred and did not fix the website.** No later recovery was present through the final 10:30:50 AM check. A successful platform invocation does not mean this source was successfully imported. This is not merely waiting for the first polling opportunity: an attempt had already failed at 9:58, and both the 10:00 application scan and the directly observed 10:30 cron left it terminal.

## D1 and website explanation

Current week is November 2–8, weekly id `276508344324535`, collection `8714712e-2a07-48b2-ab85-98a43d259e92`. Sunday contains:

| Destination | Stored content | Ownership |
| --- | --- | --- |
| Sunday Special, position 1 | `16” 3-Topping Pizza & 12 Wings` | manual origin, unlocked, null auto baseline and edit timestamp |
| All Day, position 1 | blank | no current burger |
| All Day, position 2 | `Grilled Ham & Cheese with Cup of Soup or Coleslaw` | manual origin, unlocked, null auto baseline and edit timestamp |

The populated values exactly match the current recurring defaults. Their group IDs have the automatic default-copy structure. Automatic week provisioning deliberately copies populated defaults as unlocked manual-origin values; the current rows match that behavior. There is no current Facebook-derived Sunday publication and no audited staff review for this source. Historical individual editing cannot be reconstructed from these fields alone.

Thus the Dovi Burger is absent because today's extraction never produced it; Soup is existing default wording, not an AI substitution of Chili. Prices are also absent in the saved fallback values. Today's attempt wrote tracking/image/error state to D1, but did not reach specials-content publication. No manual lock or destination-capacity rule caused this failure. Weekly values are eligible for current evidence; recurring defaults themselves remain protected from automatic publication.

Both homepage and `/specials` return HTTP 200, `Cache-Control: no-store`, `CF-Cache-Status: DYNAMIC`, with matching saved fallback content. Stale SSR/CDN output does not explain the observed discrepancy. The separately cached Facebook feed is not the source used for import scans.

## Mapping, retry and notification trace

Contract 2 explicitly supports a dated Sunday Specials poster containing three priced meals: first to Sunday Special/Lunch, second and third to All Day positions 1 and 2. An investigation-only synthetic fixture with the three user-supplied meals confirms Dovi Burger and Chili survive this mapping. A separate test preserves a locked staff correction. No mapping extension is needed. This demonstrates supported transcription, not a successful live AI reading of today's image.

`recovery.js:isTransientFailure` recognizes selected AI internal codes and HTTP statuses, plus network/transient wording. Bare code 8005 and `Internal server error` match none of these rules. `worker.js:processImportAttempt` consequently sets `failed/permanent`, clears `next_attempt_at`, and `claimImportAttempt` only reclaims pending or expired processing work. Repeated cron and webhook queue runs do not reopen a failed record. Queue retries address thrown queue-handler failures, not this caught, persisted per-image failure.

Production cron is `*/30 * * * *`; there is no second scheduled fallback. It runs on UTC half-hours, which remain Chicago half-hours through DST changes. The application uses America/Chicago date/hour windows (7 AM inclusive to 8 PM exclusive), so 10:30 AM CST is 16:30 UTC. Webhook queue retries are configured for 120 seconds, up to three retries, then DLQ; the half-hour cron is the webhook fallback. Neither path overrides a permanent import status.

Alert assessment is enabled and completed at 10:00 and 10:30. `assess` cannot establish a terminal daily offer from the empty caption; `No extracted evidence` becomes pending coverage. `recordVerified` inserts a new incident only for attention. No incident exists today: there is no due email, no sent marker, no uncertain dispatch, and no deduplication/cooldown record preventing it. The 30-minute alert grace would also defer a newly identified failure; it is not the enduring cause here because no incident starts the timer. At 10:30 live logs directly confirm observation, dispatch and health functions ran with zero sends and zero actionable incidents.

Code tracing and the empty incident table establish that this import did not authorize a Resend send. Provider acceptance/rejection is consequently not the reason for silence. Resend provider history and inbox delivery were not independently queried, and present secret bindings do not prove credential validity. Known extracted unresolved/blocked offers can alert; staff-only protection is suppressed. An offer entirely omitted by vision cannot be detected by comparing only that same extraction.

## Smallest recommended correction (not implemented)

1. Narrowly classify the observed binding-style 8005 internal error as retryable, using the existing bounded three-attempt lifecycle. Preserve permanent configuration/authorization/schema error handling. Cloudflare's current published error table does not list 8005, so do not claim its HTTP status was observed or officially documented: https://developers.cloudflare.com/workers-ai/platform/errors/.
2. Add a distinct technical image-processing coverage alert for a recent discovered image whose bounded attempts terminally fail, even without a caption. Describe unknown poster contents honestly; do not call unverified images specials. Keep staff decisions, date eligibility, grace, deduplication and delivery fences.
3. Monitor coverage independently of the completed-scan heartbeat. For successful extraction, compare expected/verified offers with actual published or explicitly protected destinations. Detect unseen omissions only through additional evidence or review, not an invented expected count for every image.
4. Deploying a classifier fix alone will not retry this already-permanent record. Recovery of today's source would require a separately authorized, targeted requeue after reviewing the fix and current staff edits. No such action occurred.

## Verification

Four new ignored diagnostic checks reproduce the bare 8005 classifier result, permanent/no-retry/no-incident behavior across a simulated next cron, all three Sunday offers, and staff protection. They assert the current diagnosis and are not regression tests for an implemented fix.

Selected existing recovery, alert-runtime, Resend and Sunday-soup tests plus these checks: 140 total. Initial run passed 136; four local workerd tests failed with localhost EACCES. A targeted rerun with local runtime access passed all four (synthetic D1 and intercepted outbound only). Thus every selected check passed across the two runs; no application source changed. No full build was needed for this investigation.

For an eventual correction, convert the 8005 diagnosis into expected retry/recovery/exhaustion tests; add captionless technical alert grace/send-once/recovery tests; preserve Sunday mapping, newer staff edit and lock tests; retain partial-publication, omitted-offer coverage, provider rejection/timeout/quarantine and duplicate suppression checks.

Historical telemetry remains access-restricted. Live sanitized tail, D1 application audit timestamps and public HTTP observations provide separate evidence; none is represented as unavailable historical invocation detail.
