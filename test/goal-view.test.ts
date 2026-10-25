import { describe, expect, test } from 'bun:test';
import { goalViews, withAccountEnds, type GoalAccount, type GoalAccountEnd } from '@/lib/goal-view';
import { fallbackText, gapItem, gapNote, gapsText, goalNotes, goalSentences, meterLabel, outlookText, paceText, shouldHaveText, splitText, stateText } from '@/lib/goal-text';
import type { Goal } from '@/lib/goal-model';
import type { AccountFlow } from '@/lib/goal-projection';

// Each goal as the card and the API show it (#42): whether its account can be
// counted, what it counts, when it will be reached, and the words for each.

const TODAY = '2026-10-10';
const ACCOUNTS: GoalAccount[] = [
  { account_id: 'sav', name: 'Savings', institution: 'Chase', balance: 10_000, currency: 'USD', type: 'depository' },
  { account_id: 'eur', name: 'Sparkonto', institution: 'N26', balance: 4000, currency: 'EUR', type: 'depository' },
  { account_id: 'card', name: 'Visa', institution: 'Chase', balance: 1200, currency: 'USD', type: 'credit' },
  { account_id: 'loan', name: 'Car loan', institution: 'Chase', balance: 9000, currency: 'USD', type: 'loan' },
  { account_id: 'hid', name: 'Old savings', institution: 'Chase', balance: 500, currency: 'USD', type: 'depository', hidden: true },
  { account_id: 'nobal', name: 'New account', institution: 'Ally', balance: null, currency: 'USD', type: 'depository' },
  { account_id: 'closed', name: 'Closed', institution: 'Ally', balance: 0, currency: 'USD', type: 'depository', ended: { state: 'closed', on: '2026-09-30' } },
  // A manual account: its balance kept in US dollars, typed by hand.
  { account_id: 'manual_jar', name: 'Jar', institution: 'Home', balance: 340.25, currency: 'USD', type: 'depository' },
  { account_id: 'ira', name: 'IRA', institution: 'Fidelity', balance: 20_000, currency: 'USD', type: 'investment' },
];
const goal = (id: string, account_id: string | null, target: number, plan?: Goal['plan'], over: Partial<Goal> = {}): Goal => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  target,
  account_id,
  ...(plan ? { plan } : {}),
  ...over,
});
const month = (m: string, amount: number | null, over: Partial<AccountFlow['months'][number]> = {}) => ({ month: m, amount, ...over });
const FLOWS = new Map<string, AccountFlow>([
  ['sav', { source: 'transactions', months: [month('2026-07', 375.5, { growth: 1.23 }), month('2026-08', 189.75, { growth: 1.27 }), month('2026-09', 330.1, { growth: 1.31 })] }],
  ['eur', { source: 'transactions', months: [month('2026-07', 0), month('2026-08', 0), month('2026-09', 0)] }],
  ['ira', { source: 'balances', months: [month('2026-07', 350.5), month('2026-08', 249.75), month('2026-09', 349.5)] }],
  ['manual_jar', { source: 'balances', months: [month('2026-07', null), month('2026-08', null), month('2026-09', null)] }],
]);
const nameOf = (id: string) => id[0].toUpperCase() + id.slice(1);
const viewsOf = (goals: Goal[], accounts = ACCOUNTS, flows: Map<string, AccountFlow> | null = FLOWS) => {
  const { views, splits } = goalViews(goals, accounts, flows, TODAY);
  return { views: new Map(views.map((v) => [v.goal.id, v])), splits };
};

describe('an account that ended (#50)', () => {
  const at = (end: GoalAccountEnd) => ACCOUNTS.map((a) => (a.account_id === 'sav' ? { ...a, ended: end } : a));
  const GOALS = [goal('fund', 'sav', 15_000, { allocation: 4000, monthly_target: 300, target_date: '2027-06-30' }), goal('trip', 'sav', 2000), goal('euro', 'eur', 3000)];

  test('closed, no longer yours, no longer followed, or assumed closed: says so with its day, counts nothing, and isn’t projected', () => {
    const cases: [GoalAccountEnd, string][] = [
      [{ state: 'closed', on: '2026-09-30' }, 'Its account closed on Sep 30, 2026, so it counts nothing from then'],
      [{ state: 'left', on: '2026-09-30' }, 'Its account isn’t yours from Sep 30, 2026, so it counts nothing from then'],
      [{ state: 'untracked', on: '2026-09-30' }, 'Its account isn’t followed from Sep 30, 2026, so it counts nothing from then'],
      [
        { state: 'closed', on: '2026-09-30', assumed: true },
        'Its account is assumed closed from Sep 30, 2026, as Chase stopped reporting it, so it counts nothing from then. Say whether it closed under Accounts that ended, on the Accounts tab',
      ],
    ];
    for (const [end, said] of cases) {
      const { views, splits } = viewsOf(GOALS, at(end));
      const v = views.get('fund')!;
      expect([v.state, v.saved, v.claim, v.measured, v.projection, v.shouldHave]).toEqual(['ended', null, null, null, null, null]);
      expect(stateText(v)).toBe(said);
      // Nothing else is said of it: no pace, no allocation scaled or shared.
      expect(goalSentences(v, nameOf, undefined)).toEqual([`${said}.`]);
      // Its allocation claims nothing, and the account has no unallocated
      // line; the other goal on it is ended too. Another account is untouched.
      expect(views.get('trip')!.state).toBe('ended');
      expect(splits.has('sav')).toBe(false);
      expect(views.get('euro')!.state).toBe('tracked');
      // Its plan is kept as set, for if it is reopened.
      expect(v.goal.plan).toEqual({ allocation: 4000, monthly_target: 300, target_date: '2027-06-30' });
    }
  });

  test('an end is said before hidden: it says more', () => {
    const accounts = ACCOUNTS.map((a) => (a.account_id === 'hid' ? { ...a, ended: { state: 'closed' as const, on: '2026-09-30' } } : a));
    expect(viewsOf([goal('old', 'hid', 100)], accounts).views.get('old')!.state).toBe('ended');
  });

  test('the accounts the app lists, with those that ended: one no longer listed comes from its end, with no balance; one reopened is as listed', () => {
    const live: GoalAccount[] = [ACCOUNTS[0], ACCOUNTS[4]];
    const ended = [
      { account_id: 'gone', lifecycle: { state: 'closed' as const, on: '2026-09-30' }, assumed: true, label: { name: 'Old savings', institution: 'Chase' }, type: 'depository', currency: 'EUR' },
      { account_id: 'hid', lifecycle: { state: 'untracked' as const, from: '2026-08-01' }, label: { name: 'Old savings', institution: 'Chase' }, type: 'depository' },
    ];
    const out = withAccountEnds(live, ended);
    expect(out.find((a) => a.account_id === 'gone')).toEqual({
      account_id: 'gone',
      name: 'Old savings',
      institution: 'Chase',
      balance: null,
      currency: 'EUR',
      type: 'depository',
      ended: { state: 'closed', on: '2026-09-30', assumed: true },
    });
    // A hidden one stays listed, with what it shows, and its end.
    expect(out.find((a) => a.account_id === 'hid')).toEqual({ ...ACCOUNTS[4], ended: { state: 'untracked', on: '2026-08-01' } });
    expect(out.find((a) => a.account_id === 'sav')).toEqual(ACCOUNTS[0]);
    // A goal on the one no longer listed says so, in its own currency.
    const v = viewsOf([goal('trip', 'gone', 900)], out).views.get('trip')!;
    expect([v.state, v.currency]).toEqual(['ended', 'EUR']);
    // Reopened: no longer among those that ended, so as the app lists it.
    expect(withAccountEnds(live, [])).toEqual(live);
  });
});

describe('whether an account can be counted', () => {
  test('each case says which it is, and shows no progress', () => {
    const { views } = viewsOf([
      goal('untracked', null, 100),
      goal('gone', 'acc_forgotten', 100),
      goal('hidden', 'hid', 100),
      goal('card', 'card', 100),
      goal('loan', 'loan', 100),
      goal('nobal', 'nobal', 100),
      goal('closed', 'closed', 100),
    ]);
    expect([...views.values()].map((v) => [v.goal.id, v.state, v.saved, v.projection])).toEqual([
      ['untracked', 'untracked', null, null],
      ['gone', 'disconnected', null, null],
      ['hidden', 'hidden', null, null],
      ['card', 'owed', null, null],
      ['loan', 'owed', null, null],
      ['nobal', 'no_balance', null, null],
      ['closed', 'ended', null, null],
    ]);
    expect(stateText(views.get('untracked')!)).toBe('No account linked');
    expect(stateText(views.get('gone')!)).toBe('Linked account disconnected');
    expect(stateText(views.get('hidden')!)).toBe('Tracked account is hidden');
    expect(stateText(views.get('card')!)).toContain('owed, not saved');
    expect(stateText(views.get('nobal')!)).toBe('No balance is known for its account yet');
    expect(stateText(views.get('closed')!)).toContain('closed');
  });

  test('a debt never reads as savings: a goal on a card shows no amount, and claims none of anything', () => {
    const { views, splits } = viewsOf([goal('card', 'card', 100)]);
    expect(views.get('card')!.saved).toBeNull();
    expect(splits.size).toBe(0);
  });
});

describe('a goal without an allocation, as before', () => {
  test('counts the whole balance, in the account’s currency, and projects from what went in', () => {
    const { views } = viewsOf([goal('fund', 'sav', 15_000)]);
    const v = views.get('fund')!;
    expect(v).toMatchObject({ state: 'tracked', saved: 10_000, currency: 'USD', sharing: [], shouldHave: null });
    // 5000.00 / 298.45 = 16.75, so seventeen months: March 2028.
    expect(v.projection).toMatchObject({ status: 'on_track', rate: 298.45, completion: '2028-03' });
    expect(outlookText(v, nameOf)).toBe('On track for March 2028');
    expect(paceText(v)).toBe('$298.45 a month went into Savings on average over the last 3 months, plus $3.81 of interest and dividends, not counted');
    expect(meterLabel(v)).toBe('$10,000.00 of $15,000.00 saved, 66%.');
  });

  test('met: reached', () => {
    const v = viewsOf([goal('fund', 'sav', 8000)]).views.get('fund')!;
    expect(v.projection!.status).toBe('complete');
    expect(outlookText(v, nameOf)).toBe('Reached');
  });
});

describe('two goals on one account', () => {
  test('allocations split it, the rest is unallocated, and each is projected at its own monthly target', () => {
    const { views, splits } = viewsOf([goal('trip', 'sav', 3000, { allocation: 1200, monthly_target: 200, target_date: '2027-06-30' }), goal('fund', 'sav', 20_000)]);
    const trip = views.get('trip')!;
    const fund = views.get('fund')!;
    expect(trip.saved).toBe(1200);
    expect(fund.saved).toBe(8800);
    expect(trip.sharing).toEqual(['fund']);
    // 1800.00 / 200.00 = 9 months: July 2027, past June. June needs 1800 / 8 = 225.
    expect(trip.projection).toMatchObject({ status: 'behind', rate: 200, rateFrom: 'monthly_target', completion: '2027-07', needed: 225, short: 25 });
    expect(outlookText(trip, nameOf)).toBe('$25.00 a month short of June 2027 at your monthly target; at this pace, reached in July 2027');
    // The other has no monthly target: what goes into the account is shared, so no pace of its own.
    expect(fund.projection!.status).toBe('no_rate');
    expect(outlookText(fund, nameOf)).toBe('Savings is shared with Trip, so this goal’s own pace isn’t known: set a monthly target to see when it will be reached');
    expect(splitText(splits.get('sav')!, 'Savings')).toBe('Savings: $8,800.00 unallocated of $10,000.00');
  });

  test('two goals without allocations each count the remainder, and each says so', () => {
    const { views } = viewsOf([goal('a', 'sav', 20_000), goal('b', 'sav', 20_000)]);
    expect(views.get('a')!.saved).toBe(10_000);
    expect(views.get('b')!.saved).toBe(10_000);
    // Information, not a warning.
    expect(goalNotes(views.get('a')!, nameOf, undefined)).toEqual([{ text: 'Counts the same $10,000.00 as B: give each an allocation to split it.', warn: false }]);
  });

  test('a balance that fell below the allocations: scaled to fit, flagged, and the account line says by how much', () => {
    const accounts = ACCOUNTS.map((a) => (a.account_id === 'sav' ? { ...a, balance: 6000 } : a));
    const { views, splits } = viewsOf([goal('a', 'sav', 9000, { allocation: 4000 }), goal('b', 'sav', 9000, { allocation: 3500.5 })], accounts);
    expect(views.get('a')!.saved).toBe(3199.79);
    expect(views.get('b')!.saved).toBe(2800.21);
    expect(goalNotes(views.get('a')!, nameOf, splits.get('sav'))[0]).toEqual({
      text: 'Allocations on Savings add up to $7,500.50, more than its $6,000.00 balance, so each is shown scaled to fit. Lower them to match.',
      warn: true,
    });
    expect(splitText(splits.get('sav')!, 'Savings')).toBe('Savings: allocations are $1,500.50 more than its $6,000.00 balance');
  });

  test('archived goals claim nothing and are not viewed', () => {
    const { views } = viewsOf([goal('old', 'sav', 500, { allocation: 500, archived: true }), goal('fund', 'sav', 20_000)]);
    expect(views.has('old')).toBe(false);
    expect(views.get('fund')!.saved).toBe(10_000);
    expect(views.get('fund')!.sharing).toEqual([]);
  });
});

describe('the outlook in words', () => {
  test('no contributions in three months says so instead of projecting', () => {
    const v = viewsOf([goal('trip', 'eur', 5000, { monthly_target: 300 })]).views.get('trip')!;
    expect(v.projection!.status).toBe('no_recent_contributions');
    expect(outlookText(v, nameOf)).toBe('No contributions in the last 3 months');
    expect(goalSentences(v, nameOf, undefined).join(' ')).not.toMatch(/On track|reached in/);
  });

  test('money taken out is no recent contributions too', () => {
    const flows = new Map(FLOWS);
    flows.set('sav', { source: 'transactions', months: [month('2026-08', -50), month('2026-09', -10)] });
    const v = viewsOf([goal('fund', 'sav', 15_000)], ACCOUNTS, flows).views.get('fund')!;
    expect(outlookText(v, nameOf)).toBe('No recent contributions: more went out of Savings than came in over the last 2 months');
  });

  test('another currency: every amount in it, nothing converted', () => {
    const flows = new Map(FLOWS);
    flows.set('eur', { source: 'transactions', months: [month('2026-07', 150), month('2026-08', 150), month('2026-09', 150)] });
    const v = viewsOf([goal('trip', 'eur', 5000, { target_date: '2027-12-31' }, { plan_start: { date: '2026-01-01', amount: 1000 } })], ACCOUNTS, flows).views.get('trip')!;
    expect(v.currency).toBe('EUR');
    // 1000.00 left at 150.00: seven months, May 2027, ahead of December.
    expect(outlookText(v, nameOf)).toBe('On track for May 2027, ahead of December 2027');
    expect(paceText(v)).toBe('€150.00 a month went into Sparkonto on average over the last 3 months');
    // 282 of 729 days from 1000.00 to 5000.00: 1000 + 4000 × 282 / 729 = 2547.33
    expect(v.shouldHave).toBe(2547.33);
    expect(shouldHaveText(v)).toBe('To reach it by Dec 31, 2027, it would have €2,547.33 by now');
    expect(meterLabel(v)).toBe('€4,000.00 of €5,000.00 saved, 80%. To reach it by Dec 31, 2027, it would have €2,547.33 by now.');
  });

  test('an account whose rows Nya doesn’t have: a change in balance, labelled as such', () => {
    const v = viewsOf([goal('retire', 'ira', 50_000)]).views.get('retire')!;
    expect(v.measured).toMatchObject({ source: 'balances', average: 316.58 });
    expect(paceText(v)).toBe(
      'IRA’s recorded balance changed by $316.58 a month on average over the last 3 months: that includes interest and market moves, which can’t be told apart from what you put in'
    );
  });

  test('a manual account with no history yet: projected at its monthly target, or asked for one', () => {
    const withTarget = viewsOf([goal('jar', 'manual_jar', 1000, { monthly_target: 50 })]).views.get('jar')!;
    expect(withTarget.currency).toBe('USD');
    // 659.75 / 50 = 13.2, so fourteen months: December 2027.
    expect(outlookText(withTarget, nameOf)).toBe('On track for December 2027 at your $50.00 monthly target');
    const without = viewsOf([goal('jar', 'manual_jar', 1000)]).views.get('jar')!;
    expect(outlookText(without, nameOf)).toBe('No history to go by yet: set a monthly target to see when it will be reached');
  });

  test('with no monthly figures loaded at all, still a view, at the monthly target', () => {
    const v = viewsOf([goal('fund', 'sav', 12_000, { monthly_target: 500 })], ACCOUNTS, null).views.get('fund')!;
    expect(v.projection).toMatchObject({ rateFrom: 'monthly_target', completion: '2027-02' });
  });

  test('a target date that has passed', () => {
    const v = viewsOf([goal('fund', 'sav', 12_000, { target_date: '2026-06-01' })]).views.get('fund')!;
    expect(outlookText(v, nameOf)).toBe('Its date, Jun 1, 2026, has passed; at this pace, reached in May 2027');
  });

  test('why the pace may be off, from each month’s gaps', () => {
    // A last sync is an instant, said as its day where the person is: 3 PM
    // on Sep 12 in the machine's time zone, so Sep 12 in any.
    const since = new Date('2026-09-12T15:00:00').toISOString();
    expect(
      gapsText([
        { kind: 'stopped', institution: 'Chase', since },
        { kind: 'importing', institution: 'N26' },
        { kind: 'missing', institution: 'Ally' },
        { kind: 'begins', on: '2026-08-14' },
        { kind: 'stopped', institution: 'Chase', since },
      ])
    ).toBe(
      'The pace may be off: Chase hasn’t synced since Sep 12; N26 is still importing older transactions; Ally’s transactions couldn’t be loaded; its transactions in Nya begin on Aug 14, 2026, so August 2026 may be short.'
    );
    expect(gapsText([{ kind: 'stopped', institution: 'Chase', since: null }])).toBe('The pace may be off: Chase isn’t syncing.');
    expect(gapsText([])).toBeNull();
  });

  test('an account reconnected under a new id, and an allocation left on the account it tracked before, each say so', () => {
    const v = viewsOf([goal('fund', 'sav', 20_000, undefined, { relinked: true, earlier_allocation: 750 })]).views.get('fund')!;
    expect(goalNotes(v, nameOf, undefined)).toEqual([
      { text: 'Its allocation of $750.00 was set on the account it tracked before, so here it counts what isn’t allocated. The next save drops it.', warn: true },
      { text: 'Follows Savings, which was reconnected.', warn: false },
    ]);
  });

  test('a connection that stopped before the months began: not "no history", not "no contributions", and why', () => {
    // Noon on Jun 10 in the machine's time zone, so Jun 10 in any.
    const since = new Date('2026-06-10T12:00:00').toISOString();
    const stopped = { kind: 'stopped' as const, institution: 'Chase', since };
    const flows = new Map(FLOWS);
    flows.set('sav', { source: 'transactions', months: ['2026-07', '2026-08', '2026-09'].map((m) => month(m, null, { gaps: [stopped] })) });
    const v = viewsOf([goal('fund', 'sav', 15_000)], ACCOUNTS, flows).views.get('fund')!;
    expect(v.projection).toMatchObject({ status: 'no_rate', completion: null });
    expect(outlookText(v, nameOf)).toBe('What went into Savings lately isn’t known, so neither is its pace: a monthly target projects it meanwhile');
    expect(gapNote(v)).toBe('What went into Savings lately isn’t known: Chase hasn’t synced since Jun 10.');
    // With a monthly target, it is projected at that, and still says why.
    const t = viewsOf([goal('fund', 'sav', 15_000, { monthly_target: 500 })], ACCOUNTS, flows).views.get('fund')!;
    expect(t.projection).toMatchObject({ rateFrom: 'monthly_target', completion: '2027-08' });
    expect(goalNotes(t, nameOf, undefined)[0]).toEqual({ text: 'What went into Savings lately isn’t known: Chase hasn’t synced since Jun 10.', warn: true });
  });

  test('every month averaged may be short and nothing came in: never "no contributions"', () => {
    const stopped = { kind: 'stopped' as const, institution: 'Chase', since: null };
    const flows = new Map(FLOWS);
    flows.set('sav', { source: 'transactions', months: ['2026-07', '2026-08', '2026-09'].map((m) => month(m, 0, { gaps: [stopped] })) });
    const v = viewsOf([goal('fund', 'sav', 15_000)], ACCOUNTS, flows).views.get('fund')!;
    expect(v.projection!.status).toBe('no_rate');
    expect(gapNote(v)).toBe('What went into Savings lately isn’t known: Chase isn’t syncing.');
    // One month that says so is enough to say nothing went in.
    flows.set('sav', { source: 'transactions', months: [month('2026-07', 0), month('2026-08', 0, { gaps: [stopped] }), month('2026-09', 0, { gaps: [stopped] })] });
    expect(viewsOf([goal('fund', 'sav', 15_000)], ACCOUNTS, flows).views.get('fund')!.projection!.status).toBe('no_recent_contributions');
  });

  test('a shared account whose months are known says its pace may be off, never that what went in isn’t known', () => {
    const importing = { kind: 'importing' as const, institution: 'Chase' };
    const flows = new Map(FLOWS);
    flows.set('sav', { source: 'transactions', months: [month('2026-07', 375.5), month('2026-08', 189.75), month('2026-09', 330.1, { gaps: [importing] })] });
    const goals = [goal('fund', 'sav', 15_000, { monthly_target: 400 }), goal('trip', 'sav', 5000, { monthly_target: 100 })];
    const v = viewsOf(goals, ACCOUNTS, flows).views.get('fund')!;
    expect(v.projection!.rateFrom).toBe('monthly_target');
    expect(gapNote(v)).toBe('The pace may be off: Chase is still importing older transactions.');
    const said = goalSentences(v, nameOf, undefined);
    expect(said).toContain('$298.45 a month went into Savings on average over the last 3 months (your target is $400.00).');
    expect(said.join(' ')).not.toContain('isn’t known');
    // Every month in question: then what went in lately isn't known.
    flows.set('sav', { source: 'transactions', months: ['2026-07', '2026-08', '2026-09'].map((m) => month(m, 100, { gaps: [importing] })) });
    expect(gapNote(viewsOf(goals, ACCOUNTS, flows).views.get('fund')!)).toBe('What went into Savings lately isn’t known: Chase is still importing older transactions.');
  });

  test('the gap note says which it is, for the card’s badge: the pace may be off, or isn’t known', () => {
    const importing = { kind: 'importing' as const, institution: 'Chase' };
    const flows = new Map(FLOWS);
    flows.set('sav', { source: 'transactions', months: [month('2026-07', 375.5), month('2026-08', 189.75), month('2026-09', 330.1, { gaps: [importing] })] });
    const off = viewsOf([goal('fund', 'sav', 15_000, { monthly_target: 400 })], ACCOUNTS, flows).views.get('fund')!;
    expect(gapItem(off)).toEqual({ kind: 'off', text: 'The pace may be off: Chase is still importing older transactions.' });
    flows.set('sav', { source: 'transactions', months: ['2026-07', '2026-08', '2026-09'].map((m) => month(m, null, { gaps: [importing] })) });
    const unknown = viewsOf([goal('fund', 'sav', 15_000)], ACCOUNTS, flows).views.get('fund')!;
    expect(gapItem(unknown)).toEqual({ kind: 'unknown', text: 'What went into Savings lately isn’t known: Chase is still importing older transactions.' });
    // gapNote is its words, and nothing when there are none.
    expect(gapNote(unknown)).toBe(gapItem(unknown)!.text);
    expect(gapItem(viewsOf([goal('fund', 'sav', 15_000)]).views.get('fund')!)).toBeNull();
  });

  test('paced by its balance because its transactions couldn’t be read: said', () => {
    const flows = new Map(FLOWS);
    flows.set('sav', { source: 'balances', months: [month('2026-07', 500), month('2026-08', 500), month('2026-09', 500)], fallback: { unreadable: 'Chase' } });
    const v = viewsOf([goal('fund', 'sav', 15_000)], ACCOUNTS, flows).views.get('fund')!;
    expect(fallbackText(v)).toBe('Chase’s transactions couldn’t be read, so this goal is paced by Savings’s recorded balance instead.');
    expect(goalNotes(v, nameOf, undefined)).toContainEqual({ text: fallbackText(v)!, warn: true });
    flows.set('manual_jar', { source: 'balances', months: [month('2026-09', 5)], fallback: { unreadable: 'Jar' } });
    expect(fallbackText(viewsOf([goal('jar', 'manual_jar', 1000)], ACCOUNTS, flows).views.get('jar')!)).toBe('Jar’s transactions couldn’t be read, so this goal is paced by its recorded balance instead.');
  });

  test('where it should be by now is said beside the meter, not only to a screen reader', () => {
    const v = viewsOf([goal('trip', 'eur', 5000, { target_date: '2027-12-31' }, { plan_start: { date: '2026-01-01', amount: 1000 } })]).views.get('trip')!;
    expect(goalNotes(v, nameOf, undefined)).toContainEqual({ text: 'To reach it by Dec 31, 2027, it would have €2,547.33 by now.', warn: false });
  });

  test('every sentence ends as one, for the API', () => {
    const v = viewsOf([goal('fund', 'sav', 15_000)]).views.get('fund')!;
    for (const s of goalSentences(v, nameOf, undefined)) expect(s).toMatch(/[.!?]$/);
  });
});
