import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { mainAnswer, readPlanAnswer } from '@/lib/plan-copies';
import { CHANGED, Refused, factsWere, isBasedOn, recordMain, saveMain } from '@/lib/plan-writes';
import { parsePlanV2 } from '@/lib/fire/plan-v2';
import { CURRENCY_CODE, isTypedAmounts } from '@/lib/fire/plan-currency';

// Your plan (lib/plan-copies.ts): GET answers { id, plan, currency,
// updated_at }, your plan's entry with the facts every plan shares in its
// fields, the currency its typed amounts are in (null while it holds none, so
// the Plan follows the accounts), its id and its stamp. While no plan is
// saved it answers { id: "main", plan: null, currency: null, updated_at:
// null }, which the Plan shows as the defaults. What GET answers, the Plan's
// inputs (app/api/plan-inputs) answer too.
//
// PUT saves your plan whole (lib/plan-writes.ts saveMain): `plan` (version 2,
// every field checked by parsePlanV2), `currency` (the one its typed amounts
// are in, when it holds any), `facts_were` (the facts the page loaded: written
// only when the plan's differ from them, so an old page never writes an old
// age back) and `based_on` (the stamp the page loaded, null before your plan
// is saved). A body without `based_on` or `facts_were` is a page from before
// plans were copies, still open: refused, so it loads again. The other plans
// are saved through /api/plans.
//
// POST records your plan's currency alone: when the person says which it is
// (`answered`), or, with none there, when the tab can tell it.

/** The answer for an error, as every route on the storage seam gives it. */
function failure(err: unknown, doing: string): NextResponse {
  if (err instanceof Refused) return NextResponse.json({ error: err.words, ...(err.stale ? { stale: true } : {}) }, { status: err.status });
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored plan assumptions unreadable:', describeUnreadable(err));
    // 409, not 500, and flagged: the client must not show the defaults and let
    // the next save replace what is there.
    return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
  }
  // Nothing was written (a plan too large to store, say): the seam's message.
  if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(err);
  return NextResponse.json({ error: `Failed to ${doing} plan assumptions` }, { status: 500 });
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function GET() {
  try {
    return NextResponse.json(await readPlanAnswer(await dataCtx()));
  } catch (err) {
    return failure(err, 'load');
  }
}

export async function PUT(req: Request) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return bad('Invalid plan');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('Invalid plan');
    const b = body as Record<string, unknown>;
    const extra = Object.keys(b).find((k) => !['plan', 'currency', 'facts_were', 'based_on'].includes(k));
    if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
    // A page from before copies sends neither: it loads again.
    if (!Object.hasOwn(b, 'based_on') || !Object.hasOwn(b, 'facts_were')) return NextResponse.json({ error: CHANGED, stale: true }, { status: 409 });
    const currency = b.currency ?? null;
    if (currency !== null && (typeof currency !== 'string' || !CURRENCY_CODE.test(currency))) return bad('Invalid plan: currency must be a three-letter code, like USD');
    const loaded = factsWere(b.facts_were);
    if (loaded === null) return bad('facts_were must be the facts the page loaded the plan with');
    if (!isBasedOn(b.based_on)) return bad('based_on is the version (updated_at) the plan was loaded at');
    const parsed = parsePlanV2(b.plan);
    if ('error' in parsed) return bad(`Invalid plan: ${parsed.error}`);
    const main = await saveMain(await dataCtx(), parsed.plan, currency, loaded, b.based_on);
    return NextResponse.json(mainAnswer(main));
  } catch (err) {
    return failure(err, 'save');
  }
}

/** Records the currency of your plan as stored: { currency, amounts }, the
 *  typed amounts of the plan the page shows, so a plan changed since on
 *  another device is never given it. `answered` when it is the person's own
 *  answer: only that replaces a currency there. */
export async function POST(req: Request) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return bad('Send the currency and the amounts it is for, as JSON');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('Send the currency and the amounts it is for, as JSON');
    const b = body as Record<string, unknown>;
    const extra = Object.keys(b).find((k) => !['currency', 'amounts', 'answered'].includes(k));
    if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
    if (typeof b.currency !== 'string' || !CURRENCY_CODE.test(b.currency)) return bad('currency must be a three-letter code, like USD');
    if (!isTypedAmounts(b.amounts)) return bad('amounts must be the plan’s typed amounts, as the page has them');
    if (b.answered !== undefined && typeof b.answered !== 'boolean') return bad('answered is true or false');
    return NextResponse.json(await recordMain(await dataCtx(), b.currency, b.amounts, b.answered === true));
  } catch (err) {
    return failure(err, 'record the currency of');
  }
}
