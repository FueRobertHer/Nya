import { describe, expect, test } from 'bun:test';
import {
  addRule,
  checkRuleInput,
  compileRules,
  deleteRule,
  editRule,
  emptyRuleSet,
  enableRule,
  evaluateRules,
  isRuleSet,
  matchText,
  MAX_CONDITIONS,
  MAX_RULES,
  orderRules,
  ruleProblem,
  ruleSentence,
  sortedRules,
  sourceKind,
  withLiveTags,
  deadRuleTags,
  withoutTags,
  type Rule,
  type RuleSet,
  type RuleSubject,
} from '@/lib/rules';
import { applyLayers } from '@/lib/txn-layers';
import { deleteCategory, indexTaxonomy, mergeCategories, renameCategory, addCategory, type Taxonomy } from '@/lib/categories';
import type { TagSet } from '@/lib/tags';
import { summarize } from '@/lib/totals';
import { spendingByTag } from '@/lib/tag-totals';
import { categoriesFor } from './category-fixture';

// The rules engine (#36), pure: what a rule may say and how it is stored
// (closed, so a later release's rules are never half applied), how rules are
// ordered and combined, what each condition matches, what makes one broken,
// and that applying a hundred rules to a few thousand transactions is fast.

const at = '2026-10-01T00:00:00.000Z';
const base = categoriesFor({}, { words: ['groceries', 'restaurants', 'coffee', 'shopping', 'travel'] }).taxonomy;
const cat = (t: Taxonomy, name: string) => t.categories.find((c) => c.name === name)!.id;
const TAGS: TagSet = { version: 1, tags: ['work', 'trip', 'gift'].map((id) => ({ id, name: id, color: 'blue', created_at: at })) };
const ctxOf = (t: Taxonomy = base) => ({ ix: indexTaxonomy(t), tags: TAGS });
let n = 0;
const newId = () => `r${++n}`;

/** A rule set from inputs, the first listed running first. */
function setOf(inputs: unknown[], t: Taxonomy = base): RuleSet {
  let set = emptyRuleSet();
  for (const input of [...inputs].reverse()) set = addRule(set, input, ctxOf(t), newId, new Date(at)).set;
  return set;
}
const subject = (over: Partial<RuleSubject> = {}): RuleSubject => ({
  names: ['blue bottle'],
  amount: 5,
  account: 'acc_1',
  institution: 'chase',
  category: cat(base, 'coffee'),
  source: 'plaid',
  ...over,
});
const outcome = (set: RuleSet, s: RuleSubject, t: Taxonomy = base) => {
  const ix = indexTaxonomy(t);
  return evaluateRules(compileRules(set, { ix, liveTags: new Set(TAGS.tags.map((x) => x.id)) }), s, ix);
};

describe('matching text', () => {
  test('in any case, accents and repeated spaces ignored', () => {
    expect(matchText('  Café   DU  Monde ')).toBe('cafe du monde');
    expect(matchText('ＡＭＺＮ Mktp')).toBe('amzn mktp');
    expect(sourceKind(undefined)).toBe('plaid');
    expect(sourceKind('import:csv')).toBe('import');
  });

  test('an apostrophe or a quote as a phone types it is the one a bank writes', () => {
    expect(matchText('Trader Joe’s')).toBe(matchText("TRADER JOE'S"));
    for (const typed of ['McDonald‘s', 'McDonald’s', 'McDonaldʼs', 'McDonald´s', 'McDonald＇s']) expect(matchText(typed)).toBe("mcdonald's");
    expect(matchText('“Bob’s” Diner')).toBe(matchText('"BOB\'S" DINER'));
    const set = setOf([{ conditions: [{ field: 'name', op: 'equals', value: 'Trader Joe’s' }], actions: { hide: true } }]);
    expect(outcome(set, subject({ names: [matchText("TRADER JOE'S")] })).hide).toBeDefined();
  });
});

describe('what a rule may say', () => {
  const ok = { conditions: [{ field: 'name', op: 'contains', value: 'amzn' }], actions: { set_category: cat(base, 'shopping') } };

  test('every condition and action is checked strictly, and stored in its own form', () => {
    const r = checkRuleInput(
      {
        conditions: [
          { field: 'name', op: 'starts_with', value: '  SQ  *Coffee ' },
          { field: 'amount', op: 'between', value: 5, value2: 20.005, direction: 'out' },
          { field: 'account', op: 'equals', value: 'manual_6b1f' },
          { field: 'institution', op: 'equals', value: 'Chase' },
          { field: 'category', op: 'equals', value: cat(base, 'coffee') },
          { field: 'source', op: 'equals', value: 'import' },
        ],
        actions: { set_name: ' Coffee ', add_tags: ['work', 'work'], hide: true },
      },
      ctxOf()
    );
    expect(r.conditions[0]).toEqual({ field: 'name', op: 'starts_with', value: 'SQ *Coffee' });
    expect(r.conditions[1]).toEqual({ field: 'amount', op: 'between', value: 5, value2: 20.005, direction: 'out' });
    expect(r.actions).toEqual({ set_name: 'Coffee', add_tags: ['work'], hide: true });
  });

  const refused: [string, unknown, string, number?][] = [
    ['no conditions', { conditions: [], actions: ok.actions }, 'Add at least one condition'],
    ['too many conditions', { conditions: Array(MAX_CONDITIONS + 1).fill(ok.conditions[0]), actions: ok.actions }, `at most ${MAX_CONDITIONS} conditions`],
    ['an unknown field', { conditions: [{ field: 'memo', op: 'equals', value: 'x' }], actions: ok.actions }, 'A condition is on'],
    ['a regular expression op', { conditions: [{ field: 'name', op: 'matches', value: '.*' }], actions: ok.actions }, 'contains, equals or starts with'],
    ['blank text', { conditions: [{ field: 'name', op: 'contains', value: '   ' }], actions: ok.actions }, 'Say what the name should match'],
    ['long text', { conditions: [{ field: 'name', op: 'contains', value: 'x'.repeat(101) }], actions: ok.actions }, 'at most 100 characters'],
    ['a negative amount', { conditions: [{ field: 'amount', op: 'gt', value: -5 }], actions: ok.actions }, 'never negative'],
    ['between the wrong way round', { conditions: [{ field: 'amount', op: 'between', value: 9, value2: 2 }], actions: ok.actions }, 'the first amount is the smaller'],
    ['a second amount without between', { conditions: [{ field: 'amount', op: 'gt', value: 9, value2: 20 }], actions: ok.actions }, 'Only between'],
    ['a direction that isn’t one', { conditions: [{ field: 'amount', op: 'gt', value: 9, direction: 'up' }], actions: ok.actions }, 'money out, money in'],
    ['an unknown source', { conditions: [{ field: 'source', op: 'equals', value: 'mint' }], actions: ok.actions }, 'A source is one of'],
    ['no action', { conditions: ok.conditions, actions: {} }, 'Say what the rule does'],
    ['a category that isn’t one', { conditions: ok.conditions, actions: { set_category: 'nope' } }, 'That category no longer exists', 404],
    ['a provisional category', { conditions: ok.conditions, actions: { set_category: 'new:abc' } }, 'That category no longer exists', 404],
    ['a tag that isn’t one', { conditions: ok.conditions, actions: { add_tags: ['gone'] } }, 'That tag no longer exists', 404],
    ['hide that isn’t true', { conditions: ok.conditions, actions: { hide: 'yes' } }, 'Say whether the rule hides'],
    ['a long name', { conditions: ok.conditions, actions: { set_name: 'x'.repeat(101) } }, 'at most 100 characters'],
  ];
  for (const [what, input, message, status = 400] of refused) {
    test(`refuses ${what}`, () => {
      try {
        checkRuleInput(input, ctxOf());
        throw new Error('not refused');
      } catch (err: any) {
        expect([err.name, err.status, err.message]).toEqual(['RuleError', status, expect.stringContaining(message)]);
      }
    });
  }
});

describe('the stored shape is closed', () => {
  const rule = setOf([{ conditions: [{ field: 'name', op: 'contains', value: 'amzn' }], actions: { hide: true } }]).rules[0];
  const with_ = (r: Record<string, unknown>) => ({ version: 1, rules: [r] });

  test('what this release wrote reads', () => {
    expect(isRuleSet(with_(rule))).toBe(true);
  });

  test('a condition, an action or a field it doesn’t know reads as unrecognised, never half applied', () => {
    expect(isRuleSet(with_({ ...rule, conditions: [{ field: 'memo', op: 'contains', value: 'x' }] }))).toBe(false);
    expect(isRuleSet(with_({ ...rule, conditions: [{ ...rule.conditions[0], case_sensitive: true }] }))).toBe(false);
    expect(isRuleSet(with_({ ...rule, actions: { hide: true, set_goal: 'g1' } }))).toBe(false);
    expect(isRuleSet(with_({ ...rule, apply_to_pending: false }))).toBe(false);
    expect(isRuleSet({ version: 2, rules: [] })).toBe(false);
    expect(isRuleSet({ version: 1, rules: [], later: 1 })).toBe(false);
  });

  test('every rule its own id and priority, and at least one condition', () => {
    expect(isRuleSet({ version: 1, rules: [rule, { ...rule, id: 'other' }] })).toBe(false);
    expect(isRuleSet({ version: 1, rules: [rule, { ...rule, priority: 2 }] })).toBe(false);
    expect(isRuleSet(with_({ ...rule, conditions: [] }))).toBe(false);
    // Its tags deleted, a rule may do nothing: it still reads.
    expect(isRuleSet(with_({ ...rule, actions: {} }))).toBe(true);
  });
});

describe('a tag deleted while a rule held it', () => {
  test('is shown in no rule, found by deadRuleTags, and an edit of the rule drops it rather than refuse', () => {
    const set = setOf([{ conditions: [{ field: 'name', op: 'contains', value: 'blue' }], actions: { add_tags: ['work', 'trip'], hide: true } }]);
    const live = new Set(['work', 'gift']);
    expect(withLiveTags(set.rules[0], live).actions).toEqual({ add_tags: ['work'], hide: true });
    expect(withLiveTags(set.rules[0], new Set()).actions).toEqual({ hide: true });
    expect(deadRuleTags(set, live)).toEqual(['trip']);
    const without = { ix: indexTaxonomy(base), tags: { ...TAGS, tags: TAGS.tags.filter((t) => t.id !== 'trip') } };
    const edited = editRule(set, set.rules[0].id, { conditions: [{ field: 'name', op: 'contains', value: 'blue' }], actions: { add_tags: ['work', 'trip'] } }, without);
    expect(edited.rules[0].actions).toEqual({ add_tags: ['work'] });
    // A new rule, or a tag the rule never had, is refused all the same.
    expect(() => addRule(set, { conditions: [{ field: 'name', op: 'contains', value: 'x' }], actions: { add_tags: ['trip'] } }, without, newId)).toThrow('That tag no longer exists');
    expect(() => editRule(set, set.rules[0].id, { conditions: [{ field: 'name', op: 'contains', value: 'x' }], actions: { add_tags: ['gone'] } }, without)).toThrow('That tag no longer exists');
    // A preview takes any.
    expect(checkRuleInput({ conditions: [{ field: 'name', op: 'contains', value: 'x' }], actions: { add_tags: ['gone'], hide: true } }, { ...without, had: 'any' }).actions).toEqual({ hide: true });
  });
});

describe('the order, and changing it', () => {
  test('a new rule goes first; the rest keep their order, numbered from 1', () => {
    const set = setOf([
      { conditions: [{ field: 'name', op: 'contains', value: 'a' }], actions: { hide: true } },
      { conditions: [{ field: 'name', op: 'contains', value: 'b' }], actions: { hide: true } },
    ]);
    const added = addRule(set, { conditions: [{ field: 'name', op: 'contains', value: 'c' }], actions: { hide: true } }, ctxOf(), () => 'newest');
    expect(sortedRules(added.set).map((r) => [r.priority, (r.conditions[0] as any).value])).toEqual([
      [1, 'c'],
      [2, 'a'],
      [3, 'b'],
    ]);
    const ids = sortedRules(added.set).map((r) => r.id);
    expect(sortedRules(orderRules(added.set, [ids[2], ids[0], ids[1]])).map((r) => r.id)).toEqual([ids[2], ids[0], ids[1]]);
    // A list that isn't every rule once is from a page out of date.
    for (const bad of [[ids[0], ids[1]], [ids[0], ids[0], ids[1]], [...ids, 'x'], 'nope']) expect(() => orderRules(added.set, bad)).toThrow('changed since this page loaded');
    expect(sortedRules(deleteRule(added.set, ids[0])).map((r) => r.priority)).toEqual([1, 2]);
  });

  test('editing keeps its place; turning it off keeps it; a rule gone is a 404', () => {
    const set = setOf([
      { conditions: [{ field: 'name', op: 'contains', value: 'a' }], actions: { hide: true } },
      { conditions: [{ field: 'name', op: 'contains', value: 'b' }], actions: { hide: true } },
    ]);
    const [first, second] = sortedRules(set);
    const edited = editRule(set, second.id, { conditions: [{ field: 'name', op: 'equals', value: 'bb' }], actions: { add_tags: ['work'] } }, ctxOf());
    expect(sortedRules(edited)[1]).toMatchObject({ id: second.id, priority: 2, actions: { add_tags: ['work'] }, enabled: true });
    expect(sortedRules(enableRule(edited, first.id, false))[0]).toMatchObject({ id: first.id, enabled: false, priority: 1 });
    try {
      enableRule(set, 'gone', true);
      throw new Error('not refused');
    } catch (err: any) {
      expect(err.status).toBe(404);
    }
  });

  test('at most so many rules', () => {
    let set = emptyRuleSet();
    for (let i = 0; i < MAX_RULES; i++) set = addRule(set, { conditions: [{ field: 'name', op: 'contains', value: `x${i}` }], actions: { hide: true } }, ctxOf(), newId).set;
    expect(() => addRule(set, { conditions: [{ field: 'name', op: 'contains', value: 'y' }], actions: { hide: true } }, ctxOf(), newId)).toThrow(`at most ${MAX_RULES} rules`);
  });
});

describe('what the rules that match decide', () => {
  test('the first to set a field decides it; tags come from every rule; any rule can hide', () => {
    const set = setOf([
      { conditions: [{ field: 'name', op: 'contains', value: 'blue' }], actions: { set_category: cat(base, 'restaurants'), add_tags: ['work'] } },
      { conditions: [{ field: 'name', op: 'starts_with', value: 'blue' }], actions: { set_category: cat(base, 'groceries'), set_name: 'BB', add_tags: ['trip', 'work'] } },
      { conditions: [{ field: 'amount', op: 'lt', value: 10 }], actions: { set_name: 'Small', hide: true } },
    ]);
    const o = outcome(set, subject());
    expect(o.category?.id).toBe(cat(base, 'restaurants'));
    expect(o.name?.value).toBe('BB');
    expect(o.hide).toBeDefined();
    expect(o.tags).toEqual(['work', 'trip']);
    expect(o.matched).toEqual(sortedRules(set).map((r) => r.id));
  });

  test('a rule turned off does nothing, and on again does the same as before', () => {
    const set = setOf([{ conditions: [{ field: 'name', op: 'contains', value: 'blue' }], actions: { hide: true } }]);
    const off = enableRule(set, set.rules[0].id, false);
    expect(outcome(off, subject()).matched).toEqual([]);
    expect(outcome(enableRule(off, set.rules[0].id, true), subject()).hide).toBeDefined();
  });

  test('each condition: names in any case, sizes and directions, accounts, institutions, categories and sources', () => {
    const one = (condition: unknown, s: Partial<RuleSubject>) => outcome(setOf([{ conditions: [condition], actions: { hide: true } }]), subject(s)).matched.length === 1;
    // A name: the shown one, the bank's under a rename, or the merchant behind a processor.
    expect(one({ field: 'name', op: 'contains', value: 'BOTTLE' }, {})).toBe(true);
    expect(one({ field: 'name', op: 'equals', value: 'blue bottle' }, { names: ['coffee place', 'blue bottle'] })).toBe(true);
    expect(one({ field: 'name', op: 'equals', value: 'blue' }, {})).toBe(false);
    expect(one({ field: 'name', op: 'starts_with', value: 'bottle' }, {})).toBe(false);
    // Sizes, Plaid's sign: money out is positive.
    expect(one({ field: 'amount', op: 'gt', value: 100 }, { amount: 150 })).toBe(true);
    expect(one({ field: 'amount', op: 'gt', value: 100 }, { amount: -150 })).toBe(true);
    expect(one({ field: 'amount', op: 'gt', value: 100, direction: 'out' }, { amount: -150 })).toBe(false);
    expect(one({ field: 'amount', op: 'gt', value: 100, direction: 'in' }, { amount: -150 })).toBe(true);
    expect(one({ field: 'amount', op: 'gt', value: 100 }, { amount: 100 })).toBe(false);
    expect(one({ field: 'amount', op: 'lt', value: 20, direction: 'out' }, { amount: -5 })).toBe(false);
    expect(one({ field: 'amount', op: 'between', value: 10, value2: 20 }, { amount: 20 })).toBe(true);
    expect(one({ field: 'amount', op: 'between', value: 10, value2: 20 }, { amount: 10 })).toBe(true);
    expect(one({ field: 'amount', op: 'between', value: 10, value2: 20 }, { amount: 20.01 })).toBe(false);
    expect(one({ field: 'account', op: 'equals', value: 'acc_1' }, {})).toBe(true);
    expect(one({ field: 'account', op: 'equals', value: 'acc_2' }, {})).toBe(false);
    expect(one({ field: 'institution', op: 'equals', value: 'CHASE' }, {})).toBe(true);
    expect(one({ field: 'category', op: 'equals', value: cat(base, 'coffee') }, {})).toBe(true);
    expect(one({ field: 'source', op: 'equals', value: 'import' }, { source: 'import' })).toBe(true);
    expect(one({ field: 'source', op: 'equals', value: 'manual' }, {})).toBe(false);
  });

  test('every condition must match', () => {
    const set = setOf([{ conditions: [{ field: 'name', op: 'contains', value: 'blue' }, { field: 'amount', op: 'gt', value: 50 }], actions: { hide: true } }]);
    expect(outcome(set, subject({ amount: 5 })).matched).toEqual([]);
    expect(outcome(set, subject({ amount: 55 })).matched).toHaveLength(1);
  });

  test('an account follows the links from an earlier account to the one it became', () => {
    const set = setOf([{ conditions: [{ field: 'account', op: 'equals', value: 'acc_old' }], actions: { hide: true } }]);
    const ix = indexTaxonomy(base);
    const links = new Map([['acc_old', 'acc_new']]);
    const account = (id: string) => links.get(id) ?? id;
    const compiled = compileRules(set, { ix, liveTags: new Set(), account });
    expect(evaluateRules(compiled, subject({ account: 'acc_new' }), ix).matched).toHaveLength(1);
  });
});

describe('ids, not names: renames, merges and deletions', () => {
  const coffee = cat(base, 'coffee');
  const rule = { conditions: [{ field: 'category', op: 'equals', value: coffee }], actions: { set_category: cat(base, 'restaurants') } };

  test('a category renamed is the same category', () => {
    const renamed = renameCategory(base, coffee, 'Café');
    const set = setOf([rule]);
    expect(outcome(set, subject(), renamed).category?.id).toBe(cat(base, 'restaurants'));
    expect(ruleSentence(set.rules[0], { ix: indexTaxonomy(renamed), tags: TAGS })).toBe('If category is Café: file under Restaurants.');
  });

  test('a category merged is followed to where it went', () => {
    const merged = mergeCategories(base, coffee, cat(base, 'groceries'));
    const set = setOf([rule]);
    // The row is filed under groceries now: the rule on coffee follows it there.
    expect(outcome(set, subject({ category: cat(base, 'groceries') }), merged).category?.id).toBe(cat(base, 'restaurants'));
    expect(ruleProblem(set.rules[0], indexTaxonomy(merged))).toBeNull();
  });

  test('a category deleted leaves the rule broken: it does nothing, never re-pointed, and says so', () => {
    const { taxonomy: withMine, category: mine } = addCategory(base, { name: 'Pet food', group: base.groups[1].id }, () => 'mine');
    const set = setOf([{ conditions: [{ field: 'name', op: 'contains', value: 'blue' }], actions: { set_category: mine.id, add_tags: ['work'] } }], withMine);
    const gone = deleteCategory(withMine, mine.id, { transactions: 0, budget: false, rules: 0 });
    expect(ruleProblem(set.rules[0], indexTaxonomy(gone))).toContain('was deleted');
    // Not even its tags: a broken rule does nothing at all.
    expect(outcome(set, subject(), gone)).toEqual({ tags: [], matched: [] });
    expect(ruleSentence(set.rules[0], { ix: indexTaxonomy(gone), tags: TAGS })).toBe('If name contains “blue”: file under a deleted category, tag work.');
  });

  test('deleting a category a rule names is refused, and says what to do', () => {
    const { taxonomy: withMine, category: mine } = addCategory(base, { name: 'Pet food', group: base.groups[1].id }, () => 'mine');
    expect(() => deleteCategory(withMine, mine.id, { transactions: 0, budget: false, rules: 2 })).toThrow('Pet food is used by 2 rules, so it can\'t be deleted. Change those rules first');
    expect(() => deleteCategory(withMine, mine.id, { transactions: 3, budget: false, rules: 1 })).toThrow('Pet food is used by 3 transactions and 1 rule');
  });

  test('a tag deleted comes out of every rule; one left adding nothing does nothing', () => {
    const set = setOf([{ conditions: [{ field: 'name', op: 'contains', value: 'blue' }], actions: { add_tags: ['work'] } }]);
    const swept = withoutTags(set, ['work']);
    expect(swept.rules[0].actions).toEqual({});
    expect(isRuleSet(swept)).toBe(true);
    expect(outcome(swept, subject()).matched).toEqual([]);
    expect(ruleSentence(swept.rules[0], { ix: indexTaxonomy(base), tags: TAGS })).toBe('If name contains “blue”: nothing (its tags were deleted).');
  });
});

describe('applied to rows, under what the person says on each', () => {
  const ix = indexTaxonomy(base);
  const liveTags = new Set(TAGS.tags.map((t) => t.id));
  const row = (id: string, over: Record<string, unknown> = {}): any => ({
    transaction_id: id,
    date: '2026-09-02',
    name: 'Blue Bottle',
    amount: 5,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Chase',
    category: 'coffee',
    iso_currency_code: 'USD',
    transaction_code: null,
    counterparty: null,
    account_ref: 'acc_1',
    ...over,
  });
  const run = (rows: any[], rules: unknown[], records: Record<string, unknown> = {}, unknown: string[] = []) => {
    applyLayers(rows, {
      records: new Map(Object.entries(records)) as any,
      unknown: new Set(unknown),
      tags: TAGS,
      rules: compileRules(setOf(rules), { ix, liveTags }),
      ix,
    });
    return rows;
  };
  const everything = { conditions: [{ field: 'name', op: 'contains', value: 'blue' }], actions: { set_category: cat(base, 'restaurants'), set_name: 'BB', add_tags: ['work'], hide: true } };

  test('a choice made on one row beats every rule: a category, a rename, a tag taken off, an include', () => {
    const [mine, renamed, untagged, included, carried, plain] = run(
      [
        row('t_mine', { category: 'groceries', category_set: true }),
        row('t_renamed', { name: 'My coffee', renamed_from: 'Blue Bottle' }),
        row('t_untagged'),
        row('t_included'),
        row('t_carried', { carried: { excluded: false, tags: ['gift'] } }),
        row('t_plain'),
      ],
      [everything],
      { t_untagged: { untagged: ['work'], updated_at: '2026-10-01T00:00:00.000Z' }, t_included: { excluded: false, updated_at: '2026-10-01T00:00:00.000Z' } }
    );
    expect(mine.rule_category).toBeUndefined();
    expect(mine.category).toBe('groceries');
    expect(renamed.name).toBe('My coffee'); // matched by the bank's name under it, renamed all the same
    expect(renamed.rule_ids).toHaveLength(1);
    expect(untagged.tags).toBeUndefined();
    expect(included.excluded).toBeUndefined();
    expect(carried.excluded).toBeUndefined();
    expect(carried.tags).toEqual(['work', 'gift']);
    expect(plain).toMatchObject({ name: 'BB', rule_category: cat(base, 'restaurants'), category: 'restaurants', tags: ['work'], excluded: true, excluded_by_rule: true });
  });

  test('a hide is the exclude flag under the person’s: excluded by hand stays theirs, unknown stays unknown', () => {
    const [byHand, unknownRow] = run([row('t_hand'), row('t_unknown')], [{ conditions: everything.conditions, actions: { hide: true } }], {
      t_hand: { excluded: true, updated_at: '2026-10-01T00:00:00.000Z' },
    }, ['t_unknown']);
    expect([byHand.excluded, byHand.excluded_by_rule]).toEqual([true, undefined]);
    expect(unknownRow.excluded).toBeNull();
  });

  test('a row entered by hand keeps its name and its category; one without a category takes the rule’s, marked as a rule’s, and its tags', () => {
    const [own, none] = run(
      [row('manual-txn:a', { source: 'manual', category: 'groceries', account_ref: undefined, account_id: 'manual_x', note: 'mine' }), row('manual-txn:b', { source: 'manual', category: null })],
      [everything]
    );
    expect([own.name, own.category, own.rule_category, own.note, own.category_by_rule, own.name_before_rules]).toEqual(['Blue Bottle', 'groceries', undefined, 'mine', undefined, undefined]);
    expect(own.tags).toEqual(['work']);
    expect([none.name, none.rule_category, none.tags, none.category_by_rule]).toEqual(['Blue Bottle', cat(base, 'restaurants'), ['work'], true]);
  });

  test('an imported or SimpleFIN row takes a rule’s name over the name it came with, never over one the person gave it', () => {
    const [csv, simplefin, named, later] = run(
      [
        row('manual-txn:c', { source: 'import:csv', category: null }),
        row('manual-txn:d', { source: 'simplefin', category: null }),
        row('manual-txn:e', { source: 'import:ofx', own_name: true }),
        // A source this release doesn't know keeps its name.
        row('manual-txn:f', { source: 'otherapp' }),
      ],
      [everything]
    );
    expect([csv.name, csv.name_before_rules]).toEqual(['BB', 'Blue Bottle']);
    expect([simplefin.name, simplefin.name_before_rules]).toEqual(['BB', 'Blue Bottle']);
    expect([named.name, named.name_before_rules, 'own_name' in named]).toEqual(['Blue Bottle', undefined, false]);
    expect(later.name).toBe('Blue Bottle');
    // A bank row a rule named says what it was named before, which rules match.
    const [bank] = run([row('t_bank')], [everything]);
    expect([bank.name, bank.name_before_rules, bank.category_by_rule]).toEqual(['BB', 'Blue Bottle', true]);
  });

  test('a category condition reads the category before any rule: rules never chain', () => {
    const [t] = run(
      [row('t1')],
      [
        { conditions: [{ field: 'name', op: 'contains', value: 'blue' }], actions: { set_category: cat(base, 'travel') } },
        { conditions: [{ field: 'category', op: 'equals', value: cat(base, 'travel') }], actions: { hide: true } },
      ]
    );
    expect(t.rule_category).toBe(cat(base, 'travel'));
    expect(t.excluded).toBeUndefined();
  });

  test('totals after rules and tags: one currency, nothing counted twice, tags agreeing with categories', () => {
    const rows = run(
      [
        row('a', { amount: 40 }),
        row('b', { amount: 60, name: 'Blue Apron' }),
        row('c', { amount: 7, name: 'Hidden one' }),
        row('d', { amount: 30, iso_currency_code: 'EUR' }),
        row('e', { amount: 15, name: 'Plain' }),
      ],
      [
        { conditions: [{ field: 'name', op: 'contains', value: 'blue' }], actions: { set_category: cat(base, 'restaurants'), add_tags: ['work'] } },
        { conditions: [{ field: 'name', op: 'equals', value: 'hidden one' }], actions: { hide: true, add_tags: ['work'] } },
      ]
    );
    // Filed as the app files them (lib/category-store.ts fileRows).
    for (const r of rows) r.category_id = r.rule_category ?? cat(base, 'coffee');
    const s = summarize(rows, () => true, 'USD');
    expect(s.money_out).toBe(115);
    expect(s.excluded).toBe(1);
    expect(s.categories.map((c) => [c.category, c.spent])).toEqual([
      ['restaurants', 100],
      ['coffee', 15],
    ]);
    // The work tag is exactly the restaurants its rule filed, in USD: not the hidden row, not the euros.
    expect(spendingByTag(rows, () => true, 'USD')).toEqual([{ tag: 'work', spent: 100, transactions: 2 }]);
  });
});

describe('fast enough to run on every read', () => {
  test('a hundred rules over five thousand transactions', () => {
    const ix = indexTaxonomy(base);
    const words = ['amzn', 'uber', 'blue bottle', 'whole foods', 'shell', 'netflix', 'spotify', 'delta', 'airbnb', 'target'];
    const inputs = Array.from({ length: 100 }, (_, i) => ({
      conditions: [
        { field: 'name', op: i % 3 === 0 ? 'starts_with' : 'contains', value: `${words[i % words.length]}${i >= 10 ? ` ${i}` : ''}` },
        ...(i % 4 === 0 ? [{ field: 'amount', op: 'gt', value: i, direction: 'out' }] : []),
        ...(i % 5 === 0 ? [{ field: 'institution', op: 'equals', value: 'chase' }] : []),
      ],
      actions: i % 2 === 0 ? { set_category: cat(base, 'shopping'), add_tags: ['work'] } : { set_name: `Merchant ${i}`, hide: i % 7 === 0 ? true : undefined },
    }));
    const rules = compileRules(setOf(inputs), { ix, liveTags: new Set(['work']) });
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      transaction_id: `t${i}`,
      date: '2026-09-02',
      name: `${words[i % words.length].toUpperCase()} ${i % 150} STORE #${i}`,
      amount: (i % 200) - 20,
      pending: false,
      account_name: 'Checking',
      institution_name: i % 2 ? 'Chase' : 'Ally',
      category: 'shopping',
      iso_currency_code: 'USD',
      transaction_code: null,
      counterparty: i % 9 === 0 ? 'Square' : null,
      account_ref: 'acc_1',
    })) as any[];
    // Warmed up first, as a server is after its first request, then measured.
    applyLayers(rows.slice(0, 200).map((r) => ({ ...r })), { records: new Map(), unknown: new Set(), tags: TAGS, rules, ix });
    const started = performance.now();
    applyLayers(rows, { records: new Map(), unknown: new Set(), tags: TAGS, rules, ix });
    const ms = performance.now() - started;
    // Measured at about 60 ms when this was written; the bound leaves five
    // times that for a slow CI, and catches anything that makes it far slower.
    expect(ms).toBeLessThan(300);
    expect(rows.filter((r) => r.rule_ids).length).toBeGreaterThan(1000);
  });
});
