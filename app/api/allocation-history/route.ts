import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, UnreadableEntriesError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { getEffectiveHidden, readKnownAccounts } from '@/lib/links';
import { pendingVanishedIds } from '@/lib/vanished';
import { placeRecorded, readHoldingsHistory } from '@/lib/holdings-history';
import { readMeasuredBalances } from '@/lib/history';
import { allocationSettingsStore } from '@/lib/allocation-settings';
import { commonCurrency, KNOWN_ALWAYS, seriesBuilder, type SeriesAccount } from '@/lib/allocation/series';
import { loggable } from '@/lib/log-safe';

// Allocation over time (lib/allocation/series.ts): for each day holdings
// history recorded (lib/holdings-history.ts), what the investment accounts
// held by asset class, by today's allocation's own rules, from the positions
// recorded that day and the balances measured beside them (lib/history.ts),
// with the person's splits as they are now. Reads stored data only, no Plaid
// calls.
//
//   POST /api/allocation-history
//     { from?, to?, currency?, accounts: [{ account_id, currency, manual, shown }] }
//   -> { from, to, currency, first_recorded, first_recorded_at,
//        last_recorded, last_recorded_at,
//        days: [{ date, classes, total, unlisted, missing, otherCurrencies,
//                 noCurrency, unpriced }],
//        accounts: [{ account_id, state, first, last, unlisted, label }],
//        unreadable_days: [date] }
//
// `accounts` is the investment accounts the dashboard knows, with each one's
// currency and whether it is tracked by hand, as the Plan tab has them: those
// today's allocation shows (`shown`), and those whose institution it can't
// show (lib/last-known.ts `unshown_accounts`). The series is of those
// accounts, by the same rules, so it and the view above it can't disagree
// about what is counted. A POST because that list is the question, and can be
// longer than a URL. Ids are followed through account links, and a hidden
// account is left out, as everywhere.
//
// Any other account holdings history recorded is still linked if it is
// remembered for a connection still stored (lib/links.ts liveAccountIds), or
// missing from an answer pending confirmation (lib/vanished.ts), and is
// expected as a listed one is; otherwise it is gone (`state`), its connection
// removed or the account closed, and expected only while it was recorded.
// When the remembered accounts can't be read, every recorded account is
// taken to be linked: none is drawn whole without it.
//
// Dates are UTC days, as holdings history's are. `to` defaults to today and
// `from` to a year before it; a range is at most MAX_RANGE_DAYS long. Only
// recorded days are in the answer, so nothing is ever drawn before the first
// one. A day an expected account wasn't recorded on names it in `missing`:
// an account still linked is expected on every day from the first it was
// recorded on, or the first the account directory knew it (lib/links.ts), so
// an institution that stops answering, however long for, never leaves its
// days drawn complete. `accounts` says where each stands and when it was
// recorded, for "not recorded since", and names (`label`, from the
// directory) the ones today's allocation doesn't show. `currency`
// is the one amounts are summed in; given none, the one most listed accounts
// are in.
//
// The months are read in turn, and each reduced to its days' figures before
// the next is read, so no more than a month of positions is held at once.
//
// What can't be read is a 409 naming it, never an empty series. A day whose
// balances are damaged for good is left out and named (`unreadable_days`),
// never counted as a day with no balances.

/** A year and a day: the longest range one request reads. */
const MAX_RANGE_DAYS = 366;
/** More accounts than anyone has: a list longer is not one from the Plan tab. */
const MAX_ACCOUNTS = 500;
/** The longest body a list of MAX_ACCOUNTS takes, with room. */
const MAX_BODY_CHARS = 200_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A currency code as accounts and positions carry them: ISO 4217, or one of
 *  Plaid's unofficial codes (a cryptocurrency's, say). */
const CURRENCY = /^[A-Z0-9]{2,12}$/;
/** An account id: Plaid's, or Nya's for a manual account. Printable, no
 *  spaces, bounded. */
const ACCOUNT_ID = /^[A-Za-z0-9_:.=-]{1,128}$/;

/** A real calendar day, as YYYY-MM-DD. */
const isDay = (s: unknown): s is string =>
  typeof s === 'string' && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
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

/** Every UTC day in [from, to]. */
function daysIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); dayOf(t) <= to; t += DAY_MS) out.push(dayOf(t));
  return out;
}

type Question = { from: string; to: string; currency: string | null; accounts: SeriesAccount[] };

/** The question, strictly: exactly the fields above, each well formed, or
 *  the reason it isn't. */
function parseQuestion(body: unknown): Question | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Send a JSON object';
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !['from', 'to', 'currency', 'accounts'].includes(k));
  if (extra.length) return `Unknown field: ${extra[0]}`;
  if ((b.from !== undefined && !isDay(b.from)) || (b.to !== undefined && !isDay(b.to))) return 'from and to are dates, YYYY-MM-DD';
  if (b.currency !== undefined && b.currency !== null && !(typeof b.currency === 'string' && CURRENCY.test(b.currency))) {
    return 'currency is a currency code, such as USD';
  }
  if (!Array.isArray(b.accounts)) return 'accounts is a list of the accounts to show';
  if (b.accounts.length > MAX_ACCOUNTS) return `At most ${MAX_ACCOUNTS} accounts`;
  const accounts: SeriesAccount[] = [];
  const seen = new Set<string>();
  for (const raw of b.accounts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Each account is an object';
    const a = raw as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== 4 || !['account_id', 'currency', 'manual', 'shown'].every((k) => keys.includes(k))) return 'Each account has account_id, currency, manual and shown';
    if (typeof a.account_id !== 'string' || !ACCOUNT_ID.test(a.account_id)) return 'An account_id is not one';
    if (a.currency !== null && !(typeof a.currency === 'string' && CURRENCY.test(a.currency))) return "An account's currency is a currency code, or null";
    if (typeof a.manual !== 'boolean') return 'manual is true or false';
    if (typeof a.shown !== 'boolean') return 'shown is true or false';
    if (seen.has(a.account_id)) return 'Each account once';
    seen.add(a.account_id);
    accounts.push({ account_id: a.account_id, currency: a.currency as string | null, manual: a.manual, shown: a.shown });
  }
  const to = (b.to as string | undefined) ?? dayOf(Date.now());
  // A year, `to` included.
  const from = (b.from as string | undefined) ?? dayOf(Date.parse(`${to}T00:00:00Z`) - 364 * DAY_MS);
  if (from > to) return 'from is after to';
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (span > MAX_RANGE_DAYS) return `A range is at most ${MAX_RANGE_DAYS} days`;
  return { from, to, currency: (b.currency as string | null | undefined) ?? null, accounts };
}

export async function POST(req: Request) {
  const text = await req.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_CHARS) return bad('Send the accounts to show, as JSON');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad('Send the accounts to show, as JSON');
  }
  const q = parseQuestion(body);
  if (typeof q === 'string') return bad(q);
  const { from, to } = q;

  try {
    const ctx = await dataCtx();
    // As the holdings-history route: every id of every hidden account left
    // out, and links followed so a re-linked account continues.
    const effective = await getEffectiveHidden(ctx);
    const opts = { links: effective.links ?? undefined, hidden: effective.hidden };
    const place = placeRecorded(opts);
    const [settings, head, directory, pending] = await Promise.all([
      allocationSettingsStore.get(ctx),
      readHoldingsHistory(ctx, null, opts),
      readKnownAccounts(ctx),
      pendingVanishedIds(ctx),
    ]);
    // The accounts still linked, under the ids they are known by now.
    const stillLinked = new Set<string>();
    for (const id of [...effective.live, ...pending]) {
      const placed = place(id);
      if (placed) stillLinked.add(placed.account);
    }
    const linked = (id: string) => !effective.liveOk || stillLinked.has(id);

    // The accounts listed, under the ids they are known by now, hidden ones
    // left out: a list from before an account was hidden or re-linked is
    // read as it is now.
    const listed = new Map<string, SeriesAccount>();
    for (const a of q.accounts) {
      const placed = place(a.account_id);
      if (placed && !listed.has(placed.account)) listed.set(placed.account, { ...a, account_id: placed.account });
    }
    // When the directory first knew each account, the earliest of its ids.
    // One whose entry can't be read is taken to have been there all along:
    // no day can be said to come before it existed, so none is drawn whole
    // without it.
    const knownFrom = new Map<string, string>();
    const labels = new Map<string, string>();
    for (const [id, k] of directory.known) {
      const placed = place(id);
      if (!placed) continue;
      if (k.first_seen) {
        const prev = knownFrom.get(placed.account);
        if (!prev || k.first_seen < prev) knownFrom.set(placed.account, k.first_seen);
      }
      if (k.label && !labels.has(placed.account)) labels.set(placed.account, k.label);
    }
    for (const id of directory.unreadable) {
      const placed = place(id);
      if (placed && (listed.has(placed.account) || linked(placed.account))) knownFrom.set(placed.account, KNOWN_ALWAYS);
    }

    const currency = q.currency ?? commonCurrency([...listed.values()]);
    const series = seriesBuilder({ accounts: [...listed.values()], knownFrom, recorded: head.accounts, linked, settings, currency });
    const unreadableDays: string[] = [];
    // Nothing is read before the first recorded day, and the months are read
    // in turn, each reduced to its days' figures before the next.
    const start = head.span.first && head.span.first > from ? head.span.first : from;
    const months = head.span.first === null || start > to ? [] : monthRanges(start, to);
    for (const m of months) {
      const [{ days }, measured] = await Promise.all([readHoldingsHistory(ctx, m, opts), readMeasuredBalances(ctx, daysIn(m.from, m.to))]);
      for (const day of days) {
        if (measured.unreadable.includes(day.date)) {
          unreadableDays.push(day.date);
          continue;
        }
        // Each balance under the account it belongs to now; of two ids of
        // one account on one day, the one its positions would be taken from.
        const best = new Map<string, { rank: number; balance: number }>();
        for (const [recordedAs, balance] of Object.entries(measured.balances.get(day.date) ?? {})) {
          const placed = place(recordedAs);
          if (!placed) continue;
          const prev = best.get(placed.account);
          if (!prev || placed.rank < prev.rank) best.set(placed.account, { rank: placed.rank, balance });
        }
        series.add(day, new Map([...best].map(([id, b]) => [id, b.balance])));
      }
    }
    return NextResponse.json({
      from,
      to,
      currency,
      first_recorded: head.span.first,
      first_recorded_at: head.span.first_at,
      last_recorded: head.span.last,
      last_recorded_at: head.span.last_at,
      days: series.days,
      accounts: series.accounts().map((a) => ({ ...a, label: a.state === 'shown' ? null : (labels.get(a.account_id) ?? null) })),
      unreadable_days: unreadableDays,
    });
  } catch (err) {
    return failure(err);
  }
}
