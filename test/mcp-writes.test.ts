import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The MCP server's write tools (lib/mcp.ts WRITE_TOOLS): listed by what the
// token may do and whether this copy lets tokens write, refused by the same
// gate as their endpoints when called by name without being listed, each the
// same change as its endpoint, recorded as made over MCP, and summed up in
// numbers, dates and codes, never in the person's own words.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy({}, { get: () => async () => { throw new Error('Plaid must not be called'); } }),
}));
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, daysAgo, seedPerson } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');
const { TOOLS, WRITE_TOOLS, INSTRUCTIONS, WRITE_INSTRUCTIONS } = await import('@/lib/mcp');
const { ASK_FIRST } = await import('@/lib/api-spec');
const { readTagSet } = await import('@/lib/tags');
const { ensureTaxonomy, readTaxonomy } = await import('@/lib/category-store');
const { findManualTxn, manualTxnStore } = await import('@/lib/manual-txns');
const { getManualAccount } = await import('@/lib/manual');
const { changeStore } = await import('@/lib/api-changes');
const { apiWriteCount } = await import('@/lib/api-token-store');
const route = await import('@/app/api/mcp/route');

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const WALLET = 'manual_wallet';
const MARKET = 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const MARK = 'Zebracorn';

let writer = '';
let writerId = '';
let reader = '';
let readerId = '';
let balancer = '';
const saved = { ...process.env };
beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  process.env.API_WRITES_ENABLED = '1';
  await registerTestContainer(fake);
  await seedPerson(fake);
  await ensureTaxonomy(ctx);
  const w = await createToken(ctx, 'Claude', new Date(NOW), null, 'write');
  [writer, writerId] = [w.token, w.info.id];
  const r = await createToken(ctx, 'Reader', new Date(NOW));
  [reader, readerId] = [r.token, r.info.id];
  balancer = (await createToken(ctx, 'Home Assistant', new Date(NOW), null, 'balances')).token;
});
afterEach(() => {
  process.env = { ...saved };
  setSystemTime();
});

let nextId = 1;
async function rpc(token: string, method: string, params?: unknown): Promise<any> {
  const res: Response = await route.POST(
    new Request('https://nya.test/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }),
    })
  );
  return (await res.json()) as any;
}
const call = async (token: string, name: string, args?: unknown) => (await rpc(token, 'tools/call', { name, ...(args === undefined ? {} : { arguments: args }) })).result;
const names = async (token: string) => ((await rpc(token, 'tools/list')).result.tools as { name: string }[]).map((t) => t.name);
const instructions = async (token: string) => (await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result.instructions;
/** How many writes the token has sent this minute, by taking one more. */
const writesSent = async (id: string) => (await apiWriteCount.take(ctx, id, NOW)).count - 1;

const READ_TOOLS = TOOLS.map((t) => t.name);
const WRITE_NAMES = WRITE_TOOLS.map((t) => t.name);

describe('what each token is shown', () => {
  test('a read token sees exactly the tools it saw before, writing on or off', async () => {
    for (const on of ['1', '0']) {
      process.env.API_WRITES_ENABLED = on;
      expect(await names(reader)).toEqual(READ_TOOLS);
      expect(await instructions(reader)).toBe(INSTRUCTIONS);
    }
  });

  test('a write token sees the write tools while writing is on; off, what a read token sees', async () => {
    expect(await names(writer)).toEqual([...READ_TOOLS, ...WRITE_NAMES]);
    expect(await instructions(writer)).toBe(`${INSTRUCTIONS} ${WRITE_INSTRUCTIONS}`);
    const listed = (await rpc(writer, 'tools/list')).result.tools as any[];
    const tool = (n: string) => listed.find((t) => t.name === n);
    expect(tool('delete_transaction').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    expect(tool('add_tag').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(tool('get_transaction').annotations).toMatchObject({ readOnlyHint: true });
    expect(tool('update_transaction').inputSchema.required).toEqual(['transaction_id', 'version']);
    expect(tool('add_transaction').inputSchema.required).toEqual(['account_id', 'date', 'amount', 'name']);
    // Each that changes something tells the model to ask first.
    for (const t of WRITE_TOOLS.filter((t) => !t.annotations.readOnlyHint)) expect([t.name, tool(t.name).description.includes(ASK_FIRST)]).toEqual([t.name, true]);

    process.env.API_WRITES_ENABLED = '0';
    expect(await names(writer)).toEqual(READ_TOOLS);
    expect(await instructions(writer)).toBe(INSTRUCTIONS);
  });

  test('a balances token sees its accounts and the balance tool alone', async () => {
    expect(await names(balancer)).toEqual(['list_accounts', 'set_account_balance']);
    expect(await instructions(balancer)).toContain('set_account_balance');
    process.env.API_WRITES_ENABLED = '0';
    expect(await names(balancer)).toEqual(['list_accounts']);
  });
});

describe('a tool not shown can’t be called', () => {
  test('a read token’s call of a write tool is refused before anything is counted or changed', async () => {
    const r = await call(reader, 'add_tag', { name: MARK });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('This token can only read. Make a token that may do this under API tokens.');
    expect(await readTagSet(ctx)).toBeNull();
    expect(await writesSent(readerId)).toBe(0);
    expect(await changeStore.count(ctx)).toBe(0);
  });

  test('a balances token reads nothing but its accounts, and changes nothing but a balance', async () => {
    for (const [name, args] of [
      ['search_transactions', {}],
      ['get_net_worth', {}],
      ['add_tag', { name: MARK }],
      ['get_transaction', { transaction_id: MARKET }],
    ] as const) {
      const r = await call(balancer, name, args);
      expect([name, r.isError]).toEqual([name, true]);
    }
    const set = await call(balancer, 'set_account_balance', { account_id: WALLET, balance: 55 });
    expect(set.isError).toBeUndefined();
    expect((await getManualAccount(ctx, WALLET))!.balance).toBe(55);
  });

  test('turned off, a write token’s call of a write tool is refused, and nothing is made', async () => {
    process.env.API_WRITES_ENABLED = '0';
    const r = await call(writer, 'add_tag', { name: MARK });
    expect([r.isError, r.content[0].text]).toEqual([true, 'This copy of Nya doesn’t let tokens make changes.']);
    expect(await readTagSet(ctx)).toBeNull();
    expect(await writesSent(writerId)).toBe(0);
  });

  test('a name that is no tool is still unknown', async () => {
    const r = await rpc(writer, 'tools/call', { name: 'delete_account', arguments: {} });
    expect(r.error.message).toBe('Unknown tool: delete_account');
  });
});

describe('the write tools', () => {
  test('each is its endpoint’s change, recorded as made over MCP', async () => {
    const added = await call(writer, 'add_transaction', { account_id: WALLET, date: daysAgo(0, NOW), amount: 4.5, name: MARK, note: `${MARK} note`, idempotency_key: 'k1' });
    expect(added.isError).toBeUndefined();
    const id = added.structuredContent.transaction.id;
    expect((await findManualTxn(ctx, id))!.row).toMatchObject({ amount: 4.5, name: MARK, note: `${MARK} note`, source: 'manual' });
    expect((await changeStore.get(ctx, added.structuredContent.change_id))!).toMatchObject({ via: 'mcp', op: 'transaction.create', state: 'done' });
    // Sent again with its key: the first, and one row.
    const again = await call(writer, 'add_transaction', { account_id: WALLET, date: daysAgo(0, NOW), amount: 4.5, name: MARK, note: `${MARK} note`, idempotency_key: 'k1' });
    expect(again.structuredContent.transaction.id).toBe(id);
    expect((await manualTxnStore.get(ctx, WALLET))!.rows.filter((r) => r.name === MARK)).toHaveLength(1);

    // A null clears; the version it was read at decides.
    const read = await call(writer, 'get_transaction', { transaction_id: id });
    const stale = await call(writer, 'update_transaction', { transaction_id: id, version: 'not-it.not-it', note: null });
    expect(stale.isError).toBe(true);
    setSystemTime(new Date(NOW + 1000)); // listed after the create
    const cleared = await call(writer, 'update_transaction', { transaction_id: id, version: read.structuredContent.transaction.version, note: null });
    expect(cleared.isError).toBeUndefined();
    expect((await findManualTxn(ctx, id))!.row.note).toBeNull();
    const missing = await call(writer, 'update_transaction', { transaction_id: id, note: 'x' });
    expect([missing.isError, missing.content[0].text]).toEqual([true, 'version is needed.']);

    const changes = await call(writer, 'list_changes', {});
    expect(changes.structuredContent.changes.map((c: any) => c.op)).toEqual(['transaction.update', 'transaction.create']);
    const undone = await call(writer, 'undo_change', { change_id: changes.structuredContent.changes[0].id });
    expect(undone.isError).toBeUndefined();
    expect((await findManualTxn(ctx, id))!.row.note).toBe(`${MARK} note`);
  });

  test('a bank’s transaction is refused, as through its endpoint', async () => {
    const r = await call(writer, 'delete_transaction', { transaction_id: 't_coffee', version: 'a.b' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('bank');
  });

  test('summaries give numbers, dates and codes, never the person’s own words', async () => {
    const group = (await readTaxonomy(ctx))!.groups[0].id;
    const texts: string[] = [];
    let tick = 0;
    const run = async (name: string, args: Record<string, unknown>) => {
      setSystemTime(new Date(NOW + ++tick * 1000)); // each listed after the one before
      const r = await call(writer, name, args);
      expect([name, r.isError]).toEqual([name, undefined]);
      texts.push(r.content[0].text);
      return r.structuredContent;
    };
    const account = (await run('add_manual_account', { name: MARK, institution_name: MARK, type: 'depository', subtype: 'cash', balance: 10 })).account;
    await run('update_manual_account', { account_id: account.id, version: account.version, name: `${MARK} 2` });
    await run('set_account_balance', { account_id: account.id, balance: 11 });
    const txn = (await run('add_transaction', { account_id: account.id, date: daysAgo(0, NOW), amount: 3, name: MARK, note: MARK })).transaction;
    const changed = (await run('update_transaction', { transaction_id: txn.id, version: txn.version, name: `${MARK} 3` })).transaction;
    await run('get_transaction', { transaction_id: txn.id });
    await run('delete_transaction', { transaction_id: txn.id, version: changed.version });
    const cat = (await run('add_category', { name: MARK, group_id: group, icon: '🦓' })).category;
    await run('update_category', { category_id: cat.id, version: cat.version, name: `${MARK} 4` });
    const g = (await run('add_category_group', { name: MARK, kind: 'expense' })).group;
    await run('update_category_group', { group_id: g.id, version: g.version, name: `${MARK} 5` });
    const tag = (await run('add_tag', { name: MARK })).tag;
    await run('update_tag', { tag_id: tag.id, version: tag.version, name: `${MARK} 6` });
    const listed = await run('list_changes', { limit: 2 });
    await run('undo_change', { change_id: listed.changes[0].id });
    expect(texts).toHaveLength(WRITE_NAMES.length);
    for (const t of texts) expect(t).not.toContain(MARK);
    expect(texts[0]).toMatch(/^Added a manual account with a balance of 10\.00 USD\. Change \d{8}\.[0-9a-f]{16}\.[0-9a-f]{12}: undo_change reverses it while nothing changes it since\.$/);
  });
});
