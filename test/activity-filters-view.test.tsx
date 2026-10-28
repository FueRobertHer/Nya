import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, FakeElement } from './mini-dom';
import { categoriesFor } from './category-fixture';

// The filters on Activity's Transactions (rollout phase 5b,
// docs/design/information-architecture.md#activity), used as a person would
// (react-dom/client over test/mini-dom.ts): a row of chips under the search,
// To review while the queue is on, Tag while there are tags, Receipt while a
// file store is connected; and the review bar under them, its count a
// heading beside Card Mode.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: MonthBreakdown, emptyListWords } = await import('@/components/MonthBreakdown');
const { localMonth } = await import('@/lib/local-date');
type Txn = import('@/components/MonthBreakdown').Txn;
type Tag = import('@/lib/tags').Tag;
type ReviewControls = import('@/components/review-state').ReviewControls;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const month = localMonth();
const { taxonomy } = categoriesFor({ groceries: 700 }, { words: ['groceries', 'income'], groups: { groceries: 'Food' } });

let n = 0;
const row = (name: string, amount: number, over: Partial<Txn> = {}): Txn =>
  ({
    transaction_id: `f${++n}`,
    date: `${month}-02`,
    name,
    amount,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Chase',
    category: 'groceries',
    iso_currency_code: 'USD',
    vendor_key: name.toLowerCase(),
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
const TAGS: Tag[] = [
  { id: 'gift', name: 'Gift', color: 'pink', created_at: at },
  { id: 'work', name: 'Reimbursable', color: 'green', created_at: at },
];

const ROWS: Txn[] = [
  row('Whole Foods', 41.3, { needs_review: true, tags: ['gift'] }),
  row('Blue Bottle', 4.5, { attached: true, attached_on: ['v'] }),
  row('Hardware store', 120, { tags: ['work'] }),
];

const NAMES = ['Whole Foods', 'Blue Bottle', 'Hardware store', 'Corner shop'];

/** The review queue's controls as the views see them, doing nothing. */
const controls = (on = true): ReviewControls =>
  ({
    view: { on, since: `${month}-01`, unread: false, unknown: 0 },
    accept: () => {},
    turn: async () => true,
    approve: async () => null,
    undo: async () => true,
    unapprove: async () => true,
    recategorizeAndApprove: async () => null,
    undoRecategorize: async () => true,
    error: null,
    setError: () => {},
    saving: false,
  }) as unknown as ReviewControls;

type Props = Partial<React.ComponentProps<typeof MonthBreakdown>>;
function mount(props: Props = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = (p: Props) =>
    act(() =>
      root.render(<MonthBreakdown txns={ROWS} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} {...p} />)
    );
  render(props);
  const all = (test: (e: FakeElement) => boolean) => host.findAll(test);
  const group = () => all((e) => e.getAttribute('role') === 'group' && e.getAttribute('aria-label') === 'Filter the list')[0] ?? null;
  const chip = (label: string) => all((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'chip' && e.textContent === label)[0] ?? null;
  const select = (label: string) => all((e) => e.tagName === 'SELECT' && e.getAttribute('aria-label') === label)[0] ?? null;
  // What a select chip shows, and whether it is on.
  const shown = (label: string) => {
    const s = select(label);
    const chipEl = s?.parentNode as FakeElement | null;
    const words = chipEl?.findAll((e) => e.tagName === 'SPAN' && e.getAttribute('aria-hidden') === 'true')[0];
    return chipEl ? { text: words?.textContent ?? null, on: chipEl.hasAttribute('data-on') } : null;
  };
  // The merchants listed, in order.
  const names = () => all((e) => e.getAttribute('class') === 'list-row-title').map((e) => NAMES.find((m) => e.textContent.startsWith(m)));
  return { host, render, all, group, chip, select, shown, names, text: () => host.textContent, unmount: () => act(() => root.unmount()) };
}

describe('the filter chips on Transactions', () => {
  test('no row of chips when none would be in it; each chip only where it can filter', () => {
    const bare = mount();
    expect(bare.group()).toBeNull();
    bare.unmount();

    const queue = mount({ review: controls() });
    expect(queue.group()).not.toBeNull();
    expect(queue.chip('To review')).not.toBeNull();
    expect(queue.select('Tag')).toBeNull();
    expect(queue.select('Receipt')).toBeNull();
    queue.unmount();

    const off = mount({ review: controls(false), tags: TAGS, onAttachmentsChanged: () => {} });
    expect(off.chip('To review')).toBeNull();
    expect(off.select('Tag')).not.toBeNull();
    expect(off.select('Receipt')).not.toBeNull();
    off.unmount();
  });

  test('To review narrows the list to what needs review and back, and says it is on', () => {
    const v = mount({ review: controls() });
    expect(v.names().length).toBe(3);
    const chip = v.chip('To review')!;
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    act(() => click(chip));
    expect(v.chip('To review')!.getAttribute('aria-pressed')).toBe('true');
    expect(v.names()).toEqual(['Whole Foods']);
    act(() => click(v.chip('To review')!));
    expect(v.chip('To review')!.getAttribute('aria-pressed')).toBe('false');
    expect(v.names().length).toBe(3);
    v.unmount();
  });

  test('the review bar under the chips: the queue counted as a heading, Card Mode beside it, no filter of its own', () => {
    const v = mount({ review: controls() });
    const heading = v.all((e) => e.tagName === 'H3' && e.getAttribute('id') === 'review-count')[0];
    expect(heading.textContent).toBe('1 to review');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(heading.hasAttribute('data-review-return')).toBe(true);
    const bar = v.all((e) => e.getAttribute('class') === 'review-bar')[0];
    expect(bar.findAll((e) => e.tagName === 'BUTTON').map((e) => e.textContent)).toContain('Review one at a time');
    expect(bar.findAll((e) => e.hasAttribute('aria-pressed')).length).toBe(0);
    // The chips come first, then the bar.
    const order = v.all((e) => e === v.group() || e === bar);
    expect([order.length, order[0] === v.group()]).toEqual([2, true]);
    v.unmount();
  });

  test('Tag: choosing one filters and the chip says which; All tags puts the list back; a tag deleted meanwhile filters nothing', () => {
    const v = mount({ tags: TAGS });
    expect(v.shown('Tag')).toEqual({ text: 'Tag', on: false });
    act(() => type(v.select('Tag')!, 'work'));
    expect(v.shown('Tag')).toEqual({ text: 'Tag: Reimbursable', on: true });
    expect(v.names()).toEqual(['Hardware store']);
    act(() => type(v.select('Tag')!, ''));
    expect(v.shown('Tag')).toEqual({ text: 'Tag', on: false });
    expect(v.names().length).toBe(3);

    act(() => type(v.select('Tag')!, 'work'));
    v.render({ tags: TAGS.filter((t) => t.id !== 'work') });
    expect(v.shown('Tag')).toEqual({ text: 'Tag', on: false });
    expect(v.names().length).toBe(3);
    v.unmount();
  });

  test('Receipt: with one, or none over an amount, whose field shows only then', () => {
    const v = mount({ onAttachmentsChanged: () => {} });
    const amount = () => v.all((e) => e.getAttribute('aria-label') === 'Money out over, in each transaction’s own currency')[0] ?? null;
    expect(v.shown('Receipt')).toEqual({ text: 'Receipt', on: false });
    expect(amount()).toBeNull();

    act(() => type(v.select('Receipt')!, 'with'));
    expect(v.shown('Receipt')).toEqual({ text: 'Receipt: has one', on: true });
    expect(v.names()).toEqual(['Blue Bottle']);
    expect(amount()).toBeNull();

    act(() => type(v.select('Receipt')!, 'without'));
    expect(v.shown('Receipt')).toEqual({ text: 'Receipt: none', on: true });
    expect(amount()).not.toBeNull();
    act(() => type(amount()!, '50'));
    expect(v.names()).toEqual(['Hardware store']);

    act(() => type(v.select('Receipt')!, ''));
    expect(amount()).toBeNull();
    expect(v.names().length).toBe(3);
    v.unmount();
  });

  test('a receipt chip on still says how many it left out unread', () => {
    const v = mount({ txns: [...ROWS, row('Corner shop', 9, { attached: null })], onAttachmentsChanged: () => {} });
    const note = 'One transaction is left out: whether it has a receipt couldn’t be read just now.';
    expect(v.text()).not.toContain(note);
    act(() => type(v.select('Receipt')!, 'with'));
    expect(v.text()).toContain(note);
    v.unmount();
  });

  test('an empty list says what narrowed it', () => {
    const v = mount({ txns: [ROWS[1]], review: controls(), tags: TAGS });
    act(() => click(v.chip('To review')!));
    expect(v.text()).toContain('Nothing listed needs review.');
    act(() => type(v.select('Tag')!, 'gift'));
    expect(v.text()).toContain('No transactions match these filters.');
    act(() => click(v.chip('To review')!));
    expect(v.text()).toContain('No transaction listed has that tag.');
    v.unmount();
  });
});

describe('emptyListWords', () => {
  const none = { query: false, tag: false, review: false, receipt: '' as const, pick: false };
  test('one filter says what it looked for; more than one, or the search, that nothing matches', () => {
    expect(emptyListWords(none)).toBe('No transactions this month.');
    expect(emptyListWords({ ...none, pick: true })).toBe('Nothing to list.');
    expect(emptyListWords({ ...none, review: true })).toBe('Nothing listed needs review.');
    expect(emptyListWords({ ...none, receipt: 'with' })).toBe('No transaction listed has a receipt or document.');
    expect(emptyListWords({ ...none, receipt: 'without' })).toBe('Nothing listed over that amount is missing a receipt.');
    expect(emptyListWords({ ...none, tag: true })).toBe('No transaction listed has that tag.');
    expect(emptyListWords({ ...none, query: true })).toBe('No transactions match your search.');
    expect(emptyListWords({ ...none, query: true, review: true })).toBe('No transactions match your search and filters.');
    expect(emptyListWords({ ...none, tag: true, receipt: 'with' })).toBe('No transactions match these filters.');
    expect(emptyListWords({ ...none, unsure: true })).toBe('No category listed is one Plaid was unsure of.');
    expect(emptyListWords({ ...none, unsure: true, review: true })).toBe('No transactions match these filters.');
  });
});

describe('names on the list', () => {
  test("the bank's own text in capitals reads readably; a merchant's name or the person's stays as given", () => {
    const m = mount({
      txns: [
        row('CREDIT CARD 3333 PAYMENT *//', 25, { name_from_bank: true }),
        row('IKEA', 80),
        row('MY LANDLORD', 1200),
      ],
    });
    const titles = m.all((e) => e.getAttribute('class') === 'list-row-title').map((e) => e.textContent);
    expect(titles).toContain('Credit Card 3333 Payment');
    expect(titles).toContain('IKEA');
    expect(titles).toContain('MY LANDLORD');
    m.unmount();
  });
});

// The screen review: rows ran three and four lines ("Transportation › taxis
// and ride shares · First Platypus Bank · Plaid Checking"), and seven of ten
// carried an orange Check category. A row is its name, then one line: its
// category and its account, the institution only where two accounts share a
// name, after the name, as the line may be cut.
describe('a row’s line', () => {
  const lines = (v: ReturnType<typeof mount>) => v.all((e) => e.getAttribute('class') === 'txn-row-line').map((e) => e.textContent);
  test('its category and its account; the bank, Plaid’s finer category and a connector’s name are left to its sheet', () => {
    const v = mount({
      txns: [
        row('Taxi', 18, { account_name: 'Plaid Checking', institution_name: 'First Platypus Bank', subcategory: 'taxis and ride shares' }),
        row('Bus', 3, { account_name: 'Plaid Checking', institution_name: 'Tartan Bank' }),
        row('Interest', -1, { account_name: 'Savings', institution_name: 'Tartan Bank' }),
        row('Gas', 40, { account_name: 'Visa', institution_name: 'My Bank', source: 'simplefin' }),
        row('Farmers market', 12, { account_name: 'Wallet', institution_name: 'Cash', source: 'manual' }),
      ],
    });
    expect(lines(v)).toEqual(['Groceries · Plaid Checking, First Platypus Bank', 'Groceries · Plaid Checking, Tartan Bank', 'Groceries · Savings', 'Groceries · Visa', 'Groceries · Wallet']);
    expect(v.text()).not.toContain('›');
    expect(v.text()).not.toContain('taxis');
    expect(v.text()).not.toContain('SimpleFIN');
    // Typed in, or from a file: a badge on the line, which is never cut.
    const badges = v.all((e) => e.getAttribute('class') === 'badge').map((e) => e.textContent);
    expect(badges).toEqual(['Entered by hand']);
    v.unmount();
  });

  test('Plaid’s doubt: a quiet mark on the rows it can be answered for, counted by a chip that narrows the list', () => {
    const rows = [
      row('Whole Foods', 41.3, { category_confidence: 'LOW' }),
      row('Blue Bottle', 4.5, { category_confidence: 'UNKNOWN' }),
      // Pending: its sheet can't answer it until it posts, so not marked or counted.
      row('Hardware store', 120, { category_confidence: 'LOW', pending: true }),
      row('Corner shop', 9, { category_confidence: 'HIGH' }),
    ];
    const v = mount({ txns: rows });
    const marked = () =>
      v.all((e) => e.getAttribute('class') === 'list-row-text' && e.findAll((x) => x.getAttribute('class') === 'txn-check').length > 0).map((e) => NAMES.find((m) => e.textContent.startsWith(m)));
    expect(marked()).toEqual(['Whole Foods', 'Blue Bottle']);
    // Words for a screen reader with the mark; Information, so no caution badge on a row.
    expect(v.text()).toContain('Unsure category: Groceries · Checking');
    expect(v.all((e) => (e.getAttribute('class') ?? '').startsWith('badge') && e.textContent === 'Check category')).toEqual([]);

    const chip = () => v.chip('Unsure category (2)') ?? v.chip('Unsure category (0)');
    expect(chip()!.getAttribute('aria-pressed')).toBe('false');
    act(() => click(chip()!));
    expect(chip()!.getAttribute('aria-pressed')).toBe('true');
    expect(v.names()).toEqual(['Whole Foods', 'Blue Bottle']);
    expect(v.all((e) => e.getAttribute('class') === 'meta')[0].textContent).toBe('2 of 4');

    // Answered (Looks right, or a category chosen) while it is on: the chip
    // stays, at nothing, and the empty list says why.
    v.render({ txns: rows.map((t) => (t.category_confidence === 'HIGH' || t.pending ? t : { ...t, category_confidence: null })) });
    expect(v.chip('Unsure category (0)')!.getAttribute('aria-pressed')).toBe('true');
    expect(v.text()).toContain('No category listed is one Plaid was unsure of.');
    act(() => click(v.chip('Unsure category (0)')!));
    expect(v.chip('Unsure category (0)')).toBeNull();
    expect(v.group()).toBeNull();
    expect(v.names().length).toBe(4);
    v.unmount();
  });
});
