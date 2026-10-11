import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import GoalsCard, { GoalsCardView } from '@/components/GoalsCard';
import GoalSheet from '@/components/GoalSheet';
import { archivedGoal, draftOf, pickAccount, readDraft } from '@/components/goal-draft';
import { readFlowsAnswer } from '@/components/goal-flows-state';
import { localDate } from '@/lib/local-date';
import type { Goal } from '@/lib/goal-model';
import { withAccountEnds, type GoalAccount } from '@/lib/goal-view';

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

  test('underfunded: short of its date, the outlook says so, flagged', () => {
    const soon = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const html = card([goal('Trip', 'sav', 20_000, { monthly_target: 100, target_date: soon })]);
    expect(html).toContain('class="goal-outlook behind"');
    expect(text(html)).toMatch(/a month short of .+ at your monthly target; at this pace, reached in/);
    expect(card([goal('Trip', 'sav', 12_000, { monthly_target: 500 })])).not.toContain('behind');
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

  test('an account that ended: the goal says so with its day, and its balance is no one’s (#50)', () => {
    const accounts = withAccountEnds(ACCOUNTS, [{ account_id: 'sav', lifecycle: { state: 'closed', on: '2026-09-30' }, label: { name: 'Savings', institution: 'Chase' }, type: 'depository' }]);
    const html = renderToStaticMarkup(<GoalsCard goals={[goal('Trip', 'sav', 12_000, { allocation: 4000 })]} accounts={accounts} onSave={async () => true} />);
    const t = text(html);
    expect(t).toContain('Its account closed on Sep 30, 2026, so it counts nothing from then');
    expect(t).not.toContain('$4,000.00 of');
    // No unallocated line for it, and no meter.
    expect(t).not.toContain('unallocated');
    expect(html).not.toContain('meter-fill');
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

describe('the card, with the months in', () => {
  const months = ['2026-07', '2026-08', '2026-09'];
  const view = (goals: Goal[], flows: Map<string, any>, notes: string[] = []) =>
    text(renderToStaticMarkup(<GoalsCardView goals={goals} accounts={ACCOUNTS} onSave={async () => true} flows={{ status: 'ready', flows, notes }} />));

  test('what the server couldn’t read for the paces is said once, above the goals', () => {
    const html = renderToStaticMarkup(
      <GoalsCardView goals={[goal('Fund', 'sav', 20_000)]} accounts={ACCOUNTS} onSave={async () => true} flows={{ status: 'ready', flows: new Map(), notes: ['Some recorded balances couldn’t be read, so a month whose end they hold reads as unknown'] }} />
    );
    expect(html).toContain('<p class="stale-note">Some recorded balances couldn’t be read, so a month whose end they hold reads as unknown</p>');
  });

  test('a connection that stopped before the months: not "no contributions", and why, as a warning', () => {
    const stopped = { kind: 'stopped', institution: 'Chase', since: '2026-06-10T12:00:00.000Z' };
    const t = view([goal('Fund', 'sav', 20_000)], new Map([['sav', { source: 'transactions', months: months.map((month) => ({ month, amount: null, gaps: [stopped] })) }]]));
    expect(t).not.toContain('No contributions');
    expect(t).toContain('What went into Savings lately isn’t known, so neither is its pace');
    expect(t).toContain('What went into Savings lately isn’t known: Chase hasn’t synced since Jun 10.');
  });

  test('paced by its balance because Chase’s transactions couldn’t be read: said on the goal', () => {
    const t = view([goal('Fund', 'sav', 20_000)], new Map([['sav', { source: 'balances', months: months.map((month) => ({ month, amount: 500 })), fallback: { unreadable: 'Chase' } }]]));
    expect(t).toContain('Chase’s transactions couldn’t be read, so this goal is paced by Savings’s recorded balance instead.');
    expect(t).toContain('Paced by its recorded balance, which includes interest and market moves');
  });

  test('information reads as information, warnings as warnings, and the marker in words too', () => {
    const start = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10);
    const html = renderToStaticMarkup(
      <GoalsCardView
        goals={[goal('Trip', 'sav', 20_000, { target_date: end }, { plan_start: { date: start, amount: 0 }, relinked: true }), goal('Fund', 'sav', 30_000)]}
        accounts={ACCOUNTS}
        onSave={async () => true}
        flows={{ status: 'ready', flows: new Map(), notes: [] }}
      />
    );
    expect(html).toContain('<p class="panel-note goal-note">Follows Savings, which was reconnected.</p>');
    expect(html).toMatch(/<p class="panel-note goal-note">To reach it by [^<]+, it would have \$[\d,]+\.\d\d by now\.<\/p>/);
    expect(html).toContain('<p class="panel-note goal-note">Counts the same $10,000.00 as Fund: give each an allocation to split it.</p>');
  });

  test('every goal archived: no "No goals yet" above the archived list', () => {
    const t = view([goal('Bike', 'sav', 900, { archived: true }, { archived_on: '2026-09-01', archived_amount: 950 })], new Map());
    expect(t).not.toContain('No goals yet');
    expect(t).toContain('1 archived · Show');
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

  test('an account that ended isn’t offered; a goal on one keeps it listed, marked, and nothing more can be set aside from it', () => {
    const ended = [{ account_id: 'sav', lifecycle: { state: 'left' as const, on: '2026-09-30' }, label: { name: 'Savings', institution: 'Chase' }, type: 'depository' }];
    const accounts = withAccountEnds(ACCOUNTS, ended);
    const render = (g: Goal | null, goals: Goal[]) =>
      text(renderToStaticMarkup(<GoalSheet open goal={g} goals={goals} accounts={accounts} flows={null} today={TODAY} saveError={null} onClose={() => {}} onSave={async () => true} />));
    expect(render(null, [])).not.toContain('Savings');
    const g = goal('Trip', 'sav', 3000, { allocation: 1000 });
    expect(render(g, [g])).toContain('Savings (Chase) · no longer yours');
    const opts = { goal: g, goals: [g], accounts, today: '2026-10-10', newId: 'n' };
    // Kept as it is, it saves; raised, it says why.
    expect(readDraft(draftOf(g), opts).ready).toBe(true);
    expect(readDraft({ ...draftOf(g), allocation: '1500' }, opts).errors).toEqual(['Nothing can be set aside from Savings: it isn’t yours from Sep 30, 2026.']);
  });

  test('the box to set part of the balance aside: checked with an allocation, never checked without an account', () => {
    const html = (g: Goal) => renderToStaticMarkup(<GoalSheet open goal={g} goals={[g]} accounts={ACCOUNTS} flows={null} today={TODAY} saveError={null} onClose={() => {}} onSave={async () => true} />);
    const box = (h: string) => h.match(/<input type="checkbox"[^>]*>/)![0];
    const allocated = html(goal('a', 'sav', 9000, { allocation: 3000 }));
    expect(box(allocated)).toContain('checked');
    expect(box(allocated)).not.toContain('disabled');
    // No account, as "No account" leaves it: nothing set aside, and Save open.
    const none = html(goal('a', null, 9000, { allocation: 3000 }));
    expect(box(none)).not.toContain('checked');
    expect(none).toMatch(/<button>Save<\/button>/);
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

  test('an allocation kept as it is saves, even on an account that can’t be counted just now', () => {
    const mine = goal('b', 'nobal', 900, { allocation: 300 });
    expect(readDraft(draftOf(mine), { ...base, goals: [mine], goal: mine }).ready).toBe(true);
    expect(readDraft({ ...draftOf(mine), allocation: '301' }, { ...base, goals: [mine], goal: mine }).errors).toEqual([
      'Nothing can be set aside from New account: no balance is known for it yet.',
    ]);
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

  test('"No account" sets nothing aside, in the same step, and saves', () => {
    const mine = goal('b', 'sav', 9000, { allocation: 3000, monthly_target: 100 });
    const opts = { ...base, goals: [mine], goal: mine };
    const none = pickAccount(draftOf(mine), '');
    expect(none.allocate).toBe(false);
    const read = readDraft(none, opts);
    expect(read).toMatchObject({ ready: true, errors: [], entry: { account_id: null, plan: { monthly_target: 100 } } });
    expect(read.entry.plan).not.toHaveProperty('allocation');
    // What was typed for it stays, for an account picked again; another
    // account keeps the box as it was.
    expect(pickAccount(none, 'sav')).toMatchObject({ allocate: false, allocation: '3000' });
    expect(pickAccount(draftOf(mine), 'yen')).toMatchObject({ allocate: true, allocation: '3000' });
    // A box left checked with no account sets nothing aside, and stops nothing.
    expect(readDraft({ ...draftOf(mine), account: '' }, opts)).toMatchObject({ ready: true, errors: [], entry: { account_id: null } });
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

describe('archiving from the editor', () => {
  const mine = goal('b', 'sav', 9000, { allocation: 3000, monthly_target: 100 }, { name: 'Trip' });
  const opts = { goal: mine, goals: [mine], accounts: ACCOUNTS, today: '2026-10-10' };

  test('as saved, when nothing was changed: archived, its allocation released', () => {
    expect(archivedGoal(draftOf(mine), opts)).toEqual({ ...mine, plan: { monthly_target: 100, archived: true } });
  });

  test('with what was typed, which would otherwise be lost', () => {
    expect(archivedGoal({ ...draftOf(mine), name: 'Trip to Japan', target: '9500', monthly: '' }, opts)).toEqual({
      id: 'b',
      name: 'Trip to Japan',
      target: 9500,
      account_id: 'sav',
      plan: { archived: true },
    });
    // What was typed for the allocation doesn't matter: archiving releases it.
    expect(archivedGoal({ ...draftOf(mine), allocation: '999999' }, opts)?.plan).toEqual({ monthly_target: 100, archived: true });
  });

  test('waits while what was typed can’t be saved, rather than drop it', () => {
    expect(archivedGoal({ ...draftOf(mine), target: 'lots' }, opts)).toBeNull();
    expect(archivedGoal({ ...draftOf(mine), name: ' ' }, opts)).toBeNull();
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
