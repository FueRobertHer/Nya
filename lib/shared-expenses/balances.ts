// lib/shared-expenses/balances.ts
//
// What each person owes, or is owed, worked out from what the person said
// (lib/shared-expenses/model.ts) on every read, never stored. Pure, safe in
// the browser.
//
// An ITEM is a share's entry (owed to you: you paid) or an IOU (either way).
// It is open by its amount less what closed it: the payments that name it
// and what was settled outside or let go on it. A person's BALANCE in a
// currency is the sum of their items, each counted from your side (owed to
// you is plus, owed by you is minus), so it is a true net: Alex's half of a
// $120 dinner (+60) and your half of $50 of groceries he bought (-25) are
// +35, "Alex owes you $35.00". Nothing is converted between currencies: a
// balance is per currency, and items net only within one.
//
// AN ITEM CLOSED PAST ITS AMOUNT (two payments confirmed for one item, or two
// devices at once) is said so, and the excess counts the other way, which is
// what happened: they paid you more than they owed.
//
// Sums are in the currency's minor units (lib/split-rows.ts unitScale), so a
// balance is exact to the cent, the yen, or eight places.

import { toUnits, unitScale } from '../split-rows';
import type { Closed, Direction, Iou, Payment, Share } from './model';

export type Item = {
  id: string;
  kind: 'share' | 'iou';
  person: string;
  direction: Direction;
  amount: number;
  currency: string;
  date: string;
  what: string;
  /** A share's: its transaction's id. */
  transaction_id?: string;
  /** An IOU owed by you: the category of what your part was for. */
  category_id?: string;
  closed: readonly Closed[];
};

/** Every item, by id: each share's entries and each IOU. An id found twice
 *  (it can't be: each is random) is counted once, the first found. */
export function itemsOf(shares: ReadonlyMap<string, Share>, ious: ReadonlyMap<string, Iou>): Map<string, Item> {
  const out = new Map<string, Item>();
  for (const [transaction_id, s] of shares) {
    for (const e of s.entries) {
      if (out.has(e.id)) continue;
      out.set(e.id, { id: e.id, kind: 'share', person: e.person, direction: 'to_you', amount: e.amount, currency: s.currency, date: s.date, what: s.what, transaction_id, closed: e.closed ?? [] });
    }
  }
  for (const [id, i] of ious) {
    if (out.has(id)) continue;
    out.set(id, { id, kind: 'iou', person: i.person, direction: i.direction, amount: i.amount, currency: i.currency, date: i.date, what: i.what, ...(i.category_id ? { category_id: i.category_id } : {}), closed: i.closed ?? [] });
  }
  return out;
}

/** How much of each item the payments close, in its currency's minor units,
 *  and the payments that name each. Only allocations in the item's own
 *  currency count (a payment is in its row's currency, refused otherwise). */
export function paidOf(payments: ReadonlyMap<string, Payment>, items: ReadonlyMap<string, Item>): Map<string, { units: number; by: string[] }> {
  const out = new Map<string, { units: number; by: string[] }>();
  for (const [row, p] of payments) {
    for (const a of p.allocations) {
      const item = items.get(a.item);
      if (!item || item.currency !== p.row.currency) continue;
      const cur = out.get(a.item) ?? { units: 0, by: [] };
      cur.units += toUnits(a.amount, unitScale(item.currency));
      cur.by.push(row);
      out.set(a.item, cur);
    }
  }
  return out;
}

/** What closed an item outside a payment, in minor units, by kind. */
export function closedUnits(item: Pick<Item, 'currency' | 'closed'>): { outside: number; forgiven: number } {
  const scale = unitScale(item.currency);
  let outside = 0;
  let forgiven = 0;
  for (const c of item.closed) {
    if (c.kind === 'outside') outside += toUnits(c.amount, scale);
    else forgiven += toUnits(c.amount, scale);
  }
  return { outside, forgiven };
}

/** An item as the card shows it: what is still open (negative when closed
 *  past its amount), and what closed it. Amounts in its currency. */
export type ItemState = Item & { paid: number; outside: number; forgiven: number; open: number; over: boolean };

export function itemState(item: Item, paid: ReadonlyMap<string, { units: number }>): ItemState {
  const scale = unitScale(item.currency);
  const { outside, forgiven } = closedUnits(item);
  const p = paid.get(item.id)?.units ?? 0;
  const open = toUnits(item.amount, scale) - p - outside - forgiven;
  return { ...item, paid: p / scale, outside: outside / scale, forgiven: forgiven / scale, open: open / scale, over: open < 0 };
}

/** A person's balance in one currency. */
export type Balance = {
  currency: string;
  /** Positive: they owe you. Negative: you owe them. */
  amount: number;
  /** Items still open (or closed past their amount) in it. */
  open: number;
  /** The day of the oldest item still open, for "open 7 months". */
  oldest: string | null;
  /** Items closed past their amount. */
  over: number;
};

/** Each person's balances, by person id, each currency most first (by its
 *  open items, then by code). */
export function balancesOf(items: ReadonlyMap<string, Item>, payments: ReadonlyMap<string, Payment>): Map<string, Balance[]> {
  const paid = paidOf(payments, items);
  const by = new Map<string, Map<string, { units: number; open: number; oldest: string | null; over: number }>>();
  for (const item of items.values()) {
    const s = itemState(item, paid);
    const scale = unitScale(item.currency);
    const units = toUnits(s.open, scale);
    const person = by.get(item.person) ?? new Map();
    const cur = person.get(item.currency) ?? { units: 0, open: 0, oldest: null, over: 0 };
    cur.units += item.direction === 'to_you' ? units : -units;
    if (units !== 0) {
      cur.open++;
      if (units > 0 && (cur.oldest === null || item.date < cur.oldest)) cur.oldest = item.date;
    }
    if (s.over) cur.over++;
    person.set(item.currency, cur);
    by.set(item.person, person);
  }
  const out = new Map<string, Balance[]>();
  for (const [person, currencies] of by) {
    const list = [...currencies]
      .map(([currency, c]) => ({ currency, amount: c.units / unitScale(currency), open: c.open, oldest: c.oldest, over: c.over }))
      .filter((b) => b.open > 0 || b.amount !== 0)
      .sort((a, b) => b.open - a.open || (a.currency < b.currency ? -1 : 1));
    out.set(person, list);
  }
  return out;
}

/** Whether every item with a person is closed, in every currency: what
 *  archiving them needs. */
export function allClosed(items: ReadonlyMap<string, Item>, payments: ReadonlyMap<string, Payment>, person: string): boolean {
  return (balancesOf(items, payments).get(person) ?? []).every((b) => b.amount === 0 && b.open === 0);
}

/** Whole months between two days (YYYY-MM-DD), for "open 7 months". */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months--;
  return Math.max(0, months);
}
