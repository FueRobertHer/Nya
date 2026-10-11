import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import GoalsCard from '@/components/GoalsCard';
import GoalSheet from '@/components/GoalSheet';
import { draftOf, readDraft } from '@/components/goal-draft';
import { readFlowsAnswer } from '@/components/goal-flows-state';
import { localDate } from '@/lib/local-date';
import type { Goal } from '@/lib/goal-model';
import type { GoalAccount } from '@/lib/goal-view';

// The Goals card and its editor (#42), as rendered: what each goal shows,
// the "where you should be" marker and its words, the unallocated remainder,
// the archived list, and the editor's checks, which are the server's.

/** Markup as text, tags dropped and entities decoded, for reading sentences. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

const TODAY = localDate();
const ACCOUNTS: GoalAccount[] = [
  { account_id: 'sav', name: 'Savings', institution: 'Chase', balance: 10_000, currency: 'USD', type: 'depository' },
  { account_id: 'card', name: 'Visa', institution: 'Chase', balance: 1200, currency: 'USD', type: 'credit' },
  { account_id: 'hid', name: 'Old savings', institution: 'Chase', balance: 500, currency: 'USD', type: 'depository', hidden: true },
  { account_id: 'nobal', name: 'New account', institution: 'Ally', balance: null, currency: 'USD', type: 'depository' },
  { account_id: 'yen', name: 'Yen', institution: 'Tokyo', balance: 100_000, currency: 'JPY', type: 'depository' },
];
const goal = (id: string, account_id: string | null, target: number, plan?: Goal['plan'], over: Partial<Goal> = {}): Goal => ({
  id,
  name: id,
  target,
  account_id,
  ...(plan ? { plan } : {}),
  ...over,
});
const card = (goals: Goal[], over: Partial<Parameters<typeof GoalsCard>[0]> = {}) =>
  renderToStaticMarkup(<GoalsCard goals={goals} accounts={ACCOUNTS} onSave={async () => true} {...over} />);

describe('the card', () => {
  test('a goal without a plan shows as it always did: the whole balance against the target', () => {
    const html = card([goal('Fund', 'sav', 15_000)]);
    expect(text(html)).toContain('Fund $10,000.00 of $15,000.00');
    expect(html).toContain('width:66.66666666666666%');
    // Nothing allocated: no line about it.
    expect(text(html)).not.toContain('unallocated');
  });

  test('allocations: each goal its part, the remainder above the list, never more than the balance', () => {
    const t = text(card([goal('Trip', 'sav', 3000, { allocation: 1200 }), goal('Fund', 'sav', 20_000)]));
    expect(t).toContain('Savings: $8,800.00 unallocated of $10,000.00');
    expect(t).toContain('Trip $1,200.00 of $3,000.00');
    expect(t).toContain('Fund $8,800.00 of $20,000.00');
  });

  test('a balance that fell below the allocations: scaled, and said', () => {
    const accounts = ACCOUNTS.map((a) => (a.account_id === 'sav' ? { ...a, balance: 6000 } : a));
    const t = text(card([goal('A', 'sav', 9000, { allocation: 4000 }), goal('B', 'sav', 9000, { allocation: 3500.5 })], { accounts }));
    expect(t).toContain('A $3,199.79 of $9,000.00');
    expect(t).toContain('B $2,800.21 of $9,000.00');
    expect(t).toContain('Savings: allocations are $1,500.50 more than its $6,000.00 balance');
    expect(t).toContain('so each is shown scaled to fit');
  });

  test('the marker: where it should be by now, a lighter tick, and in words for a screen reader', () => {
    const start = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10);
    const html = card([goal('Trip', 'sav', 20_000, { target_date: end }, { plan_start: { date: start, amount: 0 } })]);
    expect(html).toContain('class="goal-marker"');
    expect(html).toMatch(/role="img" aria-label="\$10,000\.00 of \$20,000\.00 saved, 50%\. To reach it by [^"]+, it would have \$\d[\d,]*\.\d\d by now\."/);
    // Without a target date, no marker.
    expect(card([goal('Trip', 'sav', 20_000)])).not.toContain('goal-marker');
  });

  test('a goal on a monthly target is projected at it, labelled; one paced by contributions waits for them', () => {
    const t = text(card([goal('Trip', 'sav', 12_000, { monthly_target: 500 }), goal('Car', 'yen', 200_000)]));
    expect(t).toContain('On track for');
    expect(t).toContain('at your $500.00 monthly target');
    expect(t).not.toContain('No history to go by');
  });

  test('accounts that can’t be counted say why, and a card or loan never reads as savings', () => {
    const t = text(card([goal('A', null, 100), goal('B', 'gone', 100), goal('C', 'hid', 100), goal('D', 'card', 100), goal('E', 'nobal', 100)]));
    expect(t).toContain('No account linked');
    expect(t).toContain('Linked account disconnected');
    expect(t).toContain('Tracked account is hidden');
    expect(t).toContain('owed, not saved');
    expect(t).not.toContain('$1,200.00 of');
    expect(t).toContain('No balance is known for its account yet');
  });

  test('reached: marked, in green', () => {
    const html = card([goal('Fund', 'sav', 8000)]);
    expect(text(html)).toContain('· reached');
    expect(html).toContain('meter-fill done');
  });

  test('archived goals: out of the list, counting nothing, in a closed list that opens', () => {
    const html = card([goal('Fund', 'sav', 20_000), goal('Bike', 'sav', 900, { archived: true }, { archived_on: '2026-09-01', archived_amount: 950 })]);
    const t = text(html);
    expect(t).toContain('Fund $10,000.00 of $20,000.00');
    expect(t).toContain('1 archived · Show');
    expect(html).toContain('aria-expanded="false"');
    expect(t).not.toContain('Reached $900.00');
  });

  test('loading and unreadable: never "none"', () => {
    expect(text(card([], { status: 'loading' }))).toContain('Loading goals…');
    expect(text(card([], { status: 'error', error: 'Your saved goals could not be read' }))).toContain('Your saved goals could not be read');
    expect(text(card([]))).toContain('No goals yet');
  });

  test('the house style: no em or en dashes', () => {
    const html = card([goal('Trip', 'sav', 3000, { allocation: 1200, monthly_target: 100 }), goal('B', null, 5), goal('C', 'card', 5)]);
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('the editor', () => {
  const sheet = (g: Goal | null, goals: Goal[]) =>
    text(renderToStaticMarkup(<GoalSheet open goal={g} goals={goals} accounts={ACCOUNTS} flows={null} today={TODAY} saveError={null} onClose={() => {}} onSave={async () => true} />));

  test('every field, and the accounts it offers: no hidden account, card or loan', () => {
    const t = sheet(null, []);
    for (const label of ['Name', 'Target', 'Account', 'Set part of the balance aside for this goal', 'Monthly target (optional)', 'Target date (optional)']) expect(t).toContain(label);
    expect(t).toContain('Savings (Chase)');
    expect(t).not.toContain('Visa');
    expect(t).not.toContain('Old savings');
    expect(t).toContain('Add goal');
  });

  test('a goal reached is archived, not deleted; one not reached may be either', () => {
    const reached = goal('Fund', 'sav', 8000);
    const t = sheet(reached, [reached]);
    expect(t).toContain('Archive goal');
    expect(t).not.toContain('Delete goal');
    expect(t).toContain('Reached. Archive it to keep it');
    const going = goal('Fund', 'sav', 80_000);
    const u = sheet(going, [going]);
    expect(u).toContain('Archive goal');
    expect(u).toContain('Delete goal');
  });

  test('a goal on a card keeps its account listed, marked', () => {
    const g = goal('Old', 'card', 500);
    expect(sheet(g, [g])).toContain('Visa (Chase) · owed, not saved');
  });
});

describe('the editor’s checks are the server’s', () => {
  const base = { goal: null, goals: [] as Goal[], accounts: ACCOUNTS, today: '2026-10-10', newId: 'new-id' };
  const draft = (over: Partial<ReturnType<typeof draftOf>>) => ({ ...draftOf(null), name: 'Trip', target: '3000', account: 'sav', ...over });

  test('an allocation within what is free is taken; one more is refused, saying how much is free', () => {
    const goals = [goal('a', 'sav', 9000, { allocation: 6000 })];
    expect(readDraft(draft({ allocate: true, allocation: '4000' }), { ...base, goals })).toMatchObject({ ready: true, errors: [], room: 4000 });
    const over = readDraft(draft({ allocate: true, allocation: '4000.01' }), { ...base, goals });
    expect(over.ready).toBe(false);
    expect(over.errors).toEqual(['Savings has $4,000.00 you can set aside for this goal.']);
  });

  test('after the balance fell, a goal may keep what it has, or less, never more', () => {
    const accounts = ACCOUNTS.map((a) => (a.account_id === 'sav' ? { ...a, balance: 6000 } : a));
    const mine = goal('b', 'sav', 9000, { allocation: 3500.5 });
    const goals = [goal('a', 'sav', 9000, { allocation: 4000 }), mine];
    const opts = { ...base, accounts, goals, goal: mine };
    expect(readDraft(draftOf(mine), opts).ready).toBe(true);
    expect(readDraft({ ...draftOf(mine), allocation: '3000' }, opts).ready).toBe(true);
    expect(readDraft({ ...draftOf(mine), allocation: '3500.51' }, opts).errors).toEqual(['Savings has $3,500.50 you can set aside for this goal.']);
  });

  test('nothing allocated is a choice: 0 is taken', () => {
    expect(readDraft(draft({ allocate: true, allocation: '0' }), base)).toMatchObject({ ready: true, entry: { plan: { allocation: 0 } } });
  });

  test('nothing can be set aside from a hidden account, a card, or one with no balance', () => {
    expect(readDraft(draft({ account: 'hid', allocate: true, allocation: '1' }), base).errors).toEqual(['Nothing can be set aside from Old savings: it is hidden.']);
    expect(readDraft(draft({ account: 'card', allocate: true, allocation: '1' }), base).errors).toEqual(['Nothing can be set aside from Visa: its balance is owed, not saved.']);
    expect(readDraft(draft({ account: 'nobal', allocate: true, allocation: '1' }), base).errors).toEqual(['Nothing can be set aside from New account: no balance is known for it yet.']);
  });

  test('in the account’s currency: whole yen, the yen balance', () => {
    const read = readDraft(draft({ account: 'yen', target: '200000', allocate: true, allocation: '1500.4' }), base);
    expect(read).toMatchObject({ currency: 'JPY', ready: true, entry: { plan: { allocation: 1500 } } });
    expect(readDraft(draft({ account: 'yen', target: '200000', allocate: true, allocation: '100001' }), base).errors[0]).toContain('¥100,000');
  });

  test('a target date from today on, or the one it already has', () => {
    expect(readDraft(draft({ date: '2026-10-09' }), base).errors).toEqual(['Pick a target date from today on.']);
    expect(readDraft(draft({ date: '2026-10-10' }), base).ready).toBe(true);
    const old = goal('t', 'sav', 3000, { target_date: '2026-01-01' });
    expect(readDraft({ ...draftOf(old) }, { ...base, goal: old, goals: [old] }).ready).toBe(true);
  });

  test('amounts that aren’t: said', () => {
    expect(readDraft(draft({ target: 'lots' }), base).errors).toEqual(['Enter a target, like 5000.']);
    expect(readDraft(draft({ monthly: '-5' }), base).errors).toEqual(['Enter a monthly target, like 250.']);
    expect(readDraft(draft({ name: ' ' }), base).ready).toBe(false);
  });

  test('the goal a save sends: its plan, and a new goal’s id', () => {
    expect(readDraft(draft({ monthly: '250', date: '2027-06-01' }), base).entry).toEqual({
      id: 'new-id',
      name: 'Trip',
      target: 3000,
      account_id: 'sav',
      plan: { monthly_target: 250, target_date: '2027-06-01' },
    });
  });
});

describe('the months, as the card reads them', () => {
  test('a good answer, each account’s months checked', () => {
    const read = readFlowsAnswer({ months: ['2026-07'], flows: { sav: { source: 'transactions', months: [{ month: '2026-07', amount: 10 }] } }, notes: ['x', 3] });
    expect(read?.flows.get('sav')?.months[0].amount).toBe(10);
    expect(read?.notes).toEqual(['x']);
  });

  test('anything else reads as not loaded, never as months with nothing in them', () => {
    expect(readFlowsAnswer(null)).toBeNull();
    expect(readFlowsAnswer({ flows: [] })).toBeNull();
    expect(readFlowsAnswer({ flows: { sav: { source: 'guess', months: [] } } })).toBeNull();
    expect(readFlowsAnswer({ flows: { sav: { source: 'balances', months: [{ month: '2026-07', amount: '10' }] } } })).toBeNull();
  });
});
