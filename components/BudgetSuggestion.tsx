'use client';

// A budget suggestion from history (lib/budget-suggestions.ts), in a budget's
// sheet and in Add budget's once a category or group is chosen: what
// was spent there on average over the last three complete months, rounded
// up, the months it averaged, and why any were left out or may be short,
// with one tap to use it. Shown only in the currency the budgets are in.

import { formatInstantDay, formatMoney } from '@/lib/format';
import { gapText, type MonthGap } from '@/lib/rollover';
import { suggestionWords, type BudgetSuggestions } from '@/lib/budget-suggestions';
import { Masked } from './HideAmounts';

/** A day ("2026-08-12") or an instant as the local day it fell on: "Aug 12". */
const dayOf = (at: string) => formatInstantDay(at, { sentence: true }) ?? at;

export default function BudgetSuggestion({
  suggestions,
  target,
  currency,
  rolling = false,
  busy = false,
  verb,
  onUse,
}: {
  suggestions: BudgetSuggestions | null | undefined;
  target: { kind: 'category' | 'group'; id: string };
  /** The currency the budgets are shown in: a suggestion in another isn't one. */
  currency: string | null;
  /** The budget rolls over: the suggestion says it is still the plain average. */
  rolling?: boolean;
  busy?: boolean;
  /** What the button does with the amount: "Use", "Add at". */
  verb: string;
  /** Applies the amount suggested. */
  onUse: (amount: number) => void;
}) {
  if (!suggestions || suggestions.currency !== currency) return null;
  const words = suggestionWords(suggestions, target, {
    money: (n) => formatMoney(n, currency),
    day: dayOf,
    rolling,
    gapText: (g: MonthGap) => gapText(g, dayOf),
  });
  return (
    <div className="stack tight">
      <p className="helper">
        <Masked>{words.line}</Masked>
      </p>
      {words.amount !== null && (
        <div className="btn-row">
          <button type="button" className="btn secondary" onClick={() => onUse(words.amount!)} disabled={busy}>
            <Masked>{`${verb} ${formatMoney(words.amount, currency)}`}</Masked>
          </button>
        </div>
      )}
      {words.notes.map((n) => (
        <p className="helper" key={n}>
          <Masked>{n}</Masked>
        </p>
      ))}
    </div>
  );
}
