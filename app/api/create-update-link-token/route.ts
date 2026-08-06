import { NextResponse } from 'next/server';
import { CountryCode, Products } from 'plaid';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems } from '@/lib/storage';

export async function POST(req: Request) {
  try {
    const { item_id, add_liabilities } = await req.json();
    const items = await getItems();
    const item = items.find((i) => i.item_id === item_id);
    if (!item) {
      return NextResponse.json({ error: 'Unknown item' }, { status: 404 });
    }

    const access_token = await decrypt(item.encrypted_access_token);

    // Update mode: passing access_token (instead of products) re-opens Link
    // against the *existing* Item, so the user re-authenticates without a
    // new Item or a new exchange-public-token step being created.
    //
    // `add_liabilities` is the one case where products IS sent alongside
    // access_token: that's Plaid's documented way to add a product to an
    // existing Item. /liabilities/get has no async_update escape hatch (unlike
    // /investments/transactions/get), so an Item never initialized with the
    // product genuinely cannot serve it until the user re-consents here.
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'local-user' },
      client_name: 'Nya',
      access_token,
      ...(add_liabilities ? { products: [Products.Liabilities] } : {}),
      country_codes: [CountryCode.Us],
      language: 'en',
    });

    return NextResponse.json(response.data);
  } catch (err: any) {
    console.error(err?.response?.data || err);
    // In update mode the institution is already fixed, so asking for a product
    // it doesn't support fails here -- after the user has already tapped the
    // button. Say which thing went wrong rather than "couldn't reconnect".
    const code = err?.response?.data?.error_code;
    if (code === 'PRODUCTS_NOT_SUPPORTED' || code === 'INVALID_PRODUCT') {
      return NextResponse.json(
        { error: "This institution doesn't support payment details" },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'Failed to create update link token' }, { status: 500 });
  }
}
