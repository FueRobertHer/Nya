import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, type FakeElement } from './mini-dom';

// The buttons of the import sheets and the own-sync sheet, in each step's
// footer (docs/design/guidelines.md, Buttons in the footer): the way out
// first, the step's action last, and why a request failed (or what Import
// waits on) as a footer note the action is described by. A step's footer
// shows only while that step is drawn. Used as a person would
// (react-dom/client over test/mini-dom.ts), the server stood in for.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
// React's client reads what the document supports once, when it loads.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: ImportSheet } = await import('@/components/ImportSheet');
const { default: HistoryImportSheet } = await import('@/components/HistoryImportSheet');
const { ConnectorSheet } = await import('@/components/Connectors');
type ConnectorAsk = import('@/components/Connectors').ConnectorAsk;
type ConnectionView = import('@/lib/connectors/view').ConnectionView;
type AccountView = import('@/lib/connectors/view').AccountView;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const body = () => dom.document.body;
const classOf = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');
const sheet = () => body().findAll((e) => e.getAttribute('role') === 'dialog')[0] ?? null;
const footer = () => sheet()?.findAll((e) => classOf(e).includes('sheet-footer'))[0] ?? null;
const sheetBody = () => sheet()?.findAll((e) => classOf(e).includes('sheet-body'))[0] ?? null;
/** The footer's buttons, each its words and its classes. */
const footerButtons = () => (footer()?.findAll((e) => e.tagName === 'BUTTON') ?? []).map((b) => [b.textContent.trim(), b.getAttribute('class')]);
const button = (within: FakeElement | null, words: string) => within?.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
const bodyButtons = () => (sheetBody()?.findAll((e) => e.tagName === 'BUTTON') ?? []).map((b) => b.textContent.trim());
const footerNotes = () => footer()?.findAll((e) => classOf(e).includes('sheet-footer-note')) ?? [];
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
};
const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle();
};

async function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(node));
  await settle();
  return { rerender: (n: React.ReactNode) => act(async () => root.render(n)), unmount: () => act(async () => root.unmount()) };
}

/** A file chosen in the sheet's file field, as a browser hands it over. */
async function choose(name: string, text: string) {
  const input = sheet()!.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'file')[0];
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps$'))!;
  const file = new File([text], name);
  await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { files: [file] } }));
  await settle();
}

/** Every one of these dates fits month first and day first. */
const QIF = '!Type:Bank\nD09/01/2026\nT-12.00\nPCOFFEE\n^\nD09/02/2026\nT-5.00\nPLUNCH\n^\n';

/** A failed request said in a footer note, and the step's action described by it. */
function expectRefused(action: string, words: string) {
  const notes = footerNotes();
  const note = notes.find((n) => n.textContent.includes(words));
  expect(note).toBeTruthy();
  expect(note!.findAll((e) => e.getAttribute('role') === 'alert').length).toBe(1);
  expect(button(footer(), action)!.getAttribute('aria-describedby')).toBe(note!.getAttribute('id'));
  // Said once: not in the body as well.
  expect(sheetBody()!.textContent).not.toContain(words);
}

const sentMeta = (init?: RequestInit) => JSON.parse(String((init?.body as FormData).get('meta'))) as { action: string };

describe('Import a file (ImportSheet)', () => {
  const institutions = [
    { institution_name: 'Cascade CU', manual: true, accounts: [{ account_id: 'manual_chk', name: 'Checking', type: 'depository', balance: 1000, currency: 'USD' }] },
  ];
  const PREVIEW = {
    format: 'qif',
    encoding: 'utf-8',
    statement: null,
    read: { date_order: 'mdy', dates_ordered: false, decimal: null },
    counts: { new: 2, present: 0, repeated: 0, replaced: 0, skipped: 0, conflicts: 0, unreadable: 0 },
    rows: [],
    problems: [],
    more_problems: 0,
    conflicts: [],
    more_conflicts: 0,
    shared_ids: [],
    more_shared_ids: 0,
    kinds: { transfers: 0, atm: 0, payments: 0, fees: 0 },
    first_date: '2026-09-01',
    last_date: '2026-09-02',
    currency: 'USD',
    currency_from: 'account',
    other_currencies: [],
    totals: { out: 17, in: 0 },
    shortened: 0,
    warnings: [],
    account_mismatch: null,
    balance: null,
  };

  test('the dates’ order, the preview and done each have their buttons in the footer, the way out first; Another file leaves no footer', async () => {
    let refusePreview = true;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/import?')) return Response.json({ imports: [], settings: null });
      if (url === '/api/import' && init?.method === 'POST') {
        const meta = sentMeta(init);
        if (meta.action === 'preview') {
          if (refusePreview) {
            refusePreview = false;
            return Response.json({ error: 'The file couldn’t be checked just now.' }, { status: 500 });
          }
          return Response.json({ preview: PREVIEW });
        }
        return Response.json({ imported: 2, present: 0, repeated: 0, unreadable: 0, replaced: 0, skipped: 0 });
      }
      return Response.json({ error: 'Unexpected' }, { status: 500 });
    }) as unknown as typeof fetch;
    const view = await mount(<ImportSheet target={{ account_id: 'manual_chk' }} institutions={institutions} onClose={() => {}} onImported={() => {}} />);

    // Choosing the file: nothing to commit yet, so no footer.
    expect(footer()).toBeNull();
    await choose('sept.qif', QIF);

    // The order of the dates: its question (a choice) in the body, Another file then Next in the footer.
    expect(sheetBody()!.textContent).toContain('Which is it?');
    expect(bodyButtons()).toEqual(['month/day/year (US)', 'day/month/year (UK, Europe)']);
    expect(footerButtons()).toEqual([
      ['Another file', 'btn secondary'],
      ['Next', 'btn'],
    ]);
    expect(button(footer(), 'Next')!.hasAttribute('disabled')).toBe(true);
    await press(button(sheetBody(), 'month/day/year (US)'));
    expect(button(footer(), 'Next')!.hasAttribute('disabled')).toBe(false);
    expect(button(footer(), 'Next')!.getAttribute('aria-describedby')).toBeNull();
    await press(button(footer(), 'Next'));
    expectRefused('Next', 'The file couldn’t be checked just now.');

    // The preview: its buttons come from inside it, in the same order.
    await press(button(footer(), 'Next'));
    expect(sheetBody()!.textContent).toContain('2 new transactions');
    expect(footerButtons()).toEqual([
      ['Another file', 'btn secondary'],
      ['Import 2 transactions', 'btn'],
    ]);
    expect(footerNotes().length).toBe(0);

    // Done: Import another then Done, the past imports in the body.
    await press(button(footer(), 'Import 2 transactions'));
    expect(sheetBody()!.textContent).toContain('2 transactions imported into Checking');
    expect(footerButtons()).toEqual([
      ['Import another', 'btn secondary'],
      ['Done', 'btn'],
    ]);
    expect(bodyButtons()).not.toContain('Done');

    // Another file goes back to choosing one: no step's buttons are left.
    await press(button(footer(), 'Import another'));
    expect(sheet()!.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'file').length).toBe(1);
    expect(footer()).toBeNull();
    await view.unmount();
  });

  test('a CSV file’s columns: Check against the account alone in the footer, the way back the sheet’s arrow; then Columns first in the preview', async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/import?')) return Response.json({ imports: [], settings: null });
      if (url === '/api/import' && init?.method === 'POST') return Response.json({ preview: { ...PREVIEW, format: 'csv' } });
      return Response.json({ error: 'Unexpected' }, { status: 500 });
    }) as unknown as typeof fetch;
    const view = await mount(<ImportSheet target={{ account_id: 'manual_chk' }} institutions={institutions} onClose={() => {}} onImported={() => {}} />);
    await choose('sept.csv', 'Date,Description,Amount\n2026-09-01,COFFEE,-12\n2026-09-02,LUNCH,-5\n');
    expect(sheetBody()!.textContent).toContain('How the first rows read');
    expect(footerButtons()).toEqual([['Check against Checking', 'btn']]);
    expect(sheet()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Back').length).toBe(1);
    await press(button(footer(), 'Check against Checking'));
    expect(footerButtons()).toEqual([
      ['Columns', 'btn secondary'],
      ['Import 2 transactions', 'btn'],
    ]);
    // One footer's buttons at a time: the mapping's are gone with it.
    expect(button(footer(), 'Check against Checking')).toBeNull();
    await view.unmount();
  });
});

describe('Import history (HistoryImportSheet)', () => {
  const target = { account_id: 'acc_chk', name: 'Checking', institution_name: 'Chase', type: 'depository', currency: 'USD' };
  const REVIEW = {
    format: 'qif',
    statement: null,
    read: { date_order: 'mdy', decimal: null },
    counts: { new: 2, duplicates: 0, already: 0, present: 0, repeated: 0, skipped: 0, conflicts: 0, unanswered: 0, unreadable: 0 },
    rows: [],
    problems: [],
    more_problems: 0,
    proposals: [],
    more_proposals: 0,
    conflicts: [],
    more_conflicts: 0,
    kinds: { transfers: 0, atm: 0, payments: 0, fees: 0 },
    first_date: '2026-09-01',
    last_date: '2026-09-02',
    covers: { from: '2026-09-01', to: '2026-09-30', stated: false },
    bank_from: '2026-10-01',
    before_bank: 2,
    within_bank: 0,
    pending_alike: 0,
    currency: 'USD',
    other_currencies: [],
    totals: { out: 17, in: 0 },
    shortened: 0,
    warnings: [],
    account_mismatch: null,
    review: '0123456789abcdef0123456789abcdef',
  };

  test('the dates’ order, the review and done each have their buttons in the footer, the way out first', async () => {
    let refuseReview = true;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/history-import?')) return Response.json({ imports: [], settings: null, bank_from: '2026-10-01', history_pending: false, walked: true, reach: null });
      if (url === '/api/history-import' && init?.method === 'POST') {
        const meta = sentMeta(init);
        if (meta.action === 'preview') {
          if (refuseReview) {
            refuseReview = false;
            return Response.json({ error: 'The file couldn’t be checked just now.' }, { status: 500 });
          }
          return Response.json({ preview: REVIEW });
        }
        return Response.json({ imported: 2, duplicates: 0, already: 0, present: 0, repeated: 0, skipped: 0, unreadable: 0, history: { drawn: false, from: null } });
      }
      return Response.json({ error: 'Unexpected' }, { status: 500 });
    }) as unknown as typeof fetch;
    const view = await mount(<HistoryImportSheet target={target} onClose={() => {}} onImported={() => {}} />);
    expect(footer()).toBeNull();
    await choose('old.qif', QIF);

    expect(sheetBody()!.textContent).toContain('Which is it?');
    expect(footerButtons()).toEqual([
      ['Another file', 'btn secondary'],
      ['Next', 'btn'],
    ]);
    await press(button(sheetBody(), 'month/day/year (US)'));
    await press(button(footer(), 'Next'));
    expectRefused('Next', 'The file couldn’t be checked just now.');

    await press(button(footer(), 'Next'));
    expect(footerButtons()).toEqual([
      ['Another file', 'btn secondary'],
      ['Import 2 transactions', 'btn'],
    ]);

    await press(button(footer(), 'Import 2 transactions'));
    expect(sheetBody()!.textContent).toContain('2 transactions imported into Checking');
    expect(footerButtons()).toEqual([
      ['Import another', 'btn secondary'],
      ['Done', 'btn'],
    ]);
    expect(bodyButtons()).not.toContain('Done');
    await press(button(footer(), 'Import another'));
    expect(footer()).toBeNull();
    await view.unmount();
  });
});

describe('Your own sync (ConnectorSheet)', () => {
  const account = (over: Partial<AccountView> = {}): AccountView => ({
    account_id: 'manual_a',
    name: 'Checking',
    institution_name: 'My Bank',
    type: 'depository',
    currency: 'USD',
    balance: 1500.25,
    reported: 1500.25,
    sign: null,
    needs_sign: false,
    balance_at: '2026-10-08T12:00:00.000Z',
    ...over,
  });
  const conn = (accounts: AccountView[]): ConnectionView => ({
    connection_id: 'conn_1',
    connector: 'simplefin',
    label: 'SimpleFIN',
    host: 'bridge.example',
    site: 'https://bridge.example/',
    created_at: '2026-10-01T12:00:00.000Z',
    last_fetch: null,
    last_answer_at: null,
    history: { from: '2026-07-11', to: '2026-10-09', complete: false },
    accounts,
    available: [],
  });
  const OFFER = { remote_id: 'r1', name: 'Savings', institution: 'My Bank', currency: 'USD', currency_text: 'USD', balance: 200, balance_at: null };

  /** The server, with each route's answers in turn (the last repeats). */
  function serve(routes: Record<string, (Response | (() => Response | Promise<Response>))[]>) {
    const seen: Record<string, number> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url}`;
      const answers = routes[key];
      if (!answers) return Response.json({ error: `Unexpected ${key}` }, { status: 500 });
      const i = Math.min(seen[key] ?? 0, answers.length - 1);
      seen[key] = (seen[key] ?? 0) + 1;
      const a = answers[i];
      return typeof a === 'function' ? a() : a.clone();
    }) as unknown as typeof fetch;
  }
  const list = (c: ConnectionView) => Response.json({ connections: [c], orphaned: [], requests: null, max_connections: 3 });

  async function open(ask: ConnectorAsk) {
    let closed = 0;
    const view = await mount(<ConnectorSheet ask={ask} onClose={() => closed++} onChanged={() => {}} />);
    return { ...view, closed: () => closed };
  }

  test('connecting: Cancel then Connect, a refused token said beside it; then Choose accounts’ Cancel then Save, and Done alone', async () => {
    serve({
      'POST /api/connectors/connect': [
        Response.json({ error: 'That token didn’t work.' }, { status: 400 }),
        Response.json({ connection_id: 'conn_1', connection: conn([]), offers: [OFFER] }),
      ],
      'GET /api/connectors': [list(conn([]))],
      'PUT /api/connectors/accounts': [Response.json({ connection: conn([account()]) })],
    });
    const view = await open({ kind: 'connect' });
    expect(footerButtons()).toEqual([
      ['Cancel', 'btn secondary'],
      ['Connect', 'btn'],
    ]);
    expect(button(footer(), 'Connect')!.hasAttribute('disabled')).toBe(true);
    // The token's field stays in the body.
    const field = sheetBody()!.findAll((e) => e.tagName === 'TEXTAREA')[0];
    await act(async () => type(field, 'aHR0cHM6Ly9icmlkZ2UuZXhhbXBsZS9jbGFpbQ=='));
    await settle();
    await press(button(footer(), 'Connect'));
    expectRefused('Connect', 'That token didn’t work.');

    await press(button(footer(), 'Connect'));
    expect(sheet()!.getAttribute('aria-label')).toBe('Choose accounts');
    expect(footerButtons()).toEqual([
      ['Cancel', 'btn secondary'],
      ['Save', 'btn'],
    ]);
    expect(footerNotes().length).toBe(0);
    expect(bodyButtons()).not.toContain('Save');

    await press(button(footer(), 'Save'));
    expect(sheetBody()!.textContent).toContain('Tracking 1 account');
    expect(footerButtons()).toEqual([['Done', 'btn']]);
    expect(bodyButtons()).toEqual([]);
    await press(button(footer(), 'Done'));
    expect(view.closed()).toBe(1);
    await view.unmount();
  });

  test('disconnecting: no footer while it loads; then Cancel then Disconnect, which waits on the name typed in the body', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    serve({ 'GET /api/connectors': [async () => (await held, list(conn([account()])))] });
    const view = await open({ kind: 'disconnect', connection_id: 'conn_1' });
    expect(sheet()!.findAll((e) => classOf(e).includes('spinner')).length).toBe(1);
    expect(footer()).toBeNull();
    release();
    await settle();
    expect(sheet()!.getAttribute('aria-label')).toBe('Disconnect SimpleFIN?');
    expect(footerButtons()).toEqual([
      ['Cancel', 'btn secondary'],
      ['Disconnect', 'btn danger'],
    ]);
    expect(button(footer(), 'Disconnect')!.hasAttribute('disabled')).toBe(true);
    const name = sheetBody()!.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('placeholder') === 'SimpleFIN')[0];
    expect(name).toBeTruthy();
    await act(async () => type(name, 'simplefin'));
    await settle();
    expect(button(footer(), 'Disconnect')!.hasAttribute('disabled')).toBe(false);
    await press(button(footer(), 'Cancel'));
    expect(view.closed()).toBe(1);
    await view.unmount();
  });

  test('owed or held: Later then Save, a refusal said beside Save', async () => {
    serve({
      'GET /api/connectors': [list(conn([account({ account_id: 'manual_card', name: 'Visa', type: 'credit', balance: 300, reported: 300, needs_sign: true })]))],
      'PUT /api/connectors/accounts': [Response.json({ error: 'It couldn’t be saved.' }, { status: 500 })],
    });
    const view = await open({ kind: 'sign', connection_id: 'conn_1' });
    expect(sheet()!.getAttribute('aria-label')).toBe('Owed or held?');
    expect(footerButtons()).toEqual([
      ['Later', 'btn secondary'],
      ['Save', 'btn'],
    ]);
    // Its answer, a radio in the body.
    const radio = sheetBody()!.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'radio')[0];
    const key = Object.keys(radio).find((k) => k.startsWith('__reactProps$'))!;
    await act(async () => (radio as unknown as Record<string, { onChange: () => void }>)[key].onChange());
    await settle();
    expect(button(footer(), 'Save')!.hasAttribute('disabled')).toBe(false);
    await press(button(footer(), 'Save'));
    expectRefused('Save', 'It couldn’t be saved.');
    await view.unmount();
  });

  test('undoing an account carried on: its words in the body, Cancel then Undo carrying it on', async () => {
    const carried = account({ continued: { from: { connector: 'simplefin', name: 'Checking', institution_name: 'Old Bank' }, until: null, matched: 3, added: 2, undoing: false } });
    serve({ 'GET /api/connectors': [list(conn([carried]))] });
    const view = await open({ kind: 'uncarry', connection_id: 'conn_1', account_id: 'manual_a' });
    expect(sheet()!.getAttribute('aria-label')).toBe('Undo carrying Checking on?');
    expect(footerButtons()).toEqual([
      ['Cancel', 'btn secondary'],
      ['Undo carrying it on', 'btn danger'],
    ]);
    expect(bodyButtons()).toEqual([]);
    await view.unmount();
  });
});
