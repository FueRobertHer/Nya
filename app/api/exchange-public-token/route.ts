import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { plaidClient } from '@/lib/plaid';
import { encrypt } from '@/lib/crypto';
import { saveItem } from '@/lib/storage';
import { clearCaches } from '@/lib/cache';
import { clearBackfillDone } from '@/lib/history';
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
    let institution_id: string | null = null;
    try {
      const item = await plaidClient.itemGet({ access_token: exchange.data.access_token });
      institution_id = item.data.item.institution_id ?? null;
    } catch (err: any) {
      console.error('exchange: could not read the institution id', err?.response?.data?.error_code ?? err?.name);
    }

    await saveItem(ctx, {
      item_id: exchange.data.item_id,
      institution_name: institution_name || 'Connected Account',
      encrypted_access_token,
      institution_id,
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
