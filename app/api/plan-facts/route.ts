import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { sameSite } from '@/lib/same-site';
import { Refused, optIn, saveTaxFacts } from '@/lib/plan-writes';
import { parseTaxFactOp } from '@/lib/fire/tax-facts';

// The tax facts every plan shares (lib/fire/tax-facts.ts): POST one change, an
// account's owner, typed basis and Count it, or what one person has put into a
// Roth. Answers your plan as GET /api/fire-plan does, the facts in it, for the
// copy of the Plan's inputs Home and the Plan share. With no plan saved it
// writes the facts alone, and the plan stays new. The opt-in
// makes your plan's entry and writes every plan's choices first; back to the flat
// model is one change like the others.

/** Far more than one change takes. */
const MAX_BODY_CHARS = 2 * 1024;

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function POST(req: Request) {
  if (!sameSite(req)) return NextResponse.json({ error: 'That came from somewhere else, so nothing changed.' }, { status: 403 });
  const text = await req.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_CHARS) return bad('Send the change, as JSON');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad('Send the change, as JSON');
  }
  const parsed = parseTaxFactOp(body);
  if ('error' in parsed) return bad(parsed.error);
  try {
    const ctx = await dataCtx();
    return NextResponse.json(parsed.op.kind === 'opt-in' ? await optIn(ctx) : await saveTaxFacts(ctx, parsed.op));
  } catch (err) {
    if (err instanceof Refused) return NextResponse.json({ error: err.words, ...(err.stale ? { stale: true } : {}) }, { status: err.status });
    return storeFailure(err, 'Failed to save that');
  }
}
