import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { indexTaxonomy } from '@/lib/categories';
import { ensureTaxonomy } from '@/lib/category-store';
import { liveTagIds, readTagSet } from '@/lib/tags';
import { assembleBankRows, finishActivity } from '@/lib/activity';
import { EARLIEST_DATE } from '@/lib/manual-txn-input';
import { checkRuleInput, compileRules, RuleError, RULES_VERSION, type RuleSubject } from '@/lib/rules';
import { currencyOf } from '@/lib/spending';
import { bankRows } from '@/lib/split-rows';

// What a rule being made or edited would match, before it is saved
// (components/RuleSheet.tsx): "matches 43 transactions", over every stored
// transaction of every date, the hidden accounts' left out, as the Activity
// tab shows them, and a few of them, newest first.
//
// POST { rule: { conditions, actions } }, checked as a save checks it.
// Answers { matches, keep_category, keep_name, keep_approved, samples }: how
// many it matches; of those, how many keep a category the person chose for
// them, and a name they gave the merchant (a choice made on a row wins over
// every rule), and how many stay where the person approved them (the review
// queue: the rule's category is offered there); and up to SAMPLES of them as
// they show now.
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
    // A tag deleted since the form opened is no reason to refuse a preview:
    // what the rule adds doesn't decide what it matches.
    const input = checkRuleInput(body.rule, { ix, tags, had: 'any' });
    const at = new Date().toISOString();
    const draft = { id: 'preview', enabled: true, priority: 1, ...input, created_at: at, updated_at: at };

    // Every stored row, with what each rule reads of it: the account each is
    // on as known now, through the links that apply, when the rule names an
    // account, as the rules follow them once it is saved (lib/activity.ts).
    const subjects = new Map<string, RuleSubject>();
    const onAccount = input.conditions.some((c) => c.field === 'account');
    const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, since: EARLIEST_DATE });
    const read = await finishActivity(ctx, bank.payload, bank.hidden, { since: EARLIEST_DATE, subjects, followLinks: onAccount });
    const accountOf = read.accountOf;
    // Each transaction once, as rules read it: a split one whole, a group's
    // each on its own (lib/split-rows.ts).
    const transactions = bankRows(read.transactions);
    // The draft's conditions alone: its actions don't decide what it matches.
    const compiled = compileRules({ version: RULES_VERSION, rules: [{ ...draft, actions: { hide: true } }] }, { ix, liveTags: liveTagIds(tags), account: accountOf });
    const test = compiled.rules[0]?.test;
    const matched = test ? transactions.filter((t) => subjects.has(t.transaction_id) && test(subjects.get(t.transaction_id)!)) : [];
    return NextResponse.json({
      matches: matched.length,
      keep_category: input.actions.set_category ? matched.filter((t) => subjects.get(t.transaction_id)!.keeps_category).length : 0,
      // Approved ones stay where they were approved: the rule's category is
      // offered on each, never applied unasked (lib/review-layer.ts).
      keep_approved: input.actions.set_category ? matched.filter((t) => !subjects.get(t.transaction_id)!.keeps_category && t.reviewed_at !== undefined).length : 0,
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
