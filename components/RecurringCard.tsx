'use client';

// Recurring bills and income on the Budgets tab (lib/recurring.ts): each with
// its account, cadence, how many times it was seen, its typical amount and
// when it is next expected, bills and income apart. One whose scheduled dates
// went by with nothing arriving is listed last as possibly ended, and is left
// out of the monthly figures, as is pay whose amount varies too much to
// forecast. Tap one for "Not recurring", which dismisses it from here, the
// forecast, the calendar and Home's upcoming bills; it is saved with the
// planned items (lib/planned.ts), and the dismissed are listed to restore.
// The monthly figures add up what is in the totals' currency, as the read-only
// API does (lib/totals.ts recurringMonthly).

import { useState } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { addDays, cadenceLabel, expectedDates, type RecurringSeries } from '@/lib/recurring';
import { formatMoney } from '@/lib/format';
import { leftOutText } from '@/lib/spending';
import { countsInMonthly, recurringMonthly } from '@/lib/totals';
import type { NoSpending } from '@/lib/no-transactions';

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** How far ahead "next" looks: past a yearly series' next date. */
const NEXT_WITHIN_DAYS = 400;

type Row = { series: RecurringSeries; status: 'due' | 'late' | 'ended'; next: string | null; due: string | null };

export default function RecurringCard({
  series,
  today,
  currency,
  dismissed,
  status = 'ready',
  saveError = null,
  onDismiss,
  noSpending = null,
  loading = false,
  failed = false,
}: {
  series: RecurringSeries[];
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  /** The totals' currency, for the monthly figures and amounts without one. */
  currency: string | null;
  /** The series dismissed as not recurring (lib/recurring.ts
   *  dismissedSeries). */
  dismissed: ReadonlySet<string>;
  /** The planned items' state: dismissing waits until they have loaded. */
  status?: ListStatus;
  saveError?: string | null;
  /** Saves a dismissal (true) or a restore (false); resolves true once saved. */
  onDismiss?: (series: RecurringSeries, dismiss: boolean) => Promise<boolean>;
  /** No connection brings in transactions: what to say instead. */
  noSpending?: NoSpending | null;
  /** Transactions are still loading, or couldn't be loaded. */
  loading?: boolean;
  failed?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  const gone = dismissed;
  const until = addDays(today, NEXT_WITHIN_DAYS);
  const rows: Row[] = series
    .filter((s) => !gone.has(s.id))
    .map((s) => {
      const e = expectedDates(s, today, until);
      const first = e.dates[0];
      return { series: s, status: e.status, next: first?.date ?? null, due: first?.late ? first.due : null };
    });
  // Ended ones last, each kind largest first as detected.
  const ordered = (kind: 'bill' | 'income') => rows.filter((r) => r.series.kind === kind).sort((a, b) => Number(a.status === 'ended') - Number(b.status === 'ended'));
  const bills = ordered('bill');
  const income = ordered('income');
  const dismissedRows = series.filter((s) => gone.has(s.id));

  // In a monthly figure: still coming, its amount known, and not a card's
  // payment (its card's bills are counted where they are charged). A month's
  // worth of what is still coming, in one currency; the rest named.
  const inTotal = (r: Row) => countsInMonthly(r.series, today);
  const billsMonthly = recurringMonthly(
    bills.map((r) => r.series),
    today,
    currency
  );
  const incomeMonthly = recurringMonthly(
    income.map((r) => r.series),
    today,
    currency
  );
  const leftOut = [
    leftOutText(billsMonthly.leftOut, currency, { noun: 'bill', where: 'this total', plural: false }),
    leftOutText(incomeMonthly.leftOut, currency, { noun: 'deposit', where: 'the income total', plural: false }),
  ]
    .filter(Boolean)
    .join(' ');

  const canEdit = status === 'ready' && !!onDismiss && !busy;
  // Why the buttons are off, said where they are.
  const why =
    status === 'error'
      ? "Your planned items couldn't be loaded, so this can't be saved now."
      : status === 'loading'
        ? 'Your planned items are still loading.'
        : !onDismiss
          ? "This can't be changed here."
          : null;

  async function toggle(s: RecurringSeries, dismiss: boolean) {
    if (!onDismiss) return;
    setBusy(true);
    try {
      if (await onDismiss(s, dismiss)) setOpen(null);
    } finally {
      setBusy(false);
    }
  }

  const where = (s: RecurringSeries) => (s.account ? `${s.institution} · ${s.account}` : s.institution);
  const line = (r: Row) => {
    const s = r.series;
    const when =
      r.status === 'ended'
        ? `last ${fmtDay(s.lastDate)}, may have ended`
        : r.status === 'late' && r.due
          ? `due ${fmtDay(r.due)}, not in yet`
          : r.next
            ? `next ~${fmtDay(r.next)}`
            : '';
    return [
      where(s),
      cadenceLabel(s.cadence),
      `seen ${s.seen} times`,
      s.pending ? `latest ${fmtDay(s.lastDate)}, pending` : null,
      s.agreement === 'varies' ? 'amount varies' : null,
      s.paysCard ? (s.paysCardOf ? `pays ${s.paysCardOf.account || 'a card'}` : 'pays a card') : null,
      when || null,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  // What the forecast makes of it, for the open row.
  const counted = (s: RecurringSeries) =>
    s.paysCard
      ? "It pays a card off, so it isn't in the monthly total here, where the card's own bills are; the forecast counts it, as the money leaving your checking."
      : s.agreement === 'varies'
      ? 'Its amount varies too much to forecast, so the forecast leaves it out and says so.'
      : s.accountType === 'credit'
        ? `Charged to ${s.account || 'a card'}: the forecast counts the card's payment from your checking instead, when that repeats at a steady amount.`
        : s.accountType && s.accountType !== 'depository'
          ? `On ${s.account || 'an account'}, which isn't checking or savings, so the forecast doesn't count it.`
          : s.accountType === null
            ? "The account it's on isn't known, so the forecast doesn't count it."
            : null;

  const table = (list: Row[]) => (
    <table>
      <tbody>
        {list.map((r) => {
          const s = r.series;
          const isOpen = open === s.id;
          return (
            <tr
              key={s.id}
              className={`acct-row${r.status === 'ended' ? ' recurring-ended' : ''}`}
              onClick={() => setOpen(isOpen ? null : s.id)}
              // Reachable by keyboard too: Enter or Space opens it.
              tabIndex={0}
              aria-expanded={isOpen}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                e.preventDefault();
                setOpen(isOpen ? null : s.id);
              }}
            >
              <td>
                <div className="txn-main">
                  {s.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="txn-logo" src={s.logo_url} alt="" loading="lazy" />
                  ) : (
                    <span className="txn-logo txn-logo-fallback" aria-hidden="true">
                      {s.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <div className="txn-text">
                    {s.name}
                    <div className="type-tag">{line(r)}</div>
                  </div>
                </div>
                {isOpen && (
                  <div className="txn-edit" onClick={(e) => e.stopPropagation()}>
                    <p className="panel-note" style={{ marginTop: 4 }}>
                      Seen {s.seen} times from {fmtDay(s.firstDate)} to {fmtDay(s.lastDate)}, about {formatMoney(s.amount, s.currency ?? currency)}{' '}
                      {s.agreement === 'average' ? 'each time, the average of the last half year' : 'each time'}
                      {s.previousAmount !== undefined ? `, ${formatMoney(s.previousAmount, s.currency ?? currency)} before its price changed` : ''}.
                      {counted(s) ? ` ${counted(s)}` : ''}
                    </p>
                    <div className="card-actions" style={{ marginTop: 8 }}>
                      <button className="secondary" disabled={!canEdit} onClick={() => toggle(s, true)}>
                        Not recurring
                      </button>
                    </div>
                    {why && <p className="panel-note">{why}</p>}
                  </div>
                )}
              </td>
              <td className={`num${s.kind === 'income' ? ' inflow' : ''}`}>
                {s.kind === 'income' ? '+' : ''}
                {formatMoney(s.amount, s.currency ?? currency)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Recurring</div>
        {bills.some(inTotal) && <div className="inst-total">~{formatMoney(billsMonthly.total, currency)}/mo out</div>}
      </div>

      {saveError && <p className="stale-note">{saveError}</p>}
      {status === 'error' && series.length > 0 && <p className="stale-note">{why}</p>}

      {failed && series.length === 0 ? (
        <p className="error">Transactions couldn&apos;t be loaded, so no bills or income can be found.</p>
      ) : loading && series.length === 0 ? (
        <p className="empty-note">Transactions are still loading.</p>
      ) : rows.length === 0 && noSpending ? (
        <p className="empty-note">{noSpending.lead}, so there are no bills to detect.</p>
      ) : rows.length === 0 ? (
        <p className="empty-note">
          No recurring bills or income detected yet. They show up once a merchant has charged, or paid you, the same amount on a
          regular schedule three times (four when the amount varies a little), or a yearly charge twice at exactly the same amount.
        </p>
      ) : (
        <>
          {bills.length > 0 && (
            <>
              <div className="recurring-section">Bills</div>
              {table(bills)}
            </>
          )}
          {income.length > 0 && (
            <>
              <div className="recurring-section">
                Income
                {income.some(inTotal) && <span> · ~{formatMoney(incomeMonthly.total, currency)}/mo in</span>}
              </div>
              {table(income)}
            </>
          )}
        </>
      )}

      {dismissedRows.length > 0 && (
        <div className="recurring-dismissed">
          <button className="link-btn" onClick={() => setShowDismissed(!showDismissed)} aria-expanded={showDismissed}>
            {dismissedRows.length} marked not recurring · {showDismissed ? 'Hide' : 'Show'}
          </button>
          {showDismissed && (
            <ul className="recurring-dismissed-list">
              {dismissedRows.map((s) => (
                <li key={s.id}>
                  <span>
                    {s.name} <span className="type-tag">{where(s)} · {cadenceLabel(s.cadence)}</span>
                  </span>
                  <button className="link-btn" disabled={!canEdit} onClick={() => toggle(s, false)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
          {showDismissed && why && <p className="panel-note">{why}</p>}
        </div>
      )}

      <div className="chart-note">
        Detected from charges and deposits that repeat on a schedule at a consistent amount; dates and amounts are estimates.
        {bills.some((r) => r.series.accountType === 'credit') && ' Bills charged to a card are in this total, and the forecast counts the card\'s payment instead.'}
        {leftOut && ` ${leftOut}`}
      </div>
    </div>
  );
}
