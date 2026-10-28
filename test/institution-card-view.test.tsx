import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import InstitutionCard, { type InstitutionCardProps } from '@/components/InstitutionCard';
import { liabilitySummary, type Account, type Institution } from '@/components/accounts-format';
import { CAUSES, type Cause, type ConnectionHealth } from '@/lib/connection-state';

// One institution's card on the Accounts tab (rollout phase 3). Its notices
// are what Nya says about a number that is short, dated or held, so each
// keeps its words and its color as the card is rebuilt: this pins them as
// they were on main before the card moved, and later steps change only the
// class a notice is drawn with, never the words.

const noop = () => {};
const noon = (day: string) => new Date(`${day}T12:00:00`).toISOString();
const health = (cause: Cause, over: Partial<ConnectionHealth> = {}): ConnectionHealth => ({
  ...CAUSES[cause],
  cause,
  side: 'bank',
  last_ok_at: noon('2026-09-12'),
  ...over,
});

const account = (over: Partial<Account> = {}): Account => ({
  account_id: 'acc_checking',
  name: 'Total Checking',
  official_name: null,
  mask: '4421',
  type: 'depository',
  subtype: 'checking',
  balance: 1200,
  limit: null,
  currency: 'USD',
  ...over,
});

const institution = (over: Partial<Institution> = {}): Institution => ({
  institution_name: 'Chase',
  item_id: 'item_chase',
  accounts: [account()],
  holdings: [],
  error: null,
  needs_reauth: false,
  ...over,
});

const render = (inst: Institution, over: Partial<InstitutionCardProps> = {}) =>
  renderToStaticMarkup(
    <InstitutionCard
      inst={inst}
      institutions={[inst]}
      base={null}
      shownCurrency="USD"
      connecting={false}
      expandedHoldings={new Set()}
      unallowedIds={new Set()}
      lifecycle={{ busy: false, open: noop, stillOpen: async () => null, confirmEnd: async () => null, reopen: async () => {} }}
      onOpenAccount={noop}
      toggleHoldings={noop}
      onDetails={noop}
      onRemove={noop}
      onConnector={noop}
      startReconnect={noop}
      startAllowTransactions={noop}
      startEnableLiabilities={noop}
      startManageAccounts={noop}
      {...over}
    />
  );

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Each notice line, as [its color, its text], then each toned badge, in
 *  order. Before phase 3b a notice was a `div.error` (red) or a
 *  `.stale-note` (amber); since, one `.notice` in the card's one color
 *  (lib/accounts-status.ts), with the same words. A held row's line was
 *  drawn plain (`manual-updated`) before phase 3a, and is a badge since:
 *  amber held at its last known balance, red when not counted at all. */
function notices(html: string): [string, string][] {
  const found: [string, string][] = [];
  for (const m of html.matchAll(/<div class="notice (critical|caution)">/g)) {
    const rest = html.slice(m.index! + m[0].length);
    const stops = ['<details', '<div class="notice', '</div></div>'].map((s) => rest.indexOf(s)).filter((i) => i >= 0);
    const own = rest.slice(0, Math.min(rest.length, ...stops));
    for (const p of own.matchAll(/<p>([\s\S]*?)<\/p>/g)) found.push([m[1], text(p[1])]);
  }
  // Badges hold only text.
  for (const m of html.matchAll(/<span class="(badge (?:warn|neg))">([^<]*)<\/span>/g)) found.push([m[1], text(m[2])]);
  return found;
}

/** The plain lines under a card's header: when it last synced, and the
 *  institution's own lines (`.empty-note` before phase 3b). */
const helpers = (html: string) => [...html.matchAll(/<p class="helper">([\s\S]*?)<\/p>/g)].map((m) => text(m[1]));

describe('the institution card notices, words and color', () => {
  test('a failed fetch with recovered balances is amber and dated', () => {
    const html = render(institution({ error: 'Could not fetch balances', stale_as_of: '2026-10-01' }));
    expect(notices(html)).toEqual([['caution', 'Could not fetch balances · balances as of Oct 1']]);
  });

  test('needing reconnecting stays red, with its date, and offers Reconnect by name', () => {
    const html = render(
      institution({ error: 'Chase needs to be reconnected', needs_reauth: true, stale_as_of: '2026-10-01' })
    );
    expect(notices(html)).toEqual([['critical', 'Chase needs to be reconnected · balances as of Oct 1']]);
    expect(html).toContain('aria-label="Reconnect Chase"');
  });

  test('accounts that could not be shown keep it red: the total is short, not just old', () => {
    const one = render(institution({ error: 'Could not fetch balances', stale_as_of: '2026-10-01', stale_missing: 1 }));
    expect(notices(one)).toEqual([
      ['critical', "Could not fetch balances · balances as of Oct 1 · 1 account couldn't be shown, so this total is incomplete"],
    ]);
    const two = render(institution({ error: 'Could not fetch balances', stale_as_of: '2026-10-01', stale_missing: 2 }));
    expect(notices(two)[0][1]).toContain("· 2 accounts couldn't be shown, so this total is incomplete");
  });

  test('balances too old to show are said, in red', () => {
    const html = render(institution({ accounts: [], error: 'Could not fetch balances', stale_too_old: '2026-06-01' }));
    expect(notices(html)).toEqual([
      ['critical', 'Could not fetch balances · last known balances are from Jun 1, too old to show'],
    ]);
  });

  test('a plain error with nothing recovered is red', () => {
    expect(notices(render(institution({ error: 'Could not fetch balances' })))).toEqual([['critical', 'Could not fetch balances']]);
  });

  test('accounts missing from a good answer are amber and say until when they are held', () => {
    const one = render(institution({ unconfirmed_missing: 1 }));
    expect(notices(one)).toEqual([
      [
        'caution',
        "1 account this institution used to report isn't in its latest response · it is held at its last known balance until you say whether it closed, and history is paused until then",
      ],
    ]);
    const held = account({ account_id: 'acc_gone', name: 'Savings', held: { as_of: '2026-09-12' }, question: { kind: 'missing', end: '2026-09-13', since: '2026-09-12', still_open: true } });
    const two = render(institution({ unconfirmed_missing: 2, accounts: [held] }));
    expect(notices(two)).toContainEqual([
      'caution',
      "2 accounts this institution used to report aren't in its latest response · they are held at their last known balance until they come back, two weeks from your answer at most, and history is paused until then",
    ]);
    // Never alongside an error: the error says it then.
    expect(notices(render(institution({ unconfirmed_missing: 1, error: 'Could not fetch balances' })))).toEqual([
      ['critical', 'Could not fetch balances'],
    ]);
  });

  test('a held row says its balance is the last known one, or that it is not counted', () => {
    const dated = render(institution({ accounts: [account({ held: { as_of: '2026-09-12' } })] }));
    expect(notices(dated)).toContainEqual(['badge warn', 'Last known balance, from Sep 12']);
    const none = render(institution({ accounts: [account({ held: { as_of: null }, balance: null })] }));
    expect(notices(none)).toContainEqual(['badge neg', 'No recent balance, so not counted']);
    expect(text(none)).toContain('--');
  });

  test('an overdue payment is marked on its row', () => {
    const card = account({
      account_id: 'acc_card',
      name: 'Sapphire',
      type: 'credit',
      subtype: 'credit card',
      balance: 1420.18,
      liability: { kind: 'credit', apr: 24.99, apr_label: 'Purchase APR', minimum_payment: 35, next_due_date: '2026-10-24', last_statement_balance: null, last_payment_amount: null, last_payment_date: null, is_overdue: true },
    });
    // Red before phase 3 (`type-tag over-tag`) and red since: a red badge
    // with the word, then the same line.
    const html = render(institution({ accounts: [card] }));
    expect(html).toContain('<span class="badge neg">Overdue</span>');
    const sub = html.slice(html.indexOf('<span class="list-row-sub">'));
    // The missed payment's day, said as past (it was before today).
    // (With its year, once today is in another.)
    expect(text(sub.slice(0, sub.indexOf('</button>')))).toMatch(/^Overdue · 24\.99% APR · min \$35\.00 · was due Oct 24(, 2026)?( |$)/);
  });

  test('overdue with nothing else reported: the badge still shows, beside the kind of account unless its name says it', () => {
    const loan = account({ account_id: 'acc_loan', name: 'Plaid Mortgage', type: 'loan', subtype: 'mortgage', balance: 56302.06, liability: { kind: 'mortgage', apr: null, apr_label: null, minimum_payment: null, next_due_date: null, last_statement_balance: null, last_payment_amount: null, last_payment_date: null, is_overdue: true } });
    const subOf = (html: string) => {
      const sub = html.slice(html.indexOf('<span class="list-row-sub">'));
      return sub.slice(0, sub.indexOf('<span class="list-row-value">'));
    };
    const said = subOf(render(institution({ accounts: [loan] })));
    expect(said).toContain('<span class="badge neg">Overdue</span>');
    // Its name says mortgage: the badge alone, with no "·" after it.
    expect(text(said)).toBe('Overdue');
    expect(text(subOf(render(institution({ accounts: [{ ...loan, name: 'House' }] }))))).toBe('Overdue · Mortgage');
  });

  // The screen review: "Overdue · ... · due Nov 15" read as overdue and due
  // later at once, and a card read "due May 28" five months after it passed.
  test('the due date as it is today: coming, next after an overdue one, missed, or passed and dropped', () => {
    const terms = (next_due_date: string | null, is_overdue: boolean) =>
      liabilitySummary(
        account({ type: 'loan', liability: { kind: 'mortgage', apr: 3.99, apr_label: 'Interest rate', minimum_payment: 3141.54, next_due_date, last_statement_balance: null, last_payment_amount: null, last_payment_date: null, is_overdue } }),
        '2026-10-27'
      );
    expect(terms('2026-11-15', false)).toBe('3.99% APR · min $3,141.54 · due Nov 15');
    expect(terms('2026-10-27', false)).toBe('3.99% APR · min $3,141.54 · due Oct 27');
    expect(terms('2026-11-15', true)).toBe('3.99% APR · min $3,141.54 · next due Nov 15');
    expect(terms('2026-05-28', true)).toBe('3.99% APR · min $3,141.54 · was due May 28');
    expect(terms('2026-05-28', false)).toBe('3.99% APR · min $3,141.54');
    expect(terms(null, true)).toBe('3.99% APR · min $3,141.54');
    // In another year, its year: the screen review saw "was due Nov 15" on
    // Oct 27, for last year's Nov 15, which read as still to come.
    expect(terms('2025-11-15', true)).toBe('3.99% APR · min $3,141.54 · was due Nov 15, 2025');
    expect(terms('2027-01-05', false)).toBe('3.99% APR · min $3,141.54 · due Jan 5, 2027');
  });

  test('the institution lines: payment details importing, accounts not added, transactions not allowed', () => {
    const html = render(institution({ liabilities: 'loading', new_accounts_available: true }), { unallowedIds: new Set(['item_chase']) });
    expect(helpers(html)).toEqual([
      'Payment details are still importing from this institution.',
      "Chase has accounts you haven't added yet.",
      "You didn't allow Nya to see transactions from the bank or card accounts here.",
    ]);
    expect(html).toContain('aria-label="Allow transactions from Chase"');
    expect(text(html)).toContain('Review accounts');
  });

  test('a connection Plaid says will end shows its Reconnect soon note', () => {
    const html = render(institution({ health: health('consent_ending', { ends_at: noon('2099-10-15') }) }));
    expect(text(html)).toContain('Plaid says this connection ends on');
    expect(text(html)).toContain('Reconnect before then to keep it syncing.');
  });

  test('a question about an account is asked on its card, hidden rows included', () => {
    const asked = account({ account_id: 'acc_zero', name: 'Old Savings', balance: 0, question: { kind: 'zero', end: '2026-08-01', since: '2026-08-01' } });
    const shown = institution();
    const html = render(shown, { institutions: [{ ...shown, accounts: [...shown.accounts, { ...asked, hidden: true }] }] });
    expect(text(html)).toContain('Old Savings');
    expect(html).toContain('lifecycle-question');
  });

  test('a healthy card says nothing', () => {
    expect(notices(render(institution()))).toEqual([]);
  });
});

describe('the account rows', () => {
  const manual = (over: Partial<Institution> = {}) =>
    institution({
      institution_name: 'Wallet',
      item_id: 'manual:wallet',
      manual: true,
      accounts: [account({ account_id: 'acc_cash', name: 'Cash', mask: null, currency: 'EUR', updated_at: '2026-10-08T15:05:00.000Z' })],
      ...over,
    });

  test('each row is one button that opens the account, with nothing inside it to press', () => {
    const opened: string[] = [];
    const inst = institution({ accounts: [account(), account({ account_id: 'acc_savings', name: 'Savings', mask: '0071' })] });
    const html = render(inst, { onOpenAccount: (id) => opened.push(id) });
    const rows = html.split('<button class="list-row"').slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.slice(0, row.indexOf('</button>'))).not.toContain('<button');
    // No Hide, Mark as closed… or Delete on the card: they are in the account's sheet.
    for (const word of ['Hide', 'Mark as closed…', 'Delete', 'Update', 'Add transaction', 'Import']) expect(text(html)).not.toContain(word);
    // Its name says checking, so the row says no more under it.
    expect(text(rows[0].slice(rows[0].indexOf('>') + 1))).toStartWith('Total Checking ••4421 $1,200.00');
    expect(rows[0].slice(0, rows[0].indexOf('</button>'))).not.toContain('list-row-sub');
  });

  test('a typed balance says when it was set, and its currency when not the one shown', () => {
    const html = render(manual());
    const row = text(html.slice(html.indexOf('<button class="list-row"')));
    expect(row).toContain('Cash Checking · in EUR');
    expect(row).toMatch(/Updated Oct 8, \d+:05 [AP]M/);
  });

  test('a synced balance says whose day it is', () => {
    const fed = manual({ institution_name: 'Alpine CU', item_id: 'connector:c1:alpine', connector: 'simplefin', accounts: [account({ updated_at: noon('2026-10-08') })] });
    expect(render(fed)).toContain('<span class="badge">Balance as of Oct 8</span>');
  });

  test('cash sitting in a brokerage is a badge on its row, amber only when worth acting on', () => {
    const brokerage = account({ account_id: 'acc_ind', name: 'Individual', type: 'investment', subtype: 'brokerage', balance: 10000 });
    const inst = institution({
      institution_name: 'Fidelity',
      accounts: [brokerage],
      holdings: [
        { account_id: 'acc_ind', name: 'Fidelity Government Money Market', quantity: 4200, value: 4200, cost_basis: 4200, is_cash_equivalent: true, security_type: 'cash' },
        { account_id: 'acc_ind', name: 'Total Market Index', quantity: 50, value: 5800, cost_basis: 5000, security_type: 'mutual fund' },
      ],
    });
    const html = render(inst);
    expect(html).toMatch(/<span class="badge( warn)?">\$4,200\.00 (uninvested|in cash)<\/span>/);
    // Positions that name their account are in its sheet, not on the card.
    expect(html).not.toContain('holdings-toggle');
  });
});
