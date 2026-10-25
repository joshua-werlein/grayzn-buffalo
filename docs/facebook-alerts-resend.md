# Facebook failure alerts: Resend transport

Status (October 25, 2026): implemented and verified locally only. Production
alerts remain OFF, no key or secret exists, no real email has been sent, and
migrations 0023/0024 remain unapplied. Every step under "Next phase" needs its
own explicit approval. Background and account evidence: the private alerts11
evaluation; the general rollout gates in `facebook-alerts-production-readiness.md`
still apply.

## Design

- `workers/fb-feed/alert-resend.js` POSTs to the fixed `https://api.resend.com/emails`
  endpoint with `fetch` (no SDK). `alert-email.js#alertTransport` selects it only
  when `SPECIALS_ALERT_PROVIDER` is exactly `RESEND`. An absent provider keeps the
  native `ALERT_EMAIL` binding; any other value fails closed. A selected provider
  never falls back to the other one.
- Selection, including recipient validation, happens before an incident is
  claimed, so misconfiguration returns `unconfigured` and never quarantines
  an incident.
- The existing gates are unchanged: EMAIL mode, `SPECIALS_ALERT_EMAIL_APPROVED=true`,
  GUARDED_AUTO, proof/evidence revalidation, staff-edit fencing, grace period,
  lease, and the durable `uncertain` marker written before the request.
- Sender must be exactly `alerts@grayznbuffalo.com`. The recipient must match a
  SHA-256 digest of the single approved address. The repository is public, so
  the address itself is configured privately and never committed.
- `ALERT_RESEND_API_KEY` must look like a Resend key (`re_…`) and is sent only
  in the `Authorization` header. Nothing in the adapter logs. Errors carry fixed
  text plus at most the HTTP status number.
- `Idempotency-Key` is `grayzn-fb-alert-v1-` + SHA-256 of a fixed version, the
  namespace (`production`, or a persisted `test-*` run id) and the durable
  incident key. It stays stable for each incident and is 83 characters long
  (Resend's limit is 256).
- A request is accepted only when the HTTP status is 2xx and the body has a
  UUID `id`. Redirects (`redirect:'manual'`; workerd rejects `'error'`), any
  4xx/5xx including 409/429, malformed JSON, a missing ID, a network error
  or a timeout all reject. The store then keeps the incident `uncertain`
  with `last_error='send_failed'`. There are no automatic retries, no new
  keys and no fallback. The store's ≤5 s signal is combined with a 5 s
  adapter cap.

## Configuration (future, not applied)

Merge into the then-current `workers/fb-feed/wrangler.toml` `[vars]` only with
deployment approval (the special-events branch also edits this file):

```toml
SPECIALS_ALERT_PROVIDER = "RESEND"
SPECIALS_ALERT_MODE = "OFF"
SPECIALS_ALERT_EMAIL_APPROVED = "false"
SPECIALS_ALERT_FROM = "alerts@grayznbuffalo.com"
```

Install as Worker secrets, never in TOML or chat: `ALERT_RESEND_API_KEY` and
`SPECIALS_ALERT_TO` (the approved recipient). Code reads secrets and vars the
same way. Leave the Pages `RESEND_API_KEY` and contact form untouched.

## Next phase — PREPARED, NOT EXECUTED

Run from `C:\Users\Jwerl\dev\gb-alerts-resend` with a Node version satisfying
`package.json` engines. Each numbered step needs separate approval.

1. **Dedicated key.** In the Resend dashboard (team grayznbar), go to API Keys and
   create one named `grayzn-fb-alerts`, with **Sending access** and the domain
   restricted to `grayznbuffalo.com`. Copy it straight into step 2 or 3. Do not
   save it to disk or paste it into chat.
2. **Worker secrets.** `wrangler secret put` immediately deploys a new version of
   the *currently live* code with the secret attached. Today's code ignores both
   names, so this is harmless, but record the new version id as the rollback
   baseline. Values are typed at the hidden prompt:
   ```powershell
   npx wrangler secret put ALERT_RESEND_API_KEY --config workers/fb-feed/wrangler.toml
   npx wrangler secret put SPECIALS_ALERT_TO --config workers/fb-feed/wrangler.toml
   npx wrangler secret list --config workers/fb-feed/wrangler.toml
   ```
3. **One isolated real email.** Use the operator-host harness `scripts/alert-resend-one-email.mjs`.
   It does not touch production D1, the Worker, or Cloudflare. A local
   disposable guard allows one attempt within 15 minutes, uses the test
   idempotency namespace, and is never rearmed:
   ```powershell
   $guard = Join-Path $env:LOCALAPPDATA 'grayzn-alert-test\resend-once-20261025.sqlite'
   New-Item -ItemType Directory -Force (Split-Path $guard) | Out-Null
   $env:ALERT_RESEND_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Resend key' -AsSecureString)).Password
   $env:SPECIALS_ALERT_FROM = 'alerts@grayznbuffalo.com'
   $env:SPECIALS_ALERT_TO = Read-Host 'Approved recipient'
   node scripts/alert-resend-one-email.mjs arm $guard test-20261025-one-email
   $env:ALERT_TEST_CONFIRM = 'send exactly one test alert from alerts@grayznbuffalo.com to the approved recipient'
   node scripts/alert-resend-one-email.mjs send $guard
   node scripts/alert-resend-one-email.mjs status $guard
   Remove-Item Env:ALERT_RESEND_API_KEY, Env:ALERT_TEST_CONFIRM, Env:SPECIALS_ALERT_TO
   ```
   `accepted` prints the Resend id. On `uncertain`, do not retry or recreate the
   guard; check the Resend dashboard for that idempotency key. Verify there is
   exactly one inbox message, the sender/recipient/content, and SPF/DKIM/DMARC
   pass in the received headers. Acceptance alone is not receipt.
4. **Migrations 0023 → 0024.** Follow readiness steps 2–3: a verified backup and
   rehearsal first, then `npx wrangler d1 migrations list grayzn-db --remote --config wrangler.toml`.
   Apply only if the pending list is exactly 0023 and 0024. If special events has
   merged, 0025 will also be pending and needs its own decision first.
5. **Deploy with alerts OFF.** Start from reviewed, merged main. Merge the
   `[vars]` above with MODE `OFF`, then:
   ```powershell
   npx wrangler deploy --dry-run --outdir $env:TEMP\gb-alerts-dryrun --config workers/fb-feed/wrangler.toml
   npx wrangler deploy --config workers/fb-feed/wrangler.toml
   ```
6. **OBSERVE.** Redeploy with `SPECIALS_ALERT_MODE = "OBSERVE"` and approval
   `false`. Validate per readiness step 5. OBSERVE never constructs a
   transport.
7. **Independent monitoring.** Use `.wrangler/alerts10/monitor-health.sql` /
   `readAlertHealth` outside this Worker. Alert on missing completed
   evaluations, `uncertain_sends > 0`, `send_failures > 0` and queue/DLQ
   problems. Include Resend 429 quota exhaustion (100/day and 3,000/month,
   shared with the contact form), which shows up as uncertain sends.
8. **EMAIL activation.** Set `SPECIALS_ALERT_MODE = "EMAIL"` and
   `SPECIALS_ALERT_EMAIL_APPROVED = "true"` with the provider/sender/secrets
   above. To roll back, redeploy with MODE `OFF`. Never reset `uncertain`
   incidents to force a resend.
