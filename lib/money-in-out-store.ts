// lib/money-in-out-store.ts
//
// Where an investment account's money in and out (lib/money-in-out.ts) are
// kept: a map store on the storage seam (lib/repo.ts), keyed by account id,
// exportable, since they are the person's own account of their accounts. The
// owner's alone: nothing shared reads them.
//
// KEYED TO SURVIVE A RE-LINK, as closures are (lib/lifecycle.ts): an entry
// is stored under the id the account had when it was set and read through
// account links (lib/links.ts), so totals set before the institution gave
// the account a new id still apply to it. Of two entries on one account, its
// current id's wins, then the newest. Setting them writes the current id's
// and drops the others; clearing drops every one. Whether the totals can
// still be carried (their day inside the activity Nya keeps for the account)
// is decided where they are read against that activity, on every read
// (lib/growth.ts usableTotals), never here.
//
// Kept when an institution is disconnected, as the account's history is, for
// a re-link; forgotten with the account (lib/links.ts forgetEarlierAccount).

import { defineMapStore, type MapStore } from './repo';
import type { Ctx } from './containers';
import { effectiveLinks, getLinks, sameAccountIds } from './link-core';
import { liveAccountIds } from './links';
import { isMoneyInOut, type MoneyInOut, type MoneyInOutChange } from './money-in-out';

export const moneyInOutStore: MapStore<MoneyInOut> = defineMapStore<MoneyInOut>('money-in-out', {
  what: 'deposits and withdrawals',
  isValid: isMoneyInOut,
  exportable: true,
});

/** Every id the account has had, by the links that apply now: a paused link
 *  (its earlier id is live again) joins two live accounts, and must not carry
 *  one's totals to the other. Strict. */
async function accountIds(ctx: Ctx, account_id: string): Promise<string[]> {
  const links = effectiveLinks(await getLinks(ctx), await liveAccountIds(ctx, { strict: true }));
  return sameAccountIds(account_id, links);
}

/** The totals that apply to an account, by its current id, or null. Strict:
 *  an entry that can't be read throws, as do links that can't be. Links are
 *  read only when the id has no entry of its own and another id has one. */
export async function readMoneyInOut(ctx: Ctx, account_id: string): Promise<MoneyInOut | null> {
  const own = await moneyInOutStore.get(ctx, account_id);
  if (own) return own;
  const stored = await moneyInOutStore.ids(ctx);
  if (stored.length === 0 || (stored.length === 1 && stored[0] === account_id)) return null;
  const others = (await accountIds(ctx, account_id)).filter((id) => id !== account_id && stored.includes(id));
  if (others.length === 0) return null;
  const entries = [...(await moneyInOutStore.getMany(ctx, others))].sort(([a, x], [b, y]) =>
    x.set_at !== y.set_at ? (x.set_at < y.set_at ? 1 : -1) : a < b ? -1 : 1
  );
  return entries[0]?.[1] ?? null;
}

/** Sets or clears an account's totals (see the header). Answers what applies
 *  now: the totals written, or null once cleared. */
export async function saveMoneyInOut(ctx: Ctx, change: MoneyInOutChange, now: number = Date.now()): Promise<MoneyInOut | null> {
  const ids = await accountIds(ctx, change.account_id);
  const others = ids.filter((id) => id !== change.account_id);
  if (change.kind === 'clear') {
    await moneyInOutStore.remove(ctx, change.account_id, ...others);
    return null;
  }
  const entry: MoneyInOut = { in: change.in, out: change.out, as_of: change.as_of, currency: change.currency, set_at: new Date(now).toISOString() };
  // The current id's first: it wins on read, so a failure dropping the others
  // never leaves older totals showing.
  await moneyInOutStore.set(ctx, change.account_id, entry);
  if (others.length > 0) await moneyInOutStore.remove(ctx, ...others);
  return entry;
}

/** Forgetting an earlier account (lib/links.ts forgetEarlierAccount) takes
 *  its totals too. */
export async function forgetMoneyInOut(ctx: Ctx, id: string): Promise<void> {
  await moneyInOutStore.remove(ctx, id);
}
