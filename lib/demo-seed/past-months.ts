// lib/demo-seed/past-months.ts
//
// The months a scenario imports from its brokerage's own record
// (lib/investment-months.ts), made up: an investment account's month by
// month figures from the month it opened to last month, as Vanguard's
// Performance page lists them, written through the store the import route
// writes (lib/investment-months-store.ts addMonthsImport). Made to meet what
// the seed records, so the account's chart reads as one line:
//
// - A month Nya's activity covers has that activity's net, to the cent, so
//   none differs from it; a month before has the profile's monthly deposit.
// - A month that ends on or after the recorded year's first day ends at the
//   balance recorded on the next month's 1st (today's, for one ending today).
//   The month before ends where the recorded year starts, less what came in
//   from the 1st through that day. Each month before that is walked back through its net at a
//   market of its own (a seeded wander of about 7% a year), and the first
//   opens at $0, its net the transfer that opened the account.
//
// checkPastMonths runs the months, as made from the profile's own balances,
// through the app's own join (withPastMonths) before anything is emptied:
// they must be used, joined straight on to the recorded year, and differ
// from no month of the activity.

import type { Ctx } from '../containers';
import { isVanguard, lastDayOf, nextMonth, parseMonthsChange, withPastMonths, type Month, type PastMonth } from '../investment-months';
import { addMonthsImport } from '../investment-months-store';
import type { BalancePoint, Flow } from '../growth';
import { RECORDED_DAYS, recordedYear, type MeasuredAccount, type RecordedDay } from './recorded';
import { addDays, rng, type DemoProfile, type SeedAccount } from './profiles';
import type { SeedExtras } from './extras';
import type { SeedRun } from './fill';

type Spec = NonNullable<SeedExtras['investmentMonths']>;
type Made = { start: { month: Month; balance: number }; months: PastMonth[] };

const USD = 'USD';
const toCents = (n: number) => Math.round(n * 100);

/** The month before 'YYYY-MM'. */
function prevMonth(m: Month): Month {
  const y = Number(m.slice(0, 4));
  const n = Number(m.slice(5));
  return n === 1 ? `${y - 1}-12` : `${y}-${String(n - 1).padStart(2, '0')}`;
}

/** The account's deposits and withdrawals, by day: a cash row's quantity is
 *  -1 for money in, 1 for money out. */
export function flowsOf(a: SeedAccount): Flow[] {
  return (a.investment_transactions ?? []).filter((t) => t.type === 'cash').map((t) => ({ date: t.date, amount: t.quantity < 0 ? t.price : -t.price }));
}

/** The day the account's activity starts, or null with none. */
const activityFrom = (a: SeedAccount): string | null => (a.investment_transactions ?? []).map((t) => t.date).sort()[0] ?? null;

/** What came in and went out on the days from `from` to before `to`. */
const flowedIn = (flows: readonly Flow[], from: string, to: string) => flows.reduce((n, f) => (f.date >= from && f.date < to ? n + toCents(f.amount) : n), 0);

/**
 * The months, from the month `spec` opens to last month. `valueOn` is the
 * account's balance on a day of the recorded year, or today's for today;
 * `seed` the market's own wander.
 */
export function pastMonths(a: SeedAccount, spec: Spec, today: string, valueOn: (day: string) => number | undefined, seed: number): Made {
  const last = prevMonth(today.slice(0, 7));
  const list: Month[] = [last];
  while (list.length < spec.openedMonthsBack) list.unshift(prevMonth(list[0]));
  const firstRecorded = addDays(today, -RECORDED_DAYS);
  const from = activityFrom(a);
  if (!from) throw new Error(`The account ending ${a.mask} has no activity to import months beside`);
  const flows = flowsOf(a);
  const net = list.map((m) => (lastDayOf(m) < from ? toCents(spec.monthlyBefore) : flowedIn(flows, `${m}-01`, addDays(lastDayOf(m), 1))));
  const endDay = (m: Month) => `${nextMonth(m)}-01`;

  // The ends the recorded year gives, and the last before it.
  const ends: number[] = new Array(list.length).fill(0);
  let joinAt = -1;
  for (let i = 0; i < list.length; i++) {
    const day = endDay(list[i]);
    if (day < firstRecorded) {
      joinAt = i;
      continue;
    }
    const value = valueOn(day);
    if (value === undefined) throw new Error(`No recorded balance for ${a.mask} on ${day}`);
    ends[i] = toCents(value);
  }
  if (joinAt < 1) throw new Error(`The months for ${a.mask} must reach back before the recorded year`);
  const atFirst = valueOn(firstRecorded);
  if (atFirst === undefined) throw new Error(`No recorded balance for ${a.mask} on ${firstRecorded}`);
  // The recorded balance holds that day's own flows, as a month's end does
  // its last day's: so they come off too.
  ends[joinAt] = toCents(atFirst) - flowedIn(flows, endDay(list[joinAt]), addDays(firstRecorded, 1));

  // Walked back at a market of its own, the first opening at $0.
  const r = rng(seed);
  const rate = () => 0.0057 + (r() - 0.5) * 0.05;
  for (let i = joinAt; i >= 1; i--) {
    const begin = Math.round((ends[i] - net[i]) / (1 + rate()));
    if (begin <= 0) throw new Error(`The months for ${a.mask} reach back past what the account held: open it later or pay in less before its activity`);
    ends[i - 1] = begin;
  }
  net[0] = ends[0] - Math.round((ends[0] * rate()) / 2);

  let prev = 0;
  const months = list.map((month, i) => {
    const m = { month, net: net[i] / 100, returns: (ends[i] - prev - net[i]) / 100, end: ends[i] / 100 };
    prev = ends[i];
    return m;
  });
  return { start: { month: list[0], balance: 0 }, months };
}

/** The request the import route takes, for the months made. */
const importOf = (account_id: string, spec: Spec, made: Made) => {
  const change = parseMonthsChange({ action: 'import', account_id, file_name: spec.file_name, start: made.start, months: made.months, currency: USD, typed: [], counting: null });
  if (typeof change === 'string' || change.action !== 'import') throw new Error(`The months for the account ending ${spec.mask} are refused: ${String(change)}`);
  return change;
};

/** The account with imported months, and its institution. */
function accountOf(profile: DemoProfile, spec: Spec): { a: SeedAccount; institution_id: string } {
  for (const inst of profile.institutions) for (const a of inst.accounts) if (a.mask === spec.mask) return { a, institution_id: inst.institution_id };
  throw new Error(`No account ending ${spec.mask} for its imported months`);
}

/** The market's wander for a profile's months. */
const seedOf = (profile: DemoProfile) => [...`${profile.name} months`].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 11);

/** The balance on a day: the recorded year's, or today's. */
function valuesOf(days: readonly RecordedDay[], today: string, account_id: string, balance: number | undefined): (day: string) => number | undefined {
  const byDay = new Map(days.map((d) => [d.date, d.accounts[account_id]]));
  return (day) => (day >= today ? balance : byDay.get(day));
}

/**
 * Refuses months the app wouldn't use as the scenario means them: at an
 * account at Vanguard with activity, made from the profile's own balances
 * (as the recorded year is, with stand-in ids) and joined as the app joins
 * them. Changes nothing.
 */
export function checkPastMonths(profile: DemoProfile, today: string): void {
  const spec = profile.extras?.investmentMonths;
  if (!spec) return;
  const { a, institution_id } = accountOf(profile, spec);
  if (!isVanguard(institution_id)) throw new Error(`Imported months are Vanguard's: the account ending ${spec.mask} isn't at Vanguard`);
  if (a.type !== 'investment') throw new Error(`Imported months are an investment account's: ${spec.mask} isn't one`);
  const ids = new Map(profile.institutions.flatMap((i) => i.accounts.map((x) => [x.mask, `seed-${x.mask}`] as const)));
  const measured: MeasuredAccount[] = profile.institutions.flatMap((i) => i.accounts.map((x) => ({ account_id: ids.get(x.mask)!, type: x.type, balance: x.balance })));
  const id = ids.get(spec.mask)!;
  const days = recordedYear(profile, today, measured, ids, new Map());
  const change = importOf(id, spec, pastMonths(a, spec, today, valuesOf(days, today, id, a.balance), seedOf(profile)));

  const points: BalancePoint[] = [...days.map((d) => ({ date: d.date, value: d.accounts[id] })), { date: today, value: a.balance }];
  const flows = flowsOf(a);
  const joined = withPastMonths(points, { flows, flows_from: activityFrom(a), flows_to: today, moves: [] }, { imports: [{ id: 'seed-check', source: 'vanguard-performance', file_name: change.file_name, imported_at: `${today}T00:00:00.000Z`, start: change.start, months: change.months, currency: change.currency }] }, USD);
  if (joined.unused) throw new Error(`The months for ${spec.mask} wouldn't be used (${joined.unused})`);
  if (!joined.applied?.joined) throw new Error(`The months for ${spec.mask} don't meet the recorded year`);
  if (joined.differs.length > 0) throw new Error(`The months for ${spec.mask} differ from its activity in ${joined.differs.map((d) => d.month).join(', ')}`);
}

/**
 * Imports the months, made from what today's load measured and the recorded
 * year, as the route imports a file. Passed over, and said, when the load
 * didn't measure the account, or measured a balance they can't be made from
 * (checked from the profile's own before anything was emptied, so only a
 * bank that answered other than as asked): the rest of the reset still runs.
 */
export async function writePastMonths(run: SeedRun, days: readonly RecordedDay[], measured: readonly MeasuredAccount[]): Promise<void> {
  const spec = run.profile.extras?.investmentMonths;
  if (!spec) return;
  const id = run.accountIds.get(spec.mask)!;
  const balance = measured.find((m) => m.account_id === id)?.balance;
  if (balance === undefined) {
    run.skipped.push(`the months imported for the account ending ${spec.mask}, since today's load didn't measure it`);
    return;
  }
  const { a } = accountOf(run.profile, spec);
  let change: ReturnType<typeof importOf>;
  try {
    change = importOf(id, spec, pastMonths(a, spec, run.today, valuesOf(days, run.today, id, balance), seedOf(run.profile)));
  } catch (err) {
    run.skipped.push(`the months imported for the account ending ${spec.mask}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await addMonthsImport(
    run.ctx,
    id,
    { id: crypto.randomUUID(), source: 'vanguard-performance', file_name: change.file_name, imported_at: new Date().toISOString(), start: change.start, months: change.months, currency: change.currency },
    null
  );
}
