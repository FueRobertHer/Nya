import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ForecastCard from '@/components/ForecastCard';
import CalendarView from '@/components/CalendarView';
import RecurringCard from '@/components/RecurringCard';
import PlannedCard from '@/components/PlannedCard';
import UpcomingPanel from '@/components/UpcomingPanel';
import BudgetsTab from '@/components/BudgetsTab';
import Insights from '@/components/Insights';
import type { Txn } from '@/components/MonthBreakdown';
import { addDays, detectRecurring, scheduleDates, type RecurringRow, type RecurringSeries } from '@/lib/recurring';
import { addMonths } from '@/lib/calendar';
import { EMPTY_PLANNED, type Planned } from '@/lib/planned';
import type { ForecastInstitution } from '@/lib/forecast';
import { localDate } from '@/lib/local-date';
import { EMPTY_BUDGETS } from '@/lib/budget-set';
import { NO_CONNECTIONS_WITHOUT } from '@/lib/no-transactions';
import { DrawnWidth } from '@/components/drawn-width';

// The forecast, the calendar, the recurring list and the planned items as the
// Budgets tab renders them, and Home's upcoming bills: what each says, and
// that an estimate is always labelled as one. What the segment may be missing
// is said once at its top (rollout phase 6a3), so those sentences are read
// off Upcoming as a whole.

/** Markup as text, tags dropped and entities decoded, for reading sentences. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

const TODAY = '2026-10-09';

function txn(over: Partial<Txn>): Txn {
  return {
    transaction_id: 't',
    date: TODAY,
    name: 'Shop',
    amount: 10,
    pending: false,
    account_name: 'Checking',
    account_type: 'depository',
    institution_name: 'Chase',
    category: 'food and drink',
    iso_currency_code: 'USD',
    vendor_key: 'nm:chase::shop',
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
  };
}

const row = (date: string, amount: number, over: Partial<RecurringRow> = {}): RecurringRow => ({
  date,
  name: 'Netflix',
  amount,
  institution_name: 'Chase',
  account_name: 'Checking',
  account_type: 'depository',
  category: 'entertainment',
  transaction_code: null,
  iso_currency_code: 'USD',
  ...over,
});
const monthly = (from: string, count: number, day: number) => scheduleDates({ unit: 'month', every: 1, days: [day], month: from, slot: 0 }, '2100-01-01', count);

const chase = (over: Partial<ForecastInstitution> = {}): ForecastInstitution => ({
  institution_name: 'Chase',
  item_id: 'item_1',
  accounts: [{ account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 900, currency: 'USD' }],
  ...over,
});

/** Rent on the 15th and pay on the 25th, both detected from six months. */
function series(): RecurringSeries[] {
  return detectRecurring([
    ...monthly('2026-04', 6, 15).map((d) => row(d, 1500, { name: 'Rent', category: 'rent and utilities' })),
    ...monthly('2026-04', 6, 25).map((d) => row(d, -2000, { name: 'Payroll', category: 'income' })),
  ]);
}

describe('the forecast', () => {
  const card = (over: Partial<Parameters<typeof ForecastCard>[0]> = {}) =>
    text(renderToStaticMarkup(<ForecastCard institutions={[chase()]} series={series()} planned={EMPTY_PLANNED} today={TODAY} {...over} />));
  // Upcoming as the Budgets tab draws it, for what is said at its top.
  const upcoming = (over: Partial<Parameters<typeof UpcomingPanel>[0]> = {}) =>
    text(
      renderToStaticMarkup(
        <UpcomingPanel
          institutions={[chase()]}
          series={series()}
          planned={EMPTY_PLANNED}
          plannedStatus="ready"
          plannedDrawn
          plannedError={null}
          plannedSaveError={null}
          dismissed={new Set()}
          txns={[]}
          failed={false}
          balancesAsOf={null}
          balancesSaved={false}
          incomplete={[]}
          stopped={[]}
          withoutTransactions={NO_CONNECTIONS_WITHOUT}
          fx={null}
          today={TODAY}
          currency="USD"
          plannedCurrency="USD"
          noSpending={null}
          {...over}
        />
      )
    );

  // The screen review: "$125K" sat on the line. Where its axis starts just
  // under zero (the case that once drew "−$0" as a tick), the plot has no
  // gridline and no amount, and zero's rule is named in a word instead.
  test('no money on its plot at a phone’s width: zero’s rule is named in a word, and every day is behind Show as a table', () => {
    const html = renderToStaticMarkup(
      <DrawnWidth.Provider value={248}>
        <ForecastCard institutions={[chase()]} series={series()} planned={EMPTY_PLANNED} today={TODAY} />
      </DrawnWidth.Provider>
    );
    const svg = html.slice(html.indexOf('<svg class="chart-svg at-width"'), html.indexOf('</svg>', html.indexOf('<svg class="chart-svg at-width"')));
    expect(svg).not.toContain('chart-tick');
    expect(svg).not.toContain('stroke="var(--border-subtle)"');
    expect(text(svg)).not.toMatch(/\$/);
    expect(svg).toMatch(/<text class="chart-rule-label" x="8" y="[\d.]+">Zero<\/text>/);
    expect(html).toContain('<summary>Show as a table</summary>');
  });

  test('is labelled an estimate, starts from the cash accounts it names, and gives its lowest point', () => {
    const t = card();
    expect(t).toContain('Cash forecast Estimate');
    expect(t).toContain('Starts from $900.00 in Checking at Chase.');
    // Rent on the 15th takes it to −$600, pay on the 25th back up: dates
    // after today are expectations.
    expect(t).toContain('−$600.00 lowest, around Oct 15 (estimated)');
    expect(t).toContain('Expected to drop below zero around Oct 15.');
    expect(t).toContain('Expected to end near $1,400.00 on Nov 8.');
    expect(t).toContain(
      "An estimate of what leaves and reaches your checking and savings: the bills and income Nya expects on them, and what you planned. A card's own charges aren't in it, since the card's payment is what leaves your checking, and that payment counts only when it repeats at a steady amount. Everyday spending and money moved to your other accounts aren't in it either. On a day with money both in and out, the money out is counted first."
    );
    expect(t).toContain('What if I buy');
    expect(t).toContain('Warns below $100.00');
  });

  // The screen review: ten accounts listed in seven lines.
  test('two accounts are named where it starts; from three on it counts them, and names them behind Which accounts', () => {
    const two = [chase({ accounts: [chase().accounts[0], { account_id: 'sav', name: 'Savings', type: 'depository', subtype: 'savings', balance: 100, currency: 'USD' }] })];
    expect(card({ institutions: two })).toContain('Starts from $1,000.00 in Checking and Savings at Chase.');
    const three = [...two, chase({ institution_name: 'Ally', item_id: 'item_2', accounts: [{ account_id: 'ally', name: 'Online Savings', type: 'depository', subtype: 'savings', balance: 50, currency: 'USD' }] })];
    const html = renderToStaticMarkup(<ForecastCard institutions={three} series={series()} planned={EMPTY_PLANNED} today={TODAY} balancesAsOf="2026-10-07T15:12:00" balancesSaved />);
    const helper = html.slice(html.indexOf('<p class="helper">Starts from'), html.indexOf('</p>', html.indexOf('<p class="helper">Starts from')));
    expect(text(helper).trim()).toMatch(/^Starts from \$1,050\.00 in 3 cash accounts\. Those are the balances saved on Oct 7 at 3:12\sPM, the last time they loaded; anything since isn't in it\. Expected to end near/);
    // The names, behind the disclosure that follows the line, never inside it.
    const why = html.slice(html.indexOf('<details class="why"><summary>Which accounts</summary>'));
    expect(why).not.toBe(html);
    expect(text(why)).toContain('Checking and Savings at Chase and Online Savings at Ally.');
    expect(helper).not.toContain('<details');
  });

  test('starts from the balance less what is still pending, and says when the balances are from', () => {
    const pending = [txn({ transaction_id: 'p1', amount: 143.27, pending: true }), txn({ transaction_id: 'p2', amount: 20, pending: true, account_name: 'Sapphire', account_type: 'credit' })];
    const t = card({ txns: pending, balancesAsOf: '2026-10-09T14:15:00' });
    expect(t).toContain('Starts from $756.73: $900.00 in Checking at Chase, less $143.27 still pending.');
    expect(t).toMatch(/Balances as of 2:15\sPM\./);
    // Painted from what this device saved, before a load replaced it.
    const saved = card({ balancesAsOf: '2026-10-07T15:12:00', balancesSaved: true });
    expect(saved).toMatch(/Those are the balances saved on Oct 7 at 3:12\sPM, the last time they loaded; anything since isn't in it\./);
  });

  test('a failed transactions load says so, never that nothing is coming', () => {
    const t = upcoming({ txns: null, failed: true, series: [] });
    expect(t).toContain("Transactions couldn't be loaded, so no bills or income are in this: it is your balance and what you planned.");
    expect(t).not.toContain('still loading');
  });

  test('a warning set in another currency is not read as this one', () => {
    const t = card({ planned: { ...EMPTY_PLANNED, threshold: { amount: 500, currency: 'EUR' } } });
    expect(t).toContain('Warns below $100.00');
    expect(t).toContain('Your warning of €500.00 was set in EUR, and this forecast is in USD, so it warns below $100.00 until you change it.');
  });

  test('pay that stopped coming is named, not dropped unseen', () => {
    const old = detectRecurring(monthly('2026-03', 5, 1).map((d) => row(d, -3000, { name: 'Old job', category: 'income' })));
    expect(upcoming({ series: [...series(), ...old] })).toContain("Old job hasn't come since Jul 1, so it isn't in this forecast. If it still comes, add it as planned income.");
  });

  test('with pay expected today, the lowest is the balance now, not an estimate', () => {
    const pay = detectRecurring(monthly('2026-04', 6, 9).map((d) => row(d, -2000, { name: 'Payroll', category: 'income' })));
    const t = card({ series: pay });
    expect(t).toContain('$900.00 lowest, now ');
    expect(t).not.toContain('lowest, now (estimated)');
    const overdrawn = card({ series: pay, institutions: [chase({ accounts: [{ account_id: 'chk', name: 'Checking', type: 'depository', balance: -40, currency: 'USD' }] })] });
    expect(overdrawn).toContain('Below zero now.');
  });

  test('the ranges, 30 days chosen first', () => {
    const html = renderToStaticMarkup(<ForecastCard institutions={[chase()]} series={series()} planned={EMPTY_PLANNED} today={TODAY} />);
    expect(html).toMatch(/aria-checked="true"[^>]*>30 days<\/button>/);
    expect(html).toMatch(/aria-checked="false"[^>]*>60 days<\/button>/);
    expect(html).toMatch(/aria-checked="false"[^>]*>90 days<\/button>/);
    // Drawn dashed: every point on it is an estimate.
    expect(html).toContain('stroke-dasharray="5 4"');
  });

  test('a warning below the person\'s own figure, before it would go below zero', () => {
    const t = card({
      institutions: [chase({ accounts: [{ account_id: 'chk', name: 'Checking', type: 'depository', balance: 1700, currency: 'USD' }] })],
      planned: { ...EMPTY_PLANNED, threshold: { amount: 500, currency: 'USD' } },
    });
    expect(t).toContain('Expected below $500.00 from around Oct 15.');
    expect(t).toContain('Warns below $500.00');
    expect(t).not.toContain('drop below zero');
  });

  test('planned items count, and what it may be missing is said', () => {
    const planned: Planned = { ...EMPTY_PLANNED, items: [{ id: 'p', name: 'Car registration', kind: 'expense', amount: 212.5, currency: 'USD', date: '2026-10-20', cadence: 'once' }] };
    const over = {
      planned,
      institutions: [chase({ needs_reauth: true, error: 'x', stale_as_of: '2026-10-03' })],
      stopped: [{ institution_name: 'Chase', last_ok_at: '2026-10-03T12:00:00Z' }],
    };
    const t = card(over);
    expect(t).toContain('Expected to end near $1,187.50 on Nov 8.');
    // Where it starts from, on the card; what its bills and income may be
    // missing, at the top of Upcoming.
    expect(t).toContain('Chase needs reconnecting, so this starts from its balances on Oct 3.');
    expect(upcoming(over)).toContain("Chase hasn't synced since");
  });

  test('without its planned items, or before transactions load, it says what is not in it', () => {
    expect(upcoming({ plannedStatus: 'error', plannedDrawn: false })).toContain("Your planned items aren't loaded, so they aren't in this, and bills you marked not recurring may be.");
    expect(upcoming({ txns: null, series: [] })).toContain('Transactions are still loading, so no bills or income are in this yet.');
  });

  test('with no cash accounts there is nothing to start from', () => {
    const t = card({ institutions: [chase({ accounts: [{ account_id: 'card', name: 'Sapphire', type: 'credit', balance: 300, currency: 'USD' }] })] });
    expect(t).toContain('A forecast starts from your checking and savings.');
    expect(t).not.toContain('lowest');
  });
});

describe('the calendar', () => {
  const view = (over: Partial<Parameters<typeof CalendarView>[0]> = {}) =>
    text(
      renderToStaticMarkup(
        <CalendarView
          txns={[txn({ transaction_id: 'a', date: '2026-10-05', name: 'Corner shop', amount: 30 })]}
          series={series()}
          planned={[]}
          dismissed={new Set()}
          institutions={[chase({ accounts: [{ account_id: 'card', name: 'Sapphire', type: 'credit', balance: 300, currency: 'USD', liability: { minimum_payment: 35, next_due_date: '2026-10-22' } }] })]}
          today={TODAY}
          currency="USD"
          {...over}
        />
      )
    );

  test('opens on this month and today, saying what posted and what is expected are', () => {
    const t = view();
    expect(t).toContain('October 2026');
    // Today's own day is "Today" (lib/format.ts formatDay).
    expect(t).toContain('Today');
    expect(t).not.toContain('Friday, Oct 9');
    expect(t).toContain('Nothing expected.');
    expect(t).toContain(
      "Days gone by show what posted. From today, what is expected to leave or reach your checking and savings, an estimate, as the forecast counts it; a card's own charges and the payments due on cards and loans are listed, not added."
    );
  });

  test('a failed transactions load says so on the days gone by, never "Nothing posted"', () => {
    const t = view({ txns: null, failed: true, today: '2026-10-09' });
    expect(t).toContain("Transactions couldn't be loaded, so what posted isn't shown.");
    expect(t).not.toContain('Nothing posted');
    expect(view({ txns: null })).toContain('Transactions are still loading.');
  });

  test('a card\'s own charge is listed on its day but not added, and says why', () => {
    const spotify = detectRecurring(monthly('2026-04', 6, 9).map((d) => row(d, 10.99, { name: 'Spotify', account_name: 'Sapphire', account_type: 'credit' })));
    const t = view({ series: spotify, txns: [] });
    expect(t).toContain("Spotify Bill · Monthly · On the Sapphire card, not in the day's figure: the card's payment is what leaves cash");
    expect(t).not.toContain('Expected · −$10.99');
  });

  // The screen review: "on the Plaid Credit Card card".
  test('a card whose name already says card isn’t called a card twice', () => {
    const spotify = detectRecurring(monthly('2026-04', 6, 9).map((d) => row(d, 10.99, { name: 'Spotify', account_name: 'Plaid Credit Card', account_type: 'credit' })));
    const t = view({ series: spotify, txns: [] });
    expect(t).toContain("Spotify Bill · Monthly · On the Plaid Credit Card, not in the day's figure");
    expect(t).not.toContain('Card card');
  });

  test('today\'s list says why a posted row isn\'t in the day\'s figure', () => {
    const t = view({
      txns: [
        txn({ transaction_id: 'a', name: 'Corner shop', amount: 30 }),
        txn({ transaction_id: 'b', name: 'Ramen', amount: 3200, iso_currency_code: 'JPY' }),
        txn({ transaction_id: 'c', name: 'Work trip', amount: 400, excluded: true }),
      ],
    });
    expect(t).toContain('Posted · −$30.00');
    expect(t).toContain("Ramen In JPY, not in the day's figure");
    expect(t).toContain("Work trip Excluded, not in the day's figure");
  });

  test('each day\'s cell carries its figure: what posted before today, what is expected after', () => {
    const html = renderToStaticMarkup(
      <CalendarView
        txns={[txn({ transaction_id: 'a', date: '2026-10-05', name: 'Corner shop', amount: 30 })]}
        series={series()}
        planned={[]}
        dismissed={new Set()}
        institutions={[]}
        today={TODAY}
        currency="USD"
      />
    );
    expect(html).toContain('aria-label="Monday, October 5, posted −$30.00"');
    expect(html).toContain('aria-label="Thursday, October 15, expected −$1,500.00"');
    expect(html).toContain('aria-label="Sunday, October 25, expected +$2,000.00"');
    // In the cell, its sign and whole units, a thousand shortened, and no
    // currency (the legend names it), to fit a phone's column at 12px.
    expect(html).toContain('<span class="cal-fig out">−30</span>');
    expect(html).toContain('<span class="cal-fig out estimated">−1.5K</span>');
    expect(html).toContain('<span class="cal-fig in estimated">+2K</span>');
  });

  /** October gone by (today its last day), with what posted on each day
   *  given: money in as Plaid writes it, a negative amount. */
  const posted = (amounts: Record<number, number[]>, currency: string | null = 'USD') =>
    renderToStaticMarkup(
      <CalendarView
        txns={Object.entries(amounts).flatMap(([day, list]) =>
          list.map((amount, i) => txn({ transaction_id: `${day}-${i}`, date: `2026-10-${day.padStart(2, '0')}`, amount, iso_currency_code: currency ?? 'USD' }))
        )}
        series={[]}
        planned={[]}
        dismissed={new Set()}
        institutions={[]}
        today="2026-10-31"
        currency={currency}
      />
    );
  /** Each figure drawn in a day's cell, by the day of the month. */
  const cellFigures = (html: string) =>
    Object.fromEntries(
      [...html.matchAll(/<span class="cal-num">(\d+)<\/span><span class="cal-fig[^"]*">(.*?)<\/span><span class="cal-dots"/g)].filter((m) => m[2] !== '').map((m) => [Number(m[1]), m[2]])
    );
  const FORMS: Record<number, number[]> = {
    1: [-999.6],
    2: [-12_500],
    3: [-888_888],
    4: [-999_999],
    5: [-1_250_000],
    6: [50, -50],
    7: [143],
    8: [-999.4],
    9: [0.4],
    10: [2_400_000_000],
    11: [-1e15],
    12: [-994_999],
    13: [-995_000],
  };
  const FIGURES = { 1: '+1K', 2: '+13K', 3: '+890K', 4: '+1M', 5: '+1.3M', 6: '0', 7: '−143', 8: '+999', 9: '0', 10: '−2.4B', 11: '+1000T', 12: '+990K', 13: '+1M' };

  /** `fn` run with Intl.NumberFormat as `make` makes it of the real one,
   *  put back after. */
  function withNumberFormat<T>(make: (real: typeof Intl.NumberFormat) => typeof Intl.NumberFormat, fn: () => T): T {
    const real = Intl.NumberFormat;
    Intl.NumberFormat = make(real);
    try {
      return fn();
    } finally {
      Intl.NumberFormat = real;
    }
  }

  test("a cell's figure: whole units under a thousand, then two figures and K, M, B or T, chosen once it is rounded; a zero has no sign", () => {
    // 999.6 rounds to a thousand, "1K", and 999,999 to a million, "1M",
    // never "1000K"; 994,999 stays under it, 995,000 doesn't. Past T the
    // figure grows.
    expect(cellFigures(posted(FORMS))).toEqual(FIGURES);
  });

  test("in the viewer's digits and decimal sign, the suffix the app's own", () => {
    // A browser in German: a formatter given no locale writes German.
    const german = (real: typeof Intl.NumberFormat) =>
      class extends real {
        constructor(locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
          super(locales ?? 'de-DE', options);
        }
      } as unknown as typeof Intl.NumberFormat;
    expect(withNumberFormat(german, () => cellFigures(posted({ 1: [-3_500], 2: [-1_250_000], 3: [143] })))).toEqual({ 1: '+3,5K', 2: '+1,3M', 3: '−143' });
  });

  test('a figure carried up is 1 of the next suffix, on an engine that rounds a number by its binary value too', () => {
    // 995,000 is 0.995 of a million, held as just under it: rounded as it is
    // held (a strict reading of ECMA-402), it would be "0.99M".
    const exact = (real: typeof Intl.NumberFormat) =>
      class extends real {
        format(x: number | bigint | Intl.StringNumericLiteral) {
          return super.format(typeof x === 'number' ? (x.toPrecision(20) as Intl.StringNumericLiteral) : x);
        }
      } as unknown as typeof Intl.NumberFormat;
    expect(withNumberFormat(exact, () => cellFigures(posted({ 1: [-995_000], 2: [-994_999], 3: [-1_250_000] })))).toEqual({ 1: '+1M', 2: '+990K', 3: '+1.3M' });
  });

  test('no currency in a cell, whatever the currency, and none without one', () => {
    for (const currency of ['USD', 'EUR', 'JPY', 'CAD', null]) {
      const figures = cellFigures(posted(FORMS, currency));
      expect([currency, figures]).toEqual([currency, FIGURES]);
      // No symbol ("$", "CA$", "¥") and no code ("EUR").
      for (const f of Object.values(figures)) expect(f).not.toMatch(/\p{Sc}|[A-Z]{2}/u);
    }
  });

  test('the legend names the currency once, on a line of its own, and is not read out (each cell says its amounts in full)', () => {
    expect(posted({}, 'EUR')).toContain(
      '<span class="cal-dot due"></span> Payment due</span><span class="cal-legend-note">Day figures in EUR, rounded</span></div>'
    );
    expect(posted({}, null)).toContain('<span class="cal-dot due"></span> Payment due</span><span class="cal-legend-note">Day figures rounded</span></div>');
    expect(posted({}, 'EUR')).toContain('<div class="cal-legend" aria-hidden="true">');
  });
});

describe('the recurring list', () => {
  const list = (over: Partial<Parameters<typeof RecurringCard>[0]> = {}) =>
    text(renderToStaticMarkup(<RecurringCard series={series()} today={TODAY} currency="USD" dismissed={new Set()} onDismiss={async () => true} {...over} />));

  test('bills and income apart, each with its cadence, how often it was seen, and when it is next expected', () => {
    const t = list();
    expect(t).toContain('Recurring ~$1,500.00/mo out');
    expect(t).toContain('Bills');
    expect(t).toContain('Rent Chase · Checking · Monthly · seen 6 times · next ~Oct 15 $1,500.00');
    expect(t).toContain('Income · ~$2,000.00/mo in');
    expect(t).toContain('Payroll Chase · Checking · Monthly · seen 6 times · next ~Oct 25 +$2,000.00');
  });

  test('pay that varies too much, and a payment that pays a card, are listed but not in the monthly figures', () => {
    const gigs = [800, 2900, 1200, 2600, 900, 3000, 1100, 2500, 950, 2800, 1000, 2700];
    const varies = detectRecurring(gigs.map((a, i) => row(scheduleDates({ unit: 'day', every: 14, start: '2026-04-24' }, '2100-01-01', 12)[i], -a, { name: 'Gig pay', category: 'income' })));
    const autopay = detectRecurring(monthly('2026-04', 6, 25).map((d) => row(d, 500, { name: 'Card autopay', category: 'loan payments', subcategory: 'credit card payment' })));
    const t = list({ series: [...autopay, ...varies] });
    expect(t).toContain('amount varies');
    expect(t).toContain('pays a card');
    expect(t).not.toContain('/mo out');
    expect(t).not.toContain('/mo in');
  });

  test("a card's payments received, imported with no category, are never income; the payment from checking says which card it pays", () => {
    const rows = monthly('2026-03', 7, 25).flatMap((d) => [
      row(d, 812.4, { name: 'ONLINE PAYMENT CAPITAL ONE', category: null, source: 'import:ofx' }),
      row(addDays(d, 2), -812.4, { name: 'PAYMENT/CREDIT', category: null, account_name: 'Quicksilver', account_type: 'credit', institution_name: 'Capital One' }),
    ]);
    const t = list({ series: detectRecurring(rows) });
    expect(t).not.toContain('Income');
    expect(t).not.toContain('/mo in');
    expect(t).toContain('pays Quicksilver');
  });

  test('when the planned items could not be loaded, it says why nothing can be marked', () => {
    // In a series' sheet, beside Not recurring (rollout phase 6a3).
    const s = series();
    expect(list({ series: s, status: 'error', edit: s[0].id })).toContain("Your planned items couldn't be loaded, so this can't be saved now.");
  });

  test('a failed transactions load says so', () => {
    expect(list({ series: [], failed: true })).toContain("Transactions couldn't be loaded, so no bills or income can be found.");
  });

  test('a late one, and one that seems to have ended, say so; the ended one is out of the monthly figure', () => {
    expect(list({ today: '2026-10-17' })).toContain('due Oct 15, not in yet');
    const ended = list({ today: '2026-12-20' });
    expect(ended).toContain('last Sep 15, may have ended');
    expect(ended).not.toContain('/mo out');
  });

  test('one marked not recurring is listed apart, to restore', () => {
    const s = series();
    const t = list({ series: s, dismissed: new Set([s[0].id]) });
    expect(t).not.toContain('Rent Chase · Checking · Monthly');
    expect(t).toContain('1 marked not recurring');
  });

  test('nothing detected yet says when things show up', () => {
    expect(list({ series: [] })).toContain('No recurring bills or income detected yet.');
  });
});

describe('the planned items', () => {
  const card = (over: Partial<Parameters<typeof PlannedCard>[0]> = {}) =>
    text(renderToStaticMarkup(<PlannedCard planned={EMPTY_PLANNED} today={TODAY} currency="USD" onSave={async () => true} {...over} />));

  test('each with its cadence and next date, money in marked as such', () => {
    const t = card({
      planned: {
        ...EMPTY_PLANNED,
        items: [
          { id: 'a', name: 'Car registration', kind: 'expense', amount: 212.5, currency: 'USD', date: '2025-11-03', cadence: 'yearly' },
          { id: 'b', name: 'Tax refund', kind: 'income', amount: 1200, currency: 'USD', date: '2026-10-30', cadence: 'once' },
          { id: 'c', name: 'Deposit back', kind: 'income', amount: 500, currency: 'USD', date: '2026-09-01', cadence: 'once' },
        ],
      },
    });
    expect(t).toContain('Tax refund Once · next Oct 30 +$1,200.00');
    expect(t).toContain('Car registration Yearly · next Nov 3 −$212.50');
    expect(t).toContain('Deposit back Once · was Sep 1 +$500.00');
    expect(t.indexOf('Tax refund')).toBeLessThan(t.indexOf('Car registration'));
    expect(t).toContain('Add a planned item');
  });

  test('loading, or unreadable, is never shown as none and can\'t be edited', () => {
    expect(card({ status: 'loading' })).toContain('Loading planned items');
    const t = card({ status: 'error', error: 'Your saved planned items could not be read, so they have been left untouched and editing is paused.' });
    expect(t).toContain('could not be read');
    expect(t).not.toContain('Nothing planned yet');
    expect(t).not.toContain('Add a planned item');
  });
});

describe('on the Budgets tab', () => {
  test('the forecast, the calendar, the recurring list and the planned items, from the same detection', () => {
    const txns = [
      ...monthly('2026-04', 6, 15).map((d, i) => txn({ transaction_id: `rent-${i}`, date: d, name: 'Rent', amount: 1500, category: 'rent and utilities' })),
    ];
    const t = text(
      renderToStaticMarkup(
        <BudgetsTab
          txns={txns}
          series={detectRecurring(txns)}
          budgets={EMPTY_BUDGETS}
          onSave={async () => true}
          goals={[]}
          onSaveGoals={async () => true}
          accounts={[]}
          loading={false}
          institutions={[chase()]}
          planned={EMPTY_PLANNED}
          onSavePlanned={async () => true}
        />
      )
    );
    for (const heading of ['Cash forecast', 'Calendar', 'Recurring', 'Planned']) expect(t).toContain(heading);
    expect(t).toContain('Rent Chase · Checking · Monthly · seen 6 times');
  });
});

describe('Home\'s upcoming bills', () => {
  // A bill whose next date is three days from today, on the viewer's calendar.
  const today = localDate();
  const next = addDays(today, 3);
  const from = addMonths(next.slice(0, 7), -3);
  const dates = scheduleDates({ unit: 'month', every: 1, days: [Number(next.slice(8))], month: from, slot: 0 }, addDays(today, -1));
  const bills = dates.map((d, i) => txn({ transaction_id: `gym-${i}`, date: d, name: 'Gym', amount: 40, category: 'personal care' }));
  // Detected once, by the dashboard, and handed down.
  const home = (over: Partial<Parameters<typeof Insights>[0]> = {}) =>
    text(renderToStaticMarkup(<Insights txns={bills} series={detectRecurring(over.txns ?? bills)} accounts={[]} {...over} />));
  const day = new Date(`${next}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  test('use the date the cadence names', () => {
    expect(home()).toContain(`Upcoming: Gym (~$40.00) around ${day}`);
  });

  test('leave out a bill marked not recurring', () => {
    const id = detectRecurring(bills)[0].id;
    // Its line alone: in a month's last three days the charge before the next
    // one is this month's, and can be named as the month's biggest purchase.
    expect(home()).toContain('Upcoming: Gym');
    expect(home({ dismissed: [id] })).not.toContain('Upcoming: Gym');
  });

  test('find a yearly bill from the history before the year', () => {
    // Renewed about a year ago, inside the loaded year, and a year before that.
    const renewal = addDays(today, 4);
    const thisYear = [txn({ transaction_id: 'prime-1', date: addDays(renewal, -365), name: 'Prime', amount: 139, category: 'general merchandise' })];
    const before = [row(addDays(renewal, -730), 139, { name: 'Prime', category: 'general merchandise' })];
    expect(home({ txns: thisYear })).not.toContain('Prime');
    expect(home({ txns: thisYear, series: detectRecurring([...thisYear, ...before]) })).toContain('Upcoming: Prime (~$139.00)');
  });
});
