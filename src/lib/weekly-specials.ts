export const BUSINESS_TIME_ZONE = 'America/Chicago';

const chicagoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const chicagoWeekdayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: 'long',
});
const displayDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'long',
  day: 'numeric',
});

export function chicagoCalendarDate(value = new Date()): string {
  const parts = Object.fromEntries(
    chicagoDateFormatter
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function chicagoWeekday(value = new Date()): string {
  return chicagoWeekdayFormatter.format(value);
}

export function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function formatWeeklyDateRange(start: string, end: string): string {
  const startDate = new Date(`${start}T12:00:00Z`);
  const endDate = new Date(`${end}T12:00:00Z`);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) return '';
  if (start === end) return displayDateFormatter.format(startDate);
  const sameMonth = startDate.getUTCFullYear() === endDate.getUTCFullYear() && startDate.getUTCMonth() === endDate.getUTCMonth();
  return sameMonth
    ? `${displayDateFormatter.format(startDate)}–${endDate.getUTCDate()}`
    : `${displayDateFormatter.format(startDate)} – ${displayDateFormatter.format(endDate)}`;
}

export function hasPriceNotation(content: string): boolean {
  return /(?:[$€£]\s*\d|\b\d{1,3}[.,]\d{2}\b|\b\d+\s*(?:dollars?|bucks?)\b)/i.test(content);
}
