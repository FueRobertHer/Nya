// test/shared-expenses-fixture.ts
//
// Shared expenses (#49) on screen, for the view suites
// (test/shared-expenses-ui.test.tsx, test/hide-amounts.test.tsx): a card as
// app/api/shared-expenses answers it, rows of the list, and the state the
// sheets read, with nothing sent anywhere.

import type { Txn } from '@/components/MonthBreakdown';
import type { SharedExpenses } from '@/components/shared-expenses-state';
import type { CardAnswer } from '@/lib/shared-expenses/read';
import type { ItemState } from '@/lib/shared-expenses/balances';
import { localDate } from '@/lib/local-date';

export const daysAgo = (n: number) => localDate(new Date(Date.now() - n * 86_400_000));
export const AT = '2026-10-01T12:00:00.000Z';

export function txn(over: Partial<Txn>): Txn {
  return {
    transaction_id: 't',
    date: daysAgo(1),
    name: 'Shop',
    amount: 10,
    pending: false,
    account_name: 'Checking',
    account_type: 'depository',
    institution_name: 'Chase',
    category: 'food and drink',
    category_kind: 'expense',
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
  } as Txn;
}

export const item = (over: Partial<ItemState>): ItemState => ({
  id: 'e-dinner',
  kind: 'share',
  person: 'alex',
  direction: 'to_you',
  amount: 60,
  currency: 'USD',
  date: daysAgo(10),
  what: 'Dinner',
  transaction_id: 't-dinner',
  closed: [],
  paid: 0,
  outside: 0,
  forgiven: 0,
  open: 60,
  over: false,
  ...over,
});

/** Alex owes 60 of a dinner, less 25 of groceries they bought: 35. You owe
 *  Sam 12.50 of a lunch. */
export function cardOf(over: Partial<CardAnswer> = {}): CardAnswer {
  return {
    counting: 'part',
    settings_unread: false,
    own: { venmo: 'me-venmo', cashtag: null },
    people: [
      { id: 'alex', name: 'Alex Smith', venmo: 'alex-s', cashtag: null, app: 'venmo', tag: null, requests: [], archived: false, removed: false },
      { id: 'sam', name: 'Sam Lee', venmo: null, cashtag: 'samcash', app: 'cashapp', tag: null, requests: [], archived: false, removed: false },
    ],
    items: [
      item({}),
      item({ id: 'i-groceries', kind: 'iou', direction: 'by_you', amount: 25, open: 25, date: daysAgo(5), what: 'Groceries', transaction_id: undefined, category_id: 'c1' }),
      item({ id: 'i-lunch', kind: 'iou', person: 'sam', direction: 'by_you', amount: 12.5, open: 12.5, date: daysAgo(2), what: 'Lunch', transaction_id: undefined }),
    ],
    shares: [{ transaction_id: 't-dinner', part: null, account_id: 'chk', amount_was: 120, currency: 'USD', date: daysAgo(10), what: 'Dinner', entries: [{ id: 'e-dinner', person: 'alex', amount: 60, how: { kind: 'half' } }], kept_gone: null, updated_at: AT }],
    payments: [],
    dismissed: [],
    balances: {
      alex: [{ currency: 'USD', amount: 35, open: 2, oldest: daysAgo(10), over: 0 }],
      sam: [{ currency: 'USD', amount: -12.5, open: 1, oldest: daysAgo(2), over: 0 }],
    },
    unread: {},
    ...over,
  } as CardAnswer;
}

export const shared = (card: CardAnswer | null): SharedExpenses => ({ card, failed: null, open: null, setOpen: () => {}, send: async () => ({ error: null, body: null }), reload: () => {} });

