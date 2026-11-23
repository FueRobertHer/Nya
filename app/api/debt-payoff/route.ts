import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { debtPayoffStore, parseStoredPayoffInputs } from '@/lib/debt-payoff-store';
import { loggable } from '@/lib/log-safe';

// The person's debt payoff plan inputs (lib/debt-payoff-store.ts): typed
// rates and monthly payments, extra monthly payment, strategy order, and
// left-out / accrued / shared-minimum choices. GET answers { plan: null }
// when nothing was ever saved; PUT replaces it whole after strict validation.

function failure(err: unknown, doing: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored debt payoff plan unreadable:', describeUnreadable(err));
    return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
  }
  if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(`Debt payoff plan ${doing} failed`, loggable(err));
  return NextResponse.json({ error: `Failed to ${doing} debt payoff plan` }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    return NextResponse.json({ plan: await debtPayoffStore.get(ctx) });
  } catch (err) {
    return failure(err, 'load');
  }
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid debt payoff plan' }, { status: 400 });
  }
  const parsed = parseStoredPayoffInputs(typeof body === 'object' && body !== null ? (body as { plan?: unknown }).plan : undefined);
  if ('error' in parsed) return NextResponse.json({ error: `Invalid debt payoff plan: ${parsed.error}` }, { status: 400 });
  try {
    const ctx = await dataCtx();
    await debtPayoffStore.set(ctx, parsed.plan);
    return NextResponse.json({ plan: parsed.plan });
  } catch (err) {
    return failure(err, 'save');
  }
}
