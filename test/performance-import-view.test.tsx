import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, FakeElement } from './mini-dom';
import { holdDay, HELD_DAY } from './held-day';
import { makeMonths, type MonthFigures } from './vanguard-performance-pdf';
import { readOf, RANGE } from './performance-read';

holdDay();

// Importing Vanguard's Performance page into an investment account, as the
// person sees it (components/PerformanceImport.tsx, inside components/
// HistoryImportSheet.tsx): the review for each thing it can find in a file,
// the list of imports with each Undo's words, and the sheet used as a person
// would (react-dom/client over test/mini-dom.ts), with a stand-in for pdf.js
// and what it sends. Every figure is made up (test/vanguard-performance-pdf.ts).

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
const { renderToStaticMarkup } = await import('react-dom/server');
const { PerformanceReview, PerformanceImports, usePerformanceData, usePerformanceReview } = await import('@/components/PerformanceImport');
const { default: HistoryImportSheet } = await import('@/components/HistoryImportSheet');
const { formatMoney } = await import('@/lib/format');
type ReviewContext = import('@/components/PerformanceImport').ReviewContext;
type ReviewState = import('@/components/PerformanceImport').ReviewState;
type Read = import('@/lib/import/performance-review').Read;
type MonthsImport = import('@/lib/investment-months').MonthsImport;
type PdfReader = import('@/components/PerformanceImport').PdfReader;
type Target = import('@/components/HistoryImportSheet').HistoryImportTarget;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(FakeElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const pass = fakeClock({ now: HELD_DAY });

// The file: Jan 2024 to Nov 5, 2026 (today is Nov 6), so Nov 2026 isn't
// whole. Nya recorded the account's balance from Jul 1, 2026 (each month's
// end on the next 1st, and Nov 5's), and has its activity from then.
const MONTHS = makeMonths(RANGE.from, RANGE.to);
const dollars = (c: number) => c / 100;
const LAST = dollars(MONTHS[MONTHS.length - 1].end);
const after = (m: string) => (m.slice(5) === '12' ? `${Number(m.slice(0, 4)) + 1}-01` : `${m.slice(0, 4)}-${String(Number(m.slice(5)) + 1).padStart(2, '0')}`);
const POINTS = [
  { date: '2026-06-01', value: 1, estimated: true },
  ...MONTHS.filter((m) => m.month >= '2026-06' && m.month <= '2026-10').map((m) => ({ date: `${after(m.month)}-01`, value: dollars(m.end) })),
  { date: '2026-11-05', value: LAST },
];
const flowsOf = (ms: MonthFigures[]) => ms.filter((m) => m.month >= '2026-07' && m.net !== 0).map((m) => ({ date: `${m.month}-15`, amount: dollars(m.net) }));
const ACTIVITY = { flows: flowsOf(MONTHS), flows_from: '2026-07-01', flows_to: '2026-11-05', moves: [] };
// Totals the person set, which stand for all time instead of the months.
const SET = { ...ACTIVITY, money_in_out: { in: 60_000, out: 0, as_of: '2026-10-15', currency: 'USD', set_at: '2026-11-01T00:00:00.000Z' } };

const ctx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
  account_id: 'acc_vg',
  name: 'Individual',
  currency: 'USD',
  balance: LAST,
  vanguard: [LAST],
  imports: null,
  points: POINTS,
  activity: ACTIVITY,
  today: '2026-11-06',
  ...over,
});

const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,:])/g, '$1')
    .trim();

/** The review of `read` as markup, and its state. */
function review(read: Read, c: ReviewContext = ctx()) {
  let state: ReviewState | null = null;
  function Review() {
    const s = usePerformanceReview(read, c, 'Performance.pdf');
    state = s;
    return <PerformanceReview state={s} ctx={c} fileName="Performance.pdf" onAgain={() => {}} />;
  }
  const html = renderToStaticMarkup(<Review />);
  return { html, text: words(html), state: state! as ReviewState };
}

const anImport = (over: Partial<MonthsImport> = {}): MonthsImport => {
  const r = review(readOf(MONTHS)).state.review!.importable!;
  return {
    id: 'imp-1',
    source: 'vanguard-performance',
    file_name: 'Performance.pdf',
    imported_at: '2026-11-06T12:00:00.000Z',
    start: r.start,
    months: r.months,
    currency: 'USD',
    ...over,
  };
};

describe('the review', () => {
  test('a file that adds up and is the account’s: its months, how far back they reach, and Import', () => {
    const r = review(readOf(MONTHS));
    expect(r.text).toContain('Performance.pdf · Vanguard’s Performance page');
    expect(r.text).toContain('34 months, Jan 2024 to Oct 2026');
    expect(r.text).toContain('Every month adds up, and so does the page’s total. Nov 2026 is left out until it ends.');
    expect(r.text).toContain(`Its balance yesterday, ${formatMoney(LAST, 'USD')}, is Individual’s.`);
    expect(r.text).toContain('The chart and your returns will reach back to Jan 2024. Where Nya has its own balances (from Jul 1) and activity (from Jul 1), those count.');
    expect(r.text).toContain('The months, newest first');
    expect(r.text).toContain('Show all 34 months');
    expect(r.html).not.toContain('notice critical');
    expect(r.html).not.toContain('notice caution');
    expect(r.state.body).toMatchObject({ action: 'import', account_id: 'acc_vg', file_name: 'Performance.pdf', start: { month: '2024-01', balance: 0 }, typed: [], counting: null });
    expect(r.state.body!.months.length).toBe(34);
  });

  test('a figure read wrong: the months that don’t add up, each with its fields and the sum', () => {
    const bad = MONTHS.find((m) => m.month === '2025-03')!;
    const next = MONTHS.find((m) => m.month === '2025-04')!;
    const read = readOf(MONTHS, { figures: { '2025-03': { end: bad.end + 9_000 } }, failed: { '2025-03': ['adds-up'], '2025-04': ['begins-at-last-end'] } });
    const r = review(read);
    expect(r.text).toContain('2 months don’t add up, so nothing can be imported yet.');
    expect(r.html.match(/<fieldset/g)!.length).toBe(2);
    const sum = formatMoney(dollars(bad.begin + bad.net + bad.returns), 'USD');
    expect(r.text).toContain(`is ${sum}, not ${formatMoney(dollars(bad.end + 9_000), 'USD')}. Apr 2025 began at ${formatMoney(dollars(next.begin), 'USD')}.`);
    expect(r.state.body).toBeNull();
    expect(r.html).not.toContain('The months, newest first');
  });

  test('balances far from the account’s: maybe another account’s, imported only on a yes', () => {
    const half = POINTS.map((p) => ({ ...p, value: p.value / 2 }));
    const r = review(readOf(MONTHS), ctx({ points: half, balance: LAST / 2, vanguard: [LAST / 2, LAST / 5] }));
    expect(r.text).toContain(`This file may be for another account: its balance yesterday is ${formatMoney(LAST, 'USD')}, and Individual’s is ${formatMoney(LAST / 2, 'USD')}.`);
    expect(r.text).toContain('It’s Individual’s Import it for this account anyway.');
    expect(r.state.body).toBeNull();
  });

  test('every Vanguard account together: never imported, and another file asked for', () => {
    const r = review(readOf(MONTHS), ctx({ points: null, balance: LAST * 0.3, vanguard: [LAST * 0.3, LAST * 0.7] }));
    expect(r.html).toContain('notice critical');
    expect(r.text).toContain(
      `This file is for all your Vanguard accounts together: its balance yesterday, ${formatMoney(LAST, 'USD')}, is what they hold between them, not Individual’s ${formatMoney(LAST * 0.3, 'USD')}. On Vanguard’s Performance page, choose Individual alone, print the page again, and choose that file.`
    );
    expect(r.text).toContain('Choose another file');
    expect(r.state.body).toBeNull();
  });

  test('a file that starts later than the one that counts: what would stop counting, imported only on a yes', () => {
    const older = makeMonths('2020-01-01', '2026-10-31');
    const counting = anImport({ start: { month: '2020-01', balance: 0 }, months: older.map((m) => ({ month: m.month, net: dollars(m.net), returns: dollars(m.returns), end: dollars(m.end) })) });
    const r = review(readOf(MONTHS), ctx({ imports: { imports: [counting] } }));
    expect(r.text).toContain(
      'Jan 2020 to Dec 2023 would stop counting: this file starts in Jan 2024, and only the newest import counts. To keep them, print Vanguard’s page from Jan 2020, when the account opened.'
    );
    // The months that count start at $0.00, when the account opened, so all
    // time counts from them; this file's start at $0.00 too, in Jan 2024.
    expect(r.text).toContain('Use this file’s months only All time would count from Jan 2024, not from when the account opened.');
    expect(r.state.body).toBeNull();
    // A file from a balance gives no all time of its own.
    const fromBalance = review(readOf(makeMonths(RANGE.from, RANGE.to, { startBalance: 2_500_000 })), ctx({ imports: { imports: [counting] } }));
    expect(fromBalance.text).toContain(
      'Use this file’s months only Before Jan 2024, the chart and your returns would come from Nya’s own records again, and all time would need your deposits and withdrawals.'
    );
    // With totals set, or ones that can't be read, all time doesn't come
    // from the months either way.
    for (const activity of [SET, { ...ACTIVITY, money_in_out_unreadable: true }]) {
      expect(review(readOf(MONTHS), ctx({ imports: { imports: [counting] }, activity })).text).toContain(
        'Use this file’s months only Before Jan 2024, the chart and your returns would come from Nya’s own records again.'
      );
    }
  });

  test('a file with no day to compare with the account’s balances: said, imported only on a yes', () => {
    const r = review(readOf(MONTHS), ctx({ points: null, balance: null }));
    expect(r.html).toContain('notice caution');
    expect(r.text).toContain('Nya can’t tell whether this file is Individual’s: it has no balance of the account’s on a day the file has. It’s Individual’s');
    expect(r.text).toContain('It’s Individual’s Import it for this account anyway.');
    expect(r.state.body).toBeNull();
    // With a balance now, a newer file is how to have it checked.
    const old = review(readOf(MONTHS), ctx({ points: null, today: '2026-12-20' }));
    expect(old.text).toContain('on a day the file has. A file printed up to today is checked against the balance now.');
  });

  test('an oldest beginning balance that couldn’t be read: nothing to correct, another file asked for', () => {
    const r = review(readOf(MONTHS, { figures: { '2024-01': { begin: null } }, failed: { '2024-01': ['cells'] } }));
    expect(r.html).toContain('notice critical');
    expect(r.text).toContain('Jan 2024’s beginning balance couldn’t be read, so this file can’t be checked. Print Vanguard’s page again and choose that file.');
    expect(r.text).toContain('Choose another file');
    expect(r.html).not.toContain('<fieldset');
    expect(r.text).not.toContain('don’t add up');
    expect(r.state.body).toBeNull();
  });

  test('a file inside the one that counts: the months at both ends that would stop counting', () => {
    const older = makeMonths('2020-01-01', '2026-10-31');
    const counting = anImport({ start: { month: '2020-01', balance: 0 }, months: older.map((m) => ({ month: m.month, net: dollars(m.net), returns: dollars(m.returns), end: dollars(m.end) })) });
    const inside = makeMonths('2024-01-01', '2025-12-31');
    const r = review(readOf(inside, { range: { from: '2024-01-01', to: '2025-12-31' } }), ctx({ imports: { imports: [counting] } }));
    expect(r.text).toContain(
      'Jan 2020 to Dec 2023 and Jan 2026 to Oct 2026 would stop counting: this file runs from Jan 2024 to Dec 2025, and only the newest import counts. To keep them, print Vanguard’s page from Jan 2020, when the account opened, up to today.'
    );
    // This file ends before Nya's activity starts, so none of it would be
    // used, and all time would have nothing to count from.
    expect(r.text).toContain(
      'Use this file’s months only Before Jan 2024 and after Dec 2025, the chart and your returns would come from Nya’s own records again, and all time would need your deposits and withdrawals.'
    );
    const set = review(readOf(inside, { range: { from: '2024-01-01', to: '2025-12-31' } }), ctx({ imports: { imports: [counting] }, activity: SET }));
    expect(set.text).toContain('Use this file’s months only Before Jan 2024 and after Dec 2025, the chart and your returns would come from Nya’s own records again.');
  });

  test('a file from $0.00 with empty months before the one that counts: nothing would stop counting', () => {
    // Printed from Jan 2023, a year before the account opened in Jan 2024.
    const empty = ['2023-01', '2023-02', '2023-03', '2023-04', '2023-05', '2023-06', '2023-07', '2023-08', '2023-09', '2023-10', '2023-11', '2023-12'].map((month) => ({ month, net: 0, returns: 0, end: 0 }));
    const counting = anImport({ start: { month: '2023-01', balance: 0 }, months: [...empty, ...anImport().months] });
    const r = review(readOf(MONTHS), ctx({ imports: { imports: [counting] } }));
    expect(r.text).not.toContain('would stop counting');
    expect(r.text).toContain('The chart and your returns will reach back to Jan 2024.');
  });

  test('months Nya has activity for whose deposits and withdrawals differ: listed, and Nya’s kept', () => {
    const flows = ACTIVITY.flows.map((f) => (f.date === '2026-08-15' ? { ...f, amount: f.amount + 500 } : f));
    const r = review(readOf(MONTHS), ctx({ activity: { ...ACTIVITY, flows } }));
    expect(r.text).toContain('In 1 month Nya has activity for, Vanguard’s deposits and withdrawals aren’t Nya’s. Nya keeps its own for those months, so importing doesn’t change them.');
    expect(r.text).toContain('Aug 2026');
    expect(r.state.body).not.toBeNull();
  });

  test('months that end before Nya’s activity starts: imported, but said not to be used', () => {
    const early = makeMonths('2024-01-01', '2025-12-31');
    const read = readOf(early, { range: { from: '2024-01-01', to: '2025-12-31' } });
    const r = review(read, ctx({ points: POINTS, balance: LAST, vanguard: [LAST] }));
    expect(r.text).toContain('These months wouldn’t be used now: Nya’s activity for this account starts Jul 1, and they end in Dec 2025, so nothing covers the days between. A newer Performance page would be. You can still import them.');
  });
});

describe('the imports', () => {
  const mount = (imports: MonthsImport[], activity: typeof ACTIVITY = ACTIVITY) => {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const undone: string[] = [];
    act(() =>
      root.render(
        <PerformanceImports
          name="Individual"
          imports={{ imports }}
          points={POINTS}
          activity={activity}
          currency="USD"
          busy={false}
          onUndo={async (i) => {
            undone.push(i.id);
            return true;
          }}
        />
      )
    );
    const button = (label: string) => host.findAll((e) => e.tagName === 'BUTTON' && (e.getAttribute('aria-label') ?? e.textContent.trim()) === label)[0];
    return { host, undone, button, unmount: () => act(() => root.unmount()) };
  };

  test('the newest counts; undoing it says what comes back, an older one that nothing changes', async () => {
    const older = anImport({ id: 'imp-0', imported_at: '2026-11-01T12:00:00.000Z' });
    const v = mount([older, anImport()]);
    expect(words(v.host.textContent)).toContain('Imported today · 34 months · covers Jan 2024 to Oct 2026 Counts');
    act(() => click(v.button('Undo the import from today')));
    expect(v.host.textContent).toContain(
      'Undo the import from today? The months will come from the one before it again, from Nov 1: Jan 2024 to Oct 2026. Nothing else changes, and you can import the file again later.'
    );
    act(() => click(v.button('Keep it')));
    act(() => click(v.button('Undo the import from Nov 1')));
    expect(v.host.textContent).toContain(
      'Undo the import from Nov 1? Nothing you see changes: the newest import counts. There’s just no going back to this one afterwards. You can import the file again later.'
    );
    await act(async () => click(v.button('Undo import')));
    expect(v.undone).toEqual(['imp-0']);
    v.unmount();
  });

  test('undoing the newest when the one before gives all time otherwise: said', () => {
    // The one before starts on a balance; then one from $0.00 in Jan 2025.
    const balance = mount([anImport({ id: 'imp-0', imported_at: '2026-11-01T12:00:00.000Z', start: { month: '2024-01', balance: 1_000 } }), anImport()]);
    act(() => click(balance.button('Undo the import from today')));
    expect(balance.host.textContent).toContain('Jan 2024 to Oct 2026, and all time will need your deposits and withdrawals. Nothing else changes');
    balance.unmount();
    const later = anImport({ id: 'imp-0', imported_at: '2026-11-01T12:00:00.000Z', start: { month: '2025-01', balance: 0 }, months: anImport().months.filter((m) => m.month >= '2025-01') });
    const v = mount([later, anImport()]);
    act(() => click(v.button('Undo the import from today')));
    expect(v.host.textContent).toContain('Jan 2025 to Oct 2026, and all time will count from Jan 2025. Nothing else changes');
    v.unmount();
  });

  test('the only import: the account goes back to how it was', () => {
    const v = mount([anImport()]);
    act(() => click(v.button('Undo the import from today')));
    expect(v.host.textContent).toContain(
      'Undo the import from today? Individual goes back to how it was before any import: before Jul 1 its chart is Nya’s estimate again, and all time needs your deposits and withdrawals. Nothing else changes, and you can import the file again later.'
    );
    v.unmount();
    // With totals set, all time keeps them.
    const set = mount([anImport()], SET);
    act(() => click(set.button('Undo the import from today')));
    expect(set.host.textContent).toContain(
      'Undo the import from today? Individual goes back to how it was before any import: before Jul 1 its chart is Nya’s estimate again. Nothing else changes, and you can import the file again later.'
    );
    set.unmount();
    // From a balance, the months never gave all time.
    const balance = mount([anImport({ start: { month: '2024-01', balance: 1_000 } })]);
    act(() => click(balance.button('Undo the import from today')));
    expect(balance.host.textContent).toContain('before Jul 1 its chart is Nya’s estimate again. Nothing else changes');
    balance.unmount();
  });
});

describe('the sheet', () => {
  type Sent = { url: string; body: Record<string, unknown> };
  const TARGET: Target = {
    account_id: 'acc_vg',
    name: 'Individual',
    institution_name: 'Vanguard',
    type: 'investment',
    currency: 'USD',
    item_id: 'item_vg',
    vanguard: true,
    balance: LAST,
    vanguard_balances: [LAST],
  };

  /** The sheet open on `target`, the server keeping the imports, and pdf.js
   *  stood in for by `readPdf`. */
  async function mount(target: Target, readPdf: PdfReader, opts: { already?: MonthsImport[]; wrap?: (inner: typeof fetch) => typeof fetch } = {}) {
    const sent: Sent[] = [];
    let stored: MonthsImport[] = opts.already ?? [];
    let n = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/api/investment-months') {
        const body = JSON.parse(String(init.body));
        sent.push({ url, body });
        if (body.action === 'import')
          stored = [...stored, { id: `imp-${++n}`, source: 'vanguard-performance', file_name: body.file_name, imported_at: '2026-11-06T12:00:00.000Z', start: body.start, months: body.months, currency: body.currency }];
        else stored = stored.filter((i) => i.id !== body.import_id);
        return Response.json({ investment_months: stored.length ? { imports: stored } : null });
      }
      if (url.startsWith('/api/investment-months')) return Response.json({ investment_months: stored.length ? { imports: stored } : null });
      if (url.startsWith('/api/account-history')) return Response.json({ points: POINTS });
      if (url.startsWith('/api/investment-activity')) return Response.json(ACTIVITY);
      if (url.startsWith('/api/history-import')) return Response.json({ imports: [], settings: null, bank_from: null, history_pending: false, walked: true, reach: null });
      return Response.json({ error: 'Unexpected' }, { status: 500 });
    }) as unknown as typeof fetch;
    if (opts.wrap) globalThis.fetch = opts.wrap(globalThis.fetch);
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    let imported = 0;
    act(() => root.render(<HistoryImportSheet target={target} onClose={() => {}} onImported={() => imported++} readPdf={readPdf} />));
    await pass(20);
    const checkRow = (title: string) => host.findAll((e) => e.tagName === 'LABEL' && e.getAttribute('class') === 'check-row' && e.textContent.startsWith(title))[0];
    const button = (label: string) => host.findAll((e) => e.tagName === 'BUTTON' && (e.getAttribute('aria-label') ?? e.textContent.trim()) === label)[0] ?? null;
    return {
      host,
      sent,
      imported: () => imported,
      button,
      text: () => words(host.textContent),
      /** A file chosen in the file field. */
      choose: async (name: string, bytes = new TextEncoder().encode('%PDF-1.7 made up')) => {
        const input = host.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'file')[0];
        const key = Object.keys(input).find((k) => k.startsWith('__reactProps$'))!;
        const file = {
          name,
          size: bytes.length,
          slice: (a?: number, b?: number) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }),
          arrayBuffer: async () => bytes.slice().buffer,
        };
        await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { files: [file] } }));
        await pass(20);
      },
      press: async (label: string) => {
        await act(async () => click(button(label)));
        await pass(20);
      },
      /** A check row's box ticked, by its title. */
      tick: (title: string) => {
        const input = checkRow(title).findAll((e) => e.tagName === 'INPUT')[0];
        const key = Object.keys(input).find((k) => k.startsWith('__reactProps$'))!;
        act(() => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { checked: true } }));
      },
      ticked: (title: string) => (checkRow(title).findAll((e) => e.tagName === 'INPUT')[0] as unknown as { checked: boolean }).checked,
      field: (month: string, label: string) =>
        host
          .findAll((e) => e.tagName === 'FIELDSET' && e.textContent.startsWith(month))[0]
          .findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0]
          .findAll((e) => e.tagName === 'INPUT')[0],
      unmount: () => act(() => root.unmount()),
    };
  }

  test('a Vanguard account: read on the device, reviewed, imported, listed, and undone', async () => {
    let reads = 0;
    const v = await mount(TARGET, async () => (reads++, readOf(MONTHS)));
    expect(v.text()).toContain('Vanguard’s Performance page, as a PDF');
    await v.choose('Performance.pdf');
    expect(reads).toBe(1);
    expect(v.text()).toContain('34 months, Jan 2024 to Oct 2026');
    expect(v.button('Import 34 months')!.getAttribute('disabled')).toBeNull();

    await v.press('Import 34 months');
    expect(v.sent).toHaveLength(1);
    expect(v.sent[0].body).toMatchObject({ action: 'import', account_id: 'acc_vg', file_name: 'Performance.pdf', start: { month: '2024-01', balance: 0 }, currency: 'USD', typed: [], counting: null });
    expect((v.sent[0].body.months as unknown[]).length).toBe(34);
    expect(v.imported()).toBe(1);
    expect(v.text()).toContain('Done: 34 months imported from Performance.pdf.');
    expect(v.text()).toContain('Jan 2024 to Oct 2026, from Vanguard’s Performance page');
    expect(v.text()).toContain('Nya uses them where it has nothing of its own: balances before Jul 1, and deposits and withdrawals before Jul 1.');
    expect(v.text()).toContain('Past imports into Individual');
    expect(v.text()).toContain('Counts');

    await v.press('Undo the import from today');
    await v.press('Undo import');
    expect(v.sent[1].body).toEqual({ action: 'undo', account_id: 'acc_vg', import_id: 'imp-1' });
    expect(v.imported()).toBe(2);
    expect(v.text()).toContain('Undone: the import of Vanguard’s Performance page from today.');
    expect(v.text()).not.toContain('Past imports into Individual');
    v.unmount();
  });

  test('a month read wrong: typed from Vanguard’s page, then imported with it marked as typed', async () => {
    const bad = MONTHS.find((m) => m.month === '2025-03')!;
    const read = readOf(MONTHS, { figures: { '2025-03': { end: bad.end + 9_000 } }, failed: { '2025-03': ['adds-up'], '2025-04': ['begins-at-last-end'] } });
    const v = await mount({ ...TARGET, account_id: 'acc_vg2' }, async () => read);
    await v.choose('Performance.pdf');
    expect(v.text()).toContain('2 months don’t add up');
    expect(v.button('Import 34 months')!.getAttribute('disabled')).not.toBeNull();
    act(() => type(v.field('Mar 2025', 'Ending balance'), (bad.end / 100).toFixed(2)));
    expect(v.text()).not.toContain('don’t add up');
    // Its fields stay, now with nothing to say.
    expect(v.field('Mar 2025', 'Ending balance').value).toBe((bad.end / 100).toFixed(2));
    await v.press('Import 34 months');
    expect(v.sent[0].body).toMatchObject({ account_id: 'acc_vg2', typed: ['2025-03'] });
    v.unmount();
  });

  test('a typed month that adds up but doesn’t end where the next month begins: said on it', async () => {
    const bad = MONTHS.find((m) => m.month === '2025-03')!;
    const next = MONTHS.find((m) => m.month === '2025-04')!;
    const read = readOf(MONTHS, { figures: { '2025-03': { end: bad.end + 9_000 } }, failed: { '2025-03': ['adds-up'], '2025-04': ['begins-at-last-end'] } });
    const v = await mount({ ...TARGET, account_id: 'acc_vg5' }, async () => read);
    await v.choose('Performance.pdf');
    const returns = bad.returns + 100;
    act(() => type(v.field('Mar 2025', 'Investment returns'), `${returns < 0 ? '−' : '+'}${(Math.abs(returns) / 100).toFixed(2)}`));
    act(() => type(v.field('Mar 2025', 'Ending balance'), ((bad.end + 100) / 100).toFixed(2)));
    expect(v.text()).toContain(
      `It ends at ${formatMoney(dollars(bad.end + 100), 'USD')}, but Apr 2025 began at ${formatMoney(dollars(next.begin), 'USD')}. Check its ending balance against Vanguard’s page.`
    );
    expect(v.button('Import 34 months')!.getAttribute('disabled')).not.toBeNull();
    v.unmount();
  });

  test('imports changed on another device: checked again, the yes asked again, and gone on Cancel', async () => {
    const older = makeMonths('2020-01-01', '2026-10-31');
    const counting = anImport({ id: 'imp-old', start: { month: '2020-01', balance: 0 }, months: older.map((m) => ({ month: m.month, net: dollars(m.net), returns: dollars(m.returns), end: dollars(m.end) })) });
    let now: MonthsImport[] | null = null;
    const wrap = (inner: typeof fetch) =>
      (async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST' && now === null) {
          now = [counting, { ...counting, id: 'imp-other', imported_at: '2026-11-06T13:00:00.000Z' }];
          return Response.json({ error: 'The imports changed on another device.', needs: 'review' }, { status: 409 });
        }
        if (now && url.startsWith('/api/investment-months')) return Response.json({ investment_months: { imports: now } });
        return inner(url, init);
      }) as unknown as typeof fetch;
    const v = await mount({ ...TARGET, account_id: 'acc_vg6' }, async () => readOf(MONTHS), { already: [counting], wrap });
    await v.choose('Performance.pdf');
    expect(v.text()).toContain('Jan 2020 to Dec 2023 would stop counting');
    v.tick('Use this file’s months only');
    expect(v.ticked('Use this file’s months only')).toBe(true);
    expect(v.button('Import 34 months')!.getAttribute('disabled')).toBeNull();
    await v.press('Import 34 months');
    expect(v.text()).toContain('The imports changed on another device.');
    await v.press('Check the file again');
    // The yes was to what counted then.
    expect(v.ticked('Use this file’s months only')).toBe(false);
    expect(v.button('Import 34 months')!.getAttribute('disabled')).not.toBeNull();
    await v.press('Cancel');
    expect(v.text()).not.toContain('changed on another device');
    v.unmount();
  });

  test('imports that couldn’t be loaded: said beside the review', async () => {
    const wrap = (inner: typeof fetch) =>
      (async (url: string, init?: RequestInit) =>
        !init?.method && url.startsWith('/api/investment-months')
          ? Response.json({ error: 'The imported months couldn’t be loaded.' }, { status: 500 })
          : inner(url, init)) as unknown as typeof fetch;
    const v = await mount({ ...TARGET, account_id: 'acc_vg7' }, async () => readOf(MONTHS), { wrap });
    await v.choose('Performance.pdf');
    expect(v.text()).toContain('34 months, Jan 2024 to Oct 2026');
    expect(v.host.findAll((e) => e.getAttribute('class')?.includes('notice caution') === true && e.textContent.includes('The imported months couldn’t be loaded.'))).toHaveLength(1);
    v.unmount();
  });

  test('a PDF that isn’t the Performance page: said, and back to choosing a file', async () => {
    const v = await mount({ ...TARGET, account_id: 'acc_vg3' }, async () => ({ kind: 'not-performance' }));
    await v.choose('statement.pdf');
    expect(v.text()).toContain('This PDF isn’t Vanguard’s Performance page, the only PDF Nya reads.');
    expect(v.host.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'file')).toHaveLength(1);
    v.unmount();
  });

  test('a PDF on an account at another firm: never read', async () => {
    let reads = 0;
    const v = await mount({ ...TARGET, account_id: 'acc_fid', name: 'Brokerage', institution_name: 'Fidelity', vanguard: false }, async () => (reads++, readOf(MONTHS)));
    await v.choose('Performance.pdf');
    expect(reads).toBe(0);
    expect(v.text()).toContain('Nya reads a PDF only from Vanguard’s Performance page, and Brokerage is at Fidelity. Download its transactions from Fidelity as OFX or QFX, CSV or QIF instead.');
    v.unmount();
  });
});

describe('the imports, loaded', () => {
  const load = async () => ({});
  test('an answer for an account the sheet has left is dropped', async () => {
    const answers: Record<string, (r: Response) => void> = {};
    globalThis.fetch = ((url: string) => {
      if (url.startsWith('/api/investment-months')) {
        const id = new URL(url, 'http://nya.test').searchParams.get('account_id')!;
        return new Promise<Response>((resolve) => (answers[id] = resolve));
      }
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch;
    let seen: ReturnType<typeof usePerformanceData> | null = null;
    function Probe({ id }: { id: string }) {
      seen = usePerformanceData({ account_id: id, item_id: null }, load);
      return null;
    }
    const host = dom.document.createElement('div');
    const root = createRoot(host as unknown as HTMLElement);
    act(() => root.render(<Probe id="acc_a" />));
    await pass(10);
    act(() => root.render(<Probe id="acc_b" />));
    await pass(10);
    answers.acc_a(Response.json({ investment_months: { imports: [anImport({ id: 'imp-a' })] } }));
    await pass(10);
    expect(seen!.imports).toBeNull();
    answers.acc_b(Response.json({ investment_months: { imports: [anImport({ id: 'imp-b' })] } }));
    await pass(10);
    expect(seen!.imports!.imports[0].id).toBe('imp-b');
    act(() => root.unmount());
  });
});
