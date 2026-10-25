// The scenes a Budgets > Upcoming view test draws, with every note the
// segment can say: no cash to start from, transactions that couldn't be
// loaded or are still loading, planned items that couldn't be read or are
// loading, a save refused, each of the forecast's notes (balances from an
// earlier day, banks not reached, accounts not shown or that stopped
// reporting, connections not syncing, importing, not provided, not allowed,
// a card's payment due, pay that stopped or varies, a typed balance a week
// old, no balance, currencies left out, an account of unknown type), the
// warnings, a warning set in another currency, what was converted, a series
// marked not recurring, a late one and one that ended. Data only, so the
// same scenes can be drawn by the views as they were before rollout phase
// 6a3 (to record what they said, test/upcoming-words-before-6a3.json) and as
// they are. Every scene names its own day, so the words don't move with the
// day the suite runs.

import { ecbTable } from './fx-fixture';
import type { Txn } from '@/components/MonthBreakdown';
import { detectRecurring, dismissedSeries, scheduleDates, type RecurringRow, type RecurringSeries } from '@/lib/recurring';
import { cashPosition, type ForecastInstitution } from '@/lib/forecast';
import { EMPTY_PLANNED, type Planned, type PlannedItem } from '@/lib/planned';
import { totalsIn } from '@/lib/fx/totals';
import type { FxTable } from '@/lib/fx/rates';
import type { ListStatus } from '@/lib/whole-list-store';
import type { Incomplete, Stopped } from '@/lib/month-coverage';
import { historyCount } from '@/lib/spending';
import { noSpending, NO_CONNECTIONS_WITHOUT, type NoSpending, type NoTransactionsView } from '@/lib/no-transactions';

export const TODAY = '2026-10-09';

export function txn(over: Partial<Txn>): Txn {
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

export const row = (date: string, amount: number, over: Partial<RecurringRow> = {}): RecurringRow => ({
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
export const monthly = (from: string, count: number, day: number) => scheduleDates({ unit: 'month', every: 1, days: [day], month: from, slot: 0 }, '2100-01-01', count);

export const chase = (over: Partial<ForecastInstitution> = {}): ForecastInstitution => ({
  institution_name: 'Chase',
  item_id: 'item_1',
  accounts: [{ account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 900, currency: 'USD' }],
  ...over,
});

/** Rent on the 15th and pay on the 25th, detected from six months. */
export const RENT_AND_PAY: RecurringSeries[] = detectRecurring([
  ...monthly('2026-04', 6, 15).map((d) => row(d, 1500, { name: 'Rent', category: 'rent and utilities' })),
  ...monthly('2026-04', 6, 25).map((d) => row(d, -2000, { name: 'Payroll', category: 'income' })),
]);

/** Pay that varies too much to forecast, pay that stopped coming, a bill on
 *  an account of unknown type, and one charged to a card. */
const GIGS = [800, 2900, 1200, 2600, 900, 3000, 1100, 2500, 950, 2800, 1000, 2700];
export const KINDS: RecurringSeries[] = detectRecurring([
  ...GIGS.map((a, i) => row(scheduleDates({ unit: 'day', every: 14, start: '2026-04-24' }, '2100-01-01', 12)[i], -a, { name: 'Gig pay', category: 'income' })),
  ...monthly('2026-03', 5, 1).map((d) => row(d, -3000, { name: 'Old job', category: 'income' })),
  ...monthly('2026-04', 6, 12).map((d) => row(d, 45, { name: 'Gym', category: 'personal care', account_name: 'Wallet', account_type: null as unknown as string })),
  ...monthly('2026-04', 6, 9).map((d) => row(d, 10.99, { name: 'Spotify', account_name: 'Sapphire', account_type: 'credit' })),
]);

export const CAR: PlannedItem = { id: 'car', name: 'Car registration', kind: 'expense', amount: 212.5, currency: 'USD', date: '2026-10-20', cadence: 'once' };
export const REFUND: PlannedItem = { id: 'refund', name: 'Tax refund', kind: 'income', amount: 1200, currency: 'USD', date: '2026-10-30', cadence: 'once' };

/** What the Budgets tab hands Upcoming, before it works anything out. */
export type UpcomingScene = {
  today: string;
  institutions: ForecastInstitution[];
  series: RecurringSeries[];
  planned: Planned;
  plannedStatus: ListStatus;
  plannedError: string | null;
  plannedSaveError: string | null;
  /** Null while they load or when they couldn't be (`failed`). */
  txns: Txn[] | null;
  failed: boolean;
  balancesAsOf: string | null;
  balancesSaved: boolean;
  incomplete: Incomplete[];
  stopped: Stopped[];
  withoutTransactions: NoTransactionsView;
  fx: FxTable | null;
};

const scene = (over: Partial<UpcomingScene> = {}): UpcomingScene => ({
  today: TODAY,
  institutions: [chase()],
  series: RENT_AND_PAY,
  planned: { ...EMPTY_PLANNED, items: [CAR, REFUND], threshold: { amount: 100, currency: 'USD' } },
  plannedStatus: 'ready',
  plannedError: null,
  plannedSaveError: null,
  txns: [txn({ transaction_id: 'a', date: '2026-10-05', name: 'Corner shop', amount: 30 })],
  failed: false,
  balancesAsOf: null,
  balancesSaved: false,
  incomplete: [],
  stopped: [],
  withoutTransactions: NO_CONNECTIONS_WITHOUT,
  fx: null,
  ...over,
});

/** What the Budgets tab works out from a scene before drawing Upcoming
 *  (components/BudgetsTab.tsx), the same way. */
export function derived(s: UpcomingScene) {
  const ready = s.plannedStatus === 'ready';
  const items = ready ? s.planned.items : [];
  const gone = dismissedSeries(s.series, ready ? s.planned.dismissed : []);
  const dismissed: ReadonlySet<string> = new Set(gone.keys());
  const currency = totalsIn(s.txns ?? [], s.fx, { into: 'most' }).currency;
  const plannedCurrency = cashPosition(s.institutions).currency ?? currency;
  const none: NoSpending | null = s.txns ? noSpending(s.withoutTransactions, historyCount(s.txns)) : null;
  return { items, gone, dismissed, currency, plannedCurrency, noSpending: none, loading: s.txns === null && !s.failed };
}

const SAPPHIRE_DUE = chase({
  accounts: [
    { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 900, currency: 'USD' },
    {
      account_id: 'card',
      name: 'Sapphire',
      type: 'credit',
      balance: 600,
      currency: 'USD',
      liability: { minimum_payment: 35, next_due_date: '2026-10-22', last_statement_balance: 600 },
    },
  ],
});

/** Instants at noon on the viewer's own calendar, so each is Oct 3 and Sep 20
 *  where the suite runs, whatever its time zone (an instant fixed in UTC is
 *  another day at UTC+13 or UTC-11). */
const LOCAL_OCT_3 = new Date(2026, 9, 3, 12).toISOString();
const LOCAL_SEP_20 = new Date(2026, 8, 20, 12).toISOString();

/** Every scene, by name. */
export const SCENES: Record<string, UpcomingScene> = {
  'as it usually is': scene(),
  'below the warning, above zero': scene({
    institutions: [chase({ accounts: [{ account_id: 'chk', name: 'Checking', type: 'depository', balance: 1700, currency: 'USD' }] })],
    planned: { ...EMPTY_PLANNED, threshold: { amount: 500, currency: 'USD' } },
  }),
  'no cash to start from': scene({ institutions: [chase({ accounts: [{ account_id: 'card', name: 'Sapphire', type: 'credit', balance: 300, currency: 'USD' }] })] }),
  'transactions not loaded': scene({ txns: null, failed: true, series: [] }),
  'transactions loading': scene({ txns: null, series: [] }),
  'planned items not read': scene({
    plannedStatus: 'error',
    plannedError: 'Your saved planned items could not be read, so they have been left untouched and editing is paused.',
  }),
  'planned items loading': scene({ plannedStatus: 'loading' }),
  'a save refused': scene({ plannedSaveError: 'Could not save your planned items. Nothing was changed.' }),
  'connections that leave it short': scene({
    institutions: [
      chase({ needs_reauth: true, error: 'x', stale_as_of: '2026-10-03' }),
      { institution_name: 'Ally', item_id: 'item_2', error: 'unreachable', accounts: [] },
      { institution_name: 'Capital One', item_id: 'item_3', error: 'unreachable', accounts: [], unshown_accounts: [{ name: '360 Checking', type: 'depository' }] },
      { institution_name: 'Wells Fargo', item_id: 'item_4', accounts: [{ account_id: 'wf', name: 'Everyday', type: 'depository', balance: 50, currency: 'USD' }], stale_missing: 2 },
      {
        institution_name: 'Citi',
        item_id: 'item_5',
        accounts: [{ account_id: 'citi', name: 'Citi Checking', type: 'depository', balance: 75, currency: 'USD', held: { as_of: '2026-09-30' } }],
        unconfirmed_missing: 0,
      },
      {
        institution_name: 'Cash',
        manual: true,
        accounts: [
          { account_id: 'jar', name: 'Cash jar', type: 'depository', subtype: 'cash', balance: 40, currency: 'USD', updated_at: LOCAL_SEP_20 },
          { account_id: 'empty', name: 'Envelope', type: 'depository', balance: null, currency: 'USD' },
        ],
      },
      { institution_name: 'N26', item_id: 'item_6', accounts: [{ account_id: 'n26', name: 'Girokonto', type: 'depository', balance: 500, currency: 'EUR' }] },
    ],
    txns: [txn({ transaction_id: 'p', name: 'Coffee', amount: 4, pending: true, iso_currency_code: 'EUR', account_name: 'Girokonto', institution_name: 'N26' })],
    stopped: [{ institution_name: 'Chase', last_ok_at: LOCAL_OCT_3 }, { institution_name: 'Ally', last_ok_at: null }],
    incomplete: [
      { institution_name: 'Wells Fargo', coverage: 'missing' },
      { institution_name: 'Citi', coverage: 'importing' },
    ],
    withoutTransactions: {
      without: [
        { institution_name: 'Discover', reason: 'refused' },
        { institution_name: 'Amex', reason: 'no_consent' },
      ],
      connections: 8,
    },
  }),
  'pay and bills it leaves out': scene({ series: [...RENT_AND_PAY, ...KINDS], institutions: [SAPPHIRE_DUE] }),
  'a series marked not recurring': scene({ planned: { ...EMPTY_PLANNED, dismissed: [RENT_AND_PAY[0].id] } }),
  'a bill late': scene({ today: '2026-10-17' }),
  'a bill that ended': scene({ today: '2026-12-20' }),
  'a warning set in another currency': scene({ planned: { ...EMPTY_PLANNED, threshold: { amount: 500, currency: 'EUR' } } }),
  'converted into a home currency': scene({
    fx: ecbTable({ home: 'EUR' }),
    institutions: [
      chase({
        accounts: [
          { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 1000, currency: 'USD' },
          { account_id: 'eur', name: 'Girokonto', type: 'depository', subtype: 'checking', balance: 500, currency: 'EUR' },
          { account_id: 'btc', name: 'Wallet', type: 'depository', balance: 1, currency: 'BTC' },
        ],
      }),
    ],
    planned: { ...EMPTY_PLANNED, items: [{ ...CAR, currency: 'EUR' }] },
  }),
  'balances saved on this device': scene({ balancesAsOf: '2026-10-07T15:12:00', balancesSaved: true }),
  'balances as of today, less what is pending': scene({
    balancesAsOf: '2026-10-09T14:15:00',
    txns: [txn({ transaction_id: 'p1', amount: 143.27, pending: true }), txn({ transaction_id: 'p2', amount: 20, pending: true, account_name: 'Sapphire', account_type: 'credit' })],
  }),
  'nothing detected yet': scene({ series: [], txns: [] }),
  'no connection brings in spending': scene({
    series: [],
    txns: [],
    withoutTransactions: { without: [{ institution_name: 'Chase', reason: 'refused' }], connections: 1 },
  }),
  'nothing planned': scene({ planned: EMPTY_PLANNED }),
};
