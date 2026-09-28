# Mexican Night automatic weekly publication

Branch base: c0b5ab2 (latest main when work began). No production changes made.

## Root cause

`ensureAutomaticWeek()` copied only `defaults` groups into a `week` collection.
The separate `mexican-night` section was not copied, associated with a Tuesday,
or published. Production inspection found three groups / twelve slots already
stored there, but `updated_at` was null. The existing visibility function therefore
hid the details. The Tuesday nightly summary is a separate weekly slot and stays
unchanged.

## Storage and publication

Migration 0019 snapshots the existing **unpublished, non-automated** Mexican Night
section into `mexican-night-defaults`, including labels, order, enabled flags,
service times, text and separate prices. There are no menu items in Worker code.
A published or automated section is not silently promoted to a recurring template.

The migration adds `section_week_start`, `section_service_date`, and
`section_source` to `special_collections`. The existing `weekly_special_id` cannot
be used on a section: its schema requires kind=week and is unique.

At Sunday 19:00 America/Chicago, the weekly-creation transaction also publishes
an unlocked copy of the stored template into the existing `mexican-night` key.
It records Monday's date, Tuesday's date, source `recurring`, an ISO UTC
`updated_at`, a new mutation token and an incremented revision. The initial
unpublished baseline is eligible only while it still exactly matches the migration
snapshot. Later staff saves or direct changes disqualify that bootstrap exception.

Live fallback slots use `origin=manual, manual_locked=0, last_auto_value=NULL`,
matching regular weekly fallback semantics. Facebook publication uses
`section_source=facebook`, `origin=automation`, `manual_locked=0`, and sets
`last_auto_value` to the published text. Staff saves mark `section_source=manual`
and retain the existing per-slot locking behavior. One protected item or a manual
collection blocks a whole-menu replacement, including on the next rollover.
Title/schedule/group-only staff corrections are also protected.

Facebook reconciliation accepts only current-Chicago-day evidence and records the
appropriate Monday/Tuesday association. The recurring template is never changed
by Facebook or by edits to the live menu. Its stored data can be maintained
separately; this change does not add a template editor.

## Idempotency and visibility

An already-associated current/future week is not reseeded. Existing exact weekly
records can receive missing details without changing their weekly slots. Missing,
empty or malformed templates and overlapping weeks fail closed. The transaction
copies the template atomically; failures roll back both weekly and section writes.
The next Sunday copies the template anew over eligible prior-week content.
Manual/protected content remains untouched until explicitly released by staff.

`mexicanNightDetailVisible()` is unchanged: Sunday publication is visible Sunday,
Monday, Tuesday, and Wednesday until 01:59:59 Chicago; 02:00 hides it without
removing stored data. Sunday before 19:00 cannot freshly publish the prior Tuesday.

## Production steps after review

1. Recheck the live `mexican-night` baseline before migration. At audit time its
   `updated_at` was null and its existing items were the recurring defaults.
   If it has since been published or automated, explicitly establish the correct
   recurring template instead of copying new Facebook/staff content.
2. Apply migration `0019_mexican_night_recurring.sql` once using the existing D1
   migration procedure. Verify the template's groups/items match the stored defaults.
3. Deploy the updated Pages application (manual-save protection) before the updated
   `grayzn-fb-feed` Worker. This prevents the old manual-save path from omitting the
   collection-level manual marker. Do not deploy Worker code before the migration.
4. Let the next scheduled run seed the eligible week's details; verify metadata,
   Tuesday summary, live details, and the next visibility cutoff. No AI reprocessing
   or prior-day import backfill is required.

No merge, production migration, Worker deployment, or Pages deployment was performed.

## Exact changed files

- `migrations/0019_mexican_night_recurring.sql`: stored template snapshot and publication metadata.
- `workers/fb-feed/auto-week.js`: include detailed publication in the existing weekly transaction.
- `workers/fb-feed/mexican-night-defaults.js`: guarded copy and whole-menu protection rules.
- `workers/fb-feed/guarded-auto.js`: protect manual content, associate Facebook publication, exclude prior-day evidence.
- `src/lib/specials-store.ts`: mark staff section saves as manual.
- `workers/fb-feed/mexican-night-lifecycle.test.js`: lifecycle, migration, visibility, concurrency and real D1 tests.
- `tests/specials-fixture.mjs`: optional pre-migration fixture for migration validation.
- `tests/sqlite-specials.py`: apply migration 0019 in test databases.
- `tests/specials-auto-d1.test.mjs`: correct the existing current-day test timestamp to a Chicago daytime instant.
- `MEXICAN_NIGHT_AUTOMATION.md`: audit, behavior, validation and rollout notes.

The Gemma configuration, parser version 13, structured extraction, retry/accounting,
normalization and visibility implementation are unchanged from the branch base.

## Validation

- Entire Worker suite: **333 tests, 333 passed, 0 failed, 0 skipped**.
- Application specials suite: **55 tests, 55 passed, 0 failed, 0 skipped**.
- `astro check`: **0 errors, 0 warnings, 7 hints**.
- `npm run build`: passed.
- `git diff --check`: passed.
- Primary checkout remained untouched (its pre-existing specials page edit remains).

The 23 new lifecycle tests include the requested thirteen cases plus migration
safety, stale evidence, missing templates, manual-edit races, and real local D1
transaction rollback/idempotency. The application suite's existing atomic-write
fixture used a midnight UTC date that was the prior Chicago day; its timestamp was
corrected to 14:00 UTC so that it exercises the intended same-day transaction.
