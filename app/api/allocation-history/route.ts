import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, UnreadableEntriesError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { getEffectiveHidden } from '@/lib/links';
import { readHoldingsHistory, type HoldingsDay } from '@/lib/holdings-history';
import { allocationSettingsStore } from '@/lib/allocation-settings';
import { overridesOf } from '@/lib/allocation/settings';
import { allocationSeries, commonCurrency } from '@/lib/allocation/series';
import { loggable } from '@/lib/log-safe';

// Allocation over time (lib/allocation/series.ts): for each day holdings
// history recorded (lib/holdings-history.ts), what the recorded positions
// held by asset class, classified by the same rule as today's allocation,
// with the person's splits as they are now. Reads stored data only, no Plaid
// calls.
//
//   GET /api/allocation-history?from=YYYY-MM-DD&to=YYYY-MM-DD&currency=USD
//     { from, to, currency, first_recorded, first_recorded_at, last_recorded,
//       last_recorded_at, days: [{ date, classes, total, accounts, empty,
//       missing, otherCurrencies, unpriced }] }
//
// Dates are UTC days, as holdings history's are. `to` defaults to today and
// `from` to a year before it; a range is at most MAX_RANGE_DAYS long. Only
// recorded days are in the answer, so nothing is ever drawn before the first
// one, and a day missing an account recorded before and after it names it in
// `missing`. Hidden accounts are left out, and account links followed, as
// the holdings-history route does. `currency` is the one amounts are summed
// in; positions priced in another are left out and summed by currency. Given
// none, it is the one most recorded positions are in.
//
// What can't be read is a 409 naming it, never an empty series.

/** A year and a day: the longest range one request reads. */
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** An ISO 4217 code, as the accounts carry. */
const CURRENCY = /^[A-Z]{3}$/;

/** A real calendar day, as YYYY-MM-DD. */
const isDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** The answer for what the seam or the container refused (lib/repo.ts). */
function failure(err: unknown): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  // 409, not 500, and flagged: what is stored is there, and must not be taken
  // for nothing recorded.
  if (err instanceof StoredDataUnreadableError) {
    console.error('Allocation history unreadable:', describeUnreadable(err));
    const entries = err instanceof UnreadableEntriesError ? err : null;
    return NextResponse.json(
      {
        error: err.message,
        unreadable: true,
        ...(entries ? { unreadable_ids: entries.unreadable, unrecognised_ids: entries.unrecognised } : {}),
      },
      { status: 409 }
    );
  }
  if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error('Allocation history read failed', loggable(err));
  return NextResponse.json({ error: 'Failed to read allocation history' }, { status: 500 });
}

/** The calendar months [from, to] touches, each as the part of the range in it. */
function monthRanges(from: string, to: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let start = from;
  while (start <= to) {
    const [y, m] = start.split('-').map(Number);
    const last = dayOf(Date.UTC(y, m, 0)); // the month's last day
    out.push({ from: start, to: last < to ? last : to });
    start = dayOf(Date.UTC(y, m, 1)); // the next month's first
  }
  return out;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  // Each parameter once: two answers to one question are refused, not picked from.
  for (const name of ['from', 'to', 'currency']) {
    if (params.getAll(name).length > 1) return bad(`Give ${name} once`);
  }
  const fromParam = params.get('from');
  const toParam = params.get('to');
  if ((fromParam !== null && !isDay(fromParam)) || (toParam !== null && !isDay(toParam))) {
    return bad('from and to are dates, YYYY-MM-DD');
  }
  const currencyParam = params.get('currency');
  if (currencyParam !== null && !CURRENCY.test(currencyParam)) return bad('currency is a three-letter ISO code, such as USD');
  const to = toParam ?? dayOf(Date.now());
  // A year, `to` included.
  const from = fromParam ?? dayOf(Date.parse(`${to}T00:00:00Z`) - 364 * DAY_MS);
  if (from > to) return bad('from is after to');
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (span > MAX_RANGE_DAYS) return bad(`A range is at most ${MAX_RANGE_DAYS} days`);

  try {
    const ctx = await dataCtx();
    // As the holdings-history route: every id of every hidden account left
    // out, and links followed so a re-linked account continues.
    const effective = await getEffectiveHidden(ctx);
    const opts = { links: effective.links ?? undefined, hidden: effective.hidden };
    const [settings, head] = await Promise.all([allocationSettingsStore.get(ctx), readHoldingsHistory(ctx, null, opts)]);
    // Nothing is read before the first recorded day, and each month is read
    // on its own, so no one read carries more than a month of positions.
    const start = head.span.first && head.span.first > from ? head.span.first : from;
    const months = head.span.first === null || start > to ? [] : monthRanges(start, to);
    const reads = await Promise.all(months.map((m) => readHoldingsHistory(ctx, m, opts)));
    const days: HoldingsDay[] = reads.flatMap((r) => r.days);
    const currency = currencyParam ?? commonCurrency(days);
    const series = allocationSeries(days, head.accounts, overridesOf(settings).splits, currency);
    return NextResponse.json({
      from,
      to,
      currency,
      first_recorded: head.span.first,
      first_recorded_at: head.span.first_at,
      last_recorded: head.span.last,
      last_recorded_at: head.span.last_at,
      days: series,
    });
  } catch (err) {
    return failure(err);
  }
}
