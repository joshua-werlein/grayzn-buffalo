// Cloudflare bindings (DB, SESSIONS, PHOTOS) and vars for the current request.
//
// @astrojs/cloudflare 13+ removed Astro.locals.runtime.env (reading it throws).
// src/middleware.ts copies the Worker env from `cloudflare:workers` onto
// locals.cfEnv before any page or endpoint runs. Tests render compiled pages
// without middleware and inject their own env as locals.runtime.env.
export function runtimeEnv(locals: any): any {
  return locals?.cfEnv ?? locals?.runtime?.env ?? {};
}
