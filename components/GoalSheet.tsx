'use client';

// Adding or editing a savings goal (#42), in the drawer (components/Sheet.tsx):
// its name, target and account, and its plan: part of the account's balance
// set aside for it (an allocation), a monthly target and a target date. Every
// field is checked here as the server checks it (components/goal-draft.ts),
// on the balances this page shows, so a save is never refused with nothing
// to say why; the server still checks on the balances it last measured, and
// its reason is shown here when it differs. The form only closes once the
// server took the change.

import { useState } from 'react';
import { Sheet } from './Sheet';
import { formatMoney } from '@/lib/format';
import { isOwedType } from '@/lib/balance';
import { goalViews, type GoalAccount } from '@/lib/goal-view';
import { outlookText, sourceNote } from '@/lib/goal-text';
import { LATEST_TARGET_DATE, MAX_GOAL_NAME_CHARS, type Goal } from '@/lib/goal-model';
import type { AccountFlow } from '@/lib/goal-projection';
import { draftOf, readDraft, type Draft } from './goal-draft';

export default function GoalSheet({
  open,
  goal,
  goals,
  accounts,
  flows,
  today,
  saveError,
  onClose,
  onSave,
}: {
  open: boolean;
  /** The goal edited; null to add one. */
  goal: Goal | null;
  /** Every goal, for what is allocated on an account already. */
  goals: Goal[];
  accounts: GoalAccount[];
  /** Each account's months, for the outlook as you type; null while unknown. */
  flows: Map<string, AccountFlow> | null;
  /** The viewer's day, YYYY-MM-DD. */
  today: string;
  saveError: string | null;
  onClose: () => void;
  /** Resolves true once saved. */
  onSave: (next: Goal[]) => Promise<boolean>;
}) {
  const [d, setD] = useState<Draft>(() => draftOf(goal));
  const [newId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));

  const read = readDraft(d, { goal, goals, accounts, today, newId });
  const { entry, account, currency, room } = read;
  const money = (n: number) => formatMoney(n, currency);
  const nameOf = (id: string) => goals.find((g) => g.id === id)?.name ?? 'another goal';
  // Hidden accounts, cards and loans aren't offered; one a goal tracks
  // already stays listed, marked, so the picker never shows it blank.
  const offered = accounts.filter((a) => (!a.hidden && !(a.type && isOwedType(a.type))) || a.account_id === goal?.account_id);

  // How it would go with what is typed: the same view the card shows, for
  // the list as this save would leave it (a handful of goals: cheap enough to
  // work out on every keystroke).
  const preview = (() => {
    if (!read.ready || !read.trackable) return null;
    const others = goals.filter((g) => g.id !== entry.id);
    const view = goalViews([...others, { ...entry, plan_start: goal?.plan_start }], accounts, flows, today).views.find((v) => v.goal.id === entry.id);
    const said = view ? outlookText(view, nameOf) : null;
    if (!view || !said) return null;
    const from = sourceNote(view);
    return `${said}${from ? `. ${from}` : ''}.`;
  })();
  // A goal reached is archived, not deleted, so its history survives:
  // deleting for good is in the archived list.
  const reached = !!goal && goalViews(goals, accounts, flows, today).views.find((v) => v.goal.id === goal.id)?.projection?.status === 'complete';

  async function commit(next: Goal[]) {
    setSaving(true);
    setAttempted(true);
    try {
      if (await onSave(next)) onClose();
    } finally {
      setSaving(false);
    }
  }
  const save = () => read.ready && commit(goal ? goals.map((g) => (g.id === goal.id ? entry : g)) : [...goals, entry]);
  // Archiving keeps the goal as it is saved, with its history, and releases
  // what it set aside (lib/goal-save.ts).
  const archive = () => {
    if (!goal) return;
    const { allocation: _released, ...kept } = goal.plan ?? {};
    void commit(goals.map((g) => (g.id === goal.id ? { ...goal, plan: { ...kept, archived: true } } : g)));
  };

  return (
    <Sheet open={open} title={goal ? 'Edit goal' : 'Add a goal'} onClose={() => !saving && onClose()}>
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={MAX_GOAL_NAME_CHARS} placeholder="e.g. Emergency fund" autoCapitalize="sentences" disabled={saving} />
        </label>
        <label className="field">
          Target{currency ? ` (${currency})` : ''}
          <input inputMode="decimal" autoComplete="off" value={d.target} onChange={(e) => set({ target: e.target.value })} placeholder="0.00" disabled={saving} />
        </label>
        <label className="field">
          Account
          <select value={d.account} onChange={(e) => set({ account: e.target.value })} disabled={saving}>
            <option value="">No account: not tracked</option>
            {offered.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.name}
                {a.institution ? ` (${a.institution})` : ''}
                {a.hidden ? ' · hidden' : a.type && isOwedType(a.type) ? ' · owed, not saved' : ''}
              </option>
            ))}
            {goal?.account_id && !accounts.some((a) => a.account_id === goal.account_id) && <option value={goal.account_id}>Disconnected account</option>}
          </select>
        </label>
        <label className="goal-check">
          <input type="checkbox" checked={d.allocate} onChange={(e) => set({ allocate: e.target.checked })} disabled={saving || !d.account} />
          Set part of the balance aside for this goal
        </label>
        {d.allocate && (
          <label className="field">
            Set aside{currency ? ` (${currency})` : ''}
            <input inputMode="decimal" autoComplete="off" value={d.allocation} onChange={(e) => set({ allocation: e.target.value })} placeholder="0.00" disabled={saving} />
          </label>
        )}
        {account && room !== null && (
          <p className="panel-note goal-room">
            {d.allocate
              ? `Up to ${money(room)} of ${account.name}’s ${money(account.balance!)} can be set aside for it.`
              : `Without an allocation it counts what the allocated goals on ${account.name} leave: all of it when none is allocated.`}
          </p>
        )}
        <label className="field">
          Monthly target (optional){currency ? ` (${currency})` : ''}
          <input inputMode="decimal" autoComplete="off" value={d.monthly} onChange={(e) => set({ monthly: e.target.value })} placeholder="0.00" disabled={saving} />
        </label>
        <label className="field">
          Target date (optional)
          <input type="date" value={d.date} min={today} max={LATEST_TARGET_DATE} onChange={(e) => set({ date: e.target.value })} disabled={saving} />
        </label>
      </div>
      {read.errors.map((e) => (
        <div className="error" key={e}>
          {e}
        </div>
      ))}
      {preview && <p className="panel-note">{preview}</p>}
      <p className="panel-note">
        An allocation is the part of the account’s balance this goal counts as its own: the money stays in the account, and goals never count more than it holds.
      </p>
      {attempted && saveError && <div className="error">{saveError}</div>}
      {confirmDelete && goal ? (
        <>
          <p className="panel-note">Delete {goal.name} for good? Archiving keeps it, with its history.</p>
          <div className="button-pair" style={{ marginTop: 12 }}>
            <button className="secondary" onClick={() => setConfirmDelete(false)} disabled={saving}>
              Keep it
            </button>
            <button className="danger" onClick={() => commit(goals.filter((g) => g.id !== goal.id))} disabled={saving}>
              {saving ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="button-pair" style={{ marginTop: 16 }}>
            <button className="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button onClick={save} disabled={!read.ready || saving}>
              {saving ? 'Saving…' : goal ? 'Save' : 'Add goal'}
            </button>
          </div>
          {goal && (
            <div className="goal-sheet-actions">
              {reached && <p className="panel-note">Reached. Archive it to keep it, with its history, and free what it set aside.</p>}
              <button className="secondary" onClick={archive} disabled={saving}>
                Archive goal
              </button>
              {!reached && (
                <button className="danger-outline" onClick={() => setConfirmDelete(true)} disabled={saving}>
                  Delete goal
                </button>
              )}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
