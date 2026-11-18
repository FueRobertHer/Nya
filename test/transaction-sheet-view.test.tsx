import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, type FakeElement, fakeClock } from './mini-dom';
import { categoriesFor } from './category-fixture';
import type { CategoryChoice } from '@/components/transaction-edits';

// A transaction's sheet on Activity's Transactions (rollout phase 5e,
// docs/design/information-architecture.md#activity), used as a person would
// (react-dom/client over test/mini-dom.ts): each row a button that opens it;
// its category with the offer to make a rule under it, the sheet staying
// open; Rename vendor and Edit or delete in its ⋯; Split and Group closing
// it for their own sheet; a split's parts and a group's transactions opening
// it on themselves; and the sheet following its row as the list changes.
// Rename vendor goes through the tab's own edits (components/transaction-edits.ts),
// so its failure is seen where it is said.

const dom = installDom();
// What the sheet sends for a part or a group's transaction, answered at once;
// a rename, a note or tags, and a part's or a group's change, as
// `renameAnswer`, `annotationAnswer` and `splitAnswer` say, when a test sets one.
const sent: { url: string; method: string; body: unknown }[] = [];
let renameAnswer: (() => Promise<unknown>) | null = null;
let annotationAnswer: (() => Promise<unknown>) | null = null;
let splitAnswer: (() => Promise<unknown>) | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
  sent.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
  if (url === '/api/rename' && renameAnswer) return renameAnswer();
  if (url === '/api/transaction-annotations' && annotationAnswer) return annotationAnswer();
  if ((url === '/api/transaction-splits' || url === '/api/transaction-groups') && splitAnswer) return splitAnswer();
  return { ok: true, json: async () => ({}) };
}) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: MonthBreakdown } = await import('@/components/MonthBreakdown');
const { useTransactionEdits } = await import('@/components/transaction-edits');
const { expandSplitsAndGroups } = await import('@/lib/split-rows');
const { indexTaxonomy } = await import('@/lib/categories');
const { localDate } = await import('@/lib/local-date');
type Txn = import('@/components/MonthBreakdown').Txn;
type Tag = import('@/lib/tags').Tag;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { taxonomy } = categoriesFor({}, { words: ['groceries', 'household', 'auto', 'restaurants'] });
const ix = indexTaxonomy(taxonomy);
const cat = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;
const today = localDate();

const txn = (id: string, over: Partial<Txn> = {}): Txn =>
  ({
    transaction_id: id,
    date: today,
    name: id,
    amount: 10,
    pending: false,
    account_name: 'Card',
    institution_name: 'Chase',
    category: 'groceries',
    category_id: cat('groceries'),
    category_name: 'groceries',
    category_kind: 'expense',
    iso_currency_code: 'USD',
    vendor_key: `v:${id}`,
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: null,
    payment_channel: null,
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: null,
    region: null,
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
    ...over,
  }) as Txn;

const at = '2026-01-01T00:00:00.000Z';
const TAGS: Tag[] = [{ id: 'work', name: 'Reimbursable', color: 'green', created_at: at }];

/** Costco split three ways, a dinner grouped with two paybacks, and two
 *  rows on their own, as the server sends them. */
function served(): Txn[] {
  const rows = [
    txn('Costco', { amount: 150 }),
    txn('Bistro', { amount: 120 }),
    txn('Venmo from Sam', { amount: -40, category: 'transfer in', category_id: cat('transfer in'), category_name: 'transfer in', category_kind: 'transfer' }),
    txn('Venmo from Ann', { amount: -40, category: 'transfer in', category_id: cat('transfer in'), category_name: 'transfer in', category_kind: 'transfer' }),
    txn('Whole Foods', { amount: 41.3, tags: ['work'] }),
    txn('Cash market', { amount: 12, source: 'manual' }),
  ];
  return expandSplitsAndGroups(rows as never, {
    splits: new Map([
      [
        'Costco',
        {
          version: 1 as const,
          amount: 150,
          currency: 'USD',
          parts: [
            { id: 'p0', amount: 100, category_id: cat('groceries') },
            { id: 'p1', amount: 50, category_id: cat('household') },
          ],
          updated_at: '2026-10-01T00:00:00.000Z',
        },
      ],
    ]),
    splitsUnknown: new Set(),
    groups: new Map([
      [
        'g1',
        {
          version: 1,
          name: 'Dinner',
          category_id: cat('restaurants'),
          members: ['Bistro', 'Venmo from Sam', 'Venmo from Ann'],
          date: today,
          currency: 'USD',
          created_at: '2026-10-01T00:00:00.000Z',
          updated_at: '2026-10-01T00:00:00.000Z',
        },
      ],
    ]),
    groupsUnknown: 0,
    ix,
  }).rows as unknown as Txn[];
}

/** The time a sheet takes to slide in (one frame) and to come off the page. */
const pass = fakeClock();
const settle = (ms = 5) => pass(ms);

type Props = Partial<React.ComponentProps<typeof MonthBreakdown>>;
/** The list read again in full (loadTransactions), counted. */
let reloads = 0;
/** The rows the wired list starts with. */
let wiredRows: () => Txn[] = served;
/** The list with the tab's own edits, wired as components/Dashboard.tsx
 *  wires them, its rows in its own state: their writes go through the fetch
 *  above. */
function Wired(p: Props) {
  const [txns, setTxns] = React.useState<Txn[] | null>(() => wiredRows());
  const edits = useTransactionEdits({
    txns,
    setTxns,
    setTxnNotes: () => {},
    setTxnIncomplete: () => {},
    loadTransactions: () => void reloads++,
    loadNetWorth: async () => {},
    requestBackfill: () => {},
    taxonomy,
  });
  return (
    <MonthBreakdown
      txns={txns}
      notes={[]}
      loading={false}
      taxonomy={taxonomy}
      tags={TAGS}
      onRecategorize={edits.recategorize}
      onRename={edits.rename}
      onChangeTags={edits.changeTags}
      onSaveNote={edits.saveNote}
      onToggleExcluded={edits.toggleExcluded}
      onUndoExcluded={edits.undoExcluded}
      actionError={edits.error}
      onSplitsChanged={() => {}}
      {...p}
    />
  );
}
function mount(props: Props = {}, { wired = false } = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  let last: Props = props;
  const render = (p: Props = last) => {
    last = p;
    act(() =>
      root.render(
        wired ? (
          <Wired {...p} />
        ) : (
          <MonthBreakdown txns={served()} notes={[]} loading={false} taxonomy={taxonomy} tags={TAGS} onRecategorize={() => {}} onRename={() => {}} onSplitsChanged={() => {}} {...p} />
        )
      )
    );
  };
  render(props);
  const all = (test: (e: FakeElement) => boolean) => host.findAll(test);
  const button = (label: string, within: FakeElement = host as unknown as FakeElement) =>
    within.findAll((e) => e.tagName === 'BUTTON' && (e.textContent === label || e.getAttribute('aria-label') === label))[0] ?? null;
  /** A row of the list, by the start of its words. */
  const row = (name: string) =>
    all(
      (e) =>
        e.tagName === 'BUTTON' &&
        (e.getAttribute('class') ?? '').includes('txn-row') &&
        e.findAll((x) => x.getAttribute('class') === 'list-row-title')[0]?.textContent.startsWith(name) === true
    )[0] ?? null;
  /** The sheet on the page, open or sliding out. */
  const dialog = () => all((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const field = (label: string) => {
    const d = dialog();
    const l = d?.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0];
    return (l?.findAll((e) => e.tagName === 'SELECT' || e.tagName === 'INPUT')[0] ?? null) as FakeElement | null;
  };
  /** What a select shows chosen. */
  const chosen = (select: FakeElement | null) => select?.options.find((o) => o.selected)?.value ?? null;
  const open = async (name: string) => {
    const r = row(name)!;
    r.focus();
    act(() => click(r));
    await settle();
  };
  return { host, render, all, button, row, dialog, field, chosen, open, unmount: () => act(() => root.unmount()) };
}

describe('a transaction’s sheet', () => {
  test('each row is a button that opens its sheet, nothing interactive inside it, and no table', async () => {
    const v = mount();
    expect(v.all((e) => e.tagName === 'TABLE' || e.tagName === 'TR')).toHaveLength(0);
    const r = v.row('Whole Foods')!;
    expect(r.getAttribute('aria-haspopup')).toBe('dialog');
    expect(r.findAll((e) => e !== r && ['BUTTON', 'A', 'INPUT', 'SELECT'].includes(e.tagName))).toHaveLength(0);
    await v.open('Whole Foods');
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Whole Foods');
    expect(v.chosen(v.field('Category'))).toBe(cat('groceries'));
    v.unmount();
  });

  // The screen review: "Channel online".
  test("Plaid's channel reads in words in its bank details", async () => {
    for (const [channel, words] of [['online', 'Online'], ['in store', 'In store'], ['other', 'Other']]) {
      const v = mount({ txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, payment_channel: channel } : t)) });
      await v.open('Whole Foods');
      const row = v.dialog()!.findAll((e) => (e.getAttribute('class') ?? '') === 'txn-detail-row').find((e) => e.textContent.startsWith('Channel'));
      expect(row?.textContent).toBe(`Channel${words}`);
      v.unmount();
    }
  });

  test('a category chosen stays open, and offers a rule for every transaction with its name; Make a rule closes it for the rule sheet', async () => {
    const changes: string[] = [];
    const v = mount({
      onRecategorize: (id, choice) => changes.push(`recategorize ${id} ${'category_id' in choice ? choice.category_id : ''}`),
      onCreateRule: (t, id) => changes.push(`rule ${t.transaction_id} ${id}`),
    });
    await v.open('Whole Foods');
    act(() => type(v.field('Category')!, cat('household')));
    expect(changes).toEqual([`recategorize Whole Foods ${cat('household')}`]);
    expect(v.dialog()!.textContent).toContain('Do the same for every transaction named “Whole Foods”, past and future?');
    // No thanks: the offer goes, the sheet stays.
    act(() => click(v.button('No thanks', v.dialog()!)!));
    expect(v.dialog()!.textContent).not.toContain('Do the same for every transaction');
    // Chosen again, and taken.
    act(() => type(v.field('Category')!, cat('auto')));
    act(() => click(v.button('Make a rule', v.dialog()!)!));
    expect(changes.slice(1)).toEqual([`recategorize Whole Foods ${cat('auto')}`, `rule Whole Foods ${cat('auto')}`]);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('the offer belongs to the row it was made on: closing ends it', async () => {
    const v = mount({ onCreateRule: () => {} });
    await v.open('Whole Foods');
    act(() => type(v.field('Category')!, cat('household')));
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle(400);
    await v.open('Whole Foods');
    expect(v.dialog()!.textContent).not.toContain('Do the same for every transaction');
    v.unmount();
  });

  test('a change saved shows in the open sheet, and a filter it leaves leaves the sheet open on it', async () => {
    const v = mount();
    act(() => type(v.all((e) => e.tagName === 'SELECT' && e.getAttribute('aria-label') === 'Tag')[0]!, 'work'));
    await v.open('Whole Foods');
    // Its tag taken off and its category changed, as the dashboard shows at once.
    v.render({ txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, tags: [], category_id: cat('auto') } : t)) });
    expect(v.row('Whole Foods')).toBeNull();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Whole Foods');
    expect(v.chosen(v.field('Category'))).toBe(cat('auto'));
    v.unmount();
  });

  test('gone from the list once it is read again, it closes, and focus goes to the list’s heading', async () => {
    const v = mount();
    await v.open('Whole Foods');
    v.render({ txns: served().filter((t) => t.transaction_id !== 'Whole Foods') });
    expect(v.all((e) => e.getAttribute('role') === 'dialog')).toHaveLength(0);
    expect((dom.document.activeElement as unknown as FakeElement).textContent).toBe('Transactions');
    v.unmount();
  });

  test('the list read again with a spinner takes the sheet with it, and it doesn’t come back', async () => {
    const v = mount();
    await v.open('Whole Foods');
    v.render({ loading: true });
    v.render({ loading: false });
    await settle();
    expect(v.all((e) => e.getAttribute('role') === 'dialog')).toHaveLength(0);
    v.unmount();
  });

  test('a change refused while it is open is said in it; one said before it opened isn’t', async () => {
    const v = mount({ actionError: 'Could not save that.' });
    await v.open('Whole Foods');
    expect(v.dialog()!.textContent).not.toContain('Could not save that.');
    v.render({ actionError: 'Could not reach the server.' });
    expect(v.dialog()!.findAll((e) => e.getAttribute('class') === 'notice critical').map((e) => e.textContent)).toEqual(['Critical: Could not reach the server.']);
    v.unmount();
  });

  test('the same words refused again, once cleared, are said: a new refusal', async () => {
    const v = mount({ actionError: 'Could not save that.' });
    await v.open('Whole Foods');
    v.render({ actionError: null });
    v.render({ actionError: 'Could not save that.' });
    expect(v.dialog()!.findAll((e) => e.getAttribute('class') === 'notice critical').map((e) => e.textContent)).toEqual(['Critical: Could not save that.']);
    v.unmount();
  });

  test('No thanks gives focus back to the category; a row a filter took away gives it to the list’s heading', async () => {
    const v = mount({ onCreateRule: () => {} });
    await v.open('Whole Foods');
    act(() => type(v.field('Category')!, cat('household')));
    act(() => click(v.button('No thanks', v.dialog()!)!));
    expect(dom.document.activeElement).toBe(v.field('Category')!);
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle(400);
    expect(dom.document.activeElement).toBe(v.row('Whole Foods')!);

    act(() => type(v.all((e) => e.tagName === 'SELECT' && e.getAttribute('aria-label') === 'Tag')[0]!, 'work'));
    await v.open('Whole Foods');
    v.render({ txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, tags: [] } : t)) });
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle(400);
    expect((dom.document.activeElement as unknown as FakeElement).textContent).toBe('Transactions');
    v.unmount();
  });

  test('its row’s chips, and an exclusion in full, even where it can’t be changed', async () => {
    const v = mount({ txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, category_confidence: 'LOW', excluded: true, excluded_by_rule: true } : t)) });
    await v.open('Whole Foods');
    expect(v.dialog()!.findAll((e) => (e.getAttribute('class') ?? '').startsWith('badge')).map((e) => e.textContent)).toEqual(['Check category']);
    expect(v.dialog()!.textContent).toContain('Hidden by a rule: out of budgets and reports');
    v.unmount();
  });

  // The screen review: "Check category" had no answer short of choosing
  // another category.
  test('Check category can be answered: Looks right chooses the category it has, as picking it would, and the mark goes', async () => {
    const { recategorizedRow } = await import('@/components/transaction-edits');
    const low = (t: Txn) => (t.transaction_id === 'Whole Foods' ? { ...t, category_confidence: 'LOW' } : t);
    const changes: { id: string; choice: unknown }[] = [];
    // Saved: the dashboard's recategorize resolves true once the server has it.
    const v = mount({ txns: served().map(low), onRecategorize: (id, choice) => (changes.push({ id, choice }), Promise.resolve(true)), onCreateRule: () => {} });
    await v.open('Whole Foods');
    const badges = () => v.dialog()!.findAll((e) => (e.getAttribute('class') ?? '').startsWith('badge')).map((e) => e.textContent);
    expect(badges()).toEqual(['Check category']);
    act(() => click(v.button('Looks right', v.dialog()!)!));
    await settle();
    expect(changes).toEqual([{ id: 'Whole Foods', choice: { category_id: cat('groceries') } }]);
    // No offer to make a rule: nothing was changed.
    expect(v.dialog()!.textContent).not.toContain('Do the same for every transaction');
    // The button goes, so focus goes to the field it was about, and the status line says it was kept.
    expect(dom.document.activeElement).toBe(v.field('Category') as never);
    const status = () => v.dialog()!.findAll((e) => e.getAttribute('role') === 'status')[0]!.textContent;
    expect(status()).toBe('Done: Category kept: groceries.');
    // The row as the dashboard then shows it (components/transaction-edits.ts).
    v.render({ txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...low(t), ...recategorizedRow(low(t), changes[0].choice as never, taxonomy) } : t)) });
    expect(badges()).toEqual([]);
    expect(v.button('Looks right', v.dialog()!)).toBeNull();
    expect(status()).toBe('Done: Category kept: groceries.');
    v.unmount();

    // Refused: nothing is said to have been kept (the dashboard says why).
    const refused = mount({ txns: served().map(low), onRecategorize: () => Promise.resolve(false) });
    await refused.open('Whole Foods');
    act(() => click(refused.button('Looks right', refused.dialog()!)!));
    await settle();
    expect(refused.dialog()!.findAll((e) => e.getAttribute('role') === 'status')[0]!.textContent).toBe('');
    refused.unmount();
  });

  // The audit after the screen review: "Category kept" outlived the category
  // it kept, and hid what Exclude did next.
  test('the done line says only the last thing saved: never "kept" once the category changes, and Exclude after Looks right', async () => {
    const low = (t: Txn) => (t.transaction_id === 'Whole Foods' ? { ...t, category_confidence: 'LOW' } : t);
    const onRecategorize = () => Promise.resolve(true);
    const onToggleExcluded = () => Promise.resolve(true);
    const v = mount({ txns: served().map(low), onRecategorize, onToggleExcluded });
    await v.open('Whole Foods');
    const status = () => v.dialog()!.findAll((e) => e.getAttribute('role') === 'status')[0]!.textContent;
    act(() => click(v.button('Looks right', v.dialog()!)!));
    await settle();
    expect(status()).toBe('Done: Category kept: groceries.');
    // Another category picked afterwards: nothing says it was kept.
    act(() => type(v.field('Category')!, cat('household')));
    const household = (t: Txn) => (t.transaction_id === 'Whole Foods' ? { ...t, category_id: cat('household'), category_name: 'household' } : t);
    v.render({ onRecategorize, onToggleExcluded, txns: served().map(household) });
    expect(status()).toBe('');
    // Nor when the kept one is picked again: that is a pick, not Looks right.
    act(() => type(v.field('Category')!, cat('groceries')));
    v.render({ onRecategorize, onToggleExcluded, txns: served().map(low) });
    expect(status()).toBe('');
    // Exclude afterwards is said, not hidden behind the earlier answer.
    const exclude = v.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'list-row' && e.textContent.startsWith('Exclude from'))[0]!;
    act(() => click(exclude));
    v.render({ onRecategorize, onToggleExcluded, txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...household(t), excluded: true } : t)) });
    await settle();
    expect(status()).toBe('Done: Excluded: it stays in this list, out of totals, budgets, insights, bills and the Plan.');
    v.unmount();
  });

  test('a pick made while Looks right is still saving is never said to be kept', async () => {
    const low = (t: Txn) => (t.transaction_id === 'Whole Foods' ? { ...t, category_confidence: 'LOW' } : t);
    let resolve: (saved: boolean) => void = () => {};
    const onRecategorize = (_id: string, choice: CategoryChoice) =>
      'category_id' in choice && choice.category_id === cat('groceries') ? new Promise<boolean>((r) => (resolve = r)) : Promise.resolve(true);
    const v = mount({ txns: served().map(low), onRecategorize });
    await v.open('Whole Foods');
    const status = () => v.dialog()!.findAll((e) => e.getAttribute('role') === 'status')[0]!.textContent;
    act(() => click(v.button('Looks right', v.dialog()!)!));
    // Household picked before the server answers Looks right.
    act(() => type(v.field('Category')!, cat('household')));
    v.render({ onRecategorize, txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, category_id: cat('household'), category_name: 'household' } : t)) });
    act(() => resolve(true));
    await settle();
    expect(status()).toBe('');
    v.unmount();
  });

  test('without the categories read, Looks right is still said once its words are saved', async () => {
    const low = (t: Txn) => (t.transaction_id === 'Whole Foods' ? { ...t, category_confidence: 'LOW' } : t);
    const { recategorizedRow } = await import('@/components/transaction-edits');
    const choices: CategoryChoice[] = [];
    const onRecategorize = (_id: string, choice: CategoryChoice) => (choices.push(choice), Promise.resolve(true));
    const v = mount({ taxonomy: null, txns: served().map(low), onRecategorize });
    await v.open('Whole Foods');
    act(() => click(v.button('Looks right', v.dialog()!)!));
    // The row as the dashboard shows it once saved by its words: no id now.
    v.render({ taxonomy: null, onRecategorize, txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...low(t), ...recategorizedRow(low(t), choices[0], null) } : t)) });
    await settle();
    expect(choices).toEqual([{ category: 'groceries' }]);
    expect(v.dialog()!.findAll((e) => e.getAttribute('role') === 'status')[0]!.textContent).toBe('Done: Category kept: groceries.');
    v.unmount();
  });

  test('a pending row keeps its mark without Looks right: a choice is kept by id, and it gets a new one when it posts', async () => {
    const v = mount({ txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, category_confidence: 'UNKNOWN', pending: true } : t)) });
    await v.open('Whole Foods');
    expect(v.dialog()!.textContent).toContain('Check category');
    expect(v.button('Looks right', v.dialog()!)).toBeNull();
    v.unmount();
  });

  test('its ⋯: Rename vendor as a second level, and Edit or delete only for a row entered by hand', async () => {
    const said: string[] = [];
    const v = mount({ onRename: (key, name) => said.push(`rename ${key} ${name}`), onEditTransaction: (t) => said.push(`edit ${t.transaction_id}`) });
    await v.open('Whole Foods');
    const more = () => v.dialog()!.findAll((e) => e.getAttribute('aria-haspopup') === 'menu')[0]!;
    act(() => click(more()));
    expect(v.all((e) => e.getAttribute('role') === 'menuitem').map((e) => e.textContent)).toEqual(['Rename vendor']);
    act(() => click(v.button('Rename vendor')!));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Rename vendor');
    expect(v.field('Name')!.value).toBe('Whole Foods');
    act(() => click(v.button('Back', v.dialog()!)!));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Whole Foods');
    act(() => click(more()));
    act(() => click(v.button('Rename vendor')!));
    act(() => type(v.field('Name')!, 'Whole Foods Market'));
    act(() => click(v.button('Rename', v.dialog()!)!));
    expect(said).toEqual(['rename v:Whole Foods Whole Foods Market']);
    // It waits for the write, then closes.
    await settle();
    expect(v.dialog()).toBeNull();
    await settle(400);

    await v.open('Cash market');
    act(() => click(more()));
    expect(v.all((e) => e.getAttribute('role') === 'menuitem').map((e) => e.textContent)).toEqual(['Rename vendor', 'Edit or delete']);
    act(() => click(v.button('Edit or delete')!));
    expect(said[1]).toBe('edit Cash market');
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  // The screen review: Split, Group with others, Share the cost and Exclude
  // from budgets were four tonal buttons of four widths, wrapping raggedly.
  describe('Rename vendor, written through the tab’s edits', () => {
    /** Whole Foods' row's title, its tag's chip after the name. */
    const wholeFoods = (v: ReturnType<typeof mount>) => v.all((e) => e.getAttribute('class') === 'list-row-title' && e.textContent.startsWith('Whole Foods')).map((e) => e.textContent);
    const footNote = (v: ReturnType<typeof mount>) => {
      const foot = v.dialog()!.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer')[0];
      return foot?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0] ?? null;
    };
    const renameTo = async (v: ReturnType<typeof mount>, name: string) => {
      const more = v.dialog()!.findAll((e) => e.getAttribute('aria-haspopup') === 'menu')[0]!;
      act(() => click(more));
      act(() => click(v.button('Rename vendor')!));
      act(() => type(v.field('Name')!, name));
      act(() => click(v.button('Rename', v.dialog()!)!));
      await settle();
    };
    const refused = (status: number, body: unknown = {}) => async () => ({ ok: false, status, json: async () => body });

    test('refused: it stays open on the name typed, says so beside Rename, and nothing in the list changed', async () => {
      renameAnswer = refused(500, { error: 'Failed to rename' });
      reloads = 0;
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      await renameTo(v, 'Whole Foods Market');
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Rename vendor');
      expect(v.field('Name')!.value).toBe('Whole Foods Market');
      const note = footNote(v)!;
      const alert = note.findAll((e) => e.getAttribute('role') === 'alert')[0]!;
      expect(alert.getAttribute('class')).toBe('notice critical');
      expect(alert.textContent).toContain('Could not rename this vendor. Please try again.');
      expect(v.button('Rename', v.dialog()!)!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
      // Never shown, so nothing to put back: no silent revert, no reload.
      expect(wholeFoods(v)).toEqual(['Whole FoodsReimbursable']);
      expect(reloads).toBe(0);
      v.unmount();
    });

    test('a server that can’t be reached, or a store that says why, is said in its words', async () => {
      renameAnswer = async () => {
        throw new Error('offline');
      };
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      await renameTo(v, 'Whole Foods Market');
      expect(footNote(v)!.textContent).toContain('Could not reach the server.');
      renameAnswer = refused(503, { error: 'Your data is being moved. Try again in a minute.' });
      act(() => click(v.button('Rename', v.dialog()!)!));
      await settle();
      expect(footNote(v)!.textContent).toContain('Your data is being moved. Try again in a minute.');
      expect(footNote(v)!.textContent).not.toContain('Could not reach the server.');
      v.unmount();
    });

    test('tried again: it waits, the error gone, then closes with the rows renamed behind it', async () => {
      renameAnswer = refused(500);
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      await renameTo(v, 'Whole Foods Market');
      expect(footNote(v)).not.toBeNull();
      let answer: (r: unknown) => void = () => {};
      renameAnswer = () => new Promise((resolve) => (answer = resolve));
      act(() => click(v.button('Rename', v.dialog()!)!));
      expect(footNote(v)).toBeNull();
      const waiting = v.button('Renaming…', v.dialog()!)!;
      expect(waiting.getAttribute('disabled')).not.toBeNull();
      expect(v.field('Name')!.getAttribute('disabled')).not.toBeNull();
      // No way out mid-write, so its answer is never said to no one; Back
      // stays drawn, so the level (and focus) doesn't change under it.
      act(() => click(v.button('Back', v.dialog()!)!));
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Rename vendor');
      answer({ ok: true, status: 200, json: async () => ({ success: true }) });
      await settle(400);
      expect(v.dialog()).toBeNull();
      expect(wholeFoods(v)).toEqual(['Whole Foods MarketReimbursable']);
      v.unmount();
    });

    test('cleared: the bank’s names are read again, and it closes', async () => {
      renameAnswer = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      reloads = 0;
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      await renameTo(v, '');
      expect(sent.filter((s) => s.url === '/api/rename').at(-1)!.body).toEqual({ vendor_key: 'v:Whole Foods', name: '' });
      expect(reloads).toBe(1);
      await settle(400);
      expect(v.dialog()).toBeNull();
      v.unmount();
    });

    test('back, and Rename vendor again: no error left from before', async () => {
      renameAnswer = refused(500);
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      await renameTo(v, 'Whole Foods Market');
      expect(footNote(v)).not.toBeNull();
      act(() => click(v.button('Back', v.dialog()!)!));
      const more = v.dialog()!.findAll((e) => e.getAttribute('aria-haspopup') === 'menu')[0]!;
      act(() => click(more));
      act(() => click(v.button('Rename vendor')!));
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Rename vendor');
      expect(footNote(v)).toBeNull();
      expect(v.field('Name')!.value).toBe('Whole Foods');
      v.unmount();
    });

    afterAll(() => {
      renameAnswer = null;
    });
  });

  test('its actions, one to a row in one list; those that open another sheet end in a chevron', async () => {
    const shared = { names: new Map(), onShare: () => {}, onPaidBack: () => {}, onIou: () => {}, owes: false };
    const v = mount({ shared, onToggleExcluded: () => {}, onCreateRule: () => {} });
    await v.open('Whole Foods');
    // Its actions, then Create a rule from this in a list of its own (after
    // the rules that match it, when any do).
    const lists = v.dialog()!.findAll((e) => e.tagName === 'UL' && e.getAttribute('class') === 'card list-rows');
    expect(lists).toHaveLength(2);
    const rows = lists.flatMap((l) => l.findAll((e) => e.tagName === 'BUTTON'));
    const title = (b: FakeElement) => b.findAll((e) => e.getAttribute('class') === 'list-row-title')[0].textContent;
    expect(lists.map((l) => l.findAll((e) => e.tagName === 'BUTTON').map(title))).toEqual([['Split', 'Group with others', 'Share the cost', 'Exclude from budgets and reports'], ['Create a rule from this']]);
    expect(rows.map((b) => b.getAttribute('class'))).toEqual(Array(5).fill('list-row'));
    // A chevron, and a dialog for a screen reader, on all but Exclude, which acts in place.
    expect(rows.map((b) => b.findAll((e) => e.tagName === 'svg').length)).toEqual([1, 1, 1, 0, 1]);
    expect(rows.map((b) => b.getAttribute('aria-haspopup'))).toEqual(['dialog', 'dialog', 'dialog', null, 'dialog']);
    // What Exclude does, under it, as before.
    expect(rows[3].textContent).toBe('Exclude from budgets and reportsFor a one-off: it stays in this list, out of totals, budgets, insights, bills and the Plan.');
    expect(v.dialog()!.findAll((e) => (e.getAttribute('class') ?? '').includes('btn secondary'))).toHaveLength(0);
    v.unmount();

    // With rules that match it: Create a rule from this follows them.
    const ruled = mount({ txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, rule_ids: ['r1'] } : t)), ruleSentenceOf: () => 'Name is Whole Foods: Groceries', onCreateRule: () => {} });
    await ruled.open('Whole Foods');
    const order = ruled.dialog()!.findAll((e) => (e.tagName === 'DIV' && e.getAttribute('class') === 'helper' && e.textContent.startsWith('A rule matches it')) || (e.tagName === 'BUTTON' && e.textContent === 'Create a rule from this'));
    expect(order.map((e) => e.tagName)).toEqual(['DIV', 'BUTTON']);
    ruled.unmount();

    // A pending one: why it can't be split yet, after the list, in place of its rows.
    const pending = mount({ txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, pending: true } : t)), onCreateRule: () => {} });
    await pending.open('Whole Foods');
    expect(pending.dialog()!.textContent).toContain('Once it posts, it can be split or grouped with others.');
    expect(pending.button('Split', pending.dialog()!)).toBeNull();
    pending.unmount();
  });

  test('Exclude acts in place: its title flips, and the done line says what it did, focus on it', async () => {
    const toggled: boolean[] = [];
    // Saved: the dashboard's toggle resolves true once the server has it.
    const onToggleExcluded = (_t: Txn, excluded: boolean) => (toggled.push(excluded), Promise.resolve(true));
    const v = mount({ onToggleExcluded });
    await v.open('Whole Foods');
    const exclude = (view = v) =>
      view.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'list-row' && /^(Exclude|Include) in|^Exclude from/.test(e.textContent))[0] ?? null;
    const status = (view = v) => view.dialog()!.findAll((e) => e.getAttribute('role') === 'status')[0]!.textContent;
    const before = exclude()!;
    before.focus();
    act(() => click(before));
    expect(toggled).toEqual([true]);
    // The dashboard's change comes back, and the save resolves.
    v.render({ onToggleExcluded, txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, excluded: true } : t)) });
    await settle();
    expect(exclude()).toBe(before);
    expect(before.textContent.startsWith('Include in budgets and reports')).toBe(true);
    expect(status()).toBe('Done: Excluded: it stays in this list, out of totals, budgets, insights, bills and the Plan.');
    // A done notice, in a live region kept on the page, and focus on it.
    const region = v.dialog()!.findAll((e) => e.getAttribute('role') === 'status')[0]!;
    expect(region.getAttribute('class')).toBe('txn-sheet-said');
    const notice = region.findAll((e) => e.getAttribute('class') === 'notice done');
    expect(notice.length).toBe(1);
    expect(dom.document.activeElement).toBe(notice[0] as never);
    // No Undo without one to send (the tab's toggle answers what it needs).
    expect(v.button('Undo', v.dialog()!)).toBeNull();
    // Include, back: said too, and the row is the way back again.
    before.focus();
    act(() => click(before));
    v.render({ onToggleExcluded, txns: served() });
    await settle();
    expect(toggled).toEqual([true, false]);
    expect(status()).toBe('Done: Included again: it counts in totals, budgets, insights, bills and the Plan.');
    // Put back as it was (a refusal read again): the line no longer says it.
    v.render({ onToggleExcluded, txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, excluded: true } : t)) });
    expect(status()).toBe('');
    v.unmount();

    // Refused: nothing is said to have been done.
    const refused = mount({ onToggleExcluded: () => Promise.resolve(false) });
    await refused.open('Whole Foods');
    act(() => click(exclude(refused)!));
    await settle();
    expect(status(refused)).toBe('');
    refused.unmount();
  });

  test('Include on a pending row takes its row away until it posts: focus goes to the line said in its place, then to the done line', async () => {
    const pendingOut = (excluded: boolean) => served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, pending: true, excluded: excluded ? true : undefined } : t));
    let saved: (v: unknown) => void = () => {};
    const onToggleExcluded = () => new Promise((resolve) => (saved = resolve));
    const v = mount({ txns: pendingOut(true), onToggleExcluded });
    await v.open('Whole Foods');
    const include = v.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Include in budgets and reports'))[0]!;
    include.focus();
    act(() => click(include));
    v.render({ txns: pendingOut(false), onToggleExcluded });
    await settle();
    const wait = v.dialog()!.findAll((e) => e.tagName === 'P' && e.textContent === 'Once it posts, it can be excluded from budgets and reports.')[0]!;
    expect(dom.document.activeElement).toBe(wait as never);
    expect(wait.getAttribute('tabindex')).toBe('-1');
    // Saved: said, and focus goes on to it.
    act(() => saved(true));
    await settle();
    const done = v.dialog()!.findAll((e) => e.getAttribute('class') === 'notice done')[0]!;
    expect(done.textContent).toBe('Done: Included again: it counts in totals, budgets, insights, bills and the Plan.');
    expect(dom.document.activeElement).toBe(done as never);
    v.unmount();
  });

  // The follow-up to the sheets review: Exclude and Include are undone
  // exactly, the record put back as it was (lib/txn-annotations.ts
  // undoExclusion), through the tab's own edits as the dashboard wires them.
  describe('its Undo', () => {
    const NONE = { before: null, after: { excluded: true, updated_at: at } };
    const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
    /** The PATCH saving, then the PUT undoing, as `undoAnswer` says. */
    let undoAnswer: () => Promise<unknown> = ok({});
    const answering = (patch: unknown) => () => (sent.at(-1)!.method === 'PUT' ? undoAnswer() : ok(patch)());
    const toggle = (v: ReturnType<typeof mount>) =>
      v.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'list-row' && /^(Exclude|Include) in|^Exclude from/.test(e.textContent))[0]!;
    const said = (v: ReturnType<typeof mount>) => v.dialog()!.findAll((e) => e.getAttribute('class') === 'notice done')[0] ?? null;
    afterEach(() => {
      annotationAnswer = null;
      wiredRows = served;
    });

    test('Exclude, then Undo: the row counts again, the line says so, focus on it, and the record goes back as it was', async () => {
      undoAnswer = ok({ transaction_id: 'Whole Foods', excluded: false });
      annotationAnswer = answering({ transaction_id: 'Whole Foods', excluded: true, undo: NONE });
      sent.length = 0;
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      const row = toggle(v);
      row.focus();
      act(() => click(row));
      await settle();
      expect(said(v)!.textContent).toBe('Done: Excluded: it stays in this list, out of totals, budgets, insights, bills and the Plan.');
      expect(dom.document.activeElement).toBe(said(v) as never);
      const undo = v.button('Undo', v.dialog()!)!;
      expect(undo.getAttribute('class')).toBe('btn ghost');
      // Outside the live region, which says only what was done.
      expect(v.dialog()!.findAll((e) => e.getAttribute('role') === 'status')[0]!.findAll((e) => e === undo)).toHaveLength(0);
      act(() => click(undo));
      await settle();
      // What the save answered, sent back; then the list is read again.
      expect(sent.filter((s) => s.method === 'PUT')).toEqual([{ url: '/api/transaction-annotations', method: 'PUT', body: { transaction_id: 'Whole Foods', undo: NONE } }]);
      expect(sent.at(-1)!.url).toBe('/api/transactions');
      expect(said(v)!.textContent).toBe('Done: Undone: it counts in totals, budgets, insights, bills and the Plan, as before.');
      expect(dom.document.activeElement).toBe(said(v) as never);
      expect(v.button('Undo', v.dialog()!)).toBeNull();
      expect(toggle(v).textContent.startsWith('Exclude from budgets and reports')).toBe(true);
      v.unmount();
    });

    test('Include on a row a rule hides, then Undo: the rule hides it again, and the line says so', async () => {
      const ruled = { before: null, after: { excluded: false, updated_at: at } };
      undoAnswer = ok({ transaction_id: 'Whole Foods', excluded: false });
      annotationAnswer = answering({ transaction_id: 'Whole Foods', excluded: false, undo: ruled });
      // A rule's hide is on the row as served.
      wiredRows = () => served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, excluded: true, excluded_by_rule: true } : t));
      const w = mount({}, { wired: true });
      await w.open('Whole Foods');
      act(() => click(toggle(w)));
      await settle();
      expect(said(w)!.textContent).toBe('Done: Included again: it counts in totals, budgets, insights, bills and the Plan.');
      act(() => click(w.button('Undo', w.dialog()!)!));
      await settle();
      expect(said(w)!.textContent).toBe('Done: Undone: a rule hides it again, as before.');
      expect(w.dialog()!.textContent).toContain('Hidden by a rule: out of budgets and reports');
      w.unmount();
    });

    // The review: the spinner's read closed the sheet, and its refusal with it.
    test('refused: the line stays, why is said under Undo, which stays, and the list is read again quietly', async () => {
      undoAnswer = async () => ({ ok: false, status: 409, json: async () => ({ error: 'What’s said about this transaction changed since.' }) });
      annotationAnswer = answering({ transaction_id: 'Whole Foods', excluded: true, undo: NONE });
      reloads = 0;
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      act(() => click(toggle(v)));
      await settle();
      const undo = v.button('Undo', v.dialog()!)!;
      undo.focus();
      sent.length = 0;
      act(() => click(undo));
      await settle();
      expect(reloads).toBe(0);
      expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(['PUT /api/transaction-annotations', 'GET /api/transactions']);
      expect(said(v)!.textContent).toBe('Done: Excluded: it stays in this list, out of totals, budgets, insights, bills and the Plan.');
      const alert = v.dialog()!.findAll((e) => e.getAttribute('role') === 'alert')[0]!;
      expect(alert.getAttribute('class')).toBe('notice critical');
      expect(alert.textContent).toContain('What’s said about this transaction changed since.');
      const again = v.button('Undo', v.dialog()!)!;
      const why = v.dialog()!.findAll((e) => e.getAttribute('id') === again.getAttribute('aria-describedby'))[0]!;
      expect(why.findAll((e) => e === alert)).toHaveLength(1);
      expect(dom.document.activeElement).toBe(again as never);
      v.unmount();
    });

    test('while it is out, it waits, and the line stays; a server that can’t be reached is said', async () => {
      let answer: (r: unknown) => void = () => {};
      undoAnswer = () => new Promise((resolve) => (answer = resolve));
      annotationAnswer = answering({ transaction_id: 'Whole Foods', excluded: true, undo: NONE });
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      act(() => click(toggle(v)));
      await settle();
      act(() => click(v.button('Undo', v.dialog()!)!));
      const waiting = v.button('Undoing…', v.dialog()!)!;
      expect(waiting.getAttribute('disabled')).not.toBeNull();
      expect(said(v)!.textContent).toContain('Excluded');
      act(() => answer(Promise.reject(new Error('offline'))));
      await settle();
      expect(v.dialog()!.findAll((e) => e.getAttribute('role') === 'alert')[0]!.textContent).toContain('Could not reach the server. Check your connection and press Undo again.');
      expect(v.button('Undo', v.dialog()!)!.getAttribute('disabled')).toBeNull();
      v.unmount();
    });

    test('a change made while its Undo is out stays as made once the Undo lands', async () => {
      let answer: (r: unknown) => void = () => {};
      undoAnswer = () => new Promise((resolve) => (answer = resolve));
      annotationAnswer = answering({ transaction_id: 'Whole Foods', excluded: false, undo: { before: null, after: { excluded: false, updated_at: at } } });
      // A rule hides it; Include, then Undo, and Exclude from its row while the Undo is out.
      wiredRows = () => served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, excluded: true, excluded_by_rule: true } : t));
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      act(() => click(toggle(v)));
      await settle();
      act(() => click(v.button('Undo', v.dialog()!)!));
      act(() => click(toggle(v)));
      await settle();
      expect(v.dialog()!.textContent).toContain('Excluded from budgets and reports');
      act(() => answer({ ok: true, status: 200, json: async () => ({}) }));
      await settle();
      // Still the person's own exclusion, not the rule's hide the Undo would have shown.
      expect(v.dialog()!.textContent).toContain('Excluded from budgets and reports');
      expect(v.dialog()!.textContent).not.toContain('Hidden by a rule');
      expect(said(v)!.textContent).toBe('Done: Excluded: it stays in this list, out of totals, budgets, insights, bills and the Plan.');
      v.unmount();
    });

    test('a save that answers nothing to undo is said with no Undo', async () => {
      annotationAnswer = answering({ transaction_id: 'Whole Foods', excluded: true });
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      act(() => click(toggle(v)));
      await settle();
      expect(said(v)!.textContent).toContain('Excluded');
      expect(v.button('Undo', v.dialog()!)).toBeNull();
      v.unmount();
    });
  });

  test('the bank and Plaid’s finer category, which the row leaves out, are in its sheet; a pair Nya worked out has no bank’s category', async () => {
    const v = mount({
      txns: [
        txn('Taxi', { subcategory: 'taxis and ride shares', account_name: 'Plaid Checking', institution_name: 'First Platypus Bank' }),
        txn('Card payment', { subcategory: 'credit card payment', source: 'simplefin', paired: 'card', account_name: 'Checking', institution_name: 'My Bank', counterparty: 'My Bank' }),
      ],
    });
    const detail = () =>
      Object.fromEntries(v.dialog()!.findAll((e) => e.getAttribute('class') === 'txn-detail-row').map((r) => [r.findAll((e) => e.tagName === 'DT')[0].textContent, r.findAll((e) => e.tagName === 'DD')[0].textContent]));
    await v.open('Taxi');
    expect(v.dialog()!.textContent).toContain('First Platypus Bank · Plaid Checking');
    expect(detail()['Bank’s category']).toBe('Taxis and ride shares');
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle(400);
    await v.open('Card payment');
    expect(detail()['Merchant']).toBe('My Bank');
    expect(detail()['Bank’s category']).toBeUndefined();
    v.unmount();
  });

  test('Split closes it and opens the split; closing that gives focus back to the row', async () => {
    const v = mount();
    await v.open('Whole Foods');
    act(() => click(v.button('Split', v.dialog()!)!));
    await settle();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Split transaction');
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle(400);
    expect(v.dialog()).toBeNull();
    expect(dom.document.activeElement).toBe(v.row('Whole Foods')!);
    v.unmount();
  });

  test('a split’s part opens on itself: its category, leaving it out, and the whole split', async () => {
    sent.length = 0;
    const v = mount();
    const part = v.row('Household')!;
    act(() => click(part));
    await settle();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Part of Costco');
    expect(v.chosen(v.field('Category'))).toBe(cat('household'));
    act(() => click(v.button('Leave this part out of budgets and reports', v.dialog()!)!));
    await settle();
    // Sent, and closed: the list shows it once read again.
    expect(sent).toEqual([{ url: '/api/transaction-splits', method: 'PATCH', body: { transaction_id: 'Costco', part_id: 'p1', excluded: true } }]);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('a group’s transaction opens on itself and can be taken out; the group’s own row files the group', async () => {
    sent.length = 0;
    const v = mount();
    const member = v.row('Venmo from Sam')!;
    act(() => click(member));
    await settle();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Venmo from Sam');
    act(() => click(v.button('Take it out of the group', v.dialog()!)!));
    await settle();
    expect(sent).toEqual([{ url: '/api/transaction-groups', method: 'PATCH', body: { id: 'g1', remove: ['Venmo from Sam'] } }]);
    expect(v.dialog()).toBeNull();
    await settle(400);

    sent.length = 0;
    await v.open('Dinner');
    expect(v.dialog()!.textContent).toContain('Edit group');
    act(() => type(v.field('Category')!, cat('groceries')));
    await settle();
    expect(sent).toEqual([{ url: '/api/transaction-groups', method: 'PATCH', body: { id: 'g1', category_id: cat('groceries') } }]);
    // Open on the group, and no rule offered for a group's category.
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Dinner');
    expect(v.dialog()!.textContent).not.toContain('Make a rule');
    v.unmount();
  });

  // The follow-up to the sheets review: a group's category and Ungroup
  // closed the sheet first, and a refusal was said on the list behind. Each
  // shows once the list is read again, so the sheet stays open and says it
  // then (docs/design/guidelines.md#after-save).
  describe('a group’s category and Ungroup, said in the sheet', () => {
    const doneLine = (v: ReturnType<typeof mount>) => v.dialog()!.findAll((e) => e.getAttribute('class') === 'notice done')[0] ?? null;
    const alert = (v: ReturnType<typeof mount>) => v.dialog()!.findAll((e) => e.getAttribute('role') === 'alert')[0] ?? null;
    const REFUSED = 'Could not save that. Please try again.';
    /** The group's write, held until the test answers it. */
    const held = () => {
      let answer: (r: unknown) => void = () => {};
      splitAnswer = () => new Promise((r) => (answer = r));
      return (ok: boolean) => answer(ok ? { ok: true, json: async () => ({}) } : { ok: false, status: 409, json: async () => ({ error: REFUSED }) });
    };
    afterEach(() => {
      splitAnswer = null;
    });
    /** The list read again with the group filed under another category. */
    const refiled = (id: string, name: string) =>
      served().map((t) => (t.group_members ? { ...t, category_id: id, category: name, category_name: name } : t));
    /** A transaction in a group that no longer applies, before and after Ungroup. */
    const stale = () => txn('Delta', { amount: 318, group_unapplied: { id: 'g9', name: 'Ski trip' } });
    const alone = () => txn('Delta', { amount: 318 });

    test('a group’s category: open, the field holding it while it saves, then the line says it, focus staying on the field', async () => {
      sent.length = 0;
      const answer = held();
      let v: ReturnType<typeof mount> | null = null;
      const props: Props = { onSplitsChanged: async () => v!.render({ ...props, txns: refiled(cat('groceries'), 'groceries') }) };
      v = mount(props);
      await v.open('Dinner');
      const field = v.field('Category')!;
      field.focus();
      act(() => type(field, cat('groceries')));
      await settle();
      expect(sent).toEqual([{ url: '/api/transaction-groups', method: 'PATCH', body: { id: 'g1', category_id: cat('groceries') } }]);
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Dinner');
      expect(v.chosen(v.field('Category'))).toBe(cat('groceries'));
      const saying = v.dialog()!.findAll((e) => e.getAttribute('id') === field.getAttribute('aria-describedby'))[0]!;
      expect(saying.textContent).toBe('Saving…');
      expect(saying.getAttribute('role')).toBe('status');
      // Another chosen meanwhile isn't taken: one write, the field on the first.
      act(() => type(field, cat('auto')));
      await settle();
      expect(sent).toHaveLength(1);
      expect(v.chosen(v.field('Category'))).toBe(cat('groceries'));
      answer(true);
      await settle(20);
      expect(doneLine(v)!.textContent).toContain('Category saved: the group counts under Groceries.');
      expect(v.chosen(v.field('Category'))).toBe(cat('groceries'));
      expect(field.getAttribute('aria-describedby')).toBeNull();
      expect(dom.document.activeElement).toBe(field);
      expect(v.dialog()!.textContent).not.toContain('Make a rule');
      v.unmount();
    });

    test('a group’s category refused: said at the top, the field back on what it had, focus on it, pointing at why', async () => {
      const answer = held();
      const v = mount({ onSplitsChanged: async () => {} });
      await v.open('Dinner');
      const field = v.field('Category')!;
      field.focus();
      act(() => type(field, cat('groceries')));
      await settle();
      answer(false);
      await settle(20);
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Dinner');
      expect(alert(v)!.textContent).toContain(REFUSED);
      expect(v.chosen(v.field('Category'))).toBe(cat('restaurants'));
      expect(dom.document.activeElement).toBe(field);
      const why = v.dialog()!.findAll((e) => e.getAttribute('id') === field.getAttribute('aria-describedby'))[0]!;
      expect(why.textContent).toContain(REFUSED);
      expect(doneLine(v)).toBeNull();
      v.unmount();
    });

    test('Ungroup: open, its row saying Ungrouping…, then the line says what moved, focus on it, and no Undo', async () => {
      sent.length = 0;
      const answer = held();
      let v: ReturnType<typeof mount> | null = null;
      const props: Props = { txns: [...served(), stale()], onSplitsChanged: async () => v!.render({ ...props, txns: [...served(), alone()] }) };
      v = mount(props);
      await v.open('Delta');
      const row = v.button('Ungroup “Ski trip”', v.dialog()!)!;
      row.focus();
      act(() => click(row));
      await settle();
      expect(sent).toEqual([{ url: '/api/transaction-groups', method: 'DELETE', body: { id: 'g9' } }]);
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Delta');
      expect(v.button('Ungrouping…', v.dialog()!)).toBe(row);
      // Pressed again while it is out: not sent again.
      act(() => click(row));
      await settle();
      expect(sent).toHaveLength(1);
      answer(true);
      await settle(20);
      const line = doneLine(v)!;
      expect(line.textContent).toContain('Ungrouped “Ski trip”: its transactions count on their own again, each on its own day and in its own category.');
      expect(dom.document.activeElement).toBe(line);
      expect(v.button('Undo', v.dialog()!)).toBeNull();
      // Its row gone, what it can do now offered in its place.
      expect(v.button('Ungroup “Ski trip”', v.dialog()!)).toBeNull();
      expect(v.button('Split', v.dialog()!)).not.toBeNull();
      expect(v.button('Group with others', v.dialog()!)).not.toBeNull();
      v.unmount();
    });

    test('Ungroup refused: said at the top, its row still there, focus on it', async () => {
      const answer = held();
      const v = mount({ txns: [...served(), stale()], onSplitsChanged: async () => {} });
      await v.open('Delta');
      const row = v.button('Ungroup “Ski trip”', v.dialog()!)!;
      row.focus();
      act(() => click(row));
      await settle();
      answer(false);
      await settle(20);
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Delta');
      expect(alert(v)!.textContent).toContain(REFUSED);
      expect(v.button('Ungroup “Ski trip”', v.dialog()!)).toBe(row);
      expect(dom.document.activeElement).toBe(row);
      expect(doneLine(v)).toBeNull();
      v.unmount();
    });

    /** The list read again, held until the test lets it land. */
    const heldReread = () => {
      let land: () => void = () => {};
      const reread = () => new Promise<void>((r) => (land = r));
      return { reread, land: () => land() };
    };

    test('saved, it waits for the list read again: Saving… until then, then the line', async () => {
      const answer = held();
      const r = heldReread();
      let v: ReturnType<typeof mount> | null = null;
      const props: Props = { onSplitsChanged: r.reread };
      v = mount(props);
      await v.open('Dinner');
      const field = v.field('Category')!;
      field.focus();
      act(() => type(field, cat('groceries')));
      await settle();
      answer(true);
      await settle(20);
      expect(field.getAttribute('aria-describedby')).not.toBeNull();
      expect(doneLine(v)).toBeNull();
      act(() => v!.render({ ...props, txns: refiled(cat('groceries'), 'groceries') }));
      r.land();
      await settle(20);
      expect(doneLine(v)!.textContent).toContain('Category saved: the group counts under Groceries.');
      expect(field.getAttribute('aria-describedby')).toBeNull();
      v.unmount();
    });

    test('saved, but the list isn’t read again: the field keeps the choice and the line says it, never a silent undo', async () => {
      splitAnswer = null;
      const v = mount({ onSplitsChanged: async () => {} });
      await v.open('Dinner');
      const field = v.field('Category')!;
      field.focus();
      act(() => type(field, cat('groceries')));
      await settle(20);
      expect(v.chosen(v.field('Category'))).toBe(cat('groceries'));
      expect(doneLine(v)!.textContent).toContain('Category saved: the group counts under Groceries.');
      expect(field.getAttribute('aria-describedby')).toBeNull();
      expect(dom.document.activeElement).toBe(field);
      v.unmount();
    });

    test('refused: the field is back at once, not saving, while the list is read again', async () => {
      const answer = held();
      const r = heldReread();
      const v = mount({ onSplitsChanged: r.reread });
      await v.open('Dinner');
      const field = v.field('Category')!;
      field.focus();
      act(() => type(field, cat('groceries')));
      await settle();
      answer(false);
      await settle(20);
      expect(v.chosen(v.field('Category'))).toBe(cat('restaurants'));
      expect(alert(v)!.textContent).toContain(REFUSED);
      expect(v.dialog()!.textContent).not.toContain('Saving…');
      r.land();
      await settle(20);
      v.unmount();
    });

    test('refused again in the same words as one already said on the list: said in the sheet too', async () => {
      splitAnswer = async () => ({ ok: false, status: 409, json: async () => ({ error: REFUSED }) });
      const v = mount({ onSplitsChanged: async () => {} });
      await v.open('Dinner');
      act(() => type(v.field('Category')!, cat('groceries')));
      await settle(20);
      expect(alert(v)!.textContent).toContain(REFUSED);
      act(() => click(v.button('Close', v.dialog()!)!));
      await settle(400);
      await v.open('Dinner');
      const field = v.field('Category')!;
      field.focus();
      act(() => type(field, cat('groceries')));
      await settle(20);
      expect(alert(v)!.textContent).toContain(REFUSED);
      expect(field.getAttribute('aria-describedby')).not.toBeNull();
      v.unmount();
    });

    test('Ungroup saved, but the list isn’t read again: the line still says it', async () => {
      splitAnswer = null;
      const v = mount({ txns: [...served(), stale()], onSplitsChanged: async () => {} });
      await v.open('Delta');
      const row = v.button('Ungroup “Ski trip”', v.dialog()!)!;
      row.focus();
      act(() => click(row));
      await settle(20);
      expect(doneLine(v)!.textContent).toContain('Ungrouped “Ski trip”');
      expect(dom.document.activeElement).toBe(doneLine(v));
      v.unmount();
    });
  });

  // The follow-up to the sheets review: no way to rename or delete a tag
  // from where tags are put on.
  describe('Rename or delete tags', () => {
    const editing = { onChangeTags: async () => true, onSaveNote: async () => true };

    test('under the tag field, a ghost button: it closes the sheet, then the tags open, for the row it was on', async () => {
      const opened: string[] = [];
      const v = mount({ ...editing, onManageTags: (t) => opened.push(t.transaction_id) });
      await v.open('Whole Foods');
      const link = v.button('Rename or delete tags', v.dialog()!)!;
      expect(link.getAttribute('class')).toBe('btn ghost');
      expect(link.getAttribute('aria-haspopup')).toBe('dialog');
      // After the tag field and its suggestions, before the note.
      const order = v.dialog()!.findAll((e) => e === link || e.getAttribute('aria-label') === 'Add a tag to Whole Foods' || e.tagName === 'TEXTAREA');
      expect(order.map((e) => e.tagName)).toEqual(['INPUT', 'BUTTON', 'TEXTAREA']);
      act(() => click(link));
      await settle(400);
      expect(v.dialog()).toBeNull();
      expect(opened).toEqual(['Whole Foods']);
      // Each row says whose it is, for focus to come back to it once Settings closes.
      expect(v.row('Whole Foods')!.getAttribute('data-txn-row')).toBe('Whole Foods');
      v.unmount();
    });

    test('not offered with no tags to rename, nor without a way there', async () => {
      for (const props of [{ ...editing, tags: [], onManageTags: () => {} }, editing]) {
        const v = mount(props);
        await v.open('Whole Foods');
        expect(v.button('Rename or delete tags', v.dialog()!)).toBeNull();
        v.unmount();
      }
    });
  });

  describe('a note and tags, written through the tab’s edits', () => {
    const status = (v: ReturnType<typeof mount>) => v.dialog()!.findAll((e) => e.getAttribute('role') === 'status')[0]!.textContent;
    const note = (v: ReturnType<typeof mount>) => v.dialog()!.findAll((e) => e.tagName === 'TEXTAREA')[0]!;
    const doneLine = (v: ReturnType<typeof mount>) => v.dialog()!.findAll((e) => e.getAttribute('class') === 'notice done')[0] ?? null;
    /** Pressed as a person does: focus on it, then the click. */
    const press = (el: FakeElement) => {
      el.focus();
      act(() => click(el));
    };

    test('a note saved, then cleared, says so in the sheet once the server has it, with focus on the line', async () => {
      annotationAnswer = null;
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      expect(status(v)).toBe('');
      act(() => type(note(v), 'Team lunch'));
      press(v.button('Save note', v.dialog()!)!);
      await settle();
      expect(status(v)).toBe('Done: Note saved.');
      expect(v.dialog()!.findAll((e) => e.getAttribute('class') === 'notice done').length).toBe(1);
      // The editor started again on the saved note, the button pressed gone with it.
      expect(doneLine(v)!.getAttribute('tabindex')).toBe('-1');
      expect(dom.document.activeElement).toBe(doneLine(v));
      act(() => type(note(v), ''));
      press(v.button('Clear note', v.dialog()!)!);
      await settle();
      expect(status(v)).toBe('Done: Note cleared.');
      expect(dom.document.activeElement).toBe(doneLine(v));
      v.unmount();
    });

    test('focus moved on while a note saves stays where it went; on nothing, it goes to the line', async () => {
      let answer: (r: unknown) => void = () => {};
      annotationAnswer = () => new Promise((r) => (answer = r));
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      act(() => type(note(v), 'Team lunch'));
      press(v.button('Save note', v.dialog()!)!);
      await settle();
      const picker = v.field('Category')!;
      picker.focus();
      act(() => answer({ ok: true, json: async () => ({}) }));
      await settle();
      expect(status(v)).toBe('Done: Note saved.');
      expect(dom.document.activeElement).toBe(picker);
      // Where a browser leaves focus once what had it has gone: on nothing.
      act(() => type(note(v), ''));
      press(v.button('Clear note', v.dialog()!)!);
      await settle();
      (dom.document.activeElement as FakeElement).blur();
      expect(dom.document.activeElement).toBe(dom.document.body);
      act(() => answer({ ok: true, json: async () => ({}) }));
      await settle();
      expect(status(v)).toBe('Done: Note cleared.');
      expect(dom.document.activeElement).toBe(doneLine(v));
      annotationAnswer = null;
      v.unmount();
    });

    /** What the top of the sheet says went wrong, announced. */
    const refusal = (v: ReturnType<typeof mount>) => v.dialog()!.findAll((e) => e.getAttribute('role') === 'alert')[0] ?? null;
    /** What a field points at, by its aria-describedby. */
    const pointsAt = (v: ReturnType<typeof mount>, el: FakeElement) => v.dialog()!.findAll((e) => !!e.getAttribute('id') && e.getAttribute('id') === el.getAttribute('aria-describedby'))[0] ?? null;
    const tagField = (v: ReturnType<typeof mount>) => v.dialog()!.findAll((e) => e.getAttribute('aria-label') === 'Add a tag to Whole Foods')[0]!;

    // The follow-up to the sheets review: a refusal read the list again with
    // the spinner, which closed the sheet, the note typed and focus with it.
    test('a note refused: said at the top, never said saved; the sheet stays, the note typed in its field, focus on it, pointing at why', async () => {
      annotationAnswer = async () => ({ ok: false, status: 500, json: async () => ({ error: 'nope' }) });
      reloads = 0;
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      act(() => type(note(v), 'Team lunch'));
      press(v.button('Save note', v.dialog()!)!);
      await settle();
      expect(status(v)).toBe('');
      // The server's words, as every refused edit on the tab says them.
      expect(refusal(v)!.textContent).toContain('Critical: nope');
      expect(reloads).toBe(0);
      expect(note(v).value).toBe('Team lunch');
      expect(dom.document.activeElement).toBe(note(v));
      expect(pointsAt(v, note(v))!.findAll((e) => e === refusal(v))).toHaveLength(1);
      // Never shown on the row: the note chip waits for the server.
      expect(v.row('Whole Foods')!.textContent).not.toContain('Note');
      // Saved on a second try: said, and the field points at nothing.
      annotationAnswer = null;
      press(v.button('Save note', v.dialog()!)!);
      await settle();
      expect(status(v)).toBe('Done: Note saved.');
      expect(refusal(v)).toBeNull();
      expect(note(v).getAttribute('aria-describedby')).toBeNull();
      v.unmount();
    });

    test('a tag typed and refused: the name back in its field, focus on it, pointing at why, and the tag off the row', async () => {
      annotationAnswer = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Could not change its tags. Please try again.' }) });
      reloads = 0;
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      act(() => type(tagField(v), 'Birthday'));
      press(v.button('Add', v.dialog()!)!);
      await settle();
      expect(status(v)).toBe('');
      expect(refusal(v)!.textContent).toContain('Could not change its tags. Please try again.');
      expect(reloads).toBe(0);
      expect(tagField(v).value).toBe('Birthday');
      expect(dom.document.activeElement).toBe(tagField(v));
      expect(pointsAt(v, tagField(v))!.findAll((e) => e === refusal(v))).toHaveLength(1);
      expect(v.button('Add', v.dialog()!)!.getAttribute('disabled')).toBeNull();
      annotationAnswer = null;
      v.unmount();
    });

    test('a chip’s change refused: the tag back as it was, focus on the tag field, since the chip went with the press', async () => {
      let answer: (r: unknown) => void = () => {};
      annotationAnswer = () => new Promise((r) => (answer = r));
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      press(v.button('Take Reimbursable off', v.dialog()!)!);
      await settle();
      // Off at once.
      expect(v.button('Take Reimbursable off', v.dialog()!)).toBeNull();
      act(() => answer({ ok: false, status: 500, json: async () => ({ error: 'Could not change its tags. Please try again.' }) }));
      await settle();
      expect(v.button('Take Reimbursable off', v.dialog()!)).not.toBeNull();
      expect(dom.document.activeElement).toBe(tagField(v));
      expect(tagField(v).value).toBe('');
      expect(pointsAt(v, tagField(v))).not.toBeNull();
      annotationAnswer = null;
      v.unmount();
    });

    test('a refusal once focus has moved on leaves focus where it went', async () => {
      let answer: (r: unknown) => void = () => {};
      annotationAnswer = () => new Promise((r) => (answer = r));
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      press(v.button('Take Reimbursable off', v.dialog()!)!);
      await settle();
      note(v).focus();
      act(() => type(note(v), 'Team'));
      act(() => answer({ ok: false, status: 500, json: async () => ({ error: 'Could not change its tags. Please try again.' }) }));
      await settle();
      expect(v.button('Take Reimbursable off', v.dialog()!)).not.toBeNull();
      expect(dom.document.activeElement).toBe(note(v));
      expect(note(v).value).toBe('Team');
      // Still pointing at why, for when focus comes back to it.
      expect(pointsAt(v, tagField(v))).not.toBeNull();
      annotationAnswer = null;
      v.unmount();
    });

    test('typed on while a note saves: kept in the editor once it is saved, and Save note pressed again sends it once', async () => {
      let answer: (r: unknown) => void = () => {};
      annotationAnswer = () => new Promise((r) => (answer = r));
      sent.length = 0;
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      act(() => type(note(v), 'Team lunch'));
      press(v.button('Save note', v.dialog()!)!);
      await settle();
      press(v.button('Save note', v.dialog()!)!);
      await settle();
      expect(sent.filter((x) => x.url === '/api/transaction-annotations')).toHaveLength(1);
      note(v).focus();
      act(() => type(note(v), 'Team lunch at noon'));
      act(() => answer({ ok: true, json: async () => ({}) }));
      await settle();
      expect(status(v)).toBe('Done: Note saved.');
      expect(note(v).value).toBe('Team lunch at noon');
      expect(dom.document.activeElement).toBe(note(v));
      expect(v.button('Save note', v.dialog()!)!.getAttribute('disabled')).toBeNull();
      annotationAnswer = null;
      v.unmount();
    });

    test('a tag added, then one taken off, each said by its name, with focus on the line', async () => {
      annotationAnswer = null;
      const v = mount({}, { wired: true });
      await v.open('Whole Foods');
      const field = v.dialog()!.findAll((e) => e.getAttribute('aria-label') === 'Add a tag to Whole Foods')[0]!;
      act(() => type(field, 'Travel'));
      const add = v.button('Add', v.dialog()!)!;
      press(add);
      await settle();
      expect(status(v)).toBe('Done: Tag added: Travel.');
      // Add can't be pressed again with its field emptied.
      expect(add.getAttribute('disabled')).not.toBeNull();
      expect(dom.document.activeElement).toBe(doneLine(v));
      press(v.button('Take Reimbursable off', v.dialog()!)!);
      await settle();
      expect(status(v)).toBe('Done: Tag removed: Reimbursable.');
      expect(dom.document.activeElement).toBe(doneLine(v));
      v.unmount();
    });
  });

  describe('a part’s or a group transaction’s change, refused', () => {
    const refusedWith = (error: string) => async () => ({ ok: false, status: 409, json: async () => ({ error }) });
    /** The list read again with Costco no longer split. */
    const unsplit = () => [txn('Costco', { amount: 150 }), ...served().filter((t) => t.split_of !== 'Costco' && t.transaction_id !== 'Costco')];

    test('a part gone once the list is read again after a refusal: the list says why, not nothing', async () => {
      const gone = 'That part no longer exists: the split was changed or undone. Reload to see it as it is.';
      splitAnswer = async () => ({ ok: false, status: 404, json: async () => ({ error: gone }) });
      let v: ReturnType<typeof mount> | null = null;
      const onSplitsChanged = () => queueMicrotask(() => v!.render({ onSplitsChanged, txns: unsplit() }));
      v = mount({ onSplitsChanged });
      act(() => click(v!.row('Household')!));
      await settle();
      act(() => click(v.button('Leave this part out of budgets and reports', v.dialog()!)!));
      await settle();
      await settle();
      expect(v.dialog()).toBeNull();
      expect(v.all((e) => e.getAttribute('role') === 'alert' && e.textContent.includes(gone)).length).toBe(1);
      splitAnswer = null;
      v.unmount();
    });

    test('closed after a refusal, then gone from the list: the list says nothing', async () => {
      splitAnswer = refusedWith('This split changed since it opened. Open it again.');
      const v = mount();
      act(() => click(v.row('Household')!));
      await settle();
      act(() => click(v.button('Leave this part out of budgets and reports', v.dialog()!)!));
      await settle();
      expect(v.dialog()!.textContent).toContain('This split changed since it opened.');
      act(() => click(v.button('Close', v.dialog()!)!));
      await settle(400);
      v.render({ txns: unsplit() });
      await settle();
      expect(v.host.textContent).not.toContain('This split changed since it opened.');
      splitAnswer = null;
      v.unmount();
    });

    test('a part waits for its write: refused, it stays open and says why, once, in the sheet', async () => {
      let answer: (r: unknown) => void = () => {};
      splitAnswer = () => new Promise((r) => (answer = r));
      const v = mount();
      act(() => click(v.row('Household')!));
      await settle();
      act(() => click(v.button('Leave this part out of budgets and reports', v.dialog()!)!));
      await settle();
      // Out: still open, saying so, and nothing else acts.
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Part of Costco');
      expect(v.dialog()!.findAll((e) => e.getAttribute('role') === 'status' && e.textContent === 'Saving…').length).toBe(1);
      expect(v.field('Category')!.getAttribute('disabled')).not.toBeNull();
      expect(v.button('Edit split', v.dialog()!)!.getAttribute('disabled')).not.toBeNull();
      act(() => click(v.button('Close', v.dialog()!)!));
      await settle();
      expect(v.dialog()).not.toBeNull();
      const refusal = await refusedWith('This split changed since it opened. Open it again.')();
      act(() => answer(refusal));
      await settle();
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Part of Costco');
      const alert = v.dialog()!.findAll((e) => e.getAttribute('role') === 'alert')[0]!;
      expect(alert.textContent).toContain('This split changed since it opened. Open it again.');
      // Said in the sheet only, not on the list behind it as well.
      expect(v.all((e) => e.textContent.includes('This split changed since it opened.') && (e.getAttribute('class') ?? '').startsWith('notice')).length).toBe(1);
      // Tried again and made: closed, nothing said on the list.
      splitAnswer = null;
      act(() => click(v.button('Leave this part out of budgets and reports', v.dialog()!)!));
      await settle();
      expect(v.dialog()).toBeNull();
      expect(v.host.textContent).not.toContain('This split changed since it opened.');
      v.unmount();
    });

    test('taking a transaction out of its group waits too: refused, said beside the button, which points at it', async () => {
      splitAnswer = refusedWith('The group changed since it opened.');
      const v = mount();
      act(() => click(v.row('Venmo from Sam')!));
      await settle();
      act(() => click(v.button('Take it out of the group', v.dialog()!)!));
      await settle();
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Venmo from Sam');
      const note = v.dialog()!.findAll((e) => e.getAttribute('class') === 'sheet-footer-note')[0]!;
      expect(note.textContent).toContain('The group changed since it opened.');
      expect(v.button('Take it out of the group', v.dialog()!)!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
      splitAnswer = null;
      v.unmount();
    });
  });
});
