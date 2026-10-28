// Shared by the worker and server rendering. Manual choices always win.
export const DELIVERY_HOURS = 'Delivery M–F 11 AM–1:30 PM';
export const DELIVERY_AREA = 'within Mondovi city limits.';
export const DELIVERY_TEXT = `${DELIVERY_HOURS}, ${DELIVERY_AREA}`;
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone:'America/Chicago', year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
});
// Automatic delivery notices end when delivery service ends (1:30 PM Chicago).
export const DELIVERY_CUTOFF = {hour:13, minute:30};
const CUTOFF_CLOCK = `${String(DELIVERY_CUTOFF.hour).padStart(2,'0')}:${String(DELIVERY_CUTOFF.minute).padStart(2,'0')}:00`;
export function deliveryWindow(now = new Date(Date.now())) {
  const parts = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type,p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  // Solve for the UTC instant whose Chicago wall time is the cutoff (DST-safe).
  const wall = Date.parse(`${day}T${CUTOFF_CLOCK}Z`);
  let expiry = wall;
  for (let i=0;i<3;i++) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(expiry)).map(p => [p.type,p.value]));
    expiry += wall - Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
  }
  const beforeCutoff = +parts.hour*60 + +parts.minute < DELIVERY_CUTOFF.hour*60 + DELIVERY_CUTOFF.minute;
  return {day,weekday,open:weekday>=1 && weekday<=5 && beforeCutoff,expiresAt:new Date(expiry).toISOString()};
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
