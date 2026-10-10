import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { indexTaxonomy } from '@/lib/categories';
import { ensureTaxonomy } from '@/lib/category-store';
import { readTagSet } from '@/lib/tags';
import {
  addRule,
  changeRules,
  deleteRule,
  editRule,
  emptyRuleSet,
  enableRule,
  newRuleId,
  orderRules,
  readRuleSet,
  ruleProblem,
  RuleError,
  sortedRules,
  type RuleContext,
  type RuleSet,
} from '@/lib/rules';

// Your rules (lib/rules.ts), for the Rules screen under Manage
// (components/RulesCard.tsx) and "Create a rule from this" on a transaction.
//
// GET answers the rules in the order they run (`rules`), and, by id, what
// keeps one from working (`problems`: a category it names was deleted).
//
// POST makes one change, named by `action`, in one compare-and-set, and
// answers the rules as they are after it:
//   add     { rule: { conditions, actions, enabled? } }   (first in the order)
//   edit    { id, rule: { conditions, actions, enabled? } }
//   enable  { id, enabled }                               (off keeps it, and puts its rows back)
//   order   { ids }                                       (every rule's id, first to run first)
//   delete  { id }
// A change refused says why: 400 a bad request, 404 a rule, category or tag
// gone since the page loaded, 409 too many rules or an order from a page
// that is out of date.
//
// Nothing here drops a cache: rules apply after it, on every read
// (lib/activity.ts), so a change shows on the next load of the transactions,
// in the app, the read-only API, reports and the download alike.

const MAX_BODY_CHARS = 32 * 1024;

function failure(err: unknown, what: string): NextResponse {
  if (err instanceof RuleError) return NextResponse.json({ error: err.message }, { status: err.status });
  return storeFailure(err, what);
}

/** The answer: the rules in order, and what keeps any from working. */
async function answer(set: RuleSet, ctx: Awaited<ReturnType<typeof dataCtx>>, extra: Record<string, unknown> = {}) {
  const ix = indexTaxonomy(await ensureTaxonomy(ctx));
  const rules = sortedRules(set);
  const problems = Object.fromEntries(rules.flatMap((r) => {
    const p = ruleProblem(r, ix);
    return p ? [[r.id, p]] : [];
  }));
  return NextResponse.json({ rules: { ...set, rules }, problems, ...extra });
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    return await answer((await readRuleSet(ctx)) ?? emptyRuleSet(), ctx);
  } catch (err) {
    return failure(err, 'Failed to load your rules');
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
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
    // What a rule's categories and tags are checked against: read strictly,
    // so a rule is never saved naming one that couldn't be read.
    const context = async (): Promise<RuleContext> => ({ ix: indexTaxonomy(await ensureTaxonomy(ctx)), tags: await readTagSet(ctx) });

    let set: RuleSet;
    let made: string | undefined;
    switch (body.action) {
      case 'add': {
        const c = await context();
        set = await changeRules(ctx, (s) => {
          const { set: next, rule } = addRule(s, body.rule, c, newRuleId);
          made = rule.id;
          return next;
        });
        break;
      }
      case 'edit': {
        const c = await context();
        set = await changeRules(ctx, (s) => editRule(s, body.id, body.rule, c));
        break;
      }
      case 'enable':
        set = await changeRules(ctx, (s) => enableRule(s, body.id, body.enabled));
        break;
      case 'order':
        set = await changeRules(ctx, (s) => orderRules(s, body.ids));
        break;
      case 'delete':
        set = await changeRules(ctx, (s) => deleteRule(s, body.id));
        break;
      default:
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    return await answer(set, ctx, made ? { created: made } : {});
  } catch (err) {
    return failure(err, 'Failed to change your rules');
  }
}
