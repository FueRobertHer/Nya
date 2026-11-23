import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx } = await import('./api-fixture');
const { forgetEpochs } = await import('@/lib/sessions');
const { declaredStore } = await import('@/lib/stores');
const { SEAM } = await import('@/lib/user-restore/parts');
const { STORE_CLASSES } = await import('@/lib/user-restore/classes');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');
const { isStoredPayoffInputs, parseStoredPayoffInputs } = await import('@/lib/debt-payoff-store');
const { cashPosition, forecastEvents, matchingRecurring } = await import('@/lib/forecast');
const { debtPayoffSummary } = await import('@/lib/payoff');
const route = await import('@/app/api/debt-payoff/route');

const env = { ...process.env };
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  clerk.signedIn = null;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...env };
});

const call = async (method: 'GET' | 'PUT', body?: unknown) => {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await route[method](new Request('https://nya.test/api/debt-payoff', init));
  return { res, body: await res.json() };
};

describe('debt payoff store and API route', () => {
  test('GET returns null initially, PUT validates and persists, export and restore registries cover it', async () => {
    expect((await call('GET')).body).toEqual({ plan: null });

    const saved = {
      strategy: 'snowball' as const,
      currency: 'USD',
      extra: { USD: '250' },
      leftOut: { old_card: true },
      withoutAccrued: {},
      sharedSplit: {},
      typed: { auto_1: { apr: '6.25', minimum: '465' } },
    };
    const put = await call('PUT', { plan: saved });
    expect(put.res.status).toBe(200);
    expect(put.body.plan).toEqual({ v: 1, ...saved });

    const again = await call('GET');
    expect(again.res.status).toBe(200);
    expect(again.body.plan).toEqual({ v: 1, ...saved });

    // Registered in stores, restore parts, restore classes, and data export.
    expect(declaredStore('debt-payoff')).toMatchObject({ kind: 'value', exportable: true, what: 'your debt payoff plan' });
    expect(SEAM['debt-payoff']).toEqual({ kind: 'value', restore: 'write' });
    expect(STORE_CLASSES['debt-payoff']).toBe('data');
    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date('2026-10-26T15:00:00.000Z')) as Record<string, unknown>;
    expect(doc['debt-payoff']).toEqual({ v: 1, ...saved });

    // Invalid payload refused with 400.
    const bad = await call('PUT', { plan: { ...saved, strategy: 'random' } });
    expect(bad.res.status).toBe(400);

    // Closed-shape validator rejects unknown keys so future versions read as unrecognised.
    expect(isStoredPayoffInputs({ v: 1, ...saved, unknownFutureField: true })).toBe(false);
    expect(parseStoredPayoffInputs({ ...saved, extra: { USD: '' } })).toMatchObject({ plan: { extra: {} } });

    // Unreadable ciphertext returns 409 unreadable rather than null.
    await fake.set(ctxKey('debt-payoff'), 'not-valid-ciphertext');
    const err = console.error;
    console.error = () => {};
    try {
      const broken = await call('GET');
      expect(broken.res.status).toBe(409);
      expect(broken.body.unreadable).toBe(true);
    } finally {
      console.error = err;
    }
  });
});

describe('Phase 5 pure helpers: debtPayoffSummary, forecast account scope, matchingRecurring', () => {
  test('debtPayoffSummary totals owed accounts and returns payoff month when all terms are complete', () => {
    const insts = [
      {
        institution_name: 'Chase',
        liabilities: 'on' as const,
        accounts: [
          {
            account_id: 'card1',
            name: 'Sapphire',
            mask: '4321',
            type: 'credit',
            subtype: 'credit card',
            balance: 2400,
            currency: 'USD',
            liability: { kind: 'credit' as const, apr: 20, apr_label: 'Purchase APR', minimum_payment: 120 },
          },
          {
            account_id: 'auto1',
            name: 'Auto Loan',
            mask: null,
            type: 'loan',
            subtype: 'auto',
            balance: 10000,
            currency: 'USD',
          },
        ],
      },
    ];
    const incomplete = debtPayoffSummary(insts, { startMonth: '2026-11' });
    expect(incomplete).toMatchObject({ accounts: 2, currency: 'USD', owedCents: 1_240_000, payoffMonth: null });

    const complete = debtPayoffSummary(insts, {
      startMonth: '2026-11',
      choices: {
        typed: { auto1: { apr: '6.5', minimum: '400' } },
        leftOut: {},
        withoutAccrued: {},
        sharedSplit: {},
      },
    });
    expect(complete?.accounts).toBe(2);
    expect(complete?.payoffMonth).toMatch(/^20\d\d-\d\d$/);
  });

  test('cashPosition and forecastEvents filter cleanly to Checking only when accountIds/accounts are provided', () => {
    const insts = [
      {
        institution_name: 'Chase',
        accounts: [
          { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 1200, currency: 'USD' },
          { account_id: 'sav', name: 'Savings', type: 'depository', subtype: 'savings', balance: 25000, currency: 'USD' },
        ],
      },
    ];
    expect(cashPosition(insts).start).toBe(26200);
    expect(cashPosition(insts, [], { accountIds: new Set(['chk']) }).start).toBe(1200);

    const series = [
      {
        id: 's1',
        group: 'g1',
        kind: 'bill' as const,
        name: 'Rent',
        institution: 'Chase',
        account: 'Checking',
        accountType: 'depository',
        cadence: 'monthly' as const,
        amount: 1500,
        agreement: 'same' as const,
        currency: 'USD',
        logo_url: null,
        firstDate: '2026-07-01',
        lastDate: '2026-10-01',
        nextDate: '2026-11-01',
        seen: 4,
        schedule: { unit: 'month' as const, every: 1, days: [1], month: '2026-11', slot: 0 },
      },
      {
        id: 's2',
        group: 'g2',
        kind: 'bill' as const,
        name: 'Savings fee',
        institution: 'Chase',
        account: 'Savings',
        accountType: 'depository',
        cadence: 'monthly' as const,
        amount: 10,
        agreement: 'same' as const,
        currency: 'USD',
        logo_url: null,
        firstDate: '2026-07-01',
        lastDate: '2026-10-01',
        nextDate: '2026-11-01',
        seen: 4,
        schedule: { unit: 'month' as const, every: 1, days: [1], month: '2026-11', slot: 0 },
      },
    ];
    const checkingEvents = forecastEvents({
      series,
      planned: [],
      accounts: new Set(['Chase|Checking']),
      currency: 'USD',
      today: '2026-10-20',
      until: '2026-11-20',
    });
    expect(checkingEvents.events.map((e) => e.name)).toEqual(['Rent']);

    // matchingRecurring flags planned item matching recurring bill within 5% & 5 days, ignores dismissed or far-off
    const item = { id: 'p1', name: 'Apartment rent', kind: 'expense' as const, amount: 1520, currency: 'USD', date: '2026-11-03', cadence: 'monthly' as const };
    expect(matchingRecurring(item, series, new Set(), '2026-10-20')?.id).toBe('s1');
    expect(matchingRecurring(item, series, new Set(['s1']), '2026-10-20')).toBeNull();
    expect(matchingRecurring({ ...item, amount: 2000 }, series, new Set(), '2026-10-20')).toBeNull();
    expect(matchingRecurring({ ...item, date: '2026-11-12' }, series, new Set(), '2026-10-20')).toBeNull();
  });
});
