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
    const v = mount({ txns: served().map(low), onRecategorize: (id, choice) => changes.push({ id, choice }), onCreateRule: () => {} });
    await v.open('Whole Foods');
    const badges = () => v.dialog()!.findAll((e) => (e.getAttribute('class') ?? '').startsWith('badge')).map((e) => e.textContent);
    expect(badges()).toEqual(['Check category']);
    act(() => click(v.button('Looks right', v.dialog()!)!));
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
