# Menu options panels

Shared choices on the public Menu appear in one light bordered panel design
(`src/components/OptionsPanel.astro`) under the section heading and divider and above
the items. No panel stores or shows prices, surcharges or price placeholders.

| Section | Panel content | Edited in Admin › Menu | Stored as (`settings`) |
|---|---|---|---|
| Pizzas | Sizes 6" · 12" · 16", Thin/Regular/Deep Dish crusts, 20 toppings | Pizza sizes, crusts & additional toppings | `menu_pizza_options` |
| Sauces (own section) | The 16 Wing Wednesday sauces and "Pair any sauce with anything on the menu. Available every day." | Names in Specials › Wing Wednesday; position in Manage Sections | `menu_sauces_sort` |
| Wraps | Grilled or Crispy chicken, any sandwich as a wrap, "All Wraps Served with Chips and a Pickle. See Substitute Sides." | Wrap options | `menu_wrap_options` |
| Salads | 12 dressings, "Choice of Iceberg or Spinach Mix.", "† Indicates Salad Comes with a Shell. No Shells for Lighter Side Salads." | Salad dressings, greens & shells | `menu_salad_options` |
| Substitute Sides (own section) | "Available as substitutions for Wraps, Sandwiches and Burgers." and the four printed choice groups | Substitute sides (with a Late Night checkbox, off by default); position in Manage Sections | `menu_substitute_sides`, `menu_substitute_sides_sort` |

Defaults come from JJ's printed menu and apply until staff save; no migration or D1 write
is needed to show them. A saved empty list hides that part (an empty Wrap or Substitute
Sides list hides the panel or section; an empty Salads panel is not shown). Unreadable
saved values fall back to the defaults. Pizza sizes saved by earlier releases (`Personal`,
`6 Inch`, `12 Inch`, `16 Inch`) read as `6"`, `12"`, `16"` without any D1 rewrite.

- Choice names (dressings, greens, pizza toppings) take the house capitalization. Wrap
  notes and substitute-side lines are free text kept as typed, like section notes.
- Shell salads are chosen by item name among the Salads items and marked `†Name` (the dagger is
  hidden from screen readers, which hear "(comes with a shell)"). The Burgers asterisk is unchanged. Only the Salads section is marked, never the
  Mexican Night Taco Salad. Renaming a marked salad clears its mark until it is re-checked.
- No tortilla flavors are documented, so none are listed.
- Substitute Sides shows on the Daily Menu, last by default, and on the Late Night Menu only when
  staff tick "Also show on the Late Night Menu" (stored as `lateNight` in `menu_substitute_sides`). Like Sauces, it is placed
  after every section with the same or a lower number, uses a fixed `#menu-substitute-sides`
  anchor, and takes the heading "Substitute Side Choices" if staff already have a section
  named Substitute Sides. Baskets keep their own accompaniments.

- “See Substitute Sides” keeps the Wraps wording intact and links to the virtual section's
  fixed anchor. On Late Night it uses `#late-menu-substitute-sides` when enabled, otherwise
  it switches to Daily and uses `#menu-substitute-sides`. Activation reveals the tab,
  scrolls to the section and moves keyboard/screen-reader focus there. An empty sides list
  leaves the phrase as plain text, avoiding a link to a missing section.
- Option forms carry the exact settings snapshot they displayed. Conditional writes reject
  stale Pizza, Wrap, Salad and Substitute Sides saves while retaining the submitted draft.
  Both virtual section order fields join category ordering in one guarded transaction.
  Displayed values and their concurrency tokens are captured in one settings read.
