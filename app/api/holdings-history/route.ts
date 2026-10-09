import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, UnreadableEntriesError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { getEffectiveHidden } from '@/lib/links';
import { readHoldingsHistory, repairHoldingsIndex, indexIsDamaged, HoldingsIndexMissingError } from '@/lib/holdings-history';
import { loggable } from '@/lib/log-safe';

// Holdings history (lib/holdings-history.ts): what each investment account
// held on each recorded day, for the app to build on (allocation over time,
// returns). Reads stored data only, no Plaid calls.
//
//   GET /api/holdings-history?from=YYYY-MM-DD&to=YYYY-MM-DD&account_id=...&include_hidden=1
//     { from, to, first_recorded, last_recorded, first_recorded_at, last_recorded_at,
//       dates: [{ date, accounts: [{ account_id, recorded_as, observed_at, positions }] }] }
//   GET /api/holdings-history?summary=1&account_id=...
//     { first_recorded, last_recorded, first_recorded_at, last_recorded_at },
//     from the index alone
//   POST /api/holdings-history { action: "repair", confirm: true }
//     rebuilds a damaged or missing index from the months, once the person
//     confirms (repairHoldingsIndex): { repaired: true, months, damaged_months? }
//
// Dates are UTC days, as net-worth history's are. `to` defaults to today and
// `from` to 30 days before `to`; a range is at most MAX_RANGE_DAYS long. Each
// position is self-contained: the security's description comes with it.
// Account links are followed, as the per-account balance chart follows them,
// so an account's positions continue across a reconnect under its current id
// (`recorded_as` names the id they were recorded under). Hidden accounts are
// left out unless include_hidden=1, and `account_id` narrows the answer to one
// account. first_recorded and last_recorded are the first and last days
// anything (or that account) was recorded on, whatever the range, and the
// `_at` fields the moments behind them (null where not known), so a screen can
// show the viewer's own day. The index is read once for both parts of an
// answer, so they agree.
//
// What can't be read is a 409 naming it, never an empty history, and so are
// months whose index is missing (`index_missing`: deleted by hand, or left so
// by a rollback), which would otherwise read as nothing recorded. `repairable`
// says it is the index alone, damaged or missing: what POST repairs.

/** About a quarter: the longest range one request reads. */
const MAX_RANGE_DAYS = 92;
/** The most bytes one answer carries, measured on the answer itself, so it
 *  stays inside a function's response limit (4.5 MB on Vercel) however long
 *  the securities' names are. A range holding more is refused, never cut
 *  short. */
const MAX_ANSWER_BYTES = 4_000_000;
const MAX_ID = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day, as YYYY-MM-DD. */
const isDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** The answer for what the seam or the container refused (lib/repo.ts). */
function failure(err: unknown, doing: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  // 409, not 500, and flagged: what is stored is there, and must not be taken
  // for nothing recorded.
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored holdings history unreadable:', describeUnreadable(err));
    const entries = err instanceof UnreadableEntriesError ? err : null;
    const missing = err instanceof HoldingsIndexMissingError ? err : null;
    // Only the index, damaged or missing: rebuilt from the months on request.
    const repairable = (!!entries && indexIsDamaged(entries) && entries.unrecognised.length === 0) || !!missing?.repairable;
    return NextResponse.json(
      {
        error: err.message,
        unreadable: true,
        ...(entries ? { unreadable_ids: entries.unreadable, unrecognised_ids: entries.unrecognised } : {}),
        ...(missing ? { index_missing: true } : {}),
        ...(repairable ? { repairable: true } : {}),
      },
      { status: 409 }
    );
  }
  if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(`Holdings history ${doing} failed`, loggable(err));
  return NextResponse.json({ error: `Failed to ${doing} holdings history` }, { status: 500 });
}

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
    const { span, days: dates } = await readHoldingsHistory(ctx, summary ? null : { from, to }, opts);
    const recorded = {
      first_recorded: span.first,
      last_recorded: span.last,
      first_recorded_at: span.first_at,
      last_recorded_at: span.last_at,
    };
    if (summary) return NextResponse.json(recorded);

    const answer = JSON.stringify({ from, to, ...recorded, dates });
    const bytes = Buffer.byteLength(answer);
    if (bytes > MAX_ANSWER_BYTES) {
      return bad(`That range holds more than one answer carries (${bytes} bytes, over ${MAX_ANSWER_BYTES}). Ask for fewer days, or one account.`);
    }
    return new NextResponse(answer, { headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return failure(err, 'read');
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  // Only on the person's word: the damaged index is replaced.
  if (body?.action !== 'repair' || body?.confirm !== true) return bad('Expected { action: "repair", confirm: true }');
  try {
    const ctx = await dataCtx();
    const { months, damaged_months } = await repairHoldingsIndex(ctx);
    return NextResponse.json({ repaired: true, months, ...(damaged_months > 0 ? { damaged_months } : {}) });
  } catch (err) {
    return failure(err, 'repair');
  }
}
