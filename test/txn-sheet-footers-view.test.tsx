import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type FakeElement } from './mini-dom';
import { categoriesFor } from './category-fixture';
import { cardOf, daysAgo, txn as sharedTxn } from './shared-expenses-fixture';

// The transaction and shared-expense sheets' buttons, in their footers
// (docs/design/guidelines.md, Buttons in the footer and One order): the way
// out first, the action last, and why a press failed beside them as a
// footer note the action is described by. Unsplit, Ungroup, Delete this IOU
// and Stop sharing it are each the sheet's last action row (`neg`); pressed,
// the footer asks: the question as its note, the safe answer (with focus)
// then the danger; what goes with it is said in the body under the row;
// the safe answer puts the footer back, focus on the row, and an error from
// one state never follows into the other. Used as a person would
// (react-dom/client over test/mini-dom.ts).

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
const { default: SplitSheet } = await import('@/components/SplitSheet');
const { default: GroupSheet } = await import('@/components/GroupSheet');
const { default: IouSheet } = await import('@/components/IouSheet');
const { default: ShareCostSheet } = await import('@/components/ShareCostSheet');
const { ConfirmPaymentSheet, SettleSheet } = await import('@/components/ConfirmPaymentSheet');
const { expandSplitsAndGroups, bankRows } = await import('@/lib/split-rows');
const { indexTaxonomy } = await import('@/lib/categories');
const { localDate } = await import('@/lib/local-date');
type Txn = import('@/components/MonthBreakdown').Txn;
type SharedExpenses = import('@/components/shared-expenses-state').SharedExpenses;
type CardAnswer = import('@/lib/shared-expenses/read').CardAnswer;

const body = () => dom.document.body;
const classOf = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');
const dialog = (title: string) => body().findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('aria-label') === title)[0] ?? null;
const footerOf = (d: FakeElement | null) => d?.findAll((e) => classOf(e).includes('sheet-footer'))[0] ?? null;
const bodyOf = (d: FakeElement | null) => d?.findAll((e) => classOf(e).includes('sheet-body'))[0] ?? null;
const buttons = (within: FakeElement | null) => (within?.findAll((e) => e.tagName === 'BUTTON') ?? []).map((b) => [b.textContent, b.getAttribute('class')]);
const button = (within: FakeElement | null, words: string) => within?.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
const notes = (within: FakeElement | null) => within?.findAll((e) => classOf(e).includes('sheet-footer-note')) ?? [];
const byId = (id: string) => body().findAll((e) => e.getAttribute('id') === id)[0] ?? null;
/** An action row, by its title. */
const row = (within: FakeElement | null, title: string) =>
  within?.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && e.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent === title)[0] ?? null;
const rowTitles = (within: FakeElement | null) => (within?.findAll((e) => classOf(e).includes('list-row-title')) ?? []).map((t) => t.textContent);
const focused = () => dom.document.activeElement;
const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
};
const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle();
};
/** What the element's aria-describedby names, each said. */
const describedBy = (el: FakeElement | null) => (el?.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => byId(id)?.textContent ?? `(no ${id})`);

let unmounts: (() => Promise<void>)[] = [];
beforeEach(async () => {
  for (const u of unmounts) await u();
  unmounts = [];
});

async function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(node));
  await settle();
  unmounts.push(async () => {
    await act(async () => root.unmount());
    dom.document.body.removeChild(host);
  });
}

/** The default state: the way out, then the action, and nothing else in the
 *  footer; no button pair left in the body. */
function expectFooter(title: string, out: string, action: [string, string]) {
  const d = dialog(title);
  expect(d?.getAttribute('data-open')).toBe('true');
  expect(buttons(footerOf(d))).toEqual([[out, 'btn secondary'], action]);
  expect(bodyOf(d)!.findAll((e) => classOf(e).includes('button-pair') || classOf(e).includes('btn-row')).length).toBe(0);
  return d!;
}

/** Asking: the question as the footer's note, the safe answer with focus,
 *  then the danger, described by the question and by what is said under the
 *  row. */
function expectAsking(title: string, question: string, safe: string, danger: string, said: string) {
  const d = dialog(title)!;
  const footer = footerOf(d)!;
  const note = notes(footer)[0]!;
  expect(note.getAttribute('class')).toBe('helper sheet-footer-note');
  expect(note.textContent).toBe(question);
  expect(buttons(footer)).toEqual([
    [safe, 'btn secondary'],
    [danger, 'btn danger'],
  ]);
  expect(focused() === button(footer, safe)).toBe(true);
  expect(describedBy(button(footer, danger))).toEqual([question, said]);
  // What goes with it, in the body (too long for the note).
  expect(bodyOf(d)!.textContent).toContain(said);
}

/** A refused press: its reason a footer note the button is described by
 *  too. */
function expectRefused(title: string, words: string, reason: string) {
  const footer = footerOf(dialog(title))!;
  const note = notes(footer).find((n) => n.findAll((e) => e.getAttribute('role') === 'alert').length > 0)!;
  expect(note.textContent).toContain(reason);
  expect((button(footer, words)!.getAttribute('aria-describedby') ?? '').split(' ')).toContain(note.getAttribute('id')!);
}

/** The safe answer: the footer as it was, no error, focus on the row. */
async function expectKept(title: string, safe: string, rowTitle: string, out: string, action: [string, string]) {
  await press(button(footerOf(dialog(title)), safe));
  expectFooter(title, out, action);
  expect(notes(footerOf(dialog(title))).length).toBe(0);
  expect(focused() === row(dialog(title), rowTitle)).toBe(true);
}

/** The destructive row, last in the body: in --neg, asking first, opening
 *  no other sheet. */
function expectRow(d: FakeElement, title: string) {
  expect(rowTitles(d)).toEqual([title]);
  const r = row(d, title)!;
  expect(r.getAttribute('class')).toBe('list-row neg');
  expect(r.getAttribute('aria-haspopup')).toBeNull();
  expect(r.textContent).toContain('Asks first.');
}

/** fetch for the split and group routes: refuses the first `refusals`
 *  calls, then answers ok. */
function routes(refusals: number, error: string) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: JSON.parse(String(init.body)) });
    if (calls.length <= refusals) return new Response(JSON.stringify({ error }), { status: 409 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return calls;
}

/** The shared expenses' state, with a send that refuses the first
 *  `refusals` calls. */
function sharedWith(card: CardAnswer, refusals: number, error: string) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const state: SharedExpenses = {
    card,
    failed: null,
    open: null,
    setOpen: () => {},
    send: async (path, method, sent) => {
      calls.push({ path, method, body: sent });
      return calls.length <= refusals ? { error, body: null } : { error: null, body: null };
    },
    reload: () => {},
  };
  return { state, calls };
}

const { taxonomy } = categoriesFor({}, { words: ['groceries', 'household', 'restaurants'] });
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
    category: 'general merchandise',
    category_id: cat('general merchandise'),
    category_name: 'general merchandise',
    category_kind: 'expense',
    iso_currency_code: 'USD',
    vendor_key: `v:${id}`,
    ...over,
  }) as Txn;
const STAMP = '2026-10-01T00:00:00.000Z';
const rowsOf = (raw: Txn[]) =>
  expandSplitsAndGroups(raw as any, {
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
          updated_at: STAMP,
        },
      ],
    ]),
    splitsUnknown: new Set(),
    groups: new Map([
      ['g1', { version: 1, name: 'Dinner with Sam', category_id: cat('restaurants'), members: ['Bistro', 'Venmo from Sam'], date: today, currency: 'USD', created_at: STAMP, updated_at: STAMP }],
    ]),
    groupsUnknown: 0,
    ix,
  }).rows as unknown as Txn[];
const RAW = [txn('Costco', { amount: 150 }), txn('Bistro', { amount: 120 }), txn('Venmo from Sam', { amount: -60, category_id: cat('transfer in'), category_kind: 'transfer' })];

describe('a split', () => {
  test('Cancel then Save split; Unsplit, its last row, asks in the footer; Keep the split goes back; a refusal is said; then it goes', async () => {
    const calls = routes(1, 'The split changed meanwhile.');
    let closed = 0;
    let saved = 0;
    const whole = (bankRows(rowsOf(RAW)) as Txn[]).find((t) => t.transaction_id === 'Costco')!;
    await mount(<SplitSheet t={whole} taxonomy={taxonomy} onClose={() => closed++} onSaved={() => saved++} />);
    const d = expectFooter('Edit split', 'Cancel', ['Save split', 'btn']);
    expect(button(footerOf(d), 'Save split')!.getAttribute('aria-describedby')).toBeNull();
    expectRow(d, 'Unsplit');

    await press(row(d, 'Unsplit'));
    const said = 'Its parts go, and it counts whole again, under General merchandise.';
    expectAsking('Edit split', 'Unsplit Costco?', 'Keep the split', 'Unsplit', said);
    await expectKept('Edit split', 'Keep the split', 'Unsplit', 'Cancel', ['Save split', 'btn']);
    expect(bodyOf(dialog('Edit split'))!.textContent).not.toContain(said);

    await press(row(dialog('Edit split'), 'Unsplit'));
    await press(button(footerOf(dialog('Edit split')), 'Unsplit'));
    expect(calls.map((c) => [c.url, c.method])).toEqual([['/api/transaction-splits', 'DELETE']]);
    expectRefused('Edit split', 'Unsplit', 'The split changed meanwhile.');
    expect(closed).toBe(0);
    // Keep the split takes the refusal with it.
    await expectKept('Edit split', 'Keep the split', 'Unsplit', 'Cancel', ['Save split', 'btn']);

    await press(row(dialog('Edit split'), 'Unsplit'));
    await press(button(footerOf(dialog('Edit split')), 'Unsplit'));
    expect(calls[1]).toEqual({ url: '/api/transaction-splits', method: 'DELETE', body: { transaction_id: 'Costco', updated_at: STAMP } });
    expect([saved, closed]).toEqual([1, 1]);
  });

  test('a new split: Cancel then Save split, which waits for the parts, and no Unsplit row', async () => {
    routes(0, '');
    await mount(<SplitSheet t={txn('Shop', { amount: 30 })} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />);
    const d = expectFooter('Split transaction', 'Cancel', ['Save split', 'btn']);
    expect(rowTitles(d)).toEqual([]);
    expect(button(footerOf(d), 'Save split')!.getAttribute('disabled')).not.toBeNull();
  });
});

describe('a group', () => {
  test('Cancel then Save group; Ungroup, its last row, asks in the footer; a refusal is said; then it goes', async () => {
    const calls = routes(1, 'The group changed meanwhile.');
    let closed = 0;
    const rows = rowsOf(RAW);
    const group = rows.find((t) => t.group_members)!;
    await mount(<GroupSheet start={null} group={group} txns={rows} taxonomy={taxonomy} onClose={() => closed++} onSaved={() => {}} />);
    const d = expectFooter('Edit group', 'Cancel', ['Save group', 'btn']);
    expectRow(d, 'Ungroup');

    await press(row(d, 'Ungroup'));
    const said = 'Its transactions count on their own again, each under its own category.';
    expectAsking('Edit group', 'Ungroup Dinner with Sam?', 'Keep the group', 'Ungroup', said);
    await press(button(footerOf(dialog('Edit group')), 'Ungroup'));
    expectRefused('Edit group', 'Ungroup', 'The group changed meanwhile.');
    await expectKept('Edit group', 'Keep the group', 'Ungroup', 'Cancel', ['Save group', 'btn']);

    await press(row(dialog('Edit group'), 'Ungroup'));
    await press(button(footerOf(dialog('Edit group')), 'Ungroup'));
    expect(calls.map((c) => [c.url, c.method, c.body])).toEqual([
      ['/api/transaction-groups', 'DELETE', { id: 'g1' }],
      ['/api/transaction-groups', 'DELETE', { id: 'g1' }],
    ]);
    expect(closed).toBe(1);
  });

  test('a new group: Cancel then Group them, no Ungroup row', async () => {
    routes(0, '');
    const rows = rowsOf(RAW);
    await mount(<GroupSheet start={rows.find((t) => t.transaction_id === 'Costco') ?? txn('Coffee')} group={null} txns={rows} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />);
    const d = expectFooter('Group transactions', 'Cancel', ['Group them', 'btn']);
    expect(rowTitles(d)).toEqual([]);
  });
});

describe('an IOU', () => {
  test('Cancel then Save; Delete this IOU, its last row, asks in the footer; a refused save, then a refused delete, each said only in its own state', async () => {
    const { state, calls } = sharedWith(cardOf(), 2, 'It changed meanwhile.');
    let closed = 0;
    await mount(<IouSheet id="i-groceries" open currency="USD" taxonomy={null} shared={state} onClose={() => closed++} />);
    const d = expectFooter('IOU', 'Cancel', ['Save', 'btn']);
    expectRow(d, 'Delete this IOU');

    // Save refused: said beside Save, and not carried into asking.
    await press(button(footerOf(d), 'Save'));
    expectRefused('IOU', 'Save', 'It changed meanwhile.');
    await press(row(dialog('IOU'), 'Delete this IOU'));
    const said = 'What it counted goes from your totals, and it is no longer in your balance with them.';
    expectAsking('IOU', 'Delete it?', 'Keep it', 'Delete', said);
    expect(notes(footerOf(dialog('IOU'))).length).toBe(1);

    await press(button(footerOf(dialog('IOU')), 'Delete'));
    expectRefused('IOU', 'Delete', 'It changed meanwhile.');
    await expectKept('IOU', 'Keep it', 'Delete this IOU', 'Cancel', ['Save', 'btn']);

    await press(row(dialog('IOU'), 'Delete this IOU'));
    await press(button(footerOf(dialog('IOU')), 'Delete'));
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'DELETE', 'DELETE']);
    expect(calls[2].body).toEqual({ id: 'i-groceries' });
    expect(closed).toBe(1);
  });

  test('a new one: Cancel then Add, no Delete row', async () => {
    const { state } = sharedWith(cardOf(), 0, '');
    await mount(<IouSheet id={null} open currency="USD" taxonomy={null} shared={state} onClose={() => {}} />);
    const d = expectFooter('Add an IOU', 'Cancel', ['Add', 'btn']);
    expect(rowTitles(d)).toEqual([]);
  });
});

describe('a shared cost', () => {
  const dinner = sharedTxn({ transaction_id: 't-dinner', name: 'Bistro', amount: 120 });

  test('Cancel then Save; Stop sharing it, its last row, asks in the footer, who no longer owes said in the body', async () => {
    const { state, calls } = sharedWith(cardOf(), 1, 'It changed meanwhile.');
    let closed = 0;
    await mount(<ShareCostSheet t={dinner} shared={state} onClose={() => closed++} />);
    const d = expectFooter('Who owes what', 'Cancel', ['Save', 'btn']);
    expectRow(d, 'Stop sharing it');

    await press(row(d, 'Stop sharing it'));
    expectAsking('Who owes what', 'Stop sharing Bistro?', 'Keep it shared', 'Stop sharing', 'It counts whole again, and Alex Smith no longer owes you for it.');
    await press(button(footerOf(dialog('Who owes what')), 'Stop sharing'));
    expectRefused('Who owes what', 'Stop sharing', 'It changed meanwhile.');
    await expectKept('Who owes what', 'Keep it shared', 'Stop sharing it', 'Cancel', ['Save', 'btn']);

    await press(row(dialog('Who owes what'), 'Stop sharing it'));
    await press(button(footerOf(dialog('Who owes what')), 'Stop sharing'));
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
    expect(closed).toBe(1);
  });

  test('on a split, choosing another part leaves the question and its refusal behind', async () => {
    const part = (id: string, amount: number, category: string) => sharedTxn({ transaction_id: `split:${id}`, name: 'Bistro', amount, category_name: category });
    const split = sharedTxn({ transaction_id: 't-dinner', name: 'Bistro', amount: 120, split_parts: [part('p0', 80, 'Restaurants'), part('p1', 40, 'Groceries')] });
    const card = cardOf({ shares: [{ ...cardOf().shares[0], part: 'p0' }] });
    const { state } = sharedWith(card, 1, 'It changed meanwhile.');
    await mount(<ShareCostSheet t={split} shared={state} onClose={() => {}} />);
    await press(row(dialog('Who owes what'), 'Stop sharing it'));
    await press(button(footerOf(dialog('Who owes what')), 'Stop sharing'));
    expectRefused('Who owes what', 'Stop sharing', 'It changed meanwhile.');
    // Groceries, not shared: its own buttons, nothing said of the other.
    await press(dialog('Who owes what')!.findAll((e) => e.getAttribute('type') === 'radio')[1]);
    expectFooter('Share the cost', 'Cancel', ['Save', 'btn']);
    expect(notes(footerOf(dialog('Share the cost'))).length).toBe(0);
    // Back on Restaurants: not asking until asked again, and then Keep has focus.
    await press(dialog('Share the cost')!.findAll((e) => e.getAttribute('type') === 'radio')[0]);
    expectFooter('Who owes what', 'Cancel', ['Save', 'btn']);
    await press(row(dialog('Who owes what'), 'Stop sharing it'));
    expectAsking('Who owes what', 'Stop sharing Bistro?', 'Keep it shared', 'Stop sharing', 'It counts whole again, and Alex Smith no longer owes you for it.');
  });

  test('a cost not shared yet: Cancel then Save, no Stop row', async () => {
    const { state } = sharedWith(cardOf(), 0, '');
    await mount(<ShareCostSheet t={sharedTxn({ transaction_id: 't-new', name: 'Cafe', amount: 40 })} shared={state} onClose={() => {}} />);
    const d = expectFooter('Share the cost', 'Cancel', ['Save', 'btn']);
    expect(rowTitles(d)).toEqual([]);
  });
});

describe('a payment and what was settled', () => {
  const venmo = sharedTxn({ transaction_id: 't-venmo', name: 'VENMO CASHOUT', amount: -35, date: daysAgo(3) });

  test('This paid back…: Cancel then Confirm; Not a repayment is a row that acts at once', async () => {
    const { state, calls } = sharedWith(cardOf(), 0, '');
    let closed = 0;
    await mount(<ConfirmPaymentSheet t={venmo} person="alex" preset={[{ item: 'e-dinner', amount: 35 }]} fromProposal shared={state} onClose={() => closed++} />);
    const d = expectFooter('This paid back…', 'Cancel', ['Confirm', 'btn']);
    expect(rowTitles(d)).toEqual(['Not a repayment']);
    expect(row(d, 'Not a repayment')!.getAttribute('class')).toBe('list-row');
    await press(row(d, 'Not a repayment'));
    expect(calls).toEqual([{ path: '/api/shared-expenses/payments', method: 'PATCH', body: { action: 'dismiss', transaction_id: 't-venmo' } }]);
    expect(closed).toBe(1);
  });

  test('Paid back: Close then Reopen it, what Reopen does as the footer note it is described by; a refusal is said beside it', async () => {
    const card = cardOf({ payments: [{ transaction_id: 't-venmo', allocations: [{ item: 'e-dinner', amount: 35 }] }] as unknown as CardAnswer['payments'] });
    const { state, calls } = sharedWith(card, 1, 'It changed meanwhile.');
    await mount(<ConfirmPaymentSheet t={venmo} shared={state} onClose={() => {}} />);
    const d = expectFooter('Paid back', 'Close', ['Reopen it', 'btn secondary']);
    const note = notes(footerOf(d))[0]!;
    expect(note.getAttribute('class')).toBe('helper sheet-footer-note');
    expect(describedBy(button(footerOf(d), 'Reopen it'))).toEqual(['Reopened, what it paid back is open again, and it counts as the bank shows it.']);
    expect(bodyOf(d)!.textContent).not.toContain('Reopened');
    await press(button(footerOf(d), 'Reopen it'));
    expect(calls.map((c) => c.method)).toEqual(['DELETE']);
    expectRefused('Paid back', 'Reopen it', 'It changed meanwhile.');
    expect(describedBy(button(footerOf(dialog('Paid back')), 'Reopen it'))[0]).toBe('Reopened, what it paid back is open again, and it counts as the bank shows it.');
  });

  test('Let it go: Cancel then Let it go, described by what letting go makes yours, said in the body', async () => {
    const { state } = sharedWith(cardOf(), 1, 'It changed meanwhile.');
    await mount(<SettleSheet person="alex" currency="USD" letGo shared={state} onClose={() => {}} />);
    const d = expectFooter('Let it go', 'Cancel', ['Let it go', 'btn']);
    const yours = 'What Alex Smith owed you of a shared transaction becomes your part, on the day you bought it: your spending that month goes up by it.';
    expect(describedBy(button(footerOf(d), 'Let it go'))).toEqual([yours]);
    expect(bodyOf(d)!.textContent).toContain(yours);
    await press(button(footerOf(d), 'Let it go'));
    expectRefused('Let it go', 'Let it go', 'It changed meanwhile.');
    expect(describedBy(button(footerOf(dialog('Let it go')), 'Let it go'))[0]).toBe(yours);
  });

  test('Mark settled: Cancel then Mark settled, described by nothing until a press fails', async () => {
    const { state } = sharedWith(cardOf(), 1, 'It changed meanwhile.');
    await mount(<SettleSheet person="alex" currency="USD" shared={state} onClose={() => {}} />);
    const d = expectFooter('Mark settled', 'Cancel', ['Mark settled', 'btn']);
    expect(button(footerOf(d), 'Mark settled')!.getAttribute('aria-describedby')).toBeNull();
    await press(button(footerOf(d), 'Mark settled'));
    expectRefused('Mark settled', 'Mark settled', 'It changed meanwhile.');
  });
});
