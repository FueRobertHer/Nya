'use client';

// Adding or editing a savings goal (#42), in the drawer (components/Sheet.tsx):
// its name, target and account, and its plan: part of the account's balance
// set aside for it (an allocation), a monthly target and a target date. Every
// field is checked here as the server checks it (components/goal-draft.ts),
// on the balances this page shows, so a save is never refused with nothing
// to say why; the server still checks on the balances it last measured, and
// its reason is shown here when it differs. The form only closes once the
// server took the change.

import { useEffect, useId, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { formatMoney, hideAmountsIn } from '@/lib/format';
import { isOwedType } from '@/lib/balance';
import { goalViews, type GoalAccount } from '@/lib/goal-view';
import { endedTag, outlookText, sourceNote } from '@/lib/goal-text';
import { LATEST_TARGET_DATE, MAX_GOAL_NAME_CHARS, type Goal } from '@/lib/goal-model';
import type { AccountFlow } from '@/lib/goal-projection';
import { archivedGoal, draftOf, pickAccount, readDraft, type Draft, type DraftField } from './goal-draft';
import { Notice } from './TotalCaveats';
import FieldError from './FieldError';
import ActionRows from './ActionRows';

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
  // Asked to delete it: a level of the sheet that asks, what was typed kept.
  const [asking, setAsking] = useState(false);
  const errorId = useId();
  const failedId = useId();
  // The level's safe answer takes focus when it opens (after the sheet's own
  // focus on its panel), and Delete goal takes it back after Cancel.
  const safe = useRef<HTMLButtonElement>(null);
  const deleteRow = useRef<HTMLButtonElement>(null);
  const returning = useRef(false);
  useEffect(() => {
    if (asking) safe.current?.focus({ preventScroll: true });
    else if (returning.current) {
      returning.current = false;
      deleteRow.current?.focus({ preventScroll: true });
    }
  }, [asking]);
  // Into the level or back out of it: what the last try said was about the
  // other (saveError is the card's, so it is set aside, not cleared).
  const ask = (on: boolean) => {
    if (saving) return;
    returning.current = !on;
    setAttempted(false);
    setAsking(on);
  };
  const back = () => ask(false);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));

  const read = readDraft(d, { goal, goals, accounts, today, newId });
  const { entry, account, currency, room } = read;
  // What is wrong with a field, said under it.
  const wrong = (field: DraftField) => {
    const at = read.errorFields.indexOf(field);
    return at < 0 ? null : read.errors[at];
  };
  const money = (n: number) => formatMoney(n, currency);
  const nameOf = (id: string) => goals.find((g) => g.id === id)?.name ?? 'another goal';
  // Hidden accounts, ones that ended, cards and loans aren't offered; one a
  // goal tracks already stays listed, marked, so the picker never shows it
  // blank.
  const offered = accounts.filter((a) => (!a.hidden && !a.ended && !(a.type && isOwedType(a.type))) || a.account_id === goal?.account_id);

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
  // Archiving keeps the goal, with its history and what was typed in the
  // form, and releases what it set aside (components/goal-draft.ts).
  const archived = goal ? archivedGoal(d, { goal, goals, accounts, today }) : null;
  const canArchive = archived !== null;
  const archive = () => {
    if (goal && archived) void commit(goals.map((g) => (g.id === goal.id ? archived : g)));
  };

  // The buttons, and why a save failed beside them; asked to delete, Cancel
  // and Delete in their place.
  const failed = attempted && saveError ? failedId : undefined;
  const footer = (
    <>
      {attempted && saveError && (
        <div className="sheet-footer-note" id={failedId}>
          <Notice level="critical" role="alert">
            <Masked>{hideAmountsIn(saveError)}</Masked>
          </Notice>
        </div>
      )}
      {asking && goal ? (
        <>
          <button type="button" ref={safe} className="btn secondary" onClick={back} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={() => commit(goals.filter((g) => g.id !== goal.id))} disabled={saving} aria-describedby={failed}>
            {saving ? 'Deleting…' : 'Delete'}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={save} disabled={!read.ready || saving} aria-describedby={failed}>
            {saving ? 'Saving…' : goal ? 'Save' : 'Add goal'}
          </button>
        </>
      )}
    </>
  );

  // The level that asks: the same sheet (what was typed stays in this
  // component's state), with a back arrow to the form.
  if (asking && goal) {
    return (
      <Sheet open={open} title="Delete goal" level="delete" onBack={back} onClose={() => !saving && onClose()} footer={footer}>
        <p>Delete {goal.name} for good? It can&apos;t be undone. Archiving keeps it instead, with its history.</p>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} title={goal ? 'Edit goal' : 'Add a goal'} onClose={() => !saving && onClose()} footer={footer}>
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={MAX_GOAL_NAME_CHARS} placeholder="e.g. Emergency fund" autoCapitalize="sentences" disabled={saving} />
        </label>
        <label className="field">
          Target{currency ? ` (${currency})` : ''}
          <input
            inputMode="decimal"
            autoComplete="off"
            value={d.target}
            onChange={(e) => set({ target: e.target.value })}
            placeholder="0.00"
            aria-invalid={!!wrong('target')}
            aria-describedby={wrong('target') ? `${errorId}-target` : undefined}
            disabled={saving}
          />
        </label>
        {wrong('target') && (
          <FieldError id={`${errorId}-target`}>
            <Masked>{wrong('target')}</Masked>
          </FieldError>
        )}
        <label className="field">
          Account
          <select
            value={d.account}
            onChange={(e) => setD((cur) => pickAccount(cur, e.target.value))}
            aria-invalid={!!wrong('account')}
            aria-describedby={wrong('account') ? `${errorId}-account` : undefined}
            disabled={saving}
          >
            <option value="">No account: not tracked</option>
            {offered.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.name}
                {a.institution ? ` (${a.institution})` : ''}
                {a.ended ? ` · ${endedTag(a.ended)}` : a.hidden ? ' · hidden' : a.type && isOwedType(a.type) ? ' · owed, not saved' : ''}
              </option>
            ))}
            {goal?.account_id && !accounts.some((a) => a.account_id === goal.account_id) && <option value={goal.account_id}>Disconnected account</option>}
          </select>
        </label>
        {wrong('account') && (
          <FieldError id={`${errorId}-account`}>
            <Masked>{wrong('account')}</Masked>
          </FieldError>
        )}
        <label className="goal-check">
          {/* Never disabled while checked, so it can always be cleared. */}
          <input type="checkbox" checked={d.allocate} onChange={(e) => set({ allocate: e.target.checked })} disabled={saving || (!d.account && !d.allocate)} />
          Set part of the balance aside for this goal
        </label>
        {d.allocate && !!d.account && (
          <label className="field">
            Set aside{currency ? ` (${currency})` : ''}
            <input
              inputMode="decimal"
              autoComplete="off"
              value={d.allocation}
              onChange={(e) => set({ allocation: e.target.value })}
              placeholder="0.00"
              aria-invalid={!!wrong('allocation')}
              aria-describedby={wrong('allocation') ? `${errorId}-allocation` : undefined}
              disabled={saving}
            />
          </label>
        )}
        {wrong('allocation') && (
          <FieldError id={`${errorId}-allocation`}>
            <Masked>{wrong('allocation')}</Masked>
          </FieldError>
        )}
        {account && room !== null && (
          <p className="panel-note goal-room">
            <Masked>
              {d.allocate
                ? `Up to ${money(room)} of ${account.name}’s ${money(account.balance!)} can be set aside for it.`
                : `Without an allocation it counts what the allocated goals on ${account.name} leave: all of it when none is allocated.`}
            </Masked>
          </p>
        )}
        <label className="field">
          Monthly target (optional){currency ? ` (${currency})` : ''}
          <input
            inputMode="decimal"
            autoComplete="off"
            value={d.monthly}
            onChange={(e) => set({ monthly: e.target.value })}
            placeholder="0.00"
            aria-invalid={!!wrong('monthly')}
            aria-describedby={wrong('monthly') ? `${errorId}-monthly` : undefined}
            disabled={saving}
          />
        </label>
        {wrong('monthly') && (
          <FieldError id={`${errorId}-monthly`}>
            <Masked>{wrong('monthly')}</Masked>
          </FieldError>
        )}
        <label className="field">
          Target date (optional)
          <input
            type="date"
            value={d.date}
            min={today}
            max={LATEST_TARGET_DATE}
            onChange={(e) => set({ date: e.target.value })}
            aria-invalid={!!wrong('date')}
            aria-describedby={wrong('date') ? `${errorId}-date` : undefined}
            disabled={saving}
          />
        </label>
        {wrong('date') && (
          <FieldError id={`${errorId}-date`}>
            <Masked>{wrong('date')}</Masked>
          </FieldError>
        )}
      </div>
      <div className="stack tight">
        {preview && (
          <p className="panel-note">
            <Masked>{preview}</Masked>
          </p>
        )}
        <p className="panel-note">
          An allocation is the part of the account’s balance this goal counts as its own: the money stays in the account, and goals never count more than it holds.
        </p>
      </div>
      {/* Its actions, last: Archive acts in place (the archived list
          restores it); Delete, for a goal not reached, opens the level that
          asks. */}
      {goal && (
        <div className="stack tight">
          {reached && <p className="panel-note">Reached. Archive it to keep it, with its history, and free what it set aside.</p>}
          {!canArchive && <p className="panel-note">Archiving saves your changes too, so it waits until they can be saved.</p>}
          <ActionRows
            rows={[
              { key: 'archive', title: 'Archive goal', sub: 'Keeps it, with its history.', disabled: saving || !canArchive, onSelect: archive },
              ...(reached ? [] : [{ key: 'delete', title: 'Delete goal', sub: 'Asks first.', opens: true, neg: true, ref: deleteRow, disabled: saving, onSelect: () => ask(true) }]),
            ]}
          />
        </div>
      )}
    </Sheet>
  );
}
