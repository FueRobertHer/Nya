import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, ctxKey, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The one reader of manual accounts that names what it can't use instead of
// stopping (lib/manual.ts getManualAccountsReport), for the read-only API and
// the download of my data: each value by the storage seam's rules
// (lib/repo.ts openStored), and one sealed under a key this deployment can't
// use named apart from damage.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const MASTER = Buffer.alloc(32, 101).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt, forgetActiveKey, MasterKeyError } = await import('@/lib/crypto');
const { getManualAccountsReport } = await import('@/lib/manual');

const ctx = TEST_CTX;
const CASH = { account_id: 'manual_cash', name: 'Wallet', institution_name: 'Cash', type: 'depository' as const, subtype: 'cash', balance: 40, updated_at: '2026-09-30T10:00:00.000Z' };
const BODY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** A value as written under another PLAID_ENCRYPTION_KEY: what every value
 *  under k0 looks like once the key is replaced. */
async function underAnotherK0(plain: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(1), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  return Buffer.concat([iv, sealed]).toString('base64');
}

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  delete process.env.MASTER_KEY;
  forgetActiveKey();
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...saved };
  forgetActiveKey();
});

describe('getManualAccountsReport', () => {
  test('each account by why it can’t be used: damaged, not understood, or under a key this deployment lacks', async () => {
    await fake.hset(ctxKey('manual:accounts'), {
      manual_cash: await encrypt(JSON.stringify(CASH)),
      manual_damaged: 'not-ciphertext-but-long-enough-to-be-tried',
      manual_shape: await encrypt(JSON.stringify({ account_id: 'manual_shape', name: 'Boat', kind: 'a later one' })),
      manual_text: await encrypt('not json'),
      manual_later: `v2.k9-0badc0de.z.${BODY}`,
      manual_k0: await underAnotherK0(JSON.stringify(CASH)),
    });
    expect(await getManualAccountsReport(ctx)).toEqual({
      accounts: [CASH],
      unreadable: ['manual_damaged'],
      unrecognised: ['manual_later', 'manual_shape', 'manual_text'],
      unavailable: ['manual_k0'],
    });
  });

  test('with a master key: a data key the key store lacks is unavailable, and ciphertext that fails under one is damaged', async () => {
    process.env.MASTER_KEY = MASTER;
    forgetActiveKey();
    const sealed = await encrypt(JSON.stringify(CASH));
    expect(sealed).toStartWith('v2.k1-');
    // One character of the body changed: it no longer authenticates under its
    // key, whose id commits to it, so the bytes are damaged.
    const at = sealed.length - 8;
    const tampered = sealed.slice(0, at) + (sealed[at] === 'A' ? 'B' : 'A') + sealed.slice(at + 1);
    await fake.hset(ctxKey('manual:accounts'), {
      manual_cash: sealed,
      manual_tampered: tampered,
      manual_missing_key: `v2.k9-0badc0de.-.${BODY}`,
    });
    expect(await getManualAccountsReport(ctx)).toEqual({ accounts: [CASH], unreadable: ['manual_tampered'], unrecognised: [], unavailable: ['manual_missing_key'] });
  });

  // Nothing about any one account: every reader of them fails alike.
  test('without the master key a data key needs, or with storage out of reach, it throws', async () => {
    await fake.hset(ctxKey('manual:accounts'), { manual_cash: await encrypt(JSON.stringify(CASH)), manual_v2: `v2.k9-0badc0de.-.${BODY}` });
    expect(await getManualAccountsReport(ctx).catch((e) => e)).toBeInstanceOf(MasterKeyError);
    await fake.hdel(ctxKey('manual:accounts'), 'manual_v2');
    fake.failNext('hgetall');
    await expect(getManualAccountsReport(ctx)).rejects.toThrow('armed failure');
  });
});
