// lib/shared-expenses/api.ts
//
// Shared expenses as the read-only API answers them (GET
// /api/v1/shared-expenses, and the MCP tool get_shared_expenses): the one
// answer that names the people the person splits costs with. Everywhere else
// the API gives a person's random id only (a transaction's `shared` and
// `settles`), so a token used for transactions alone never receives a
// friend's name, and this one endpoint documents where names leave.
//
// Read strictly (lib/shared-expenses/read.ts readCard): balances are null
// while any share, IOU or payment can't be read, never a figure short of one;
// what couldn't be read is counted by store. No handle and no request is
// answered: a program doesn't need them.

import type { Ctx } from '../containers';
import { categoryById, indexTaxonomy, isProvisionalId } from '../categories';
import { readTaxonomy } from '../category-store';
import { StoredDataUnreadableError } from '../repo';
import { toUnits, unitScale } from '../split-rows';
import { readCard } from './read';
import type { Counting, Direction } from './model';

export type ApiSharedPerson = {
  id: string;
  /** Null once the person forgot them: the amounts stay. */
  name: string | null;
  archived: boolean;
  /** Per currency: positive, they owe you; negative, you owe them. Null
   *  while anything couldn't be read. */
  balances: { currency: string; amount: number; open_items: number }[] | null;
};

export type ApiSharedItem = {
  id: string;
  kind: 'share' | 'iou';
  person_id: string;
  /** to_you: they owe you; by_you: you owe them. */
  direction: Direction;
  date: string;
  what: string;
  currency: string;
  amount: number;
  /** What is still open of it (negative: closed past its amount). */
  open: number;
  /** A share's: the transaction it is of. */
  transaction_id: string | null;
  /** An IOU you owe: the category of what your part was for. */
  category_id: string | null;
  category: string | null;
  /** What it counts in totals at your part: an IOU you owe for something,
   *  less what was let go, under `part`; zero otherwise (a share's parts
   *  never count as yours). */
  counted: number;
};

export type ApiSharedExpenses = {
  counting: Counting;
  people: ApiSharedPerson[];
  /** Every IOU, and every share's part still open (closed ones are in the
   *  app), newest first. */
  items: ApiSharedItem[];
  /** The 100 newest payments the person confirmed. */
  payments: { transaction_id: string; date: string; amount: number; currency: string; allocations: { item: string; person_id: string | null; amount: number }[] }[];
  /** How many entries of each store couldn't be read; empty when all did. */
  unreadable: Record<string, number>;
};

export async function readApiSharedExpenses(ctx: Ctx): Promise<ApiSharedExpenses> {
  const card = await readCard(ctx);
  // The categories' names, for IOUs: a convenience, so one that can't be
  // read leaves the names out and the ids in.
  let ix: ReturnType<typeof indexTaxonomy> | null = null;
  try {
    const taxonomy = await readTaxonomy(ctx);
    ix = taxonomy ? indexTaxonomy(taxonomy) : null;
  } catch (err) {
    if (!(err instanceof StoredDataUnreadableError)) throw err;
  }
  const people: ApiSharedPerson[] = [...card.people]
    .map(([id, p]) => ({
      id,
      name: p.name ?? null,
      archived: !!p.archived_at,
      balances: card.balances ? (card.balances.get(id) ?? []).map((b) => ({ currency: b.currency, amount: b.amount, open_items: b.open })) : null,
    }))
    .sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿') || (a.id < b.id ? -1 : 1));
  const items: ApiSharedItem[] = card.items
    .filter((i) => i.kind === 'iou' || i.open !== 0)
    .map((i) => {
      const c = ix && i.category_id ? categoryById(ix, i.category_id) : null;
      const scale = unitScale(i.currency);
      const counts = card.counting === 'part' && i.kind === 'iou' && i.direction === 'by_you' && !!i.category_id;
      const counted = counts ? Math.max(0, toUnits(i.amount, scale) - toUnits(i.forgiven, scale)) / scale : 0;
      return {
        id: i.id,
        kind: i.kind,
        person_id: i.person,
        direction: i.direction,
        date: i.date,
        what: i.what,
        currency: i.currency,
        amount: i.amount,
        open: i.open,
        transaction_id: i.transaction_id ?? null,
        category_id: c && !isProvisionalId(c.id) ? c.id : (i.category_id ?? null),
        category: c?.name ?? null,
        counted,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1));
  const personOf = new Map(card.items.map((i) => [i.id, i.person] as const));
  const payments = [...card.payments]
    .map(([transaction_id, p]) => ({ transaction_id, date: p.row.date, amount: p.row.amount, currency: p.row.currency, allocations: p.allocations.map((a) => ({ item: a.item, person_id: personOf.get(a.item) ?? null, amount: a.amount })) }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.transaction_id < b.transaction_id ? -1 : 1))
    .slice(0, 100);
  const unreadable = Object.fromEntries(Object.entries(card.unread).map(([store, u]) => [store, u.unreadable.length + u.unrecognised.length]));
  return { counting: card.counting, people, items, payments, unreadable };
}
