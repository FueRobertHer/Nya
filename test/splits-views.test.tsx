import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MonthBreakdown, { type Txn } from '@/components/MonthBreakdown';
import SplitSheet, { leftToSplit, startingParts } from '@/components/SplitSheet';
import GroupSheet, { groupCandidates } from '@/components/GroupSheet';
import { entryLabel, entryNotice } from '@/components/SplitRows';
import { searchRows } from '@/components/txn-search';
import { expandSplitsAndGroups, bankRows } from '@/lib/split-rows';
import { indexTaxonomy } from '@/lib/categories';
import { localDate } from '@/lib/local-date';
import { categoriesFor } from './category-fixture';

// Splits and groups on the Activity tab (#39): a split transaction listed
// once, as the bank has it, its parts nested under it with their categories
// and amounts, the day's figure counting the parts; a group's row with its
// transactions under it; the search finding both; the split sheet's running
// remainder, its parts adding up before it saves; and what the group sheet
// offers to add.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const { taxonomy } = categoriesFor({}, { words: ['groceries', 'household', 'auto', 'restaurants'] });
const ix = indexTaxonomy(taxonomy);
const cat = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;
const today = localDate();

const txn = (id: string, over: Partial<Txn> = {}): Txn => ({
  transaction_id: id,
  date: today,
  name: id,
  amount: 10,
  pending: false,
  account_name: 'Card',
  institution_name: 'Chase',
  category: 'general merchandise',
  category_id: cat('general merchandise'),
  category_name: 'general merchandise',
  category_kind: 'expense',
  iso_currency_code: 'USD',
  vendor_key: `v:${id}`,
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

const record = (amount: number, parts: [string, number, string?][]) => ({
  version: 1 as const,
  amount,
  currency: 'USD',
  parts: parts.map(([c, a, note], i) => ({ id: `p${i}`, amount: a, category_id: cat(c), ...(note ? { note } : {}) })),
  updated_at: '2026-10-01T00:00:00.000Z',
});

/** The rows as the server sends them: Costco split three ways, a dinner and
 *  its payback grouped. */
function served(): Txn[] {
  const rows = [
    txn('Costco', { amount: 150, note: 'monthly run' }),
    txn('Bistro', { amount: 120, date: today }),
    txn('Venmo from Sam', { amount: -60, date: today, category: 'transfer in', category_id: cat('transfer in'), category_name: 'transfer in', category_kind: 'transfer' }),
    txn('Coffee', { amount: 4.5 }),
  ];
  return expandSplitsAndGroups(rows as any, {
    splits: new Map([['Costco', record(150, [['groceries', 100.01, 'food'], ['household', 30], ['auto', 19.99]])]]),
    splitsUnknown: new Set(),
    groups: new Map([
      ['g1', { version: 1, name: 'Dinner with Sam', category_id: cat('restaurants'), members: ['Bistro', 'Venmo from Sam'], date: today, currency: 'USD', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }],
    ]),
    groupsUnknown: 0,
    ix,
  }).rows as unknown as Txn[];
}

const list = (rows: Txn[]) =>
  text(renderToStaticMarkup(<MonthBreakdown txns={rows} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} onSplitsChanged={() => {}} />));

describe('the Activity tab’s list', () => {
  test('a split transaction is listed once, its parts under it; a group’s row with its transactions under it', () => {
    const page = list(served());
    expect(page).toContain('Costco · note Chase · Card · Split into 3 -$150.00');
    expect(page.match(/Costco/g)).toHaveLength(1);
    expect(page).toContain('Groceries · food -$100.01 Household -$30.00 Auto -$19.99');
    expect(page).toContain('Dinner with Sam Chase · Card · Group of 2 · Restaurants -$60.00 Bistro');
    expect(page).toContain('Venmo from Sam');
    // The day's figure counts the parts and the net: 150 + 60 + 4.50 out.
    expect(page).toContain('-$214.50');
  });

  test('a split transaction left out of budgets is one transaction left out, however many parts it has', () => {
    const rows = served().map((t) => (t.split_of ? { ...t, excluded: true as const } : t));
    expect(list(rows)).toContain('and 1 transaction you left out');
  });

  test('the search finds a part by its transaction’s note, and a group by one of its transactions', () => {
    const rows = served();
    expect(searchRows(rows, { query: 'monthly run', tag: '' }, []).map((t) => t.split_of)).toEqual(['Costco', 'Costco', 'Costco']);
    expect(searchRows(rows, { query: 'venmo', tag: '' }, []).map((t) => t.name)).toEqual(['Dinner with Sam']);
  });

  test('what a split or a group says in place of its category, and when something changed', () => {
    const whole = bankRows(served(), { groups: 'keep' });
    expect(whole.map((t) => entryLabel(t))).toEqual(['Split into 3', null, 'Group of 2']);
    const changed = expandSplitsAndGroups([txn('Costco', { amount: 160 })] as any, {
      splits: new Map([['Costco', record(150, [['groceries', 100], ['household', 50]])]]),
      splitsUnknown: new Set(),
      groups: new Map(),
      groupsUnknown: 0,
      ix,
    }).rows as unknown as Txn[];
    expect(entryNotice(bankRows(changed)[0] as Txn)).toBe('The bank changed this amount since you split it.');
    expect(entryNotice(txn('x', { split_unread: true }))).toBe('How you split this couldn’t be read, so it shows whole.');
    expect(entryNotice(txn('x', { group_members: [txn('a')], group_removed: 1 }))).toContain('1 of its transactions isn’t here');
  });

  test('nothing is offered to split or group without somewhere to save it', () => {
    const page = renderToStaticMarkup(<MonthBreakdown txns={served()} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} />);
    expect(page).not.toContain('Split transaction');
    expect(page).not.toContain('Group transactions');
  });
});

describe('the split sheet', () => {
  test('starts from the split’s own parts, what the bank changed since left to split', () => {
    const rows = expandSplitsAndGroups([txn('Costco', { amount: 160 })] as any, {
      splits: new Map([['Costco', record(150, [['groceries', 100], ['household', 50]])]]),
      splitsUnknown: new Set(),
      groups: new Map(),
      groupsUnknown: 0,
      ix,
    }).rows as unknown as Txn[];
    const whole = bankRows(rows)[0] as Txn;
    const drafts = startingParts(whole, taxonomy.uncategorized);
    expect(drafts.map((d) => [d.id, d.amount, d.category_id])).toEqual([
      ['p0', '100.00', cat('groceries')],
      ['p1', '50.00', cat('household')],
    ]);
    expect(leftToSplit(whole.amount, drafts, 'USD').left).toBe(1000);
    const page = text(renderToStaticMarkup(<SplitSheet t={whole} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />));
    expect(page).toContain('Edit split');
    expect(page).toContain('The bank changed this amount from $150.00 to $160.00 since you split it.');
    expect(page).toContain('$10.00 left to split');
    expect(page).toContain('Unsplit');
  });

  test('a new split starts with two empty parts under the transaction’s category, and nothing saves until they add up', () => {
    const t = txn('Costco', { amount: 150 });
    const drafts = startingParts(t, taxonomy.uncategorized);
    expect(drafts.map((d) => [d.amount, d.category_id])).toEqual([
      ['', cat('general merchandise')],
      ['', cat('general merchandise')],
    ]);
    expect(leftToSplit(150, [{ amount: '100.01' }, { amount: '49,99' }], 'USD').left).toBe(0);
    expect(leftToSplit(150, [{ amount: '100' }, { amount: '' }], 'USD').left).toBe(5000);
    expect(leftToSplit(-40, [{ amount: '30' }, { amount: '20' }], 'USD').left).toBe(-1000);
    expect(leftToSplit(3000, [{ amount: '1000' }, { amount: '2000' }], 'JPY').left).toBe(0);
    const page = renderToStaticMarkup(<SplitSheet t={t} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />);
    expect(text(page)).toContain('Split transaction');
    expect(page).toMatch(/<button[^>]*disabled=""[^>]*>Save split<\/button>/);
  });
});

describe('the group sheet', () => {
  test('offers posted transactions in the same currency, as the bank has them, nearest first', () => {
    const rows = [
      ...served(),
      txn('Pending', { pending: true }),
      txn('Paris', { iso_currency_code: 'EUR' }),
      txn('Far', { date: '2025-01-01' }),
      txn('Near', { date: today }),
    ];
    const offered = groupCandidates(rows, { currency: 'USD', near: today, exclude: new Set(['Coffee']), query: '' });
    // Not the pending one, the one in euros, the one already in, Costco's
    // parts or the group's row: nearest in date first.
    expect(offered.map((t) => t.name)).toEqual(['Near', 'Far']);
    expect(groupCandidates(rows, { currency: 'USD', near: today, exclude: new Set(), query: 'far' }).map((t) => t.name)).toEqual(['Far']);
  });

  test('opened on a transaction, it starts a group with it; on a group, it edits it and offers to ungroup', () => {
    const rows = served();
    const start = text(renderToStaticMarkup(<GroupSheet start={txn('Coffee', { amount: 4.5 })} group={null} txns={rows} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />));
    expect(start).toContain('Group transactions');
    expect(start).toContain('Choose at least 2 transactions.');
    const group = rows.find((t) => t.group_members)!;
    const edit = text(renderToStaticMarkup(<GroupSheet start={null} group={group} txns={rows} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />));
    expect(edit).toContain('Edit group');
    expect(edit).toContain('2 transactions, counted as $60.00 out under Restaurants.');
    expect(edit).toContain('Ungroup');
  });
});
