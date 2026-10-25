import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { retryStalled, MAX_ATTEMPTS } from '@/lib/blob-attempts';

// A Vercel Blob call that stalls, sent again on a new request
// (lib/blob-attempts.ts): what kept the backup's last steps and the receipts
// sweep's listings failing on one connection that went quiet.

const warnings: string[] = [];
const warn = console.warn;
beforeEach(() => {
  warnings.length = 0;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
});
afterEach(() => {
  console.warn = warn;
});

/** A call that never answers until its signal aborts, then rejects as the
 *  SDK does. */
const stall = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('The request was aborted.'))));

describe('a Blob call that stalls', () => {
  test('is sent again on a new request, and the first is aborted with no reason', async () => {
    const seen: AbortSignal[] = [];
    const result = await retryStalled('a listing', new AbortController().signal, (signal) => {
      seen.push(signal);
      return seen.length === 1 ? stall(signal) : Promise.resolve('listed');
    }, 20);
    expect(result).toBe('listed');
    expect(seen).toHaveLength(2);
    expect(seen[0].aborted).toBe(true);
    // The default reason: Vercel Blob stops only on an AbortError.
    expect((seen[0].reason as Error).name).toBe('AbortError');
    expect(seen[1].aborted).toBe(false);
    expect(warnings).toEqual(["Vercel Blob didn't finish a listing within 0.02s; sent again on a new request"]);
  });

  test('a call that fails is not sent again here (the SDK retries its own failures)', async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('Access denied'));
    };
    await expect(retryStalled('a delete', new AbortController().signal, failing, 20)).rejects.toThrow('Access denied');
    expect(calls).toBe(1);
  });

  test('once the caller’s signal aborts, the call is aborted and nothing is sent again', async () => {
    const outer = new AbortController();
    const seen: AbortSignal[] = [];
    await expect(
      retryStalled('a listing', outer.signal, (signal) => {
        seen.push(signal);
        // The caller gives up while the second attempt waits.
        if (seen.length === 2) queueMicrotask(() => outer.abort());
        return stall(signal);
      }, 20)
    ).rejects.toThrow('The request was aborted.');
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.aborted)).toBe(true);
  });

  test('a caller that gives up after a stall stops it there', async () => {
    const outer = new AbortController();
    const seen: AbortSignal[] = [];
    await expect(
      retryStalled('a listing', outer.signal, (signal) => {
        seen.push(signal);
        // The first attempt runs out, and the caller's own limit with it.
        signal.addEventListener('abort', () => outer.abort());
        return stall(signal);
      }, 20)
    ).rejects.toThrow("Vercel Blob didn't finish a listing within 0.02s");
    expect(seen).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test('a caller already given up sends nothing', async () => {
    const outer = new AbortController();
    outer.abort();
    let calls = 0;
    await expect(retryStalled('a delete', outer.signal, async () => void calls++)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test('each attempt has twice the time of the one before, and they stop at the most allowed', async () => {
    let calls = 0;
    const started = Date.now();
    await expect(
      retryStalled('a listing', undefined, (signal) => {
        calls++;
        return stall(signal);
      }, 10)
    ).rejects.toThrow("Vercel Blob didn't finish a listing within 0.04s");
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10 + 20 + 40 - 5);
  });

  test('a call that ignores its signal is still left behind when its time is up', async () => {
    let calls = 0;
    const result = await retryStalled('a lookup', undefined, () => (++calls === 1 ? new Promise<never>(() => {}) : Promise.resolve('found')), 20);
    expect(result).toBe('found');
  });
});
