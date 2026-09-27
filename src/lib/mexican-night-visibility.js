const chicagoDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function chicagoCalendarDate(date) {
  const parts = Object.fromEntries(
    chicagoDateFmt.formatToParts(date)
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function sundayOf(dateStr) {
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - dow);
  return date.toISOString().slice(0, 10);
}

/**
 * Returns true when the Mexican Night detail section should be visible.
 *
 * Visible window: Sunday through Wednesday 1:59 AM Chicago time, when
 * updatedAt falls within the same Sunday-to-Saturday calendar week as now.
 * Null/missing updatedAt always returns false (section never published).
 */
export function mexicanNightDetailVisible(updatedAt, now = new Date()) {
  if (!updatedAt) return false;
  let updatedDate;
  try { updatedDate = chicagoCalendarDate(new Date(updatedAt)); }
  catch { return false; }
  if (sundayOf(updatedDate) !== sundayOf(chicagoCalendarDate(now))) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const dayStr = parts.find(p => p.type === 'weekday')?.value ?? '';
  const hourStr = parts.find(p => p.type === 'hour')?.value ?? '0';
  const hour = parseInt(hourStr, 10) % 24;
  const day = ({Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6})[dayStr] ?? 0;
  return day <= 2 || (day === 3 && hour < 2);
}
