import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { watchSignOut } from '@/components/sign-out-watch';

const g = globalThis as any;
beforeEach(() => {
  g.window = { location: { href: 'https://nya.test/', origin: 'https://nya.test' } };
});
afterEach(() => {
  delete g.window;
  delete g.Clerk;
});

// A server that answers from a queue of statuses, recording each call.
const server = (...statuses: number[]) => {
  const calls: string[] = [];
  const call = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(null, { status: statuses.shift() ?? 200 });
  };
  return { call, calls };
};

describe('noticing a session has ended', () => {
  test('password mode: a 401 from the API signs out at once, whatever Clerk says', async () => {
    g.Clerk = { session: { getToken: async () => 'token' } };
    const { call, calls } = server(401, 200);
    let out = 0;
    const res = await watchSignOut(call, { clerk: false, onSignedOut: () => out++ })('/api/net-worth');
    expect(res.status).toBe(401);
    expect(out).toBe(1);
    expect(calls.length).toBe(1);
  });

  test('other 401s are not a sign-out: the login call, other sites', async () => {
    const { call } = server(401, 401);
    let out = 0;
    const watched = watchSignOut(call, { clerk: false, onSignedOut: () => out++ });
    await watched('/api/login');
    await watched('https://elsewhere.test/api/x');
    expect(out).toBe(0);
  });

  test('Clerk: an expired cookie is renewed and the call tried once more', async () => {
    let renewed = 0;
    g.Clerk = { session: { getToken: async () => (renewed++, 'token') } };
    const { call, calls } = server(401, 200);
    let out = 0;
    const res = await watchSignOut(call, { clerk: true, onSignedOut: () => out++ })('/api/net-worth');
    expect(res.status).toBe(200);
    expect(renewed).toBe(1);
    expect(calls.length).toBe(2);
    expect(out).toBe(0);
  });

  test('Clerk: still 401 after renewing, or no session to renew, is a sign-out', async () => {
    g.Clerk = { session: { getToken: async () => 'token' } };
    let out = 0;
    await watchSignOut(server(401, 401).call, { clerk: true, onSignedOut: () => out++ })('/api/net-worth');
    expect(out).toBe(1);
    g.Clerk = { session: null };
    await watchSignOut(server(401).call, { clerk: true, onSignedOut: () => out++ })('/api/net-worth');
    expect(out).toBe(2);
    g.Clerk = { session: { getToken: async () => { throw new Error('offline'); } } };
    await watchSignOut(server(401).call, { clerk: true, onSignedOut: () => out++ })('/api/net-worth');
    expect(out).toBe(3);
  });

  test('a Request body is never sent twice', async () => {
    g.Clerk = { session: { getToken: async () => 'token' } };
    const { call, calls } = server(401, 200);
    let out = 0;
    await watchSignOut(call, { clerk: true, onSignedOut: () => out++ })(new Request('https://nya.test/api/budgets', { method: 'POST', body: '{}' }));
    expect(calls.length).toBe(1);
    expect(out).toBe(1);
  });
});
