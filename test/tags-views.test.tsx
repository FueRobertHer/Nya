import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MonthBreakdown, { type Txn } from '@/components/MonthBreakdown';
import TagChips from '@/components/TagChips';
import SpendByTag from '@/components/SpendByTag';
import TxnTagsNote from '@/components/TxnTagsNote';
import TagsCard from '@/components/TagsCard';
import { searchRows } from '@/components/txn-search';
import { spendingByTag } from '@/lib/tag-totals';
import { summarize } from '@/lib/totals';
import { localDate } from '@/lib/local-date';
import type { Tag } from '@/lib/tags';
import { categoriesFor } from './category-fixture';

// Tags and notes on the Activity tab (#40): chips on a row, the search that
// reads tag names and notes, the filter by tag, and spending by tag, which
// agrees with the category totals by the rule every total follows.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const at = '2026-10-01T00:00:00.000Z';
const TAGS: Tag[] = [
  { id: 'trip', name: 'Vacation 2026', color: 'blue', created_at: at },
  { id: 'work', name: 'Reimbursable', color: 'green', created_at: at },
  { id: 'gift', name: 'Gift', color: 'pink', created_at: at },
];
const today = localDate();

const txn = (id: string, over: Partial<Txn> = {}): Txn => ({
  transaction_id: id,
  date: today,
  name: id,
  amount: 10,
  pending: false,
  account_name: 'Checking',
  institution_name: 'Chase',
  category: 'food and drink',
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

describe('the search and the filter by tag', () => {
  const rows = [
    txn('Hotel Lisboa', { tags: ['trip'], amount: 300 }),
    txn('Taxi', { tags: ['trip', 'work'], note: 'Airport run, client pays' }),
    txn('Groceries', { note: null }),
    txn('Flowers', { tags: ['gift', 'deleted-meanwhile'] }),
  ];
  const names = (out: readonly Txn[]) => out.map((t) => t.name);

  test('the search reads tag names and note text, in any case', () => {
    expect(names(searchRows(rows, { query: 'vacation', tag: '' }, TAGS))).toEqual(['Hotel Lisboa', 'Taxi']);
    expect(names(searchRows(rows, { query: 'CLIENT PAYS', tag: '' }, TAGS))).toEqual(['Taxi']);
    expect(names(searchRows(rows, { query: 'reimburs', tag: '' }, TAGS))).toEqual(['Taxi']);
    // What it always read still matches.
    expect(names(searchRows(rows, { query: 'grocer', tag: '' }, TAGS))).toEqual(['Groceries']);
    // A tag no longer among the tags has no name to match.
    expect(names(searchRows(rows, { query: 'deleted', tag: '' }, TAGS))).toEqual([]);
  });

  test('the filter keeps the rows carrying the tag, and the search narrows within them', () => {
    expect(names(searchRows(rows, { query: '', tag: 'trip' }, TAGS))).toEqual(['Hotel Lisboa', 'Taxi']);
    expect(names(searchRows(rows, { query: 'taxi', tag: 'trip' }, TAGS))).toEqual(['Taxi']);
    expect(names(searchRows(rows, { query: '', tag: 'work' }, TAGS))).toEqual(['Taxi']);
  });
});

describe('spending by tag agrees with the category totals', () => {
  // Every kind of row a total leaves out, tagged.
  const rows = [
    txn('Hotel', { tags: ['trip'], amount: 300, category: 'travel' }),
    txn('Dinner', { tags: ['trip', 'work'], amount: 80, category: 'food and drink' }),
    txn('Refund', { tags: ['trip'], amount: -40, category: 'travel' }),
    txn('Transfer to savings', { tags: ['trip'], amount: 500, category: 'transfer out', transaction_code: 'transfer' }),
    txn('Excluded', { tags: ['trip'], amount: 999, excluded: true }),
    txn('Hidden by a rule', { tags: ['trip'], amount: 77, excluded: true }),
    txn('In Paris', { tags: ['trip'], amount: 50, iso_currency_code: 'EUR' }),
    txn('Unknown exclusion', { tags: ['work'], amount: 12, excluded: null }),
    txn('Untagged', { amount: 1000 }),
  ];
  const all = () => true;

  test('each tag is exactly the spending of its rows, by the rule every total follows', () => {
    const byTag = spendingByTag(rows, all, 'USD');
    expect(byTag).toEqual([
      { tag: 'trip', spent: 380, transactions: 2 },
      { tag: 'work', spent: 92, transactions: 2 },
    ]);
    for (const { tag, spent } of byTag) {
      const own = rows.filter((t) => t.tags?.includes(tag));
      const s = summarize(own, all, 'USD');
      // The tag's figure is its rows' money out, and the sum of their category totals.
      expect(spent).toBe(s.money_out);
      expect(s.categories.reduce((n, c) => n + c.spent, 0)).toBe(spent);
    }
  });

  test('a period and a currency are a total’s own; nothing in another is added', () => {
    expect(spendingByTag(rows, all, 'EUR')).toEqual([{ tag: 'trip', spent: 50, transactions: 1 }]);
    expect(spendingByTag(rows, (d) => d < '2000-01-01', 'USD')).toEqual([]);
  });

  test('the card names each tag with its spending, and says a row with two tags counts under each', () => {
    const t = text(renderToStaticMarkup(<SpendByTag txns={rows} tags={TAGS} currency="USD" />));
    expect(t).toContain('Spending by tag');
    expect(t).toContain('Vacation 2026 $380.00');
    expect(t).toContain('Reimbursable $92.00');
    expect(t).toContain('A transaction with more than one tag counts under each');
    expect(renderToStaticMarkup(<SpendByTag txns={[txn('x')]} tags={TAGS} currency="USD" />)).toBe('');
  });
});

describe('on the Activity tab', () => {
  const { taxonomy } = categoriesFor({}, { words: ['food and drink'] });

  test('a row shows its tags as chips after the merchant, and the tab offers the filter and spending by tag', () => {
    const html = renderToStaticMarkup(
      <MonthBreakdown
        txns={[txn('Taxi', { tags: ['trip', 'work'] }), txn('Groceries')]}
        notes={[]}
        loading={false}
        taxonomy={taxonomy}
        tags={TAGS}
        onRecategorize={() => {}}
        onRename={() => {}}
        onChangeTags={() => {}}
        onSaveNote={() => {}}
      />
    );
    const t = text(html);
    expect(t).toContain('Taxi Vacation 2026 Reimbursable');
    expect(html).toContain('class="tag-chip tag-blue"');
    expect(t).toContain('All tags');
    expect(t).toContain('Tagged Gift');
    expect(t).toContain('Spending by tag');
  });

  test('chips leave out an id no tag has', () => {
    expect(text(renderToStaticMarkup(<TagChips ids={['gone', 'gift']} tags={TAGS} />))).toBe('Gift');
    expect(renderToStaticMarkup(<TagChips ids={['gone']} tags={TAGS} />)).toBe('');
  });

  test('the editor waits for a pending row to post, and says tags and notes are never shared', () => {
    const props = { tags: TAGS, onChangeTags: () => {}, onSaveNote: () => {} };
    expect(text(renderToStaticMarkup(<TxnTagsNote t={{ transaction_id: 'p', name: 'Pending', pending: true }} {...props} />))).toBe(
      'Once it posts, it can be tagged and given a note.'
    );
    const t = text(renderToStaticMarkup(<TxnTagsNote t={{ transaction_id: 'x', name: 'Taxi', pending: false, tags: ['trip'], note: 'Airport' }} {...props} />));
    expect(t).toContain('Vacation 2026');
    expect(t).toContain('Tags and notes are yours: sharing never shows them.');
  });

  test('the Tags card says how many there are', () => {
    expect(text(renderToStaticMarkup(<TagsCard tags={TAGS} onChanged={() => {}} />))).toContain('3 tags.');
    expect(text(renderToStaticMarkup(<TagsCard tags={[]} onChanged={() => {}} />))).toContain('Add tags');
  });
});
