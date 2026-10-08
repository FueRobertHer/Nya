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
// Plaid's own example mortgage (LiabilitiesGetResponse in its API spec): its
// payment includes escrow.
const mortgage = {
  account_id: 'home',
  name: 'Mortgage',
  mask: '0001',
  type: 'loan',
  subtype: 'mortgage',
  balance: 56_302.06,
  currency: 'USD',
  liability: {
    kind: 'mortgage' as const,
    apr: 3.99,
    apr_label: 'Interest rate',
    minimum_payment: 3141.54,
    escrow_balance: 3141.54,
    origination_principal_amount: 425_000,
    loan_term: '30 year',
    interest_rate_type: 'fixed',
  },
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
  const { debts } = planRows(debtAccounts(institutions), all);
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
    expect(html).toContain('<div class="total-label">Debt-free</div>');
    expect(html).toContain(monthLabel(plan.month!));
    expect(html).toContain(formatMoney(plan.interestCents! / 100, 'USD'));
    // One debt and no extra: nothing to roll over, so nothing is saved.
    expect(html).toContain('The same as paying only the minimums.');
    // What it costs right now: $4,210.55 at 21.24% / 12.
    expect(html).toContain('About $74.53 a month in interest at this balance.');
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
    // Plaid does have a figure, so the row doesn't claim it has none.
    expect(html).not.toContain('no usable figure');
  });

  test('a card whose record lacks a rate says Plaid has none, and keeps the minimum it has', () => {
    const html = panel([chase([{ ...sapphire, liability: { ...sapphire.liability, apr: null, apr_label: null } }])]);
    expect(html).toContain('Plaid has no usable figure for this one.');
    expect(html).toContain('Minimum from Plaid');
  });

  test('a debt can be left out, and the headline then says what it covers', () => {
    const html = panel([chase([sapphire]), ...alliant], { leftOut: { manual_auto: true } });
    expect(html).toContain('Left out of the plan.');
    expect(html).toContain('>Include it<');
    // Not "Debt-free": the auto loan is still owed.
    expect(html).toContain('<div class="total-label">Paid off</div>');
    expect(html).toContain(', 1 left out</div>');
  });

  test('the strategies side by side with minimums only, the chosen one marked, and what each saving is', () => {
    const institutions = [
      chase([
        sapphire,
        { ...sapphire, account_id: 'freedom', name: 'Freedom', mask: '9999', balance: 900, liability: { ...sapphire.liability, apr: 27.99, minimum_payment: 40 } },
      ]),
    ];
    const html = panel(institutions, { extra: { USD: '200' } });
    expect(html).toContain('<tr class="chosen"><td>Avalanche</td>');
    expect(html).toContain('<td>Snowball</td>');
    expect(html).toContain('<td>Minimums only</td>');
    const c = expected(institutions, {}, 20000);
    const extra = c.avalanche.extraSaved!;
    // Two plain lines: the extra alone, then everything against minimums only.
    expect(html).toContain(
      `The extra $200.00 a month saves ${formatMoney(extra.interestCents! / 100, 'USD')} in interest and`
    );
    expect(html).toContain(
      `Against paying only the minimums, this saves ${formatMoney(c.avalanche.saved.interestCents! / 100, 'USD')} in interest`
    );
    // The payoff order: the higher rate first.
    expect(html.indexOf('Freedom ••9999')).toBeLessThan(html.indexOf('Sapphire ••4321'));
    // The chart, with what it shows said in words.
    expect(html).toContain(`Avalanche reaches zero in ${monthLabel(c.avalanche.month!)}`);
    expect(html).toContain(`On top of the payments below: ${formatMoney(360, 'USD')} a month in all.`);
    // The readout keeps its figures on one line and the date on its own.
    expect(html).toContain('chart-readout chart-readout-stable');
  });

  test('the snowball, when chosen, is the one marked', () => {
    const html = panel([chase([sapphire])], { strategy: 'snowball' });
    expect(html).toContain('<tr class="chosen"><td>Snowball</td>');
    expect(html).toContain('Smallest balance first.');
  });

  test('a minimum below the interest is called out, and never is said only where it is true', () => {
    const card = { ...sapphire, balance: 10_000, liability: { ...sapphire.liability, apr: 24, minimum_payment: 150 } };
    const never = panel([chase([card])]);
    expect(never).toContain("$150.00 a month doesn't cover the interest (about $200.00 a month)");
    expect(never).toContain("At $150.00 a month these debts aren't paid off within 50 years: the payments don't cover the interest.");
    expect(never).not.toContain('reaches zero');

    const withExtra = panel([chase([card])], { extra: { USD: '100' } });
    expect(withExtra).toContain(
      "Against paying only the minimums: this clears Sapphire ••4321, which minimums alone don't within 50 years."
    );
    expect(withExtra).toContain("Without the extra $100.00 a month, these debts aren't paid off within 50 years.");
    expect(withExtra).toContain('Minimums only, not paid off by 50 years');
    expect(withExtra).toContain('<td>Minimums only</td><td>Not by 50 years<div class="payoff-sub">not within 50 years</div></td><td class="num">--</td>');
    // Its line leaves through the top of the chart, where the axis stops,
    // rather than running flat along the edge.
    const baseline = /<path d="([^"]+)"[^>]*stroke="#6b7080"/.exec(withExtra)![1];
    expect(baseline.endsWith(',12.0')).toBe(true);
    expect(baseline.split('L').length).toBeLessThan(200);
  });

  test('past 50 years with a payment that does cover the interest: too slow, not "never"', () => {
    // $60,000 at 6% is $300 a month of interest; $300.50 clears it in about a century.
    const loan = { ...sapphire, account_id: 'big', name: 'Big Loan', type: 'loan', balance: 60_000, liability: { kind: 'student' as const, apr: 6, apr_label: 'Interest rate', minimum_payment: 300.5 } };
    const html = panel([chase([loan])]);
    expect(html).toContain("At $300.50 a month these debts aren't paid off within 50 years. Add more each month.");
    expect(html).not.toContain("don't cover the interest");
    expect(html).toContain('About $300.00 a month in interest at this balance.');
  });

  test('a payment equal to the interest only covers it, and no payment at all is said plainly', () => {
    const card = { ...sapphire, balance: 10_000, liability: { ...sapphire.liability, apr: 24, minimum_payment: 200 } };
    expect(panel([chase([card])])).toContain('$200.00 a month only covers the interest, so on its own the balance never falls.');
    const free = { ...sapphire, balance: 500, liability: { ...sapphire.liability, apr: 0, minimum_payment: 20 } };
    expect(panel([chase([free])], { typed: { sapphire: { minimum: '0' } } })).toContain(
      'With no payment, it never pays off on its own.'
    );
  });

  test("a mortgage reporting escrow waits for its principal and interest, says why by the headline, and offers it worked out", () => {
    const html = panel([chase([sapphire, mortgage])]);
    expect(html).toContain('Add the missing rate or payment for 1 debt below');
    expect(html).toContain("Mortgage ••0001: Plaid's $3,141.54 payment includes escrow, which doesn't pay down the loan, so its principal and interest are needed.");
    expect(html).toContain('the escrow account holds $3,141.54');
    expect(html).toContain('Use $2,026.57, worked out from the original $425,000.00 over 30 years at 3.99%');
    // Plaid's escrow-inclusive figure is never one tap away, and the field is empty.
    expect(html).not.toContain("No escrow? Use Plaid's");
    expect(html).not.toContain('value="3141.54"');
    expect(html).not.toContain('Debt-free');

    const taken = panel([chase([sapphire, mortgage])], { typed: { home: { minimum: '2026.57' } } });
    expect(taken).toContain('Worked out from the original loan');
    expect(taken).toContain('Debt-free');
  });

  test('a mortgage with no escrow reported can be confirmed as having none', () => {
    const plain = { ...mortgage, liability: { ...mortgage.liability, escrow_balance: null } };
    const html = panel([chase([plain])]);
    expect(html).toContain("Plaid's $3,141.54 is the whole monthly payment and may include escrow");
    expect(html).toContain("No escrow? Use Plaid's $3,141.54");
    const confirmed = panel([chase([plain])], { typed: { home: { minimum: '3141.54' } } });
    expect(confirmed).toContain('Monthly payment from Plaid, with no escrow');
  });

  test("a student loan's accrued interest is owed, shown, and can be left out", () => {
    const loan = {
      ...sapphire,
      account_id: 'student',
      name: 'Student Loan',
      type: 'loan',
      subtype: 'student',
      balance: 65_262,
      liability: { kind: 'student' as const, apr: 5.25, apr_label: 'Interest rate', minimum_payment: 700, outstanding_interest: 6227.36 },
    };
    const html = panel([chase([loan])]);
    expect(html).toContain('$71,489.36'); // $65,262 plus $6,227.36
    expect(html).toContain('Includes $6,227.36 of accrued interest.');
    expect(html).toContain('>Leave it out<');
    const without = panel([chase([loan])], { withoutAccrued: { student: true } });
    expect(without).toContain('$65,262.00');
    expect(without).toContain('$6,227.36 of accrued interest left out.');
  });

  test('a $0 minimum from Plaid is needed, with the likely reasons, by the headline and on the row', () => {
    const loan = { ...sapphire, account_id: 'nav', name: 'Navient Loan', type: 'loan', subtype: 'student', balance: 20_000, liability: { kind: 'student' as const, apr: 8.5, apr_label: 'Interest rate', minimum_payment: 0 } };
    const html = panel([chase([loan])]);
    expect(html).toContain("Navient Loan ••4321: Plaid shows a $0.00 minimum, which usually isn't a real payment.");
    expect(html).toContain('usually autopay at some servicers, nothing due this cycle, or a deferment');
    expect(html).not.toContain("doesn't cover the interest");
    expect(html).not.toContain('Debt-free');
  });

  test('loans sharing one minimum split it by balance, say so, and can be billed separately', () => {
    const share = (id: string, balance: number) => ({
      ...sapphire,
      account_id: id,
      name: `Loan ${id}`,
      mask: null,
      type: 'loan',
      subtype: 'student',
      balance,
      liability: { kind: 'student' as const, apr: 4.9, apr_label: 'Interest rate', minimum_payment: 400 },
    });
    const greatLakes = { institution_name: 'Great Lakes', liabilities: 'on', accounts: [share('a', 8000), share('b', 7000), share('c', 9000), share('d', 6000)] };
    const html = panel([greatLakes]);
    expect(html).toContain('Plaid shows one $400.00 payment on 4 student loans at Great Lakes, so it\'s split across them by balance.');
    expect(html).toContain('Share of one $400.00 payment on 4 loans');
    expect(html).toContain('value="106.67"');
    expect(html).toContain('Billed separately? Use $400.00 for this loan');
    expect(html).toContain(`On top of the payments below: ${formatMoney(400, 'USD')} a month in all.`);
  });

  test('a card paid in full starts out of the plan, shows no interest, and can be put in', () => {
    const paid = { ...sapphire, liability: { ...sapphire.liability, last_payment_amount: 980.5, last_statement_balance: 980.5 } };
    const html = panel([chase([paid])]);
    expect(html).toContain("Paid in full at its last statement: no interest is charged while that continues, so it's left out.");
    expect(html).toContain('This card is paid in full each month, so no balance is carried to pay off.');
    expect(html).not.toContain('a month in interest');
    const included = panel([chase([paid])], { leftOut: { sapphire: false } });
    expect(included).toContain("It's planned here as a balance carried, with interest.");
    expect(included).toContain('Debt-free');
  });

  test("a card's rates are blended, and the parts are named", () => {
    const card = {
      ...sapphire,
      balance: 2775.55,
      liability: {
        ...sapphire.liability,
        apr: 12.5,
        apr_balances: [
          { type: 'purchase_apr', rate: 12.5, balance: 1775.55 },
          { type: 'special', rate: 0, balance: 1000 },
        ],
      },
    };
    const html = panel([chase([card])]);
    expect(html).toContain('Blended APR from Plaid');
    expect(html).toContain('12.5% on $1,775.55 (purchases), 0% on $1,000.00 (a special rate)');
    expect(html).toContain('a promotional rate is taken as lasting');
  });

  test('says which institutions the plan cannot see, by the headline', () => {
    const html = panel([chase([sapphire]), { institution_name: 'Citi', error: 'Could not fetch balances', accounts: [] }]);
    expect(html).toContain("Citi couldn't be loaded, so any cards or loans there aren't in this plan.");
    expect(html).toContain('<div class="total-label">Paid off</div>');
    expect(html.indexOf("Citi couldn't be loaded")).toBeLessThan(html.indexOf('Paid off'));
  });

  test("a recovered balance shows the day it's from, and why its terms are missing", () => {
    const html = panel([chase([{ ...sapphire, liability: undefined }], { stale_as_of: '2026-08-07', liabilities: 'unavailable', error: 'Could not fetch balances' })]);
    expect(html).toContain('balance from Aug 7');
    expect(html).toContain("This institution couldn't be reached");
    expect(html).toContain("Chase couldn't be reached: its balances here are from Aug 7.");
  });

  test('payment details not enabled: says how to get them from Plaid', () => {
    const html = panel([chase([{ ...sapphire, liability: undefined }], { liabilities: 'off' })]);
    expect(html).toContain('tap Enable payment details on its card');
  });

  test('nothing owed is said, not planned, and unknown is not called zero', () => {
    const html = panel([chase([{ ...sapphire, balance: 0 }])]);
    expect(html).toContain('Nothing is owed on these cards and loans.');
    expect(html).toContain('Nothing owed');
    expect(html).not.toContain('Debt-free');
    const unknown = panel([chase([{ ...sapphire, balance: null }])]);
    expect(unknown).toContain("No balance was reported for these cards and loans, so there's nothing to plan.");
    expect(unknown).not.toContain('Nothing is owed');
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
    const auto = { ...sapphire, account_id: 'auto', name: 'Auto', type: 'loan', subtype: 'auto', balance: 9000, liability: { kind: 'credit' as const, apr: 7, apr_label: 'Interest rate', minimum_payment: 250 } };
    const institutions = [chase([sapphire, auto]), { institution_name: 'N26', liabilities: 'on', accounts: [euro] }];
    const usd = panel(institutions);
    expect(usd).toContain('Your cards and loans are in 2 currencies. Each is planned on its own: nothing is converted between currencies.');
    expect(usd).toContain('aria-pressed="true">USD<');
    expect(usd).toContain('aria-pressed="false">EUR<');
    expect(usd).toContain('Sapphire');
    expect(usd).not.toContain('Euro Card');
    // Not "Debt-free": the euro card is still owed.
    expect(usd).toContain(', USD only</div>');

    const eur = panel(institutions, { currency: 'EUR' });
    expect(eur).toContain('aria-pressed="true">EUR<');
    expect(eur).toContain('Euro Card');
    expect(eur).not.toContain('Sapphire');
    expect(eur).toContain(formatMoney(1000, 'EUR'));
    expect(eur).toContain('Extra each month (EUR)');
  });

  test('debts with no currency code are shown without a dollar sign, and may be mixed', () => {
    const odd = { ...sapphire, currency: null };
    const html = panel([chase([odd])]);
    expect(html).toContain('may not all be in the same currency');
    expect(html).toContain('>4,210.55<');
    expect(html).not.toContain('$4,210.55');
  });

  test('hidden accounts stay out of it entirely', () => {
    const html = panel([chase([sapphire, { ...mortgage, hidden: true }])]);
    expect(html).not.toContain('Mortgage');
  });
});
