// test/restore-run.ts
//
// Bringing a download back as the page does it, for the restore's tests
// (test/user-restore-*.test.ts): the routes reached as the page's fetch
// reaches them, a download of a container, the file read, planned, checked,
// started, sent and finished, and the bank connected again with new ids.
// Imports the routes, so a test file imports it dynamically, after mocking
// lib/storage.

import { expect } from 'bun:test';
import { ctxKey, TEST_CTX, type FakeRedis } from './fake-redis';
import { resetEachTest } from './shared-reset';
import { bankTxn } from './restore-fixture';
import type { Ctx } from '@/lib/containers';
import { collectUserData, buildUserExport, exportFile, fileChunks } from '@/lib/user-export';
import { collect, previewOf } from '@/lib/user-restore/file';
import { makePlan, startBody, startRestore, sendBatches, finishRestore, type Fetcher } from '@/lib/user-restore/send';
import { newUserRestoreId } from '@/lib/user-restore/ids';
import { totalsHold } from '@/lib/user-restore/restored';
import { encrypt } from '@/lib/crypto';
import { encodeJsonBlob } from '@/lib/blob';
import { saveItem } from '@/lib/storage';
import { liveAccountIds } from '@/lib/links';
import { assembleBankRows, finishActivity } from '@/lib/activity';
import * as restoreRoute from '@/app/api/user-restore/route';
import * as batchRoute from '@/app/api/user-restore/batch/route';
import * as forgetRoute from '@/app/api/user-restore/forget/route';

export const EXPORTED = new Date('2026-10-06T12:00:00.000Z');

/** Batches sent through the fetch, and after how many it fails as a dropped
 *  connection does. Set back before each test of every file that loads this
 *  (test/preload.ts), so a test that makes the batches fail can't fail
 *  another file's restore. */
export const sent = { batches: 0, failAfter: Infinity };
resetEachTest(() => {
  sent.batches = 0;
  sent.failAfter = Infinity;
});

/** The routes, as the page's fetch reaches them. */
export const fetcher: Fetcher = async (input, init) => {
  const url = new URL(input, 'http://localhost');
  const req = new Request(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'x-forwarded-for': '203.0.113.9' } });
  if (url.pathname === '/api/user-restore') return (restoreRoute as unknown as Record<string, (r: Request) => Promise<Response>>)[init?.method ?? 'GET'](req);
  if (url.pathname === '/api/user-restore/batch') {
    if (url.searchParams.has('index')) {
      if (sent.batches >= sent.failAfter) throw new TypeError('Failed to fetch');
      sent.batches++;
    }
    return batchRoute.POST(req);
  }
  if (url.pathname === '/api/user-restore/forget') return forgetRoute.POST(req);
  throw new Error(`no route ${url.pathname}`);
};

export const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetcher(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
};

/** The container's download, as JSON text. */
export async function downloadText(at: Date, ctx: Ctx = TEST_CTX): Promise<string> {
  const doc = buildUserExport(await collectUserData({ ctx, userId: 'user_me' }), at);
  return new TextDecoder().decode(Buffer.concat([...fileChunks(exportFile(doc, 'json'))]));
}

/** A file as the page reads it, `piece` bytes at a time. */
export const sourceOf = (text: string, piece = 4096) => {
  const bytes = new TextEncoder().encode(text);
  return {
    size: bytes.length,
    protected: false,
    async *bytes() {
      for (let i = 0; i < bytes.length; i += piece) yield bytes.slice(i, i + piece);
    },
  };
};
export type Source = ReturnType<typeof sourceOf>;

/** Read, planned and checked, as the page does before the start. */
export async function planned(text: string | Source) {
  const source = typeof text === 'string' ? sourceOf(text) : text;
  const c = await collect(source);
  const p = previewOf(c);
  expect(p.refuse).toBeNull();
  const plan = await makePlan(source, c, { fetcher });
  return { source, c, p, plan };
}

/** The whole restore, as the page does it: the finished record. */
export async function restoreAll(text: string | Source) {
  const { source, c, p, plan } = await planned(text);
  const record = await startRestore(fetcher, startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
  await sendBatches(source, c, record, { fetcher, plan });
  return finishRestore(fetcher, record.id);
}

/** Activity as /api/transactions builds it, from what is stored. */
export async function activity(ctx: Ctx = TEST_CTX) {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, withAccountIds: true });
  return finishActivity(ctx, bank.payload, bank.hidden);
}
export const rowsOf = (a: { transactions: any[] }) => a.transactions.map((t) => [t.transaction_id, t.date, t.amount, t.category, t.note ?? null, t.tags ?? null]);

/** Whether totals are held, as recordFetch asks. */
export const hold = (ctx: Ctx = TEST_CTX) => totalsHold(ctx, () => liveAccountIds(ctx, { strict: true, readOnly: true }));

/** The bank connected again (test/restore-fixture.ts's Chase): a new Item,
 *  new ids, the same rows (the coffee, the gas, the card's books) and one
 *  new one. */
export async function connectAgain(fake: FakeRedis, ctx: Ctx = TEST_CTX) {
  await saveItem(ctx, { item_id: 'item_new', institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt(ctx, 'access-sandbox-b') } as never);
  await fake.hset(ctxKey('accounts:meta', ctx), {
    item_new: await encrypt(
      ctx,
      JSON.stringify([
        { account_id: 'new_chk', name: 'Checking', official_name: 'Total Checking', mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' },
        { account_id: 'new_card', name: 'Sapphire', official_name: null, mask: '2222', type: 'credit', subtype: 'credit card', limit: 5000, currency: 'USD' },
      ])
    ),
  });
  const txns = {
    n_coffee: bankTxn({ transaction_id: 'n_coffee', account_id: 'new_chk' }),
    n_gas: bankTxn({ transaction_id: 'n_gas', account_id: 'new_chk', amount: 20.5, date: '2026-01-04', name: 'GAS', merchant_name: 'Shell', merchant_entity_id: null }),
    n_new: bankTxn({ transaction_id: 'n_new', account_id: 'new_chk', amount: 9.99, date: '2026-02-01', name: 'NEW ROW', merchant_name: null, merchant_entity_id: null }),
    n_card: bankTxn({ transaction_id: 'n_card', account_id: 'new_card', amount: 30, date: '2026-01-03', account_name: 'Sapphire', name: 'BOOKS', merchant_name: 'Green Apple', merchant_entity_id: 'ent_ga' }),
  };
  const balances = (current: number, limit: number | null) => ({ available: current, current, limit, iso_currency_code: 'USD', unofficial_currency_code: null });
  await fake.set(
    ctxKey('txns:item_new', ctx),
    await encodeJsonBlob(ctx, {
      schema_version: 2,
      cursor: 'c-new',
      accounts: {
        new_chk: { name: 'Checking', official_name: 'Total Checking', type: 'depository', subtype: 'checking', mask: '1111', balances: balances(1700, null) },
        new_card: { name: 'Sapphire', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: balances(500, 5000) },
      },
      txns,
    })
  );
}
