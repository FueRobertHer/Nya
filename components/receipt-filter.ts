// The Activity tab's filter by receipt (#47): every transaction, those with a
// receipt or document, or those without one that spent more than an amount
// (the ones worth finding a receipt for). A row whether it has one couldn't
// be read for (its `attached` is null: lib/activity.ts markAttached) is left
// out of both, and counted, so the list can say so rather than pass it off
// as one without. It narrows the list, as the search does; the month's
// totals stay the month's. Pure, so the view and the tests share it.
//
// THE AMOUNT. In each transaction's own currency, as its row shows it: money
// out over it (a split transaction by its whole amount, a group's row by its
// net). Empty, any money out. Typed as the person writes it: "50", "50.5",
// "1,250" or "1 250", or "12,50" where a comma is the decimal mark.

export type ReceiptChoice = '' | 'with' | 'without';

/** What the filter reads of a row. */
export type ReceiptRow = {
  transaction_id: string;
  amount: number;
  attached?: true | null;
  split_of?: string;
  split_parent?: { amount: number };
};

/** The amount typed, or null when it is none (empty, or not a number). */
export function amountTyped(text: string): number | null {
  const t = text.trim().replace(/[\s  ']/g, '');
  if (!t) return null;
  let n: string;
  // A comma followed by one or two digits at the end, with no point: the
  // decimal mark. Otherwise commas group thousands.
  if (/^\d+(?:\.\d{3})*,\d{1,2}$/.test(t)) n = t.replace(/\./g, '').replace(',', '.');
  else n = t.replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(n)) return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/** The rows the filter keeps, in their order, and how many transactions it
 *  left out because whether they have one couldn't be read (a split
 *  transaction once). */
export function receiptRows<T extends ReceiptRow>(rows: readonly T[], choice: ReceiptChoice, over: string): { rows: readonly T[]; unknown: number } {
  if (choice === '') return { rows, unknown: 0 };
  const unknown = new Set<string>();
  const min = choice === 'without' ? (amountTyped(over) ?? 0) : 0;
  const kept = rows.filter((t) => {
    if (t.attached === null) {
      unknown.add(t.split_of ?? t.transaction_id);
      return false;
    }
    if (choice === 'with') return t.attached === true;
    const spent = t.split_parent ? t.split_parent.amount : t.amount;
    return t.attached !== true && spent > 0 && spent > min;
  });
  return { rows: kept, unknown: unknown.size };
}

/** What the list says of the transactions the filter couldn't tell about. */
export function unknownNote(n: number): string | null {
  if (n === 0) return null;
  return `${n === 1 ? 'One transaction is' : `${n} transactions are`} left out: whether ${n === 1 ? 'it has' : 'they have'} a receipt couldn’t be read just now.`;
}
