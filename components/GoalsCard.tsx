'use client';

// Savings goals (#42): a target tracked against an account's balance. Each
// goal counts its allocation of that balance, or what the allocations on it
// leave (the whole balance when none is allocated, as every goal did before
// allocations), never more than the account holds (lib/goal-allocation.ts);
// says when it will be reached at the pace money went in, or at its monthly
// target (lib/goal-projection.ts); and, with a target date, marks on its
// meter where it should be by now. What each account leaves unallocated is
// above the list. Goals reached are archived rather than deleted, so their
// history survives, in a list that can be opened to restore one or delete it
// for good.
//
// Progress meters use the accent hue, switching to the up-green once the goal
// is reached (state, not severity: reaching a goal is good); the "where you
// should be" marker is a lighter tick on the track, said in words to a
// screen reader (lib/goal-text.ts meterLabel). Everything is worked out here
// from the balances this page shows; the months behind each pace come from
// the server (components/goal-flows-state.ts), and nothing derived is saved.
//
// With no goal at all (none archived either), the card is the empty state
// (components/EmptyState.tsx, the screen review after step 5): what goals
// are for and Add goal as its one primary. Add goal is one button either way
// (`addRef`), so a sheet that closes once the button it opened from is gone
// (the first goal saved takes the empty state with it) gives focus to the
// Add goal under the list, as Budgets' does.

import { useEffect, useRef, useState } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { formatMoney, hideAmountsIn, spoken } from '@/lib/format';
import { localDate } from '@/lib/local-date';
import { goalViews, type GoalAccount, type GoalView } from '@/lib/goal-view';
import { archivedText, gapItem, goalNotes, meterLabel, outlookText, sourceNote, splitText, stateText, type GapItem } from '@/lib/goal-text';
import { MAX_GOALS, type Goal } from '@/lib/goal-model';
import { useGoalFlows, type GoalFlowsState } from './goal-flows-state';
import GoalSheet from './GoalSheet';
import GoalPlansRepair, { type GoalPlansDamage } from './GoalPlansRepair';
import { Masked } from './HideAmounts';
import TotalCaveats, { type Caveat } from './TotalCaveats';
import EmptyState from './EmptyState';

export type { Goal } from '@/lib/goal-model';
export type { GoalAccount } from '@/lib/goal-view';

/** A goal as a save sends it: its four fields and its plan, always, `{}` for
 *  none (a goal sent without one keeps what is stored: lib/goal-model.ts).
 *  What the server works out is left out; it sends that back. */
const forSave = (g: Goal): Goal => ({ id: g.id, name: g.name, target: g.target, account_id: g.account_id, plan: g.plan ?? {} });

type CardProps = {
  goals: Goal[];
  /** Until 'ready', the list is unknown: shown as loading, never as "none",
   *  with no way to add or edit (lib/whole-list-store.ts). */
  status?: ListStatus;
  /** Why the goals could not be loaded; shown instead of the list. */
  error?: string | null;
  /** Why the last save did not go through; shown above the list. */
  saveError?: string | null;
  /** When the goals couldn't load for plans that can't be read, how many of
   *  each kind: the damaged ones can be removed here, once confirmed. */
  damage?: GoalPlansDamage;
  /** Loads the goals again once they are removed. */
  onRepaired?: () => void;
  /** Every account, hidden ones too, and those that ended, each with its end
   *  (lib/goal-view.ts withAccountEnds): a goal tracking one says so, rather
   *  than "disconnected", which would be alarming and false. The editor
   *  keeps them out of its picker. */
  accounts: GoalAccount[];
  /** Resolves true once saved; the editor only closes then. */
  onSave: (next: Goal[]) => Promise<boolean>;
};

/** The card, with the months behind each pace read once its goals are in. */
export default function GoalsCard(props: CardProps) {
  const flows = useGoalFlows((props.status ?? 'ready') === 'ready');
  return <GoalsCardView {...props} flows={flows} />;
}

/** The card as shown, given the months (components/goal-flows-state.ts). */
export function GoalsCardView({
  goals,
  status = 'ready',
  error = null,
  saveError = null,
  damage,
  onRepaired,
  accounts,
  onSave,
  flows,
}: CardProps & { flows: GoalFlowsState }) {
  const today = localDate();
  // The editor: a fresh form each time it opens (a new key), kept while it
  // slides shut.
  const [sheet, setSheet] = useState<{ open: boolean; goal: Goal | null; key: number }>({ open: false, goal: null, key: 0 });
  const [showArchived, setShowArchived] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (next: Goal[]) => {
    setBusy(true);
    try {
      return await onSave(next.map(forSave));
    } finally {
      setBusy(false);
    }
  };
  const edit = (goal: Goal | null) => setSheet((s) => ({ open: true, goal, key: s.key + 1 }));
  // A list that can't be loaded (a save's reload that found it unreadable,
  // say) can't be saved either: the editor closes, and the card says why.
  useEffect(() => {
    if (status === 'error') setSheet((s) => (s.open ? { ...s, open: false } : s));
  }, [status]);
  // Closed: the sheet gives focus back to the button that opened it as its
  // own effect ends, which runs before this one. When it couldn't (that
  // button went meanwhile: the empty state's, once the first goal is in),
  // focus goes to Add goal as it is drawn now, rather than to nothing.
  const addRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(sheet.open);
  useEffect(() => {
    const closed = wasOpen.current && !sheet.open;
    wasOpen.current = sheet.open;
    if (!closed) return;
    let lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
    for (let n: Element | null = document.activeElement; n && !lost; n = n.parentElement) lost = n.getAttribute('role') === 'dialog';
    if (lost) addRef.current?.focus({ preventScroll: true });
  }, [sheet.open]);

  const { views, splits } = goalViews(goals, accounts, flows.flows, today);
  const archived = goals.filter((g) => g.plan?.archived);
  const nameOf = (id: string) => goals.find((g) => g.id === id)?.name ?? 'another goal';
  const accountName = (id: string) => accounts.find((a) => a.account_id === id)?.name ?? 'An account';
  const currencyOf = (g: Goal) => accounts.find((a) => a.account_id === g.account_id)?.currency ?? null;

  /** The outlook, once the months behind it are in; when they couldn't be
   *  read, only what the monthly targets say. */
  const outlook = (v: GoalView): string | null => {
    const p = v.projection;
    if (!p) return null;
    if (flows.status === 'loading' && p.status !== 'complete' && p.rateFrom !== 'monthly_target') return null;
    if (flows.status === 'error' && p.status === 'no_rate' && v.sharing.length === 0) return null;
    const said = outlookText(v, nameOf);
    const from = sourceNote(v);
    return said && from ? `${said}. ${from}` : said;
  };

  // What may be missing from the paces, said once at the card's top, before
  // the goals (design-system.md "Status and honesty" rule 3), each in its
  // words and at its level: what the server couldn't read, and each gap note
  // two or more goals say word for word, those goals badged. A gap note only
  // one goal says stays on it: it names a bank, not the goal, and the rows
  // don't show the account. Built in a list, one at a time.
  const projected = views.some((v) => v.projection);
  const gaps = new Map<string, GapItem>();
  const sayers = new Map<string, number>();
  for (const v of views) {
    const gap = gapItem(v);
    if (!gap) continue;
    gaps.set(v.goal.id, gap);
    sayers.set(gap.text, (sayers.get(gap.text) ?? 0) + 1);
  }
  const caveats: Caveat[] = [];
  if (flows.status === 'error' && projected) {
    caveats.push({
      key: 'flows-error',
      severity: 'caution',
      summary: 'paces at monthly targets only',
      body: 'How much went into your accounts couldn’t be read just now, so goals are projected at their monthly targets only.',
    });
  }
  if (projected) for (const n of flows.notes) caveats.push({ key: `flows-note:${n}`, severity: 'caution', summary: 'some data couldn’t be read', body: n });
  const onTop = new Set<string>();
  for (const v of views) {
    const gap = gaps.get(v.goal.id);
    if (!gap || (sayers.get(gap.text) ?? 0) < 2 || onTop.has(gap.text)) continue;
    onTop.add(gap.text);
    caveats.push({
      key: `gap:${gap.text}`,
      severity: 'caution',
      summary: gap.kind === 'off' ? 'a goal’s pace may be off' : 'a goal’s pace not known',
      body: gap.text,
    });
  }
  const allocated = [...splits.values()].filter((s) => s.hasAllocations);

  // The editor stays mounted whatever the list's state: a save that fails
  // reloads the list (lib/whole-list-store.ts), and what was typed, with why
  // it wasn't saved, must still be there when it is back.
  const editor = (
    <GoalSheet
      key={sheet.key}
      open={sheet.open}
      goal={sheet.goal}
      goals={goals}
      accounts={accounts}
      flows={flows.flows}
      today={today}
      saveError={saveError}
      onClose={() => setSheet((s) => ({ ...s, open: false }))}
      onSave={save}
    />
  );

  // No title of its own: the Budgets tab's bar names the segment
  // (components/BudgetsBar.tsx).
  if (status !== 'ready') {
    return (
      <div className="card goals-card">
        {status === 'loading' ? <p className="empty-note">Loading goals…</p> : <p className="stale-note">{error}</p>}
        {/* Plans that can't be read: said with the load's error, with the repair. */}
        {status === 'error' && damage && onRepaired && damage.unreadable + damage.unrecognised > 0 && (
          <GoalPlansRepair damage={damage} onRepaired={onRepaired} />
        )}
        {editor}
      </div>
    );
  }

  return (
    <div className="card goals-card">
      {(saveError || caveats.length > 0 || allocated.length > 0) && (
        <div className="stack tight">
          {saveError && <p className="stale-note"><Masked>{hideAmountsIn(saveError)}</Masked></p>}
          <TotalCaveats items={caveats} />
          {/* Each account with allocations on it: what they leave, or how
              far they are over its balance. */}
          {allocated.map((s) => (
            <p className="panel-note goal-unallocated" key={s.account_id}>
              <Masked>{splitText(s, accountName(s.account_id))}</Masked>
            </p>
          ))}
        </div>
      )}

      {goals.length === 0 && (
        <EmptyState
          title="No goals yet"
          line="Set a target, track it against an account’s balance, and see when you’ll reach it."
          action={{ label: 'Add goal', opens: true, ref: addRef, onSelect: () => edit(null) }}
        />
      )}

      {views.map((v) => {
        const goal = v.goal;
        const done = v.projection?.status === 'complete';
        const ratio = v.saved !== null ? Math.max(v.saved, 0) / goal.target : null;
        const marker = v.shouldHave !== null ? Math.min(Math.max(v.shouldHave, 0) / goal.target, 1) : null;
        const said = outlook(v);
        // Underfunded, as a budget target would say: short of its date, or
        // nothing went in lately.
        const behind = v.projection?.status === 'behind' || v.projection?.status === 'no_recent_contributions';
        // Its gap note when it is said at the top: badged here instead.
        const gap = gaps.get(goal.id);
        const above = gap && onTop.has(gap.text) ? gap : null;
        // Warnings in the warning style; what only informs, plain.
        const notes = goalNotes(v, nameOf, goal.account_id ? splits.get(goal.account_id) : undefined).filter((n) => n.text !== above?.text);
        return (
          <div className="budget-row" key={goal.id}>
            <button className="budget-summary" onClick={() => edit(goal)}>
              <div className="budget-line">
                <span>
                  <span className="budget-name">{goal.name}</span>
                  {above && <> <span className="badge warn">{above.kind === 'off' ? 'Pace may be off' : 'Pace not known'}</span></>}
                </span>
                <span className="budget-amounts">
                  <Masked>{`${v.saved !== null ? `${formatMoney(v.saved, v.currency)} of ` : ''}${formatMoney(goal.target, v.currency)}`}</Masked>
                  {done && <span className="done-tag"> · reached</span>}
                </span>
              </div>
              {ratio !== null ? (
                <div className="meter-track goal-meter" role="img" aria-label={spoken(meterLabel(v))}>
                  <div className={`meter-fill${done ? ' done' : ''}`} style={{ width: `${Math.min(ratio * 100, 100)}%` }} />
                  {marker !== null && <span className="goal-marker" style={{ left: `${marker * 100}%` }} />}
                </div>
              ) : (
                <div className="type-tag">
                  <Masked>{stateText(v)}</Masked>
                </div>
              )}
            </button>
            {said && (
              <p className={`goal-outlook${behind ? ' behind' : ''}`}>
                <Masked>{said}</Masked>
              </p>
            )}
            {notes.map((n) => (
              <p className={`${n.warn ? 'stale-note' : 'panel-note'} goal-note`} key={n.text}>
                <Masked>{n.text}</Masked>
              </p>
            ))}
          </div>
        );
      })}

      {goals.length > 0 && (
        <div className="card-actions" style={{ marginTop: 16 }}>
          <button ref={addRef} className="secondary" onClick={() => edit(null)} disabled={goals.length >= MAX_GOALS}>
            Add goal
          </button>
        </div>
      )}
      {goals.length >= MAX_GOALS && <p className="panel-note">{MAX_GOALS} goals is the most, archived ones included: delete an archived one to add another.</p>}

      {archived.length > 0 && (
        <div className="recurring-dismissed">
          <button className="link-btn" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
            {archived.length} archived · {showArchived ? 'Hide' : 'Show'}
          </button>
          {showArchived && (
            <ul className="recurring-dismissed-list">
              {archived.map((g) => {
                const { archived: _restored, ...restored } = g.plan ?? {};
                return (
                  <li key={g.id}>
                    <span>
                      {g.name}{' '}
                      <span className="type-tag">
                        <Masked>{archivedText(g, currencyOf(g))}</Masked>
                      </span>
                    </span>
                    {confirmDelete === g.id ? (
                      <span className="goal-archived-actions">
                        <button className="link-btn" onClick={() => setConfirmDelete(null)} disabled={busy}>
                          Keep
                        </button>
                        <button className="link-btn danger-link" onClick={async () => (await save(goals.filter((o) => o.id !== g.id))) && setConfirmDelete(null)} disabled={busy}>
                          Delete for good
                        </button>
                      </span>
                    ) : (
                      <span className="goal-archived-actions">
                        <button className="link-btn" onClick={() => void save(goals.map((o) => (o.id === g.id ? { ...g, plan: restored } : o)))} disabled={busy}>
                          Restore
                        </button>
                        <button className="link-btn danger-link" onClick={() => setConfirmDelete(g.id)} disabled={busy}>
                          Delete
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {editor}
    </div>
  );
}
