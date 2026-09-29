import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The check for Items that cost money and do nothing (lib/item-usage.ts). It
// only FLAGS them: these tests also pin that nothing is ever removed by it.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const DAY = 86_400_000;
const plaid = {
  accounts: {} as Record<string, string[]>, // access token -> account ids
  fail: {} as Record<string, string>, // access token -> error code
  itemError: {} as Record<string, string>, // access token -> error carried on a 200
  removed: [] as string[],
  webhooks: [] as { token: string; url: string }[],
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async (req: any) => {
      const code = plaid.fail[req.access_token];
      if (code) throw { response: { data: { error_code: code } } };
      const error = plaid.itemError[req.access_token];
      return {
        data: {
          item: error ? { error: { error_code: error } } : {},
          accounts: (plaid.accounts[req.access_token] ?? []).map((account_id) => ({ account_id })),
        },
      };
    },
    itemRemove: async (req: any) => {
      plaid.removed.push(req.access_token);
      return { data: {} };
    },
    itemWebhookUpdate: async (req: any) => {
      plaid.webhooks.push({ token: req.access_token, url: req.webhook });
      return { data: {} };
    },
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { saveItem, getItems } = await import('@/lib/storage');
const { setAccountHidden } = await import('@/lib/hidden');
const { checkItemUsage, readFlagged, unusedKind, unusedDays, DEFAULT_UNUSED_DAYS, MIN_UNUSED_DAYS } = await import('@/lib/item-usage');
const cronRoute = await import('@/app/api/plaid/check-items/route');

async function link(item_id: string, token: string, accounts: string[]) {
  await saveItem(ctx, { item_id, institution_name: `Bank ${item_id}`, encrypted_access_token: await encrypt(token) });
  plaid.accounts[token] = accounts;
}

const T0 = Date.parse('2026-01-01T00:00:00Z');
const run = (daysLater: number) => checkItemUsage(ctx, { now: T0 + daysLater * DAY, days: 60 });
const flagged = async () => (await readFlagged(ctx)).map((f) => `${f.item_id}:${f.kind}`).sort();
const ids = async () => (await getItems(ctx)).map((i) => i.item_id).sort();

const saved = { ...process.env };
const errors = console.error;
beforeEach(async () => {
  fake.reset();
  plaid.accounts = {};
  plaid.fail = {};
  plaid.itemError = {};
  plaid.removed = [];
  plaid.webhooks = [];
  console.error = () => {};
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...saved };
  console.error = errors;
});

describe('an Item Plaid keeps refusing', () => {
  test('is flagged once refused for the whole period, not before', async () => {
    await link('good', 'tok_good', ['g1']);
    await link('dead', 'tok_dead', ['d1']);
    plaid.fail.tok_dead = 'ITEM_LOGIN_REQUIRED';

    await run(0);
    await run(59);
    expect(await flagged()).toEqual([]);

    const report = await run(60);
    expect(report.flagged).toBe(1);
    expect(await flagged()).toEqual(['dead:refused']);
  });

  test('is never removed by the check, however long it has been refused', async () => {
    await link('dead', 'tok', ['a']);
    plaid.fail.tok = 'ITEM_LOGIN_REQUIRED';
    await run(0);
    await run(500);
    expect(await ids()).toEqual(['dead']);
    expect(plaid.removed).toEqual([]);
  });

  test('loses the flag, and the count, when it works again', async () => {
    await link('flaky', 'tok', ['a']);
    plaid.fail.tok = 'ITEM_LOGIN_REQUIRED';
    await run(0);
    await run(60);
    expect(await flagged()).toEqual(['flaky:refused']);
    delete plaid.fail.tok; // the user reconnected
    await run(61);
    expect(await flagged()).toEqual([]);
    plaid.fail.tok = 'ITEM_LOGIN_REQUIRED';
    await run(62);
    await run(121); // 59 days since it failed again
    expect(await flagged()).toEqual([]);
    await run(122);
    expect(await flagged()).toEqual(['flaky:refused']);
  });

  test('an outage, timeout or rate limit says nothing either way', async () => {
    await link('slow', 'tok', ['a']);
    plaid.fail.tok = 'INSTITUTION_DOWN';
    await run(0);
    await run(200);
    expect(await flagged()).toEqual([]);
    // ...and does not restart a count already running
    plaid.fail.tok = 'ITEM_LOGIN_REQUIRED';
    await run(201);
    plaid.fail.tok = 'RATE_LIMIT_EXCEEDED';
    await run(230);
    plaid.fail.tok = 'ITEM_LOGIN_REQUIRED';
    await run(261);
    expect(await flagged()).toEqual(['slow:refused']);
  });

  test('an error carried on a successful answer counts as a refusal', async () => {
    await link('quiet', 'tok', ['a']);
    plaid.itemError.tok = 'ITEM_LOGIN_REQUIRED';
    await run(0);
    await run(60);
    expect(await flagged()).toEqual(['quiet:refused']);
  });

  test('codes that can be an artifact of configuration are not refusals', async () => {
    await link('env', 'tok', ['a']);
    for (const code of ['INVALID_ACCESS_TOKEN', 'NO_ACCOUNTS', 'ITEM_LOCKED']) {
      plaid.fail.tok = code;
      await run(0);
      await run(500);
      expect(await flagged()).toEqual([]);
    }
  });
});

describe('a flag needs the same run to confirm it', () => {
  test('a read that fails on the checking day does not newly flag an Item whose clock is old', async () => {
    await link('back', 'tok', ['a']);
    plaid.fail.tok = 'ITEM_LOGIN_REQUIRED';
    await run(0); // clock starts; reconnected on day 50, but no run happened until day 60
    plaid.fail.tok = 'ETIMEDOUT';
    await run(60);
    plaid.fail.tok = 'RATE_LIMIT_EXCEEDED';
    await run(61);
    expect(await flagged()).toEqual([]);
  });

  test('a flag stays through a failed read, and clears on a good one', async () => {
    await link('dead', 'tok', ['a']);
    plaid.fail.tok = 'ITEM_LOGIN_REQUIRED';
    await run(0);
    await run(60);
    plaid.fail.tok = 'ETIMEDOUT';
    await run(61);
    expect(await flagged()).toEqual(['dead:refused']);
    delete plaid.fail.tok;
    await run(62);
    expect(await flagged()).toEqual([]);
  });
});

describe('an Item whose every account is hidden', () => {
  test('is flagged after the period, and only if ALL its accounts are hidden', async () => {
    await link('half', 'tok_half', ['h1', 'h2']);
    await link('all', 'tok_all', ['x1', 'x2']);
    await setAccountHidden(ctx, 'h1', 'depository', true);
    await setAccountHidden(ctx, 'x1', 'depository', true);
    await setAccountHidden(ctx, 'x2', 'depository', true);

    await run(0);
    await run(60);
    expect(await flagged()).toEqual(['all:hidden']);
    expect(await ids()).toEqual(['all', 'half']); // nothing removed
  });

  test('unhiding one account in time keeps it unflagged', async () => {
    await link('all', 'tok', ['x1', 'x2']);
    await setAccountHidden(ctx, 'x1', 'depository', true);
    await setAccountHidden(ctx, 'x2', 'depository', true);
    await run(0);
    await setAccountHidden(ctx, 'x2', 'depository', false);
    await run(40);
    await setAccountHidden(ctx, 'x2', 'depository', true);
    await run(70);
    expect(await flagged()).toEqual([]);
  });

  test('a failed read on the checking day does not newly flag it', async () => {
    await link('all', 'tok', ['x1']);
    await setAccountHidden(ctx, 'x1', 'depository', true);
    await run(0);
    plaid.fail.tok = 'INSTITUTION_DOWN'; // the user may have unhidden it since
    await run(60);
    expect(await flagged()).toEqual([]);
    delete plaid.fail.tok;
    await run(61);
    expect(await flagged()).toEqual(['all:hidden']);
  });

  test('an Item with no accounts at all is not "all hidden"', async () => {
    await link('empty', 'tok', []);
    await run(0);
    await run(500);
    expect(await flagged()).toEqual([]);
  });
});

describe('what it leaves alone', () => {
  test('an Item whose credentials cannot be decrypted is neither checked nor flagged', async () => {
    await saveItem(ctx, { item_id: 'bad', institution_name: 'Bad', encrypted_access_token: 'not-ciphertext' });
    await run(0);
    await run(500);
    expect(await flagged()).toEqual([]);
    expect(await ids()).toEqual(['bad']);
  });

  test('the list holds only Items that are still linked', async () => {
    await link('dead', 'tok', ['a']);
    plaid.fail.tok = 'ITEM_LOGIN_REQUIRED';
    await run(0);
    await run(60);
    expect(await flagged()).toEqual(['dead:refused']);
    const { removeItem } = await import('@/lib/storage');
    await removeItem(ctx, 'dead');
    expect(await flagged()).toEqual([]);
  });
});

describe('the webhook', () => {
  test('is registered once per URL on an Item that predates it', async () => {
    await link('old', 'tok', ['a']);
    process.env.PLAID_WEBHOOK_URL = 'https://nya.example/api/plaid/webhook';
    await run(0);
    await run(7);
    expect(plaid.webhooks).toEqual([{ token: 'tok', url: `https://nya.example/api/plaid/webhook?c=${ctx.container}` }]);
    process.env.PLAID_WEBHOOK_URL = 'https://other.example/api/plaid/webhook';
    await run(14);
    expect(plaid.webhooks).toHaveLength(2);
  });

  test('is not registered when none is configured', async () => {
    await link('old', 'tok', ['a']);
    delete process.env.PLAID_WEBHOOK_URL;
    await run(0);
    expect(plaid.webhooks).toEqual([]);
  });
});

describe('the settings', () => {
  test('the period defaults to 60 days and is never shorter than 14', () => {
    delete process.env.PLAID_UNUSED_DAYS;
    expect(unusedDays()).toBe(DEFAULT_UNUSED_DAYS);
    process.env.PLAID_UNUSED_DAYS = '3';
    expect(unusedDays()).toBe(MIN_UNUSED_DAYS);
    process.env.PLAID_UNUSED_DAYS = 'soon';
    expect(unusedDays()).toBe(DEFAULT_UNUSED_DAYS);
    process.env.PLAID_UNUSED_DAYS = '90';
    expect(unusedDays()).toBe(90);
  });

  test('unusedKind needs a start date old enough, and this run to confirm it', () => {
    const u = { first_seen: '2026-01-01T00:00:00Z', error_since: null, hidden_since: null, webhook: null, checked_at: null, flagged: null, confirmed_run: null };
    const since = new Date(T0).toISOString();
    expect(unusedKind(u, T0 + 999 * DAY, 60)).toBeNull();
    expect(unusedKind({ ...u, error_since: since }, T0 + 60 * DAY, 60)).toBe('refused');
    expect(unusedKind({ ...u, error_since: since }, T0 + 60 * DAY, 60, { error: false, hidden: true })).toBeNull();
    expect(unusedKind({ ...u, hidden_since: since }, T0 + 59 * DAY, 60)).toBeNull();
    expect(unusedKind({ ...u, hidden_since: since }, T0 + 60 * DAY, 60)).toBe('hidden');
  });
});

describe('the cron route', () => {
  test('the cron route needs the secret, and reports counts only', async () => {
    process.env.CRON_SECRET = 'cron';
    await link('dead', 'tok', ['a']);
    plaid.fail.tok = 'ITEM_LOGIN_REQUIRED';

    expect((await cronRoute.GET(new Request('http://x/api/plaid/check-items'))).status).toBe(401);
    expect((await cronRoute.GET(new Request('http://x', { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);

    const log = console.log;
    console.log = () => {};
    try {
      const res = await cronRoute.GET(new Request('http://x', { headers: { authorization: 'Bearer cron' } }));
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).not.toContain('Bank dead');
    } finally {
      console.log = log;
    }
    expect(await ids()).toEqual(['dead']);
  });
});
