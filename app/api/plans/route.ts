import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { mainAnswer, readPlans } from '@/lib/plan-copies';
import { Refused, createCopy, factsWere, isBasedOn, makeMain, relabelPlan, removePlan, renamePlan, saveEntries, type Save } from '@/lib/plan-writes';
import { parsePlanV2 } from '@/lib/fire/plan-v2';
import { CURRENCY_CODE } from '@/lib/fire/plan-currency';
import { SCENARIO_NAME_MAX } from '@/lib/fire/plan-list';

// Every plan (lib/plan-copies.ts): yours and its copies, each a whole plan
// in `fire-plans`, sharing the facts in `plan-facts`. Every write is
// lib/plan-writes.ts's, at the stamp (`based_on`) the page loaded.
//
//   GET                                   every plan, yours first, then the
//                                         copies in the order they were made,
//                                         and the ids of any that can't be
//                                         read or that a newer version saved
//   POST   { from, name, plan, currency, tax? } a new copy: `plan` whole, made from
//                                         `from` (New copy, Duplicate, Try it);
//                                         `tax` its own tax choices, when they
//                                         differ (behind `plan-tax`)
//   PUT    { saves, facts_were }          saves plans whole, all or none:
//                                         [{ id, plan, currency, based_on, tax? }],
//                                         `tax` its tax choices, when they changed
//                                         (behind `plan-tax`)
//   PATCH  { id, name, based_on }         renames one
//          { id, currency, based_on }     says a copy's amounts are in that
//                                         currency (the person's answer)
//          { main, based_on }             makes a copy your plan, answered as
//                                         GET /api/fire-plan answers yours
//   DELETE { id, based_on, unreadable? }  deletes a copy, never your plan;
//                                         damaged bytes only once the person
//                                         confirmed (`unreadable: true`)
//
// Every plan is checked (parsePlanV2) and anything else refused. A name
// another plan has (in any case) is refused: compare mode tells plans apart
// by name. Errors as on the storage seam (lib/store-failure.ts); a write
// refused for what is stored now is 409 with the words the page shows.

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function failure(err: unknown, fallback: string): NextResponse {
  if (err instanceof Refused) return NextResponse.json({ error: err.words, ...(err.stale ? { stale: true } : {}) }, { status: err.status });
  return storeFailure(err, fallback);
}

const extraKey = (b: Record<string, unknown>, keys: readonly string[]) => Object.keys(b).find((k) => !keys.includes(k));
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && v !== '__proto__';
const isCurrency = (v: unknown): v is string | null => v === null || (typeof v === 'string' && CURRENCY_CODE.test(v));

/** A plan's name, trimmed: 1 to SCENARIO_NAME_MAX characters, on one line
 *  (no control character, as scenarios had it). */
function nameOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  return name.length > 0 && name.length <= SCENARIO_NAME_MAX && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

export async function GET() {
  try {
    return NextResponse.json(await readPlans(await dataCtx()), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return failure(err, 'Failed to load your plans');
  }
}

export async function POST(req: Request) {
  const b = await bodyOf(req);
  if (!b) return bad('Send the new plan, as JSON');
  const extra = extraKey(b, ['from', 'name', 'plan', 'currency', 'tax']);
  if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
  if (!isId(b.from)) return bad('from is the id of the plan it is made from');
  const name = nameOf(b.name);
  if (name === null) return bad(`Name the plan on one line, in at most ${SCENARIO_NAME_MAX} characters`);
  const currency = b.currency ?? null;
  if (!isCurrency(currency)) return bad('currency must be a three-letter code, like USD');
  const parsed = parsePlanV2(b.plan);
  if ('error' in parsed) return bad(`Invalid plan: ${parsed.error}`);
  try {
    return NextResponse.json({ plan: await createCopy(await dataCtx(), { from: b.from, name, plan: parsed.plan, currency, ...(Object.hasOwn(b, 'tax') ? { tax: b.tax } : {}) }) });
  } catch (err) {
    return failure(err, 'Failed to make the plan');
  }
}

export async function PUT(req: Request) {
  const b = await bodyOf(req);
  if (!b) return bad('Send the plans to save, as JSON');
  const extra = extraKey(b, ['saves', 'facts_were']);
  if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
  const loaded = factsWere(b.facts_were);
  if (loaded === null) return bad('facts_were must be the facts the page loaded the plans with');
  if (!Array.isArray(b.saves) || b.saves.length === 0 || b.saves.length > 11) return bad('saves is a list of the plans to save');
  const saves: Save[] = [];
  for (const raw of b.saves) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('Each save is { id, plan, currency, based_on }');
    const x = raw as Record<string, unknown>;
    const e = extraKey(x, ['id', 'plan', 'currency', 'based_on', 'tax']);
    if (e) return bad(`${e.slice(0, 40)} isn’t taken here`);
    if (!isId(x.id)) return bad('id is a plan’s id');
    const currency = x.currency ?? null;
    if (!isCurrency(currency)) return bad('currency must be a three-letter code, like USD');
    if (!isBasedOn(x.based_on)) return bad('based_on is the version (updated_at) the plan was loaded at');
    const parsed = parsePlanV2(x.plan);
    if ('error' in parsed) return bad(`Invalid plan: ${parsed.error}`);
    saves.push({ id: x.id, plan: parsed.plan, currency, basedOn: x.based_on, ...(Object.hasOwn(x, 'tax') ? { tax: x.tax } : {}) });
  }
  try {
    const { main, rows } = await saveEntries(await dataCtx(), saves, loaded);
    return NextResponse.json({ plans: rows, main: mainAnswer(main) });
  } catch (err) {
    return failure(err, 'Failed to save your plans');
  }
}

export async function PATCH(req: Request) {
  const b = await bodyOf(req);
  if (!b) return bad('Send the change, as JSON');
  if (!isBasedOn(b.based_on)) return bad('based_on is the version (updated_at) the plan was loaded at');
  try {
    if (Object.hasOwn(b, 'main')) {
      const extra = extraKey(b, ['main', 'based_on']);
      if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
      if (!isId(b.main) || typeof b.based_on !== 'string') return bad('main is the id of the plan to make yours, at its based_on');
      return NextResponse.json(mainAnswer(await makeMain(await dataCtx(), b.main, b.based_on)));
    }
    if (!isId(b.id)) return bad('id is a plan’s id');
    if (Object.hasOwn(b, 'name')) {
      const extra = extraKey(b, ['id', 'name', 'based_on']);
      if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
      const name = nameOf(b.name);
      if (name === null) return bad(`Name the plan on one line, in at most ${SCENARIO_NAME_MAX} characters`);
      return NextResponse.json({ plan: await renamePlan(await dataCtx(), b.id, name, b.based_on) });
    }
    const extra = extraKey(b, ['id', 'currency', 'based_on']);
    if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
    if (typeof b.currency !== 'string' || !CURRENCY_CODE.test(b.currency)) return bad('currency must be a three-letter code, like USD');
    return NextResponse.json({ plan: await relabelPlan(await dataCtx(), b.id, b.currency, b.based_on) });
  } catch (err) {
    return failure(err, 'Failed to change the plan');
  }
}

export async function DELETE(req: Request) {
  const b = await bodyOf(req);
  if (!b) return bad('Send the id of the plan to delete, as JSON');
  const extra = extraKey(b, ['id', 'based_on', 'unreadable']);
  if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
  if (!isId(b.id)) return bad('id is a plan’s id');
  const basedOn = b.based_on ?? null;
  if (!isBasedOn(basedOn)) return bad('based_on is the version (updated_at) the plan was loaded at');
  if (b.unreadable !== undefined && typeof b.unreadable !== 'boolean') return bad('unreadable is true or false');
  try {
    await removePlan(await dataCtx(), b.id, basedOn, b.unreadable === true);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return failure(err, 'Failed to delete the plan');
  }
}
