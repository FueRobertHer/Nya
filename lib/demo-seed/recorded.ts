// lib/demo-seed/recorded.ts
//
// A year of recorded balances for a seeded account, as if Nya's daily
// snapshot had run every day of it, and the plan it said was its plan some
// months back. Without them a reset leaves the returns line, Investments'
// ranges, Progress against your plan and Allocation over time blank until
// days pass, and the sandbox's balances don't move, so the days that follow
// are flat.
//
// EACH DAY, from today − 365 to yesterday, worked back from the balances
// Plaid gave today (so nothing steps where the recorded year meets today's
// point), with the profile's rows:
//
// - an account with rows (a bank account, a card, a loan, a manual account)
//   walked back through the rows posted after the day, as the net-worth
//   backfill walks one;
// - an investment account by what it held then (each fund's quantity before
//   the buys and sells after the day, its cash before the deposits and
//   withdrawals) at the prices then: the market about 12% lower a year back,
//   as Portfolio priced the buys (lib/demo-seed/profiles.ts marketOn), with a
//   little seeded wander so the line isn't straight. Today's balance times
//   that day's worth over today's;
// - any other held flat (a hidden account, an ended one, the HSA).
//
// Each day's map holds every account's raw balance, as a snapshot records it
// (owed positive), and its total is their sum by signedContribution, hidden,
// ended and manual accounts included, as computeNetWorth sums them. The days
// replace the backfill's estimates, so no seeded demo shows dashed estimated
// history (a new connection still does). Holdings are recorded once a month
// on the same terms, for Allocation over time.
//
// Pure but for writeRecordedYear and writeHoldingsMonths.

import type { Ctx } from '../containers';
import { signedContribution } from '../balance';
import { restoreHistoryDays } from '../history';
import { recordHoldings, type HoldingsObservation, type Position } from '../holdings-history';
import type { InstitutionResult } from '../networth';
import { savedPlanStore } from '../saved-plan';
import type { FirePlanV2 } from '../fire/plan-v2';
import { addDays, historyMonths, lastDay, marketOn, rng, round2, type DemoProfile, type SeedAccount, type SeedHolding, type SeedInvTxn } from './profiles';

/** One recorded day: every account's raw balance, and the total. */
export type RecordedDay = { date: string; accounts: Record<string, number>; total: number };

/** An account as today's load measured it. */
export type MeasuredAccount = { account_id: string; type: string; balance: number };

/** Days of the recorded year. */
export const RECORDED_DAYS = 365;
const CASH = 'CUR:USD';

/** The market's wander about its trend, by days back from today (0 today):
 *  a seeded walk that drifts back toward the trend, a percent or two either
 *  side, the same for every account of a profile. */
export function wander(seed: number, days: number): number[] {
  const r = rng(seed);
  const out = [0];
  for (let k = 1; k <= days; k++) out.push(0.96 * out[k - 1] + (r() * 2 - 1) * 0.008);
  return out;
}

/** A seed from a profile's name, so each profile wanders its own way. */
const seedOf = (name: string) => [...name].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** What an investment account held on `day`: each fund's quantity and its
 *  cash, before the activity after that day. */
function heldOn(holdings: readonly SeedHolding[], txns: readonly SeedInvTxn[], day: string): { quantities: Map<string, number>; cash: number } {
  const quantities = new Map<string, number>();
  let cash = 0;
  for (const h of holdings) {
    if (h.ticker === CASH) cash += h.quantity;
    else quantities.set(h.ticker, (quantities.get(h.ticker) ?? 0) + h.quantity);
  }
  for (const t of txns) {
    if (t.date <= day) continue;
    if (t.type === 'cash') {
      // Money in (quantity -1) wasn't there yet; money out still was.
      cash += t.quantity < 0 ? -t.price : t.price;
    } else {
      // A buy's units weren't held yet and its cost was still cash; a sell's
      // units (a quantity below zero) still were, its proceeds not yet cash.
      quantities.set(t.ticker, (quantities.get(t.ticker) ?? 0) - t.quantity);
      cash += t.quantity * t.price;
    }
  }
  for (const [ticker, q] of quantities) quantities.set(ticker, Math.max(0, q));
  return { quantities, cash };
}

/** A fund's price on a day: today's, at the market then. */
const priceOn = (price: number, today: string, day: string, w: number) => price * marketOn(today, day) * (1 + w);

/** What an investment account was worth on a day, over what it is worth today. */
function worthRatio(a: SeedAccount, today: string, day: string, w: number): number {
  const holdings = a.holdings ?? [];
  const price = new Map(holdings.map((h) => [h.ticker, h.price]));
  const worth = (d: string, wd: number) => {
    const { quantities, cash } = heldOn(holdings, a.investment_transactions ?? [], d);
    let total = cash;
    for (const [ticker, q] of quantities) total += q * priceOn(price.get(ticker) ?? 0, today, d, wd);
    return total;
  };
  const now = worth(today, 0);
  return now > 0 ? Math.max(0, worth(day, w)) / now : 1;
}

/** A balance on `day` from today's, back through posted rows after it (Plaid's
 *  sign: positive is money out). Money held gains back what went out; money
 *  owed loses what was added to it. */
function walkedBack(balance: number, type: string, rows: readonly { date: string; amount: number; pending?: boolean }[], day: string): number {
  const after = rows.reduce((n, t) => (!t.pending && t.date > day ? n + t.amount : n), 0);
  return type === 'credit' || type === 'loan' ? balance - after : balance + after;
}

/**
 * The recorded year, oldest first: each day's balances worked back from
 * `measured` (today's load), the profile's accounts found by `ids` (mask to
 * account id) and its manual accounts by `manualIds` (name to id). An
 * account the profile doesn't know is held flat.
 */
export function recordedYear(profile: DemoProfile, today: string, measured: readonly MeasuredAccount[], ids: ReadonlyMap<string, string>, manualIds: ReadonlyMap<string, string>): RecordedDay[] {
  const invested = new Map<string, SeedAccount>();
  const rowsOf = new Map<string, { date: string; amount: number; pending?: boolean }[]>();
  for (const inst of profile.institutions) {
    for (const a of inst.accounts) {
      const id = ids.get(a.mask);
      if (!id) continue;
      if (a.type === 'investment' && a.holdings) invested.set(id, a);
      else rowsOf.set(id, a.transactions);
    }
  }
  for (const m of profile.manual) if (manualIds.has(m.name)) rowsOf.set(manualIds.get(m.name)!, m.rows ?? []);

  const w = wander(seedOf(profile.name), RECORDED_DAYS);
  const days: RecordedDay[] = [];
  for (let back = RECORDED_DAYS; back >= 1; back--) {
    const date = addDays(today, -back);
    const accounts: Record<string, number> = {};
    let total = 0;
    for (const a of measured) {
      const inv = invested.get(a.account_id);
      const balance = round2(inv ? a.balance * worthRatio(inv, today, date, w[back]) : walkedBack(a.balance, a.type, rowsOf.get(a.account_id) ?? [], date));
      accounts[a.account_id] = balance;
      total += signedContribution(a.type, balance);
    }
    days.push({ date, accounts, total: round2(total) });
  }
  return days;
}

/** Every account today's load measured, with its balance. */
export function measuredOf(institutions: readonly InstitutionResult[]): MeasuredAccount[] {
  return institutions.flatMap((inst) => (inst.error ? [] : inst.accounts.filter((a) => typeof a.balance === 'number' && !a.stale).map((a) => ({ account_id: a.account_id, type: a.type, balance: a.balance }))));
}

/** Writes the recorded year: the accounts' days first, then the totals, as a
 *  snapshot writes them. Without `totals` (today's load held its total back,
 *  as when a bank didn't answer), only the accounts measured, into the
 *  partial layer, as such a load records them: a total without that bank
 *  would be short for good. */
export async function writeRecordedYear(ctx: Ctx, days: readonly RecordedDay[], totals: boolean): Promise<void> {
  await restoreHistoryDays(ctx, totals ? 'accounts' : 'accounts:partial', days.map((d) => ({ date: d.date, value: d.accounts })));
  if (totals) await restoreHistoryDays(ctx, 'net-worth', days.map((d) => ({ date: d.date, value: d.total })));
}

/** The days holdings are recorded on before today: each past month's last,
 *  oldest first. */
export function holdingsDays(today: string): string[] {
  return historyMonths(today)
    .map(lastDay)
    .filter((d) => d < today && daysBetween(d, today) <= RECORDED_DAYS);
}

/** What an observed account held on `day`, each position worked back as its
 *  balance is. */
function positionsOn(a: SeedAccount, observed: readonly Position[], securities: HoldingsObservation['securities'], today: string, day: string, w: number): Position[] {
  const holdings = a.holdings ?? [];
  const { quantities, cash } = heldOn(holdings, a.investment_transactions ?? [], day);
  const ratio = worthRatio(a, today, day, w);
  return observed.map((p) => {
    const ticker = securities[p.security_id]?.ticker ?? null;
    const seed = holdings.find((h) => h.ticker === ticker);
    if (ticker === CASH || securities[p.security_id]?.is_cash_equivalent) {
      return { ...p, quantity: round2(cash), price: 1, price_as_of: day, value: round2(cash), cost_basis: round2(cash) };
    }
    if (!seed || p.quantity === null || p.price === null) {
      return { ...p, value: p.value === null ? null : round2(p.value * ratio), price_as_of: day };
    }
    const quantity = Math.round((quantities.get(seed.ticker) ?? 0) * 10_000) / 10_000;
    const price = round2(priceOn(p.price, today, day, w));
    const share = p.quantity > 0 ? quantity / p.quantity : 0;
    return { ...p, quantity, price, price_as_of: day, value: round2(quantity * price), cost_basis: p.cost_basis === null ? null : round2(p.cost_basis * share) };
  });
}

/**
 * Records holdings on each past month's last day, oldest first, from what
 * today's load observed: a month written after a later one doesn't move the
 * index's first day back, so these go before today's (recordFetch).
 */
export async function writeHoldingsMonths(ctx: Ctx, profile: DemoProfile, today: string, institutions: readonly InstitutionResult[], ids: ReadonlyMap<string, string>): Promise<void> {
  const accountOf = new Map<string, SeedAccount>();
  for (const inst of profile.institutions) for (const a of inst.accounts) if (ids.has(a.mask)) accountOf.set(ids.get(a.mask)!, a);
  const w = wander(seedOf(profile.name), RECORDED_DAYS);
  for (const day of holdingsDays(today)) {
    const back = daysBetween(day, today);
    const then = institutions.map((inst) => {
      const seen = inst.holdings_observed;
      if (!seen || inst.error) return inst;
      const accounts: Record<string, Position[]> = {};
      for (const [id, positions] of Object.entries(seen.accounts)) {
        const a = accountOf.get(id);
        accounts[id] = a ? positionsOn(a, positions, seen.securities, today, day, w[back]) : positions;
      }
      return { ...inst, holdings_observed: { accounts, securities: seen.securities } };
    });
    await recordHoldings(ctx, then, Date.parse(`${day}T21:00:00Z`));
  }
}

/** What the profile paid into its investment accounts a year, as of `day`:
 *  the savings a plan saved that day used. Each account over the part of
 *  the year before it that its activity covers, made a year's worth, so one
 *  with a longer history doesn't make another's part year count as whole. */
export function yearlySavings(profile: DemoProfile, day: string): number {
  const from = addDays(day, -RECORDED_DAYS);
  let total = 0;
  for (const inst of profile.institutions) {
    for (const a of inst.accounts) {
      const cash = (a.investment_transactions ?? []).filter((t) => t.type === 'cash' && t.date <= day);
      if (cash.length === 0) continue;
      const begins = cash.map((t) => t.date).sort()[0];
      const covered = Math.min(RECORDED_DAYS, daysBetween(begins < from ? from : begins, day));
      const paid = cash.reduce((n, t) => (t.quantity < 0 && t.date > from ? n + t.price : n), 0);
      if (covered > 0) total += (paid * RECORDED_DAYS) / covered;
    }
  }
  return round2(total);
}

/** Your plan, saved for Progress against your plan on `day`, as the Progress
 *  card's save stores it (lib/saved-plan.ts) but on the profile's day. */
export async function writeSavedPlan(ctx: Ctx, profile: DemoProfile, plan: FirePlanV2, day: string): Promise<void> {
  await savedPlanStore.set(ctx, {
    version: 1,
    plan,
    savings: yearlySavings(profile, day),
    currency: 'USD',
    inflation: 0.03,
    day,
    savedAt: `${day}T17:00:00.000Z`,
    rev: crypto.randomUUID(),
  });
}
