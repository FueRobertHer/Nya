// lib/recurring.ts
//
// Recurring charges and deposits detected from transaction history: bills and
// subscriptions (Mint's "Bills" view) and income such as payroll, the cadence
// each repeats on, and when each is next expected. Pure functions, safe to
// import from client code and from the server, which sends the older history
// detection needs (olderRowsForDetection, app/api/transactions).
//
// WHAT COUNTS. A posted charge (a positive amount, Plaid's convention) is a
// candidate bill, and a posted deposit (negative) a candidate income. Money
// moved rather than spent or earned is never either (lib/spending.ts
// isMoneyMovement: transfers between your own accounts, cash taken out), and
// neither is a transaction the person excluded. Loan payments are bills (a
// mortgage is the classic one) and so is a bank's monthly fee, as before; a
// card payment received on the card's side is not income. Grouped by kind,
// account (its name at its institution), merchant and currency: the same
// subscription on two cards is two series, even at one bank, and an amount
// never adds up charges in two currencies (nothing is converted). Each series
// says which account it is on and the account's type, so the forecast can
// count only what leaves or reaches cash (lib/forecast.ts).
//
// CADENCES. Weekly, every two weeks, twice a month (two days of the month,
// such as the 1st and the 15th), every four weeks, monthly, every two months,
// every three months, twice a year and yearly. Each is a SCHEDULE: a fixed
// step in days (weekly, every two or four weeks), or one or two days of the
// month in every first, second, third, sixth or twelfth month. A schedule's
// day of the month is kept as banks keep it: a bill on the 31st falls on the
// 30th of a 30-day month and on the 28th or 29th of February, and is back on
// the 31st after.
//
// THE RULES, each with its reason. A merchant's charges recur on a cadence
// when they fit its schedule:
//   - a charge may land up to SPECS[c].tolerance days from its scheduled date
//     (2 for weekly up to 14 for yearly): weekends and holidays move a bank's
//     posting by a day or three, and a yearly renewal drifts a little;
//   - at least 75% of the merchant's charges in the window fit, one per
//     scheduled date: a merchant that also takes the odd extra charge (a gym's
//     smoothie bar) still has its membership found, while a shop visited on no
//     schedule (a grocery store, three times one week and none the next) fits
//     no cadence at all;
//   - at least 75% of the scheduled dates between the first and the last
//     fitting charge have one: a skipped month (a paused subscription, a bill
//     paid late into the next) is allowed, every other month is a different
//     cadence;
//   - their amounts agree, in one of two ways, each asking for its own amount
//     of evidence. THE SAME amount (the largest and smallest within 2% of
//     their median, or 50 cents: a subscription's price, a rent): 4 charges
//     for weekly and twice a month, 3 for the rest, and at those fewest
//     exactly the same, to the cent (a lunch spot's bills can come within 2%
//     three times by chance; a subscription's price is exact). A SIMILAR
//     amount (within 25% of the median, or 5 units of the currency: a utility
//     bill, a phone bill with its taxes): one charge more than that, since a
//     shop's spend can be similar by chance. Either way the one charge
//     farthest out among five or more is forgiven (a prorated first bill, a
//     bonus paycheck), and the amounts compared are the last year's. This is
//     the rule that keeps a store visited every week from being called a
//     bill: its timing may be weekly, its amounts are not;
//   - twice a year and yearly charges come too seldom to be judged on a
//     similar amount: they need the same amount, and three charges, or two
//     at exactly the same amount, to the cent, with nothing else from the
//     merchant in the window, at a merchant that isn't a restaurant, a shop
//     for food or a way of getting about (EVERYDAY): two visits a year apart
//     to a restaurant are not a bill;
//   - a PRICE CHANGE (a promotion ending, a plan upgraded) keeps the series:
//     charges at one amount and then, on the same schedule, at another, each
//     part agreeing within itself and one of them long enough to be a series.
//     The amount is the new one from its second charge (until then the new
//     charge is taken as a one-off), and a charge at a new amount always
//     counts for its date, so it is never also "not in yet";
//   - PAY that keeps its schedule closely (6 deposits or more, nearly every
//     scheduled date) may vary more (an hourly wage): the largest and smallest
//     within 60% of the median, once a tenth of them at the ends are left out.
//     Its amount is then the MEDIAN of the last half year's, which moves
//     little from one paycheck to the next; a raise to a new fixed amount is
//     followed as a price change is. Pay that keeps its schedule but varies
//     more than that is listed as VARYING: kept apart, so the forecast can
//     name it rather than drop it unseen.
// Evidence comes from a window before the merchant's latest charge (half a
// year for weekly, a year for most, longer for twice a year and yearly), so a
// bill is judged on what it has recently been. Where the window spans a change
// of schedule (a due date moved from the 5th to the 20th, a payroll moved from
// every two weeks to twice a month), the charges since the change are judged
// on their own, but only when those before it were a series by these rules
// too: a merchant visited at random whose last few visits happen to line up
// is not a bill.
//   A merchant whose charges don't agree as a whole (Apple billing iCloud and
//   a music plan under one name, Amazon's Prime among its orders) is split by
//   amount, and each run of exactly one amount, to the cent, is judged on its
//   own: a subscription repeats its price exactly, a shop's trips almost
//   never do. Such a run needs 4 charges or more, never fewer than its
//   cadence's own, and is never twice a year or yearly: at a merchant charged
//   that often, a few charges that line up are what chance gives. Its price
//   changing is followed once two charges in a row are at the new one.
// After the last charge that fit: one at the series' amount paid early (by
// more than the tolerance, at most twice it) stands for the date it was paid
// for, so it is never expected again on top of itself; an extra charge at
// another amount (a repair fee beside a water bill) is not taken for the next
// bill. A charge still pending counts for its date too: the forecast takes it
// off the balance it starts from, so it is not expected again. A deposit
// still pending does not count, as the forecast doesn't add it either.
//
// IDENTITY. A series' id is its group (kind, account, merchant, currency) and
// its amount when found. A dismissal ("not recurring", lib/planned.ts) saves
// that id and applies to the series of the same group nearest its amount
// (dismissedSeries), so it holds as amounts move, new charges come in and a
// series is found anew.
//
// DATES. Transaction dates are the bank's calendar days, so every date here is
// a calendar day, counted in whole days (UTC arithmetic on the date alone, so a
// daylight-saving change never makes a day 23 or 25 hours long). "Today" is the
// viewer's own day (lib/local-date.ts), passed in by callers.

import { currencyOf, isExcluded, isMoneyMovement } from './spending';
import { localDate } from './local-date';
import { toMinorUnits } from './manual-txn-input';

/** What detection reads of a transaction: the Activity tab's Txn, or a
 *  compact row of the history before it (olderRowsForDetection). */
export type RecurringRow = {
  date: string;
  name: string;
  amount: number;
  institution_name: string;
  category: string | null;
  /** Plaid's detail for the category, humanized ("credit card payment"). */
  subcategory?: string | null;
  transaction_code: string | null;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  /** Absent on a compact row, which is always posted. */
  pending?: boolean;
  excluded?: boolean | null;
  logo_url?: string | null;
  /** The account it was charged to or paid into, and Plaid's type for that
   *  account (depository for checking and savings, credit for a card, loan,
   *  investment), as /api/transactions sends them. */
  account_name?: string;
  account_type?: string | null;
};

export type Cadence =
  | 'weekly'
  | 'biweekly'
  | 'semimonthly'
  | 'four-weekly'
  | 'monthly'
  | 'bimonthly'
  | 'quarterly'
  | 'semiannual'
  | 'yearly';

export type RecurringKind = 'bill' | 'income';

/** How a series' amounts agree (THE RULES above): the same each time,
 *  similar, around a median (pay only), or varying more than the forecast can
 *  use (pay only, never forecast). */
export type Agreement = 'same' | 'similar' | 'median' | 'varies';

/**
 * When something is expected, as a run of dates from the first one: every
 * `every` days from `start`; or, by the month, on `days` (one day of the
 * month, or two for twice a month) of every `every`th month, from the
 * `slot`th of those days in `month` (YYYY-MM). A day past a month's end is its
 * last day.
 */
export type Schedule =
  | { unit: 'day'; every: number; start: string }
  | { unit: 'month'; every: number; days: number[]; month: string; slot: number };

export type RecurringSeries = {
  /** Its group and its amount when found (see IDENTITY): what "Not
   *  recurring" is saved under (lib/planned.ts). */
  id: string;
  /** Its kind, institution, account, merchant and currency. */
  group: string;
  kind: RecurringKind;
  name: string;
  institution: string;
  /** The account's name, empty when the rows didn't say. */
  account: string;
  /** The account's type (Plaid's: depository, credit, loan, investment), or
   *  null when the rows didn't say. */
  accountType: string | null;
  cadence: Cadence;
  /** The typical amount, positive whichever way the money goes: the median of
   *  the last three at its amount now (the latest of two), an amount actually
   *  charged; the median of the last half year's for pay around a median. */
  amount: number;
  agreement: Agreement;
  /** The amount before its latest price change, when it had one. */
  previousAmount?: number;
  /** It pays a card off (Plaid's "credit card payment"): the card's own
   *  charges are counted where they are charged, so a monthly total of bills
   *  leaves it out, while the forecast counts it, as the money leaving cash. */
  paysCard?: true;
  /** One per series (see the grouping above). */
  currency: string | null;
  /** The merchant's logo, if any charge in the series carried one. */
  logo_url: string | null;
  firstDate: string;
  /** The latest charge or deposit counted in the series. */
  lastDate: string;
  /** That latest charge is still pending. */
  pending?: true;
  /** The first date expected after it. */
  nextDate: string;
  /** How many posted charges or deposits the series was found from. */
  seen: number;
  /** Its dates from nextDate on. */
  schedule: Schedule;
};

// --- calendar days -----------------------------------------------------------

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a YYYY-MM-DD calendar day. */
export function dayNumber(iso: string): number {
  return Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS);
}

/** The YYYY-MM-DD calendar day of a day number. */
export function dayIso(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar day `days` later (earlier when negative). */
export function addDays(iso: string, days: number): string {
  return dayIso(dayNumber(iso) + days);
}

/** Months since the year 0: January 2026 is 2026 * 12. */
function monthIndex(iso: string): number {
  return Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
}

function monthIso(index: number): string {
  const y = Math.floor(index / 12);
  return `${y}-${String(index - y * 12 + 1).padStart(2, '0')}`;
}

/** The day number of day `day` of month `index`, or of its last day when the
 *  month is shorter: the 31st of April is April 30th. */
function dayOfMonth(index: number, day: number): number {
  const y = Math.floor(index / 12);
  const m = index - y * 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Math.round(Date.UTC(y, m, Math.min(day, last)) / DAY_MS);
}

/** Whether a calendar day is the last of its month. */
function isMonthEnd(iso: string): boolean {
  return addDays(iso, 1).slice(8, 10) === '01';
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

// --- the rules ---------------------------------------------------------------

type Spec = {
  unit: 'day' | 'month';
  /** Days (unit 'day') or months (unit 'month') between scheduled dates. */
  every: number;
  /** Days of the month in each scheduled month: 2 for twice a month. */
  anchors: 1 | 2;
  /** About how many days apart its charges are. */
  period: number;
  /** The typical gap between a merchant's charges (a skipped date counted as
   *  two gaps) that makes the cadence worth fitting at all: a cheap first
   *  sieve, not a rule of its own. */
  gaps: readonly [number, number];
  /** How many days from its scheduled date a charge may land. */
  tolerance: number;
  /** The fewest charges at the same amount that make a pattern. */
  minSeen: number;
  /** How many days before the latest charge the evidence is taken from. */
  window: number;
  /** Added to a fit's score: a cadence that is rarer, or freer to fit, must
   *  fit clearly better than a common one to be chosen over it. */
  prior: number;
};

const SPECS: Record<Cadence, Spec> = {
  weekly: { unit: 'day', every: 7, anchors: 1, period: 7, gaps: [5, 9], tolerance: 2, minSeen: 4, window: 182, prior: 0 },
  biweekly: { unit: 'day', every: 14, anchors: 1, period: 14, gaps: [11, 17], tolerance: 3, minSeen: 3, window: 245, prior: 0 },
  semimonthly: { unit: 'month', every: 1, anchors: 2, period: 365.25 / 24, gaps: [10, 20], tolerance: 3, minSeen: 4, window: 245, prior: 0.25 },
  'four-weekly': { unit: 'day', every: 28, anchors: 1, period: 28, gaps: [24, 32], tolerance: 3, minSeen: 3, window: 366, prior: 0.5 },
  monthly: { unit: 'month', every: 1, anchors: 1, period: 365.25 / 12, gaps: [24, 38], tolerance: 4, minSeen: 3, window: 366, prior: 0 },
  bimonthly: { unit: 'month', every: 2, anchors: 1, period: 365.25 / 6, gaps: [50, 72], tolerance: 6, minSeen: 3, window: 400, prior: 0.25 },
  quarterly: { unit: 'month', every: 3, anchors: 1, period: 365.25 / 4, gaps: [80, 102], tolerance: 7, minSeen: 3, window: 400, prior: 0 },
  semiannual: { unit: 'month', every: 6, anchors: 1, period: 365.25 / 2, gaps: [160, 205], tolerance: 10, minSeen: 3, window: 560, prior: 0 },
  yearly: { unit: 'month', every: 12, anchors: 1, period: 365.25, gaps: [340, 390], tolerance: 14, minSeen: 3, window: 800, prior: 0 },
};

/** Every cadence, in the order a tie between two equally good fits goes. */
export const CADENCES: readonly Cadence[] = [
  'monthly',
  'biweekly',
  'weekly',
  'semimonthly',
  'four-weekly',
  'quarterly',
  'yearly',
  'semiannual',
  'bimonthly',
];

/** Too seldom to be judged on a similar amount (see THE RULES). */
const SELDOM: ReadonlySet<Cadence> = new Set(['semiannual', 'yearly']);

/** Share of a merchant's charges in the window that must fit the schedule. */
const MIN_ON_SCHEDULE = 0.75;
/** Share of the scheduled dates between the first and the last fitting charge
 *  that must have one. */
const MIN_FILLED = 0.75;
/** The one amount farthest from the median is forgiven among this many. */
const OUTLIER_FROM = 5;
/** Pay around a median: this many deposits or more, filling this share of the
 *  scheduled dates. */
const MEDIAN_FEWEST = 6;
const MEDIAN_FILLED = 0.9;
/** A run of exactly one amount, at a merchant split by amount, needs this
 *  many charges or more. */
const RUN_FEWEST = 4;
/** How far back a median of pay looks, in days before its latest deposit. */
const MEDIAN_DAYS = 182;
/** Plaid's detail for paying a card off (as lib/fire/inputs.ts reads it). */
const CARD_PAYMENT = 'credit card payment';
/** Categories of everyday spending, where two visits a year apart at the
 *  same amount are chance, not a bill. */
const EVERYDAY: ReadonlySet<string> = new Set(['food and drink', 'transportation']);

/** How far back detection looks: two years and a little, so a yearly charge
 *  can be seen twice. The Activity tab loads one year; the server sends the
 *  rows before it that detection needs (olderRowsForDetection). */
export const RECURRING_LOOKBACK_DAYS = 800;

type AmountRule = { share: number; floor: number };
/** The same amount: a subscription's price, a rent. */
const SAME: AmountRule = { share: 0.02, floor: 0.5 };
/** A similar amount: a utility bill, a phone bill with its taxes. */
const SIMILAR: AmountRule = { share: 0.25, floor: 5 };
/** Pay that varies, around its median. */
const WIDE: AmountRule = { share: 0.6, floor: 5 };

// --- grouping ----------------------------------------------------------------

/** Whether a row can belong to a recurring series, and which way, pending or
 *  not. */
function rowKind(t: RecurringRow): RecurringKind | null {
  if (isExcluded(t) || isMoneyMovement(t)) return null;
  if (t.amount > 0) return 'bill';
  // A card payment received, on the card's side, settles purchases already
  // counted: it earns nothing.
  if (t.amount < 0 && t.category !== 'loan payments') return 'income';
  return null;
}

/** Whether a posted row can belong to a series, and which way. */
function kindOf(t: RecurringRow): RecurringKind | null {
  return t.pending ? null : rowKind(t);
}

function groupOf(t: RecurringRow, kind: RecurringKind): string {
  const name = t.name.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${kind}|${t.institution_name}|${t.account_name ?? ''}|${name}|${currencyOf(t) ?? ''}`;
}

/** The group a posted row belongs to, or null when it can't belong to a
 *  series. */
function groupKey(t: RecurringRow): string | null {
  const kind = kindOf(t);
  return kind ? groupOf(t, kind) : null;
}

// --- fitting a schedule ------------------------------------------------------

type Row = { day: number; month: number; amount: number; t: RecurringRow };

type Fit = {
  /** unit 'day': a scheduled day number. */
  phase: number;
  /** unit 'month': the scheduled months are those ≡ monthPhase (mod every). */
  monthPhase: number;
  /** unit 'month': the day(s) of the month, ascending. */
  days: number[];
  /** Each row's scheduled date (its slot), or null when none is near. */
  slots: (number | null)[];
  /** Each row's distance in days from its slot's date. */
  resid: number[];
  cost: number;
};

/** The day number of a slot under a fit. */
function slotDay(spec: Spec, fit: Fit, slot: number): number {
  if (spec.unit === 'day') return fit.phase + slot * spec.every;
  const q = Math.floor(slot / spec.anchors);
  return dayOfMonth(fit.monthPhase + q * spec.every, fit.days[slot - q * spec.anchors]);
}

/** Where each row falls under one choice of a schedule's parameters. */
function place(spec: Spec, rows: Row[], phase: number, monthPhase: number, days: number[]): Fit {
  const slots: (number | null)[] = [];
  const resid: number[] = [];
  let cost = 0;
  for (const r of rows) {
    let best = Infinity;
    let slot: number | null = null;
    if (spec.unit === 'day') {
      slot = Math.round((r.day - phase) / spec.every);
      best = Math.abs(r.day - (phase + slot * spec.every));
    } else {
      // The scheduled months around the row's own: a charge for the 1st can
      // post on the 30th before it, one for the 31st on the 2nd after.
      for (let m = r.month - 1; m <= r.month + 1; m++) {
        if (mod(m - monthPhase, spec.every) !== 0) continue;
        for (let j = 0; j < days.length; j++) {
          const d = Math.abs(r.day - dayOfMonth(m, days[j]));
          if (d < best) {
            best = d;
            slot = ((m - monthPhase) / spec.every) * spec.anchors + j;
          }
        }
      }
    }
    slots.push(slot);
    resid.push(best);
    // Capped, so one stray charge weighs no more than any other miss.
    cost += Math.min(best, spec.tolerance + 1);
  }
  return { phase, monthPhase, days, slots, resid, cost };
}

/** The schedule parameters that fit the rows best. The candidates come from
 *  the rows themselves (their place in the week, their day of the month),
 *  which is where the best fit under a sum of distances lies. */
function bestFit(spec: Spec, rows: Row[]): Fit {
  let best: Fit | null = null;
  const consider = (fit: Fit) => {
    if (!best || fit.cost < best.cost) best = fit;
  };
  if (spec.unit === 'day') {
    for (const phase of new Set(rows.map((r) => mod(r.day, spec.every)))) consider(place(spec, rows, phase, 0, []));
    return best!;
  }
  const anchorDays = new Set<number>();
  for (const r of rows) {
    anchorDays.add(Number(r.t.date.slice(8, 10)));
    // A month's last day may be a 31st, clamped.
    if (isMonthEnd(r.t.date)) anchorDays.add(31);
  }
  const sorted = [...anchorDays].sort((a, b) => a - b);
  const sets: number[][] = [];
  if (spec.anchors === 1) for (const d of sorted) sets.push([d]);
  else
    for (const a of sorted)
      for (const b of sorted)
        // Twice a month means about two weeks apart: the 1st and the 15th,
        // the 15th and the last day.
        if (b - a >= 10 && b - a <= 20) sets.push([a, b]);
  const phases = new Set<number>();
  for (const r of rows) for (const d of [-1, 0, 1]) phases.add(mod(r.month + d, spec.every));
  for (const monthPhase of phases) for (const days of sets) consider(place(spec, rows, 0, monthPhase, days));
  // No two days of the month two weeks apart: nothing is near any date.
  return best ?? place(spec, rows, 0, 0, []);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const cents = (n: number) => Math.round(n * 100);

/** Whether amounts agree under a rule: the largest and smallest within
 *  `share` of their median, or `floor` units, once the `drop` farthest from
 *  the median are left out (by default the one farthest among OUTLIER_FROM or
 *  more). */
function consistent(amounts: number[], rule: AmountRule, drop = amounts.length >= OUTLIER_FROM ? 1 : 0): boolean {
  if (amounts.length === 0) return false;
  const med = median(amounts);
  const use = drop > 0 ? [...amounts].sort((a, b) => Math.abs(a - med) - Math.abs(b - med)).slice(0, amounts.length - drop) : amounts;
  return Math.max(...use) - Math.min(...use) <= Math.max(med * rule.share, rule.floor);
}

/** Whether amounts are all exactly the same, to the cent. */
function exact(amounts: number[]): boolean {
  return amounts.every((a) => cents(a) === cents(amounts[0]));
}

/** Whether one amount agrees with a series' under a rule. */
function near(a: number, amount: number, rule: AmountRule): boolean {
  return Math.abs(a - amount) <= Math.max(amount * rule.share, rule.floor);
}

/** How a list of amounts agrees, the same or similar, or null. */
function agreeing(amounts: number[], drop?: number): 'same' | 'similar' | null {
  if (consistent(amounts, SAME, drop)) return 'same';
  if (consistent(amounts, SIMILAR, drop)) return 'similar';
  return null;
}

/** Where a series' charges come from: a merchant's charges as a whole, or a
 *  run of one amount among them (see THE RULES). */
type From = 'whole' | 'run';

/** The fewest charges a series needs, by how its amounts agree. */
function fewest(cadence: Cadence, agreement: Agreement, from: From): number {
  const spec = SPECS[cadence];
  if (from === 'run') return SELDOM.has(cadence) ? Infinity : Math.max(spec.minSeen, RUN_FEWEST);
  switch (agreement) {
    case 'same':
      return spec.minSeen;
    case 'similar':
      return SELDOM.has(cadence) ? Infinity : spec.minSeen + 1;
    default:
      return MEDIAN_FEWEST;
  }
}

type Found = {
  cadence: Cadence;
  spec: Spec;
  fit: Fit;
  /** The fitting rows, one per slot, oldest first. */
  kept: { row: Row; slot: number; resid: number }[];
  agreement: Agreement;
  /** The first kept charge at the amount now: 0 unless the price changed. */
  shift: number;
  score: number;
};

/** How the kept charges' amounts agree, and where their latest price begins,
 *  or null when they don't make a series (see THE RULES). `strong` is pay
 *  keeping its schedule closely. */
function judgeAmounts(
  cadence: Cadence,
  kept: Found['kept'],
  kind: RecurringKind,
  from: From,
  strong: boolean
): { agreement: Agreement; shift: number } | null {
  // The last year's, at least the last two.
  const last = kept[kept.length - 1].row.day;
  let start = kept.findIndex((k) => k.row.day >= last - 365);
  if (kept.length - start < 2) start = kept.length - 2;
  const amounts = kept.slice(start).map((k) => k.row.amount);
  // Enough charges for how they agree; at the fewest, the same amount means
  // exactly the same, to the cent.
  const enough = (agreement: Agreement, n: number, xs: number[]) => {
    const need = fewest(cadence, agreement, from);
    return n > need || (n === need && (agreement !== 'same' || exact(xs)));
  };

  if (from === 'run') return exact(amounts) && enough('same', kept.length, amounts) ? { agreement: 'same', shift: 0 } : null;

  // Pay keeping its schedule closely is taken around its median unless it is
  // the same each time (or the same at a new amount, a raise): a median of
  // the last half year moves little, where the last few paychecks swing.
  const steadyPay = kind === 'income' && strong;
  const all = agreeing(amounts);
  if (all === 'same' && enough('same', kept.length, amounts)) return { agreement: 'same', shift: 0 };
  if (all === 'similar' && !steadyPay && enough('similar', kept.length, amounts)) return { agreement: 'similar', shift: 0 };
  if (kept.length === 2 && SELDOM.has(cadence) && kind === 'bill' && exact(amounts)) {
    // Twice a year or yearly from two: exactly the same amount, nothing else
    // from the merchant in the window (judge saw only these two), and not
    // everyday spending.
    if (kept.every((k) => !EVERYDAY.has(k.row.t.category ?? ''))) return { agreement: 'same', shift: 0 };
  }
  if (!SELDOM.has(cadence)) {
    // A price change: the latest at one amount, those before at another, each
    // agreeing within itself, the new one two charges or more, and one part
    // long enough to be a series of its own (the old one counted with its
    // charges from before the year).
    for (let c = 1; c <= amounts.length - 2; c++) {
      const head = amounts.slice(0, c);
      const tail = amounts.slice(c);
      const before = agreeing(head, 0);
      const after = agreeing(tail, 0);
      if (!before || !after || (steadyPay && (before !== 'same' || after !== 'same'))) continue;
      if (enough(before, start + c, head) || enough(after, tail.length, tail)) return { agreement: after, shift: start + c };
    }
    // One charge at a new amount, the latest: the series is the others', and
    // the charge counts for its date.
    if (amounts.length >= 3 && !steadyPay) {
      const head = amounts.slice(0, -1);
      const rest = agreeing(head, 0);
      if (rest && enough(rest, kept.length - 1, head)) return { agreement: rest, shift: 0 };
    }
  }
  if (steadyPay) {
    const drop = Math.max(amounts.length >= OUTLIER_FROM ? 1 : 0, Math.ceil(amounts.length / 10));
    return { agreement: consistent(amounts, WIDE, drop) ? 'median' : 'varies', shift: 0 };
  }
  return null;
}

/** The rows that fit a schedule, one per scheduled date, judged by the rules
 *  in the header; null when they don't make a series. */
function judge(cadence: Cadence, rows: Row[], fit: Fit, kind: RecurringKind, from: From): Found | null {
  const spec = SPECS[cadence];
  const med = median(rows.map((r) => r.amount));
  const bySlot = new Map<number, number>();
  rows.forEach((r, i) => {
    const slot = fit.slots[i];
    if (slot === null || fit.resid[i] > spec.tolerance) return;
    const j = bySlot.get(slot);
    // Two charges for one date: the closer one, then the more typical amount,
    // then the later one. The other is an extra charge.
    if (
      j === undefined ||
      fit.resid[i] < fit.resid[j] ||
      (fit.resid[i] === fit.resid[j] && Math.abs(r.amount - med) <= Math.abs(rows[j].amount - med))
    )
      bySlot.set(slot, i);
  });
  const kept = [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([slot, i]) => ({ row: rows[i], slot, resid: fit.resid[i] }));
  if (kept.length < 2) return null;
  if (kept.length / rows.length < MIN_ON_SCHEDULE) return null;
  const filled = kept.length / (kept[kept.length - 1].slot - kept[0].slot + 1);
  if (filled < MIN_FILLED) return null;
  // Two charges make a series only with nothing else in the window.
  if (kept.length === 2 && rows.length > 2) return null;
  const strong = kept.length >= MEDIAN_FEWEST && filled >= MEDIAN_FILLED;
  const amounts = judgeAmounts(cadence, kept, kind, from, strong);
  if (!amounts) return null;
  const meanResid = kept.reduce((sum, k) => sum + k.resid, 0) / kept.length;
  // Varying pay only when nothing else fits.
  return { cadence, spec, fit, kept, ...amounts, score: meanResid + spec.prior + (amounts.agreement === 'varies' ? 100 : 0) };
}

/** The series a cadence makes of a merchant's rows (oldest first), or null.
 *  Judged on the window before the latest row and, where that spans a change
 *  of schedule, on the rows since it (see the header). */
function tryCadence(cadence: Cadence, all: Row[], kind: RecurringKind, from: From, allowChange = true): Found | null {
  const spec = SPECS[cadence];
  if (all.length < 2) return null;
  const latest = all[all.length - 1].day;
  const rows = all.filter((r) => r.day >= latest - spec.window);
  if (rows.length < 2) return null;
  // The sieve: the median gap, a skipped date's gap counted per date.
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const g = rows[i].day - rows[i - 1].day;
    gaps.push(g / Math.max(1, Math.round(g / spec.period)));
  }
  const g = median(gaps);
  if (g < spec.gaps[0] || g > spec.gaps[1]) return null;

  const whole = judge(cadence, rows, bestFit(spec, rows), kind, from);
  if ((whole && whole.agreement !== 'varies') || from === 'run' || !allowChange) return whole;
  // A change of schedule: the longest run of recent rows that is a series,
  // when the rows before it were a series too (any cadence's).
  for (let s = 2; rows.length - s >= 2; s++) {
    const after = rows.slice(s);
    const found = judge(cadence, after, bestFit(spec, after), kind, from);
    if (!found || found.agreement === 'varies') continue;
    const before = rows.slice(0, s);
    const wasSeries = CADENCES.some((c) => {
      const prior = tryCadence(c, before, kind, from, false);
      return prior !== null && prior.agreement !== 'varies';
    });
    if (wasSeries) return found;
  }
  return whole;
}

/** The cadence a merchant's rows (oldest first) recur on, the best fit. */
function bestCadence(rows: Row[], kind: RecurringKind, from: From): Found | null {
  let best: Found | null = null;
  for (const cadence of CADENCES) {
    const found = tryCadence(cadence, rows, kind, from);
    if (found && (!best || found.score < best.score)) best = found;
  }
  return best;
}

/** A merchant's charges of exactly one amount, to the cent, each oldest
 *  first, as many as a run needs or more. */
function exactRuns(rows: Row[]): Row[][] {
  const byAmount = new Map<number, Row[]>();
  for (const r of rows) {
    const c = cents(r.amount);
    const list = byAmount.get(c);
    if (list) list.push(r);
    else byAmount.set(c, [r]);
  }
  return [...byAmount.values()].filter((list) => list.length >= RUN_FEWEST);
}

/** The typical amount of charges (oldest first): the median of the last
 *  three (the latest of two); for pay around a median, of the last half
 *  year's. */
function typical(kept: Found['kept'], agreement: Agreement): number {
  if (agreement === 'median' || agreement === 'varies') {
    const last = kept[kept.length - 1].row.day;
    const recent = kept.filter((k) => k.row.day >= last - MEDIAN_DAYS);
    return median((recent.length >= 3 ? recent : kept).map((k) => k.row.amount));
  }
  const recent = kept.slice(-3).map((k) => k.row.amount);
  return recent.length >= 3 ? median(recent) : recent[recent.length - 1];
}

/** The series a fit makes. `all` is every posted row of its group (oldest
 *  first) and `pending` the group's pending charges, for what came after the
 *  last charge that fit (see the header). */
function toSeries(group: string, kind: RecurringKind, found: Found, from: From, all: Row[], pending: Row[]): RecurringSeries {
  const { spec, fit, kept, agreement, shift } = found;
  const latest = kept[kept.length - 1].row.t;
  const currency = currencyOf(latest);
  // A median of an even count is between two amounts: to the currency's
  // minor unit (the cent, the yen).
  const round = (n: number) => toMinorUnits(n, currency ?? 'USD');
  let amount = round(typical(kept.slice(shift), agreement));
  // A price it changed from, when it was charged at least twice (one first
  // charge apart is a prorated first bill).
  let previousAmount = shift >= 2 ? round(typical(kept.slice(0, shift), agreement)) : undefined;
  let lastSlot = kept[kept.length - 1].slot;
  let lastDay = kept[kept.length - 1].row.day;
  let seen = kept.length;
  let isPending = false;

  const tolerance = spec.tolerance;
  const rule = agreement === 'same' ? SAME : agreement === 'similar' ? SIMILAR : WIDE;
  const matches = (a: number) => (from === 'run' ? cents(a) === cents(amount) : near(a, amount, rule));
  const taken = new Set(kept.map((k) => k.row));
  const later = [...all.filter((r) => r.day > lastDay && !taken.has(r)), ...pending.filter((r) => r.day > lastDay)].sort((a, b) => a.day - b.day);
  const closest = (list: Row[], due: number) =>
    list.reduce<Row | null>((best, r) => (!best || Math.abs(r.day - due) < Math.abs(best.day - due) ? r : best), null);
  while (later.length > 0) {
    const due = slotDay(spec, fit, lastSlot + 1);
    // Early by up to twice the tolerance, or on time.
    const options = later.filter((r) => r.day > lastDay && r.day >= due - 2 * tolerance && r.day <= due + tolerance);
    if (options.length === 0) break;
    const onTime = options.filter((r) => Math.abs(r.day - due) <= tolerance);
    let pick = closest(
      options.filter((r) => matches(r.amount)),
      due
    );
    if (!pick && from === 'run') {
      // A new price two dates running, at a merchant split by amount.
      const next = slotDay(spec, fit, lastSlot + 2);
      const priced = onTime.find(
        (r) => !r.t.pending && later.some((q) => !q.t.pending && q.day > r.day && cents(q.amount) === cents(r.amount) && Math.abs(q.day - next) <= tolerance)
      );
      if (priced) {
        previousAmount = amount;
        amount = priced.amount;
        pick = priced;
      }
    }
    // A merchant of one series charging on time, still pending at another
    // amount: that date's charge.
    if (!pick && from === 'whole')
      pick = closest(
        onTime.filter((r) => r.t.pending),
        due
      );
    if (!pick) break;
    lastSlot += 1;
    lastDay = pick.day;
    if (pick.t.pending) isPending = true;
    else seen++;
  }

  const next = lastSlot + 1;
  const q = Math.floor(next / spec.anchors);
  const schedule: Schedule =
    spec.unit === 'day'
      ? { unit: 'day', every: spec.every, start: dayIso(slotDay(spec, fit, next)) }
      : { unit: 'month', every: spec.every, days: fit.days, month: monthIso(fit.monthPhase + q * spec.every), slot: next - q * spec.anchors };
  const withLogo = [...all].reverse().find((r) => r.t.logo_url);
  return {
    id: `${group}|${cents(amount)}`,
    group,
    kind,
    name: latest.name,
    institution: latest.institution_name,
    account: latest.account_name ?? '',
    accountType: latest.account_type ?? null,
    cadence: found.cadence,
    amount,
    agreement,
    ...(previousAmount !== undefined && cents(previousAmount) !== cents(amount) ? { previousAmount } : {}),
    ...(latest.subcategory === CARD_PAYMENT ? { paysCard: true as const } : {}),
    currency,
    logo_url: withLogo?.t.logo_url ?? null,
    firstDate: kept[0].row.t.date,
    lastDate: dayIso(lastDay),
    ...(isPending ? { pending: true as const } : {}),
    nextDate: dayIso(slotDay(spec, fit, next)),
    seen,
    schedule,
  };
}

const toRow = (t: RecurringRow): Row => ({ day: dayNumber(t.date), month: monthIndex(t.date), amount: Math.abs(t.amount), t });

/**
 * Every recurring series in the rows: bills first, then income, each largest
 * first. Rows may come in any order and may hold anything (pending, transfers,
 * excluded): what can't belong to a series is left out here.
 */
export function detectRecurring(txns: readonly RecurringRow[]): RecurringSeries[] {
  const groups = new Map<string, { kind: RecurringKind; posted: RecurringRow[]; pending: RecurringRow[] }>();
  for (const t of txns) {
    const kind = rowKind(t);
    // A deposit still pending doesn't count (see the header).
    if (!kind || (t.pending && kind !== 'bill')) continue;
    const key = groupOf(t, kind);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { kind, posted: [], pending: [] }));
    (t.pending ? g.pending : g.posted).push(t);
  }

  const out: RecurringSeries[] = [];
  const ids = new Set<string>();
  for (const [key, g] of groups) {
    if (g.posted.length < 2) continue;
    const rows = g.posted.map(toRow).sort((a, b) => a.day - b.day);
    const pending = g.pending.map(toRow);
    const found: { f: Found; from: From }[] = [];
    const whole = bestCadence(rows, g.kind, 'whole');
    const series = whole && whole.agreement !== 'varies' ? whole : null;
    if (series) found.push({ f: series, from: 'whole' });
    // Several subscriptions under one name: each run of one amount, among the
    // charges no series took. Not those from before the series began, which
    // are its own past (a schedule it changed from), not another series.
    const taken = new Set(series?.kept.map((k) => k.row) ?? []);
    const start = series ? series.kept[0].row.day : -Infinity;
    for (const run of exactRuns(rows.filter((r) => !taken.has(r) && r.day >= start))) {
      const f = bestCadence(run, g.kind, 'run');
      if (f) found.push({ f, from: 'run' });
    }
    // Pay that keeps its schedule at amounts too varied to forecast, listed
    // when nothing else was found.
    if (found.length === 0 && whole) found.push({ f: whole, from: 'whole' });
    for (const { f, from } of found) {
      const s = toSeries(key, g.kind, f, from, rows, pending);
      // Never two ids alike: a dismissal must name one series.
      let id = s.id;
      for (let n = 2; ids.has(id); n++) id = `${s.id}#${n}`;
      ids.add(id);
      out.push({ ...s, id });
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? b.amount - a.amount : a.kind === 'bill' ? -1 : 1));
}

// --- what comes next ---------------------------------------------------------

/** The dates a schedule names, from its first, up to and including `until`
 *  (at most `limit` of them). */
export function scheduleDates(schedule: Schedule, until: string, limit = 1000): string[] {
  const end = dayNumber(until);
  const out: string[] = [];
  if (schedule.unit === 'day') {
    for (let d = dayNumber(schedule.start); d <= end && out.length < limit; d += schedule.every) out.push(dayIso(d));
    return out;
  }
  let m = monthIndex(`${schedule.month}-01`);
  let j = schedule.slot;
  while (out.length < limit) {
    const d = dayOfMonth(m, schedule.days[j]);
    if (d > end) break;
    out.push(dayIso(d));
    j++;
    if (j >= schedule.days.length) {
      j = 0;
      m += schedule.every;
    }
  }
  return out;
}

/** The dates a schedule names from `from` through `until`, both included,
 *  skipping straight to `from` however far back the schedule starts. */
export function scheduleDatesBetween(schedule: Schedule, from: string, until: string, limit = 1000): string[] {
  const lo = dayNumber(from);
  let start = schedule;
  if (schedule.unit === 'day') {
    const first = dayNumber(schedule.start);
    if (first < lo) start = { ...schedule, start: dayIso(first + Math.ceil((lo - first) / schedule.every) * schedule.every) };
  } else {
    // Whole steps to the month before `from` (its dates can't reach `from`
    // from any earlier month), starting again at the first day of the month.
    const m = monthIndex(`${schedule.month}-01`);
    const target = monthIndex(from) - 1;
    if (target > m) start = { ...schedule, month: monthIso(m + Math.ceil((target - m) / schedule.every) * schedule.every), slot: 0 };
  }
  // The month before `from` and `from`'s own can hold four dates before it.
  return scheduleDates(start, until, limit + 4).filter((d) => d >= from).slice(0, limit);
}

/** A monthly schedule (every `every` months) on one date's day of the month,
 *  from that date: the 31st falls on each shorter month's last day. */
export function monthlyFrom(date: string, every: number): Schedule {
  return { unit: 'month', every, days: [Number(date.slice(8, 10))], month: date.slice(0, 7), slot: 0 };
}

/** How many days from its scheduled date a charge of the cadence is still on
 *  time. */
export function toleranceOf(cadence: Cadence): number {
  return SPECS[cadence].tolerance;
}

/** Scheduled dates gone by, each past its tolerance with nothing arriving,
 *  that end a series: two in a row for those that come monthly or more often,
 *  one for the rest. */
function missesToEnd(cadence: Cadence): number {
  return SPECS[cadence].period <= 31 ? 2 : 1;
}

export type Expected = {
  /** When it is expected: today for one that is late. */
  date: string;
  /** Its scheduled date. */
  due: string;
  /** Scheduled before today and not in yet, within the cadence's tolerance. */
  late: boolean;
};

/**
 * Where a series stands on `today` (the viewer's day), and the dates it is
 * expected on from today through `until`:
 *   - `ended` once missesToEnd scheduled dates went by, each past its
 *     tolerance, with nothing arriving; then no dates;
 *   - `late` while one scheduled before today is not in yet but still within
 *     its tolerance: it is expected today;
 *   - `due` otherwise. A scheduled date past its tolerance is taken as
 *     skipped, and the series goes on from the next.
 */
export function expectedDates(series: RecurringSeries, today: string, until: string): { status: 'due' | 'late' | 'ended'; dates: Expected[] } {
  const tolerance = SPECS[series.cadence].tolerance;
  const now = dayNumber(today);
  const end = dayNumber(until);
  const dates = scheduleDates(series.schedule, dayIso(Math.max(end, now)));
  let i = 0;
  while (i < dates.length && dayNumber(dates[i]) + tolerance < now) i++;
  if (i >= missesToEnd(series.cadence)) return { status: 'ended', dates: [] };
  const out: Expected[] = [];
  let late = false;
  for (; i < dates.length; i++) {
    const d = dayNumber(dates[i]);
    if (d < now) {
      late = true;
      if (now <= end) out.push({ date: today, due: dates[i], late: true });
    } else if (d <= end) out.push({ date: dates[i], due: dates[i], late: false });
  }
  return { status: late ? 'late' : 'due', dates: out };
}

/** The bills expected from today through `days` days on (the viewer's day,
 *  not UTC's), soonest first, each at its first expected date. Those the
 *  person said aren't recurring (the ids dismissedSeries gives) are left
 *  out. */
export function upcomingBills(
  series: readonly RecurringSeries[],
  days = 7,
  today: string = localDate(),
  dismissed: ReadonlySet<string> = new Set()
): ({ series: RecurringSeries } & Expected)[] {
  const until = addDays(today, days);
  return series
    .filter((s) => s.kind === 'bill' && !dismissed.has(s.id))
    .flatMap((s) => {
      const first = expectedDates(s, today, until).dates[0];
      return first ? [{ series: s, ...first }] : [];
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

/**
 * Which series the person said aren't recurring, each with the dismissal that
 * says so (see IDENTITY): a dismissal names a group and an amount, and applies
 * to the series of that group nearest the amount, each series and each
 * dismissal at most once.
 */
export function dismissedSeries(series: readonly RecurringSeries[], dismissed: readonly string[]): Map<string, string> {
  const byGroup = new Map<string, RecurringSeries[]>();
  for (const s of series) {
    const list = byGroup.get(s.group);
    if (list) list.push(s);
    else byGroup.set(s.group, [s]);
  }
  const pairs: { gap: number; id: string; entry: string }[] = [];
  for (const entry of dismissed) {
    const m = /^(.*)\|(\d+)(?:#\d+)?$/.exec(entry);
    if (!m) continue;
    const amount = Number(m[2]);
    for (const s of byGroup.get(m[1]) ?? []) pairs.push({ gap: Math.abs(cents(s.amount) - amount), id: s.id, entry });
  }
  pairs.sort((a, b) => a.gap - b.gap);
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.id) || used.has(p.entry)) continue;
    out.set(p.id, p.entry);
    used.add(p.entry);
  }
  return out;
}

const LABELS: Record<Cadence, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  'four-weekly': 'Every 4 weeks',
  monthly: 'Monthly',
  bimonthly: 'Every 2 months',
  quarterly: 'Every 3 months',
  semiannual: 'Twice a year',
  yearly: 'Yearly',
};

export function cadenceLabel(cadence: Cadence): string {
  return LABELS[cadence];
}

/** What a series comes to in an average month: a weekly $10 is about $43. */
export function perMonth(series: Pick<RecurringSeries, 'amount' | 'cadence'>): number {
  return (series.amount * 365.25) / 12 / SPECS[series.cadence].period;
}

/** The most rows a merchant may have in the stretch before the loaded year
 *  for them to be sent: a yearly or twice-yearly charge has one to three
 *  there. */
const OLDER_PER_MERCHANT = 3;
/** The most rows a merchant may have in the loaded year for its older rows to
 *  be sent: a yearly charge has one there, a twice-yearly one two. A merchant
 *  charged more often is judged on the loaded year alone, which holds every
 *  other cadence's window. */
const RECENT_PER_MERCHANT = 2;

/**
 * The rows from before the loaded year worth sending for detection: those
 * that could belong to a series (posted, not moved money, not excluded), of a
 * merchant charged in `recent` too (a series that stopped over a year ago is
 * nothing to expect) but at most `limits.recent` times, at most
 * `limits.older` times in `older`, and at the same amount as one of its
 * charges this year (within 2% or 50 cents). That is what twice-yearly and
 * yearly series need, since they need the same amount, and little else. The
 * server keeps a wider set with its cache, chosen before the person's
 * exclusions are applied, and narrows it after them.
 */
export function olderRowsForDetection<T extends RecurringRow>(
  recent: readonly RecurringRow[],
  older: readonly T[],
  limits: { recent: number; older: number } = { recent: RECENT_PER_MERCHANT, older: OLDER_PER_MERCHANT }
): T[] {
  const recentAmounts = new Map<string, number[]>();
  for (const t of recent) {
    const key = groupKey(t);
    if (!key) continue;
    const list = recentAmounts.get(key);
    if (list) list.push(Math.abs(t.amount));
    else recentAmounts.set(key, [Math.abs(t.amount)]);
  }
  const olderCounts = new Map<string, number>();
  for (const t of older) {
    const key = groupKey(t);
    if (key && recentAmounts.has(key)) olderCounts.set(key, (olderCounts.get(key) ?? 0) + 1);
  }
  return older.filter((t) => {
    const key = groupKey(t);
    if (!key) return false;
    const amounts = recentAmounts.get(key);
    const o = olderCounts.get(key);
    return (
      amounts !== undefined &&
      amounts.length <= limits.recent &&
      o !== undefined &&
      o <= limits.older &&
      amounts.some((a) => near(Math.abs(t.amount), a, SAME))
    );
  });
}
