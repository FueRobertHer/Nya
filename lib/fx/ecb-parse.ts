// lib/fx/ecb-parse.ts
//
// The ECB's whole history of reference rates, as its eurofxref-hist.zip holds
// it in one CSV, read strictly, and what of it to write. Pure.
//
// THE FILE: a header "Date,USD,JPY,BGN,...,ZAR," (each currency the ECB has
// ever published, and a trailing comma), then one row per publication day,
// newest first: an ISO date, then each currency's units per euro as published
// ("1.1551", "178.52") or N/A where it had none that day. Anything else, a
// header without Date, a day twice, a value that isn't a positive decimal, a
// row of another length, refuses the whole file: nothing of it is written.
//
// WHAT IS WRITTEN (planWrites): per year, its calendar and each currency's
// series (lib/fx/fields.ts), and the newest publication whole. Never a year
// whose days aren't all the stored year's and more (a stale copy of the file
// would otherwise remove the newest day), and never a newest publication
// older than the stored one.

import { isCalendarDay } from '../manual-txn-input';
import { ECB_CODE, daysField, isRateText, seriesField, LATEST_FIELD } from './fields';
import type { EcbLatest, EcbSeries } from './rates';

/** The file, read: its publication days ascending, and each day's rates. */
export type EcbFile = { days: string[]; rates: Map<string, Record<string, string>> };

/** More than the ECB has ever published, and enough rows for centuries. */
const MAX_CODES = 100;
const MAX_ROWS = 40_000;

export function parseEcbCsv(text: string): EcbFile | { error: string } {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 2) return { error: 'The file holds no rates.' };
  if (lines.length - 1 > MAX_ROWS) return { error: 'The file holds more rows than the ECB publishes.' };
  const head = lines[0].split(',');
  if (head[head.length - 1] === '') head.pop();
  if (head[0] !== 'Date') return { error: 'The file does not start with a Date column.' };
  const codes = head.slice(1);
  if (codes.length === 0 || codes.length > MAX_CODES) return { error: 'The file names no currencies, or too many.' };
  if (codes.some((c) => !ECB_CODE.test(c))) return { error: 'The file names a currency that isn’t a three-letter code.' };
  if (new Set(codes).size !== codes.length) return { error: 'The file names a currency twice.' };

  const rates = new Map<string, Record<string, string>>();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length === head.length + 1 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length !== head.length) return { error: `Row ${i + 1} has ${cells.length} cells, not ${head.length}.` };
    const day = cells[0];
    if (!isCalendarDay(day)) return { error: `Row ${i + 1} doesn’t start with a date.` };
    if (rates.has(day)) return { error: `The file has ${day} twice.` };
    const row: Record<string, string> = {};
    for (let j = 1; j < cells.length; j++) {
      const v = cells[j];
      if (v === 'N/A') continue;
      if (!isRateText(v)) return { error: `Row ${i + 1} has a rate that isn’t a positive decimal.` };
      row[codes[j - 1]] = v;
    }
    if (Object.keys(row).length === 0) return { error: `Row ${i + 1} (${day}) holds no rates.` };
    rates.set(day, row);
  }
  return { days: [...rates.keys()].sort(), rates };
}

/** One year of the file, as fields: its calendar and each currency's series. */
function yearOfFile(file: EcbFile, year: string): { days: string[]; series: Map<string, EcbSeries> } {
  const days = file.days.filter((d) => d.slice(0, 4) === year);
  const series = new Map<string, EcbSeries>();
  for (const d of days) {
    for (const [code, rate] of Object.entries(file.rates.get(d)!)) {
      const id = seriesField(code, year);
      const s = series.get(id) ?? {};
      s[d] = rate;
      series.set(id, s);
    }
  }
  return { days, series };
}

/** What is stored now that a plan needs: each year's calendar (null when the
 *  year has none or it can't be used) and the newest publication's day. */
export type StoredState = { days: ReadonlyMap<string, readonly string[] | null>; latest: string | null };

export type WritePlan = {
  /** One step per year, newest first, each written whole and on its own. */
  years: { year: string; fields: Map<string, unknown> }[];
  /** Years left as they are because the file holds fewer of their days than
   *  are stored (a stale copy), named for the fetch's record. */
  refused: string[];
  /** The newest publication, when the file's is newer than the stored one
   *  (written with the newest year's step, so it is never ahead of it). */
  latest: EcbLatest | null;
};

/**
 * What to write from the file: each year that is new, or (when `all`, or for
 * the current year and the year before, which can still change) whose stored
 * calendar differs, as long as the file's days for it include every stored
 * day. Unchanged years are left alone. `current` is the year it is now (UTC).
 */
export function planWrites(file: EcbFile, stored: StoredState, opts: { current: string; all?: boolean }): WritePlan {
  const years = [...new Set(file.days.map((d) => d.slice(0, 4)))].sort().reverse();
  const recent = new Set([opts.current, String(Number(opts.current) - 1)]);
  const plan: WritePlan = { years: [], refused: [], latest: null };
  const newest = file.days[file.days.length - 1];
  if (stored.latest === null || newest > stored.latest) plan.latest = { date: newest, rates: { ...file.rates.get(newest)! } };
  for (const year of years) {
    const has = stored.days.get(year);
    // A past year is written once; a recent one (it may still gain days) is
    // written whole each run, one step of about 170 KB, which is cheaper
    // than reading its 29 series to compare. A stored calendar that can't be
    // used (null) is written again: the file mends it.
    if (has && !opts.all && !recent.has(year)) continue;
    const { days, series } = yearOfFile(file, year);
    if (has) {
      const now = new Set(days);
      if (has.some((d) => !now.has(d))) {
        plan.refused.push(year);
        continue;
      }
    }
    plan.years.push({ year, fields: new Map<string, unknown>([[daysField(year), days], ...series]) });
  }
  // The newest publication goes with its own year's step, so a reader never
  // sees it ahead of that year's series. If that year was refused, so is it.
  const newestYear = newest.slice(0, 4);
  if (plan.latest) {
    const step = plan.years.find((s) => s.year === newestYear);
    if (step) step.fields.set(LATEST_FIELD, plan.latest);
    else if (plan.refused.includes(newestYear)) plan.latest = null;
    else plan.years.unshift({ year: newestYear, fields: new Map<string, unknown>([[LATEST_FIELD, plan.latest]]) });
  }
  return plan;
}
