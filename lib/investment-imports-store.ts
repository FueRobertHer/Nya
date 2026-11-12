// lib/investment-imports-store.ts
//
// Where the transactions imported for an investment account
// (lib/investment-imports.ts) are kept: a map store on the storage seam
// (lib/repo.ts), exportable (the person's own record of their account) and
// compressed. The owner's alone: nothing shared reads it.
//
// ONE ENTRY PER ACCOUNT AND IMPORT, under `${account_id}:${import_id}`,
// never changed after it is written. An import that takes several accounts
// writes all their entries in one step (MapStore.updateMany), and its Undo
// removes them all in one (a single HDEL), so no reader ever sees part of
// one. `ids()` lists every import without reading a row: what the activity
// caches are checked against (importsFingerprint), in one request however
// many accounts are asked for.
//
// KEYED TO SURVIVE A RE-LINK, as the months imported from Vanguard's
// Performance page are (lib/investment-months-store.ts): an import is stored
// under the id the account had then, and read through the links that apply
// now (effectiveLinks over the strict live ids, so a paused link never
// carries one account's imports to another). Links are read only when
// another id holds an entry.
//
// Kept when an institution is disconnected, as the account's history is,
// for a re-link; forgotten with the account (lib/links.ts
// forgetEarlierAccount).

import { createHash } from 'node:crypto';
import { loggable } from './log-safe';
import { defineMapStore, type MapStore } from './repo';
import type { Ctx } from './containers';
import { effectiveLinks, getLinks, sameAccountIds } from './link-core';
import { liveAccountIds } from './links';
import {
  importKey,
  isInvestmentImport,
  keyParts,
  MAX_ACCOUNTS_PER_IMPORT,
  MAX_IMPORTS_PER_ACCOUNT,
  type AccountImport,
  type InvestmentImport,
} from './investment-imports';

export const investmentImportsStore: MapStore<InvestmentImport> = defineMapStore<InvestmentImport>('investment-imports', {
  what: 'transactions imported from your brokerage',
  isValid: isInvestmentImport,
  exportable: true,
  compress: true,
});

/** Which imports there are, in a word: a cached activity built from other
 *  imports (or before there were any) is a miss. Changes with every import
 *  and every Undo, for every account, which costs each account's cache one
 *  miss: imports are rare. */
export function importsFingerprint(keys: readonly string[]): string {
  if (keys.length === 0) return 'none';
  return createHash('sha256').update([...keys].sort().join('\n')).digest('base64url').slice(0, 22);
}

/** Every import's key. One request; a failure to reach storage throws. */
export function importKeys(ctx: Ctx): Promise<string[]> {
  return investmentImportsStore.ids(ctx);
}

/** importKeys for the activity's readers, or null when they can't be listed
 *  (logged): no cached copy can be checked then, and the activity is Plaid's
 *  alone, said, and not cached. */
export async function importKeysOrNull(ctx: Ctx): Promise<string[] | null> {
  try {
    return await importKeys(ctx);
  } catch (err) {
    console.error(loggable(err));
    return null;
  }
}

/** Every id each account has had, by the links that apply now (strict),
 *  read only when an import is stored under an id not asked for. */
async function idsOf(ctx: Ctx, account_ids: readonly string[], keys: readonly string[]): Promise<Map<string, string[]>> {
  const asked = new Set(account_ids);
  const elsewhere = keys.some((k) => !asked.has(keyParts(k)?.account_id ?? ''));
  if (!elsewhere) return new Map(account_ids.map((id) => [id, [id]]));
  const links = effectiveLinks(await getLinks(ctx), await liveAccountIds(ctx, { strict: true }));
  return new Map(account_ids.map((id) => [id, [...new Set([id, ...sameAccountIds(id, links)])]]));
}

/**
 * Each account's imports, across its ids, by `keys` (importKeys, read once
 * for the request). Strict: an entry that can't be read throws, as do links
 * that can't be; an entry of another account never holds one back.
 */
export async function readAccountImports(ctx: Ctx, account_ids: readonly string[], keys: readonly string[]): Promise<Map<string, AccountImport[]>> {
  const out = new Map<string, AccountImport[]>(account_ids.map((id) => [id, []]));
  if (keys.length === 0 || account_ids.length === 0) return out;
  const ids = await idsOf(ctx, account_ids, keys);
  const wanted = new Set([...ids.values()].flat());
  const mine = keys.filter((k) => wanted.has(keyParts(k)?.account_id ?? ''));
  if (mine.length === 0) return out;
  const entries = await investmentImportsStore.getMany(ctx, mine);
  for (const [account_id, theirs] of ids) {
    const held = new Set(theirs);
    const list: AccountImport[] = [];
    for (const [key, value] of entries) {
      const parts = keyParts(key);
      if (parts && held.has(parts.account_id)) list.push({ ...value, ...parts });
    }
    out.set(account_id, list);
  }
  return out;
}

/** One import, listed for its account's sheet: what it is and every account
 *  it took (by the ids they were imported on), without its rows. */
export type ListedImport = Omit<InvestmentImport, 'rows'> & { import_id: string; rows: number; accounts: string[] };

/** The account's imports, newest first, and the fingerprint they were read
 *  under (an import names it, so a review made before another device's
 *  change is asked again). */
export async function listImports(ctx: Ctx, account_id: string): Promise<{ imports: ListedImport[]; fingerprint: string }> {
  const keys = await importKeys(ctx);
  const mine = (await readAccountImports(ctx, [account_id], keys)).get(account_id) ?? [];
  const imports = mine
    .map(({ rows, account_id: _, ...i }) => ({
      ...i,
      rows: rows.length,
      accounts: keys.flatMap((k) => {
        const parts = keyParts(k);
        return parts && parts.import_id === i.import_id ? [parts.account_id] : [];
      }),
    }))
    .sort((a, b) => (a.imported_at !== b.imported_at ? (a.imported_at > b.imported_at ? -1 : 1) : a.import_id > b.import_id ? -1 : 1));
  return { imports, fingerprint: importsFingerprint(keys) };
}

/** Why an import or an undo was refused: the imports changed since the file
 *  was reviewed (another device), an account has as many imports as it
 *  keeps, or the import isn't there. */
export class ImportsRefused extends Error {
  constructor(
    readonly why: 'changed' | 'full' | 'missing',
    readonly account_id: string | null = null
  ) {
    super(why);
  }
}

/**
 * Adds one import: an entry for each account, under its current id, all in
 * one step. `counting` is the fingerprint the file was reviewed against:
 * refused when the imports have changed since, or when an account already
 * keeps as many as it may (across its linked ids).
 */
export async function addImport(ctx: Ctx, import_id: string, entries: readonly { account_id: string; value: InvestmentImport }[], counting: string): Promise<void> {
  if (entries.length === 0 || entries.length > MAX_ACCOUNTS_PER_IMPORT) throw new TypeError(`An import takes 1 to ${MAX_ACCOUNTS_PER_IMPORT} accounts.`);
  const links = effectiveLinks(await getLinks(ctx), await liveAccountIds(ctx, { strict: true }));
  const sets = entries.map((e) => new Set([e.account_id, ...sameAccountIds(e.account_id, links)]));
  const keys = entries.map((e) => importKey(e.account_id, import_id));
  await investmentImportsStore.updateMany(ctx, keys, async () => {
    // Not atomic with the write: the compare-and-set watches only the new
    // keys, which are always absent, so it never retries. Two imports sent at
    // once against the same review both stand (the rule decides between
    // them, and the cap can be passed by one); with one person using Nya,
    // that is accepted rather than locked against.
    const now = await importKeys(ctx);
    if (importsFingerprint(now) !== counting) throw new ImportsRefused('changed');
    entries.forEach((e, n) => {
      if (now.filter((k) => sets[n].has(keyParts(k)?.account_id ?? '')).length >= MAX_IMPORTS_PER_ACCOUNT) throw new ImportsRefused('full', e.account_id);
    });
    return new Map(entries.map((e, n) => [keys[n], e.value]));
  });
}

/** Takes one import out, from every account it took, in one step. */
export async function undoImport(ctx: Ctx, import_id: string): Promise<void> {
  const keys = (await importKeys(ctx)).filter((k) => keyParts(k)?.import_id === import_id);
  if (keys.length === 0) throw new ImportsRefused('missing');
  await investmentImportsStore.remove(ctx, ...keys);
}

/** Forgetting an earlier account (lib/links.ts forgetEarlierAccount) takes
 *  its imports too; another account an import also took keeps its own. */
export async function forgetInvestmentImports(ctx: Ctx, id: string): Promise<void> {
  const keys = (await importKeys(ctx)).filter((k) => keyParts(k)?.account_id === id);
  if (keys.length > 0) await investmentImportsStore.remove(ctx, ...keys);
}
