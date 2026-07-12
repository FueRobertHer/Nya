'use client';

// Savings goals: a target amount tracked against a linked account's live
// balance. Progress meters use the accent hue, switching to the up-green
// once the goal is reached (state, not severity -- reaching a goal is good).

import { useState } from 'react';

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
};

function fmtUsd(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function GoalsCard({
  goals,
  accounts,
  onSave,
}: {
  goals: Goal[];
  accounts: GoalAccount[];
  onSave: (next: Goal[]) => void;
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

  function commit() {
    const value = Number(target);
    if (!name.trim() || !Number.isFinite(value) || value <= 0) return;
    const entry: Goal = {
      id: editing ?? crypto.randomUUID(),
      name: name.trim(),
      target: value,
      account_id: accountId || null,
    };
    const next = editing ? goals.map((g) => (g.id === editing ? entry : g)) : [...goals, entry];
    onSave(next);
    setEditing(null);
    setAdding(false);
  }

  function remove(id: string) {
    onSave(goals.filter((g) => g.id !== id));
    setEditing(null);
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
        {accounts.map((a) => (
          <option key={a.account_id} value={a.account_id}>
            {a.name} ({a.institution})
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

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Goals</div>
      </div>

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
        const balance = account?.balance ?? null;
        const ratio = balance != null ? Math.max(balance, 0) / goal.target : null;
        const done = ratio != null && ratio >= 1;
        return (
          <div className="budget-row" key={goal.id}>
            <button className="budget-summary" onClick={() => startEdit(goal)}>
              <div className="budget-line">
                <span className="budget-name">{goal.name}</span>
                <span className="budget-amounts">
                  {balance != null ? `${fmtUsd(balance)} of ` : ''}
                  {fmtUsd(goal.target)}
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
                  {goal.account_id ? 'linked account disconnected' : 'no account linked'}
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
