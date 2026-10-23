import { describe, expect, test } from 'bun:test';
import { applyLayers } from '@/lib/txn-layers';
import { fileRows } from '@/lib/category-store';
import { indexTaxonomy, mergeCategories, deleteCategory } from '@/lib/categories';
import { compileRules, type RuleSet } from '@/lib/rules';
import { approvalIdsOf, approvalInputOf, countToReview, needsReview, reviewable, reviewLayerOf, sameAmount, type ReviewLayer } from '@/lib/review-layer';
import { expandSplitsAndGroups, bankRows } from '@/lib/split-rows';
import type { Approval } from '@/lib/review-store';
import type { OlderTxn, Txn } from '@/lib/transactions';
import { categoriesFor } from './category-fixture';

// The review queue and merchants' defaults on read (lib/review-layer.ts),
// through the read layer's own function (lib/txn-layers.ts applyLayers) and
// the filing after it: what needs review on the day the queue starts and
// after; an approval that holds, and one the bank's new amount undoes; an
// approved transaction never moved by a rule, a default or the bank, only
// offered another; the order of the person's own category, an approval, a
// rule, a default and the bank's; a pending row's and an imported row's
// approval carried to the posted bank row; what can't be read never taken for
// "needs review"; and counting transactions, not rows.

const { taxonomy } = categoriesFor({}, { words: ['groceries', 'household', 'auto'] });
const ix = indexTaxonomy(taxonomy);
const cat = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;
const SINCE = '2026-10-10';

const row = (id: string, over: Partial<Txn> = {}): Txn => ({
  transaction_id: id,
  date: SINCE,
  name: 'Costco',
  amount: 54.2,
  pending: false,
  account_name: 'Card',
  institution_name: 'Chase',
  category: 'general merchandise',
  pfc_primary: 'GENERAL_MERCHANDISE',
  pfc_detailed: null,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  vendor_key: 'nm:chase::costco',
  logo_url: null,
  category_icon_url: null,
  subcategory: null,
  category_confidence: null,
  transaction_code: null,
  payment_channel: null,
  datetime: null,
  website: null,
  check_number: null,
  account_owner: null,
  city: null,
  region: null,
  counterparty: null,
  payment_processor: null,
  payment_reference: null,
  ...over,
});

const approval = (over: Partial<Approval> = {}): Approval => ({
  version: 1,
  approved_at: '2026-10-11T09:00:00.000Z',
  amount: 54.2,
  currency: 'USD',
  category_id: cat('general merchandise'),
  name: 'Costco',
  ...over,
});

const layer = (over: Partial<ReviewLayer> = {}): ReviewLayer => ({ approvals: new Map(), approvalsUnknown: new Set(), defaults: new Map(), queue: { since: SINCE }, ...over });

const ruleSet = (set_category: string, set_name?: string): RuleSet => ({
  version: 1,
  rules: [
    {
      id: 'rule-1',
      enabled: true,
      priority: 1,
      conditions: [{ field: 'name', op: 'contains', value: 'costco' }],
      actions: { set_category, ...(set_name ? { set_name } : {}) },
      created_at: '2026-10-12T00:00:00.000Z',
      updated_at: '2026-10-12T00:00:00.000Z',
    },
  ],
});

/** The read layer's order: the layers, then filing (lib/activity.ts). */
function read<T extends Txn | OlderTxn>(rows: T[], review: ReviewLayer, rules?: RuleSet, ixUsed = ix): T[] {
  applyLayers(rows, { records: new Map(), unknown: new Set(), tags: null, rules: rules ? compileRules(rules, { ix: ixUsed, liveTags: new Set() }) : undefined, ix: ixUsed, review });
  fileRows(ixUsed, rows);
  return rows;
}

describe('what needs review', () => {
  test('on the day the queue starts: nothing dated before it, whatever arrives; from it on, what the bank, SimpleFIN or a file brings', () => {
    const rows = read(
      [
        row('t_old', { date: '2026-10-09' }),
        row('t_new'),
        row('t_pending', { pending: true }),
        row('t_simplefin', { source: 'simplefin', vendor_key: '' }),
        row('t_imported_manual', { source: 'import:ofx', vendor_key: '' }),
        row('imported-txn:abc', { source: 'import:csv' }),
        row('t_typed', { source: 'manual', vendor_key: '' }),
        row('t_later', { date: '2026-11-02' }),
      ],
      layer()
    );
    expect(rows.map((t) => [t.transaction_id, t.needs_review ?? false])).toEqual([
      ['t_old', false],
      ['t_new', true],
      ['t_pending', true],
      ['t_simplefin', true],
      ['t_imported_manual', true],
      ['imported-txn:abc', true],
      ['t_typed', false],
      ['t_later', true],
    ]);
  });

  test('with the queue off nothing is marked, and an approval still holds what it holds', () => {
    const [t] = read([row('t1')], layer({ queue: null, approvals: new Map([['t1', approval()]]) }), ruleSet(cat('household')));
    expect(t.needs_review).toBeUndefined();
    expect(t.reviewed_at).toBe('2026-10-11T09:00:00.000Z');
    expect(t.category_name).toBe('general merchandise');
  });

  test('a transaction entered by hand never needs review, nor does a group’s row', () => {
    expect(reviewable({ source: 'manual' })).toBe(false);
    expect(reviewable({ group_members: [] })).toBe(false);
    expect(reviewable({})).toBe(true);
    expect(reviewable({ source: 'simplefin' })).toBe(true);
    expect(reviewable({ source: 'import:qif' })).toBe(true);
  });
});

describe('an approval', () => {
  test('holds while the amount and currency are what was approved, to the minor unit', () => {
    const [kept, cent, other] = read(
      [row('t1'), row('t2', { amount: 54.21 }), row('t3', { iso_currency_code: 'CAD' })],
      layer({ approvals: new Map([['t1', approval()], ['t2', approval()], ['t3', approval()]]) })
    );
    expect([kept.reviewed_at, kept.needs_review, kept.review_changed]).toEqual(['2026-10-11T09:00:00.000Z', undefined, undefined]);
    // The bank changed it since: back in the queue, saying from what.
    expect([cent.reviewed_at, cent.needs_review, cent.review_changed]).toEqual([undefined, true, { amount: 54.2, currency: 'USD' }]);
    expect([other.needs_review, other.review_changed]).toEqual([true, { amount: 54.2, currency: 'USD' }]);
    // Whole yen: a float that rounds to the same unit is the same amount.
    expect(sameAmount({ amount: 1200, currency: 'JPY' }, { amount: 1200.0000001, iso_currency_code: 'JPY', unofficial_currency_code: null })).toBe(true);
    expect(sameAmount({ amount: 12.3, currency: null }, { amount: 12.3, iso_currency_code: null, unofficial_currency_code: null })).toBe(true);
  });

  test('a rule added later never moves an approved transaction: it stays where it was approved, the rule’s category offered', () => {
    const [approved, open] = read([row('t1'), row('t2')], layer({ approvals: new Map([['t1', approval()]]) }), ruleSet(cat('household')));
    expect([approved.category_name, approved.category_by_rule, approved.review_suggestion]).toEqual([
      'general merchandise',
      undefined,
      { category_id: cat('household'), by: 'rule', rule_id: 'rule-1' },
    ]);
    // Not approved: the rule files it, as always.
    expect([open.category_name, open.category_by_rule, open.review_suggestion]).toEqual(['household', true, undefined]);
  });

  test('a rule that agrees with what was approved offers nothing; a rule’s name shows, with the name it was approved under', () => {
    const [t] = read([row('t1')], layer({ approvals: new Map([['t1', approval({ category_id: cat('household') })]]) }), ruleSet(cat('household'), 'Costco Wholesale'));
    expect([t.category_name, t.category_by_rule, t.review_suggestion]).toEqual(['household', true, undefined]);
    expect([t.name, t.approved_name]).toEqual(['Costco Wholesale', 'Costco']);
  });

  test('the person’s own category always shows, approved or not', () => {
    const [t] = read([row('t1', { category: 'groceries', category_set: true })], layer({ approvals: new Map([['t1', approval()]]) }), ruleSet(cat('household')));
    expect([t.category_name, t.review_suggestion, t.reviewed_at]).toEqual(['groceries', undefined, '2026-10-11T09:00:00.000Z']);
  });

  test('the bank’s new category, or a rule taken away, never moves it either', () => {
    // Approved while a rule filed it under household; the rule is gone now.
    const [t] = read([row('t1')], layer({ approvals: new Map([['t1', approval({ category_id: cat('household') })]]) }));
    expect([t.category_name, t.review_suggestion]).toEqual(['household', { category_id: cat('general merchandise'), by: 'bank' }]);
  });

  test('its category followed through a merge; one deleted since holds nothing', () => {
    const merged = indexTaxonomy(mergeCategories(taxonomy, cat('household'), cat('auto')));
    const [t] = read([row('t1')], layer({ approvals: new Map([['t1', approval({ category_id: cat('household') })]]) }), undefined, merged);
    expect(t.category_id).toBe(cat('auto'));
    const gone = indexTaxonomy(deleteCategory(taxonomy, cat('groceries'), { transactions: 0, budget: false }));
    const [u] = read([row('t2')], layer({ approvals: new Map([['t2', approval({ category_id: cat('groceries') })]]) }), undefined, gone);
    expect([u.category_name, u.review_suggestion, u.reviewed_at]).toEqual(['general merchandise', undefined, '2026-10-11T09:00:00.000Z']);
  });

  test('a posted row carries the approval of the pending one it replaced, and a bank row that of the imported row it stands for', () => {
    const [posted, standing, pendingStanding] = read(
      [
        row('t_posted', { pending_from: 't_pend' }),
        row('t_bank', { stands_for: ['imported-txn:x'] }),
        row('t_bank_pending', { pending: true, stands_for: ['imported-txn:y'] }),
      ],
      layer({ approvals: new Map([['t_pend', approval({ pending: true })], ['imported-txn:x', approval()], ['imported-txn:y', approval()]]) })
    );
    expect([posted.reviewed_at, posted.review_via, posted.needs_review]).toEqual(['2026-10-11T09:00:00.000Z', 't_pend', undefined]);
    expect([standing.reviewed_at, standing.review_via]).toEqual(['2026-10-11T09:00:00.000Z', 'imported-txn:x']);
    // A pending bank row takes nothing of the rows it stands in for until it posts.
    expect([pendingStanding.reviewed_at, pendingStanding.needs_review]).toEqual([undefined, true]);
    // The fact that carried it is never sent.
    expect('pending_from' in posted).toBe(false);
    expect(approvalIdsOf([row('a', { pending_from: 'p' }), row('b', { stands_for: ['i1'] }), row('c', { pending: true, stands_for: ['i2'] })])).toEqual(['a', 'p', 'b', 'i1', 'c']);
  });

  test('a pending row approved at one amount that posts at another is back in the queue, saying so', () => {
    const [t] = read([row('t_posted', { pending_from: 't_pend', amount: 64.2 })], layer({ approvals: new Map([['t_pend', approval({ pending: true })]]) }));
    expect([t.needs_review, t.review_changed]).toEqual([true, { amount: 54.2, currency: 'USD' }]);
  });

  test('a new amount from the bank never takes the category it was approved under: back in the queue, still there, the other still offered', () => {
    // Held against a rule made later, then the bank adds a dollar.
    const [held] = read([row('t1', { amount: 55.2 })], layer({ approvals: new Map([['t1', approval()]]) }), ruleSet(cat('household')));
    expect([held.category_name, held.category_by_rule, held.needs_review, held.review_changed, held.review_suggestion]).toEqual([
      'general merchandise',
      undefined,
      true,
      { amount: 54.2, currency: 'USD' },
      { category_id: cat('household'), by: 'rule', rule_id: 'rule-1' },
    ]);
    expect(held.reviewed_at).toBeUndefined();
    // A pending dinner recategorized and approved, posted with a tip: the
    // category chosen stays, though the bank still says general merchandise.
    const [dinner] = read(
      [row('t_dinner', { pending_from: 'p_dinner', amount: 60, name: 'SQ *NOPALITO' })],
      layer({ approvals: new Map([['p_dinner', approval({ amount: 50, category_id: cat('groceries'), pending: true, name: 'SQ *NOPALITO' })]]) })
    );
    expect([dinner.category_name, dinner.needs_review, dinner.review_changed, dinner.review_via, dinner.review_suggestion]).toEqual([
      'groceries',
      true,
      { amount: 50, currency: 'USD' },
      'p_dinner',
      { category_id: cat('general merchandise'), by: 'bank' },
    ]);
    // A split one's difference, a part of its own, is filed where it was approved too.
    const [split] = read([row('t_split', { amount: 110 })], layer({ approvals: new Map([['t_split', approval({ amount: 100, category_id: cat('auto') })]]) }));
    const { rows } = expandSplitsAndGroups([split], {
      splits: new Map([
        ['t_split', { version: 1, amount: 100, currency: 'USD', parts: [{ id: 'p1', amount: 60, category_id: cat('groceries') }, { id: 'p2', amount: 40, category_id: cat('household') }], updated_at: '2026-10-11T00:00:00.000Z' }],
      ]),
      splitsUnknown: new Set(),
      groups: new Map(),
      groupsUnknown: 0,
      ix,
    });
    const rest = rows.find((t) => t.split_remainder)!;
    expect([rest.amount, rest.category_id]).toEqual([10, cat('auto')]);
  });

  test('approved with no category, it takes the one a rule or a default gives it later: that fills an empty place', () => {
    const none = { ...row('t1'), category: null, pfc_primary: null } as unknown as Txn;
    const uncategorized = approval({ category_id: taxonomy.uncategorized });
    const [ruled] = read([none], layer({ approvals: new Map([['t1', uncategorized]]) }), ruleSet(cat('household')));
    expect([ruled.category_name, ruled.category_by_rule, ruled.review_suggestion, ruled.reviewed_at]).toEqual(['household', true, undefined, '2026-10-11T09:00:00.000Z']);
    const [byDefault] = read(
      [{ ...none, transaction_id: 't2' } as Txn],
      layer({ approvals: new Map([['t2', uncategorized]]), defaults: new Map([['nm:chase::costco', { id: 'v1', category_id: cat('groceries'), since: SINCE, agree: 2 }]]) })
    );
    expect([byDefault.category_name, byDefault.filed_by_default]).toEqual(['groceries', { id: 'v1', agree: 2 }]);
  });
});

describe('what can’t be read is never taken for "needs review"', () => {
  test('an approval that can’t be read leaves the review not known, and its category as everything else files it', () => {
    const [t] = read([row('t1')], layer({ approvalsUnknown: new Set(['t1']) }), ruleSet(cat('household')));
    expect([t.needs_review, t.review_unknown, t.category_name]).toEqual([undefined, true, 'household']);
  });

  test('settings that can’t be read mark nothing to review; an approval that reads still holds', () => {
    const [open, approved, typed] = read([row('t1'), row('t2'), row('t3', { source: 'manual', vendor_key: '' })], layer({ queue: 'unknown', approvals: new Map([['t2', approval()]]) }));
    expect([open.needs_review, open.review_unknown]).toEqual([undefined, true]);
    expect([approved.reviewed_at, approved.review_unknown]).toEqual(['2026-10-11T09:00:00.000Z', undefined]);
    expect(typed.review_unknown).toBeUndefined();
  });

  test('the notes say which, and only the queue’s settings stay out of what changes a total', () => {
    const built = reviewLayerOf({ settings: null, settingsUnread: true, defaults: null, defaultsUnread: true, approvals: new Map(), approvalsUnknown: new Set(['a', 'b']) }, ix);
    expect(built.layer.queue).toBe('unknown');
    expect(built.notes).toEqual([
      'Your merchants’ default categories couldn’t be read, so none files a transaction until they can be.',
      'Your approval of 2 transactions couldn’t be read, so they show as the bank, your rules and your defaults file them now, and whether they need review isn’t known, until they can be.',
    ]);
    expect(built.queueNote).toBe('Your review queue’s settings couldn’t be read, so nothing is marked to review until they can be.');
  });
});

describe('a merchant’s default, in its place', () => {
  const defaults = new Map([['nm:chase::costco', { id: 'v1', category_id: cat('groceries'), since: SINCE, agree: 2 }]]);

  test('files a transaction nothing else files, from the day it was set; marked, for the detail', () => {
    const [t, before] = read([row('t1'), row('t0', { date: '2026-10-09' })], layer({ defaults }));
    expect([t.category_name, t.filed_by_default, t.category_by_rule]).toEqual(['groceries', { id: 'v1', agree: 2 }, undefined]);
    expect([before.category_name, before.filed_by_default]).toEqual(['general merchandise', undefined]);
  });

  test('under a rule and the person’s own: each beats it', () => {
    const [ruled] = read([row('t1')], layer({ defaults }), ruleSet(cat('household')));
    expect([ruled.category_name, ruled.filed_by_default]).toEqual(['household', undefined]);
    const [own] = read([row('t2', { category: 'auto', category_set: true })], layer({ defaults }));
    expect([own.category_name, own.filed_by_default]).toEqual(['auto', undefined]);
  });

  test('over the bank’s; never on one side of a pair between SimpleFIN accounts, nor for a row with no merchant', () => {
    const [paired, none] = read([row('t1', { paired: 'transfer', source: 'simplefin' }), row('t2', { vendor_key: '' })], layer({ defaults: new Map([...defaults, ['', defaults.get('nm:chase::costco')!]]) }));
    expect(paired.filed_by_default).toBeUndefined();
    expect(none.filed_by_default).toBeUndefined();
  });

  test('a default that moved files each row by the category it had on its day: the move re-files nothing before it', () => {
    // Formed on Nov 10, 2025 under groceries, moved to household on Oct 15, 2026.
    const moved = new Map([
      ['nm:chase::costco', { id: 'v1', category_id: cat('household'), since: '2026-10-15', agree: 2, previous: [{ category_id: cat('groceries'), since: '2025-11-10', until: '2026-10-15' }] }],
    ]);
    const [jan, oct16, oct14, early] = read(
      [row('t_jan', { date: '2026-01-15' }), row('t_oct16', { date: '2026-10-16' }), row('t_oct14', { date: '2026-10-14' }), row('t_early', { date: '2025-11-09' })],
      layer({ defaults: moved })
    );
    expect([jan.category_name, jan.filed_by_default]).toEqual(['groceries', { id: 'v1', agree: 2, earlier: true }]);
    expect([oct14.category_name, oct14.filed_by_default]).toEqual(['groceries', { id: 'v1', agree: 2, earlier: true }]);
    expect([oct16.category_name, oct16.filed_by_default]).toEqual(['household', { id: 'v1', agree: 2 }]);
    // Before it first formed: never filed by it.
    expect([early.category_name, early.filed_by_default]).toEqual(['general merchandise', undefined]);
  });

  test('an approved transaction stays where it was approved, the default offered', () => {
    const [t] = read([row('t1')], layer({ defaults, approvals: new Map([['t1', approval()]]) }));
    expect([t.category_name, t.filed_by_default, t.review_suggestion]).toEqual(['general merchandise', undefined, { category_id: cat('groceries'), by: 'default' }]);
  });

  test('a row from before the year, for recurring detection, is filed by it too, and marked nothing', () => {
    const older = { ...row('t_older'), pending: undefined } as unknown as OlderTxn;
    delete (older as { pending?: boolean }).pending;
    const [t] = read([older], layer({ defaults }));
    expect(t.category_id).toBe(cat('groceries'));
    expect((t as Txn).filed_by_default).toBeUndefined();
    expect((t as Txn).needs_review).toBeUndefined();
  });
});

describe('counting and listing', () => {
  test('a split transaction is one to review, however many parts; a group’s transactions each', () => {
    const split = read([row('t_split', { amount: 100 })], layer())[0];
    const a = read([row('t_a', { amount: 30 })], layer())[0];
    const b = read([row('t_b', { amount: -10 })], layer({ approvals: new Map([['t_b', approval({ amount: -10 })]]) }))[0];
    const c = read([row('t_c', { amount: 12 })], layer())[0];
    const { rows } = expandSplitsAndGroups([split, a, b, c], {
      splits: new Map([['t_split', { version: 1, amount: 100, currency: 'USD', parts: [{ id: 'p1', amount: 60, category_id: cat('groceries') }, { id: 'p2', amount: 40, category_id: cat('household') }], updated_at: '2026-10-11T00:00:00.000Z' }]]),
      splitsUnknown: new Set(),
      groups: new Map([['g1', { version: 1, name: 'Dinner', category_id: cat('groceries'), members: ['t_a', 't_b'], date: SINCE, currency: 'USD', created_at: '2026-10-11T00:00:00.000Z', updated_at: '2026-10-11T00:00:00.000Z' }]]),
      groupsUnknown: 0,
      ix,
    });
    // The parts carry the transaction's marks, and the group's row its transactions'.
    expect(rows.filter((t) => t.split_of === 't_split').every((t) => t.needs_review === true)).toBe(true);
    const group = rows.find((t) => t.group_members)!;
    expect(group.group_members!.map((m) => [m.transaction_id, m.needs_review ?? false])).toEqual([
      ['t_a', true],
      ['t_b', false],
    ]);
    expect(needsReview(group)).toBe(true);
    // Two parts, a group of one to review and one approved, and one more: three.
    expect(countToReview(rows)).toBe(3);
    // Put back whole, a split transaction is approved as itself, its own amount and category.
    const whole = bankRows(rows).find((t) => t.transaction_id === 't_split')!;
    expect(approvalInputOf(whole)).toEqual({ transaction_id: 't_split', amount: 100, currency: 'USD', category_id: cat('general merchandise'), name: 'Costco', pending: false });
  });

  test('an approval never keeps a provisional category id', () => {
    expect(approvalInputOf({ ...row('t1'), category_id: 'new:abc' }).category_id).toBeNull();
  });
});
