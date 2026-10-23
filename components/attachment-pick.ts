// Choosing the transaction a receipt or document goes on (#47): the
// viewer's "Attach to another transaction" and a file not on one. Every
// transaction the Activity tab has loaded, once each: a split transaction as
// itself (a file goes on the transaction, never on a part), a group's
// transactions each (a group is no transaction), a shared one or a payment
// as itself at the bank's amount, and never a row shared expenses add
// (another's part, a part paid back, an IOU), which is no transaction. Found by its merchant, its
// amount as typed ("12.5", "12,50") or its day ("2026-03-04", or "Mar 4" as
// this browser writes it). Pure, so the viewer and the tests share it.

import { currencyOf } from '@/lib/spending';
import { isLayerRow } from '@/lib/shared-expenses/rows';
import { amountTyped, wholeAmount } from './receipt-filter';

export type PickRow = {
  transaction_id: string;
  date: string;
  name: string;
  amount: number;
  pending: boolean;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  split_of?: string;
  split_parent?: { amount: number };
  shared_was?: number;
  shared_part?: unknown;
  shared_iou?: unknown;
  group_members?: readonly PickRow[];
};

export type Candidate = { id: string; date: string; name: string; amount: number; currency: string | null; pending: boolean };

/** Every transaction a file can go on, newest first, leaving out `except`
 *  (the one it is on). */
export function candidates(rows: readonly PickRow[], except: string | null = null): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const t of rows) {
    for (const r of t.group_members ?? [t]) {
      if (isLayerRow(r)) continue;
      const id = r.split_of ?? r.transaction_id;
      if (id === except || out.has(id)) continue;
      out.set(id, { id, date: r.date, name: r.name, amount: wholeAmount(r), currency: currencyOf(r), pending: r.pending });
    }
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name)));
}

/** The day as this browser writes it short ("Mar 4"), for the search. */
export function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The candidates the text typed finds, at most `limit`. */
export function findCandidates(all: readonly Candidate[], query: string, limit = 40): Candidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  const figure = /^[\d\s.,]+$/.test(q) ? amountTyped(q) : null;
  const out: Candidate[] = [];
  for (const c of all) {
    const size = Math.abs(c.amount);
    const hit =
      c.name.toLowerCase().includes(q) ||
      c.date.includes(q) ||
      shortDay(c.date).toLowerCase().includes(q) ||
      (figure !== null && (Math.abs(size - figure) < 0.005 || (Number.isInteger(figure) && Math.floor(size) === figure)));
    if (hit) out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}
