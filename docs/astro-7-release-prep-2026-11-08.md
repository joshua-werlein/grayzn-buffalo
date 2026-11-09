# Astro 7 Worker release preparation — November 8, 2026

Follow-up to `astro-7-readiness-2026-11-08.md`. Owner-executed so far: Workers Paid was enabled, the unrouted `grayzn-buffalo` Worker was created, its secrets were entered/reconciled, and the dedicated CI token was created. This independent review made no production deployment, route, DNS, storage, secret or billing changes. See `astro-7-independent-review-2026-11-08.md` for fresh evidence and remaining release gates.

Revised for Cloudflare's updated Workers permissions model: creating a new Worker requires Workers product-level **Admin**, so the owner creates the unrouted Worker with their own administrator access. CI afterwards uses an **Editor-level** token that can only update it.

## Gate status

| Gate | Status |
|---|---|
| Capacity | **Independently confirmed November 8 CST:** Billing → Subscriptions lists Workers Paid under Subscribed, renewing November 30. Recheck before release. |
| Code/tests | `914d5f6` → `f55003a` → `8758391` → `57c4ff6` (Claude safeguards) → `c44e546` (responsive grid) → `a8441c3` (contact regressions), followed by independent review documentation. All descend from `dd10dc2`. |
| Bindings | DB `c998bfd4-…`, SESSIONS `3c315599…`, PHOTOS `grayzn-photos` are identical to the Pages config on main. Pages reads bindings from main's `wrangler.toml`, so there are no dashboard-only bindings. |
| Plain vars | `CF_ANALYTICS_ACCOUNT_ID` and `CF_ANALYTICS_SITE_TAG` are in `wrangler.toml`. ✅ Duplicate secrets removed by owner. They are absent from live version `253ed164` until the first CI deploy re-adds them. |
| Worker creation | ✅ Done by owner. Unrouted; workers.dev and previews off (see "Live read-only state"). |
| CI token | `CLOUDFLARE_WORKERS_DEPLOY_TOKEN` is in GitHub (name verified). Dashboard independently shows account-owned Individual Workers → Editor on `grayzn-buffalo` only. GitHub secret name exists; its encrypted value cannot be compared with the dashboard token. Successful CI deployment still requires separate authorization. |
| Secrets | ✅ Exactly the six runtime secrets (names verified). The guard prints `Worker secrets OK`. |
| Routing | Unchanged. Generated deploy config: no routes, `workers_dev=false`, `preview_urls=false`. |

## Wrangler route and subdomain behaviour (verified in installed Wrangler 4.158.0)

- **No routes in config:** `triggersDeploy` partitions `config.routes`. When there are none, `publishRoutes` is never called and Wrangler makes no route API call, so the dashboard-managed `grayznbuffalo.com/*` route is left untouched by every CI deploy.
- **If routes are ever configured:** `publishRoutes` sends `PUT /accounts/…/workers/scripts/grayzn-buffalo/routes`, which *replaces* that Worker's whole route list and deletes the dashboard route if it isn't listed. The call is script-scoped, so it can't affect the Facebook Worker's routes. **The site route therefore stays dashboard-managed.** `wrangler.toml` documents this, and `tests/worker-deploy-config.test.mjs` fails if `routes`, `route` or custom domains appear in the source or generated config.
- **Subdomains:** every deploy POSTs `{ enabled: false, previews_enabled: false }` to the Worker's `/subdomain` endpoint, from explicit `workers_dev = false` and `preview_urls = false`. A workers.dev address or preview URL enabled by hand would be switched off again by the next deploy.

## Route precedence (verified)

Live Facebook patterns (from `workers/fb-feed/wrangler.toml`, unchanged): `grayznbuffalo.com/api/facebook-feed` (exact) and `grayznbuffalo.com/api/facebook-webhook*`. With Miniflare's Cloudflare route parser and matcher, alongside `grayznbuffalo.com/*`:

| Request | Selected Worker |
|---|---|
| `/`, `/menu`, `/specials`, `/admin/menu`, `/api/contact`, `/api/facebook-click` | `grayzn-buffalo` |
| `/api/facebook-feed`, `/api/facebook-webhook`, `/api/facebook-webhook?hub.mode=subscribe`, `/api/facebook-webhook/x` | `grayzn-fb-feed` |
| `/api/facebook-feed?x=1` | `grayzn-buffalo` (exact pattern excludes queries; production returns 404 for this today) |
| `www.grayznbuffalo.com/` | none (existing redirect rules) |
| Rollback, site route removed: `/menu` | none → Pages origin; `/api/facebook-feed` still `grayzn-fb-feed` |

Read-only production probe: `/api/facebook-feed` is 200 JSON and `/api/facebook-feed?x=1` is 404, matching the table. These checks are now a regression test.

## Worker creation (owner, Workers Admin)

Don't use dashboard "Create Worker". Its template uploads placeholder code and enables workers.dev and preview URLs by default. Create the Worker by uploading the reviewed build with your own administrator login, so it is never public:

```sh
# In .worktrees/astro7-security-nov8, at the reviewed, committed migration commit
git status --short                   # must be empty
npx wrangler login                   # sign in as the account administrator
npx wrangler whoami                  # confirm account a79e3b4a… is listed
npm ci && npm run build
npx wrangler deploy --dry-run        # bindings: DB, SESSIONS, PHOTOS, ASSETS, 2 vars; no routes
npx wrangler deploy                  # creates grayzn-buffalo, unrouted, workers.dev/previews off
```

Expected output: the upload and version ID, with no workers.dev URL, preview URL or route listed. Then check Dashboard → Workers & Pages → `grayzn-buffalo` → Settings → Domains & Routes: no routes and workers.dev disabled. Preview URLs are disabled too.

## CI deployment token (Editor level)

The existing `CLOUDFLARE_API_TOKEN` ("Grayzn Auto Deploy", Pages) stays as it is for main's Pages workflow and Pages rollback. Don't edit, roll or revoke it.

Permission model ([Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/), updated September 15, 2026):

- **Roles:** Metadata Read-Only, Content Read-Only, Editor and Admin.
- **Scopes:** the Workers product, or Individual Workers.
- **Deploying an existing Worker:** `Editor` for that Worker. The same role covers `versions upload`/`deploy`, `rollback`, and `secret put`/`delete`.
- **Creating a Worker:** product-level Admin, which is why the owner created it.
- **Bindings:** need no permission on the bound D1, KV or R2 resources.
- **Routes:** `Workers Routes Write` is needed only when a deploy adds, updates or removes a route or custom domain. Ours never does.
- **Token ownership:** granular roles require an **account-owned** API token. `wrangler login` OAuth does not support them.

Create the token as an **account-owned** token: Manage Account → Account API Tokens → Create Token → Custom token.

- Name: `Grayzn Site Worker Deploy`
- Account: *Grayznbar@outlook.com's Account* (`a79e3b4a…`) only.
- Permission: **Individual Workers → Editor**, resource `grayzn-buffalo` only. Not `grayzn-fb-feed`, and not the Workers product scope.
- No zone or Workers Routes, DNS, Pages, D1, KV or R2 permissions.
- Optional: client IP filtering and an expiry, per your policy.

If the first CI run fails on a read with authentication error 10000/401/403, the only reported remedy is adding **Workers Metadata Read-Only on the same `grayzn-buffalo` Worker**. That remedy comes from community reports and isn't documented by Cloudflare. Never widen the token to Workers-product Editor, Admin or Facebook Worker scope without a separate decision.

**Known issue, already fixed in the pinned Wrangler.** [workers-sdk #16390](https://github.com/cloudflare/workers-sdk/issues/16390) reported that Worker-scoped Editor deploys failed after secrets were edited in the dashboard. In that state (`last_deployed_from: dash`), Wrangler's pre-upload check read the Worker's routes and custom domains, which returned 403. It was closed by PR #16531 on November 2. Installed and locked Wrangler **4.158.0** (released November 5) fetches routes and custom domains only when the config declares them, and ours declares neither. The remaining reads (bindings, subdomain, service environment, schedules) were reported to return 200 with this role. `wrangler-action@v4` uses the project's installed Wrangler.

In CI, Wrangler doesn't stop at the dashboard-versus-local config diff: without `--strict`, it auto-confirms and overrides the remote config. That is why the workflow's names-only secret check runs first (see "Worker variable reconciliation").

Paste the value once, straight into GitHub: Settings → Secrets and variables → Actions → `CLOUDFLARE_WORKERS_DEPLOY_TOKEN`. Not in chat, a terminal, a file or a commit. `CLOUDFLARE_ACCOUNT_ID` is reused. `CLOUDFLARE_API_TOKEN` (Pages) is preserved.

A CI failure is safe. The secret check and the pre-upload checks fail before any upload, and the subdomain settings are already off.

## Worker variable reconciliation

✅ **Resolved November 8 CST (November 9 UTC):** the owner deleted the two duplicate secrets. Version `253ed164` has the six secrets and no plain vars, and the guard passes. The history below is kept for review.

State before the fix, from read-only `wrangler versions view` of `181b28cc` and `wrangler secret list`, names only:

- The Worker has **eight secrets and no plain-text vars**.
- Saving `CF_ANALYTICS_ACCOUNT_ID` and `CF_ANALYTICS_SITE_TAG` as dashboard secrets replaced the plain-text vars that the initial upload created from `wrangler.toml`.
- **Problem:** every `wrangler deploy` keeps existing secrets (`keep_bindings: secret_text`) and also uploads `[vars]` as plain-text bindings of the same two names. The API then either rejects the duplicate binding names, or one value silently shadows the other. Either way, the source of truth is ambiguous.
- **Smallest safe correction (owner action, needs authorization):** delete only the two secrets `CF_ANALYTICS_ACCOUNT_ID` and `CF_ANALYTICS_SITE_TAG` on `grayzn-buffalo`. Use Dashboard → Settings → Variables and Secrets → the entry's delete action, or `npx wrangler secret delete <NAME> --name grayzn-buffalo`.
  - These two are public identifiers already committed in `wrangler.toml`, so nothing is lost.
  - Don't touch the six runtime secrets.
  - Each deletion creates a new version without those two values. `/admin/analytics` would show "configuration" until the next deploy restores them as plain vars. The Worker is unrouted, so nothing public is affected.
- **Guard:** the workflow runs `npx wrangler secret list --name grayzn-buffalo | node scripts/check-worker-secrets.mjs` before deploying. It fails if any `[vars]` name is also a secret, if any of the six runtime secrets is missing, or if the output isn't the expected JSON. It reads names only. It failed on the historical duplicate state; the fresh independent check now passes after the owner removed those duplicates.
- **Do not** "fix" this by removing `[vars]` from `wrangler.toml`. That would move two public identifiers into untracked dashboard state.

## Secrets (names only)

Pages production has exactly six encrypted secrets: `ADMIN_PASSWORD`, `CF_ANALYTICS_API_TOKEN`, `CONTACT_TO_EMAIL`, `RESEND_API_KEY`, `TURNSTILE_SECRET`, `TURNSTILE_SITEKEY`. Their values can't be read back from Pages. Staff login (Turnstile and password) and the contact form fail closed without them, so **all six must be on the Worker before the route is added.**

| Secret | Source | Rule |
|---|---|---|
| `ADMIN_PASSWORD` | Owner's password manager / staff | Can be recreated. It is compared directly (no derived keys), and sessions are random KV tokens. If changed, tell staff before cutover. |
| `TURNSTILE_SITEKEY` | Cloudflare → Turnstile → grayznbuffalo.com widget | Retrieve the existing value (public). |
| `TURNSTILE_SECRET` | Same widget → Settings | Retrieve the existing value. **Do not rotate**: that breaks Pages and rollback. |
| `RESEND_API_KEY` | Password manager if saved; otherwise Resend → API Keys → Create | Shown only once. Create a new Sending-access key restricted to the sending domain. **Do not delete the old key.** |
| `CONTACT_TO_EMAIL` | Owner | Recreate: the destination inbox. |
| `CF_ANALYTICS_API_TOKEN` | Cloudflare → API Tokens → Create | Create a new token, **Account → Account Analytics → Read** on `a79e3b4a…`. **Do not "Roll"** the existing one. |

Enter them after Worker creation: Dashboard → `grayzn-buffalo` → Settings → Variables and Secrets → Add → Type **Secret** → save/deploy, one per name. Verify names only with `npx wrangler secret list --name grayzn-buffalo`. Never put values on a command line or in environment variables. Later deploys keep dashboard secrets; only `[vars]` are replaced by config. **Enter only these six as secrets.** `CF_ANALYTICS_ACCOUNT_ID` and `CF_ANALYTICS_SITE_TAG` are `[vars]` and must not also be secrets.

## Production deployment steps (requires separate authorization)

1. **Drift check.**
   - `git ls-remote origin refs/heads/main` is still `dd10dc2`.
   - Pages production is still `d5cfa3ed…`.
   - `npx wrangler deployments list --name grayzn-fb-feed` is still `eb32d3f0…` at 100%.
   - Both Facebook routes are present: feed `14bd0888…`, webhook `2d440848…`.
   - Workers Paid is confirmed in Billing.

   Stop on any difference.
2. ✅ **Reviewed and committed** (`f55003a`, plus the follow-up commit for this pass).
3. ✅ **Unrouted Worker created** by the owner (initial version `e9a7a733…`; `181b28cc…` after secret entry).
4. ✅ **Six secrets entered and duplicates deleted** ("Worker variable reconciliation"). Re-check before step 6: `npx wrangler secret list --name grayzn-buffalo | node scripts/check-worker-secrets.mjs` (after `npm run build`) must print `Worker secrets OK`.
5. ✅ **Create the Individual Workers Editor token** and add `CLOUDFLARE_WORKERS_DEPLOY_TOKEN` to GitHub. Verify presence with `gh secret list` (names only).
6. **Prove CI while still unrouted.** Fast-forward main to the reviewed commit and push.
   - CI runs Astro check, build, both regression suites (including the deploy-config and secret-check tests), the names-only secret check, then `wrangler deploy` with the Editor token.
   - Confirm the run succeeded, a new version is at 100% in `npx wrangler deployments list --name grayzn-buffalo`, and Domains & Routes is still empty.
   - From this push on, **main no longer deploys to Pages** (Pages stays on `dd10dc2`), so do steps 6–8 in one session.
7. **Cutover.** Worker → Settings → Domains & Routes → Add → **Route** (not Custom domain): zone `grayznbuffalo.com`, pattern `grayznbuffalo.com/*`. Record the route ID.
   - Leave untouched: Pages custom domain, DNS, www/gumbysbar redirects, and both Facebook routes.
   - The route lives only in the dashboard. Don't add it to `wrangler.toml`.
8. **Verify immediately:**
   - `/`, `/menu`, `/specials`, `/contact` return 200 with current content.
   - `/img/…` images load, and `/server/entry.mjs` returns 404.
   - Turnstile renders, staff sign-in succeeds, and `/admin/menu`, `/admin/specials`, `/admin/automation` load.
   - `/api/facebook-feed` is still served by `grayzn-fb-feed`.
   - The Web Analytics beacon is still on the custom domain (zone-injected), and `/admin/analytics` loads data.
   - Security and no-store headers are present.
   - No errors or CPU-limit exceptions in Worker metrics.

   Test the contact form or content edits only if separately scoped.

## Rollback

Trigger it on public or admin errors, auth, header or cache regressions, image failures, CPU-limit errors, or changed Facebook routing.

1. Worker `grayzn-buffalo` → Domains & Routes → remove **only** `grayznbuffalo.com/*`, confirming its recorded route ID. Never touch either Facebook route or any Worker, D1, KV or R2 resource.
2. Traffic falls back to Pages `d5cfa3ed…` / `dd10dc2`, which still has its own secrets and token. Confirm the public, admin and image pages and the Facebook feed.
3. Don't restore D1/KV/R2. Writes since cutover are shared and remain valid.
4. CI can't recreate the route, because config has no routes and the test enforces it. Later pushes only update the unrouted Worker. To make main deploy Pages again, prepare reviewed reversions of the migration-specific workflow/build configuration and dependency changes. The proposed release is a fast-forward, so there is no merge commit to revert. Preserve subsequent application fixes, including the responsive grid, and rerun the Pages build/tests before any separately authorized push.

## Changes

- `f55003a`:
  - `.github/workflows/deploy.yaml`: dedicated `CLOUDFLARE_WORKERS_DEPLOY_TOKEN` and a non-cancelling concurrency group.
  - `wrangler.toml`: comment forbidding config-managed routes.
  - `tests/worker-deploy-config.test.mjs`.
- Follow-up:
  - `scripts/check-worker-secrets.mjs` and `tests/check-worker-secrets.test.mjs`: names-only secret and vars guard.
  - The workflow step that runs the guard before deploying.
  - This runbook's token and variable sections.
- Final review:
  - `.github/workflows/deploy.yaml`: the 10 LF-only lines added in `914d5f6`/`f55003a` are normalized to CRLF, matching the rest of the file and main. The parsed YAML is unchanged. `git diff --check` reports CR-at-EOL on added lines only, and `-c core.whitespace=cr-at-eol` is clean.
  - The guard step sets `shell: bash` so `pipefail` applies, and a Wrangler/API error fails the step directly. It already failed closed, because the checker rejects empty or non-JSON input.

## Live read-only state (November 8 CST / November 9 UTC)

| Item | Value |
|---|---|
| `grayzn-buffalo` active version | `253ed164-ee6b-4aa1-bf0b-ef82f5dd5775`, 100% (after the two secret deletions) |
| Handlers | `fetch` only |
| Bindings | DB / SESSIONS / PHOTOS / ASSETS at the Pages resource IDs, plus the six `secret_text` secrets. No plain vars until the next deploy. |
| Subdomain | `enabled: false`, `previews_enabled: false` |
| Schedules | none |
| Custom domains | none |
| Zone routes | only `14bd0888…` → `grayzn-fb-feed` (feed) and `2d440848…` → `grayzn-fb-feed` (webhook) |
| Facebook Worker | `grayzn-fb-feed` still `eb32d3f0…`, 100% |
| Pages production | still `d5cfa3ed…` |

## For independent review (Sol)

- That an account-owned Individual Workers Editor token on `grayzn-buffalo` alone is enough for `wrangler deploy` and `wrangler secret list` with Wrangler 4.158.0, and whether Metadata Read-Only is needed for any read.
- The Wrangler 4.158.0 route and subdomain analysis above.
- The zone-injected analytics beacon on Worker-rendered HTML after an authorized cutover remains an edge verification gate; an unrouted Worker cannot prove it.
- This pass's workflow, config and test diffs.
