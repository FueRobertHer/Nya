import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { indexTaxonomy } from '@/lib/categories';
import { ensureTaxonomy } from '@/lib/category-store';
import { liveTagIds, readTagSet, tagsForDisplay } from '@/lib/tags';
import {
  addRule,
  changeRules,
  deadRuleTags,
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
  sweepRuleTags,
  withCurrentCategories,
  withLiveTags,
  type RuleContext,
  type RuleSet,
} from '@/lib/rules';

// Your rules (lib/rules.ts), for the Rules screen in Settings, Transactions
// (components/RulesCard.tsx) and "Create a rule from this" on a transaction.
//
// GET answers the rules in the order they run (`rules`, each category they
// name as it is known now, following a merge, and only the tags that exist),
// and, by id, what keeps one from working (`problems`: a category it names
// was deleted).
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
// A TAG DELETED WHILE A RULE IS SAVED. A save checks its tags against the
// tags as read before its compare-and-set; a tag deleted meanwhile may have
// been swept out of the rules before the save landed (lib/tag-delete.ts). So
// after an add or an edit, any tag the rules add that no longer exists is
// swept out again: the save and the deletion end with no rule holding it,
// whichever lands first.
//
// Nothing here drops a cache: rules apply after it, on every read
// (lib/activity.ts), so a change shows on the next load of the transactions,
// in the app, the read-only API, reports and the download alike.

const MAX_BODY_CHARS = 32 * 1024;

function failure(err: unknown, what: string): NextResponse {
  if (err instanceof RuleError) return NextResponse.json({ error: err.message }, { status: err.status });
  return storeFailure(err, what);
}

type Ctx = Awaited<ReturnType<typeof dataCtx>>;

/** The answer: the rules in order, and what keeps any from working. */
async function answer(set: RuleSet, ctx: Ctx, extra: Record<string, unknown> = {}) {
  const [taxonomy, tags] = await Promise.all([ensureTaxonomy(ctx), tagsForDisplay(ctx)]);
  const ix = indexTaxonomy(taxonomy);
  // Tags that can't be read leave each rule's as stored: an edit of a rule
  // shown without them would save it without them.
  const live = tags.note ? null : liveTagIds(tags.set);
  const rules = sortedRules(set).map((r) => {
    const now = withCurrentCategories(r, ix);
    return live ? withLiveTags(now, live) : now;
  });
  const problems = Object.fromEntries(rules.flatMap((r) => {
    const p = ruleProblem(r, ix);
    return p ? [[r.id, p]] : [];
  }));
  return NextResponse.json({ rules: { ...set, rules }, problems, ...extra });
}

/** After an add or an edit: the tags the rules add that were deleted
 *  meanwhile, swept out (see A TAG DELETED WHILE A RULE IS SAVED), and the
 *  rules as they are then. The save stands whatever this finds: a tag left
 *  behind is shown nowhere, and the next deletion's sweep or edit takes it. */
async function settled(ctx: Ctx, set: RuleSet): Promise<RuleSet> {
  try {
    const dead = deadRuleTags(set, liveTagIds(await readTagSet(ctx)));
    if (dead.length === 0) return set;
    await sweepRuleTags(ctx, dead);
    return (await readRuleSet(ctx)) ?? set;
  } catch (err) {
    console.error('rules: a deleted tag could not be swept after a save', err instanceof Error ? err.name : 'error');
    return set;
  }
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
        set = await settled(
          ctx,
          await changeRules(ctx, (s) => {
            const { set: next, rule } = addRule(s, body.rule, c, newRuleId);
            made = rule.id;
            return next;
          })
        );
        break;
      }
      case 'edit': {
        const c = await context();
        set = await settled(ctx, await changeRules(ctx, (s) => editRule(s, body.id, body.rule, c)));
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
