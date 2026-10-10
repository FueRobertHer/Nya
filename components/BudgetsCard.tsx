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
// Budgets are saved whole (lib/whole-list-store.ts, app/api/budgets), so
// nothing here edits until they have loaded; a save that fails puts back what
// is stored. A budget on a category or group since deleted is shown, and can
// be removed.

import { useMemo, useState } from 'react';
import { formatMoney } from '@/lib/format';
import { budgetMeters, placeBudgets, type Budgets, type GroupMeter } from '@/lib/budget-set';
import { categoriesIn, displayName, indexTaxonomy, sortedGroups, type Taxonomy } from '@/lib/categories';

function meterState(ratio: number): '' | ' warn' | ' over' {
  if (ratio >= 1) return ' over';
  if (ratio >= 0.85) return ' warn';
  return '';
}

function Meter({ spent, limit }: { spent: number; limit: number }) {
  const ratio = limit > 0 ? spent / limit : 0;
  return (
    <div className={`meter-track${meterState(ratio)}`}>
      <div className={`meter-fill${meterState(ratio)}`} style={{ width: `${Math.min(ratio * 100, 100)}%` }} />
    </div>
  );
}

/** What is being edited: a category's budget or a group's own. */
type Target = { kind: 'category' | 'group'; id: string };

const keyOf = (t: Target) => `${t.kind}:${t.id}`;

export default function BudgetsCard({
  taxonomy,
  budgets,
  spent,
  currency,
  editable,
  noSpending,
  onSave,
  open: opened = [],
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
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(opened));
  const [editing, setEditing] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [adding, setAdding] = useState('');
  const [addAmount, setAddAmount] = useState('');

  const ix = useMemo(() => indexTaxonomy(taxonomy), [taxonomy]);
  const placed = useMemo(() => placeBudgets(budgets, ix), [budgets, ix]);
  const meters = useMemo(() => budgetMeters(ix, placed, new Map(Object.entries(spent))), [ix, placed, spent]);
  const shown = meters.groups.filter((g) => g.limit !== null);
  const money = (n: number) => formatMoney(n, currency);

  const amountOf = (t: Target) => (t.kind === 'category' ? budgets.categories[t.id]?.amount : budgets.groups[t.id]?.amount);
  const withAmount = (t: Target, amount: number | null): Budgets => {
    const field = t.kind === 'category' ? 'categories' : 'groups';
    const next = { ...budgets[field] };
    if (amount === null) delete next[t.id];
    else next[t.id] = { amount };
    return { ...budgets, [field]: next };
  };

  function startEdit(t: Target) {
    setEditing(keyOf(t));
    setEditAmount(String(amountOf(t) ?? ''));
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
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
    </div>
  );

  const reconcileText = (m: GroupMeter) => {
    const r = m.reconcile!;
    return r.binds === 'group'
      ? `Its categories’ budgets add up to ${money(r.categories)}, more than the ${money(r.group)} set for ${m.group.name}, so ${money(r.group)} is the limit.`
      : `Every category in ${m.group.name} has a budget, and they add up to ${money(r.categories)}, less than the ${money(r.group)} set for the group, so ${money(r.categories)} is the limit.`;
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
      {shown.length === 0 && <p className="empty-note">No budgets yet. Add one below to track spending against a monthly limit, for a category or a whole group.</p>}

      {shown.map((m) => {
        const expanded = open.has(m.group.id);
        const groupTarget: Target = { kind: 'group', id: m.group.id };
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
                  {noSpending ? (
                    `${money(m.limit!)} limit`
                  ) : (
                    <>
                      {money(m.spent)} of {money(m.limit!)}
                      {m.spent >= m.limit! && <span className="over-tag"> · over</span>}
                    </>
                  )}
                </span>
              </div>
              {!noSpending && <Meter spent={m.spent} limit={m.limit!} />}
              {m.reconcile && <div className="budget-reconcile">{m.reconcile.binds === 'group' ? 'Capped by the group’s budget' : 'Limited to its categories’ budgets'}</div>}
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
                  <button className="budget-summary budget-own" onClick={() => startEdit(groupTarget)} disabled={!editable}>
                    <div className="budget-line">
                      <span className="budget-label">For {m.group.name} as a whole</span>
                      <span className="budget-amounts">{m.own !== null ? money(m.own) : 'Not set'}</span>
                    </div>
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
                        <button className="budget-summary" onClick={() => startEdit(t)} disabled={!editable}>
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
                                `${money(budget)} limit`
                              ) : (
                                <>
                                  {money(s)} of {money(budget)}
                                  {s >= budget && <span className="over-tag"> · over</span>}
                                </>
                              )}
                            </span>
                          </div>
                          {budget !== null && !noSpending && <Meter spent={s} limit={budget} />}
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

      {placed.orphans.map((o) => (
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
    </>
  );
}

/** The month's total: every group's limit and what counts against it. */
export function budgetTotals(taxonomy: Taxonomy, budgets: Budgets, spent: Readonly<Record<string, number>>): { budget: number; spent: number } {
  const ix = indexTaxonomy(taxonomy);
  return budgetMeters(ix, placeBudgets(budgets, ix), new Map(Object.entries(spent))).total;
}
