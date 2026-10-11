import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { loadBudgets, moveMergedBudgets } from '@/lib/budget-store';
import { changeIncome, changeMonths, moveMergedMonths } from '@/lib/budget-months-store';
import { categoryById, indexTaxonomy } from '@/lib/categories';
import { isMonth, resetCarry, RolloverError, setRollover, type TargetKind } from '@/lib/rollover';
import { isThisMonth, rolloverFailure } from '@/lib/rollover-http';

// Budget rollover and income carryover settings (#37, lib/rollover.ts), kept
// in the `budget-months` and `income-carryover` stores beside the budget set
// (lib/budget-months-store.ts), never in it.
//
// POST makes one change, named by `action`, in `month` (this month, as the
// page has it: a month some time zone is in now), and answers what it saved:
//
//   rollover { kind, id, on: true, from }   roll a budget over from `from`
//                                           (this month or earlier), or move
//                                           the start of one that does
//   rollover { kind, id, on: false }        stop: its carry is zero from this
//                                           month, earlier months keep theirs
//   reset    { kind, id }                   its carry set to zero from this month
//   income   { enabled: true, start }       income carryover on, its pool
//                                           counting from `start`
//   income   { enabled: false }             off (its start kept)
//
// `kind` is "category" or "group", and `id` its id: a budget the budget set
// has now (a group's own amount, for a group). Each change is one
// compare-and-set over the record noted against the budget set as it is, so
// a save of budgets on another device never loses it, nor it them. Refused
// changes say why: 400 a bad request, 409 a budget gone since the page loaded
// or a change that doesn't apply, and 409 with `unreadable` when the record
// can't be read, which is never saved over.

const MAX_BODY_CHARS = 4 * 1024;
/** A category's or group's id, as the budget set keeps one. */
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** The fields an action takes; any other is refused. */
const FIELDS: Record<string, readonly string[]> = {
  rollover: ['action', 'month', 'kind', 'id', 'on', 'from'],
  reset: ['action', 'month', 'kind', 'id'],
  income: ['action', 'month', 'enabled', 'start'],
};

function target(body: Record<string, unknown>): { kind: TargetKind; id: string } {
  if ((body.kind !== 'category' && body.kind !== 'group') || !isId(body.id)) throw new RolloverError('Invalid request');
  return { kind: body.kind === 'category' ? 'categories' : 'groups', id: body.id };
}

export async function POST(req: Request) {
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed;
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const action = typeof body.action === 'string' && Object.hasOwn(FIELDS, body.action) ? body.action : null;
    if (!action || !Object.keys(body).every((k) => FIELDS[action].includes(k))) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    // The page's this month: a stale page (left open past a month's end) is
    // asked to reload rather than change a month that has gone by.
    if (!isThisMonth(body.month)) return NextResponse.json({ error: 'This page’s month has passed. Reload, then try again.' }, { status: 400 });
    const month = body.month;

    if (action === 'income') {
      if (typeof body.enabled !== 'boolean') throw new RolloverError('Invalid request');
      if (body.enabled && !isMonth(body.start)) throw new RolloverError('Choose the month income carryover counts from.');
      if (!body.enabled && body.start !== undefined) throw new RolloverError('Invalid request');
      const ctx = await dataCtx();
      const income = await changeIncome(ctx, body.enabled ? { enabled: true, start: body.start as string } : { enabled: false }, month);
      return NextResponse.json({ income });
    }

    const { kind, id } = target(body);
    let change: { on: true; from: string } | { on: false } | null = null;
    if (action === 'rollover') {
      if (typeof body.on !== 'boolean') throw new RolloverError('Invalid request');
      if (body.on && !isMonth(body.from)) throw new RolloverError('Choose the month rollover starts in.');
      if (!body.on && body.from !== undefined) throw new RolloverError('Invalid request');
      change = body.on ? { on: true, from: body.from as string } : { on: false };
    }
    const ctx = await dataCtx();
    // Migrated first (lib/budget-store.ts), and a merge the budgets haven't
    // followed yet (one the release before made) settled, so the budget is
    // on the category the page shows it on.
    let { budgets, taxonomy } = await loadBudgets(ctx);
    const ix = indexTaxonomy(taxonomy);
    if (Object.keys(budgets.categories).some((c) => (categoryById(ix, c)?.id ?? c) !== c)) {
      await moveMergedBudgets(ctx, taxonomy);
      await moveMergedMonths(ctx, taxonomy);
      ({ budgets, taxonomy } = await loadBudgets(ctx));
    }
    const months = await changeMonths(ctx, budgets, taxonomy, month, (m) =>
      change ? setRollover(m, kind, id, change, month) : resetCarry(m, kind, id, month)
    );
    return NextResponse.json({ rollover: months[kind][id]?.rollover ?? [] });
  } catch (err) {
    return rolloverFailure(err, 'Failed to change rollover');
  }
}
