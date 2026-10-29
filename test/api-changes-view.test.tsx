import { describe, expect, test, mock, afterEach } from 'bun:test';
mock.module('@clerk/nextjs', () => ({
  useClerk: () => ({ signOut: async () => {} }),
  useReverification: (fetcher: unknown) => fetcher,
}));
const { renderToStaticMarkup } = await import('react-dom/server');
const { ApiChangesView, ChangeSheet } = await import('@/components/ApiChanges');
const { changeSentence, cannotUndo } = await import('@/components/api-change-words');
const { setAmountsHidden, MASK } = await import('@/lib/format');
type ListedChange = import('@/components/api-change-words').ListedChange;
type Props = Parameters<typeof ApiChangesView>[0];

// Changes made with your tokens (components/ApiChanges.tsx): nothing while
// writing is off and nothing is kept; each change in a sentence of what it
// stored, with its token (since revoked once it is), how it came, Undo or why
// not, and Forget; amounts through the hide-amounts formatters.

afterEach(() => setAmountsHidden(false));

const TOKEN = { ref: '0123456789abcdef', label: 'Importer' };
const change = (over: Partial<ListedChange> = {}): ListedChange => ({
  id: '20261020.0123456789abcdef.0123456789ab',
  at: '2026-10-20T12:00:00.000Z',
  via: 'api',
  token: TOKEN,
  op: 'transaction.create',
  target: { kind: 'transaction', id: 'manual-txn:1', account_id: 'manual_wallet' },
  state: 'done',
  before: null,
  after: { row: { id: 'manual-txn:1', name: 'Corner café', amount: 4.5, currency: 'USD', date: '2026-10-20' }, said: null },
  ...over,
});
const ready = (changes: ListedChange[], over: Partial<Extract<Props['list'], { kind: 'ready' }>> = {}): Props['list'] => ({
  kind: 'ready',
  changes,
  next: null,
  unreadable: [],
  unrecognised: [],
  accounts: { manual_wallet: { name: 'Wallet', currency: 'USD' } },
  writes: true,
  ...over,
});
const view = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(<ApiChangesView list={ready([])} writes act={async () => null} onMore={() => {}} loadingMore={false} {...over} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('the list', () => {
  test('nothing at all while writing is off and nothing is kept', () => {
    expect(view({ writes: false, list: ready([], { writes: false }) })).toBe('');
    // A change made before writing was turned off can still be undone.
    expect(text(view({ writes: false, list: ready([change()], { writes: false }) }))).toContain('Changes made with your tokens');
  });

  test('says what it is, and that there are none yet', () => {
    const t = text(view());
    expect(t).toContain('Changes made with your tokens');
    expect(t).toContain('Every change a token made in the last 30 days, newest first.');
    expect(t).toContain('No changes in the last 30 days.');
    expect(t).not.toMatch(/[\u2013\u2014]/);
  });

  test('each change: a sentence, its token and how it came, and Undo and Forget', () => {
    const html = view({ list: ready([change()]) });
    const t = text(html);
    expect(t).toContain('Added Corner café, −$4.50 on Oct 20.');
    expect(t).toContain('Importer through the API');
    expect(html.match(/>Undo<\/button>/g)).toHaveLength(1);
    expect(html.match(/>Forget<\/button>/g)).toHaveLength(1);
    // Each button is described by the change it acts on.
    const id = change().id;
    expect(html).toContain(`<div class="api-change-text" id="api-change-${id}">`);
    expect(html.match(new RegExp(`aria-describedby="api-change-${id.replaceAll('.', '\\.')}"`, 'g'))).toHaveLength(2);
  });

  test('a revoked token is named so; an assistant’s change says so; the app’s undo is yours', () => {
    const t = text(
      view({
        list: ready([
          change({ via: 'mcp', revoked: true }),
          change({ id: '20261020.app.0123456789ab', token: null, via: 'app', op: 'undo', target: { kind: 'change', id: 'x' }, undoes: 'x', before: null, after: null }),
        ]),
      })
    );
    expect(t).toContain('Importer (since revoked) through an AI assistant');
    expect(t).toContain('You in the app');
    expect(t).toContain('Undid an earlier change.');
  });

  test('why one can’t be undone: undone, forgotten, may not have been made', () => {
    const t = text(
      view({
        list: ready([
          change({ undone_by: '20261020.0123456789abcdef.aaaaaaaaaaaa' }),
          change({ id: 'b', forgotten_at: '2026-10-20T13:00:00.000Z', before: undefined, after: undefined }),
          change({ id: 'c', state: 'pending', before: undefined, after: undefined }),
        ]),
      })
    );
    expect(t).toContain('· undone');
    expect(t).toContain('Added a transaction. ');
    expect(t).toContain('What it changed is forgotten, so it can’t be undone.');
    expect(t).toContain('It may not have been made.');
    expect(t).toContain('It may not have been made, so there is nothing to undo.');
    expect(cannotUndo(change({ op: 'undo' }))).toBe('An undo isn’t undone: make the change again.');
  });

  test('a change that can’t be read can be removed; one from another version is only named; older ones load on asking', () => {
    const html = view({ list: ready([], { unreadable: ['20261020.0123456789abcdef.bbbbbbbbbbbb'], unrecognised: ['x'], next: 'abc' }) });
    const t = text(html);
    expect(t).toContain('A change couldn’t be read, so it can’t be undone.');
    expect(html).toContain('Remove it');
    expect(t).toContain('A change was recorded by another version of Nya');
    expect(html).toContain('Show older changes');
  });

  test('amounts go through the hide-amounts formatters', () => {
    // As in a browser's page: only there can amounts be hidden.
    const g = globalThis as Record<string, unknown>;
    g.window = {};
    try {
      setAmountsHidden(true);
    } finally {
      delete g.window;
    }
    const html = view({ list: ready([change(), change({ id: 'd', op: 'manual-account.balance', target: { kind: 'manual-account', id: 'manual_wallet' }, before: { balance: 40 }, after: { balance: 75.25 } })]) });
    expect(html).not.toContain('4.50');
    expect(html).not.toContain('75.25');
    expect(html).toContain(MASK);
    expect(text(html)).toContain('Set Wallet’s balance from');
  });
});

describe('sentences', () => {
  test('of every kind, from what the change stored', () => {
    const acct = { account_id: 'manual_jar', name: 'Jar', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 12.5 };
    expect(changeSentence(change({ op: 'manual-account.create', target: { kind: 'manual-account', id: 'manual_jar' }, after: acct }))).toBe('Added the manual account Jar, with a balance of $12.50.');
    expect(changeSentence(change({ op: 'manual-account.update', target: { kind: 'manual-account', id: 'manual_jar' }, before: acct, after: { ...acct, name: 'Coin jar', subtype: null } }))).toBe(
      'Changed the manual account Coin jar: renamed from Jar to Coin jar, its subtype from cash to none.'
    );
    expect(changeSentence(change({ op: 'manual-account.balance', target: { kind: 'manual-account', id: 'gone' }, before: { balance: 1 }, after: { balance: 2 } }))).toBe(
      'Set a manual account’s balance from $1.00 to $2.00.'
    );
    const row = { id: 'manual-txn:1', name: 'Market', amount: 25, currency: 'USD', date: '2026-10-19', note: 'apples' };
    expect(changeSentence(change({ op: 'transaction.update', before: { row, said: null }, after: { row: { ...row, amount: 30, note: null }, said: null } }))).toBe(
      'Changed Market, −$25.00 on Oct 19: its amount from −$25.00 to −$30.00, its note taken off.'
    );
    expect(changeSentence(change({ op: 'transaction.update', before: { row, said: null }, after: { row, said: { excluded: true, tags: ['t'] } } }))).toBe(
      'Changed Market, −$25.00 on Oct 19: left out of budgets and reports, its tags.'
    );
    expect(changeSentence(change({ op: 'transaction.delete', before: { row, said: null }, after: null }))).toBe('Deleted Market, −$25.00 on Oct 19.');
    expect(changeSentence(change({ op: 'category.create', target: { kind: 'category', id: 'c' }, after: { category: { name: 'Pets' } } }))).toBe('Added the category Pets.');
    expect(changeSentence(change({ op: 'category.update', target: { kind: 'category', id: 'c' }, before: { category: { name: 'Pets', archived: false } }, after: { category: { name: 'Pets', archived: true } } }))).toBe(
      'Changed the category Pets: archived.'
    );
    expect(changeSentence(change({ op: 'group.update', target: { kind: 'group', id: 'g' }, before: { group: { name: 'Side' } }, after: { group: { name: 'Side jobs' } } }))).toBe(
      'Changed the category group Side jobs: renamed from Side to Side jobs.'
    );
    expect(changeSentence(change({ op: 'tag.update', target: { kind: 'tag', id: 't' }, before: { tag: { name: 'Trip', color: 'blue' } }, after: { tag: { name: 'Trip', color: 'green' } } }))).toBe(
      'Changed the tag Trip: its color from blue to green.'
    );
    const undone = change();
    expect(changeSentence(change({ op: 'undo', target: { kind: 'change', id: undone.id }, undoes: undone.id }), {}, undone)).toBe('Undid this: added Corner café, −$4.50 on Oct 20.');
  });

  test('what it can’t read, it leaves out', () => {
    expect(changeSentence(change({ after: { row: 'nonsense' } }))).toBe('Added a transaction.');
    expect(changeSentence(change({ op: 'something.new', target: { kind: 'new', id: 'x' } }))).toBe('Made a change.');
  });
});

describe('asked first', () => {
  const sheet = (over: Partial<Parameters<typeof ChangeSheet>[0]> = {}) =>
    renderToStaticMarkup(<ChangeSheet asking={{ kind: 'undo', change: change(), id: change().id }} names={{}} busy={false} error={null} onCancel={() => {}} onConfirm={() => {}} {...over} />);

  test('an undo says what it changes back, and that it is only if nothing changed it since', () => {
    const t = text(sheet());
    expect(t).toContain('Undo this change?');
    expect(t).toContain('Added Corner café');
    expect(t).toContain('It is changed back only if nothing has changed it since');
    expect(sheet()).toContain('>Undo</button>');
  });

  test('a forget says what it removes, and offers every change of the token', () => {
    const html = sheet({ asking: { kind: 'forget', change: change(), id: change().id } });
    const t = text(html);
    expect(t).toContain('Forget what it changed?');
    expect(t).toContain('Forgetting removes the copy now. The change stays listed, without it, and can no longer be undone.');
    expect(html).toContain('>Forget this one</button>');
    expect(t).toContain('Forget every change Importer made');
  });

  test('a failure is shown, and while it works both buttons wait', () => {
    expect(sheet({ error: 'The transaction changed since this change was made' })).toContain('The transaction changed since this change was made');
    expect(sheet({ busy: true }).match(/disabled=""/g)!.length).toBeGreaterThanOrEqual(2);
  });
});
