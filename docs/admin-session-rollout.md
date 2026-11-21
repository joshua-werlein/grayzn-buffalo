# Staff session rollout and password rotation

The site Worker authenticates `gb_session` against a 24-hour Workers KV record. The record contains a versioned HMAC-SHA-256 signature over the session token and `ADMIN_PASSWORD`, keyed with the separate `ADMIN_SESSION_KEY` Worker secret. A KV snapshot alone cannot verify password guesses. Existing signed sessions survive code deployments with the same password and key. Requests use one KV read for a syntactically valid cookie and write only when issuing or revoking a session.

## First deployment

1. Get owner approval for the secret setup and production release. Record the current Worker version before any change. Plan for one staff sign-in after the release and ask staff to save any open edits beforehand.
2. Add `ADMIN_SESSION_KEY` to the `grayzn-buffalo` Worker as an encrypted secret. Generate 32 random bytes and encode them as 64 lowercase hexadecimal characters. Use a test-only key with the same format for local development. Keep the production key stable across deployments and store it in the owner’s secret manager. Keep `ADMIN_PASSWORD` as-is for this rollout.
3. Adding a secret can itself create and deploy a Worker version. Verify the version and the secret's presence after provisioning. Verify the key format when entering it because the CI preflight checks names only. The merge to `main` triggers the application deployment. Confirm the approved application version serves 100% of traffic.
4. With staff authorization, check that a pre-release cookie returns to sign-in, that signing in restores protected page access and that signing out clears the session. The old `1` records expire in place. A missing or invalid key denies staff sessions and sign-in.

## Later password rotations

Update only `ADMIN_PASSWORD` for a routine rotation. A request handled by the updated Worker rejects a signature made with the old password even if KV still returns the cached record. A Worker still serving an earlier version with the old secret or an in-flight request can briefly use the old credential. Avoid splitting production traffic between old- and new-password versions. Confirm the intended version serves 100% of traffic before treating the rotation as complete. Use a fresh password so older signed sessions cannot become valid again if a previous value is restored before expiration.

KV consistency still applies to newly created records and logout deletes. Another location can serve a cached value or cached miss for around 60 seconds or longer. [Worker versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/) · [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

## Recovery

If staff sign-in fails, check that the active Worker has the correctly formatted secret and that Turnstile and KV are available. Prefer a forward fix or redeploy known-good code with the current password, signing key and session validation intact. Restart staff sessions only if required by the incident.

If an emergency requires reverting to the pre-release Worker, get owner approval and restrict staff routes before restoring it. Old code accepts unexpired legacy records and rejects the new signed records. Restoring a version from before a password rotation can also restore its password binding. Verify the active version and public pages after rollback, keep staff routes restricted until session validation is restored, and have staff sign in again. Worker version rollback leaves KV data in place. [Cloudflare Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
