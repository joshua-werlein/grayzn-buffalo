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
const boardDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});
const boardCompactDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'short',
  month: 'short',
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

export function mondayForIsoDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function standardWeekEndDate(monday: string): string {
  const date = new Date(`${monday}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 6);
  return date.toISOString().slice(0, 10);
}

export function calendarDatesFrom(start: string, count: number): string[] {
  const date = new Date(`${start}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || count < 1) return [];
  return Array.from({ length: count }, () => {
    const value = date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 1);
    return value;
  });
}

export function calendarDayOfWeek(value: string): number {
  return new Date(`${value}T12:00:00Z`).getUTCDay();
}

export function formatWeeklyBoardDate(value: string, compact = false): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries((compact ? boardCompactDateFormatter : boardDateFormatter)
    .formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${parts.weekday} · ${parts.month} ${parts.day}`;
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
