import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AccountQuestions,
  EndedAccounts,
  LifecycleForm,
  LifecycleRepair,
  endEffect,
  endText,
  lifecycleDamageOf,
  questionText,
  type EndedAccount,
} from '@/components/AccountLifecycle';
import { TimelineNotesSheet } from '@/components/TimelineNotes';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import type { Institution } from '@/components/accounts-format';
import { severityOf } from '@/lib/accounts-status';
import { CAUSES, type ConnectionHealth } from '@/lib/connection-state';

// What the person sees of accounts that end (#50): the questions, the sheet,
// the Accounts that ended card, the repair when closures can't be
// read, and the notes card. Days are in 2024, so each is said with its year
// whatever year the tests run in.

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim()).filter(Boolean);

describe('the questions', () => {
  test('a missing account: when it was last seen, Closed?, and that it is held meanwhile', () => {
    const q = { kind: 'missing' as const, end: '2024-03-13', since: '2024-03-12' };
    expect(questionText(q, 'Chase Savings ••4821', 'Chase', { balance: 900, currency: 'USD', held: { as_of: '2024-03-12' } })).toEqual({
      ask: 'Chase Savings ••4821 hasn’t appeared since Mar 12, 2024. Closed?',
      detail: 'It’s shown at its last known balance, from Mar 12, 2024, and no total is saved until you answer.',
    });
    // Too old to count, and never seen with a balance.
    expect(questionText(q, 'Card', 'Chase', { balance: null, currency: 'USD', held: { as_of: null, too_old: '2024-01-02' } }).detail).toBe(
      'Its last known balance, from Jan 2, 2024, is too old to count, and no total is saved until you answer.'
    );
    expect(questionText({ ...q, since: null }, 'Card', 'Chase').ask).toBe('Card is missing from Chase’s latest answer. Closed?');
  });

  test('answered Still open, and still missing: said, without asking the same again, for two weeks at most', () => {
    const q = { kind: 'missing' as const, end: '2024-03-13', since: '2024-03-12', still_open: true as const };
    const { ask, detail } = questionText(q, 'Savings', 'Chase');
    expect(ask).toBe('You said Savings is still open, but Chase hasn’t reported it since Mar 12, 2024.');
    expect(detail).toContain('no total is saved while it’s missing, for two weeks from your answer at most: then Nya asks again.');
    // Lapsed: asked again, with the three days that follow.
    const again = questionText({ kind: 'missing', end: '2024-03-13', since: '2024-03-12', again: true }, 'Savings', 'Chase');
    expect(again.ask).toBe('You said Savings was still open, but it still hasn’t appeared since Mar 12, 2024. Closed?');
    expect(again.detail).toContain('If nobody answers within three days, Nya assumes it closed');
  });

  test('a hidden account that goes missing is asked about too: it counts in nothing, but holds every total', () => {
    const q = { kind: 'missing' as const, end: '2024-03-13', since: '2024-03-12' };
    expect(questionText(q, 'Joint', 'Chase', { balance: 900, currency: 'USD', hidden: true, held: { as_of: '2024-03-12' } }).detail).toBe(
      'It’s hidden, so it counts in no total either way, and no total is saved until you answer.'
    );
  });

  test('an end its bank disagrees with: what it shows, Still closed or Reopen', () => {
    const q = { kind: 'reported' as const, end: '2024-03-13', since: null, ended: { state: 'closed' as const, on: '2024-03-13' } };
    const row = { account_id: 'card', name: 'Chase Freedom', mask: '9902', type: 'credit', balance: 450, currency: 'USD', question: q };
    expect(questionText(q, 'Chase Freedom ••9902', 'Chase', row).ask).toBe('Chase Freedom ••9902, closed Mar 13, 2024, shows $450.00 owed. Still closed?');
    const html = renderToStaticMarkup(<AccountQuestions accounts={[row]} institution="Chase" busy={false} onOpen={noop} onStillOpen={noop} onConfirmEnd={noop} onReopen={noop} />);
    expect(buttons(html)).toEqual(['Still closed', 'Reopen']);
    expect(text(html)).toContain('Chase still reports it, and from its end it counts in nothing, so this isn’t in your net worth.');
    // A debt still owed stays out of net worth only once the person ticks the
    // same box the sheet asks for, with the amount named.
    expect(text(html)).toContain('Stop counting the $450.00 it owes');
    expect(html).toMatch(/<input type="checkbox"/);
    expect(html).toMatch(/<button class="secondary" disabled="">Still closed<\/button>/);
    // Owing nothing, or an account that holds money: one tap, as the sheet.
    for (const shown of [{ ...row, balance: 0 }, { ...row, type: 'depository', balance: 200 }]) {
      const plain = renderToStaticMarkup(<AccountQuestions accounts={[shown]} institution="Chase" busy={false} onOpen={noop} onStillOpen={noop} onConfirmEnd={noop} onReopen={noop} />);
      expect(plain).not.toContain('type="checkbox"');
      expect(plain).toMatch(/<button class="secondary">Still closed<\/button>/);
    }
    // Left, with a transaction since.
    const left = { kind: 'reported' as const, end: '2024-03-13', since: '2024-03-20', ended: { state: 'left' as const, on: '2024-03-13' } };
    expect(questionText(left, 'Joint', 'Ally').ask).toBe('Joint, no longer yours since Mar 13, 2024, has a transaction from Mar 20, 2024. Still not yours?');
  });

  test('a zero for weeks holds nothing, and says so', () => {
    const q = { kind: 'zero' as const, end: '2024-02-01', since: '2024-02-01' };
    const { ask, detail } = questionText(q, 'Old checking', 'Ally', { balance: 0, currency: 'USD' });
    expect(ask).toBe('Old checking has been at $0.00 with no activity since Feb 1, 2024. Closed?');
    expect(detail).toBe('Nothing waits on your answer: a zero counts the same either way.');
  });

  test('each question offers Closed, Still open and Stop following; Still open once only', () => {
    const accounts = [
      { account_id: 'a', name: 'Savings', mask: '4821', balance: 900, currency: 'USD', question: { kind: 'missing' as const, end: '2024-03-13', since: '2024-03-12' } },
      { account_id: 'b', name: 'Card', mask: null, balance: 0, currency: 'USD', question: { kind: 'missing' as const, end: '2024-03-13', since: '2024-03-12', still_open: true as const } },
      { account_id: 'c', name: 'Checking', mask: null, balance: 10, currency: 'USD' },
    ];
    const html = renderToStaticMarkup(<AccountQuestions accounts={accounts} institution="Chase" busy={false} onOpen={noop} onStillOpen={noop} />);
    expect(buttons(html)).toEqual(['Closed', 'Still open', 'Stop following', 'Closed', 'Stop following']);
    expect(text(html)).toContain('Savings ••4821 hasn’t appeared since Mar 12, 2024. Closed?');
    expect(text(html)).not.toContain('Checking');
    // Nothing asked, nothing drawn.
    expect(renderToStaticMarkup(<AccountQuestions accounts={[accounts[2]]} institution="Chase" busy={false} onOpen={noop} onStillOpen={noop} />)).toBe('');
  });

  test('a question needs attention even on a working connection, a hidden account’s too, and is asked on its card', () => {
    const health: ConnectionHealth = { ...CAUSES.ok, cause: 'ok', side: 'none', last_ok_at: '2026-10-08T12:00:00.000Z' };
    const asked = { account_id: 'z', name: 'Old checking', official_name: null, mask: null, type: 'depository', subtype: null, balance: 0, limit: null, currency: 'USD', question: { kind: 'zero' as const, end: '2024-02-01', since: '2024-02-01' } };
    const inst: Institution = { institution_name: 'Ally', item_id: 'item_ally', error: null, needs_reauth: false, holdings: [], health, accounts: [asked] };
    // Amber (lib/accounts-status.ts): counted, but the person is asked.
    expect(severityOf(inst)).toBe('caution');
    // A hidden account's question too: its absence holds every total all the same.
    expect(severityOf({ ...inst, accounts: [{ ...asked, hidden: true }] })).toBe('caution');
    expect(severityOf({ ...inst, accounts: [{ ...asked, question: undefined }] })).toBeNull();
    // And an end its bank disagrees with.
    expect(severityOf({ ...inst, accounts: [], ended_reported: [{ ...asked, question: { kind: 'reported', end: '2024-02-01', since: null } }] })).toBe('caution');
    // On the card, from every row, the hidden one's too.
    const html = renderToStaticMarkup(
      <ConnectionStatus
        inst={{ ...inst, accounts: [] }}
        allRows={[{ ...asked, hidden: true }]}
        place={null}
        fx={null}
        connecting={false}
        unallowed={false}
        lifecycle={{ busy: false, open: noop, stillOpen: async () => null, confirmEnd: async () => null, reopen: async () => {} }}
        onReconnect={noop}
        onRemove={noop}
        onManageAccounts={noop}
        onAllowTransactions={noop}
        onConnector={noop}
      />
    );
    expect(text(html)).toContain('Old checking');
    expect(html).toContain('lifecycle-question');
  });
});

describe('the sheet', () => {
  const target = { account_id: 'a', name: 'Savings', mask: '4821', institution: 'Ally' };
  const form = (over: Partial<Parameters<typeof LifecycleForm>[0]> = {}) =>
    renderToStaticMarkup(<LifecycleForm target={target} busy={false} error="" onCancel={noop} onEnd={noop} onReopen={noop} today="2024-06-30" {...over} />);

  test('three choices, with untracked set apart from hidden in so many words', () => {
    const t = text(form());
    expect(t).toContain('Closed It no longer exists');
    expect(t).toContain('No longer yours It still exists, but isn’t yours');
    expect(t).toContain('Stop following It is still yours, and you stop following it. It still counts on every day before the one you choose, and not after.');
    // Never "tracking": that is what letting an account go from SimpleFIN is called.
    expect(t).not.toMatch(/track/i);
    expect(t).toContain('Hiding is different: a hidden account is left out of every day, past ones too.');
  });

  test('a day up to today, prefilled from the question, and what changes from it', () => {
    const html = form({ target: { ...target, day: '2024-03-13', prefilled: 'Prefilled with the day after it was last seen, Mar 12, 2024.' } });
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2024-03-13"');
    expect(html).toContain('max="2024-06-30"');
    const t = text(html);
    expect(t).toContain('Prefilled with the day after it was last seen, Mar 12, 2024.');
    expect(t).toContain('Every day before Mar 13, 2024 stays as it was. From Mar 13, 2024 on it isn’t counted');
    expect(t).toContain('Nothing is deleted, so reopening puts it back exactly.');
    // A prefill after today is brought back to today.
    expect(form({ target: { ...target, day: '2024-07-04' } })).toContain('value="2024-06-30"');
  });

  test('an account that ended can be reopened from it; one its bank no longer returns is held, which it says', () => {
    expect(buttons(form())).toEqual(['Cancel', 'Save']);
    const ended = form({ target: { ...target, state: 'left', day: '2024-03-13', ended: true } });
    expect(buttons(ended)).toEqual(['Cancel', 'Save', 'Reopen it']);
    expect(text(ended)).toContain('If its bank no longer returns it, it is held at its last known balance, and asked about, until the bank does.');
  });

  test('ending a card that still owes says net worth rises by it, and waits for a tick', () => {
    const card = { ...target, name: 'Freedom', balance: 310, type: 'credit', currency: 'USD' };
    const html = form({ target: card });
    expect(text(html)).toContain('It still shows $310.00 owed. From Jun 30, 2024 that debt stops counting, so your net worth rises by $310.00.');
    expect(text(html)).toContain('Stop counting what it owes');
    // Save waits for the tick.
    expect(html).toMatch(/<button disabled="">Save<\/button>/);
    // An asset says what leaves net worth, and asks nothing more; a zero says nothing.
    expect(endEffect({ balance: 5000, type: 'depository', currency: 'USD' }, '2024-03-12')).toEqual({
      text: 'It still shows $5,000.00. From Mar 12, 2024 it stops counting, so your net worth falls by $5,000.00.',
      owed: false,
    });
    expect(endEffect({ balance: 0, type: 'credit', currency: 'USD' }, '2024-03-12')).toBeNull();
    expect(endEffect({ balance: null, type: 'credit', currency: 'USD' }, '2024-03-12')).toBeNull();
    expect(endEffect({ balance: 2000, type: 'credit', currency: 'USD', lastKnown: true }, '2024-03-13')?.text).toStartWith('Its last known balance is $2,000.00 owed.');
  });
});

describe('the Accounts that ended card', () => {
  const entry = (over: Partial<EndedAccount> = {}): EndedAccount => ({
    account_id: 'a',
    lifecycle: { state: 'closed', on: '2024-03-13', note: 'Moved to Chase' },
    label: { name: 'Ally Savings', institution: 'Ally', mask: '4821' },
    type: 'depository',
    item_id: 'item_ally',
    set_at: '2024-03-14T00:00:00.000Z',
    ...over,
  });
  const card = (ended: EndedAccount[], hidden: string[] = []) =>
    renderToStaticMarkup(<EndedAccounts ended={ended} hidden={new Set(hidden)} busy={false} onOpen={noop} onReopen={noop} onStillOpen={noop} />);

  test('closed and left say different things; the math is the same', () => {
    expect(endText({ state: 'closed', on: '2024-03-13' })).toBe('Closed Mar 13, 2024');
    expect(endText({ state: 'left', on: '2024-03-13' })).toBe('No longer yours since Mar 13, 2024');
    expect(endText({ state: 'untracked', from: '2024-03-13' })).toBe('Not followed since Mar 13, 2024');
  });

  test('collapsed, with a count, until opened', () => {
    const html = card([entry()]);
    expect(text(html)).toContain('Accounts that ended 1');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Moved to Chase');
    expect(card([])).toBe('');
  });

  test('an assumed closure opens it, says it was assumed, and asks', () => {
    const html = card([entry({ assumed: true, lifecycle: { state: 'closed', on: '2024-03-13' } }), entry({ account_id: 'b', lifecycle: { state: 'untracked', from: '2024-01-02' }, label: { name: 'Brokerage', institution: 'Vanguard', mask: null } })], ['b']);
    const t = text(html);
    expect(html).toContain('aria-expanded="true"');
    expect(t).toContain('1 to confirm');
    expect(t).toContain('Assumed closed: Ally stopped reporting it and nobody answered. Is it?');
    expect(t).toContain('Vanguard · Not followed since Jan 2, 2024 · also hidden');
    expect(buttons(html)).toEqual(['Yes, closed', 'Still open', 'Change', 'Reopen']);
  });
});

describe('closures that can’t be read', () => {
  test('only a 409 that names them is taken for them', () => {
    expect(lifecycleDamageOf(409, { repair: 'account-lifecycle', unreadable_ids: ['a', 'b'], unrecognised_ids: [] })).toEqual({ unreadable: 2, unrecognised: 0 });
    expect(lifecycleDamageOf(409, { unreadable: true, unreadable_ids: ['a'] })).toBeNull();
    expect(lifecycleDamageOf(500, { repair: 'account-lifecycle' })).toBeNull();
    expect(lifecycleDamageOf(409, null)).toBeNull();
  });

  test('damaged ones can be removed once confirmed; ones a newer Nya saved are only named', () => {
    const damaged = renderToStaticMarkup(<LifecycleRepair damage={{ unreadable: 1, unrecognised: 0 }} onRepaired={noop} />);
    expect(text(damaged)).toContain('One saved account closure is damaged and can’t be read. Accounts can’t load until it is removed, since one may be an account you closed.');
    expect(buttons(damaged)).toEqual(['Remove the damaged closure']);
    const newer = renderToStaticMarkup(<LifecycleRepair damage={{ unreadable: 0, unrecognised: 2 }} onRepaired={noop} />);
    expect(text(newer)).toContain('2 account closures are in a form this version of Nya can’t read, though they look intact');
    expect(buttons(newer)).toEqual([]);
    // Both: removing the damaged one isn't enough on its own, and it says so.
    const both = text(renderToStaticMarkup(<LifecycleRepair damage={{ unreadable: 1, unrecognised: 1 }} onRepaired={noop} />));
    expect(both).toContain('removing this one isn’t enough on its own');
  });
});

describe('the chart notes sheet', () => {
  const notes = [
    { id: 'n1', date: '2024-03-13', text: 'Bought the house', kind: 'user' as const },
    { id: 'n2', date: '2024-05-02', text: 'Chase Savings closed', kind: 'auto' as const, account_id: 'a1' },
  ];

  test('closed: nothing on the page', () => {
    expect(renderToStaticMarkup(<TimelineNotesSheet open={false} onClose={noop} notes={notes} problem={null} onChanged={noop} />)).toBe('');
  });

  test('open: every note newest first, Nya’s marked, only the person’s editable, and what couldn’t be read said', () => {
    const html = renderToStaticMarkup(<TimelineNotesSheet open onClose={noop} notes={notes} problem="One note couldn’t be read, so it isn’t shown." onChanged={noop} />);
    expect(html).toContain('aria-label="Chart notes"');
    expect(text(html)).toContain('One note couldn’t be read, so it isn’t shown.');
    expect(html).toContain('<div class="notice caution">');
    const t = text(html);
    expect(t.indexOf('Chase Savings closed')).toBeLessThan(t.indexOf('Bought the house'));
    expect(html).toContain('<span class="badge">Added when the account changed</span>');
    expect(buttons(html).filter((b) => b === 'Edit')).toHaveLength(1);
    expect(buttons(html)).toContain('Add a note');
    // The explanation is behind "What are these?", its words kept.
    expect(html).toContain('<summary>What are these?</summary>');
    expect(t).toContain('A note marks its day on the chart, so a step in the line says what it was: a house bought, a 401(k) rolled over.');
  });

  test('no notes yet: said, and one can be added', () => {
    const html = renderToStaticMarkup(<TimelineNotesSheet open onClose={noop} notes={[]} problem={null} onChanged={noop} />);
    expect(text(html)).toContain('No notes yet.');
    expect(buttons(html)).toContain('Add a note');
  });
});
