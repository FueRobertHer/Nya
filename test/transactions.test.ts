import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

// Real AES-256-GCM, not a stub. Every stored blob in this module goes through
// encrypt -> gzip -> Redis and back, and the whole point of several of these
// tests is what happens when that round trip FAILS, so a stubbed cipher would
// test nothing.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// A ceiling a fixture can actually cross. The real one is 8M characters, which
// would take roughly a hundred megabytes of JSON to reach after gzip — far too
// slow to build in a unit test. A one-row blob encodes to about 800 characters,
// so this sits well clear of the ordinary fixtures and is crossed only by the
// deliberately bulky one. Read at import time, so it must be set before the
// module below is imported.
process.env.MAX_TXN_BLOB_CHARS = '5000';

// Drives /transactions/sync deterministically. Declared before mock.module
// because that call is hoisted above the imports below it (same hazard as
// test/investments.test.ts).
let pages: {
  added?: any[];
  modified?: any[];
  removed?: { transaction_id: string }[];
  accounts?: any[];
  next_cursor?: string;
  has_more?: boolean;
  status?: string;
  error?: string;
}[] = [];
let calls: { cursor: string | undefined }[] = [];

mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async (req: any) => {
      calls.push({ cursor: req.cursor });
      const page = pages[calls.length - 1] ?? { added: [] };
      if (page.error) throw { response: { data: { error_code: page.error } } };
      return {
        data: {
          added: page.added ?? [],
          modified: page.modified ?? [],
          removed: page.removed ?? [],
          accounts: page.accounts ?? [acct()],
          next_cursor: page.next_cursor ?? 'cursor-1',
          has_more: page.has_more ?? false,
          transactions_update_status: page.status ?? 'HISTORICAL_UPDATE_COMPLETE',
        },
      };
    },
  },
}));

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const {
  syncItemTransactions,
  readItemTransactions,
  getItemAccountIds,
  clearItemTransactions,
  TXN_SCHEMA_VERSION,
} =
  await import('@/lib/transactions');

const ITEM = {
  item_id: 'item_a',
  institution_name: 'Test Bank',
  encrypted_access_token: await encrypt('access-token'),
};

function acct(over: Record<string, unknown> = {}) {
  return {
    account_id: 'acct_1',
    name: 'Checking',
    official_name: null,
    type: 'depository',
    subtype: 'checking',
    mask: '4821',
    balances: { available: 100, current: 100, limit: null, iso_currency_code: 'USD' },
    ...over,
  };
}

function txn(over: Record<string, unknown> = {}) {
  return {
    transaction_id: 't1',
    account_id: 'acct_1',
    amount: 12.34,
    iso_currency_code: 'USD',
    date: daysAgo(3),
    name: 'COFFEE SHOP',
    pending: false,
    counterparties: [],
    ...over,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Writes a blob at the key the module reads, in the SAME encoding it writes:
 * JSON -> gzip -> base64 -> encrypt. Mirrors the private encodeState, which is
 * not exported, so the seeding path and the production path can drift. If these
 * tests start failing mysteriously, check that this still matches.
 */
async function seedState(item_id: string, state: unknown): Promise<void> {
  const gz = new Response(JSON.stringify(state)).body!.pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(gz).arrayBuffer());
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  await fake.set(testKey(`txns:${item_id}`), await encrypt(btoa(binary)));
}

/** Writes a blob in the pre-compression encoding: JSON straight into encrypt. */
async function seedUncompressedState(item_id: string, state: unknown): Promise<void> {
  await fake.set(testKey(`txns:${item_id}`), await encrypt(JSON.stringify(state)));
}

beforeEach(() => {
  fake.reset();
  pages = [];
  calls = [];
});

describe('persistence round trip', () => {
  test('stores state on first sync and resumes from the stored cursor', async () => {
    pages = [{ added: [txn()], next_cursor: 'cursor-1' }];
    const first = await syncItemTransactions(ITEM);

    expect(first.note).toBeNull();
    expect(first.txns.map((t) => t.transaction_id)).toEqual(['t1']);
    expect(calls[0].cursor).toBeUndefined(); // '' means never synced

    // Second sync: a different Plaid page, resuming from the persisted cursor.
    calls = [];
    pages = [{ added: [txn({ transaction_id: 't2', date: daysAgo(1) })], next_cursor: 'cursor-2' }];
    const second = await syncItemTransactions(ITEM);

    expect(calls[0].cursor).toBe('cursor-1');
    // t1 came from the persisted blob, t2 from this page: the store accumulates.
    expect(second.txns.map((t) => t.transaction_id).sort()).toEqual(['t1', 't2']);
  });

  test('a removed delta deletes the stored row', async () => {
    pages = [{ added: [txn(), txn({ transaction_id: 't2' })] }];
    await syncItemTransactions(ITEM);

    calls = [];
    pages = [{ removed: [{ transaction_id: 't1' }] }];
    const after = await syncItemTransactions(ITEM);

    expect(after.txns.map((t) => t.transaction_id)).toEqual(['t2']);
  });

  test('getItemAccountIds reads the persisted account map', async () => {
    pages = [{ added: [txn()], accounts: [acct(), acct({ account_id: 'acct_2', name: 'Savings' })] }];
    await syncItemTransactions(ITEM);

    expect((await getItemAccountIds('item_a')).sort()).toEqual(['acct_1', 'acct_2']);
  });
});

describe('retention beyond the display window', () => {
  test('rows older than the display window stay in the store', async () => {
    pages = [{ added: [txn({ transaction_id: 'old', date: daysAgo(700) }), txn()] }];

    // The display projection filters to the trailing LOOKBACK_DAYS window.
    const displayed = await syncItemTransactions(ITEM);
    expect(displayed.txns.map((t) => t.transaction_id)).toEqual(['t1']);

    // But the row is still persisted, which is the entire premise of this
    // module: it exists to outlive institutions that only expose a short
    // window to Plaid. A wider read finds it without another Plaid call.
    calls = [];
    pages = [{}];
    const stored = await readItemTransactions(ITEM, 1000);
    expect(stored.txns.map((t) => t.transaction_id).sort()).toEqual(['old', 't1']);
  });
});

describe('stored blob compatibility', () => {
  test('reads a pre-compression blob (raw JSON inside the ciphertext)', async () => {
    await seedUncompressedState('item_a', {
      schema_version: TXN_SCHEMA_VERSION,
      cursor: 'legacy-cursor',
      accounts: { acct_1: { name: 'Checking' } },
      txns: {
        t_old: {
          transaction_id: 't_old',
          account_id: 'acct_1',
          date: daysAgo(5),
          name: 'OLD ROW',
          amount: 5,
          pending: false,
          institution_name: 'Test Bank',
          category: null,
          counterparties: [],
        },
      },
    });

    pages = [{}];
    const res = await syncItemTransactions(ITEM);

    expect(calls[0].cursor).toBe('legacy-cursor');
    expect(res.txns.map((t) => t.transaction_id)).toEqual(['t_old']);
  });

  test('upgrades an unversioned blob in place, keeping every row and the cursor', async () => {
    await seedState('item_a', {
      // No schema_version at all: the pre-v2 shape.
      cursor: 'v1-cursor',
      accountNames: { acct_1: 'Checking' },
      txns: {
        t_v1: {
          transaction_id: 't_v1',
          date: daysAgo(4),
          name: 'LEGACY ROW',
          amount: 9.99,
          pending: false,
          account_name: 'Checking',
          institution_name: 'Test Bank',
          category: 'food and drink',
          account_id: 'acct_1',
        },
      },
    });

    pages = [{}];
    const res = await syncItemTransactions(ITEM);

    // Re-pulling would only recover what the bank still exposes, so the upgrade
    // must preserve the row rather than start clean.
    expect(calls[0].cursor).toBe('v1-cursor');
    expect(res.txns.map((t) => t.transaction_id)).toEqual(['t_v1']);
    const row = res.txns[0];
    expect(row.name).toBe('LEGACY ROW');
    expect(row.category).toBe('food and drink');
    // Fields the legacy shape never carried come back null rather than absent.
    expect(row.payment_channel).toBeNull();
    expect(row.counterparty).toBeNull();
  });

  test('passes a NEWER blob through untouched instead of downgrading it', async () => {
    // What an older deploy sees after a rollback. The blob is a superset, so
    // feeding it to the legacy migrator would null the fields it does not know.
    await seedState('item_a', {
      schema_version: TXN_SCHEMA_VERSION + 1,
      cursor: 'future-cursor',
      accounts: { acct_1: { name: 'Checking' } },
      txns: {
        t_future: {
          transaction_id: 't_future',
          account_id: 'acct_1',
          date: daysAgo(2),
          name: 'FUTURE ROW',
          merchant_name: 'Future Merchant',
          amount: 1,
          pending: false,
          institution_name: 'Test Bank',
          category: null,
          counterparties: [],
          some_unknown_future_field: 'preserved',
        },
      },
    });

    pages = [{}];
    const res = await syncItemTransactions(ITEM);

    expect(calls[0].cursor).toBe('future-cursor');
    expect(res.txns[0].name).toBe('Future Merchant');
  });
});

describe('hard stops leave the stored blob alone', () => {
  test('undecryptable credentials stop before any Plaid call', async () => {
    const res = await syncItemTransactions({ ...ITEM, encrypted_access_token: 'not-ciphertext' });

    expect(res.txns).toEqual([]);
    expect(res.note).toContain('could not decrypt stored credentials');
    expect(calls).toHaveLength(0);
  });

  test('ITEM_LOGIN_REQUIRED does not overwrite the stored blob', async () => {
    pages = [{ added: [txn()] }];
    await syncItemTransactions(ITEM);
    const stored = await fake.get<string>(testKey('txns:item_a'));
    expect(stored).not.toBeNull();

    calls = [];
    pages = [{ error: 'ITEM_LOGIN_REQUIRED' }];
    const res = await syncItemTransactions(ITEM);

    expect(res.note).toContain('needs to be reconnected');
    expect(await fake.get<string>(testKey('txns:item_a'))).toBe(stored as string);
  });
});

describe('a blob too large to persist', () => {
  // Rows whose names are random, so gzip cannot compress the bulk away: the
  // blob's size has to come from real entropy, or the encoded length barely
  // moves however many rows are added. Two are dated outside the display
  // window so the refusal can be shown not to drop the irreplaceable ones.
  const bulky = () =>
    Array.from({ length: 140 }, (_, i) => {
      const age = i < 2 ? 900 - i * 100 : 3;
      return txn({
        transaction_id: i < 2 ? `old_${i + 1}` : `t${i}`,
        date: daysAgo(age),
        name: `MERCHANT ${crypto.randomUUID()}`,
      });
    });

  test('refuses to write, and drops nothing from the returned set', async () => {
    pages = [{ added: bulky() }];
    const res = await readItemTransactions(ITEM, 1000);

    // THE point of the change. The old code trimmed oldest-first until the blob
    // fit, mutating the caller's state in place — and syncItem returns that same
    // object, so the trimmed set reached lib/backfill.ts through this very
    // function and reconstructed balances from a set with a hole in it.
    expect(res.txns).toHaveLength(140);
    // The two oldest are the ones the old code would have dropped first, and
    // the ones no bank will re-serve.
    expect(res.txns.map((t) => t.transaction_id)).toContain('old_1');
    expect(res.txns.map((t) => t.transaction_id)).toContain('old_2');
    expect(res.note).toContain("won't persist");
  });

  test('leaves the previously stored blob untouched', async () => {
    // One small row fits and persists.
    pages = [{ added: [txn()], next_cursor: 'cursor-small' }];
    await syncItemTransactions(ITEM);
    const stored = await fake.get<string>(testKey('txns:item_a'));
    expect(stored).not.toBeNull();

    // Now a pull that pushes it over. The stored blob must survive intact: the
    // cursor has not advanced, so the deltas replay safely next time.
    calls = [];
    pages = [{ added: bulky() }];
    await syncItemTransactions(ITEM);

    expect(await fake.get<string>(testKey('txns:item_a'))).toBe(stored as string);
  });

  test('sets the blocked marker so the next sync does not re-pull', async () => {
    pages = [{ added: bulky() }];
    await syncItemTransactions(ITEM);

    expect(await fake.get<string>(testKey('txns-blocked:item_a'))).not.toBeNull();
  });

  test('a failed persist never drops rows from the returned set', async () => {
    pages = [{ added: [txn(), txn({ transaction_id: 't2' })] }];
    fake.failNext('set');

    const res = await syncItemTransactions(ITEM);

    expect(res.txns.map((t) => t.transaction_id).sort()).toEqual(['t1', 't2']);
  });

  /** A marker recording a refusal at `chars`, as writeState would write it. */
  const blockedAt = (chars: number) =>
    fake.set(
      testKey('txns-blocked:item_a'),
      JSON.stringify({ at: '2026-01-15T00:00:00.000Z', chars })
    );

  test('a blocked item short-circuits instead of re-pulling from Plaid', async () => {
    await blockedAt(99_999_999); // still far over the 5000 test ceiling

    pages = [{ added: [txn()] }];
    const res = await syncItemTransactions(ITEM);

    // The whole point of the marker: no Plaid call at all. Without it, every
    // dashboard load would re-pull the Item's full history and refuse to write
    // it again, forever, at real cost.
    expect(calls).toHaveLength(0);
    expect(res.txns).toEqual([]);
    expect(res.note).toContain('too large to save');
    expect(res.note).toContain('2026-01-15');
    // The note must state what reconnecting costs, not just offer it.
    expect(res.note).toContain('discards');
  });

  test('raising the ceiling unblocks the item', async () => {
    // The legitimate fix is a bigger plan and a bigger limit. Before this was
    // handled, the short-circuit fired before any size was computed, so raising
    // the limit did nothing and reconnecting — which discards the stored
    // history — was the only way out.
    await blockedAt(1000); // under the 5000 ceiling now in force

    pages = [{ added: [txn()] }];
    const res = await syncItemTransactions(ITEM);

    expect(calls).toHaveLength(1);
    expect(res.txns.map((t) => t.transaction_id)).toEqual(['t1']);
    expect(await fake.get(testKey('txns-blocked:item_a'))).toBeNull();
  });

  test('an uninterpretable marker clears rather than blocking forever', async () => {
    await fake.set(testKey('txns-blocked:item_a'), 'not-json');

    pages = [{ added: [txn()] }];
    const res = await syncItemTransactions(ITEM);

    // Costs one wasted pull; writeState re-sets it if the blob is still too
    // big. Better than a permanently stuck Item nothing can interpret.
    expect(calls).toHaveLength(1);
    expect(res.note).toBeNull();
  });

  test('disconnecting clears the marker so a reconnect is not blocked', async () => {
    await blockedAt(99_999_999);
    await clearItemTransactions('item_a');

    pages = [{ added: [txn()] }];
    const res = await syncItemTransactions(ITEM);

    expect(calls).toHaveLength(1);
    expect(res.txns.map((t) => t.transaction_id)).toEqual(['t1']);
  });
});

describe('a ceiling error names the container (#58)', () => {
  test('in the refusal log line', async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    try {
      pages = [{ added: Array.from({ length: 140 }, (_, i) => txn({ transaction_id: `b${i}`, name: `M ${crypto.randomUUID()}` })) }];
      await syncItemTransactions(ITEM);
    } finally {
      console.error = origError;
    }
    // None is set up in this test.
    expect(errors.join(' ')).toContain('refusing to persist item_a in no container');
  });
});

describe('unreadable stored blob', () => {
  // readState used to catch ANY throw and return an empty state, which the next
  // writeState then persisted over the real blob: silent permanent loss of
  // everything past the bank's window. It now hard-stops instead.
  test('refuses to sync rather than overwriting history it cannot read', async () => {
    await fake.set(testKey('txns:item_a'), 'not-ciphertext');

    pages = [{ added: [txn({ transaction_id: 't_new' })] }];
    const res = await syncItemTransactions(ITEM);

    expect(calls).toHaveLength(0); // never reached Plaid
    expect(res.txns).toEqual([]);
    expect(res.note).toContain('refusing to re-sync over it');
    // The one that actually matters: the blob is still there.
    expect(await fake.get<string>(testKey('txns:item_a'))).toBe('not-ciphertext');
  });

  test('a failed Redis read is not treated as an empty store', async () => {
    pages = [{ added: [txn()] }];
    await syncItemTransactions(ITEM);
    const stored = await fake.get<string>(testKey('txns:item_a'));

    // A transient read failure used to mean "start clean", which would re-pull
    // from scratch and persist the bank's short window over years of rows. The
    // read is transient; that overwrite would not be.
    calls = [];
    // Two, because syncItem reads the blocked marker before the state blob and
    // deliberately tolerates that first read failing. The second is the one
    // under test.
    fake.failNext('get', 2);
    const res = await syncItemTransactions(ITEM);

    expect(calls).toHaveLength(0);
    expect(res.note).toContain('refusing to re-sync over it');
    expect(await fake.get<string>(testKey('txns:item_a'))).toBe(stored as string);
  });

  test('an absent blob is still a legitimate fresh start', async () => {
    pages = [{ added: [txn()] }];
    const res = await syncItemTransactions(ITEM);

    // The one case that should start from empty, and the reason the null check
    // sits outside the try rather than inside it.
    expect(res.note).toBeNull();
    expect(res.txns.map((t) => t.transaction_id)).toEqual(['t1']);
  });
});
