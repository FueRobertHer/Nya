// lib/investment-months.ts
//
// An investment account's past months, imported from its brokerage's own
// record of them (today only Vanguard's Performance page, printed to a PDF and
// read in the browser, lib/import/vanguard-performance.ts): each month's
// deposits and withdrawals (one net), its returns and its ending balance,
// from the month the account opened. They reach back past what Plaid shares
// (two years of activity) and past the first day Nya recorded a balance.
//
// EVERY IMPORT IS ITS OWN RECORD, never changed after it is written, and an
// import changes nothing else in Nya: not the activity Plaid gives, not the
// typed deposits and withdrawals (lib/money-in-out.ts), not the recorded
// balances, not another import. What counts is worked out on every read:
// the account's newest import, whole (never two files' months mixed, since
// one file's ending balance needn't be the next one's beginning), joined to
// the account's own history by withPastMonths below. So undoing an import
// takes out only its record, and everything reads as it did before it.
//
// THE SEAM (withPastMonths), applied to an account's whole history once per
// view tree: its chart (components/AccountSparkline.tsx) and Accounts >
// Investments (components/InvestmentGrowth.tsx), so the two never disagree.
// Where Nya has its own figures they win; the months fill in only before:
//
//   - Each month's ending balance is a real point on the 1st of the next
//     month (Nya's points don't include flows dated that day; a month's end
//     includes its last day's), and the first month's beginning balance one
//     on its 1st. They carry `entered`, so the chart draws them solid, a
//     month apart, and says where they come from. Months whose point would
//     fall on or after the first recorded day are left out: Nya's own are
//     there.
//   - Estimated points the months reach over are dropped (the backfill
//     walks the balance back through flows with no market in it, which
//     Vanguard's real balances contradict). The months reach to the first
//     recorded day when their last end is a month or less before it, joined
//     straight on to it (`joined`); otherwise only to their last end
//     (`entered_to`), and Nya's estimates fill the days from there. The
//     net-worth chart and the stored history are untouched (lib/history.ts).
//   - Each month before Nya's activity starts is one flow, its net, at the
//     middle of its days; the month the activity starts in gives the part
//     before it, Vanguard's net less Nya's own from that day to its end.
//     Months Nya's activity covers add nothing: its own rows count there.
//   - A file that starts at $0.00 with empty months (a range chosen from
//     before the account opened) starts at its first month with anything in
//     it: the months before held nothing.
//   - `flows_from` reaches back to the first month. Typed totals stay bound
//     to Nya's own activity (`totals_from`), so totals for a day before it
//     still read as outdated.
//
// Months whose figures differ from Nya's activity (`differs`) are compared,
// not used: where Plaid misreads a conversion or a sweep.
//
// Pure, safe to import from client code; the store is lib/investment-
// months-store.ts, the route app/api/investment-months.

import { MAX_AMOUNT } from './manual-txn-input';
import { isTotal, type MoneyInOut } from './money-in-out';
import { usableTotals, type BalancePoint, type Flow, type Move } from './growth';

/** Plaid's institution id for Vanguard (Fue checked it against Plaid,
 *  2026-11-11): the only brokerage whose Performance page Nya reads. By id,
 *  never by name: another firm calling itself Vanguard isn't read. */
export const VANGUARD_INSTITUTION_IDS: ReadonlySet<string> = new Set(['ins_115616']);

/** Whether a connection's institution is Vanguard's. */
export function isVanguard(institution_id: string | null | undefined): boolean {
  return !!institution_id && VANGUARD_INSTITUTION_IDS.has(institution_id);
}

/** A month, as 'YYYY-MM'. */
export type Month = string;

/** One month of an import: Vanguard's own figures, in the account's
 *  currency. end = the month before's end (or the start balance) + net +
 *  returns, to the cent. */
export type PastMonth = {
  month: Month;
  /** Deposits and withdrawals, one signed net: below zero when more came out. */
  net: number;
  /** Personal investment returns: market gain or loss plus income. */
  returns: number;
  /** Ending balance. */
  end: number;
};

export type MonthsSource = 'vanguard-performance';

/** One import, as it was read. Never changed once written. */
export type MonthsImport = {
  id: string;
  source: MonthsSource;
  /** The file's name, as the person's device gave it, or null. */
  file_name: string | null;
  /** When it was imported (an ISO time): the newest counts. */
  imported_at: string;
  /** The first month and its beginning balance. */
  start: { month: Month; balance: number };
  /** Every whole month the file had, oldest first, from start.month on. */
  months: PastMonth[];
  /** The account's currency when it was imported, or null. */
  currency: string | null;
  /** Months whose figures the person typed in the review, where the file's
   *  didn't add up. */
  typed?: Month[];
};

/** An account's imports, oldest first, as stored under one of its ids, or
 *  as read across all of them. */
export type InvestmentMonths = { imports: MonthsImport[] };

/** The most months one import holds: a hundred years. */
export const MAX_MONTHS = 1_200;
/** The most imports an account keeps, across its ids: past it, the person
 *  undoes an old one first, so nothing goes without being asked. */
export const MAX_IMPORTS = 24;
/** The earliest month: nothing in Nya is older. */
export const FIRST_MONTH = '1970-01';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const CURRENCY = /^[A-Za-z0-9]{2,12}$/;
const IMPORT_KEYS = ['id', 'source', 'file_name', 'imported_at', 'start', 'months', 'currency', 'typed'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const toCents = (n: number) => Math.round(n * 100);
const cents = (n: number) => Math.round(n * 100) / 100;

export const isMonth = (v: unknown): v is Month => typeof v === 'string' && MONTH.test(v) && v >= FIRST_MONTH;

/** The month before 'YYYY-MM'. */
export function previousMonth(m: Month): Month {
  const y = Number(m.slice(0, 4));
  const n = Number(m.slice(5));
  return n === 1 ? `${y - 1}-12` : `${y}-${String(n - 1).padStart(2, '0')}`;
}

/** The month after 'YYYY-MM'. */
export function nextMonth(m: Month): Month {
  const y = Number(m.slice(0, 4));
  const n = Number(m.slice(5));
  return n === 12 ? `${y + 1}-01` : `${y}-${String(n + 1).padStart(2, '0')}`;
}

/** The month's last day, 'YYYY-MM-DD'. */
export function lastDayOf(m: Month): string {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0));
  return d.toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
const shiftDays = (d: string, n: number) => new Date(parse(d) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((parse(b) - parse(a)) / DAY_MS);

/** A net or a return as stored: a finite amount, no larger than MAX_AMOUNT
 *  either way. */
const isSigned = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_AMOUNT;

/** What is wrong with a list of months from `start`, in the person's words,
 *  or null: contiguous from start.month, each adding up to the cent. */
export function monthsProblem(start: { month: unknown; balance: unknown }, months: unknown): string | null {
  if (!isMonth(start.month)) return 'The first month is a month, YYYY-MM, from 1970 on';
  if (!isTotal(start.balance)) return 'The beginning balance must be an amount, $0.00 or more';
  if (!Array.isArray(months) || months.length === 0) return 'Send at least one month';
  if (months.length > MAX_MONTHS) return `At most ${MAX_MONTHS.toLocaleString('en-US')} months`;
  let expect = start.month;
  let prev = toCents(start.balance);
  for (const m of months) {
    if (!isRecord(m) || !Object.keys(m).every((k) => ['month', 'net', 'returns', 'end'].includes(k))) return 'Each month is its month, net, returns and end';
    if (m.month !== expect) return `The months must follow on from ${start.month}, one a month`;
    if (!isSigned(m.net)) return `${m.month}: deposits and withdrawals must be an amount`;
    if (!isSigned(m.returns)) return `${m.month}: returns must be an amount`;
    if (!isTotal(m.end)) return `${m.month}: the ending balance must be an amount, $0.00 or more`;
    if (prev + toCents(m.net) + toCents(m.returns) !== toCents(m.end)) return `${m.month} doesn’t add up: its beginning balance, plus deposits and withdrawals, plus returns, isn’t its ending balance`;
    prev = toCents(m.end);
    expect = nextMonth(expect);
  }
  return null;
}

/** The stored shape of one import, closed: a later release's record is
 *  unrecognised, never read as something it isn't. */
export function isMonthsImport(v: unknown): v is MonthsImport {
  if (!isRecord(v) || !Object.keys(v).every((k) => IMPORT_KEYS.includes(k))) return false;
  if (typeof v.id !== 'string' || !ID.test(v.id)) return false;
  if (v.source !== 'vanguard-performance') return false;
  if (!(v.file_name === null || (typeof v.file_name === 'string' && v.file_name.length <= 255))) return false;
  if (typeof v.imported_at !== 'string' || v.imported_at.length > 64 || !Number.isFinite(Date.parse(v.imported_at))) return false;
  if (!isRecord(v.start) || !Object.keys(v.start).every((k) => k === 'month' || k === 'balance')) return false;
  if (!(v.currency === null || (typeof v.currency === 'string' && CURRENCY.test(v.currency)))) return false;
  if (monthsProblem(v.start as { month: unknown; balance: unknown }, v.months) !== null) return false;
  if (v.typed !== undefined) {
    const listed = new Set((v.months as PastMonth[]).map((m) => m.month));
    if (!Array.isArray(v.typed) || v.typed.length === 0 || new Set(v.typed).size !== v.typed.length || !v.typed.every((m) => typeof m === 'string' && listed.has(m))) return false;
  }
  return true;
}

/** The stored shape of an account's imports, closed. */
export function isInvestmentMonths(v: unknown): v is InvestmentMonths {
  if (!isRecord(v) || !Object.keys(v).every((k) => k === 'imports')) return false;
  const list = v.imports;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_IMPORTS || !list.every(isMonthsImport)) return false;
  return new Set(list.map((i) => i.id)).size === list.length;
}

/** Oldest first: by when imported, then by id, so every reader agrees. */
export function byImported(a: MonthsImport, b: MonthsImport): number {
  if (a.imported_at !== b.imported_at) return a.imported_at < b.imported_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The import that counts: the newest. */
export function countingImport(entry: InvestmentMonths | null | undefined): MonthsImport | null {
  if (!entry || entry.imports.length === 0) return null;
  return [...entry.imports].sort(byImported)[entry.imports.length - 1];
}

/** The months an import covers, first to last. */
export function importSpan(i: MonthsImport): { from: Month; to: Month } {
  return { from: i.start.month, to: i.months[i.months.length - 1].month };
}

// ---- The request -----------------------------------------------------------

export type MonthsChange =
  | {
      action: 'import';
      account_id: string;
      file_name: string | null;
      start: { month: Month; balance: number };
      months: PastMonth[];
      currency: string | null;
      typed: Month[];
      /** The import that counted when the file was reviewed, or null for
       *  none: refused when another device has imported since. */
      counting: string | null;
    }
  | { action: 'undo'; account_id: string; import_id: string };

const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/**
 * A request to the route, or what is wrong with it in the person's words:
 *
 *   { action: 'import', account_id, file_name, start, months, currency,
 *     typed?, counting }                          add an import
 *   { action: 'undo', account_id, import_id }     undo one
 *
 * Amounts are numbers, to the cent; the months must add up as stored.
 */
export function parseMonthsChange(body: unknown): MonthsChange | string {
  if (!isRecord(body)) return 'Send the months, as JSON';
  const { account_id, action } = body;
  if (typeof account_id !== 'string' || !ACCOUNT_ID.test(account_id) || account_id === '__proto__') return 'Invalid account id';
  if (action === 'undo') {
    if (Object.keys(body).some((k) => !['action', 'account_id', 'import_id'].includes(k))) return 'Undoing takes the account and the import alone';
    if (typeof body.import_id !== 'string' || !ID.test(body.import_id)) return 'Invalid import id';
    return { action: 'undo', account_id, import_id: body.import_id };
  }
  if (action !== 'import') return 'Say whether to import or undo';
  const extra = Object.keys(body).find((k) => !['action', 'account_id', 'file_name', 'start', 'months', 'currency', 'typed', 'counting'].includes(k));
  if (extra) return `${extra.slice(0, 40)} isn’t part of an import`;
  const file_name = body.file_name ?? null;
  if (file_name !== null && (typeof file_name !== 'string' || file_name.length > 255)) return 'Invalid file name';
  if (!isRecord(body.start) || Object.keys(body.start).some((k) => k !== 'month' && k !== 'balance')) return 'Send the first month and its beginning balance';
  const start = body.start as { month: unknown; balance: unknown };
  const problem = monthsProblem(start, body.months);
  if (problem) return problem;
  const currency = body.currency ?? null;
  if (currency !== null && (typeof currency !== 'string' || !CURRENCY.test(currency))) return 'Invalid currency';
  const months = (body.months as PastMonth[]).map((m) => ({ month: m.month, net: cents(m.net), returns: cents(m.returns), end: cents(m.end) }));
  const typed = body.typed ?? [];
  if (!Array.isArray(typed) || new Set(typed).size !== typed.length || !typed.every((m) => months.some((x) => x.month === m))) return 'The typed months must be months of the import';
  const counting = body.counting ?? null;
  if (counting !== null && (typeof counting !== 'string' || !ID.test(counting))) return 'Invalid import id';
  return {
    action: 'import',
    account_id,
    file_name: file_name === null ? null : file_name.slice(0, 255),
    start: { month: start.month as Month, balance: cents(start.balance as number) },
    months,
    currency,
    typed: typed as Month[],
    counting,
  };
}

// ---- The seam --------------------------------------------------------------

/** What the activity payload says (app/api/investment-activity), the parts
 *  read here. */
export type MonthsActivity = {
  flows?: Flow[] | null;
  flows_from?: string | null;
  flows_to?: string | null;
  moves?: Move[] | null;
  /** The totals the person set, and whether they couldn't be read: not
   *  read by the seam, only by the sheet, to say what an import or an undo
   *  does to all time. */
  money_in_out?: MoneyInOut | null;
  money_in_out_unreadable?: boolean;
};

/**
 * Why the months that count aren't used now (see the header, rule 0):
 *   - currency: the account's currency isn't the one they were imported in;
 *   - activity: Nya has no activity for the account to join them to;
 *   - no-record: Nya has no recorded balance for the account yet;
 *   - gap: Nya's activity starts after the month after their last, so
 *     nothing covers the days between (a newer file would);
 *   - activity-late: Nya's activity starts after its first recorded day
 *     (a re-link), so no month could be joined honestly, whatever the file;
 *   - covered: Nya has its own balances for every one of their months.
 */
export type MonthsUnused = 'currency' | 'activity' | 'no-record' | 'gap' | 'activity-late' | 'covered';

/** A month inside Nya's own activity whose deposits and withdrawals aren't
 *  Vanguard's, by more than a dollar. */
export type MonthDiffers = { month: Month; theirs: number; nyas: number };

export type PastMonthsResult = {
  /** The points the views draw: the months' as entered points, then Nya's. */
  points: BalancePoint[];
  /** The account's daily flows, with one a month before Nya's activity. */
  flows: Flow[] | null;
  /** From the first month, or Nya's own. */
  flows_from: string | null;
  /** Nya's own activity's first day, which typed totals are checked against. */
  totals_from: string | null;
  /** The import that counts, used or not. */
  counting: MonthsImport | null;
  unused: MonthsUnused | null;
  /** Where the months apply: their first day, the first recorded day,
   *  Nya's activity's first day, and their last end's day. `joined`: the
   *  line runs straight on from that end to the first recorded day, a month
   *  or less on; otherwise Nya's estimates fill the days between. */
  applied: { from: string; first_recorded: string; activity_from: string; entered_to: string; joined: boolean } | null;
  differs: MonthDiffers[];
};

/** The month a file's months count from: its first, or from $0.00 its first
 *  with anything in it (see the seam's header). A start with no balance
 *  given counts from its first. */
export function firstMonth(i: { start: { month: Month; balance?: number }; months: readonly PastMonth[] }): Month {
  if (i.start.balance !== 0) return i.start.month;
  return i.months.find((m) => m.net !== 0 || m.returns !== 0 || m.end !== 0)?.month ?? i.start.month;
}

/** "Mar 2018". */
export function monthText(m: Month): string {
  return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** The longest a line is joined straight from a month's end: a month. */
export const JOINED_DAYS = 31;

/** The middle of the days from `from` to `to`: the 16th of a 31-day month. */
function middleDay(from: string, to: string): string {
  return shiftDays(from, Math.floor((daysBetween(from, to) + 1) / 2));
}

const sameCurrency = (a: string | null | undefined, b: string | null | undefined) => (a ?? 'USD').toUpperCase() === (b ?? 'USD').toUpperCase();

/**
 * An account's history and activity joined to the months that count (see
 * the header). `points` is its whole balance history, oldest first;
 * `activity` its payload; `currency` its currency now. With nothing that
 * applies, the points and activity come back as given, `unused` saying why.
 */
export function withPastMonths(
  points: readonly BalancePoint[],
  activity: MonthsActivity,
  entry: InvestmentMonths | null | undefined,
  currency: string | null | undefined
): PastMonthsResult {
  const flows = activity.flows ?? null;
  const from = activity.flows_from ?? null;
  const counting = countingImport(entry);
  const asGiven = (unused: MonthsUnused | null): PastMonthsResult => ({
    points: [...points],
    flows,
    flows_from: from,
    totals_from: from,
    counting,
    unused,
    applied: null,
    differs: [],
  });
  if (!counting) return asGiven(null);
  if (!sameCurrency(counting.currency, currency)) return asGiven('currency');
  if (!flows || !from) return asGiven('activity');
  const firstRecorded = points.find((p) => !p.estimated && !p.entered)?.date ?? null;
  if (!firstRecorded) return asGiven('no-record');
  if (from > firstRecorded) return asGiven('activity-late');
  const last = counting.months[counting.months.length - 1].month;
  if (from > `${nextMonth(last)}-01`) return asGiven('gap');

  // The months' points before the first recorded day: the start balance on
  // its 1st, each month's end on the next month's 1st. From $0.00, from the
  // first month with anything in it (see the header).
  const first = firstMonth(counting);
  const used = counting.months.filter((m) => m.month >= first);
  const entered: BalancePoint[] = [];
  const startDay = `${first}-01`;
  if (startDay < firstRecorded) entered.push({ date: startDay, value: counting.start.balance, entered: true });
  for (const m of used) {
    const day = `${nextMonth(m.month)}-01`;
    if (day >= firstRecorded) break;
    entered.push({ date: day, value: m.end, entered: true });
  }
  // Only the start balance: no month ends before Nya's own.
  if (entered.length < 2) return asGiven('covered');

  // One flow a month before Nya's activity starts: its net at the middle of
  // its uncovered days; the month the activity starts in, less Nya's own.
  const lumps: Flow[] = [];
  const differs: MonthDiffers[] = [];
  const to = activity.flows_to ?? null;
  for (const m of counting.months) {
    const first = `${m.month}-01`;
    const end = lastDayOf(m.month);
    const nyas = cents(flows.reduce((t, f) => (f.date >= first && f.date <= end ? t + f.amount : t), 0));
    if (first >= from) {
      // Nya's own activity covers it: compared, never used.
      if ((!to || end <= to) && Math.abs(toCents(nyas) - toCents(m.net)) > 100) differs.push({ month: m.month, theirs: m.net, nyas });
      continue;
    }
    const uncoveredTo = end < from ? end : shiftDays(from, -1);
    const amount = end < from ? m.net : cents(m.net - nyas);
    if (toCents(amount) !== 0) lumps.push({ date: middleDay(first, uncoveredTo), amount });
  }

  // The estimates the months reach over: to the first recorded day when
  // their last end is a month or less before it, else to that end.
  const enteredTo = entered[entered.length - 1].date;
  const joined = daysBetween(enteredTo, firstRecorded) <= JOINED_DAYS;
  const kept = points.filter((p) => !(p.estimated && (joined ? p.date < firstRecorded : p.date <= enteredTo)));
  return {
    points: [...entered, ...kept],
    flows: [...lumps, ...flows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    flows_from: startDay < from ? startDay : from,
    totals_from: from,
    counting,
    unused: null,
    applied: { from: startDay, first_recorded: firstRecorded, activity_from: from, entered_to: enteredTo, joined },
    differs,
  };
}

/**
 * The day all time counts from through the months (lib/growth-summary.ts,
 * components/AccountSparkline.tsx): their first day, when they apply and
 * start at $0.00 (when the account opened) and the person's totals can't
 * stand instead: none carried, and none unreadable. Else null.
 */
export function allTimeFromMonths(past: PastMonthsResult | null, totals: MoneyInOut | null | undefined, unreadable = false): string | null {
  if (!past?.applied || !past.counting || past.counting.start.balance !== 0 || unreadable) return null;
  return usableTotals(totals ?? null, past.totals_from) ? null : past.applied.from;
}

/** The months an import would stop counting if `next` counted instead: those
 *  the counting one has at either end that `next` doesn't. */
export function monthsDropped(
  now: MonthsImport | null,
  next: { start: { month: Month; balance?: number }; months: PastMonth[] }
): { before: { from: Month; to: Month } | null; after: { from: Month; to: Month } | null } {
  if (!now) return { before: null, after: null };
  // From each file's first month that counts: a file from $0.00 drops none
  // of the empty months before it.
  const a = { from: firstMonth(now), to: importSpan(now).to };
  const nextFrom = firstMonth(next);
  const nextTo = next.months[next.months.length - 1].month;
  return {
    before: a.from < nextFrom ? { from: a.from, to: previousMonth(nextFrom) < a.to ? previousMonth(nextFrom) : a.to } : null,
    after: a.to > nextTo ? { from: nextMonth(nextTo) > a.from ? nextMonth(nextTo) : a.from, to: a.to } : null,
  };
}

