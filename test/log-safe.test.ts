import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loggable } from '@/lib/log-safe';

const SECRET = 'plaid-secret-value-0123456789';
const TOKEN = 'access-sandbox-11111111-2222-3333-4444-555555555555';

/**
 * An error shaped the way the Plaid SDK's axios throws one: the request config
 * rides along. Built by hand rather than with axios itself, whose node build
 * collides with other test files' module mocks when the whole suite runs in
 * one process.
 */
function plaidError(response?: { status: number; data: unknown }): Error {
  const err = new Error(response ? 'Request failed with status code 400' : 'timeout of 45000ms exceeded') as any;
  err.name = 'AxiosError';
  err.isAxiosError = true;
  err.code = response ? 'ERR_BAD_REQUEST' : 'ECONNABORTED';
  err.config = {
    headers: { 'PLAID-CLIENT-ID': 'client-id', 'PLAID-SECRET': SECRET },
    data: JSON.stringify({ access_token: TOKEN }),
    url: 'https://production.plaid.com/accounts/get',
    method: 'post',
  };
  err.request = {};
  if (response) err.response = { status: response.status, data: response.data, headers: {}, statusText: '' };
  return err;
}

/**
 * Every string reachable from a value, own properties included (an Error's
 * too), joined. A printer's depth limit would hide nested headers in either
 * direction, so the checks look at everything a log line could contain.
 */
function printed(v: unknown, seen = new Set<unknown>()): string {
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object' && seen.has(v)) return '';
  if (v === null || typeof v !== 'object') return String(v);
  seen.add(v);
  return Object.getOwnPropertyNames(v)
    .map((k) => {
      let value: unknown;
      try {
        value = (v as Record<string, unknown>)[k];
      } catch {
        return '';
      }
      return `${k}=${printed(value, seen)}`;
    })
    .join(' ');
}

describe('loggable', () => {
  test('a Plaid call that got no answer logs neither the secret nor the access token', () => {
    const err = plaidError();
    // The danger this exists for: the raw error prints the request.
    expect(printed(err)).toContain(SECRET);
    expect(printed(err)).toContain(TOKEN);
    const safe = printed(loggable(err));
    expect(safe).not.toContain(SECRET);
    expect(safe).not.toContain(TOKEN);
    expect(loggable(err)).toMatchObject({
      name: 'AxiosError',
      message: 'timeout of 45000ms exceeded',
      code: 'ECONNABORTED',
      // Which call timed out: without it a timeout says only how long it waited.
      endpoint: 'POST /accounts/get',
    });
  });

  test("a Plaid error answer keeps Plaid's diagnosis and drops the request", () => {
    const err = plaidError({
      status: 400,
      data: {
        error_type: 'ITEM_ERROR',
        error_code: 'ITEM_LOGIN_REQUIRED',
        error_message: 'the login details of this item have changed',
        display_message: null,
        request_id: 'req-123',
        // Not on the list, so never logged even if Plaid ever echoed something.
        echoed: TOKEN,
      },
    });
    const out = loggable(err) as Record<string, unknown>;
    expect(out.status).toBe(400);
    expect(out.plaid).toEqual({
      error_type: 'ITEM_ERROR',
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_message: 'the login details of this item have changed',
      display_message: null,
      request_id: 'req-123',
    });
    expect(printed(out)).not.toContain(SECRET);
    expect(printed(out)).not.toContain(TOKEN);
  });

  test('an error wrapping a Plaid failure is rebuilt without the request', () => {
    const wrapped = new Error('Could not refresh', { cause: new Error('middle', { cause: plaidError() }) });
    const safe = printed(loggable(wrapped));
    expect(safe).not.toContain(SECRET);
    expect(safe).not.toContain(TOKEN);
    expect(safe).toContain('Could not refresh');
    expect(safe).toContain('timeout of 45000ms exceeded');
  });

  test('an ordinary error is returned as it is, stack and all', () => {
    const plain = new Error('Manual account x could not be read', { cause: new SyntaxError('bad json') });
    expect(loggable(plain)).toBe(plain);
    const bare = new TypeError('nope');
    expect(loggable(bare)).toBe(bare);
    expect(loggable('a string')).toBe('a string');
    expect(loggable(undefined)).toBeUndefined();
  });

  test('a plain object that carries a request config is treated like a Plaid error', () => {
    const out = loggable({ message: 'x', config: { headers: { 'PLAID-SECRET': SECRET } }, request: {} });
    expect(printed(out)).not.toContain(SECRET);
  });

  test('a cause chain that loops ends', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as any).cause = b;
    // Returns (nothing in the loop is a Plaid error, so it is unchanged).
    expect(loggable(a)).toBe(a);
  });
});

describe('no log prints a raw Plaid error', () => {
  // The old habit: when Plaid gives no response, `err.response.data` is
  // undefined and the whole error, request config included, is printed.
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });

  test('nothing logs `err?.response?.data || err`', () => {
    // Code only: lib/log-safe.ts quotes the old pattern in its header comment.
    const code = (f: string) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join('\n');
    const offenders = ['lib', 'app'].flatMap(walk).filter((f) => /console\.\w+\([^)]*response\?\.data\s*\|\|/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});
