import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { plaidClient } from '@/lib/plaid';
import { encrypt } from '@/lib/crypto';
import { saveItem } from '@/lib/storage';
import { clearCaches } from '@/lib/cache';
import { clearBackfillDone } from '@/lib/history';
import { transactionsBilledOf } from '@/lib/item-products';
import { loggable } from '@/lib/log-safe';

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const { public_token, institution_name } = await req.json();
    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });

    const encrypted_access_token = await encrypt(exchange.data.access_token);

    // Asked of Plaid rather than taken from the client, which could send any id.
    // Best effort: without it the Item still links, and the duplicate check falls
    // back to the institution's name.
    //
    // The same answer says whether Plaid already bills Transactions on the
    // Item. One from the brokerage option often has no Transactions, and a sync
    // call would add it and start billing it, so the sync reads this before
    // calling (lib/item-products.ts). Unknown when the lookup fails, which the
    // sync treats with the same care as "not billed".
    let institution_id: string | null = null;
    let transactions_billed: boolean | null = null;
    try {
      const item = await plaidClient.itemGet({ access_token: exchange.data.access_token });
      institution_id = item.data.item.institution_id ?? null;
      transactions_billed = transactionsBilledOf(item.data.item);
    } catch (err: any) {
      console.error('exchange: could not read the institution id or what Plaid bills', err?.response?.data?.error_code ?? err?.name);
    }

    await saveItem(ctx, {
      item_id: exchange.data.item_id,
      institution_name: institution_name || 'Connected Account',
      encrypted_access_token,
      institution_id,
      transactions_billed,
    });

    // Cached payloads no longer reflect the linked institutions, and the
    // estimated history should be recomputed with the new accounts in it.
    await clearCaches(ctx);
    await clearBackfillDone(ctx);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to exchange public token' }, { status: 500 });
  }
}
