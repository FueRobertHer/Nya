// lib/calendar.ts
//
// One month of the calendar view (components/CalendarView.tsx): each day's
// posted transactions, and from today on the bills and income expected
// (lib/recurring.ts), the items planned (lib/planned.ts) and the card and
// loan payments Plaid says are due (lib/liabilities.ts), with a figure for
// each day. Pure; "today" is the viewer's own day (lib/local-date.ts).
//
// A DAY'S FIGURES, one for what posted and one for what is expected, never
// added together: one is the bank's record, the other an estimate.
//   - Posted: money in less money out, as the Activity tab's day heading
//     counts it (every row but one the person excluded), in the totals'
//     currency only: a row in another is listed, not added.
//   - Expected: the forecast's own amounts for the day (lib/forecast.ts), in
//     its currency: bills and income on cash accounts, and the items planned.
//     A bill charged to a card is listed on its day but not added, as the
//     forecast doesn't add it: the card's payment is what leaves cash. So is
//     pay whose amount varies too much to forecast, and a series on an account
//     whose type isn't known. A payment due on a card or loan is marked on its
//     day but never added: the forecast doesn't count it either, since it may
//     already be a detected bill, and what will be paid (the minimum, the
//     statement, something between) is the person's to decide.
// Figures are added in whole minor units of the currency (cents, yen).
//
// WITH A HOME CURRENCY (lib/fx/), what is in another currency than the day's
// figures counts in them converted, each entry still listed in its own
// currency with what it counts as (`figure`): a posted row at its own day's
// rate (lib/fx/totals.ts totalsIn), an expected amount at the newest rates,
// as the forecast counts it. One with no rate is listed, not added, as
// before.

import { addDays, expectedDates, type Cadence, type RecurringSeries } from './recurring';
import { plannedDates, type PlannedCadence, type PlannedItem } from './planned';
import { currencyOf, inCurrency, isExcluded } from './spending';
import { bankRows } from './split-rows';
import { minorScale } from './forecast';
import { totalsIn } from './fx/totals';
import { convert, type FxTable } from './fx/rates';

/** What the calendar reads of a transaction (the Activity tab's Txn). */
export type CalendarTxn = {
  transaction_id: string;
  date: string;
  name: string;
  amount: number;
  pending: boolean;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  excluded?: boolean | null;
  /** A part of a split transaction, or a group's row (lib/split-rows.ts):
   *  what the calendar puts back together to list each charge once. */
  split_of?: string;
  split_parent?: unknown;
  split_remainder?: unknown;
  group_members?: readonly unknown[];
  /** One of a group counted on a day before what was read: listed, not
   *  counted (lib/split-rows.ts). */
  group_outside?: { name: string; date: string };
  /** The rows shared expenses make of a shared transaction or a payment
   *  (lib/shared-expenses/rows.ts), put back whole by bankRows; an IOU's
   *  row, which is no charge, is left off the calendar. */
  shared_of?: string;
  shared_was?: number;
  shared_part?: unknown;
  shared_iou?: unknown;
};

/** A card or loan payment Plaid says is due (an account's liability). */
export type DuePayment = {
  account_id: string;
  name: string;
  institution: string;
  date: string;
  /** The minimum payment, or null when Plaid gives none. */
  minimum: number | null;
  currency: string | null;
};

export type CalendarEntry = {
  kind: 'posted' | 'expected' | 'due';
  date: string;
  name: string;
  /** Positive is money in, as the calendar shows it. A payment due shows its
   *  minimum as money out, or null when there is none. */
  amount: number | null;
  currency: string | null;
  /** A transaction's id, a series' or planned item's, or an account's. */
  ref: string;
  /** Where an expected amount comes from. */
  source?: 'bill' | 'income' | 'planned';
  cadence?: Cadence | PlannedCadence;
  /** Expected: due before today and not in yet, so expected today. */
  late?: boolean;
  /** Expected and late: its scheduled date. */
  due?: string;
  /** A series': the account it is on, and that account's type. */
  account?: string;
  accountType?: string | null;
  pending?: boolean;
  excluded?: boolean;
  /** Listed but not in the day's figure: another currency, a transaction the
   *  person excluded, or a payment due (see the header). */
  uncounted?: boolean;
  /** Posted, split (#39): how many parts the person made, and, when some of
   *  them are left out, what the day's figure counts of it instead of
   *  `amount` (money in positive, as `amount`). */
  parts?: number;
  counted?: number;
  /** In another currency, with a home currency: what the day's figure counts
   *  of it, converted into the figure's currency (money in positive). */
  figure?: number;
  /** Posted, in a group counted on a day before what was read: the group's
   *  name and day (listed, never in the figure). */
  group?: { name: string; date: string };
  /** Why an expected one isn't in the figure: another currency, an account
   *  that isn't cash (a card's charge) or whose type isn't known, or pay that
   *  varies too much to forecast. */
  off?: 'currency' | 'not-cash' | 'unknown-account' | 'varies';
};

export type CalendarDay = {
  date: string;
  entries: CalendarEntry[];
  /** Posted money in less money out, or null when nothing counted posted. */
  posted: number | null;
  /** Expected money in less money out, or null when nothing counted is. */
  expected: number | null;
};

export type CalendarMonth = {
  /** YYYY-MM. */
  month: string;
  /** The month's days a week a row, Sunday first; null pads the first and
   *  last weeks. */
  weeks: (string | null)[][];
  /** Every day of the month, by date. */
  days: Map<string, CalendarDay>;
};

/** The days of a month (YYYY-MM), first to last. */
export function monthDays(month: string): string[] {
  const first = `${month}-01`;
  const out: string[] = [];
  for (let d = first; d.startsWith(month); d = addDays(d, 1)) out.push(d);
  return out;
}

/** The month after (or `n` months after) a YYYY-MM. */
export function addMonths(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  const y = Math.floor(index / 12);
  return `${y}-${String(index - y * 12 + 1).padStart(2, '0')}`;
}

/** A month's grid: weeks of seven, Sunday first. */
export function monthWeeks(month: string): (string | null)[][] {
  const days = monthDays(month);
  const lead = new Date(`${days[0]}T00:00:00Z`).getUTCDay();
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** One month of the calendar (see the header). */
export function calendarMonth(opts: {
  month: string;
  today: string;
  txns: readonly CalendarTxn[];
  series: readonly RecurringSeries[];
  planned: readonly PlannedItem[];
  dismissed?: ReadonlySet<string>;
  dues?: readonly DuePayment[];
  /** The currency the day's figures are in (the totals', or the forecast's). */
  currency: string | null;
  /** With a home currency, what converts an entry in another currency into
   *  the figures' (see the header). */
  fx?: FxTable | null;
}): CalendarMonth {
  const { month, today, currency } = opts;
  const scale = minorScale(currency);
  // The rows as the figures count them, by id: converted where they can be.
  const counting = currency !== null && opts.fx?.home ? totalsIn(opts.txns, opts.fx, { into: { currency } }).rows : null;
  const asCounted = counting ? new Map(bankRows(counting, { groups: 'keep' }).map((t) => [t.transaction_id, t])) : null;
  // An amount expected from today: at the newest rates.
  const rateDay = opts.fx?.latest && opts.fx.latest.date > today ? opts.fx.latest.date : today;
  const expectedIn = (amount: number, c: string | null): number | null => {
    if (!opts.fx?.home || currency === null || !c) return null;
    const r = convert(opts.fx, amount, c, currency, rateDay);
    return r.ok ? r.amount : null;
  };
  const all = monthDays(month);
  const first = all[0];
  const last = all[all.length - 1];
  const entries = new Map<string, CalendarEntry[]>(all.map((d) => [d, []]));
  const add = (e: CalendarEntry) => entries.get(e.date)?.push(e);

  // Each charge once, as the bank made it (lib/split-rows.ts bankRows): a
  // split transaction whole, its parts that count making the day's figure;
  // a group's net as one row, as every total counts it.
  for (const t of bankRows(opts.txns, { groups: 'keep' })) {
    if (!entries.has(t.date)) continue;
    // A split one's parts, or the rows shared expenses made of a shared
    // transaction or a payment (lib/shared-expenses/rows.ts): what counts of
    // them is the day's figure, your part of a shared dinner.
    const split = t.split_parts;
    const parts = split ?? t.shared_parts;
    const excluded = parts ? parts.every((p) => isExcluded(p)) : isExcluded(t);
    // As the figure counts it: converted, with a home currency, when it can be.
    const c = asCounted?.get(t.transaction_id) ?? t;
    const converted = c !== t && currencyOf(c) !== currencyOf(t);
    const uncounted = excluded || !inCurrency(c, currency) || !!t.group_outside;
    const cParts = c.split_parts ?? c.shared_parts;
    // What counts of a split one: all of it, unless a part is left out on its own.
    const counted = parts && !uncounted && !converted ? -parts.filter((p) => !isExcluded(p)).reduce((n, p) => n + Math.round(p.amount * scale), 0) / scale : undefined;
    const figure =
      converted && !uncounted ? (cParts ? -cParts.filter((p) => !isExcluded(p)).reduce((n, p) => n + Math.round(p.amount * scale), 0) / scale : -c.amount || 0) : undefined;
    add({
      kind: 'posted',
      date: t.date,
      name: t.name,
      amount: t.amount === 0 ? 0 : -t.amount,
      currency: currencyOf(t),
      ref: t.transaction_id,
      ...(t.pending ? { pending: true } : {}),
      ...(excluded ? { excluded: true } : {}),
      ...(uncounted ? { uncounted: true } : {}),
      ...(split ? { parts: split.filter((p) => !p.split_remainder && p.shared_part === undefined).length } : {}),
      ...(t.group_outside ? { group: { name: t.group_outside.name, date: t.group_outside.date } } : {}),
      ...(counted !== undefined && Math.round(counted * scale) !== Math.round(-t.amount * scale) ? { counted: counted || 0 } : {}),
      ...(figure !== undefined ? { figure } : {}),
    });
  }

  // What is expected starts today: a month gone by has none.
  const from = today > first ? today : first;
  if (from <= last) {
    const expected: CalendarEntry[] = [];
    for (const s of opts.series) {
      if (opts.dismissed?.has(s.id)) continue;
      // What the forecast leaves out is listed, with why (see the header).
      const own = inCurrency({ iso_currency_code: s.currency }, currency);
      const at = own ? null : expectedIn(s.amount, s.currency);
      const off: CalendarEntry['off'] =
        s.accountType === null
          ? 'unknown-account'
          : s.accountType !== 'depository'
            ? 'not-cash'
            : s.agreement === 'varies'
              ? 'varies'
              : own || at !== null
                ? undefined
                : 'currency';
      for (const d of expectedDates(s, today, last).dates) {
        if (d.date < from) continue;
        expected.push({
          kind: 'expected',
          date: d.date,
          name: s.name,
          amount: s.kind === 'income' ? s.amount : -s.amount,
          currency: s.currency,
          ref: s.id,
          source: s.kind,
          cadence: s.cadence,
          ...(d.late ? { late: true, due: d.due } : {}),
          ...(s.account ? { account: s.account } : {}),
          accountType: s.accountType,
          ...(off ? { uncounted: true, off } : {}),
          ...(!off && at !== null ? { figure: s.kind === 'income' ? at : -at } : {}),
        });
      }
    }
    for (const item of opts.planned) {
      const own = inCurrency({ iso_currency_code: item.currency }, currency);
      const at = own ? null : expectedIn(item.amount, item.currency);
      for (const date of plannedDates(item, from, last))
        expected.push({
          kind: 'expected',
          date,
          name: item.name,
          amount: item.kind === 'income' ? item.amount : -item.amount,
          currency: item.currency,
          ref: item.id,
          source: 'planned',
          cadence: item.cadence,
          ...(own ? {} : at !== null ? { figure: item.kind === 'income' ? at : -at } : { uncounted: true, off: 'currency' as const }),
        });
    }
    // On each day, money in first, then out, largest first (as counted).
    const size = (e: CalendarEntry) => e.figure ?? e.amount!;
    expected.sort((a, b) => Number(size(a) < 0) - Number(size(b) < 0) || Math.abs(size(b)) - Math.abs(size(a)));
    for (const e of expected) add(e);
    for (const p of opts.dues ?? []) {
      if (p.date < from || p.date > last) continue;
      add({
        kind: 'due',
        date: p.date,
        name: p.name,
        amount: p.minimum === null ? null : -p.minimum,
        currency: p.currency,
        ref: p.account_id,
        uncounted: true,
      });
    }
  }

  const days = new Map<string, CalendarDay>();
  for (const date of all) {
    const list = entries.get(date)!;
    let posted: number | null = null;
    let expected: number | null = null;
    for (const e of list) {
      if (e.uncounted || e.amount === null) continue;
      if (e.kind === 'posted') posted = (posted ?? 0) + Math.round((e.figure ?? e.counted ?? e.amount) * scale);
      else if (e.kind === 'expected') expected = (expected ?? 0) + Math.round((e.figure ?? e.amount) * scale);
    }
    days.set(date, { date, entries: list, posted: posted === null ? null : posted / scale, expected: expected === null ? null : expected / scale });
  }
  return { month, weeks: monthWeeks(month), days };
}

/** The payments due that Plaid reports on visible cards and loans, from the
 *  institutions the dashboard holds. */
export function duePayments(
  institutions: readonly {
    institution_name: string;
    accounts: readonly {
      account_id: string;
      name: string;
      type: string;
      currency: string | null;
      hidden?: boolean;
      liability?: { minimum_payment: number | null; next_due_date: string | null };
    }[];
  }[]
): DuePayment[] {
  return institutions.flatMap((i) =>
    i.accounts.flatMap((a) =>
      !a.hidden && (a.type === 'credit' || a.type === 'loan') && a.liability?.next_due_date
        ? [{ account_id: a.account_id, name: a.name, institution: i.institution_name, date: a.liability.next_due_date, minimum: a.liability.minimum_payment, currency: a.currency }]
        : []
    )
  );
}
