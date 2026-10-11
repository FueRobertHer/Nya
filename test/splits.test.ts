import { describe, expect, test } from 'bun:test';
import { checkParts, isSplitRecord, SplitError, MAX_PARTS, type SplitRecord } from '@/lib/splits';
import { checkMembers, isTxnGroup, GroupError, type TxnGroup } from '@/lib/groups';
import { bankRows, expandSplitsAndGroups, parentOf, unitScale, PART_PREFIX, REMAINDER_PREFIX, GROUP_PREFIX, type SplitInputs } from '@/lib/split-rows';
import { indexTaxonomy, mergeCategories, seedTaxonomy, textKeys, type Taxonomy } from '@/lib/categories';
import { summarize, spendingByCategory } from '@/lib/totals';
import { leftOutByCurrency, leftOutText, countsInTotals } from '@/lib/spending';
import { detectRecurring } from '@/lib/recurring';
import { spendingByTag } from '@/lib/tag-totals';
import type { Txn } from '@/lib/transactions';
import { splitMemoOf } from '@/lib/export-splits';
import { appendixSplitWords } from '@/lib/report/words';

// Splits and groups (#39), the pure part: what a split may hold
// (lib/splits.ts checkParts and its closed shape), what a group may hold
// (lib/groups.ts), and how the read layer applies them (lib/split-rows.ts):
// a split transaction as its parts, a group's transactions as its net, every
// total counting those and nothing twice, and each transaction put back
// whole for what reads it whole.

let n = 0;
const taxonomy: Taxonomy = seedTaxonomy(textKeys(['groceries', 'household', 'auto', 'restaurants', 'utilities']), () => `c${++n}`);
const ix = indexTaxonomy(taxonomy);
const cat = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;
const kindOf = (id: string) => taxonomy.groups.find((g) => g.id === taxonomy.categories.find((c) => c.id === id)!.group)!.kind;

/** A row as the read layer has it once filed, before splits and groups. */
function row(id: string, over: Partial<Txn> = {}): Txn {
  const category = over.category_id ?? cat('general merchandise');
  const c = taxonomy.categories.find((x) => x.id === category)!;
  return {
    transaction_id: id,
    date: '2026-10-05',
    name: 'Costco',
    amount: 150,
    pending: false,
    account_name: 'Card',
    account_type: 'credit',
    institution_name: 'Chase',
    category: c.provider_keys.find((k) => k.provider === 'text')!.key,
    category_id: category,
    category_name: c.name,
    category_kind: kindOf(category),
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    vendor_key: 'mid:costco',
    logo_url: 'https://logo.example/costco.png',
    category_icon_url: null,
    subcategory: 'superstores',
    category_confidence: 'HIGH',
    transaction_code: null,
    payment_channel: 'in store',
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: 'Seattle',
    region: 'WA',
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
    ...over,
  };
}

const split = (amount: number, parts: { id: string; amount: number; category: string; note?: string; excluded?: true }[], currency: string | null = 'USD'): SplitRecord => ({
  version: 1,
  amount,
  currency,
  parts: parts.map((p) => ({ id: p.id, amount: p.amount, category_id: cat(p.category), ...(p.note ? { note: p.note } : {}), ...(p.excluded ? { excluded: true as const } : {}) })),
  updated_at: '2026-10-06T10:00:00.000Z',
});

const group = (members: string[], over: Partial<TxnGroup> = {}): TxnGroup => ({
  version: 1,
  name: 'Dinner with Sam',
  category_id: cat('restaurants'),
  members,
  date: '2026-10-03',
  currency: 'USD',
  created_at: '2026-10-06T10:00:00.000Z',
  updated_at: '2026-10-06T10:00:00.000Z',
  ...over,
});

const inputs = (over: Partial<SplitInputs> = {}): SplitInputs => ({ splits: new Map(), splitsUnknown: new Set(), groups: new Map(), groupsUnknown: 0, ix, ...over });
const october = (d: string) => d.startsWith('2026-10');

describe('what a split may hold (checkParts)', () => {
  const costco = { amount: 150, currency: 'USD', pending: false };
  let k = 0;
  const id = () => `new-${++k}`;

  test('parts that add up to the amount in cents, each with a category, are taken; ids kept or made', () => {
    const parts = checkParts(
      [
        { id: 'keep-me', amount: 100.01, category_id: cat('groceries') },
        { amount: 49.99, category_id: cat('household'), note: '  paper towels  ' },
      ],
      costco,
      id
    );
    expect(parts).toEqual([
      { id: 'keep-me', amount: 100.01, category_id: cat('groceries') },
      { id: expect.stringMatching(/^new-/), amount: 49.99, category_id: cat('household'), note: 'paper towels' },
    ]);
  });

  test('a cent short or over is refused, saying by how much', () => {
    const short = () => checkParts([{ amount: 100, category_id: cat('groceries') }, { amount: 49.99, category_id: cat('household') }], costco, id);
    expect(short).toThrow('The parts add up to 149.99, not the transaction’s 150.00: 0.01 is left over.');
    const over = () => checkParts([{ amount: 100, category_id: cat('groceries') }, { amount: 50.01, category_id: cat('household') }], costco, id);
    expect(over).toThrow('0.01 too much');
  });

  test('floating-point noise never refuses parts that add up (0.1 + 0.2)', () => {
    expect(checkParts([{ amount: 0.1, category_id: cat('groceries') }, { amount: 0.2, category_id: cat('household') }], { amount: 0.3, currency: 'USD', pending: false }, id)).toHaveLength(2);
  });

  test('finer than the currency’s minor unit is refused: cents in dollars, whole yen', () => {
    expect(() => checkParts([{ amount: 100.005, category_id: cat('groceries') }, { amount: 49.995, category_id: cat('household') }], costco, id)).toThrow(
      'can’t be finer than 0.01'
    );
    const yen = { amount: 3000, currency: 'JPY', pending: false };
    expect(() => checkParts([{ amount: 1000.5, category_id: cat('groceries') }, { amount: 1999.5, category_id: cat('household') }], yen, id)).toThrow('finer than 1');
    expect(checkParts([{ amount: 1000, category_id: cat('groceries') }, { amount: 2000, category_id: cat('household') }], yen, id)).toHaveLength(2);
  });

  test('eight places for a currency without an ISO code: every valid split taken, at any size, a ninth place refused', () => {
    let refused = 0;
    let tried = 0;
    for (let whole = 1; whole < 200_000; whole = Math.ceil(whole * 1.37) + 1) {
      for (const frac of [0.12345678, 0.00000001, 0.5, 0.99999999, 0.31415926]) {
        const amount = Number((whole + frac).toFixed(8));
        const a = Number((amount / 3).toFixed(8));
        const b = Number((amount - a).toFixed(8));
        tried++;
        try {
          checkParts([{ amount: a, category_id: cat('groceries') }, { amount: b, category_id: cat('household') }], { amount, currency: 'BTC', pending: false }, id);
        } catch {
          refused++;
        }
      }
    }
    expect(tried).toBeGreaterThan(100);
    expect(refused).toBe(0);
    const btc = { amount: 233.5, currency: 'BTC', pending: false };
    expect(checkParts([{ amount: 77.83333333, category_id: cat('groceries') }, { amount: 155.66666667, category_id: cat('household') }], btc, id).map((p) => p.amount)).toEqual([
      77.83333333, 155.66666667,
    ]);
    expect(() =>
      checkParts([{ amount: 77.833333331, category_id: cat('groceries') }, { amount: 155.666666669, category_id: cat('household') }], btc, id)
    ).toThrow('can’t be finer than 0.00000001');
  });

  test('each part has the transaction’s own sign: money in splits into money in', () => {
    expect(() => checkParts([{ amount: 200, category_id: cat('groceries') }, { amount: -50, category_id: cat('household') }], costco, id)).toThrow(
      'Each part of money out is money out too.'
    );
    const refund = { amount: -40, currency: 'USD', pending: false };
    expect(checkParts([{ amount: -30, category_id: cat('groceries') }, { amount: -10, category_id: cat('household') }], refund, id).map((p) => p.amount)).toEqual([-30, -10]);
  });

  test('a pending transaction is refused (409): it gets a new id when it posts', () => {
    let caught: unknown;
    try {
      checkParts([{ amount: 100, category_id: cat('groceries') }, { amount: 50, category_id: cat('household') }], { ...costco, pending: true }, id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SplitError);
    expect((caught as SplitError).status).toBe(409);
    expect((caught as SplitError).message).toContain('pending');
  });

  test('too few or too many parts, a part of nothing, a transaction of nothing, a part without a category', () => {
    expect(() => checkParts([{ amount: 150, category_id: cat('groceries') }], costco, id)).toThrow('at least 2 parts');
    const many = Array.from({ length: MAX_PARTS + 1 }, () => ({ amount: 1, category_id: cat('groceries') }));
    expect(() => checkParts(many, { amount: MAX_PARTS + 1, currency: 'USD', pending: false }, id)).toThrow(`at most ${MAX_PARTS} parts`);
    expect(() => checkParts([{ amount: 150, category_id: cat('groceries') }, { amount: 0, category_id: cat('household') }], costco, id)).toThrow('can’t be nothing');
    expect(() => checkParts([{ amount: 1, category_id: cat('groceries') }, { amount: -1, category_id: cat('household') }], { amount: 0, currency: 'USD', pending: false }, id)).toThrow(
      'nothing can’t be split'
    );
    expect(() => checkParts([{ amount: 100 }, { amount: 50, category_id: cat('household') }], costco, id)).toThrow('Choose a category');
    expect(() => checkParts('two parts', costco, id)).toThrow('Say what the parts are.');
  });

  test('a part id given twice keeps the first; notes are checked', () => {
    const parts = checkParts([{ id: 'same', amount: 100, category_id: cat('groceries') }, { id: 'same', amount: 50, category_id: cat('household') }], costco, id);
    expect(parts[0].id).toBe('same');
    expect(parts[1].id).not.toBe('same');
    expect(() => checkParts([{ amount: 100, category_id: cat('groceries'), note: 'x'.repeat(501) }, { amount: 50, category_id: cat('household') }], costco, id)).toThrow('at most 500');
    expect(() => checkParts([{ amount: 100, category_id: cat('groceries'), note: 'a\u0007b' }, { amount: 50, category_id: cat('household') }], costco, id)).toThrow('control');
  });
});

describe('the stored shape is closed', () => {
  const good = split(150, [
    { id: 'a', amount: 100, category: 'groceries', note: 'food' },
    { id: 'b', amount: 50, category: 'household', excluded: true },
  ]);
  test('the current shape reads', () => {
    expect(isSplitRecord(good)).toBe(true);
    expect(isTxnGroup(group(['t1', 't2']))).toBe(true);
  });
  test('a field this release doesn’t know, at any level, is unrecognised', () => {
    expect(isSplitRecord({ ...good, reviewed: true })).toBe(false);
    expect(isSplitRecord({ ...good, parts: [{ ...good.parts[0], tax: 1 }, good.parts[1]] })).toBe(false);
    expect(isSplitRecord({ ...good, version: 2 })).toBe(false);
    expect(isSplitRecord({ ...good, parts: [good.parts[0], { ...good.parts[1], id: 'a' }] })).toBe(false);
    expect(isSplitRecord({ ...good, currency: 'us dollars' })).toBe(false);
    expect(isSplitRecord({ ...good, parts: [{ ...good.parts[0], amount: 0 }, good.parts[1]] })).toBe(false);
    expect(isTxnGroup({ ...group(['t1', 't2']), note: 'x' })).toBe(false);
    expect(isTxnGroup({ ...group(['t1', 't1']) })).toBe(false);
    expect(isTxnGroup({ ...group(['t1', 't2']), removed: 0 })).toBe(false);
  });
});

describe('a split transaction is its parts, in its place', () => {
  const costco = row('t_costco', { tags: ['tag-trip'], rule_ids: ['rule-1'], note: 'the big shop' });
  const coffee = row('t_coffee', { name: 'Blue Bottle', amount: 5, date: '2026-10-07', category_id: cat('food and drink') });
  const record = split(150, [
    { id: 'p1', amount: 100.01, category: 'groceries', note: 'food' },
    { id: 'p2', amount: 30, category: 'household' },
    { id: 'p3', amount: 19.99, category: 'auto' },
  ]);
  const out = expandSplitsAndGroups([coffee, costco], inputs({ splits: new Map([['t_costco', record]]) }));

  test('each part carries the transaction’s date, merchant, account, currency, tags and rules, and its own amount, category and note', () => {
    expect(out.notes).toEqual([]);
    expect(out.rows.map((t) => t.transaction_id)).toEqual(['t_coffee', `${PART_PREFIX}p1`, `${PART_PREFIX}p2`, `${PART_PREFIX}p3`]);
    const [, p1, p2] = out.rows;
    expect(p1).toMatchObject({
      date: '2026-10-05',
      name: 'Costco',
      account_name: 'Card',
      institution_name: 'Chase',
      iso_currency_code: 'USD',
      amount: 100.01,
      category: 'groceries',
      category_id: cat('groceries'),
      category_name: 'groceries',
      category_kind: 'expense',
      category_confidence: null,
      note: 'food',
      tags: ['tag-trip'],
      rule_ids: ['rule-1'],
      split_of: 't_costco',
      split_index: 0,
      split_count: 3,
    });
    expect(p2.note).toBeUndefined();
    expect(p2.split_parent).toMatchObject({ amount: 150, category_id: cat('general merchandise'), note: 'the big shop' });
  });

  test('a month’s total spend is unchanged, to the cent; only its spread across categories moves', () => {
    const before = summarize([coffee, costco], october, 'USD');
    const after = summarize(out.rows, october, 'USD');
    expect(after.money_out).toBe(before.money_out);
    expect(after.money_out).toBe(155);
    expect(after.net).toBe(before.net);
    expect(spendingByCategory(out.rows, october, 'USD')).toEqual({ [cat('food and drink')]: 5, [cat('groceries')]: 100.01, [cat('household')]: 30, [cat('auto')]: 19.99 });
    expect(spendingByCategory([coffee, costco], october, 'USD')).toEqual({ [cat('food and drink')]: 5, [cat('general merchandise')]: 150 });
  });

  test('a split in another currency is left out of the totals and named once, as one transaction', () => {
    const euro = row('t_euro', { amount: 80, iso_currency_code: 'EUR', name: 'Paris' });
    const rows = expandSplitsAndGroups([coffee, costco, euro], inputs({ splits: new Map([['t_costco', record], ['t_euro', split(80, [{ id: 'e1', amount: 50, category: 'restaurants' }, { id: 'e2', amount: 30, category: 'household' }], 'EUR')]]) })).rows;
    expect(rows.filter((t) => t.split_of === 't_euro')).toHaveLength(2);
    const s = summarize(rows, october, 'USD');
    expect(s.money_out).toBe(155);
    expect(s.left_out).toEqual([{ currency: 'EUR', count: 1 }]);
    expect(leftOutText(leftOutByCurrency(rows, 'USD'), 'USD')).toBe("1 transaction in EUR isn't in these totals, which are in USD.");
  });

  test('spending by tag counts each part once, the whole transaction in all', () => {
    const tagged = spendingByTag(out.rows, october, 'USD');
    expect(tagged.find((t) => t.tag === 'tag-trip')).toEqual({ tag: 'tag-trip', spent: 150, transactions: 3 });
  });

  test('put back whole (bankRows), the transaction is exactly as it was, with its parts beside it', () => {
    const whole = bankRows(out.rows);
    expect(whole.map((t) => t.transaction_id)).toEqual(['t_coffee', 't_costco']);
    const { split_parts, ...back } = whole[1];
    expect(back).toEqual(costco);
    expect(split_parts!.map((p) => p.amount)).toEqual([100.01, 30, 19.99]);
    expect(parentOf(out.rows[1])).toEqual(costco);
  });

  test('unsplit (no split stored) shows the rows exactly as they came', () => {
    const rows = [coffee, costco];
    expect(expandSplitsAndGroups(rows, inputs()).rows).toEqual(rows);
  });

  test('a manual row (its note null) and one SimpleFIN brought are split the same way, and put back exactly', () => {
    const typed = row('manual-txn:aaaa-bbbb-cccc', { source: 'manual', account_id: 'manual_x', note: null, vendor_key: 'nm:cash::market' });
    const fed = row('manual-txn:dddd-eeee-ffff', { source: 'simplefin', account_id: 'manual_y', note: null });
    const imported = row('manual-txn:1111-2222-3333', { source: 'import:ofx', account_id: 'manual_z', note: 'from the file' });
    const records = new Map(
      [typed, fed, imported].map((t, i) => [t.transaction_id, split(150, [{ id: `m${i}a`, amount: 75, category: 'groceries' }, { id: `m${i}b`, amount: 75, category: 'household' }])] as const)
    );
    const rows = expandSplitsAndGroups([typed, fed, imported], inputs({ splits: records })).rows;
    expect(rows).toHaveLength(6);
    expect(rows.every((t) => t.account_id?.startsWith('manual_') && t.source)).toBe(true);
    expect(bankRows(rows).map(({ split_parts, ...t }) => t)).toEqual([typed, fed, imported]);
  });
});

describe('what the transaction’s own layers do to its parts', () => {
  const record = split(150, [
    { id: 'p1', amount: 100, category: 'groceries' },
    { id: 'p2', amount: 50, category: 'household' },
  ]);
  const parts = (t: Txn, r: SplitRecord = record) => expandSplitsAndGroups([t], inputs({ splits: new Map([[t.transaction_id, r]]) })).rows;

  test('excluded by the person: every part is out of the totals', () => {
    const out = parts(row('t1', { excluded: true }));
    expect(out.map((t) => t.excluded)).toEqual([true, true]);
    expect(out.every((t) => !countsInTotals(t, 'USD'))).toBe(true);
    expect(parentOf(out[0]).excluded).toBe(true);
  });

  test('hidden by a rule: every part is hidden by it, marked so', () => {
    const out = parts(row('t1', { excluded: true, excluded_by_rule: true }));
    expect(out.map((t) => [t.excluded, t.excluded_by_rule])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  test('whether it is excluded can’t be read: every part counts, marked so', () => {
    expect(parts(row('t1', { excluded: null })).map((t) => t.excluded)).toEqual([null, null]);
  });

  test('a part left out on its own is out; the rest count, and the transaction is not excluded', () => {
    const out = parts(row('t1'), split(150, [{ id: 'p1', amount: 100, category: 'groceries' }, { id: 'p2', amount: 50, category: 'household', excluded: true }]));
    expect(out.map((t) => [t.excluded, t.split_excluded])).toEqual([
      [undefined, undefined],
      [true, true],
    ]);
    expect(summarize(out, october, 'USD').money_out).toBe(100);
    expect(parentOf(out[1]).excluded).toBeUndefined();
  });

  test('a rule’s category never lands on a part: the person chose each one', () => {
    const ruled = row('t1', { category_id: cat('auto'), category: 'auto', category_name: 'auto', category_by_rule: true });
    const out = parts(ruled);
    expect(out.map((t) => [t.category_id, t.category_by_rule])).toEqual([
      [cat('groceries'), undefined],
      [cat('household'), undefined],
    ]);
    expect(parentOf(out[0])).toEqual(ruled);
  });

  test('a part’s category merged into another is filed where it went', () => {
    const merged = indexTaxonomy(mergeCategories(taxonomy, cat('household'), cat('groceries')));
    const out = expandSplitsAndGroups([row('t1')], { ...inputs({ splits: new Map([['t1', record]]) }), ix: merged }).rows;
    expect(out.map((t) => t.category_id)).toEqual([cat('groceries'), cat('groceries')]);
  });

  test('a part under a category no longer there is uncategorized, with a note', () => {
    const gone = { ...record, parts: [record.parts[0], { ...record.parts[1], category_id: 'deleted-category' }] };
    const out = expandSplitsAndGroups([row('t1')], inputs({ splits: new Map([['t1', gone]]) }));
    expect(out.rows[1]).toMatchObject({ category: null, category_id: taxonomy.uncategorized, category_name: null, amount: 50 });
    expect(out.notes).toEqual(['1 part of your split transactions is under a category that no longer exists, so it is uncategorized: edit the split to choose one.']);
  });
});

describe('the bank changes a split transaction’s amount', () => {
  const record = split(50, [
    { id: 'p1', amount: 40, category: 'restaurants' },
    { id: 'p2', amount: 10, category: 'household' },
  ]);

  test('the difference is a part of its own, last, in the transaction’s own category, marked, so the total is the bank’s', () => {
    const tipped = row('t1', { amount: 60, name: 'Bistro' });
    const out = expandSplitsAndGroups([tipped], inputs({ splits: new Map([['t1', record]]) }));
    expect(out.rows.map((t) => [t.transaction_id, t.amount, t.category_id, t.split_index, t.split_count])).toEqual([
      [`${PART_PREFIX}p1`, 40, cat('restaurants'), 0, 3],
      [`${PART_PREFIX}p2`, 10, cat('household'), 1, 3],
      [`${REMAINDER_PREFIX}t1`, 10, cat('general merchandise'), 2, 3],
    ]);
    expect(out.rows[2].split_remainder).toEqual({ was: 50 });
    expect(summarize(out.rows, october, 'USD').money_out).toBe(60);
    // Whole again, it is what the bank says now.
    expect(bankRows(out.rows)[0].amount).toBe(60);
  });

  test('down, or to nothing, the remainder takes it back: never a total that disagrees with the bank', () => {
    for (const now of [45.5, 0, -50]) {
      const out = expandSplitsAndGroups([row('t1', { amount: now })], inputs({ splits: new Map([['t1', record]]) }));
      const sum = out.rows.reduce((s, t) => s + Math.round(t.amount * 100), 0) / 100;
      expect(sum).toBe(now);
    }
  });

  test('a rule’s category on the transaction files its remainder', () => {
    const ruled = row('t1', { amount: 60, category_id: cat('auto'), category: 'auto', category_name: 'auto', category_by_rule: true });
    const rest = expandSplitsAndGroups([ruled], inputs({ splits: new Map([['t1', record]]) })).rows[2];
    expect(rest).toMatchObject({ category_id: cat('auto'), category_by_rule: true });
  });

  test('an OFX statement’s memo says which way the bank changed it', () => {
    const memo = (amount: number) => splitMemoOf({ id: 't1', amount, currency: 'USD' }, inputs({ splits: new Map([['t1', record]]) }));
    expect(memo(50)).toBe('Split in Nya: Restaurants 40.00; Household 10.00');
    expect(memo(60)).toBe('Split in Nya: Restaurants 40.00; Household 10.00; the bank added 10.00 since');
    expect(memo(45.5)).toBe('Split in Nya: Restaurants 40.00; Household 10.00; the bank took 4.50 off since');
    // Money in grows the same way: a refund of 50 that is now 60.
    const refund = split(-50, [
      { id: 'p1', amount: -40, category: 'restaurants' },
      { id: 'p2', amount: -10, category: 'household' },
    ]);
    expect(splitMemoOf({ id: 't1', amount: -60, currency: 'USD' }, inputs({ splits: new Map([['t1', refund]]) }))).toBe(
      'Split in Nya: Restaurants 40.00; Household 10.00; the bank added 10.00 since'
    );
    // One entered by hand or imported changes when it is edited, not by the bank.
    expect(splitMemoOf({ id: 't1', amount: 60, currency: 'USD', bank: false }, inputs({ splits: new Map([['t1', record]]) }))).toBe(
      'Split in Nya: Restaurants 40.00; Household 10.00; 10.00 added since'
    );
    expect(splitMemoOf({ id: 't1', amount: 45.5, currency: 'USD', bank: false }, inputs({ splits: new Map([['t1', record]]) }))).toBe(
      'Split in Nya: Restaurants 40.00; Household 10.00; 4.50 taken off since'
    );
    // Pending, or in another currency now: whole, so nothing to say.
    expect(splitMemoOf({ id: 't1', amount: 50, currency: 'USD', pending: true }, inputs({ splits: new Map([['t1', record]]) }))).toBeNull();
    expect(splitMemoOf({ id: 't1', amount: 50, currency: 'EUR' }, inputs({ splits: new Map([['t1', record]]) }))).toBeNull();
  });
});

describe('what a report’s appendix says of a part or a group', () => {
  const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;
  test('a part, what changed since, and a group’s net', () => {
    expect(appendixSplitWords({ split: { part: 1, parts: 3, whole: 150, remainder: false } }, money)).toBe('Part 1 of 3 of a $150.00 transaction');
    expect(appendixSplitWords({ source: 'plaid', split: { part: 3, parts: 3, whole: 160, remainder: true } }, money)).toBe(
      'What the bank changed this $160.00 transaction by since it was split'
    );
    expect(appendixSplitWords({ source: 'simplefin', split: { part: 3, parts: 3, whole: 160, remainder: true } }, money)).toContain('What the bank changed');
    expect(appendixSplitWords({ source: 'manual', split: { part: 3, parts: 3, whole: 160, remainder: true } }, money)).toBe(
      'What this $160.00 transaction changed by since it was split'
    );
    expect(appendixSplitWords({ group: { transactions: 2, missing: 1 } }, money)).toBe('The net of a group of 2 transactions; 1 more isn’t here');
    expect(appendixSplitWords({}, money)).toBeNull();
  });
});

describe('a split that can’t be applied shows its transaction whole', () => {
  const record = split(150, [
    { id: 'p1', amount: 100, category: 'groceries' },
    { id: 'p2', amount: 50, category: 'household' },
  ]);

  test('one that couldn’t be read: whole, marked, with a note', () => {
    const out = expandSplitsAndGroups([row('t1')], inputs({ splitsUnknown: new Set(['t1']) }));
    expect(out.rows).toEqual([{ ...row('t1'), split_unread: true }]);
    expect(out.notes).toEqual(['How you split 1 transaction couldn’t be read, so it shows whole until it can be.']);
  });

  test('one whose transaction is in another currency now: whole, marked, with a note', () => {
    const out = expandSplitsAndGroups([row('t1', { iso_currency_code: 'CAD' })], inputs({ splits: new Map([['t1', record]]) }));
    expect(out.rows[0]).toMatchObject({ transaction_id: 't1', split_unapplied: 'currency' });
    expect(out.notes[0]).toContain('in another currency now');
  });

  test('one on a pending row is never applied', () => {
    const out = expandSplitsAndGroups([row('t1', { pending: true })], inputs({ splits: new Map([['t1', record]]) }));
    expect(out.rows).toEqual([row('t1', { pending: true })]);
  });
});

describe('groups net their transactions', () => {
  const dinner = row('t_dinner', { name: 'Bistro', amount: 120, date: '2026-10-03', category_id: cat('food and drink'), tags: ['tag-b'] });
  const venmo = row('t_venmo', { name: 'Venmo from Sam', amount: -60, date: '2026-10-10', account_name: 'Checking', account_type: 'depository', category_id: cat('transfer in'), tags: ['tag-a'] });
  const coffee = row('t_coffee', { name: 'Blue Bottle', amount: 5, date: '2026-10-07', category_id: cat('food and drink') });

  test('a $120 dinner and $60 paid back count once, as $60 in the group’s category, the two listed inside it', () => {
    const out = expandSplitsAndGroups([venmo, coffee, dinner], inputs({ groups: new Map([['g1', group(['t_dinner', 't_venmo'])]]), orderTags: (ids) => ['tag-a', 'tag-b'].filter((t) => ids.has(t)) }));
    expect(out.notes).toEqual([]);
    expect(out.rows.map((t) => t.transaction_id)).toEqual(['t_coffee', `${GROUP_PREFIX}g1`]);
    const g = out.rows[1];
    expect(g).toMatchObject({
      date: '2026-10-03',
      name: 'Dinner with Sam',
      amount: 60,
      category_id: cat('restaurants'),
      category_kind: 'expense',
      account_name: 'Card',
      group_id: 'g1',
      tags: ['tag-a', 'tag-b'],
      pending: false,
    });
    expect(g.group_members!.map((t) => [t.transaction_id, t.amount, t.group_id])).toEqual([
      ['t_dinner', 120, 'g1'],
      ['t_venmo', -60, 'g1'],
    ]);
    const s = summarize(out.rows, october, 'USD');
    expect([s.money_out, s.money_in]).toEqual([65, 0]);
    expect(spendingByCategory(out.rows, october, 'USD')).toEqual({ [cat('food and drink')]: 5, [cat('restaurants')]: 60 });
    // Each transaction once again, for what reads them whole.
    expect(bankRows(out.rows).map((t) => t.transaction_id)).toEqual(['t_coffee', 't_dinner', 't_venmo']);
  });

  test('a trip and its reimbursement net to nothing, and count nothing', () => {
    const flight = row('t_flight', { name: 'Airline', amount: 500.25, date: '2026-10-01' });
    const back = row('t_back', { name: 'Employer reimbursement', amount: -500.25, date: '2026-10-20', category_id: cat('income') });
    const out = expandSplitsAndGroups([back, flight], inputs({ groups: new Map([['g1', group(['t_flight', 't_back'], { date: '2026-10-01', name: 'Work trip' })]]) }));
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].amount).toBe(0);
    const s = summarize(out.rows, october, 'USD');
    expect([s.money_out, s.money_in]).toEqual([0, 0]);
  });

  test('what was said about one of its transactions doesn’t change the net: grouping says how they count', () => {
    const hidden = { ...venmo, excluded: true, excluded_by_rule: true } as Txn;
    const out = expandSplitsAndGroups([hidden, dinner], inputs({ groups: new Map([['g1', group(['t_dinner', 't_venmo'])]]) }));
    expect(out.rows[0].amount).toBe(60);
    expect(out.rows[0].excluded).toBeUndefined();
  });

  test('a transaction that isn’t here (removed, hidden, not loaded) is left out of the net, and counted', () => {
    const out = expandSplitsAndGroups([dinner], inputs({ groups: new Map([['g1', group(['t_dinner', 't_venmo'], { removed: 1 })]]) }));
    expect(out.rows[0]).toMatchObject({ amount: 120, group_missing: 1, group_removed: 1 });
  });

  test('a group none of whose transactions are here shows nothing', () => {
    expect(expandSplitsAndGroups([coffee], inputs({ groups: new Map([['g1', group(['t_dinner', 't_venmo'])]]) })).rows).toEqual([coffee]);
  });

  test('transactions in more than one currency now count on their own, with a note', () => {
    const euro = { ...venmo, iso_currency_code: 'EUR' } as Txn;
    const out = expandSplitsAndGroups([euro, dinner], inputs({ groups: new Map([['g1', group(['t_dinner', 't_venmo'])]]) }));
    expect(out.rows.map((t) => t.transaction_id)).toEqual(['t_venmo', 't_dinner']);
    expect(out.notes).toEqual(['The transactions in 1 of your groups are in more than one currency now, so they count on their own: a group nets one currency.']);
  });

  test('a transaction in two groups counts in the one made first; one also split counts whole in its group', () => {
    const first = group(['t_dinner', 't_venmo'], { created_at: '2026-10-01T00:00:00.000Z' });
    const second = group(['t_venmo', 't_coffee'], { name: 'Coffee', created_at: '2026-10-02T00:00:00.000Z' });
    const out = expandSplitsAndGroups(
      [venmo, coffee, dinner],
      inputs({ groups: new Map([['g2', second], ['g1', first]]), splits: new Map([['t_dinner', split(120, [{ id: 'd1', amount: 100, category: 'restaurants' }, { id: 'd2', amount: 20, category: 'household' }])]]) })
    );
    const g1 = out.rows.find((t) => t.group_id === 'g1')!;
    const g2 = out.rows.find((t) => t.group_id === 'g2')!;
    expect([g1.amount, g2.amount, g2.group_missing]).toEqual([60, 5, 1]);
    expect(out.rows.some((t) => t.split_of)).toBe(false);
    expect(out.notes).toEqual(['1 transaction in a group is split too, so its parts aren’t used: the group counts it whole.']);
  });

  test('groups that couldn’t be read leave their transactions on their own, with a note', () => {
    const out = expandSplitsAndGroups([coffee], inputs({ groupsUnknown: 2 }));
    expect(out.rows).toEqual([coffee]);
    expect(out.notes).toEqual(['2 of your groups couldn’t be read, so their transactions count on their own until they can be.']);
  });
});

describe('what a group may hold (checkMembers)', () => {
  const m = (id: string, date: string, currency: string | null = 'USD', pending = false) => ({ transaction_id: id, date, currency, pending, amount: 10 });
  test('two or more posted transactions in one currency, dated by the earliest', () => {
    expect(checkMembers([m('a', '2026-10-09'), m('b', '2026-10-02')])).toEqual({ date: '2026-10-02', currency: 'USD' });
  });
  test('refused: one alone, pending, mixed currencies, more than a year apart', () => {
    expect(() => checkMembers([m('a', '2026-10-09')])).toThrow('at least 2');
    expect(() => checkMembers([m('a', '2026-10-09'), m('b', '2026-10-02', 'USD', true)])).toThrow(GroupError);
    expect(() => checkMembers([m('a', '2026-10-09'), m('b', '2026-10-02', 'EUR')])).toThrow('more than one currency (USD, EUR)');
    expect(() => checkMembers([m('a', '2025-01-01'), m('b', '2026-10-02')])).toThrow('within 366 days');
  });
});

describe('recurring detection reads whole transactions', () => {
  test('a monthly bill split in two each month is the same bill, at its whole amount', () => {
    const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
    const bills = months.map((m, i) => row(`t_bill${i}`, { name: 'City Utilities', amount: 100, date: `${m}-15`, category_id: cat('rent and utilities'), account_type: 'depository' }));
    const records = new Map(bills.map((b, i) => [b.transaction_id, split(100, [{ id: `u${i}a`, amount: 60, category: 'utilities' }, { id: `u${i}b`, amount: 40, category: 'household' }])] as const));
    const expanded = expandSplitsAndGroups(bills, inputs({ splits: records })).rows;
    expect(expanded).toHaveLength(12);
    const before = detectRecurring(bills);
    const after = detectRecurring(expanded);
    expect(before).toHaveLength(1);
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ amount: 100, cadence: 'monthly', name: 'City Utilities' });
  });
});

describe('amounts are counted in whole units of their currency', () => {
  test('cents, yen, three places, and eight for a currency without an ISO code', () => {
    expect([unitScale('USD'), unitScale('JPY'), unitScale('KWD'), unitScale('BTC'), unitScale(null)]).toEqual([100, 1, 1000, 1e8, 100]);
  });
});
