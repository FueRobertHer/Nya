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
//     its currency. A payment due on a card or loan is marked on its day but
//     never added: the forecast doesn't count it either, since it may already
//     be a detected bill, and what will be paid (the minimum, the statement,
//     something between) is the person's to decide.

import { addDays, expectedDates, type Cadence, type RecurringSeries } from './recurring';
import { plannedDates, type PlannedCadence, type PlannedItem } from './planned';
import { currencyOf, inCurrency, isExcluded } from './spending';

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
  pending?: boolean;
  excluded?: boolean;
  /** Listed but not in the day's figure: another currency, a transaction the
   *  person excluded, or a payment due (see the header). */
  uncounted?: boolean;
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

const cents = (n: number) => Math.round(n * 100);

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
}): CalendarMonth {
  const { month, today, currency } = opts;
  const all = monthDays(month);
  const first = all[0];
  const last = all[all.length - 1];
  const entries = new Map<string, CalendarEntry[]>(all.map((d) => [d, []]));
  const add = (e: CalendarEntry) => entries.get(e.date)?.push(e);

  for (const t of opts.txns) {
    if (!entries.has(t.date)) continue;
    const excluded = isExcluded(t);
    add({
      kind: 'posted',
      date: t.date,
      name: t.name,
      amount: t.amount === 0 ? 0 : -t.amount,
      currency: currencyOf(t),
      ref: t.transaction_id,
      ...(t.pending ? { pending: true } : {}),
      ...(excluded ? { excluded: true } : {}),
      ...(excluded || !inCurrency(t, currency) ? { uncounted: true } : {}),
    });
  }

  // What is expected starts today: a month gone by has none.
  const from = today > first ? today : first;
  if (from <= last) {
    const expected: CalendarEntry[] = [];
    for (const s of opts.series) {
      if (opts.dismissed?.has(s.id)) continue;
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
          ...(inCurrency({ iso_currency_code: s.currency }, currency) ? {} : { uncounted: true }),
        });
      }
    }
    for (const item of opts.planned)
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
          ...(inCurrency({ iso_currency_code: item.currency }, currency) ? {} : { uncounted: true }),
        });
    // On each day, money in first, then out, largest first.
    expected.sort((a, b) => Number(a.amount! < 0) - Number(b.amount! < 0) || Math.abs(b.amount!) - Math.abs(a.amount!));
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
      if (e.kind === 'posted') posted = (posted ?? 0) + cents(e.amount);
      else if (e.kind === 'expected') expected = (expected ?? 0) + cents(e.amount);
    }
    days.set(date, { date, entries: list, posted: posted === null ? null : posted / 100, expected: expected === null ? null : expected / 100 });
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
