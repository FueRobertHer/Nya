// lib/backfill.ts
//
// The backward balance walk behind the ESTIMATED history layer: given today's
// balances and a day-by-day table of flows, it returns each account's balance on
// every past day, plus the walked share of net worth for the same days.
//
// Split out of app/api/backfill/route.ts because it is pure (no Plaid, no Redis,
// no clock beyond an injectable `now`), so it can be tested directly. The route
// still owns fetching, deciding which accounts are walkable, and persisting.

import { signedContribution } from './balance';
// Pure classifiers only; nothing here calls Plaid.
import { countedTrades, walkDelta, type InvestmentTxn } from './investments';

export type WalkType = 'depository' | 'credit' | 'investment';

/** What the backfill needs from an Item's stored investment transactions
 *  (lib/invstore.ts InvSync), kept structural so this module stays pure. */
export type ItemInvestments = {
  rows: InvestmentTxn[];
  note: string | null;
  pending: boolean;
  busy: boolean;
  coverage: Record<string, { from: string; through: string }>;
  unconfirmedIds: string[];
};

/**
 * Which of an Item's investment accounts can be walked, whether to wait, and
 * which rows to walk.
 *
 * PER ACCOUNT. An account is walked when its own VERIFIED coverage runs from the
 * window's start to at least yesterday (to today when the latest fetch failed:
 * anything after the last verified sync is unknown, and a paycheck posted since
 * would be missing from a walk that is never redone). One account short of that
 * is held flat on its own without holding the Item's others flat.
 *
 * Waits (bounded by the caller's retry cap) only when a retry can help: Plaid
 * extracting or temporarily failing (`pending`), another sync holding the store
 * (`busy`), or a fetch that worked while some account's coverage still falls
 * short. A failure that won't fix itself (reauth, product unavailable) doesn't
 * wait: five runs change nothing, and each repeats a billed balance call per
 * institution.
 *
 * Rows marked missing but not yet confirmed are LEFT OUT of the walk. Right after
 * Plaid re-keys a batch the old copies sit here for a day beside the new ones,
 * and walking both would count every flow twice. Leaving out a row that turns
 * out to be real costs that one flow, and they don't hold the walk up.
 */
export function investmentReadiness(
  inv: ItemInvestments,
  investmentIds: string[],
  dates: { windowStart: string; yesterday: string; today: string }
): { coveredIds: Set<string>; pending: boolean; walkRows: InvestmentTxn[] } {
  const reachBy = inv.note ? dates.today : dates.yesterday;
  const coveredIds = new Set(
    investmentIds.filter((id) => {
      const cov = inv.coverage[id];
      return !!cov && cov.from <= dates.windowStart && cov.through >= reachBy;
    })
  );
  const someShort = coveredIds.size < investmentIds.length;
  const unconfirmed = new Set(inv.unconfirmedIds);
  return {
    coveredIds,
    pending: inv.pending || inv.busy || (someShort && !inv.note),
    walkRows: inv.rows.filter((r) => !unconfirmed.has(r.investment_transaction_id)),
  };
}

/**
 * Brings an Item's investment store up to date for the backfill and decides what
 * to walk. Takes the sync as a function so the one thing that matters, asking
 * for freshness from a VERIFIED sync only, can be tested: an unverified store
 * served without fetching again would spend a capped retry and make no progress.
 */
export async function loadItemInvestments(
  sync: (opts: { freshOnlyIfVerified: boolean }) => Promise<ItemInvestments>,
  investmentIds: string[],
  dates: { windowStart: string; yesterday: string; today: string }
): Promise<{ coveredIds: Set<string>; pending: boolean; walkRows: InvestmentTxn[] }> {
  return investmentReadiness(await sync({ freshOnlyIfVerified: true }), investmentIds, dates);
}

/**
 * Adds one Item's investment transactions to the walk's per-day table, for the
 * accounts being walked as investments, and returns the oldest date it added (or
 * null).
 *
 * Resolved over the Item's whole set, not row by row, because whether a
 * contribution trade carries its own money depends on the rows beside it (see
 * countedTrades). Judged alone, a paycheck booked as a single contribution buy
 * reads as an internal trade and gets carried back into the past.
 */
export function addInvestmentFlows(
  dailyByAccount: Record<string, Record<string, number>>,
  invTxns: InvestmentTxn[],
  walkType: Record<string, WalkType>,
  /** Only rows on or after this date are walked. The trades are still judged
   *  over EVERY row passed in, so the answer matches the activity route's,
   *  which sees the account's whole stored history. */
  since?: string
): string | null {
  const counted = countedTrades(invTxns);
  let oldest: string | null = null;
  for (const t of invTxns) {
    if (walkType[t.account_id] !== 'investment') continue;
    if (since && t.date < since) continue;
    const delta = walkDelta(t, counted);
    if (delta === 0) continue; // internal reallocation: buys, sells, corporate actions
    const day = (dailyByAccount[t.date] ??= {});
    // Back into the walk's convention (positive = value left the account),
    // which is what reconstruct un-applies.
    day[t.account_id] = (day[t.account_id] ?? 0) + -delta;
    if (!oldest || t.date < oldest) oldest = t.date;
  }
  return oldest;
}

export function isoDaysAgo(days: number, from: number = Date.now()): string {
  return new Date(from - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The UTC day before a YYYY-MM-DD date. */
function dayBefore(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export type WalkInput = {
  /** Today's raw balance per walkable account. */
  balances: Record<string, number>;
  walkType: Record<string, WalkType>;
  /** date -> account -> summed flow, in Plaid's convention (positive = value left). */
  dailyByAccount: Record<string, Record<string, number>>;
  /** Oldest CASH transaction date: how far the total series can honestly go. */
  oldestTxn: string;
  /** Oldest INVESTMENT transaction date, when it reaches back further. */
  oldestInvTxn?: string | null;
  lookbackDays: number;
  now?: number;
};

export type WalkResult = {
  /** Per-account balances by date, newest first. */
  accountPoints: { date: string; balances: Record<string, number> }[];
  /** The walked accounts' combined contribution to net worth, by date. The
   *  caller adds the flat-held `rest` term. Stops at the cash horizon. */
  totalPoints: { date: string; walked: number }[];
  /** Investment accounts whose flows out-ran their balance and were floored at
   *  zero (see the floor below). Reported so a systematically incomplete flow
   *  stream is visible rather than silently smoothed over. */
  floored: string[];
};

/**
 * Walk backward one day at a time: un-applying day D's flows yields balances at
 * the end of day D-1.
 *
 * DIRECTION. `balances[id] += walkType[id] === 'credit' ? -amount : amount` has
 * the same shape as signedContribution and the OPPOSITE meaning (a card purchase
 * RAISES what you owe), so the two must not be merged (see lib/balance.ts).
 * signedContribution is used only for the net-worth term.
 *
 * THE FLOOR. An investment account whose flows would take it below zero is held
 * at zero from that day backward. A brokerage account can't hold less than
 * nothing, and it is common with large arrivals: an IRA opened by a $60k
 * rollover worth $58k today reconstructs to -$2k the day before it existed,
 * because market movement is not a transaction.
 *
 * This replaced dropping the account back to the flat term, which held TODAY's
 * balance for the whole year (the very error the walk removes): the rollover
 * looked as if the money had always been there, and the event was invisible on
 * the account's chart. Flooring keeps the step, bounds the error to the
 * reconstructed pre-arrival balance, and never states an impossible balance. Once
 * floored an account takes no earlier flows, since the data has already
 * contradicted the premise. The cost: flow data that overstates inflow (an
 * internal cash sweep reported as an external deposit) now pulls the account
 * toward zero, where flat was merely uninformative. `floored` in the response
 * makes a systematically bad flow stream visible.
 *
 * The NET-WORTH line moves with it, deliberately: a floored account contributes
 * zero to the walked total before its floor date, so money arriving from an
 * unlinked institution shows as a step there too, as every trusted arrival
 * already did. Where both legs are linked the sending account's drop cancels it.
 */
export function reconstruct(input: WalkInput): WalkResult {
  const { walkType, dailyByAccount, oldestTxn, lookbackDays } = input;
  const now = input.now ?? Date.now();
  const balances = { ...input.balances };
  const floored = new Set<string>();

  // Investment flows can reach back further than cash ones (a brokerage that
  // reports a year, a bank three months). The TOTAL series still stops at the
  // cash horizon, since walking past it would freeze every cash balance and
  // publish a flatline as history. An investment account's OWN series has real
  // data out there, so it keeps going (where a rollover from six months ago lives).
  const invHorizon =
    input.oldestInvTxn && input.oldestInvTxn < oldestTxn ? input.oldestInvTxn : oldestTxn;

  // The earliest date each account has a flow on. Past the cash horizon this
  // bounds the extension per account, because `oldestInvTxn` is one number across
  // every Item: without it a brokerage opened two months ago would be drawn flat
  // for the ten months before it existed. One day either side of an account's own
  // data is the most that can be said.
  const firstFlow: Record<string, string> = {};
  for (const [date, day] of Object.entries(dailyByAccount)) {
    for (const id of Object.keys(day)) {
      if (!firstFlow[id] || date < firstFlow[id]) firstFlow[id] = date;
    }
  }
  // Resolved to the earliest date each account can be drawn on, once, rather
  // than per day inside the loop below.
  const extendsTo: Record<string, string> = {};
  for (const [id, date] of Object.entries(firstFlow)) extendsTo[id] = dayBefore(date);

  const accountPoints: WalkResult['accountPoints'] = [];
  const totalPoints: WalkResult['totalPoints'] = [];

  const walkedTotal = () =>
    Object.entries(balances).reduce(
      (sum, [id, b]) => sum + signedContribution(walkType[id], b),
      0
    );

  for (let back = 1; back <= lookbackDays; back++) {
    const dayTxns = dailyByAccount[isoDaysAgo(back - 1, now)] ?? {};
    for (const [id, amount] of Object.entries(dayTxns)) {
      // An id the caller isn't walking. Unreachable through the route, but
      // `balances[id] += amount` on a missing key yields NaN and poisons every
      // later point, so refuse.
      if (!(id in balances) || floored.has(id)) continue;
      const next = balances[id] + (walkType[id] === 'credit' ? -amount : amount);
      if (walkType[id] === 'investment' && next < 0) {
        balances[id] = 0;
        floored.add(id);
      } else {
        balances[id] = next;
      }
    }

    const date = isoDaysAgo(back, now);
    if (date < invHorizon) break; // beyond available data: stop, don't flatline
    if (date >= oldestTxn) {
      accountPoints.push({ date, balances: { ...balances } });
      totalPoints.push({ date, walked: walkedTotal() });
      continue;
    }
    // Past the cash horizon: only investment accounts still have data, so only
    // they are recorded, back to where their own flows start. Everything else has
    // no point for these dates, which reads as history not yet reconstructed
    // rather than a balance that didn't move.
    //
    // The day BEFORE the first flow is kept: it is the only point showing what the
    // account was worth before that flow (for a $60k rollover, the whole story).
    // Nothing earlier is reconstructable, since every earlier day would repeat it.
    const investOnly: Record<string, number> = {};
    for (const [id, b] of Object.entries(balances)) {
      if (walkType[id] !== 'investment') continue;
      const start = extendsTo[id];
      if (!start || date < start) continue;
      investOnly[id] = b;
    }
    // Nothing left to say about this date: don't write an empty map for it.
    if (Object.keys(investOnly).length === 0) continue;
    accountPoints.push({ date, balances: investOnly });
  }

  return { accountPoints, totalPoints, floored: [...floored] };
}
