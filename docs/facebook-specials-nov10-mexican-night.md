# November 10, 2026 — Mexican Night not updated, no alert email

Status: root causes confirmed from production evidence; local fix and regression tests complete. **Not deployed.** No production D1 write, replay, or email was performed.

## Timeline (America/Chicago)

| Time | Event | Source |
|---|---|---|
| Sun Nov 8, 7:00 PM | Weekly creation seeded `mexican-night` from the recurring template (`section_source=recurring`, revision 15, week 2026-11-09). | D1 `special_collections.updated_at=2026-11-09T01:00:24Z` |
| Tue 9:30 AM | "Tuesday Specials" poster imported and published normally (all three prices live). | Public site |
| Tue 3:29 PM | Facebook post `…_1763389068662303`, caption "Mexican Night 5-10pm", with a fully priced poster image. | Graph feed cache |
| 3:30:24 PM | Worker discovered the post; classified `section / mexican-night` ("Mexican Night phrase detected"). | `special_import_events` fetch/classify |
| 3:30:25 PM | Workers AI extraction, attempt 1 (`@cf/google/gemma-4-26b-a4b-it`). | `extract` event |
| 3:31:44 PM | Attempt 1 rejected; one repair reread reserved. | `extract` + `retry` events |
| 3:32:09 PM | Repair reading rejected. Import `failed / rejected / permanent`: "Mexican Night item facts differ from original evidence". | `fail` event, `special_imports` |
| 3:32 PM onward | `reconcileMexicanNight` found no staged source; menu stayed on the recurring (unpriced) template. | D1 collection still `recurring` |
| Each cron | Alert scan completed (`evaluation_state=complete`) with **zero** incidents for the day. | `facebook_alert_scans`, `facebook_alert_incidents` |

## Root cause 1 — Mexican Night was not published

The stored (repair) reading was correct for all eleven printed items, including Taco Salad's `Large $9.00 • Small $8.50 • Mini $6.00` line and all four priced substitutions/add-ons. Every item passes `sameMenuItemFacts` (replayed locally from `tests/fixtures/nov10-mexican-night.json`).

The model attached `uncertainties: ["unreadable text in title"]` to **2 Soft Shell** even though it read that title correctly. The contract-2 validator (`validateExtraction`, `worker.js`) treated any item with an uncertainty as a fatal error for the **entire** menu and reported it with the misleading message "item facts differ". Ten verified items were discarded because of one hedged item.

How that reading came about (confirmed by the read-only production check below): the generic contract-2 first request degenerated into whitespace after item 1's evidence until the 4,096-token cap, so attempt 0 was invalid JSON. The single reread then used the same generic request and produced the hedged reading. The Mexican-only request was never used.

Not a cause: Facebook discovery, Graph API, image retrieval, Workers AI availability, budget, schedule check, D1 revision guards, manual locks, visibility/rendering, or caching. The October 20 Taco Salad size fix (`labelBareSizePrices`) is deployed and worked on this reading.

Deployed Worker `eb32d3f0` (Nov 8, "base c8876d8") matches `HEAD` Worker source (commit `5108403`).

## Root cause 2 — no alert email

No incident was ever created, so nothing reached Resend. This was a coverage gap (listed as out of scope in `facebook-automation-alerts.md`), not a delivery failure:

- `daily` excludes dedicated Mexican Night sources (`dedicated()`).
- The per-image technical scope suppresses them (`covered=dedicated(source) || caption.kind==='section'`), and treats any source with extracted JSON as resolved.
- `weekly` and `wing` do not consider them.
- `reconcileMexicanNight`'s result is discarded in `worker.js`.

A failed, held or partially published Mexican Night post therefore produced no alert. Email configuration was not implicated; the scan ran and completed normally.

## Fixes (local, uncommitted)

Policy decision (owner, Nov 10): keep the October 27 whole-menu fail-closed rule. One unverified item still holds every item; nothing is partially published.

1. **Distinct rejection reasons** (`workers/fb-feed/worker.js`). The old single message is split into `Missing Mexican Night item evidence: "<title>"`, `Uncertain Mexican Night item: "<title>"` and `Mexican Night item facts differ from original evidence: "<title>"`. Validation itself is unchanged. The reason is stored in `validation_reason` and is also what the targeted reread receives, so the repair now names the uncertain item instead of reporting a fact mismatch that did not exist.
2. **Mexican Night alert scope** (`alert-runtime.js`, `alert-detail.js`, `alert-store.js`). This adds one verified incident per Chicago day, `<day>:mexican:mexican_night_failed`, reusing the existing 30-minute grace, proof and revalidation, single send, and Resend uncertainty quarantine. It applies only to a current post whose caption or printed heading says "Mexican Night":
   - pending/processing → pending; staff-owned section (manual save or locked/edited slot) → suppressed;
   - validated but not published (held, or schedule differs) → attention;
   - failed import (validation, AI, retries, budget) → attention;
   - published, with every saved entry confirmed by the poster, or no Mexican Night post at all → no email.

   For today's post this would have produced an email about 30 minutes after the 3:32 PM rejection, around 4:02 PM Chicago.

3. **Unconfirmed recurring entries** (Option A, `alert-runtime.js`, `alert-detail.js`, `alert-store.js`). This runs after a validated menu has published normally. It is detection only: it writes nothing and validation is unchanged. It names saved entries that today's poster did not confirm and that therefore show without a current price. It reports two kinds of entry: (a) a whole item absent from the validated reading and unpriced; (b) an `Add…`/`Substitute…` line kept from the template under a dish whose poster entry printed no description, such as today's Chips line. Ordinary ingredient fallbacks are not reported. It uses the same once-per-day Mexican Night incident key, so it can never send a second email for that day. It has its own cause, `mexican_night_incomplete`, a subject ending "(Mexican Night: unconfirmed entries)", and a body that says "Published — not a validation failure". A staff save suppresses it.

## Regression tests

The `November 10:` tests in `workers/fb-feed/alert-runtime.test.js` replay the production reading (`tests/fixtures/nov10-mexican-night.json`) through the full pipeline. They cover:

- whole-menu hold with the uncertainty named, the recurring menu untouched, one email after grace, and same-day deduplication;
- a size-price mismatch and missing evidence reported distinctly from uncertainty;
- the reread request carrying the targeted reason;
- a clean reread publishing every price, the labelled Taco Salad sizes, and the four standing substitutions/add-ons;
- the complete poster (Chips add-on included) publishing with no incident;
- today's reading without the Chips line publishing normally and emailing once, naming only "Add Nacho Cheese or Salsa", worded as missing information rather than a failure, and deduplicated across crons;
- a recurring dish missing from the poster being named, with no price invented;
- a staff price after publication suppressing the email and never being overwritten;
- a rejected import staying requeueable, with recovery before grace sending nothing;
- staff corrections never overwritten and suppressing the alert;
- no incident without a Mexican Night post or for an unrelated poster;
- a Resend 503 recorded as `uncertain/send_failed` and never resent.

The October 20 and October 27 Mexican Night regression tests are unchanged and pass.

## Live AI experiment (authorized; 10/10 calls, read-only)

The run used a throwaway local `wrangler dev` proxy whose only binding was Workers AI (no D1, R2, KV, queues or routes). The cap was 10 calls, enforced in both the proxy and a ledger, and the proxy was stopped afterwards. The model was `@cf/google/gemma-4-26b-a4b-it`. Requests came from the repository's `buildReliableExtractionRequest`, and readings were scored by the current `validateExtraction`. The image was today's poster as served at `grayznbuffalo.com/img/facebook/…-3a302c2e27da31e6a9a8.jpg`, not the R2 copy production read; the bytes may differ. Total usage was 665.9 neurons. Raw outputs were kept in the session scratchpad, not the repository.

| Request | Calls | Valid | 12 items | 2 Soft Shell clear | Chips add-on recovered | Latency |
|---|---|---|---|---|---|---|
| First attempt (production contract-2 request) | 3 | 0 | 0 | — | — | 82–90 s |
| Deployed reread (generic "facts differ" reason) | 3 | 3 | 3 | 3 | 3 | 15–18 s |
| Improved reread (names the uncertain item) | 4 | 4 | 4 | 4 | 4 | 17–22 s |

Findings:

- **First attempt fails every time:** the three outputs were byte-identical. The model starts a correct Mexican Night reading, then emits only whitespace from the first item's `uncertainties` field until the 4,096-token output limit, so the JSON is truncated and invalid. Production attempt 1 ran 79 s (3:30:25 to 3:31:44), consistent with the same truncation. This is inferred, not confirmed: production's attempt-1 raw output is in `special_import_events` and was not read.
- **Consequence:** with a cap of two AI calls per import, a Mexican Night post effectively gets **one** real reading, the reread. Any hedge in that single reading holds the whole menu.
- **Rereads were reliable in this sample:** all 7 rereads, deployed and improved prompts alike, returned complete, valid 12-item readings with no uncertainties and the Chips add-on in a continuation group. The improved reason could not be shown to help, because the deployed reread also succeeded 3/3 on this image.
- **Same field, two failures:** today's bad production reread flagged exactly the field where every first attempt degenerates (item 1's `uncertainties`). The phantom "unreadable text in title" looks more like a decoding artifact than a real reading problem; the chili-icon idea is weaker. This remains a hypothesis.

Resolved by the production check below: the image bytes are identical, and production's reread was the generic request, not the Mexican one these rows tested.

## Read-only production check (owner-run D1 SELECTs; R2 object read)

- **Confirmed: attempt 0 was truncated.** Event 760 (`evidence-v2-response`, attempt 0) shows 78,445 ms, `completion_tokens: 4096` (the cap) and 140.5 neurons. The output is the correct heading and 2 Soft Shell's evidence, followed by 31,456 spaces from character 501 until the cap. That makes it invalid JSON ("Expecting ',' delimiter").
- **Confirmed: the reread was generic, not Mexican-specific.** Because attempt 0 failed as "response is not valid JSON", it carried no Mexican repair shape. Attempt 1 (event 763: 25,592 ms, 1,211 completion tokens) therefore used the generic contract-2 request, with the whitespace-padded output pasted in as "previous". That reading carried the phantom 2 Soft Shell uncertainty, and its validation produced the final "facts differ" message (event 764).
- **Ruled out: image differences.** The R2 object `special-imports/583672228384067_1763389068662303-…-74a58574-….jpg`, the public copy used in the experiment, and the stored `image_hash` (`9100e6ed78f6d599`) are byte-identical (SHA-256 `9100e6ed78f6d599…`).
- **Correction to the experiment:** the "deployed reread" rows above used the Mexican shape, which is not what production ran. Production's actual path was generic, then generic.

## Mexican Night first request (implemented)

- `classify.js`: `confidentMexicanNightCaption()` is true only when the caption names Mexican Night and has no other specials signal (lunch, specials, delivery, soup, wings, pizza, fish, burgers, weekly, or a weekday other than Tuesday). It selects a request and is never a write gate.
- `extraction.js`: the existing Mexican-only contract-2 request can be built as a first reading. The rules, schema and evidence/uncertainty fields are the same; only the "previous reading needs repair" sentence is dropped.
- `worker.js`: for such a caption, attempt 0 uses the Mexican request, and the single reread keeps the Mexican shape, including after invalid JSON. If the Mexican reading is complete but finds no printed Mexican Night heading, the reread falls back to the existing generic request. Validation, the whole-menu policy, the two-call and three-reservation limits, manual locks, alerts and the legacy (non-contract-2) path are unchanged. The retry audit event now names the Mexican Night retry.
- Tests: `workers/fb-feed/nov10-mexican-first-prompt.test.js` covers caption selection, one-call success, the production truncation reread in the Mexican shape, two unusable readings staying held with no further AI calls, the no-heading fallback to generic, generic first requests for mixed or empty captions, and staff locks.

## Production follow-up (requires authorization)

- Deploy `grayzn-fb-feed`. There is no migration and no configuration change.
- Today's import is `failed/permanent`, so it will not retry on its own. Before close, staff can enter tonight's prices in **This Week's Mexican Night** (a manual save, which is protected). Requeueing import `51e0de4c35e3d9b25930cdf5ae3e0d1b` would be a production D1 write, and under the kept policy it can still be held again. After tonight the menu is moot; Sunday reseeds the template.
- After deployment, verify the next Tuesday's import publishes and that `facebook_alert_incidents` behaves as above.
