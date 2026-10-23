// lib/report/year-over-year-read.ts
//
// What year over year (lib/report/year-over-year.ts) is made of, read the way
// a report reads (lib/report/read.ts), for the report page
// (app/api/reports/year-over-year) and the API (/api/v1/year-over-year,
// lib/api-reports.ts): one report read from January 1 of last year through
// today, its rows as a report counts them (lib/report/build.ts periodRows),
// and two reports built from it, this year so far and the same days of last
// year, whose months and gaps say which months may be short (the report's own
// rule, so a month is marked here as a report on its days would mark it).
//
// WITH A HOME CURRENCY, both years are in it, or in the currency asked for,
// what is in another converted (lib/report/year-over-year.ts), as a report
// is; `plain` adds the comparison as before a home currency beside it, in the
// currency asked for (else the one most rows are in), for the API's version
// 1 fields, from the same read; the API asks for the converted one in the
// home currency (`baseInHome`).
//
// READ ONLY, and for display, as a report is: nothing here writes, deletes or
// records anything, and nothing it works out is stored.

import type { Ctx } from '../containers';
import { readReportInput } from './read';
import { buildReport, periodRows, type Gap, type Report } from './build';
import { buildYearOverYear, yoyCurrency, yoySpans, type YearOverYear, type YoyShort } from './year-over-year';
import type { Period } from './period';

export type YearOverYearReport = YearOverYear & {
  version: 1;
  today: string;
  time_zone: string;
  generated_at: string;
  /** Either year's gaps, once each (lib/report/build.ts). */
  gaps: Gap[];
  /** When this year's transactions are from (a report's data_as_of). */
  data_as_of: string | null;
  caveats: Pick<Report['caveats'], 'hidden' | 'scope' | 'names_unread' | 'notes'>;
  /** With a home currency and `plain` asked for: the comparison as before
   *  one, nothing converted. */
  plain?: YearOverYear;
};

export async function readYearOverYear(
  ctx: Ctx,
  opts: { today: string; timeZone: string; currency?: string | null; now?: number; plain?: boolean; baseInHome?: boolean }
): Promise<YearOverYearReport> {
  const now = opts.now ?? Date.now();
  const { today, timeZone } = opts;
  const spans = yoySpans(today);
  const period: Period = { kind: 'range', start: spans.year.last.start, end: today, through: today, today, time_zone: timeZone };
  // Without the categories marked for taxes: year over year never shows them.
  const { input } = await readReportInput(ctx, period, { now, marked: false, currency: opts.currency ?? null });
  const { rows } = periodRows(input, period);
  // With a home currency, it or the one asked for, as a report (lib/report/build.ts).
  const home = input.fx?.home ?? null;
  // `baseInHome` (the API, whose base is in the home currency): the home
  // currency whatever is asked, which `plain` then answers in.
  const currency = home ? (opts.baseInHome ? home : (opts.currency ?? home)) : yoyCurrency(rows, today, opts.currency ?? null);
  const span = (start: string, end: string): Period => ({ kind: 'range', start, end, through: end, today, time_zone: timeZone });
  const thisYear = buildReport({ ...input, currency, period: span(spans.year.this.start, spans.year.this.end) });
  const lastYear = buildReport({ ...input, currency, period: span(spans.year.last.start, spans.year.last.end) });
  const short = new Map<string, YoyShort>();
  for (const m of [...lastYear.months, ...thisYear.months]) if (!m.future) short.set(m.month, { uncertain: m.uncertain, institutions: m.gaps });
  const seen = new Set<string>();
  const gaps = [...lastYear.gaps, ...thisYear.gaps].filter((g) => {
    const key = JSON.stringify(g);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    version: 1,
    today,
    time_zone: timeZone,
    generated_at: new Date(now).toISOString(),
    ...buildYearOverYear({ rows, taxonomy: input.taxonomy ?? null, currency, today, short, fx: home ? input.fx : null, now }),
    ...(home && opts.plain ? { plain: buildYearOverYear({ rows, taxonomy: input.taxonomy ?? null, currency: yoyCurrency(rows, today, opts.currency ?? null), today, short }) } : {}),
    gaps,
    data_as_of: thisYear.data_as_of,
    caveats: {
      hidden: input.hidden,
      scope: { investment: thisYear.caveats.scope.investment || lastYear.caveats.scope.investment, loans: thisYear.caveats.scope.loans || lastYear.caveats.scope.loans },
      names_unread: thisYear.caveats.names_unread,
      notes: thisYear.caveats.notes,
    },
  };
}
