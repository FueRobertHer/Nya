'use client';

// Budgets tab -- the Mint core loop: monthly budgets per spending category
// with progress meters (fill carries severity: accent -> warning -> over),
// plus detected recurring bills. Spending is the current month's outflows that
// count in totals (lib/spending.ts: not transfers or loan payments, not
// excluded, and in the totals' currency, naming what is in others), from the
// already-loaded transactions: the same rule as the Activity tab and the Home
// insights, so a budget agrees with both.

import { useMemo, useState } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { type Txn } from './MonthBreakdown';
import { countsInTotals, leftOutByCurrency, leftOutText, totalsCurrency } from '@/lib/spending';
import { detectRecurring } from '@/lib/recurring';
import { localMonth, instantDay } from '@/lib/local-date';
import { formatMoney } from '@/lib/format';
import { monthGapNotes, type Incomplete, type Stopped } from '@/lib/month-coverage';
import { noSpending as noSpendingOf, refusedMonthNote, withoutNote, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import GoalsCard, { type Goal, type GoalAccount } from './GoalsCard';

// Stable empty defaults, as in Insights.
const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];

export type Budgets = Record<string, number>;

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function meterState(ratio: number): '' | ' warn' | ' over' {
  if (ratio >= 1) return ' over';
  if (ratio >= 0.85) return ' warn';
  return '';
}

export default function BudgetsTab({
  txns,
  budgets,
  budgetsStatus = 'ready',
  budgetsError = null,
  budgetsSaveError = null,
  onSave,
  goals,
  goalsStatus = 'ready',
  goalsError = null,
  goalsSaveError = null,
  onSaveGoals,
  accounts,
  loading,
  incomplete = NO_GAPS,
  stopped = NO_STOPPED,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
}: {
  txns: Txn[] | null;
  budgets: Budgets;
  /** Until 'ready', the list is unknown: shown as loading, never as "none",
   *  and not editable (lib/whole-list-store.ts). */
  budgetsStatus?: ListStatus;
  /** Why the budgets could not be loaded; shown instead of the list. */
  budgetsError?: string | null;
  /** Why the last save did not go through; shown above the list. */
  budgetsSaveError?: string | null;
  /** Resolves true once saved; forms only clear then, so nothing typed is
   *  lost to a failed save. */
  onSave: (next: Budgets) => Promise<boolean>;
  goals: Goal[];
  goalsStatus?: ListStatus;
  goalsError?: string | null;
  goalsSaveError?: string | null;
  onSaveGoals: (next: Goal[]) => Promise<boolean>;
  accounts: GoalAccount[];
  loading: boolean;
  /** What may leave this month's spending short, as Activity says it
   *  (lib/month-coverage.ts): a spent figure that looks finished but isn't
   *  makes a budget look safer than it is. */
  incomplete?: Incomplete[];
  stopped?: Stopped[];
  /** Connections that bring in no transactions (lib/no-transactions.ts). When
   *  none can bring in spending, a budget shows its limit and why there is
   *  nothing against it, never "$0 of" it; a bank account Plaid doesn't
   *  provide transactions for is named under the month. */
  withoutTransactions?: NoTransactionsView;
}) {
  const [editing, setEditing] = useState<string | null>(null); // category being edited
  const [editAmount, setEditAmount] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newAmount, setNewAmount] = useState('');

  const thisMonth = localMonth();
  const monthName = new Date().toLocaleDateString(undefined, { month: 'long' });

  // Budgets are plain numbers with no currency; they count, and are shown in,
  // the currency most transactions are in (lib/spending.ts), as the Activity
  // tab's totals are.
  const displayCurrency = useMemo(() => totalsCurrency(txns ?? []), [txns]);

  // Current-month spending per category.
  const spendByCat = useMemo(() => {
    const map: Record<string, number> = {};
    (txns ?? []).forEach((t) => {
      if (t.date.slice(0, 7) !== thisMonth || t.amount <= 0 || !countsInTotals(t, displayCurrency)) return;
      const cat = t.category ?? 'other';
      map[cat] = (map[cat] ?? 0) + t.amount;
    });
    return map;
  }, [txns, thisMonth, displayCurrency]);

  // This month's spending in other currencies, named rather than added.
  const leftOut = useMemo(
    () =>
      leftOutText(
        leftOutByCurrency(
          (txns ?? []).filter((t) => t.date.slice(0, 7) === thisMonth && t.amount > 0),
          displayCurrency
        ),
        displayCurrency,
        { where: 'these budgets' }
      ),
    [txns, thisMonth, displayCurrency]
  );

  // Categories seen anywhere in the window, offered when adding a budget.
  const availableCategories = useMemo(() => {
    const seen = new Set<string>();
    (txns ?? []).forEach((t) => {
      if (t.amount > 0 && countsInTotals(t, displayCurrency)) seen.add(t.category ?? 'other');
    });
    return [...seen].filter((c) => !(c in budgets)).sort();
  }, [txns, budgets, displayCurrency]);

  const budgetedCategories = useMemo(
    () =>
      Object.keys(budgets).sort(
        (a, b) => (spendByCat[b] ?? 0) / budgets[b] - (spendByCat[a] ?? 0) / budgets[a]
      ),
    [budgets, spendByCat]
  );

  const recurring = useMemo(() => (txns ? detectRecurring(txns) : []), [txns]);

  // The bills' monthly total adds up those in the budgets' currency; each bill
  // is listed in its own, and those in others are named.
  const { monthlyBills, billsLeftOut } = useMemo(() => {
    let total = 0;
    const others = new Map<string, number>();
    for (const b of recurring) {
      const c = b.currency ?? displayCurrency;
      if (c === displayCurrency || displayCurrency === null) total += b.amount;
      else if (c) others.set(c, (others.get(c) ?? 0) + 1);
    }
    const leftOut = [...others].map(([currency, count]) => ({ currency, count })).sort((a, b) => b.count - a.count);
    return {
      monthlyBills: total,
      billsLeftOut: leftOutText(leftOut, displayCurrency, { noun: 'bill', where: 'this total', plural: false }),
    };
  }, [recurring, displayCurrency]);

  if (loading) {
    return (
      <div className="card">
        <div className="spinner" role="status" aria-label="Loading budgets" />
      </div>
    );
  }

  const totalBudget = Object.values(budgets).reduce((a, b) => a + b, 0);
  const totalSpent = budgetedCategories.reduce((sum, c) => sum + (spendByCat[c] ?? 0), 0);
  const totalRatio = totalBudget > 0 ? totalSpent / totalBudget : 0;
  // No connection can bring in spending, and none came from anywhere else
  // (rows entered by hand count): say so, rather than "$0 of" every limit.
  // With rows entered by hand, the connections that bring in none are named
  // beside the budgets instead, as where the spending comes from.
  const noSpending = txns ? noSpendingOf(withoutTransactions, txns.length) : null;
  const refusedNote = noSpending ? null : refusedMonthNote(withoutTransactions);
  const namedWithout = withoutNote(withoutTransactions, txns?.length ?? 0);

  function startEdit(category: string) {
    setEditing(category);
    setEditAmount(String(budgets[category]));
  }

  async function saveEdit(category: string) {
    const value = Number(editAmount);
    if (!Number.isFinite(value) || value <= 0) return;
    if (await onSave({ ...budgets, [category]: value })) setEditing(null);
  }

  async function removeBudget(category: string) {
    const next = { ...budgets };
    delete next[category];
    if (await onSave(next)) setEditing(null);
  }

  async function addBudget() {
    const value = Number(newAmount);
    if (!newCategory || !Number.isFinite(value) || value <= 0) return;
    if (await onSave({ ...budgets, [newCategory]: value })) {
      setNewCategory('');
      setNewAmount('');
    }
  }

  return (
    <>
      <div className="card">
        <div className="inst-header">
          <div className="inst-name">{monthName} budgets</div>
          {totalBudget > 0 && budgetsStatus === 'ready' && !noSpending && (
            <div className="inst-total">
              {formatMoney(totalSpent, displayCurrency)} of{' '}
              {formatMoney(totalBudget, displayCurrency)}
            </div>
          )}
        </div>

        {budgetsStatus === 'loading' ? (
          <p className="empty-note">Loading budgets…</p>
        ) : budgetsStatus === 'error' ? (
          <p className="stale-note">{budgetsError}</p>
        ) : (
          <>
        {budgetsSaveError && <p className="stale-note">{budgetsSaveError}</p>}
        {noSpending && (
          <p className="empty-note">
            {noSpending.lead}, so there&apos;s no spending to count against budgets. To track them, {noSpending.remedy}.
          </p>
        )}
        {totalBudget > 0 && !noSpending && (
          <div className={`meter-track${meterState(totalRatio)}`}>
            <div
              className={`meter-fill${meterState(totalRatio)}`}
              style={{ width: `${Math.min(totalRatio * 100, 100)}%` }}
            />
          </div>
        )}

        {budgetedCategories.length === 0 && (
          <p className="empty-note">
            No budgets yet — add one below to start tracking spending against a monthly limit.
          </p>
        )}

        {budgetedCategories.map((cat) => {
          const spent = spendByCat[cat] ?? 0;
          const budget = budgets[cat];
          const ratio = spent / budget;
          return (
            <div className="budget-row" key={cat}>
              {editing === cat ? (
                <div className="budget-edit">
                  <span className="budget-name">{cat}</span>
                  <input
                    className="text-input budget-input"
                    type="number"
                    min="1"
                    step="1"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    aria-label={`Monthly budget for ${cat}`}
                  />
                  <div className="card-actions">
                    <button onClick={() => saveEdit(cat)}>Save</button>
                    <button className="secondary" onClick={() => removeBudget(cat)}>
                      Remove
                    </button>
                    <button className="secondary" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button className="budget-summary" onClick={() => startEdit(cat)}>
                  <div className="budget-line">
                    <span className="budget-name">{cat}</span>
                    <span className="budget-amounts">
                      {noSpending ? (
                        `${formatMoney(budget, displayCurrency)} limit`
                      ) : (
                        <>
                          {formatMoney(spent, displayCurrency)} of{' '}
                          {formatMoney(budget, displayCurrency)}
                          {ratio >= 1 && <span className="over-tag"> · over</span>}
                        </>
                      )}
                    </span>
                  </div>
                  {!noSpending && (
                    <div className={`meter-track${meterState(ratio)}`}>
                      <div
                        className={`meter-fill${meterState(ratio)}`}
                        style={{ width: `${Math.min(ratio * 100, 100)}%` }}
                      />
                    </div>
                  )}
                </button>
              )}
            </div>
          );
        })}

        <div className="budget-add">
          <select
            className="text-input budget-select"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            aria-label="Category to budget"
          >
            <option value="">Choose a category…</option>
            {availableCategories.map((c) => (
              <option key={c} value={c}>
                {c}
                {spendByCat[c]
                  ? ` (${formatMoney(spendByCat[c], displayCurrency)} this month)`
                  : ''}
              </option>
            ))}
          </select>
          <input
            className="text-input budget-input"
            type="number"
            min="1"
            step="1"
            placeholder="Monthly limit"
            value={newAmount}
            onChange={(e) => setNewAmount(e.target.value)}
            aria-label="Monthly limit"
          />
          <button onClick={addBudget} disabled={!newCategory || !newAmount}>
            Add Budget
          </button>
        </div>
          </>
        )}

        {leftOut && <div className="chart-note">{leftOut}</div>}
        {totalBudget > 0 && namedWithout && <div className="chart-note">{namedWithout}</div>}
        {totalBudget > 0 &&
          [...monthGapNotes(thisMonth, incomplete, stopped, (at) => instantDay(at) ?? at.slice(0, 10)), ...(refusedNote ? [refusedNote] : [])].map((n) => (
            <div className="stale-note" key={n}>
              {n}
            </div>
          ))}
      </div>

      <GoalsCard
        goals={goals}
        status={goalsStatus}
        error={goalsError}
        saveError={goalsSaveError}
        accounts={accounts}
        onSave={onSaveGoals}
      />

      <div className="card">
        <div className="inst-header">
          <div className="inst-name">Recurring bills</div>
          {recurring.length > 0 && (
            <div className="inst-total">
              ~{formatMoney(monthlyBills, displayCurrency)}/mo
            </div>
          )}
        </div>

        {recurring.length === 0 && noSpending ? (
          <p className="empty-note">{noSpending.lead}, so there are no bills to detect.</p>
        ) : recurring.length === 0 ? (
          <p className="empty-note">
            No recurring charges detected yet — they show up once a merchant has billed a
            consistent amount for three months.
          </p>
        ) : (
          <table>
            <tbody>
              {recurring.map((b) => (
                <tr key={`${b.institution}-${b.name}`}>
                  <td>
                    <div className="txn-main">
                      {b.logo_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className="txn-logo" src={b.logo_url} alt="" loading="lazy" />
                      ) : (
                        <span className="txn-logo txn-logo-fallback" aria-hidden="true">
                          {b.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <div className="txn-text">
                        {b.name}
                        <div className="type-tag">
                          {b.institution} · {b.monthsSeen} months · next ~{fmtDay(b.nextDate)}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="num">
                    {formatMoney(b.amount, b.currency ?? displayCurrency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="chart-note">
          Detected from repeating charges of a consistent amount.{billsLeftOut && ` ${billsLeftOut}`}
        </div>
      </div>
    </>
  );
}
