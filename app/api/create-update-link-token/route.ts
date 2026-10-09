import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { CountryCode, Products } from 'plaid';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems } from '@/lib/storage';
import { webhookUrlFor } from '@/lib/webhook-url';
import { loggable } from '@/lib/log-safe';

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const { item_id, add_liabilities, select_accounts, allow_transactions } = await req.json();
    // Different flows, each with its own Link screen: asking for two at once
    // would leave it to Plaid which one the user sees.
    if ([add_liabilities, select_accounts, allow_transactions].filter(Boolean).length > 1) {
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
    //
    // `allow_transactions` is the "Allow transactions" action on a connection
    // whose first transactions call Plaid refused for want of consent
    // (lib/no-transactions.ts, no_consent): update mode that asks for consent
    // to Transactions, by listing it in additional_consented_products. That
    // Plaid collects consent this way in update mode is to be confirmed in
    // Sandbox (docs/deployment.md); should it refuse the token for the field,
    // one plain update-mode token is made instead, so the button still opens
    // Link. Consent alone bills nothing (lib/item-products.ts): the sync's own
    // check still decides any first call. Kept apart from Reconnect, which
    // only repairs a sign-in, so a login repair never carries the field.
    const request = {
      user: { client_user_id: ctx.container }, // as in create-link-token
      client_name: 'Nya',
      access_token,
      ...(add_liabilities ? { products: [Products.Liabilities] } : {}),
      ...(select_accounts ? { update: { account_selection_enabled: true } } : {}),
      country_codes: [CountryCode.Us],
      language: 'en' as const,
      // Re-registers the Item's webhook, so an Item linked before webhooks were
      // configured picks it up when it is reconnected.
      ...(webhookUrlFor(ctx) ? { webhook: webhookUrlFor(ctx) } : {}),
    };
    let response;
    if (allow_transactions) {
      try {
        response = await plaidClient.linkTokenCreate({ ...request, additional_consented_products: [Products.Transactions] });
      } catch (err) {
        console.error(loggable(err));
        response = await plaidClient.linkTokenCreate(request);
      }
    } else {
      response = await plaidClient.linkTokenCreate(request);
    }

    // When the picker opened, by the server's clock, handed back to
    // /api/item-accounts-updated: only an account first seen missing after this
    // was removed in the picker. One missing from before went on its own.
    return NextResponse.json(select_accounts ? { ...response.data, opened_at: new Date().toISOString() } : response.data);
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
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
