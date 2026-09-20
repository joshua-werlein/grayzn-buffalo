import { chicagoCalendarDate, calendarDatesFrom, BUSINESS_TIME_ZONE } from './weekly-specials';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const HOUR = 3_600_000;
export const PUBLIC_HOSTS = ['grayznbuffalo.com', 'www.grayznbuffalo.com'];
const INTERNAL = ['/admin', '/api', '/img', '/_astro', '/cdn-cgi'];
export type AnalyticsStatus = 'ok' | 'configuration' | 'permission' | 'provider';
export const ANALYTICS_MESSAGES = {
  configuration: 'Website analytics is not configured yet.',
  permission: 'Website analytics access needs attention. Check the analytics token permissions.',
  provider: 'Website analytics is temporarily unavailable. Please try again later.',
};
type Row = { count?: number; sum?: { visits: number }; dimensions?: { datetimeHour?: string; requestPath?: string; refererHost?: string } };
type Limits = { enabled: boolean; maxDuration: number; maxPageSize: number; notOlderThan: number };
export type AnalyticsData = {
  recentVisits: number; historyVisits: number; historyStart: string; firstRecordedDay: string | null;
  daily: { date: string; visits: number }[];
  monthly: { month: string; visits: number; partial: boolean }[];
  pages: { path: string; views: number }[];
  sources: { name: string; visits: number }[];
};
class AnalyticsError extends Error {
  constructor(public status: Exclude<AnalyticsStatus, 'ok'>) { super(status); }
}

export function shiftDay(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

/** Chicago midnight in UTC, including the 23/25-hour DST days. */
export function chicagoMidnight(day: string): number {
  const target = Date.parse(`${day}T00:00:00Z`);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    guess += target - represented;
  }
  return guess;
}

export function reportingWindow(now = new Date()) {
  const today = chicagoCalendarDate(now);
  const start = shiftDay(today, -29);
  return { today, start, startMs: chicagoMidnight(start), endMs: now.getTime() };
}

export function isPublicPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && path !== '/menu.json' &&
    !INTERNAL.some(root => path === root || path.startsWith(root + '/'));
}

export function sourceGroup(value: string): 'Google' | 'Facebook' | 'Direct / Other' {
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com' || host.endsWith('.fb.com')) return 'Facebook';
  // Google country domains, with boundaries that reject google.com.example.org.
  if (/^(?:[a-z0-9-]+\.)*google\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(host)) return 'Google';
  return 'Direct / Other';
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AnalyticsError('provider');
  return value;
}
function rows(value: unknown, limit: number): Row[] {
  // Never silently present a result capped by the provider as a complete total.
  if (!Array.isArray(value) || value.length >= limit) throw new AnalyticsError('provider');
  return value;
}

export function publicFilter(siteTag: string, start: number, end: number) {
  return {
    siteTag, datetime_geq: new Date(start).toISOString(), datetime_lt: new Date(end).toISOString(),
    requestHost_in: PUBLIC_HOSTS, requestPath_notin: [...INTERNAL, '/menu.json'],
    AND: INTERNAL.map(root => ({ requestPath_notlike: `${root}/%` })),
  };
}

export function historyChunks(now: number, limits: Limits): [number, number][] {
  // Two minutes inside the moving retention boundary avoids aging out while requests run.
  const start = now - limits.notOlderThan * 1000 + 120_000;
  const span = Math.floor(Math.min(limits.maxDuration * 1000, (limits.maxPageSize - 2) * HOUR) / HOUR) * HOUR;
  if (span < HOUR || start >= now) throw new AnalyticsError('provider');
  const chunks: [number, number][] = [];
  for (let from = start; from < now;) {
    const end = from + span >= now ? now : Math.floor((from + span) / HOUR) * HOUR;
    chunks.push([from, end]);
    from = end;
    if (chunks.length > 12) throw new AnalyticsError('provider');
  }
  return chunks;
}

export async function loadAnalytics(env: Record<string, any>, now = new Date(), request: typeof fetch = fetch): Promise<
  { status: 'ok'; data: AnalyticsData } | { status: Exclude<AnalyticsStatus, 'ok'> }
> {
  const token = env.CF_ANALYTICS_API_TOKEN?.trim();
  const account = env.CF_ANALYTICS_ACCOUNT_ID?.trim();
  const site = env.CF_ANALYTICS_SITE_TAG?.trim();
  if (!token || !/^[a-f0-9]{32}$/.test(account ?? '') || !/^[a-f0-9]{32}$/.test(site ?? '')) return { status: 'configuration' };
  const gql = async (query: string, variables: object = {}) => {
    const response = await request(ENDPOINT, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { account, ...variables } }), signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 401 || response.status === 403) throw new AnalyticsError('permission');
    if (!response.ok) throw new AnalyticsError('provider');
    const body = await response.json();
    if (body.errors?.length) {
      const denied = body.errors.some((e: any) => /auth|permission|access denied|not allowed|token/i.test(String(e.message)));
      throw new AnalyticsError(denied ? 'permission' : 'provider');
    }
    const accounts = body.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) throw new AnalyticsError('permission');
    return accounts[0];
  };
  try {
    const settings = await gql(`query($account:string!){viewer{accounts(filter:{accountTag:$account}){
      settings{rumPageloadEventsAdaptiveGroups{enabled maxDuration maxPageSize notOlderThan}}
    }}}`);
    const limits: Limits = settings.settings?.rumPageloadEventsAdaptiveGroups;
    if (limits?.enabled === false) throw new AnalyticsError('permission');
    if (limits?.enabled !== true || ![limits.maxDuration, limits.maxPageSize, limits.notOlderThan].every(n => Number.isSafeInteger(n) && n > 0)) throw new AnalyticsError('provider');
    const chunks = historyChunks(now.getTime(), limits);
    const window = reportingWindow(now);
    if (chunks[0][0] > window.startMs || limits.maxDuration * 1000 < window.endMs - window.startMs) throw new AnalyticsError('provider');
    const hourly: Row[] = [];
    // Sequential bounded requests keep the small dashboard gentle on provider limits.
    for (const [start, end] of chunks) {
      const result = await gql(`query($account:string!,$filter:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!,$limit:Int!){
        viewer{accounts(filter:{accountTag:$account}){hours:rumPageloadEventsAdaptiveGroups(limit:$limit,filter:$filter,orderBy:[datetimeHour_ASC]){
          sum{visits} dimensions{datetimeHour}
        }}}}`, { filter: publicFilter(site, start, end), limit: limits.maxPageSize });
      hourly.push(...rows(result.hours, limits.maxPageSize));
    }
    const recent = await gql(`query($account:string!,$filter:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!,$limit:Int!){
      viewer{accounts(filter:{accountTag:$account}){
        pages:rumPageloadEventsAdaptiveGroups(limit:$limit,filter:$filter,orderBy:[count_DESC]){count dimensions{requestPath}}
        sources:rumPageloadEventsAdaptiveGroups(limit:$limit,filter:$filter){sum{visits} dimensions{refererHost}}
      }}}`, { filter: publicFilter(site, window.startMs, window.endMs), limit: limits.maxPageSize });
    const byDay = new Map<string, number>();
    let historyVisits = 0;
    for (const row of hourly) {
      const stamp = row.dimensions?.datetimeHour;
      if (!stamp || !Number.isFinite(Date.parse(stamp))) throw new AnalyticsError('provider');
      const day = chicagoCalendarDate(new Date(stamp));
      const visits = count(row.sum?.visits);
      historyVisits += visits;
      byDay.set(day, (byDay.get(day) ?? 0) + visits);
    }
    const daily = calendarDatesFrom(window.start, 30).map(date => ({ date, visits: byDay.get(date) ?? 0 })).reverse();
    const monthDate = new Date(`${window.today.slice(0, 7)}-01T12:00:00Z`);
    const monthly = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(monthDate); d.setUTCMonth(d.getUTCMonth() - i);
      const month = d.toISOString().slice(0, 7);
      return { month, visits: [...byDay].filter(([day]) => day.startsWith(month)).reduce((sum, [, n]) => sum + n, 0),
        partial: i === 0 || chicagoMidnight(`${month}-01`) < chunks[0][0] };
    });
    const pages = rows(recent.pages, limits.maxPageSize).map(row => {
      if (typeof row.dimensions?.requestPath !== 'string') throw new AnalyticsError('provider');
      return { path: row.dimensions.requestPath, views: count(row.count) };
    }).filter(row => isPublicPath(row.path)).sort((a, b) => b.views - a.views).slice(0, 10);
    const sources = ['Google', 'Facebook', 'Direct / Other'].map(name => ({ name, visits: 0 }));
    for (const row of rows(recent.sources, limits.maxPageSize)) {
      if (typeof row.dimensions?.refererHost !== 'string') throw new AnalyticsError('provider');
      sources.find(group => group.name === sourceGroup(row.dimensions!.refererHost!))!.visits += count(row.sum?.visits);
    }
    return { status: 'ok', data: { recentVisits: daily.reduce((sum, day) => sum + day.visits, 0), historyVisits,
      historyStart: new Date(chunks[0][0]).toISOString(), firstRecordedDay: [...byDay.keys()].sort()[0] ?? null,
      daily, monthly, pages, sources } };
  } catch (error) {
    return { status: error instanceof AnalyticsError ? error.status : 'provider' };
  }
}
