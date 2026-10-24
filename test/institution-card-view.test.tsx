import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import InstitutionCard, { type InstitutionCardProps } from '@/components/InstitutionCard';
import type { Account, Institution } from '@/components/accounts-format';
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
      savingManual={false}
      togglingHidden={null}
      expandedAccounts={new Set()}
      expandedHoldings={new Set()}
      unallowedIds={new Set()}
      lifecycle={{ busy: false, open: noop, stillOpen: async () => null, confirmEnd: async () => null, reopen: async () => {} }}
      txnEdits={{ openAdd: noop }}
      toggleAccount={noop}
      toggleHoldings={noop}
      toggleHidden={noop}
      setOptionsTarget={noop}
      startEditManual={noop}
      setImportTarget={noop}
      setHistoryTarget={noop}
      setManualError={noop}
      setManualDeleteTarget={noop}
      startReconnect={noop}
      startAllowTransactions={noop}
      startEnableLiabilities={noop}
      startManageAccounts={noop}
      {...over}
    />
  );

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Each element with one of these classes, as [class, its text], in order. */
const NOTICE_CLASSES = ['error', 'stale-note', 'empty-note', 'manual-updated', 'type-tag over-tag'];
function notices(html: string): [string, string][] {
  const found: [string, string][] = [];
  for (const m of html.matchAll(/<(div|p) class="([^"]+)">([\s\S]*?)<\/\1>/g)) {
    if (NOTICE_CLASSES.includes(m[2])) found.push([m[2], text(m[3])]);
  }
  return found;
}

describe('the institution card notices, words and color', () => {
  test('a failed fetch with recovered balances is amber and dated', () => {
    const html = render(institution({ error: 'Could not fetch balances', stale_as_of: '2026-10-01' }));
    expect(notices(html)).toEqual([['stale-note', 'Could not fetch balances · balances as of Oct 1']]);
  });

  test('needing reconnecting stays red, with its date, and offers Reconnect by name', () => {
    const html = render(
      institution({ error: 'Chase needs to be reconnected', needs_reauth: true, stale_as_of: '2026-10-01' })
    );
    expect(notices(html)).toEqual([['error', 'Chase needs to be reconnected · balances as of Oct 1']]);
    expect(html).toContain('aria-label="Reconnect Chase"');
  });

  test('accounts that could not be shown keep it red: the total is short, not just old', () => {
    const one = render(institution({ error: 'Could not fetch balances', stale_as_of: '2026-10-01', stale_missing: 1 }));
    expect(notices(one)).toEqual([
      ['error', "Could not fetch balances · balances as of Oct 1 · 1 account couldn't be shown, so this total is incomplete"],
    ]);
    const two = render(institution({ error: 'Could not fetch balances', stale_as_of: '2026-10-01', stale_missing: 2 }));
    expect(notices(two)[0][1]).toContain("· 2 accounts couldn't be shown, so this total is incomplete");
  });

  test('balances too old to show are said, in red', () => {
    const html = render(institution({ accounts: [], error: 'Could not fetch balances', stale_too_old: '2026-06-01' }));
    expect(notices(html)).toEqual([
      ['error', 'Could not fetch balances · last known balances are from Jun 1, too old to show'],
    ]);
  });

  test('a plain error with nothing recovered is red', () => {
    expect(notices(render(institution({ error: 'Could not fetch balances' })))).toEqual([['error', 'Could not fetch balances']]);
  });

  test('accounts missing from a good answer are amber and say until when they are held', () => {
    const one = render(institution({ unconfirmed_missing: 1 }));
    expect(notices(one)).toEqual([
      [
        'stale-note',
        "1 account this institution used to report isn't in its latest response · it is held at its last known balance until you say whether it closed, and history is paused until then",
      ],
    ]);
    const held = account({ account_id: 'acc_gone', name: 'Savings', held: { as_of: '2026-09-12' }, question: { kind: 'missing', end: '2026-09-13', since: '2026-09-12', still_open: true } });
    const two = render(institution({ unconfirmed_missing: 2, accounts: [held] }));
    expect(notices(two)).toContainEqual([
      'stale-note',
      "2 accounts this institution used to report aren't in its latest response · they are held at their last known balance until they come back, two weeks from your answer at most, and history is paused until then",
    ]);
    // Never alongside an error: the error says it then.
    expect(notices(render(institution({ unconfirmed_missing: 1, error: 'Could not fetch balances' })))).toEqual([
      ['error', 'Could not fetch balances'],
    ]);
  });

  test('a held row says its balance is the last known one, or that it is not counted', () => {
    const dated = render(institution({ accounts: [account({ held: { as_of: '2026-09-12' } })] }));
    expect(notices(dated)).toContainEqual(['manual-updated', 'Last known balance, from Sep 12']);
    const none = render(institution({ accounts: [account({ held: { as_of: null }, balance: null })] }));
    expect(notices(none)).toContainEqual(['manual-updated', 'No recent balance, so not counted']);
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
    expect(notices(render(institution({ accounts: [card] })))).toContainEqual(['type-tag over-tag', 'Overdue · 24.99% APR · min $35.00 · due Oct 24']);
  });

  test('the institution lines: payment details importing, accounts not added, transactions not allowed', () => {
    const html = render(institution({ liabilities: 'loading', new_accounts_available: true }), { unallowedIds: new Set(['item_chase']) });
    expect(notices(html)).toEqual([
      ['empty-note', 'Payment details are still importing from this institution.'],
      ['empty-note', "Chase has accounts you haven't added yet."],
      ['empty-note', "You didn't allow Nya to see transactions from the bank or card accounts here."],
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
