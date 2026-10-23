import { describe, expect, test } from 'bun:test';
import { isPerson, isShare, isIou, isPayment, isDismissed, isExpenseSettings, isHandle, nameKey, personName, REMOVED_NAME, type Share, type Iou, type Payment } from '@/lib/shared-expenses/model';
import { itemsOf, balancesOf, itemState, paidOf, allClosed, monthsBetween } from '@/lib/shared-expenses/balances';
import { venmoLink, handoffLinks, cutNote, linkAmount, messageText, noteOf, UNCONFIRMED_LINKS, NOTE_CHARS } from '@/lib/shared-expenses/links';

// Shared expenses (#49), the pure part: the closed shapes of what is kept
// (lib/shared-expenses/model.ts), each person's balance worked out from them
// (lib/shared-expenses/balances.ts), and the handoff's links and message
// (lib/shared-expenses/links.ts).

const AT = '2026-10-03T12:00:00.000Z';

const share = (entries: Share['entries'], over: Partial<Share> = {}): Share => ({
  version: 1,
  account_id: 'acc-card',
  amount_was: 120,
  currency: 'USD',
  date: '2026-10-03',
  what: 'Dinner at Joe’s',
  entries,
  created_at: AT,
  updated_at: AT,
  ...over,
});

const iou = (over: Partial<Iou> = {}): Iou => ({
  version: 1,
  person: 'alex',
  direction: 'by_you',
  amount: 25,
  currency: 'USD',
  date: '2026-10-05',
  what: 'Groceries',
  created_at: AT,
  updated_at: AT,
  ...over,
});

const payment = (amount: number, allocations: Payment['allocations'], over: Partial<Payment> = {}): Payment => ({
  version: 1,
  account_id: 'acc-checking',
  row: { amount, currency: 'USD', date: '2026-10-09' },
  allocations,
  confirmed_at: AT,
  ...over,
});

describe('the shapes are closed', () => {
  test('a person: a name, or none once forgotten, and never a handle that looks like a number', () => {
    const p = { version: 1, name: 'Alex', venmo: 'alex-s', cashtag: 'alexs', app: 'venmo', created_at: AT, updated_at: AT };
    expect(isPerson(p)).toBe(true);
    expect(isPerson({ ...p, email: 'a@example.com' })).toBe(false);
    expect(isPerson({ ...p, venmo: '5551234567' })).toBe(false);
    expect(isPerson({ ...p, name: undefined })).toBe(false);
    expect(isPerson({ version: 1, removed_at: AT, created_at: AT, updated_at: AT })).toBe(true);
    // Forgotten keeps no name and no handle.
    expect(isPerson({ ...p, removed_at: AT })).toBe(false);
    expect(isPerson({ ...p, tag: { id: 'tag-1', how: { kind: 'half' } } })).toBe(true);
    expect(isPerson({ ...p, tag: { id: 'tag-1', how: { kind: 'amount' } } })).toBe(false);
    expect(isPerson({ ...p, version: 2 })).toBe(false);
  });

  test('a share, an IOU, a payment, a dismissed row, the setting: each field this release knows, and nothing else', () => {
    const s = share([{ id: 'e1', person: 'alex', amount: 60, how: { kind: 'half' } }]);
    expect(isShare(s)).toBe(true);
    expect(isShare({ ...s, later: 1 })).toBe(false);
    expect(isShare({ ...s, entries: [] })).toBe(false);
    expect(isShare({ ...s, entries: [s.entries[0], s.entries[0]] })).toBe(false);
    expect(isShare({ ...s, entries: [{ ...s.entries[0], amount: 0 }] })).toBe(false);
    expect(isShare({ ...s, entries: [{ ...s.entries[0], closed: [{ event: 'ev1', kind: 'outside', amount: 10, date: '2026-10-04', at: AT }] }] })).toBe(true);
    expect(isShare({ ...s, entries: [{ ...s.entries[0], closed: [{ event: 'ev1', kind: 'gift', amount: 10, date: '2026-10-04', at: AT }] }] })).toBe(false);
    expect(isIou(iou({ category_id: 'c1' }))).toBe(true);
    // A category is what your part was for: only on one you owe.
    expect(isIou(iou({ direction: 'to_you', category_id: 'c1' }))).toBe(false);
    expect(isIou({ ...iou(), date: '2026-02-30' })).toBe(false);
    expect(isPayment(payment(-60, [{ item: 'e1', amount: 60 }]))).toBe(true);
    expect(isPayment(payment(-60, []))).toBe(false);
    expect(isPayment(payment(0, [{ item: 'e1', amount: 60 }]))).toBe(false);
    expect(isPayment({ ...payment(-60, [{ item: 'e1', amount: 60 }]), kind: 'matched' })).toBe(false);
    expect(isDismissed({ version: 1, date: '2026-10-09', at: AT })).toBe(true);
    expect(isDismissed({ version: 1, date: '2026-10-09', at: AT, why: 'x' })).toBe(false);
    expect(isExpenseSettings({ version: 1, counting: 'part', updated_at: AT })).toBe(true);
    expect(isExpenseSettings({ version: 1, counting: 'offset', updated_at: AT })).toBe(false);
  });

  test('handles, names', () => {
    expect(isHandle('Alex-Smith_2')).toBe(true);
    expect(isHandle('a/b')).toBe(false);
    expect(isHandle('4111111111111111')).toBe(false);
    expect(isHandle('x'.repeat(31))).toBe(false);
    expect(nameKey(' Alex  Smith ')).toBe(nameKey('alexsmith'));
    expect(personName({ name: undefined })).toBe(REMOVED_NAME);
  });
});

describe('balances', () => {
  test('a true net: their part of your dinner less your part of their groceries, closed by one payment', () => {
    const shares = new Map([['txn-dinner', share([{ id: 'e1', person: 'alex', amount: 60 }])]]);
    const ious = new Map([['i1', iou({ category_id: 'groceries' })]]);
    const items = itemsOf(shares, ious);
    expect(balancesOf(items, new Map()).get('alex')).toEqual([{ currency: 'USD', amount: 35, open: 2, oldest: '2026-10-03', over: 0 }]);
    const paid = new Map([['txn-venmo', payment(-35, [{ item: 'e1', amount: 60 }, { item: 'i1', amount: 25 }])]]);
    expect(balancesOf(items, paid).get('alex')).toEqual([]);
    expect(allClosed(items, paid, 'alex')).toBe(true);
  });

  test('partly paid, settled outside, let go: each closes its part; past the amount is said, and counts the other way', () => {
    const shares = new Map([
      ['txn-dinner', share([{ id: 'e1', person: 'alex', amount: 60, closed: [{ event: 'ev1', kind: 'outside', amount: 10, date: '2026-10-04', at: AT }, { event: 'ev2', kind: 'forgiven', amount: 5, date: '2026-10-05', at: AT }] }])],
    ]);
    const items = itemsOf(shares, new Map());
    const paid = new Map([['p1', payment(-20, [{ item: 'e1', amount: 20 }])]]);
    expect(itemState(items.get('e1')!, paidOf(paid, items))).toMatchObject({ paid: 20, outside: 10, forgiven: 5, open: 25, over: false });
    const twice = new Map([...paid, ['p2', payment(-50, [{ item: 'e1', amount: 50 }])]]);
    expect(itemState(items.get('e1')!, paidOf(twice, items))).toMatchObject({ open: -25, over: true });
    expect(balancesOf(items, twice).get('alex')).toEqual([{ currency: 'USD', amount: -25, open: 1, oldest: null, over: 1 }]);
  });

  test('to the cent in minor units, per currency, never netted across currencies', () => {
    const shares = new Map([
      ['t1', share([{ id: 'e1', person: 'alex', amount: 0.1 }])],
      ['t2', share([{ id: 'e2', person: 'alex', amount: 0.2 }])],
      ['t3', share([{ id: 'e3', person: 'alex', amount: 1200 }], { currency: 'JPY' })],
    ]);
    const ious = new Map([['i1', iou({ currency: 'EUR', amount: 12 })]]);
    const list = balancesOf(itemsOf(shares, ious), new Map()).get('alex')!;
    expect(list).toContainEqual({ currency: 'USD', amount: 0.3, open: 2, oldest: '2026-10-03', over: 0 });
    expect(list).toContainEqual({ currency: 'JPY', amount: 1200, open: 1, oldest: '2026-10-03', over: 0 });
    expect(list).toContainEqual({ currency: 'EUR', amount: -12, open: 1, oldest: '2026-10-05', over: 0 });
    // A payment in another currency than its item closes nothing of it.
    const items = itemsOf(shares, ious);
    expect(paidOf(new Map([['p', payment(-12, [{ item: 'i1', amount: 12 }])]]), items).size).toBe(0);
  });

  test('months open, for "let it go?"', () => {
    expect(monthsBetween('2026-03-15', '2026-10-14')).toBe(6);
    expect(monthsBetween('2026-03-15', '2026-10-15')).toBe(7);
    expect(monthsBetween('2026-10-20', '2026-10-01')).toBe(0);
  });
});

describe('the handoff', () => {
  test('only Venmo’s documented form is on: a username, charge or pay, the amount and note encoded', () => {
    expect(UNCONFIRMED_LINKS).toBe(false);
    expect(venmoLink({ direction: 'to_you', amount: 35, currency: 'USD', note: 'Dinner & drinks #2 / tip? 🍕', venmo: 'alex-s' })).toBe(
      'https://venmo.com/alex-s?txn=charge&amount=35.00&note=Dinner%20%26%20drinks%20%232%20%2F%20tip%3F%20%F0%9F%8D%95'
    );
    expect(venmoLink({ direction: 'by_you', amount: 1234.5, currency: 'USD', note: 'Rent', venmo: 'sam' })).toBe('https://venmo.com/sam?txn=pay&amount=1234.50&note=Rent');
    // No username, another currency, nothing to ask, a username that isn't one: no link.
    expect(venmoLink({ direction: 'to_you', amount: 35, currency: 'USD', note: 'x' })).toBeNull();
    expect(venmoLink({ direction: 'to_you', amount: 35, currency: 'EUR', note: 'x', venmo: 'alex' })).toBeNull();
    expect(venmoLink({ direction: 'to_you', amount: 0, currency: 'USD', note: 'x', venmo: 'alex' })).toBeNull();
    expect(venmoLink({ direction: 'to_you', amount: 5, currency: 'USD', note: 'x', venmo: '../evil.com' })).toBeNull();
    expect(handoffLinks({ direction: 'by_you', amount: 35, currency: 'USD', note: 'x', venmo: 'alex', cashtag: 'alexs' }).map((h) => h.via)).toEqual(['venmo']);
  });

  test('the forms nobody documented, only behind the switch', () => {
    const links = handoffLinks({ direction: 'by_you', amount: 35, currency: 'USD', note: 'Rent Oct', venmo: 'alex', cashtag: 'alexs', unconfirmed: true });
    expect(links.map((l) => [l.via, l.href, l.unconfirmed])).toEqual([
      ['venmo', 'https://venmo.com/alex?txn=pay&amount=35.00&note=Rent%20Oct', false],
      ['venmo-app', 'venmo://paycharge?txn=pay&recipients=alex&amount=35.00&note=Rent%20Oct', true],
      ['cashapp', 'https://cash.app/$alexs/35.00', true],
    ]);
    expect(handoffLinks({ direction: 'to_you', amount: 35, currency: 'USD', note: 'x', unconfirmed: true }).map((l) => l.href)).toEqual(['https://venmo.com/?txn=charge&amount=35.00&note=x']);
  });

  test('a note is cut to its code points, on a word, before it is encoded', () => {
    const long = `${'dinner '.repeat(40)}`;
    expect([...cutNote(long)].length).toBeLessThanOrEqual(NOTE_CHARS);
    expect(cutNote(long).endsWith('dinner')).toBe(true);
    const emoji = '🍕'.repeat(250);
    expect([...cutNote(emoji)].length).toBe(NOTE_CHARS);
    expect(cutNote('a\u0000b\nc')).toBe('a b c');
    expect(linkAmount(0.1 + 0.2)).toBe('0.30');
  });

  test('the message says the total, each item from the payer’s side, and where to pay you', () => {
    const text = messageText({
      name: 'Alex',
      direction: 'to_you',
      amount: 35,
      currency: 'USD',
      lines: [
        { what: 'Dinner', date: '2026-10-03', amount: 60, direction: 'to_you' },
        { what: 'Groceries you got', date: '2026-10-05', amount: 25, direction: 'by_you' },
      ],
      ownVenmo: 'me-too',
    });
    expect(text).toBe('Hi Alex, $35.00 is left for you to pay me:\nDinner, Oct 3: $60.00\nGroceries you got, Oct 5: less $25.00\nVenmo: @me-too');
    expect(messageText({ name: 'Sam', direction: 'by_you', amount: 1200, currency: 'JPY', lines: [{ what: 'Ramen', date: '2026-01-09', amount: 1200, direction: 'by_you' }] })).toBe('Hi Sam, I owe you ¥1,200:\nRamen, Jan 9: ¥1,200');
    expect(noteOf([{ what: 'Dinner' }, { what: 'Groceries' }])).toBe('Dinner, Groceries');
  });
});
