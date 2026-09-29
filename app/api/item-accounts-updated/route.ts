import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { getItems } from '@/lib/storage';
import { fetchInstitution } from '@/lib/networth';
import { rememberAccounts, rememberedIdsForItem } from '@/lib/last-known';
import { recordDirectory } from '@/lib/links';
import { vanishedSince, forgetVanishedIds } from '@/lib/vanished';
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
// Only absences that began with the picker count. `opened_at` (from
// /api/create-update-link-token, by the server's clock) marks that: an account
// already missing before the picker opened is a closure or a glitch, and keeps
// its grace window, or the next snapshot would permanently record a total
// without it.
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
      return NextResponse.json({ error: 'Expected { item_id, opened_at }' }, { status: 400 });
    }
    const opened_at = typeof body?.opened_at === 'string' ? body.opened_at : '';

    const item = (await getItems(ctx)).find((i) => i.item_id === item_id);
    if (!item) return NextResponse.json({ error: 'Unknown item' }, { status: 404 });

    // Without a measurement nothing can be reconciled, and saying so matters: a
    // removal left unreconciled pauses snapshots at the next healthy load. The
    // new-accounts prompt stays, and running the picker again finishes the job.
    const inst = await fetchInstitution(item);
    if (inst.error || inst.accounts.length === 0) {
      return NextResponse.json({ error: 'Could not read the institution' }, { status: 502 });
    }

    // Both sources: a load that ran between the picker closing and this call has
    // already moved a removed id out of the remembered list and into the
    // vanished record.
    const [remembered, vanishing] = await Promise.all([
      rememberedIdsForItem(ctx, item_id),
      vanishedSince(ctx, item_id, opened_at),
    ]);
    const known = new Set([...remembered, ...vanishing]);
    const fresh = new Set(inst.accounts.map((a) => a.account_id as string));
    const removed = [...known].filter((id) => !fresh.has(id));
    const added = [...fresh].filter((id) => !known.has(id)).length;

    await rememberAccounts(ctx, [inst]);
    await recordDirectory(ctx, [inst]);
    await forgetVanishedIds(ctx, item_id, removed);
    // The prompt led here, and the picker has now been through.
    await clearNewAccounts(ctx, item_id);

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
