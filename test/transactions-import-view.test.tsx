import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, fakeClock, FakeElement } from './mini-dom';
import { holdDay, HELD_DAY } from './held-day';
import { vanguardCsv } from './vanguard-transactions-csv';
import { vanguardQfx } from './vanguard-transactions-qfx';

holdDay();

// Importing Vanguard's transactions download into investment accounts, as the
// person sees it (components/TransactionsImport.tsx, inside components/
// HistoryImportSheet.tsx): the file known by its layout and sent for the
// server's review, every account in it checked or off with why, one Import
// into every account checked, the list of imports with each one's standing,
// and an Undo that names every account it is undone from and what comes
// back. The sheet is used as a person would (react-dom/client over
// test/mini-dom.ts), with the server stood in for. Every figure and account
// number is made up.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: HistoryImportSheet } = await import('@/components/HistoryImportSheet');
const { importedText } = await import('@/components/InvestmentActivity');
const { TransactionImports, TransactionsNow, undoText } = await import('@/components/TransactionsImport');
const { renderToStaticMarkup } = await import('react-dom/server');
type Target = import('@/components/HistoryImportSheet').HistoryImportTarget;
type ImportsReview = import('@/lib/investment-imports-review').ImportsReview;
type ListedImport = import('@/lib/investment-imports-store').ListedImport;
type TwinShown = import('@/lib/investment-imports-review').TwinShown;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(FakeElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const pass = fakeClock({ now: HELD_DAY });

const words = (text: string) => text.replace(/\s+/g, ' ').replace(/ ([.,:])/g, '$1').trim();

const FILE = vanguardCsv([], [{ account: '11114421', trade: '2026-10-01', type: 'Funds Received', net: 5 }], { noHoldings: true });
const COVERS = { from: '2025-06-01', to: '2026-11-05' };
const takes = (rows: number, now_rows: number, file: number, now: number | null, months: { month: string; now: number | null; file: number }[] = [], twins: TwinShown[] = []) => ({
  kind: 'takes' as const,
  days: [COVERS],
  rows,
  now_rows,
  flows: { file, now },
  savings: { file: 0, now: 0 } as { file: number; now: number | null },
  months,
  twins,
});

/** The server's review: the Individual and the Traditional IRA can be
 *  taken, the Roth has a kind Nya doesn't know, ••8802 isn't one of yours. */
const REVIEW: ImportsReview = {
  fingerprint: 'fp-1',
  source: 'vanguard-csv',
  covers: COVERS,
  stated_end: null,
  after_today: 2,
  sheet_in: true,
  csv: [],
  accounts: [
    {
      mask: '4421',
      lines: 62,
      rows: 61,
      account: { account_id: 'ind', item_id: 'item_vg', name: 'Individual' },
      problem: null,
      effect: takes(61, 58, 36_000, 41_000, [{ month: '2026-01', now: 7000, file: 2000 }], [
        { date: '2026-11-04', file_date: '2026-11-02', name: 'Buy', type: 'buy', subtype: 'buy', amount: 2000 },
      ]),
    },
    {
      mask: '3307',
      lines: 27,
      rows: 0,
      account: { account_id: 'roth', item_id: 'item_vg', name: 'Roth IRA' },
      problem: { why: 'unreadable', detail: { reason: 'unknown-type', type: 'Exchange', line: 40 } },
      effect: null,
    },
    {
      mask: '5519',
      lines: 33,
      rows: 33,
      account: { account_id: 'trad', item_id: 'item_vg', name: 'Traditional IRA' },
      problem: null,
      effect: takes(33, 31, -15_400, 0, [{ month: '2026-03', now: 0, file: -15_400 }]),
    },
    { mask: '8802', lines: 9, rows: 9, account: null, problem: { why: 'not-in-nya' }, effect: null },
  ],
};

const TARGET: Target = {
  account_id: 'ind',
  name: 'Individual ••4421',
  institution_name: 'Vanguard',
  type: 'investment',
  currency: 'USD',
  item_id: 'item_vg',
  vanguard: true,
  balance: 100_000,
  vanguard_balances: [100_000],
};

type Sent = { body: Record<string, unknown> };

async function mount(target: Target, opts: { review?: ImportsReview; refuse?: { status: number; body: unknown } } = {}) {
  const sent: Sent[] = [];
  let stored: ListedImport[] = [];
  let refuse = opts.refuse ?? null;
  const names = { ind: { name: 'Individual', mask: '4421', item_id: 'item_vg' }, trad: { name: 'Traditional IRA', mask: '5519', item_id: 'item_vg' } };
  const listing = () => Response.json({ imports: stored, fingerprint: stored.length ? 'fp-2' : 'fp-1', names });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/investment-imports' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      sent.push({ body });
      if (body.action === 'review') return Response.json({ review: opts.review ?? REVIEW });
      if (body.action === 'import') {
        if (refuse) {
          const r = refuse;
          refuse = null;
          return Response.json(r.body, { status: r.status });
        }
        stored = [
          {
            import_id: 'imp-1',
            source: (opts.review ?? REVIEW).source,
            file_name: body.file_name,
            imported_at: HELD_DAY.toISOString(),
            covers: COVERS,
            currency: 'USD',
            rows: 61,
            accounts: body.take.map((t: { account_id: string }) => t.account_id),
          },
        ];
        return listing();
      }
      stored = stored.filter((i) => i.import_id !== body.import_id);
      return listing();
    }
    if (url.startsWith('/api/investment-imports')) return listing();
    if (url.startsWith('/api/investment-months')) return Response.json({ investment_months: null });
    if (url.startsWith('/api/account-history')) return Response.json({ points: [] });
    if (url.startsWith('/api/investment-activity'))
      return Response.json({
        txns: [],
        ytd_contributions: 0,
        ytd_rollovers: 0,
        flows: [],
        flows_from: '2025-01-01',
        flows_to: '2026-11-05',
        moves: [],
        note: null,
        imported_days: stored.map((i) => ({ import_id: i.import_id, ...i.covers, file_name: i.file_name, imported_at: i.imported_at })),
        imports_unused: [],
      });
    if (url.startsWith('/api/history-import')) return Response.json({ imports: [], settings: null, bank_from: null, history_pending: false, walked: true, reach: null });
    return Response.json({ error: 'Unexpected' }, { status: 500 });
  }) as unknown as typeof fetch;
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const imported: unknown[] = [];
  act(() => root.render(<HistoryImportSheet target={target} onClose={() => {}} onImported={(what) => imported.push(what)} />));
  await pass(20);
  const checkRow = (title: string) => host.findAll((e) => e.tagName === 'LABEL' && e.getAttribute('class') === 'check-row' && e.textContent.startsWith(title))[0];
  const box = (title: string) => checkRow(title).findAll((e) => e.tagName === 'INPUT')[0] as unknown as { checked: boolean; getAttribute: (k: string) => string | null };
  const button = (label: string) => host.findAll((e) => e.tagName === 'BUTTON' && (e.getAttribute('aria-label') ?? e.textContent.trim()) === label)[0] ?? null;
  return {
    sent,
    imported,
    button,
    box,
    text: () => words(host.textContent),
    choose: async (name: string, text = FILE) => {
      const bytes = new TextEncoder().encode(text);
      const input = host.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'file')[0];
      const key = Object.keys(input).find((k) => k.startsWith('__reactProps$'))!;
      const file = { name, size: bytes.length, slice: (a?: number, b?: number) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }), arrayBuffer: async () => bytes.slice().buffer };
      await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { files: [file] } }));
      await pass(20);
    },
    press: async (label: string) => {
      await act(async () => click(button(label)));
      await pass(20);
    },
    toggle: (title: string, on: boolean) => {
      const input = checkRow(title).findAll((e) => e.tagName === 'INPUT')[0];
      const key = Object.keys(input).find((k) => k.startsWith('__reactProps$'))!;
      act(() => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { checked: on } }));
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe('the sheet', () => {
  test('a Vanguard account: the download reviewed, imported into every account checked, listed, and undone from all of them', async () => {
    const v = await mount(TARGET);
    expect(v.text()).toContain('Vanguard’s transactions download: CSV, OFX or QFX');
    await v.choose('OfxDownload.csv');
    expect(v.sent[0].body).toEqual({ action: 'review', account_id: 'ind', file_name: 'OfxDownload.csv', text: FILE, today: '2026-11-06' });

    expect(v.text()).toContain('OfxDownload.csv · Vanguard’s transactions download');
    expect(v.text()).toContain('131 transactions in 4 accounts, Jun 1, 2025 to yesterday');
    expect(v.box('Individual ••4421').checked).toBe(true);
    expect(v.box('Traditional IRA ••5519').checked).toBe(true);
    expect(v.box('Roth IRA ••3307').checked).toBe(false);
    expect(v.box('Roth IRA ••3307').getAttribute('disabled')).not.toBeNull();
    expect(v.text()).toContain('61 transactions, in place of the 58 there now. Deposits & withdrawals +$36,000.00, now +$41,000.00.');
    expect(v.text()).toContain('Can’t be imported: one of its 27 transactions is “Exchange”, a kind Nya doesn’t know yet.');
    expect(v.text()).toContain('Roth IRA ••3307’s transactions can’t be imported');
    expect(v.text()).toContain('The file’s 9 transactions for ••8802 are left out: it isn’t one of your Vanguard accounts in Nya.');
    expect(v.text()).toContain('The file’s 2 transactions from today are left out');
    expect(v.text()).toContain('Where deposits & withdrawals change');
    expect(v.text()).toContain('Individual, Jan 2026');
    expect(v.text()).toContain('Traditional IRA, Mar 2026');
    expect(v.text()).toContain('Individual ••4421: Vanguard gave Nya a buy of $2,000.00 on Nov 4 that the file lists on Nov 2, so it counts once, as the file’s.');
    expect(v.button('Import 94 transactions into 2 accounts')).not.toBeNull();

    // Unchecked, it isn't taken, and its months go from the table.
    v.toggle('Traditional IRA ••5519', false);
    expect(v.button('Import 61 transactions into 1 account')).not.toBeNull();
    expect(v.text()).not.toContain('Traditional IRA, Mar 2026');
    v.toggle('Traditional IRA ••5519', true);

    await v.press('Import 94 transactions into 2 accounts');
    expect(v.sent[1].body).toEqual({
      action: 'import',
      account_id: 'ind',
      file_name: 'OfxDownload.csv',
      text: FILE,
      today: '2026-11-06',
      take: [
        { account_id: 'ind', mask: '4421' },
        { account_id: 'trad', mask: '5519' },
      ],
      counting: 'fp-1',
    });
    expect(v.imported).toEqual([{ investments: true }]);
    expect(v.text()).toContain('94 transactions imported into 2 accounts from OfxDownload.csv.');
    expect(v.text()).toContain('Jun 1, 2025 to yesterday, from Vanguard’s transactions download');
    expect(v.text()).toContain('Past imports into Individual ••4421');
    expect(v.text()).toContain('Imported today · 61 transactions, and into 1 other account · Jun 1, 2025 to yesterday Counts');

    await v.press('Undo the import from today');
    expect(v.text()).toContain(
      'Undo the import from today? It went into Individual ••4421 and Traditional IRA ••5519, and is undone from both. In Individual ••4421, Jun 1, 2025 to yesterday will come from what Vanguard gave Nya again; in the other, its days will come from another import that covers them, or from what Vanguard gave Nya, again. Nothing else changes, and you can import the file again later.'
    );
    await v.press('Undo import');
    expect(v.sent[2].body).toEqual({ action: 'undo', account_id: 'ind', import_id: 'imp-1' });
    expect(v.imported).toEqual([{ investments: true }, { investments: true }]);
    expect(v.text()).toContain('Undone: the import of OfxDownload.csv from today, from 2 accounts.');
    expect(v.text()).not.toContain('Past imports into');
    v.unmount();
  });

  test('changed on another device while it was checked: asked to check it again, and the Import waits', async () => {
    const v = await mount({ ...TARGET, account_id: 'ind2' }, { refuse: { status: 409, body: { error: 'The imports changed on another device while you checked this file. Check it again against what’s here now before importing it.', needs: 'review' } } });
    await v.choose('OfxDownload.csv');
    v.toggle('Traditional IRA ••5519', false);
    await v.press('Import 61 transactions into 1 account');
    expect(v.text()).toContain('The imports changed on another device');
    expect(v.button('Import 61 transactions into 1 account')!.getAttribute('disabled')).not.toBeNull();
    await v.press('Check the file again');
    expect(v.sent.map((s) => s.body.action)).toEqual(['review', 'import', 'review']);
    // Checked again, what the person unchecked stays unchecked.
    expect(v.box('Traditional IRA ••5519').checked).toBe(false);
    expect(v.button('Import 61 transactions into 1 account')!.getAttribute('disabled')).toBeNull();
    v.unmount();
  });

  test('none of the file’s accounts is yours: said where the file is chosen, nothing to review', async () => {
    const review: ImportsReview = { ...REVIEW, accounts: [{ mask: '8802', lines: 9, rows: 9, account: null, problem: { why: 'not-in-nya' }, effect: null }, { mask: '1150', lines: 2, rows: 2, account: null, problem: { why: 'not-in-nya' }, effect: null }] };
    const v = await mount({ ...TARGET, account_id: 'ind3' }, { review });
    await v.choose('OfxDownload.csv');
    expect(v.text()).toContain('None of this file’s accounts (••8802 and ••1150) is one of your Vanguard accounts in Nya, so nothing can be imported. Download it from the Vanguard login Individual ••4421 is in.');
    expect(v.text()).toContain('File to import into Individual ••4421');
    v.unmount();
  });

  test('an account at another firm: the download refused, never read as some other CSV', async () => {
    const v = await mount({ ...TARGET, account_id: 'fid', name: 'Brokerage ••7710', institution_name: 'Fidelity', vanguard: false });
    await v.choose('OfxDownload.csv');
    expect(v.text()).toContain('This is Vanguard’s transactions download, and Brokerage ••7710 is at Fidelity. Import it from one of your Vanguard accounts.');
    expect(v.sent).toEqual([]);
    v.unmount();
  });

  test('an account at Vanguard it can’t go into (one that ended, opened from Accounts that ended): said so, not that it is at another firm', async () => {
    const v = await mount({ account_id: 'gone', name: 'Old IRA', institution_name: 'Vanguard', type: 'investment', currency: null });
    await v.choose('OfxDownload.csv');
    expect(v.text()).toContain('This is Vanguard’s transactions download, which Nya imports only into the Vanguard investment accounts it’s connected to, and Old IRA isn’t one. Import it from one of those.');
    expect(v.sent).toEqual([]);
    v.unmount();
  });
});

describe('the download as QFX', () => {
  const QFX_FILE = vanguardQfx([{ number: '11114421', txns: [{ kind: 'bank', posted: '2026-01-05', amount: 2000 }] }], { start: '2025-05-13', end: '2026-11-06' });
  const QFX_COVERS = { from: '2025-05-13', to: '2026-11-05' };
  const ind = { account_id: 'ind', item_id: 'item_vg', name: 'Individual' };
  const trad = { account_id: 'trad', item_id: 'item_vg', name: 'Traditional IRA' };
  const effect = (days: { from: string; to: string }[], ...args: Parameters<typeof takes>) => ({ ...takes(...args), days });
  /** Made today: the Individual's January isn't what counts now, and its
   *  May 2025 is before Nya's activity (nothing to differ from). */
  const QFX_REVIEW: ImportsReview = {
    ...REVIEW,
    source: 'vanguard-qfx',
    covers: QFX_COVERS,
    stated_end: '2026-11-06',
    after_today: 1,
    accounts: [
      { mask: '4421', lines: 60, rows: 60, account: ind, problem: null, effect: effect([QFX_COVERS], 60, 59, 36_000, 41_000, [{ month: '2025-05', now: null, file: 500 }, { month: '2026-01', now: 7000, file: 2000 }]) },
      { mask: '5519', lines: 28, rows: 28, account: trad, problem: null, effect: effect([QFX_COVERS], 28, 31, 0, 0) },
    ],
  };
  const CSV_IMPORT = { import_id: 'csv-1', file_name: 'OfxDownload.csv', imported_at: '2026-11-05T12:00:00.000Z', covers: { from: '2025-06-01', to: '2026-11-04' }, masks: ['4421', '5519'] };

  test('it differs from what counts now: said with the months, and the Import waits for a yes', async () => {
    const v = await mount({ ...TARGET, account_id: 'q1' }, { review: QFX_REVIEW });
    await v.choose('OfxDownload.qfx', QFX_FILE);
    expect(v.sent[0].body).toMatchObject({ action: 'review', file_name: 'OfxDownload.qfx', text: QFX_FILE });
    expect(v.text()).toContain('OfxDownload.qfx · Vanguard’s transactions download, as QFX');
    expect(v.text()).toContain('The file says it runs to today, the day it was made, which wasn’t over then, so it counts to yesterday. Its 1 transaction from that day is left out.');
    expect(v.text()).not.toContain('from today is left out');
    expect(v.text()).toContain(
      'In Jan 2026 this file’s deposits and withdrawals for Individual ••4421 aren’t what Nya counts now. A QFX file leaves out conversions and shares moved in kind, so it may be the one that’s wrong. Vanguard’s CSV download has them: import that instead if you can.'
    );
    expect(v.text()).toContain('MonthNowThis fileIndividual, Jan 2026+$7,000.00+$2,000.00');
    // Before Nya's activity there is nothing to differ from, and a CSV's table isn't shown.
    expect(v.text()).not.toContain('May 2025');
    expect(v.text()).not.toContain('Where deposits & withdrawals change');
    expect(v.text()).toContain('Use this file anywayIts transactions will count for May 13, 2025 to yesterday.');
    expect(v.text()).toContain('A QFX file doesn’t say whether money in was a contribution or a rollover, so none of it counts as new savings in your Plan.');
    expect(v.text()).toContain('Vanguard’s QFX file is the same download as its CSV');
    const importing = () => v.button('Import 88 transactions into 2 accounts')!;
    expect(importing().getAttribute('disabled')).not.toBeNull();
    v.toggle('Use this file anyway', true);
    expect(importing().getAttribute('disabled')).toBeNull();
    v.toggle('Use this file anyway', false);
    // Without the account that differs, nothing waits.
    v.toggle('Individual ••4421', false);
    expect(v.text()).not.toContain('aren’t what Nya counts now');
    expect(v.button('Import 28 transactions into 1 account')!.getAttribute('disabled')).toBeNull();
    v.toggle('Individual ••4421', true);
    v.toggle('Use this file anyway', true);
    await v.press('Import 88 transactions into 2 accounts');
    expect(v.sent[1].body).toMatchObject({ action: 'import', file_name: 'OfxDownload.qfx', text: QFX_FILE, take: [{ account_id: 'ind', mask: '4421' }, { account_id: 'trad', mask: '5519' }] });
    expect(v.text()).toContain('88 transactions imported into 2 accounts from OfxDownload.qfx.');
    v.unmount();
  });

  test('a CSV import decides some of its days, or all of them: said, and each account’s transactions that count', async () => {
    const part = [
      { from: '2025-05-13', to: '2025-05-31' },
      { from: '2026-11-05', to: '2026-11-05' },
    ];
    const some: ImportsReview = {
      ...QFX_REVIEW,
      csv: [CSV_IMPORT],
      accounts: [
        { ...QFX_REVIEW.accounts[0], effect: effect(part, 3, 2, 0, 0) },
        { ...QFX_REVIEW.accounts[1], effect: effect(part, 1, 1, 0, 0) },
      ],
    };
    const v = await mount({ ...TARGET, account_id: 'q2' }, { review: some });
    await v.choose('OfxDownload.qfx', QFX_FILE);
    expect(v.text()).toMatch(
      /OfxDownload\.csv, imported [^,]+, covers Jun 1, 2025 to Nov 4\. A CSV decides the days it covers, since it has what a QFX leaves out, so this file counts only for May 13, 2025 to May 31, 2025 and yesterday\./
    );
    expect(v.text()).toContain('3 of its 60 transactions count, in place of the 2 there now.');
    expect(v.text()).toContain('1 of its 28 transactions counts, in place of the 1 there now.');
    v.unmount();

    const all: ImportsReview = {
      ...QFX_REVIEW,
      csv: [CSV_IMPORT],
      accounts: QFX_REVIEW.accounts.map((a) => ({ ...a, effect: effect([], 0, 0, 0, null) })),
    };
    const w = await mount({ ...TARGET, account_id: 'q3' }, { review: all });
    await w.choose('OfxDownload.qfx', QFX_FILE);
    expect(w.text()).toMatch(/OfxDownload\.csv, imported [^,]+, covers all of this file’s days, and a CSV decides the days it covers, since it has what a QFX leaves out, so none of this file would count now\. It would if that import were undone\./);
    expect(w.text()).toContain('None of its 60 transactions would count now.');
    expect(w.text()).not.toContain('A QFX file doesn’t say whether money in was');
    // It can still be imported, for when the CSV is undone.
    expect(w.button('Import 88 transactions into 2 accounts')!.getAttribute('disabled')).toBeNull();
    w.unmount();
  });

  test('on an account at another firm: refused like the CSV', async () => {
    const v = await mount({ ...TARGET, account_id: 'fid2', name: 'Brokerage ••7710', institution_name: 'Fidelity', vanguard: false });
    await v.choose('OfxDownload.qfx', QFX_FILE);
    expect(v.text()).toContain('This is Vanguard’s transactions download, and Brokerage ••7710 is at Fidelity. Import it from one of your Vanguard accounts.');
    expect(v.sent).toEqual([]);
    v.unmount();
  });

  test('once imported, one a CSV outranks says so', () => {
    const at = { covers: { from: '2025-06-01', to: '2026-11-04' }, currency: 'USD', rows: 10, accounts: ['ind'], imported_at: '2026-11-05T12:00:00.000Z' };
    const list = {
      imports: [
        { ...at, import_id: 'qfx-1', source: 'vanguard-qfx' as const, file_name: 'OfxDownload.qfx' },
        { ...at, import_id: 'csv-1', source: 'vanguard-csv' as const, file_name: 'OfxDownload.csv' },
      ],
      fingerprint: 'fp-3',
      names: {},
    };
    const activity = { imported_days: [{ import_id: 'csv-1', ...at.covers, file_name: 'OfxDownload.csv', imported_at: at.imported_at }], imports_unused: [] } as unknown as Parameters<typeof TransactionImports>[0]['activity'];
    const shown = words(renderToStaticMarkup(<TransactionImports name="Individual ••4421" list={list} activity={activity} busy={false} onUndo={async () => true} />).replace(/<[^>]+>/g, ' '));
    expect(shown).toContain('· a CSV import decides its days Doesn’t count');
    // Undoing the CSV hands its days to the QFX, which was never checked against them: said.
    expect(undoText(list.imports[1], list, activity, 'Individual ••4421')).toMatch(
      /^Undo the import from [^?]+\? Jun 1, 2025 to Nov 4 will come from the QFX import from [^.]+ again\. A QFX file leaves out conversions and shares moved in kind, and none of its money in counts as new savings\. Nothing else changes/
    );
    // Decided partly by a CSV and partly by a newer QFX: neither named alone.
    const mixed = {
      ...list,
      imports: [{ ...list.imports[0], import_id: 'qfx-2' }, ...list.imports.map((i) => (i.import_id === 'csv-1' ? { ...i, covers: { from: '2025-06-01', to: '2025-12-31' } } : i))],
    };
    const split = {
      imported_days: [
        { import_id: 'csv-1', from: '2025-06-01', to: '2025-12-31', file_name: 'OfxDownload.csv', imported_at: at.imported_at },
        { import_id: 'qfx-2', from: '2026-01-01', to: '2026-11-04', file_name: 'OfxDownload.qfx', imported_at: at.imported_at },
      ],
      imports_unused: [],
    } as unknown as Parameters<typeof TransactionImports>[0]['activity'];
    const shownMixed = words(renderToStaticMarkup(<TransactionImports name="Individual ••4421" list={mixed} activity={split} busy={false} onUndo={async () => true} />).replace(/<[^>]+>/g, ' '));
    expect(shownMixed).toContain('· other imports decide its days Doesn’t count');
  });

  test('only its new savings fall: said with the figures, and the Import waits for a yes, asked again when the accounts checked change or the file is chosen again', async () => {
    const savingsOnly: ImportsReview = {
      ...QFX_REVIEW,
      accounts: [
        { ...QFX_REVIEW.accounts[0], effect: { ...effect([QFX_COVERS], 60, 59, 36_000, 36_000), savings: { file: 0, now: 4000 } } },
        QFX_REVIEW.accounts[1],
      ],
    };
    const v = await mount({ ...TARGET, account_id: 'q4' }, { review: savingsOnly });
    await v.choose('OfxDownload.qfx', QFX_FILE);
    expect(v.text()).toContain(
      'With this file, the new savings your Plan counts in its days would fall from +$4,000.00 to $0.00 in Individual ••4421: a QFX file doesn’t say whether money in was a contribution or a rollover. Vanguard’s CSV download says which: import that instead if you can.'
    );
    expect(v.text()).not.toContain('This file+');
    expect(v.text()).not.toContain('A QFX file doesn’t say whether money in was a contribution or a rollover, so none of it counts');
    const importing = () => v.button('Import 88 transactions into 2 accounts')!;
    expect(importing().getAttribute('disabled')).not.toBeNull();
    v.toggle('Use this file anyway', true);
    expect(importing().getAttribute('disabled')).toBeNull();
    // Another account checked or unchecked: the yes is asked again.
    v.toggle('Traditional IRA ••5519', false);
    v.toggle('Traditional IRA ••5519', true);
    expect(v.box('Use this file anyway').checked).toBe(false);
    expect(importing().getAttribute('disabled')).not.toBeNull();
    v.toggle('Use this file anyway', true);
    await v.press('Cancel');
    await v.choose('OfxDownload.qfx', QFX_FILE);
    expect(v.box('Use this file anyway').checked).toBe(false);
    v.unmount();
  });
});

describe('the sheet’s top', () => {
  test('the days downloads decide, each run apart: the days between are Vanguard’s', () => {
    const at = (import_id: string, from: string, to: string) => ({ import_id, from, to, file_name: 'OfxDownload.csv', imported_at: '2026-11-06T12:00:00.000Z' });
    const activity = (days: ReturnType<typeof at>[]) => ({ imported_days: days }) as unknown as Parameters<typeof TransactionsNow>[0]['activity'];
    const top = (days: ReturnType<typeof at>[]) => words(renderToStaticMarkup(<TransactionsNow name="Individual ••4421" activity={activity(days)} />).replace(/<[^>]+>/g, ' '));
    expect(top([at('old', '2025-01-01', '2025-03-31'), at('new', '2026-01-01', '2026-08-31')])).toContain('Jan 1, 2025 to Mar 31, 2025 and Jan 1 to Aug 31, from Vanguard’s transactions downloads');
    // Two that meet are one run.
    expect(top([at('old', '2025-01-01', '2025-03-31'), at('new', '2025-04-01', '2025-08-31')])).toContain('Jan 1, 2025 to Aug 31, 2025, from Vanguard’s transactions downloads');
  });
});

describe('the activity list', () => {
  test('says which days come from which file, and where to undo it', () => {
    expect(importedText([{ import_id: 'imp-1', from: '2025-06-01', to: '2026-11-05', file_name: 'OfxDownload.csv', imported_at: '2026-11-06T12:00:00.000Z' }])).toBe(
      'Jun 1, 2025 to yesterday come from OfxDownload.csv, imported today. To undo it: ⋯, Import history from a file.'
    );
    expect(
      importedText([
        { import_id: 'old', from: '2025-02-03', to: '2025-05-31', file_name: null, imported_at: '2025-08-03T12:00:00.000Z' },
        { import_id: 'new', from: '2025-06-01', to: '2026-11-05', file_name: 'OfxDownload.csv', imported_at: '2026-11-06T12:00:00.000Z' },
      ])
    ).toBe('Feb 3, 2025 to May 31, 2025 come from Vanguard’s transactions download, imported Aug 3, 2025; Jun 1, 2025 to yesterday come from OfxDownload.csv, imported today. To undo one: ⋯, Import history from a file.');
  });
});
