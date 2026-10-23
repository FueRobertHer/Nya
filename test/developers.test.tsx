import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer } from './fake-redis';

// The developer page (app/developers) and its reference (lib/api-examples.ts),
// held to the code: every endpoint, parameter and tool the code has is on the
// page; every field a real answer holds is described, and the examples hold
// only described fields, in the shape the API answers with; and it claims no
// compatibility with any other product.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { default: DevelopersPage } = await import('@/app/developers/page');
const { API_DOCS, RESOURCE_DOCS } = await import('@/lib/api-examples');
const { OPERATION_SPECS, TOOL_SPECS, PROTOCOL_VERSIONS, RESOURCE_SPECS, WRITE_TOOL_SPECS } = await import('@/lib/api-spec');
const limits = await import('@/lib/api-limits');
const { generateMetadata } = await import('@/app/developers/page');
const { readTaxonomy, ensureTaxonomy } = await import('@/lib/category-store');
const { REQUESTS_PER_MINUTE, MAX_TOKENS, MAX_PAGE_SIZE, MCP_MAX_PAGE_SIZE, API_AUTH_MAX_FAILURES, API_AUTH_WINDOW_SECONDS } = await import('@/lib/api-limits');
const { ctx, seedPerson } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});
const page = () => text(renderToStaticMarkup(<DevelopersPage />));

describe('the page', () => {
  test('documents every endpoint and its parameters, every tool, and the limits, from the code', () => {
    const p = page();
    for (const op of OPERATION_SPECS) {
      expect(p).toContain(`GET /api/v1/${op.name}`);
      expect(p).toContain(op.summary);
      for (const name of Object.keys(op.args)) expect([op.name, name, p.includes(name)]).toEqual([op.name, name, true]);
      for (const [path] of API_DOCS[op.name].fields) expect([op.name, path, p.includes(path)]).toEqual([op.name, path, true]);
    }
    for (const tool of TOOL_SPECS) {
      expect(p).toContain(tool.name);
      expect(p).toContain(tool.description);
    }
    for (const v of PROTOCOL_VERSIONS) expect(p).toContain(v);
    expect(p).toContain(`Each token may make ${REQUESTS_PER_MINUTE} requests in 60 seconds`);
    expect(p).toContain(`You can have up to ${MAX_TOKENS}.`);
    expect(p).toContain(`(at most ${MAX_PAGE_SIZE})`);
    expect(p).toContain('A transaction’s positive amount is money leaving the account');
    expect(p).toContain('What a credit card or a loan owes is a positive balance');
    expect(p).toContain('What version 1 promises');
  });

  test('says what the review asked to be said: failures, restores, the demo, dates, and the MCP server’s size', () => {
    const p = page();
    expect(p).toContain(`or more than ${API_AUTH_MAX_FAILURES} requests with tokens that don’t work from your address in ${API_AUTH_WINDOW_SECONDS / 60} minutes`);
    expect(p).toContain('The token is good, but your data can’t be reached just now');
    expect(p).toContain('Try again later, and keep the token.');
    expect(p).toContain('Backups leave tokens out, so if a backup is ever restored, every token stops: make new ones.');
    expect(p).toContain('Signing out everywhere, or changing the app password, doesn’t revoke tokens.');
    expect(p).toContain('The demo accounts can’t make tokens');
    expect(p).toContain('A sandbox to try the API against');
    expect(p).toContain('a transaction’s is the date it carries, the bank’s posting date or the day picked for one entered by hand');
    expect(p).toContain('one message per request (no batches)');
    expect(p).toContain(`gives at most ${MCP_MAX_PAGE_SIZE} transactions a page`);
    expect(p).toContain('at any path under /api/v1, an endpoint or not');
    expect(p).not.toContain('2025-03-26');
  });

  test('shows this copy’s own address when APP_URL is set, and a stand-in otherwise', () => {
    delete process.env.APP_URL;
    expect(page()).toContain('https://your-nya.example/api/mcp');
    process.env.APP_URL = 'https://money.example.org/';
    const p = page();
    expect(p).toContain('https://money.example.org/api/v1');
    expect(p).toContain('"url": "https://money.example.org/api/mcp"');
    expect(p).toContain('claude mcp add --transport http nya https://money.example.org/api/mcp --header "Authorization: Bearer nya_your_token"');
  });

  test('claims no compatibility with any other product, and keeps the house style, writing on or off', () => {
    for (const on of ['0', '1']) {
      process.env.API_WRITES_ENABLED = on;
      const p = page();
      expect(p).not.toMatch(/compatib|lunch ?money|monarch|ynab|plaid-compatible/i);
      expect(p).not.toMatch(/[\u2013\u2014]/);
    }
    for (const doc of [...Object.values(API_DOCS), ...Object.values(RESOURCE_DOCS)]) {
      for (const [, meaning] of doc.fields) expect(meaning).not.toMatch(/[\u2013\u2014]/);
    }
  });

  test('while this copy lets no token write, the page says nothing of writing', () => {
    delete process.env.API_WRITES_ENABLED;
    const p = page();
    expect(p).toContain('JSON over HTTPS, read only. Nothing you call can change your data.');
    expect(p).toContain('Writing anything: adding transactions, changing categories, budgets or balances.');
    expect(p).toContain('Every tool is read only, and reads what the API above reads.');
    for (const word of ['If-Match', 'Idempotency-Key', 'make changes', 'writes', 'version_mismatch', 'Write-RateLimit', 'balances or write', 'undo']) {
      expect([word, p.includes(word)]).toEqual([word, false]);
    }
    for (const spec of RESOURCE_SPECS) expect(p).not.toContain(`${spec.method} /api/v1/${spec.path}`);
    for (const tool of WRITE_TOOL_SPECS) expect([tool.name, new RegExp(`\\b${tool.name}\\b`).test(p)]).toEqual([tool.name, false]);
    expect(generateMetadata().description).toBe('Nya’s read-only API and MCP server: read your own data from your own programs.');
  });

  test('while it does, it documents writing from the code: each endpoint, field, tool and limit', () => {
    process.env.API_WRITES_ENABLED = '1';
    const p = page();
    for (const spec of RESOURCE_SPECS) {
      expect(p).toContain(`${spec.method} /api/v1/${spec.path}`);
      expect(p).toContain(spec.summary);
      for (const name of Object.keys(spec.args)) expect([spec.name, name, p.includes(name)]).toEqual([spec.name, name, true]);
      for (const [path] of RESOURCE_DOCS[spec.name].fields) expect([spec.name, path, p.includes(path)]).toEqual([spec.name, path, true]);
      expect([spec.name, !!RESOURCE_DOCS[spec.name].ifMatch]).toEqual([spec.name, !!spec.versioned]);
    }
    for (const tool of WRITE_TOOL_SPECS) {
      expect(p).toContain(tool.name);
      expect(p).toContain(tool.description);
    }
    expect(p).toContain(`Each token may make ${limits.WRITES_PER_MINUTE} writes a minute, counted whether or not they are valid, ${limits.CHANGES_PER_DAY} changes a day and ${limits.CREATES_PER_DAY} new things a day; all your tokens together 2,000 changes a day.`);
    expect(p).toContain(`Every change is recorded for ${limits.CHANGES_KEEP_DAYS} days`);
    expect(p).toContain('stops at 450 categories, 45 groups, 225 tags and 45 manual accounts');
    expect(p).toContain('a token never gains kinds of changes added to Nya after it was made');
    expect(p).toContain('A call never reaches your bank or Plaid.');
    expect(p).toContain('it records no point in your history by itself');
    expect(p).not.toContain('Writing anything: adding transactions');
    expect(p).not.toContain('Nothing you call can change your data.');
    expect(p).toContain('in 10 minutes, or, for a change, more than 30 writes a minute');
    expect(generateMetadata().description).toContain('with a token made for it change some of it');
  });
});

/** Every field path a JSON value holds: "a.b", "a[]", "a[].b". */
function paths(value: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) paths(item, `${prefix}[]`, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.add(path);
      paths(v, path, out);
    }
  }
  return out;
}

describe('the reference, held to the API’s real answers', () => {
  let token = '';
  beforeEach(async () => {
    fake.reset();
    forgetEpochs();
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CONTAINER_ID;
    await registerTestContainer(fake);
    await seedPerson(fake);
    token = (await createToken(ctx, 'Docs')).token;
  });

  const answer = async (name: string, query: string) => {
    const route = await import(`@/app/api/v1/${name}/route`);
    const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${name}?${query}`, { headers: { authorization: `Bearer ${token}` } }));
    expect([name, res.status]).toEqual([name, 200]);
    return res.json();
  };

  test('every endpoint is documented', () => {
    expect(Object.keys(API_DOCS).sort()).toEqual(OPERATION_SPECS.map((o) => o.name).sort());
    expect(Object.keys(RESOURCE_DOCS).sort()).toEqual(RESOURCE_SPECS.map((o) => o.name).sort());
  });

  // Each resource operation, run in order on the seeded data with a token
  // that can write, as its example runs: its answer and its example hold
  // described fields only (a resource as a list lists it, by that list's
  // fields; what a change stored, before and after, is Nya's own), in the
  // same shape.
  test('one resource, and writing: every field each answers with is described, and each example is in the same shape', async () => {
    process.env.API_WRITES_ENABLED = '1';
    await ensureTaxonomy(ctx);
    const writer = (await createToken(ctx, 'Writer', new Date(), null, 'write')).token;
    const send = async (spec: (typeof RESOURCE_SPECS)[number], id: string | null, body: unknown, version?: string) => {
      const parts = spec.path.split('/');
      const dir = parts.length === 1 ? parts[0] : parts.length === 2 ? `${parts[0]}/[id]` : `${parts[0]}/[id]/${parts[2]}`;
      const route: any = await import(`@/app/api/v1/${dir}/route`);
      const doc = RESOURCE_DOCS[spec.name];
      const path = spec.path.replace('{id}', id ?? '');
      const res: Response = await route[spec.method](
        new Request(`https://nya.test/api/v1/${path}${doc.query ? `?${doc.query}` : ''}`, {
          method: spec.method,
          headers: { authorization: `Bearer ${writer}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(version ? { 'if-match': `"${version}"` } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        { params: Promise.resolve({ id }) }
      );
      const out = await res.json();
      expect([spec.name, res.status]).toEqual([spec.name, spec.keyed ? 201 : 200]);
      return out;
    };
    const t = (await readTaxonomy(ctx))!;
    const ids: Record<string, string> = {};
    const versions: Record<string, string> = {};
    const kindOf = (name: string) => name.split('.')[0];
    const bodyFor = (name: string): Record<string, unknown> | null => {
      const body = RESOURCE_DOCS[name].body ? { ...RESOURCE_DOCS[name].body } : null;
      if (body && 'account_id' in body) body.account_id = ids['manual-accounts'];
      if (body && 'group_id' in body) body.group_id = t.groups[0].id;
      if (body && 'category_id' in body) body.category_id = t.categories[0].id;
      return body;
    };
    // Each kind made first, then read and changed; the record last.
    const step = (name: string) => [/\.create$/, /\.get$/, /\.(update|balance)$/, /\.delete$/, /^changes\.list$/, /^changes\.undo$/].findIndex((r) => r.test(name));
    const ordered = [...RESOURCE_SPECS].sort((a, b) => step(a.name) - step(b.name));
    expect(ordered).toHaveLength(RESOURCE_SPECS.length);
    for (const spec of ordered) {
      const kind = kindOf(spec.name);
      const id = spec.name === 'changes.undo' ? ids.change : spec.id ? ids[kind] : null;
      const real = await send(spec, id, bodyFor(spec.name), spec.versioned ? versions[kind] : undefined);
      const resource = Object.values(real).find((v) => v && typeof v === 'object' && !Array.isArray(v) && 'id' in (v as object)) as { id: string; version?: string } | undefined;
      if (resource && kind !== 'changes') {
        ids[kind] = resource.id;
        if (resource.version) versions[kind] = resource.version;
      }
      if (spec.name === 'changes.list') ids.change = real.changes.find((c: { op: string }) => c.op === 'tag.update').id;
      const doc = RESOURCE_DOCS[spec.name];
      const described = new Set(doc.fields.map(([path]) => path));
      const isDescribed = (p: string) => {
        if (described.has(p)) return true;
        if (/^(changes\[\]|change)\.(before|after)\./.test(p)) return true;
        for (const [at, endpoint, as] of doc.like ?? []) {
          if (p.startsWith(`${at}.`) && API_DOCS[endpoint].fields.some(([f]) => f === `${as}${p.slice(at.length)}`)) return true;
        }
        return false;
      };
      expect([spec.name, [...paths(real)].filter((p) => !isDescribed(p))]).toEqual([spec.name, []]);
      expect([spec.name, [...paths(doc.example)].filter((p) => !isDescribed(p))]).toEqual([spec.name, []]);
      expect([spec.name, Object.keys(doc.example as object).sort()]).toEqual([spec.name, Object.keys(real).sort()]);
    }
  });

  for (const op of OPERATION_SPECS) {
    test(`${op.name}: every field it answers with is described, and its example holds described fields in the same shape`, async () => {
      const doc = API_DOCS[op.name];
      const described = new Set(doc.fields.map(([path]) => path));
      // With hidden accounts and estimates too, so every field there can be shows.
      const extra = [op.args.include_hidden ? 'include_hidden=true' : '', op.args.include_estimated ? 'include_estimated=true' : '', op.name === 'spending' || op.name === 'cash-flow' ? 'from=2000-01-01' : '']
        .filter(Boolean)
        .join('&');
      const real = await answer(op.name, extra);
      const undocumented = [...paths(real)].filter((p) => !described.has(p));
      expect([op.name, undocumented]).toEqual([op.name, []]);
      const stray = [...paths(doc.example)].filter((p) => !described.has(p));
      expect([op.name, stray]).toEqual([op.name, []]);
      expect([op.name, Object.keys(doc.example as object).sort()]).toEqual([op.name, Object.keys(real).sort()]);
      // Nothing described that no answer could hold: each is in the example or the real answer.
      // (Rows that say no currency, `assumed` in a base, only the oldest stored history has.)
      const seen = new Set([...paths(doc.example), ...paths(real)]);
      const never = [...described].filter(
        (p) => !seen.has(p) && !p.includes('records_unreadable') && !p.startsWith('accounts[].connection.problem.') && !p.includes('left_out[]') && !p.includes('.assumed.')
      );
      expect([op.name, never]).toEqual([op.name, []]);
      // The example request is one the endpoint takes.
      const route = await import(`@/app/api/v1/${op.name}/route`);
      const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${op.name}?${doc.query}`, { headers: { authorization: `Bearer ${token}` } }));
      expect([op.name, doc.query, res.status]).toEqual([op.name, doc.query, 200]);
    });
  }
});
