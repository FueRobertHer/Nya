import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { consideredMonths, roundUp, suggestBudgets, suggestionWords, type BudgetSuggestions } from '@/lib/budget-suggestions';
import { addMonths, gapText, type MonthGap } from '@/lib/rollover';
import { indexTaxonomy, type Taxonomy } from '@/lib/categories';
import type { TotalsRow } from '@/lib/totals';
import BudgetSuggestion from '@/components/BudgetSuggestion';
import BudgetsCard from '@/components/BudgetsCard';
import { categoriesFor } from './category-fixture';

// Budget suggestions from history (lib/budget-suggestions.ts): the trailing
// average of the last three complete months of spending, by the rule every
// total follows (one currency, exclusions and what a rule hides left out,
// transfers too), to the cent, rounded up to a round figure; only months the
// stored history reaches whole, the rest named with why, and those that may
// be incomplete named too; with rollover, still the plain average. And the
// Budgets tab's month answer that carries them, and the editor that offers
// one with a tap.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Nothing here may reach Plaid: the months are read from what is stored.
const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { ctx, txn } = await import('./api-fixture');
const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { syncsStore } = await import('@/lib/connection-records');
const { setExcluded } = await import('@/lib/txn-annotations');
const { rulesStore } = await import('@/lib/rules');
const monthRoute = await import('@/app/api/budgets/month/route');
const budgetsRoute = await import('@/app/api/budgets/route');

// ---- The arithmetic ----

const MONTH = '2026-10';
const [JUL, AUG, SEP] = consideredMonths(MONTH);
const { taxonomy } = categoriesFor({}, { words: ['groceries', 'restaurants', 'coffee'], groups: { groceries: 'Food', restaurants: 'Food', coffee: 'Food' } });
const ix = indexTaxonomy(taxonomy);
const id = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;
const groupId = (name: string) => taxonomy.groups.find((g) => g.name === name)!.id;

type Row = TotalsRow & { date: string };
let n = 0;
/** A row on a day, spending (positive, Plaid's sign) or money in, in a
 *  category's words, filed by the page's set (lib/categories.ts filedId). */
const row = (date: string, amount: number, category = 'groceries', over: Partial<Row> = {}): Row => ({
  transaction_id: `r${++n}`,
  date,
  amount,
  category,
  transaction_code: null,
  iso_currency_code: 'USD',
  excluded: false,
  ...over,
}) as Row;

const suggest = (rows: Row[], over: Partial<Parameters<typeof suggestBudgets>[0]> = {}) =>
  suggestBudgets({ month: MONTH, rows, currency: 'USD', ix, earliest: '2025-01', gaps: () => [], ...over });

const money = (n: number) => `$${n.toFixed(2)}`;
const day = (at: string) => at.slice(5).replace('-', '/');
const words = (s: BudgetSuggestions, target: { kind: 'category' | 'group'; id: string }, rolling = false) =>
  suggestionWords(s, target, { money, day, rolling, gapText: (g: MonthGap) => gapText(g, day) });

describe('the suggestion', () => {
  test('rounded up to a round figure: to the unit under 100, then a 5, a 50, a 500', () => {
    expect(roundUp(412.37)).toBe(415);
    expect(roundUp(415)).toBe(415);
    expect(roundUp(41.37)).toBe(42);
    expect(roundUp(41)).toBe(41);
    expect(roundUp(0.4)).toBe(1);
    expect(roundUp(99.2)).toBe(100);
    expect(roundUp(100.01)).toBe(105);
    expect(roundUp(999.1)).toBe(1000);
    expect(roundUp(1001)).toBe(1050);
    expect(roundUp(4123.45)).toBe(4150);
    expect(roundUp(41_234)).toBe(41_500);
    expect(roundUp(0)).toBe(0);
    // From 100 up, never more than 5% over; under it, never more than a unit.
    for (const avg of [100.01, 101, 333.33, 1234.56, 9999.99, 54_321]) expect(roundUp(avg) / avg).toBeLessThanOrEqual(1.05);
    for (const avg of [0.01, 12.34, 99.99]) expect(roundUp(avg) - avg).toBeLessThan(1);
  });

  test('the average of the last three complete months, to the cent, whatever this month or older ones hold', () => {
    const s = suggest([
      row(`${JUL}-03`, 84.12),
      row(`${JUL}-20`, 0.1),
      row(`${AUG}-11`, 100.2),
      row(`${SEP}-30`, 115.89),
      // This month, and the one before the three: not in it.
      row(`${MONTH}-02`, 900),
      row(`${addMonths(JUL, -1)}-28`, 900),
    ]);
    expect(s.months).toEqual([JUL, AUG, SEP]);
    // (84.12 + 0.10 + 100.20 + 115.89) / 3 = 100.1033...
    expect(s.categories[id('groceries')]).toEqual({ average: 100.1, amount: 105 });
    // Three months with nothing in one: it counts as nothing, not left out.
    const gap = suggest([row(`${JUL}-03`, 33.33), row(`${SEP}-03`, 33.34)]);
    expect(gap.categories[id('groceries')]).toEqual({ average: 22.22, amount: 23 });
    // Floating point adds up to the cent: 0.1 + 0.2 is 0.3.
    const tiny = suggest([row(`${JUL}-03`, 0.1), row(`${JUL}-04`, 0.2), row(`${AUG}-04`, 0.3), row(`${SEP}-04`, 0.3)]);
    expect(tiny.categories[id('groceries')].average).toBe(0.3);
    // A currency without cents averages in whole units.
    const yen = suggest([row(`${JUL}-03`, 4000, 'groceries', { iso_currency_code: 'JPY' }), row(`${AUG}-03`, 4001, 'groceries', { iso_currency_code: 'JPY' })], { currency: 'JPY' });
    expect(yen.categories[id('groceries')]).toEqual({ average: 2667, amount: 2700 });
  });

  test('a group’s is everything spent in it, by the categories in it now', () => {
    const s = suggest([row(`${JUL}-03`, 30, 'groceries'), row(`${AUG}-03`, 60, 'restaurants'), row(`${SEP}-03`, 9, 'coffee')]);
    expect(s.groups[groupId('Food')]).toEqual({ average: 33, amount: 33 });
    expect(s.categories[id('restaurants')]).toEqual({ average: 20, amount: 20 });
  });

  test('by the rule every total follows: one currency, what you excluded, what a rule hides, transfers and refunds left out', () => {
    const s = suggest([
      row(`${JUL}-03`, 90),
      // In another currency: named, never added.
      row(`${JUL}-04`, 500, 'groceries', { iso_currency_code: 'EUR' }),
      // Excluded by you, hidden by a rule.
      row(`${AUG}-04`, 400, 'groceries', { excluded: true }),
      row(`${AUG}-05`, 300, 'groceries', { excluded: true, excluded_by_rule: true } as Partial<Row>),
      // A transfer, and a refund: neither is spending.
      row(`${SEP}-04`, 250, 'transfer out', { category_kind: 'transfer' }),
      row(`${SEP}-05`, -60),
    ]);
    expect(s.categories[id('groceries')]).toEqual({ average: 30, amount: 30 });
    expect(s.left_out).toEqual([{ currency: 'EUR', count: 1 }]);
    expect(words(s, { kind: 'category', id: id('groceries') }).notes).toContain("1 transaction in EUR isn't in this average, which is in USD.");
    // Income and transfers are never budgeted: no suggestion for them.
    const income = suggest([row(`${JUL}-03`, 20, 'income')]);
    expect(Object.keys(income.categories)).toEqual([]);
  });

  test('a category without spending in those months gets none, and says why', () => {
    const s = suggest([row(`${JUL}-03`, 90)]);
    expect(s.categories[id('coffee')]).toBeUndefined();
    expect(words(s, { kind: 'category', id: id('coffee') })).toEqual({
      line: 'Nothing was spent here in July, August and September, so there’s no suggestion.',
      amount: null,
      notes: [],
    });
  });

  test('says which months it averaged, and with rollover that it is the plain average', () => {
    const s = suggest([row(`${JUL}-03`, 300), row(`${AUG}-03`, 330), row(`${SEP}-03`, 337.11)]);
    expect(words(s, { kind: 'category', id: id('groceries') })).toEqual({
      line: 'Suggested: $325.00, from the average of July, August and September ($322.37 a month).',
      amount: 325,
      notes: [],
    });
    expect(words(s, { kind: 'category', id: id('groceries') }, true).notes).toEqual([
      'Rollover is on: this is still the plain monthly average, with nothing that rolled over in it.',
    ]);
  });
});

describe('only months the stored history reaches whole', () => {
  test('before the first month with any transaction: never counted, as if nothing was spent', () => {
    const s = suggest([row(`${SEP}-03`, 120)], { earliest: AUG });
    expect(s.months).toEqual([AUG, SEP]);
    expect(s.unreached).toEqual([{ month: JUL, kind: 'before', first: AUG }]);
    // Not (0 + 0 + 120) / 3.
    expect(s.categories[id('groceries')]).toEqual({ average: 60, amount: 60 });
    expect(words(s, { kind: 'category', id: id('groceries') })).toEqual({
      line: 'Suggested: $60.00, from the average of August and September ($60.00 a month).',
      amount: 60,
      notes: ['July isn’t counted, as Nya’s history doesn’t reach it whole: Nya’s transactions begin in August.'],
    });
  });

  test('the month the history begins in, from a day after its first: not whole, so not counted', () => {
    const s = suggest([row(`${AUG}-12`, 50), row(`${SEP}-03`, 120)], { earliest: AUG });
    expect(s.months).toEqual([SEP]);
    expect(s.unreached.map((u) => u.kind)).toEqual(['before', 'starts']);
    expect(words(s, { kind: 'category', id: id('groceries') }).line).toBe('Suggested: $120.00, from September alone ($120.00 a month).');
    expect(words(s, { kind: 'category', id: id('groceries') }).notes[0]).toBe(
      'July and August aren’t counted, as Nya’s history doesn’t reach them whole: Nya’s transactions begin on 08/12.'
    );
    // From its first day, it is whole.
    expect(suggest([row(`${AUG}-01`, 50), row(`${SEP}-03`, 120)], { earliest: AUG }).months).toEqual([AUG, SEP]);
  });

  test('a month a bank’s stored history begins after: not counted, the bank named', () => {
    const begins: MonthGap = { kind: 'begins', institution: 'Chase', first: `${JUL}-20` };
    const s = suggest([row(`${AUG}-03`, 40), row(`${SEP}-03`, 80)], { gaps: (m) => (m === JUL ? [begins] : []) });
    expect(s.months).toEqual([AUG, SEP]);
    expect(words(s, { kind: 'category', id: id('groceries') }).notes).toEqual([
      `July isn’t counted, as Nya’s history doesn’t reach it whole: Chase’s stored transactions begin on 07/20.`,
    ]);
  });

  test('none whole: no suggestion, and why', () => {
    const s = suggest([row(`${MONTH}-03`, 40)], { earliest: MONTH });
    expect(s.months).toEqual([]);
    expect(s.categories).toEqual({});
    expect(words(s, { kind: 'category', id: id('groceries') })).toEqual({
      line: 'No suggestion yet: there isn’t a complete month of transactions to go by (Nya’s transactions begin in October).',
      amount: null,
      notes: [],
    });
    expect(suggest([], { earliest: null }).months).toEqual([]);
  });

  test('a month that may be incomplete otherwise is counted, and named with why: it may be low', () => {
    const stopped: MonthGap = { kind: 'stopped', institution: 'Chase', since: `${AUG}-20T15:00:00Z` };
    const s = suggest([row(`${JUL}-03`, 90), row(`${AUG}-03`, 30), row(`${SEP}-03`, 90)], { gaps: (m) => (m === AUG ? [stopped] : []) });
    expect(s.months).toEqual([JUL, AUG, SEP]);
    expect(s.incomplete).toEqual([{ month: AUG, gaps: [stopped] }]);
    expect(words(s, { kind: 'category', id: id('groceries') }).notes).toEqual(['August may be incomplete (Chase hasn’t synced since 08/20T15:00:00Z), so this may be low.']);
  });
});

describe('in the editor', () => {
  const suggestions = suggestBudgets({ month: MONTH, rows: [row(`${JUL}-03`, 300), row(`${AUG}-03`, 330), row(`${SEP}-03`, 337.11)], currency: 'USD', ix, earliest: '2025-01', gaps: () => [] });
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

  test('beside a budget being edited, with one tap to use it, and for one about to be added', () => {
    const groceries = id('groceries');
    const html = renderToStaticMarkup(
      <BudgetsCard
        taxonomy={taxonomy}
        budgets={{ categories: { [groceries]: { amount: 250 } }, groups: {} }}
        spent={{}}
        currency="USD"
        editable
        noSpending={false}
        onSave={async () => true}
        open={[groupId('Food')]}
        edit={{ kind: 'category', id: groceries }}
        suggestions={suggestions}
      />
    );
    expect(text(html)).toContain('Suggested: $325.00, from the average of July, August and September ($322.37 a month).');
    expect(text(html)).toContain('Use $325.00');
    const adding = text(renderToStaticMarkup(<BudgetSuggestion suggestions={suggestions} target={{ kind: 'group', id: groupId('Food') }} currency="USD" verb="Add at" onUse={() => {}} />));
    expect(adding).toContain('Add at $325.00');
  });

  test('never in another currency than the budgets', () => {
    expect(renderToStaticMarkup(<BudgetSuggestion suggestions={suggestions} target={{ kind: 'category', id: id('groceries') }} currency="EUR" verb="Use" onUse={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<BudgetSuggestion suggestions={null} target={{ kind: 'category', id: id('groceries') }} currency="USD" verb="Use" onUse={() => {}} />)).toBe('');
  });
});

// ---- The Budgets tab's month, from the stored history ----

const NOW = new Date().toISOString().slice(0, 7);
const M = (k: number) => addMonths(NOW, k);
const on = (k: number, d = 10) => `${M(k)}-${String(d).padStart(2, '0')}`;

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  plaidTouched.length = 0;
});
afterEach(() => {
  expect(plaidTouched).toEqual([]);
  expect(unscopedDataKeys(fake)).toEqual([]);
});

/** A bank's stored rows, as a sync leaves them. */
async function seedBank(rows: ReturnType<typeof txn>[]) {
  await saveItem(ctx, { item_id: 'item_bank', institution_name: 'Bank', encrypted_access_token: await encrypt('access-sandbox-x') });
  const accounts = { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } };
  await fake.set(
    ctxKey('txns:item_bank'),
    await encodeJsonBlob({ schema_version: 2, cursor: 'c1', accounts, txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])), synced_at: new Date().toISOString() })
  );
  await syncsStore.set(ctx, 'item_bank', { at: new Date().toISOString() });
}
const bankRow = (rid: string, date: string, amount: number, category = 'food and drink', over: Record<string, unknown> = {}) => txn(rid, 'acc_chk', 1, amount, { date, category, ...over });
const call = async (res: Response | Promise<Response>) => {
  const r = await res;
  return { status: r.status, body: await r.json() };
};
const month = (m = NOW, extra = '&history=1') => call(monthRoute.GET(new Request(`http://x/api/budgets/month?month=${m}&today=${NOW}${extra}`)));

describe('the month answer', () => {
  test('carries this month’s suggestions from the stored history, by the meters’ rule', async () => {
    await seedBank([
      // From before the three months, so the history reaches them whole.
      bankRow('old', on(-4, 1), 999),
      bankRow('a', on(-3), 120.5),
      bankRow('b', on(-2), 99.5),
      bankRow('c', on(-1), 90),
      bankRow('excluded', on(-1, 12), 1000),
      bankRow('gym', on(-2, 14), 400),
      bankRow('euro', on(-2, 15), 500, 'food and drink', { iso_currency_code: 'EUR' }),
      bankRow('now', on(0, 2), 700),
    ]);
    // One you excluded, and one a rule of yours hides: neither counts.
    await setExcluded(ctx, 'excluded', true);
    const now = new Date().toISOString();
    await rulesStore.set(ctx, {
      version: 1,
      rules: [{ id: 'rule-1', enabled: true, priority: 1, conditions: [{ field: 'name', op: 'contains', value: 'GYM' }], actions: { hide: true }, created_at: now, updated_at: now }],
    });
    const t: Taxonomy = (await call(budgetsRoute.GET())).body.categories;
    const food = t.categories.find((c) => c.name === 'food and drink')!;
    const { status, body } = await month();
    expect(status).toBe(200);
    expect(body.suggestions.months).toEqual([M(-3), M(-2), M(-1)]);
    expect(body.suggestions.categories[food.id]).toEqual({ average: 103.33, amount: 105 });
    expect(body.suggestions.groups[food.group]).toEqual({ average: 103.33, amount: 105 });
    expect(body.suggestions.currency).toBe('USD');
    // The one in euros is named, never added.
    expect(body.suggestions.left_out).toEqual([{ currency: 'EUR', count: 1 }]);
  });

  test('none for a month gone by, nor without the history', async () => {
    await seedBank([bankRow('a', on(-3, 1), 120)]);
    expect((await month(M(-1))).body.suggestions).toBeNull();
    expect((await month(NOW, '')).body.suggestions).toBeNull();
  });
});
