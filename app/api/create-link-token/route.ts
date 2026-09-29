import { NextResponse } from 'next/server';
import { Products, CountryCode } from 'plaid';
import { plaidClient } from '@/lib/plaid';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { webhookUrlFor } from '@/lib/webhook-url';

export async function POST() {
  try {
    const ctx = await dataCtx();
    const response = await plaidClient.linkTokenCreate({
      // One id per person, as Plaid expects: their container's, which says
      // nothing about who they are.
      user: { client_user_id: ctx.container },
      client_name: 'Nya',
      products: [Products.Transactions],
      // Optional, not required: an institution that can't serve investments or
      // liabilities would fail Link outright if these were in `products`. As
      // optional they initialize where supported and are silently dropped
      // elsewhere, which is what lets one link flow cover banks, brokerages and
      // card issuers alike.
      optional_products: [Products.Investments, Products.Liabilities],
      // Ask for up to 2 years of transaction history (default is 90 days) so
      // the estimated net-worth backfill can reach back further.
      transactions: { days_requested: 730 },
      country_codes: [CountryCode.Us],
      language: 'en',
      // Plaid tells us when new data is ready (app/api/plaid/webhook), so the
      // app can serve from its own storage in between. Omitted when unset.
      ...(webhookUrlFor(ctx) ? { webhook: webhookUrlFor(ctx) } : {}),
    });
    return NextResponse.json(response.data);
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to create link token' }, { status: 500 });
  }
}
