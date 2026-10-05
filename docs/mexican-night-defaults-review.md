# Mexican Night defaults: review and release notes

Prepared from source and read-only production D1 inspection on October 5, 2026.
No production data change or deployment has been performed.

## Storage and editors

- `mexican-night-defaults` is the recurring template in `special_collections`.
- `mexican-night` is the live collection. Each has separate `special_groups` and `special_slots` rows.
- Both admin editors reuse the existing fields and revision-checked transactional save path.
- Template saves reject prices in item text, descriptions, separate price fields, headings and schedules. They do not mark the live collection as manually saved.
- Live changes continue to protect the current week and accept staff/Facebook prices.
- The existing atomic rollover copies the template into the new live week with unlocked slots. Facebook can then replace eligible items, including size prices, and preserve or replace accessories under the existing rules.

## Proposed data cleanup (requires approval)

Production template revision 2 contains prices in 11 populated slots across three groups. Its separate `price` fields are already empty. Migration `0020_mexican_night_price_free_defaults.sql` replaces only the exact inspected text in that template:

| Item | Price text removed |
| --- | --- |
| 2 Soft Shell | $7.75 |
| Burrito | $10.25 |
| Chimichanga | $12.25 |
| Enchilada | $9.25 |
| Nacho Deluxe | $9.75 |
| Taco Salad | Large $9.00, Small $8.50, Mini $6.00 |
| Chips & Salsa or Chips & Cheese | $4.00; nacho cheese or salsa +$1.50 |
| Substitute chicken | +$1.50 |
| Add nacho cheese | +$1.50 |
| Substitute queso | +$0.50 |
| Substitute shredded cheese for nacho cheese | +$0.50 |

Names, descriptions, Large/Small/Mini options, group structure and schedule are preserved. The template revision increments once if rows change, invalidating old editor drafts. Reapplying the cleanup changes nothing. Unknown or subsequently edited text is left unchanged for review.

No schema change is necessary. The same cleanup can be saved through the new recurring editor instead of applying this data migration. The migration makes the inspected change repeatable and testable.

Before an approved release, re-read both collections and confirm that the migration's old values still match. Apply the data migration using the transactional migration runner, then verify all 11 expected template values, empty price fields, and no remaining template prices. Confirm the live collection and its groups, slots and protection are identical to the pre-change snapshot. Deploy the admin validation together with the approved cleanup before the next rollover. Do not run the Worker to force a rollover or re-save the live collection.

The inspected live collection was revision 6, `section_source='manual'`, for the week starting October 5, 2026. Its prices had already been removed by staff. It must not be altered by this cleanup.

Until the approved data cleanup is applied, production still contains the old recurring prices. Source changes alone do not rewrite stored D1 data. Facebook extraction and live rendering continue to retain current poster prices.
