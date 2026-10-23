// lib/fx/fields.ts
//
// How the ECB's rates are laid out in their store (lib/fx/ecb-store.ts), and
// how a reader's table (lib/fx/rates.ts FxTable) is built from what it read.
// Pure, and safe to import from client code.
//
// ONE FIELD PER CURRENCY AND YEAR, A CALENDAR PER YEAR, THE NEWEST WHOLE:
//   "USD:2026"   {"2026-01-02":"1.0353",...}  the year's rates as published
//   "days:2026"  ["2026-01-02",...]           the days the ECB published
//   "latest"     {"date":...,"rates":{...}}   the newest publication, whole
//   "fetch"      what the last fetch did (lib/fx/rates.ts EcbFetch)
// The calendar is what tells "published that day without this currency" from
// "didn't publish that day". Every currency the ECB publishes is kept, always:
// which currencies are stored must never say which ones people here hold.

import type { EcbFetch, EcbLatest, EcbSeries, FxTable, OwnRate } from './rates';
import { isCalendarDay, knownCurrency } from '../manual-txn-input';

export const LATEST_FIELD = 'latest';
export const FETCH_FIELD = 'fetch';
export const daysField = (year: string) => `days:${year}`;
export const seriesField = (currency: string, year: string) => `${currency}:${year}`;

/** A currency code as the ECB's file writes one. */
export const ECB_CODE = /^[A-Z]{3}$/;
/** A rate as the ECB publishes one: digits, maybe a fraction, nothing else. */
const RATE = /^\d{1,9}(\.\d{1,9})?$/;
const YEAR = /^\d{4}$/;
/** A field's id, as the fetch's record names one it mended. */
const FIELD_ID = /^(latest|fetch|days:\d{4}|[A-Z]{3}:\d{4})$/;
/** More fields than the store holds (about 900). */
export const MAX_MENDED = 2000;

export const isRateText = (v: unknown): v is string => typeof v === 'string' && RATE.test(v) && Number(v) > 0;

export function isDays(v: unknown, year?: string): v is string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 366) return false;
  for (let i = 0; i < v.length; i++) {
    const d = v[i];
    if (!isCalendarDay(d) || (year !== undefined && d.slice(0, 4) !== year)) return false;
    if (i > 0 && d <= v[i - 1]) return false;
  }
  return true;
}

export function isSeries(v: unknown, year?: string): v is EcbSeries {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 366) return false;
  return entries.every(([d, r]) => isCalendarDay(d) && (year === undefined || d.slice(0, 4) === year) && isRateText(r));
}

export function isLatest(v: unknown): v is EcbLatest {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const l = v as Record<string, unknown>;
  if (Object.keys(l).some((k) => k !== 'date' && k !== 'rates')) return false;
  if (!isCalendarDay(l.date) || !l.rates || typeof l.rates !== 'object' || Array.isArray(l.rates)) return false;
  const rates = Object.entries(l.rates as Record<string, unknown>);
  return rates.length > 0 && rates.length <= 100 && rates.every(([c, r]) => ECB_CODE.test(c) && isRateText(r));
}

export function isFetch(v: unknown): v is EcbFetch {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const f = v as Record<string, unknown>;
  if (Object.keys(f).some((k) => !['at', 'ok', 'reason', 'newest', 'last_ok', 'mended'].includes(k))) return false;
  const time = (t: unknown) => typeof t === 'string' && Number.isFinite(Date.parse(t));
  return (
    time(f.at) &&
    typeof f.ok === 'boolean' &&
    (f.reason === undefined || (typeof f.reason === 'string' && f.reason.length <= 500)) &&
    (f.newest === null || isCalendarDay(f.newest)) &&
    (f.last_ok === null || time(f.last_ok)) &&
    (f.mended === undefined || (Array.isArray(f.mended) && f.mended.length <= MAX_MENDED && f.mended.every((id) => typeof id === 'string' && FIELD_ID.test(id))))
  );
}

/** Whether a stored value is what its field holds. */
export function isEcbValue(v: unknown, id: string): boolean {
  if (id === LATEST_FIELD) return isLatest(v);
  if (id === FETCH_FIELD) return isFetch(v);
  const [head, year] = id.split(':');
  if (year === undefined || !YEAR.test(year)) return false;
  if (head === 'days') return isDays(v, year);
  return ECB_CODE.test(head) && isSeries(v, year);
}

/** The years a reader needs for days from `from` to `to`: each year they
 *  fall in, and the year before when `from` is in its year's first week,
 *  which starts before the year's first publication (1 January always). */
export function yearsFor(from: string, to: string): string[] {
  const first = Number(from.slice(0, 4)) - (from.slice(5) <= '01-07' ? 1 : 0);
  const last = Number(to.slice(0, 4));
  const out: string[] = [];
  for (let y = Math.max(first, 1999); y <= last; y++) out.push(String(y));
  return out;
}

/** The fields a reader reads for these currencies over these years: the
 *  newest publication, the last fetch, each year's calendar, and each
 *  currency's series for each year. The euro has none (its rate is 1), nor
 *  has a code that isn't an ISO currency (BTC): the ECB publishes only those. */
export function fieldsFor(currencies: Iterable<string>, years: readonly string[]): string[] {
  const codes = [...new Set(currencies)].filter((c) => c !== 'EUR' && ECB_CODE.test(c) && knownCurrency(c)).sort();
  return [LATEST_FIELD, FETCH_FIELD, ...years.map(daysField), ...codes.flatMap((c) => years.map((y) => seriesField(c, y)))];
}

/**
 * A reader's table from what it read: `fields` the values it got (a field
 * that is absent, or that couldn't be used, is not in it), `years` the years
 * it asked for, `home` and `own` the person's settings. A year asked for with
 * no usable calendar is `missing_years`: no rate on its days.
 */
export function tableFromFields(fields: ReadonlyMap<string, unknown>, years: readonly string[], home: string | null, own: readonly OwnRate[], unusable: readonly string[] = []): FxTable {
  const days: Record<string, readonly string[]> = {};
  const series: Record<string, EcbSeries> = {};
  const missing: string[] = [];
  for (const y of years) {
    const d = fields.get(daysField(y));
    if (isDays(d, y)) days[y] = d;
    else missing.push(y);
  }
  for (const [id, v] of fields) {
    const [head, year] = id.split(':');
    if (head !== 'days' && year !== undefined && ECB_CODE.test(head) && isSeries(v, year)) series[id] = v;
  }
  const latest = fields.get(LATEST_FIELD);
  const fetch = fields.get(FETCH_FIELD);
  return { home, own, latest: isLatest(latest) ? latest : null, days, series, missing_years: missing, fetch: isFetch(fetch) ? fetch : null, unusable: [...unusable].sort() };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An own rate as a reader's table carries it (lib/fx/settings.ts keeps
 *  them, and checks them there): its fields' forms. */
const isTableOwnRate = (v: unknown): v is OwnRate =>
  isObject(v) &&
  typeof v.currency === 'string' &&
  /^[A-Z0-9]{2,10}$/.test(v.currency) &&
  isRateText(v.rate) &&
  typeof v.quote === 'string' &&
  ECB_CODE.test(v.quote) &&
  (v.from === null || isCalendarDay(v.from)) &&
  typeof v.set_at === 'string';

/**
 * A reader's table as an answer carries it to the page (app/api/transactions
 * `fx`), checked field by field, or null: a page converts with nothing it
 * can't read, and then shows today's totals.
 */
export function asFxTable(v: unknown): FxTable | null {
  if (!isObject(v) || typeof v.home !== 'string' || !ECB_CODE.test(v.home)) return null;
  if (!Array.isArray(v.own) || !v.own.every(isTableOwnRate)) return null;
  if (!(v.latest === null || isLatest(v.latest)) || !(v.fetch === null || isFetch(v.fetch))) return null;
  if (!isObject(v.days) || !Object.entries(v.days).every(([y, d]) => YEAR.test(y) && isDays(d, y))) return null;
  if (!isObject(v.series) || !Object.entries(v.series).every(([id, s]) => isEcbValue(s, id) && !id.startsWith('days:') && id.includes(':'))) return null;
  if (!Array.isArray(v.missing_years) || !v.missing_years.every((y) => typeof y === 'string' && YEAR.test(y))) return null;
  if (v.unusable !== undefined && !(Array.isArray(v.unusable) && v.unusable.every((id) => typeof id === 'string'))) return null;
  if (v.accounts !== undefined && !(isObject(v.accounts) && Object.values(v.accounts).every((c) => typeof c === 'string' && /^[A-Z0-9]{2,10}$/.test(c)))) return null;
  if (v.unread !== undefined && v.unread !== true) return null;
  return v as unknown as FxTable;
}
