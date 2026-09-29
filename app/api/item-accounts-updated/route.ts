import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { getItems } from '@/lib/storage';
import { fetchInstitution } from '@/lib/networth';
import { rememberAccounts, rememberedIdsForItem } from '@/lib/last-known';
import { recordDirectory } from '@/lib/links';
import { vanishedIdsForItem, forgetVanishedIds } from '@/lib/vanished';
import { clearNewAccounts } from '@/lib/new-accounts';
import { clearCaches } from '@/lib/cache';
import { clearBackfillDone } from '@/lib/history';

// Called by the client after Link's account picker (update mode with account
// selection) succeeds on an existing Item. The access token is unchanged, so
// there is nothing to exchange; what changed is WHICH accounts the Item shares,
// and the stores that remember an Item's accounts have to hear it from here.
//
// An account the user de-selected is absent from the next fetch, which
// lib/vanished.ts would otherwise hold as "maybe closed" for three days, pausing
// every snapshot. Here the absence is the user's own choice, so the Item's
// remembered accounts are rewritten from a fresh fetch and the removed ids are
// dropped from the vanished record: they are never candidates at all.
//
// Balance history for a removed account is kept, as on disconnect. Its stored
// transactions are kept too (lib/invstore.ts never deletes rows, and a
// transaction sync holds no lock a delete could take).
//
// Known race: a net-worth load already in flight, holding vanished inputs read
// before this runs, can still record a removed id as missing. It then clears
// through the normal three-day window.

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await req.json().catch(() => null);
    const item_id = body?.item_id;
    if (typeof item_id !== 'string') {
      return NextResponse.json({ error: 'Expected { item_id }' }, { status: 400 });
    }

    const item = (await getItems(ctx)).find((i) => i.item_id === item_id);
    if (!item) return NextResponse.json({ error: 'Unknown item' }, { status: 404 });

    // The prompt led here, and the user has now been through the picker.
    await clearNewAccounts(ctx, item_id);

    const inst = await fetchInstitution(item);
    let added = 0;
    let removed: string[] = [];
    if (!inst.error && inst.accounts.length > 0) {
      // Both sources: a load that ran between Link closing and this call has
      // already moved a removed id out of the remembered list and into the
      // vanished record.
      const [remembered, vanishing] = await Promise.all([
        rememberedIdsForItem(ctx, item_id),
        vanishedIdsForItem(ctx, item_id),
      ]);
      const known = new Set([...remembered, ...vanishing]);
      const fresh = new Set(inst.accounts.map((a) => a.account_id as string));
      removed = [...known].filter((id) => !fresh.has(id));
      added = [...fresh].filter((id) => !known.has(id)).length;

      await rememberAccounts(ctx, [inst]);
      await recordDirectory(ctx, [inst]);
      await forgetVanishedIds(ctx, item_id, removed);
    }

    await clearCaches(ctx);
    // Only for an addition. The estimated layer is rebuilt from the accounts
    // linked now, so rebuilding after a removal alone would erase the removed
    // account from past estimated totals.
    if (added > 0) await clearBackfillDone(ctx);

    // Counts, not ids.
    return NextResponse.json({ added, removed: removed.length });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to update accounts' }, { status: 500 });
  }
}
