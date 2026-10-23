import { describe, expect, test, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunwayView, SavedScenarios, lastsWords, scenarioToSave } from '@/components/RunwayReport';
import { whatIfWords } from '@/lib/report/runway-words';
import { reportDay } from '@/components/ReportView';
import { parseRunwayScenario } from '@/lib/report/runway-scenarios';
import { YearOverYearView, pctWords } from '@/components/YearOverYearReport';
import { reportChoice } from '@/components/ReportsPage';
import { cashPosition } from '@/lib/forecast';
import { DEFAULT_WHAT_IF, RUNWAY_WINDOWS, buildRunwayInputs, projectRunway, type RunwayWhatIf } from '@/lib/report/runway';
import type { RunwayReport } from '@/lib/report/runway-read';
import { buildYearOverYear } from '@/lib/report/year-over-year';
import type { YearOverYearReport } from '@/lib/report/year-over-year-read';
import { MASK, setAmountsHidden } from '@/lib/format';
import { PLANNED, ROWS, TODAY, row } from './runway-fixture';
import { categoriesFor } from './category-fixture';

// The runway and year over year as the report page draws them
// (components/RunwayReport.tsx, components/YearOverYearReport.tsx): how long,
// both ways, and the day, as test/runway.test.ts works them by hand; what
// each is worked out from, listed; what each can't see, said; the what-if in
// words, never sent anywhere but as a scenario the person saves; amounts
// hidden when the switch says so; and where the page offers them.

const ROOT = join(import.meta.dir, '..');
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

afterEach(() => setAmountsHidden(false));

const position = cashPosition([
  {
    institution_name: 'Chase',
    accounts: [
      { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 7000, currency: 'USD' },
      { account_id: 'sav', name: 'Savings', type: 'depository', subtype: 'savings', balance: 5000, currency: 'USD' },
    ],
  },
]);

function runway(over: Partial<RunwayReport> = {}): RunwayReport {
  const built = buildRunwayInputs({ today: TODAY, position, rows: ROWS, planned: PLANNED, dismissed: [], short: [{ month: '2026-08', institutions: ['Citi'] }] });
  return {
    ...built,
    version: 1,
    time_zone: 'America/New_York',
    generated_at: '2026-10-22T15:00:00.000Z',
    cash_accounts: built.position.included.map((a) => ({ account_id: a.account_id, name: a.name, institution: a.institution, balance: a.balance, manual: a.manual, as_of: '2026-10-21' })),
    owed_on_cards: 600,
    stale_balances: [],
    gaps: RUNWAY_WINDOWS.map((months) => ({ months, gaps: [{ kind: 'stale' as const, item_id: 'item_citi', institution: 'Citi', since: '2026-08-20' }] })),
    data_as_of: '2026-10-22T13:00:00.000Z',
    notes: ['Cash inside investment accounts, such as a brokerage’s settlement or money market fund, isn’t counted: it is money waiting to be invested, days from being spent.'],
    ...over,
  };
}
const three = (over: Partial<RunwayWhatIf> = {}): RunwayWhatIf => ({ ...DEFAULT_WHAT_IF, months: 3, ...over });
const draw = (r: RunwayReport = runway(), w: RunwayWhatIf = three()) => renderToStaticMarkup(<RunwayView runway={r} projection={projectRunway(r, w)} />);

describe('the runway, drawn', () => {
  test('how long, both ways, and the day, as worked by hand', () => {
    const t = text(draw());
    expect(t).toContain('Cash now $12,000.00');
    expect(t).toContain('Without income 3.0 months');
    expect(t).toContain('With your income 7.3 months');
    expect(t).toContain('If your income stopped, your cash would last 93 days, to around Jan 23, 2027; runs out around Jan 24, 2027.');
    expect(t).toContain('With your income, 225 days, to around Jun 4, 2027; runs out around Jun 5, 2027. An estimate.');
    expect(t).toContain('Worked out with spending over the last 3 full months and what you planned in.');
    // The chart: both lines, and the day each runs out marked.
    const html = draw();
    expect(html.match(/<path d="M/g)?.length).toBe(2);
    expect(html.match(/<circle /g)?.length).toBe(2);
  });

  test('what it is worked out from, listed', () => {
    const t = text(draw());
    expect(t).toContain('$12,000.00 in Checking at Chase and Savings at Chase: $12,000.00.');
    expect(t).toContain('The oldest of these balances is from Oct 21, 2026.');
    expect(t).toContain('$9,200.00 over Jul 1, 2026 to Sep 30, 2026 (92 days), about $3,043.75 a month.');
    expect(t).toContain('Midas, Aug 15, 2026: $2,000.00');
    expect(t).toContain('$6,440.00 over the same days, about $2,130.63 a month: pay and other money in, refunds aside.');
    expect(t).toContain('Home Loans from Checking: $800.00, monthly, next around Nov 5, 2026');
    expect(t).toContain('Car registration: an expense of $300.00, once, next on Dec 1, 2026');
    expect(t).toContain('Tax refund: income of $1,000.00, once, next on Mar 15, 2027');
    expect(t).toContain('Bills already in your spending that come monthly or more often, rent among them, aren’t added again. Nothing here is saved.');
    expect(t).toContain('Money out as the Activity tab counts it: $9,200.00');
  });

  test('what it can’t see, said first', () => {
    const t = text(draw());
    expect(t).toContain('What it can’t see:');
    expect(t).toContain('Aug 2026 may be missing transactions from Citi, so the spending, and the income, may be low.');
    expect(t).toContain('Citi hasn’t synced since Aug 20, 2026, so this report may be missing some of its transactions.');
    expect(t).toContain("1 transaction in EUR isn't in these totals, which are in USD.");
    expect(t).toContain('Your cards owe $600.00: their charges are in the spending as they are made, but paying them off comes out of this cash, which this doesn’t take off.');
    expect(t).toContain('Cash inside investment accounts');
    // The window it reads: July isn't short.
    expect(text(draw(runway(), three({ months: 12 })))).toContain('Aug 2026 may be missing');
  });

  test('a what-if, in words and in the figures', () => {
    const t = text(draw(runway(), three({ lower_by: 304.38, income_until: '2026-12-31', planned: false, leave_out_one_offs: true })));
    expect(t).toContain('Worked out with spending over the last 3 full months, spending lower by $304.38 a month, income stopping after Dec 31, 2026, what you planned left out and one-offs left out.');
    expect(t).toContain('With income until Dec 31, 2026');
    expect(t).toContain('Left out as one-offs:');
    expect(t).toContain('Left out in this what-if.');
    expect(t).toContain('It stops after Dec 31, 2026 in this what-if.');
    expect(t).toContain('a month in this what-if');
  });

  test('what leaves cash unseen is said: a card Nya doesn’t see, transfers out and cash taken out, and the what-if that counts them', () => {
    const amex = ['07', '08', '09'].map((m) => row(`amex-${m}`, `2026-${m}-12`, 1500, { name: 'AMEX EPAYMENT', category: 'loan payments', subcategory: 'credit card payment' }));
    // Rent for a sublet paid by Zelle, and a move to a health savings account
    // in Nya, which isn't cash here; the move to savings arrived there.
    const moves = [
      row('zelle', '2026-09-08', 1000, { name: 'ZELLE TO J SMITH', category: 'transfer out', transaction_code: 'transfer' }),
      row('to-hsa', '2026-07-17', 250, { name: 'To HSA', category: 'transfer out', transaction_code: 'transfer' }),
      row('hsa-in', '2026-07-20', -250, { name: 'Contribution', account_name: 'Health', category: 'transfer in', transaction_code: 'transfer' }),
    ];
    const built = buildRunwayInputs({ today: TODAY, position, rows: [...ROWS, ...amex, ...moves], planned: PLANNED, dismissed: [] });
    const r = runway({ ...built });
    const t = text(draw(r));
    expect(t).toContain('AMEX EPAYMENT from Checking looks like a card’s payment, and no card in Nya shows it arriving, so its $4,500.00 over these months counts as spending here');
    expect(t).toContain('plus payments to cards Nya doesn’t see: $4,500.00');
    expect(t).toContain('AMEX EPAYMENT from Checking: $4,500.00 over 3 payments');
    expect(t).toContain('$13,700.00 over Jul 1, 2026 to Sep 30, 2026');
    expect(t).toContain(
      'Over these months, money went out of your checking and savings that isn’t in the spending: $1,000.00 in transfers no account in Nya shows arriving (a payment by Zelle or Venmo, a move to an account Nya doesn’t hold); $250.00 in transfers to your accounts in Nya that aren’t counted as cash here (a health savings account, an investment account); and $200.00 in cash taken out. Categorize what was spending as such, or count it in the what-if.'
    );
    // Never the move to savings, which arrived.
    expect(t).not.toContain('$2,000.00 in transfers');
    const counted = text(draw(r, three({ count_moved_out: true })));
    expect(counted).toContain('This what-if counts all of it as spending.');
    expect(counted).toContain('transfers out and cash taken out counted');
    expect(counted).toContain('a month in this what-if');
  });

  test('no spending to go by is said, never "doesn’t run out"', () => {
    const r = runway({ windows: runway().windows.map((w) => ({ ...w, transactions: 0, card_payments: [], spending: 0, money_out: 0, income: 0, money_in: 0 })) });
    const t = text(draw(r));
    expect(t).toContain('There are no transactions in these months to go by, so no runway is given');
    expect(t).toContain('Without income Not known');
    expect(t).not.toContain('Doesn’t run out');
    expect(t).not.toContain('Nothing is known to be missing');
    expect(draw(r)).not.toContain('<svg');
  });

  test('income that stopped on a day gone is labelled so, never as income', () => {
    const t = text(draw(runway(), three({ income_until: '2026-09-30' })));
    expect(t).toContain('Income stopped after Sep 30, 2026 3.0 months');
    expect(t).toContain('It stopped after Sep 30, 2026 in this what-if.');
    expect(t).not.toContain('With your income');
  });

  test('one-offs left out are said only where the window has some', () => {
    const none = runway({ windows: runway().windows.map((w) => ({ ...w, one_offs: [], one_offs_total: 0, one_offs_in: [], one_offs_in_total: 0 })) });
    expect(text(draw(none, three({ leave_out_one_offs: true })))).not.toContain('one-offs left out');
    expect(text(draw(runway(), three({ leave_out_one_offs: true })))).toContain('one-offs left out');
  });

  test('the outcomes in words: below zero now, more than ten years, covered', () => {
    const p = projectRunway(runway({ start: -5 }), three());
    expect(lastsWords(p.without_income, TODAY)).toEqual({ figure: 'None', words: 'below zero now' });
    const line = { ...p.without_income, outcome: 'beyond' as const, runs_out: null, days: null, months: null };
    expect(lastsWords(line, TODAY).figure).toBe('Over 10 years');
    expect(lastsWords({ ...line, outcome: 'covered' }, TODAY)).toEqual({ figure: 'Doesn’t run out', words: 'at this rate, what comes in covers what goes out' });
    expect(lastsWords({ ...line, outcome: 'no_cash' }, TODAY).figure).toBe('No cash');
    expect(lastsWords({ ...line, outcome: 'no_spending' }, TODAY).figure).toBe('Not known');
    expect(whatIfWords(DEFAULT_WHAT_IF, 'USD', reportDay)).toBe('Worked out with spending over the last 6 full months and what you planned in.');
  });

  test('with no cash, it says how to get one rather than a figure', () => {
    const empty = runway({ cash_accounts: [], start: 0, position: { ...position, included: [], balances: 0, start: 0 } });
    const t = text(draw(empty));
    expect(t).toContain('A runway starts from your checking, savings and cash on hand.');
    expect(t).not.toContain('Without income');
  });

  test('with amounts hidden: no figure, and the months and days stay, since they say no amount', () => {
    (globalThis as Record<string, unknown>).window ??= {};
    setAmountsHidden(true);
    const html = draw();
    delete (globalThis as Record<string, unknown>).window;
    const t = text(html);
    expect(t).not.toMatch(/\$\d/);
    expect(t).toContain(MASK);
    expect(t).toContain('Without income 3.0 months');
    expect(t).toContain('runs out around Jan 24, 2027');
    expect(html).toContain('<span class="visually-hidden">');
  });
});

describe('the saved scenarios', () => {
  const saved = { v: 1 as const, name: 'If I quit', months: 6 as const, lower_by: 250, currency: 'USD', income_until: '2026-12-31', planned: true, leave_out_one_offs: false, saved_at: '2026-10-01T00:00:00.000Z' };

  test('each with its settings in words, Apply and Delete; one that can’t be read can be deleted, a newer one is only counted', () => {
    const t = text(
      renderToStaticMarkup(
        <SavedScenarios list={{ scenarios: [{ id: 's1', ...saved }], unreadable_ids: ['bad'], unrecognised_ids: ['later'] }} currency="USD" busy={false} onApply={() => {}} onDelete={() => {}} />
      )
    );
    expect(t).toContain('If I quit');
    expect(t).toContain('Worked out with spending over the last 6 full months, spending lower by $250.00 a month, income stopping after Dec 31, 2026 and what you planned in.');
    expect(t.match(/Apply/g)?.length).toBe(1);
    expect(t.match(/Delete/g)?.length).toBe(2);
    expect(t).toContain('A saved scenario that can’t be read');
    expect(t).toContain('One more was saved by a newer version of Nya');
    expect(text(renderToStaticMarkup(<SavedScenarios list={{ scenarios: [], unreadable_ids: [], unrecognised_ids: [] }} currency="USD" busy={false} onApply={() => {}} onDelete={() => {}} />))).toContain('None yet.');
    expect(text(renderToStaticMarkup(<SavedScenarios list={null} currency="USD" busy={false} onApply={() => {}} onDelete={() => {}} />))).toContain('aren’t loaded');
  });

  test('Save sends the what-if as worked out, its lower spending with the currency it was typed in, and the server takes it', () => {
    const lower = scenarioToSave('If I quit', three({ lower_by: 304.38, income_until: '2026-12-31' }), 'USD');
    expect(lower).toEqual({ name: 'If I quit', months: 3, lower_by: 304.38, income_until: '2026-12-31', planned: true, leave_out_one_offs: false, count_moved_out: false, currency: 'USD' });
    expect(parseRunwayScenario(lower, 0)).toMatchObject({ ok: { lower_by: 304.38, currency: 'USD' } });
    const none = scenarioToSave('As it is', DEFAULT_WHAT_IF, 'USD');
    expect(none.currency).toBeNull();
    expect('ok' in parseRunwayScenario(none, 0)).toBe(true);
  });

  test('a lower spending set in another currency isn’t applied to this one', () => {
    const t = text(
      renderToStaticMarkup(<SavedScenarios list={{ scenarios: [{ id: 's1', ...saved, currency: 'EUR' }], unreadable_ids: [], unrecognised_ids: [] }} currency="USD" busy={false} onApply={() => {}} onDelete={() => {}} />)
    );
    expect(t).not.toContain('lower by');
  });

  test('the what-if is never sent: the runway is asked for with the time zone alone, and only a scenario saved by name is written', () => {
    const src = readFileSync(join(ROOT, 'components', 'RunwayReport.tsx'), 'utf8');
    expect(src).toContain("fetch(`/api/reports/runway?tz=${encodeURIComponent(browserZone())}`)");
    const writes = [...src.matchAll(/fetch\(([^,)]+),\s*\{\s*method: '(\w+)'/g)].map((m) => [m[1], m[2]]);
    expect(writes).toEqual([
      ["'/api/runway-scenarios'", 'POST'],
      ["'/api/runway-scenarios'", 'DELETE'],
    ]);
    // No browser storage either.
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
});

describe('year over year, drawn', () => {
  const { taxonomy } = categoriesFor({}, { words: ['food and drink', 'rent and utilities', 'income', 'general merchandise'] });
  const rows = [
    row('food-25', '2025-08-10', 650, { category: 'food and drink' }),
    row('food-26', '2026-08-10', 800, { category: 'food and drink' }),
    row('refund-26', '2026-09-09', -20),
    row('pay-25', '2025-01-15', -3000, { category: 'income' }),
    row('pay-26', '2026-01-15', -3200, { category: 'income' }),
    row('food-oct-25', '2025-10-10', 250, { category: 'food and drink' }),
    row('food-oct-26', '2026-10-05', 300, { category: 'food and drink' }),
  ];
  const report = (over: Partial<YearOverYearReport> = {}): YearOverYearReport => ({
    ...buildYearOverYear({ rows, taxonomy, currency: 'USD', today: TODAY, short: new Map([['2026-08', { uncertain: true, institutions: ['Citi'] }]]) }),
    version: 1,
    today: TODAY,
    time_zone: 'America/New_York',
    generated_at: '2026-10-22T15:00:00.000Z',
    gaps: [{ kind: 'stale', item_id: 'item_citi', institution: 'Citi', since: '2026-08-20' }],
    data_as_of: '2026-10-22T13:00:00.000Z',
    caveats: { hidden: true, scope: { investment: true, loans: false }, names_unread: false, notes: [] },
    ...over,
  });

  test('the years, this month, every month, and every group and category, with the change and the percent', () => {
    const t = text(renderToStaticMarkup(<YearOverYearView report={report()} />));
    expect(t).toContain('Jan 1, 2026 to Oct 22, 2026, against the same days of 2025.');
    expect(t).toContain('Money out $1,100.00 last year $900.00; +$200.00 (+22.2%)');
    expect(t).toContain('Money in $3,220.00 last year $3,000.00; +$220.00 (+7.3%)');
    expect(t).toContain('This year may be short of Citi.');
    expect(t).toContain('Oct 2026 so far');
    expect(t).toContain('Money out $300.00 last year $250.00; +$50.00 (+20.0%)');
    expect(t).toContain('Oct 2026 (to the 22nd)');
    expect(t).toContain('Aug 2026 $800.00 $650.00 +$150.00 +23.1% This year may be short of Citi');
    // A group, then its categories; new when last year had none.
    expect(t).toContain('Food $1,100.00 $900.00 +$200.00 +22.2% food and drink $1,100.00 $900.00 +$200.00 +22.2%');
    expect(t).toContain('Shopping $20.00 $0.00 +$20.00 new');
    // What it can't see, first.
    expect(t).toContain('These figures may be incomplete:');
    expect(t).toContain('Citi hasn’t synced since Aug 20, 2026');
    expect(t).toContain('Hidden accounts are left out.');
    expect(t).toContain('Activity inside investment accounts, such as trades, dividends and interest, isn’t in it.');
  });

  test('nothing in either year says so, rather than tables of zeros', () => {
    const empty = buildYearOverYear({ rows: [], taxonomy, currency: 'USD', today: TODAY });
    const t = text(renderToStaticMarkup(<YearOverYearView report={report({ ...empty, gaps: [], caveats: { hidden: false, scope: { investment: false, loans: false }, names_unread: false, notes: [] } })} />));
    expect(t).toContain('There are no transactions in either year to compare.');
    expect(t).toContain('Nothing is known to be missing from either year.');
    expect(t).not.toContain('By month');
  });

  test('the percent in words', () => {
    expect(pctWords({ this: 110, last: 100, change: 10, pct: 10 })).toBe('+10.0%');
    expect(pctWords({ this: 90, last: 100, change: -10, pct: -10 })).toBe('-10.0%');
    expect(pctWords({ this: 5, last: 0, change: 5, pct: null })).toBe('new');
    expect(pctWords({ this: 0, last: 0, change: 0, pct: null })).toBe('');
  });

  test('with amounts hidden: no figure, the percentages stay', () => {
    (globalThis as Record<string, unknown>).window ??= {};
    setAmountsHidden(true);
    const t = text(renderToStaticMarkup(<YearOverYearView report={report()} />));
    delete (globalThis as Record<string, unknown>).window;
    expect(t).not.toMatch(/\$\d/);
    expect(t).toContain('+22.2%');
  });
});

describe('where they are found', () => {
  test('the report page offers all three, and the address can ask for one', () => {
    expect(reportChoice('?report=runway')).toBe('runway');
    expect(reportChoice('?report=year-over-year')).toBe('year-over-year');
    expect(reportChoice('?kind=year&year=2025')).toBe('accountant');
    expect(reportChoice('?report=other')).toBe('accountant');
    const page = readFileSync(join(ROOT, 'components', 'ReportsPage.tsx'), 'utf8');
    for (const label of ['For your accountant', 'Runway', 'Year over year']) expect(page).toContain(`label: '${label}'`);
    expect(page).toContain("{which === 'runway' && <RunwayReport />}");
  });

  test('the cash forecast points to the runway', () => {
    const forecast = readFileSync(join(ROOT, 'components', 'ForecastCard.tsx'), 'utf8');
    expect(forecast).toContain('href="/reports?report=runway"');
  });
});
