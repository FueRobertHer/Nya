import { NextResponse } from 'next/server';
import { Products, CountryCode } from 'plaid';
import { plaidClient } from '@/lib/plaid';

export async function POST() {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'local-user' },
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
    });
    return NextResponse.json(response.data);
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to create link token' }, { status: 500 });
  }
}
