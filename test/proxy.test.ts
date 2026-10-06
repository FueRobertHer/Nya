import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';

const { config, proxy } = await import('@/proxy');

// The matcher selects the paths the session gate runs on. The self-
// authenticating routes must be excluded exactly, and nothing else with them.
const gated = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

describe('the session gate', () => {
  test('skips exactly the routes that authenticate themselves', () => {
    for (const path of ['/api/snapshot', '/api/snapshot/catchup', '/api/backup', '/api/ingest/balance', '/api/plaid/webhook', '/api/plaid/check-items', '/api/ops/export', '/api/ops/rotate-master', '/api/login']) {
      expect(gated(path)).toBe(false);
    }
  });

  test('still covers anything that merely starts with one of them', () => {
    for (const path of ['/api/ops/rotate-master2', '/api/snapshot-runs', '/api/snapshot/other', '/api/snapshot/catchup/x', '/api/backup/x', '/api/backups', '/api/admin/unused', '/api/plaid/webhook/x', '/api/plaid/check-items2', '/api/plaid/other', '/api/ops/exports', '/api/ops/rotate-master/x', '/api/ops/other']) {
      expect(gated(path)).toBe(true);
    }
  });

  test('covers ordinary routes and pages', () => {
    for (const path of ['/api/budgets', '/api/net-worth', '/', '/settings']) expect(gated(path)).toBe(true);
  });

  // They are let through inside (below), but still pass through the proxy:
  // that is what gives a page its Content-Security-Policy.
  test('covers the public pages too', () => {
    for (const path of ['/login', '/security', '/privacy']) expect(gated(path)).toBe(true);
  });
});

// The shared password (no Clerk keys): what a request without a session gets.
describe('without a session', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CSP_MODE;
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  const call = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => proxy(new NextRequest(`https://nya.test${path}`, init));

  test('the login, security and privacy pages open, with their policy', async () => {
    for (const path of ['/login', '/security', '/privacy']) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-security-policy-report-only')).toContain("'strict-dynamic'");
    }
  });

  test('only those exact paths', async () => {
    for (const path of ['/security/x', '/privacy2', '/securityx', '/login/x', '/']) {
      expect((await call(path)).headers.get('location')).toBe('https://nya.test/login');
    }
    expect((await call('/api/security')).status).toBe(401);
  });

  test('the policy carries a nonce made here, passed on to the page', async () => {
    // A nonce the request brings is never used.
    const res = await call('/security', { headers: { 'x-nonce': 'chosen', 'content-security-policy': "script-src 'nonce-chosen'" } });
    const policy = res.headers.get('content-security-policy-report-only')!;
    const nonce = /'nonce-([^']+)'/.exec(policy)![1];
    expect(nonce).not.toBe('chosen');
    // What the page renders with: NextResponse.next({ request: { headers } }).
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(res.headers.get('x-middleware-request-content-security-policy-report-only')).toBe(policy);
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBeNull();
    // A new one every time.
    const again = (await call('/security')).headers.get('content-security-policy-report-only')!;
    expect(again).not.toBe(policy);
  });

  test('CSP_MODE=enforce sends it as Content-Security-Policy, off sends none', async () => {
    process.env.CSP_MODE = 'enforce';
    let res = await call('/privacy');
    expect(res.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(res.headers.get('content-security-policy'));

    process.env.CSP_MODE = 'off';
    res = await call('/privacy', { headers: { 'x-nonce': 'chosen' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    // Even off, a request cannot hand the page a nonce of its own.
    expect(res.headers.get('x-middleware-request-x-nonce')).toBeNull();
  });
});
