'use client';

// Savings goals: a target amount tracked against a linked account's live
// balance. Progress meters use the accent hue, switching to the up-green
// once the goal is reached (state, not severity -- reaching a goal is good).

import { useState } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { formatMoney } from '@/lib/format';

export type Goal = {
  id: string;
  name: string;
  target: number;
  account_id: string | null;
};

export type GoalAccount = {
  account_id: string;
  name: string;
  institution: string;
  balance: number | null;
  currency: string | null;
  // Hidden accounts are still passed in so a goal tracking one can say so,
  // rather than falling through to "linked account disconnected", which would
  // be alarming and false. They're kept out of the picker below.
  hidden?: boolean;
};

export default function GoalsCard({
  goals,
  status = 'ready',
  error = null,
  saveError = null,
  accounts,
  onSave,
}: {
  goals: Goal[];
  /** Until 'ready', the list is unknown: shown as loading, never as "none",
   *  with no way to add or edit (lib/whole-list-store.ts). */
  status?: ListStatus;
  /** Why the goals could not be loaded; shown instead of the list. */
  error?: string | null;
  /** Why the last save did not go through; shown above the list. */
  saveError?: string | null;
  accounts: GoalAccount[];
  /** Resolves true once saved; the form only closes then. */
  onSave: (next: Goal[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [accountId, setAccountId] = useState('');
  const [adding, setAdding] = useState(false);

  const accountById = new Map(accounts.map((a) => [a.account_id, a]));

  function startAdd() {
    setAdding(true);
    setEditing(null);
    setName('');
    setTarget('');
    setAccountId('');
  }

  function startEdit(goal: Goal) {
    setEditing(goal.id);
    setAdding(false);
    setName(goal.name);
    setTarget(String(goal.target));
    setAccountId(goal.account_id ?? '');
  }

  async function commit() {
    const value = Number(target);
    if (!name.trim() || !Number.isFinite(value) || value <= 0) return;
    const entry: Goal = {
      id: editing ?? crypto.randomUUID(),
      name: name.trim(),
      target: value,
      account_id: accountId || null,
    };
    const next = editing ? goals.map((g) => (g.id === editing ? entry : g)) : [...goals, entry];
    if (await onSave(next)) {
      setEditing(null);
      setAdding(false);
    }
  }

  async function remove(id: string) {
    if (await onSave(goals.filter((g) => g.id !== id))) setEditing(null);
  }

  const form = (
    <div className="budget-edit">
      <input
        className="text-input budget-input"
        placeholder="Goal name (e.g. Emergency fund)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Goal name"
      />
      <input
        className="text-input budget-input"
        type="number"
        min="1"
        step="1"
        placeholder="Target amount"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        aria-label="Target amount"
      />
      <select
        className="text-input budget-select"
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
        aria-label="Tracked account"
      >
        <option value="">No linked account</option>
        {accounts
          // Hidden accounts aren't offered, but one that's already selected
          // stays listed so the picker doesn't render blank on an existing goal.
          .filter((a) => !a.hidden || a.account_id === accountId)
          .map((a) => (
            <option key={a.account_id} value={a.account_id}>
              {a.name} ({a.institution})
              {a.hidden ? ' · hidden' : ''}
            </option>
          ))}
      </select>
      <div className="card-actions">
        <button onClick={commit} disabled={!name.trim() || !target}>
          Save
        </button>
        {editing && (
          <button className="secondary" onClick={() => remove(editing)}>
            Remove
          </button>
        )}
        <button
          className="secondary"
          onClick={() => {
            setEditing(null);
            setAdding(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  if (status !== 'ready') {
    return (
      <div className="card">
        <div className="inst-header">
          <div className="inst-name">Goals</div>
        </div>
        {status === 'loading' ? (
          <p className="empty-note">Loading goals…</p>
        ) : (
          <p className="stale-note">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Goals</div>
      </div>

      {saveError && <p className="stale-note">{saveError}</p>}

      {goals.length === 0 && !adding && (
        <p className="empty-note">
          No goals yet — set a target and track it against an account balance.
        </p>
      )}

      {goals.map((goal) => {
        if (editing === goal.id) {
          return (
            <div className="budget-row" key={goal.id}>
              {form}
            </div>
          );
        }
        const account = goal.account_id ? accountById.get(goal.account_id) : undefined;
        // A hidden account contributes nothing anywhere else, so it shouldn't
        // drive a progress meter either. Treated as untracked, but labelled
        // distinctly below so it doesn't read as "disconnected".
        const balance = account && !account.hidden ? account.balance : null;
        const currency = account?.currency ?? null;
        const ratio = balance != null ? Math.max(balance, 0) / goal.target : null;
        const done = ratio != null && ratio >= 1;
        return (
          <div className="budget-row" key={goal.id}>
            <button className="budget-summary" onClick={() => startEdit(goal)}>
              <div className="budget-line">
                <span className="budget-name">{goal.name}</span>
                <span className="budget-amounts">
                  {balance != null ? `${formatMoney(balance, currency)} of ` : ''}
                  {formatMoney(goal.target, currency)}
                  {done && <span className="done-tag"> · reached</span>}
                </span>
              </div>
              {ratio != null ? (
                <div className="meter-track">
                  <div
                    className={`meter-fill${done ? ' done' : ''}`}
                    style={{ width: `${Math.min(ratio * 100, 100)}%` }}
                  />
                </div>
              ) : (
                <div className="type-tag">
                  {account?.hidden
                    ? 'tracked account is hidden'
                    : goal.account_id
                      ? 'linked account disconnected'
                      : 'no account linked'}
                </div>
              )}
            </button>
          </div>
        );
      })}

      {adding ? (
        <div className="budget-row">{form}</div>
      ) : (
        <div className="card-actions" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={startAdd}>
            Add Goal
          </button>
        </div>
      )}
    </div>
  );
}
