import { afterEach, describe, expect, test } from 'bun:test';
import { Redis } from '@upstash/redis';
import { requestLimit } from '@/lib/redis-limit';

// The time limit every Redis request has (lib/redis-limit.ts, lib/storage.ts): a request Upstash
// never answers must fail, and fail as an error, never come back as a value.
// The client used here is the real @upstash/redis, given the limit the way
// lib/storage.ts gives it; only fetch is stood in for, by one that never
// answers until it is aborted.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch that never answers, as a stalled connection doesn't. */
function stalled() {
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
}

const client = (signal: AbortSignal | (() => AbortSignal)) =>
  new Redis({ url: 'https://redis.test', token: 'token', signal, enableAutoPipelining: false, retry: false });

describe('a Redis request that never answers', () => {
  test('fails once its limit is up, as the limit is given', async () => {
    stalled();
    const started = Date.now();
    await expect(client(requestLimit(50)).get('k')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('the trap the function form avoids: handed a signal itself, the client answers as if the key held its reason', async () => {
    stalled();
    expect(await client(AbortSignal.timeout(50)).get('k')).not.toBeInstanceOf(Error);
  });

  test('each request gets a limit of its own', async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      calls++;
      signals.push(init!.signal!);
      return Promise.resolve(new Response(JSON.stringify({ result: 'v' })));
    }) as unknown as typeof fetch;
    const r = client(requestLimit(50));
    await r.get('a');
    await r.get('b');
    expect(calls).toBe(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});
