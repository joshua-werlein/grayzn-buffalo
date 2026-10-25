import {deliveryAlertObservation,dailyPublicationObservation} from './alert-policy.js';
import {recordAlertObservation} from './alert-store.js';
import {deliveryWindow} from '../../src/lib/delivery.js';

// OBSERVE records incidents only. No production sender is imported or invoked.
// Raw evidence is used transiently in bound SQL snapshot comparisons, never
// stored in incident messages or logged. Failure cannot abort food publication.
export async function observeDeliveryOutcome(env, outcome) {
  if (env.SPECIALS_ALERT_MODE!=='OBSERVE' || !outcome?.snapshot) return;
  try {
    const window=deliveryWindow(new Date(Date.now()));
    if (!window.open || window.day!==outcome.day) return;
    const manual=(await env.DB.prepare("SELECT value FROM settings WHERE key='delivery_display'").first())?.value ?? 'auto';
    const observation=manual==='auto'?deliveryAlertObservation(outcome):{state:'suppressed'};
    // A rejected snapshot is not a fresh success or failure, even under override.
    if (outcome.status==='superseded' || observation.state==='unknown') return;
    await recordAlertObservation(env.DB,{day:outcome.day,scope:'delivery',code:'delivery_failed',
      state:observation.state,observedAt:Date.parse(outcome.observedAt)},
    {deliveryGuard:{...outcome.snapshot,manual,observedAt:outcome.observedAt,expectedActive:outcome.expectedActive}});
  } catch {
    console.error('Delivery alert observation unavailable');
  }
}

export async function observeDailyOutcome(env, outcome, {day,observedAt}) {
  if (env.SPECIALS_ALERT_MODE!=='OBSERVE' || !outcome?.alertSnapshot) return;
  try {
    if (deliveryWindow(new Date(Date.now())).day!==day) return;
    const observation=dailyPublicationObservation(outcome);
    if(observation.state==='unknown') return;
    await recordAlertObservation(env.DB,{day,scope:'daily',code:'publication_blocked',
      state:observation.state,observedAt:Date.parse(observedAt)},
    {publicationGuard:outcome.alertSnapshot});
  } catch {
    console.error('Daily alert observation unavailable');
  }
}
