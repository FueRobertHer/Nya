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
const { PreviewView, RecordSummary, UnreadableNotesView } = await import('@/components/RestoreCard');
type UnreadableAccount = import('@/components/restore-state').UnreadableAccount;
type UnrecognisedAccount = import('@/components/restore-state').UnrecognisedAccount;
type RestoredRows = import('@/lib/user-restore/forget').RestoredRows;
const { earlierNames } = await import('@/lib/earlier-names');
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
    expect(broughtLines({ 'store:currency-settings': 1 }, null)).toEqual(['your home currency and your own exchange rates']);
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

  test('what can’t be read says what to do: emptying only for the record itself while restores are on, the Accounts tab’s repair for an end', () => {
    const none = { entries: [], unrecognised: [], ends: false, unnamed: false, broken_links: false };
    expect(unreadableNotes({ enabled: true, record_unreadable: false, accounts_unreadable: none })).toEqual([]);
    const record = unreadableNotes({ enabled: true, record_unreadable: true, accounts_unreadable: none });
    expect(record.map((n) => n.empty)).toEqual([true]);
    expect(record[0].words).toContain('Empty this account (below) to start again');
    // With restores turned off, the emptying section isn't shown and the
    // server refuses it: the note says so instead.
    const off = unreadableNotes({ enabled: false, record_unreadable: true, accounts_unreadable: none });
    expect(off.map((n) => n.empty)).toEqual([false]);
    expect(off[0].words).not.toContain('Empty this account');
    expect(off[0].words).toContain('turned off on this copy of Nya: ask whoever runs it.');
    const ends = unreadableNotes({ enabled: true, record_unreadable: false, accounts_unreadable: { ...none, ends: true } });
    expect(ends.map((n) => n.empty)).toEqual([false]);
    expect(ends[0].words).toContain('Remove the damaged closure on the Accounts tab');
  });

  const damaged = (entries: UnreadableAccount[], over: { unnamed?: boolean; broken_links?: boolean; unrecognised?: UnrecognisedAccount[] } = {}) =>
    unreadableNotes({ enabled: true, record_unreadable: false, accounts_unreadable: { entries, unrecognised: [], ends: false, unnamed: false, broken_links: false, ...over } }, (d) => `[${d}]`);
  const ROWS: RestoredRows = { count: 2, first: '2026-01-03', last: '2026-01-04', unreadable: false, unrecognised: false };
  const WHAT = (subject: string) => `What Nya keeps about ${subject}, which a restore brought back, can’t be read, so no net worth total is recorded until it can be.`;
  const unlisted = (
    account_id: string,
    label: string | null,
    why: NonNullable<UnreadableAccount['unlisted']>['why'],
    others: (string | null)[] = [],
    listable = true,
    rows: RestoredRows | null = why === 'unknown' ? ROWS : null
  ): UnreadableAccount => ({
    account_id,
    label,
    listed: null,
    unlisted: { why, others, listable, rows },
  });

  test('an account whose details can’t be read is named as the Earlier accounts list names it before it is forgotten', () => {
    const notes = damaged([
      { account_id: 'acc_card', label: 'Chase Sapphire ••2222', listed: { name: 'Chase Sapphire ••2222', first: '2025-12-30', last: '2026-10-06' }, unlisted: null },
      { account_id: 'acc_gone', label: null, listed: { name: 'Balance history', first: '2024-01-01', last: null }, unlisted: null },
    ]);
    expect(notes.map((n) => [n.empty, n.words, n.remove])).toEqual([
      [false, `${WHAT('Chase Sapphire ••2222')} Forget it under Earlier accounts (Manage), where it is listed as Chase Sapphire ••2222 ([2025-12-30] to [2026-10-06]), or ask whoever runs this copy of Nya.`, undefined],
      [false, `${WHAT('an account')} Forget it under Earlier accounts (Manage), where it is listed as Balance history ([2024-01-01] to unknown), or ask whoever runs this copy of Nya.`, undefined],
    ]);
  });

  test('three damaged accounts at once that the list would show alike are told apart, there and in the notes', () => {
    // As the Earlier accounts list holds them: three with no name it can
    // read, over the same days, and one more, named.
    const list = [
      { id: 'acc_9f2Lq7', label: null, first: '2025-11-01', last: '2025-11-02' },
      { id: 'acc_Xw31Bd', label: null, first: '2025-11-01', last: '2025-11-02' },
      { id: 'acc_kP0z5e', label: null, first: '2025-11-01', last: '2025-11-02' },
      { id: 'acc_card', label: 'Chase Sapphire ••2222', first: '2025-12-30', last: '2026-10-06' },
    ];
    const names = earlierNames(list);
    expect([...names.values()]).toEqual(['Balance history · …2Lq7', 'Balance history · …31Bd', 'Balance history · …0z5e', 'Chase Sapphire ••2222']);
    const notes = damaged(list.slice(0, 3).map((e) => ({ account_id: e.id, label: null, listed: { name: names.get(e.id)!, first: e.first, last: e.last }, unlisted: null })));
    expect(new Set(notes.map((n) => n.words)).size).toBe(3);
    expect(notes.map((n) => n.words.slice(n.words.indexOf('listed as ')))).toEqual([
      'listed as Balance history · …2Lq7 ([2025-11-01] to [2025-11-02]), or ask whoever runs this copy of Nya.',
      'listed as Balance history · …31Bd ([2025-11-01] to [2025-11-02]), or ask whoever runs this copy of Nya.',
      'listed as Balance history · …0z5e ([2025-11-01] to [2025-11-02]), or ask whoever runs this copy of Nya.',
    ]);
  });

  test('one the list doesn’t show is told why, with what works for that reason, never a link that isn’t there', () => {
    const notes = damaged([
      unlisted('acc_unk', null, 'unknown', [], false),
      unlisted('acc_old', 'Chase Old Checking ••0000', 'linked', ['Chase Checking ••1111']),
      unlisted('acc_chk', 'Chase Checking ••1111', 'linked-to', ['Chase Old Checking ••0000']),
      unlisted('acc_two', null, 'linked-to', [null, null], false),
      unlisted('acc_brk', null, 'link-unreadable', [], false),
      unlisted('acc_live', 'Ally Savings ••7777', 'live'),
      unlisted('acc_conn', 'Ally Checking ••8888', 'connected'),
      unlisted('manual_x', null, 'manual'),
    ]);
    const way = (n: { words: string }) => n.words.slice(n.words.indexOf('can be. ') + 'can be. '.length);
    expect(notes.map(way)).toEqual([
      'Nya has no name it can read for it and no balance history, so it isn’t listed under Earlier accounts (Manage). Forget it here for good, or ask whoever runs this copy of Nya.',
      'It isn’t listed under Earlier accounts (Manage), since it is linked to Chase Checking ••1111, whose history it is part of. To forget it, unlink it (Manage, Reconnected accounts, Linked), then forget it under Earlier accounts; or ask whoever runs this copy of Nya.',
      'It isn’t listed under Earlier accounts (Manage), since Chase Old Checking ••0000 is linked to it. To forget it, unlink that one (Manage, Reconnected accounts, Linked), then forget it under Earlier accounts; or ask whoever runs this copy of Nya.',
      'It isn’t listed under Earlier accounts (Manage), since 2 earlier accounts are linked to it. To forget it, unlink them (Manage, Reconnected accounts, Linked), then forget it here; or ask whoever runs this copy of Nya.',
      'It isn’t listed under Earlier accounts (Manage), since a link saved for it can’t be read. To forget it, remove that link (Manage, Reconnected accounts, Unreadable), then forget it here; or ask whoever runs this copy of Nya.',
      'It isn’t listed under Earlier accounts (Manage), since it is one of your connected accounts. To forget it, disconnect its bank (Accounts tab), then forget it under Earlier accounts; or ask whoever runs this copy of Nya.',
      'It isn’t listed under Earlier accounts (Manage), since its bank is still connected. To forget it, disconnect that bank (Accounts tab), then forget it under Earlier accounts; or ask whoever runs this copy of Nya.',
      'It has a manual account’s id, so it can’t be forgotten as an earlier account: ask whoever runs this copy of Nya.',
    ]);
    expect(notes.every((n) => !n.words.includes('It is linked to another account'))).toBe(true);
    // Only the one nothing else can show is forgotten from the card.
    expect(notes.map((n) => n.remove?.account_id ?? null)).toEqual(['acc_unk', null, null, null, null, null, null, null]);
    expect(notes[0].remove!.confirm).toBe(
      'Forget this account for good? The 2 transactions a restore brought back for it ([2026-01-03] to [2026-01-04]), and what you said about them, are deleted, and this can’t be undone. To keep a copy, cancel and choose Download my data first.'
    );
    // The download is offered first, once, as undo offers it.
    const html = renderToStaticMarkup(<UnreadableNotesView notes={notes} busy={false} onRemove={() => {}} download={<button className="secondary">Download my data first</button>} />);
    expect(html.match(/<button[^>]*>Forget it<\/button>/g)?.length).toBe(1);
    expect(html.match(/Download my data first/g)?.length).toBe(1);
    expect(html.indexOf('Download my data first')).toBeLessThan(html.indexOf('>Forget it<'));
    expect(html.match(/<p class="stale-note">/g)?.length).toBe(8);
  });

  test('the confirm says what forgetting takes: how many transactions and over which days, or that some can’t be read, or that there are none', () => {
    const confirm = (rows: RestoredRows | null) => damaged([unlisted('acc_unk', null, 'unknown', [], false, rows)])[0].remove!.confirm;
    const rest = ', and this can’t be undone. To keep a copy, cancel and choose Download my data first.';
    expect(confirm({ ...ROWS, count: 1, last: '2026-01-03' })).toBe(`Forget this account for good? The transaction a restore brought back for it ([2026-01-03]), and what you said about it, are deleted${rest}`);
    expect(confirm({ ...ROWS, count: 1234 })).toContain('The 1,234 transactions a restore brought back for it ([2026-01-03] to [2026-01-04]), and what you said about them, are deleted');
    expect(confirm({ ...ROWS, unreadable: true })).toContain('The 2 transactions a restore brought back for it that can be read ([2026-01-03] to [2026-01-04]), those that can’t be, and what you said about them, are deleted');
    expect(confirm({ count: 0, first: null, last: null, unreadable: true, unrecognised: false })).toContain('The transactions a restore brought back for it, which can’t be read, are deleted');
    expect(confirm({ count: 0, first: null, last: null, unreadable: false, unrecognised: false })).toBe(`Forget this account for good? A restore brought back no transactions for it, and what Nya keeps about it is deleted${rest}`);
  });

  test('what this version doesn’t know is said apart, a newer version’s or a fault, and nothing offers to forget it', () => {
    const NEWER = (subject: string) =>
      `What Nya keeps about ${subject}, which a restore brought back, is in a form this version of Nya doesn’t know: a newer version wrote it, or it is a fault. It is kept as it is, and no net worth total is recorded meanwhile: ask whoever runs this copy of Nya.`;
    const notes = damaged([], { unrecognised: [{ account_id: 'acc_card', label: 'Chase Sapphire ••2222' }, { account_id: 'acc_x1111', label: null }, { account_id: 'acc_y1111', label: null }], broken_links: true });
    expect(notes.map((n) => [n.key, n.words, n.remove])).toEqual([
      ['account:acc_card', NEWER('Chase Sapphire ••2222'), undefined],
      ['account:acc_x1111', NEWER('an account (…x1111)'), undefined],
      ['account:acc_y1111', NEWER('an account (…y1111)'), undefined],
    ]);
    // Said even when the damaged ones can't be named, beside them.
    const both = damaged([{ account_id: 'a', label: null, listed: null, unlisted: null }], { unnamed: true, unrecognised: [{ account_id: 'acc_card', label: null }] });
    expect(both.map((n) => [n.key, n.remove])).toEqual([
      ['unnamed', undefined],
      ['account:acc_card', undefined],
    ]);
    // An account with nothing to list it by whose transactions this version
    // doesn't know isn't forgotten from here either.
    const rows = damaged([unlisted('acc_unk', null, 'unknown', [], false, { ...ROWS, unrecognised: true })]);
    expect(rows[0].remove).toBeUndefined();
    expect(rows[0].words).toContain('are in a form this version of Nya doesn’t know: a newer version wrote them, or it is a fault. They are kept as they are, so it can’t be forgotten here: ask whoever runs this copy of Nya.');
  });

  test('two that would read the same are told apart by the end of each id; a link that can’t be read is said once', () => {
    const notes = damaged([unlisted('acc_aaaa1111', null, 'unknown', [], false), unlisted('acc_bbbb1111', null, 'unknown', [], false)], { broken_links: true });
    expect(notes.map((n) => n.key)).toEqual(['broken-links', 'account:acc_aaaa1111', 'account:acc_bbbb1111']);
    expect(notes[0].words).toBe('A saved link can’t be read, so no account can be forgotten until it is removed: remove it first (Manage, Reconnected accounts, Unreadable).');
    expect(notes[1].words.startsWith(WHAT('an account (…a1111)'))).toBe(true);
    expect(notes[2].words.startsWith(WHAT('an account (…b1111)'))).toBe(true);
    expect(notes[1].remove!.confirm.startsWith('Forget this account (…a1111) for good?')).toBe(true);
    // Its own link is the one to remove: said there, not twice.
    expect(damaged([unlisted('acc_brk', null, 'link-unreadable', [], false)], { broken_links: true }).map((n) => n.key)).toEqual(['account:acc_brk']);
  });

  test('when what names them can’t be read, the note says so, and nothing else about them', () => {
    const blank = (account_id: string): UnreadableAccount => ({ account_id, label: null, listed: null, unlisted: null });
    expect(damaged([blank('a')], { unnamed: true }).map((n) => n.words)).toEqual([
      'What Nya keeps about an account a restore brought back can’t be read, so no net worth total is recorded until it can be. Its name couldn’t be read just now either, so this card can’t say how to forget it: try again later, or ask whoever runs this copy of Nya.',
    ]);
    expect(damaged([blank('a'), blank('b'), blank('c')], { unnamed: true, broken_links: true }).map((n) => n.words)).toEqual([
      'What Nya keeps about 3 accounts a restore brought back can’t be read, so no net worth total is recorded until it can be. Their names couldn’t be read just now either, so this card can’t say how to forget them: try again later, or ask whoever runs this copy of Nya.',
    ]);
  });

  test('a protected file is told by its first bytes', () => {
    expect(looksProtected(new TextEncoder().encode('age-encryption.org/v1\n-> scrypt'))).toBe(true);
    expect(looksProtected(new TextEncoder().encode('{"format": "nya-export"'))).toBe(false);
  });
});

type View = import('@/lib/user-restore/answering').AnswersView;
const words = await import('@/components/restore-state');
const { default: RestoreAnswers } = await import('@/components/RestoreAnswers');

describe('the banks from your download, and the answers that count them', () => {
  const account = (over: Record<string, unknown> = {}) => ({
    account_id: 'acc_chk',
    name: 'Checking',
    mask: '1111',
    type: 'depository',
    currency: 'USD',
    rows: { first: '2025-11-20', last: '2026-01-04', count: 3 },
    hidden: false,
    end: null,
    counted: null,
    held_by: [] as string[] | 'unread',
    apart: { items: [] as string[], accounts: [] as string[] },
    handed_to: null,
    ...over,
  });
  const item = { kind: 'item' as const, id: 'item_new', institution: 'Chase', institution_id: 'ins_3', accounts: [{ account_id: 'new_chk', name: 'Checking', mask: '1111' }] };
  const sf = { kind: 'connector' as const, id: 'manual_sf', institution: 'Chase', name: 'Total Checking', card: 'abc', kept: false, via: 'simplefin' as const };
  const view = (accounts: ReturnType<typeof account>[], holders: View['holders'] = []): View => ({
    banks: [{ institution_name: 'Chase', accounts: accounts as never, prefill: '2026-01-05', latest: '2026-10-07' }],
    holders,
    unreadable: false,
  });

  test('where each account’s transactions stand, in words', () => {
    const line = (over: Record<string, unknown>) => words.accountLine(account(over) as never, [item, sf]);
    expect(line({})).toBe('Checking ••1111, transactions Nov 20, 2025 to Jan 4, 2026: waiting for an answer');
    expect(line({ end: { state: 'untracked', from: '2026-01-05' } })).toBe('Checking ••1111, transactions Nov 20, 2025 to Jan 4, 2026: not followed from Jan 5, 2026: its transactions aren’t counted');
    expect(line({ counted: 'person', end: { state: 'closed', on: '2026-10-07' } })).toBe('Checking ••1111, transactions Nov 20, 2025 to Jan 4, 2026: counted up to its end (closed on Oct 7, 2026)');
    expect(line({ counted: 'file', end: { state: 'closed', on: '2026-01-03' } })).toContain('counted up to its end (closed on Jan 3, 2026), as in your other copy');
    expect(line({ counted: 'person', held_by: ['item_new', 'manual_sf'] })).toContain('counted once you say whether Chase and Chase Total Checking through SimpleFIN hold it');
    expect(line({ counted: 'person', held_by: 'unread' })).toContain('counted, but not while what holds it can’t be read');
    expect(line({ counted: 'person', handed_to: { account_id: 'manual_sf', cut: '2026-01-04' } })).toContain('carried on by Chase Total Checking through SimpleFIN: counted before Jan 4, 2026');
    expect(line({ counted: 'person', handed_to: { account_id: 'manual_sf', cut: null } })).toContain('counted whole until that account has transactions of its own');
    expect(line({ hidden: true })).toContain('Checking ••1111 (hidden)');
  });

  test('a waiting bank is asked whether it is gone, with the day prefilled and its latest said', () => {
    const html = text(renderToStaticMarkup(<RestoreAnswers view={view([account()])} busy={false} onAnswer={async () => {}} onStopFollowing={async () => {}} />));
    expect(html).toContain('Is Chase gone? Its transactions can count as an ended account’s, up to the day you give. Nya has them up to your download, so Oct 7, 2026 at the latest.');
    expect(html).toContain('Count Chase’s transactions');
    expect(html).toContain('Stop following, without counting them');
    expect(html).not.toContain('Connected since');
  });

  test('a card that still owes asks before what it owes stops counting', () => {
    const html = text(renderToStaticMarkup(<RestoreAnswers view={view([account({ type: 'credit' })])} busy={false} onAnswer={async () => {}} onStopFollowing={async () => {}} />));
    expect(html).toContain('Stop counting what its cards and loans owe from then too');
  });

  test('a counted bank held by connections made since asks about each, and offers the answers', () => {
    const v = view([account({ counted: 'person', end: { state: 'closed', on: '2026-10-07' }, held_by: ['item_new', 'manual_sf'] })], [item, sf]);
    expect(words.openHolders(v).map((h) => h.id)).toEqual(['item_new', 'manual_sf']);
    const html = text(renderToStaticMarkup(<RestoreAnswers view={v} busy={false} onAnswer={async () => {}} onStopFollowing={async () => {}} />));
    expect(html).toContain('Is Chase one of the banks from your download? Its accounts: Checking ••1111.');
    expect(html).toContain('None of them');
    expect(html).toContain('None of these are at Chase');
    expect(html).toContain('Is Chase Total Checking through SimpleFIN one of the accounts from your download?');
    expect(html).toContain('It carries on Chase Checking ••1111');
    expect(html).toContain('Don’t count Chase’s transactions');
  });

  test('a connection said not to be among them can be asked about again', () => {
    const v = view([account({ counted: 'person', apart: { items: ['item_new'], accounts: [] } })], [item]);
    expect(words.answeredHolders(v)).toEqual([{ holder: item, account_ids: ['acc_chk'] }]);
    expect(text(renderToStaticMarkup(<RestoreAnswers view={v} busy={false} onAnswer={async () => {}} onStopFollowing={async () => {}} />))).toContain('Ask about Chase again');
  });
});
