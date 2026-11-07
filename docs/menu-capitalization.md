# Menu and Specials capitalization

## The rule

Grayz'n Buffalo house capitalization: every major word starts with a capital letter.
Only `a`, `an`, `the`, `and`, `or`, `of` and `with` stay lowercase, and even those are
capitalized as the first word of an entry or a new entry line. Sentence punctuation
alone does not restart the entry. Every other word,
including `in`, `on`, `at`, `to`, `by` and `for`, is capitalized.
Multiline choices with a printed price on every line are one entry; a continued
`or` or `and` stays lowercase consistently in the editor, Worker and backfill.

| Typed | Saved |
|---|---|
| CHICKEN BACON RANCH WRAP | Chicken Bacon Ranch Wrap |
| BURGER WITH FRIES | Burger with Fries |
| BASKET OF FRIES | Basket of Fries |
| A HALF POUND BURGER | A Half Pound Burger |
| SOUP OR SALAD | Soup or Salad |
| THE BEST BURGER IN TOWN | The Best Burger In Town |
| CHICKEN AND BACON WRAP | Chicken and Bacon Wrap |
| bbq chicken w/ ff | BBQ Chicken w/ FF |
| bone-in wings $1.10 each | Bone-In Wings $1.10 each |

`src/lib/text-case.js` (`normalizeMenuCase`) is the only implementation. It changes
letter case only, so a value keeps its length, and applying it again changes nothing.

- Kept as typed: digits, prices, punctuation, apostrophes, hyphens, spacing, line
  breaks, letters attached to a number (`12oz`, `2nd`), URLs, email addresses,
  `@handles`, `#hashtags`, paths and markup.
- Always capitals: the abbreviations in `MENU_ACRONYMS` (BBQ, BLT, FF, PBR, IPA, …).
- Brands: CamelCase typed that way (`McRib`, `DiGiorno`, `PowerAde`) is kept, and
  `BRANDS` lists the few title case can't produce (`RumChata`, `SpaghettiOs`).
- Lowercase forms: `w/`, `w/o`, and a unit after an amount (`8 oz`, `$.89 each`,
  `12 inch`). `am`/`pm` after a time print as `AM`/`PM`.

To change the house style, edit `MINOR_WORDS` or the other lists in `text-case.js`
and update `tests/menu-case.test.mjs`.

## Where it applies

| Path | Fields |
|---|---|
| Menu editor (`/admin/menu`) | item name and description, section name |
| Specials editors (weekly, Recurring Defaults, Mexican Night, Wing Wednesday, recurring section defaults) via `saveCollection` | special text (including multiline items), group labels, section titles |
| Import acceptance (`applyCandidate`), staff approval (`approveImport`), Wing price approval | the text staff publish |
| Facebook Worker | daily, weekly lunch and soup specials (`canonicalizeSlotContent`), Mexican Night items and group labels; published special-event titles/offers that already share this formatter |

The staff editors normalize only values staff changed. An untouched value keeps its
stored form, so its ownership, lock, edit time and automation baseline never change
because of capitalization. Retyping a special in a different case is not an edit.

Not changed: schedules and service times, prices in the separate price field, section
links, Facebook captions, AI readings, import history and audit records, announcements, legacy specials
tables, category subtitles and notes, and `src/data/menu-baseline.json` (the
emergency snapshot, refreshed from production by its own procedure).
The backfill also excludes stored special events and past weeks. No static website
copy, headings, navigation, buttons or footer are normalized. The menu page's
existing category-placement lookup is case-insensitive so the stored category
`On the Lighter Side` keeps its established position.

## Release order

All release and production commands below are proposals requiring JJ's approval.
No deployment or production data change is part of this implementation task.

During an owner-controlled maintenance window, pause automatic imports, stop staff
saves and drain in-flight writes. Export a fresh backup, generate and review the
plan, deploy the site and Worker, apply only the approved plan, verify, then resume
editing and imports. Do not backfill while an old Worker can rewrite the old style.
Weekly lunch price upgrades and superseded-poster replacements recognize legacy
capitalization while still requiring exact `content = last_auto_value` ownership.
Repeated normalized publication produces no additional capitalization writes.

## Backfill of existing content (owner approval required)

`scripts/menu-case-backfill.mjs` never connects to D1. It loads an export into a
private in-memory SQLite copy, writes `preview.md`, `changes.json`, `apply.sql` and `rollback.sql`,
and rehearses both files on that copy before reporting success.

1. Export production. This file is also the pre-change backup.

   ```sh
   npx wrangler d1 export grayzn-db --config workers/fb-feed/wrangler.toml --remote --output backups/pre-menu-case.sql
   ```

2. Generate and rehearse. The command exits non-zero unless the rehearsal passes.

   ```sh
   node scripts/menu-case-backfill.mjs --export backups/pre-menu-case.sql --out backups/menu-case
   ```

3. Keep the export immutable, record its SHA-256 hash and the pre-apply UTC time,
   and retain a second backup copy outside the workspace. Review `preview.md`
   and every row in `changes.json`, including exact IDs, before/after values,
   guards, skipped rows and rehearsal results. Counts are field updates: one menu
   record can have both its name and description changed. Obtain approval for
   that exact export and generated SQL; regenerate if writes have resumed.

4. After approval, apply:

   ```sh
   npx wrangler d1 execute grayzn-db --config workers/fb-feed/wrangler.toml --remote --file backups/menu-case/apply.sql
   ```

5. Compare each statement's affected-row count with the approved manifest. A
   skipped guard requires review, never removal of the guard. Export again and
   re-run step 2: it must report `"changes": 0` apart from explicitly reviewed
   skipped rows. Compare all unrelated columns/tables with the backup, especially
   prices, schedules, locks, origins, timestamps, raw evidence and audits. Verify
   automation-baseline equality is unchanged, and spot-check `/menu`, `/specials`
   and the homepage. Do not resume writes until verification passes.

Scope: menu items and sections, section titles, and the group labels and specials of
the Recurring Defaults, the Mexican Night and Wing Wednesday sections and their
defaults, and weeks ending today or later. Past weeks are history and stay as saved.

Each statement replaces one value only if it still holds the exported text, so a
value edited after the export is skipped rather than overwritten, and re-running
`apply.sql` changes nothing. Slot guards additionally compare ownership, locks,
edit timestamps, price, link and parent revision; collection and group changes
also require their exported parent revision. An automation value moves together with its
`last_auto_value`, so no slot changes ownership. A staff value whose new form would
equal its automation baseline (and so look automation-owned) is listed for manual
review instead of changed. No revision, `updated_at`, lock, origin or edit time is
written, so the Mexican Night visibility window and staff-edit times are unaffected.

### Rollback

With writes still paused, apply `rollback.sql` using the same explicit config as
step 4 and `--file backups/menu-case/rollback.sql`. It restores only matching
backfilled values whose metadata/revision still match the backup. Verify exact
equality with the export before resuming. Later staff edits are deliberately
skipped: reconcile those rows manually. A whole-database restore can discard
subsequent legitimate changes and requires separate owner authorization; it is
not an automatic rollback step.

### Local rehearsal on the archived October 13 backup

Run against `grayzn-db-backup-2026-10-13-pre-0022.sql` with `--today 2026-11-07`:
110 field updates (74 item descriptions, 1 item name, 1 category name, 2 group
labels and 32 special texts), none skipped. The rehearsal applied 110, re-planned
0, re-applied 0, preserved ownership and all other tables, and rolled back to an
identical copy. Artifacts are in `audit/current-week-capitalization-rehearsal/`.
This archive predates Wing Wednesday and is not a current production inventory;
live counts remain unknown. Current-schema local tests separately cover Wing
Wednesday and concurrent ownership/revision guards. Production initialization
verification was excluded at JJ's request.
