// Shared by the worker and server rendering. Manual choices always win.
export const DELIVERY_TEXT = 'Delivery M–F 11 AM–1:30 PM, within Mondovi city limits.';
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone:'America/Chicago', year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
});
export function deliveryWindow(now = new Date(Date.now())) {
  const parts = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type,p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  let expiry = Date.parse(`${day}T15:00:00Z`);
  for (let i=0;i<3;i++) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(expiry)).map(p => [p.type,p.value]));
    expiry += Date.parse(`${day}T15:00:00Z`) - Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
  }
  return {day,weekday,open:weekday>=1 && weekday<=5 && +parts.hour<15,expiresAt:new Date(expiry).toISOString()};
}
export function resolveDeliveryDisplay(manual, automatic, now = new Date(Date.now())) {
  if (['available','unavailable','hidden'].includes(manual)) return manual;
  if (manual !== 'auto') return 'hidden';
  const window = deliveryWindow(now);
  return window.open && automatic?.active===1 && automatic.day===window.day
    && automatic.expires_at===window.expiresAt ? 'available' : 'hidden';
}
export async function readAutomaticDelivery(env) {
  try { return await env.DB.prepare('SELECT * FROM delivery_automation WHERE id=1').first(); }
  catch { return null; } // Missing migration or database: no automatic announcement.
}
