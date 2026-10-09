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
const { API_DOCS } = await import('@/lib/api-examples');
const { OPERATION_SPECS, TOOL_SPECS, PROTOCOL_VERSIONS } = await import('@/lib/api-spec');
const { REQUESTS_PER_MINUTE, MAX_TOKENS, MAX_PAGE_SIZE } = await import('@/lib/api-limits');
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

  test('shows this copy’s own address when APP_URL is set, and a stand-in otherwise', () => {
    delete process.env.APP_URL;
    expect(page()).toContain('https://your-nya.example/api/mcp');
    process.env.APP_URL = 'https://money.example.org/';
    const p = page();
    expect(p).toContain('https://money.example.org/api/v1');
    expect(p).toContain('"url": "https://money.example.org/api/mcp"');
    expect(p).toContain('claude mcp add --transport http nya https://money.example.org/api/mcp --header "Authorization: Bearer nya_your_token"');
  });

  test('claims no compatibility with any other product, and keeps the house style', () => {
    const p = page();
    expect(p).not.toMatch(/compatib|lunch ?money|monarch|ynab|plaid-compatible/i);
    expect(p).not.toMatch(/[\u2013\u2014]/);
    for (const doc of Object.values(API_DOCS)) {
      for (const [, meaning] of doc.fields) expect(meaning).not.toMatch(/[\u2013\u2014]/);
    }
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
  });

  for (const op of OPERATION_SPECS) {
    test(`${op.name}: every field it answers with is described, and its example holds described fields in the same shape`, async () => {
      const doc = API_DOCS[op.name];
      const described = new Set(doc.fields.map(([path]) => path));
      // With hidden accounts and estimates too, so every field there can be shows.
      const extra = [op.args.include_hidden ? 'include_hidden=true' : '', op.args.include_estimated ? 'include_estimated=true' : '', op.name === 'spending' ? 'from=2000-01-01' : '']
        .filter(Boolean)
        .join('&');
      const real = await answer(op.name, extra);
      const undocumented = [...paths(real)].filter((p) => !described.has(p));
      expect([op.name, undocumented]).toEqual([op.name, []]);
      const stray = [...paths(doc.example)].filter((p) => !described.has(p));
      expect([op.name, stray]).toEqual([op.name, []]);
      expect([op.name, Object.keys(doc.example as object).sort()]).toEqual([op.name, Object.keys(real).sort()]);
      // Nothing described that no answer could hold: each is in the example or the real answer.
      const seen = new Set([...paths(doc.example), ...paths(real)]);
      const never = [...described].filter((p) => !seen.has(p) && !p.includes('records_unreadable') && !p.startsWith('accounts[].connection.problem.') && !p.includes('left_out[]'));
      expect([op.name, never]).toEqual([op.name, []]);
      // The example request is one the endpoint takes.
      const route = await import(`@/app/api/v1/${op.name}/route`);
      const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${op.name}?${doc.query}`, { headers: { authorization: `Bearer ${token}` } }));
      expect([op.name, doc.query, res.status]).toEqual([op.name, doc.query, 200]);
    });
  }
});
