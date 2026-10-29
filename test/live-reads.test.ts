import { describe, expect, test, mock, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, unscopedDataKeys } from './fake-redis';

// The live paths' reads that don't depend on each other are begun together
// (lib/eager.ts), so Redis sends them in one round trip: each is asked for
// before any has answered. Each test holds every answer back and looks at
// what was asked for meanwhile.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called here');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { assembleBankRows } = await import('@/lib/activity');
const { syncItemTransactions } = await import('@/lib/transactions');
const { encrypt } = await import('@/lib/crypto');

const READS = ['get', 'hget', 'hgetall', 'hmget', 'mget', 'smembers', 'exists'] as const;

/** Holds every read back until `release`, noting what each asked for. */
function hold() {
  const asked: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const target = fake as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const real = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  for (const name of READS) {
    const fn = target[name];
    if (typeof fn !== 'function') continue;
    real.set(name, fn);
    target[name] = async (...args: unknown[]) => {
      asked.push(`${name} ${String(args[0])}`);
      await gate;
      return fn.apply(fake, args);
    };
  }
  return {
    asked,
    release: () => open(),
    restore: () => {
      for (const [name, fn] of real) target[name] = fn;
    },
  };
}

/** Lets everything that can run before a read answers run: the microtasks,
 *  and the work that takes longer (a decrypt), over a few turns of the event
 *  loop. */
async function untilWaiting() {
  for (let turn = 0; turn < 5; turn++) {
    for (let i = 0; i < 100; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('reads begun together', () => {
  test('the banks part asks for the Items, the hidden set and the closures before any answers', async () => {
    fake.reset();
    const h = hold();
    try {
      const run = assembleBankRows(TEST_CTX, { sync: false, readOnly: true });
      await untilWaiting();
      const keys = h.asked.map((a) => a.slice(a.lastIndexOf(':') + 1));
      expect(keys).toContain('items');
      expect(keys).toContain('accounts');
      expect(keys).toContain('account-lifecycle');
      h.release();
      await run;
    } finally {
      h.release();
      h.restore();
    }
  });

  test("a sync asks for the Item's blocked marker beside its credentials, and its stored rows only once the marker lets it go on", async () => {
    fake.reset();
    const item = { item_id: 'item_a', institution_name: 'Test Bank', encrypted_access_token: await encrypt(TEST_CTX, 'access-token') };
    const h = hold();
    try {
      const run = syncItemTransactions(TEST_CTX, item);
      await untilWaiting();
      expect(h.asked).toEqual([`get ${ctxKey('txns-blocked:item_a')}`]);
      h.release();
      await run.catch(() => {});
      // The rows were asked for after the marker answered: an Item blocked
      // as too large never fetches its blob, which can be megabytes.
      expect(h.asked).toContain(`get ${ctxKey('txns:item_a')}`);
    } finally {
      h.release();
      h.restore();
    }
  });
});
