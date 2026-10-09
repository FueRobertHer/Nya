// A container with a bit of everything, for the tests of the read-only API
// (test/api-v1.test.ts) and the MCP server (test/mcp.test.ts): linked and
// manual accounts, recorded and estimated history, transactions with a
// rename, an override, an exclusion, a hidden account, another currency and a
// subscription, budgets, connection records and holdings; and another
// person's container, none of which may ever show for the first one's token.
//
// Import it with `await import('./api-fixture')` AFTER the test file's
// mock.module calls: it loads the modules it seeds through, which must load
// against the mocked storage.

import type { FakeRedis } from './fake-redis';
import { testKey, ctxKey, TEST_CTX } from './fake-redis';
import { encrypt } from '@/lib/crypto';
import { encodeJsonBlob } from '@/lib/blob';
import { saveItem } from '@/lib/storage';
import { saveManualAccount } from '@/lib/manual';
import { setAccountHidden } from '@/lib/hidden';
import { setOverride } from '@/lib/overrides';
import { setRename } from '@/lib/renames';
import { setBudgets } from '@/lib/budgets';
import { setExcluded } from '@/lib/txn-annotations';
import { manualTxnStore } from '@/lib/manual-txns';
import { syncsStore, noticesStore, warningsStore } from '@/lib/connection-records';
import { recordHoldings, observeHoldings } from '@/lib/holdings-history';
import { vendorKey } from '@/lib/transactions';

export const ctx = TEST_CTX;
export const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
export const DAY = 86_400_000;
/** A UTC day relative to now, so the transactions stay inside the window the
 *  app reads (the last 365 days) whenever the tests run. */
export const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const remembered = (accounts: Record<string, unknown>[]) =>
  encrypt(JSON.stringify(accounts.map((a) => ({ official_name: null, subtype: null, mask: null, limit: null, currency: 'USD', ...a }))));

export function txn(id: string, account_id: string, daysBack: number, amount: number, over: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    pending_transaction_id: null,
    account_id,
    amount,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date: daysAgo(daysBack),
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    name: id.toUpperCase(),
    merchant_name: null,
    merchant_entity_id: null,
    website: null,
    logo_url: null,
    personal_finance_category: null,
    personal_finance_category_icon_url: null,
    pending: false,
    payment_channel: 'in store',
    transaction_code: null,
    transaction_type: null,
    check_number: null,
    account_owner: null,
    location: null,
    payment_meta: null,
    counterparties: [],
    category: 'general merchandise',
    account_name: 'Checking',
    institution_name: 'Chase',
    ...over,
  };
}

export const CHASE_TXNS = [
  txn('t_coffee', 'acc_chk', 2, 5.5, { name: 'BLUE BOTTLE 123', merchant_name: 'Blue Bottle', merchant_entity_id: 'm_bb', category: 'food and drink' }),
  txn('t_rent', 'acc_chk', 3, 1200, { category: 'rent and utilities' }),
  txn('t_pay', 'acc_chk', 4, -3000, { category: 'income' }),
  txn('t_transfer', 'acc_chk', 5, 500, { category: 'transfer out', transaction_code: 'transfer' }),
  txn('t_atm', 'acc_chk', 5, 100, { category: 'general merchandise', transaction_code: 'atm' }),
  txn('t_fee', 'acc_chk', 6, 35, { category: 'bank fees' }),
  txn('t_loan', 'acc_chk', 6, 400, { category: 'loan payments' }),
  txn('t_paris', 'acc_card', 7, 50, { iso_currency_code: 'EUR', category: 'travel', account_name: 'Card' }),
  txn('t_card', 'acc_card', 8, 80, { category: 'general merchandise', account_name: 'Card' }),
  txn('t_big', 'acc_chk', 9, 2000, { category: 'general merchandise' }),
  txn('t_hidden', 'acc_save', 3, 999, { name: 'HIDDEN-ACCOUNT-ROW', account_name: 'Savings' }),
  // A pending charge its posted row has replaced: shown once.
  txn('t_pending', 'acc_chk', 1, 12, { pending: true, name: 'PENDING-SUPERSEDED' }),
  txn('t_posted', 'acc_chk', 1, 12, { pending_transaction_id: 't_pending', name: 'Posted lunch', category: 'food and drink' }),
  // Older than the window the app shows.
  txn('t_ancient', 'acc_chk', 400, 9, { name: 'ANCIENT' }),
  // A subscription, about monthly (31 days apart, so always in three months).
  ...[26, 57, 88].map((d, i) => txn(`t_flix${i}`, 'acc_chk', d, 15.99, { name: 'NETFLIX.COM', merchant_name: 'Netflix', category: 'entertainment' })),
];

export const SYNCED_AT = new Date(Date.now() - 2 * 3600_000).toISOString();

export async function seedPerson(fake: FakeRedis) {
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-secret') });
  await saveItem(ctx, { item_id: 'item_broker', institution_name: 'Broker', encrypted_access_token: await encrypt('access-sandbox-secret-2') });
  await saveItem(ctx, { item_id: 'item_new', institution_name: 'NewBank', encrypted_access_token: await encrypt('access-sandbox-secret-3') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await remembered([
      { account_id: 'acc_chk', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1111' },
      { account_id: 'acc_card', name: 'Card', type: 'credit', subtype: 'credit card', mask: '2222', limit: 5000 },
      { account_id: 'acc_save', name: 'Savings', type: 'depository', subtype: 'savings', mask: '3333' },
    ]),
    item_broker: await remembered([{ account_id: 'acc_ira', name: 'IRA', type: 'investment', subtype: 'ira', mask: '4444' }]),
  });
  // Balances as recorded: two full days, and a newer partial one for checking
  // (the broker failed that day).
  const map = (m: Record<string, number>) => encrypt(JSON.stringify(m));
  await fake.hset(ctxKey('history:accounts'), {
    [daysAgo(3)]: await map({ acc_chk: 1000, acc_card: 250, acc_save: 5000, acc_ira: 20000, manual_house: 300000 }),
    [daysAgo(2)]: await map({ acc_chk: 1200, acc_card: 300, acc_save: 5000, acc_ira: 20500, manual_house: 300000 }),
  });
  await fake.hset(ctxKey('history:accounts:partial'), { [daysAgo(1)]: await map({ acc_chk: 1250, acc_card: 310 }) });
  await fake.hset(ctxKey('history:net-worth'), {
    [daysAgo(3)]: await encrypt(String(1000 - 250 + 5000 + 20000 + 300000)),
    [daysAgo(2)]: await encrypt(String(1200 - 300 + 5000 + 20500 + 300000)),
  });
  await fake.hset(ctxKey('history:net-worth:est'), { [daysAgo(10)]: await encrypt('320000') });
  await fake.hset(ctxKey('history:accounts:est'), { [daysAgo(10)]: await map({ acc_chk: 900 }) });
  await fake.hset(ctxKey('snapshot:taken'), { [daysAgo(2)]: `${daysAgo(2)}T13:00:41.000Z` });

  const accounts = {
    acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
    acc_card: { name: 'Card', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
    acc_save: { name: 'Savings', official_name: null, type: 'depository', subtype: 'savings', mask: '3333', balances: null },
  };
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob({ schema_version: 2, cursor: 'c1', accounts, txns: Object.fromEntries(CHASE_TXNS.map((t) => [t.transaction_id, t])), synced_at: SYNCED_AT })
  );
  // The broker's store was last saved before sync times were kept.
  await fake.set(ctxKey('txns:item_broker'), await encodeJsonBlob({ schema_version: 2, cursor: 'c2', accounts: {}, txns: {} }));

  await setAccountHidden(ctx, 'acc_save', 'depository', true);
  await setOverride(ctx, 't_rent', 'housing');
  await setRename(ctx, vendorKey({ merchant_entity_id: 'm_bb', merchant_name: 'Blue Bottle', name: 'BLUE BOTTLE 123', institution_name: 'Chase' }), 'Coffee place');
  await setExcluded(ctx, 't_big', true);

  const updated = new Date(Date.now() - 5 * 3600_000).toISOString();
  await saveManualAccount(ctx, { account_id: 'manual_house', name: 'House', institution_name: 'Property', type: 'other', subtype: null, balance: 300000, updated_at: updated });
  await saveManualAccount(ctx, { account_id: 'manual_wallet', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 40, updated_at: updated });
  const now = new Date().toISOString();
  await manualTxnStore.set(ctx, 'manual_wallet', {
    version: 1,
    rows: [
      { id: 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', account_id: 'manual_wallet', date: daysAgo(1), amount: 25, currency: 'USD', name: 'Farmers market', category: 'food and drink', note: 'apples', source: 'manual', source_id: null, created_at: now, updated_at: now },
    ],
  });

  await setBudgets(ctx, { 'food and drink': 100, housing: 1500, travel: 200 });

  await syncsStore.set(ctx, 'item_chase', { at: SYNCED_AT });
  await noticesStore.set(ctx, 'item_broker', { episode: 'e1', since: `${daysAgo(1)}T13:00:00.000Z`, state: 'needs_reauth', notified_at: null, reminded_at: null });
  await warningsStore.set(ctx, 'item_chase', {
    kind: 'pending_expiration',
    received_at: SYNCED_AT,
    ends_at: new Date(Date.now() + 5 * DAY).toISOString(),
    ends_estimated: false,
    reason: null,
  });

  const accountsSeen = [{ account_id: 'acc_ira', type: 'investment', balance: 20500 }];
  await recordHoldings(ctx, [
    {
      error: null,
      accounts: accountsSeen,
      holdings_observed: observeHoldings({
        accounts: accountsSeen,
        holdings: [{ account_id: 'acc_ira', security_id: 'sec_vti', quantity: 80, institution_price: 250, institution_price_as_of: daysAgo(1), institution_value: 20000, cost_basis: 15000, iso_currency_code: 'USD', unofficial_currency_code: null }],
        securities: [{ security_id: 'sec_vti', ticker_symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'etf', is_cash_equivalent: false }],
      })!,
    },
  ]);
}

/**
 * A connection that brings in no transactions (lib/item-products.ts): linked
 * without Plaid billing Transactions, with the accounts a load remembered,
 * and, for a bank account or card Plaid refused a first sync for, the refusal
 * that sync stored (`refused`: Plaid's code, and when, by default now).
 */
export async function connectWithoutTransactions(
  fake: FakeRedis,
  opts: { item_id: string; name: string; accounts: { account_id: string; type: string }[]; refused?: { code: string; at?: string } }
) {
  await saveItem(ctx, { item_id: opts.item_id, institution_name: opts.name, encrypted_access_token: await encrypt(`access-sandbox-${opts.item_id}`), transactions_billed: false });
  await fake.hset(ctxKey('accounts:meta'), { [opts.item_id]: await remembered(opts.accounts.map((a) => ({ ...a, name: a.account_id }))) });
  if (opts.refused) {
    const cash = opts.accounts.filter((a) => a.type === 'depository' || a.type === 'credit').map((a) => a.account_id).sort();
    await fake.set(
      ctxKey(`txns:${opts.item_id}`),
      await encodeJsonBlob({ schema_version: 2, cursor: '', accounts: {}, txns: {}, refused: { at: opts.refused.at ?? new Date().toISOString(), code: opts.refused.code, accounts: cash } })
    );
  }
}

/** Someone else's container: none of it may ever show for the first one's token. */
export async function seedOther(fake: FakeRedis) {
  await fake.hset(testKey('containers'), { [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-02-01T00:00:00.000Z' }) });
  await saveItem(OTHER, { item_id: 'item_other', institution_name: 'OtherBank', encrypted_access_token: await encrypt('access-sandbox-other') });
  await fake.hset(ctxKey('accounts:meta', OTHER), { item_other: await remembered([{ account_id: 'acc_other', name: 'OTHER-SECRET-ACCOUNT', type: 'depository' }]) });
  await fake.set(
    ctxKey('txns:item_other', OTHER),
    await encodeJsonBlob({ schema_version: 2, cursor: 'c', accounts: {}, txns: { t_o: txn('t_o', 'acc_other', 1, 77, { name: 'OTHER-SECRET-TXN', institution_name: 'OtherBank' }) } })
  );
  await setBudgets(OTHER, { 'OTHER-SECRET-BUDGET': 5 });
}
