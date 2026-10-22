# October 21: recurring Facebook specials failures

Local repair and investigation only. No production deployment, D1 mutation,
migration, configuration change or historical replay was performed.

## A. Confirmed cause and production evidence

Freshly fetched `origin/main` and local `main` were both
`0c4662345b48b260e588dbabca1f0c06d9b373da`. Three pre-existing untracked files
(`docs/mexican-night-oct20-fix.md`, `recovery/oct20-mexican-correction.js`,
`tests/mexican-correction.test.mjs`) were preserved.

Cloudflare reports active Worker `14b6503d-0368-41db-89e1-39e8e477f496`
(October 20, 22:48 UTC) at 100%. Production Pages deployment
`62785a29-35c8-40e0-a1b3-27190e2bf799` uses `0c46623`. Downloaded live Worker
source contains both the duplicate-weekday rejection and the later contract-2
single-day rejection, as does HEAD; the new adapter is absent. This verifies
the affected deployed path, not a byte-for-byte comparison of every bundled
module. The read-only script download uses the documented
[Cloudflare endpoint](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/get/).

The original approved diagnostic export is preserved locally in ignored
`.wrangler/oct21-original-fixture-before-sanitization.json`. The versioned
`tests/fixtures/oct21-production.json` retains only regression inputs: public
poster evidence, relevant slot values and summarized rejection evidence.
Import/collection identifiers are synthetic; provider telemetry, raw audit
responses and database metadata were removed. The retained zero-write marker
describes the original read-only query, not a new production operation.

1. Morning post `1740650964269447`, created 9:37 AM Chicago, was discovered and
   processed at 9:39 AM. Both AI readings returned `weekly-lunch` despite the
   explicit WEDNESDAY LUNCH SPECIALS heading. The final reading includes all
   three complete meals and $9.75/$10.25/$7.25, plus Chicken Noodle or Chili.
2. `validateExtraction()` in `worker.js` enters the contract-2 weekly branch.
   Its uniqueness check rejects the repeated Wednesday rows **before**
   `singleDayLunchEvidence()` can recognize the single-day layout. Furthermore,
   that branch explicitly rejects recovered single-day evidence in contract 2.
   The failure is `Invalid or duplicate weekly weekday evidence`, not missing
   dishes, a 150-character overflow, a provider outage or a database write race.
3. The one internal retry uses the general extraction schema again and returns
   the same wrong shape. Validation failure is permanent for this source ID;
   the half-hour scans do not request another extraction. `retry_count=1`
   counts the processing attempt, not the two model calls within it.
4. Evening post `1740929520908258`, created 3:29 PM, was processed at 3:30 PM.
   It staged valid contract-2 evidence with both sandwiches, Soup and labelled
   $.89 bone-in/$.99 boneless prices. Audit events 390–393 explicitly show the
   earlier rejected source preventing publication from both sources.
5. `reconcileToday()` retains failed extracted evidence to prevent conflicting
   sources silently disappearing. It recognizes the morning shape as daily via
   the legacy helper, but the contract-2 planner skips weekly-shaped objects;
   the failed-source veto then blocks the complete plan. This safety rule is
   correct for genuinely invalid evidence; the format adapter was missing.
6. Wednesday All Day slot 2 is the Chicken Salad recurring value, with
   `origin=manual`, `manual_locked=0`, `last_auto_value=null`. Wing Night is also
   an unlocked recurring value, including Add Fries and no prices. These are
   eligible defaults, not protected staff corrections. Lunch is an unchanged
   prior automation value without a price. Today's failed daily import did not
   write it; the export alone does not establish its earlier source.

Direct HTTP checks of homepage and Specials at 4:40 PM Chicago returned 200 and
both contained the same French Dip, Chicken Salad and Add Fries values; neither
contained Pizza Burger. Both pages read normalized collections and use the same
`SpecialGroup` component and `displayedSpecial()` price composition. The wing
prices are missing from the stored live value, not intentionally hidden by UI.
Web-search cached pages were stale and were not used for this conclusion.

Read-only integrity checks: migration-15 mismatch count is zero; no duplicate
week-start rows exist. No migration-tracking repair is indicated by this incident.

## B. Recurring failures: shared versus separate

| Incident | Evidence/cause | Relationship |
| --- | --- | --- |
| October 9 Friday | D1 still records duplicate weekly weekday rejection; `0fb9086` added legacy single-day recovery | Same format failure; contract 2 bypassed the earlier recovery |
| October 10 | Plural Soup/layout normalization, `fc1c3bb` | Separate parsing issue; same dependence on exact representation |
| October 11 | Printed weekday and current-day evidence, `61bfc6c` | Separate date-validation issue |
| October 12 Monday | D1 records ambiguous service-time price; contract-2 reliability work in `121a011` | Separate misplaced fields/facts; architectural transition introduced incompatible paths |
| October 15–16 | Stored fixtures show copied time scope, numbered evidence and Friday price/group conflicts; `82e1001` | Separate facts/scope/capacity problems; same fixed-slot publishing bottleneck |
| October 19 delivery | Weekly evidence blocked daily delivery, `d912f88` | Separate delivery reconciliation workflow; preserved unchanged |
| October 20 Mexican Night | Menu title/description/accessory grouping, `0c46623` | Separate section workflow; preserved unchanged |
| October 21 | Valid single-day contents encoded as weekly rows; later valid post vetoed | Confirmed regression of an already handled failure class |

Historical aggregate D1 results corroborate validation categories, not a precise
every-other-day outage rate. Staged/ok means extraction passed, not publication
was complete. Unresolved factual conflicts must still be reviewed.

## C. Architecture assessment

The physical `special_slots` table supports positions 1–4. The automatic planner,
publisher and editor impose smaller service capacities: Lunch 1, All Day 2,
Nightly usually 1 (Monday/Friday 2). The UI itself renders populated slots.
Therefore **the current automatic/editor model cannot represent three genuinely
lunch-only offers**. More than four items or independently timed offers require
a broader model. Raising a regex limit or concatenating meals would hide this.

Today's existing approved mapping is documented in `facebook-specials-auto.md`:
a matching weekday three-meal Lunch Specials layout maps first meal to Lunch,
then the pair to All Day. The original first meal explicitly carries 11–1:30;
the other two have no individual time. Recovery uses that established rule,
not mere repetition across posters. A test with three genuinely corroborated
lunch windows remains blocked for capacity; no automatic relabelling occurs.

Other structural risks remain:

- AI shape, normalized candidate, validation status and publication status are
  separate concepts, but compatibility was implemented in different branches.
- An unrecoverable source can veto unrelated current-day publication. Removing
  that veto without evidence-level conflict scope would weaken fail-closed rules.
- Multiple posts support identical/subset agreement and known repeats; arbitrary
  disjoint offers are treated as conflict, not automatically unioned.
- The 150-character presentation constraint still rejects longer complete meals.
- Recurring defaults can look like confirmed current-day offers to customers.
- No deterministic validator can detect an offer the model omitted entirely
  unless another source, verification pass or independent coverage check reveals it.

Smallest demonstrated correction: normalize the alternate single-day shape
before weekly validation, preserve its original evidence, and use the same
normalization for persisted evidence replay. That is implemented locally.

Recommended next architectural increment: one canonical offer list with durable
source/offer identity, original evidence, service/time provenance, unresolved
reasons and publication coverage. Service groups should become a projection of
that list with shared configurable capacities for editor and importer. Within
four slots, a capacity change need not require D1 schema changes, but it needs
explicit business-rule agreement and coordinated planner/editor validation.
An unbounded list or per-offer service windows needs a schema/API/UI migration.
This investigation does not claim that broader redesign is implemented.

## D. Local corrections

- `reconcile.js`: shared `singleDayLunchEvidenceV2()` adapter. Requires one printed
  weekday, matching row weekdays, Lunch heading, no weekly heading or date range.
  Retains row evidence, uncertainties, dates and any own service fields. Keeps
  overall time in heading scope; never synthesizes verbatim evidence from content.
  The same adapter runs before reconciliation of persisted evidence.
- `worker.js`: applies adapter before weekly uniqueness checks and routes through
  existing daily fact/date validation. Emits `Specials import requires attention`
  with counts/status only for blocked, rejected, awaiting-recovery, missing-week,
  missing-extraction and concurrent-change outcomes.
- `guarded-auto.js`: permits revalidation of the specific recoverable failed shape
  only when its original facts have no validation issues. Existing source-date,
  manual ownership, parser, revision, snapshot and transaction fences remain.
  Original failed status/raw response/audit history are not rewritten.
- `oct21-regression.test.js`, `oct21-production.json`, and
  `tests/specials-rendering.test.mjs`: exact production regression and integration
  coverage, including both compiled public pages reading the same test database.

No changes to extraction prompts, model, parser identity (19), delivery logic,
Mexican Night implementation, frontend implementation, dependencies or schema.

## E. Validation

New regressions cover all original offers/prices, wrong shape normalization,
real weekly schedules and mixed days, missing evidence, changed prices,
uncertainties, long content, real Lunch capacity overflow, both post orders,
default replacement, idempotent scans/no additional AI, stored failed evidence,
staff locks, concurrent writes, and content-free attention logging.

The compiled homepage and Specials test reads one authoritative local database,
asserts every meal and wing price, rejects stale default text, and confirms no
render-time writes. Tests cannot prove all future AI outputs will be correct.

Final verification:

| Check | Result |
| --- | --- |
| Full Worker suite | 1,043 tests: 1,039 passed; four local Miniflare connection/port failures subsequently passed in the local-D1 reruns |
| Final October 21 suite (two additional boundary tests) | 18/18 passed |
| Application suite | 149 tests: 147 passed; two localhost-restricted D1 tests subsequently passed in the local-D1 rerun |
| Added compiled October 21 two-page regression | 1/1 passed |
| Local D1/recovery/delivery/Soup rerun with localhost access | 76/76 passed, including both application failures and three Worker failures |
| Remaining Mexican Night real-D1 transaction rerun | 1/1 passed |
| Astro build | Passed |
| Astro check | Zero errors, zero warnings; six existing hints |
| Worker deployment dry run | Passed; no deployment |
| `git diff --check` | Passed |

The final broader runs include Mexican Night, delivery, migration tracking,
ownership, source edits, recovery leases, AI budgets and transaction tests.
The only failures were local test infrastructure (localhost access/port), all
resolved in successful reruns. There are no known remaining assertion failures.
Logs are in ignored `.wrangler/oct21-*.log`; fixture and tests are reviewable
source files. The pre-existing Mexican correction files were not edited.

## F. Production readiness, backup and rollback

This correction needs a **Worker-only deployment** after review/authorization.
No Pages deployment or D1 migration is needed. Do not deploy from this report.
Before release, recheck active version/main and concurrent changes, retain the
current Worker version and a current D1 backup/time-travel bookmark, and preserve
the inspected slot/import snapshot. The next eligible current-day complete scan
can reuse the failed raw evidence without spending another AI call. It must still
pass all dates, ownership and database fences. Earlier days are not replayed.

Risk: deterministic recovery can now replace unlocked recurring values and
unchanged automation with the evidence-backed values. Staff-locked text remains
protected. Incomplete, contradictory and oversized evidence remains held.

Worker rollback target: `14b6503d-0368-41db-89e1-39e8e477f496`.
Code rollback does not undo slots already published. Any data rollback must be a
separately authorized, exact-snapshot conditional correction that preserves later
staff edits; never restore the whole database blindly. There is no schema rollback.

## G. Monitoring and remaining operational work

The new structured warning makes partial publication visible in existing Worker
observability logs. It does not configure an alert destination or send messages.
Configure an alert for `Specials import requires attention`, deduplicated by date
and status, with a grace period for pending recovery and concurrency retries.
Treat `written=true` plus blocked/rejected counts as incomplete, not success.

An operational completeness monitor should additionally track: complete Graph
scan, expected posting deadline, discovered/extracted/held/published offer counts,
recurring values still displayed despite newer evidence, budget/exhausted/permanent
failures, queue dead letters and absence of scheduled executions. Read latest
reconciliation outcome as well as original failed status: a safely recovered
source deliberately retains its historical failure record. Alert only on new or
persistent actionable conditions, and clear on verified resolution.

No external alerting or recurring monitor was configured in this task. The local
warning closes a visibility gap, but reliable unattended operation still needs
that alert routing and a defined completeness policy.
