import { NextResponse } from 'next/server';
import { Products, CountryCode, type LinkTokenCreateRequest } from 'plaid';
import { plaidClient } from '@/lib/plaid';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { webhookUrlFor } from '@/lib/webhook-url';
import { isLinkKind, TRANSACTIONS_DAYS_REQUESTED, type LinkKind } from '@/lib/item-products';
import { loggable } from '@/lib/log-safe';

// The link token for a new connection, of one of two kinds:
//
//   bank         Transactions required; Investments and Liabilities optional.
//                Checking, savings, cards and loans, and any investment
//                accounts at the same login. The token every Item had before
//                there were two.
//   investments  Investments required; Transactions required only if
//                supported; Liabilities optional. Brokerages and retirement
//                plans, including those the bank kind can't show.
//
// WHY TWO. Plaid's Link lets someone pick only an institution that supports
// every product in `products`, shows only the account types compatible with
// them, and `products` must name at least one. With Transactions there, a
// retirement plan provider that has Investments but not Transactions can't be
// picked at all. Listing Investments under required_if_supported_products
// doesn't change that, since Transactions is still in `products`; and with
// Investments in `products` instead, every plain bank drops out. Each
// institution list needs its own token, so the app offers two buttons.
//
// WHY "REQUIRED IF SUPPORTED" for Transactions on the second: Plaid's reference
// says such a product "will only be extracted and billed if the user selects an
// institution and account type that supports" it, and Transactions covers
// depository, credit and student loan accounts, never investment ones (the
// reference for /transactions/sync sends those to Investments). So a 401(k) or
// an IRA is never billed for Transactions, while a brokerage login whose
// checking account is shared gets its transactions as through the bank kind.
// For optional products the reference promises only a best effort, with no
// word on billing. Either way the sync never calls Transactions on an Item
// that doesn't have it unless the Item holds an account it describes
// (lib/item-products.ts), since that call would add the product.
//
// Liabilities is optional on both, as it always was: Nya asks for it only for
// Items with a card or loan (lib/networth.ts).
const PRODUCTS: Record<LinkKind, Pick<LinkTokenCreateRequest, 'products' | 'required_if_supported_products' | 'optional_products'>> = {
  bank: {
    products: [Products.Transactions],
    // Optional, not required: an institution that can't serve investments or
    // liabilities would fail Link outright if these were in `products`. As
    // optional they initialize where supported and are silently dropped
    // elsewhere.
    optional_products: [Products.Investments, Products.Liabilities],
  },
  investments: {
    products: [Products.Investments],
    required_if_supported_products: [Products.Transactions],
    optional_products: [Products.Liabilities],
  },
};

/** Bigger than any body this route takes. */
const MAX_BODY_CHARS = 200;

/** Which kind is asked for: no body (what every client sent before there were
 *  two) means the bank kind. Null for anything else this route doesn't take. */
async function kindOf(req: Request): Promise<LinkKind | null> {
  const text = await req.text();
  if (text.trim() === '') return 'bank';
  if (text.length > MAX_BODY_CHARS) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { kind, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (kind === undefined) return 'bank';
  return isLinkKind(kind) ? kind : null;
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const kind = await kindOf(req);
    if (!kind) {
      return NextResponse.json({ error: "Expected { kind: 'bank' } or { kind: 'investments' }" }, { status: 400 });
    }
    const response = await plaidClient.linkTokenCreate({
      // One id per person, as Plaid expects: their container's, which says
      // nothing about who they are.
      user: { client_user_id: ctx.container },
      client_name: 'Nya',
      ...PRODUCTS[kind],
      // Ask for up to 2 years of transaction history (default is 90 days) so
      // the estimated net-worth backfill can reach back further. Applies to
      // either kind wherever Transactions is initialized at Link.
      transactions: { days_requested: TRANSACTIONS_DAYS_REQUESTED },
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
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to create link token' }, { status: 500 });
  }
}
