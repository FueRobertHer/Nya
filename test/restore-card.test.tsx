import { describe, expect, test, mock, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer } from './fake-redis';
import { seedOld, restoreRecord } from './restore-fixture';

// The Bring back a download card's words (components/restore-state.ts) and
// views (components/RestoreCard.tsx): what a real download would bring back
// and what it wouldn't, in words the person knows; a damaged entry's
// transactions with their amounts hidden when amounts are; the banks that
// wait, with the day Stop following starts from; and how long undo lasts.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { MASK, setAmountsHidden } = await import('@/lib/format');
const { broughtLines, leftOutLines, waitingBanks, dayAfter, canUndo, looksProtected, accountWords, sharingLines, unreadableNotes } = await import('@/components/restore-state');
const { PreviewView, RecordSummary } = await import('@/components/RestoreCard');
const { collect, previewOf } = await import('@/lib/user-restore/file');
const { downloadText, sourceOf, EXPORTED } = await import('./restore-run');

afterEach(() => setAmountsHidden(false));
const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
const spoken = (html: string) => text(html.replace(/<span aria-hidden="true">[^<]*<\/span>/g, ' '));

fake.reset();
await registerTestContainer(fake);
await seedOld(fake, TEST_CTX);
const DOWNLOAD = await downloadText(EXPORTED);

describe('what comes back, in words', () => {
  test('a real download’s parts, said as the person knows them, never by part name', async () => {
    const p = previewOf(await collect(sourceOf(DOWNLOAD)));
    const lines = broughtLines(p.brought, p.history);
    expect(lines).toEqual([
      'your categories and their groups',
      'your tags',
      'your rules',
      '1 manual account',
      '2 accounts of banks connected through Plaid, kept as earlier accounts until you connect each bank again',
      '4 bank transactions, counted once their accounts are linked again',
      'the transactions of 1 manual account',
      '1 category you chose for transactions',
      '1 merchant name',
      'notes, tags and exclusions on 1 transaction',
      '1 split',
      '1 group of transactions',
      '2 approvals',
      '1 link between an earlier account and a new one',
      'your budgets',
      'your goals',
      'your balance history, 2025-12-29 to 2026-01-04, recorded and estimated days each where they were',
      'your settings',
    ]);
    expect(lines.join(' ')).not.toMatch(/store:|history:|restored-/);
    expect(broughtLines({ 'store:connector-connections': 2 }, null)).toEqual(['2 connections to SimpleFIN or Lunch Flow, to connect again with a new Setup Token or an API key from Lunch Flow']);
    expect(leftOutLines(p.left_out, p.collected.never)).toEqual([
      '1 pending transaction: the bank sends it again once posted',
      'what you said only about pending transactions (3)',
      'the sign-ins Nya used to reach your banks: connect each bank again',
    ]);
    expect(leftOutLines({}, { api_tokens: 2, sharing: 1 }).slice(1)).toEqual([
      '2 API tokens: make new ones if you need them',
      '1 sharing connection: sharing is between two people, so share again from here',
    ]);
  });

  test('a damaged entry’s transactions are named, each amount hidden when amounts are and said as hidden', async () => {
    const withProblem = DOWNLOAD.replace('"problems": []', `"problems": [${JSON.stringify({ section: 'transaction-annotations', problem: 'unreadable', ids: ['t_old'] })}]`);
    const c = await collect(sourceOf(withProblem));
    const loaded = { source: sourceOf(withProblem), collected: c, preview: previewOf(c) };
    const view = (on: boolean) => {
      const g = globalThis as Record<string, unknown>;
      const none = g.window === undefined;
      if (none) g.window = {};
      try {
        setAmountsHidden(on);
        return renderToStaticMarkup(<PreviewView loaded={loaded} withoutOk={false} onWithoutOk={() => {}} passwordField={null} busy={false} blocked onCancel={() => {}} onRestore={() => {}} clerk />);
      } finally {
        setAmountsHidden(false);
        if (none) delete g.window;
      }
    };
    expect(text(view(false))).toContain('2025-11-20 · Rainbow · $61.20');
    const hidden = view(true);
    expect(text(hidden)).toContain(`2025-11-20 · Rainbow · $${MASK}`);
    expect(text(hidden)).not.toContain('61.20');
    expect(spoken(hidden)).toContain('2025-11-20 · Rainbow · hidden');
    expect(text(hidden)).toContain('Bring it back without them');
  });

  test('whom the account shares with already, and what, so they know who will see it', () => {
    expect(sharingLines([{ label: 'Pat', kinds: ['net_worth', 'spending'], accounts: 0 }, { label: 'Sam', kinds: [], accounts: 2 }])).toEqual(['Pat: your net worth and your spending', 'Sam: 2 accounts']);
  });

  test('a finished restore says when, from which download, and what came back', () => {
    const record = { ...restoreRecord({ status: 'finished', done: 1, finished_at: '2026-10-07T09:05:00.000Z', undo_until: '2026-10-14T09:05:00.000Z', history: { first: '2025-12-29', last: '2026-01-04' } }), plan: { digest: 'a'.repeat(64), batches: 1 } };
    const html = text(renderToStaticMarkup(<RecordSummary record={record as never} />));
    expect(html).toContain('Brought back on');
    expect(html).toContain('your tags');
    expect(html).toContain('your balance history, 2025-12-29 to 2026-01-04');
  });
});

describe('what waits, and for how long undo lasts', () => {
  test('banks that wait, each with its accounts and the day after its last restored day', () => {
    const banks = waitingBanks([
      { account_id: 'a1', institution_name: 'Chase', name: 'Checking', mask: '1111', last: '2026-01-04' },
      { account_id: 'a2', institution_name: 'Chase', name: 'Sapphire', mask: '2222', last: '2026-01-03' },
      { account_id: 'a3', institution_name: 'Ally', name: null, mask: null, last: null },
    ]);
    expect(banks.map((b) => [b.institution_name, b.accounts.map(accountWords), b.last, b.from])).toEqual([
      ['Chase', ['Checking ••1111', 'Sapphire ••2222'], '2026-01-04', '2026-01-05'],
      ['Ally', ['Account'], null, null],
    ]);
    expect(dayAfter('2024-02-28')).toBe('2024-02-29');
    expect(dayAfter('2026-12-31')).toBe('2027-01-01');
  });

  test('undo while unfinished, and until its last day after the finish', () => {
    const view = (over: Record<string, unknown>) => ({ ...restoreRecord(over), plan: { digest: 'a'.repeat(64), batches: 1 } }) as never;
    expect(canUndo(view({ status: 'writing' }), Date.parse('2030-01-01'))).toBe(true);
    const finished = view({ status: 'finished', done: 1, finished_at: '2026-10-07T09:05:00.000Z', undo_until: '2026-10-14T09:05:00.000Z' });
    expect(canUndo(finished, Date.parse('2026-10-14T09:05:00.000Z'))).toBe(true);
    expect(canUndo(finished, Date.parse('2026-10-14T09:05:00.001Z'))).toBe(false);
  });

  test('what can’t be read says what to do: emptying only for the record itself, the Accounts tab’s repair for an end', () => {
    const none = { entries: false, ends: false };
    expect(unreadableNotes({ record_unreadable: false, accounts_unreadable: none })).toEqual([]);
    expect(unreadableNotes({ record_unreadable: true, accounts_unreadable: none }).map((n) => [n.empty, n.words.slice(0, 43)])).toEqual([[true, 'Nya can’t read the record of a restore here']]);
    const ends = unreadableNotes({ record_unreadable: false, accounts_unreadable: { entries: false, ends: true } });
    expect(ends.map((n) => n.empty)).toEqual([false]);
    expect(ends[0].words).toContain('Remove the damaged closure on the Accounts tab');
    const entries = unreadableNotes({ record_unreadable: false, accounts_unreadable: { entries: true, ends: false } });
    expect(entries.map((n) => n.empty)).toEqual([false]);
    expect(entries[0].words).toContain('Forget that account (Manage, Earlier accounts)');
  });

  test('a protected file is told by its first bytes', () => {
    expect(looksProtected(new TextEncoder().encode('age-encryption.org/v1\n-> scrypt'))).toBe(true);
    expect(looksProtected(new TextEncoder().encode('{"format": "nya-export"'))).toBe(false);
  });
});
