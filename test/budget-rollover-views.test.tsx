import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import BudgetsCard from '@/components/BudgetsCard';
import BudgetsTab from '@/components/BudgetsTab';
import Insights from '@/components/Insights';
import { IncomePoolHeader, IncomeSetting } from '@/components/IncomePool';
import type { BudgetMonthState, BudgetMonthView } from '@/components/budget-month-state';
import type { Txn } from '@/components/MonthBreakdown';
import type { Carries, Carry, IncomePool } from '@/lib/rollover';
import { addMonths } from '@/lib/rollover';
import { localDate, localMonth } from '@/lib/local-date';
import type { Taxonomy } from '@/lib/categories';
import { categoriesFor } from './category-fixture';

// Budget rollover and income carryover on screen (#37): meters against what
// is available with the carry beneath them, the rollover editor, a past
// month shown as it was, the income pool and its setting, and Home's alerts
// weighing what is available.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const NOW = localMonth();
const { taxonomy } = categoriesFor({}, { words: ['groceries', 'restaurants', 'coffee'], groups: { groceries: 'Food', restaurants: 'Food', coffee: 'Food' } });
const id = (t: Taxonomy, name: string) => t.categories.find((c) => c.name === name)!.id;
const FOOD = taxonomy.groups.find((g) => g.name === 'Food')!.id;
const GROCERIES = id(taxonomy, 'groceries');
const RESTAURANTS = id(taxonomy, 'restaurants');

const carry = (over: Partial<Carry>): Carry => ({ carry: 0, from: addMonths(NOW, -2), why: 'start', start: addMonths(NOW, -2), uncertain: [], ...over });
const carries = (categories: Record<string, Partial<Carry>>, groups: Record<string, Partial<Carry>> = {}): Carries => ({
  categories: Object.fromEntries(Object.entries(categories).map(([k, c]) => [k, carry(c)])),
  groups: Object.fromEntries(Object.entries(groups).map(([k, c]) => [k, carry(c)])),
});
const card = (props: Partial<Parameters<typeof BudgetsCard>[0]>) =>
  text(
    renderToStaticMarkup(
      <BudgetsCard
        taxonomy={taxonomy}
        budgets={{ categories: { [GROCERIES]: { amount: 300 }, [RESTAURANTS]: { amount: 100 } }, groups: {} }}
        spent={{ [GROCERIES]: 80, [RESTAURANTS]: 120 }}
        currency="USD"
        editable
        noSpending={false}
        onSave={async () => true}
        open={[FOOD]}
        {...props}
      />
    )
  );

describe('the meters, against what is available', () => {
  test('leftover and overspending carried: each meter is spent of available, with the carry beneath it', () => {
    const t = card({ carries: carries({ [GROCERIES]: { carry: 120 }, [RESTAURANTS]: { carry: -45 } }) });
    expect(t).toContain('Groceries $80.00 of $420.00');
    expect(t).toContain('+$120.00 rolled over');
    // Overspent: 100 less the 45 carried is 55 available, and 120 is over it.
    expect(t).toContain('Restaurants $120.00 of $55.00 · over');
    expect(t).toContain('$45.00 overspent, carried over');
    // The group rolls its categories' available up.
    expect(t).toContain('Food $200.00 of $475.00');
  });

  test('a carry that counts a month that may be incomplete says it may be off, and which', () => {
    const t = card({ carries: carries({ [GROCERIES]: { carry: 120, uncertain: [addMonths(NOW, -1)] } }), month: NOW });
    expect(t).toMatch(/\+\$120\.00 rolled over \(may be off: \w+( \d{4})? is incomplete\)/);
  });

  test('a hole deeper than the budget: nothing available, the meter full and over', () => {
    const html = renderToStaticMarkup(
      <BudgetsCard
        taxonomy={taxonomy}
        budgets={{ categories: { [GROCERIES]: { amount: 100 } }, groups: {} }}
        spent={{}}
        currency="USD"
        editable
        noSpending={false}
        onSave={async () => true}
        open={[FOOD]}
        carries={carries({ [GROCERIES]: { carry: -150 } })}
      />
    );
    expect(text(html)).toContain('Groceries $0.00 of -$50.00 · over');
    expect(html).toContain('meter-fill over" style="width:100%"');
  });

  test('a group’s own budget rolling over: its carry beneath its own amount, and the reconcile rule over what is available', () => {
    const t = card({
      budgets: { categories: { [GROCERIES]: { amount: 300 }, [RESTAURANTS]: { amount: 100 } }, groups: { [FOOD]: { amount: 350 } } },
      carries: carries({}, { [FOOD]: { carry: 30 } }),
    });
    expect(t).toContain('For Food as a whole $350.00 +$30.00 rolled over');
    expect(t).toContain('Food $200.00 of $380.00');
    expect(t).toContain('What its categories have available adds up to $400.00, more than the $380.00 available to Food as a whole, so $380.00 is the limit.');
  });

  test('no carries: exactly as before', () => {
    const t = card({});
    expect(t).toContain('Groceries $80.00 of $300.00');
    expect(t).not.toContain('rolled over');
  });
});

describe('the rollover editor', () => {
  const settings = (rolling: Record<string, string> = {}) => ({ rolling: { categories: rolling, groups: {} }, starts: { categories: { [GROCERIES]: addMonths(NOW, -3) }, groups: {} }, earliest: addMonths(NOW, -30) });

  test('off: rolls over from a month chosen, this month first, back no further than the budget began', () => {
    const html = renderToStaticMarkup(
      <BudgetsCard
        taxonomy={taxonomy}
        budgets={{ categories: { [GROCERIES]: { amount: 300 } }, groups: {} }}
        spent={{}}
        currency="USD"
        editable
        noSpending={false}
        onSave={async () => true}
        open={[FOOD]}
        edit={{ kind: 'category', id: GROCERIES }}
        month={NOW}
        rollover={settings()}
        onRollover={async () => true}
      />
    );
    const t = text(html);
    expect(t).toContain('Roll over what’s left (or overspent) into the next month, counting from');
    expect(t).toContain('Turn on rollover');
    expect(html).toContain(`<option value="${NOW}" selected="">`);
    expect(html).toContain(`<option value="${addMonths(NOW, -3)}">`);
    expect(html).not.toContain(`<option value="${addMonths(NOW, -4)}">`);
  });

  test('on: says since when, and offers a reset and turning it off', () => {
    const t = text(
      renderToStaticMarkup(
        <BudgetsCard
          taxonomy={taxonomy}
          budgets={{ categories: { [GROCERIES]: { amount: 300 } }, groups: {} }}
          spent={{}}
          currency="USD"
          editable
          noSpending={false}
          onSave={async () => true}
          open={[FOOD]}
          edit={{ kind: 'category', id: GROCERIES }}
          month={NOW}
          carries={carries({ [GROCERIES]: { carry: 40, why: 'reset', from: addMonths(NOW, -1) } })}
          rollover={settings({ [GROCERIES]: addMonths(NOW, -1) })}
          onRollover={async () => true}
        />
      )
    );
    expect(t).toMatch(/Carryover reset in \w+/);
    expect(t).toContain('Reset carryover');
    expect(t).toContain('Turn off rollover');
  });

  test('without the month’s rollover loaded, it offers none', () => {
    expect(card({ edit: { kind: 'category', id: GROCERIES } })).not.toContain('rollover');
  });
});

describe('a past month, as it was', () => {
  test('its budgets and spending then, with nothing to edit or add', () => {
    const t = card({ past: true, month: addMonths(NOW, -1), carries: carries({ [GROCERIES]: { carry: 10 } }) });
    expect(t).toContain('Groceries $80.00 of $310.00');
    expect(t).not.toContain('Add Budget');
    expect(card({ past: true, month: '2026-03', budgets: { categories: {}, groups: {} }, spent: {} })).toContain('No budgets in March 2026.');
  });
});

describe('income carryover', () => {
  const pool: IncomePool = {
    start: addMonths(NOW, -2),
    from: addMonths(NOW, -2),
    clamped: false,
    carried_in: 2140.5,
    income: 3100,
    spending: 1890.25,
    available: 3350.25,
    uncertain: [addMonths(NOW, -1)],
    months: [
      { month: addMonths(NOW, -2), carried_in: 0, income: 5200, spending: 3150.5, carried_out: 2049.5, uncertain: false },
      { month: addMonths(NOW, -1), carried_in: 2049.5, income: 1800, spending: 1709, carried_out: 2140.5, uncertain: true },
      { month: NOW, carried_in: 2140.5, income: 3100, spending: 1890.25, carried_out: 3350.25, uncertain: false },
    ],
  };

  test('available to allocate: last month’s leftover, plus this month’s income so far, less its spending', () => {
    const t = text(renderToStaticMarkup(<IncomePoolHeader pool={pool} currency="USD" month={NOW} today={NOW} />));
    expect(t).toContain('Available to allocate $3,350.25');
    expect(t).toMatch(/\$2,140\.50 left from \w+, plus \$3,100\.00 income so far, less \$1,890\.25 spent/);
    expect(t).toMatch(/May be off: \w+( \d{4})? is incomplete\./);
    expect(t).toContain('Show how it built up');
  });

  test('a past month: what it left; one before the pool began: nothing in it', () => {
    const last = { ...pool, months: pool.months.slice(0, 2), carried_in: 2049.5, income: 1800, spending: 1709, available: 2140.5 };
    expect(text(renderToStaticMarkup(<IncomePoolHeader pool={last} currency="USD" month={addMonths(NOW, -1)} today={NOW} />))).toMatch(/Left to allocate at the end of \w+/);
    const later = { ...pool, start: NOW, from: NOW, months: [] };
    expect(text(renderToStaticMarkup(<IncomePoolHeader pool={later} currency="USD" month={addMonths(NOW, -1)} today={NOW} />))).toMatch(/Income carryover counts from \w+/);
  });

  test('the setting is off until turned on, and says budgets work as before either way', () => {
    const off = text(renderToStaticMarkup(<IncomeSetting setting={null} today={NOW} earliest={null} disabled={false} onChange={async () => true} />));
    expect(off).toContain('My income is irregular Off');
    expect(off).toContain('Budgets work as they always do.');
    expect(off).toContain('Turn on');
    const on = text(renderToStaticMarkup(<IncomeSetting setting={{ version: 1, enabled: true, start: NOW }} today={NOW} earliest={null} disabled={false} onChange={async () => true} />));
    expect(on).toContain('My income is irregular On');
    expect(on).toContain('Turn off');
    // Off again, the month it counted from is offered first.
    const kept = renderToStaticMarkup(<IncomeSetting setting={{ version: 1, enabled: false, start: addMonths(NOW, -2) }} today={NOW} earliest={null} disabled={false} onChange={async () => true} />);
    expect(kept).toContain(`<option value="${addMonths(NOW, -2)}" selected="">`);
  });
});

describe('the Budgets tab, with the month loaded', () => {
  const row = (date: string, amount: number, category: string): Txn => ({
    transaction_id: `${date}:${amount}:${category}`,
    date,
    name: 'Shop',
    amount,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Bank',
    category,
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
  });
  const budgets = { categories: { [GROCERIES]: { amount: 300 } }, groups: {} };
  const view = (over: Partial<BudgetMonthView> = {}): BudgetMonthView => ({
    month: NOW,
    today: NOW,
    currency: 'USD',
    budgets,
    assumed: { categories: [], groups: [] },
    recorded_since: addMonths(NOW, -3),
    carries: carries({ [GROCERIES]: { carry: 120, uncertain: [addMonths(NOW, -1)] } }),
    rollover: { categories: { [GROCERIES]: addMonths(NOW, -2) }, groups: {} },
    starts: { categories: { [GROCERIES]: addMonths(NOW, -6) }, groups: {} },
    spent: { [GROCERIES]: 80 },
    income: null,
    pool: null,
    earliest: addMonths(NOW, -6),
    gaps: [{ month: addMonths(NOW, -1), gaps: [{ kind: 'stopped', institution: 'Chase', since: `${addMonths(NOW, -1)}-15T12:00:00.000Z` }] }],
    left_out_text: null,
    counted_left_out_text: null,
    notes: [],
    ...over,
  });
  const state = (v: BudgetMonthView | null, status: BudgetMonthState['status'] = 'ready', error: string | null = null): BudgetMonthState => ({ status, view: v, error, reload: () => {} });
  const tab = (budgetMonth?: BudgetMonthState) =>
    text(
      renderToStaticMarkup(
        <BudgetsTab
          txns={[row(localDate(), 80, 'groceries')]}
          budgets={budgets}
          taxonomy={taxonomy}
          onSave={async () => true}
          goals={[]}
          onSaveGoals={async () => true}
          accounts={[]}
          loading={false}
          budgetMonth={budgetMonth}
        />
      )
    );

  test('the total is spent of what is available, and why a carry may be off is said', () => {
    const t = tab(state(view()));
    expect(t).toContain('$80.00 of $420.00');
    expect(t).toContain('Rollover may be off where a month is incomplete: Chase hasn’t synced since');
    // A month picker, back to the first month with transactions.
    expect(t).toContain('(this month)');
    expect(t).toContain('My income is irregular Off');
  });

  test('income carryover on: available to allocate above the meters', () => {
    const pool: IncomePool = { start: NOW, from: NOW, clamped: false, carried_in: 0, income: 500, spending: 80, available: 420, uncertain: [], months: [{ month: NOW, carried_in: 0, income: 500, spending: 80, carried_out: 420, uncertain: false }] };
    const t = tab(state(view({ income: { version: 1, enabled: true, start: NOW }, pool })));
    expect(t.indexOf('Available to allocate $420.00')).toBeGreaterThan(-1);
    expect(t.indexOf('Available to allocate')).toBeLessThan(t.indexOf('Food'));
  });

  test('not loaded, or not loadable: this month as it always was, and said', () => {
    const before = tab();
    expect(before).toContain('$80.00 of $300.00');
    expect(before).not.toContain('irregular');
    const failed = tab(state(null, 'error', 'Rollover couldn’t be worked out just now, so each budget shows its amount without it.'));
    expect(failed).toContain('$80.00 of $300.00');
    expect(failed).toContain('Rollover couldn’t be worked out just now');
  });

  test('what the earlier months counted left out for another currency is named', () => {
    const t = tab(state(view({ counted_left_out_text: "2 transactions in EUR aren't in what rolled over from earlier months, which is in USD." })));
    expect(t).toContain("2 transactions in EUR aren't in what rolled over from earlier months, which is in USD.");
  });

  test('amounts from before budgets were kept by month are said to be assumed', () => {
    const t = tab(state(view({ recorded_since: NOW })));
    expect(t).toMatch(/Nya began keeping budgets by month in \w+/);
  });
});

describe('Home’s budget alerts weigh what is available', () => {
  const row = (amount: number): Txn =>
    ({
      transaction_id: `t${amount}`,
      date: localDate(),
      name: 'Grocer',
      amount,
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
    }) as Txn;
  const budgets = { categories: { [GROCERIES]: { amount: 300 } }, groups: {} };
  const alerts = (c: Carries | null) => text(renderToStaticMarkup(<Insights txns={[row(320)]} budgets={budgets} taxonomy={taxonomy} accounts={[]} budgetCarries={c} />));

  test('over the budget, but within what rolled over: no alert; deeper in a hole: over', () => {
    expect(alerts(null)).toContain('Over your groceries budget: $320.00 of $300.00');
    expect(alerts(carries({ [GROCERIES]: { carry: 150 } }))).not.toContain('groceries budget');
    expect(alerts(carries({ [GROCERIES]: { carry: -50 } }))).toContain('Over your groceries budget: $320.00 of $250.00');
  });

  test('the dashboard passes this month’s carries, once loaded', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    const mount = dashboard.slice(dashboard.indexOf('<Insights'), dashboard.indexOf('/>', dashboard.indexOf('<Insights')));
    expect(mount).toContain('budgetCarries={budgetMonth.view?.month === thisMonth ? budgetMonth.view.carries : null}');
  });
});
