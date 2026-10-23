// The runway's hand-worked case (test/runway.test.ts works it by hand; the
// view tests draw it): three months of the Activity tab's rows, the cash it
// starts from, and what was planned. Today is passed in, never read.

import type { Txn } from '@/lib/transactions';
import type { PlannedItem } from '@/lib/planned';

export const TODAY = '2026-10-22';

export function row(id: string, date: string, amount: number, over: Partial<Txn> = {}): Txn {
  return {
    transaction_id: id,
    date,
    name: id,
    amount,
    pending: false,
    account_name: 'Checking',
    account_type: 'depository',
    institution_name: 'Chase',
    category: 'general merchandise',
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    vendor_key: id,
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

/**
 * Three months, July to September 2026 (92 days), by hand:
 *   money out that counts: rent 3 x 1,500 + groceries 9 x 300 + a car repair
 *   of 2,000 = 9,200.00, so 100.00 a day exactly;
 *   money in that counts: pay 3 x 2,000 + a refund of 440 = 6,440.00, so
 *   70.00 a day exactly;
 *   left out: a TV the person excluded, a move to savings, cash taken out,
 *   the mortgage's 800 a month (a loan payment, a transfer to every total),
 *   and a meal in euros.
 * The mortgage is paid from checking on the 5th, from April on: detection
 * finds it, and it is next due on Nov 5.
 */
export const ROWS: Txn[] = [
  ...['07', '08', '09'].map((m) => row(`rent-${m}`, `2026-${m}-01`, 1500, { name: 'Landlord', vendor_key: 'landlord', category: 'rent and utilities' })),
  ...['07-03', '07-10', '07-24', '08-07', '08-14', '08-28', '09-04', '09-11', '09-25'].map((d) => row(`groceries-${d}`, `2026-${d}`, 300, { name: 'Grocer', vendor_key: 'grocer', category: 'food and drink' })),
  row('repair', '2026-08-15', 2000, { name: 'Midas', vendor_key: 'midas' }),
  ...['07', '08', '09'].map((m) => row(`pay-${m}`, `2026-${m}-15`, -2000, { name: 'Employer', vendor_key: 'employer', category: 'income' })),
  row('refund', '2026-08-20', -440, { name: 'Shop refund', vendor_key: 'shop' }),
  row('tv', '2026-07-20', 1200, { name: 'TV store', vendor_key: 'tv', excluded: true }),
  row('to-savings', '2026-08-02', 1000, { name: 'To savings', category: 'transfer out', transaction_code: 'transfer' }),
  row('atm', '2026-09-02', 200, { name: 'ATM', transaction_code: 'atm' }),
  row('paris', '2026-09-20', 90, { name: 'Bistro', iso_currency_code: 'EUR', category: 'food and drink' }),
  ...['04', '05', '06', '07', '08', '09', '10'].map((m) => row(`mortgage-${m}`, `2026-${m}-05`, 800, { name: 'Home Loans', vendor_key: 'homeloans', category: 'loan payments' })),
];

/** 12,000.00 of cash: checking and savings at Chase. */
export const START = 12000;

export const PLANNED: PlannedItem[] = [
  { id: 'reg', name: 'Car registration', kind: 'expense', amount: 300, currency: 'USD', date: '2026-12-01', cadence: 'once' },
  { id: 'refund', name: 'Tax refund', kind: 'income', amount: 1000, currency: 'USD', date: '2027-03-15', cadence: 'once' },
  { id: 'euro', name: 'Paris trip', kind: 'expense', amount: 900, currency: 'EUR', date: '2027-01-10', cadence: 'once' },
];
