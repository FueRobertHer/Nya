'use client';

// The month's budgets on Budgets > Month, rolled up to your category groups
// (lib/budget-set.ts), as rows of one card (rollout phase 6a2): each group
// with a budget, or with budgeted categories, is a row with its meter, and
// opens in place to its categories, each a row with a meter of its own. A
// budget is set on a category or on a group as a whole: a group's is a cap
// on everything in it, and when both are set, the group's meter shows
// min(the group's amount, its categories' added up), with a badge saying
// which binds and the sentence why once it is open (THE RECONCILE RULE
// there). Spending is counted by lib/totals.ts, by category id: the Activity
// tab's rule, one currency, what the person excluded and transfers left out.
//
// ROLLOVER (#37, lib/rollover.ts). With the month's carries, each meter is
// spending against what is available (the amount plus what rolled over, which
// is negative after overspending), with the carry on the line under it
// ("+$120 rolled over", "$45 overspent, carried over") and, when a month it
// counts may be incomplete, that it may be off. Nothing available is said in
// words, never as a limit of zero or below: "$37.50 spent, nothing left", and
// how far over the month began. The reconcile rule works on what is
// available. Without carries (not loaded, or none), meters are as before.
//
// OVER is amber, as nearly over is (from 85%): both need the person
// (design-system.md "Status and honesty"), and the Over badge tells them
// apart, never the color alone.
//
// SHEETS (components/BudgetSheet.tsx). A budget's row opens its sheet: its
// amount, the suggestion from history (lib/budget-suggestions.ts), and, a
// level in, its rollover (on from a month chosen, off, or its carry reset)
// and Remove. A budget on a category or group since deleted opens a sheet
// that removes it; + Add budget opens Add budget's. This card holds which is
// open, at which level, and what is typed in it; each opening starts afresh.
// A sheet says only the refusals that arose while it was open (the store
// clears its error when a save starts, so the same words again are new), and
// stays open on what was typed when a save fails. Focus goes back to the row
// that opened it, or to + Add budget when that row has gone.
//
// Budgets are saved whole (lib/whole-list-store.ts, app/api/budgets), so
// nothing here saves until they have loaded; a save that fails puts back
// what is stored. A past month is shown as it was: its rows open nothing.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatMoney } from '@/lib/format';
import { budgetMeters, placeBudgets, type Budgets, type GroupMeter, type Reconcile } from '@/lib/budget-set';
import { displayName, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import { carryText, monthName, withCarry, type Carries, type Carry } from '@/lib/rollover';
import { localMonth } from '@/lib/local-date';
import { Masked } from './HideAmounts';
import { chevron, RIGHT } from './ActivityBar';
import { AddBudgetSheet, BudgetSheet, OrphanBudgetSheet, type BudgetLevel, type BudgetRollover } from './BudgetSheet';
import type { BudgetSuggestions } from '@/lib/budget-suggestions';

/** Amber from 85% of what is available, and past it: Budgets' meters never
 *  turn red (rollout 6a2), as AccountSheet's and Shared's still do. */
function meterState(ratio: number): '' | ' warn' {
  return ratio >= 0.85 ? ' warn' : '';
}

/** Over once the limit is used up; with nothing available, once something
 *  is spent or the month began over. */
const isOver = (spent: number, limit: number) => (limit > 0 ? spent >= limit : spent > 0 || limit < 0);

/** Spending against a limit: full once the limit is used up, or when there
 *  is none left at all (a carry deeper than the budget). Spans, since a row
 *  is a button. */
function Meter({ spent, limit }: { spent: number; limit: number }) {
  const ratio = limit > 0 ? spent / limit : spent > 0 || limit < 0 ? 1 : 0;
  return (
    <span className={`meter-track${meterState(ratio)}`}>
      <span className={`meter-fill${meterState(ratio)}`} style={{ width: `${Math.min(ratio * 100, 100)}%` }} />
    </span>
  );
}

/** Spending against what is available, in words: "$80.00 of $300.00"; with
 *  nothing available (an overspent carry as deep as the budget, or deeper),
 *  "$37.50 spent, nothing left". */
function Amounts({ spent, limit, money }: { spent: number; limit: number; money: (n: number) => string }) {
  return <Masked>{limit > 0 ? `${money(spent)} of ${money(limit)}` : `${money(spent)} spent, nothing left`}</Masked>;
}

/** Over its limit, in a word beside its name. */
const OVER = (
  <>
    {' '}
    <span className="badge warn">Over</span>
  </>
);

/** Under the amounts of a budget whose month began over (an overspent carry
 *  deeper than the budget): by how much, rather than a limit below zero. */
function BeganOver({ limit, money }: { limit: number; money: (n: number) => string }) {
  return limit < 0 ? (
    <span className="budget-carry negative">
      <Masked>{`Began the month ${money(-limit)} over.`}</Masked>
    </span>
  ) : null;
}

const DOWN = 'm6 9 6 6 6-6';

/** What is being edited: a category's budget or a group's own. */
export type Target = { kind: 'category' | 'group'; id: string };

/** What the sheets know of rollover now (app/api/budgets/month): each
 *  budget rolling over and since when, the earliest month each can start
 *  from, each turned off this month and the month it ran from, and the first
 *  month with any transactions. */
export type RolloverSettings = {
  rolling: { categories: Record<string, string>; groups: Record<string, string> };
  starts: { categories: Record<string, string>; groups: Record<string, string> };
  ended: { categories: Record<string, string>; groups: Record<string, string> };
  earliest: string | null;
};

/** A change to a budget's rollover, as its sheet asks for it. */
export type RolloverChange = { on: true; from: string } | { on: false } | { reset: true };

/** Which sheet is open: a budget's, at one of its levels, with its name and
 *  the amount saved as they were when it opened, what is typed, and the
 *  month a rollover is to count from; one on a category or group since
 *  deleted; or Add budget's, with what is chosen and typed. */
type Opened =
  | { kind: 'budget'; target: Target; name: string; saved: number | null; level: BudgetLevel; draft: string; from: string }
  | { kind: 'orphan'; target: Target; amount: number }
  | { kind: 'add'; choice: string; draft: string };

/** The sheet open, kept while it slides out: the save refusal already said
 *  when it opened (`seen`), so it says only those that arise while it is
 *  open; a rollover change's own refusal (`error`); and which opening it is
 *  (`n`), so each starts afresh. */
type SheetState = { at: Opened; open: boolean; seen: string | null; error: string | null; n: number };

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
  editLevel = 'edit',
  adding = false,
  carries = null,
  month,
  past = false,
  rollover = null,
  onRollover,
  suggestions = null,
  saveError = null,
  monthError = null,
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
  /** Resolves true once saved; a sheet only closes then, so nothing typed
   *  is lost to a failed save. */
  onSave: (next: Budgets) => Promise<boolean>;
  /** Groups shown opened at first, by id; every other starts collapsed. */
  open?: readonly string[];
  /** A budget whose sheet is open at first (a deleted category's or
   *  group's opens its own), at `editLevel`. */
  edit?: Target;
  editLevel?: BudgetLevel;
  /** Add budget's sheet open at first. */
  adding?: boolean;
  /** What rolls into the month shown, by category and group id
   *  (lib/rollover.ts), or null when not known: meters without it. */
  carries?: Carries | null;
  /** The month shown (this month by default), for what is said of it. */
  month?: string;
  /** A month gone by: shown as it was, with nothing to edit or add. */
  past?: boolean;
  /** Rollover now, for the sheets; without it (or onRollover), they offer none. */
  rollover?: RolloverSettings | null;
  /** Resolves null once the change is saved, else why not. */
  onRollover?: (target: Target, change: RolloverChange) => Promise<string | null>;
  /** What was spent on average in the last three complete months, by
   *  category and group (lib/budget-suggestions.ts), for a budget's sheet
   *  and for one about to be added; null when not known. */
  suggestions?: BudgetSuggestions | null;
  /** Why the last save of the budgets didn't go through: said in the sheet
   *  open when it arose. */
  saveError?: string | null;
  /** Why the month couldn't be worked out, for a rollover level whose
   *  month has gone. */
  monthError?: string | null;
}) {
  const shownMonth = month ?? localMonth();
  const ix = useMemo(() => indexTaxonomy(taxonomy), [taxonomy]);
  const placed = useMemo(() => placeBudgets(budgets, ix), [budgets, ix]);
  const meters = useMemo(() => budgetMeters(ix, withCarry(placed, carries), new Map(Object.entries(spent))), [ix, placed, carries, spent]);
  const shown = meters.groups.filter((g): g is GroupMeter & { limit: number } => g.limit !== null);
  const orphans = past ? [] : placed.orphans;
  const money = (n: number) => formatMoney(n, currency);
  const carryOf = (t: Target): Carry | undefined => (t.kind === 'category' ? carries?.categories[t.id] : carries?.groups[t.id]);
  const uid = useId();

  const amountOf = (t: Target) => (t.kind === 'category' ? budgets.categories[t.id]?.amount : budgets.groups[t.id]?.amount);
  const withAmount = (t: Target, amount: number | null): Budgets => {
    const field = t.kind === 'category' ? 'categories' : 'groups';
    const next = { ...budgets[field] };
    if (amount === null) delete next[t.id];
    else next[t.id] = { amount };
    return { ...budgets, [field]: next };
  };

  /** A budget's sheet as it opens: its name and amount as they are now
   *  (the sheet keeps them, whatever a save then does to the list); a
   *  budget on a category or group since deleted opens its own. */
  const opening = (t: Target, level: BudgetLevel = 'edit'): Opened => {
    const orphan = placed.orphans.find((o) => o.kind === t.kind && o.id === t.id);
    if (orphan) return { kind: 'orphan', target: t, amount: orphan.amount };
    const name = t.kind === 'category' ? displayName(ix.byId.get(t.id)?.name ?? '') : `${ix.groupById.get(t.id)?.name ?? ''} as a whole`;
    const saved = amountOf(t) ?? null;
    return { kind: 'budget', target: t, name, saved, level, draft: saved === null ? '' : String(saved), from: shownMonth };
  };

  const [open, setOpen] = useState<Set<string>>(() => new Set(opened));
  const [sheet, setSheet] = useState<SheetState | null>(() => {
    const at: Opened | null = past ? null : edit ? opening(edit, editLevel) : adding ? { kind: 'add', choice: '', draft: '' } : null;
    return at ? { at, open: true, seen: saveError, error: null, n: 1 } : null;
  });
  const [busy, setBusy] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  // A refusal said before the sheet opened, once cleared, is forgotten: the
  // same words coming back are a new refusal, and the sheet says it.
  useEffect(() => {
    if (saveError === null) setSheet((s) => (s && s.seen !== null ? { ...s, seen: null } : s));
  }, [saveError]);

  const show = (at: Opened) => {
    if (past) return;
    setSheet((s) => ({ at, open: true, seen: saveError, error: null, n: (s?.n ?? 0) + 1 }));
  };
  const setAt = (change: (at: Opened) => Opened) => setSheet((s) => (s ? { ...s, at: change(s.at) } : s));
  /** A level of a budget's sheet, with no refusal left from the last. */
  const goTo = (level: BudgetLevel) => setSheet((s) => (s && s.at.kind === 'budget' ? { ...s, error: null, at: { ...s.at, level } } : s));
  /** Closed: focus goes back to the row that opened it (the sheet gives it
   *  back), or, when that row has gone (a group's last budget removed takes
   *  the group with it), to + Add budget rather than to nothing. */
  const close = () => {
    setSheet((s) => (s ? { ...s, open: false } : s));
    requestAnimationFrame(() => {
      // Still in the sheet sliding out, or nowhere.
      let left = !document.activeElement || document.activeElement === document.body;
      for (let n: Element | null = document.activeElement; n && !left; n = n.parentElement) {
        if (n.getAttribute('role') === 'dialog') left = n.getAttribute('data-open') === 'false';
      }
      if (left) addRef.current?.focus({ preventScroll: true });
    });
  };

  /** The budgets changed from a sheet: it closes once they are saved, and
   *  stays open on what was typed when they aren't, saying why (the store
   *  puts back what is stored and reads it again meanwhile). */
  async function commit(next: Budgets, then?: () => void) {
    if (busy) return;
    setBusy(true);
    // The store clears its refusal as the save starts: whatever it says
    // after is this save's.
    setSheet((s) => (s ? { ...s, seen: null, error: null } : s));
    try {
      if (await onSave(next)) {
        then?.();
        close();
      }
    } finally {
      setBusy(false);
    }
  }
  async function roll(t: Target, change: RolloverChange) {
    if (!onRollover || busy) return;
    setBusy(true);
    try {
      // Saved: the sheet closes, and the meter shows the change once the
      // month has been worked out again.
      const error = await onRollover(t, change);
      if (error === null) close();
      else setSheet((s) => (s ? { ...s, error } : s));
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

  /** A budget's rollover now, for its sheet, or null when not known. */
  const rolloverOf = (t: Target): BudgetRollover | null => {
    if (!rollover || !onRollover) return null;
    const of = (r: { categories: Record<string, string>; groups: Record<string, string> }) => (t.kind === 'category' ? r.categories[t.id] : r.groups[t.id]) ?? null;
    return { since: of(rollover.rolling), first: of(rollover.starts), ran: of(rollover.ended), earliest: rollover.earliest };
  };

  const reconcileText = (m: GroupMeter, r: Reconcile) => {
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

  /** The carry under a meter, or nothing for a budget that doesn't roll over. */
  const carryLine = (t: Target) => {
    const c = carryOf(t);
    if (!c) return null;
    return (
      <span className={`budget-carry${c.carry < 0 ? ' negative' : ''}`}>
        <Masked>{carryText(c, money, shownMonth)}</Masked>
      </span>
    );
  };

  /** A limit's amounts as its row says them: spent of what is available, or,
   *  with no spending to count, the limit alone. */
  const limitText = (s: number, limit: number) =>
    noSpending ? <Masked>{limit > 0 ? `${money(limit)} limit` : 'Nothing left'}</Masked> : <Amounts spent={s} limit={limit} money={money} />;

  /** A budget's figures in its sheet, as its row shows them (a group's own
   *  budget, as the group's row): what is spent of what is available, Over
   *  when it is, the meter, the carry and how far over its month began.
   *  Null when it isn't among the meters now (being removed, say). */
  const sheetFigures = (t: Target): ReactNode => {
    let figure: { spent: number; limit: number | null } | null = null;
    if (t.kind === 'group') {
      for (const m of shown) if (m.group.id === t.id) figure = { spent: m.spent, limit: m.limit };
    } else {
      for (const m of meters.groups) for (const c of m.categories) if (c.category.id === t.id) figure = { spent: c.spent, limit: c.budget };
    }
    if (!figure) return null;
    const { spent: s, limit } = figure;
    if (limit === null) {
      return (
        <p className="money">
          <Masked>{`${money(s)}, no budget`}</Masked>
        </p>
      );
    }
    return (
      <div className="stack tight">
        <p>
          <span className="money">{limitText(s, limit)}</span>
          {!noSpending && isOver(s, limit) && OVER}
        </p>
        {!noSpending && <Meter spent={s} limit={limit} />}
        {carryLine(t)}
        <BeganOver limit={limit} money={money} />
      </div>
    );
  };
  /** A group's reconcile sentence, for its own budget's sheet. */
  const sheetReconcile = (t: Target): ReactNode => {
    if (t.kind !== 'group') return null;
    for (const m of shown) if (m.group.id === t.id && m.reconcile) return <Masked>{reconcileText(m, m.reconcile)}</Masked>;
    return null;
  };

  const at = sheet?.at ?? null;
  const sheetOpen = !!sheet?.open;
  const sheetErrors: string[] = [];
  if (sheet?.error) sheetErrors.push(sheet.error);
  if (sheet && saveError && saveError !== sheet.seen && saveError !== sheet.error) sheetErrors.push(saveError);

  return (
    <>
      {shown.length === 0 && (
        <p className="empty-note">
          {past ? `No budgets in ${monthName(shownMonth)}.` : 'No budgets yet. Add one below to track spending against a monthly limit, for a category or a whole group.'}
        </p>
      )}

      {(shown.length > 0 || orphans.length > 0) && (
        <ul className="card list-rows budget-rows">
          {shown.map((m) => {
            const expanded = open.has(m.group.id);
            const groupTarget: Target = { kind: 'group', id: m.group.id };
            const own = budgets.groups[m.group.id]?.amount ?? null;
            const listId = `${uid}-${m.group.id}`;
            // Opened, its budgets say their own carry.
            const groupCarry = !expanded ? carryLine(groupTarget) : null;
            const whole = (
              <>
                <span className="list-row-text">
                  <span className="list-row-title">For {m.group.name} as a whole</span>
                  {carryOf(groupTarget) && <span className="list-row-sub">{carryLine(groupTarget)}</span>}
                </span>
                <span className="list-row-value budget-value money">
                  <Masked>{own !== null ? money(own) : 'Not set'}</Masked>
                </span>
                {!past && chevron(RIGHT)}
              </>
            );
            return (
              <li key={m.group.id}>
                <button type="button" className="list-row" onClick={() => toggle(m.group.id)} aria-expanded={expanded} aria-controls={expanded ? listId : undefined}>
                  <span className="list-row-text">
                    <span className="list-row-title">
                      {m.group.name}
                      {!noSpending && isOver(m.spent, m.limit) && OVER}
                    </span>
                    {!noSpending && <Meter spent={m.spent} limit={m.limit} />}
                    {(groupCarry || m.reconcile) && (
                      <span className="list-row-sub">
                        {groupCarry}
                        {groupCarry && m.reconcile && ' '}
                        {m.reconcile && <span className="badge">{m.reconcile.binds === 'group' ? 'Capped by the group’s budget' : 'Limited to its categories’ budgets'}</span>}
                      </span>
                    )}
                  </span>
                  <span className="list-row-value budget-value">
                    <span className="money">{limitText(m.spent, m.limit)}</span>
                    {!expanded && <BeganOver limit={m.limit} money={money} />}
                  </span>
                  <svg className={`section-chevron${expanded ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={DOWN} />
                  </svg>
                </button>
                {expanded && (
                  <ul className="list-rows budget-sub-rows" id={listId}>
                    {m.group.kind !== 'expense' && (
                      <li>
                        <p className="helper">
                          The categories in {m.group.name} count as {m.group.kind === 'income' ? 'income' : 'transfers'}, not spending, so nothing counts
                          against a budget here. Move a category into a spending group to budget it.
                        </p>
                      </li>
                    )}
                    {m.reconcile && (
                      <li>
                        <p className="helper">
                          <Masked>{reconcileText(m, m.reconcile)}</Masked>
                        </p>
                      </li>
                    )}
                    <li>
                      {past ? (
                        <div className="list-row">{whole}</div>
                      ) : (
                        <button type="button" className="list-row" aria-haspopup="dialog" onClick={() => show(opening(groupTarget))}>
                          {whole}
                        </button>
                      )}
                    </li>
                    {m.categories.map(({ category, budget, spent: s }) => {
                      const t: Target = { kind: 'category', id: category.id };
                      const name = displayName(category.name);
                      const body = (
                        <>
                          <span className="list-row-text">
                            <span className="list-row-title">
                              {category.icon ? `${category.icon} ` : ''}
                              {name}
                              {category.archived ? ' (archived)' : ''}
                              {budget !== null && !noSpending && isOver(s, budget) && OVER}
                            </span>
                            {budget !== null && !noSpending && <Meter spent={s} limit={budget} />}
                            {budget !== null && carryOf(t) && <span className="list-row-sub">{carryLine(t)}</span>}
                          </span>
                          <span className="list-row-value budget-value">
                            <span className="money">
                              {budget === null ? <Masked>{`${money(s)}, no budget`}</Masked> : limitText(s, budget)}
                            </span>
                            {budget !== null && <BeganOver limit={budget} money={money} />}
                          </span>
                          {!past && chevron(RIGHT)}
                        </>
                      );
                      return (
                        <li key={category.id}>
                          {past ? (
                            <div className="list-row">{body}</div>
                          ) : (
                            <button type="button" className="list-row" aria-haspopup="dialog" onClick={() => show(opening(t))}>
                              {body}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}

          {orphans.map((o) => (
            <li key={`${o.kind}:${o.id}`}>
              <button type="button" className="list-row" aria-haspopup="dialog" onClick={() => show(opening({ kind: o.kind, id: o.id }))}>
                <span className="list-row-text">
                  <span className="list-row-title">A {o.kind} since deleted</span>
                </span>
                <span className="list-row-value budget-value money">
                  <Masked>{money(o.amount)}</Masked>
                </span>
                {chevron(RIGHT)}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!past && (
        <div className="btn-row">
          <button type="button" ref={addRef} className="btn secondary budget-add-button" aria-haspopup="dialog" onClick={() => show({ kind: 'add', choice: '', draft: '' })}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add budget
          </button>
        </div>
      )}

      {sheet && at?.kind === 'budget' && (
        <BudgetSheet
          key={sheet.n}
          open={sheetOpen}
          name={at.name}
          target={at.target}
          level={at.level}
          onLevel={goTo}
          draft={at.draft}
          onDraft={(draft) => setAt((a) => (a.kind === 'budget' ? { ...a, draft } : a))}
          saved={at.saved}
          from={at.from}
          onFrom={(from) => setAt((a) => (a.kind === 'budget' ? { ...a, from } : a))}
          figures={sheetFigures(at.target)}
          reconcile={sheetReconcile(at.target)}
          carry={carryOf(at.target)}
          rollover={rolloverOf(at.target)}
          monthError={monthError}
          suggestions={suggestions}
          currency={currency}
          month={shownMonth}
          editable={editable}
          busy={busy}
          errors={sheetErrors}
          onClose={close}
          onSave={(amount) => void commit(withAmount(at.target, amount))}
          onRemove={() => void commit(withAmount(at.target, null))}
          onRoll={(change) => void roll(at.target, change)}
        />
      )}
      {sheet && at?.kind === 'orphan' && (
        <OrphanBudgetSheet
          key={sheet.n}
          open={sheetOpen}
          kind={at.target.kind}
          amount={at.amount}
          currency={currency}
          editable={editable}
          busy={busy}
          errors={sheetErrors}
          onClose={close}
          onRemove={() => void commit(withAmount(at.target, null))}
        />
      )}
      {sheet && at?.kind === 'add' && (
        <AddBudgetSheet
          key={sheet.n}
          open={sheetOpen}
          taxonomy={taxonomy}
          budgets={budgets}
          spent={spent}
          groups={meters.groups}
          currency={currency}
          choice={at.choice}
          onChoice={(choice) => setAt((a) => (a.kind === 'add' ? { ...a, choice } : a))}
          draft={at.draft}
          onDraft={(draft) => setAt((a) => (a.kind === 'add' ? { ...a, draft } : a))}
          suggestions={suggestions}
          editable={editable}
          busy={busy}
          errors={sheetErrors}
          onClose={close}
          onAdd={(target, amount) =>
            void commit(withAmount(target, amount), () => {
              // Opened, so the budget just set is in view.
              const group = target.kind === 'group' ? target.id : ix.byId.get(target.id)?.group;
              if (group) setOpen((prev) => new Set(prev).add(group));
            })
          }
        />
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
