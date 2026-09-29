import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { CountryCode, Products } from 'plaid';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems } from '@/lib/storage';
import { webhookUrlFor } from '@/lib/webhook-url';

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const { item_id, add_liabilities, select_accounts } = await req.json();
    // Two different flows, each with its own Link screen: asking for both at
    // once would leave it to Plaid which one the user sees.
    if (add_liabilities && select_accounts) {
      return NextResponse.json({ error: 'Choose one change at a time' }, { status: 400 });
    }
    const items = await getItems(ctx);
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
    //
    // `select_accounts` shows Link's account picker for the existing Item, so
    // adding (or removing) an account at an institution already connected
    // reuses this Item instead of creating a second one, which Plaid would bill
    // separately and which would mean signing in again.
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: ctx.container }, // as in create-link-token
      client_name: 'Nya',
      access_token,
      ...(add_liabilities ? { products: [Products.Liabilities] } : {}),
      ...(select_accounts ? { update: { account_selection_enabled: true } } : {}),
      country_codes: [CountryCode.Us],
      language: 'en',
      // Re-registers the Item's webhook, so an Item linked before webhooks were
      // configured picks it up when it is reconnected.
      ...(webhookUrlFor(ctx) ? { webhook: webhookUrlFor(ctx) } : {}),
    });

    return NextResponse.json(response.data);
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
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
