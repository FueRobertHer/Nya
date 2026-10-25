'use client';

// The sheets of Budgets > Month (rollout phase 6a2), in place of the editor
// that opened inside a budget's row and the form that sat open under the
// list: a budget's sheet, a deleted category's or group's, and Add budget.
// components/BudgetsCard.tsx holds which is open and what is typed in it,
// and draws the budget's figures; these draw the rest.
//
// A BUDGET'S SHEET has levels, each replacing the last with a back arrow
// (docs/design/guidelines.md "Sheets, menus and forms"), so the first has
// one way to commit, Save:
//   - edit: its figures as on its row, the group's reconcile sentence, its
//     amount, the suggestion from history (one tap saves it), and a
//     Rollover row while rollover is known and it has an amount; that row
//     waits while the amount typed isn't the one saved, as a change of
//     amount is saved first. Footer: Remove... and Save.
//   - rollover: on since when, with Reset carryover... and Turn off; or off,
//     with the month to count from and Turn on. A change that is saved
//     closes the sheet: the meter shows it once the month is worked out
//     again. Should the month's view go (a reload that failed), the level
//     says why rather than offering what can't be known.
//   - reset: what a reset does and why one is needed, confirmed (Cancel is
//     focused); it sets a carry aside, which turning rollover on again
//     doesn't bring back, so it is a danger button.
//   - remove: confirmed (Keep it is focused), saying that a budget's
//     rollover ends with it (lib/rollover.ts: no budget, nothing to roll).
// Back, like closing, waits for a change under way.
//
// Errors are said at the top of the sheet they arose in, as a caution (the
// stale notes they were); the card says what was said before it opened.
// Every amount is written through lib/format.ts and drawn in <Masked>, and
// an amount field keeps the hide-amounts hook's class (budget-input) and a
// placeholder, so hiding amounts covers it (app/globals.css "Hide amounts").

import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { formatMoney } from '@/lib/format';
import { categoriesIn, displayName, sortedGroups, type Taxonomy } from '@/lib/categories';
import type { Budgets, GroupMeter } from '@/lib/budget-set';
import type { BudgetSuggestions } from '@/lib/budget-suggestions';
import { carryText, monthName, sinceText, startChoices, type Carry } from '@/lib/rollover';
import { Sheet } from './Sheet';
import { Notice } from './TotalCaveats';
import { Masked, NO_EXAMPLE, spokenLabel } from './HideAmounts';
import BudgetSuggestion from './BudgetSuggestion';
import { chevron, RIGHT } from './ActivityBar';
import { NOT_LOADED } from './budget-month-state';
import type { RolloverChange, Target } from './BudgetsCard';

/** In the reset's confirmation: when a reset is what a carry needs. */
export const REFUND_NOTE = 'A refund counts as money in, never off a budget’s spending, so a purchase you returned stays in the carry until you reset it.';

/** Where a budget's sheet is. */
export type BudgetLevel = 'edit' | 'rollover' | 'reset' | 'remove';

/** What a budget's sheet knows of its rollover now (app/api/budgets/month):
 *  since when it rolls over (null when it doesn't), the earliest month it
 *  can start from, the month it ran from when turned off this month, and
 *  the first month with any transactions. */
export type BudgetRollover = { since: string | null; first: string | null; ran: string | null; earliest: string | null };

/** An amount, typed as a string so a half-typed one survives (guidelines.md
 *  "Sheets, menus and forms"), in the field the hide-amounts hook covers. */
function AmountField({ label, name, value, onChange, disabled }: { label: string; name: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <label className="field">
      {label}
      <input
        className="budget-input"
        type="number"
        min="1"
        step="1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={NO_EXAMPLE}
        aria-label={name}
        disabled={disabled}
      />
    </label>
  );
}

/** What went wrong while the sheet was open, at its top. */
function Said({ errors }: { errors: readonly string[] }) {
  return (
    <>
      {errors.map((e) => (
        <Notice key={e} level="caution">
          {e}
        </Notice>
      ))}
    </>
  );
}

/** A positive amount typed, or null. */
const positive = (draft: string): number | null => {
  const n = Number(draft);
  return draft.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

/** One budget's sheet, at the level `level`. */
export function BudgetSheet({
  open,
  name,
  target,
  level,
  onLevel,
  draft,
  onDraft,
  saved,
  from,
  onFrom,
  figures,
  reconcile,
  carry,
  rollover,
  monthError,
  suggestions,
  currency,
  month,
  editable,
  busy,
  errors,
  onClose,
  onSave,
  onRemove,
  onRoll,
}: {
  open: boolean;
  /** Its name, the sheet's title: "Groceries", "Food as a whole". */
  name: string;
  target: Target;
  level: BudgetLevel;
  onLevel: (level: BudgetLevel) => void;
  /** The amount typed, and the one saved when the sheet opened (null for
   *  none yet). */
  draft: string;
  onDraft: (v: string) => void;
  saved: number | null;
  /** The month a rollover is to count from, as chosen. */
  from: string;
  onFrom: (m: string) => void;
  /** Its figures as its row shows them, drawn by the card; null when the
   *  budget isn't among them now (being removed, say). */
  figures: ReactNode;
  /** The group's reconcile sentence, or null. */
  reconcile: ReactNode;
  carry: Carry | undefined;
  /** Its rollover, or null while the month isn't known. */
  rollover: BudgetRollover | null;
  /** Why the month isn't known, when it couldn't be worked out. */
  monthError: string | null;
  suggestions: BudgetSuggestions | null;
  currency: string | null;
  month: string;
  /** Loaded, so it can be saved over. */
  editable: boolean;
  /** A change under way. */
  busy: boolean;
  errors: readonly string[];
  onClose: () => void;
  onSave: (amount: number) => void;
  onRemove: () => void;
  onRoll: (change: RolloverChange) => void;
}) {
  const money = (n: number) => formatMoney(n, currency);
  const helpId = useId();
  // The question's safe answer takes focus when it opens, so a stray Enter
  // keeps what is there (after the sheet's own focus on its panel).
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open && (level === 'reset' || level === 'remove')) safe.current?.focus({ preventScroll: true });
  }, [open, level]);
  const back = () => {
    if (busy) return;
    onLevel(level === 'reset' ? 'rollover' : 'edit');
  };
  const close = () => !busy && onClose();
  const sheet = (title: string, body: ReactNode, footer?: ReactNode) => (
    <Sheet open={open} title={title} onClose={close} onBack={level === 'edit' ? undefined : back} level={level} footer={footer}>
      <div className="stack">
        <Said errors={errors} />
        {body}
      </div>
    </Sheet>
  );

  if (level === 'rollover') {
    if (!rollover) return sheet('Rollover', <Notice level="caution">{monthError ?? NOT_LOADED}</Notice>);
    if (rollover.since) {
      return sheet(
        'Rollover',
        <p>{carry ? sinceText(carry, month) : `Rolling over since ${monthName(rollover.since, month)}`}</p>,
        <div className="btn-row">
          <button type="button" className="btn secondary" onClick={() => onLevel('reset')} disabled={!editable || busy}>
            Reset carryover…
          </button>
          <button type="button" className="btn secondary" onClick={() => onRoll({ on: false })} disabled={!editable || busy}>
            Turn off rollover
          </button>
        </div>
      );
    }
    // Turned off this month: the undo, which is on again from where it ran,
    // offered whatever is known of the first month with transactions.
    const { first, ran } = rollover;
    const choices = startChoices(month, rollover.earliest, ran).filter((m) => !first || m >= first);
    return sheet(
      'Rollover',
      <>
        {ran && choices.includes(ran) && (
          <p className="helper">Rollover was turned off this month. Turn it on again from {monthName(ran, month)} to bring its carry back.</p>
        )}
        <div className="sheet-form">
          <label className="field">
            Roll over what’s left (or overspent) into the next month, counting from
            <select value={from} onChange={(e) => onFrom(e.target.value)} disabled={!editable || busy}>
              {choices.map((m) => (
                <option key={m} value={m}>
                  {m === month ? `${monthName(m, month)} (this month)` : monthName(m, month)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </>,
      <button type="button" className="btn" onClick={() => onRoll({ on: true, from: from || month })} disabled={!editable || busy}>
        Turn on rollover
      </button>
    );
  }

  if (level === 'reset') {
    return sheet(
      'Reset carryover',
      <>
        <p>
          {name}’s carryover goes to zero from {monthName(month)}: this month starts from its budget alone
          <Masked>{carry ? `, and what is carried now (${carryText(carry, money, month)}) is set aside` : ''}</Masked>. Earlier months keep theirs.
        </p>
        <p className="helper">{REFUND_NOTE}</p>
      </>,
      <div className="btn-row">
        <button type="button" ref={safe} className="btn secondary" onClick={back} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn danger" onClick={() => onRoll({ reset: true })} disabled={!editable || busy}>
          Reset carryover
        </button>
      </div>
    );
  }

  if (level === 'remove') {
    // A carry is kept only for a budget that rolls over.
    const rolls = !!rollover?.since || !!carry;
    return sheet(
      'Remove budget',
      <p>
        Remove the budget for {name}?{rolls ? ' Its rollover ends with it: adding it again starts without one.' : ''}
      </p>,
      <div className="btn-row">
        <button type="button" ref={safe} className="btn secondary" onClick={back} disabled={busy}>
          Keep it
        </button>
        <button type="button" className="btn danger" onClick={onRemove} disabled={!editable || busy}>
          {busy ? 'Removing…' : 'Remove'}
        </button>
      </div>
    );
  }

  const amount = positive(draft);
  // A new amount is saved before its rollover changes, so the first level
  // has one way to commit; "300" is the 300.00 saved.
  const differs = Number(draft) !== saved;
  return sheet(
    name,
    <>
      {figures}
      {reconcile && <p className="helper">{reconcile}</p>}
      <div className="sheet-form">
        <AmountField label="Monthly budget" name={`Monthly budget for ${name}`} value={draft} onChange={onDraft} disabled={busy} />
      </div>
      <BudgetSuggestion
        suggestions={suggestions}
        target={target}
        currency={currency}
        rolling={!!rollover?.since}
        busy={!editable || busy}
        verb="Use"
        onUse={onSave}
      />
      {rollover && saved !== null && (
        <>
          <ul className="card list-rows">
            <li>
              <button
                type="button"
                className="list-row budget-rollover-row"
                aria-disabled={differs ? 'true' : undefined}
                aria-describedby={differs ? helpId : undefined}
                onClick={() => {
                  if (!differs) onLevel('rollover');
                }}
              >
                <span className="list-row-text">
                  <span className="list-row-title">Rollover</span>
                </span>
                <span className="list-row-value">{rollover.since ? `On since ${monthName(rollover.since, month)}` : 'Off'}</span>
                {chevron(RIGHT)}
              </button>
            </li>
          </ul>
          {differs && (
            <p className="helper" id={helpId}>
              Save the new amount first to change rollover.
            </p>
          )}
        </>
      )}
    </>,
    <div className="btn-row">
      {saved !== null && (
        <button type="button" className="btn secondary" onClick={() => onLevel('remove')} disabled={busy}>
          Remove…
        </button>
      )}
      <button type="button" className="btn" onClick={() => amount !== null && onSave(amount)} disabled={!editable || busy || amount === null}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

/** A budget on a category or group since deleted: its amount, and Remove
 *  budget, the sheet being the question. */
export function OrphanBudgetSheet({
  open,
  kind,
  amount,
  currency,
  editable,
  busy,
  errors,
  onClose,
  onRemove,
}: {
  open: boolean;
  kind: 'category' | 'group';
  amount: number;
  currency: string | null;
  editable: boolean;
  busy: boolean;
  errors: readonly string[];
  onClose: () => void;
  onRemove: () => void;
}) {
  const money = (n: number) => formatMoney(n, currency);
  const close = () => !busy && onClose();
  return (
    <Sheet
      open={open}
      title={`A ${kind} since deleted`}
      onClose={close}
      footer={
        <div className="btn-row">
          <button type="button" className="btn secondary" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={onRemove} disabled={!editable || busy}>
            Remove budget
          </button>
        </div>
      }
    >
      <div className="stack">
        <Said errors={errors} />
        <p className="money">
          <Masked>{money(amount)}</Masked>
        </p>
      </div>
    </Sheet>
  );
}

/** Add budget: a category or group to budget, and its amount. Only spending
 *  is offered: income and transfers are never spending, so a budget on them
 *  would never move (lib/spending.ts). */
export function AddBudgetSheet({
  open,
  taxonomy,
  budgets,
  spent,
  groups,
  currency,
  choice,
  onChoice,
  draft,
  onDraft,
  suggestions,
  editable,
  busy,
  errors,
  onClose,
  onAdd,
}: {
  open: boolean;
  taxonomy: Taxonomy;
  budgets: Budgets;
  /** This month's spending by category id, for each choice's hint. */
  spent: Readonly<Record<string, number>>;
  /** Every group's meter, for a whole group's spending. */
  groups: readonly GroupMeter[];
  currency: string | null;
  /** The category or group chosen ("category:<id>", "group:<id>"), or "". */
  choice: string;
  onChoice: (v: string) => void;
  draft: string;
  onDraft: (v: string) => void;
  suggestions: BudgetSuggestions | null;
  editable: boolean;
  busy: boolean;
  errors: readonly string[];
  onClose: () => void;
  onAdd: (target: Target, amount: number) => void;
}) {
  const money = (n: number) => formatMoney(n, currency);
  // What can still be budgeted: spending groups without one of their own,
  // and their categories without one (not archived), each with this month's
  // spending.
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
  const [kind, id] = choice.split(':') as ['category' | 'group', string];
  const target: Target | null = id ? { kind, id } : null;
  const amount = positive(draft);
  const close = () => !busy && onClose();
  return (
    <Sheet
      open={open}
      title="Add budget"
      onClose={close}
      footer={
        <button type="button" className="btn" onClick={() => target && amount !== null && onAdd(target, amount)} disabled={!editable || busy || !target || amount === null}>
          {busy ? 'Adding…' : 'Add budget'}
        </button>
      }
    >
      <div className="stack">
        <Said errors={errors} />
        <div className="sheet-form">
          <label className="field">
            Category or group
            <select value={choice} onChange={(e) => onChoice(e.target.value)} aria-label="Category or group to budget" disabled={busy}>
              <option value="">Choose a category or group…</option>
              <optgroup label="A whole group">
                {choices
                  .filter((c) => c.free)
                  .map(({ group }) => {
                    const text = `${group.name}${hint(groups.find((m) => m.group.id === group.id)?.spent_all)}`;
                    return (
                      <option key={group.id} value={`group:${group.id}`} aria-label={spokenLabel(text)}>
                        {text}
                      </option>
                    );
                  })}
              </optgroup>
              {choices
                .filter((c) => c.categories.length > 0)
                .map(({ group, categories }) => (
                  <optgroup key={group.id} label={group.name}>
                    {categories.map((c) => {
                      const text = `${displayName(c.name)}${hint(spent[c.id])}`;
                      return (
                        <option key={c.id} value={`category:${c.id}`} aria-label={spokenLabel(text)}>
                          {text}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
            </select>
          </label>
          <AmountField label="Monthly limit" name="Monthly limit" value={draft} onChange={onDraft} disabled={busy} />
        </div>
        {target && (
          <BudgetSuggestion
            suggestions={suggestions}
            target={target}
            currency={currency}
            busy={!editable || busy}
            verb="Add at"
            onUse={(suggested) => onAdd(target, suggested)}
          />
        )}
      </div>
    </Sheet>
  );
}
