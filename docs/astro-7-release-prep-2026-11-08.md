# Astro 7 Worker release preparation — November 8, 2026

Follow-up to `astro-7-readiness-2026-11-08.md`. Nothing in this document has been executed against production. No Worker upload, route, secret, token, DNS, D1/KV/R2 or billing change was made.

Revised for Cloudflare's updated Workers permissions model: creating a new Worker requires Workers product-level **Admin**, so the owner creates the unrouted Worker with their own administrator access. CI afterwards uses an **Editor-level** token that can only update it.

## Gate status

| Gate | Status |
|---|---|
| Capacity | **Cleared by owner:** Workers Paid reported Active (approved by Jeff, enabled November 8). Not independently re-read from Billing (browser unavailable). Confirm in Billing → Subscriptions at step 1. |
| Code/tests | Sol's commit `914d5f6` on `dd10dc2`, plus this pass's changes; re-verified (see "Verification"). |
| Bindings | DB `c998bfd4-…`, SESSIONS `3c315599…`, PHOTOS `grayzn-photos` are identical to the Pages config on main. Pages reads bindings from main's `wrangler.toml`, so there are no dashboard-only bindings. |
| Plain vars | `CF_ANALYTICS_ACCOUNT_ID` and `CF_ANALYTICS_SITE_TAG` are in `wrangler.toml` and go out with every deploy. |
| Worker creation | **Owner action** with Workers Admin (step 3). `grayzn-buffalo` does not exist yet. |
| CI token | **Owner action:** Editor-level token (below). |
| Secrets | **Owner action:** six secrets entered on the Worker (below). |
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

Create a new token: My Profile → API Tokens → Create Token → Custom token.

- Name: `Grayzn Site Worker Deploy`
- Permission: Account → **Workers Scripts → Edit** (the Editor-level Workers permission; it can update existing Workers and deploy versions but cannot create Workers). If the dashboard offers the product role by name, choose Workers **Editor**, not Admin.
- Account resources: Include → *Grayznbar@outlook.com's Account* (`a79e3b4a…`) only.
- No zone, route, DNS, Pages, D1, KV or R2 permissions. Routes are dashboard-managed and bindings are attached by ID.
- If the first CI deploy fails on `/memberships` or `/user`, add only **User → User Details → Read** and **User → Memberships → Read**. If it fails because Editor can't create the Worker, the Worker doesn't exist yet: go back to "Worker creation". Never upgrade the CI token to Admin.

Paste the value once, straight into GitHub: Settings → Secrets and variables → Actions → `CLOUDFLARE_WORKERS_DEPLOY_TOKEN`. Not in chat, a terminal, a file or a commit. `CLOUDFLARE_ACCOUNT_ID` is reused.

A CI failure is safe. The Worker is uploaded before the subdomain call, and the subdomain settings are already off, so a partial failure can't expose the Worker or touch routes.

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

Enter them after Worker creation: Dashboard → `grayzn-buffalo` → Settings → Variables and Secrets → Add → Type **Secret** → save/deploy, one per name. Verify names only with `npx wrangler secret list --name grayzn-buffalo`. Never put values on a command line or in environment variables. Later deploys keep dashboard secrets; only `[vars]` are replaced by config.

## Production deployment steps (requires separate authorization)

1. **Drift check.**
   - `git ls-remote origin refs/heads/main` is still `dd10dc2`.
   - Pages production is still `d5cfa3ed…`.
   - `npx wrangler deployments list --name grayzn-fb-feed` is still `eb32d3f0…` at 100%.
   - Both Facebook routes are present: feed `14bd0888…`, webhook `2d440848…`.
   - Workers Paid is confirmed in Billing.

   Stop on any difference.
2. **Review and commit** the migration branch locally (owner). Gather the six secret values.
3. **Create the unrouted Worker** with Workers Admin ("Worker creation" above).
4. **Enter the six secrets** and verify the names.
5. **Create the Editor CI token** and add `CLOUDFLARE_WORKERS_DEPLOY_TOKEN` to GitHub.
6. **Prove CI while still unrouted.** Fast-forward main to the reviewed commit and push.
   - CI runs Astro check, build, both regression suites (including the deploy-config test), then `wrangler deploy` with the Editor token.
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
4. CI can't recreate the route, because config has no routes and the test enforces it. Later pushes only update the unrouted Worker. To make main deploy Pages again, revert the migration merge.

## Changes in this pass

- `.github/workflows/deploy.yaml`: Editor-level `CLOUDFLARE_WORKERS_DEPLOY_TOKEN` instead of the Pages token, plus a non-cancelling concurrency group.
- `wrangler.toml`: explicit `workers_dev = false` and `preview_urls = false` kept, with a comment forbidding config-managed routes.
- `tests/worker-deploy-config.test.mjs`: new test covering subdomain flags, no routes or custom domains, identical D1/KV/R2 identities, client-only assets, Facebook route precedence and the rollback model.

## Verification

See the final report for this pass: Astro check, build, full application suite (now including the deploy-config test) and Facebook Worker suite. `wrangler deploy --dry-run` wasn't re-run in this pass; run it at step 3.

## For independent review (Sol)

- That Workers Scripts Edit corresponds to Editor under the updated model and is enough for `wrangler deploy` updates, including the `/subdomain` POST, without a membership lookup.
- The Wrangler 4.158.0 route and subdomain analysis above.
- The zone-injected analytics beacon on Worker-rendered HTML after cutover.
- This pass's workflow, config and test diffs.
