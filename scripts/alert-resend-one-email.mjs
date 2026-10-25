// PREPARED ONLY: running `send` requires separate authorization for exactly one
// real alert email. Operator-host harness for the Resend delivery test. It never
// touches production D1, the importer, Graph, queues, routes or cron. A local
// disposable SQLite guard allows one attempt: armed -> uncertain BEFORE the
// request. It is never reset or rearmed; any ambiguous outcome stays uncertain.
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resendConfig,sendResendEmail} from '../workers/fb-feed/alert-resend.js';
import {ALERT_CODES} from '../workers/fb-feed/alert-store.js';

export const ARM_WINDOW_MS = 15 * 60 * 1000;
export const CONFIRMATION = 'send exactly one test alert from alerts@grayznbuffalo.com to the approved recipient';
const RUN_ID = /^test-[a-z0-9-]{1,48}$/;
const chicagoDay = now => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));

// Fixed, reviewable test content. No business data or provider output.
export function testMessage(day) {
  return {subject:`[TEST] Grayz'n Buffalo automation needs review — ${day}`,
    text:`TEST ONLY - no action needed. One-time delivery test of Facebook failure alerts.\n${ALERT_CODES.automation_failed}\nChicago date: ${day}\nReview: https://grayznbuffalo.com/admin`};
}

export function arm(guardPath, {runId, now = Date.now(), expiresInMs = ARM_WINDOW_MS} = {}) {
  if(typeof runId!=='string' || !RUN_ID.test(runId)) throw Error('Run id must match test-[a-z0-9-]');
  if(!Number.isSafeInteger(expiresInMs) || expiresInMs<1 || expiresInMs>ARM_WINDOW_MS) throw Error('Arming window must be at most 15 minutes');
  if(existsSync(guardPath)) throw Error('Guard already exists; it is never rearmed');
  const db=new DatabaseSync(guardPath);
  try {
    // No IF NOT EXISTS: a concurrent or repeated arm fails here as well.
    db.exec(`CREATE TABLE email_test_once (id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('armed','uncertain','accepted')), expires_ms INTEGER NOT NULL,
      attempted_ms INTEGER, provider_message_id TEXT)`);
    db.prepare("INSERT INTO email_test_once VALUES(1,?,'armed',?,NULL,NULL)").run(runId,now+expiresInMs);
  } finally {db.close();}
}

export function status(guardPath) {
  if(!existsSync(guardPath)) return {state:'no-guard'};
  const db=new DatabaseSync(guardPath,{readOnly:true});
  try {return db.prepare('SELECT run_id,state,expires_ms,attempted_ms,provider_message_id FROM email_test_once WHERE id=1').get() ?? {state:'no-guard'};}
  finally {db.close();}
}

// fetch/recipientSha256 are test seams; the CLI uses neither.
export async function sendOnce(guardPath, env, {confirm, fetch, recipientSha256, now = Date.now(), timeoutMs = 5000} = {}) {
  if(confirm!==CONFIRMATION) return {state:'not-confirmed'};
  if(!existsSync(guardPath)) return {state:'no-guard'};
  const db=new DatabaseSync(guardPath);
  try {
    const guard=db.prepare("SELECT run_id FROM email_test_once WHERE id=1").get();
    if(!guard) return {state:'no-guard'};
    // The persisted run id is the idempotency namespace, distinct from production.
    const config=await resendConfig(env,{namespace:guard.run_id,recipientSha256});
    if(!config) return {state:'unconfigured'};
    const claim=db.prepare("UPDATE email_test_once SET state='uncertain',attempted_ms=?1 WHERE id=1 AND state='armed' AND expires_ms>?1 RETURNING id").get(now);
    if(!claim) return {state:'already-used-or-expired'};
    const day=chicagoDay(now);
    try {
      const {id}=await sendResendEmail(config,{incidentKey:`${day}:resend_test:automation_failed`,
        ...testMessage(day),signal:AbortSignal.timeout(timeoutMs)},fetch);
      db.prepare("UPDATE email_test_once SET state='accepted',provider_message_id=?1 WHERE id=1 AND state='uncertain'").run(id);
      return {state:'accepted',id};
    } catch {return {state:'uncertain'};}
  } finally {db.close();}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [command,guardPath,runId]=process.argv.slice(2);
  const env={ALERT_RESEND_API_KEY:process.env.ALERT_RESEND_API_KEY,SPECIALS_ALERT_FROM:process.env.SPECIALS_ALERT_FROM,SPECIALS_ALERT_TO:process.env.SPECIALS_ALERT_TO};
  const run=async()=>{
    if(!guardPath) throw Error('Usage: arm <guard.sqlite> <test-run-id> | send <guard.sqlite> | status <guard.sqlite>');
    if(command==='arm') {arm(guardPath,{runId});return status(guardPath);}
    if(command==='status') return status(guardPath);
    if(command==='send') return sendOnce(guardPath,env,{confirm:process.env.ALERT_TEST_CONFIRM});
    throw Error('Unknown command');
  };
  // Prints only guard state and the provider id; never the key or any response.
  run().then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.message);process.exitCode=1;});
}
