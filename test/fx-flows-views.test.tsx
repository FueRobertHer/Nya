import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MonthBreakdown, { type Txn } from '@/components/MonthBreakdown';
import Insights from '@/components/Insights';
import BudgetsTab from '@/components/BudgetsTab';
import { localMonth } from '@/lib/local-date';
import { categoriesFor } from './category-fixture';
import { ecbTable } from './fx-fixture';

// The page's totals of flows in a home currency (lib/fx/totals.ts), drawn:
// each converted total is its rows converted at their day's rates, to the
// cent; each row is listed in its own currency; what has no rate is named,
// with why; and without a home currency every figure is today's. The ECB's
// newest rates in the fixture are 14 Sep 2026's (1 EUR = 1.1551 USD), which
// a day after them takes.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const month = localMonth();
const day = (d: number) => `${month}-${String(d).padStart(2, '0')}`;
const { taxonomy, budgets } = categoriesFor({ groceries: 500 }, { words: ['groceries', 'rent and utilities'] });
let n = 0;
const row = (d: number, name: string, amount: number, category: string | null, over: Partial<Txn> = {}): Txn => ({
  transaction_id: `f${++n}`,
  date: day(d),
  name,
  amount,
  pending: false,
  account_name: 'Checking',
  institution_name: 'Chase',
  category,
  iso_currency_code: 'USD',
  vendor_key: name.toLowerCase(),
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
export const FLOWS: Txn[] = [
  row(1, 'ACME CORP', -3100, 'income'),
  row(2, 'Whole Foods', 412.3, 'groceries'),
  row(3, 'Landlord', 2100, 'rent and utilities'),
  row(4, 'Monoprix', 40, 'groceries', { iso_currency_code: 'EUR' }),
  row(5, 'Coinbase card', 0.01, 'groceries', { iso_currency_code: null, unofficial_currency_code: 'BTC' }),
];
const fx = ecbTable({ home: 'EUR' });
const activity = (over: Partial<Parameters<typeof MonthBreakdown>[0]> = {}) =>
  text(renderToStaticMarkup(<MonthBreakdown txns={FLOWS} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} {...over} />));

describe('the Activity tab', () => {
  test('without a home currency: the dollars, the euro row named', () => {
    const t = activity();
    expect(t).toContain('In +$3,100.00');
    expect(t).toContain('Out −$2,512.30');
    expect(t).toContain("1 transaction in BTC and 1 in EUR aren't in these totals, which are in USD.");
  });

  test('with one: every total in euros, each row at its day’s rate, to the cent; each row listed as it is', () => {
    const t = activity({ fx });
    // 3,100 / 1.1551
    expect(t).toContain('In +€2,683.75');
    // 40 + 412.30 / 1.1551 + 2,100 / 1.1551
    expect(t).toContain('Out −€2,214.96');
    expect(t).toContain('Net +€468.79');
    expect(t).toContain('Converted into EUR at each day’s ECB rate: 3 transactions in USD.');
    expect(t).toContain("1 transaction in BTC isn't in these totals, which are in EUR: there is no rate for BTC on those days.");
    // Listed in its own currency.
    expect(t).toContain('−$412.30');
    expect(t).toContain('−€40.00');
  });
});

describe('the insights on Home', () => {
  const rows = [...FLOWS, row(6, 'Galeries Lafayette', 2000, 'shopping', { iso_currency_code: 'EUR' })];
  const insights = (over: Partial<Parameters<typeof Insights>[0]> = {}) => text(renderToStaticMarkup(<Insights txns={rows} accounts={[]} {...over} />));

  test('the biggest purchase is ranked by what it came to, and said in its own currency', () => {
    // Without a home currency, the dollars only: the rent.
    expect(insights()).toContain('Biggest purchase this month: Landlord, $2,100.00');
    // With one, $2,100 is €1,818.02, less than €2,000.
    expect(insights({ fx })).toContain('Biggest purchase this month: Galeries Lafayette, €2,000.00');
  });
});

describe('the Budgets tab', () => {
  const tab = (over: Partial<Parameters<typeof BudgetsTab>[0]> = {}) =>
    text(
      renderToStaticMarkup(
        <BudgetsTab txns={FLOWS} taxonomy={taxonomy} budgets={budgets} onSave={async () => true} goals={[]} onSaveGoals={async () => true} accounts={[]} loading={false} {...over} />
      )
    );

  test('budgets stay in the currency they are in; spending in another counts converted into it, to the cent', () => {
    // Without a home currency: the euros named.
    expect(tab()).toContain('$412.30 of $500.00');
    expect(tab()).toContain("1 transaction in BTC and 1 in EUR aren't in these budgets, which are in USD.");
    // With one: still dollars, €40 counting as $46.20 (40 × 1.1551).
    const t = tab({ fx });
    expect(t).toContain('$458.50 of $500.00');
    expect(t).toContain('Spending in other currencies counts converted into USD, the currency your budgets are in, at each day’s ECB rate: 1 transaction in EUR.');
    expect(t).toContain("1 transaction in BTC isn't in these budgets, which are in USD: there is no rate for BTC on those days.");
  });
});
