// What the review queue and merchants' defaults say, in the views
// (components/ReviewBar.tsx, components/ReviewNote.tsx, components/CardMode.tsx,
// components/VendorDefaultsCard.tsx). Pure, so the tests read the same words.
// Amounts go through lib/format.ts, as every amount on a screen does.

import { formatMoney } from '@/lib/format';
import type { ReviewSuggestion } from '@/lib/review-layer';

const NUMBER_WORDS = ['no', 'one', 'two', 'three'];

/** "Filed by your default for Costco (two of your last three)": what filed
 *  a transaction, and why the default is what it is. */
export function defaultWords(merchant: string, agree: number): string {
  const why = agree >= 2 ? `${NUMBER_WORDS[agree] ?? agree} of your last three` : 'set when two of your last three agreed';
  return `Filed by your default for ${merchant} (${why})`;
}

/** The Defaults list's line for one merchant: since when, and why. */
export function defaultListWords(d: { since: string; agree: number }, day: (iso: string) => string): string {
  const why = d.agree >= 2 ? `${NUMBER_WORDS[d.agree] ?? d.agree} of your last three agree` : 'set when two of your last three agreed';
  return `Since ${day(d.since)}, ${why}`;
}

/** Why an approved transaction is back in the queue: the bank changed its
 *  amount since. */
export function changedWords(was: { amount: number; currency: string | null }): string {
  // Plaid's sign: positive is money out, shown as the list shows it.
  return `The bank changed the amount since you approved it at ${formatMoney(Math.abs(was.amount), was.currency)} ${was.amount < 0 ? 'in' : 'out'}.`;
}

/** What would file an approved transaction elsewhere now, offered. */
export function suggestionWords(s: ReviewSuggestion, categoryName: string, merchant: string): string {
  if (s.by === 'rule') return `Your rule would file it under ${categoryName}. It stays where you approved it until you choose.`;
  if (s.by === 'default') return `Your default for ${merchant} would file it under ${categoryName}. It stays where you approved it until you choose.`;
  return `Your bank now files it under ${categoryName}. It stays where you approved it until you choose.`;
}

/** "12 to review": transactions, counted as every count is. */
export function toReviewWords(n: number): string {
  return n === 0 ? 'Nothing to review' : `${n} to review`;
}

/** The end of Card Mode: all caught up, or done for now, with a count. */
export function endWords(c: { approved: number; recategorized: number; skipped: number }): { title: string; detail: string } {
  const done = c.approved + c.recategorized;
  if (done === 0 && c.skipped === 0) return { title: 'All caught up', detail: 'Nothing is waiting for review.' };
  const approved = done === 1 ? 'You approved 1 transaction' : `You approved ${done} transactions`;
  const recategorized = c.recategorized > 0 ? `, ${c.recategorized} of them with a new category` : '';
  if (c.skipped > 0) {
    return { title: 'Done for now', detail: `${approved}${recategorized}. ${c.skipped === 1 ? '1 you skipped still needs' : `${c.skipped} you skipped still need`} review.` };
  }
  return { title: 'All caught up', detail: `${approved}${recategorized}.` };
}

/** What Card Mode says once a card is done, for a screen reader. */
export function doneWords(kind: 'approved' | 'recategorized' | 'skipped' | 'undone', merchant: string, left: number): string {
  const what = kind === 'approved' ? `Approved ${merchant}` : kind === 'recategorized' ? `Recategorized and approved ${merchant}` : kind === 'skipped' ? `Skipped ${merchant}` : `Put ${merchant} back`;
  return `${what}. ${left === 0 ? 'Nothing left to review.' : `${left} left.`}`;
}
