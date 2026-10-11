import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import BudgetsCard from '@/components/BudgetsCard';
import BudgetsTab, { PastMonthPending } from '@/components/BudgetsTab';
import Insights from '@/components/Insights';
import { IncomePoolHeader, IncomeSetting } from '@/components/IncomePool';
import { lacksHistory, monthUrl, UNREADABLE_MONTHS, type BudgetMonthState, type BudgetMonthView } from '@/components/budget-month-state';
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
const COFFEE = id(taxonomy, 'coffee');

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
    // Said in words, never as a limit below zero.
    expect(text(html)).toContain('Groceries $0.00 spent, nothing left · over $150.00 overspent, carried over Began the month $50.00 over.');
    expect(text(html)).not.toContain('-$');
    expect(html).toContain('meter-fill over" style="width:100%"');
  });

  test('a carry that uses up the budget exactly: nothing left, and over only once something is spent', () => {
    const at = (spent: number) =>
      renderToStaticMarkup(
        <BudgetsCard
          taxonomy={taxonomy}
          budgets={{ categories: { [GROCERIES]: { amount: 100 } }, groups: {} }}
          spent={{ [GROCERIES]: spent }}
          currency="USD"
          editable
          noSpending={false}
          onSave={async () => true}
          open={[FOOD]}
          carries={carries({ [GROCERIES]: { carry: -100 } })}
        />
      );
    expect(text(at(0))).toContain('Groceries $0.00 spent, nothing left $100.00 overspent, carried over');
    expect(at(0)).not.toContain('over-tag');
    expect(at(0)).not.toContain('Began the month');
    expect(at(0)).toContain('meter-fill" style="width:0%"');
    expect(text(at(12))).toContain('Groceries $12.00 spent, nothing left · over');
    expect(at(12)).toContain('meter-fill over" style="width:100%"');
  });

  test('the reconcile rule with nothing left on one side says so in words', () => {
    const own = card({
      budgets: { categories: { [GROCERIES]: { amount: 300 }, [RESTAURANTS]: { amount: 100 } }, groups: { [FOOD]: { amount: 350 } } },
      carries: carries({}, { [FOOD]: { carry: -500 } }),
    });
    expect(own).toContain('Food $200.00 spent, nothing left · over');
    expect(own).toContain('Nothing is left of the budget for Food as a whole after what it carried over, so nothing more can be spent in the group, whatever its categories have available ($400.00).');
    expect(own).not.toContain('-$');
    // Every category in it budgeted, so theirs can bind.
    const all = Object.fromEntries(taxonomy.categories.filter((c) => c.group === FOOD).map((c) => [c.id, { amount: 10 }]));
    const theirs = card({
      budgets: { categories: { ...all, [GROCERIES]: { amount: 300 }, [RESTAURANTS]: { amount: 100 }, [COFFEE]: { amount: 50 } }, groups: { [FOOD]: { amount: 350 } } },
      carries: carries({ [GROCERIES]: { carry: -400 }, [RESTAURANTS]: { carry: -150 }, [COFFEE]: { carry: -100 } }),
    });
    expect(theirs).toContain('Food $200.00 spent, nothing left · over');
    expect(theirs).toContain('Every category in Food has a budget, and after what they carried over nothing is left of them, so nothing more can be spent in the group, whatever it has available as a whole ($350.00).');
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

  test('one that couldn’t be loaded says so, with a way to try again', () => {
    const failed = (error: string) => <PastMonthPending state={{ status: 'error', view: null, error, reload: () => {} }} name="March" />;
    const html = renderToStaticMarkup(failed('Rollover couldn’t be worked out just now, so each budget shows its amount without it.'));
    expect(text(html)).toBe('March couldn’t be loaded. Try again');
    expect(html).toContain('<button class="secondary"');
    expect(text(renderToStaticMarkup(failed(UNREADABLE_MONTHS)))).toBe(`${UNREADABLE_MONTHS} Try again`);
    expect(text(renderToStaticMarkup(<PastMonthPending state={{ status: 'loading', view: null, error: null, reload: () => {} }} name="March" />))).toBe('Loading March…');
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
    history: true,
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

  test('nothing left in all after an overspent carry: the total still shows, over', () => {
    const html = renderToStaticMarkup(
      <BudgetsTab
        txns={[row(localDate(), 80, 'groceries')]}
        budgets={budgets}
        taxonomy={taxonomy}
        onSave={async () => true}
        goals={[]}
        onSaveGoals={async () => true}
        accounts={[]}
        loading={false}
        budgetMonth={state(view({ carries: carries({ [GROCERIES]: { carry: -500 } }) }))}
      />
    );
    expect(text(html)).toContain(`${new Date().toLocaleDateString(undefined, { month: 'long' })} budgets $80.00 spent, nothing left`);
    expect(text(html)).not.toContain('of -$');
    expect(html).toContain('meter-fill over" style="width:100%"');
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

  test('scattered incomplete months are named as such, never as a run', () => {
    const scattered = [-12, -8, -4, -1].map((n) => addMonths(NOW, n));
    const t = tab(
      state(
        view({
          carries: carries({ [GROCERIES]: { carry: 120, from: scattered[0], uncertain: scattered } }),
          gaps: scattered.map((month) => ({ month, gaps: [{ kind: 'exclusions' as const, count: 1 }] })),
        })
      )
    );
    expect(t).toContain('Whether you excluded 1 transaction couldn’t be read (4 months since');
    expect(t).not.toMatch(/\(\w+( \d{4})? to \w+/);
  });

  test('answered without the stored history: this month as it always was, with no months to pick yet', () => {
    const html = renderToStaticMarkup(
      <BudgetsTab
        txns={[row(localDate(), 80, 'groceries')]}
        budgets={budgets}
        taxonomy={taxonomy}
        onSave={async () => true}
        goals={[]}
        onSaveGoals={async () => true}
        accounts={[]}
        loading={false}
        budgetMonth={state(view({ history: false, carries: carries({}), gaps: [], earliest: null, spent: {}, currency: null }))}
      />
    );
    expect(text(html)).toContain('$80.00 of $300.00');
    expect(html).not.toContain('Month to show');
    expect(text(html)).toContain('My income is irregular Off');
    // A start from the last year, until the first month with transactions is known.
    expect(text(html)).toContain(`Count from ${new Date().toLocaleDateString('en-US', { month: 'long' })} (this month)`);
    expect(text(html)).not.toContain(String(Number(NOW.slice(0, 4)) - 2));
  });
});

describe('loading the month', () => {
  test('the history is asked for only when wanted', () => {
    expect(monthUrl('2026-10', '2026-10', false)).toBe('/api/budgets/month?month=2026-10&today=2026-10');
    expect(monthUrl('2026-08', '2026-10', true)).toBe('/api/budgets/month?month=2026-08&today=2026-10&history=1');
  });

  test('an answer without the history is loaded again once it is wanted, and never twice', () => {
    const plain = { history: false } as BudgetMonthView;
    const read = { history: true } as BudgetMonthView;
    expect(lacksHistory(true, { status: 'ready', view: plain, asked: false })).toBe(true);
    // Not wanted (Home), already read, already asked, or still loading.
    expect(lacksHistory(false, { status: 'ready', view: plain, asked: false })).toBe(false);
    expect(lacksHistory(true, { status: 'ready', view: read, asked: false })).toBe(false);
    expect(lacksHistory(true, { status: 'ready', view: plain, asked: true })).toBe(false);
    expect(lacksHistory(true, { status: 'loading', view: plain, asked: false })).toBe(false);
    expect(lacksHistory(true, { status: 'error', view: null, asked: false })).toBe(false);
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

  test('nothing available after what was overspent: its own sentence, never "of" a limit of zero or less', () => {
    expect(alerts(carries({ [GROCERIES]: { carry: -350 } }))).toContain(
      'Over your groceries budget: overspending carried over left it $50.00 over before this month, and $320.00 is spent'
    );
    expect(alerts(carries({ [GROCERIES]: { carry: -300 } }))).toContain('Over your groceries budget: overspending carried over left nothing of it this month, and $320.00 is spent');
    const none = text(renderToStaticMarkup(<Insights txns={[]} budgets={budgets} taxonomy={taxonomy} accounts={[]} budgetCarries={carries({ [GROCERIES]: { carry: -350 } })} />));
    expect(none).toContain('Over your groceries budget: overspending carried over left it $50.00 over before this month');
    expect(none).not.toContain('is spent');
    for (const t of [alerts(carries({ [GROCERIES]: { carry: -350 } })), none]) expect(t).not.toContain('of -$');
  });

  test('the dashboard passes this month’s carries, once loaded', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    const mount = dashboard.slice(dashboard.indexOf('<Insights'), dashboard.indexOf('/>', dashboard.indexOf('<Insights')));
    expect(mount).toContain('budgetCarries={budgetMonth.view?.month === thisMonth ? budgetMonth.view.carries : null}');
  });

  test('the dashboard loads the month once the transactions have, never during a save, with the history on the Budgets tab', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const hook = dashboard.slice(dashboard.indexOf('useBudgetMonth('), dashboard.indexOf(');', dashboard.indexOf('useBudgetMonth(')));
    expect(hook).toContain("budgetsState.status === 'ready' && (txns !== null || txnsFailed) ? thisMonth : null");
    expect(hook).toContain('[budgets, txns, categories.taxonomy]');
    expect(hook).toContain("{ paused: budgetsState.saving, history: tab === 'budgets' }");
  });
});

describe('the pool table on a phone', () => {
  test('its cells set their own size (the global th, td would win), and it scrolls inside its box', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toContain(".pool-table td,\n.pool-table th[scope='row'] {\n  font-size: 12px;\n}");
    expect(css).toMatch(/\.pool-scroll \{[^}]*overflow-x: auto;/);
    const source = readFileSync(join(import.meta.dir, '..', 'components', 'IncomePool.tsx'), 'utf8');
    expect(source).toContain('<div className="pool-scroll">');
    // What each month carried in is the row below's Left: not a column.
    expect(source).not.toContain('Carried in');
  });
});
