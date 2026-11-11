// lib/import/performance-review.ts
//
// What importing a Vanguard Performance page would bring in, for the review
// in the account's Import history from a file sheet
// (components/PerformanceImport.tsx): the months as read
// (lib/import/vanguard-performance.ts), with any the person corrected, run
// through the reader's checks again; and whether the file is the account's.
// Pure, safe to import from client code.
//
// CORRECTED MONTHS. A month the reader couldn't vouch for (a figure not
// found, or one that doesn't add up) takes the person's figures for its
// deposits and withdrawals, returns and ending balance, typed from
// Vanguard's own page. Its beginning balance is the month before's end, as
// corrected. Every check is run again on what is then there: each month adds
// up and begins where the one before ended, the cumulative returns follow
// (for the months not typed: from the months as corrected, or else from the
// page's own month before, so a typed month that is off shows once, in the
// total, not in every month after it), and the Total row and the summary
// match the months. The Total row's market and income columns are figures Nya doesn't
// keep: a difference there is let go only when every month whose market or
// income figure was in doubt has been typed. Nothing is imported until all
// of it holds.
//
// WHOSE FILE. Vanguard's print never names its account, and a print of all
// the person's Vanguard accounts together looks the same as one account's, so
// the balances tell. Each whole month's end is compared with the balance Nya
// recorded on the next month's 1st, and the file's last day with the
// balance recorded that day (or the account's balance now, for a file that
// ends within a few days of today). Within 2% everywhere it is the account's.
// A last balance within 2% of every Vanguard account's together (two or
// more) is all of them: never imported. Anything else more than 2% off may be
// another account's, and waits for the person's yes.

import type { Cents, PerformanceRead, TotalColumn } from './vanguard-performance';
import type { BalancePoint } from '../growth';
import { lastDayOf, nextMonth, type Month, type PastMonth } from '../investment-months';

export type Read = Extract<PerformanceRead, { kind: 'read' }>;

/** A month's figures as the person typed them, in cents; null where a field
 *  isn't an amount. */
export type TypedMonth = { net: Cents | null; returns: Cents | null; end: Cents | null };

export type MonthState = {
  month: Month;
  /** The month before's end, as corrected; the file's for the oldest. */
  begin: Cents | null;
  net: Cents | null;
  returns: Cents | null;
  end: Cents | null;
  /** The file has the whole month (lib/import/vanguard-performance.ts). */
  whole: boolean;
  typed: boolean;
  /** It passes every check now. */
  ok: boolean;
  /** What the file read, for the fields' first values. */
  read: { net: Cents | null; returns: Cents | null; end: Cents | null };
};

export type MonthsReview = {
  /** Every month in the file, oldest first. */
  months: MonthState[];
  /** Those that don't pass, oldest first. */
  failing: MonthState[];
  /** The Total row and the summary match the months. */
  totals_ok: boolean;
  /** What would be imported, or null while anything fails or no month is
   *  whole. */
  importable: { start: { month: Month; balance: number }; months: PastMonth[]; typed: Month[] } | null;
  /** Months not whole in the file: the newest until it ends, an oldest cut
   *  at the range's start. */
  left_out: Month[];
};

const dollars = (c: Cents) => c / 100;

export function reviewMonths(read: Read, typed: Readonly<Record<Month, TypedMonth>>): MonthsReview {
  const months: MonthState[] = [];
  let prevEnd: Cents | null = null;
  // The cumulative returns before the month, as corrected.
  let cumulative: Cents | null = 0;
  read.months.forEach((m, k) => {
    const f = m.figures;
    const t = typed[m.month];
    const begin = k === 0 ? f.begin : prevEnd;
    const net = t ? t.net : f.net;
    const returns = t ? t.returns : f.returns;
    const end = t ? t.end : f.end;
    const addsUp = begin !== null && net !== null && returns !== null && end !== null && begin + net + returns === end;
    const before = k === 0 ? 0 : read.months[k - 1].figures.cumulative;
    const follows =
      !t &&
      f.cumulative !== null &&
      returns !== null &&
      ((cumulative !== null && f.cumulative === cumulative + returns) || (before !== null && f.cumulative === before + returns));
    cumulative = follows ? f.cumulative : cumulative !== null && returns !== null ? cumulative + returns : null;
    const ok = t ? addsUp : addsUp && !m.failed.some((c) => c === 'cells' || c === 'returns') && f.begin === begin && follows;
    months.push({ month: m.month, begin, net, returns, end, whole: m.whole, typed: !!t, ok, read: { net: f.net, returns: f.returns, end: f.end } });
    prevEnd = end;
  });

  const sum = (k: 'net' | 'returns') => months.reduce<Cents | null>((s, m) => (s === null || m[k] === null ? null : s + m[k]!), 0);
  const net = sum('net');
  const returns = sum('returns');
  const unsure = read.months.filter((m) => m.failed.includes('cells') || m.failed.includes('returns'));
  const marketLetGo = unsure.length > 0 && unsure.every((m) => typed[m.month]);
  const marketOk = (c: TotalColumn) => marketLetGo || !read.total_differs.includes(c);
  const totals_ok =
    net !== null &&
    returns !== null &&
    read.total.net === net &&
    read.total.returns === returns &&
    marketOk('market') &&
    marketOk('income') &&
    read.summary.begin === months[0]?.begin &&
    read.summary.end === months[months.length - 1]?.end &&
    read.summary.net === net &&
    read.summary.returns === returns;

  const failing = months.filter((m) => !m.ok);
  const whole = months.filter((m) => m.whole);
  const importable =
    failing.length === 0 && totals_ok && whole.length > 0 && whole[0].begin !== null
      ? {
          start: { month: whole[0].month, balance: dollars(whole[0].begin) },
          months: whole.map((m) => ({ month: m.month, net: dollars(m.net!), returns: dollars(m.returns!), end: dollars(m.end!) })),
          typed: whole.filter((m) => m.typed).map((m) => m.month),
        }
      : null;
  return { months, failing, totals_ok, importable, left_out: months.filter((m) => !m.whole).map((m) => m.month) };
}

/** Whether two balances are within 2% of each other. */
const near = (a: number, b: number) => Math.abs(a - b) <= 0.02 * Math.max(Math.abs(a), Math.abs(b));

/** How many days a file's last day may be before today and still be
 *  compared with the account's balance now. */
const LIVE_DAYS = 3;

export type AccountCheck =
  /** The file's balance on `day`, and the account's. */
  | { kind: 'matches'; day: string; balance: number }
  | { kind: 'another'; day: string; balance: number; account: number }
  /** Every Vanguard account's together. */
  | { kind: 'all-accounts'; day: string; balance: number; together: number; account: number | null }
  | null;

/**
 * Whether the file is the account's (see the header). `last` is the file's
 * last day and balance (dollars); `months` what would be imported;
 * `points` the account's history; `balance` its balance now; `vanguard` the
 * balances now of every account at a Vanguard connection, this one with
 * them. Null with nothing to compare.
 */
export function accountCheck(o: {
  last: { day: string; balance: number | null };
  months: readonly PastMonth[];
  points: readonly BalancePoint[] | null;
  balance: number | null;
  vanguard: readonly number[];
  today: string;
}): AccountCheck {
  const recorded = new Map((o.points ?? []).filter((p) => !p.estimated && !p.entered).map((p) => [p.date, p.value] as const));
  const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  const compared: { day: string; file: number; account: number }[] = [];
  for (const m of o.months) {
    const next = `${nextMonth(m.month)}-01`;
    if (recorded.has(next)) compared.push({ day: lastDayOf(m.month), file: m.end, account: recorded.get(next)! });
  }
  const lastAccount =
    recorded.get(o.last.day) ?? (o.balance !== null && o.last.day <= o.today && days(o.last.day, o.today) <= LIVE_DAYS ? o.balance : null);
  if (o.last.balance !== null && lastAccount !== null) compared.push({ day: o.last.day, file: o.last.balance, account: lastAccount });

  const recent = o.last.balance !== null && o.last.day <= o.today && days(o.last.day, o.today) <= LIVE_DAYS;
  const together = o.vanguard.reduce((s, b) => s + b, 0);
  const allOfThem = recent && o.vanguard.length >= 2 && together > 0 && near(o.last.balance!, together);
  const off = compared.find((c) => !near(c.file, c.account));
  if (!off && compared.length > 0) {
    // The account's own balance, though it is nearly all of them.
    const said = compared[compared.length - 1];
    return { kind: 'matches', day: said.day, balance: said.file };
  }
  if (allOfThem) return { kind: 'all-accounts', day: o.last.day, balance: o.last.balance!, together, account: lastAccount };
  if (off) {
    // The last day's, when it is off, as the person can check it today.
    const said = compared[compared.length - 1].day === o.last.day && !near(compared[compared.length - 1].file, compared[compared.length - 1].account) ? compared[compared.length - 1] : off;
    return { kind: 'another', day: said.day, balance: said.file, account: said.account };
  }
  return null;
}
