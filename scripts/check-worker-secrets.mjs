#!/usr/bin/env node
// Pre-deploy guard for the grayzn-buffalo site Worker. Reads names only, never values.
//
//   npx wrangler secret list --name grayzn-buffalo | node scripts/check-worker-secrets.mjs
//
// `wrangler deploy` keeps every existing secret and uploads [vars] as plain-text
// bindings. A [vars] name that is also a dashboard secret is a binding-name collision:
// the upload is rejected or one value silently shadows the other. Fails when that
// happens, when a required runtime secret is missing, or when the input is not the
// expected JSON list. Run after `npm run build` (reads dist/server/wrangler.json).
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const REQUIRED_SECRETS = ['ADMIN_PASSWORD', 'CF_ANALYTICS_API_TOKEN', 'CONTACT_TO_EMAIL',
  'RESEND_API_KEY', 'TURNSTILE_SECRET', 'TURNSTILE_SITEKEY'];

export function checkWorkerSecrets(secretList, vars) {
  if (!Array.isArray(secretList) || !secretList.every(s => typeof s?.name === 'string'))
    return ['Secret list is not the expected JSON array of {name, type}.'];
  const secrets = new Set(secretList.map(s => s.name));
  const problems = [];
  for (const name of Object.keys(vars ?? {}).filter(n => secrets.has(n)).sort())
    problems.push(`${name} is both a [vars] entry and a Worker secret; delete the duplicate secret.`);
  for (const name of REQUIRED_SECRETS.filter(n => !secrets.has(n)))
    problems.push(`Required Worker secret ${name} is missing.`);
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let list;
  try { list = JSON.parse(readFileSync(0, 'utf8')); } catch { list = null; }
  const {vars} = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
  const problems = checkWorkerSecrets(list, vars);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log(`Worker secrets OK: ${REQUIRED_SECRETS.length} required present, no [vars] collisions.`);
}
