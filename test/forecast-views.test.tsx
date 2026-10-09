import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ForecastCard from '@/components/ForecastCard';
import CalendarView from '@/components/CalendarView';
import RecurringCard from '@/components/RecurringCard';
import PlannedCard from '@/components/PlannedCard';
import BudgetsTab from '@/components/BudgetsTab';
import Insights from '@/components/Insights';
import type { Txn } from '@/components/MonthBreakdown';
import { addDays, detectRecurring, scheduleDates, type RecurringRow, type RecurringSeries } from '@/lib/recurring';
import { addMonths } from '@/lib/calendar';
import { EMPTY_PLANNED, type Planned } from '@/lib/planned';
import type { ForecastInstitution } from '@/lib/forecast';
import { localDate } from '@/lib/local-date';

// The forecast, the calendar, the recurring list and the planned items as the
// Budgets tab renders them, and Home's upcoming bills: what each says, and
// that an estimate is always labelled as one.

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

  test('is labelled an estimate, starts from the cash accounts it names, and gives its lowest point', () => {
    const t = card();
    expect(t).toContain('Cash forecast estimate');
    expect(t).toContain('Starts from $900.00 today in Checking at Chase.');
    // Rent on the 15th takes it to -$600, pay on the 25th back up.
    expect(t).toContain('-$600.00 lowest, on Oct 15 (estimated)');
    expect(t).toContain('Drops below zero on Oct 15.');
    expect(t).toContain('Ends $1,400.00 on Nov 8.');
    expect(t).toContain("An estimate from the bills and income Nya expects and what you planned. Everyday spending isn't in it");
    expect(t).toContain('What if I buy');
    expect(t).toContain('Warns below $100.00');
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
    expect(html).toContain('aria-pressed="true">30 days</button>');
    expect(html).toContain('aria-pressed="false">60 days</button>');
    expect(html).toContain('aria-pressed="false">90 days</button>');
    // Drawn dashed: every point on it is an estimate.
    expect(html).toContain('stroke-dasharray="5 4"');
  });

  test('a warning below the person\'s own figure, before it would go below zero', () => {
    const t = card({ institutions: [chase({ accounts: [{ account_id: 'chk', name: 'Checking', type: 'depository', balance: 1700, currency: 'USD' }] })], planned: { ...EMPTY_PLANNED, threshold: 500 } });
    expect(t).toContain('Below $500.00 from Oct 15.');
    expect(t).toContain('Warns below $500.00');
    expect(t).not.toContain('Drops below zero');
  });

  test('planned items count, and what it may be missing is said', () => {
    const planned: Planned = { ...EMPTY_PLANNED, items: [{ id: 'p', name: 'Car registration', kind: 'expense', amount: 212.5, currency: 'USD', date: '2026-10-20', cadence: 'once' }] };
    const t = card({
      planned,
      institutions: [chase({ needs_reauth: true, error: 'x', stale_as_of: '2026-10-03' })],
      stopped: [{ institution_name: 'Chase', last_ok_at: '2026-10-03T12:00:00Z' }],
    });
    expect(t).toContain('Ends $1,187.50 on Nov 8.');
    expect(t).toContain('Chase needs reconnecting, so this starts from its balances on Oct 3.');
    expect(t).toContain("Chase hasn't synced since");
  });

  test('without its planned items, or before transactions load, it says what is not in it', () => {
    expect(card({ plannedStatus: 'error' })).toContain("Your planned items aren't loaded, so they aren't in this, and bills you marked not recurring may be.");
    expect(card({ loading: true, series: [] })).toContain('Transactions are still loading, so no bills or income are in this yet.');
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
    expect(t).toContain('Friday, October 9');
    expect(t).toContain('Nothing expected.');
    expect(t).toContain('Days gone by show what posted; from today, what is expected, an estimate. A payment due on a card or loan is marked, not added.');
  });

  test('today\'s list says why a posted row isn\'t in the day\'s figure', () => {
    const t = view({
      txns: [
        txn({ transaction_id: 'a', name: 'Corner shop', amount: 30 }),
        txn({ transaction_id: 'b', name: 'Ramen', amount: 3200, iso_currency_code: 'JPY' }),
        txn({ transaction_id: 'c', name: 'Work trip', amount: 400, excluded: true }),
      ],
    });
    expect(t).toContain('Posted · -$30.00');
    expect(t).toContain("Ramen in JPY, not in the day's figure");
    expect(t).toContain("Work trip excluded, not in the day's figure");
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
    expect(html).toContain('aria-label="Monday, October 5, posted -$30.00"');
    expect(html).toContain('aria-label="Thursday, October 15, expected -$1,500.00"');
    expect(html).toContain('aria-label="Sunday, October 25, expected +$2,000.00"');
  });
});

describe('the recurring list', () => {
  const list = (over: Partial<Parameters<typeof RecurringCard>[0]> = {}) =>
    text(renderToStaticMarkup(<RecurringCard series={series()} today={TODAY} currency="USD" dismissed={[]} onDismiss={async () => true} {...over} />));

  test('bills and income apart, each with its cadence, how often it was seen, and when it is next expected', () => {
    const t = list();
    expect(t).toContain('Recurring ~$1,500.00/mo out');
    expect(t).toContain('Bills');
    expect(t).toContain('Rent Chase · Monthly · seen 6 times · next ~Oct 15 $1,500.00');
    expect(t).toContain('Income · ~$2,000.00/mo in');
    expect(t).toContain('Payroll Chase · Monthly · seen 6 times · next ~Oct 25 +$2,000.00');
  });

  test('a late one, and one that seems to have ended, say so; the ended one is out of the monthly figure', () => {
    expect(list({ today: '2026-10-17' })).toContain('due Oct 15, not in yet');
    const ended = list({ today: '2026-12-20' });
    expect(ended).toContain('last Sep 15, may have ended');
    expect(ended).not.toContain('/mo out');
  });

  test('one marked not recurring is listed apart, to restore', () => {
    const s = series();
    const t = list({ series: s, dismissed: [s[0].id] });
    expect(t).not.toContain('Rent Chase · Monthly');
    expect(t).toContain('1 marked not recurring · Show');
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
    expect(t).toContain('Tax refund Once · next Oct 30, 2026 +$1,200.00');
    expect(t).toContain('Car registration Yearly · next Nov 3, 2026 -$212.50');
    expect(t).toContain('Deposit back Once · was Sep 1, 2026 +$500.00');
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
          budgets={{}}
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
    expect(t).toContain('Rent Chase · Monthly · seen 6 times');
  });
});

describe('Home\'s upcoming bills', () => {
  // A bill whose next date is three days from today, on the viewer's calendar.
  const today = localDate();
  const next = addDays(today, 3);
  const from = addMonths(next.slice(0, 7), -3);
  const dates = scheduleDates({ unit: 'month', every: 1, days: [Number(next.slice(8))], month: from, slot: 0 }, addDays(today, -1));
  const bills = dates.map((d, i) => txn({ transaction_id: `gym-${i}`, date: d, name: 'Gym', amount: 40, category: 'personal care' }));
  const home = (over: Partial<Parameters<typeof Insights>[0]> = {}) =>
    text(renderToStaticMarkup(<Insights txns={bills} budgets={{}} accounts={[]} {...over} />));
  const day = new Date(`${next}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  test('use the date the cadence names', () => {
    expect(home()).toContain(`Upcoming: Gym (~$40.00) around ${day}`);
  });

  test('leave out a bill marked not recurring', () => {
    const id = detectRecurring(bills)[0].id;
    expect(home({ dismissed: [id] })).not.toContain('Gym');
  });

  test('find a yearly bill from the history before the year', () => {
    // Renewed about a year ago, inside the loaded year, and a year before that.
    const renewal = addDays(today, 4);
    const thisYear = [txn({ transaction_id: 'prime-1', date: addDays(renewal, -365), name: 'Prime', amount: 139, category: 'general merchandise' })];
    const before = [row(addDays(renewal, -730), 139, { name: 'Prime', category: 'general merchandise' })];
    expect(home({ txns: thisYear })).not.toContain('Prime');
    expect(home({ txns: thisYear, recurringHistory: before })).toContain('Upcoming: Prime (~$139.00)');
  });
});
