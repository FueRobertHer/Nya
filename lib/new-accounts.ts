// lib/new-accounts.ts
//
// Items where Plaid has found accounts the user hasn't shared yet (the ITEM
// NEW_ACCOUNTS_AVAILABLE webhook). The card offers "Review accounts", which opens
// Link's account picker on the SAME Item: adding the account there costs nothing
// extra, where connecting the institution again would create a second Item that
// Plaid bills separately.
//
// One hash in the container, item id -> ISO time the webhook arrived. Plain: it
// says only that an Item has something new, and item ids already sit in plain
// view as field names elsewhere (accounts:vanished). Set by the webhook, cleared
// once the user has been through the picker, or on disconnect.

import { redis, kc } from './storage';
import type { Ctx } from './containers';

const NEW_ACCOUNTS_HASH = (ctx: Ctx) => kc(ctx, 'plaid:new-accounts');

export async function markNewAccounts(ctx: Ctx, item_id: string, now: number = Date.now()): Promise<void> {
  await redis().hset(NEW_ACCOUNTS_HASH(ctx), { [item_id]: new Date(now).toISOString() });
}

/** Item ids with new accounts waiting. A failed read is "none": this only
 *  decides whether a prompt shows, and must never cost the dashboard. */
export async function itemsWithNewAccounts(ctx: Ctx): Promise<Set<string>> {
  try {
    const map = await redis().hgetall<Record<string, string>>(NEW_ACCOUNTS_HASH(ctx));
    return new Set(Object.keys(map ?? {}));
  } catch {
    return new Set();
  }
}

export async function clearNewAccounts(ctx: Ctx, item_id: string): Promise<void> {
  try {
    await redis().hdel(NEW_ACCOUNTS_HASH(ctx), item_id);
  } catch {
    // Best effort: a flag left behind shows a prompt that opens the picker
    // again, which changes nothing the user doesn't choose.
  }
}
