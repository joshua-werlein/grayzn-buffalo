# October 22: Thursday Pizza Night prices (local fix, not deployed)

## Production evidence (read-only)

- Evening post `1741990054135538`, created 4:27 PM CDT, processed 4:28 PM on
  Worker `a37829f3`. Staged `ok`; the model read the poster faithfully:
  heading `TONIGHT IS PIZZA NIGHT / SPECIAL IS 5-10PM`, no weekday, four offers:
  `12 inch 3-Topping Pizza $13.50`, `16 inch 3-Topping Pizza $16` (each with
  service fields `5-10PM` / `SPECIAL IS 5-10PM`), plus the BLT Wrap $10.25 and
  Grilled Ham and Cheese $7.25 repeats of that morning's All Day offers.
- Audit events 409–412: `reconciled 2 source(s); 0 slot(s); CONFLICT: 2 blocked
  proposal(s)`, both `Service not established by evidence`. The Thursday
  Nightly slot kept its unlocked recurring default `12” 3-Topping Pizza /
  16” 3-Topping Pizza` with no prices. Lunch, All Day and Soup from the morning
  stayed correct. Rendering, database writes and discovery were not involved.

## Causes (all reproduced from the stored candidates)

1. Heading scope: both service fields only repeat the heading, so they are not
   offer-level evidence (`offerService`). This rule is unchanged.
2. Day evidence: the night-heading house layout required a printed weekday.
   "TONIGHT" has none, and the verified-timestamp exception covered only the
   exact DAILY SPECIALS daytime template.
3. Capacity: the two sizes were two offers; Thursday Nightly holds one. Even
   with a printed "Thursday" the poster stayed held.

## Correction (`workers/fb-feed/evidence.js`)

- **Same-day TONIGHT poster.** The guarded publisher's existing trusted-source
  set (stored `fb_created_time`: finite, not future, today in Chicago) now also
  dates a poster whose heading names `tonight`, resolves to Nightly service,
  has `day_of_week=-1` and empty `day_evidence`. It reaches only the
  night-heading layouts (not the Wednesday Wing Night or daytime layouts), on
  Monday, Wednesday, Thursday or Friday. Tuesday (Mexican Night) and weekends
  are excluded. The existing check of every printed field for another weekday,
  calendar date or future reference still rejects or excludes the source.
- **Pizza sizes are one special (`joinPizzaSizes`).** Before analysis, an
  adjacent run of offers on a night-heading poster is joined into one offer
  only if every offer is `<size> <same pizza> $price` (size `12 inch`, `12"`,
  `12 in.`), sizes are distinct, each has exactly one content price equal to
  exactly one evidence price, service fields are identical, and there are no
  uncertainties or date evidence. Content and evidence are joined verbatim,
  one size per line, which is the established Thursday format. Nothing is
  invented; any other shape is left for the ordinary checks.

Result for October 22: Nightly 1 =
`12 inch 3-Topping Pizza $13.50` / `16 inch 3-Topping Pizza $16`, with both
All Day offers recognized as repeats. Thursday capacity stays one slot. The
publisher's ownership rules are unchanged: unlocked defaults and unchanged
automation may update; staff-locked or staff-edited slots are blocked.

## Boundaries and remaining risks

- A night poster that adds a genuinely different second night offer still
  exceeds Thursday capacity and stays held.
- An undated TONIGHT poster processed before any All Day evidence exists for
  that day (no morning poster, no prior automation) still holds, because its
  daytime repeats cannot be identified.
- When fact-identical repeats differ only in punctuation, the first planned
  post supplies the wording (pre-existing behavior).
- Parser version stays 19. No migration, prompt or configuration change.
  October 22 itself is not replayed.

## Coverage

`workers/fb-feed/oct22-pizza-night.test.js` (11 tests) with the public-text
fixtures `tests/fixtures/oct22-pizza-night.json` (evening) and the existing
`tests/fixtures/oct22-delivery.json` (morning): both processing orders,
repeats of published automation, missing timestamp trust, printed other
day/date/tomorrow, Tuesday and weekends, twelve join refusals plus a
three-size join, incomplete prices (no half publication), a different second
night offer, and pipeline replacement of the recurring default, idempotent
rescans with no extra AI call, staff locks and staff-edited automation.
`tests/specials-rendering.test.mjs` checks the compiled homepage and Specials
page show the combined offer with both prices. Disabling either part of the
correction fails five of the new tests.
