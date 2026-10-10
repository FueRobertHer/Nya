import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { indexTaxonomy } from '@/lib/categories';
import { ensureTaxonomy } from '@/lib/category-store';
import { liveTagIds, readTagSet } from '@/lib/tags';
import { assembleBankRows, finishActivity } from '@/lib/activity';
import { readLinks, resolveId } from '@/lib/link-core';
import { EARLIEST_DATE } from '@/lib/manual-txn-input';
import { checkRuleInput, compileRules, RuleError, RULES_VERSION, type RuleSubject } from '@/lib/rules';
import { currencyOf } from '@/lib/spending';

// What a rule being made or edited would match, before it is saved
// (components/RuleSheet.tsx): "matches 43 transactions", over every stored
// transaction of every date, the hidden accounts' left out, as the Activity
// tab shows them, and a few of them, newest first.
//
// POST { rule: { conditions, actions } }, checked as a save checks it.
// Answers { matches, keep_category, keep_name, samples }: how many it
// matches; of those, how many keep a category the person chose for them, and
// a name they gave the merchant (a choice made on a row wins over every
// rule); and up to SAMPLES of them as they show now.
//
// The rule is read alone: what other rules do is not counted, since which of
// two rules decides a row depends on the order the person gives them. From
// storage only, never syncing: it changes nothing, so nothing is cleared.

const MAX_BODY_CHARS = 32 * 1024;
/** How many matches are listed. */
const SAMPLES = 5;

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
    const [taxonomy, tags] = await Promise.all([ensureTaxonomy(ctx), readTagSet(ctx)]);
    const ix = indexTaxonomy(taxonomy);
    const input = checkRuleInput(body.rule, { ix, tags });
    const at = new Date().toISOString();
    const draft = { id: 'preview', enabled: true, priority: 1, ...input, created_at: at, updated_at: at };

    // Every stored row, with what each rule reads of it.
    const subjects = new Map<string, RuleSubject>();
    const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, since: EARLIEST_DATE });
    const { transactions } = await finishActivity(ctx, bank.payload, bank.hidden, { since: EARLIEST_DATE, subjects });
    const onAccount = input.conditions.some((c) => c.field === 'account');
    const links = onAccount ? await readLinks(ctx).then((r) => r.links, () => new Map()) : null;
    const account = links?.size ? (id: string) => resolveId(id, links) : undefined;
    // The draft's conditions alone: its actions don't decide what it matches.
    const compiled = compileRules({ version: RULES_VERSION, rules: [{ ...draft, actions: { hide: true } }] }, { ix, liveTags: liveTagIds(tags), account });
    const test = compiled.rules[0]?.test;
    const matched = test ? transactions.filter((t) => subjects.has(t.transaction_id) && test(subjects.get(t.transaction_id)!)) : [];
    return NextResponse.json({
      matches: matched.length,
      keep_category: input.actions.set_category ? matched.filter((t) => subjects.get(t.transaction_id)!.keeps_category).length : 0,
      keep_name: input.actions.set_name ? matched.filter((t) => subjects.get(t.transaction_id)!.keeps_name).length : 0,
      samples: matched.slice(0, SAMPLES).map((t) => ({
        transaction_id: t.transaction_id,
        date: t.date,
        name: t.name,
        amount: t.amount,
        currency: currencyOf(t),
        account_name: t.account_name,
        category: t.category_name ?? null,
      })),
    });
  } catch (err) {
    if (err instanceof RuleError) return NextResponse.json({ error: err.message }, { status: err.status });
    return storeFailure(err, 'Failed to preview that rule');
  }
}
