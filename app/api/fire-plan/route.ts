import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { firePlanStore, planCurrencyStore } from '@/lib/fire-plan';
import { parsePlan, type FirePlan } from '@/lib/fire/plan';
import { CURRENCY_CODE, currencyRecord, hasTypedAmounts, isTypedAmounts, recordedCurrency, sameAmounts, typedAmounts, type PlanCurrencyRecord } from '@/lib/fire/plan-currency';

// The Plan tab's saved assumptions, and the currency their typed figures are
// in (lib/fire/plan-currency.ts). GET answers { plan, currency } ({ plan:
// null, currency: null } when nothing was ever saved); `currency` is the
// recorded one when the record holds for the plan, else null, and
// `currency_problem` says why a record there doesn't: "stale" (a record of
// other amounts, its currency in `currency_was`), "unreadable" or "newer".
// No currency and no problem is no record at all. PUT replaces the whole
// plan (the client always sends all of it), after checking every field
// (lib/fire/plan.ts parsePlan), and records `currency` with it when given.
// POST records the currency alone, for the plan as stored: when the person
// says which it is (`answered`), or, with no record at all, when the tab can
// tell it. A record is replaced only on the person's answer.

/** The answer for an error, as every route on the storage seam gives it. */
function failure(err: unknown, doing: string): NextResponse {
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

type Ctx = Awaited<ReturnType<typeof dataCtx>>;
type Problem = 'unreadable' | 'newer' | null;

/** The record as it reads: strict about deployment problems, but a record
 *  that can't be used is said, never thrown, so the plan still loads (the
 *  page then asks which currency the figures are in). */
async function readRecord(ctx: Ctx): Promise<{ record: PlanCurrencyRecord | null; problem: Problem }> {
  const r = await planCurrencyStore.getReport(ctx);
  return { record: r.value, problem: r.unrecognised ? 'newer' : r.unreadable ? 'unreadable' : null };
}

/** A record there, for typed amounts it isn't of. */
const isStale = (plan: FirePlan | null, record: PlanCurrencyRecord | null) => !!plan && !!record && hasTypedAmounts(plan) && recordedCurrency(plan, record) === null;

const answer = (plan: FirePlan | null, record: PlanCurrencyRecord | null, problem: Problem) => {
  if (problem) return { plan, currency: null, currency_problem: problem };
  if (isStale(plan, record)) return { plan, currency: null, currency_problem: 'stale', currency_was: record!.currency };
  return { plan, currency: recordedCurrency(plan, record) };
};

const NEWER = 'The currency your plan’s figures are in was recorded by a newer version of Nya, so it can’t be changed here.';
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function GET() {
  try {
    const ctx = await dataCtx();
    const plan = await firePlanStore.get(ctx);
    const { record, problem } = await readRecord(ctx);
    return NextResponse.json(answer(plan, record, problem));
  } catch (err) {
    return failure(err, 'load');
  }
}

export async function PUT(req: Request) {
  try {
    const ctx = await dataCtx();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return bad('Invalid plan');
    }
    const b = typeof body === 'object' && body !== null ? (body as { plan?: unknown; currency?: unknown }) : {};
    const parsed = parsePlan(b.plan);
    if ('error' in parsed) return bad(`Invalid plan: ${parsed.error}`);
    // Absent from a page of the release before, still open: the plan alone,
    // which leaves the record apart from it, so the next load asks.
    const currency = b.currency ?? null;
    if (currency !== null && (typeof currency !== 'string' || !CURRENCY_CODE.test(currency))) return bad('Invalid plan: currency must be a three-letter code, like USD');
    // Read first, so a record that can't be used is neither written over nor
    // a reason the plan isn't saved: the plan is saved, and the record left.
    const before = await readRecord(ctx);
    if (currency === null || before.problem) {
      await firePlanStore.set(ctx, parsed.plan);
      return NextResponse.json(answer(parsed.plan, before.record, before.problem));
    }
    // A currency other than the one recorded for the plan there now, or over
    // a record that no longer fits it: a page that didn't see the change (a
    // relabel on another device, say). Refused, so it loads and asks: a save
    // never changes what the figures mean.
    const stored = await firePlanStore.get(ctx);
    if (before.record && stored && hasTypedAmounts(stored) && recordedCurrency(stored, before.record) !== currency) {
      return NextResponse.json({ error: 'The currency your plan’s figures are in was changed since this page loaded it, so nothing was saved: load it again.', stale: true }, { status: 409 });
    }
    // The record first, then the plan: a save stopped between the two leaves
    // a record of other amounts than the plan's, which reads as stale and asks,
    // never as no record (which the tab may fill in on its own). A plan the
    // seam refuses puts the record back as it was.
    const record = currencyRecord(parsed.plan, currency);
    await planCurrencyStore.set(ctx, record);
    try {
      await firePlanStore.set(ctx, parsed.plan);
    } catch (err) {
      await (before.record ? planCurrencyStore.set(ctx, before.record) : planCurrencyStore.remove(ctx)).catch(() => {});
      throw err;
    }
    return NextResponse.json(answer(parsed.plan, record, null));
  } catch (err) {
    return failure(err, 'save');
  }
}

/** Records the currency of the plan as stored: { currency, amounts }, the
 *  typed amounts of the plan the page shows, so a plan changed since on
 *  another device is never given it. `answered` when it is the person's own
 *  answer: only that replaces a record there (one that can't be read, one
 *  that no longer fits, or another currency for the same amounts); without
 *  it, only a plan with no record at all is recorded. */
export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
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
    const plan = await firePlanStore.get(ctx);
    if (!plan || !hasTypedAmounts(plan)) return NextResponse.json({ error: 'Your plan holds no amount you typed, so there is no currency to record.' }, { status: 409 });
    if (!sameAmounts(typedAmounts(plan), b.amounts)) {
      return NextResponse.json({ error: 'Your plan was changed since this page loaded it, so nothing was recorded: load it again.', stale: true }, { status: 409 });
    }
    const { record: there, problem } = await readRecord(ctx);
    if (problem === 'newer') return NextResponse.json({ error: NEWER }, { status: 409 });
    const answered = b.answered === true;
    if (problem === 'unreadable') {
      if (!answered) return NextResponse.json({ error: 'The record of your plan’s currency couldn’t be read, so it was left as it is.', unreadable: true }, { status: 409 });
      // The person's own answer, over damaged bytes: only those are removed.
      await planCurrencyStore.remove(ctx);
    } else if (there && !answered && recordedCurrency(plan, there) !== b.currency) {
      // A record there that this would change: never without the person.
      return NextResponse.json({ error: 'A currency is recorded for your plan already, so it was left as it is: say which currency your figures are in.', stale: true }, { status: 409 });
    }
    const record = currencyRecord(plan, b.currency);
    await planCurrencyStore.set(ctx, record);
    return NextResponse.json(answer(plan, record, null));
  } catch (err) {
    return failure(err, 'record the currency of');
  }
}
