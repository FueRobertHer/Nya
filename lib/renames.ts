// lib/renames.ts
//
// Vendor display-name overrides. Plaid's merchant names are often cryptic
// ("SQ *COFFEE 1234") or inconsistent; a rename lets the user relabel a
// merchant once and have it apply to every transaction from that vendor.
//
// Keyed by a stable vendor key (see vendorKey in lib/transactions.ts), NOT by
// transaction_id — that's what makes one rename cover all of a vendor's rows,
// past and future. A Redis hash of vendor_key -> display name, applied on top
// of the fetched data in /api/transactions. Values are encrypted like every
// other financial payload.

import { redis, kc } from './storage';
import type { Ctx } from './containers';
import { encrypt, decrypt } from './crypto';

const RENAMES_HASH = (ctx: Ctx) => kc(ctx, 'txn-vendor-renames');

export async function getRenames(ctx: Ctx): Promise<Record<string, string>> {
  return (await readRenamesReport(ctx)).renames;
}

/**
 * The renames getRenames gives, and whether they were all read (`ok`): false
 * when the hash couldn't be read or a rename couldn't be decrypted, both of
 * which getRenames passes over. For a report, which says when the person's
 * own names are missing from it (lib/report/read.ts); the app goes on as it
 * always has.
 */
export async function readRenamesReport(ctx: Ctx): Promise<{ renames: Record<string, string>; ok: boolean }> {
  try {
    const map = await redis().hgetall<Record<string, string>>(RENAMES_HASH(ctx));
    if (!map) return { renames: {}, ok: true };
    const out: Record<string, string> = {};
    let ok = true;
    await Promise.all(
      Object.entries(map).map(async ([key, blob]) => {
        try {
          out[key] = await decrypt(blob);
        } catch {
          // undecryptable rename (rotated key) -- drop it
          ok = false;
        }
      })
    );
    return { renames: out, ok };
  } catch {
    return { renames: {}, ok: false };
  }
}

/**
 * Every rename, vendor_key -> name, for the download of my data
 * (lib/user-export.ts). Strict where getRenames is lenient: a failed read, or
 * any value that can't be decrypted, throws instead of being dropped.
 */
export async function readRenamesStrict(ctx: Ctx): Promise<Map<string, string>> {
  const map = (await redis().hgetall<Record<string, string>>(RENAMES_HASH(ctx))) ?? {};
  const out = new Map<string, string>();
  for (const [key, name] of await Promise.all(
    Object.entries(map).map(async ([key, blob]) => [key, await decrypt(String(blob))] as const)
  )) {
    out.set(key, name);
  }
  return out;
}

export async function setRename(ctx: Ctx, vendor_key: string, name: string): Promise<void> {
  await redis().hset(RENAMES_HASH(ctx), { [vendor_key]: await encrypt(name) });
}

/** Remove a rename, reverting the vendor to its Plaid-provided name. */
export async function clearRename(ctx: Ctx, vendor_key: string): Promise<void> {
  await redis().hdel(RENAMES_HASH(ctx), vendor_key);
}
