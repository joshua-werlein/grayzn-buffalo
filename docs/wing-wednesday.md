# Wing Wednesday

A recurring `/specials` section built on the Mexican Night section tables, with the anchor `#wing-wednesday`.

## Data

| Item | Value |
|---|---|
| Migration | `0027_wing_wednesday.sql` (additive) |
| Recurring template | `wing-wednesday-defaults` |
| Live section | `wing-wednesday` |
| Options | group `ww-live:ww-default:wings`: slots 1–2 hold bone-in and boneless in either order, slots 3–4 open and left empty by Facebook |
| Sauces | group `ww-live:ww-default:sauces`: slot 1, one sauce per line. The same list is also the public Menu's Sauces section (both tabs and `menu.json`, `src/lib/menu-sauces.ts`), without prices, whenever the group is enabled and not empty. Its position is set in Admin › Menu › Manage Sections (stored as `settings.menu_sauces_sort`; right after Appetizers until changed). If staff also have their own section named Sauces (any case), that section is left exactly as is and this one is headed "Wing Wednesday Sauces"; its anchor is always `#menu-sauces` |
| Facebook decisions | `wing_wednesday_decisions`: `published`, `held` or `approved` |

## Links

`src/lib/section-links.js` holds the identifiers (`mexican-night`, `wing-wednesday`), labels and anchors. `readPublicSections()` in `specials-store.ts` is the only visibility decision, and every section, daily link and recurring card uses it, so a hidden section can't be linked.

A special links through its stored `section_link`, or by being the section's home nightly slot and naming that promotion. The home slot doesn't store the identifier because automation treats any linked slot as protected, which would stop Facebook updating it. A bone-in or boneless dish that isn't wings gets no link.

While the section is visible, `presentSpecial()` replaces the printed heading (`Mexican Night!`, `Wing Night!`) with the link. Stored text doesn't change, and once the section is hidden the special reads as printed.

The homepage Wednesday card is shorter. While the section is visible, `presentHomeSpecial()` shows only the link, like Tuesday's Mexican Night card, and `withWingHomeLink()` adds it for rendering when the nightly field is empty. A special staff entered shows as written instead of the link. Nothing is removed from the database or Recurring Defaults, and `/specials` keeps the full card.

## Prices

A wing price shows only from a verified current poster or staff. A verified poster for the current week is authoritative. No price is invented or carried over from an earlier week.

- The section starts each week from `wing-wednesday-defaults`, which rejects prices when saved. The rollover also refuses a priced default that reaches the table some other way, leaving the section hidden.
- The Wednesday nightly slot comes from the ordinary `defaults` template, which may still hold `$.89` and `$.99` from migration `0012`. The rollover and the Create new week prefill both drop that price when copying, and a new wing price typed into the template is rejected. An untouched legacy value doesn't block other template edits.
- `presentSpecial()` also drops the price from a slot that neither a verified poster nor staff wrote, which covers weeks created before this rule. Normal specials on other nights, and other Wednesday promotions, keep their prices.
- While the section is visible, a staff-approved section price replaces the nightly reading it corrected, and a section price fills a nightly slot that has none. A slot staff edited directly stands.

## Schedule

All times are Chicago. The weekly transaction in `ensureAutomaticWeek` copies the template to the live section at 7:00 PM Sunday and records the week and Wednesday service date. `wingWednesdayVisible()` shows it from then until 2:00 AM Thursday. Hiding removes nothing.

A staff save claims its week. On Sunday that is the coming week, so the rollover can't replace an edit made before 7 PM. Until the section reaches the current week, the editor starts from the defaults so last week's prices aren't saved forward, and a tab opened for an earlier week is refused. An edit from Thursday through Saturday stays with the finished week and is replaced on Sunday. Each new week starts from the recurring defaults.

## Staff edits and Facebook

The Wing editor has an item name and an optional description, with no price field. The Protect this price checkbox no longer exists. A poster writes only each option's price, keeping the name, description, sauces, title and schedule staff entered.

Staff can type a price into an item name when needed. That price ends the review of that option and never blocks Facebook.

| Staff enters a price, then | Result |
|---|---|
| A verified poster that hasn't been applied yet supplies that option's price | The poster replaces the staff price, whichever was posted first |
| The poster it corrected is scanned again | The staff price stands, because a poster is only decided once |
| A newer poster doesn't verify that option | The staff price stands and isn't sent for review |

Keeping the price the last poster supplied isn't a staff price. Every save still requires the revision the form opened with, so a stale form can't overwrite a published price.

## Add Fries

Add Fries is a standing line on the Wednesday nightly card on `/specials`, and on the homepage only when the section is hidden. It's never in the section, including when a poster prints it or updates the wing prices. It appears when the Wednesday nightly Recurring Default includes it and a poster omits it, without a price. A price printed on the current poster shows with it. A card staff wrote stands as written.

## Facebook

The Wednesday poster goes through the existing extraction once. Its validated evidence then updates two destinations independently: the nightly special and the Wing Wednesday section. A locked or staff-written nightly slot keeps its text while the section updates.

- `wing-night.js` accepts Wing Night or Wing Wednesday, keeps the printed name, and proves each price against its own printed label.
- A Wednesday poster for another promotion publishes as the nightly special. The section keeps its values, and the post is held for staff.
- Only the newest current-week poster counts (Sunday through Wednesday). It must print Wednesday, or be posted on the Wednesday itself.
- A price goes to the item whose name states that wing type, not to a fixed position, so reordered items stay correct. Automation Review approvals follow the same rule.
- Each price is decided on its own. A verified price publishes while an uncertain one is held, and only that option goes to review.
- An item naming neither type or both, or two items naming one type, is held rather than guessed. The other option still updates if its type is clear.
- A new price replaces the old one however it was written, leaving one price in the item name. Descriptions aren't read or changed.
- When the newest poster doesn't verify an option, an earlier poster's price comes off and the option is held. A deleted, expired or earlier-week poster supplies no price.
- Only the prices on the two wing options are written. Sauces are staff-managed.
- A failed section write is held and retried on the next run.

## Review and alerts

`readWingAttention()` in `workers/fb-feed/wing-review.js` is the one decision behind the editor notice, `/admin/automation` and email. Only the newest decision for the live week counts. A newer verified poster, a staff price on the held option, a dismissal or a corrected reading ends it.

Decisions stay in `wing_wednesday_decisions`, apart from `special_import_events`, because the daily reconciler compares against its own latest `review` event on these same imports.

Alerts use the existing pipeline with scope `wing` and code `wing_wednesday_failed`, including its grace period, send fence and fingerprint deduplication. A poster that also holds the daily special sends one email naming both, unless the daily email has already gone.

## Rollout

Pushing to `main` deploys Pages automatically; the Worker deploys separately. Order: apply migration `0027`, push so Pages deploys, then deploy the `grayzn-fb-feed` Worker from that same commit. Before the Worker runs, Pages shows nothing new because the section has no week yet. Confirm what production has recorded before using `migrations apply`, because it runs every migration it believes is unapplied.
