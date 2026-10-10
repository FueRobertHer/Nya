import { describe, expect, test } from 'bun:test';

// The API's operations (lib/api-ops.ts): each argument declared once, read
// strictly from a REST query (text) and from an MCP call (JSON), with the
// same names, ranges and refusals, and the schema an MCP client is shown.

process.env.PLAID_CLIENT_ID ||= 'placeholder';
process.env.PLAID_SECRET ||= 'placeholder';
const { OPERATIONS, operation, argsFromQuery, argsFromJson, inputSchema, BadRequest } = await import('@/lib/api-ops');

const tx = operation('transactions');
const query = (q: string) => argsFromQuery(tx, new URLSearchParams(q));
const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequest);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('from a query', () => {
  test('each kind read from its text', () => {
    expect(query('from=2026-10-01&to=2026-10-09&account_id=a,b&q=%20coffee%20&min_amount=-12.5&max_amount=100&include_hidden=1&limit=25&cursor=abc_-9')).toEqual({
      from: '2026-10-01',
      to: '2026-10-09',
      account_id: ['a', 'b'],
      q: 'coffee',
      min_amount: -12.5,
      max_amount: 100,
      include_hidden: true,
      limit: 25,
      cursor: 'abc_-9',
    });
    expect(query('include_hidden=false')).toEqual({ include_hidden: false });
    expect(query('')).toEqual({});
  });

  test('refused: unknown, repeated, or out of range, never ignored', () => {
    expect(refused(() => query('includeHidden=true'))).toContain('Unknown parameter: includeHidden');
    expect(refused(() => query('limit=5&limit=6'))).toBe('Give limit once.');
    for (const q of ['from=2026-02-29', 'from=26-10-01', 'limit=0', 'limit=501', 'limit=1.5', 'min_amount=1e3', 'min_amount=', 'q=', 'q=%00x', 'include_hidden=yes', 'account_id=a,,b', 'cursor=a%20b']) {
      expect([q, refused(() => query(q)).length > 0]).toEqual([q, true]);
    }
  });
});

describe('from JSON', () => {
  test('each kind read from its JSON type', () => {
    expect(argsFromJson(tx, { from: '2026-10-01', account_id: 'a', min_amount: 5, include_hidden: true, limit: 10, q: ' x ', category: null })).toEqual({
      from: '2026-10-01',
      account_id: ['a'],
      min_amount: 5,
      include_hidden: true,
      limit: 10,
      q: 'x',
    });
    expect(argsFromJson(tx, { account_id: ['a', 'b'] })).toEqual({ account_id: ['a', 'b'] });
    expect(argsFromJson(tx, undefined)).toEqual({});
  });

  test('refused: the wrong type, unknown names, or out of range', () => {
    for (const bad of [
      [],
      'x',
      { include_hidden: 'true' },
      { limit: 2.5 },
      { limit: '10' },
      { min_amount: Infinity },
      { min_amount: 1e14 },
      { from: 20261001 },
      { account_id: [] },
      { account_id: [1] },
      { nope: 1 },
      { __proto__: 1, toString: 2 },
    ]) {
      expect(() => argsFromJson(tx, bad)).toThrow(BadRequest);
    }
  });

  test('the schema an MCP client sees allows exactly the declared arguments', () => {
    const schema = inputSchema(tx.args) as any;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(tx.args).sort());
    expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 500 });
    expect(schema.properties.include_hidden.type).toBe('boolean');
    for (const p of Object.values(schema.properties) as any[]) expect(typeof p.description).toBe('string');
  });
});

describe('the operations', () => {
  test('each has a path, a summary and arguments, and the paths are unique', () => {
    const names = OPERATIONS.map((o) => o.name);
    expect(names).toEqual(['me', 'accounts', 'net-worth', 'balance-history', 'transactions', 'categories', 'budgets', 'spending', 'recurring', 'holdings']);
    expect(new Set(names).size).toBe(names.length);
    for (const o of OPERATIONS) expect(o.summary.length).toBeGreaterThan(10);
    expect(() => operation('nope')).toThrow();
  });
});
