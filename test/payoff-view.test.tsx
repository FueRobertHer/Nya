import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import DebtPayoff, { NO_INPUTS, PayoffPanel, monthLabel, type PayoffInputs } from '@/components/DebtPayoff';
import { comparePlans, debtAccounts, planRows, type DebtInstitutionInput } from '@/lib/payoff';
import { formatMoney } from '@/lib/format';
import { toInstitutions } from '@/lib/manual';

const START = '2026-10';
const noop = () => {};

/** The panel as it renders, with React's escaped apostrophes put back. */
function panel(institutions: DebtInstitutionInput[], inputs: Partial<PayoffInputs> = {}): string {
  return renderToStaticMarkup(
    <PayoffPanel institutions={institutions} inputs={{ ...NO_INPUTS, ...inputs }} onChange={noop} startMonth={START} />
  ).replaceAll('&#x27;', "'");
}

const sapphire = {
  account_id: 'sapphire',
  name: 'Sapphire',
  mask: '4321',
  type: 'credit',
  subtype: 'credit card',
  balance: 4210.55,
  currency: 'USD',
  liability: { kind: 'credit' as const, apr: 21.24, apr_label: 'Purchase APR', minimum_payment: 120 },
};
const mortgage = {
  account_id: 'home',
  name: 'Mortgage',
  mask: '0001',
  type: 'loan',
  subtype: 'mortgage',
  balance: 310_000,
  currency: 'USD',
  liability: { kind: 'mortgage' as const, apr: 5.25, apr_label: 'Interest rate', minimum_payment: 2100.5 },
};
const chase = (accounts: DebtInstitutionInput['accounts'], extra: Partial<DebtInstitutionInput> = {}): DebtInstitutionInput => ({
  institution_name: 'Chase',
  liabilities: 'on',
  accounts,
  ...extra,
});
const alliant = toInstitutions([
  { account_id: 'manual_auto', name: 'Auto Loan', institution_name: 'Alliant', type: 'loan', subtype: 'auto', balance: 8420, updated_at: '2026-08-02T17:02:00.000Z' },
]);

/** The plan the panel should be showing, worked out directly. */
function expected(institutions: DebtInstitutionInput[], inputs: Partial<PayoffInputs> = {}, extraCents = 0) {
  const all = { ...NO_INPUTS, ...inputs };
  const { debts } = planRows(debtAccounts(institutions), all.typed, all.leftOut);
  return comparePlans(debts, { startMonth: START, extraCents });
}

describe('the payoff planner', () => {
  test("fills in Plaid's terms, says where they came from, and plans at once", () => {
    const html = panel([chase([sapphire])]);
    expect(html).toContain('value="21.24"');
    expect(html).toContain('value="120.00"');
    expect(html).toContain('Purchase APR from Plaid');
    expect(html).toContain('Minimum from Plaid');
    const plan = expected([chase([sapphire])]).avalanche;
    expect(html).toContain(monthLabel(plan.month!));
    expect(html).toContain(formatMoney(plan.interestCents! / 100, 'USD'));
    // One debt and no extra: nothing to roll over, so nothing is saved.
    expect(html).toContain('The same as paying only the minimums.');
  });

  test('opens in the drawer as "Payoff plan"', () => {
    const html = renderToStaticMarkup(<DebtPayoff open onClose={noop} institutions={[chase([sapphire])]} />);
    expect(html).toContain('aria-label="Payoff plan"');
    expect(html).toContain('Purchase APR from Plaid');
  });

  test('a manual loan has no terms: it is needed, says why, and the plan waits for it', () => {
    const html = panel([chase([sapphire]), ...alliant]);
    expect(html).toContain('Add the missing rate or payment for 1 debt below, or leave it out, to see the plan.');
    expect(html).toContain('Needed');
    expect(html).toContain('A manual account has no terms from a bank');
    expect(html).not.toContain('Debt-free');
    expect(html).toContain('updated'); // a typed balance says when it was set
  });

  test('typed terms are planned and labelled as typed, with a way back to Plaid', () => {
    const inputs = { typed: { manual_auto: { apr: '7.9', minimum: '310' }, sapphire: { apr: '19.99' } } };
    const html = panel([chase([sapphire]), ...alliant], inputs);
    expect(html).toContain('value="7.9"');
    expect(html).toContain('value="19.99"');
    expect(html).toContain('Typed');
    expect(html).toContain("Use Plaid's 21.24%");
    expect(html).toContain('Debt-free');
    const plan = expected([chase([sapphire]), ...alliant], inputs).avalanche;
    expect(html).toContain(monthLabel(plan.month!));
  });

  test('a cleared field is needed again rather than quietly using Plaid', () => {
    const html = panel([chase([sapphire])], { typed: { sapphire: { apr: '' } } });
    expect(html).toContain('value=""');
    expect(html).toContain("Use Plaid's 21.24%");
    expect(html).toContain('Add the missing rate or payment for 1 debt below');
  });

  test('a debt can be left out, and the rest is planned without waiting on it', () => {
    const html = panel([chase([sapphire]), ...alliant], { leftOut: { manual_auto: true } });
    expect(html).toContain('Left out of the plan.');
    expect(html).toContain('>Include<');
    expect(html).toContain('Debt-free');
  });

  test('the strategies side by side with minimums only, the chosen one marked, and what it saves', () => {
    const institutions = [chase([sapphire, { ...sapphire, account_id: 'freedom', name: 'Freedom', mask: '9999', balance: 900, liability: { ...sapphire.liability, apr: 27.99, minimum_payment: 40 } }])];
    const html = panel(institutions, { extra: { USD: '200' } });
    expect(html).toContain('<tr class="chosen"><td>Avalanche</td>');
    expect(html).toContain('<td>Snowball</td>');
    expect(html).toContain('<td>Minimums only</td>');
    const c = expected(institutions, {}, 20000);
    expect(html).toContain(`Saves ${formatMoney(c.avalanche.saved.interestCents! / 100, 'USD')} in interest`);
    // The payoff order: the higher rate first.
    expect(html.indexOf('Freedom ••9999')).toBeLessThan(html.indexOf('Sapphire ••4321'));
    // The chart, with what it shows said in words.
    expect(html).toContain(`Avalanche reaches zero in ${monthLabel(c.avalanche.month!)}`);
    expect(html).toContain(`On top of the payments below: ${formatMoney(360, 'USD')} a month in all.`);
  });

  test('the snowball, when chosen, is the one marked', () => {
    const html = panel([chase([sapphire])], { strategy: 'snowball' });
    expect(html).toContain('<tr class="chosen"><td>Snowball</td>');
    expect(html).toContain('Smallest balance first.');
  });

  test('a minimum below the interest is called out, and never paid off is said in words', () => {
    const card = { ...sapphire, balance: 10_000, liability: { ...sapphire.liability, apr: 24, minimum_payment: 150 } };
    const never = panel([chase([card])]);
    expect(never).toContain("$150.00 a month doesn't cover the interest (about $200.00 a month)");
    expect(never).toContain("At $150.00 a month these debts aren't paid off within 50 years");
    expect(never).not.toContain('reaches zero');

    const withExtra = panel([chase([card])], { extra: { USD: '100' } });
    expect(withExtra).toContain('This clears Sapphire ••4321, which paying only the minimums never would.');
    expect(withExtra).toContain('Minimums only, never paid off');
    expect(withExtra).toContain('<td>Minimums only</td><td>Never<div class="payoff-sub">not within 50 years</div></td><td class="num">--</td>');
    // Its line leaves through the top of the chart, where the axis stops,
    // rather than running flat along the edge.
    const baseline = /<path d="([^"]+)"[^>]*stroke="#6b7080"/.exec(withExtra)![1];
    expect(baseline.endsWith(',12.0')).toBe(true);
    expect(baseline.split('L').length).toBeLessThan(200);
  });

  test("a mortgage's payment from Plaid may include escrow, and the planner says so", () => {
    const html = panel([chase([mortgage])]);
    expect(html).toContain('Monthly payment from Plaid');
    expect(html).toContain('can include escrow');
    expect(html).toContain('Interest rate from Plaid');
    // Not once a payment has been typed in its place.
    expect(panel([chase([mortgage])], { typed: { home: { minimum: '1712' } } })).not.toContain('can include escrow');
  });

  test("a recovered balance shows the day it's from", () => {
    const html = panel([chase([sapphire], { stale_as_of: '2026-08-07' })]);
    expect(html).toContain('balance from Aug 7');
  });

  test('payment details not enabled: says how to get them from Plaid', () => {
    const html = panel([chase([{ ...sapphire, liability: undefined }], { liabilities: 'off' })]);
    expect(html).toContain('tap Enable payment details on its card');
  });

  test('nothing owed is said, not planned', () => {
    const html = panel([chase([{ ...sapphire, balance: 0 }])]);
    expect(html).toContain('Nothing is owed on these cards and loans.');
    expect(html).toContain('Nothing owed');
    expect(html).not.toContain('Debt-free');
  });

  test('an extra that is not an amount holds the plan and says why', () => {
    const html = panel([chase([sapphire])], { extra: { USD: '-5' } });
    expect(html).toContain('Enter an amount of 0 or more.');
    expect(html).toContain('Enter an extra amount of 0 or more to see the plan.');
    expect(html).not.toContain('Debt-free');
  });

  test('debts in two currencies are planned one currency at a time, never added together', () => {
    const euro = { ...sapphire, account_id: 'eu', name: 'Euro Card', mask: '7777', currency: 'EUR', balance: 1000 };
    // Two in dollars and one in euros: the currency with the most debts comes first.
    const institutions = [chase([sapphire, mortgage]), { institution_name: 'N26', liabilities: 'on', accounts: [euro] }];
    const usd = panel(institutions);
    expect(usd).toContain('Your cards and loans are in 2 currencies. Each is planned on its own: nothing is converted between currencies.');
    expect(usd).toContain('aria-pressed="true">USD<');
    expect(usd).toContain('aria-pressed="false">EUR<');
    expect(usd).toContain('Sapphire');
    expect(usd).not.toContain('Euro Card');

    const eur = panel(institutions, { currency: 'EUR' });
    expect(eur).toContain('aria-pressed="true">EUR<');
    expect(eur).toContain('Euro Card');
    expect(eur).not.toContain('Sapphire');
    expect(eur).toContain(formatMoney(1000, 'EUR'));
    expect(eur).toContain('Extra each month (EUR)');
  });

  test('hidden accounts stay out of it entirely', () => {
    const html = panel([chase([sapphire, { ...mortgage, hidden: true }])]);
    expect(html).not.toContain('Mortgage');
  });
});
