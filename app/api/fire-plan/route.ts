import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { firePlanStore, planAnswer as answer, planCurrencyStore, readCurrencyRecord as readRecord } from '@/lib/fire-plan';
import { firePlansStore, mainAnswer, planFactsStore, readMain, readPlanAnswer, type MainPlan } from '@/lib/plan-copies';
import { parsePlan } from '@/lib/fire/plan';
import { parsePlanV2, type StoredPlan } from '@/lib/fire/plan-v2';
import { factsOf, holdsAmounts, isPlanFacts, sameFacts, withFacts, type Facts, type PlanEntry } from '@/lib/fire/copies';
import { CURRENCY_CODE, currencyRecord, hasTypedAmounts, isTypedAmounts, recordedCurrency, sameAmounts, typedAmounts, type TypedAmounts } from '@/lib/fire/plan-currency';
import { stampAfter } from '@/lib/edit-stamp';

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
// tell it. A record is replaced only on the person's answer. What GET
// answers is lib/plan-copies.ts readPlanAnswer's, which the Plan's inputs
// (app/api/plan-inputs) answer too.
//
// Once a newer release has made the plans copies (`fire-plans`,
// lib/plan-copies.ts), GET answers your plan's entry, with the facts every
// plan shares, its currency and its stamp (`updated_at`), and PUT and POST
// save into that entry, never `fire-plan`, which isn't read any more:
//
//   - PUT takes `plan` in either version, `currency`, `facts_were` (the facts
//     the page loaded: written only when the plan's differ from them, so an
//     old page never writes an old age back) and `based_on` (the entry's
//     stamp as a newer page loaded it). Anything else is refused, so a newer
//     page's save of another plan never lands in yours. Every check runs on
//     what was read before anything is written, then again inside each
//     compare-and-set; the facts are written first, then the entry, so a
//     failure between says the age was saved and the rest wasn't.
//   - POST records the entry's currency by the same rules as the record's.
//
// Neither ever makes `fire-plans` or `plan-facts`: a write finding either
// gone is refused as stale.

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

const NEWER = 'The currency your plan’s figures are in was recorded by a newer version of Nya, so it can’t be changed here.';
const STALE_CURRENCY = 'The currency your plan’s figures are in was changed since this page loaded it, so nothing was saved: load it again.';
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** A save refused for what is stored now, with the words the page shows. */
class Refused extends Error {
  constructor(
    readonly words: string,
    readonly stale = true
  ) {
    super(words);
  }
}

const CHANGED = 'Your plan changed: load the page again';
const OTHER_DEVICE = 'Changed on another device: load it again';
const FIRST_CURRENCY = 'Say which currency your plan’s figures are in, then save again: nothing was saved.';
const refused = (r: Refused) => NextResponse.json({ error: r.words, ...(r.stale ? { stale: true } : {}) }, { status: 409 });

/** The facts a page loaded, as it sends them: the shape the facts store
 *  takes, without its version and main id. */
function factsWere(v: unknown): Facts | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  if (!isPlanFacts({ version: 1, main: 'main', ...v })) return null;
  const { age, partnerAge, includeCash, planFunding, method } = v as Facts;
  return { age, partnerAge, includeCash, planFunding, method };
}

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
    // Absent from a page of the release before, still open: the plan alone,
    // which leaves the record apart from it, so the next load asks.
    const currency = b.currency ?? null;
    if (currency !== null && (typeof currency !== 'string' || !CURRENCY_CODE.test(currency))) return bad('Invalid plan: currency must be a three-letter code, like USD');
    const loaded = b.facts_were === undefined ? undefined : factsWere(b.facts_were);
    if (loaded === null) return bad('facts_were must be the facts the page loaded the plan with');
    if (b.based_on !== undefined && (typeof b.based_on !== 'string' || b.based_on.length > 64)) return bad('based_on is the version (updated_at) the plan was loaded at');
    const ctx = await dataCtx();
    const main = await readMain(ctx);
    if (main) return await saveMain(ctx, main, b.plan, currency, loaded, b.based_on as string | undefined);
    // This release saves version 1 only to `fire-plan`; version 2 is read,
    // never written there (lib/fire/plan-v2.ts).
    if (typeof b.plan === 'object' && b.plan !== null && (b.plan as { version?: unknown }).version === 2) return bad('This plan holds what only a newer version of Nya can save');
    const parsed = parsePlan(b.plan);
    if ('error' in parsed) return bad(`Invalid plan: ${parsed.error}`);
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
      return NextResponse.json({ error: STALE_CURRENCY, stale: true }, { status: 409 });
    }
    // The record first, then the plan: a save stopped between the two leaves
    // a record of other amounts than the plan's, which reads as stale and asks,
    // never as no record (which the tab may fill in on its own). A plan the
    // seam refused before writing it (too large, or over a value it can't
    // read) puts the record back as it was. Any other failure may have come
    // after the plan was written (a reply lost), so the new record stays: it
    // then fits the plan, or reads as stale, and never leaves typed amounts
    // with no record at all.
    const record = currencyRecord(parsed.plan, currency);
    await planCurrencyStore.set(ctx, record);
    try {
      await firePlanStore.set(ctx, parsed.plan);
    } catch (err) {
      if (err instanceof StoreRefusedError || err instanceof StoredDataUnreadableError) {
        await (before.record ? planCurrencyStore.set(ctx, before.record) : planCurrencyStore.remove(ctx)).catch(() => {});
      }
      throw err;
    }
    return NextResponse.json(answer(parsed.plan, record, null));
  } catch (err) {
    return failure(err, 'save');
  }
}

/** The checks a save into your plan's entry makes, on the entry as read and
 *  again on the entry at the write: the stamp a newer page sent, a version
 *  1 plan over a version 2 one (an old page would drop items it couldn't
 *  show), a currency other than the one the entry's amounts are in, and
 *  first amounts with none (the currency an entry kept once its amounts
 *  went is no one's: never a label for new ones). */
function checkEntry(entry: PlanEntry, plan: StoredPlan, currency: string | null, basedOn: string | undefined): void {
  if (basedOn !== undefined && basedOn !== entry.updatedAt) throw new Refused(CHANGED);
  if (plan.version === 1 && entry.plan.version === 2) throw new Refused(CHANGED);
  if (currency !== null && holdsAmounts(entry.plan) && entry.currency !== null && entry.currency !== currency) throw new Refused(STALE_CURRENCY);
  if (currency === null && holdsAmounts(plan) && !holdsAmounts(entry.plan)) throw new Refused(FIRST_CURRENCY, false);
}

/** PUT once the plans are copies: into your plan's entry (see the top). */
async function saveMain(ctx: Awaited<ReturnType<typeof dataCtx>>, main: MainPlan, raw: unknown, currency: string | null, loaded: Facts | undefined, basedOn: string | undefined): Promise<NextResponse> {
  const isV2 = typeof raw === 'object' && raw !== null && (raw as { version?: unknown }).version === 2;
  const parsed = isV2 ? parsePlanV2(raw) : parsePlan(raw);
  if ('error' in parsed) return bad(`Invalid plan: ${parsed.error}`);
  const plan: StoredPlan = parsed.plan;
  const stored = main.facts ?? factsOf(main.entry.plan);
  const sent = factsOf(plan);
  // The facts this save changes, or null: compared with what the page loaded,
  // so another device's new age stands through an unrelated save. A page
  // that sends none (the release before's) is taken only with the facts as
  // they are.
  let change: Facts | null = null;
  try {
    checkEntry(main.entry, plan, currency, basedOn);
    if (loaded === undefined) {
      if (!sameFacts(sent, stored)) throw new Refused(CHANGED);
    } else if (!sameFacts(sent, loaded)) {
      if (!sameFacts(loaded, stored)) throw new Refused(OTHER_DEVICE);
      change = sent;
    }
  } catch (err) {
    if (err instanceof Refused) return refused(err);
    throw err;
  }
  let factsLanded = false;
  let facts = main.facts;
  try {
    if (change && main.facts) {
      const to = change;
      facts = await planFactsStore.update(ctx, (cur) => {
        // Gone since it was read: never made again from here.
        if (cur === null) throw new Refused(CHANGED);
        if (!sameFacts(cur, loaded!)) throw new Refused(OTHER_DEVICE);
        return { ...cur, ...to };
      });
      factsLanded = true;
    }
    const now = new Date();
    const written = await firePlansStore.update(ctx, main.id, (cur) => {
      if (cur === null) throw new Refused(CHANGED);
      checkEntry(cur, plan, currency, basedOn);
      // Without `plan-facts` the entry's own fields are the facts, so they
      // are checked here too.
      if (change && !main.facts && !sameFacts(factsOf(cur.plan), loaded!)) throw new Refused(OTHER_DEVICE);
      return {
        ...cur,
        plan: withFacts(plan, change ?? factsOf(cur.plan)),
        currency: holdsAmounts(plan) ? (currency ?? cur.currency) : cur.currency,
        updatedAt: stampAfter(cur.updatedAt, now),
      };
    });
    return NextResponse.json(mainAnswer({ ...main, entry: written!, facts }));
  } catch (err) {
    if (factsLanded) {
      console.error('Plan facts saved, its entry not:', err);
      return NextResponse.json({ error: 'Your age was saved; the rest wasn’t: try again', stale: true }, { status: 409 });
    }
    if (err instanceof Refused) return refused(err);
    throw err;
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
    const answered = b.answered === true;
    const main = await readMain(ctx);
    if (main) return await recordMain(ctx, main, b.currency, b.amounts, answered);
    const plan = await firePlanStore.get(ctx);
    if (!plan || !hasTypedAmounts(plan)) return NextResponse.json({ error: NOTHING_TYPED }, { status: 409 });
    if (!sameAmounts(typedAmounts(plan), b.amounts)) {
      return NextResponse.json({ error: CHANGED_SINCE, stale: true }, { status: 409 });
    }
    const { record: there, problem } = await readRecord(ctx);
    if (problem === 'newer') return NextResponse.json({ error: NEWER }, { status: 409 });
    if (problem === 'unreadable') {
      if (!answered) return NextResponse.json({ error: 'The record of your plan’s currency couldn’t be read, so it was left as it is.', unreadable: true }, { status: 409 });
      // The person's own answer, over damaged bytes: only those are removed.
      await planCurrencyStore.remove(ctx);
    } else if (there && !answered && recordedCurrency(plan, there) !== b.currency) {
      // A record there that this would change: never without the person.
      return NextResponse.json({ error: ALREADY, stale: true }, { status: 409 });
    }
    const record = currencyRecord(plan, b.currency);
    await planCurrencyStore.set(ctx, record);
    return NextResponse.json(answer(plan, record, null));
  } catch (err) {
    return failure(err, 'record the currency of');
  }
}

const NOTHING_TYPED = 'Your plan holds no amount you typed, so there is no currency to record.';
const CHANGED_SINCE = 'Your plan was changed since this page loaded it, so nothing was recorded: load it again.';
const ALREADY = 'A currency is recorded for your plan already, so it was left as it is: say which currency your figures are in.';

/** POST once the plans are copies: the currency into your plan's entry, by
 *  the record's rules, every check on the entry at the write (its currency
 *  carries no amounts of its own to tell a changed plan by). */
async function recordMain(ctx: Awaited<ReturnType<typeof dataCtx>>, main: MainPlan, currency: string, amounts: TypedAmounts, answered: boolean): Promise<NextResponse> {
  const now = new Date();
  try {
    const written = await firePlansStore.update(ctx, main.id, (cur) => {
      if (cur === null) throw new Refused(CHANGED);
      if (!holdsAmounts(cur.plan)) throw new Refused(NOTHING_TYPED, false);
      if (!sameAmounts(typedAmounts(cur.plan), amounts)) throw new Refused(CHANGED_SINCE);
      if (cur.currency === currency) return cur;
      if (cur.currency !== null && !answered) throw new Refused(ALREADY);
      return { ...cur, currency, updatedAt: stampAfter(cur.updatedAt, now) };
    });
    return NextResponse.json(mainAnswer({ ...main, entry: written! }));
  } catch (err) {
    if (err instanceof Refused) return refused(err);
    throw err;
  }
}
