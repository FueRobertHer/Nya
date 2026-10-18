import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer } from './fake-redis';
import { seedOld } from './restore-fixture';

// Reading a download in the page (lib/user-restore/file.ts): collected,
// planned and batched, every batch then passing the server's own checks
// (lib/user-restore/check.ts), from a real download of a seeded container.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { collectUserData, buildUserExport, exportFile, fileChunks } = await import('@/lib/user-export');
const { collect, previewOf, buildBatches, FileRefused, digestOf } = await import('@/lib/user-restore/file');
const { checkBatch } = await import('@/lib/user-restore/check');
const { parseStrict } = await import('@/lib/user-restore/stream');
const { restoredId } = await import('@/lib/user-restore/ids');

const ctx = TEST_CTX;
const NOW = new Date('2026-10-06T12:00:00.000Z');

async function downloadText(): Promise<string> {
  const doc = buildUserExport(await collectUserData({ ctx, userId: 'user_me' }), NOW);
  const parts: Uint8Array[] = [...fileChunks(exportFile(doc, 'json'))];
  return new TextDecoder().decode(Buffer.concat(parts));
}
const sourceOf = (text: string, piece = 1000) => {
  const bytes = new TextEncoder().encode(text);
  return {
    size: bytes.length,
    protected: false,
    async *bytes() {
      for (let i = 0; i < bytes.length; i += piece) yield bytes.slice(i, i + piece);
    },
  };
};
const refusal = async (text: string): Promise<string> => {
  try {
    await collect(sourceOf(text));
  } catch (err) {
    if (err instanceof FileRefused) return err.problem;
    throw err;
  }
  return 'read';
};

let text = '';
beforeEach(async () => {
  fake.reset();
  await registerTestContainer(fake);
  await seedOld(fake, ctx);
  text ??= '';
  text = await downloadText();
});

describe('reading a real download', () => {
  test('collected: the bank’s rows counted, not held; what is small held', async () => {
    const c = await collect(sourceOf(text, 777));
    expect(c.version).toBe(2);
    expect([...c.bank.posted].sort()).toEqual(['t_card', 't_coffee', 't_old', 't_posted']);
    expect([...c.bank.pending]).toEqual(['t_pending']);
    expect([...c.bank.replaced]).toEqual(['t_pending']);
    expect(c.bank.accounts.get('acc_chk')).toEqual({ count: 3, first: '2025-11-20', last: '2026-01-04' });
    expect(c.core.transactions).toBeUndefined();
    expect(c.books.get('manual-transactions')?.map((b) => [b.id, b.size])).toEqual([['manual_house', 1]]);
  });

  test('the same file read in any piece size reads alike', async () => {
    const a = await collect(sourceOf(text, 1));
    const b = await collect(sourceOf(text, 65536));
    expect(previewOf(a).brought).toEqual(previewOf(b).brought);
  });

  test('every batch passes the server’s checks, and is the same however often it is built', async () => {
    const c = await collect(sourceOf(text));
    const p = previewOf(c);
    expect(p.refuse).toBeNull();
    const built: { part: string; body: string; count: number }[] = [];
    await buildBatches(sourceOf(text), c, async (b) => {
      built.push(b);
    });
    for (const b of built) expect(() => checkBatch(parseStrict(b.body), { exported: '2026-10-06', today: '2026-10-18' })).not.toThrow();
    const again: string[] = [];
    await buildBatches(sourceOf(text, 333), c, async (b) => {
      again.push(await digestOf(b.body));
    });
    expect(again).toEqual(await Promise.all(built.map((b) => digestOf(b.body))));
    const parts = built.map((b) => b.part);
    // Categories first, then the accounts, the rows, what was said, the history.
    expect(parts.indexOf('store:categories')).toBeLessThan(parts.indexOf('directory'));
    expect(parts.indexOf('directory')).toBeLessThan(parts.indexOf('restored-rows'));
    expect(parts.indexOf('restored-rows')).toBeLessThan(parts.indexOf('store:transaction-annotations'));
    expect(parts.indexOf('store:transaction-annotations')).toBeLessThan(parts.indexOf('history:net-worth'));
  });

  test('the bank’s rows re-keyed, pending ones left out with what was said about them', async () => {
    const c = await collect(sourceOf(text));
    const records = new Map<string, unknown[]>();
    await buildBatches(sourceOf(text), c, async (b) => {
      records.set(b.part, [...(records.get(b.part) ?? []), ...(parseStrict(b.body) as { records: unknown[] }).records]);
    });
    const rows = (records.get('restored-rows') as { id: string; rows: { id: string }[] }[]).flatMap((r) => r.rows.map((x) => x.id)).sort();
    expect(rows).toEqual(['t_card', 't_coffee', 't_old', 't_posted'].map(restoredId).sort());
    expect(records.get('overrides')).toEqual([{ id: restoredId('t_coffee'), value: 'Treats' }]);
    expect((records.get('store:transaction-annotations') as { id: string }[]).map((r) => r.id)).toEqual([restoredId('t_coffee')]);
    // A group left with one transaction is no group; the other keeps both, re-keyed.
    expect(records.get('store:transaction-groups')).toEqual([{ id: 'g1', value: expect.objectContaining({ members: [restoredId('t_card'), restoredId('t_coffee')] }) }]);
    // The pending row's approval is the posted row's, under the pending row's restored id.
    expect((records.get('store:transaction-approvals') as { id: string }[]).map((r) => r.id).sort()).toEqual([restoredId('t_coffee'), restoredId('t_pending')].sort());
    expect(previewOf(c).left_out).toMatchObject({ pending_transactions: 1, 'category_overrides:pending': 1, 'transaction-annotations:pending': 1, 'transaction-groups:pending': 1 });
  });
});

describe('refusals', () => {
  test('an unknown part, an unknown field, a newer version, damaged JSON', async () => {
    expect(await refusal(text.replace('"institutions":', '"newer_part": [], "institutions":'))).toContain('newer_part');
    expect(await refusal(text.replace('"transaction_id":"t_coffee"', '"transaction_id":"t_coffee","later":1'))).toContain('later: is a field this version of Nya doesn’t know');
    expect(await refusal(text.replace('"version": 2', '"version": 3'))).toContain('newer version of Nya (version 3)');
    expect(await refusal(text.replace('"format": "nya-export"', '"format": "other"'))).toContain('isn’t a download from Nya');
    expect(await refusal(text.slice(0, text.length / 2))).toContain('isn\'t JSON Nya can read');
  });

  test('a key twice, or one that would set a prototype', async () => {
    expect(await refusal(text.replace('"transaction_id":"t_coffee"', '"transaction_id":"t_coffee","transaction_id":"t_x"'))).toContain('JSON');
    expect(await refusal(text.replace('"institutions":', '"__proto__":{},"institutions":'))).toContain('JSON');
  });

  test('a damaged entry that other parts are read against refuses; one the person can do without is named', async () => {
    const withProblem = (p: unknown) => text.replace('"problems": []', `"problems": [${JSON.stringify(p)}]`);
    expect(previewOf(await collect(sourceOf(withProblem({ section: 'categories', problem: 'unreadable' })))).refuse).toContain('read as something else');
    expect(previewOf(await collect(sourceOf(withProblem({ section: 'rules', problem: 'unrecognised' })))).refuse).toContain('newer one may');
    const p = previewOf(await collect(sourceOf(withProblem({ section: 'transaction-annotations', problem: 'unreadable', ids: ['t_old'] }))));
    expect(p.refuse).toBeNull();
    expect(p.without).toEqual([{ part: 'transaction-annotations', count: 1, words: 'what you said about 1 transaction (notes, tags, exclusions)', affects: [{ date: '2025-11-20', amount: 61.2, name: 'Rainbow', account: 'acc_chk' }] }]);
  });
});
