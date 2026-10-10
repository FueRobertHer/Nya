// lib/report/period.ts
//
// The period a report covers (app/reports, app/api/reports): a calendar year,
// for a tax year, or any range of days, checked and bounded, and read on the
// person's own calendar, in the time zone their browser sends. Pure and
// client-safe: the report page checks its form with these too.
//
// DAYS AND TIMES. A transaction's date is a calendar day at the bank
// (lib/local-date.ts), compared as it is and never converted, so a period is
// a range of such days. What needs a time zone is every instant: today (a
// range can't end after it, and a year still running is covered through it)
// and when each institution last synced, which is set against the period's
// days on the person's calendar. The report says which time zone that was.

import { addDays, isCalendarDay } from '../manual-txn-input';

/** The earliest day a report can start on. */
export const EARLIEST_REPORT_DAY = '2000-01-01';
/** The longest range: two years, a leap day included. */
export const MAX_RANGE_DAYS = 731;

export type ReportKind = 'year' | 'range';

/** What the person asked for: a calendar year, or a range of days. */
export type ReportRequest = { kind: 'year'; year: number } | { kind: 'range'; start: string; end: string };

/**
 * A period, resolved: the days asked for (`start` to `end`), the last day this
 * report can cover (`through`: the end, or today for a year still running),
 * and the person's today and the time zone it was read in.
 */
export type Period = { kind: ReportKind; start: string; end: string; through: string; today: string; time_zone: string };

/** An IANA time zone this runtime knows ("America/New_York", "UTC"). */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,2}$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** The calendar day (YYYY-MM-DD) an instant falls on in `timeZone`, or null
 *  for something that isn't an instant. */
export function dayIn(at: string | number | Date, timeZone: string): string | null {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formats.set(timeZone, f);
  }
  const part = (type: string) => f.formatToParts(d).find((p) => p.type === type)?.value ?? '';
  const day = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  return isCalendarDay(day) ? day : null;
}

/** Whole days from one calendar day to another: 0 for the same day. */
export function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export { addDays };

/** The request a report's query asks for, and how it is to be answered. */
export type ReportParams = { request: ReportRequest; timeZone: string; currency: string | null; format: 'json' | 'csv' };

const PARAMS = new Set(['kind', 'year', 'start', 'end', 'tz', 'currency', 'format']);
/** A currency as a row carries one: an ISO code, or Plaid's code for one
 *  without (a cryptocurrency's). */
const CURRENCY = /^[A-Z0-9]{2,16}$/;

/**
 * The report a query asks for, checked field by field, or why it can't be
 * read. `kind` is "year" (the default, with `year`) or "range" (with `start`
 * and `end`, each YYYY-MM-DD); `tz` is the time zone to read days in (UTC
 * when not given); `currency` picks the report's currency; `format` is "json"
 * (the default) or "csv". Nothing else is taken, and nothing twice. The
 * period's bounds are checked against today by resolvePeriod.
 */
export function readReportParams(params: URLSearchParams): ReportParams | { error: string } {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!PARAMS.has(key)) return { error: `Unknown parameter "${key.slice(0, 40)}".` };
    if (seen.has(key)) return { error: `"${key}" is given more than once.` };
    seen.add(key);
  }
  const kind = params.get('kind') ?? 'year';
  if (kind !== 'year' && kind !== 'range') return { error: 'kind must be "year" or "range".' };
  const tz = params.get('tz') ?? 'UTC';
  if (!isTimeZone(tz)) return { error: 'tz must be a time zone, like America/New_York.' };
  const currency = params.get('currency');
  if (currency !== null && !CURRENCY.test(currency)) return { error: 'currency must be a currency code, like USD.' };
  const format = params.get('format') ?? 'json';
  if (format !== 'json' && format !== 'csv') return { error: 'format must be "json" or "csv".' };
  const base = { timeZone: tz, currency, format: format as 'json' | 'csv' };
  if (kind === 'year') {
    if (params.has('start') || params.has('end')) return { error: 'A year takes no start or end.' };
    const year = params.get('year');
    if (year === null || !/^\d{4}$/.test(year)) return { error: 'year must be a year, like 2025.' };
    return { ...base, request: { kind: 'year', year: Number(year) } };
  }
  if (params.has('year')) return { error: 'A range takes a start and an end, not a year.' };
  const start = params.get('start');
  const end = params.get('end');
  if (!isCalendarDay(start) || !isCalendarDay(end)) return { error: 'A range needs a start and an end, each a date written YYYY-MM-DD.' };
  return { ...base, request: { kind: 'range', start, end } };
}

/**
 * The period a request covers, on the person's calendar at `now`, or why it
 * can't be one. A year from 2000 to this one; this year is covered through
 * today. A range of at most MAX_RANGE_DAYS days, from 2000 on, ending today at
 * the latest.
 */
export function resolvePeriod(request: ReportRequest, timeZone: string, now: number): Period | { error: string } {
  const today = dayIn(now, timeZone);
  if (!today) return { error: 'Today’s date couldn’t be read in that time zone.' };
  const thisYear = Number(today.slice(0, 4));
  if (request.kind === 'year') {
    const { year } = request;
    const first = Number(EARLIEST_REPORT_DAY.slice(0, 4));
    if (!Number.isInteger(year) || year < first || year > thisYear) return { error: `Choose a year from ${first} to ${thisYear}.` };
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    return { kind: 'year', start, end, through: end < today ? end : today, today, time_zone: timeZone };
  }
  const { start, end } = request;
  if (!isCalendarDay(start) || !isCalendarDay(end)) return { error: 'A range needs a start and an end, each a date written YYYY-MM-DD.' };
  if (end < start) return { error: 'The range ends before it starts.' };
  if (start < EARLIEST_REPORT_DAY) return { error: `A range can’t start before ${EARLIEST_REPORT_DAY}.` };
  if (end > today) return { error: `A range can’t end after today (${today}).` };
  if (daysFrom(start, end) + 1 > MAX_RANGE_DAYS) return { error: `A range can be at most two years long (${MAX_RANGE_DAYS} days).` };
  return { kind: 'range', start, end, through: end, today, time_zone: timeZone };
}

/** The months a period's covered days fall in ("YYYY-MM"), oldest first, each
 *  with its first and last day inside the period. A year lists all twelve,
 *  those after `through` too, which are still to come. */
export function periodMonths(period: Period): { month: string; start: string; end: string }[] {
  const out: { month: string; start: string; end: string }[] = [];
  let month = period.start.slice(0, 7);
  const last = period.end.slice(0, 7);
  while (month <= last) {
    const first = `${month}-01`;
    const next = addDays(first, 32).slice(0, 7);
    const lastDay = addDays(`${next}-01`, -1);
    out.push({ month, start: first < period.start ? period.start : first, end: lastDay > period.end ? period.end : lastDay });
    month = next;
  }
  return out;
}
