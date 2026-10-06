// lib/fire/inputs.ts
//
// The Plan tab's automatic inputs, measured from what Nya already has:
//   - annual spending and income, from the trailing twelve months of
//     transactions, by the SAME rule as the Activity tab and Insights
//     (components/MonthBreakdown.tsx isTransfer: transfers between your own
//     accounts, ATM withdrawals, bank charges coded as transfers, and loan
//     payments are neither spending nor income, so a card payment is not
//     counted twice). Pending rows count, as they do there; a pending row
//     whose posted row has arrived was already dropped by /api/transactions
//     (lib/transactions.ts supersededPendingIds), so nothing counts twice.
//   - annual savings as income minus spending: an ESTIMATE, since pre-tax
//     401(k) contributions and an employer match never pass through a bank
//     account, and money moved to a brokerage is a transfer.
//   - invested assets: the balances of investment accounts (and, if asked,
//     checking and savings), not hidden, as the Accounts tab shows them.
//
// Each comes with what it was measured from, for the label beside it. The
// person can override every one (lib/fire/plan.ts).

import { isTransfer, type Txn } from '@/components/MonthBreakdown';
import { isInvestmentType } from '@/lib/balance';
import { dominantCurrency } from '@/lib/format';

/** The trailing window, in days (today included). */
export const TRAILING_DAYS = 365;
/** Less history than this is scaled up to a year, and said so. */
export const FULL_YEAR_DAYS = 335;
/** Less history than this is too little to estimate a year from. */
export const MIN_DAYS = 28;

export type TrailingFlows = {
  /** A year's spending (money out, not transfers). */
  spending: number;
  /** A year's income (money in, not transfers). */
  income: number;
  /** income - spending: an estimate (see the top of this file). */
  savings: number;
  /** The earliest transaction counted, and today. */
  from: string;
  to: string;
  /** Days of history behind the figures, the first one and today included. */
  days: number;
  /** True when that history was under FULL_YEAR_DAYS and the totals were
   *  scaled up to a year. */
  scaled: boolean;
  /** Transactions counted (transfers excluded). */
  count: number;
  /** The currency most of them are in, and whether others were summed with it. */
  currency: string | null;
  mixedCurrency: boolean;
};

const DAY_MS = 86_400_000;
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
const isoDay = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/**
 * Spending, income and savings over the trailing year, from the transactions
 * the dashboard loaded. `today` is the viewer's local calendar day
 * (lib/local-date.ts). Null when there is too little to go on: no countable
 * transaction, or under MIN_DAYS of history.
 */
export function trailingFlows(txns: Txn[], today: string): TrailingFlows | null {
  const end = dayNumber(today);
  const start = end - (TRAILING_DAYS - 1);
  let spending = 0;
  let income = 0;
  let count = 0;
  let earliest = end;
  const counted: Txn[] = [];
  for (const t of txns) {
    const d = dayNumber(t.date);
    if (!(d >= start && d <= end)) continue; // also skips a malformed date
    if (d < earliest) earliest = d;
    if (isTransfer(t)) continue;
    count++;
    counted.push(t);
    if (t.amount > 0) spending += t.amount;
    else income -= t.amount;
  }
  const days = end - earliest + 1;
  if (count === 0 || days < MIN_DAYS) return null;
  const scale = days < FULL_YEAR_DAYS ? TRAILING_DAYS / days : 1;
  const currencies = new Set(counted.map((t) => t.iso_currency_code).filter((c): c is string => !!c));
  return {
    spending: spending * scale,
    income: income * scale,
    savings: (income - spending) * scale,
    from: isoDay(earliest),
    to: today,
    days,
    scaled: scale !== 1,
    count,
    currency: dominantCurrency(counted),
    mixedCurrency: currencies.size > 1,
  };
}

/** The account fields this needs, as the dashboard has them. */
export type AssetAccount = {
  account_id: string;
  name: string;
  institution: string;
  type: string;
  balance: number | null;
  currency: string | null;
  hidden?: boolean;
};

export type InvestedAssets = {
  /** Null when no account counts. */
  total: number | null;
  /** The accounts summed, for the list under the figure. */
  accounts: (AssetAccount & { balance: number })[];
  /** Accounts that would count but have no balance to count. */
  unknown: number;
  currency: string | null;
  mixedCurrency: boolean;
};

/**
 * Invested assets: every investment account that is not hidden, plus
 * checking and savings when `includeCash`. Credit and loan balances are not
 * subtracted: the FI number is about what can be invested and drawn on, not
 * net worth.
 */
export function investedAssets(accounts: AssetAccount[], includeCash: boolean): InvestedAssets {
  const counted: (AssetAccount & { balance: number })[] = [];
  let unknown = 0;
  for (const a of accounts) {
    if (a.hidden) continue;
    if (!isInvestmentType(a.type) && !(includeCash && a.type === 'depository')) continue;
    if (a.balance === null || !Number.isFinite(a.balance)) {
      unknown++;
      continue;
    }
    counted.push({ ...a, balance: a.balance });
  }
  const currencies = new Set(counted.map((a) => a.currency).filter((c): c is string => !!c));
  return {
    total: counted.length > 0 ? counted.reduce((s, a) => s + a.balance, 0) : null,
    accounts: counted,
    unknown,
    currency: dominantCurrency(counted.map((a) => ({ iso_currency_code: a.currency }))),
    mixedCurrency: currencies.size > 1,
  };
}
