# October 20 Mexican Night implementation and verification

## Evidence and causes

Read-only production inspection on October 20, 2026 confirmed import
`bd5bead40405e72a00840a216584e429`, parser 19, collection revision 11.
The archived poster was visually inspected from its R2 object:
`special-imports/583672228384067_1739929751008235-1cd9e22626cf5253f0cd-f7e933ff-424c-4e3c-974e-f1a532b75842.jpg`.

- Taco Salad labels were absent in **both AI title and AI evidence**, before validation or persistence. The matching-facts check therefore accepted the same omission twice. Neither D1 nor rendering removed labels. Validation now rejects bare multi-price lists even when evidence repeats them; contract 2 gets one targeted reread. Labels are restored only when the item's evidence explicitly pairs each label and amount. No prices or labels are guessed from the template.
- Reconciliation assigned `poster_evidence` directly to the collection title and the extracted schedule directly to its schedule. This persisted the promotional headline as a huge heading. Reconciliation now uses the canonical title and recurring schedule; rendering uses the requested heading/subtitle, and group times are no longer repeated below Favorites. Promotional menu entries are excluded.
- The live DOM contained exactly one Favorites heading, no duplicate pseudo-element, and no text shadow. Its font shorthand left line-height as `normal`. A true overlap was **not reproduced**; the change replaces the crowded small slab-serif heading with the existing label typeface, makes line-height explicitly 1.5, and allows wrapping. This is a layout safeguard, not a claim that duplicate markup was found. Browser verification after the change at 375px/1440px found one heading, an 18px gap before the food list, and no horizontal overflow.
- Food groups were previously replaced wholesale, and any accessory group replaced all accessories. Imports now patch matching items over the current week's seeded template, preserving omitted foods, descriptions, prices, sizes, and individual accessories. Unchanged stored groups retain ownership metadata. Ambiguous duplicate identities and incomplete size changes fail closed. Whole-collection staff protection and transactional snapshot checks remain.

All seven food prices and five accessory prices supplied in the request match the archived poster. The recurring template has the expected names, descriptions and sizes but intentionally has no prices (existing policy and migration 20 are unchanged). The entire public page already contained all five accessories; none was missing below the viewport. The food-safety disclaimer was on `/menu` but absent from `/specials`; the shared Mexican renderer now displays the existing wording once.

## Files

Implementation:

- `workers/fb-feed/mexican-menu.js`: deterministic identity, merge, schedule comparison, and promotion classification.
- `workers/fb-feed/reconcile.js`: multi-price validation and promotion exclusion.
- `workers/fb-feed/worker.js`: one targeted repair for missing size labels.
- `workers/fb-feed/extraction.js`: explicit promotional-text exclusion in both prompts.
- `workers/fb-feed/guarded-auto.js`: baseline merge, recurring schedule, review flags, transactional template snapshot checks, preservation of unchanged group ownership.
- `src/pages/specials.astro`: canonical public heading and subtitle.
- `src/components/MexicanNightMenu.astro`: clearer section-heading typeface and spacing, no redundant group schedule, one advisory.

Tests and fixtures:

- `workers/fb-feed/oct20-mexican.test.js`
- `workers/fb-feed/mexican-night.test.js` (replacement expectations updated to the requested preservation policy; protection assertions retained)
- `workers/fb-feed/mexican-night-lifecycle.test.js` (staff form fixture pads every retained group)
- `tests/mexican-oct20-rendering.test.mjs`
- `tests/fixtures/mexican-layout.html`
- `tests/specials-rendering.test.mjs`
- `tests/mexican-correction.test.mjs`

Prepared recovery and this report:

- `recovery/oct20-mexican-correction.js`
- `docs/mexican-night-oct20-fix.md`

No delivery source/tests, migrations, migration tracking, or import-history records were modified remotely. No deployment or reprocessing was performed. Local main and remote main were both `d912f88da441aad1b28ccab9d339dfe82380050c` at inspection; the checkout was clean before work.

## Production correction procedure — requires separate authorization

Deployment alone cannot repair the existing unlabeled Taco Salad content. Do not clear history or replay the live post.

1. Obtain explicit approval for the October 20 D1 correction. This is separate from Pages/Worker deployment approval.
2. Read and retain a fresh snapshot of `special_collections` for `mexican-night`, its groups/slots, and import `bd5bead40405e72a00840a216584e429`. Confirm revision 11, week October 19, Facebook ownership, exact old title/schedule, exact unlabeled Taco Salad content, and no staff locks/drift. Stop if any differs; do not loosen the checks.
3. Through an approved administrative runtime with the existing `grayzn-db` D1 binding, invoke `correctOctober20MexicanNight(env.DB)` from the prepared recovery module exactly once. The module has no automatic entry point and is not a public endpoint. It uses one D1 `batch` transaction, parameterized statements, a mutation token, exact old-value checks and whole-collection manual protection.
4. Require exactly one returned collection row: revision 12, title `Mexican Night`, schedule `Every Tuesday • 5–10 PM`, source `manual`. An empty result means no change: stop and reread, never retry with relaxed conditions.
5. Verify Taco Salad contains `Large $9.00 | Small $8.50 | Mini $6.00`, the description is unchanged, and only that slot's content/ownership and collection presentation/revision/source changed. Publication timestamps, week/service dates, recurring defaults and original import evidence remain unchanged. The audit event records the correction. The staff lock expires through the existing next-week rollover behavior.
6. Verify the public page. The correction fixes current data; layout/advisory/import safeguards require the separately approved Pages and Worker deployment. Repeated correction calls are no-ops. If execution fails mid-batch, D1 rolls back the batch. Do not perform an automatic rollback over later staff work.

## Remaining limits

The reported doubled heading could not be reproduced as overlapping DOM/CSS; confirm the affected user's browser after deployment. Missing prices remain absent when neither current-week evidence nor the stored baseline supplies them. Genuine removals, ambiguous renamed dishes, incomplete size changes, and changed hours require staff review rather than inferring deletion or changing the established schedule. Schedule discrepancies retain the menu and write `REVIEW_REQUIRED_MEXICAN_SCHEDULE` to the import's review reason and audit trail. A subsequent approved correction must use staff editing rather than deleting that audit event to force a replay.

The prepared data correction is deliberately specific to the observed revision. Any intervening staff save requires a new reviewed procedure.

## Final verification results

- 210 Mexican Night, lifecycle, visibility, extraction, pricing, ownership, defaults, admin and recovery tests pass across the final targeted runs. The final combined run had one old ordering/ownership assertion; its corrected 25-test lifecycle suite then passed in full. The new assertion checks the imported item by identity and also verifies the preserved seeded slots byte-for-byte.
- 105 parser/reconciliation/AI reliability and poster-formatting regression tests pass.
- 14 compiled Astro rendering/layout tests pass after the final typography change.
- Total: 329 relevant tests, with all final test expectations passing. Delivery tests and implementation were not edited.
- `npm run build`: passed after the final UI change.
- Browser fixture: 375px and 1440px, one Favorites heading, 1 and 4 food columns respectively, 18px heading/list gap, no horizontal overflow, one advisory. Final heading typography also inspected visually.
- Prepared recovery: exact-snapshot success, manual-lock rejection, idempotency and injected-failure rollback verified against disposable local SQLite.
- `git diff --check`: passed.

Reproduce the browser fixture with `npm run build`, then set `MEXICAN_LAYOUT_PREVIEW=1` and run `node --test tests/mexican-oct20-rendering.test.mjs`. Serve `.wrangler/mexican-layout` with `/_astro` and `/images` mapped to the built `dist` assets. The fixture runs its own browser geometry checks after fonts load.

Local implementation is ready for deployment approval. Current-week data correction needs separate approval and a fresh snapshot; no production mutation has been performed.

## Authorized production release — October 20, 2026

- Release commit: `0c4662345b48b260e588dbabca1f0c06d9b373da` (13 reviewed implementation/test files), pushed to main. Remote main was checked before release; no conflicts or unrelated changes were present.
- Release checks: 327/327 tests passed (the two deferred correction tests were excluded), Astro build passed locally and in CI, Worker dry run passed, and diff whitespace checks passed.
- Pages: `62785a29-35c8-40e0-a1b3-27190e2bf799`, production source `0c46623`, https://62785a29.grayzn-buffalo.pages.dev. Established GitHub Actions deployment succeeded: https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/39510514082.
- Worker: `14b6503d-0368-41db-89e1-39e8e477f496`, active at 100% as of 2026-10-20 17:48 America/Chicago. Deployed using `npx wrangler deploy --config workers/fb-feed/wrangler.toml --keep-vars`. Existing variables, routes, half-hour cron, queue, bindings, and parser identities retained.
- Previous rollback references: Pages `2389242a-19e3-4f19-9043-356cc657154e`; Worker `27fe0847-0ee4-49c1-83c1-f326668c3c30`. No rollback was needed.
- Public checks: homepage, specials, and read-only Facebook feed returned HTTP 200. Browser confirmed canonical heading/subtitle, one Favorites heading in Barlow Condensed, all seven food items, five accessories, one advisory, no horizontal overflow.
- Read-only before/after D1 comparison confirmed the October 20 collection (revision 11), Taco Salad slot, and existing import-review audit remained identical. The unlabeled Taco Salad record remains DEFERRED and UNCORRECTED. No migrations, manual corrections, direct production D1 writes or Facebook post reprocessing were performed.
- The correction module, its test, and this working report remain local and were excluded from the release commit. No delivery automation or D1 reconciliation changes were included.
- One-time read-only follow-up `verify-october-27-mexican-night-import` is active for October 27, 2026 at 5:30 PM America/Chicago. It must verify the actual new source/import and published labels/prices, recurring defaults, and add-ons; missing or failed imports must be reported, not assumed successful.
- No deployment failures occurred. GitHub's runner-image migration notice was informational only.
- Production screenshot: `.wrangler/mexican-production-release.png`. Build/test/snapshot logs are in ignored `.wrangler/mexican-release-*` files.
