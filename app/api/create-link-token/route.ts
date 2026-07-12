import { NextResponse } from 'next/server';
import { Products, CountryCode } from 'plaid';
import { plaidClient } from '@/lib/plaid';

export async function POST() {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'local-user' },
      client_name: 'Nya',
      products: [Products.Transactions],
      optional_products: [Products.Investments],
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
