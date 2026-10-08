// The real Plaid SDK and its real axios, against a local server standing in for
// Plaid, so the errors under test are exactly the ones production throws.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Configuration, PlaidApi } from 'plaid';
import { makePlaidClient } from '@/lib/plaid-scrub';
import { loggable } from '@/lib/log-safe';

const SECRET = 'plaid-secret-value-0123456789';
const TOKEN = 'access-production-11111111-2222-3333-4444-555555555555';

/** Every string reachable from a value, own properties of errors included, so
 *  no printer's depth limit can hide a secret from the check. */
function everything(v: unknown, seen = new Set<unknown>()): string {
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
        return ''; // a getter on a socket or stream that throws holds no text
      }
      return `${k}=${everything(value, seen)}`;
    })
    .join(' ');
}

let server: ReturnType<typeof Bun.serve>;
const configuration = () =>
  new Configuration({
    basePath: `http://127.0.0.1:${server.port}`,
    baseOptions: { headers: { 'PLAID-CLIENT-ID': 'client-id', 'PLAID-SECRET': SECRET }, timeout: 300 },
  });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/accounts/get') {
        return Response.json(
          {
            error_type: 'ITEM_ERROR',
            error_code: 'ITEM_LOGIN_REQUIRED',
            error_code_reason: 'OAUTH_CONSENT_EXPIRED',
            error_message: 'the login details of this item have changed',
            display_message: null,
            request_id: 'req-123',
          },
          { status: 400 }
        );
      }
      if (path === '/item/remove') return Response.json({ request_id: 'req-ok' });
      await Bun.sleep(2000); // never answers in time
      return new Response('late');
    },
  });
});
afterAll(() => server.stop(true));

describe('the Plaid client throws errors without the request', () => {
  test('the danger is real: the unscrubbed SDK error holds the secret and the token', async () => {
    const raw = await new PlaidApi(configuration()).accountsGet({ access_token: TOKEN }).catch((e: unknown) => e);
    expect(everything(raw)).toContain(SECRET);
    expect(everything(raw)).toContain(TOKEN);
  });

  test("an error answer keeps Plaid's answer and the call, and loses the request", async () => {
    const err: any = await makePlaidClient(configuration())
      .accountsGet({ access_token: TOKEN })
      .catch((e: unknown) => e);
    const text = everything(err);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
    // Callers still read these.
    expect(err.isAxiosError).toBe(true);
    expect(err.response.status).toBe(400);
    expect(err.response.data.error_code).toBe('ITEM_LOGIN_REQUIRED');
    expect(err.config.url).toEndWith('/accounts/get');
    expect(err.config.method).toBe('post');
    expect(err.request).toBeUndefined();
    expect(err.response.request).toBeUndefined();
    // And JSON (what a structured logger would write) is clean too.
    expect(JSON.stringify(err.toJSON())).not.toContain(SECRET);
  });

  test('a timeout, which has no answer, loses the request too', async () => {
    const err: any = await makePlaidClient(configuration())
      .transactionsSync({ access_token: TOKEN })
      .catch((e: unknown) => e);
    expect(err.code).toBe('ECONNABORTED');
    expect(err.response).toBeUndefined();
    const text = everything(err);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
  });

  test('a successful call is untouched', async () => {
    const res = await makePlaidClient(configuration()).itemRemove({ access_token: TOKEN });
    expect(res.data.request_id).toBe('req-ok');
  });

  test('loggable names the call and keeps the reason', async () => {
    const err = await makePlaidClient(configuration()).accountsGet({ access_token: TOKEN }).catch((e: unknown) => e);
    const out = loggable(err) as Record<string, any>;
    expect(out.endpoint).toBe('POST /accounts/get');
    expect(out.status).toBe(400);
    expect(out.plaid.error_code_reason).toBe('OAUTH_CONSENT_EXPIRED');
    expect(typeof out.stack).toBe('string');
    // Even for an error that did not go through the scrubbing client.
    const raw = await new PlaidApi(configuration()).accountsGet({ access_token: TOKEN }).catch((e: unknown) => e);
    expect(everything(loggable(raw))).not.toContain(SECRET);
    expect(everything(loggable(raw))).not.toContain(TOKEN);
  });
});

describe('every Plaid client goes through the scrubber', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? (name === 'node_modules' ? [] : walk(p)) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });

  test('no code outside lib/plaid-scrub.ts constructs a PlaidApi', () => {
    const offenders = ['lib', 'app', 'components', 'scripts']
      .flatMap(walk)
      .filter((f) => !f.endsWith(join('lib', 'plaid-scrub.ts')))
      .filter((f) => /new\s+PlaidApi\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('lib/plaid.ts builds its client with makePlaidClient', () => {
    expect(readFileSync('lib/plaid.ts', 'utf8')).toMatch(/export const plaidClient = makePlaidClient\(/);
  });
});
