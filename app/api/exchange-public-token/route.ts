import { NextResponse } from 'next/server';
import { plaidClient } from '@/lib/plaid';
import { encrypt } from '@/lib/crypto';
import { saveItem } from '@/lib/storage';

export async function POST(req: Request) {
  try {
    const { public_token, institution_name } = await req.json();
    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });

    const encrypted_access_token = await encrypt(exchange.data.access_token);

    await saveItem({
      item_id: exchange.data.item_id,
      institution_name: institution_name || 'Connected Account',
      encrypted_access_token,
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to exchange public token' }, { status: 500 });
  }
}
