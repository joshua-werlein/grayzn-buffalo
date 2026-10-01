# Automatic Facebook Specials

## Current Production State

| Item | Value |
|---|---|
| Parser version | 16 |
| AI model | `@cf/google/gemma-4-26b-a4b-it` (Gemma 4, Workers AI) |
| `SPECIALS_IMPORT_MODE` | `GUARDED_AUTO` |
| Worker version | `344d5be3-5203-4165-81f3-5a0d0fbc7949` |
| Worker test suite | 406/406 passing |
| Application test suite | 93/93 passing |

## Pipeline Overview

Each half-hour cron in `GUARDED_AUTO` mode:

1. Scans today's Facebook image posts (America/Chicago, 7 AM inclusive – 8 PM exclusive).
2. Classifies captions and images using Gemma 4 via Workers AI.
3. Validates extraction output against one of three shapes.
4. Runs deterministic reconciliation against stored evidence.
5. Writes eligible specials to D1 in a single guarded transaction.

`SPECIALS_IMPORT_MODE` controls behavior:

- `OFF` — pipeline disabled entirely
- `DRY_RUN` — fetches, classifies, and stages; no D1 writes
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

All Day repetitions are compared by complete normalized dish and price. Case, spacing, punctuation, `w/` versus `with`, ampersands, and dollar formatting normalize; different dishes or prices do not match. Existing automation-owned All Day text and order are retained when the pair matches.

- A Monday/Friday four-offer night poster needs the repeated pair identified before its two remaining offers publish.
- Wednesday publishes only one explicit Wing Night offer; Thursday allows one night-specific offer.
- Tuesday Nightly and the separate Mexican Night collection are untouched.
- Weekend Nightly stays disabled; configured weekend Lunch/All Day groups remain subject to their existing enabled settings and capacities.

## Weekly Lunch

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

Manual values, locked blanks, and values differing from `last_auto_value` cannot be changed. All eligible group changes commit in one transaction with the collection revision, full snapshots of today's groups/slots and source evidence, and audit events. A race affecting an All Day baseline invalidates the night plan as well.

## Fail-Closed Safeguards

- Night-first evidence is retained; explicit unambiguous groups may publish first.
- A later day poster can establish Lunch/All Day and resolve a staged night poster automatically.
- Conflicting or incomplete groups fail closed.
- The next cron reconciles unchanged, successfully extracted current versions, so a write race can recover without another AI call.
- Source edits replace prior versions for reconciliation; historical versions remain for audit.

## AI Budget and Durable Claims

Each Page/post/caption/image/parser/model version has a durable deterministic claim. Vision runs at most once for that version. The 50-call Chicago-day budget (`SPECIALS_AI_DAILY_LIMIT`) is reserved atomically before image work begins. Reconciliation uses stored evidence and does not invoke vision. Failed or budget-limited extractions stay in the audit history; they are not blindly retried.

## Week Creation

In `GUARDED_AUTO` only:

- Sunday crons at/after 7 PM Chicago ensure the upcoming Monday–Sunday week (including retries later that evening).
- On other runs during processing hours, the current Monday–Sunday week is ensured before scanning.
- No future week is created earlier.

Overlap checks and template copying happen in one transaction. Existing/overlapping weeks are left unchanged. Group structure and recurring values copy exactly; populated slots start manual/locked, while `NULL`/empty slots become explicit empty strings and are eligible for Facebook (slots with a price or section link remain protected).

`OFF` and `DRY_RUN` never create weeks. The admin's default view reads the unique week containing today's Chicago date. Explicit week selection and the explicit new-week action retain their behavior. No GET creates weeks. No schema migration or manual production D1 edit is needed.

## Testing

- Worker test suite: 406/406 passing
- Application test suite: 93/93 passing

## Related Documentation

- [Mexican Night Automation](MEXICAN_NIGHT_AUTOMATION.md) — Mexican Night section lifecycle and migration history
