'use client';

// Recent activity for one investment account, shown under the balance chart
// when an investment row is expanded (Accounts tab). Fetches its own data on
// mount like AccountSparkline -- but unlike that one this endpoint makes live
// Plaid calls, so it's cached server-side for 15 minutes to survive an
// expand/collapse loop.

import { useEffect, useState } from 'react';
import { amountsHidden, formatDay, formatInstantDay, formatMoney, hiddenFigure, hiddenMoney, trueMinus } from '@/lib/format';
import { Masked } from './HideAmounts';
import { readableName } from '@/lib/merchant-name';
import { displayName } from '@/lib/categories';
import { InvestmentActivitySkeleton } from './LoadingSkeletons';
import { Notice } from './TotalCaveats';
import type { MoneyInOut } from '@/lib/money-in-out';
import type { InvestmentMonths } from '@/lib/investment-months';
import { ACTIVITY_STILL_LOADING } from '@/lib/growth-summary';

type InvestmentTxn = {
  investment_transaction_id: string;
  date: string;
  name: string;
  type: string;
  subtype: string;
  quantity: number;
  amount: number;
  currency: string | null;
  security: string | null;
};

export type InvestmentActivityPayload = {
  txns: InvestmentTxn[];
  ytd_contributions: number;
  ytd_rollovers: number;
  /** Money crossing the account boundary per day, for the chart's added-vs-
   *  growth line. Null when unavailable or withheld (see the route). */
  flows?: { date: string; amount: number }[] | null;
  /** The moves taken out of `flows` (lib/growth.ts withoutMoves), as the days
   *  each spans: the line never starts between a move's two legs. */
  moves?: { from: string; to: string }[] | null;
  flows_from?: string | null;
  /** Last date the flows are known complete for; the line stops there. */
  flows_to?: string | null;
  note: string | null;
  /** The money in and out the person set for the account (lib/money-in-out.ts),
   *  read fresh beside the activity, or null; `money_in_out_unreadable` when
   *  they couldn't be read. */
  money_in_out?: MoneyInOut | null;
  money_in_out_unreadable?: boolean;
  /** The months imported for the account from its brokerage
   *  (lib/investment-months.ts), read fresh beside the activity, or null;
   *  `investment_months_unreadable` when they couldn't be read. */
  investment_months?: InvestmentMonths | null;
  investment_months_unreadable?: boolean;
  /** The days imports of the brokerage's transactions download decide
   *  (lib/investment-imports.ts), in order, each with its file. */
  imported_days?: { import_id: string; from: string; to: string; file_name: string | null; imported_at: string }[];
  /** Imports whose days don't reach Nya's activity, so they aren't used. */
  imports_unused?: string[];
};
type Payload = InvestmentActivityPayload;

// One request per account for both readers. The account's sheet mounts this list
// and the balance chart together, and both want this payload: fetched
// separately they would miss the server cache together and cost two live
// Plaid calls. Reused for a minute, which covers that and an expand/collapse;
// the server's own 15-minute cache covers the rest. A failure is dropped at
// once so the next mount retries, and so is an answer that the activity is
// still loading on another request, which the server doesn't keep either: a
// Refresh then asks again, as Accounts > Investments says to.
const REUSE_MS = 60_000;
const inflight = new Map<string, { at: number; promise: Promise<Payload> }>();

export function loadInvestmentActivity(accountId: string, itemId: string): Promise<Payload> {
  const key = `${itemId}:${accountId}`;
  const hit = inflight.get(key);
  if (hit && Date.now() - hit.at < REUSE_MS) return hit.promise;
  const promise = fetch(
    `/api/investment-activity?id=${encodeURIComponent(accountId)}&item_id=${encodeURIComponent(itemId)}`
  ).then((res) => {
    if (!res.ok) throw new Error(`investment-activity ${res.status}`);
    return res.json() as Promise<Payload>;
  });
  inflight.set(key, { at: Date.now(), promise });
  const drop = () => {
    if (inflight.get(key)?.promise === promise) inflight.delete(key);
  };
  promise.then((p) => {
    if (p.note?.includes(ACTIVITY_STILL_LOADING)) drop();
  }, drop);
  return promise;
}

// Readers of an account's payload that show its money in and out or its
// imported months (AccountSparkline, Accounts > Investments), told when
// either is saved, cleared, imported or undone.
const saved = new Set<(key: string) => void>();

/** The payload in hand takes `patch`, fresh for another REUSE_MS, and its
 *  readers load it again. With none in hand they fetch it. */
function patched(accountId: string, itemId: string, patch: Partial<Payload>): void {
  const key = `${itemId}:${accountId}`;
  const hit = inflight.get(key);
  if (hit) {
    const promise = hit.promise.then((p) => ({ ...p, ...patch }));
    inflight.set(key, { at: Date.now(), promise });
    promise.catch(() => {
      if (inflight.get(key)?.promise === promise) inflight.delete(key);
    });
  }
  for (const tell of saved) tell(key);
}

/** Money in and out were saved (or cleared, null) for an account. */
export function moneyInOutSaved(accountId: string, itemId: string, totals: MoneyInOut | null): void {
  patched(accountId, itemId, { money_in_out: totals, money_in_out_unreadable: false });
}

/** An account's imported months changed (an import or an undo): what is
 *  there now, or null. */
export function investmentMonthsSaved(accountId: string, itemId: string, months: InvestmentMonths | null): void {
  patched(accountId, itemId, { investment_months: months, investment_months_unreadable: false });
}

/** Transactions were imported into these accounts, or an import of them
 *  undone: what each one's activity is changed, so its copy goes and its
 *  readers load it again. */
export function investmentImportsChanged(accounts: readonly { account_id: string; item_id: string }[]): void {
  for (const { account_id, item_id } of accounts) {
    const key = `${item_id}:${account_id}`;
    inflight.delete(key);
    for (const tell of saved) tell(key);
  }
}

/** Calls `tell` with an account's key (`item:account`) when its money in and
 *  out or its imported months are saved, or its transactions imported;
 *  returns the unsubscribe, for an effect's cleanup. */
export function onMoneyInOutSaved(tell: (key: string) => void): () => void {
  saved.add(tell);
  return () => {
    saved.delete(tell);
  };
}

function fmtDay(iso: string): string {
  // Parsed at local midnight, not UTC, so a date never renders as the day
  // before for anyone west of Greenwich.
  // "Today", "Oct 5", "Oct 5, 2025" (lib/format.ts formatDay).
  return formatDay(iso);
}

/**
 * Plaid reports a positive amount when cash is debited. Flipped here so money
 * arriving in the account reads positive, matching how the Activity tab renders
 * cash transactions.
 *
 * Note this is cash movement, not change in total value: a buy shows as a large
 * negative even though the account is worth the same afterwards, because the
 * cash became securities. The caption below the table says so.
 */
function fmtAmount(t: InvestmentTxn): string {
  const flipped = -t.amount;
  if (amountsHidden()) return hiddenMoney(flipped, t.currency || 'USD', 'always');
  try {
    return trueMinus(
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: t.currency || 'USD',
        signDisplay: 'always',
      }).format(flipped)
    );
  } catch {
    return formatMoney(flipped, t.currency);
  }
}

export default function InvestmentActivity({
  accountId,
  itemId,
}: {
  accountId: string;
  itemId: string;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped when the account's transactions are imported or an import undone.
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    const mine = `${itemId}:${accountId}`;
    return onMoneyInOutSaved((key) => {
      if (key === mine) setChanges((n) => n + 1);
    });
  }, [accountId, itemId]);

  useEffect(() => {
    let cancelled = false;
    loadInvestmentActivity(accountId, itemId)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, itemId, changes]);

  if (failed)
    return (
      <Notice level="critical" role="alert">
        Could not load investment activity.
      </Notice>
    );
  if (data === null) return <InvestmentActivitySkeleton />;
  // With stored history, a note (institution down, storage problem) no longer
  // means there is nothing to show: say it, then show what is stored.
  if (data.txns.length === 0) {
    return <p className="empty-note">{data.note ? `${data.note}.` : 'No investment activity yet.'}</p>;
  }
  const imported = data.imported_days ?? [];

  return (
    <div className="inv-activity">
      {data.note && <p className="empty-note">{data.note}.</p>}
      {imported.length > 0 && <p className="chart-note">{importedText(imported)}</p>}
      {data.ytd_contributions > 0 && (
        <div className="type-tag">
          <Masked>{formatMoney(data.ytd_contributions, data.txns[0]?.currency)}</Masked> contributed this year
        </div>
      )}
      {/* Kept on its own line rather than added to the figure above: a rollover
          is existing retirement money arriving, not money saved this year. */}
      {data.ytd_rollovers > 0 && (
        <div className="type-tag">
          <Masked>{formatMoney(data.ytd_rollovers, data.txns[0]?.currency)}</Masked> rolled over this year
        </div>
      )}
      <table className="txn-table">
        <caption className="visually-hidden">Investment activity</caption>
        <tbody>
          {data.txns.map((t) => {
            const inflow = -t.amount > 0;
            return (
              <tr key={t.investment_transaction_id}>
                <td>
                  <div className="txn-text">
                    {readableName(t.name)}
                    <div className="type-tag">
                      {fmtDay(t.date)} · {displayName(t.subtype)}
                      {t.security ? ` · ${readableName(t.security)}` : ''}
                      {t.type === 'transfer' && t.quantity ? (
                        <>
                          , <Masked>{shares(t.quantity)}</Masked>
                        </>
                      ) : null}
                    </div>
                  </div>
                </td>
                <td className={`num${inflow ? ' inflow' : ''}`}>
                  <Masked>{fmtAmount(t)}</Masked>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="chart-note">
        Amounts are cash moving in and out of the account, not change in its value: a buy spends
        cash to hold securities worth the same.
        {imported.length > 0 && ' Shares moved in or out, as in a conversion, show what they were worth.'}
      </p>
    </div>
  );
}

/** "98.12 shares": the shares a row moved, without their sign. A figure of
 *  the person's, as a holding's quantity is: masked while amounts are
 *  hidden. */
function shares(quantity: number): string {
  const n = Math.abs(quantity);
  return `${hiddenFigure(n.toLocaleString(undefined, { maximumFractionDigits: 4 }))} ${n === 1 ? 'share' : 'shares'}`;
}

/** Which days come from which imported file, in order, and where to undo
 *  them: "Jun 1, 2025 to Nov 10 come from OfxDownload.csv, imported Nov 12.
 *  To undo it: ⋯, Import history from a file." */
export function importedText(days: NonNullable<Payload['imported_days']>): string {
  const day = (d: string) => formatDay(d, { sentence: true });
  const parts = days.map((d) => {
    const when = formatInstantDay(d.imported_at, { sentence: true });
    const span = d.from === d.to ? `${day(d.from)} comes` : `${day(d.from)} to ${day(d.to)} come`;
    return `${span} from ${d.file_name ?? 'Vanguard’s transactions download'}${when ? `, imported ${when}` : ''}`;
  });
  const said = parts.join('; ');
  const files = new Set(days.map((d) => d.import_id)).size;
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}. To undo ${files === 1 ? 'it' : 'one'}: ⋯, Import history from a file.`;
}
