'use client';

// Budgets tab -- the Mint core loop: monthly budgets per spending category
// with progress meters (fill carries severity: accent -> warning -> over),
// plus detected recurring bills. Spending is the current month's non-transfer
// outflows, from the already-loaded transactions.

import { useMemo, useState } from 'react';
import { type Txn } from './MonthBreakdown';
import { detectRecurring } from '@/lib/recurring';
import GoalsCard, { type Goal, type GoalAccount } from './GoalsCard';

export type Budgets = Record<string, number>;

function fmtUsd(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function isTransfer(t: Txn): boolean {
  return !!t.category && (t.category.startsWith('transfer') || t.category === 'loan payments');
}

function meterState(ratio: number): '' | ' warn' | ' over' {
  if (ratio >= 1) return ' over';
  if (ratio >= 0.85) return ' warn';
  return '';
}

export default function BudgetsTab({
  txns,
  budgets,
  onSave,
  goals,
  onSaveGoals,
  accounts,
  loading,
}: {
  txns: Txn[] | null;
  budgets: Budgets;
  onSave: (next: Budgets) => void;
  goals: Goal[];
  onSaveGoals: (next: Goal[]) => void;
  accounts: GoalAccount[];
  loading: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null); // category being edited
  const [editAmount, setEditAmount] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newAmount, setNewAmount] = useState('');

  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthName = new Date().toLocaleDateString(undefined, { month: 'long' });

  // Current-month spending per category.
  const spendByCat = useMemo(() => {
    const map: Record<string, number> = {};
    (txns ?? []).forEach((t) => {
      if (t.date.slice(0, 7) !== thisMonth || t.amount <= 0 || isTransfer(t)) return;
      const cat = t.category ?? 'other';
      map[cat] = (map[cat] ?? 0) + t.amount;
    });
    return map;
  }, [txns, thisMonth]);

  // Categories seen anywhere in the window, offered when adding a budget.
  const availableCategories = useMemo(() => {
    const seen = new Set<string>();
    (txns ?? []).forEach((t) => {
      if (t.amount > 0 && !isTransfer(t)) seen.add(t.category ?? 'other');
    });
    return [...seen].filter((c) => !(c in budgets)).sort();
  }, [txns, budgets]);

  const budgetedCategories = useMemo(
    () =>
      Object.keys(budgets).sort(
        (a, b) => (spendByCat[b] ?? 0) / budgets[b] - (spendByCat[a] ?? 0) / budgets[a]
      ),
    [budgets, spendByCat]
  );

  const recurring = useMemo(() => (txns ? detectRecurring(txns) : []), [txns]);

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
  const monthlyBills = recurring.reduce((sum, b) => sum + b.amount, 0);

  function startEdit(category: string) {
    setEditing(category);
    setEditAmount(String(budgets[category]));
  }

  function saveEdit(category: string) {
    const value = Number(editAmount);
    if (!Number.isFinite(value) || value <= 0) return;
    onSave({ ...budgets, [category]: value });
    setEditing(null);
  }

  function removeBudget(category: string) {
    const next = { ...budgets };
    delete next[category];
    onSave(next);
    setEditing(null);
  }

  function addBudget() {
    const value = Number(newAmount);
    if (!newCategory || !Number.isFinite(value) || value <= 0) return;
    onSave({ ...budgets, [newCategory]: value });
    setNewCategory('');
    setNewAmount('');
  }

  return (
    <>
      <div className="card">
        <div className="inst-header">
          <div className="inst-name">{monthName} budgets</div>
          {totalBudget > 0 && (
            <div className="inst-total">
              {fmtUsd(totalSpent)} of {fmtUsd(totalBudget)}
            </div>
          )}
        </div>

        {totalBudget > 0 && (
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
                      {fmtUsd(spent)} of {fmtUsd(budget)}
                      {ratio >= 1 && <span className="over-tag"> · over</span>}
                    </span>
                  </div>
                  <div className={`meter-track${meterState(ratio)}`}>
                    <div
                      className={`meter-fill${meterState(ratio)}`}
                      style={{ width: `${Math.min(ratio * 100, 100)}%` }}
                    />
                  </div>
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
                {spendByCat[c] ? ` (${fmtUsd(spendByCat[c])} this month)` : ''}
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
      </div>

      <GoalsCard goals={goals} accounts={accounts} onSave={onSaveGoals} />

      <div className="card">
        <div className="inst-header">
          <div className="inst-name">Recurring bills</div>
          {recurring.length > 0 && <div className="inst-total">~{fmtUsd(monthlyBills)}/mo</div>}
        </div>

        {recurring.length === 0 ? (
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
                    {b.name}
                    <div className="type-tag">
                      {b.institution} · {b.monthsSeen} months · next ~{fmtDay(b.nextDate)}
                    </div>
                  </td>
                  <td className="num">{fmtUsd(b.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="chart-note">Detected from repeating charges of a consistent amount.</div>
      </div>
    </>
  );
}
