// Pre-deploy secret/vars guard (scripts/check-worker-secrets.mjs). Names only; no Cloudflare calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkWorkerSecrets, REQUIRED_SECRETS} from '../scripts/check-worker-secrets.mjs';

const vars = {CF_ANALYTICS_ACCOUNT_ID: 'a', CF_ANALYTICS_SITE_TAG: 'b'};
const list = names => names.map(name => ({name, type: 'secret_text'}));

test('the six runtime secrets with no [vars] overlap pass', () => {
  assert.deepEqual(checkWorkerSecrets(list(REQUIRED_SECRETS), vars), []);
});

test('analytics identifiers duplicated as secrets are rejected by name', () => {
  const problems = checkWorkerSecrets(list([...REQUIRED_SECRETS, 'CF_ANALYTICS_SITE_TAG', 'CF_ANALYTICS_ACCOUNT_ID']), vars);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^CF_ANALYTICS_ACCOUNT_ID is both/);
  assert.match(problems[1], /^CF_ANALYTICS_SITE_TAG is both/);
});

test('a missing required secret is rejected', () => {
  assert.deepEqual(checkWorkerSecrets(list(REQUIRED_SECRETS.filter(n => n !== 'TURNSTILE_SECRET')), vars),
    ['Required Worker secret TURNSTILE_SECRET is missing.']);
});

test('unexpected input fails closed', () => {
  for (const input of [null, {}, [{type: 'secret_text'}], 'text'])
    assert.equal(checkWorkerSecrets(input, vars).length, 1);
});

test('CLI exits non-zero on collisions and on non-JSON input (run npm run build first)', () => {
  const run = input => spawnSync(process.execPath, ['scripts/check-worker-secrets.mjs'], {input, encoding: 'utf8'});
  assert.equal(run(JSON.stringify(list(REQUIRED_SECRETS))).status, 0);
  const duplicated = run(JSON.stringify(list([...REQUIRED_SECRETS, 'CF_ANALYTICS_SITE_TAG'])));
  assert.equal(duplicated.status, 1);
  assert.match(duplicated.stderr, /CF_ANALYTICS_SITE_TAG is both/);
  assert.equal(run('⛅️ wrangler banner\nnot json').status, 1);
});
