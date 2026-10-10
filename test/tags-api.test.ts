import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Tags and notes through the read-only API and the MCP server (#40): the
// tags endpoint, tags and notes on transactions, the tag filters, spending by
// tag, all additive to version 1, from stored data alone, and never another
// person's.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// The real ceiling on a stored value: a file run before this one may have
// lowered it for its own tests (lib/blob.ts reads it on every write).
delete process.env.MAX_TXN_BLOB_CHARS;
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called by the API');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, OTHER, seedPerson, seedOther } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');
const { ensureTag, changeTagSet, renameTag } = await import('@/lib/tags');
const { changeAnnotation } = await import('@/lib/txn-annotations');
const mcpRoute = await import('@/app/api/mcp/route');

let token = '';
let work = '';
let trip = '';
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  await seedPerson(fake);
  token = (await createToken(ctx, 'Tests')).token;
  work = (await ensureTag(ctx, { name: 'Work' })).tag.id;
  trip = (await ensureTag(ctx, { name: 'Vacation 2026' })).tag.id;
  await changeAnnotation(ctx, 't_coffee', { add: [work], note: 'With the team' });
  await changeAnnotation(ctx, 't_card', { add: [work, trip] });
  await changeAnnotation(ctx, 't_hidden', { add: [trip] });
  await changeAnnotation(ctx, 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', { add: [trip] });
});

const call = async (name: string, query = '') => {
  const route = await import(`@/app/api/v1/${name}/route`);
  const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${name}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${token}` } }));
  return { status: res.status, body: (await res.json()) as any };
};
const ids = (body: any) => body.transactions.map((t: any) => t.id).sort();

describe('the tags endpoint', () => {
  test('every tag, with how many shown transactions carry it; hidden accounts only when asked', async () => {
    const { status, body } = await call('tags');
    expect(status).toBe(200);
    expect(body.tags).toEqual([
      { id: work, name: 'Work', color: expect.any(String), transactions: 2, last_date: expect.any(String) },
      { id: trip, name: 'Vacation 2026', color: expect.any(String), transactions: 2, last_date: expect.any(String) },
    ]);
    expect((await call('tags', 'include_hidden=true')).body.tags[1].transactions).toBe(3);
    expect((await call('tags', 'color=red')).status).toBe(400);
  });

  test('a rename is in the next answer, by the same id', async () => {
    await changeTagSet(ctx, (s) => renameTag(s, work, 'Day job'));
    expect((await call('tags')).body.tags[0]).toMatchObject({ id: work, name: 'Day job' });
    expect((await call('transactions', 'from=2000-01-01&tag_id=' + work)).body.transactions[0].tags).toContainEqual({ id: work, name: 'Day job' });
  });
});

describe('tags and notes on transactions, added to version 1', () => {
  test('each transaction carries its tags and the person’s note, every field it had before still there', async () => {
    const { body } = await call('transactions', 'from=2000-01-01');
    const byId = new Map(body.transactions.map((t: any) => [t.id, t]));
    expect((byId.get('t_coffee') as any).tags).toEqual([{ id: work, name: 'Work' }]);
    expect((byId.get('t_coffee') as any).note).toBe('With the team');
    expect((byId.get('t_card') as any).tags).toEqual([
      { id: work, name: 'Work' },
      { id: trip, name: 'Vacation 2026' },
    ]);
    expect((byId.get('t_rent') as any).tags).toEqual([]);
    // A manual row's note is its own, as before.
    expect((byId.get('manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d') as any).note).toBe('apples');
    for (const t of body.transactions) {
      for (const field of ['id', 'date', 'amount', 'currency', 'name', 'category', 'category_id', 'excluded', 'is_transfer', 'account_id', 'source', 'note']) expect(field in t).toBe(true);
    }
  });

  test('filters by tag, by name in any case or by id; q finds tag names and notes; an unknown id is a 404', async () => {
    expect(ids((await call('transactions', `from=2000-01-01&tag_id=${trip}`)).body)).toEqual(['manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', 't_card']);
    expect(ids((await call('transactions', 'from=2000-01-01&tag=WORK')).body)).toEqual(['t_card', 't_coffee']);
    expect(ids((await call('transactions', 'from=2000-01-01&tag=nobody')).body)).toEqual([]);
    expect(ids((await call('transactions', 'from=2000-01-01&q=vacation')).body)).toEqual(['manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', 't_card']);
    expect(ids((await call('transactions', 'from=2000-01-01&q=the%20team')).body)).toEqual(['t_coffee']);
    const missing = await call('transactions', 'tag_id=not-a-tag');
    expect([missing.status, missing.body.error.code]).toEqual([404, 'not_found']);
    expect((await call('transactions', 'tag_id=has%20space')).status).toBe(400);
  });

  test('a cursor belongs to its tag: carried to another, it is refused', async () => {
    const first = (await call('transactions', `from=2000-01-01&tag_id=${work}&limit=1`)).body;
    expect(first.has_more).toBe(true);
    const next = await call('transactions', `from=2000-01-01&tag_id=${work}&limit=1&cursor=${first.next_cursor}`);
    expect(next.status).toBe(200);
    expect((await call('transactions', `from=2000-01-01&tag_id=${trip}&limit=1&cursor=${first.next_cursor}`)).status).toBe(400);
  });

  test('spending by tag agrees with the category totals, in the totals’ currency', async () => {
    const { body } = await call('spending', 'from=2000-01-01');
    expect(body.currency).toBe('USD');
    // t_coffee 5.5 and t_card 80 (USD); t_paris is in EUR and left out.
    expect(body.tags).toEqual([
      { id: work, name: 'Work', spent: 85.5, transactions: 2 },
      { id: trip, name: 'Vacation 2026', spent: 105, transactions: 2 },
    ].sort((a, b) => b.spent - a.spent));
  });

  test('never another person’s tags', async () => {
    await seedOther(fake);
    await ensureTag(OTHER, { name: 'OTHER-SECRET-TAG' });
    const all = JSON.stringify([(await call('tags', 'include_hidden=true')).body, (await call('transactions', 'from=2000-01-01&include_hidden=true')).body]);
    expect(all).not.toContain('OTHER-SECRET');
  });
});

describe('through the MCP server', () => {
  const rpc = async (name: string, args: unknown) => {
    const res: Response = await mcpRoute.POST(
      new Request('https://nya.test/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      })
    );
    return (await res.json()).result;
  };

  test('list_tags lists them, and search_transactions filters by one', async () => {
    const tags = await rpc('list_tags', {});
    expect(tags.content[0].text).toBe('2 tags.');
    expect(tags.structuredContent.tags.map((t: any) => t.name)).toEqual(['Work', 'Vacation 2026']);
    const found = await rpc('search_transactions', { from: '2000-01-01', tag: 'work' });
    expect(found.structuredContent.transactions.map((t: any) => t.id).sort()).toEqual(['t_card', 't_coffee']);
  });
});
