# Grayz'n Buffalo project status

Updated November 22, 2026 (Central time). Admin session invalidation, the refreshed emergency menu, the Facebook alert optimization and responsive footer artwork are live. The Cloudflare audit is complete within the verified scope below. The full November 22 R2 snapshot is archived. Photos and Reviews is live for signed-in staff and awaits owner review before any public launch.

## Verified production baseline

| Item | State |
| --- | --- |
| Primary checkout | `C:\Users\Jwerl\dev\Grayzn Buffalo`. The deployed source is `df0ea1a2187b74d0dd08959498c5d1363630aa07` on `main`, merged through PR #6. [Merged PR](https://github.com/joshua-werlein/grayzn-buffalo/pull/6) |
| Live site | Astro 7.4.7 on `grayzn-buffalo`, version `ee689404-b8a0-43e5-9029-eee6bd8ea14d` at 100%. [Public site](https://grayznbuffalo.com/) · [Deployment workflow](https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/45070923816) |
| Facebook Worker | `grayzn-fb-feed`, version `260c8ad8-b4a2-4cc4-b28a-12954b543e53` at 100% from 11:10 a.m. Central. The separate Wrangler deployment and active bundle were verified. |
| November 21 release evidence | CI passed 491 app tests and 1,830 Facebook Worker tests. Maintenance covered bounded request bodies, input validation, Facebook API and image timeouts, private error handling, explicit database columns and GitHub Actions permissions. [Release record](maintenance-hardening-2026-11-21.md) · [CI run](https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/44936454618) |
| D1 recovery | The November 21 post-release export was restored into isolated local workerd, with all 23 table counts, quick check, foreign keys, indexes and migration receipts verified. The pre-release D1 export and photo archive were verified after encrypted offsite upload and download. The two D1 recovery points are distinct. |
| R2 recovery | The November 21 backups cover 20 menu and Welcome objects. The November 22 archive pair covers the complete 88-object snapshot, including Facebook feed images and import evidence. See Task 3 for counts, checksums and recovery. [November 21 backup evidence](maintenance-hardening-2026-11-21.md) |

## Final production verification

- GitHub Actions #534 deployed the site at PR #4's merge SHA. Attempt 2 passed Astro check, build, 496 application tests, 1,835 mocked Facebook Worker tests and the names-only secret preflight. Attempt 1 failed in `workers/fb-feed/recovery-d1.test.js` on a Miniflare `SynchronousFetcher` assertion. The same commit passed on retry. Investigate as a possible intermittent local-runtime test issue if it recurs. [Attempt 1](https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/45044539344/attempts/1) · [Attempt 2](https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/45044539344/attempts/2)
- Home, Menu, Specials, Contact and `/menu.json` returned 200. Home navigation linked to Menu, Specials and Contact. The menu feed's top-level section items totaled 114 and exposed no price fields. HTTP apex returned 308, HTTPS `www` returned 301, and both redirected to HTTPS apex. The HTTPS site sent HSTS. Anonymous `/admin` served the noindex login page. `/admin/menu`, `/admin/specials` and `/admin/automation` redirected to sign-in. Signed-in Turnstile login, a protected page, logout and genuine legacy-cookie rejection remain manual.
- The Facebook feed returned 200 with four post permalinks and a 60-second cache policy. An unauthenticated webhook verification GET returned 403 and `no-store`. The active Facebook script matched a local Wrangler dry-run bundle built from the PR #4 merge commit byte for byte (SHA-256 `fec402e301bca8855a2b09c198f3fdf43909a35df599a95ba4badf5166d95796`). The active version retained `DB` (D1), `FB_KV`, `PHOTOS` (R2), `AI` and `IMPORT_TRIGGER`. Queue metadata confirmed `grayzn-fb-feed` as both producer and consumer of `grayzn-fb-import-trigger`. The live cron schedule is `*/30 * * * *`. Signed webhook delivery and queue processing were left to normal production traffic.
- From each deployment through 1:49 p.m. Central, Cloudflare's adaptive invocation data reported zero Worker errors. The site had 539 successful invocations and two client disconnects. Facebook had 14 successful invocations. The latest D1 alert evaluation completed at 1:30:30 p.m. Central, with three complete recent scans, zero uncertain incidents and zero same-day send failures at inspection. No production deployments, imports, alerts, D1 writes, R2 modifications or secret changes were initiated by this verification.

## Task 1 · Admin session invalidation

Deployed November 22 at 9:06 a.m. Central from `5759f59a0ab812c8540bbcaeeaed50adc235e1bd` as site Worker version `89c8062c-6d37-44d9-8060-27594ad9626a`. The auth implementation commit is `25fe367abe458e0a89b2097f9325fa9b517222e5`. GitHub Actions passed 494 application and 1,830 mocked Facebook Worker tests and confirmed the encrypted `ADMIN_SESSION_KEY` by name. Public and anonymous admin checks passed. Live signed-in verification remains manual. `ADMIN_PASSWORD` was preserved. [GitHub Actions deployment](https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/45035085932)

- [src/lib/auth.ts](../src/lib/auth.ts) stores a versioned HMAC-SHA-256 over the session token and current password. The independent `ADMIN_SESSION_KEY` Worker secret prevents a KV snapshot alone from serving as a password verifier. The existing 24-hour KV and cookie expiry, Secure, HttpOnly and SameSite=Lax cookie, Turnstile-first password check, redirects and sign-in UI are preserved. A valid request reads KV once and does no session write. A missing credential or key and a failed KV read deny authorization. No schema migration is involved.
- [scripts/check-worker-secrets.mjs](../scripts/check-worker-secrets.mjs) adds the signing key to the names-only deployment preflight. [tests/auth-security.test.mjs](../tests/auth-security.test.mjs), [tests/check-worker-secrets.test.mjs](../tests/check-worker-secrets.test.mjs), and [tests/admin-session-fixture.mjs](../tests/admin-session-fixture.mjs) cover credential rotation, protected pages and photo API writes, failures, expiry, cookie flags and logout. Existing authenticated route tests now use signed fixtures. Use `git diff --name-only 2691524..codex/admin-session-invalidation` for the full file inventory.
- All legacy sessions require one sign-in on first deployment because their KV records contain only `1`. Subsequent unrelated deploys preserve signed sessions with the same password and key. An updated Worker rejects an old signature even if KV still returns it. Earlier Worker versions and in-flight requests may still use the prior binding during propagation. New login records and logout deletes can take about 60 seconds or longer to become visible in other KV locations. Reusing an older password before its signed records expire can make those records valid again. [Session rollout and rollback](admin-session-rollout.md) · [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

### Task 1 local verification

| Check | Result |
| --- | --- |
| `npx astro check` | Passed. 36 files, 0 errors, 0 warnings, 28 hints. |
| `npm run build` | Passed. Astro built the Cloudflare Worker and client assets. |
| Auth, photo upload security, deployment config and secret preflight | 35 passed, 0 failed. The auth file alone passed 13 tests. |
| Full application suite | 494 passed, 0 failed, 0 skipped. |
| Full Facebook Worker suite | 1,830 passed, 0 failed, 0 skipped. Final result recovered from the completed local test log after the chat interruption. |
| `git diff --check` | Passed. |

Run tests with Node 24.22.3, using mocked credentials and local fixtures. The first targeted run failed one new assertion because Astro's test container exposes response cookies separately. The corrected run reads Astro's cookie API. The 35 targeted checks passed again during the November 22 handoff. The first sandboxed full Facebook attempt was cancelled after visible failures and superseded by the complete rerun above.

## Task 2 · Cloudflare security audit

The signed-in dashboard supplied zone settings and token policies that Wrangler OAuth could not read. Public requests used ordinary GETs. The audit made no changes.

| Setting | Verified state | Risk | Recommended action |
| --- | --- | --- | --- |
| WAF and rule order | The Free zone shows one active custom rule, an order-1 block for a single scanner IP. No custom Skip rule or separately configured managed rules were listed. Security Settings showed the built-in managed ruleset and HTTP DDoS protection always active. | The scanner rule is narrow. An independent account ruleset inventory remains unavailable. | Keep the verified managed protection. Review the scanner rule's Security Events before deciding whether to retain it. [Zone security rules](https://dash.cloudflare.com/a79e3b4a2bb8dad70c75bceac4b1d3f9/grayznbuffalo.com/security/security-rules) · [WAF plan coverage](https://developers.cloudflare.com/waf/) |
| Admin rate limiting | One active rule blocks exact `POST /admin` requests above 5 per IP per 10 seconds for 10 seconds. It applies to any action posted to that path. Server-side Turnstile runs before password verification. | Staff behind one IP can share a counter. Edge matching is limited to the exact path in the rule. | Keep the current limiter. Review actual rate-limit events and canonical path handling if staff report trouble. [Zone security rules](https://dash.cloudflare.com/a79e3b4a2bb8dad70c75bceac4b1d3f9/grayznbuffalo.com/security/security-rules) |
| Contact rate limiting | No dedicated zone rule for `POST /api/contact`. The Free zone's one rate-limit rule covers admin. The code bounds the request and verifies Turnstile before using Resend. | Invalid contact traffic still reaches the Worker. Provider and Worker usage can grow during abuse. | Keep the admin rule. Use observed abuse and mail metrics to decide whether additional rate-limit capacity is justified. [Contact handler](../src/pages/api/contact.ts) · [WAF plan coverage](https://developers.cloudflare.com/waf/) |
| Bot protection and indexing | Bot Fight Mode, Under Attack Mode and AI Labyrinth are off. Browser Integrity Check is on and challenge passage is 30 minutes. No configuration rules or legacy Page Rules were listed. Public home and contact returned 200, robots permits general search crawling, the sitemap returned 200, and admin returned `noindex, nofollow`. | Browser checks could affect some clients. Public probes do not establish how actual Googlebot was treated. | Check Security Events and Search Console's live URL inspection before changing bot policy. [Zone security settings](https://dash.cloudflare.com/a79e3b4a2bb8dad70c75bceac4b1d3f9/grayznbuffalo.com/security/settings) · [robots.txt](https://grayznbuffalo.com/robots.txt) |
| TLS and HTTPS | SSL mode is Full with Automatic mode enabled. The minimum edge version is TLS 1.0, TLS 1.3 is on and the Universal certificate is active. Zone-wide Always Use HTTPS is off. Two active redirect rules enforce HTTPS apex and www canonicalization. Public HTTP apex redirected with 308 and HTTPS www with 301. The HTTPS app returned HSTS with `max-age=15552000; includeSubDomains`. | The configured edge floor permits legacy TLS. Full mode does not verify an origin certificate when Cloudflare connects to an origin. | Review a TLS 1.2 minimum with the owner. Confirm any real origin or fallback certificate before considering Full (strict). The current Worker route uses a proxied placeholder DNS setup. [Edge certificate settings](https://dash.cloudflare.com/a79e3b4a2bb8dad70c75bceac4b1d3f9/grayznbuffalo.com/ssl-tls/edge-certificates) · [TLS minimum](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/) · [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/) |
| Worker routes and DNS | The site owns `grayznbuffalo.com/*`. The Facebook Worker owns the more specific feed and webhook routes. Both have workers.dev and preview URLs disabled. The account Worker custom domain API returned none. Apex and www are proxied, with apex pointing to a placeholder Worker origin via proxied `100::`. | Removing the apex Worker route would interrupt site handling. An older Pages fallback is not established by this audit. | Keep the dashboard-managed routes. Use the site Worker versions for recovery. [Zone Worker routes](https://dash.cloudflare.com/a79e3b4a2bb8dad70c75bceac4b1d3f9/grayznbuffalo.com/workers) |
| Deployment API tokens | The account-owned Grayzn Workers Deploy token has a single Individual Workers Editor policy for `grayzn-buffalo`. The user-owned Grayzn Auto Deploy token has Account Cloudflare Pages Edit for this account. GitHub retains both secret names. The active workflow reads `CLOUDFLARE_WORKERS_DEPLOY_TOKEN` and leaves routing to the dashboard. GitHub does not expose the stored values for exact token matching. | Reducing the site token to read-only would break uploads. The legacy Pages token retains write access even though main's Worker workflow does not use it. | Keep the site token at individual Worker Editor. Before an approved legacy token retirement, verify all consumers and the recovery plan. [Token policies](https://dash.cloudflare.com/a79e3b4a2bb8dad70c75bceac4b1d3f9/settings/api-tokens) · [Minimum Worker deploy role](https://developers.cloudflare.com/workers/authorization/workers/) |

Wrangler OAuth returned HTTP 403 for zone metadata/settings, DNS records, custom and managed WAF phases, zone rate-limit phases and the legacy rate-limit endpoint, bot management, the zone list of Worker routes, and account/user token inventory. The dashboard closed those zone and named-token policy gaps. Remaining gaps are the independent account-level custom, managed and rate-limit phase inventory (403, Cloudflare 10000), separate JavaScript Detections configuration, exact GitHub secret-to-token identity, and actual Googlebot treatment. Use an existing authorized account WAF reader or owner-provided dashboard evidence for the account phases, zone Bot Management Read for bot API details if available, owner-side token metadata for CI provenance, and Security Events plus Google Search Console for crawler behavior. No inaccessible setting is classified as insecure. [Cloudflare API permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)

## Task 3 · R2 backup coverage and recovery

The final paginated inventory started at 9:21:24 a.m. Central on November 22. The first pass found 86 objects. Two more objects appeared before the follow-up and all 86 existing keys retained their listed sizes and ETags. The base archive preserves the first pass and the follow-up archive adds the two objects and the complete manifest. D1 menu and Welcome references including derived `@600` thumbnails, D1 Facebook import references, and the current plus retained Facebook feed KV snapshot account for all 88 listed keys. Zero live references were missing and zero objects were unreferenced against those sources at capture.

| R2 prefix | Objects | Bytes | Reference source |
| --- | ---: | ---: | --- |
| `menu/` | 12 | 491,248 | D1 items and six thumbnails |
| `welcome/` | 8 | 323,028 | D1 Welcome slots and four thumbnails |
| `facebook/` | 10 | 1,632,765 | Current and retained Facebook feed KV |
| `special-imports/` | 58 | 9,053,650 | D1 import evidence |
| **Total** | **88** | **11,500,691** | **Complete at the inventory cut-off** |

The November 21 archive covers the original menu and Welcome scope of 20 objects and 814,276 bytes. The new archive pair adds independent coverage of 68 Facebook and import-evidence objects and also includes the 20 menu and Welcome objects. Every downloaded object matched the listed byte count and its single-part R2 MD5 ETag. The manifest records the object key, archive and member path, size, SHA-256, ETag, HTTP and custom metadata, and reference sources. A local decrypt and extraction verified every listed member by SHA-256. Zero objects were unprotected at the cut-off. The bucket remains active, and later writes and automated evidence pruning make recurring snapshots necessary for ongoing coverage. [R2 list API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/)

| Private encrypted archive | Bytes | SHA-256 |
| --- | ---: | --- |
| [grayzn-r2-inventory-20261122.tar.gpg](https://drive.google.com/file/d/1CIroL6VoNhWwo9jBpci7XBBwUsSdW60s/view) | 11,234,404 | `908f093a2f27d472e142c450bd665197ca0fb5918efcfc83b9c17b84be7b2538` |
| [grayzn-r2-followup-20261122.tar.gpg](https://drive.google.com/file/d/1aE4Q1LP2S-IF8xqiIO5YfU23GFvohWZL/view) | 447,592 | `1ea4ee0e1d6619eed4ba81744dffa588bdbda4e082824181d5c31cdbcbf45e84` |

The two archives use GnuPG symmetric AES-256 with SHA-512 S2K and are stored in the existing owner-only Drive folder. Both were downloaded again from Drive, matched the ciphertext SHA-256 checksums above, and decrypted to the same tar files used for the verified local restore. The passphrase remains in the restricted local backup set at `C:\Users\Jwerl\dev\grayzn-backups\r2-inventory-20261122T151328Z`, outside Git and the archives. Offsite restore depends on retaining access to that local passphrase. [Private Google Drive backups](https://drive.google.com/drive/folders/1HpgysRy-n-nboNrdyueEmSne_JPRMgSu)

1. Retrieve both encrypted archives from the private folder and compare their SHA-256 digests above.
2. In a restricted local restore directory, decrypt each with `gpg --pinentry-mode loopback --passphrase-file <local-key-file> --output <archive.tar> --decrypt <archive.tar.gpg>`. On this Windows host, run the Git-bundled `gpg` from Git Bash with POSIX paths so its agent can start.
3. Extract the two tar files into separate directories. Use `complete-manifest.json` in the follow-up archive to select the member from its named archive and verify every restored size and SHA-256.
4. Map each member back to its original object key and metadata. Rehearse any upload into a disposable bucket using separately authorized access. Production restoration requires explicit approval.

## Task 4 · Emergency menu snapshot

The read-only production D1 snapshot contains 10 categories and 114 active items, including 31 Late Night items. The refresh adds 10pc Shrimp Basket, corrects the On the Lighter Side heading and updates 81 existing items across 76 descriptions, five names, three photo keys and two photo orientations. Field counts overlap. Existing sort order, availability and the retired duplicate Cheese Curds exclusion are preserved.

Production D1 had no saved menu option or virtual-section ordering overrides. The built fallback matched all 114 items and 11 corresponding sections in the live menu feed, including the default options, with zero menu prices. The 16-entry live Sauces section reads Wing Wednesday tables independently and keeps its existing D1-unavailable behavior. The regenerated recovery SQL preserves embedded description line endings and refuses a nonempty target. [Menu recovery instructions](../recovery/README.md)

Local verification on Node 24.22.3 passed `npx astro check` (36 files, 0 errors, 0 warnings, 28 hints), `npm run build`, 21 targeted menu tests, and all 496 application tests with 0 failures or skips. The first full run passed 495 tests and failed one assertion that expected the previous heading capitalization. The corrected assertion preserves its original dagger checks. A fresh SQLite restore reproduced the complete snapshot and rejected a populated target. No test used production write bindings.

The approved commit `0fd6d1fd57b74eb04188ff21752be81e51b5c24f` was deployed November 22 at 9:59 a.m. Central after Cloudflare authentication was restored. Before the fast-forward, release checks reconfirmed every tracked menu field and the sort order against read-only production D1 results. The release workflow passed Astro check, the build, 496 application tests and 1,830 mocked Facebook Worker tests. Its version `597e8cb6-ee70-42be-bb88-9a53925ea476` matched the site's 100% active deployment. The prior site version was `89c8062c-6d37-44d9-8060-27594ad9626a`. [GitHub Actions deployment](https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/45040160742)

Post-release GETs verified menu rendering, price-free menu JSON with 114 items and 31 Late Night items, canonical HTTPS redirects and anonymous admin protection. The Facebook Worker remained at `509cda22-b3d0-42a2-8b0c-a49518e0342e`. The release made no production D1 writes or R2, Cloudflare settings or credential changes.

## Task 7 · Facebook alert snapshot optimization

Read-only D1 Insights for the preceding day placed the alert incident upsert and evaluation write among the database's highest total-read queries. Two evaluation-write variants averaged 5,708 rows and 19.54 ms (27 executions), and 5,700 rows and 20.86 ms (10 executions). The larger incident-upsert group averaged 1,914 rows and 2.12 ms (118 executions). Direct snapshot reads averaged 19 rows at 0.17 ms for collections, 374 rows at 0.80 ms for groups, and 1,492 rows at 4.63 ms for slots. The November 21 baseline was 22 million database rows read over 30 days (+301%), with 5,699 rows and 30.6 ms per evaluation query and no reported production automation errors. [D1 query analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)

The read-only health check found a successful November 22 production evaluation at 10:00:31 a.m. Central. The three newest scan records were complete, and there were zero uncertain-send incidents at inspection.

Each snapshot reads all 19 `special_collections`, 374 `special_groups` and 1,492 `special_slots` rows. Two snapshots bracket read-only assessment. The write batch previously repeated full-table counts and null-safe field comparisons for each incident and again for scan completion. The collected week metadata covers the scan date. On November 22 that was week `127790733950070`. The collection graph also includes the retained week IDs `1`, `3`, `2`, `6`, `7`, `8`, `189439038376748`, `9067071494112`, `67764417977154`, `145433591667349`, `120839756668678`, `276508344324535`, and `25623860904001`, plus `defaults`, `mexican-night`, `mexican-night-defaults`, `wing-wednesday`, and `wing-wednesday-defaults`.

Daily reconciliation and disabled-group suppression use the scan-date week. Weekly Lunch can resolve each poster to the printed start date in its creation year or the following year. Without a printed range, it uses the Chicago creation date under evidence version 2 or the scan date in the legacy path. Equivalent, competing or replacement posters can refer to distinct targets, and previously published posters supply replacement provenance for their resolved week. Weekly detail and retention checks can read groups and slots for the resolved target. Mexican Night and Wing Wednesday read sections and staff locks outside the weekly collections. The existing fence also covers edits to retained collections even when a particular scan has no source for them. A production `EXPLAIN QUERY PLAN` verified that a current-week slot query uses the existing week-range, collection-to-week, group-to-collection, and slot primary-key indexes. The narrower query would remove historical and section rows from that guard, so the implementation retains the original snapshot and checks it once per write transaction. There is no schema change.

The first D1 batch statement checks the original evidence and acquires a temporary scan token. Every incident write requires that token. The final statement restores the original token and records successful evaluation in the same transaction. A failed fence leaves each incident write ineligible, and a D1 error rolls back the token and all changes. The snapshot payload, proof hash, durable token, send-time atomic fence, grace period and delivery retry behavior use the existing paths. Production schema inspection confirmed no triggers on either alert table. [D1 batch transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

| Local workerd SQL metric | Original rows read | Optimized rows read | Original SQL time | Optimized SQL time |
| --- | ---: | ---: | ---: | ---: |
| One snapshot | 1,908 | 1,908 | 4.2 ms | 4.1 ms |
| Full slot read inside a snapshot | 1,492 | 1,492 | 3.05 ms | 3.00 ms |
| Representative daily incident upsert | 5,705 | 6 | 21.0 ms | 0.3 ms |
| Final scan completion | 5,701 | 2 | 18.5 ms | Below local 1 ms timing resolution |
| One full evidence check | 5,701 | 5,700 | 18.5 ms | 18.5 ms |
| Complete evaluation write batch | 39,940 | 5,725 | 126.0 ms | 19.0 ms |

The local fixture matched the live table sizes above and exercised a daily incident with one failed source and no existing weekly, Wing or image incidents. Results are means across 10 evaluations after warm-up. Batch SQL time sums statement timings and excludes assessment, request overhead and dispatch. In this case the batch used 85.7% fewer reads and 84.9% less SQL time. Actual production savings will vary with alert outcomes and query plans. The underlying snapshot and send-authorization costs remain visible in D1.

The snapshot optimization is deployed and verified. The six-hour production D1 Insights window contained five samples of the optimized incident upsert averaging 2 rows and 0.22 ms. It also included older query variants from before deployment. The full optimized gate was absent from the returned top-query sample. Production batch savings and the longer-term effect on total database reads are awaiting observation. Keep the November 21 baseline and the local before/after figures distinct. The prior Facebook Worker version `509cda22-b3d0-42a2-8b0c-a49518e0342e` is the verified rollback reference. The persistent schema and proof format are compatible in both directions.

## Image delivery review

Prior work already supplied a 98,740-byte mobile hero background, responsive wordmark and Bar & Grill artwork, a 130,892-byte animated buffalo and a 17,144-byte reduced-motion still. The hero background is preloaded at high priority. Welcome uses WebP thumbnails, responsive frames and deferred inactive photos. Menu rows reserve space for lazy `@600` thumbnails and request the full photo for the lightbox. Successful R2 responses send ETags and `public, max-age=31536000, immutable`. The Facebook feed uses lazy images in reserved card space and shares the image URL with the lightbox. The four sampled feed JPEGs transferred 145,671–201,793 bytes each when scrolled into range. Static WebP artwork uses ETag revalidation.

Two cold production traces at 390 CSS pixels, 3× DPR, 200 KB/s down, 90 ms latency and 4× CPU slowdown recorded LCP of 8.22–8.39 s at the mobile hero background, with CLS about 0.0023. The hero image finished close to its paint time. Several lower-page CSS backgrounds started without scrolling, including Welcome (97,634 bytes), the Facebook wall (104,900 bytes) and the footer landscape (72,376 bytes). The menu trace had 0.97 s LCP and 0.024 CLS under the same emulation. These are single-device lab observations. Recheck the homepage waterfall, CSS background loading and Facebook poster delivery during the final performance audit after Photos and Reviews. No LCP improvement is claimed for the footer change.

The existing Contact Us footer artwork transferred 719,292 bytes despite rendering at 152 CSS pixels on the 390-pixel viewport. Local browser verification at 3× DPR selected the 480w WebP at 390 pixels (91,060 bytes, 87% smaller) and the 800w WebP at 700 pixels (231,114 bytes, 68% smaller). A 1440-pixel desktop viewport selected the original. The mobile screenshot comparison confirmed readable sign lettering and the same artwork, with less fine texture in the downsized image. Rendered height changed by less than 0.2 CSS pixels. The link, accessible name, decorative alt text, lazy loading and noindex treatment were verified. Assets are served from the site build without R2 changes or paid image services. Roll back the site Worker or revert the image commit to restore the original markup.

Production browser checks confirmed the same choices and transferred bytes at 390, 700 and 1440 pixels. The live image kept the accessible Contact Us link, lazy loading and noindex headers. The previous site Worker version `597e8cb6-ee70-42be-bb88-9a53925ea476` is the verified rollback reference. PR #4 includes the work from `53e916c70a12805f86038b1ce20d1fef0b152abd` for the Worker and `1651ca88d2a096b0ee8db03f435e67d69f98f43d` for the footer.

## Local verification for Task 7 and the footer

| Check | Result |
| --- | --- |
| Full Facebook Worker suite | 1,835 passed, 0 failures or skips. |
| Application suite | 496 passed, 0 failures or skips. |
| Targeted Facebook regressions | 7 passed. Covered an empty source and week set, edits to current and historical slots, a newer scan taking ownership, a cross-week poster and one send, and rollback on a failed batch. |
| Astro check | 36 files, 0 errors, 0 warnings, 28 hints. |
| Production build command run locally | Passed. The site bundle contains both new WebP files and their header rules. |
| Local browser | Confirmed candidate selection, byte counts, sign appearance, link, dimensions and noindex treatment. |
| `git diff --check` | Passed. |

## Welcome photo layout fix · Local verification

The browser showed that `object-fit: contain` centered each printed frame inside a box with a different aspect ratio, while the photo aperture's percentage dimensions filled that larger box. The worst measured aperture mismatch was about 53 CSS pixels at 620 pixels. Earlier `grid-auto-rows` rules also constrained the final photo grid, putting the tagline about 41 pixels inside the frames' vertical bounds at 900 pixels.

Each frame now determines the aspect ratio of its grid item. Its artwork and image aperture share that box, with the existing responsive height caps translated into width caps. The grid rows grow with the frames, the tagline follows in normal document flow, and the wood section can grow beyond its desktop background minimum height. The paper artwork, rotations, crop settings, hover lift, photo cycling, and lightbox were retained. The keyboard outline is drawn around the holder where it remains visible.

Local Edge checks used the real holder artwork and local fixture images at 1920, 1440, 1366, 1280, 1024, 900, 768, 620, 390 and 360 CSS pixels. Aperture alignment stayed within one CSS pixel, the tagline stayed at least 30 pixels below the rotated frames, and the page had no horizontal overflow. Before-and-after captures at 1366, 1280, 1024, 900, 620, 390 and 360 pixels are in `.wrangler/welcome-overflow-evidence` in the primary checkout.

Interaction checks verified the hover lift, visible keyboard focus, Enter to open the lightbox, Escape with focus restoration, cycling paused while the lightbox was open, normal timed transitions, and static photos and tagline under reduced motion. All 496 application tests passed with zero failures or skips. Astro check passed with zero errors, zero warnings and 28 hints. The local production build and `git diff --check` passed.

Branch `codex/welcome-photo-overflow` is based on `c2630201b0d75bcf9cd0b49c5b2d83c42fc0f863`. The change awaits owner review and approval to merge or deploy. Photos and Reviews remains a separate assignment after approval of this fix.

## Photos and Reviews · Owner preview

Implemented November 22, 2026 in the local `task/photos-and-reviews` worktree at `C:\Users\Jwerl\dev\.worktrees\grayzn-buffalo\photos-and-reviews`. The worktree belongs to the Photos and Reviews Codex chat and isolates the feature from the primary Welcome checkout. Its base is the verified `origin/main` tip, `8070438d3a5bb3290fb80fc74cb16d608bc97da7`. The site deployment workflow for that base was running when inspected. This feature stays in the local worktree for owner review. [PR #5 base](https://github.com/joshua-werlein/grayzn-buffalo/pull/5) · [Deployment workflow at branch creation](https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/45065025259)

- The gallery filters approved photos by Food, Drinks and The Bar. It reuses the site layout, typography and keyboard-operable lightbox. Cards use responsive 320px and 640px maximum-edge WebP variants, and opening the lightbox requests a variant up to 1440px. Google Maps showed 4.6 out of 5 from 291 reviews for the listing at 102 S Eau Claire St on November 22, 2026. The write-review link reached Google sign-in with the verified place ID in the return URL. [Read Google reviews](https://www.google.com/maps/search/?api=1&query=Grayz%27n+Buffalo+Bar+%26+Grill%2C+Mondovi%2C+WI&query_place_id=ChIJAwP5xdDv-IcRiYQJPU_9snY) · [Write a review](https://search.google.com/local/writereview?placeid=ChIJAwP5xdDv-IcRiYQJPU_9snY)
- The upload form asks for a category, a description per photo and consent. It uses the existing Turnstile verification and bounded request reader. Up to three JPEG, PNG or WebP files are accepted, each up to 5 MiB and 24 megapixels. The aggregate body is capped at 15 MiB plus 32 KiB for form fields. The server checks the signature and dimensions, decodes and re-encodes each image, and retains only still-image WebP chunks in the displayed copies. A database uniqueness constraint prevents duplicate active photos, including competing submissions.
- Staff sign in with the existing signed KV session. They can preview and approve pending photos, reject a photo or the remaining pending photos in its submission, update a description or category, and withdraw an approved photo. Same-origin POSTs, session-bound CSRF tokens, bounded bodies and conditional updates protect writes. D1 commits each submission as an atomic batch. Rejected and withdrawn images are immediately ineligible for delivery, and R2 deletion follows the D1 decision.
- Staff select one approved Food photo per active menu item. It takes precedence in the signed-in menu preview. Removing the association restores any existing staff photo. Withdrawal or recategorizing a photo away from Food revokes the association in the same database statement. The original staff upload flow supersedes an association when staff change the item's photo key. The gallery stores its own objects, independently of Menu and Welcome storage.
- The preview requires a valid staff session, the local preview binding value, and a loopback host. The local configuration disables Cloudflare's storage explorer, local observability and the debugger. The gallery and media responses are never cached or indexed. Protected image URLs serve approved variants, with a separate authenticated moderation mode for one pending thumbnail size. Original files have no HTTP serving route. The prior R2 audit found public R2 access disabled. The review bucket is still distinct so existing menu, Welcome and Facebook R2 objects remain outside the review workflow. Public navigation, footer links and the generated sitemap exclude the preview. [Existing R2 audit](security-reliability-audit-2026-11-08.md) · [Cloudflare Local Explorer](https://developers.cloudflare.com/workers/local-development/local-explorer/)

### Open the local owner preview

Open [Manage Photos and Reviews](http://127.0.0.1:4396/admin?next=/admin/reviews) on the machine running the preview. Sign in with the local fixture password from the worktree's ignored `.dev.vars`. Follow **Open gallery preview** to submit a photo or **Featured menu photo** to assign an approved Food photo to the local Cheeseburger fixture. The retained browser fixture gallery uses labeled site artwork. Use your own photos to inspect portrait images, descriptions and moderation.

If the server has stopped, restart it in the feature worktree using the existing local fixtures.

```powershell
$env:GRAYZN_REVIEWS_LOCAL = '1'
npx astro dev --host 127.0.0.1 --port 4396
```

For a fresh feature checkout, install the lockfile dependencies with `npm ci`. Create an ignored `.dev.vars` with a local-only `ADMIN_PASSWORD`, a random 64-character hex `ADMIN_SESSION_KEY`, `TURNSTILE_SITEKEY=1x00000000000000000000AA` and `TURNSTILE_SECRET=1x0000000000000000000000000000000AA`. These keys make the real Turnstile widget and server verification testable from localhost. Bootstrap the local D1 store and add the disposable menu item before starting the server. [Cloudflare test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)

```powershell
npx wrangler d1 execute DB --config wrangler.reviews-local.toml --local --persist-to .wrangler/reviews-local --file schema.sql
npx wrangler d1 execute DB --config wrangler.reviews-local.toml --local --persist-to .wrangler/reviews-local --command "INSERT OR IGNORE INTO categories (id,name) VALUES (1,'Burgers'); INSERT OR IGNORE INTO items (id,category_id,name,description,late_night) VALUES (1,1,'Cheeseburger','Local preview fixture',1);"
$env:GRAYZN_REVIEWS_LOCAL = '1'
npx astro dev --host 127.0.0.1 --port 4396
```

### Verification

| Check | Result |
| --- | --- |
| Astro check | 38 files, 0 errors, 0 warnings, 28 existing hints. |
| Production build and sitemap | Build passed locally. The default bundle returned 404 for the page, anonymous upload, moderation and image access. The served sitemap excluded `/reviews`. |
| Application suite | 500 passed, 0 failures or skips. Four review tests exercised real local Workerd D1, R2 and Images bindings. They covered upload limits, spoofed or truncated files, EXIF removal, Turnstile rejection, authorization, CSRF, duplicates, concurrent approval, group rejection, legacy image isolation and menu revocation. |
| Facebook Worker suite | 1,835 mocked regressions passed, 0 failures or skips. |
| Local Edge | Verified Turnstile sign-in and submission, all three filters, approval, rejection, featured-photo replacement and removal, and revocation with conditional request headers. Signed-out requests and Local Explorer probes were denied. |
| Browser layout and accessibility | Gallery and moderation layouts passed at 320, 390, 768 and 1280 CSS pixels, with no horizontal overflow and maximum measured gallery layout shift of 0.00006. Verified keyboard focus, Enter, Tab, Escape, focus restoration, reduced motion and accessible names in the browser accessibility tree. A native screen-reader pass remains before public launch. |
| Browser image delivery | The measured fixture transferred 11,282 bytes for the small gallery variant and 75,658 bytes for the lightbox variant. Gallery cards chose small or medium at all tested widths. |
| Git patch formatting | `git diff --check` passed. |

Local browser captures and measurements are under `.wrangler/reviews-browser`. The local test logs are under `.wrangler`.

The existing `public/footer-reviews.webp` uses the same wood, cream sign and crimson palette as the optimized Contact Us sign. Its left-facing arrow complements the right-facing Contact Us arrow. The existing art stays available for the separately approved footer step.

The local Images simulator strips EXIF rotation without applying it. Test photos encoded with EXIF-only orientation against the real Images binding in the approved release rehearsal. Cloudflare documents automatic EXIF rotation for image optimization. [Cloudflare image optimization features](https://developers.cloudflare.com/images/optimization/features/#metadata)

### Before any production change

1. Obtain separate approval for integration, migration, deployment, public access and the footer. If the owner needs a remote private preview, the smallest safe setup is a dedicated preview hostname and Worker behind Cloudflare Access, bound only to disposable D1, KV and R2 resources. Restrict the preview environment to staff, maintain the application session and deny public access at the edge before publishing any route. Verify the Access boundary and Turnstile with the real preview hostname.
2. Before approved rollout, back up D1 and establish the new review bucket's retention and recovery policy. Keep the bucket private with R2 public access and custom delivery domains disabled. Verify the Images binding and resize quotas. Stage and rehearse additive D1 migration `0029_review_photos.sql` before applying it to the approved target. Use the upgrade migration for existing databases and `schema.sql` for fresh ones.
3. Prepare the public gallery and upload policy separately from moderation. Use a customer submission flow without staff credentials, bind real Turnstile verification to the expected hostname and action, and set upload abuse controls before opening the endpoint. Allow approved derivatives only after checking current D1 state and keep revocable media out of shared caches and public image transformations. Check the Google snapshot again, update the public privacy policy with retention and removal information, and test with a real screen reader. Mark the gallery for indexing and add the existing footer sign after the owner authorizes those changes.
4. Roll back by disabling the feature or restoring the last known-good Worker version, then verify that review routes and media are inaccessible. Leave the additive tables and private objects in place for reconciliation. Record and investigate R2 deletion failures or unused keys from indeterminate D1 outcomes by comparing the review bucket's UUIDs with D1. Keep referenced approved and pending images, and separately authorize any pruning or data restoration. Preserve the existing menu and Welcome photo keys and objects.

## Photos and Reviews · Restricted production release

November 22, 2026. This release enables the staff preview on the existing HTTPS production origin. The feature uses the existing signed staff session for the gallery, review API, moderation, image delivery and menu preview. It returns a non-public response when the mode is unset, the host is incorrect or the session is invalid. Review responses carry `no-store` for browsers and CDNs. The gallery is excluded from the sitemap and includes a noindex directive. No anonymous photo upload, new public route mapping or footer link is part of this release.

### Authorized release plan

1. Confirm the release is based on `8070438d3a5bb3290fb80fc74cb16d608bc97da7` or recheck the release against any newer `main` tip. The previous site Worker version is `e864e6c1-3ef7-4820-8273-582188c51951`. Record the active Facebook Worker version for comparison.
2. Retain the ACL-restricted D1 export and verified restore. The preflight export contained 977,544 bytes with SHA-256 `81d7210d435b303ebac6650898709d4993a047efe4381286745e42d94b3d8c2e`. It restored 23 tables in local Workerd with no foreign-key violations or row-count mismatches. The migration rehearsal on that snapshot preserved all 115 existing menu-photo rows.
3. Create `grayzn-review-photos` with default private access. Check that `r2.dev` is off and no custom domains are attached. The new `REVIEW_PHOTOS` binding isolates it from `PHOTOS`. The site Worker uses the `REVIEW_IMAGES` binding to render still WebP files directly from bytes in private storage. The preview needs no image-delivery domain or publicly accessible source. [Private R2 buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) · [Images binding](https://developers.cloudflare.com/images/optimization/binding/)
4. Recheck that `0029_review_photos.sql` is the sole pending migration. Run `npx wrangler d1 migrations apply grayzn-db --remote` and verify the receipt, two tables, three indexes and two triggers. The migration is additive.
5. Merge the gated change into `main` after the application, security, Astro and build checks pass. Let the existing **Deploy site Worker** workflow deploy the site. It runs its own application and Facebook regressions.
6. Verify the deployed version and inspect signed-out responses before uploading test files. Use the existing staff sign-in and Turnstile. Identify any test submissions as private tests. Remove test menu associations before leaving the site for owner review. Reject or withdraw surplus test photos through moderation. Confirm the affected image URLs return 404 and retain only clearly labeled samples useful to the owner.

If the site or access controls regress, restore Worker version `e864e6c1-3ef7-4820-8273-582188c51951` and verify public pages and closed review routes. Preserve the additive tables and private bucket for audit and reconciliation. Before public launch, obtain separate approval for the anonymous access and upload controls, public indexing and the footer. Verify real-host Turnstile, abuse protection, image revocation, retention policy, review links and assistive technology. Then run the final public-site audit.


### Live verification for restricted Photos and Reviews

The site Worker `grayzn-buffalo` is serving version `ee689404-b8a0-43e5-9029-eee6bd8ea14d` at 100% from 3:27 p.m. Central on November 22, 2026. The deployed merge commit is `df0ea1a2187b74d0dd08959498c5d1363630aa07`. GitHub Actions passed Astro check, build, 500 application tests, 1,835 mocked Facebook tests and the names-only secret preflight. The workflow deployed the site Worker. Wrangler confirmed `grayzn-fb-feed` remained on `260c8ad8-b4a2-4cc4-b28a-12954b543e53`. [PR #6](https://github.com/joshua-werlein/grayzn-buffalo/pull/6) · [Deployment workflow](https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/45070923816)

- The private R2 bucket was created and Cloudflare confirmed `r2.dev` access is off and no custom domains are attached. The deployment includes `REVIEW_PHOTOS`, `REVIEW_IMAGES` and `REVIEWS_PREVIEW=staff-production`. The legacy `PHOTOS` binding serves the existing menu and Welcome images.
- D1 recorded `0029_review_photos.sql` as applied. Both review tables, all three indexes and both triggers were verified. The verified preflight export and restore remain in the private local backup directory `grayzn-backups/reviews-preflight-20261122T210631Z`. Big Pretzel retained its existing `items.photo_key`.
- Signed-out GET and HEAD for `/reviews` and POSTs to both review write APIs returned 404 with `no-store`. Anonymous moderation redirected to staff sign-in. Home, Menu, Specials, Contact, the existing menu image and the Facebook feed returned 200. Public navigation and the served sitemap omit Reviews. The existing footer appeared with Contact Us and no Reviews sign.
- The existing admin session opened the [private production preview](https://grayznbuffalo.com/admin?next=/admin/reviews). The signed-in gallery and upload form rendered, and the Turnstile widget issued a token. The narrow browser pane had no horizontal scroll. Local browser coverage from the earlier implementation includes 320, 390, 768 and 1280 pixels with loaded review photos.
- The original black-looking fixtures were decorative frame assets. Their WebP alpha channels averaged 82–89 out of 255, leaving transparent areas against the preview background. The replacement JPEG, PNG and WebP test inputs are real photographs from the site's existing images. The live browser stalled at the OS file picker before submission, so Cloudflare photo processing, EXIF-only rotation, moderation, menu association, approved-photo denial and revocation still need their live pass. The production review tables contained zero submissions and zero menu associations at the handoff.

### Finish the private production acceptance test

In the existing staff browser session, use the prepared `pretzel-exif.jpg`, `alternate-food.png` and `welcome.webp` from the feature worktree's `.wrangler/reviews-production-fixtures` directory. Label the files `PRIVATE TEST 1122 - Big Pretzel`, `PRIVATE TEST 1122 - Philly Cheese` and `PRIVATE TEST 1122 - Bar exterior`. Submit, check that pending thumbnails work only in moderation, approve the Food example, recategorize the exterior, and reject the remaining sample. With an authenticated and an anonymous browser, compare the same image URLs and the menu item. Remove the temporary Big Pretzel association, confirm the gallery photo still works, then reassign it and withdraw approval. Verify revocation, confirm the original staff image returns, clear any remaining test associations and withdraw any leftover sample after owner review. Use these images to check the populated layout on phone, tablet and desktop. Keep review originals in the private bucket, and identify any rows and object keys left by a failed cleanup using the test labels.

### Public launch remains a separate decision

After the owner accepts the live private preview, authorize public access and the footer separately. Implement and test anonymous read access to approved photos and a customer upload route with hostname-bound Turnstile, abuse controls and no staff cookie dependency. Keep the moderation paths and original objects private. Confirm storage retention and cleanup, recheck Google links and accessible image descriptions, verify cache and revocation behavior, and run the signed-in and signed-out smoke checks. After approval, add the sitemap and footer entry and run the final public-site audit.

## Seven-item backlog

| # | Priority | Task | Current status | Exact next action |
| --- | --- | --- | --- | --- |
| 1 | High | Admin session invalidation | Deployed and verified for public and anonymous routes. | An authorized live check can cover Turnstile login, a protected page, logout and genuine legacy-cookie rejection. |
| 2 | High | Cloudflare security configuration audit | Completed within verified scope. Account phases and crawler verification remain open. | Request read-only account WAF evidence and use Search Console if the owner wants to close those gaps. Obtain separate approval for a particular configuration change. |
| 3 | Medium | Complete R2 backup inventory | Complete at the November 22 cut-off. | Keep the archive pair and local key available for recovery, then agree an owner and cadence for later snapshots. |
| 4 | Medium | Refresh emergency fallback menu | Deployed and verified November 22. | Refresh the snapshot again after material menu edits using the read-only recovery procedure. |
| 5 | Feature | Photos and Reviews | Deployed with verified staff-only access. The live photo lifecycle test is pending. | Select the prepared photos in the staff upload form and finish the production acceptance checks. Obtain separate approval before anonymous access or footer placement. |
| 6 | Release validation | Final performance, accessibility, mobile and SEO audit | Waiting on task 5. | Audit the finished public pages for Lighthouse and Core Web Vitals, mobile layout, keyboard and screen-reader navigation, imaging, metadata, sitemaps, structured data and indexing. Run the site regression suite. |
| 7 | Medium | Facebook alert snapshot optimization | Deployed and verified. Responsive footer artwork also deployed and verified. | Observe production D1 metrics over a representative window. Follow up on `recovery-d1.test.js` if the Miniflare failure recurs. |

## Resume in a new ChatGPT conversation

1. Open `C:\Users\Jwerl\dev\Grayzn Buffalo` in Codex and read `C:\Users\Jwerl\dev\AGENTS.md`. Check `git status --short --branch`, `git worktree list --porcelain`, `git ls-remote origin refs/heads/main` and active chats before editing. Read this handoff with `git show codex/r2-backup-menu-baseline:docs/PROJECT_STATUS.md` if the feature branch is not checked out.
2. For Task 5, use the signed-in production Photos and Reviews link above. After the approved public release, run the final performance, accessibility, mobile and SEO audit in Task 6.
3. Use the Task 3 archive pair and manifest for recovery. Keep recovery rehearsals isolated. Coordinate cross-project updates with the owner of `C:\Users\Jwerl\dev\.archives\development-audits\DEFERRED_TASKS.md`.

For documentation-only handoffs, the repository has used `[skip ci]` on the commit pushed to `main`. GitHub lists no Actions runs for the previous November 21 documentation-only commit `2691524c65d6642bf1e19b4d23cf5ab4fa59d1a7`. At this handoff the only workflow file on `main` was the `push`-triggered site deployment. Verify the staged paths and current workflow before using the same procedure. [GitHub workflow skip instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)
