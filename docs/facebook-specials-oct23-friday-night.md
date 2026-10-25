# October 23: Friday Night Specials (local fix, not deployed)

## Production evidence (read-only)

- Post `1742943434040200`, created 3:00 PM CDT, processed 3:02 PM on Worker
  `a37829f3`, staged `ok` with no issues. The model read the poster
  faithfully: `Friday Night Specials 5-10pm`, `day_evidence: Friday`, five
  priced offers, each with service fields that only repeat the heading:
  1. `1 or 2 Piece Fish + 3 Jumbo Shrimp + Fries & Coleslaw or Side Salad $12.99/$13.99`
  2. `Chicken Stir Fry $12.99`
  3. `Steak Stir Fry $13.99`
  4. `Cheeseburger or Fish Sandwich w/Side Salad, Soup or Coleslaw $10.75`
     (the All Day dish at its night price; All Day is $10.25)
  5. `Grilled Ham and Cheese w/cup of Soup or Coleslaw $7.25`
     (identical to the All Day offer)
- Audit events 426–429: four `Service not established by evidence` holds plus
  `Unresolved offer could contradict this offer` on All Day. Nothing was
  written; Friday Nightly kept its unpriced recurring default. The morning's
  Lunch, All Day and Soup were already published and stayed correct.
- The October 16 Friday night poster used the same template and was held by
  design (`docs/facebook-specials-oct15-16.md`); the behavior recurred weekly.
- The 3:13 PM Brewers game poster is a one-time special event. It remains an
  unresolved, unpublished offer here; the separate event workflow is a later task.

## Approved behavior and correction

- **Capacity.** Friday Nightly now holds up to four specials, consistently in
  the planner (`evidence.js` `capacityOf`), the guarded publisher
  (`guarded-auto.js`) and the staff editor (`src/lib/specials-store.ts`
  `specialInputCount`, which also drives the admin form). Monday stays two;
  other weeknights one. The existing four-slot schema is unchanged; no migration.
- **Friday Night rule (`houseLayout`).** With a printed Friday (explicit
  today), a `Friday Night` heading resolving to Nightly service, and today's
  verified All Day evidence (published automation or another same-day post),
  every priced meal is a Nightly special except an identical repeat of that All
  Day offer, which stays All Day and is not duplicated. A night-priced version
  of an All Day dish (the $10.75 Cheeseburger) is a Nightly special and never
  changes the All Day $10.25 slot. More than four Nightly specials hold the
  whole poster: nothing is dropped or truncated. Without All Day evidence the
  poster holds, because repeats cannot be recognized.
- **Variant join (`joinProteinVariants`).** Under a night heading, an adjacent
  run of complete, certain, singly priced offers that differ only by a leading
  protein (chicken, steak, beef, pork, shrimp) of the same dish of at least two
  words, with identical service fields and distinct proteins, becomes one
  special with each line verbatim:
  `Chicken Stir Fry $12.99` / `Steak Stir Fry $13.99`. Unrelated dishes are never
  combined to fit capacity. The October 22 pizza-size join shares the same helper.
- **Explicit repeats.** On Friday an offer carrying its own night label that is
  an identical repeat of today's verified All Day offer also stays All Day.
- **Legacy layouts preserved.** The established Monday/Friday layouts still
  expect exactly two night meals. The four-offer "two night + two All Day"
  layout is not applied after variants were joined, so a night-priced All Day
  dish can never be published as All Day.

Result for October 23: Nightly 1 Fish & Shrimp `$12.99/$13.99`, Nightly 2 the
stir fries, Nightly 3 Cheeseburger or Fish Sandwich `$10.75`; All Day
unchanged at `$10.25` and `$7.25`; Brewers promotion not published. Ownership
rules are unchanged: staff-locked or staff-edited slots are blocked per slot,
eligible siblings publish.

## Remaining limitations

- A Friday poster with five or more distinct specials after joining holds
  entirely (fail closed) and keeps the recurring default.
- The contract-1 rollback path (`reconcile.js` legacy mapping) and the legacy
  `groups` import contract in `worker.js` keep their two-slot Friday limit;
  they are only used if `SPECIALS_EVIDENCE_VERSION` is unset.
- Partial publication semantics are unchanged: if a later same-day poster
  lists fewer Nightly specials than an earlier automated publication, the
  extra earlier slot is not cleared automatically.
- A Friday night poster without a printed weekday, or headed other than
  `Friday Night`, uses the earlier two-meal layouts.

## Coverage

`workers/fb-feed/oct23-friday-night.test.js` (16 tests) with the public-text
fixture `tests/fixtures/oct23-friday-night.json` and the existing
`tests/fixtures/oct23-delivery.json`: both processing orders, published All Day
automation as repeat evidence, no All Day evidence, the Brewers poster in both
orders, the four/five boundary, night price variants versus identical repeats,
ten join refusals, a refused join that still fits or exceeds four slots, other
weekday and other headings, explicit night labels, Monday capacity, and
pipeline publication with idempotent rescans, five-special hold, staff-locked
Nightly slot and staff-edited All Day price.
`workers/fb-feed/oct15-16-regression.test.js` now expects the approved Friday
publication for the October 16 posters (evening alone still holds).
`tests/specials-rendering.test.mjs` checks the compiled homepage and Specials
pages and the admin editor's four Friday Nightly inputs. Disabling the Friday
rule, the variant join, the capacity change, the explicit-repeat rule or the
joined-layout guard each fails one or more of these tests.
