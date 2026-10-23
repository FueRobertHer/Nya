import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';

const { config, proxy } = await import('@/proxy');

// The matcher selects the paths the session gate runs on. The self-
// authenticating routes must be excluded exactly, and nothing else with them.
const gated = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

describe('the session gate', () => {
  test('skips exactly the routes that authenticate themselves', () => {
    for (const path of ['/api/snapshot', '/api/snapshot/catchup', '/api/backup', '/api/ingest/balance', '/api/v1/accounts', '/api/v1/transactions', '/api/plaid/webhook', '/api/plaid/check-items', '/api/ops/export', '/api/ops/rotate-master', '/api/ops/container-keys', '/api/login', '/api/weekly-summary/unsubscribe']) {
      expect(gated(path)).toBe(false);
    }
  });

  test('still covers anything that merely starts with one of them', () => {
    for (const path of ['/api/v1', '/api/v1/accounts/x', '/api/v1/other', '/api/ops/rotate-master2', '/api/snapshot-runs', '/api/snapshot/other', '/api/snapshot/catchup/x', '/api/backup/x', '/api/backups', '/api/admin/unused', '/api/plaid/webhook/x', '/api/plaid/check-items2', '/api/plaid/other', '/api/ops/exports', '/api/ops/rotate-master/x', '/api/ops/container-keys/x', '/api/ops/container-key', '/api/ops/other', '/api/weekly-summary', '/api/weekly-summary/send', '/api/weekly-summary/unsubscribe/x', '/api/weekly-summary/unsubscribes']) {
      expect(gated(path)).toBe(true);
    }
  });

  test('covers ordinary routes and pages', () => {
    for (const path of ['/api/budgets', '/api/net-worth', '/', '/settings']) expect(gated(path)).toBe(true);
  });

  // They are let through inside (below), but still pass through the proxy:
  // that is what gives a page its Content-Security-Policy.
  test('covers the public pages too', () => {
    for (const path of ['/login', '/security', '/privacy', '/developers', '/open-download', '/unsubscribe']) expect(gated(path)).toBe(true);
  });
});

// Compiled by Next itself, as it compiles the matcher for a deployment: the
// same paths are exempt from the proxy, and no other spelling of them is.
// In a process of its own: loading Next's build code here would leave its
// request storage unusable for the test files that run after this one.
describe('the matcher, as Next compiles it', () => {
  const script =
    "const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info.js');" +
    'process.stdout.write(getMiddlewareMatchers([process.env.MATCHER], {})[0].regexp);';
  const compiled = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, MATCHER: config.matcher[0] },
  });
  const regexp = compiled.stdout.toString();
  const runs = (path: string) => new RegExp(regexp).test(path);

  test('compiles', () => {
    expect([compiled.exitCode, regexp.length > 0]).toEqual([0, true]);
  });

  test('exempts each API endpoint and the MCP server at exactly their paths', async () => {
    const { OPERATION_SPECS } = await import('@/lib/api-spec');
    for (const op of OPERATION_SPECS) expect([op.name, runs(`/api/v1/${op.name}`)]).toEqual([op.name, false]);
    expect(runs('/api/mcp')).toBe(false);
  });

  // The paths of one resource, and of writes (lib/api-spec.ts RESOURCE_SPECS),
  // with an id of each form the app makes: they authenticate themselves too.
  test('exempts each resource path, with any id the app makes, and no other spelling of one', async () => {
    const { RESOURCE_SPECS } = await import('@/lib/api-spec');
    const ids = ['manual_4efc3d8d-060e-4051-b18e-e75d9c94efde', 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', 'manual-txn%3A5a0c1d2e', 't_coffee', 'cat_0a1b2c', '20261020.0123456789abcdef.0123456789ab'];
    for (const spec of RESOURCE_SPECS) {
      for (const id of spec.path.includes('{id}') ? ids : ['']) {
        const path = `/api/v1/${spec.path.replace('{id}', id)}`;
        expect([path, runs(path)]).toEqual([path, false]);
      }
    }
    for (const path of [
      '/api/v1/transactions/',
      '/api/v1/transactions/..',
      '/api/v1/transactions/.x',
      '/api/v1/transactions/a%2Fb',
      '/api/v1/transactions/a/b',
      '/api/v1/manual-accounts/',
      '/api/v1/manual-accounts/x/',
      '/api/v1/manual-accounts/x/balance/',
      '/api/v1/manual-accounts/x/other',
      '/api/v1/changes/x',
      '/api/v1/changes/x/undo/',
      '/api/v1/tags/x/y',
      '/api/v1/category-groups/x.rsc/y',
      '/API/V1/TAGS/x',
    ]) {
      expect([path, runs(path)]).toEqual([path, true]);
    }
  });

  // The weekly summary's link (lib/weekly-summary/unsubscribe.ts): its token is
  // its authentication, and it can only ever turn that summary off.
  test('exempts the link that turns a weekly summary off at exactly its path', () => {
    expect(runs('/api/weekly-summary/unsubscribe')).toBe(false);
    for (const path of ['/api/weekly-summary/unsubscribe/', '/api/weekly-summary/unsubscribe.json', '/api/weekly-summary/unsubscribe/x', '/api/weekly-summary', '/api/weekly-summary/send', '/API/WEEKLY-SUMMARY/UNSUBSCRIBE']) {
      expect([path, runs(path)]).toEqual([path, true]);
    }
  });

  test('runs for every other spelling of them', () => {
    for (const path of [
      '/api/v1/me/',
      '/api/v1/me.json',
      '/api/v1/me.rsc',
      '/API/V1/ME',
      '/api/v1/accounts/',
      '/api/v1//accounts',
      '/api/v1/accounts%2F',
      '/api/v1/../connections',
      '/api/v1/accounts/..',
      '/api/mcp/',
      '/api/mcp.rsc',
      '/_next/data/build/api/v1/me.json',
      '/api/v1/me;x',
      '/api/v1',
      '/api/connections',
    ]) {
      expect([path, runs(path)]).toEqual([path, true]);
    }
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

  test('the login, security, privacy, developer, protected-download and unsubscribe pages open, with their policy', async () => {
    for (const path of ['/login', '/security', '/privacy', '/developers', '/open-download', '/unsubscribe']) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-security-policy-report-only')).toContain("'strict-dynamic'");
    }
  });

  test('a path under /api/v1 that is no endpoint is a 404 in the API’s own error shape, session or not', async () => {
    for (const path of ['/api/v1/acounts', '/api/v1/accounts/', '/api/v1', '/api/v1/', '/api/v1/accounts/x']) {
      const res = await call(path, { headers: { authorization: 'Bearer nya_whatever' } });
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'There is no such endpoint. The endpoints are listed at /developers.' } });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    // Anything else under /api is gated as before.
    expect((await call('/api/v1x')).status).toBe(401);
  });

  // Receipts and documents (#47) are the signed-in person's alone: an API
  // token is never a way in (review S15), and only their clean-up cron,
  // which checks the cron secret itself, is outside the gate.
  test('a receipt’s routes take no API token: a Bearer token alone is a 401', async () => {
    const id = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d';
    for (const path of ['/api/attachments', `/api/attachments?ids=t_1`, `/api/attachments/${id}`, `/api/attachments/${id}/file`, `/api/attachments/${id}/thumb`, `/api/attachments/${id}/parts/0`, '/api/attachments/download']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await call(path, { method, headers: { authorization: 'Bearer nya_whatever' } });
        expect([path, method, res.status]).toEqual([path, method, 401]);
      }
    }
    expect(gated('/api/attachments/sweep')).toBe(false);
    for (const path of ['/api/attachments', '/api/attachments/sweep/x', '/api/attachments/sweeps', `/api/attachments/${id}/file`]) expect([path, gated(path)]).toEqual([path, true]);
  });

  test('only those exact paths', async () => {
    for (const path of ['/security/x', '/privacy2', '/securityx', '/login/x', '/developers/x', '/developer', '/open-download/x', '/open', '/unsubscribe/x', '/unsubscribes', '/']) {
      expect((await call(path)).headers.get('location')).toBe('https://nya.test/login');
    }
    expect((await call('/api/security')).status).toBe(401);
  });

  // Review should-fix 1: a notice email's link (lib/connection-notices.ts),
  // opened while logged out, still ends on the Connection health card.
  test('the link from a notice email comes back to the Connection health card once logged in; nothing else is passed', async () => {
    expect((await call('/?view=connections')).headers.get('location')).toBe('https://nya.test/login?view=connections');
    expect((await call('/?view=connections&utm_source=email')).headers.get('location')).toBe('https://nya.test/login?view=connections');
    for (const path of ['/?view=other', '/?next=https://evil.example', '/settings?view=connections', '//evil.example/?view=connections']) {
      expect([path, (await call(path)).headers.get('location')]).toEqual([path, 'https://nya.test/login']);
    }
    // The login page reads only that flag, and goes to the card or Home.
    const page = readFileSync(new URL('../app/login/page.tsx', import.meta.url), 'utf8');
    expect(page).toContain("get('view') === 'connections' ? CONNECTIONS_PATH : '/'");
    expect(page).toContain('router.push(afterLogin());');
    expect(page).not.toMatch(/router\.push\((?!afterLogin\(\))/);
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
    // Report-only leaves frame-ancestors out: browsers ignore it there.
    expect((await call('/privacy')).headers.get('content-security-policy-report-only')).not.toContain('frame-ancestors');

    process.env.CSP_MODE = 'enforce';
    let res = await call('/privacy');
    expect(res.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
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
