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
// institution, merchant and currency: the same subscription on two linked
// institutions is not read as twice a month, and an amount never adds up
// charges in two currencies (nothing is converted).
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
//   - enough of them to be a pattern: 4 for weekly and twice a month, 3 for
//     most, 2 for twice a year and yearly (two years of history hold a yearly
//     charge twice at most);
//   - a consistent amount: the largest and smallest of the fitting charges
//     of the last year (at least the last two) differ by at most 25% of their
//     median, or 5 units of the currency for a small subscription whose tax
//     moves by cents, forgiving the one farthest out among five or more (a
//     bonus paycheck, a prorated first bill). This is the rule that keeps a store visited every week from
//     being called a bill: its timing may be weekly, its amounts are not.
// Evidence comes from a window before the merchant's latest charge (half a
// year for weekly, a year for most, longer for twice a year and yearly), so a
// bill is judged on what it has recently been. Where the window spans a change
// of schedule (a due date moved from the 5th to the 20th, a payroll moved from
// every two weeks to twice a month), the charges since the change are judged
// on their own, but only when those before it kept a schedule too: a merchant
// visited at random whose last few visits happen to line up is not a bill.
//   A merchant whose charges don't agree as a whole (Apple billing iCloud and
//   a music plan under one name, with the odd app besides) is split by amount,
//   and each run of the SAME amount (within 2%, or 50 cents) is judged on its
//   own: a subscription repeats its price exactly, a shop's trips don't. So
//   are the charges left over beside a series found.
// A charge of a series' amount that fits no scheduled date but came after the
// last one that did (a bill paid a week early) counts for the date nearest
// it, so it is never expected again on top of itself.
//
// DATES. Transaction dates are the bank's calendar days, so every date here is
// a calendar day, counted in whole days (UTC arithmetic on the date alone, so a
// daylight-saving change never makes a day 23 or 25 hours long). "Today" is the
// viewer's own day (lib/local-date.ts), passed in by callers.

import { currencyOf, isExcluded, isMoneyMovement } from './spending';
import { localDate } from './local-date';

/** What detection reads of a transaction: the Activity tab's Txn, or a
 *  compact row of the history before it (olderRowsForDetection). */
export type RecurringRow = {
  date: string;
  name: string;
  amount: number;
  institution_name: string;
  category: string | null;
  transaction_code: string | null;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  /** Absent on a compact row, which is always posted. */
  pending?: boolean;
  excluded?: boolean | null;
  logo_url?: string | null;
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
  /** Stable while the series is: what "Not recurring" is saved under
   *  (lib/planned.ts). Its kind, institution, merchant and currency, and its
   *  amount when the merchant's charges were split by amount. */
  id: string;
  kind: RecurringKind;
  name: string;
  institution: string;
  cadence: Cadence;
  /** The typical amount, positive whichever way the money goes: the median of
   *  the last three (the latest of two), an amount actually charged. */
  amount: number;
  /** One per series (see the grouping above). */
  currency: string | null;
  /** The merchant's logo, if any charge in the series carried one. */
  logo_url: string | null;
  firstDate: string;
  /** The latest charge or deposit counted in the series. */
  lastDate: string;
  /** The first date expected after it. */
  nextDate: string;
  /** How many charges or deposits the series was found from. */
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
  /** The fewest fitting charges that make a pattern. */
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
  semiannual: { unit: 'month', every: 6, anchors: 1, period: 365.25 / 2, gaps: [160, 205], tolerance: 10, minSeen: 2, window: 560, prior: 0 },
  yearly: { unit: 'month', every: 12, anchors: 1, period: 365.25, gaps: [340, 390], tolerance: 14, minSeen: 2, window: 800, prior: 0 },
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

/** Share of a merchant's charges in the window that must fit the schedule. */
const MIN_ON_SCHEDULE = 0.75;
/** Share of the scheduled dates between the first and the last fitting charge
 *  that must have one. */
const MIN_FILLED = 0.75;
/** A consistent amount: within this share of the median... */
const AMOUNT_SPREAD = 0.25;
/** ...or within this many units of the currency, for small subscriptions. */
const AMOUNT_FLOOR = 5;
/** The one amount farthest from the median is forgiven among this many. */
const OUTLIER_FROM = 5;
/** A run of the same amount, when a merchant's charges are split by amount. */
const SAME_AMOUNT_SPREAD = 0.02;
const SAME_AMOUNT_FLOOR = 0.5;

/** How far back detection looks: two years and a little, so a yearly charge
 *  can be seen twice. The Activity tab loads one year; the server sends the
 *  rows before it that detection needs (olderRowsForDetection). */
export const RECURRING_LOOKBACK_DAYS = 800;
/** The most rows a merchant may have in the stretch before the loaded year
 *  for them to be sent: a yearly or twice-yearly charge has one to three
 *  there, and a merchant charged more often is judged on the loaded year
 *  alone, which holds every other cadence's window. */
const OLDER_PER_MERCHANT = 3;

type AmountRule = { share: number; floor: number };
const AMOUNT_RULE: AmountRule = { share: AMOUNT_SPREAD, floor: AMOUNT_FLOOR };
const SAME_AMOUNT_RULE: AmountRule = { share: SAME_AMOUNT_SPREAD, floor: SAME_AMOUNT_FLOOR };

// --- grouping ----------------------------------------------------------------

/** Whether a row can belong to a recurring series, and which way. */
function kindOf(t: RecurringRow): RecurringKind | null {
  if (t.pending || isExcluded(t) || isMoneyMovement(t)) return null;
  if (t.amount > 0) return 'bill';
  // A card payment received, on the card's side, settles purchases already
  // counted: it earns nothing.
  if (t.amount < 0 && t.category !== 'loan payments') return 'income';
  return null;
}

/** The group a row belongs to, or null when it can't belong to a series. */
function groupKey(t: RecurringRow): string | null {
  const kind = kindOf(t);
  if (!kind) return null;
  const name = t.name.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${kind}|${t.institution_name}|${name}|${currencyOf(t) ?? ''}`;
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

/** Whether amounts agree: within `share` of their median, or `floor` units,
 *  forgiving the one farthest out among OUTLIER_FROM or more. */
function consistent(amounts: number[], rule: AmountRule): boolean {
  if (amounts.length === 0) return false;
  const med = median(amounts);
  let use = amounts;
  if (amounts.length >= OUTLIER_FROM) {
    let far = 0;
    for (let i = 1; i < amounts.length; i++) if (Math.abs(amounts[i] - med) > Math.abs(amounts[far] - med)) far = i;
    use = amounts.filter((_, i) => i !== far);
  }
  return Math.max(...use) - Math.min(...use) <= Math.max(med * rule.share, rule.floor);
}

type Found = {
  cadence: Cadence;
  spec: Spec;
  fit: Fit;
  /** The fitting rows, one per slot, oldest first. */
  kept: { row: Row; slot: number; resid: number }[];
  score: number;
};

/** The rows that fit a schedule, one per scheduled date, judged by the rules
 *  in the header; null when they don't make a series. With `rule` their
 *  amounts must agree too; without, only whether they keep a schedule. */
function judge(cadence: Cadence, rows: Row[], fit: Fit, rule: AmountRule | null): Found | null {
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
  if (kept.length < spec.minSeen) return null;
  if (kept.length / rows.length < MIN_ON_SCHEDULE) return null;
  if (kept.length / (kept[kept.length - 1].slot - kept[0].slot + 1) < MIN_FILLED) return null;
  if (rule) {
    const last = kept[kept.length - 1].row.day;
    let recent = kept.filter((k) => k.row.day >= last - 365);
    if (recent.length < 2) recent = kept.slice(-2);
    if (!consistent(recent.map((k) => k.row.amount), rule)) return null;
  }
  const meanResid = kept.reduce((sum, k) => sum + k.resid, 0) / kept.length;
  return { cadence, spec, fit, kept, score: meanResid + spec.prior };
}

/** The series a cadence makes of a merchant's rows (oldest first), or null.
 *  Judged on the window before the latest row and, where that spans a change
 *  of schedule, on the rows since it (see the header). */
function tryCadence(cadence: Cadence, all: Row[], rule: AmountRule | null, allowChange: boolean): Found | null {
  const spec = SPECS[cadence];
  if (all.length < spec.minSeen) return null;
  const latest = all[all.length - 1].day;
  const rows = all.filter((r) => r.day >= latest - spec.window);
  if (rows.length < spec.minSeen) return null;
  // The sieve: the median gap, a skipped date's gap counted per date.
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const g = rows[i].day - rows[i - 1].day;
    gaps.push(g / Math.max(1, Math.round(g / spec.period)));
  }
  const g = median(gaps);
  if (g < spec.gaps[0] || g > spec.gaps[1]) return null;

  const whole = judge(cadence, rows, bestFit(spec, rows), rule);
  if (whole || !allowChange) return whole;
  // A change of schedule: the longest run of recent rows that fits, when the
  // rows before it kept a schedule of their own (any cadence's).
  for (let s = 2; rows.length - s >= spec.minSeen; s++) {
    const after = rows.slice(s);
    const found = judge(cadence, after, bestFit(spec, after), rule);
    if (!found) continue;
    const before = rows.slice(0, s);
    if (CADENCES.some((c) => tryCadence(c, before, null, false))) return found;
  }
  return null;
}

/** The cadence a merchant's rows (oldest first) recur on, the best fit. */
function bestCadence(rows: Row[], rule: AmountRule): Found | null {
  let best: Found | null = null;
  for (const cadence of CADENCES) {
    const found = tryCadence(cadence, rows, rule, true);
    if (found && (!best || found.score < best.score)) best = found;
  }
  return best;
}

/** Rows split into runs of the same amount (see the header), each oldest
 *  first, with two rows or more. */
function sameAmountRuns(rows: Row[]): Row[][] {
  const byAmount = [...rows].sort((a, b) => a.amount - b.amount);
  const runs: Row[][] = [];
  let run: Row[] = [];
  for (const r of byAmount) {
    const prev = run[run.length - 1];
    if (prev && r.amount - prev.amount <= Math.max(prev.amount * SAME_AMOUNT_SPREAD, SAME_AMOUNT_FLOOR)) run.push(r);
    else {
      if (run.length >= 2) runs.push(run);
      run = [r];
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs.map((r) => r.sort((a, b) => a.day - b.day));
}

/** The series a fit makes, given every row it was found among (oldest
 *  first). */
function toSeries(id: string, kind: RecurringKind, found: Found, rows: Row[]): RecurringSeries {
  const { spec, fit, kept } = found;
  const recent = kept.slice(-3).map((k) => k.row.amount);
  const amount = recent.length >= 3 ? median(recent) : recent[recent.length - 1];
  let lastSlot = kept[kept.length - 1].slot;
  let lastDay = kept[kept.length - 1].row.day;
  let seen = kept.length;
  // A charge of the series' amount after the last that fit (early, or late
  // past the tolerance) counts for the scheduled date nearest it, within half
  // a period of it.
  const within = Math.max(amount * AMOUNT_SPREAD, AMOUNT_FLOOR);
  for (const r of rows) {
    if (r.day <= lastDay || Math.abs(r.amount - amount) > within) continue;
    let slot = lastSlot + 1;
    while (slotDay(spec, fit, slot + 1) - r.day < r.day - slotDay(spec, fit, slot)) slot++;
    if (Math.abs(r.day - slotDay(spec, fit, slot)) > spec.period / 2) continue;
    lastSlot = slot;
    lastDay = r.day;
    seen++;
  }
  const next = lastSlot + 1;
  const q = Math.floor(next / spec.anchors);
  const schedule: Schedule =
    spec.unit === 'day'
      ? { unit: 'day', every: spec.every, start: dayIso(slotDay(spec, fit, next)) }
      : { unit: 'month', every: spec.every, days: fit.days, month: monthIso(fit.monthPhase + q * spec.every), slot: next - q * spec.anchors };
  const latest = kept[kept.length - 1].row.t;
  const withLogo = [...rows].reverse().find((r) => r.t.logo_url);
  return {
    id,
    kind,
    name: latest.name,
    institution: latest.institution_name,
    cadence: found.cadence,
    amount,
    currency: currencyOf(latest),
    logo_url: withLogo?.t.logo_url ?? null,
    firstDate: kept[0].row.t.date,
    lastDate: dayIso(lastDay),
    nextDate: dayIso(slotDay(spec, fit, next)),
    seen,
    schedule,
  };
}

/**
 * Every recurring series in the rows: bills first, then income, each largest
 * first. Rows may come in any order and may hold anything (pending, transfers,
 * excluded): what can't belong to a series is left out here.
 */
export function detectRecurring(txns: readonly RecurringRow[]): RecurringSeries[] {
  const groups = new Map<string, RecurringRow[]>();
  for (const t of txns) {
    const key = groupKey(t);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const out: RecurringSeries[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const kind = kindOf(list[0])!;
    const rows = list
      .map((t) => ({ day: dayNumber(t.date), month: monthIndex(t.date), amount: Math.abs(t.amount), t }))
      .sort((a, b) => a.day - b.day);
    const whole = bestCadence(rows, AMOUNT_RULE);
    if (whole) out.push(toSeries(key, kind, whole, rows));
    // Several subscriptions under one name: each run of one amount, among the
    // charges no series took. Not those from before the series began, which
    // are its own past (a schedule it changed from), not another series.
    const taken = new Set(whole?.kept.map((k) => k.row) ?? []);
    const from = whole ? whole.kept[0].row.day : -Infinity;
    const rest = rows.filter((r) => !taken.has(r) && r.day >= from);
    if (whole && rest.length < 2) continue;
    for (const run of sameAmountRuns(rest)) {
      const found = bestCadence(run, SAME_AMOUNT_RULE);
      if (found) out.push(toSeries(`${key}|${Math.round(found.kept[found.kept.length - 1].row.amount * 100)}`, kind, found, run));
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
 *  person said aren't recurring (lib/planned.ts) are left out. */
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

/**
 * The rows from before the loaded year worth sending for detection: those
 * that could belong to a series (posted, not moved money, not excluded), from
 * a merchant that charged in `recent` too (a series that stopped over a year
 * ago is nothing to expect) and at most OLDER_PER_MERCHANT times in `older`.
 * That is what twice-yearly and yearly series need, and little else.
 */
export function olderRowsForDetection<T extends RecurringRow>(recent: readonly RecurringRow[], older: readonly T[]): T[] {
  const keys = new Set<string>();
  for (const t of recent) {
    const key = groupKey(t);
    if (key) keys.add(key);
  }
  const counts = new Map<string, number>();
  for (const t of older) {
    const key = groupKey(t);
    if (key && keys.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return older.filter((t) => {
    const key = groupKey(t);
    const n = key ? counts.get(key) : undefined;
    return n !== undefined && n <= OLDER_PER_MERCHANT;
  });
}
