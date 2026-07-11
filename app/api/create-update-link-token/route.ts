import { NextResponse } from 'next/server';
import { CountryCode } from 'plaid';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems } from '@/lib/storage';

export async function POST(req: Request) {
  try {
    const { item_id } = await req.json();
    const items = await getItems();
    const item = items.find((i) => i.item_id === item_id);
    if (!item) {
      return NextResponse.json({ error: 'Unknown item' }, { status: 404 });
    }

    const access_token = await decrypt(item.encrypted_access_token);

    // Update mode: passing access_token (instead of products) re-opens Link
    // against the *existing* Item, so the user re-authenticates without a
    // new Item or a new exchange-public-token step being created.
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'local-user' },
      client_name: 'Nya',
      access_token,
      country_codes: [CountryCode.Us],
      language: 'en',
    });

    return NextResponse.json(response.data);
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to create update link token' }, { status: 500 });
  }
}
