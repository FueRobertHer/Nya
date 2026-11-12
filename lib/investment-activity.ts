// lib/investment-activity.ts
//
// One investment account's activity as the dashboard shows it, worked out
// from its item's stored investment transactions (lib/invstore.ts): recent
// buys, sells, dividends and fees, what the holder has put in this year, the
// per-day flows behind the chart's money-added line, and the trailing year's
// contributions the Plan's savings use. Two routes answer it: the Accounts
// tab's (app/api/investment-activity) and the Plan's inputs
// (app/api/plan-inputs), from one item's sync for every account in it.
//
// Both join the transactions imported for the account from its brokerage's
// download first (lib/investment-imports.ts withImportedRows, through
// activityWithImports here), so the account's chart, Investments, the
// activity list and the Plan count the same rows.

import {
  contributedAmount,
  countedTrades,
  dailyFlows,
  isContribution,
  isIncomingRollover,
} from './investments';
import type { InvSync } from './invstore';
import type { InvestmentTxn } from './investments';
import { withImportedRows, type AccountImport, type ImportedDays } from './investment-imports';
import { withoutMoves } from './growth';
import { ACTIVITY_STILL_LOADING } from './growth-summary';

const RECENT_LIMIT = 25;

/** Income an account paid in cash: a dividend or interest, not a capital gain
 *  or a distribution, which are other things to the tax model. */
const INCOME_SUBTYPES = new Set(['dividend', 'qualified dividend', 'non-qualified dividend', 'interest']);
const isAccountIncome = (t: { type: string; subtype: string }) => t.type.toLowerCase() === 'cash' && INCOME_SUBTYPES.has((t.subtype || '').toLowerCase());

/** The account's activity from its item's sync. `judged` is the counted
 *  trades when they were judged already (withImportedRows judges them over
 *  each source's own rows); otherwise they are judged here over the
 *  account's. */
export function activityFromSync(sync: InvSync, account_id: string, judged?: ReadonlySet<InvestmentTxn>) {
  // Newest first, explicitly: the store has no order of its own.
  const mine = sync.rows
    .filter((t) => t.account_id === account_id)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // Decided over every row the account has, the same set the backfill hands
  // the walk, so the two can't disagree about a paycheck (see countedTrades).
  const counted = judged ?? countedTrades(mine);
  const yearStart = `${new Date().getUTCFullYear()}-01-01`;
  const thisYear = mine.filter((t) => t.date >= yearStart);
  const sum = (rows: typeof thisYear) =>
    rows.reduce((total, t) => total + contributedAmount(t, counted), 0);

  // Reported as two figures: a rollover is retirement money that already existed
  // moving between accounts, so folding it into contributions makes a $60k 401k
  // transfer read as a year of saving, while dropping it would leave a large
  // arrival in the activity list that no line accounts for.
  const ytd_contributions = sum(thisYear.filter((t) => isContribution(t, counted)));
  const ytd_rollovers = sum(thisYear.filter((t) => isIncomingRollover(t, counted)));

  // The money-added line, only across dates the store has VERIFIED for this
  // account, ending where they end: a contribution after `through` isn't known
  // yet (an outage, or an unverified last sync), so drawing past it would book it
  // as growth.
  //
  // It starts at the later of the verified start and the account's oldest row:
  // an institution can keep less history than was asked for, and every
  // contribution before its oldest row would read as growth. No rows at all
  // proves nothing about how far the feed reaches, so no line.
  //
  // Without the moves inside the account (lib/growth.ts withoutMoves): an
  // exchange whose sell and buy land days apart is neither money in nor out,
  // for the line, its readout, the sheet's figures and the form's checks.
  // The moves are kept as the days they span, for where the line may start.
  const cov = sync.coverage[account_id];
  const oldest = mine.length ? mine[mine.length - 1].date : null;
  const flowsKnown = !!cov && !!oldest;
  const split = flowsKnown
    ? withoutMoves(
        dailyFlows(
          mine.filter((t) => t.date >= cov!.from && t.date <= cov!.through),
          counted
        )
      )
    : null;
  const flows = split?.flows ?? null;
  const moves = split?.moves ?? null;
  const flows_from = flowsKnown ? (oldest! > cov!.from ? oldest! : cov!.from) : null;
  const flows_to = flowsKnown ? cov!.through : null;

  // The trailing year's contributions, for the Plan tab's savings
  // (lib/fire/inputs.ts): new money only, not rollovers, from the later of a
  // year ago and the first day the store has verified. Whether that cut the
  // year short is said here, in contributions_12m_partial, decided against
  // the verified coverage (not the oldest row: a plan with no activity for a
  // while is still covered) and on the coverage's own UTC days, so the tab
  // never compares one of these days with its own. Each contribution is
  // listed too, so the tab can leave out one that a transfer from a bank
  // account paid for, which its income minus spending already counts. Null
  // where the flows aren't known, for the same reasons as the line above.
  const yearAgo = new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10);
  const contributions_12m_from = flowsKnown ? (cov!.from > yearAgo ? cov!.from : yearAgo) : null;
  const contributions_12m_partial = flowsKnown ? cov!.from > yearAgo : null;
  const contributed = contributions_12m_from
    ? mine.filter((t) => t.date >= contributions_12m_from && isContribution(t, counted))
    : null;
  const contributions_12m = contributed ? sum(contributed) : null;
  const contributions_12m_rows = contributed
    ? contributed.map((t) => ({ date: t.date, amount: contributedAmount(t, counted) })).reverse() // oldest first
    : null;
  // The verified record can reach back further than the institution's own
  // history (it may keep less), so when the account's oldest row is inside
  // the year, that day is said too: "Nya has activity for it from" is true
  // either way. Same UTC days as the rest.
  const contributions_12m_activity_from = flowsKnown && oldest! > yearAgo ? oldest : null;

  // The same year's dividends and interest, for the Plan's tax buckets
  // (lib/fire/buckets-today.ts): what the rows say arrived as cash. A dividend an
  // institution reports only as a reinvested buy isn't here, which the sheet
  // says. Plaid writes money in as a negative amount.
  const dividends_12m = contributions_12m_from
    ? mine.filter((t) => t.date >= contributions_12m_from && isAccountIncome(t)).reduce((total, t) => total - t.amount, 0)
    : null;

  // Said in full here so the client can print it as is. A fetch failure
  // serves what is stored (and says so only if there is any); a storage
  // problem serves what was just fetched. Both can happen at once.
  const fetchNote = sync.note ? (mine.length ? `${sync.note}; showing saved activity` : sync.note) : null;
  // Another sync is mid-way through the first download: nothing is saved yet,
  // and "no activity" would be wrong.
  const loadingNote = sync.busy && mine.length === 0 ? ACTIVITY_STILL_LOADING : null;
  const note = [fetchNote, loadingNote, sync.storeNote].filter(Boolean).join('. ') || null;
  return {
    txns: mine.slice(0, RECENT_LIMIT),
    ytd_contributions,
    ytd_rollovers,
    flows,
    moves,
    flows_from,
    flows_to,
    contributions_12m,
    contributions_12m_from,
    contributions_12m_partial,
    contributions_12m_rows,
    contributions_12m_activity_from,
    dividends_12m,
    note,
  };
}

export type InvestmentActivity = ReturnType<typeof activityFromSync>;

/** Said when the account's imports can't be read: its activity is Plaid's
 *  alone, and isn't cached, so the next load tries them again. */
export const IMPORTS_UNREADABLE = 'Your imported transactions can’t be read just now, so this is Plaid’s activity alone';

/** The activity as both routes answer it: with the account's imports
 *  joined, what they decide and which can't be used, and the fingerprint of
 *  the imports it was built under (lib/investment-imports-store.ts
 *  importsFingerprint), which a cached copy must match. `imports` null: they
 *  couldn't be read. */
export function activityWithImports(
  sync: InvSync,
  account_id: string,
  imports: readonly AccountImport[] | null,
  imports_fingerprint: string
): { payload: InvestmentActivity & { imported_days: ImportedDays[]; imports_unused: string[]; imports_fingerprint: string }; cacheable: boolean } {
  if (imports === null) {
    const payload = activityFromSync({ ...sync, storeNote: [sync.storeNote, IMPORTS_UNREADABLE].filter(Boolean).join('. ') }, account_id);
    return { payload: { ...payload, imported_days: [], imports_unused: [], imports_fingerprint }, cacheable: false };
  }
  const merged = withImportedRows(sync, account_id, imports);
  const payload = activityFromSync(merged.sync, account_id, merged.counted);
  return { payload: { ...payload, imported_days: merged.decided, imports_unused: merged.unused, imports_fingerprint }, cacheable: cacheable(sync) };
}

/** A cached entry built under the imports there are now: one built from
 *  others, or before imports were joined, is a miss. */
export function hasCurrentImports(cached: Record<string, unknown>, fingerprint: string): boolean {
  return cached.imports_fingerprint === fingerprint;
}

/** Whether the activity from this sync may be cached. Not after a Plaid
 *  failure (re-check next load), nor while another sync held the store (that
 *  answer is whatever was stored, which on a first link is nothing). A
 *  storage-only problem IS cached: the rows were just fetched live, and
 *  otherwise an unwritable store would re-run the full fetch every load. */
export function cacheable(sync: InvSync): boolean {
  return !sync.note && !sync.busy;
}

/** A cached entry the Plan can use: one cached before the Plan tab's fields
 *  existed is a miss, so the tab never reads their absence as "nothing
 *  contributed" or "a whole year". */
export function hasPlanFields(cached: Record<string, unknown>): boolean {
  return 'contributions_12m_activity_from' in cached;
}

/** A cached entry whose flows have the moves inside the account taken out
 *  (withoutMoves), which says so with its `moves`: one cached before then is
 *  a miss, so its chart and Accounts > Investments never count an exchange's two
 *  legs as money out and money in for the rest of its life in the cache. */
export function hasCurrentFlows(cached: Record<string, unknown>): boolean {
  return 'moves' in cached;
}
