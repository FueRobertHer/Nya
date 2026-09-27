// lib/overrides.ts
//
// Manual category overrides for transactions (Mint-style recategorization).
// Plaid's auto-categorization is good but not always right; overrides are a
// Redis hash of transaction_id -> category, applied on top of the fetched
// data in /api/transactions. Values are encrypted for consistency with
// everything else financial.

import { redis, kc } from './storage';
import type { Ctx } from './containers';
import { encrypt, decrypt } from './crypto';
import { contentKey, type StoredTxn } from './transactions';
import { resolveId, type Link } from './link-core';

const OVERRIDES_HASH = (ctx: Ctx) => kc(ctx, 'txn-category-overrides');

export async function getOverrides(ctx: Ctx): Promise<Record<string, string>> {
  try {
    const map = await redis().hgetall<Record<string, string>>(OVERRIDES_HASH(ctx));
    if (!map) return {};
    const out: Record<string, string> = {};
    await Promise.all(
      Object.entries(map).map(async ([id, blob]) => {
        try {
          out[id] = await decrypt(blob);
        } catch {
          // undecryptable override (rotated key) -- drop it
        }
      })
    );
    return out;
  } catch {
    return {};
  }
}

export async function setOverride(ctx: Ctx, transaction_id: string, category: string): Promise<void> {
  await redis().hset(OVERRIDES_HASH(ctx), { [transaction_id]: await encrypt(category) });
}

// ---------------------------------------------------------------------------
// Carrying categories across a re-link (#46)
//
// A re-link gives every transaction a new transaction_id, so the overrides
// above no longer match anything. When an Item is disconnected, each of its
// overridden rows is recorded here under its contentKey (lib/transactions.ts:
// account, date, amount, merchant) before its store is deleted. Once the user
// links the old account to the new one (lib/links.ts), the new account's rows
// with the same key show the same category.
//
// Like links, this rewrites nothing: the carried categories are applied on
// read, a category set on the new row itself still wins, and unlinking stops
// the carry. A key whose rows were categorized differently is ambiguous and
// carries nothing, rather than guessing.

const CARRY_HASH = (ctx: Ctx) => kc(ctx, 'txn-category-carry');

/** A category waiting to be carried; null when its rows disagreed. */
export type Carried = { account_id: string; category: string | null };

/**
 * Records the overridden rows of an Item being disconnected. Call before its
 * transaction store is cleared. Throws if the overrides can't be read, so the
 * caller can say it couldn't (it must not stop the disconnect).
 */
export async function retireOverrides(ctx: Ctx, txns: StoredTxn[]): Promise<number> {
  const raw = (await redis().hgetall<Record<string, string>>(OVERRIDES_HASH(ctx))) ?? {};
  const wanted = txns.filter((t) => !t.pending && raw[t.transaction_id] !== undefined);
  if (wanted.length === 0) return 0;
  const byKey = new Map<string, Carried>();
  for (const t of wanted) {
    let category: string;
    try {
      category = await decrypt(raw[t.transaction_id]);
    } catch {
      continue; // unreadable: it isn't shown today either
    }
    const key = contentKey(t.account_id, t);
    const prev = byKey.get(key);
    byKey.set(key, { account_id: t.account_id, category: prev && prev.category !== category ? null : category });
  }
  if (byKey.size === 0) return 0;
  const writes: Record<string, string> = {};
  for (const [key, c] of byKey) writes[key] = await encrypt(JSON.stringify(c));
  await redis().hset(CARRY_HASH(ctx), writes);
  return byKey.size;
}

/** Every recorded category, by contentKey. Empty when it can't be read: a
 *  carried category is a convenience, and a failed read shows Plaid's. */
export async function getCarried(ctx: Ctx): Promise<Map<string, Carried>> {
  const out = new Map<string, Carried>();
  try {
    const raw = (await redis().hgetall<Record<string, string>>(CARRY_HASH(ctx))) ?? {};
    await Promise.all(
      Object.entries(raw).map(async ([key, blob]) => {
        try {
          const c = JSON.parse(await decrypt(blob)) as Carried;
          if (typeof c?.account_id === 'string' && (typeof c.category === 'string' || c.category === null)) out.set(key, c);
        } catch {
          // unreadable: skipped, like an unreadable override
        }
      })
    );
  } catch (err) {
    console.warn('overrides: could not read carried categories', err instanceof Error ? err.message : err);
  }
  return out;
}

/** The key under the account's current id, or null when it isn't linked to
 *  anything: nothing is carried until the user has said it's the same account. */
function currentKey(key: string, c: Carried, links: Map<string, Link>): string | null {
  const current = resolveId(c.account_id, links);
  if (current === c.account_id || !key.startsWith(`${c.account_id}|`)) return null;
  return current + key.slice(c.account_id.length);
}

/**
 * The categories to apply, by contentKey under each account's CURRENT id,
 * following the active links. Two earlier ids of one account that disagree
 * on a row carry nothing for it.
 */
export function carriedCategories(carried: Map<string, Carried>, links: Map<string, Link>): Map<string, string> {
  const out = new Map<string, string>();
  const clash = new Set<string>();
  for (const [key, c] of carried) {
    const k = currentKey(key, c, links);
    if (!k) continue;
    if (c.category === null || (out.has(k) && out.get(k) !== c.category)) {
      clash.add(k);
      continue;
    }
    out.set(k, c.category);
  }
  for (const k of clash) out.delete(k);
  return out;
}

/**
 * For each linked earlier account: how many categorized rows it had, and how
 * many of them match a row of the account now (`present`: the contentKeys of
 * the stored rows). Reported on the Accounts tab so the carry-over is honest
 * about what didn't make it (rows older than the bank re-sends, or ambiguous).
 */
export function carryCounts(
  carried: Map<string, Carried>,
  links: Map<string, Link>,
  present: Set<string>
): Record<string, { total: number; carried: number }> {
  const categories = carriedCategories(carried, links);
  const out: Record<string, { total: number; carried: number }> = {};
  for (const [key, c] of carried) {
    const k = currentKey(key, c, links);
    if (!k) continue;
    const n = (out[c.account_id] ??= { total: 0, carried: 0 });
    n.total++;
    if (categories.has(k) && present.has(k)) n.carried++;
  }
  return out;
}
