// test/restore-fixture.ts
//
// A container with something of most kinds in it, for the restore's tests
// (test/user-restore-*.test.ts): two Plaid banks (one with a pending row and
// the posted row that replaced it), a manual account with its book, every
// history layer, what was said about rows (some of it about the pending
// row), links and what they carry, categories, tags, a rule, budgets, goals
// and settings. Written through the stores' own writes where there is one,
// so every value is one the app keeps. Callers mock lib/storage first.

import { ctxKey, type FakeRedis } from './fake-redis';
import type { Ctx } from '@/lib/containers';

export const OLD_ITEM = 'item_chase';
export const FID_ITEM = 'item_fid';

export const bankTxn = (over: Record<string, unknown>) => ({
  transaction_id: 't',
  pending_transaction_id: null,
  account_id: 'acc_chk',
  amount: 4.5,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  date: '2026-01-02',
  authorized_date: '2026-01-01',
  authorized_datetime: null,
  datetime: '2026-01-02T08:15:00Z',
  name: 'COFFEE 123',
  merchant_name: 'Blue Bottle',
  merchant_entity_id: 'ent_bb',
  website: null,
  logo_url: null,
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'VERY_HIGH' },
  personal_finance_category_icon_url: null,
  pending: false,
  payment_channel: 'in store',
  transaction_code: null,
  transaction_type: 'place',
  check_number: null,
  account_owner: null,
  location: { address: null, city: 'Oakland', region: 'CA', postal_code: null, country: 'US', lat: null, lon: null, store_number: null },
  payment_meta: { reference_number: null, ppd_id: null, payee: null, by_order_of: null, payer: null, payment_method: null, payment_processor: null, reason: null },
  counterparties: [],
  category: 'food and drink',
  account_name: 'Checking',
  institution_name: 'Chase',
  ...over,
});

export const TXNS = {
  t_coffee: bankTxn({ transaction_id: 't_coffee' }),
  t_pending: bankTxn({ transaction_id: 't_pending', pending: true, amount: 20, date: '2026-01-03', name: 'GAS', merchant_name: 'Shell', merchant_entity_id: null }),
  t_posted: bankTxn({ transaction_id: 't_posted', pending_transaction_id: 't_pending', amount: 20.5, date: '2026-01-04', name: 'GAS', merchant_name: 'Shell', merchant_entity_id: null }),
  t_card: bankTxn({ transaction_id: 't_card', account_id: 'acc_card', amount: 30, date: '2026-01-03', account_name: 'Sapphire', name: 'BOOKS', merchant_name: 'Green Apple', merchant_entity_id: 'ent_ga' }),
  t_old: bankTxn({ transaction_id: 't_old', amount: 61.2, date: '2025-11-20', name: 'GROCER 9', merchant_name: 'Rainbow', merchant_entity_id: null }),
};

const NOW = '2026-10-06T12:00:00.000Z';

export async function seedOld(fake: FakeRedis, ctx: Ctx): Promise<void> {
  const { encrypt } = await import('@/lib/crypto');
  const { encodeJsonBlob } = await import('@/lib/blob');
  const enc = (v: unknown) => encrypt(ctx, typeof v === 'string' ? v : JSON.stringify(v));
  const k = (name: string) => ctxKey(name, ctx);

  await fake.hset(k('plaid:items'), {
    [OLD_ITEM]: JSON.stringify({ item_id: OLD_ITEM, institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt(ctx, 'access-sandbox-a') }),
  });
  await fake.hset(k('accounts:meta'), {
    [OLD_ITEM]: await enc([
      { account_id: 'acc_chk', name: 'Checking', official_name: 'Total Checking', mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' },
      { account_id: 'acc_card', name: 'Sapphire', official_name: null, mask: '2222', type: 'credit', subtype: 'credit card', limit: 5000, currency: 'USD' },
    ]),
  });
  await fake.hset(k('accounts:directory'), {
    acc_chk: await enc({ provider: 'plaid', item_id: OLD_ITEM, institution_id: 'ins_3', institution_name: 'Chase', name: 'Checking', official_name: 'Total Checking', mask: '1111', type: 'depository', subtype: 'checking', persistent_account_id: 'pers_1', first_seen: '2025-06-01', last_seen: '2026-10-05' }),
    acc_old: await enc({ item_id: 'item_gone', institution_id: 'ins_3', institution_name: 'Chase', name: 'Old Checking', official_name: null, mask: '0000', type: 'depository', subtype: 'checking', persistent_account_id: null, first_seen: '2024-01-01', last_seen: '2025-05-31' }),
  });
  await fake.set(
    k(`txns:${OLD_ITEM}`),
    await encodeJsonBlob(ctx, {
      schema_version: 2,
      cursor: 'cursor-a',
      accounts: {
        acc_chk: { name: 'Checking', official_name: 'Total Checking', type: 'depository', subtype: 'checking', mask: '1111', balances: { available: 1650, current: 1700, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null } },
        acc_card: { name: 'Sapphire', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: { available: 4500, current: 500, limit: 5000, iso_currency_code: 'USD', unofficial_currency_code: null } },
      },
      txns: TXNS,
    })
  );
  await fake.hset(k('manual:accounts'), {
    manual_house: await enc({ account_id: 'manual_house', name: 'House', institution_name: 'Zillow estimate', type: 'other', subtype: null, balance: 400000, updated_at: '2026-09-30T10:00:00.000Z' }),
  });
  await fake.hset(k('hidden:accounts'), { acc_card: await enc({ type: 'credit', hidden_at: '2026-03-01T00:00:00.000Z' }) });
  await fake.hset(k('txn-category-overrides'), { t_coffee: await encrypt(ctx, 'Treats'), t_pending: await encrypt(ctx, 'Gas') });
  await fake.hset(k('txn-vendor-renames'), { 'mid:ent_bb': await encrypt(ctx, 'BB Coffee') });
  await fake.hset(k('account-links'), { acc_old: await enc({ to: 'acc_chk', linked_at: '2025-06-02T00:00:00.000Z', evidence: { old_last: '2025-05-31' } }) });
  await fake.hset(k('account-links:dismissed'), { 'acc_x>acc_chk': '2025-07-01T00:00:00.000Z' });
  await fake.hset(k('txn-category-carry'), { acc_old: await enc({ 'acc_old|2025-12-20|725|bakery 12': 'Bread' }) });
  await fake.hset(k('history:net-worth'), { '2026-01-01': await encrypt(ctx, '1000'), '2026-01-02': await encrypt(ctx, '1100.5') });
  await fake.hset(k('history:net-worth:est'), { '2025-12-30': await encrypt(ctx, '900') });
  await fake.hset(k('history:accounts'), { '2026-01-01': await enc({ acc_chk: 1500, acc_card: 500 }), '2026-01-02': await enc({ acc_chk: 1600.5, acc_card: 500 }) });
  await fake.hset(k('history:accounts:partial'), { '2026-01-04': await enc({ acc_chk: 1700 }) });
  await fake.hset(k('history:accounts:est'), { '2025-12-30': await enc({ acc_chk: 1400, acc_card: 500 }) });
  await fake.hset(k('history:accounts:est:ext'), { '2025-12-29': await enc({ acc_chk: 1390 }) });
  await fake.hset(k('history:accounts:est:flatd'), { '2025-12-30': await enc({ manual_house: 400000 }) });

  // On the seam.
  const { taxonomyStore } = await import('@/lib/category-store');
  const { seedTaxonomy } = await import('@/lib/categories');
  let n = 0;
  const taxonomy = seedTaxonomy([], () => `cat${++n}`);
  await taxonomyStore.set(ctx, taxonomy);
  const food = taxonomy.categories.find((c) => c.provider_keys.some((p) => p.key === 'FOOD_AND_DRINK'))!;
  const { tagStore } = await import('@/lib/tags');
  await tagStore.set(ctx, { version: 1, tags: [{ id: 'tag1', name: 'Trip', color: 'blue', created_at: NOW }] });
  const { rulesStore } = await import('@/lib/rules');
  await rulesStore.set(ctx, {
    version: 1,
    rules: [{ id: 'rule1', enabled: true, priority: 1, conditions: [{ field: 'name', op: 'contains', value: 'coffee' }], actions: { set_category: food.id }, created_at: NOW, updated_at: NOW }],
  });
  const { txnAnnotationStore } = await import('@/lib/txn-annotations');
  await txnAnnotationStore.set(ctx, 't_coffee', { note: 'with Sam', tags: ['tag1'], updated_at: NOW });
  await txnAnnotationStore.set(ctx, 't_pending', { note: 'fill up', updated_at: NOW });
  const { groupStore } = await import('@/lib/groups');
  await groupStore.set(ctx, 'g1', { version: 1, name: 'Weekend', category_id: food.id, members: ['t_card', 't_coffee'], date: '2026-01-02', currency: 'USD', created_at: NOW, updated_at: NOW });
  await groupStore.set(ctx, 'g2', { version: 1, name: 'Gas run', category_id: food.id, members: ['t_pending', 't_coffee'], date: '2026-01-02', currency: 'USD', created_at: NOW, updated_at: NOW });
  const { splitStore } = await import('@/lib/splits');
  await splitStore.set(ctx, 't_old', {
    version: 1,
    amount: 61.2,
    currency: 'USD',
    parts: [
      { id: 'p1', amount: 40, category_id: food.id },
      { id: 'p2', amount: 21.2, category_id: food.id, note: 'snacks' },
    ],
    updated_at: NOW,
  });
  const { approvalStore } = await import('@/lib/review-store');
  await approvalStore.set(ctx, 't_coffee', { version: 1, approved_at: NOW, amount: 4.5, currency: 'USD', category_id: food.id, name: 'Blue Bottle' });
  await approvalStore.set(ctx, 't_pending', { version: 1, approved_at: NOW, amount: 20, currency: 'USD', category_id: food.id, name: 'Shell', pending: true });
  const { reportSettingsStore } = await import('@/lib/report/store');
  await reportSettingsStore.set(ctx, { v: 1, marked: ['food and drink'] });
  const { manualTxnStore } = await import('@/lib/manual-txns');
  await manualTxnStore.set(ctx, 'manual_house', {
    version: 1,
    rows: [{ id: 'manual-txn:00000000-0000-4000-8000-000000000001', account_id: 'manual_house', date: '2026-02-01', amount: 120, currency: 'USD', name: 'Plumber', category: 'Home', note: null, source: 'manual', source_id: null, created_at: NOW, updated_at: NOW }],
  });
  const { setGoals } = await import('@/lib/goals');
  await setGoals(ctx, [{ id: 'g_trip', name: 'Trip', target: 3000, account_id: 'acc_chk' }]);
  const { budgetSetStore } = await import('@/lib/budget-store');
  const { legacyCopy } = await import('@/lib/budget-set');
  const { indexTaxonomy } = await import('@/lib/categories');
  const { setBudgets } = await import('@/lib/budgets');
  const budgets = { categories: { [food.id]: { amount: 400 } }, groups: {} };
  const copy = legacyCopy(budgets, indexTaxonomy(taxonomy));
  await budgetSetStore.set(ctx, { version: 1, ...budgets, mirror: copy, mirror_before: null });
  await setBudgets(ctx, copy);
}

/** A restore's record (lib/user-restore/store.ts), unfinished unless `over`
 *  says otherwise, for tests that need one there without running a restore. */
export function restoreRecord(over: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    id: 'user-restore:7f0c2a1e-4b3d-4c5e-8f6a-9b0c1d2e3f4a',
    status: 'writing' as 'writing' | 'finished' | 'undoing',
    started_at: '2026-10-07T09:00:00.000Z',
    finished_at: null as string | null,
    undo_until: null as string | null,
    last_batch_at: null as string | null,
    source: { exported_at: NOW, version: 2 as const, bytes: 20_000, protected: false },
    plan: { digest: 'a'.repeat(64), batches: [{ part: 'store:tags', count: 1, digest: 'b'.repeat(64) }] },
    done: 0,
    brought: { 'store:tags': 1 },
    left_out: {},
    without: {},
    history: null as { first: string; last: string } | null,
    earlier: [] as { exported_at: string; restored_at: string }[],
    ...over,
  };
}
