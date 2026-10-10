import { describe, expect, test, mock, afterEach } from 'bun:test';
// Every name the app's components take from Clerk's client, so this mock can
// stand in for another file's while they share the process.
mock.module('@clerk/nextjs', () => ({
  useClerk: () => ({ signOut: async () => {} }),
  useReverification: (fetcher: unknown) => fetcher,
}));
const { renderToStaticMarkup } = await import('react-dom/server');
const { DownloadMyDataView, requestFile, formatsFor, localFilename } = await import('@/components/DownloadMyData');
const { ofxAccounts, accountLabel, chosenAccount, passphraseHint } = await import('@/components/DownloadOptions');
const { localDate } = await import('@/lib/local-date');

// What the download card adds to a format (components/DownloadOptions.tsx,
// components/DownloadMyData.tsx): the account an OFX statement is of, and a
// passphrase that protects the file. The rest of the card is
// test/download-view.test.tsx.

type Props = Parameters<typeof DownloadMyDataView>[0];
const noop = () => {};
const view = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(
    <DownloadMyDataView format="json" onFormat={noop} needsPassword={false} password="" onPassword={noop} phase={{ kind: 'idle' }} onDownload={noop} {...over} />
  );
const downloadButton = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].at(-1)!;

const ACCOUNTS = [
  { account_id: 'acc_sav', name: 'Savings', institution_name: 'Chase', type: 'depository', mask: '4444' },
  { account_id: 'acc_card', name: 'Sapphire', institution_name: 'Chase', type: 'credit', mask: '2222' },
  { account_id: 'acc_chk', name: 'Checking', institution_name: 'Chase', type: 'depository', mask: '1111' },
  { account_id: 'acc_mortgage', name: 'Mortgage', institution_name: 'Chase', type: 'loan', mask: '3333' },
  { account_id: 'acc_brk', name: 'Brokerage', institution_name: 'Fidelity', type: 'investment', mask: '9999' },
  { account_id: 'manual_cash', name: 'Cash', institution_name: 'By hand', type: 'depository', mask: null },
];

describe('a bank account’s or card’s statement', () => {
  test('is one of the formats, saying what it is for', () => {
    const ofx = formatsFor(true).find((f) => f.value === 'ofx')!;
    expect(ofx.label).toBe('Bank or card statement (OFX)');
    expect(ofx.note).toContain('for a money app that imports OFX (GnuCash, Actual Budget, YNAB) or to import into Nya again');
    expect(ofx.note).toContain('Pending transactions are left out until they post.');
    expect(view()).toContain('Bank or card statement (OFX)');
  });

  test('offers bank accounts and cards only, by institution and name, the first chosen until another is, and says why the rest aren’t there', () => {
    expect(ofxAccounts(ACCOUNTS).map((a) => a.account_id)).toEqual(['manual_cash', 'acc_chk', 'acc_card', 'acc_sav']);
    expect(accountLabel(ACCOUNTS[2])).toBe('Chase · Checking ••1111');
    expect(accountLabel(ACCOUNTS[5])).toBe('By hand · Cash');
    expect(chosenAccount(ACCOUNTS, null)?.account_id).toBe('manual_cash');
    expect(chosenAccount(ACCOUNTS, 'acc_chk')?.account_id).toBe('acc_chk');
    // An account no longer offered (removed, or a loan) falls back to the first.
    expect(chosenAccount(ACCOUNTS, 'acc_mortgage')?.account_id).toBe('manual_cash');
    const html = view({ format: 'ofx', accounts: ACCOUNTS, accountId: 'acc_chk' });
    expect(html).toContain('<select');
    expect([...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])).toEqual(['manual_cash', 'acc_chk', 'acc_card', 'acc_sav']);
    expect(html).toMatch(/<option value="acc_chk" selected="">Chase · Checking ••1111<\/option>/);
    expect(html).not.toContain('Mortgage');
    expect(html).not.toContain('Brokerage');
    expect(html).toContain('A loan has no statement in the OFX money apps read, and an investment account’s needs its holdings and trades');
    expect(html).toContain('their history is in the JSON file.');
    expect(downloadButton(html)[0]).not.toMatch(/disabled/);
    // The picker is there only for OFX.
    expect(view({ format: 'json', accounts: ACCOUNTS })).not.toContain('<select');
  });

  test('with no bank account or card, says so, and won’t start', () => {
    const html = view({ format: 'ofx', accounts: ACCOUNTS.filter((a) => a.type === 'loan' || a.type === 'investment') });
    expect(html).toContain('There’s no bank account or card to make a statement of.');
    expect(downloadButton(html)[0]).toMatch(/disabled/);
  });

  test('is named for its account, with the viewer’s own date', () => {
    const evening = new Date('2026-10-07T01:30:00.000Z');
    expect(localFilename('ofx', evening, { account: ACCOUNTS[2] })).toBe(`nya-chase-checking-1111-${localDate(evening)}.ofx`);
    expect(localFilename('ofx', evening, { account: ACCOUNTS[2], protected: true })).toBe(`nya-chase-checking-1111-${localDate(evening)}.ofx.age`);
  });
});

describe('a passphrase', () => {
  test('is offered, off until chosen', () => {
    const html = view();
    expect(html).toContain('Protect the file with a passphrase');
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)/);
    expect(html).not.toContain('new-password');
  });

  test('asks twice, says plainly that a lost one can’t be recovered, and how to open the file', () => {
    const html = view({ protect: true, passphrase: 'piano orbit lantern harvest', confirm: 'piano orbit lantern harvest' });
    expect(html.match(/autoComplete="new-password"|autocomplete="new-password"/gi)).toHaveLength(2);
    expect(html).toContain('At least 12 characters. Four or more words you’ll remember that don’t belong together');
    expect(html).toContain('Nya never keeps your passphrase. If you lose it, the file can’t be opened, by you or by anyone running Nya.');
    expect(html).toContain('href="/open-download"');
    expect(html).toContain('<code>age -d</code>');
    expect(downloadButton(html)[0]).not.toMatch(/disabled/);
  });

  test('won’t start until it is long enough and typed the same twice, and says what is missing', () => {
    expect(passphraseHint('', '')).toBe('Use at least 12 characters.');
    expect(passphraseHint('eleven char', 'eleven char')).toBe('Use at least 12 characters.');
    expect(passphraseHint(' '.repeat(12), ' '.repeat(12))).toBe('Use words, not only spaces.');
    expect(passphraseHint('piano orbit lantern', '')).toBe('Type it again below.');
    expect(passphraseHint('piano orbit lantern', 'piano orbit lanterns')).toBe('The two don’t match.');
    expect(passphraseHint('piano orbit lantern', 'piano orbit lantern')).toBeNull();
    for (const [passphrase, confirm, hint] of [
      ['short', 'short', 'Use at least 12 characters.'],
      ['piano orbit lantern', 'piano orbit lanter', 'The two don’t match.'],
    ]) {
      const html = view({ protect: true, passphrase, confirm });
      expect(html).toContain(hint);
      expect(downloadButton(html)[0]).toMatch(/disabled/);
    }
    // Off, nothing is asked of it.
    expect(downloadButton(view({ protect: false, passphrase: 'x', confirm: '' }))[0]).not.toMatch(/disabled/);
  });

  test('a protected file, saved: says how to open it', () => {
    const html = view({ phase: { kind: 'done', filename: 'nya-data-2026-10-10.json.age', bytes: 2048, notes: [], incomplete: [], protected: true } });
    expect(html).toContain('Saved nya-data-2026-10-10.json.age (2 KB).');
    expect(html).toContain('It is protected with your passphrase. Open it on');
    expect(html).toContain('href="/open-download"');
    expect(view({ phase: { kind: 'done', filename: 'f.json', bytes: 1, notes: [], incomplete: [] } })).not.toContain('protected with your passphrase');
  });
});

describe('the request', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('carries the account with OFX, and the passphrase when there is one; the file is named for both', async () => {
    const sent: unknown[] = [];
    const bytes = new TextEncoder().encode('OFXHEADER:100');
    globalThis.fetch = (async (_: unknown, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(bytes, { headers: { 'x-nya-export-bytes': String(bytes.length), 'content-type': 'application/octet-stream' } });
    }) as unknown as typeof fetch;
    const out = await requestFile({ format: 'ofx', account: ACCOUNTS[2], passphrase: 'piano orbit lantern harvest' }, 'hunter2', () => {});
    expect(out).toMatchObject({ ok: true, filename: `nya-chase-checking-1111-${localDate()}.ofx.age`, protected: true });
    await requestFile({ format: 'json', account: ACCOUNTS[2], passphrase: null }, null, () => {});
    await requestFile('balances-csv', null, () => {});
    expect(sent).toEqual([
      { format: 'ofx', account_id: 'acc_chk', passphrase: 'piano orbit lantern harvest', password: 'hunter2' },
      { format: 'json' },
      { format: 'balances-csv' },
    ]);
  });
});
