# Sunday Facebook specials audit — September 27, 2026

## Preservation and isolation

- Approved hero branch: `codex/hero-regression`, clean at `58bdaaf4e7bfda5de7b7b0a2053dba664b5413cf`.
- Pushed that existing branch only; verified GitHub now has the exact commit. No redundant commit or merge.
- GitHub main remains `0138604acc487e4e8ee10b450230ad05046b25c6`.
- Facebook changes are independently based on that main commit in `codex/facebook-current-day`, at `C:/Users/Jwerl/.codex/worktrees/facebook-current-day/Grayzn Buffalo`.
- Primary checkout files were inspected only. Its uncommitted Worker/test and hero changes were not copied, staged, committed, stashed, reset, or overwritten.
- No Worker deployment, production database write, import requeue, or prior-day publication was performed.

## Production trace and answers

Evidence was obtained with read-only remote D1 queries, the public feed and homepage, and Cloudflare's deployed-script endpoint. Deployment version: `9c49e879-7c1b-4742-ba8e-b65b25e54234`, created `2026-09-27T01:00:11.118Z`.

1. **Fetched:** yes. Facebook post `583672228384067_1715818976752646`, posted September 27 at 8:40:54 AM Chicago (`2026-09-27T13:40:54+0000`). Caption is empty. The public feed also contains this post and its image.
2. **Stored:** yes. Import row and R2 image key/hash exist. The public image is accessible. The import's stored key is below; the production extraction response itself establishes successful image reading at processing time.
3. **Import ID:** `6ea39f7ea9112cb32f6c11da8f29391a`.
4. **Import fields:**
   - `processing_status`: `failed`
   - `review_status`: `pending`
   - `validation_result`: `rejected`
   - `validation_reason`: `response is not valid JSON`
   - `parser_version`: `12`
   - `processed_at`: `2026-09-27T14:01:16.998Z`
   - `fetched_at`: `2026-09-27T14:01:16.155Z`
   - `image_r2_key`: `special-imports/583672228384067_1715818976752646-0437489e28baea2c0245.jpg`
   - `image_hash`: `70faa6e7fdeacef9`
   - `candidate_json`: null; `last_error`: null; `retry_count`: 0.
5. **AI invoked:** yes. Stored response and `extract` audit event establish invocation of `@cf/meta/llama-3.2-11b-vision-instruct`.
6. **Actual AI result:** prose describes all three dishes, including Crispy Hawaiian and $10.25, followed by a supposed JSON object. That object incorrectly sets `day_of_week:3` while its evidence says Sunday, omits prices from dish content, and copies `11am-10pm` to individual offers. It is not acceptable extraction evidence.
7. **Schema accepted:** the deployed code does send `response_format: {type:'json_schema', json_schema:{name, schema}}`. The provider returned a normal response, not a schema/API exception. This proves request acceptance, not schema enforcement. The response was prose. The current Llama model documentation does not advertise structured output; a separate corrected-schema Llama probe reproduced prose and the wrong day. A schema-only fix is insufficient.
8. **Three offers:** recognized in prose, but never produced as valid usable structured evidence with correct day and prices.
9. **Validation:** rejected immediately as invalid JSON. No candidate was staged.
10. **Sunday mapping:** did not run on usable evidence in production. Existing `reconcilePosters` already maps an unambiguous daily three-offer Sunday poster to lunch/Sunday Special, then All Day positions 1 and 2. The corrected live extraction passed that mapper locally.
11. **Why Western Burger remained:** invalid extraction never reached publication. There is also an independent locked-slot blocker.
12. **Actual guard values:** all three populated Sunday slots are `origin='legacy'`, `manual_locked=1`, `last_auto_value=NULL`, with empty `price` and `section_link`. Western Burger is `day:301:all-day`, position 1. These values match the recurring defaults, but matching text alone does not establish that a lock is safe to disregard. The migration originally marked nonempty legacy content locked. This differs from newly provisioned defaults, which use `origin='manual', manual_locked=0` and are eligible already.
13. **Processing window:** yes. Fetch/extraction started at 9:01 AM Chicago; extract/validate/fail events were recorded at `14:01:34Z`. Config is every 30 minutes; allowed extraction/publication hours are 7 AM inclusive to 8 PM exclusive.
14. **Budget:** not the cause. Two processed rows and two extraction events were observed for today's Chicago window, below the configured 50. Sunday's row demonstrably ran AI. Old accounting counts rows and does not establish every retry invocation. Three separate diagnostic AI calls were made during this audit (one Llama, two Gemma); they did not touch import or slot records.
15. **Retry:** production only retries thrown JSON-mode errors. Today's prose result did not throw, so there is no retry event. Both production retry branches also shorten the extraction instructions. Initial object/string response handling exists, but the old code does not handle the modern chat-completion response shape used by Gemma.

The homepage reads normalized saved-week collections via `getWeeklySpecialsForDateRange`, then `visibleGroups` and `SpecialGroup`. Its public HTML still contained Western Burger and did not contain Crispy Hawaiian during this audit. The D1 migration gate is healthy (`version=15, mismatches=0`).

## Claude's current work: what it covers and misses

The current primary diff changes `worker.js`, `ai.test.js`, and `guarded-auto.test.js`. It adds an extraction schema and JSON-mode exception detection, changes requests from `json_object` to `json_schema`, replaces format-failure retries with exception-only retries, and shortens retry prompts. Tests were changed to expect thrown JSON-mode errors rather than malformed responses. The deployed script contains these changes.

Object/string response handling, pending reprocessing, weekend three-offer mapping, per-slot reconciliation, and unlocked manual/default eligibility are already in committed main. They are not newly added by this uncommitted diff. The pending query lacks a source-date filter. AI counting still counts processed rows and omits retry calls. `retry_count` is not a durable provider-call ledger. Default eligibility is correct for new unlocked copies but does not repair old locked legacy rows.

## Smallest verified code fix for these defects

- `workers/fb-feed/extraction.js`: shared full prompt/schema/request builder. Uses Gemma's multimodal message format and structured-output envelope. Removes the misleading concrete Wednesday example. Preserves 150-character fields and existing semantic validators.
- `workers/fb-feed/wrangler.toml` and `worker.js`: select `@cf/google/gemma-4-26b-a4b-it`. This is necessary because the live Llama probe reproduced failure despite a corrected request. The model change affects all poster types; local weekly/Mexican tests remain necessary and live validation here covers Sunday only.
- `worker.js`, `runAiExtraction`: one bounded retry for invalid JSON/no response or JSON-mode/schema errors; identical image, full prompt, and schema on both attempts. Supports string/object legacy envelopes and `choices[0].message.content`. Retains provider errors and final returned evidence. No retry for semantic rejection.
- `worker.js`, `AI_COUNT_SQL` / `countTodayAiCalls`: atomically reserve one `extract` event per provider invocation, across models, including retries and errors. Existing processed rows without extract events are counted conservatively. Requeuing cannot erase recorded calls. Missing images cause no AI reservation. A crash between reservation and invocation may conservatively consume one unused reservation; provider-side exactly-once billing cannot be guaranteed across a crash.
- `worker.js`, pending-record query: only pending, unreviewed rows from today with the current parser and model may reprocess.
- `guarded-auto.js`, `reconcileToday`: independently rejects prior-day source IDs. Existing slot eligibility and concurrency checks remain intact.
- `guarded-auto.js`, `applyWeeklyLunch`: only fills today and future dates of the selected week, never elapsed weekdays.
- `classify.js`: parser version 13 ensures a current-day post receives a fresh claim after deployment, without overwriting the failed version-12 audit row. The scan remains today-only.
- Focused tests: `current-day.test.js`, updated AI request assertions, and two parser-version assertions in `daytime.test.js` and `mexican-night.test.js`.

No new migration is required: accounting uses the existing indexed `special_import_events` table and allowed `extract` event type. No hero/page changes are part of this branch.

## Live candidate verification

The exact proposed request returned HTTP 200 and valid Sunday evidence from the public poster. All three prices and dishes were present; all content stayed within 150 characters. `validateEvidence` accepted it and `reconcilePosters` produced the correct Sunday Special / All Day pair. Exact result: [sunday-extraction-probe.json](sunday-extraction-probe.json). It preserves printed wording such as “ONLY” and offer numbers; the important dish/side/price information is complete.

Documentation checked:
- https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/
- https://developers.cloudflare.com/workers-ai/features/json-mode/
- https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/

## Deployment decision and today's remaining data blocker

No deployment has been performed. Code tests and the live Sunday probe support the proposed change, but code deployment alone cannot replace the live locked Western Burger slot.

A separate, explicit approval is needed to reclassify **only** `day:301:all-day`, position 1, as an unlocked recurring fallback (`origin='manual', manual_locked=0`). Before doing that, recheck that it is still today's slot, still exactly Western Burger, still legacy/locked with null last_auto_value, and still matches the recurring default. Make the metadata change with the collection revision/concurrency guard and an audit record; preserve its content until valid Facebook evidence replaces it. Do not unlock staff-origin corrections or all legacy slots. If today's date has passed, skip this entirely.

This narrow data action is proposed because the user's product rule permits default replacement but protects intentional locks, and historical migration metadata cannot by itself prove staff intent. No SQL or production write was executed.

After approval: deploy only this Worker from this branch, leave main/hero alone, allow today's normal cron to create the new parser/model claim, and read back the import, reconciliation events, Sunday slots, and homepage. Stop if extraction is ambiguous. No yesterday requeue or backfill.

## Final validation

- Focused AI, Sunday/current-day, and guarded reconciliation run: 98/98 passed.
- Expanded current-day tests including elapsed-weekday prevention: 12/12 passed.
- Legacy Worker test group after updating its accounting/message test double: 34/34 passed.
- Final complete Worker suite: **279/279 passed**, zero failures, zero skipped (124.8 seconds).
- `wrangler deploy --dry-run`: successful bundle, 81.94 KiB / 19.72 KiB gzip; explicitly exited without deploying.
- `git diff --check`: passed.
- Isolated live API probes: old Llama still failed; both Gemma probes returned structured Sunday evidence. The final probe used the exact shared request builder committed here. No production slots were written.
- Hero worktree rechecked clean. Remote hero and main hashes rechecked unchanged after preservation. Primary checkout retains the same uncommitted file set and diff sizes.

**Readiness:** the Worker fix is ready for a reviewed deployment with post-deployment verification. The complete Sunday website correction is not achievable by deploying code alone: today's legacy Western Burger slot remains locked. Approve that one fallback reclassification separately; do not weaken the global manual-protection rule. Only Sunday has been live-probed with the new model; weekly and Mexican Night behavior is covered by local regression tests.
