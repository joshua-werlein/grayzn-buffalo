# Canonical menu recovery

`src/data/menu-baseline.json` is the verified production menu snapshot from
2026-09-07, after the Mexican Night and On The Lighter Side corrections.
The emergency public fallback imports that same snapshot. Production D1 remains
authoritative; normal staff edits do not automatically update the snapshot.

The retired duplicate Cheese Curds ID 13 is intentionally excluded. It remains
inactive in production for audit purposes. No other snapshot records are omitted.
Bloody Mary and previously deleted records are not restored. Existing IDs,
descriptions, order, flags and photo keys are retained. R2 photo files are not
contained in this export and require their own backup.

## Recover into a new database

1. Create the current schema using `schema.sql`. Do not apply historical ALTER
   migrations on top of a fresh current schema.
2. Ensure the `items` and `categories` tables are empty.
3. Execute `recovery/menu-canonical.sql` as a single transactional batch.
   The guard rejects nonempty menu tables. Never clear live tables to bypass it.
4. Verify category/item counts, Late Night flags and R2 images before cutover.

The generated SQL contains no deletes, replacements or upserts. It cannot merge
with an existing menu and must not be used as a live synchronization script.
`migrations/seed_menu.sql` is now a harmless retirement notice.

## Refresh the snapshot

Read the current production categories and items, including inactive rows.
Review duplicates, retired records and all changed fields. Replace the JSON
snapshot with the approved data, then run `node scripts/generate-menu-recovery.mjs`.
Validate a fresh restore and its rejection of a nonempty target. Commit the JSON
and generated SQL together. Do not derive menu content from old seed files.

For existing databases, `0013_category_details.sql` adds the two category fields
once. `2026-09-07-menu-additions.sql` documents this specific production correction;
it is not the recovery seed and must not be replayed to override later staff edits.
