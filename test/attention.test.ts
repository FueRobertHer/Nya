import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_LINKS_TITLE, attentionItems, type AttentionInput, type Placed } from '@/components/attention';
import { fmtStaleDay, type Institution } from '@/components/accounts-format';
import { budgetAlerts, paymentAlerts, type PaymentAccount } from '@/components/Insights';
import { severityOf } from '@/lib/accounts-status';
import { CAUSES, type Cause, type ConnectionHealth } from '@/lib/connection-state';
import type { ConnectorIssue } from '@/lib/connectors/types';
import type { ConnectorsList } from '@/components/Connectors';
import { NOTHING } from './home-attention';

// Home's Needs attention (rollout phase 4b, components/attention.ts): what
// asks the person to act, each row in its object's own color and words,
// going where it is fixed.

const now = new Date('2026-10-08T12:00:00');
const plaid = (cause: Cause, over: Partial<ConnectionHealth> = {}): ConnectionHealth => ({ ...CAUSES[cause], cause, side: 'bank', last_ok_at: '2026-09-12T12:00:00Z', ...over });
const connector = (issue: ConnectorIssue, connection_id = 'c1'): ConnectionHealth => ({
  state: issue === 'waiting' || issue === 'missing' ? 'partial' : 'needs_reauth',
  cause: 'connector',
  side: 'connector',
  action: 'none',
  last_ok_at: null,
  detail: { connector: 'simplefin', label: 'SimpleFIN', host: null, connection_id, issue, messages: [], accounts: ['Savings'] },
});
const inst = (name: string, over: Partial<Institution> = {}): Institution =>
  ({ institution_name: name, item_id: name, error: null, needs_reauth: false, accounts: [{ account_id: `${name}-a`, name: 'Checking', mask: null, type: 'depository', balance: 100, currency: 'USD' }], holdings: [], ...over }) as Institution;
const placed = (i: Institution): Placed => ({ inst: i, severity: severityOf(i) });
const rows = (over: Partial<AttentionInput>) => attentionItems({ ...NOTHING, now, ...over }).map((r) => [r.severity, r.title, r.sub ?? null, r.go.to]);

describe('connections, in their cards’ colors', () => {
  test('one that needs the person, or is short, is red, going to its card: what to do first, as the redesign draws it', () => {
    const login = inst('Chase', { error: 'Login', needs_reauth: true, stale_as_of: '2026-09-12', health: plaid('login') });
    expect(rows({ cards: [placed(login)] })).toEqual([['critical', 'Reconnect Chase', `Balances as of ${fmtStaleDay('2026-09-12')}`, 'card']]);
    expect(rows({ cards: [placed(inst('Chase', { error: 'Gone', health: plaid('revoked') }))] })[0][1]).toBe('Connect Chase again');
    // Nothing for the person to do there: its name and its card's badge.
    // Short with no badge of its own: its card's error line.
    const down = inst('Ally', { error: "Couldn't refresh", stale_missing: 1, stale_as_of: '2026-09-12' });
    expect(rows({ cards: [placed(down)] })).toEqual([['critical', 'Ally', "Couldn't refresh", 'card']]);
  });

  test('one that couldn’t refresh but needs nothing from the person is not listed', () => {
    const down = inst('Ally', { error: 'Down', stale_as_of: '2026-09-12', health: plaid('institution_down') });
    expect(severityOf(down)).toBe('caution');
    expect(rows({ cards: [placed(down)] })).toEqual([]);
  });

  test('a connection ending within three days: today’s words, title and line, every one, none twice', () => {
    const ends = (name: string, days: number) => inst(name, { health: plaid('consent_ending', { state: 'reconnect_soon', ends_at: new Date(2026, 9, 8 + days, 12).toISOString() }) });
    expect(rows({ cards: [ends('A', 3), ends('B', 1), ends('C', 0), ends('D', 9)].map(placed) })).toEqual([
      ['caution', 'Reconnect A', 'Plaid says its connection ends in 3 days', 'card'],
      ['caution', 'Reconnect B', 'Plaid says its connection ends tomorrow', 'card'],
      ['caution', 'Reconnect C', 'Plaid says its connection ends today', 'card'],
    ]);
    // Red for something else as well: its one row is the red one.
    const both = inst('E', { error: 'Login', needs_reauth: true, health: plaid('consent_ending', { state: 'reconnect_soon', ends_at: new Date(2026, 9, 9, 12).toISOString() }) });
    expect(rows({ cards: [{ inst: both, severity: 'critical' }] }).map((r) => r[0])).toEqual(['critical']);
  });

  test('connection warnings that couldn’t be read: said, so an empty list never claims nothing needs you', () => {
    // In the Accounts tab's colors: red for the connections, amber for Plaid's warnings.
    expect(rows({ unread: { health: true, connectors: true } })).toEqual([
      ['critical', 'Your own sync’s connections couldn’t be loaded', 'One that needs you may not be listed', 'accounts'],
      ['caution', "Plaid's warnings couldn't be read just now", 'A connection that is about to end may not be listed', 'accounts'],
    ]);
    expect(rows({ unread: { health: false, connectors: false } })).toEqual([]);
  });

  test('a SimpleFIN connection failing as a whole is one row, not one per bank', () => {
    const paying = (name: string) => inst(name, { manual: true, connector: 'simplefin', connection_id: 'c1', error: 'Pay', stale_as_of: '2026-09-12', health: connector('payment') });
    expect(rows({ cards: [placed(paying('Ally')), placed(paying('Chase'))] })).toEqual([['critical', 'Ally', 'Payment due at SimpleFIN', 'card']]);
  });

  test('what a connection says of each bank is each bank’s row: two cards to sign are two rows', () => {
    const sign = (name: string, messages: string[]) => {
      const health = connector('sign');
      return inst(name, { manual: true, connector: 'simplefin', connection_id: 'c1', health: { ...health, detail: { ...health.detail!, messages } } });
    };
    const both = [sign('Ally', ['Card (+$40.00)']), sign('Chase', ['Visa (+$12.00)'])].map(placed);
    expect(both.map((p) => p.severity)).toEqual(['critical', 'critical']);
    expect(rows({ cards: both })).toEqual([
      ['critical', 'Ally', 'Needs your answer', 'card'],
      ['critical', 'Chase', 'Needs your answer', 'card'],
    ]);
  });

  test('accounts its connector stopped sending: amber, as its card, with its badge', () => {
    const missing = inst('Ally', { manual: true, connector: 'simplefin', connection_id: 'c1', health: connector('missing') });
    expect(severityOf(missing)).toBe('caution');
    expect(rows({ cards: [placed(missing)] })).toEqual([['caution', 'Ally', 'Missing accounts', 'card']]);
  });

  test('accounts Plaid offers that aren’t added: information, in the card’s words', () => {
    expect(rows({ cards: [placed(inst('Chase', { new_accounts_available: true }))] })).toEqual([['info', "Chase has accounts you haven't added yet", null, 'card']]);
  });

  test('one with no card on Accounts goes to Settings > Connections, to its card there', () => {
    const login = inst('Chase', { error: 'Login', needs_reauth: true, health: plaid('login') });
    const [row] = attentionItems({ ...NOTHING, now, hiddenOnly: [placed(login)] });
    expect(row.go).toEqual({ to: 'connections', item_id: 'Chase' });
  });

  test('SimpleFIN and Lunch Flow connections with no card: refused or gone (red), offered and none chosen (amber)', () => {
    const conn = (connection_id: string, over: object) => ({ connection_id, connector: 'simplefin', label: `Conn ${connection_id}`, last_fetch: null, accounts: [], available: [], ...over });
    const connectors = {
      connections: [
        conn('a', { last_fetch: { ok: false, kind: 'refused', problems: [], missing: [], note: null } }),
        conn('b', { available: [{ id: 'x' }] }),
        conn('c', { last_fetch: { ok: true, kind: null, problems: ['x'], missing: [], note: null } }),
      ],
      orphaned: [{ connection_id: 'd', accounts: [{ name: 'Savings' }] }],
    } as unknown as ConnectorsList;
    expect(rows({ connectors, cardless: new Set(['a', 'b', 'c', 'd']) })).toEqual([
      ['critical', 'Conn a', 'Needs connecting again', 'connections'],
      ['critical', 'Savings is left from a connection that is gone', null, 'connections'],
      ['caution', "Conn b has accounts you haven't added yet", null, 'connections'],
    ]);
  });
});

describe('the rest', () => {
  test('each account question, as its card asks it, hidden accounts’ too, going to its card', () => {
    const asked = inst('Ally', {
      accounts: [{ account_id: 'z', name: 'Savings', mask: '1234', type: 'depository', balance: 0, currency: 'USD', hidden: true, question: { kind: 'zero', end: '2026-09-01', since: '2026-09-01' } }],
    } as Partial<Institution>);
    const [row] = attentionItems({ ...NOTHING, now, cards: [placed(asked)], institutions: [asked] });
    expect(row).toMatchObject({ severity: 'caution', go: { to: 'card', item_id: 'Ally' } });
    expect(row.title).toStartWith('Savings ••1234 has been at $0.00 with no activity since');
    expect(row.title).toEndWith('Closed?');
  });

  test('transactions to review, counted', () => {
    expect(rows({ review: 12 })).toEqual([['info', '12 transactions to review', null, 'review']]);
    expect(rows({ review: 1 })[0][1]).toBe('1 transaction to review');
    expect(rows({ review: 0 })).toEqual([]);
  });

  test('payments: overdue red, due within a week amber, every one, going to the account’s sheet', () => {
    const card = (name: string, liability: PaymentAccount['liability']): PaymentAccount => ({ item_id: 'i', account_id: name, name, type: 'credit', balance: 500, currency: 'USD', liability });
    const day = (n: number) => `2026-10-${String(8 + n).padStart(2, '0')}`;
    const payments = paymentAlerts(
      [
        card('Visa', { minimum_payment: 25, next_due_date: day(5), is_overdue: false }),
        card('Amex', { minimum_payment: 35, next_due_date: day(1), is_overdue: false }),
        card('Store', { minimum_payment: 10, next_due_date: day(2), is_overdue: false }),
        card('Old', { minimum_payment: 40, next_due_date: null, is_overdue: true }),
        card('Later', { minimum_payment: 5, next_due_date: day(20), is_overdue: false }),
      ],
      now
    );
    expect(rows({ payments })).toEqual([
      ['critical', 'Old is overdue', 'Minimum $40.00', 'account'],
      ['caution', 'Amex due tomorrow', 'Minimum $35.00', 'account'],
      ['caution', 'Store due in 2 days', 'Minimum $10.00', 'account'],
      ['caution', 'Visa due in 5 days', 'Minimum $25.00', 'account'],
    ]);
    expect(attentionItems({ ...NOTHING, now, payments })[0].go).toEqual({ to: 'account', item_id: 'i', account_id: 'Old' });
  });

  test('budgets: amber, the worst two, then how many more', () => {
    const alerts = {
      alerts: [
        { key: 'a', text: 'Over your Food budget: $320.00 of $300.00', title: 'Over your Food budget', sub: '$320.00 of $300.00' },
        { key: 'b', text: 'Approaching your Fun budget (92%)', title: 'Approaching your Fun budget (92%)' },
      ],
      more: 3,
    };
    expect(rows({ budgets: alerts })).toEqual([
      ['caution', 'Over your Food budget', '$320.00 of $300.00', 'budgets'],
      ['caution', 'Approaching your Fun budget (92%)', null, 'budgets'],
      ['caution', '3 more budgets over or nearly over', null, 'budgets'],
    ]);
    expect(attentionItems({ ...NOTHING, now, budgets: alerts }).every((r) => r.spending)).toBe(true);
    expect(budgetAlerts({ txns: null })).toEqual({ alerts: [], more: 0 });
  });

  test('the offer of a home currency: amber while the total adds currencies as they are, neutral for transactions alone', () => {
    expect(rows({ currency: { budgets: 'USD', accounts: 'EUR' } })).toEqual([['caution', 'Show your totals in one currency', 'Your accounts are in more than one currency', 'currency']]);
    expect(rows({ currency: { budgets: 'USD', accounts: null, why: 'transactions' } })).toEqual([['info', 'Show your totals in one currency', 'Your transactions are in more than one currency', 'currency']]);
  });

  test('a restore: a bank it brought back that isn’t connected is red; one that can’t be read amber; unfinished has its banner', () => {
    expect(rows({ restore: { unfinished: true, waiting: [], unreadable: false } })).toEqual([]);
    expect(rows({ restore: { unfinished: false, waiting: [{ institution_name: 'Chase', last: null }], unreadable: true } })).toEqual([
      ['critical', "Chase isn't connected after a restore", "It isn't counted in your net worth", 'restore'],
      ['caution', "A restore can't be read", 'No total is recorded until it can be', 'restore'],
    ]);
    expect(rows({ restore: { unfinished: false, waiting: [{ institution_name: 'Chase', last: null }, { institution_name: 'Ally', last: null }], unreadable: false } })[0][1]).toBe(
      "Chase and Ally aren't connected after a restore"
    );
  });

  test('reconnected accounts Settings suggests linking: named as there, in the IA’s words, going to its card', () => {
    expect(rows({ linkOffer: [] })).toEqual([]);
    expect(rows({ linkOffer: ['Chase Checking ••4821'] })).toEqual([['info', 'Chase Checking ••4821 may continue an earlier account', 'Link its history', 'connections']]);
    expect(rows({ linkOffer: ['Chase Checking ••4821', 'Chase Savings ••1111'] })).toEqual([
      ['info', '2 reconnected accounts may continue earlier ones', 'Link the history of Chase Checking ••4821 and Chase Savings ••1111', 'connections'],
    ]);
    expect(rows({ linkOffer: ['A ••1', 'B ••2', 'C ••3', 'D ••4'] })[0].slice(1, 3)).toEqual([
      '4 reconnected accounts may continue earlier ones',
      'Link the history of A ••1, B ••2 and 2 more',
    ]);
    // Settings > Connections, on the Reconnected accounts card's title.
    expect(attentionItems({ ...NOTHING, now, linkOffer: ['A ••1'] })[0].go).toEqual({ to: 'connections', focus: ACCOUNT_LINKS_TITLE });
  });

  test('worst first, each level in its order', () => {
    const order = attentionItems({
      ...NOTHING,
      now,
      review: 2,
      currency: { budgets: 'USD', accounts: 'EUR' },
      restore: { unfinished: false, waiting: [{ institution_name: 'Chase', last: null }], unreadable: false },
    }).map((r) => r.key);
    expect(order).toEqual(['restore-waiting', 'currency', 'review']);
  });

  test('a title and its line as the alert built them: a name holding a colon is never split', () => {
    const card: PaymentAccount = { item_id: 'i', account_id: 'a', name: 'Chase: Sapphire', type: 'credit', balance: 500, currency: 'USD', liability: { minimum_payment: 25, next_due_date: '2026-10-09', is_overdue: false } };
    const [due] = paymentAlerts([card], now);
    expect(due.text).toBe('Chase: Sapphire: $25.00 due tomorrow');
    expect(rows({ payments: [due] })).toEqual([['caution', 'Chase: Sapphire due tomorrow', 'Minimum $25.00', 'account']]);
    // The line under it starts a sentence: "overspending" as "Overspending".
    const carried = { alerts: [{ key: 'c', text: 'x', title: 'Over your Food budget', sub: 'overspending carried over left nothing of it this month, and $10.00 is spent' }], more: 0 };
    expect(rows({ budgets: carried })[0][2]).toBe('Overspending carried over left nothing of it this month, and $10.00 is spent');
  });
});

describe('the dashboard', () => {
  const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');

  test('builds the rows from what the Accounts tab and Settings > Connections show, only on Home', () => {
    const memo = dashboard.slice(dashboard.indexOf('const attention = useMemo('), dashboard.indexOf('// Where a Needs attention row goes'));
    expect(memo).toContain('if (!homeShown) return null;');
    expect(memo).toContain('severity: c.severity');
    expect(memo).toContain('cardless: cardlessConnectors,');
    expect(memo).toContain('review: reviewOn ? countToReview(txns ?? []) : 0,');
    expect(dashboard).toContain('const reviewOn = !!review.view?.on;');
    expect(memo).toContain('currency: offer && !base && !currencyProblem && !offerHidden ? offer : null,');
    expect(memo).toContain('amountsHidden]);');
  });

  test('draws Needs attention under the Net worth card, the admin’s card under it, and Insights below', () => {
    const home = dashboard.slice(dashboard.indexOf("{tab === 'home' && ("));
    const at = (s: string) => home.indexOf(s);
    expect(at('<NetWorthCard')).toBeLessThan(at('<NeedsAttention'));
    expect(at('<NeedsAttention')).toBeLessThan(at('{admin && <AdminAttention'));
    expect(at('{admin && <AdminAttention')).toBeLessThan(at('<Insights'));
    // The unfinished restore's banner stays on every tab, Home's too.
    expect(dashboard.indexOf('<RestoreBanner')).toBeLessThan(dashboard.indexOf("{tab === 'home' && ("));
  });
});
