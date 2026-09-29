import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Adding or removing accounts on an Item already connected, through Link's
// account picker (update mode with account selection), rather than connecting
// the institution a second time.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// What Plaid reports, by access token.
const plaidAccounts: Record<string, any[]> = {};
const failing = new Set<string>();
const linkRequests: any[] = [];
let itemGetFails = false;
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async (req: any) => {
      if (failing.has(req.access_token)) throw { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
      return { data: { accounts: plaidAccounts[req.access_token] ?? [], item: { institution_id: 'ins_3' } } };
    },
    linkTokenCreate: async (req: any) => {
      linkRequests.push(req);
      return { data: { link_token: 'link' } };
    },
    itemPublicTokenExchange: async () => ({ data: { access_token: 'token-fresh', item_id: 'item_fresh' } }),
    itemGet: async () => {
      if (itemGetFails) throw new Error('down');
      return { data: { item: { institution_id: 'ins_9' } } };
    },
    itemRemove: async () => ({ data: {} }),
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { rememberAccounts, rememberedIdsForItem } = await import('@/lib/last-known');
const { computeNetWorth, fetchInstitution } = await import('@/lib/networth');
const { markBackfillDone, isBackfillDone } = await import('@/lib/history');
const { getItems } = await import('@/lib/storage');
const { applyWebhook } = await import('@/lib/plaid-webhook');
const { itemsWithNewAccounts, markNewAccounts } = await import('@/lib/new-accounts');
const { existingItemsAt } = await import('@/lib/existing-items');

const account = (id: string) => ({
  account_id: id,
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: id.slice(-4),
  balances: { available: 100, current: 100, limit: null, iso_currency_code: 'USD' },
});

/** An Item as it is after a successful load: stored and remembered. */
async function addItem(item_id: string, account_ids: string[], extra: Record<string, unknown> = {}) {
  const token = `token-${item_id}`;
  plaidAccounts[token] = account_ids.map(account);
  await fake.hset(ctxKey('plaid:items'), {
    [item_id]: JSON.stringify({ item_id, institution_name: 'Chase', encrypted_access_token: await encrypt(token), ...extra }),
  });
  const inst = { item_id, institution_name: 'Chase', error: null, accounts: account_ids.map((id) => ({ ...account(id), balance: 100 })) };
  await rememberAccounts(ctx, [inst as any]);
}

const route = async (path: string, method: string, body?: unknown) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}`, { method, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, body: await res.json() };
};

const missingOn = async (item_id: string) =>
  (await computeNetWorth(ctx)).institutions.find((i) => i.item_id === item_id)?.unconfirmed_missing ?? 0;

beforeEach(async () => {
  fake.reset();
  failing.clear();
  linkRequests.length = 0;
  itemGetFails = false;
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

describe('opening the account picker', () => {
  test('asks Plaid for account selection on the existing Item', async () => {
    await addItem('item_1', ['acct_0001']);
    const res = await route('create-update-link-token', 'POST', { item_id: 'item_1', select_accounts: true });
    expect(res.status).toBe(200);
    expect(linkRequests[0].access_token).toBe('token-item_1');
    expect(linkRequests[0].update).toEqual({ account_selection_enabled: true });
    expect(linkRequests[0].products).toBeUndefined();
  });

  test('a plain reconnect does not show the picker', async () => {
    await addItem('item_1', ['acct_0001']);
    await route('create-update-link-token', 'POST', { item_id: 'item_1' });
    expect(linkRequests[0].update).toBeUndefined();
  });

  test('refuses account selection and a new product in one go', async () => {
    await addItem('item_1', ['acct_0001']);
    const res = await route('create-update-link-token', 'POST', { item_id: 'item_1', select_accounts: true, add_liabilities: true });
    expect(res.status).toBe(400);
    expect(linkRequests).toHaveLength(0);
  });
});

describe('after the picker', () => {
  test('a removed account never pauses snapshots, and an added one is remembered', async () => {
    await addItem('item_1', ['acct_0001', 'acct_0002']);
    await markBackfillDone(ctx);
    // The user kept 0001, dropped 0002, added 0003.
    plaidAccounts['token-item_1'] = [account('acct_0001'), account('acct_0003')];

    const res = await route('item-accounts-updated', 'POST', { item_id: 'item_1' });
    expect(res.body).toEqual({ added: 1, removed: 1 });
    expect((await rememberedIdsForItem(ctx, 'item_1')).sort()).toEqual(['acct_0001', 'acct_0003']);
    expect(await missingOn('item_1')).toBe(0);
    // An addition rebuilds the estimated history.
    expect(await isBackfillDone(ctx)).toBe(false);
  });

  test('catches a removal a load already recorded as missing', async () => {
    await addItem('item_1', ['acct_0001', 'acct_0002']);
    plaidAccounts['token-item_1'] = [account('acct_0001')];
    // A load between Link closing and the route: 0002 goes into the vanished
    // record, and the remembered list is rewritten without it.
    const { institutions } = await computeNetWorth(ctx);
    expect(institutions[0].unconfirmed_missing).toBe(1);
    await rememberAccounts(ctx, institutions);
    expect(await rememberedIdsForItem(ctx, 'item_1')).toEqual(['acct_0001']);

    const res = await route('item-accounts-updated', 'POST', { item_id: 'item_1' });
    expect(res.body).toEqual({ added: 0, removed: 1 });
    expect(await missingOn('item_1')).toBe(0);
  });

  test('a removal alone leaves the estimated history as it is', async () => {
    await addItem('item_1', ['acct_0001', 'acct_0002']);
    await markBackfillDone(ctx);
    plaidAccounts['token-item_1'] = [account('acct_0001')];
    await route('item-accounts-updated', 'POST', { item_id: 'item_1' });
    expect(await isBackfillDone(ctx)).toBe(true);
  });

  test('clears the new-accounts prompt', async () => {
    await addItem('item_1', ['acct_0001']);
    await markNewAccounts(ctx, 'item_1');
    await route('item-accounts-updated', 'POST', { item_id: 'item_1' });
    expect((await itemsWithNewAccounts(ctx)).size).toBe(0);
  });

  test('changes nothing it cannot measure when the Item fails to answer', async () => {
    await addItem('item_1', ['acct_0001', 'acct_0002']);
    failing.add('token-item_1');
    const res = await route('item-accounts-updated', 'POST', { item_id: 'item_1' });
    expect(res.body).toEqual({ added: 0, removed: 0 });
    expect((await rememberedIdsForItem(ctx, 'item_1')).sort()).toEqual(['acct_0001', 'acct_0002']);
  });

  test('an unknown Item is a 404', async () => {
    expect((await route('item-accounts-updated', 'POST', { item_id: 'nope' })).status).toBe(404);
    expect((await route('item-accounts-updated', 'POST', {})).status).toBe(400);
  });
});

describe('the institution id', () => {
  test('is stored from Plaid when an Item is linked', async () => {
    const res = await route('exchange-public-token', 'POST', { public_token: 'p', institution_name: 'Ally', institution_id: 'ins_forged' });
    expect(res.status).toBe(200);
    expect((await getItems(ctx))[0].institution_id).toBe('ins_9');
  });

  test('a failed lookup still links the Item', async () => {
    itemGetFails = true;
    const res = await route('exchange-public-token', 'POST', { public_token: 'p', institution_name: 'Ally' });
    expect(res.status).toBe(200);
    expect((await getItems(ctx))[0]).toMatchObject({ item_id: 'item_fresh', institution_id: null });
  });

  test('is carried by an Item that fails to load', async () => {
    await addItem('item_1', ['acct_0001'], { institution_id: 'ins_3' });
    failing.add('token-item_1');
    const [item] = await getItems(ctx);
    const inst = await fetchInstitution(item);
    expect(inst.needs_reauth).toBe(true);
    expect(inst.institution_id).toBe('ins_3');
  });
});

describe('new accounts at an Item', () => {
  test('the webhook sets the prompt and a disconnect clears it', async () => {
    await addItem('item_1', ['acct_0001']);
    expect(await applyWebhook(ctx, { webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE', item_id: 'item_1' })).toBe(true);
    expect([...(await itemsWithNewAccounts(ctx))]).toEqual(['item_1']);
    await route('disconnect', 'POST', { item_id: 'item_1' });
    expect((await itemsWithNewAccounts(ctx)).size).toBe(0);
  });

  test('other webhooks leave it alone', async () => {
    await addItem('item_1', ['acct_0001']);
    await applyWebhook(ctx, { webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: 'item_1' });
    expect((await itemsWithNewAccounts(ctx)).size).toBe(0);
  });
});

describe('existingItemsAt', () => {
  const inst = (item_id: string, institution_name: string, institution_id?: string | null, manual = false) => ({
    item_id,
    institution_name,
    institution_id,
    manual,
  });

  test('matches on the institution id when both sides have one', () => {
    const list = [inst('a', 'Chase', 'ins_3'), inst('b', 'Chase', 'ins_4'), inst('c', 'Ally', 'ins_9')];
    expect(existingItemsAt(list, { institution_id: 'ins_3', name: 'Chase' }).map((i) => i.item_id)).toEqual(['a']);
  });

  test('falls back to the name when an Item has no id', () => {
    const list = [inst('a', 'Chase', null), inst('b', 'Ally', null)];
    expect(existingItemsAt(list, { institution_id: 'ins_3', name: ' chase ' }).map((i) => i.item_id)).toEqual(['a']);
  });

  test('never offers a manual grouping or matches an empty name', () => {
    const list = [inst('m', 'Chase', null, true), inst('a', '', null)];
    expect(existingItemsAt(list, { institution_id: 'ins_3', name: 'Chase' })).toEqual([]);
    expect(existingItemsAt(list, { institution_id: null, name: '' })).toEqual([]);
  });
});
