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

import { redis, k } from './storage';
import { encrypt, decrypt } from './crypto';

const RENAMES_HASH = k('txn-vendor-renames');

export async function getRenames(): Promise<Record<string, string>> {
  try {
    const map = await redis().hgetall<Record<string, string>>(RENAMES_HASH);
    if (!map) return {};
    const out: Record<string, string> = {};
    await Promise.all(
      Object.entries(map).map(async ([key, blob]) => {
        try {
          out[key] = await decrypt(blob);
        } catch {
          // undecryptable rename (rotated key) -- drop it
        }
      })
    );
    return out;
  } catch {
    return {};
  }
}

export async function setRename(vendor_key: string, name: string): Promise<void> {
  await redis().hset(RENAMES_HASH, { [vendor_key]: await encrypt(name) });
}

/** Remove a rename, reverting the vendor to its Plaid-provided name. */
export async function clearRename(vendor_key: string): Promise<void> {
  await redis().hdel(RENAMES_HASH, vendor_key);
}
