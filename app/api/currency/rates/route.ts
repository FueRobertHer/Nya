import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { currencySettingsStore, PRICED_CODE, rateTextError, withOwnRate, withoutOwnRate, SettingsRefused } from '@/lib/fx/settings';
import { readLatestRates } from '@/lib/fx/read';
import { addDays, isCalendarDay } from '@/lib/manual-txn-input';
import type { OwnRate } from '@/lib/fx/rates';

// The person's own exchange rates (lib/fx/settings.ts, lib/fx/rates.ts
// OwnRate): "1 BTC = 61000 USD", from a day or for every day.
//
// PUT { currency, rate, quote, from } sets one, replacing any for its
// currency. Every field is checked: the currency an ISO code or Plaid's
// unofficial one, the rate a positive decimal as typed (a decimal comma is
// refused with how to write it), the quote the euro or a currency in the
// ECB's newest publication (its rate is what the own rate goes through), and
// `from` a day no later than tomorrow, or null for every day. Nothing else.
// DELETE ?currency=BTC removes one. Both through a compare-and-set, never
// over settings that can't be read (409).

const FIELDS = ['currency', 'rate', 'quote', 'from'] as const;

function bad(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad('Send { "currency", "rate", "quote", "from" }.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Send { "currency", "rate", "quote", "from" }.');
  const given = body as Record<string, unknown>;
  const unknown = Object.keys(given).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) return bad(`Unknown field: ${unknown[0].slice(0, 40)}.`);
  const { currency, rate, quote, from } = given;
  if (typeof currency !== 'string' || !PRICED_CODE.test(currency)) return bad('The currency is a code like USD, or BTC.');
  if (typeof rate !== 'string') return bad('The rate is a number as text, like "0.92".');
  const rateError = rateTextError(rate);
  if (rateError) return bad(rateError);
  if (typeof quote !== 'string') return bad('Say which currency the rate is in, like EUR.');
  if (quote === currency) return bad('A rate is in another currency than the one it prices.');
  if (from !== null && from !== undefined && !isCalendarDay(from)) return bad('From is a date, YYYY-MM-DD, or null for every day.');
  const today = new Date().toISOString().slice(0, 10);
  if (typeof from === 'string' && from > addDays(today, 1)) return bad('From is no later than tomorrow.');
  try {
    // The quote must be one the ECB publishes now, or the euro: the own rate
    // goes through its rate.
    if (quote !== 'EUR') {
      const { latest } = await readLatestRates();
      if (!latest) return bad('Nya has no ECB rates yet, so for now a rate of your own is in euros.');
      if (!(quote in latest.rates)) return bad(`The ECB doesn’t publish a rate for ${quote.slice(0, 10)}. Use the euro or one it publishes.`);
    }
    const ctx = await dataCtx();
    const own: OwnRate = { currency, rate, quote, from: typeof from === 'string' ? from : null, set_at: new Date().toISOString() };
    const saved = await currencySettingsStore.update(ctx, (current) => withOwnRate(current, own));
    return NextResponse.json({ own: saved?.own ?? [] });
  } catch (err) {
    if (err instanceof SettingsRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    return storeFailure(err, 'Failed to save your rate');
  }
}

export async function DELETE(req: Request) {
  const currency = new URL(req.url).searchParams.get('currency');
  if (currency === null || !PRICED_CODE.test(currency)) return bad('Say which rate to remove: ?currency=BTC.');
  try {
    const ctx = await dataCtx();
    const saved = await currencySettingsStore.update(ctx, (current) => withoutOwnRate(current, currency));
    return NextResponse.json({ own: saved?.own ?? [] });
  } catch (err) {
    return storeFailure(err, 'Failed to remove your rate');
  }
}
