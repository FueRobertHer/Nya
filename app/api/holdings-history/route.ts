import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, UnreadableEntriesError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { getEffectiveHidden } from '@/lib/links';
import { readHoldingsRange, readHoldingsSpan } from '@/lib/holdings-history';
import { loggable } from '@/lib/log-safe';

// Holdings history (lib/holdings-history.ts): what each investment account
// held on each recorded day, for the app to build on (allocation over time,
// returns). Reads stored data only, no Plaid calls.
//
//   GET /api/holdings-history?from=YYYY-MM-DD&to=YYYY-MM-DD&account_id=...&include_hidden=1
//     { from, to, first_recorded, last_recorded,
//       dates: [{ date, accounts: [{ account_id, recorded_as, observed_at, positions }] }] }
//   GET /api/holdings-history?summary=1&account_id=...
//     { first_recorded, last_recorded }, from the index alone
//
// Dates are UTC days, as net-worth history's are. `to` defaults to today and
// `from` to 30 days before `to`; a range is at most MAX_RANGE_DAYS long. Each
// position is self-contained: the security's description comes with it.
// Account links are followed, as the per-account balance chart follows them,
// so an account's positions continue across a reconnect under its current id
// (`recorded_as` names the id they were recorded under). Hidden accounts are
// left out unless include_hidden=1, and `account_id` narrows the answer to one
// account. first_recorded and last_recorded are the first and last days
// anything (or that account) was recorded on, whatever the range.

/** About a quarter: the longest range one request reads. */
const MAX_RANGE_DAYS = 92;
/** The most positions one answer carries, so it stays well inside a
 *  function's response limit (4.5 MB on Vercel): a position is about 250
 *  characters of JSON. A range holding more is refused, never cut short. */
const MAX_POSITIONS = 12_000;
const MAX_ID = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day, as YYYY-MM-DD. */
const isDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  // Each parameter once: two answers to one question are refused, not picked from.
  for (const name of ['from', 'to', 'account_id', 'include_hidden', 'summary']) {
    if (params.getAll(name).length > 1) return bad(`Give ${name} once`);
  }
  const flag = (name: string): boolean | null => {
    const v = params.get(name);
    return v === null || v === '0' ? false : v === '1' ? true : null;
  };
  const includeHidden = flag('include_hidden');
  const summary = flag('summary');
  if (includeHidden === null || summary === null) return bad('include_hidden and summary are 0 or 1');
  const accountId = params.get('account_id');
  if (accountId !== null && (accountId.length === 0 || accountId.length > MAX_ID)) return bad('Invalid account_id');

  const fromParam = params.get('from');
  const toParam = params.get('to');
  if ((fromParam !== null && !isDay(fromParam)) || (toParam !== null && !isDay(toParam))) {
    return bad('from and to are dates, YYYY-MM-DD');
  }
  const to = toParam ?? dayOf(Date.now());
  const from = fromParam ?? dayOf(Date.parse(`${to}T00:00:00Z`) - 30 * DAY_MS);
  if (from > to) return bad('from is after to');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) return bad(`A range is at most ${MAX_RANGE_DAYS} days`);

  try {
    const ctx = await dataCtx();
    // Every id of every hidden account, and the links in effect. A link that
    // can't be read with nothing hidden leaves each id as its own account, as
    // the balance chart does; with something hidden it fails the request, since
    // a hidden account must never show.
    const effective = await getEffectiveHidden(ctx);
    const opts = {
      links: effective.links ?? undefined,
      hidden: includeHidden ? undefined : effective.hidden,
      ...(accountId !== null ? { accountId } : {}),
    };
    const span = await readHoldingsSpan(ctx, opts);
    const recorded = { first_recorded: span.first, last_recorded: span.last };
    if (summary) return NextResponse.json(recorded);

    const dates = await readHoldingsRange(ctx, from, to, opts);
    const positions = dates.reduce((n, d) => n + d.accounts.reduce((m, a) => m + a.positions.length, 0), 0);
    if (positions > MAX_POSITIONS) {
      return bad(`That range holds ${positions} positions, more than one answer carries (${MAX_POSITIONS}). Ask for fewer days, or one account.`);
    }
    return NextResponse.json({ from, to, ...recorded, dates });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    // 409, not 500, and flagged: what is stored is there, and must not be
    // taken for nothing recorded.
    if (err instanceof StoredDataUnreadableError) {
      console.error('Stored holdings history unreadable:', describeUnreadable(err));
      return NextResponse.json(
        {
          error: err.message,
          unreadable: true,
          ...(err instanceof UnreadableEntriesError ? { unreadable_ids: err.unreadable, unrecognised_ids: err.unrecognised } : {}),
        },
        { status: 409 }
      );
    }
    if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('Holdings history read failed', loggable(err));
    return NextResponse.json({ error: 'Failed to read holdings history' }, { status: 500 });
  }
}
