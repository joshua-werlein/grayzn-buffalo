# Canonical menu recovery

`src/data/menu-baseline.json` is the verified production menu snapshot from
November 22, 2026. It contains 10 categories and 114 active items, including 31
late-night items. The source was read-only production D1 queries.
The emergency public fallback imports that same snapshot. Production D1 remains
authoritative; normal staff edits do not automatically update the snapshot.

The retired duplicate Cheese Curds ID 13 is intentionally excluded. It remains
inactive in production for audit purposes. No other snapshot records are omitted.
Bloody Mary and previously deleted records are not restored. Existing IDs,
descriptions, order, flags and photo keys are retained. R2 photo files are not
contained in this export and require their own backup.

The production menu has no saved menu option or virtual-section ordering overrides.
Pizza, wrap, salad and substitute-side options use the application's defaults.
The live Sauces section reads Wing Wednesday data separately and is omitted when
D1 is unavailable, as before. The recovery snapshot carries categories and items.

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
and generated SQL together. Use read-only production queries or a verified export
as the source for each refresh.

For existing databases, `0013_category_details.sql` adds the two category fields
once. `2026-09-07-menu-additions.sql` documents this specific production correction;
it is not the recovery seed and must not be replayed to override later staff edits.
