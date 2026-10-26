// lib/fire/invested-series.ts
//
// Invested assets day by day, for progress against your plan (rollout 8e):
// for each day snapshots measured balances on (lib/history.ts
// readMeasuredBalances, the real and partial layers, never an estimate),
// the sum of the accounts the Plan counts, by the Plan's own rules
// (lib/fire/inputs.ts investedAssets):
//   - the accounts are the ones the Plan counts today (investment accounts,
//     and checking and savings with include cash), and the ones that would
//     have counted before they ended, each on the days before its end; a
//     hidden account is never one of them (the route leaves every id of one
//     out before anything reaches here);
//   - ONE CURRENCY, the Plan's. Without a home currency nothing converts:
//     an account in another currency is left out and named by its currency,
//     and one that names none counts in the Plan's, as today's figure counts
//     it. With one (`fx`), each currency's subtotal is converted once, at
//     that day's rate, as net worth's history is (lib/fx/net-worth.ts
//     balancesIn); a currency with no rate that day is left out and named.
//
// Only what was measured. A day with no balances measured is not in the
// series, so nothing is drawn across it. An account expected on a day (known
// by then, and not yet ended) with no balance that day is MISSING from it and
// named: the day's total is the rest, and is never taken for the whole.
// Balances are in each day's own money (nominal): the page says how a plan
// in today's dollars is set against them.
//
// Pure. The route (app/api/invested-history) adds the days oldest first.

import { balancesIn } from '@/lib/fx/net-worth';
import type { FxTable, NoRate } from '@/lib/fx/rates';
import type { AssetInstitution } from './inputs';

/** An account the series counts, under the id it is known by now. */
export type InvestedSeriesAccount = {
  account_id: string;
  /** Its currency: null when its institution gives none, taken to be the
   *  Plan's, as today's figure takes it. */
  currency: string | null;
  /** The first day it is expected on: when the account directory first knew
   *  it, or it was first measured, whichever is earlier. Null expects it only
   *  from the first day it is measured in the range. */
  knownFrom: string | null;
  /** It ended (lib/lifecycle.ts) and counts only on the days before this one. */
  ended?: string;
};

export type InvestedDay = {
  date: string;
  /** The counted accounts' balances in the series' currency; null when none
   *  of them has one that day. */
  total: number | null;
  /** How many accounts are in the total. */
  counted: number;
  /** Accounts expected that day with no balance measured, by id, in id order. */
  missing: string[];
  /** Without a home currency, accounts left out for being in another
   *  currency, by currency: how many. */
  otherCurrencies: Record<string, number>;
  /** With one, currencies left out for having no rate that day, with how
   *  many accounts, why, and whose rate is missing. */
  unrated: { currency: string; accounts: number; why: NoRate; unrated: string }[];
};

export type InvestedSeriesInput = {
  accounts: readonly InvestedSeriesAccount[];
  /** The Plan's currency; null when it had none (no account named one), so
   *  only accounts that name none count. */
  currency: string | null;
  /** With a home currency, what balances convert with; null converts
   *  nothing. */
  fx: FxTable | null;
};

export function investedSeries(input: InvestedSeriesInput) {
  const days: InvestedDay[] = [];
  const firstMeasured = new Map<string, string>();
  let previous: string | null = null;
  const converts = input.fx !== null && input.fx.home !== null && input.currency !== null;

  /** Adds one day's measured balances, by account id as known now. */
  function add(date: string, balances: ReadonlyMap<string, number>): void {
    if (previous !== null && date <= previous) throw new Error('invested series: add each day once, oldest first');
    previous = date;
    const rows: { amount: number; currency: string | null }[] = [];
    const missing: string[] = [];
    const otherCurrencies: Record<string, number> = {};
    for (const a of input.accounts) {
      if (a.ended !== undefined && date >= a.ended) continue;
      const balance = balances.get(a.account_id);
      if (balance === undefined || !Number.isFinite(balance)) {
        const first = firstMeasured.get(a.account_id);
        if ((a.knownFrom !== null && a.knownFrom <= date) || (first !== undefined && first <= date)) missing.push(a.account_id);
        continue;
      }
      if (!firstMeasured.has(a.account_id)) firstMeasured.set(a.account_id, date);
      // Without a currency of its own the plan sums only accounts that name
      // none: one that names a currency is left out and named, never added
      // to another currency's money.
      if (!converts && a.currency !== null && a.currency !== input.currency) {
        otherCurrencies[a.currency] = (otherCurrencies[a.currency] ?? 0) + 1;
        continue;
      }
      rows.push({ amount: balance, currency: a.currency });
    }
    // Nothing the series counts was there to measure that day.
    if (rows.length === 0 && missing.length === 0 && Object.keys(otherCurrencies).length === 0) return;
    let total: number | null = null;
    let counted = rows.length;
    let unrated: InvestedDay['unrated'] = [];
    if (converts) {
      const b = balancesIn(rows, input.fx as FxTable, input.currency as string, date, input.currency);
      unrated = b.left_out;
      counted = b.parts.filter((p) => p.converted !== null).reduce((n, p) => n + p.accounts, 0);
      total = counted > 0 ? b.total : null;
    } else if (rows.length > 0) {
      total = rows.reduce((s, r) => s + r.amount, 0);
    }
    days.push({ date, total, counted, missing: missing.sort(), otherCurrencies, unrated });
  }

  return { add, days };
}

/** A day measured whole: every account expected that day has a balance, and
 *  none is left out for its currency. Only such a day is set against a plan. */
export function isComplete(d: InvestedDay): d is InvestedDay & { total: number } {
  return d.total !== null && d.missing.length === 0 && Object.keys(d.otherCurrencies).length === 0 && d.unrated.length === 0;
}

/** An account as the page sends it (app/api/invested-history), which decides
 *  from the saved plan which of them count. */
export type ProgressAccount = { account_id: string; type: string; currency: string | null };

/** Every account the dashboard knows, hidden ones aside, for the series:
 *  those it shows, and those an institution is known to have but can't show
 *  (lib/last-known.ts `unshown_accounts`), which are still the person's, so
 *  the days they are missing from are marked, never drawn whole. One with no
 *  type known is left out: nothing says it would count. */
export function progressAccountsOf(institutions: readonly AssetInstitution[]): ProgressAccount[] {
  const out: ProgressAccount[] = [];
  const seen = new Set<string>();
  const add = (account_id: string, type: string | null | undefined, currency: string | null | undefined) => {
    if (seen.has(account_id) || !type) return;
    seen.add(account_id);
    out.push({ account_id, type, currency: currency ?? null });
  };
  for (const i of institutions) for (const a of i.accounts) if (!a.hidden) add(a.account_id, a.type, a.currency);
  for (const i of institutions) for (const a of i.unshown ?? []) add(a.account_id, a.type, a.currency);
  return out;
}
