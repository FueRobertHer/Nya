// lib/overrides.ts
//
// Manual category overrides for transactions (Mint-style recategorization): a
// Redis hash of transaction_id -> category, applied on top of the fetched data
// in /api/transactions. Values are encrypted like everything else financial.

import { redis, kc } from './storage';
import type { Ctx } from './containers';
import { encrypt, decrypt } from './crypto';
import { contentKey, storedTransactionIds, type StoredTxn } from './transactions';
import { resolveId, type Link } from './link-core';

const OVERRIDES_HASH = (ctx: Ctx) => kc(ctx, 'txn-category-overrides');

export async function getOverrides(ctx: Ctx): Promise<Record<string, string>> {
  return (await readOverridesReport(ctx)).overrides;
}

/**
 * The overrides getOverrides gives, and whether they were all read (`ok`):
 * false when the hash couldn't be read or an override couldn't be decrypted,
 * both of which getOverrides passes over. For a report, which says when the
 * person's own categories are missing from it (lib/report/read.ts); the app
 * goes on as it always has.
 */
export async function readOverridesReport(ctx: Ctx): Promise<{ overrides: Record<string, string>; ok: boolean }> {
  try {
    const map = await redis().hgetall<Record<string, string>>(OVERRIDES_HASH(ctx));
    if (!map) return { overrides: {}, ok: true };
    const out: Record<string, string> = {};
    let ok = true;
    await Promise.all(
      Object.entries(map).map(async ([id, blob]) => {
        try {
          out[id] = await decrypt(blob);
        } catch {
          // undecryptable override (rotated key) -- drop it
          ok = false;
        }
      })
    );
    return { overrides: out, ok };
  } catch {
    return { overrides: {}, ok: false };
  }
}

/**
 * Every override, transaction_id -> category, for the download of my data
 * (lib/user-export.ts). Strict where getOverrides is lenient: a failed read,
 * or any value that can't be decrypted, throws instead of being dropped, so a
 * download never leaves out a category the user set without saying so.
 */
export async function readOverridesStrict(ctx: Ctx): Promise<Map<string, string>> {
  const map = (await redis().hgetall<Record<string, string>>(OVERRIDES_HASH(ctx))) ?? {};
  const out = new Map<string, string>();
  for (const [id, category] of await Promise.all(
    Object.entries(map).map(async ([id, blob]) => [id, await decrypt(String(blob))] as const)
  )) {
    out.set(id, category);
  }
  return out;
}

export async function setOverride(ctx: Ctx, transaction_id: string, category: string): Promise<void> {
  await redis().hset(OVERRIDES_HASH(ctx), { [transaction_id]: await encrypt(category) });
}

// Carrying categories across a re-link (#46)
//
// A re-link gives every transaction a new transaction_id, so the overrides above
// no longer match. When an Item is disconnected, each of its overridden rows is
// recorded here under its contentKey (lib/transactions.ts: account, date, amount,
// the bank's descriptor) before its store is deleted. Once the user links the old
// account to the new one (lib/links.ts), the new account's rows with the same key
// show the same category.
//
// One encrypted record per earlier account, filed under its account id: the keys
// name a date, an amount and a merchant, so they belong inside the ciphertext,
// never in a field name. Filing by account also lets a user forget one earlier
// account's data in one step (forgetCarried).
//
// Like links, this rewrites nothing: carried categories are applied on read, a
// category set on the new row itself wins, and unlinking stops the carry. A key
// that can't be pinned to one category (rows categorized differently, or an
// identical row left as it was) carries nothing rather than guessing.

const CARRY_HASH = (ctx: Ctx) => kc(ctx, 'txn-category-carry');

/** One earlier account's rows: contentKey -> category, or null when ambiguous. */
export type CarriedRows = Record<string, string | null>;
/** Every earlier account's rows, by its account id. */
export type Carried = Map<string, CarriedRows>;

/**
 * Records the overridden rows of an Item being disconnected, then deletes those
 * overrides. Call before its transaction store is cleared, once the Item is
 * removed at Plaid. Throws if something can't be read, so the caller can say so
 * (it must not stop the disconnect).
 */
export async function retireOverrides(ctx: Ctx, txns: StoredTxn[]): Promise<number> {
  const raw = (await redis().hgetall<Record<string, string>>(OVERRIDES_HASH(ctx))) ?? {};
  // The Item's own overrides are dead once it is gone (its transaction ids go
  // with it), and the categories live on in the record written below: they are
  // dropped at the end, so forgetting the account later leaves none behind.
  const dead = txns.filter((t) => raw[t.transaction_id] !== undefined).map((t) => t.transaction_id);
  const dropDead = async () => {
    if (dead.length > 0) await redis().hdel(OVERRIDES_HASH(ctx), ...dead);
  };
  const posted = txns.filter((t) => !t.pending);
  if (!posted.some((t) => raw[t.transaction_id] !== undefined)) {
    await dropDead();
    return 0;
  }

  // Every posted row by key, overridden or not: an identical row the user left
  // alone means the category can't be attributed to "this" row on the other side.
  const groups = new Map<string, { account_id: string; categories: (string | undefined)[] }>();
  for (const t of posted) {
    let category: string | undefined;
    if (raw[t.transaction_id] !== undefined) {
      try {
        category = await decrypt(raw[t.transaction_id]);
      } catch {
        category = undefined; // unreadable: it isn't shown today either
      }
    }
    const key = contentKey(t.account_id, t);
    const g = groups.get(key) ?? { account_id: t.account_id, categories: [] };
    g.categories.push(category);
    groups.set(key, g);
  }

  const byAccount = new Map<string, CarriedRows>();
  for (const [key, g] of groups) {
    if (g.categories.every((c) => c === undefined)) continue;
    const first = g.categories[0];
    const agreed = g.categories.every((c) => c === first) ? (first as string) : null;
    const rows = byAccount.get(g.account_id) ?? {};
    rows[key] = agreed;
    byAccount.set(g.account_id, rows);
  }
  if (byAccount.size === 0) {
    await dropDead();
    return 0;
  }

  // Merged with anything already recorded for the account (the same id seen
  // under an earlier Item): a key recorded both ways becomes ambiguous.
  const existing = (await readCarried(ctx, [...byAccount.keys()])).carried;
  const writes: Record<string, string> = {};
  let n = 0;
  for (const [account_id, rows] of byAccount) {
    const merged: CarriedRows = { ...(existing.get(account_id) ?? {}) };
    for (const [key, category] of Object.entries(rows)) {
      merged[key] = key in merged && merged[key] !== category ? null : category;
    }
    n += Object.keys(rows).length;
    writes[account_id] = await encrypt(JSON.stringify(merged));
  }
  await redis().hset(CARRY_HASH(ctx), writes);
  await dropDead();
  return n;
}

async function parseRows(blob: string): Promise<CarriedRows | null> {
  try {
    const rows = JSON.parse(await decrypt(blob));
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return null;
    for (const v of Object.values(rows)) if (typeof v !== 'string' && v !== null) return null;
    return rows as CarriedRows;
  } catch {
    return null; // unreadable: skipped, like an unreadable override
  }
}

/** Some accounts' records, read strictly (throws on a failed read); a record
 *  that can't be parsed is skipped, and said in `ok`. */
async function readCarried(ctx: Ctx, account_ids: string[]): Promise<{ carried: Carried; ok: boolean }> {
  const out: Carried = new Map();
  let ok = true;
  const blobs = await Promise.all(account_ids.map((id) => redis().hget<string>(CARRY_HASH(ctx), id)));
  await Promise.all(
    account_ids.map(async (id, i) => {
      const rows = blobs[i] ? await parseRows(blobs[i]!) : null;
      if (rows) out.set(id, rows);
      else if (blobs[i]) ok = false;
    })
  );
  return { carried: out, ok };
}

/**
 * The records of the given earlier accounts, as getCarried reads them, and
 * whether they were all read (`ok`): false when the read failed or a record
 * couldn't be parsed. For a report (lib/report/read.ts), which says so; the
 * app shows Plaid's categories, as it always has.
 */
export async function getCarriedReport(ctx: Ctx, account_ids: string[]): Promise<{ carried: Carried; ok: boolean }> {
  if (account_ids.length === 0) return { carried: new Map(), ok: true };
  try {
    return await readCarried(ctx, account_ids);
  } catch (err) {
    console.warn('overrides: could not read carried categories', err instanceof Error ? err.message : err);
    return { carried: new Map(), ok: false };
  }
}

/**
 * The records of the given earlier accounts (the old ids of links), or of
 * every account when none are given. Empty when it can't be read: a carried
 * category is a convenience, and a failed read shows Plaid's.
 */
export async function getCarried(ctx: Ctx, account_ids?: string[]): Promise<Carried> {
  try {
    if (account_ids) return account_ids.length === 0 ? new Map() : (await readCarried(ctx, account_ids)).carried;
    const raw = (await redis().hgetall<Record<string, string>>(CARRY_HASH(ctx))) ?? {};
    const out: Carried = new Map();
    await Promise.all(
      Object.entries(raw).map(async ([id, blob]) => {
        const rows = await parseRows(blob);
        if (rows) out.set(id, rows);
      })
    );
    return out;
  } catch (err) {
    console.warn('overrides: could not read carried categories', err instanceof Error ? err.message : err);
    return new Map();
  }
}

/**
 * Every earlier account's record, for the download of my data
 * (lib/user-export.ts). Strict where getCarried is lenient: a failed read, or
 * a record that can't be decrypted or parsed, throws instead of being skipped.
 */
export async function readCarriedStrict(ctx: Ctx): Promise<Carried> {
  const raw = (await redis().hgetall<Record<string, string>>(CARRY_HASH(ctx))) ?? {};
  const out: Carried = new Map();
  for (const [id, rows] of await Promise.all(
    Object.entries(raw).map(async ([id, blob]) => [id, await parseRows(String(blob))] as const)
  )) {
    if (!rows) throw new Error('The categories carried for an earlier account could not be read');
    out.set(id, rows);
  }
  return out;
}

/**
 * Deletes overrides whose transaction no longer exists in any stored Item (rows
 * the bank removed, pending rows replaced by their posted ones, rows of an Item
 * disconnected before categories were carried): they can never be shown again.
 * Only when the Items and every store could be read, and no store is behind
 * (rows shown from a store too large to save aren't in it, and their
 * overrides are live); otherwise nothing (lib/transactions.ts
 * storedTransactionIds).
 */
export async function pruneOrphanOverrides(ctx: Ctx): Promise<number> {
  // The overrides first, then the Items and their stores: a category set on a
  // row saved meanwhile, of an Item linked meanwhile too, is then always
  // checked against a read that has the row.
  const ids = await redis().hkeys(OVERRIDES_HASH(ctx));
  if (ids.length === 0) return 0;
  const known = await storedTransactionIds(ctx);
  if (!known) return 0;
  const orphans = ids.filter((id) => !known.has(id));
  if (orphans.length > 0) await redis().hdel(OVERRIDES_HASH(ctx), ...orphans);
  return orphans.length;
}

/** Deletes one earlier account's carried categories (forgetting it). */
export async function forgetCarried(ctx: Ctx, account_id: string): Promise<void> {
  await redis().hdel(CARRY_HASH(ctx), account_id);
}

/** The key under the account's current id, or null when it isn't linked to
 *  anything: nothing is carried until the user has said it's the same account. */
function currentKey(key: string, account_id: string, links: Map<string, Link>): string | null {
  const current = resolveId(account_id, links);
  if (current === account_id || !key.startsWith(`${account_id}|`)) return null;
  return current + key.slice(account_id.length);
}

/**
 * The categories to apply, by contentKey under each account's CURRENT id,
 * following the active links. Two earlier ids of one account that disagree
 * on a row carry nothing for it.
 */
export function carriedCategories(carried: Carried, links: Map<string, Link>): Map<string, string> {
  const out = new Map<string, string>();
  const clash = new Set<string>();
  for (const [account_id, rows] of carried) {
    for (const [key, category] of Object.entries(rows)) {
      const k = currentKey(key, account_id, links);
      if (!k) continue;
      if (category === null || (out.has(k) && out.get(k) !== category)) {
        clash.add(k);
        continue;
      }
      out.set(k, category);
    }
  }
  for (const k of clash) out.delete(k);
  return out;
}

/**
 * For each linked earlier account: how many categorized rows it had that can
 * carry, how many show on a row of the account now, and how many were ambiguous
 * (never carried). `shown` holds the keys of displayed rows (inside the lookback,
 * not superseded) with no category of their own. Reported on the Accounts tab so
 * the carry-over is honest about what didn't make it.
 */
export function carryCounts(
  carried: Carried,
  links: Map<string, Link>,
  shown: Set<string>
): Record<string, { total: number; carried: number; ambiguous: number }> {
  const categories = carriedCategories(carried, links);
  const out: Record<string, { total: number; carried: number; ambiguous: number }> = {};
  for (const [account_id, rows] of carried) {
    for (const [key, category] of Object.entries(rows)) {
      const k = currentKey(key, account_id, links);
      if (!k) continue;
      const n = (out[account_id] ??= { total: 0, carried: 0, ambiguous: 0 });
      if (category === null || !categories.has(k)) {
        n.ambiguous++;
        continue;
      }
      n.total++;
      if (shown.has(k)) n.carried++;
    }
  }
  return out;
}
