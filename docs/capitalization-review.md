# Capitalization implementation and independent review

Review for JJ, November 7, 2026. Local implementation only; release and production
data changes require separate approval.

**Status: PASS for local implementation and independent review.** Release and
production data changes remain subject to JJ's separate approval.

Branch `main`, HEAD and local `origin/main` were all
`0db3a64288869063f5ecbd0b237b146e204683d2` on entry. Claude's existing uncommitted
work was retained and completed. No commits, pushes, deployments, migrations,
production writes, branch changes, resets, cleaning, stashing or deletions occurred.

**Scope:** database-backed Menu and Specials text, relevant editor/import writes,
and a proposed offline backfill. No static website copy, headings, buttons,
navigation or footer was changed. The public Menu category lookup now ignores
letter case to preserve existing column placement after a stored category name
changes. Database-backed special-event titles/offers already use the shared
Specials formatter and receive its capitalization; their raw evidence does not.

**Claude review:** the shared normalizer, Menu editor writes, changed-value
Specials normalization, import integration, and offline backfill/rehearsal were
sound foundations. Existing authentication, transactional fences, staff locks,
Wing Wednesday visibility and initialization logic were retained. Implementation
and expectation updates were incomplete. An extraction-prompt assertion had been
incorrectly recased, and some mock source constants had been changed instead of
only published-output expectations. Those source constants and the original
prompt contract were restored. Archived JSON fixtures were never edited.

**Corrections made:**

- Kept the seven exception words lowercase after sentence punctuation; an entry
  start, including a new entry line, receives the first-word exception.
- Covered numbered/bulleted/emoji entries, curly apostrophes, quoted URLs, HTML
  entities, additional valid acronyms and branded mixed-case forms. Prices,
  measurements, punctuation, whitespace and meaningful line breaks are preserved.
- A link-only Specials save leaves unchanged stored text and its automation
  baseline intact. Case-only retyping of normalized text remains a no-op.
- Weekly-lunch price upgrades and superseded-poster replacements recognize
  older capitalization while still requiring exact unchanged automation
  ownership. No raw evidence or historical audit is normalized.
- Moved priced-choice continuation casing into the shared normalizer, so an
  `or` on a continued price line remains identical across Worker publication,
  staff saves and backfill. Numeric quantities such as `1 or 2` retain their
  existing case, while decorative entry prefixes do not hide a first word.
- Normalize newly published Mexican groups while retaining completely omitted
  groups byte for byte. Claude's normalization of the merged collection rebuilt
  retained slots, moved split prices and changed ownership. The original strict
  preservation assertion now passes without weakening it. Existing retained
  casing is handled by the reviewed backfill rather than a destructive rebuild.
- Menu responses display normalized saved values without replacing a newer
  unsaved draft entered during the request. Two UI regression tests cover this.
- Strengthened backfill guards for parent revisions, ownership, locks, timestamps,
  prices and links. Added a full row manifest and refused SQL generation if the
  rehearsal fails. Documented a paused-write maintenance window and conservative
  rollback instead of treating whole-database restoration as a routine rollback.

**Verification:**

| Check | Final result |
|---|---|
| `node --test --test-reporter=tap tests/*.test.mjs` | 345 passed; 0 failed, skipped or cancelled. |
| `node --test --test-reporter=tap workers/fb-feed/*.test.js` | 1,716 passed; 0 failed, skipped or cancelled. |
| Capitalization regression files | All 27 pass as part of the full suites; the final focused casing/choice/formatting run passed 98/98. |
| `npx astro check` | 0 errors, 0 warnings, 15 hints. |
| `npm run build` | Production build passed. |
| `git diff --check` | Passed. |

Application count: the 323-test baseline plus 20 capitalization/editor/backfill
tests and two new UI draft-preservation tests = 345. Worker count: the 1,709-test
baseline plus seven capitalization/import/rollover regressions = 1,716. No
existing tests were removed. Final complete-run logs are
`.tmp-sol-app-final-reviewed.log` and `.tmp-sol-worker-final-reviewed.log`.

The initial sandboxed runs exposed
workerd/D1 runtime startup failures; those checks were rerun outside the sandbox,
without weakening or skipping them. Outdated published-output expectations were
corrected after comparing their inputs, validated evidence and stored output.
No price, ingredient, size, quantity, substitution, add-on, lock or ownership
expectation was removed to accommodate capitalization.

**Existing production content:** a current record count is unknown. The local
rehearsal uses the archived October 13 export with cutoff `2026-11-07`, not a
current production snapshot. It proposes 110 field updates: 74 item descriptions,
1 item name, 1 category name, 2 group labels and 32 special texts. One record can
have more than one field update. It applies 110, replans 0, reapplies 0, preserves
ownership and every other table, and rolls back to an identical snapshot. The
archive predates Wing Wednesday; current-schema tests cover that section.

**Production plan:** see [menu-capitalization.md](menu-capitalization.md). During
an owner-approved window, pause imports and staff saves, drain in-flight writes,
export production using the explicit Worker account configuration, retain an
immutable backup and SHA-256 hash plus a second backup copy, and generate the
offline plan. Review every affected row in `changes.json`, approve that exact
manifest and SQL, deploy the approved code, and run the guarded apply operation.
Verify affected-row counts, replan from a fresh export, compare unaffected fields
and tables, check the website, and only then resume writes. Rollback uses the
generated guarded reverse statements while writes remain paused. Later edits
are skipped and require manual reconciliation. A whole-database restore requires
separate approval because it can lose subsequent legitimate writes.

The archived rehearsal artifacts are preserved locally in
`audit/current-week-capitalization-rehearsal/`: `preview.md`, `changes.json`,
`apply.sql`, and `rollback.sql`. They are **not a live production apply package**.

**Wing Wednesday:** production initialization investigation was excluded at JJ's
request. Local regressions cover sauces, Add Fries, price entry/import/review,
weekly initialization and rollover, scheduled visibility, homepage links and
staff overrides. No initialization conclusion is inferred from those tests.

**Remaining release decisions:** JJ must approve the release and a freshly
generated production data plan. There is no new schema or infrastructure to
approve. Unrecognized unusual acronyms/brands should be reviewed in the full
before/after manifest; the normalizer uses an explicit acronym/brand vocabulary
and preserves recognized mixed-case forms.

## Files changed and purpose

| File | Purpose |
|---|---|
| `src/lib/text-case.js` | Shared house capitalization normalizer and changed-value helper. |
| `src/lib/specials-store.ts` | Normalize newly entered Specials fields before existing validation and transactional saves. |
| `src/lib/automation-approval.ts` | Normalize customer-facing Mexican import approval text and newly created group labels. |
| `src/lib/wing-approval.ts` | Normalize a newly entered Wing option while retaining its existing description. |
| `src/pages/admin/menu.astro` | Normalize database-backed names/descriptions/categories and return saved text safely to the editor. |
| `src/pages/menu.astro` | Preserve category placement with a case-insensitive stored-name lookup; no copy or navigation edits. |
| `workers/fb-feed/reconcile.js` | Shared published-output capitalization, preserving grouped price-line formatting. |
| `workers/fb-feed/guarded-auto.js` | Mexican publication capitalization with retained-group preservation; legacy-case weekly provenance comparisons. |
| `scripts/menu-case-backfill.mjs` | Offline guarded data plan, full manifest, idempotency and rollback rehearsal. |
| `docs/menu-capitalization.md` | Scope, house rules, exact proposed commands, verification and rollback safeguards. |
| `docs/capitalization-review.md` | Independent review, findings, validation and complete changed-file inventory. |

Application and Worker test changes below update only relevant published-output
expectations, restore original evidence contracts, or add capitalization and
draft-preservation regressions. Existing test coverage remains in place.

- `tests/client-workflows.test.mjs`
- `tests/manual-override.test.mjs`
- `tests/menu-case.test.mjs`
- `tests/mexican-admin.test.mjs`
- `tests/mexican-defaults.test.mjs`
- `tests/recurring-default-fields.test.mjs`
- `tests/slot-lock-scope.test.mjs`
- `tests/specials-hotfix.test.mjs`
- `tests/specials-ownership.test.mjs`
- `tests/specials-rendering.test.mjs`
- `tests/specials-store.test.mjs`
- `tests/wing-wednesday.test.mjs`
- `workers/fb-feed/alert-detail.test.js`
- `workers/fb-feed/canonical-content.test.js`
- `workers/fb-feed/current-day.test.js`
- `workers/fb-feed/delivery-formatting.test.js`
- `workers/fb-feed/dynamic-prices.test.js`
- `workers/fb-feed/events-d1.test.js`
- `workers/fb-feed/events.test.js`
- `workers/fb-feed/guarded-auto.test.js`
- `workers/fb-feed/house-convention.test.js`
- `workers/fb-feed/menu-case.test.js`
- `workers/fb-feed/mexican-night-lifecycle.test.js`
- `workers/fb-feed/mexican-night.test.js`
- `workers/fb-feed/nov2-weekly-lunch.test.js`
- `workers/fb-feed/nov3-compact-lunch-window.test.js`
- `workers/fb-feed/oct10-regression.test.js`
- `workers/fb-feed/oct20-mexican.test.js`
- `workers/fb-feed/oct23-friday-night.test.js`
- `workers/fb-feed/oct26-monday-night.test.js`
- `workers/fb-feed/oct27-regression.test.js`
- `workers/fb-feed/oct9-regression.test.js`
- `workers/fb-feed/poster-formatting.test.js`
- `workers/fb-feed/price-adversarial.test.js`
- `workers/fb-feed/real-image-eval.test.js`
- `workers/fb-feed/reliability.test.js`
- `workers/fb-feed/same-cron.test.js`
- `workers/fb-feed/soup-wing.test.js`
- `workers/fb-feed/weekly-lunch.test.js`
- `workers/fb-feed/wing-wednesday-integration.test.js`
