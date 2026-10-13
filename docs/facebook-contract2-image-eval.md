# Contract 2 real-image evaluation, 2026-10-12

Authorized limited evaluation: original Facebook poster images from R2 (read-only), the production Workers AI model, at most 20 calls, nothing published.

## Method

- Images: 7 originals downloaded with `wrangler r2 object get --remote` (read only) using keys from a read-only D1 SELECT. Copies were kept in the session scratchpad, not the repository. Ground truth was transcribed by reading each image before any model call.
- Model calls: `@cf/google/gemma-4-26b-a4b-it` through a throwaway local `wrangler dev` Worker whose **only** binding was Workers AI (no D1, R2, KV or queue), with a hard cap of 20 in both the proxy and a persistent ledger. Requests were built by the repository's `buildReliableExtractionRequest`; responses were validated and planned by the repository's own `validateExtraction` and `reconcilePosterEvidence`, mirroring the Worker's conditional-repair loop. Each poster was evaluated as if processed on its own posting date. Captions were empty (as in production for these posts).
- Saved actual model outputs: `tests/fixtures/contract2-eval/*.json`; replayed by `workers/fb-feed/real-image-eval.test.js`.
- Nothing was written to D1 or R2; no specials were published; no reconciliation or deployment ran. Proxy stopped after use.

## Usage

20 / 20 calls, 0 errors. Model latency min 1.7 s, median 7.1 s, max 29.6 s (Mexican Night). 57,975 prompt + 7,584 completion tokens, 582.3 neurons total (~29 neurons per call; ~2,700 prompt tokens per daily image call, ~4,400 for a repair carrying a long previous reading).

Calls: 6 under the original schema (all trapped, see Finding 1), 12 under the fixed schema (7 posters, conditional strategy), 2 independent second reads.

## Findings

### 1. Original contract-2 schema trapped every daily poster (fixed)
Structured decoding emitted keys in sorted order. `evidence_version` was in all three shapes and was the first sorted key only of `mexican-night`, so a daily poster starting `{"evidence_version"` was locked into Mexican Night with `groups:[]`. Oct 10, 11 and 12 were all rejected after 2 calls each (6 calls). Deployed, contract 2 would have rejected every daily poster. Mocked tests could not detect this.
Fix: the model is no longer asked for a version; the request selects the contract and code stamps it. A schema test now requires each shape's first sorted key to belong to no other shape (mutation-checked against the original schema).

### 2. Two validator false rejections (fixed)
- A spaced hyphen before a price (`Drink - $9.75`, transcribing the printed dash) was treated as a negative price. Now only an attached or leading minus is negative.
- The shared formatting rules instruct the model to join a bundle printed on separate lines with `&` (Oct 11 pizza and wings, $30), but the fact check rejected that added `&`. Now an `&` may be added; it may never replace a printed `or`, and no printed word may be dropped.

### 3. Results with fixes (actual outputs, current code)

| Poster | Ground truth vs reading | Calls (conditional) | Would publish |
|---|---|---|---|
| Oct 10 Saturday | Exact: 3 meals, prices, sides, Soups | 1 | Saturday Special, 2 All Day, Soup: correct |
| Oct 11 Sunday | Exact; `&` added between pizza and wings as instructed | 1 (2 before fix) | Sunday Special, 2 All Day, Soup: correct |
| Oct 12 Monday | Exact; model itself flagged the printed missing "or" as uncertain | 2 | **Nothing** (gate: meal 3 unverified, meal 2 unlabeled, unknown service holds all food). Defaults remain |
| Oct 12 weekly | Heading read correctly but **daily shape with zero offers** | 1 | **Nothing**. Legacy retried with weekly-only schema and published 5 lunches |
| Oct 6 Mexican Night | All 7 dishes, prices, add-ons (incl. `50c`, `+$1.50`) transcribed accurately, but as **daily offers** | 2 | **Nothing**; menu not updated. Legacy published |
| Oct 5 Monday night | Exact first read, no labels; repair copied MONDAY NIGHT onto the All Day repeats | 2 | **Nothing**. Legacy four-offer night rule published |
| Oct 7 Wednesday night | Wing Night prices and meals exact | 2 | **Soup only**. Legacy Wing Night pair rule published |

No reading invented a price, side, connector or date. All factual errors were held rather than published.

### 4. Verification strategy
- Independent second reads of Oct 10 and Oct 11 matched the first reads exactly (identical fact/service fingerprints).
- All five conditional repairs reproduced the first reading's facts; none resolved its issue. One (Oct 5) introduced a wrong service assignment, copying the night heading onto All Day offers.
- Conclusion: a second call of the same model is highly correlated with the first and is not independent verification. `always` would double cost for no observed accuracy gain. `conditional` adds cost without observed benefit on these posters; with Finding 2 fixed, Oct 10/11 need 1 call. **Recommendation: `single`, or `conditional` restricted to shape errors** (weekly / Mexican Night misreads, where the legacy targeted single-shape retry demonstrably worked).

## Round 2: business-rule restoration (local; no additional AI calls)

Owner decisions applied: explicit evidence first, then narrowly defined established house layouts; partial publication scoped to slots an unresolved meal could actually take; same-cron repeat matching by identical facts only. All results below re-run the SAVED real model outputs through the full Worker pipeline (`workers/fb-feed/real-image-eval.test.js`, end to end through the guarded D1 publisher).

### Fixes in this round
- **Planner** (`evidence.js`): unknown service no longer holds every food service. An unresolved meal holds a verified offer only if it could take its slot (printed ahead of it while that service has free capacity) or if it is the same dish with different facts on any post. Restored layouts: day poster (Lunch/Day Special + two All Day), Wednesday Wing Night + two All Day, Monday/Friday four-offer night poster, night poster whose repeats exactly match a known All Day offer, single-service heading. A `service_evidence` that merely repeats the poster heading is heading scope, not offer evidence. Layout identification needs priced meals, not perfect wording, so one ambiguous meal is held in its own slot.
- **Same-cron repeats**: verified All Day offers from this run's day posts (and existing automation) identify identical repeats on night posts, in either processing order. Different price or description is never a repeat.
- **Shape repairs** (`worker.js`, `extraction.js`): a weekly heading in daily shape, an explicit Mexican Night heading, or a Tuesday reading with night/no offers triggers ONE single-shape contract-2 reread under every strategy. A reread that validates worse never replaces a usable first reading. A missing service label never triggers a repair (a reread copied the night heading onto All Day offers).
- **Wing Night** (`wing-night.js`): `&` accepted between the two independently labelled prices.
- **Mexican Night fact check**: tolerates a price line printed twice; still rejects dropped/invented amounts, swapped size prices and changed add-on prices.
- **Rollback safety** (`classify.js` + callers): contract 2 stores rows under parser version 19. Supersession is per parser version, so a same-day deploy or rollback never permanently blocks the other contract's rows (previously both directions failed; regression tests in `contract-rollback.test.js`).

### Should publish vs. Contract 2 now

| Poster | Should publish (from the image) | Contract 2 now | Basis |
|---|---|---|---|
| Oct 10 Saturday | Saturday Special Philly & Fries $11; All Day German Burger $10.25, Chicken Salad $7.25; Soups list | Identical, 1 call | Real reading |
| Oct 11 Sunday | Sunday Special 16" Pizza & 12 Wings $30; All Day Olive Burger $10.25, Chicken Salad $7.25; Soups list | Identical, 1 call | Real reading |
| Oct 12 Monday | Lunch Caesar Salad & Drink $9.75; All Day Cheddar BLT $10.25; Chicken Salad held (see ambiguity) | Identical; Chicken Salad slot keeps its recurring default; 2 calls | Real readings |
| Oct 12 weekly | Mon–Fri lunches for 10/12–10/16 | 5 lunches published to the printed week after one weekly-only reread | Real first reading + constructed reread; **confirmed with the real reread** (Final validation) |
| Oct 6 Mexican Night | Full menu incl. Nacho Deluxe, labelled Taco Salad sizes, substitutions | Complete menu after one Mexican-only reread; never published as Tuesday daily | Real first reading + constructed reread; **confirmed with the real reread** (Final validation) |
| Oct 5 Monday night | Nightly 2 Burgers $14, Half Rack Ribs $18.75; All Day BLT $10.25, Chicken Salad w/ Cup of Coleslaw $7.25 | Identical (from both the first and the heading-copying repair reading), 1 call | Real readings |
| Oct 7 Wednesday | Wing Night Bone-In $.89 / Boneless $.99; All Day Chipotle Chicken $10.25, Chicken Salad $7.25; Soup | Identical, 1 call | Real reading |

### Genuinely ambiguous facts (held, never repaired by invention)
- Oct 12: "Chicken Salad Sandwich w/ Cup of Soup Coleslaw" is printed without "or"; the model flagged it as uncertain. Held; that All Day slot keeps its recurring default.
- Oct 5 night vs. a day post saying "Cup of Soup or Coleslaw": the night poster prints "Cup of Coleslaw". If both appear the same day, All Day is held (same dish, different sides) and the night layout cannot be identified.
- Oct 6: the image prints Taco Salad prices twice (unlabelled and labelled). Legacy production published them without size labels and omitted Nacho Deluxe and the substitutions banner; per-item checks cannot detect an omitted item, only a misread one.

## Final validation: the two single-shape rereads (2 authorized calls)

Same isolated harness: a local `wrangler dev` Worker whose only binding was Workers AI, capped at 2 calls in the proxy and in a separate ledger; process tree terminated and port confirmed closed afterwards. Requests were built exactly as `runAiExtraction` builds the reread: the validation reason and repair shape of the saved real first reading, its raw text as `previous`, `verify: true`. Actual outputs: `tests/fixtures/contract2-eval/*.final-reread.json`.

| Reread | Schema | Latency | Tokens (prompt / completion) | Neurons |
|---|---|---|---|---|
| Oct 12 weekly-only | `specials_evidence_v2_weekly` | 5.2 s | 1,120 / 240 | 16.7 |
| Oct 6 Mexican-only | `specials_evidence_v2_mexican` | 16.8 s | 1,309 / 920 | 37.0 |

### Results against the original posters

**Weekly: model reading fully correct; rejected by a validator bug (fixed).** Correct shape and fields; all five weekday meals exact, each with verbatim row evidence; heading and 11AM–1:30PM window exact. The model wrote `date_range: "OCT 12-16"` (the printed form) and the validator compared it as text with the heading-derived `10/12-10/16`. Fix: both are parsed by the same date-range parser before comparison; a genuinely different range is still a conflict. Result: 5 lunches for 10/12–10/16 publish.

**Mexican Night: one genuine model error, caught by validation (fixed narrowly).** Correct shape and fields; all 7 dishes with correct prices and descriptions, including Nacho Deluxe (which legacy production omitted), all 4 substitutions and the `+$1.50` chips add-on. Eleven of twelve items passed. The Taco Salad title dropped its printed size labels (`$9.00 | $8.50 | $6.00`), violating the prompt; its own verbatim evidence printed `Large $9.00 • Small $8.50 • Mini $6.00`. Fix: a title's run of bare prices is relabelled only when the item's evidence prints exactly one labelled run with the same amounts in the same order; any other difference stays rejected. Result: the complete printed menu publishes (12 items, asserted exactly in `real-image-eval.test.js`). The model placed each item in its own group; the website flattens groups into Favorites and Substitutions & Add-ons, so presentation is unaffected.

Both outputs, replayed through the full local pipeline, produce the intended publication (`real-image-eval.test.js`, end to end through the guarded D1 publisher). Both fixes were mutation-checked against these real outputs.

**Caveat on independence:** the two final fixes were derived from these same two outputs, so their passing on them is confirmation of the fix, not an independent accuracy measurement. Both are deterministic, narrowly scoped, and fail safe (a non-matching case is still rejected and the existing menu or defaults stay).

The `constructed/` fixtures from round 2 are superseded by the real rereads and no longer used by any test.

## Totals

22 Workers AI calls overall (20 evaluation + 2 final), 0 errors; ~636 neurons. No production data written; nothing published.
