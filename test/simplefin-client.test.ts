import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { FakeSimplefin, fakeAccount, at } from './simplefin-fake';
import { setTransportForTests, guardedRequest, UnsafeUrlError, RequestFailedError, MAX_REDIRECTS } from '@/lib/connectors/http';
import { isPublicAddress } from '@/lib/connectors/net-guard';
import { ConnectorFailure, ExchangeFailure } from '@/lib/connectors/types';
import {
  claimSetupToken,
  decodeSetupToken,
  fetchAccountSet,
  parseAccessUrl,
  readAccountSet,
  readNumber,
  readTime,
  epochOfDay,
  accountsNamedIn,
  SIMPLEFIN,
} from '@/lib/connectors/simplefin';

// The SimpleFIN protocol client (lib/connectors/simplefin.ts) against a local
// fake server (test/simplefin-fake.ts), and the request guard it goes through
// (lib/connectors/http.ts): claiming a Setup Token once, reading accounts in
// a window, the sign conventions, pending transactions, the server's errors,
// and every way a request is refused or cut short.

let fake: FakeSimplefin;
beforeAll(async () => {
  fake = await FakeSimplefin.start();
  setTransportForTests(fake.transport());
});
afterAll(() => {
  setTransportForTests(null);
  fake.stop();
});
afterEach(() => {
  fake.reset();
  setTransportForTests(fake.transport());
});

/** The error a promise rejects with. */
async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a failure');
}

/** Everything an error says, its message, name and own fields, as text. */
const said = (err: Error) => `${err.name} ${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`;

describe('the Setup Token', () => {
  test('is the base64 of the claim URL, standard or URL-safe, line breaks and spaces aside', () => {
    const url = 'https://bridge.example/simplefin/claim/AbC?x=1';
    const b64 = Buffer.from(url).toString('base64');
    expect(decodeSetupToken(b64).toString()).toBe(url);
    expect(decodeSetupToken(`  ${b64.slice(0, 10)}\n${b64.slice(10)}  `).toString()).toBe(url);
    const urlSafe = Buffer.from('https://bridge.example/claim/??>>').toString('base64url');
    expect(decodeSetupToken(urlSafe).toString()).toBe('https://bridge.example/claim/??%3E%3E');
  });

  test('is refused, with words for the person, when it is anything else', () => {
    const kinds = (input: string) => {
      try {
        decodeSetupToken(input);
        return 'decoded';
      } catch (err) {
        return err instanceof ExchangeFailure ? err.kind : 'other';
      }
    };
    expect(kinds('')).toBe('invalid');
    expect(kinds('not a token!')).toBe('invalid');
    expect(kinds(Buffer.from('hello world').toString('base64'))).toBe('invalid');
    expect(kinds('https://bridge.example/claim/abc')).toBe('invalid');
    expect(kinds(Buffer.from('http://bridge.example/claim/abc').toString('base64'))).toBe('invalid');
    expect(kinds(Buffer.from('https://user:pw@bridge.example/claim/abc').toString('base64'))).toBe('invalid');
    expect(kinds(Buffer.from('https://bridge.example/\nclaim').toString('base64'))).toBe('invalid');
    expect(kinds(Buffer.from([0xff, 0xfe, 0x00, 0x41]).toString('base64'))).toBe('invalid');
    expect(kinds('A'.repeat(5000))).toBe('invalid');
  });
});

describe('claiming', () => {
  test('POSTs to the claim URL once and keeps the Access URL it answers', async () => {
    const { secret, host } = await claimSetupToken(fake.setupToken('first'));
    expect(secret).toBe(fake.accessUrl());
    expect(host).toBe(`bridge.test:${fake.port}`);
    expect(fake.seen).toEqual([{ method: 'POST', path: '/simplefin/claim/first', query: {}, authorized: false, authorization: null }]);
  });

  test('a token works once: claiming it again is refused as already used', async () => {
    const token = fake.setupToken('once');
    await claimSetupToken(token);
    const err = await failure(claimSetupToken(token));
    expect(err).toBeInstanceOf(ExchangeFailure);
    expect((err as ExchangeFailure).kind).toBe('claimed');
    expect(err.message).toContain('already been used');
    expect(err.message).toContain('Create a new one');
  });

  test("an answer that isn't an Access URL is refused, and the server's error is not taken for one", async () => {
    fake.behaviour = { on: 'claim', status: 200, body: 'https://bridge.test/no-credentials' };
    expect(((await failure(claimSetupToken(fake.setupToken('a')))) as ExchangeFailure).kind).toBe('answer');
    fake.behaviour = { on: 'claim', status: 500, body: 'oops' };
    const down = (await failure(claimSetupToken(fake.setupToken('b')))) as ExchangeFailure;
    expect(down.kind).toBe('down');
    expect(down.message).toContain('HTTP 500');
  });

  test('a claim that times out says the token may be used up', async () => {
    fake.behaviour = { on: 'claim', delayMs: 600 };
    const err = (await failure(claimSetupToken(fake.setupToken('slow'), { timeoutMs: 150 }))) as ExchangeFailure;
    expect(err.kind).toBe('down');
    expect(err.message).toContain('in time');
    expect(err.message).toContain('used up');
  });

  test('the Access URL is read into its address and its credentials', () => {
    const access = parseAccessUrl('https://us%40er:p%3Ass@bridge.example:8443/simplefin/')!;
    expect([access.user, access.password, access.base.toString()]).toEqual(['us@er', 'p:ss', 'https://bridge.example:8443/simplefin/']);
    expect(parseAccessUrl('https://bridge.example/simplefin')).toBeNull();
    expect(parseAccessUrl('http://u:p@bridge.example/simplefin')).toBeNull();
    expect(parseAccessUrl('not a url')).toBeNull();
    expect(SIMPLEFIN.hostOf(fake.accessUrl())).toBe(`bridge.test:${fake.port}`);
  });
});

describe('reading accounts', () => {
  test('sends the credentials as Basic authorization and asks for a window by Unix time, never for pending', async () => {
    fake.accounts = [fakeAccount()];
    await fetchAccountSet(fake.accessUrl(), { start: '2026-07-01', end: '2026-09-29' }, { timeoutMs: 2000 });
    const [req] = fake.accountRequests;
    expect(req.authorized).toBe(true);
    expect(req.query).toEqual({ 'start-date': String(epochOfDay('2026-07-01')), 'end-date': String(epochOfDay('2026-09-29')) });
    expect(epochOfDay('2026-07-01')).toBe(Date.UTC(2026, 6, 1) / 1000);
    await fetchAccountSet(fake.accessUrl(), { start: '2026-09-01', end: null }, { timeoutMs: 2000 });
    expect(fake.accountRequests[1].query).toEqual({ 'start-date': String(epochOfDay('2026-09-01')) });
    await fetchAccountSet(fake.accessUrl(), { balancesOnly: true }, { timeoutMs: 2000 });
    expect(fake.accountRequests[2].query).toEqual({ 'balances-only': '1' });
  });

  test("amounts take Plaid's sign: money in is negative, money out positive, on a card as on checking", async () => {
    fake.accounts = [
      fakeAccount({
        id: 'CHK',
        balance: '1500.25',
        transactions: [
          { id: 't-pay', posted: at('2026-10-01'), amount: '2500.00', description: 'PAYROLL ACME' },
          { id: 't-rent', posted: at('2026-10-02'), amount: '-1200.50', description: 'RENT', payee: 'Landlord LLC' },
        ],
      }),
      fakeAccount({
        id: 'CARD',
        name: 'Visa',
        balance: '-432.10',
        'available-balance': '4567.90',
        transactions: [
          { id: 'c-buy', posted: at('2026-10-03'), amount: '-45.67', description: 'COFFEE SHOP 123', payee: 'Coffee Shop' },
          { id: 'c-pay', posted: at('2026-10-04'), amount: '300.00', description: 'PAYMENT THANK YOU' },
        ],
      }),
    ];
    const answer = await fetchAccountSet(fake.accessUrl(), { start: '2026-09-01', end: null }, { timeoutMs: 2000 });
    const [chk, card] = answer.accounts;
    expect(chk.transactions.map((t) => [t.source_id, t.amount, t.description, t.date])).toEqual([
      ['t-pay', -2500, 'PAYROLL ACME', '2026-10-01'],
      ['t-rent', 1200.5, 'Landlord LLC', '2026-10-02'],
    ]);
    expect(card.transactions.map((t) => [t.source_id, t.amount])).toEqual([
      ['c-buy', 45.67],
      ['c-pay', -300],
    ]);
    // Balances are kept from the holder's side, as reported: a card's debt is
    // negative until the person says it is a card.
    expect([chk.balance, chk.available, card.balance, card.available]).toEqual([1500.25, 1400.25, -432.1, 4567.9]);
    expect(card.transactions[0]).toMatchObject({ source: 'simplefin', currency: 'USD', raw: { id: 'c-buy', amount: '-45.67', description: 'COFFEE SHOP 123', payee: 'Coffee Shop' } });
    expect(chk.balance_at).toBe('2026-10-08T12:00:00.000Z');
  });

  test('pending transactions are left out and counted, and so are unreadable ones', async () => {
    fake.accounts = [
      fakeAccount({
        transactions: [
          { id: 'posted', posted: at('2026-10-01'), amount: '-10.00', description: 'POSTED' },
          { id: 'pend-flag', posted: at('2026-10-02'), amount: '-11.00', description: 'PENDING', pending: true },
          { id: 'pend-zero', posted: 0, amount: '-12.00', description: 'PENDING TOO' },
          { id: '', posted: at('2026-10-03'), amount: '-13.00', description: 'NO ID' },
          { id: 'bad-amount', posted: at('2026-10-03'), amount: '12,00', description: 'COMMA' },
          { id: 'bad-time', posted: -5, amount: '-1.00', description: 'NEGATIVE TIME' },
        ],
      }),
    ];
    // The fake leaves pending out unless asked; a server that sends them anyway is read the same way.
    fake.extra = {};
    const asked = await fetchAccountSet(fake.accessUrl(), { start: '2026-09-01', end: null }, { timeoutMs: 2000 });
    expect(asked.accounts[0].transactions.map((t) => t.source_id)).toEqual(['posted']);
    const sent = readAccountSet({ errors: [], accounts: [fakeAccount({ transactions: fake.accounts[0].transactions })] });
    expect(sent.accounts[0].transactions.map((t) => t.source_id)).toEqual(['posted']);
    expect(sent.accounts[0].left_out).toEqual({ pending: 2, unreadable: 3 });
  });

  test("a currency Nya doesn't know is kept as text, never taken for a code", () => {
    const answer = readAccountSet({
      errors: [],
      accounts: [fakeAccount({ id: 'A', currency: 'aud' }), fakeAccount({ id: 'B', currency: 'https://example.com/flight-miles.json' }), fakeAccount({ id: 'C', currency: 'XYZ' })],
    });
    expect(answer.accounts.map((a) => [a.currency, a.currency_text])).toEqual([
      ['AUD', 'aud'],
      [null, 'https://example.com/flight-miles.json'],
      [null, 'XYZ'],
    ]);
  });

  test('an account without an id or a balance is counted, never guessed at', () => {
    const answer = readAccountSet({
      errors: [],
      accounts: [fakeAccount({ id: 'ok' }), { ...fakeAccount(), id: '' }, { ...fakeAccount({ id: 'nobal' }), balance: 'n/a' }, 'junk', fakeAccount({ id: 'ok' })],
    });
    expect(answer.accounts.map((a) => a.remote_id)).toEqual(['ok']);
    expect(answer.unreadable_accounts).toBe(4);
  });

  test("the server's errors come with the accounts of the institution they name, or with none named", () => {
    const answer = readAccountSet({
      errors: ['Connection to My Bank may need attention', 'Something went wrong', '\u0007Bad‮ text'],
      accounts: [fakeAccount({ id: 'mine' }), fakeAccount({ id: 'other', org: { name: 'Other Credit Union', domain: 'ocu.example' } })],
    });
    expect(answer.problems).toEqual([
      { message: 'Connection to My Bank may need attention', side: 'connector', accounts: ['mine'] },
      { message: 'Something went wrong', side: 'connector', accounts: null },
      { message: 'Bad text', side: 'connector', accounts: null },
    ]);
    expect(accountsNamedIn('connection to OTHER credit union failed', answer.accounts)).toEqual(['other']);
  });

  test('an errlist entry names its account by id', () => {
    const answer = readAccountSet({ errors: [], errlist: [{ code: 'con.auth', msg: 'Reauthenticate', account_id: 'x' }], accounts: [fakeAccount({ id: 'x' })] });
    expect(answer.problems).toEqual([{ message: 'Reauthenticate', side: 'connector', accounts: ['x'] }]);
  });

  test('organizations group their accounts by id, else domain, else name', () => {
    const answer = readAccountSet({
      errors: [],
      accounts: [
        fakeAccount({ id: '1', org: { id: 'ORG1', name: 'A', domain: 'a.example' } }),
        fakeAccount({ id: '2', org: { domain: 'B.example' } }),
        fakeAccount({ id: '3', org: { name: 'Credit Union' } }),
        fakeAccount({ id: '4', org: {} }),
      ],
    });
    expect(answer.accounts.map((a) => a.institution)).toEqual([
      { name: 'A', key: 'id:ORG1', domain: 'a.example' },
      { name: 'b.example', key: 'domain:b.example', domain: 'b.example' },
      { name: 'Credit Union', key: 'name:credit union', domain: null },
      { name: 'Your bank', key: 'unknown', domain: null },
    ]);
  });

  test('numbers and times are read strictly', () => {
    expect(['1', '-1.5', '+2.25', '.5', 3, '1e3', '1,000', '', ' 4 ', NaN, null].map(readNumber)).toEqual([1, -1.5, 2.25, 0.5, 3, null, null, null, 4, null, null]);
    expect([0, -1, '1700000000', 1700000000000].map(readTime)).toEqual([null, null, 1_700_000_000_000, null]);
  });

  test('each answer the protocol defines as a failure is one, in words for the person', async () => {
    const cases: [number, ConnectorFailure['kind'], ConnectorFailure['side']][] = [
      [403, 'refused', 'you'],
      [401, 'refused', 'you'],
      [402, 'payment', 'you'],
      [429, 'limited', 'nya'],
      [400, 'rejected', 'nya'],
      [500, 'down', 'connector'],
      [503, 'down', 'connector'],
    ];
    for (const [status, kind, side] of cases) {
      fake.behaviour = { on: 'accounts', status, body: JSON.stringify({ errors: ['Date range is too long'] }) };
      const err = (await failure(fetchAccountSet(fake.accessUrl(), { balancesOnly: true }, { timeoutMs: 2000 }))) as ConnectorFailure;
      expect([status, err.kind, err.side, err.status]).toEqual([status, kind, side, status]);
      expect(err.message).toContain('Date range is too long');
    }
    fake.behaviour = { on: 'accounts', status: 200, body: '<html>maintenance</html>' };
    expect(((await failure(fetchAccountSet(fake.accessUrl(), { balancesOnly: true }, { timeoutMs: 2000 }))) as ConnectorFailure).kind).toBe('answer');
    fake.behaviour = { on: 'accounts', status: 200, body: '{"errors":[]}' };
    expect(((await failure(fetchAccountSet(fake.accessUrl(), { balancesOnly: true }, { timeoutMs: 2000 }))) as ConnectorFailure).kind).toBe('answer');
  });

  test('wrong credentials are refused by the server, and said so', async () => {
    const wrong = fake.accessUrl().replace(fake.password, 'not-the-password');
    const err = (await failure(fetchAccountSet(wrong, { balancesOnly: true }, { timeoutMs: 2000 }))) as ConnectorFailure;
    expect(err.kind).toBe('refused');
    expect(fake.accountRequests[0].authorized).toBe(false);
  });
});

describe('the request guard', () => {
  const claimTo = (host: string) => Buffer.from(`https://${host}:${fake.port}/simplefin/claim/demo`).toString('base64');

  test('refuses a host that resolves to any address that is not public, before sending anything', async () => {
    const classes: [string, string[]][] = [
      ['loopback', ['127.0.0.1']],
      ['private', ['10.0.0.8']],
      ['private 192.168', ['192.168.0.10']],
      ['link-local metadata', ['169.254.169.254']],
      ['carrier-grade NAT', ['100.100.100.200']],
      ['IPv6 loopback', ['::1']],
      ['IPv6 unique local metadata', ['fd00:ec2::254']],
      ['IPv6 link-local', ['fe80::1']],
      ['IPv4-mapped metadata', ['::ffff:169.254.169.254']],
      ['a public and a private address', ['93.184.216.34', '10.0.0.1']],
    ];
    // The real rule: no exception for the fake's own address.
    setTransportForTests({ ...fake.transport(), allowAddress: isPublicAddress });
    for (const [what, addresses] of classes) {
      const host = `${what.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.evil.example`;
      fake.names.set(host, addresses);
      const err = await failure(claimSetupToken(claimTo(host)));
      expect([what, (err as ExchangeFailure).kind]).toEqual([what, 'blocked']);
    }
    // bridge.test itself is 127.0.0.1: refused under the real rule too.
    expect(((await failure(claimSetupToken(fake.setupToken()))) as ExchangeFailure).kind).toBe('blocked');
    expect(fake.seen).toEqual([]);
  });

  test('refuses an address written in the URL itself, in any form a URL parser accepts', async () => {
    setTransportForTests({ ...fake.transport(), allowAddress: isPublicAddress });
    for (const host of ['127.0.0.1', '2130706433', '0x7f.1', '[::1]', '[::ffff:7f00:1]', '169.254.169.254', '10.1.1.1']) {
      const err = await failure(guardedRequest({ method: 'GET', url: new URL(`https://${host}:${fake.port}/x`), accept: '*/*', timeoutMs: 500, maxBytes: 100 }));
      expect([host, err instanceof UnsafeUrlError && err.reason]).toEqual([host, 'address']);
    }
    expect(fake.seen).toEqual([]);
  });

  test('refuses http, and credentials in the URL', async () => {
    const http = await failure(guardedRequest({ method: 'GET', url: new URL(`http://bridge.test:${fake.port}/x`), accept: '*/*', timeoutMs: 500, maxBytes: 100 }));
    expect((http as UnsafeUrlError).reason).toBe('scheme');
    const creds = await failure(guardedRequest({ method: 'GET', url: new URL(fake.accessUrl()), accept: '*/*', timeoutMs: 500, maxBytes: 100 }));
    expect((creds as UnsafeUrlError).reason).toBe('credentials');
    expect(said(creds)).not.toContain(fake.password);
    expect(fake.seen).toEqual([]);
  });

  test('follows a redirect only to where the rules allow, and never with the credentials to another host', async () => {
    fake.names.set('internal.example', ['10.20.30.40']);
    fake.behaviour = { on: 'claim', location: `https://internal.example:${fake.port}/simplefin/claim/demo`, times: 1 };
    expect(((await failure(claimSetupToken(fake.setupToken()))) as ExchangeFailure).kind).toBe('blocked');
    // The metadata service, by address.
    fake.behaviour = { on: 'claim', location: 'https://169.254.169.254/latest/meta-data/', times: 1 };
    expect(((await failure(claimSetupToken(fake.setupToken()))) as ExchangeFailure).kind).toBe('blocked');
    // To http.
    fake.behaviour = { on: 'claim', location: `http://bridge.test:${fake.port}/simplefin/claim/demo`, times: 1 };
    expect(((await failure(claimSetupToken(fake.setupToken()))) as ExchangeFailure).kind).toBe('blocked');
    // Within the same origin it is followed.
    fake.behaviour = { on: 'claim', status: 307, location: `/simplefin/claim/demo`, times: 1 };
    expect((await claimSetupToken(fake.setupToken())).secret).toBe(fake.accessUrl());

    // The accounts call carries the credentials: another host is never sent them.
    fake.behaviour = { on: 'accounts', location: `https://other.bridge.test:${fake.port}/simplefin/accounts`, times: 1 };
    const err = (await failure(fetchAccountSet(fake.accessUrl(), { balancesOnly: true }, { timeoutMs: 2000 }))) as ConnectorFailure;
    expect(err.kind).toBe('blocked');
    expect(fake.seen.filter((r) => r.authorization !== null).length).toBe(1);
  });

  test(`gives up after ${MAX_REDIRECTS} redirects`, async () => {
    fake.behaviour = { on: 'claim', location: `/simplefin/claim/loop` };
    const err = await failure(guardedRequest({ method: 'POST', url: new URL(fake.claimUrl('loop')), accept: '*/*', timeoutMs: 2000, maxBytes: 100 }));
    expect((err as RequestFailedError).reason).toBe('redirects');
    expect(fake.seen.length).toBe(MAX_REDIRECTS + 1);
  });

  test('drops an answer larger than allowed, declared or not', async () => {
    fake.accounts = [fakeAccount()];
    for (const declared of [true, false]) {
      fake.behaviour = { on: 'accounts', huge: { bytes: 300_000, declared } };
      const err = await failure(guardedRequest({ method: 'GET', url: new URL(`https://bridge.test:${fake.port}/simplefin/accounts`), accept: '*/*', timeoutMs: 5000, maxBytes: 100_000 }));
      expect([declared, (err as RequestFailedError).reason]).toEqual([declared, 'too-large']);
    }
    fake.behaviour = { on: 'claim', huge: { bytes: 10_000, declared: false } };
    expect(((await failure(claimSetupToken(fake.setupToken()))) as ExchangeFailure).kind).toBe('answer');
  });

  test('cuts off an answer that comes too slowly, whether it never starts or trickles in', async () => {
    fake.behaviour = { on: 'accounts', delayMs: 800 };
    const t0 = Date.now();
    const slow = (await failure(fetchAccountSet(fake.accessUrl(), { balancesOnly: true }, { timeoutMs: 200 }))) as ConnectorFailure;
    expect([slow.kind, slow.message]).toEqual(['down', 'SimpleFIN didn’t answer in time.']);
    fake.behaviour = { on: 'accounts', trickle: { pieces: 20, everyMs: 50 } };
    const trickled = (await failure(fetchAccountSet(fake.accessUrl(), { balancesOnly: true }, { timeoutMs: 300 }))) as ConnectorFailure;
    expect(trickled.kind).toBe('down');
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test('a certificate the transport does not trust is refused', async () => {
    setTransportForTests({ ...fake.transport(), ca: undefined });
    const err = await failure(guardedRequest({ method: 'POST', url: new URL(fake.claimUrl()), accept: '*/*', timeoutMs: 2000, maxBytes: 100 }));
    expect((err as RequestFailedError).reason).toBe('tls');
  });

  test('a host that cannot be found is a network failure, not a refusal', async () => {
    const err = await failure(guardedRequest({ method: 'GET', url: new URL('https://nowhere.example/x'), accept: '*/*', timeoutMs: 500, maxBytes: 100 }));
    expect([(err as RequestFailedError).reason, (err as RequestFailedError).code]).toEqual(['network', 'ENOTFOUND']);
  });
});

describe('the Access URL never shows', () => {
  test('in any failure of the accounts call', async () => {
    const access = fake.accessUrl();
    const errors: Error[] = [];
    const run = async (b: typeof fake.behaviour, timeoutMs = 2000) => {
      fake.behaviour = b;
      errors.push(await failure(fetchAccountSet(access, { balancesOnly: true }, { timeoutMs })));
    };
    await run({ on: 'accounts', status: 403, body: `denied for ${fake.user}:${fake.password}` });
    await run({ on: 'accounts', status: 500, body: `{"errors":["bad credentials ${fake.password}"]}` });
    await run({ on: 'accounts', status: 200, body: 'not json' });
    await run({ on: 'accounts', delayMs: 400 }, 100);
    await run({ on: 'accounts', location: 'https://elsewhere.example/steal' });
    await run({ on: 'accounts', huge: { bytes: 11 * 1024 * 1024, declared: true } });
    setTransportForTests({ ...fake.transport(), allowAddress: isPublicAddress });
    await run(null);
    setTransportForTests({ ...fake.transport(), ca: undefined });
    await run(null);
    errors.push(await failure(fetchAccountSet(access.replace('https:', 'http:'), { balancesOnly: true }, { timeoutMs: 100 })));
    expect(errors.length).toBe(9);
    for (const err of errors) {
      const text = said(err);
      expect(text).not.toContain(fake.password);
      expect(text).not.toContain(fake.user);
      expect(text).not.toContain(access);
      expect(text).not.toContain(`${fake.host}:${fake.port}/simplefin`);
    }
  });
});
