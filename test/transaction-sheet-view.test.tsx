import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, type FakeElement } from './mini-dom';
import { categoriesFor } from './category-fixture';

// A transaction's sheet on Activity's Transactions (rollout phase 5e,
// docs/design/information-architecture.md#activity), used as a person would
// (react-dom/client over test/mini-dom.ts): each row a button that opens it;
// its category with the offer to make a rule under it, the sheet staying
// open; Rename vendor and Edit or delete in its ⋯; Split and Group closing
// it for their own sheet; a split's parts and a group's transactions opening
// it on themselves; and the sheet following its row as the list changes.

const dom = installDom();
// What the sheet sends for a part or a group's transaction, answered at once.
const sent: { url: string; method: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
  sent.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, json: async () => ({}) };
}) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: MonthBreakdown } = await import('@/components/MonthBreakdown');
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
const settle = (ms = 5) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

type Props = Partial<React.ComponentProps<typeof MonthBreakdown>>;
function mount(props: Props = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  let last: Props = props;
  const render = (p: Props = last) => {
    last = p;
    act(() =>
      root.render(
        <MonthBreakdown txns={served()} notes={[]} loading={false} taxonomy={taxonomy} tags={TAGS} onRecategorize={() => {}} onRename={() => {}} onSplitsChanged={() => {}} {...p} />
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
    expect(v.dialog()!.findAll((e) => e.getAttribute('class') === 'notice critical').map((e) => e.textContent)).toEqual(['Could not reach the server.']);
    v.unmount();
  });

  test('the same words refused again, once cleared, are said: a new refusal', async () => {
    const v = mount({ actionError: 'Could not save that.' });
    await v.open('Whole Foods');
    v.render({ actionError: null });
    v.render({ actionError: 'Could not save that.' });
    expect(v.dialog()!.findAll((e) => e.getAttribute('class') === 'notice critical').map((e) => e.textContent)).toEqual(['Could not save that.']);
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
    expect(status()).toBe('Category kept: groceries.');
    // The row as the dashboard then shows it (components/transaction-edits.ts).
    v.render({ txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...low(t), ...recategorizedRow(low(t), changes[0].choice as never, taxonomy) } : t)) });
    expect(badges()).toEqual([]);
    expect(v.button('Looks right', v.dialog()!)).toBeNull();
    expect(status()).toBe('Category kept: groceries.');
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
  test('the status line says only the last thing saved: never "kept" once the category changes, and Exclude after Looks right', async () => {
    const low = (t: Txn) => (t.transaction_id === 'Whole Foods' ? { ...t, category_confidence: 'LOW' } : t);
    const onRecategorize = () => Promise.resolve(true);
    const onToggleExcluded = () => Promise.resolve(true);
    const v = mount({ txns: served().map(low), onRecategorize, onToggleExcluded });
    await v.open('Whole Foods');
    const status = () => v.dialog()!.findAll((e) => e.getAttribute('role') === 'status')[0]!.textContent;
    act(() => click(v.button('Looks right', v.dialog()!)!));
    await settle();
    expect(status()).toBe('Category kept: groceries.');
    // Another category chosen afterwards: nothing says it was kept.
    const household = (t: Txn) => (t.transaction_id === 'Whole Foods' ? { ...t, category_name: 'household' } : t);
    v.render({ onRecategorize, onToggleExcluded, txns: served().map(household) });
    expect(status()).toBe('');
    // Exclude afterwards is said, not hidden behind the earlier answer.
    const exclude = v.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'list-row' && e.textContent.startsWith('Exclude from'))[0]!;
    act(() => click(exclude));
    v.render({ onRecategorize, onToggleExcluded, txns: served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...household(t), excluded: true } : t)) });
    await settle();
    expect(status()).toBe('Excluded from budgets and reports.');
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

  test('Exclude acts in place: focus stays on its row as its title flips, and the status line says what it did', async () => {
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
    expect(dom.document.activeElement).toBe(before as never);
    expect(status()).toBe('Excluded from budgets and reports.');
    // Put back as it was (a refusal read again): the line no longer says it.
    v.render({ onToggleExcluded, txns: served() });
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

  test('Include on a pending row takes its row away until it posts: focus goes to the line said in its place', async () => {
    const pendingOut = (excluded: boolean) => served().map((t) => (t.transaction_id === 'Whole Foods' ? { ...t, pending: true, excluded: excluded ? true : undefined } : t));
    const v = mount({ txns: pendingOut(true), onToggleExcluded: () => Promise.resolve(true) });
    await v.open('Whole Foods');
    const include = v.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Include in budgets and reports'))[0]!;
    include.focus();
    act(() => click(include));
    v.render({ txns: pendingOut(false), onToggleExcluded: () => Promise.resolve(true) });
    await settle();
    const wait = v.dialog()!.findAll((e) => e.tagName === 'P' && e.textContent === 'Once it posts, it can be excluded from budgets and reports.')[0]!;
    expect(dom.document.activeElement).toBe(wait as never);
    expect(wait.getAttribute('tabindex')).toBe('-1');
    v.unmount();
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
    // A group's category shows once the list is read again: closed, and no rule offered.
    expect(v.dialog()).toBeNull();
    v.unmount();
  });
});
