'use client';

// The month's budgets on the Budgets tab, rolled up to your category groups
// (lib/budget-set.ts): each group with a budget, or with budgeted categories,
// is a meter, collapsed, and opens with a tap to its categories, each with a
// meter of its own. A budget is set on a category or on a group as a whole: a
// group's is a cap on everything in it, and when both are set, the group's
// meter shows min(the group's amount, its categories' added up), with a line
// saying which binds (THE RECONCILE RULE there). Spending is counted by
// lib/totals.ts, by category id: the Activity tab's rule, one currency, what
// the person excluded and transfers left out.
//
// ROLLOVER (#37, lib/rollover.ts). With the month's carries, each meter is
// spending against what is available (the amount plus what rolled over, which
// is negative after overspending), with the carry beneath it ("+$120 rolled
// over", "$45 overspent, carried over") and, when a month it counts may be
// incomplete, that it may be off. Nothing available is said in words, never
// as a limit of zero or below: "$37.50 spent, nothing left", and how far over
// the month began. The reconcile rule works on what is available. Without
// carries (not loaded, or none), meters are as before.
// Editing a budget offers rolling it over, from a month chosen (this month by
// default), turning it off, and resetting its carry to zero (confirmed first).
//
// Budgets are saved whole (lib/whole-list-store.ts, app/api/budgets), so
// nothing here edits until they have loaded; a save that fails puts back what
// is stored. A budget on a category or group since deleted is shown, and can
// be removed. A past month is shown as it was, and not edited.

import { useMemo, useState } from 'react';
import { formatMoney } from '@/lib/format';
import { budgetMeters, placeBudgets, type Budgets, type GroupMeter } from '@/lib/budget-set';
import { categoriesIn, displayName, indexTaxonomy, sortedGroups, type Taxonomy } from '@/lib/categories';
import { carryText, monthName, sinceText, startChoices, withCarry, type Carries, type Carry } from '@/lib/rollover';
import { localMonth } from '@/lib/local-date';
import { Sheet } from './Sheet';

function meterState(ratio: number): '' | ' warn' | ' over' {
  if (ratio >= 1) return ' over';
  if (ratio >= 0.85) return ' warn';
  return '';
}

/** Spending against a limit: full and over once the limit is used up, or
 *  when there is none left at all (a carry deeper than the budget). */
function Meter({ spent, limit }: { spent: number; limit: number }) {
  const ratio = limit > 0 ? spent / limit : spent > 0 || limit < 0 ? 1 : 0;
  return (
    <div className={`meter-track${meterState(ratio)}`}>
      <div className={`meter-fill${meterState(ratio)}`} style={{ width: `${Math.min(ratio * 100, 100)}%` }} />
    </div>
  );
}

/** Spending against what is available, in words: "$80.00 of $300.00"; with
 *  nothing available (an overspent carry as deep as the budget, or deeper),
 *  "$37.50 spent, nothing left". Tagged over once the limit is used up, and
 *  with nothing left only once something is spent or the month began over. */
function Amounts({ spent, limit, money }: { spent: number; limit: number; money: (n: number) => string }) {
  const over = limit > 0 ? spent >= limit : spent > 0 || limit < 0;
  return (
    <>
      {limit > 0 ? `${money(spent)} of ${money(limit)}` : `${money(spent)} spent, nothing left`}
      {over && <span className="over-tag"> · over</span>}
    </>
  );
}

/** Beneath a meter whose month began over (an overspent carry deeper than
 *  the budget): by how much, rather than a limit below zero. */
function BeganOver({ limit, money }: { limit: number; money: (n: number) => string }) {
  return limit < 0 ? <div className="budget-carry negative">Began the month {money(-limit)} over.</div> : null;
}

/** What is being edited: a category's budget or a group's own. */
export type Target = { kind: 'category' | 'group'; id: string };

const keyOf = (t: Target) => `${t.kind}:${t.id}`;

/** What the editor knows of rollover now (app/api/budgets/month): each
 *  budget rolling over and since when, the earliest month each can start
 *  from, and the first month with any transactions. */
export type RolloverSettings = {
  rolling: { categories: Record<string, string>; groups: Record<string, string> };
  starts: { categories: Record<string, string>; groups: Record<string, string> };
  earliest: string | null;
};

/** A change to a budget's rollover, as the editor asks for it. */
export type RolloverChange = { on: true; from: string } | { on: false } | { reset: true };

export default function BudgetsCard({
  taxonomy,
  budgets,
  spent,
  currency,
  editable,
  noSpending,
  onSave,
  open: opened = [],
  edit,
  carries = null,
  month,
  past = false,
  rollover = null,
  onRollover,
}: {
  taxonomy: Taxonomy;
  budgets: Budgets;
  /** This month's spending by category id (lib/totals.ts spendingByCategory). */
  spent: Readonly<Record<string, number>>;
  currency: string | null;
  /** Loaded, so it can be saved over. */
  editable: boolean;
  /** No connection can bring in spending: limits, never "$0 of". */
  noSpending: boolean;
  /** Resolves true once saved; forms only clear then, so nothing typed is
   *  lost to a failed save. */
  onSave: (next: Budgets) => Promise<boolean>;
  /** Groups shown opened at first, by id; every other starts collapsed. */
  open?: readonly string[];
  /** A budget whose editor is shown open at first (in an opened group). */
  edit?: Target;
  /** What rolls into the month shown, by category and group id
   *  (lib/rollover.ts), or null when not known: meters without it. */
  carries?: Carries | null;
  /** The month shown (this month by default), for what is said of it. */
  month?: string;
  /** A month gone by: shown as it was, with nothing to edit or add. */
  past?: boolean;
  /** Rollover now, for the editor; without it (or onRollover), it offers none. */
  rollover?: RolloverSettings | null;
  /** Resolves true once the change is saved. */
  onRollover?: (target: Target, change: RolloverChange) => Promise<boolean>;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(opened));
  const [editing, setEditing] = useState<string | null>(edit && !past ? keyOf(edit) : null);
  const [editAmount, setEditAmount] = useState(() =>
    edit ? String((edit.kind === 'category' ? budgets.categories[edit.id]?.amount : budgets.groups[edit.id]?.amount) ?? '') : ''
  );
  const [adding, setAdding] = useState('');
  const [addAmount, setAddAmount] = useState('');
  const [rollFrom, setRollFrom] = useState(month ?? localMonth());
  const [resetting, setResetting] = useState<{ target: Target; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const shownMonth = month ?? localMonth();
  const ix = useMemo(() => indexTaxonomy(taxonomy), [taxonomy]);
  const placed = useMemo(() => placeBudgets(budgets, ix), [budgets, ix]);
  const meters = useMemo(() => budgetMeters(ix, withCarry(placed, carries), new Map(Object.entries(spent))), [ix, placed, carries, spent]);
  const shown = meters.groups.filter((g) => g.limit !== null);
  const money = (n: number) => formatMoney(n, currency);
  const carryOf = (t: Target): Carry | undefined => (t.kind === 'category' ? carries?.categories[t.id] : carries?.groups[t.id]);

  const amountOf = (t: Target) => (t.kind === 'category' ? budgets.categories[t.id]?.amount : budgets.groups[t.id]?.amount);
  const withAmount = (t: Target, amount: number | null): Budgets => {
    const field = t.kind === 'category' ? 'categories' : 'groups';
    const next = { ...budgets[field] };
    if (amount === null) delete next[t.id];
    else next[t.id] = { amount };
    return { ...budgets, [field]: next };
  };

  function startEdit(t: Target) {
    if (past) return;
    setEditing(keyOf(t));
    setEditAmount(String(amountOf(t) ?? ''));
    setRollFrom(shownMonth);
  }
  async function saveEdit(t: Target) {
    const value = Number(editAmount);
    if (!Number.isFinite(value) || value <= 0) return;
    if (await onSave(withAmount(t, value))) setEditing(null);
  }
  async function remove(t: Target) {
    if (await onSave(withAmount(t, null))) setEditing(null);
  }
  async function add() {
    const value = Number(addAmount);
    const [kind, id] = adding.split(':') as ['category' | 'group', string];
    if (!id || !Number.isFinite(value) || value <= 0) return;
    if (await onSave(withAmount({ kind, id }, value))) {
      setAdding('');
      setAddAmount('');
      // Opened, so the budget just set is in view.
      const group = kind === 'group' ? id : ix.byId.get(id)?.group;
      if (group) setOpen((prev) => new Set(prev).add(group));
    }
  }
  async function roll(t: Target, change: RolloverChange) {
    if (!onRollover || busy) return;
    setBusy(true);
    try {
      // Saved: the editor closes, and the meter shows the change once the
      // month has been worked out again.
      if (await onRollover(t, change)) {
        setResetting(null);
        setEditing(null);
      }
    } finally {
      setBusy(false);
    }
  }
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Since when a budget rolls over now, or null when it doesn't. */
  const rollingSince = (t: Target): string | null => (t.kind === 'category' ? rollover?.rolling.categories[t.id] : rollover?.rolling.groups[t.id]) ?? null;

  /** Rolling a budget over, in its editor: on from a month chosen, or off, or
   *  its carry reset. Only for one with a budget, in this month. */
  const rolloverEditor = (t: Target, name: string) => {
    if (!rollover || !onRollover || amountOf(t) === undefined) return null;
    const since = rollingSince(t);
    if (since) {
      const c = carryOf(t);
      return (
        <div className="budget-rollover">
          <span className="budget-label">{c ? sinceText(c, shownMonth) : `Rolling over since ${monthName(since, shownMonth)}`}</span>
          <div className="card-actions">
            <button className="secondary" onClick={() => setResetting({ target: t, name })} disabled={!editable || busy}>
              Reset carryover
            </button>
            <button className="secondary" onClick={() => roll(t, { on: false })} disabled={!editable || busy}>
              Turn off rollover
            </button>
          </div>
        </div>
      );
    }
    const first = t.kind === 'category' ? rollover.starts.categories[t.id] : rollover.starts.groups[t.id];
    const choices = startChoices(shownMonth, rollover.earliest).filter((m) => !first || m >= first);
    return (
      <div className="budget-rollover">
        <label className="budget-label" htmlFor={`roll-${keyOf(t)}`}>
          Roll over what’s left (or overspent) into the next month, counting from
        </label>
        <select id={`roll-${keyOf(t)}`} className="text-input budget-select" value={rollFrom} onChange={(e) => setRollFrom(e.target.value)} disabled={!editable || busy}>
          {choices.map((m) => (
            <option key={m} value={m}>
              {m === shownMonth ? `${monthName(m, shownMonth)} (this month)` : monthName(m, shownMonth)}
            </option>
          ))}
        </select>
        <div className="card-actions">
          <button onClick={() => roll(t, { on: true, from: rollFrom || shownMonth })} disabled={!editable || busy}>
            Turn on rollover
          </button>
        </div>
      </div>
    );
  };

  /** The inline form for one budget. */
  const editor = (t: Target, name: string) => (
    <div className="budget-edit">
      <span className="budget-label">{name}</span>
      <input
        className="text-input budget-input"
        type="number"
        min="1"
        step="1"
        value={editAmount}
        onChange={(e) => setEditAmount(e.target.value)}
        aria-label={`Monthly budget for ${name}`}
      />
      <div className="card-actions">
        <button onClick={() => saveEdit(t)} disabled={!editable}>
          Save
        </button>
        {amountOf(t) !== undefined && (
          <button className="secondary" onClick={() => remove(t)} disabled={!editable}>
            Remove
          </button>
        )}
        <button className="secondary" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </div>
      {rolloverEditor(t, name)}
    </div>
  );

  const reconcileText = (m: GroupMeter) => {
    const r = m.reconcile!;
    if (!carries) {
      return r.binds === 'group'
        ? `Its categories’ budgets add up to ${money(r.categories)}, more than the ${money(r.group)} set for ${m.group.name}, so ${money(r.group)} is the limit.`
        : `Every category in ${m.group.name} has a budget, and they add up to ${money(r.categories)}, less than the ${money(r.group)} set for the group, so ${money(r.categories)} is the limit.`;
    }
    // With carries, each side is what is available: amount plus carry, which
    // an overspent carry can take to nothing or below: said in words.
    const other = (n: number) => (n > 0 ? ` (${money(n)})` : '');
    if (r.binds === 'group') {
      return r.group > 0
        ? `What its categories have available adds up to ${money(r.categories)}, more than the ${money(r.group)} available to ${m.group.name} as a whole, so ${money(r.group)} is the limit.`
        : `Nothing is left of the budget for ${m.group.name} as a whole after what it carried over, so nothing more can be spent in the group, whatever its categories have available${other(r.categories)}.`;
    }
    return r.categories > 0
      ? `Every category in ${m.group.name} has a budget, and what they have available adds up to ${money(r.categories)}, less than the ${money(r.group)} available to the group as a whole, so ${money(r.categories)} is the limit.`
      : `Every category in ${m.group.name} has a budget, and after what they carried over nothing is left of them, so nothing more can be spent in the group, whatever it has available as a whole${other(r.group)}.`;
  };

  /** The carry beneath a meter, or nothing for a budget that doesn't roll over. */
  const carryLine = (t: Target) => {
    const c = carryOf(t);
    if (!c) return null;
    return <div className={`budget-carry${c.carry < 0 ? ' negative' : ''}`}>{carryText(c, money, shownMonth)}</div>;
  };

  // What can still be budgeted: spending groups without one of their own,
  // and their categories without one (not archived), each with this month's
  // spending. Income and transfers are never spending, so a budget on them
  // would never move (lib/spending.ts): they aren't offered.
  const choices = useMemo(
    () =>
      sortedGroups(taxonomy)
        .filter((g) => g.kind === 'expense')
        .map((g) => ({
          group: g,
          free: !budgets.groups[g.id],
          categories: categoriesIn(taxonomy, g.id).filter((c) => !c.archived && !budgets.categories[c.id]),
        })),
    [taxonomy, budgets]
  );
  const hint = (n: number | undefined) => (n ? ` (${money(n)} this month)` : '');

  return (
    <>
      {shown.length === 0 && (
        <p className="empty-note">
          {past ? `No budgets in ${monthName(shownMonth)}.` : 'No budgets yet. Add one below to track spending against a monthly limit, for a category or a whole group.'}
        </p>
      )}

      {shown.map((m) => {
        const expanded = open.has(m.group.id);
        const groupTarget: Target = { kind: 'group', id: m.group.id };
        const own = budgets.groups[m.group.id]?.amount ?? null;
        return (
          <div className="budget-row budget-group" key={m.group.id}>
            <button className="budget-summary" onClick={() => toggle(m.group.id)} aria-expanded={expanded}>
              <div className="budget-line">
                <span className="budget-label">
                  <span className="rollup-caret" aria-hidden="true">
                    {expanded ? '▾' : '▸'}
                  </span>
                  {m.group.name}
                </span>
                <span className="budget-amounts">
                  {noSpending ? (m.limit! > 0 ? `${money(m.limit!)} limit` : 'Nothing left') : <Amounts spent={m.spent} limit={m.limit!} money={money} />}
                </span>
              </div>
              {!noSpending && <Meter spent={m.spent} limit={m.limit!} />}
              {m.reconcile && <div className="budget-reconcile">{m.reconcile.binds === 'group' ? 'Capped by the group’s budget' : 'Limited to its categories’ budgets'}</div>}
              {/* Opened, its budgets say their own. */}
              {!expanded && carryLine(groupTarget)}
              {!expanded && <BeganOver limit={m.limit!} money={money} />}
            </button>
            {expanded && (
              <div className="budget-children">
                {m.group.kind !== 'expense' && (
                  <p className="panel-note budget-note">
                    The categories in {m.group.name} count as {m.group.kind === 'income' ? 'income' : 'transfers'}, not spending, so nothing counts
                    against a budget here. Move a category into a spending group to budget it.
                  </p>
                )}
                {m.reconcile && <p className="panel-note budget-note">{reconcileText(m)}</p>}
                {editing === keyOf(groupTarget) ? (
                  editor(groupTarget, `${m.group.name} as a whole`)
                ) : (
                  <button className="budget-summary budget-own" onClick={() => startEdit(groupTarget)} disabled={!editable || past}>
                    <div className="budget-line">
                      <span className="budget-label">For {m.group.name} as a whole</span>
                      <span className="budget-amounts">{own !== null ? money(own) : 'Not set'}</span>
                    </div>
                    {carryLine(groupTarget)}
                  </button>
                )}
                {m.categories.map(({ category, budget, spent: s }) => {
                  const t: Target = { kind: 'category', id: category.id };
                  const name = displayName(category.name);
                  return (
                    <div className="budget-child" key={category.id}>
                      {editing === keyOf(t) ? (
                        editor(t, name)
                      ) : (
                        <button className="budget-summary" onClick={() => startEdit(t)} disabled={!editable || past}>
                          <div className="budget-line">
                            <span className="budget-label">
                              {category.icon ? `${category.icon} ` : ''}
                              {name}
                              {category.archived ? ' (archived)' : ''}
                            </span>
                            <span className="budget-amounts">
                              {budget === null ? (
                                `${money(s)}, no budget`
                              ) : noSpending ? (
                                budget > 0 ? `${money(budget)} limit` : 'Nothing left'
                              ) : (
                                <Amounts spent={s} limit={budget} money={money} />
                              )}
                            </span>
                          </div>
                          {budget !== null && !noSpending && <Meter spent={s} limit={budget} />}
                          {budget !== null && carryLine(t)}
                          {budget !== null && <BeganOver limit={budget} money={money} />}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {!past &&
        placed.orphans.map((o) => (
          <div className="budget-row" key={`${o.kind}:${o.id}`}>
            <div className="budget-line">
              <span className="budget-label">A {o.kind} since deleted</span>
              <span className="budget-amounts">{money(o.amount)}</span>
            </div>
            <div className="card-actions">
              <button className="secondary" onClick={() => remove({ kind: o.kind, id: o.id })} disabled={!editable}>
                Remove budget
              </button>
            </div>
          </div>
        ))}

      {!past && (
        <div className="budget-add">
          <select className="text-input budget-select" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Category or group to budget" disabled={!editable}>
            <option value="">Choose a category or group…</option>
            <optgroup label="A whole group">
              {choices
                .filter((c) => c.free)
                .map(({ group }) => (
                  <option key={group.id} value={`group:${group.id}`}>
                    {group.name}
                    {hint(meters.groups.find((m) => m.group.id === group.id)?.spent_all)}
                  </option>
                ))}
            </optgroup>
            {choices
              .filter((c) => c.categories.length > 0)
              .map(({ group, categories }) => (
                <optgroup key={group.id} label={group.name}>
                  {categories.map((c) => (
                    <option key={c.id} value={`category:${c.id}`}>
                      {displayName(c.name)}
                      {hint(spent[c.id])}
                    </option>
                  ))}
                </optgroup>
              ))}
          </select>
          <input
            className="text-input budget-input"
            type="number"
            min="1"
            step="1"
            placeholder="Monthly limit"
            value={addAmount}
            onChange={(e) => setAddAmount(e.target.value)}
            aria-label="Monthly limit"
            disabled={!editable}
          />
          <button onClick={add} disabled={!editable || !adding || !addAmount}>
            Add Budget
          </button>
        </div>
      )}

      {onRollover && (
        <Sheet open={resetting !== null} title="Reset carryover" onClose={() => !busy && setResetting(null)}>
          {resetting && (
            <div className="sheet-form">
              <p className="panel-note">
                {resetting.name}’s carryover goes to zero from {monthName(shownMonth)}: this month starts from its budget alone
                {carryOf(resetting.target) ? `, and what is carried now (${carryText(carryOf(resetting.target)!, money, shownMonth)}) is set aside` : ''}. Earlier
                months keep theirs.
              </p>
              <div className="action-row">
                <button onClick={() => roll(resetting.target, { reset: true })} disabled={busy}>
                  Reset carryover
                </button>
                <button className="secondary" onClick={() => setResetting(null)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Sheet>
      )}
    </>
  );
}

/** The month's total: every group's limit and what counts against it, over
 *  what is available when the month's carries are known; `any` when there is
 *  a budget at all (what is available in all can be nothing, or less). */
export function budgetTotals(
  taxonomy: Taxonomy,
  budgets: Budgets,
  spent: Readonly<Record<string, number>>,
  carries: Carries | null = null
): { budget: number; spent: number; any: boolean } {
  const ix = indexTaxonomy(taxonomy);
  const meters = budgetMeters(ix, withCarry(placeBudgets(budgets, ix), carries), new Map(Object.entries(spent)));
  return { ...meters.total, any: meters.groups.some((g) => g.limit !== null) };
}
