import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AccountQuestions,
  EndedAccounts,
  LifecycleForm,
  LifecycleRepair,
  endText,
  lifecycleDamageOf,
  questionText,
  type EndedAccount,
} from '@/components/AccountLifecycle';
import { TimelineNotesCard } from '@/components/TimelineNotes';
import { ConnectionHealthView, needsAttention, type HealthInstitution } from '@/components/ConnectionHealth';
import { CAUSES, type ConnectionHealth } from '@/lib/connection-state';

// What the person sees of accounts that end (#50): the questions, the sheet,
// the Closed, left and untracked card, the repair when closures can't be
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

  test('answered Still open, and still missing: said, without asking the same again', () => {
    const q = { kind: 'missing' as const, end: '2024-03-13', since: '2024-03-12', still_open: true as const };
    expect(questionText(q, 'Savings', 'Chase').ask).toBe('You said Savings is still open, but Chase hasn’t reported it since Mar 12, 2024.');
  });

  test('a zero for weeks holds nothing, and says so', () => {
    const q = { kind: 'zero' as const, end: '2024-02-01', since: '2024-02-01' };
    const { ask, detail } = questionText(q, 'Old checking', 'Ally', { balance: 0, currency: 'USD' });
    expect(ask).toBe('Old checking has been at $0.00 with no activity since Feb 1, 2024. Closed?');
    expect(detail).toBe('Nothing waits on your answer: a zero counts the same either way.');
  });

  test('each question offers Closed, Still open and Stop tracking; Still open once only', () => {
    const accounts = [
      { account_id: 'a', name: 'Savings', mask: '4821', balance: 900, currency: 'USD', question: { kind: 'missing' as const, end: '2024-03-13', since: '2024-03-12' } },
      { account_id: 'b', name: 'Card', mask: null, balance: 0, currency: 'USD', question: { kind: 'missing' as const, end: '2024-03-13', since: '2024-03-12', still_open: true as const } },
      { account_id: 'c', name: 'Checking', mask: null, balance: 10, currency: 'USD' },
    ];
    const html = renderToStaticMarkup(<AccountQuestions accounts={accounts} institution="Chase" busy={false} onOpen={noop} onStillOpen={noop} />);
    expect(buttons(html)).toEqual(['Closed', 'Still open', 'Stop tracking', 'Closed', 'Stop tracking']);
    expect(text(html)).toContain('Savings ••4821 hasn’t appeared since Mar 12, 2024. Closed?');
    expect(text(html)).not.toContain('Checking');
    // Nothing asked, nothing drawn.
    expect(renderToStaticMarkup(<AccountQuestions accounts={[accounts[2]]} institution="Chase" busy={false} onOpen={noop} onStillOpen={noop} />)).toBe('');
  });

  test('connection health shows them too, and a question needs attention even on a working connection', () => {
    const health: ConnectionHealth = { ...CAUSES.ok, cause: 'ok', side: 'none', last_ok_at: '2026-10-08T12:00:00.000Z' };
    const row: HealthInstitution & { health: ConnectionHealth } = {
      institution_name: 'Ally',
      item_id: 'item_ally',
      error: null,
      health,
      accounts: [{ account_id: 'z', name: 'Old checking', mask: null, type: 'depository', balance: 0, currency: 'USD', question: { kind: 'zero' } }],
    };
    expect(needsAttention(row)).toBe(true);
    expect(needsAttention({ ...row, accounts: [{ ...row.accounts[0], hidden: true }] })).toBe(false);
    const html = renderToStaticMarkup(
      <ConnectionHealthView
        rows={[row]}
        open={true}
        onToggle={noop}
        unavailable={false}
        connecting={false}
        onReconnect={noop}
        onRemove={noop}
        onManageAccounts={noop}
        questions={(inst) => <p>asked about {inst.accounts.length}</p>}
      />
    );
    expect(text(html)).toContain('1 of 1 needs attention');
    expect(text(html)).toContain('asked about 1');
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
    expect(t).toContain('Stop tracking You stop following it. It still counts on every day before the one you choose, and not after.');
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

  test('an account that ended can be reopened from it', () => {
    expect(buttons(form())).toEqual(['Cancel', 'Save']);
    expect(buttons(form({ target: { ...target, state: 'left', day: '2024-03-13', ended: true } }))).toEqual(['Cancel', 'Save', 'Reopen it']);
  });
});

describe('the Closed, left and untracked card', () => {
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
    expect(endText({ state: 'untracked', from: '2024-03-13' })).toBe('Not tracked since Mar 13, 2024');
  });

  test('collapsed, with a count, until opened', () => {
    const html = card([entry()]);
    expect(text(html)).toContain('Closed, left and untracked 1');
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
    expect(t).toContain('Vanguard · Not tracked since Jan 2, 2024 · also hidden');
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
    expect(text(newer)).toContain('2 account closures were saved by a newer version of Nya');
    expect(buttons(newer)).toEqual([]);
  });
});

describe('the notes card', () => {
  test('collapsed with a count; what couldn’t be read is said', () => {
    const notes = [{ id: 'n1', date: '2024-03-13', text: 'Bought the house', kind: 'user' as const }];
    const html = renderToStaticMarkup(<TimelineNotesCard notes={notes} problem="One note couldn’t be read, so it isn’t shown." onChanged={noop} />);
    expect(text(html)).toContain('Notes on the timeline 1');
    expect(html).toContain('aria-expanded="false"');
    expect(text(html)).toContain('One note couldn’t be read, so it isn’t shown.');
    expect(html).not.toContain('Bought the house');
  });
});
