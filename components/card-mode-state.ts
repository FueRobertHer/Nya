// Card Mode's progress (components/CardMode.tsx): the transactions to review,
// in the order they were dealt when it opened, and what was done to each, in
// order, so the last can be undone. Pure, so the tests play it through.
//
// A card is a transaction as transactionCounter counts one (lib/spending.ts):
// a split transaction once, whole, with its parts on it; each of a group's
// transactions on its own. Its row is read from the list as it is now, never
// kept: a card the person approved elsewhere meanwhile (another device, the
// list behind) is passed over, and one whose amount the bank changed shows
// the change.

/** What was done to one card. `undo` is whatever the view needs to put it
 *  back (an approval's ticket, the category it had). */
export type CardStep<U = unknown> = { id: string; kind: 'approved' | 'recategorized' | 'skipped'; undo?: U };

export type Cards<U = unknown> = { queue: readonly string[]; steps: readonly CardStep<U>[] };

/** Cards dealt for these transactions, in this order. */
export function openCards<U = unknown>(ids: readonly string[]): Cards<U> {
  return { queue: [...new Set(ids)], steps: [] };
}

/** The card to show: the first dealt with nothing done to it that still
 *  waits (`waits`: it is in the list and needs review), or null when none is
 *  left: all caught up. */
export function currentCard(c: Cards<unknown>, waits: (id: string) => boolean): string | null {
  const done = new Set(c.steps.map((s) => s.id));
  return c.queue.find((id) => !done.has(id) && waits(id)) ?? null;
}

/** After something was done to a card. */
export function withStep<U>(c: Cards<U>, step: CardStep<U>): Cards<U> {
  return { ...c, steps: [...c.steps, step] };
}

/** A card's step taken out without undoing anything: what was done to it
 *  didn't save (the request failed), so it is dealt again in its place. */
export function withoutStep<U>(c: Cards<U>, id: string): Cards<U> {
  const at = c.steps.map((s) => s.id).lastIndexOf(id);
  return at < 0 ? c : { ...c, steps: [...c.steps.slice(0, at), ...c.steps.slice(at + 1)] };
}

/** The last thing done, taken back: the cards as before it, and the step,
 *  for the view to undo; null when nothing was done. */
export function undoStep<U>(c: Cards<U>): { cards: Cards<U>; step: CardStep<U> | null } {
  if (c.steps.length === 0) return { cards: c, step: null };
  return { cards: { ...c, steps: c.steps.slice(0, -1) }, step: c.steps[c.steps.length - 1] };
}

/** What was done, for the end card and the live announcements. */
export function cardCounts(c: Cards<unknown>): { approved: number; recategorized: number; skipped: number } {
  const n = { approved: 0, recategorized: 0, skipped: 0 };
  for (const s of c.steps) n[s.kind]++;
  return n;
}

/** The skipped ones dealt again, in their order, with nothing done to them,
 *  and everything else done this time kept: the end card counts the whole
 *  of it, and Undo still reaches back into the first round. */
export function dealSkipped<U>(c: Cards<U>): Cards<U> {
  return { queue: c.queue, steps: c.steps.filter((s) => s.kind !== 'skipped') };
}

/** Card Mode's category list, open on one card, with the category it shows
 *  (the view's draft: nothing is chosen until "Use"). */
export type Picker = { id: string; draft: string };

/** The list as the card `id` shown now has it: open only on the card it was
 *  opened on, so a category picked for one card is never used on another
 *  that comes up under it (a failed approval dealing a card back, a refresh
 *  passing over the one shown). */
export function pickerOn(p: Picker | null, id: string | null): Picker | null {
  return p && id !== null && p.id === id ? p : null;
}

/** Which card this is of those dealt, from 1, and how many: "3 of 12". */
export function cardPosition(c: Cards<unknown>, id: string | null): { at: number; of: number } {
  const done = new Set(c.steps.map((s) => s.id));
  return { at: id === null ? c.queue.length : Math.min(c.queue.length, done.size + 1), of: c.queue.length };
}
