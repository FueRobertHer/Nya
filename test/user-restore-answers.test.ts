import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld } from './restore-fixture';

// The answers about the accounts a restore brought back from a bank
// connected through Plaid, through their route (app/api/user-restore/answers,
// lib/user-restore/answering.ts), after a real restore (test/restore-run.ts):
// each answer checked and written, its end first, what every reader then
// counts, and what the card is told.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_ENABLED = '1';

mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({ data: { added: [], modified: [], removed: [], accounts: [], next_cursor: 'c-next', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' } }),
  },
}));
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { lifecycleStore, markEnded } = await import('@/lib/lifecycle');
const { linkAccounts } = await import('@/lib/links');
const { restoredAnswersStore, userRestoreStore } = await import('@/lib/user-restore/store');
const { connectionsStore, connectorAccountsStore } = await import('@/lib/connectors/store');
const { institutionRef } = await import('@/lib/connectors/institutions');
const { removeItem } = await import('@/lib/storage');
const { EXPORTED, downloadText, restoreAll, connectAgain, call, planned } = await import('./restore-run');
const { NOV, JAN, month, every, shared } = await import('./restore-readers');
const { countedLines } = await import('@/components/restore-state');
const linksRoute = await import('@/app/api/account-links/route');
const { hold } = await import('./restore-run');

const ctx = TEST_CTX;

fake.reset();
await registerTestContainer(fake);
await seedOld(fake, ctx);
const OLD = await downloadText(EXPORTED);

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await restoreAll(OLD);
});

const answer = (body: unknown) => call('POST', '/api/user-restore/answers', body);
const CLOSED = { state: 'closed' as const, on: '2026-10-07' };

/** A SimpleFIN account at Chase tracked since the restore, in `currency`. */
async function trackSimpleFin(account_id = 'manual_sf_chk', currency = 'USD') {
  const at = new Date().toISOString();
  await connectionsStore.set(ctx, 'conn_sf', { version: 1, connector: 'simplefin', host: 'bridge.simplefin.org', created_at: at, last_fetch: null, last_answer_at: at, tracked: [], available: [], history: null });
  await connectorAccountsStore.set(ctx, account_id, {
    version: 1,
    account_id,
    connection_id: 'conn_sf',
    connector: 'simplefin',
    remote_id: `R-${account_id}`,
    name: 'Total Checking',
    institution_name: 'Chase',
    institution_key: 'chase.com',
    institution_ref: institutionRef('conn_sf', 'chase.com'),
    type: 'depository',
    subtype: null,
    currency,
    reported_balance: null,
    reported_available: null,
    balance_at: null,
    fetched_at: null,
    created_at: at,
  });
}

describe('count', () => {
  test('ends the account first, then counts it: every reader counts its grocery, to the cent', async () => {
    const res = await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED });
    expect(res).toEqual({ status: 200, body: { answered: 1 } });
    expect((await lifecycleStore.get(ctx, 'acc_chk'))!.lifecycle).toEqual(CLOSED);
    expect(await restoredAnswersStore.get(ctx, 'acc_chk')).toMatchObject({ counted: { by: 'person', ended: CLOSED }, apart: { items: [], accounts: [] }, handed_to: null });
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await shared(NOV)).toBe(61.2);
  });

  test('an account with no end needs one, at the latest the day after its download', async () => {
    const none = await answer({ action: 'count', account_ids: ['acc_chk'] });
    expect(none.status).toBe(400);
    expect(none.body.error).toContain('Say when to stop counting Chase Checking ••1111');
    const late = await answer({ action: 'count', account_ids: ['acc_chk'], end: { state: 'untracked', from: '2026-10-08' } });
    expect(late.status).toBe(400);
    expect(late.body.error).toBe('Nya has Chase Checking ••1111’s transactions only up to your download of Oct 6, 2026: it can stop counting on Oct 7, 2026 at the latest.');
    // Nothing was written.
    expect(await lifecycleStore.get(ctx, 'acc_chk')).toBeNull();
    expect(await restoredAnswersStore.get(ctx, 'acc_chk')).toBeNull();
  });

  test('an account ended already keeps its end, and the answer names none it wrote', async () => {
    await markEnded(ctx, 'acc_chk', { state: 'untracked', from: '2026-01-03' }, { type: 'depository', label: { name: 'Checking', institution: 'Chase', mask: '1111' }, item_id: 'item_chase' });
    expect((await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED })).status).toBe(200);
    expect((await lifecycleStore.get(ctx, 'acc_chk'))!.lifecycle).toEqual({ state: 'untracked', from: '2026-01-03' });
    expect((await restoredAnswersStore.get(ctx, 'acc_chk'))!.counted!.ended).toBeNull();
  });

  test('uncount holds it again; its end stays', async () => {
    await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED });
    expect((await answer({ action: 'uncount', account_ids: ['acc_chk'] })).status).toBe(200);
    expect(await month(NOV)).toEqual(every(0));
    expect((await lifecycleStore.get(ctx, 'acc_chk'))!.lifecycle).toEqual(CLOSED);
    // It said nothing else: no answer is kept.
    expect(await restoredAnswersStore.get(ctx, 'acc_chk')).toBeNull();
  });

  test('a linked account is answered by its link, and isn’t asked', async () => {
    await connectAgain(fake);
    await linkAccounts(ctx, 'acc_chk', 'new_chk', {});
    const res = await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('is linked to an account connected again');
  });

  test('refused for an account no restore brought back, and while a restore is unfinished', async () => {
    expect((await answer({ action: 'count', account_ids: ['acc_nope'], end: CLOSED })).status).toBe(404);
    const record = (await userRestoreStore.get(ctx))!;
    await userRestoreStore.set(ctx, { ...record, status: 'undoing' } as never);
    const res = await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('being written or undone');
  });

  test('every field is checked', async () => {
    for (const body of [
      null,
      { action: 'count' },
      { action: 'count', account_ids: [] },
      { action: 'count', account_ids: ['acc_chk'], end: { state: 'closed' } },
      { action: 'count', account_ids: ['acc_chk'], end: { state: 'closed', on: '2999-01-01' } },
      { action: 'count', account_ids: ['acc_chk'], extra: 1 },
      { action: 'apart', account_ids: ['acc_chk'], connection: { kind: 'bank', id: 'x' } },
      { action: 'hand-over', account_id: 'acc_chk' },
      { action: 'forget', account_ids: ['acc_chk'] },
    ]) {
      expect([body, (await answer(body)).status]).toEqual([body, 400]);
    }
  });
});

describe('apart and ask again', () => {
  test('an Item said not to hold it lets it count; asked again, it holds once more', async () => {
    await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED });
    await connectAgain(fake);
    expect(await month(NOV)).toEqual(every(0));
    expect((await answer({ action: 'apart', connection: { kind: 'item', id: 'item_new' }, account_ids: ['acc_chk', 'acc_card'] })).status).toBe(200);
    expect(await month(NOV)).toEqual(every(61.2));
    // The card, not counted, keeps the answer for when it is.
    expect((await restoredAnswersStore.get(ctx, 'acc_card'))!).toMatchObject({ counted: null, apart: { items: ['item_new'], accounts: [] } });
    await answer({ action: 'ask-again', connection: { kind: 'item', id: 'item_new' }, account_ids: ['acc_chk'] });
    expect(await month(NOV)).toEqual(every(0));
  });

  test('a connection that is gone can’t be answered for, and each write drops what names one', async () => {
    await connectAgain(fake);
    await answer({ action: 'apart', connection: { kind: 'item', id: 'item_new' }, account_ids: ['acc_chk'] });
    await removeItem(ctx, 'item_new');
    const gone = await answer({ action: 'apart', connection: { kind: 'item', id: 'item_new' }, account_ids: ['acc_chk'] });
    expect(gone.status).toBe(404);
    await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED });
    expect((await restoredAnswersStore.get(ctx, 'acc_chk'))!.apart).toEqual({ items: [], accounts: [] });
  });
});

describe('hand over', () => {
  test('counts and ends the account, carried on by the connector account; taken back, every connector account holds it again', async () => {
    await trackSimpleFin();
    const res = await answer({ action: 'hand-over', account_id: 'acc_chk', to: 'manual_sf_chk', end: { state: 'untracked', from: '2026-01-05' } });
    expect(res.status).toBe(200);
    expect(await restoredAnswersStore.get(ctx, 'acc_chk')).toMatchObject({ counted: { by: 'person', ended: { state: 'untracked', from: '2026-01-05' } }, handed_to: { account_id: 'manual_sf_chk' } });
    // Its account has no rows yet: the restored ones count whole.
    expect(await month(NOV)).toEqual(every(61.2));
    await answer({ action: 'take-back', account_id: 'acc_chk' });
    expect(await month(NOV)).toEqual(every(0));
  });

  test('only to an account in the same currency, and one account carries on one', async () => {
    await trackSimpleFin('manual_sf_eur', 'EUR');
    const other = await answer({ action: 'hand-over', account_id: 'acc_chk', to: 'manual_sf_eur', end: CLOSED });
    expect(other.status).toBe(409);
    expect(other.body.error).toContain('an account doesn’t change currency');
    await trackSimpleFin();
    expect((await answer({ action: 'hand-over', account_id: 'acc_chk', to: 'manual_sf_chk', end: CLOSED })).status).toBe(200);
    const twice = await answer({ action: 'hand-over', account_id: 'acc_card', to: 'manual_sf_chk', end: CLOSED });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toContain('carries on another account from your download already');
  });

  test('not to an account that isn’t tracked through a connector', async () => {
    expect((await answer({ action: 'hand-over', account_id: 'acc_chk', to: 'manual_house', end: CLOSED })).status).toBe(404);
  });
});

describe('what the card is told', () => {
  test('each bank with accounts not linked, its answers, the prefilled end and its latest, and the connections made since', async () => {
    await connectAgain(fake);
    await trackSimpleFin();
    let state = await call('GET', '/api/user-restore');
    expect(state.status).toBe(200);
    const bank = state.body.answers.banks[0];
    // The prefill: the day after the later of its last restored row (Jan 4)
    // and its last restored balance (Jan 4, partial); the latest, the day
    // after the download.
    expect([bank.institution_name, bank.prefill, bank.latest]).toEqual(['Chase', '2026-01-05', '2026-10-07']);
    expect(bank.accounts.map((a: any) => [a.account_id, a.counted, a.hidden, a.end])).toEqual([
      ['acc_chk', null, false, null],
      ['acc_card', null, true, null],
    ]);
    expect(state.body.answers.holders.map((h: any) => [h.kind, h.id, h.institution])).toEqual([
      ['item', 'item_new', 'Chase'],
      ['connector', 'manual_sf_chk', 'Chase'],
    ]);
    await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED });
    state = await call('GET', '/api/user-restore');
    const counted = state.body.answers.banks[0].accounts.find((a: any) => a.account_id === 'acc_chk');
    expect(counted).toMatchObject({ counted: 'person', end: CLOSED, held_by: ['item_new', 'manual_sf_chk'] });
  });

  test('nothing to answer once every account is linked', async () => {
    await connectAgain(fake);
    await linkAccounts(ctx, 'acc_chk', 'new_chk', {});
    await linkAccounts(ctx, 'acc_card', 'new_card', {});
    expect((await call('GET', '/api/user-restore')).body.answers).toEqual({ banks: [], holders: [], unreadable: false });
  });

  test('an answer that can’t be read is said, never counted', async () => {
    await fake.hset(ctxKey('restored-answers'), { acc_chk: 'not a value Nya wrote' });
    expect((await call('GET', '/api/user-restore')).body.answers.unreadable).toBe(true);
  });
});

describe('a file that says an account ended', () => {
  /** The old copy, its checking account closed on Jan 3 there, downloaded;
   *  then this account emptied again, to bring it back. */
  async function endedThere() {
    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    await seedOld(fake, ctx);
    await markEnded(ctx, 'acc_chk', { state: 'closed', on: '2026-01-03' }, { type: 'depository', label: { name: 'Checking', institution: 'Chase', mask: '1111' }, item_id: 'item_chase', currency: 'USD' });
    const text = await downloadText(EXPORTED);
    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    return text;
  }

  test('counts it here as it counted there, up to its end, by the file’s word; the preview says so', async () => {
    const text = await endedThere();
    const { p } = await planned(text);
    expect(countedLines(p.counted)).toEqual(['Chase Checking ••1111 ended in your other copy on Jan 3, 2026: its transactions up to then count here too, as they did there']);
    await restoreAll(text);
    expect(await restoredAnswersStore.get(ctx, 'acc_chk')).toMatchObject({ counted: { by: 'file', ended: null } });
    // The card, which didn't end there, waits for an answer.
    expect(await restoredAnswersStore.get(ctx, 'acc_card')).toBeNull();
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await month(JAN)).toEqual(every(4.5, JAN));
  });

  test('one that didn’t end counts nothing until it is answered for', async () => {
    const { p } = await planned(OLD);
    expect(p.counted).toEqual([]);
    expect(await restoredAnswersStore.getAll(ctx)).toEqual(new Map());
  });
});

describe('a download of a copy that answered, brought back again', () => {
  test('keeps its answers and its ends: every reader counts as it did', async () => {
    await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED });
    const was = await restoredAnswersStore.get(ctx, 'acc_chk');
    const text = await downloadText(new Date());
    expect(JSON.parse(text)['restored-answers']).toHaveLength(1);
    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    await restoreAll(text);
    expect(await restoredAnswersStore.get(ctx, 'acc_chk')).toEqual(was);
    expect((await lifecycleStore.get(ctx, 'acc_chk'))!.lifecycle).toEqual(CLOSED);
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await shared(NOV)).toBe(61.2);
  });
});

describe('a later link', () => {
  const link = (old: string, to: string) => linksRoute.POST(new Request('http://localhost/api/account-links', { method: 'POST', body: JSON.stringify({ action: 'link', old, to }) }));
  const unlink = (old: string) => linksRoute.DELETE(new Request('http://localhost/api/account-links', { method: 'DELETE', body: JSON.stringify({ old }) }));
  /** Connected again, its balance fetched once: the directory knows the new
   *  checking account from today, so it is offered to link by hand. */
  async function connectedAndSeen() {
    await connectAgain(fake);
    const { restoreDirectoryEntries } = await import('@/lib/links');
    const today = new Date().toISOString().slice(0, 10);
    await restoreDirectoryEntries(ctx, [
      ['new_chk', { provider: 'plaid', item_id: 'item_new', institution_id: 'ins_3', institution_name: 'Chase', name: 'Checking', official_name: 'Total Checking', mask: '1111', type: 'depository', subtype: 'checking', persistent_account_id: null, first_seen: today, last_seen: today } as never],
    ]);
  }

  test('takes away the end the count wrote, so the new account doesn’t end; unlinked, it gets it back', async () => {
    await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED });
    await connectedAndSeen();
    expect((await link('acc_chk', 'new_chk')).status).toBe(200);
    expect(await lifecycleStore.get(ctx, 'acc_chk')).toBeNull();
    // Its rows are the linked account's: November's grocery, once.
    expect(await month(NOV)).toEqual(every(61.2));
    // The card, still waiting, holds the totals; the checking account doesn't.
    expect((await hold()).waiting).toEqual([{ institution_name: 'Chase', last: '2026-01-03' }]);

    expect((await unlink('acc_chk')).status).toBe(200);
    expect((await lifecycleStore.get(ctx, 'acc_chk'))!.lifecycle).toEqual(CLOSED);
    // Counted again, and held by the Item until it is answered for.
    expect(await month(NOV)).toEqual(every(0));
    expect((await hold()).waiting).toEqual([{ institution_name: 'Chase', last: '2026-01-03' }]);
  });

  test('an end from elsewhere stays: the file’s, or one set since', async () => {
    await answer({ action: 'count', account_ids: ['acc_chk'], end: CLOSED });
    // Changed since, by the person: Stop following from another day.
    await markEnded(ctx, 'acc_chk', { state: 'untracked', from: '2026-01-05' }, { type: 'depository', label: { name: 'Checking', institution: 'Chase', mask: '1111' }, item_id: 'item_chase' });
    await connectedAndSeen();
    expect((await link('acc_chk', 'new_chk')).status).toBe(200);
    expect((await lifecycleStore.get(ctx, 'acc_chk'))!.lifecycle).toEqual({ state: 'untracked', from: '2026-01-05' });
  });
});
