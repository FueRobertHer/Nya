// lib/backfill.ts
//
// The backward balance walk behind the ESTIMATED history layer: given today's
// balances and a day-by-day table of flows, it returns each account's balance
// on every past day, plus the walked share of net worth for the same days.
//
// Split out of app/api/backfill/route.ts because it is pure -- no Plaid, no
// Redis, no clock beyond an injectable `now` -- which is what lets the route
// stay orchestration and lets this be tested directly. The route still owns
// fetching, deciding which accounts are walkable, and persisting.

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
 * PER ACCOUNT. An account is walked when its own VERIFIED coverage runs from
 * the window's start to at least yesterday (to today when the latest fetch
 * failed: anything after the last verified sync is unknown, and a paycheck
 * posted since would otherwise be missing from a walk that is never redone).
 * One account short of that is held flat on its own; it no longer holds the
 * Item's other accounts flat with it.
 *
 * Waits (the caller's retry cap bounds it) only when a retry can help: Plaid
 * extracting or temporarily failing (`pending`), another sync holding the store
 * (`busy`), or a fetch that worked while some account's coverage still falls
 * short, which the next run re-fetches. A failure that won't fix itself
 * (reauth, the product unavailable) doesn't wait: five runs change nothing,
 * and each repeats a billed balance call for every institution.
 *
 * Rows marked missing but not yet confirmed are LEFT OUT of the walk. Right
 * after Plaid re-keys a batch, the old copies are still here for a day beside
 * the new ones, and walking both would count every flow twice. Leaving out a
 * row that turns out to be real costs that one flow; they don't hold the walk
 * up either, since confirming takes a day and the cap is a few page loads.
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
 * Brings an Item's investment store up to date for the backfill and decides
 * what to walk. Takes the sync as a function so the one thing that matters
 * here, asking for freshness from a VERIFIED sync only, can be tested: a run
 * that served an unverified store without fetching again would spend one of
 * the backfill's capped retries and make no progress.
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
 * accounts being walked as investments, and returns the oldest date it added
 * (or null).
 *
 * Resolved over the Item's whole set rather than row by row, because whether a
 * contribution trade carries its own money depends on the rows beside it (see
 * countedTrades). Judged alone, a paycheck booked as a single contribution buy
 * reads as an internal trade, and the walk carried every one of them back into
 * the past as if the money had always been there.
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
 * Two rules are worth knowing before changing anything here.
 *
 * DIRECTION. `balances[id] += walkType[id] === 'credit' ? -amount : amount` is
 * the same shape as signedContribution and the OPPOSITE concept -- a card
 * purchase RAISES what you owe -- so the two must not be merged. See the
 * warning in lib/balance.ts. signedContribution is used only for the net-worth
 * term, which is the question it actually answers.
 *
 * THE FLOOR. An investment account whose flows would take it below zero is held
 * at zero from that day backward instead. A brokerage account cannot hold less
 * than nothing, and the situation is common with large arrivals: an IRA opened
 * by a $60k rollover that is worth $58k today reconstructs to -$2k the day
 * before it existed, because the market moved and market movement is not a
 * transaction.
 *
 * This replaced dropping the whole account back to the flat term. Flat meant
 * held at TODAY's balance for the entire year, which is the exact error the
 * walk exists to remove -- it draws the rollover as if the money had always
 * been there, so the event itself is invisible on the account's chart -- and it
 * was triggered by precisely the transfers most worth seeing. Flooring keeps
 * the step, bounds the error to the reconstructed pre-arrival balance, and
 * never states a balance known to be impossible. Once floored an account takes
 * no earlier flows: every reconstruction further back rests on a premise the
 * data has already contradicted.
 *
 * What the floor gives up is the old fallback's one virtue: flow data that
 * overstates inflow (a broker reporting an internal cash sweep as an external
 * deposit, say) now pulls the account toward zero for the span before it,
 * where holding it flat was merely uninformative. The trade is deliberate --
 * flat was wrong in the common case and this is wrong in the rare one -- and
 * `floored` in the response is what makes a systematically bad flow stream
 * visible rather than silent.
 *
 * The NET-WORTH line moves with it, deliberately. A floored account contributes
 * zero to the walked total before its floor date instead of today's balance, so
 * money arriving from an institution the user hasn't linked now shows as a step
 * there too. That is what the walk already did for every arrival it trusted --
 * the flat fallback was the inconsistency -- and where both legs are linked the
 * sending account's matching drop cancels it out.
 */
export function reconstruct(input: WalkInput): WalkResult {
  const { walkType, dailyByAccount, oldestTxn, lookbackDays } = input;
  const now = input.now ?? Date.now();
  const balances = { ...input.balances };
  const floored = new Set<string>();

  // Investment flows can reach back further than cash ones -- a brokerage that
  // reports a year against a bank that reports three months. The TOTAL series
  // still stops at the cash horizon, because walking past it would hold every
  // cash balance frozen and publish a flatline as if it were history. An
  // investment account's OWN series has real data out there, so it keeps going:
  // that extra span is where a rollover from six months ago lives.
  const invHorizon =
    input.oldestInvTxn && input.oldestInvTxn < oldestTxn ? input.oldestInvTxn : oldestTxn;

  // The earliest date each account has a flow on. Past the cash horizon this is
  // what bounds the extension per account, because `oldestInvTxn` is a single
  // number across every Item: without it, a brokerage opened two months ago
  // would be drawn as a flat line for the ten months before it existed, on the
  // strength of some other account's longer history. An account is only drawn
  // where its own data reaches, and one day either side of that is the most
  // that can be said.
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
      // An id the caller isn't walking. Unreachable through the route, which
      // filters both flow streams by membership, but `balances[id] += amount`
      // on a missing key yields NaN and poisons every later point, so it is
      // cheaper to refuse than to debug.
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
    // Past the cash horizon: only the investment accounts still have data, so
    // only they are recorded, and only back to where their own flows start.
    // Everything left out simply has no point for these dates, which reads on a
    // chart as history that hasn't been reconstructed rather than as a balance
    // that didn't move.
    //
    // The day BEFORE the first flow is kept deliberately: it is the only point
    // that shows what the account was worth before that flow, which for an
    // account opened by a $60k rollover is the whole story. Nothing earlier is
    // reconstructable -- with no flows left to un-apply, every earlier day would
    // just repeat it.
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
