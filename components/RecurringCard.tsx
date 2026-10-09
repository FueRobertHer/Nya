'use client';

// Recurring bills and income on the Budgets tab (lib/recurring.ts): each with
// its cadence, how many times it was seen, its typical amount and when it is
// next expected, bills and income apart. One whose scheduled dates went by
// with nothing arriving is listed last as possibly ended, and is left out of
// the monthly figures. Tap one for "Not recurring", which dismisses it from
// here, the forecast, the calendar and Home's upcoming bills; it is saved
// with the planned items (lib/planned.ts), and the dismissed are listed to
// restore. The monthly figures add up what is in the totals' currency.

import { useState } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { addDays, cadenceLabel, expectedDates, perMonth, type RecurringSeries } from '@/lib/recurring';
import { formatMoney } from '@/lib/format';
import { leftOutText, type LeftOut } from '@/lib/spending';
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
}: {
  series: RecurringSeries[];
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  /** The totals' currency, for the monthly figures and amounts without one. */
  currency: string | null;
  /** Ids dismissed as not recurring. */
  dismissed: readonly string[];
  /** The planned items' state: dismissing waits until they have loaded. */
  status?: ListStatus;
  saveError?: string | null;
  /** Saves a dismissal (true) or a restore (false); resolves true once saved. */
  onDismiss?: (id: string, dismiss: boolean) => Promise<boolean>;
  /** No connection brings in transactions: what to say instead. */
  noSpending?: NoSpending | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  const gone = new Set(dismissed);
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

  // A month's worth of what is still coming, in one currency; the rest named.
  const monthly = (list: Row[]) => {
    let total = 0;
    const others = new Map<string, number>();
    for (const r of list) {
      if (r.status === 'ended') continue;
      const c = r.series.currency ?? currency;
      if (c === currency || currency === null) total += perMonth(r.series);
      else if (c) others.set(c, (others.get(c) ?? 0) + 1);
    }
    const leftOut: LeftOut = [...others].map(([c, count]) => ({ currency: c, count })).sort((a, b) => b.count - a.count);
    return { total, leftOut };
  };
  const billsMonthly = monthly(bills);
  const incomeMonthly = monthly(income);
  const leftOut = [
    leftOutText(billsMonthly.leftOut, currency, { noun: 'bill', where: 'this total', plural: false }),
    leftOutText(incomeMonthly.leftOut, currency, { noun: 'deposit', where: 'the income total', plural: false }),
  ]
    .filter(Boolean)
    .join(' ');

  const canEdit = status === 'ready' && !!onDismiss && !busy;

  async function toggle(id: string, dismiss: boolean) {
    if (!onDismiss) return;
    setBusy(true);
    try {
      if (await onDismiss(id, dismiss)) setOpen(null);
    } finally {
      setBusy(false);
    }
  }

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
    return `${s.institution} · ${cadenceLabel(s.cadence)} · seen ${s.seen} times${when ? ` · ${when}` : ''}`;
  };

  const table = (list: Row[]) => (
    <table>
      <tbody>
        {list.map((r) => {
          const s = r.series;
          const isOpen = open === s.id;
          return (
            <tr key={s.id} className={`acct-row${r.status === 'ended' ? ' recurring-ended' : ''}`} onClick={() => setOpen(isOpen ? null : s.id)}>
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
                      Seen {s.seen} times from {fmtDay(s.firstDate)} to {fmtDay(s.lastDate)}, about {formatMoney(s.amount, s.currency ?? currency)} each time.
                    </p>
                    <div className="card-actions" style={{ marginTop: 8 }}>
                      <button className="secondary" disabled={!canEdit} onClick={() => toggle(s.id, true)}>
                        Not recurring
                      </button>
                    </div>
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
        {bills.some((r) => r.status !== 'ended') && <div className="inst-total">~{formatMoney(billsMonthly.total, currency)}/mo out</div>}
      </div>

      {saveError && <p className="stale-note">{saveError}</p>}

      {rows.length === 0 && noSpending ? (
        <p className="empty-note">{noSpending.lead}, so there are no bills to detect.</p>
      ) : rows.length === 0 ? (
        <p className="empty-note">
          No recurring bills or income detected yet. They show up once a merchant has charged, or paid you, a consistent amount on a
          regular schedule: three times for most, twice for a yearly charge.
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
                {income.some((r) => r.status !== 'ended') && <span> · ~{formatMoney(incomeMonthly.total, currency)}/mo in</span>}
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
                    {s.name} <span className="type-tag">{s.institution} · {cadenceLabel(s.cadence)}</span>
                  </span>
                  <button className="link-btn" disabled={!canEdit} onClick={() => toggle(s.id, false)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="chart-note">
        Detected from charges and deposits that repeat on a schedule at a consistent amount; dates and amounts are estimates.
        {leftOut && ` ${leftOut}`}
      </div>
    </div>
  );
}
