import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import BudgetsCard from '@/components/BudgetsCard';
import CategoryRollup from '@/components/CategoryRollup';
import CategoryPicker, { pickerOptions } from '@/components/CategoryPicker';
import CategoryManager from '@/components/CategoryManager';
import CategoriesCard from '@/components/CategoriesCard';
import MonthBreakdown, { categoryLabel, type Txn } from '@/components/MonthBreakdown';
import Insights from '@/components/Insights';
import { moveCategory, setArchived, setCategoryIcon, renameCategory, type Taxonomy } from '@/lib/categories';
import { localDate } from '@/lib/local-date';
import { categoriesFor } from './category-fixture';

// The screens your categories show on (#38): the Budgets tab's group meters
// and the reconcile line, the Activity tab's top spending by group, the lists
// to choose a category from, and the Categories screen under Manage.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const today = localDate();
const { taxonomy } = categoriesFor({}, { words: ['groceries', 'restaurants', 'coffee'], groups: { groceries: 'Food', restaurants: 'Food', coffee: 'Food' } });
const id = (t: Taxonomy, name: string) => t.categories.find((c) => c.name === name)!.id;
const group = (t: Taxonomy, name: string) => t.groups.find((g) => g.name === name)!.id;
const FOOD = group(taxonomy, 'Food');

const card = (props: Partial<Parameters<typeof BudgetsCard>[0]>) =>
  text(
    renderToStaticMarkup(
      <BudgetsCard taxonomy={taxonomy} budgets={{ categories: {}, groups: {} }} spent={{}} currency="USD" editable noSpending={false} onSave={async () => true} {...props} />
    )
  );
const amounts = (by: Record<string, number>) => Object.fromEntries(Object.entries(by).map(([name, amount]) => [id(taxonomy, name), { amount }]));
const spentBy = (by: Record<string, number>) => Object.fromEntries(Object.entries(by).map(([name, s]) => [id(taxonomy, name), s]));

describe('the Budgets tab’s group meters', () => {
  test('collapsed at first: each group with a budget as one meter, its categories hidden', () => {
    const t = card({ budgets: { categories: amounts({ groceries: 300, restaurants: 200 }), groups: {} }, spent: spentBy({ groceries: 120, restaurants: 30, coffee: 5 }) });
    expect(t).toContain('Food $150.00 of $500.00');
    expect(t).not.toContain('groceries');
    expect(t).not.toContain('Groceries $120.00');
  });

  test('opened: its own budget, then each category with a budget or spending, nested, most spent first', () => {
    const t = card({ budgets: { categories: amounts({ groceries: 300, restaurants: 200 }), groups: {} }, spent: spentBy({ groceries: 120, restaurants: 30, coffee: 5 }), open: [FOOD] });
    expect(t).toContain('For Food as a whole Not set');
    expect(t).toContain('Groceries $120.00 of $300.00');
    expect(t).toContain('Restaurants $30.00 of $200.00');
    expect(t).toContain('Coffee $5.00, no budget');
    expect(t.indexOf('Groceries')).toBeLessThan(t.indexOf('Restaurants'));
  });

  test('the reconcile rule, shown: a group’s amount capping its categories’, and categories adding up to less', () => {
    const capped = card({ budgets: { categories: amounts({ groceries: 500, restaurants: 400 }), groups: { [FOOD]: { amount: 800 } } }, open: [FOOD] });
    expect(capped).toContain('Food $0.00 of $800.00');
    expect(capped).toContain('Capped by the group’s budget');
    expect(capped).toContain('Its categories’ budgets add up to $900.00, more than the $800.00 set for Food, so $800.00 is the limit.');
    const all = amounts({ groceries: 100, restaurants: 100, coffee: 50, 'food and drink': 50 });
    const limited = card({ budgets: { categories: all, groups: { [FOOD]: { amount: 800 } } }, open: [FOOD] });
    expect(limited).toContain('Food $0.00 of $300.00');
    expect(limited).toContain('Limited to its categories’ budgets');
    expect(limited).toContain('Every category in Food has a budget, and they add up to $300.00, less than the $800.00 set for the group, so $300.00 is the limit.');
  });

  test('a group’s own budget counts everything in it; with no spending to count, limits only', () => {
    expect(card({ budgets: { categories: {}, groups: { [FOOD]: { amount: 400 } } }, spent: spentBy({ coffee: 50, groceries: 100 }) })).toContain('Food $150.00 of $400.00');
    expect(card({ budgets: { categories: {}, groups: { [FOOD]: { amount: 400 } } }, noSpending: true })).toContain('Food $400.00 limit');
  });

  test('over its limit says so', () => {
    expect(card({ budgets: { categories: amounts({ groceries: 100 }), groups: {} }, spent: spentBy({ groceries: 140 }) })).toContain('Food $140.00 of $100.00 · over');
  });

  test('a budget on a category since deleted is shown, and can be removed', () => {
    const t = card({ budgets: { categories: { gone_1: { amount: 25 } }, groups: {} } });
    expect(t).toContain('A category since deleted $25.00 Remove budget');
  });

  test('to add one: whole groups without a budget, then each group’s categories without one, archived ones left out', () => {
    const archived = setArchived(taxonomy, id(taxonomy, 'coffee'), true);
    const html = renderToStaticMarkup(
      <BudgetsCard taxonomy={archived} budgets={{ categories: amounts({ groceries: 1 }), groups: {} }} spent={spentBy({ restaurants: 12 })} currency="USD" editable noSpending={false} onSave={async () => true} />
    );
    expect(html).toContain(`<option value="group:${FOOD}">Food ($12.00 this month)</option>`);
    expect(html).toContain(`<option value="category:${id(taxonomy, 'restaurants')}">Restaurants ($12.00 this month)</option>`);
    expect(html).not.toContain(`category:${id(taxonomy, 'groceries')}`);
    expect(html).not.toContain(`category:${id(taxonomy, 'coffee')}`);
  });

  test('only spending is offered: income and transfers never count against a budget, and one already on them says why it never moves', () => {
    const html = renderToStaticMarkup(
      <BudgetsCard taxonomy={taxonomy} budgets={{ categories: {}, groups: {} }} spent={{}} currency="USD" editable noSpending={false} onSave={async () => true} />
    );
    for (const name of ['income', 'transfer in', 'transfer out', 'loan payments']) expect(html).not.toContain(`category:${id(taxonomy, name)}`);
    for (const name of ['Income', 'Transfers']) expect(html).not.toContain(`value="group:${group(taxonomy, name)}"`);
    expect(html).toContain(`value="group:${FOOD}"`);
    const loans = id(taxonomy, 'loan payments');
    const t = card({ budgets: { categories: { [loans]: { amount: 900 } }, groups: {} }, open: [group(taxonomy, 'Transfers')] });
    expect(t).toContain('Transfers $0.00 of $900.00');
    expect(t).toContain('The categories in Transfers count as transfers, not spending, so nothing counts against a budget here.');
  });

  test('a renamed category shows by its new name: one rename, everywhere', () => {
    const renamed = renameCategory(taxonomy, id(taxonomy, 'groceries'), 'Supermarket');
    const t = text(
      renderToStaticMarkup(
        <BudgetsCard taxonomy={renamed} budgets={{ categories: amounts({ groceries: 300 }), groups: {} }} spent={spentBy({ groceries: 10 })} currency="USD" editable noSpending={false} onSave={async () => true} open={[FOOD]} />
      )
    );
    expect(t).toContain('Supermarket $10.00 of $300.00');
  });
});

describe('the Activity tab’s top spending by group', () => {
  const row = (over: Partial<Txn>): Txn => ({
    transaction_id: Math.random().toString(36).slice(2),
    date: today,
    name: 'Shop',
    amount: 10,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Bank',
    category: 'groceries',
    iso_currency_code: 'USD',
    vendor_key: 'v',
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

  test('groups with their totals, most first, collapsed; a category opens under its group', () => {
    const t = text(
      renderToStaticMarkup(
        <CategoryRollup taxonomy={taxonomy} byCategory={new Map([[id(taxonomy, 'groceries'), 120], [id(taxonomy, 'coffee'), 8], [id(taxonomy, 'transportation'), 300]])} currency="USD" />
      )
    );
    expect(t).toContain('Transport $300.00');
    expect(t).toContain('Food $128.00');
    expect(t.indexOf('Transport')).toBeLessThan(t.indexOf('Food'));
    expect(t).not.toContain('Groceries');
  });

  test('a category the page doesn’t know is counted under uncategorized’s group, never left out', () => {
    const t = text(renderToStaticMarkup(<CategoryRollup taxonomy={taxonomy} byCategory={new Map([['new:1', 40]])} currency="USD" />));
    expect(t).toContain('Other $40.00');
  });

  test('on the Activity tab: rows filed by their category’s id, and by their words where the server hasn’t yet', () => {
    const rows = [
      row({ category: 'groceries', category_id: id(taxonomy, 'groceries'), category_name: 'groceries', category_kind: 'expense', amount: 30 }),
      row({ category: 'transportation', amount: 70 }),
    ];
    const t = text(renderToStaticMarkup(<MonthBreakdown txns={rows} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} />));
    expect(t).toContain('Top spending by group');
    expect(t).toContain('Transport $70.00');
    expect(t).toContain('Food $30.00');
  });

  test('a row shows its category’s name, or none when it says none', () => {
    expect(categoryLabel({ category: 'groceries', category_name: 'Supermarket' })).toBe('Supermarket');
    expect(categoryLabel({ category: null, category_name: null })).toBeNull();
    expect(categoryLabel({ category: 'food and drink' })).toBe('Food and drink');
  });
});

describe('Home’s budget alerts', () => {
  test('a category’s budget and a group’s, each by its name', () => {
    const { taxonomy: t, budgets } = categoriesFor({ groceries: 100, restaurants: 100 }, { groups: { groceries: 'Food', restaurants: 'Food' } });
    const rows = [
      { transaction_id: 'a', date: today, name: 'Shop', amount: 95, pending: false, account_name: 'C', institution_name: 'B', category: 'groceries', iso_currency_code: 'USD', vendor_key: 'v', logo_url: null, category_icon_url: null, subcategory: null, category_confidence: null, transaction_code: null, payment_channel: null, datetime: null, website: null, check_number: null, account_owner: null, city: null, region: null, counterparty: null, payment_processor: null, payment_reference: null },
    ] as Txn[];
    const s = text(renderToStaticMarkup(<Insights txns={rows} taxonomy={t} budgets={budgets} accounts={[]} />));
    expect(s).toContain('Approaching your groceries budget (95%)');
    // A group without a budget of its own only adds its categories' up: no alert of its own.
    const tight = { ...budgets, categories: { ...budgets.categories, [t.categories.find((c) => c.name === 'restaurants')!.id]: { amount: 5 } } };
    const sum = text(renderToStaticMarkup(<Insights txns={rows} taxonomy={t} budgets={tight} accounts={[]} />));
    expect(sum).toContain('Approaching your groceries budget (95%)');
    expect(sum).not.toContain('your Food budget');
    const capped = { ...budgets, groups: { [group(t, 'Food')]: { amount: 100 } } };
    const g = text(renderToStaticMarkup(<Insights txns={rows} taxonomy={t} budgets={capped} accounts={[]} />));
    expect(g).toContain('Approaching your Food budget (95%)');
  });
});

describe('the lists to choose a category from', () => {
  test('by group, in your order, archived ones left out but for the one chosen now', () => {
    let t = setArchived(taxonomy, id(taxonomy, 'coffee'), true);
    t = setCategoryIcon(t, id(t, 'groceries'), '🛒');
    const options = pickerOptions(t, null);
    expect(options[0].group).toBe('Income');
    const food = options.find((o) => o.group === 'Food')!;
    expect(food.options.map((o) => o.label)).toEqual(['Food and drink', '🛒 Groceries', 'Restaurants']);
    const withCurrent = pickerOptions(t, id(t, 'coffee')).find((o) => o.group === 'Food')!;
    expect(withCurrent.options.map((o) => o.label)).toContain('Coffee (archived)');
    const html = renderToStaticMarkup(<CategoryPicker taxonomy={t} value="" none="No category" onChange={() => {}} />);
    expect(html).toContain('<option value="" selected="">No category</option>');
    expect(html).toContain('<optgroup label="Transfers">');
  });
});

describe('the Categories screen under Manage', () => {
  const state = (t: Taxonomy | null, error: string | null = null) => ({ taxonomy: t, error, accept: () => {}, reload: async () => {} });

  test('the card says how many, and opens the screen', () => {
    const archived = setArchived(taxonomy, id(taxonomy, 'coffee'), true);
    const t = text(renderToStaticMarkup(<CategoriesCard categories={state(archived)} onChanged={() => {}} />));
    expect(t).toContain(`${archived.categories.length - 1} categories in 10 groups, and 1 archived.`);
    expect(t).toContain('Edit categories');
    expect(text(renderToStaticMarkup(<CategoriesCard categories={state(null, 'Your categories couldn’t be loaded.')} onChanged={() => {}} />))).toContain('Try again');
  });

  test('the screen: every group in order with its kind, each category, archived and uncategorized ones marked', () => {
    let t = setArchived(taxonomy, id(taxonomy, 'coffee'), true);
    t = moveCategory(t, id(t, 'loan payments'), group(t, 'Housing'));
    const s = text(renderToStaticMarkup(<CategoryManager open taxonomy={t} onClose={() => {}} onTaxonomy={() => {}} />));
    expect(s).toContain('Add a category Add a group');
    expect(s).toContain('Food Spending');
    expect(s).toContain('Transfers Transfers');
    expect(s).toContain('Coffee Archived');
    expect(s).toContain('Other Uncategorized');
    // Moved: under Housing now.
    expect(s.indexOf('Loan payments')).toBeGreaterThan(s.indexOf('Housing'));
    expect(s.indexOf('Loan payments')).toBeLessThan(s.indexOf('Transport'));
  });

  test('the dashboard mounts it behind Manage, and hands the categories to every view that files by them', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');
    expect(dashboard).toContain('{manageMode && (\n                  <CategoriesCard');
    for (const view of ['<MonthBreakdown', '<BudgetsTab', '<ManualTxnSheet', '<Insights']) {
      const at = dashboard.indexOf(view);
      expect([view, dashboard.slice(at, dashboard.indexOf('/>', at)).includes('taxonomy={categories.taxonomy}')]).toEqual([view, true]);
    }
    expect(dashboard).toContain("field: 'budget_set'");
    // A budget on a category the page's set lacks reads the set again.
    expect(dashboard).toContain("useCategoriesForBudgets(categories, budgets, budgetsState.status === 'ready');");
  });
});
