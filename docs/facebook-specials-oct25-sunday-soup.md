# October 25: Sunday soups missing (local fix, not deployed)

## Production evidence (read-only)

- Post `1744683877199489` (`SUNDAY SPECIALS`), created 9:27 AM CDT, processed
  9:29 AM. Both AI readings were faithful and staged `ok`. The fourth offer
  read `content: "Soups: Chicken Noodle or Chili"` with verbatim
  `evidence: "Soups: Chicken Noodle or Chili."`; the poster prints that
  sentence period.
- The stored validation reason and audit events 456–459 record
  `offer 4: Ambiguous standalone Soup evidence`. The guarded publisher wrote
  the three food slots (Sunday Special $30, Hang Over Burger $10.25, Grilled
  Ham and Cheese $7.25) and blocked only the Soup proposal. Nothing was written
  to the Sunday Soup line, so the pages showed the food without soups.
- The later Packers $4 pulled pork post (`1744742333860310`) is a special event,
  unresolved and unpublished; it is not part of this fix.

## Stage and cause

Extraction and staging succeeded; the soup was **rejected during
reconciliation**, not omitted by rendering. `standaloneSoup()` in
`src/lib/daily-soup.js` requires the soup names in content and evidence to
match exactly. The evidence's single sentence-ending period made `Chili.`
differ from `Chili`, so the standalone Soup was treated as ambiguous.

## Correction

`standaloneSoup()` now treats one terminal `.` or `!` after the soup names as
presentation, on both sides. Every name, connector, comma and inner period
must still match; a dropped soup, changed `or`/`and`, a dangling connector,
a price, a side or "with" wording, or two terminal marks still reject.
Multiple advertised soups stay one exact printed line
(`Chicken Noodle or Chili`); no price is added.

Unchanged design that already meets the display requirements:

- Soup is stored in the reserved per-day Soup group (`soup:<week>:<day>`),
  never in a Lunch/All Day/Nightly slot, and rendered once by `DailySoup` on
  both the homepage and the Specials page.
- It belongs to that dated day of that saved week. The guarded publisher only
  accepts sources whose stored Facebook creation time is today in Chicago, and
  printed other weekdays, other dates or future references exclude or reject
  the poster. There is no Sunday recurring soup default, so nothing carries
  into another day.
- Staff-locked or staff-edited Soup values are never replaced; unlocked blanks
  and unchanged automation may update. Recurring defaults are untouched.

Parser version stays 19; no prompt, schema, migration or configuration change.
October 25 itself is not replayed in production. If deployed while today's
evidence is still current, the next scheduled scan would reuse the staged
reading without another AI call.

## Coverage

`workers/fb-feed/oct25-sunday-soup.test.js` (8 tests) with the public-text
fixture `tests/fixtures/oct25-sunday-soup.json`: the stored candidate,
both orders with the Packers post, parser boundaries (accepted terminal marks
and multiple soups; rejected omissions, connector changes, prices, sides and
double marks), printed other day and future date, stored Facebook times outside
today, pipeline publication into the reserved Soup group with food unchanged,
no other day touched and idempotent rescans, the later Packers post, and a
staff-locked Soup. `tests/daily-soup.test.mjs` checks the compiled homepage
and Specials page render the Soup line once beside all food specials. Reverting
the parser change fails five of the new tests.
