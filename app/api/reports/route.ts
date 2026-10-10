import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, describeUnreadable } from '@/lib/repo';
import { readReportParams, resolvePeriod } from '@/lib/report/period';
import { readReport } from '@/lib/report/read';
import { reportCsv, reportFilename } from '@/lib/report/csv';
import { loggable } from '@/lib/log-safe';

// A report for an accountant (lib/report/): a tax-year summary
// (?kind=year&year=2025) or any range of days (?kind=range&start=...&end=...),
// read in the person's time zone (tz), in one currency (currency, else the
// one most of the period's transactions are in), as JSON for the report page
// (app/reports) or as a CSV of its totals (format=csv). Every parameter is
// checked, and the period's bounds against the person's today, before
// anything is read.
//
// From storage only, as the read-only API reads (lib/report/read.ts): a report
// never calls Plaid, so it costs nothing there and says as of when each
// institution's transactions are. It changes nothing, so no cache is cleared.
// Gated like the dashboard (proxy.ts).

export async function GET(req: Request) {
  const params = readReportParams(new URL(req.url).searchParams);
  if ('error' in params) return NextResponse.json({ error: params.error }, { status: 400 });
  const now = Date.now();
  const period = resolvePeriod(params.request, params.timeZone, now);
  if ('error' in period) return NextResponse.json({ error: period.error }, { status: 400 });
  try {
    const ctx = await dataCtx(now);
    const report = await readReport(ctx, period, { currency: params.currency, now });
    if (params.format === 'csv') {
      return new NextResponse(reportCsv(report), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${reportFilename(report)}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    // Something the report can't do without couldn't be read (the hidden
    // accounts, say): 409 and flagged, never a report short of it.
    if (err instanceof StoredDataUnreadableError) {
      console.error('Report: stored data unreadable:', describeUnreadable(err));
      return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
    }
    console.error('Report failed', loggable(err));
    return NextResponse.json({ error: 'Failed to make the report' }, { status: 500 });
  }
}
