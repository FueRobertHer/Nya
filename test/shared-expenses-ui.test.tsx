import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MASK, setAmountsHidden, formatMoney } from '@/lib/format';
import type { Txn } from '@/components/MonthBreakdown';
import MonthBreakdown from '@/components/MonthBreakdown';
import SharedExpensesCard, { aboutInHome } from '@/components/SharedExpensesCard';
import { NO_FX, type FxTable } from '@/lib/fx/rates';
import ShareCostSheet from '@/components/ShareCostSheet';
import HandoffSheet from '@/components/HandoffSheet';
import { ConfirmPaymentSheet, itemsFor, netUnits } from '@/components/ConfirmPaymentSheet';
import { canPayBack, canShare, SharedRowLine, type SharedRowHooks } from '@/components/SharedRows';
import { balanceText, letGoText, reasonsText, rowLine, splitUnits, whoseText } from '@/components/shared-expenses-text';
import type { SharedExpenses } from '@/components/shared-expenses-state';
import type { CardAnswer } from '@/lib/shared-expenses/read';
import type { ItemState } from '@/lib/shared-expenses/balances';
import type { Proposal } from '@/lib/shared-expenses/match';
import { localDate } from '@/lib/local-date';

// Shared expenses (#49) on screen: the card's words for a balance, a long
// open one, a proposal and a row; the card with its people, a proposal and
// the first-use note; the handoff with Venmo's documented link only and the
// message; confirming a payment that could be two people's; sharing a cost;
// and a row's line and actions. Every figure through the formatters, so
// none shows while amounts are hidden (and test/hide-amounts.test.tsx's
// backstop renders each of these again hidden).

const daysAgo = (n: number) => localDate(new Date(Date.now() - n * 86_400_000));
const AT = '2026-10-01T12:00:00.000Z';

function txn(over: Partial<Txn>): Txn {
  return {
    transaction_id: 't',
    date: daysAgo(1),
    name: 'Shop',
    amount: 10,
    pending: false,
    account_name: 'Checking',
    account_type: 'depository',
    institution_name: 'Chase',
    category: 'food and drink',
    category_kind: 'expense',
    iso_currency_code: 'USD',
    vendor_key: 'nm:chase::shop',
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
  } as Txn;
}

const item = (over: Partial<ItemState>): ItemState => ({
  id: 'e-dinner',
  kind: 'share',
  person: 'alex',
  direction: 'to_you',
  amount: 60,
  currency: 'USD',
  date: daysAgo(10),
  what: 'Dinner',
  transaction_id: 't-dinner',
  closed: [],
  paid: 0,
  outside: 0,
  forgiven: 0,
  open: 60,
  over: false,
  ...over,
});

/** Alex owes 60 of a dinner, less 25 of groceries they bought: 35. You owe
 *  Sam 12.50 of a lunch. */
function cardOf(over: Partial<CardAnswer> = {}): CardAnswer {
  return {
    counting: 'part',
    settings_unread: false,
    own: { venmo: 'me-venmo', cashtag: null },
    people: [
      { id: 'alex', name: 'Alex Smith', venmo: 'alex-s', cashtag: null, app: 'venmo', tag: null, requests: [], archived: false, removed: false },
      { id: 'sam', name: 'Sam Lee', venmo: null, cashtag: 'samcash', app: 'cashapp', tag: null, requests: [], archived: false, removed: false },
    ],
    items: [
      item({}),
      item({ id: 'i-groceries', kind: 'iou', direction: 'by_you', amount: 25, open: 25, date: daysAgo(5), what: 'Groceries', transaction_id: undefined, category_id: 'c1' }),
      item({ id: 'i-lunch', kind: 'iou', person: 'sam', direction: 'by_you', amount: 12.5, open: 12.5, date: daysAgo(2), what: 'Lunch', transaction_id: undefined }),
    ],
    shares: [{ transaction_id: 't-dinner', part: null, account_id: 'chk', amount_was: 120, currency: 'USD', date: daysAgo(10), what: 'Dinner', entries: [{ id: 'e-dinner', person: 'alex', amount: 60, how: { kind: 'half' } }], kept_gone: null, updated_at: AT }],
    payments: [],
    dismissed: [],
    balances: {
      alex: [{ currency: 'USD', amount: 35, open: 2, oldest: daysAgo(10), over: 0 }],
      sam: [{ currency: 'USD', amount: -12.5, open: 1, oldest: daysAgo(2), over: 0 }],
    },
    unread: {},
    ...over,
  } as CardAnswer;
}

const shared = (card: CardAnswer | null): SharedExpenses => ({ card, failed: null, open: null, setOpen: () => {}, send: async () => ({ error: null, body: null }), reload: () => {} });

/** As in a browser's page, where alone amounts can be hidden. */
function hidden<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const none = g.window === undefined;
  if (none) g.window = {};
  try {
    setAmountsHidden(true);
    return fn();
  } finally {
    setAmountsHidden(false);
    if (none) delete g.window;
  }
}
afterEach(() => setAmountsHidden(false));

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const usd = (n: number) => formatMoney(n, 'USD');

describe('the words', () => {
  test('a balance from your side, both ways, and settled', () => {
    expect(balanceText('Alex', 35, usd)).toBe('Alex owes you $35.00');
    expect(balanceText('Alex', -12.5, usd)).toBe('You owe Alex $12.50');
    expect(balanceText('Alex', 0, usd)).toBe('Settled up');
  });

  test('“let it go?” only for what they owe you, open six months or more', () => {
    expect(letGoText(35, '2026-04-23', '2026-10-23')).toBe('Open for 6 months: let it go?');
    expect(letGoText(35, '2026-04-24', '2026-10-23')).toBeNull();
    expect(letGoText(-35, '2025-01-01', '2026-10-23')).toBeNull();
    expect(letGoText(35, null, '2026-10-23')).toBeNull();
  });

  test('why a row may be a payment, and whose it could be', () => {
    const p = { fit: 'requested', app: 'venmo', named: true, days: 2, choice: false } as Proposal;
    expect(reasonsText(p, 'Alex', true)).toBe('The amount you asked for · From Venmo · Says Alex · 2 days after you asked');
    expect(reasonsText({ ...p, fit: 'part', app: null, named: false, days: 1 }, 'Alex', false)).toBe('Less than the balance · 1 day after the newest');
    expect(whoseText(['Alex', 'Sam'])).toBe('Could be Alex’s or Sam’s');
    expect(whoseText(['Alex', 'Sam', 'Kim'])).toBe('Could be Alex’s, Sam’s or Kim’s');
  });

  test('what a row says: shared, paid back, an IOU, or why it counts whole', () => {
    const names = new Map([['alex', 'Alex']]);
    expect(rowLine({ shared: { your_part: 60, people: [{ person: 'alex', item: 'e', amount: 60 }], counted: true } }, names, usd)).toBe('Shared: your part $60.00 · Alex $60.00');
    expect(rowLine({ settles: { rest: 0, people: [{ person: 'alex', item: 'e', amount: 35, direction: 'to_you' }], counted: true } }, names, usd)).toBe('Paid back: Alex $35.00');
    expect(rowLine({ shared_iou: { person: 'alex', item: 'i', cash: 0 } }, names, usd)).toBe('Your part of what Alex paid (an IOU)');
    expect(rowLine({ shared_iou: { person: 'gone', item: 'i', cash: 0 } }, names, usd)).toBe('Your part of what Someone you removed paid (an IOU)');
    expect(rowLine({ shared_unapplied: 'group' }, names, usd)).toBe('Shared, but counted whole: it is in a group, which says how it counts');
    expect(rowLine({}, names, usd)).toBeNull();
  });

  test('a cost split half, evenly or by percent, what doesn’t split to the cent yours', () => {
    expect(splitUnits(12001, { kind: 'half' }, 1)).toEqual([6000]);
    expect(splitUnits(10000, { kind: 'even', ways: 3 }, 2)).toEqual([3333, 3333]);
    expect(splitUnits(10000, { kind: 'percent', percent: 25 }, 2, [25, 40])).toEqual([2500, 4000]);
    expect(splitUnits(10000, { kind: 'amount' }, 2)).toEqual([]);
  });
});

describe('the card', () => {
  const venmo = txn({ transaction_id: 't-venmo', name: 'VENMO CASHOUT ALEX SMITH', amount: -35, date: daysAgo(3), category: 'transfer in', category_kind: 'transfer', transaction_code: 'transfer' });

  test('the people and their balances, a strong proposal first, and that Nya never moves money', () => {
    const html = renderToStaticMarkup(<SharedExpensesCard shared={shared(cardOf())} txns={[venmo]} facts={null} tags={[]} taxonomy={null} currency="USD" />);
    const said = text(html);
    expect(said).toContain('Alex Smith owes you $35.00');
    expect(said).toContain('You owe Sam Lee $12.50');
    expect(said).toContain('Ask for it');
    expect(said).toContain('Paid back?');
    expect(said).toContain('Looks like Alex Smith paying you back');
    expect(said).toContain('The whole balance · From Venmo · Says Alex Smith');
    expect(said).toContain('Nya never sends, receives or holds money');
    expect(said).not.toContain('let it go?');
  });

  test('with amounts hidden, no figure shows', () => {
    const html = hidden(() => renderToStaticMarkup(<SharedExpensesCard shared={shared(cardOf())} txns={[venmo]} facts={null} tags={[]} taxonomy={null} currency="USD" />));
    expect(html).not.toContain('35.00');
    expect(html).not.toContain('12.50');
    expect(html).toContain(MASK);
  });

  test('open seven months: the line asks whether to let it go', () => {
    const old = new Date();
    old.setMonth(old.getMonth() - 7);
    const card = cardOf({ balances: { alex: [{ currency: 'USD', amount: 35, open: 2, oldest: localDate(old), over: 0 }], sam: [] } });
    expect(text(renderToStaticMarkup(<SharedExpensesCard shared={shared(card)} txns={[]} facts={null} tags={[]} taxonomy={null} currency="USD" />))).toContain('Open for 7 months: let it go? Let it go');
  });

  test('a balance in another currency, about in the home one at the latest rates: an estimate, never stored', () => {
    const fx: FxTable = { ...NO_FX, home: 'USD', latest: { date: daysAgo(1), rates: { USD: '1.1' } }, fetch: { last_ok: new Date().toISOString() } as FxTable['fetch'] };
    const balances = [
      { currency: 'USD', amount: 35, open: 2, oldest: null, over: 0 },
      { currency: 'EUR', amount: -10, open: 1, oldest: null, over: 0 },
    ];
    expect(aboutInHome(balances, fx)).toEqual({ amount: 24, currency: 'USD', stale: false });
    expect(aboutInHome(balances, { ...fx, fetch: null })?.stale).toBe(true);
    // Only the home currency, or no home currency: nothing to say.
    expect(aboutInHome([balances[0]], fx)).toBeNull();
    expect(aboutInHome(balances, NO_FX)).toBeNull();
    // A currency with no rate: no estimate, never one short of it.
    expect(aboutInHome([...balances, { currency: 'JPY', amount: 100, open: 1, oldest: null, over: 0 }], fx)).toBeNull();
    const card = cardOf({ balances: { alex: balances, sam: [] } });
    const said = text(renderToStaticMarkup(<SharedExpensesCard shared={shared(card)} txns={[]} facts={null} tags={[]} taxonomy={null} currency="USD" fx={fx} />));
    expect(said).toContain('About $24.00 owed to you in all, at the latest exchange rates: an estimate');
  });

  test('the first time: what it is for, and how to begin', () => {
    const said = text(renderToStaticMarkup(<SharedExpensesCard shared={shared(cardOf({ people: [], items: [], shares: [], balances: {} }))} txns={[]} facts={null} tags={[]} taxonomy={null} currency="USD" />));
    expect(said).toContain('Keep track of what people owe you and what you owe them. Nya keeps the list; the money moves in Venmo, Cash App or however you pay each other.');
    expect(said).toContain('Add someone');
  });

  test('what couldn’t be read: no balance, and the damaged removed only once confirmed', () => {
    const card = cardOf({ balances: null, unread: { 'expense-shares': { unreadable: ['t-x'], unrecognised: [] } } });
    const said = text(renderToStaticMarkup(<SharedExpensesCard shared={shared(card)} txns={[]} facts={null} tags={[]} taxonomy={null} currency="USD" />));
    expect(said).toContain('Some of what you keep here couldn’t be read: 1 shared transaction');
    expect(said).toContain('Balances aren’t shown until everything can be read');
    expect(said).toContain('Remove what is damaged');
    expect(said).not.toContain('owes you');
  });

  test('a shared transaction gone from the accounts: kept, with a move, keep or remove', () => {
    const moved = txn({ transaction_id: 't-dinner-2', name: 'Bistro', amount: 120, date: daysAgo(9) });
    const said = text(renderToStaticMarkup(<SharedExpensesCard shared={shared(cardOf())} txns={[moved]} facts={{ gone: { shares: ['t-dinner'], payments: [] }, twice: [] }} tags={[]} taxonomy={null} currency="USD" />));
    expect(said).toContain('Dinner,');
    expect(said).toContain('its transaction isn’t in your accounts any more');
    expect(said).toContain('Move to Bistro');
    expect(said).toContain('Keep it');
  });
});

describe('the handoff', () => {
  test('Venmo’s documented link alone, the note editable, and the message; nothing that moves money', () => {
    const html = renderToStaticMarkup(<HandoffSheet person="alex" currency="USD" shared={shared(cardOf())} onClose={() => {}} />);
    expect(html).toContain('href="https://venmo.com/alex-s?txn=charge&amp;amount=35.00&amp;note=Dinner%2C%20Groceries"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('venmo://');
    expect(html).not.toContain('cash.app');
    const said = text(html);
    expect(said).toContain('Request on Venmo');
    expect(said).toContain('Nya never sends, receives or holds money. This opens Venmo with the request filled in');
    expect(said).toContain('Venmo may show this note to your Venmo friends.');
    expect(said).toContain('Hi Alex Smith, $35.00 is left for you to pay me:');
    expect(said).toContain('Venmo: @me-venmo');
  });

  test('without a Venmo username, the message only, and a place to add one', () => {
    const said = text(renderToStaticMarkup(<HandoffSheet person="sam" currency="USD" shared={shared(cardOf())} onClose={() => {}} />));
    expect(said).toContain('Send Sam Lee the message below however you two pay each other');
    expect(said).toContain('Hi Sam Lee, I owe you $12.50:');
    expect(said).not.toContain('on Venmo');
  });

  test('with amounts hidden, the message on screen shows none (what is copied has them)', () => {
    const html = hidden(() => renderToStaticMarkup(<HandoffSheet person="alex" currency="USD" shared={shared(cardOf())} onClose={() => {}} />));
    expect(text(html)).not.toContain('35.00');
    expect(html).toContain(MASK);
  });
});

describe('confirming a payment', () => {
  const venmo = txn({ transaction_id: 't-venmo', name: 'VENMO CASHOUT', amount: -35, date: daysAgo(3) });

  test('each person’s items a fieldset under their name; one that could be two people’s says so, and only Confirm writes', () => {
    const html = renderToStaticMarkup(
      <ConfirmPaymentSheet t={venmo} person="alex" preset={[]} also={['sam']} fromProposal shared={shared(cardOf())} onClose={() => {}} />
    );
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend class="section-label">Alex Smith</legend>');
    const said = text(html);
    expect(said).toContain('Could be Alex Smith’s or Sam Lee’s: choose whose it is.');
    expect(said).toContain('Confirm');
    expect(said).toContain('Not a repayment');
    // Nothing chosen: nothing is checked.
    expect(html).not.toContain('checked=""');
  });

  test('a strong proposal’s items come checked, and what is the other way is taken off', () => {
    const preset = [
      { item: 'e-dinner', amount: 60 },
      { item: 'i-groceries', amount: 25 },
    ];
    const html = renderToStaticMarkup(<ConfirmPaymentSheet t={venmo} person="alex" preset={preset} shared={shared(cardOf())} onClose={() => {}} />);
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(text(html)).toContain('All of it pays back what you chose.');
    const card = cardOf();
    const items = itemsFor(card, 'USD', 'to_you');
    expect(items.map((i) => i.id)).toEqual(['e-dinner', 'i-groceries', 'i-lunch']);
    expect(netUnits(preset, items, 'to_you', 'USD')).toBe(3500);
  });
});

describe('sharing a cost, and a row of the list', () => {
  const dinner = txn({ transaction_id: 't-new', name: 'Bistro', amount: 90 });

  test('the sheet lists the people, how to split, and your part', () => {
    const said = text(renderToStaticMarkup(<ShareCostSheet t={dinner} shared={shared(cardOf())} onClose={() => {}} />));
    expect(said).toContain('Share the cost');
    expect(said).toContain('Bistro: $90.00');
    expect(said).toContain('Alex Smith');
    expect(said).toContain('Sam Lee');
    expect(said).toContain('Your part: $90.00');
    expect(said).toContain('Nya never asks them for it on its own.');
  });

  test('what a row offers: share posted money out; say what money in paid back', () => {
    expect(canShare(dinner)).toBe(true);
    expect(canShare({ ...dinner, pending: true })).toBe(false);
    expect(canShare({ ...dinner, amount: -20 })).toBe(false);
    expect(canPayBack({ ...dinner, amount: -20 }, false)).toBe(true);
    expect(canPayBack(dinner, false)).toBe(false);
    expect(canPayBack(dinner, true)).toBe(true);
    expect(canPayBack({ ...dinner, shared: { your_part: 45, people: [], counted: true } }, true)).toBe(false);
  });

  test('a shared row’s line, and an IOU’s row listed on its day', () => {
    const hooks: SharedRowHooks = { names: new Map([['alex', 'Alex Smith']]), onShare: () => {}, onPaidBack: () => {}, onIou: () => {}, owes: false };
    const row = txn({ transaction_id: 't-dinner', name: 'Bistro', amount: 60, shared: { your_part: 60, people: [{ person: 'alex', item: 'e', amount: 60 }], counted: true }, shared_was: 120, shared_of: 't-dinner' });
    expect(text(renderToStaticMarkup(<SharedRowLine t={row} hooks={hooks} />))).toContain('Shared: your part $60.00 · Alex Smith $60.00');
    const iou = txn({ transaction_id: 'iou:i1', name: 'Groceries', amount: 25, date: daysAgo(0), account_name: '', shared_iou: { person: 'alex', item: 'i1', cash: 0 } });
    const html = renderToStaticMarkup(<MonthBreakdown txns={[iou]} notes={[]} loading={false} onRecategorize={() => {}} onRename={() => {}} shared={hooks} />);
    expect(text(html)).toContain('Your part of what Alex Smith paid (an IOU)');
  });
});
