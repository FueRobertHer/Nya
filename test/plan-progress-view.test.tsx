import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressView, SheetBody, readInflation, shortWhy, type ProgressAnswer, type ProgressViewProps } from '@/components/PlanProgress';
import { wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN, type FirePlan } from '@/lib/fire/plan';
import type { SavedPlan } from '@/lib/fire/saved-plan';

// The Progress card at the end of Your path (components/PlanProgress.tsx,
// rollout 8e): "This is my plan" only when the Plan can be saved; once saved,
// where you are set against where the plan has you (worked by hand), only on
// a whole day a month or more after the start, with a newer short day, an
// account added since, damaged days and a changed Plan each said; and the
// sheets' words.

/** The text a person reads, without the markup. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();

const PLAN: FirePlan = { ...DEFAULT_PLAN, age: 35, targetAge: 55, realReturn: 0.05 };
const SAVED: SavedPlan = { version: 1, plan: PLAN, savings: 10_000, currency: 'USD', inflation: 0.03, day: '2024-01-01', savedAt: '2024-01-01T12:00:00.000Z', rev: 'r1' };
const day = (date: string, total: number | null, over: Partial<ProgressAnswer['latest'] & object> = {}) => ({ date, total, counted: 1, missing: [], otherCurrencies: {}, unrated: [], ...over });
/** Started from 100,000 on Jan 1, 2024; whole again four years on. */
const answer = (actual: number, over: Partial<ProgressAnswer> = {}): ProgressAnswer => ({
  currency: 'USD',
  saved_day: '2024-01-01',
  anchor: day('2024-01-01', 100_000),
  latest: day('2028-01-01', actual),
  months: [
    { date: '2024-01-31', total: 101_000 },
    { date: '2028-01-01', total: actual },
  ],
  accounts: [{ account_id: 'brk', first: '2024-01-01', last: '2028-01-01', ended: null, label: null }],
  unreadable_days: [],
  ...over,
});

const NAMES: Record<string, string> = { brk: 'Brokerage at Broker', ira: 'IRA at Broker', newira: 'New IRA at Broker' };
const props = (over: Partial<ProgressViewProps> = {}): ProgressViewProps => ({
  savedState: { kind: 'ready', saved: SAVED, problem: null },
  series: { kind: 'ready', answer: answer(190_000) },
  plan: PLAN,
  blocked: null,
  scenarioOpen: false,
  savings: { value: 10_000, source: 'measured' },
  money: (n) => wholeMoney(n, 'USD'),
  nameOf: (id) => NAMES[id] ?? 'an account no longer linked',
  busy: false,
  error: null,
  onSheet: () => {},
  onRetry: () => {},
  ...over,
});
const view = (over: Partial<ProgressViewProps> = {}) => renderToStaticMarkup(<ProgressView {...props(over)} />);
const none = { savedState: { kind: 'ready' as const, saved: null, problem: null }, series: null };

describe('nothing saved yet', () => {
  test('offers This is my plan, saying what it keeps', () => {
    const html = view(none);
    expect(text(html)).toContain('Progress Say this is your plan, and Nya keeps its assumptions and sets your invested assets against them as they are recorded.');
    expect(html).toMatch(/<button type="button" class="btn secondary">This is my plan<\/button>/);
    expect(html).not.toContain('Progress options');
  });

  test('not while the Plan can’t be saved, saying why; not with a scenario open; not without savings', () => {
    const blocked = view({ ...none, blocked: 'Your saved plan has values to fix first (at the top of the Plan tab), so this can’t be saved yet.' });
    expect(blocked).toMatch(/class="btn secondary" disabled="">This is my plan/);
    expect(text(blocked)).toContain('values to fix first');
    const scenario = view({ ...none, scenarioOpen: true });
    expect(scenario).not.toContain('This is my plan');
    expect(text(scenario)).toContain('A scenario is open: go back to your plan to save it as your plan.');
    const unmeasured = view({ ...none, savings: { value: null, source: 'unmeasured' } });
    expect(unmeasured).toMatch(/disabled="">This is my plan/);
    expect(text(unmeasured)).toContain('Your annual savings aren’t measured');
    expect(text(view({ ...none, savings: { value: null, source: 'none' } }))).toContain('Your plan needs your annual savings first');
  });

  test('loading, a load that failed, one that can’t be read, and one a newer version saved', () => {
    expect(text(view({ savedState: { kind: 'loading' }, series: null }))).toContain('Loading your saved plan');
    const failed = view({ savedState: { kind: 'failed', message: null }, series: null });
    expect(failed).toContain('class="notice caution"');
    expect(text(failed)).toContain('Your saved plan couldn’t be loaded. Try again');
    const unreadable = view({ savedState: { kind: 'ready', saved: null, problem: 'unreadable' }, series: null });
    expect(unreadable).toContain('class="notice critical"');
    expect(text(unreadable)).toContain('couldn’t be read, so nothing is set against it. Delete it');
    expect(unreadable).not.toContain('This is my plan');
    const newer = view({ savedState: { kind: 'ready', saved: null, problem: 'newer' }, series: null });
    expect(text(newer)).toContain('saved by a newer version of Nya');
    expect(newer).not.toContain('Delete it');
  });
});

describe('saved, set against what was recorded', () => {
  test('ahead, by hand: 100,000 grown four years at 5%, saving 10,000 a year, raised by 3% inflation, is 185,317', () => {
    const t = text(view());
    expect(t).toContain('Your plan from Jan 1, 2024.');
    expect(t).toContain('Started from $100,000, recorded on Jan 1, 2024.');
    expect(t).toContain('Invested on Jan 1, 2028 $190,000 Where your plan has you $185,317');
    expect(t).toContain('$4,683 ahead of it.');
    expect(t).toContain('Growing a steady 5% a year after inflation, saving $10,000 a year, with prices rising 3% a year.');
    expect(t).toContain('Hypothetical: a steady return and steady prices, not a prediction, and not advice.');
    expect(view()).toContain('Progress options');
  });

  test('behind, and level', () => {
    expect(text(view({ series: { kind: 'ready', answer: answer(180_000) } }))).toContain('$5,317 behind it.');
    expect(text(view({ series: { kind: 'ready', answer: answer(185_317.2) } }))).toContain('Level with it.');
  });

  test('under a month after the start: the start, and nothing set against it yet', () => {
    const early = answer(101_000, { latest: day('2024-01-20', 101_000), months: [{ date: '2024-01-20', total: 101_000 }] });
    const t = text(view({ series: { kind: 'ready', answer: early } }));
    expect(t).toContain('Started from $100,000');
    expect(t).toContain('A month after that, Nya sets where you are against where your plan has you.');
    expect(t).not.toContain('ahead');
    expect(t).not.toContain('behind');
  });

  test('no whole day yet: says what the newest day misses, and no start', () => {
    const waiting = answer(0, { anchor: null, months: [], latest: day('2024-01-02', 60_000, { missing: ['ira'] }) });
    const t = text(view({ series: { kind: 'ready', answer: waiting } }));
    expect(t).toContain('Progress shows from the first day every account your plan counts is recorded whole. On Jan 2, 2024, IRA at Broker wasn’t recorded that day.');
    expect(t).not.toContain('Started from');
    const nothing = text(view({ series: { kind: 'ready', answer: answer(0, { anchor: null, months: [], latest: null }) } }));
    expect(nothing).toContain('Progress shows once Nya records your invested assets');
  });

  test('a newer day that wasn’t whole isn’t counted, and says why; the comparison is the newest whole day', () => {
    const short = answer(190_000, { latest: day('2028-01-05', 120_000, { missing: ['ira'] }) });
    const html = view({ series: { kind: 'ready', answer: short } });
    expect(text(html)).toContain('Invested on Jan 1, 2028 $190,000');
    expect(html).toContain('class="notice caution"');
    expect(text(html)).toContain('Jan 5, 2028 isn’t counted: IRA at Broker wasn’t recorded that day.');
  });

  test('an account first recorded after the start is named: what it held counts as progress', () => {
    const added = answer(190_000, { accounts: [...answer(0).accounts, { account_id: 'newira', first: '2025-03-01', last: '2028-01-01', ended: null, label: null }] });
    const html = view({ series: { kind: 'ready', answer: added } });
    expect(html).toContain('class="notice caution"');
    expect(text(html)).toContain('New IRA at Broker was first recorded after Jan 1, 2024, so what it held then counts as progress here.');
    // One that stopped being recorded before the day compared isn't in it.
    const gone = answer(190_000, { accounts: [{ account_id: 'newira', first: '2025-03-01', last: '2025-04-01', ended: null, label: null }] });
    expect(text(view({ series: { kind: 'ready', answer: gone } }))).not.toContain('first recorded after');
  });

  test('an account counted in the start that ended since is named: it is in one end and not the other', () => {
    const ended = answer(190_000, { accounts: [...answer(0).accounts, { account_id: 'ira', first: '2024-01-01', last: '2025-06-01', ended: '2025-06-02', label: null }] });
    const html = view({ series: { kind: 'ready', answer: ended } });
    expect(text(html)).toContain('IRA at Broker (on Jun 2, 2025) ended since Jan 1, 2024: what it held is in the start and not since, so it counts again only where it went to an account your plan counts.');
    // One that ended before the start, or after the day compared, isn't.
    for (const at of ['2023-12-01', '2028-02-01']) {
      const outside = answer(190_000, { accounts: [{ account_id: 'ira', first: '2023-01-01', last: '2028-01-01', ended: at, label: null }] });
      expect(text(view({ series: { kind: 'ready', answer: outside } }))).not.toContain('ended since');
    }
  });

  test('savings below zero read as spending more than comes in', () => {
    expect(text(view({ savedState: { kind: 'ready', saved: { ...SAVED, savings: -5_000 }, problem: null } }))).toContain('spending $5,000 a year more than comes in');
  });

  test('a save that met a change on another device is information; a failure is critical', () => {
    expect(view({ error: { text: 'Your saved plan was changed on another device: here it is as it is now.', kind: 'info' } })).toContain('<p class="notice info">Your saved plan was changed on another device');
    expect(view({ error: { text: 'Failed to save your plan', kind: 'critical' } })).toContain('<p class="notice critical">Failed to save your plan');
  });

  test('days that couldn’t be read are said', () => {
    expect(text(view({ series: { kind: 'ready', answer: answer(190_000, { unreadable_days: ['2026-02-03'] }) } }))).toContain('The balances of Feb 3, 2026 couldn’t be read, so that day is left out.');
    expect(text(view({ series: { kind: 'ready', answer: answer(190_000, { unreadable_days: ['2026-02-03', '2026-02-04'] }) } }))).toContain('2 days couldn’t be read');
  });

  test('loading and a failed load of the days', () => {
    expect(text(view({ series: { kind: 'loading' } }))).toContain('Loading your invested assets since then');
    const failed = view({ series: { kind: 'failed', message: null } });
    expect(text(failed)).toContain('Your invested assets since then couldn’t be loaded. Try again');
  });

  test('a change to what the comparison rests on is said, with a save of the Plan as it is now; a birthday isn’t', () => {
    expect(view({ plan: { ...PLAN, age: 36 } })).not.toContain('changed since');
    const changed = view({ plan: { ...PLAN, realReturn: 0.04, includeCash: true } });
    expect(text(changed)).toContain('Your Plan’s growth after inflation and include cash changed since you saved it. This compares with the plan as you saved it.');
    expect(changed).toContain('Save the Plan as it is now');
    expect(view({ plan: { ...PLAN, realReturn: 0.04 }, scenarioOpen: true })).not.toContain('Save the Plan as it is now');
    expect(view({ plan: { ...PLAN, realReturn: 0.04 }, blocked: 'Still loading or saving your plan.' })).toMatch(/disabled="">Save the Plan as it is now/);
  });
});

describe('why a day is short', () => {
  test('each reason, named', () => {
    const nameOf = (id: string) => NAMES[id] ?? id;
    expect(shortWhy(day('2026-10-01', 10, { missing: ['ira', 'newira'] }), nameOf)).toBe('IRA at Broker and New IRA at Broker weren’t recorded that day.');
    expect(shortWhy(day('2026-10-01', 10, { otherCurrencies: { EUR: 2 } }), nameOf)).toBe(
      '2 accounts in EUR are left out: without a home currency Nya doesn’t convert them (choose one on the Currency card in Settings, Preferences).'
    );
    expect(shortWhy(day('2026-10-01', 10, { unrated: [{ currency: 'ARS', accounts: 1, why: 'unpublished', unrated: 'ARS' }] as never }), nameOf)).toBe('1 account in ARS had no exchange rate that day.');
    expect(shortWhy(day('2026-10-01', 10), nameOf)).toBeNull();
  });
});

describe('the sheets', () => {
  const body = (sheet: Parameters<typeof SheetBody>[0]['sheet'], saved: SavedPlan | null = null) =>
    text(renderToStaticMarkup(<SheetBody sheet={sheet} saved={saved} savings={10_000} money={(n) => wholeMoney(n, 'USD')} inflation="3" onInflation={() => {}} error={null} />));

  test('saving says what is kept, and that nothing worked out is', () => {
    expect(body('save')).toContain('Nya keeps your Plan’s assumptions as they are now, and the $10,000 a year of savings it uses, and sets your invested assets against them from today. Nothing worked out from them is kept.');
    expect(body('save')).toContain('Inflation a year, %');
    expect(body('save')).not.toContain('replaces');
    expect(body('resave', SAVED)).toContain('This replaces the plan you saved on Jan 1, 2024, and the comparison starts again from today.');
  });

  test('stopping says it can’t be undone, and that the Plan stays', () => {
    expect(body('forget', SAVED)).toBe('Nya forgets the plan you saved on Jan 1, 2024. Your Plan and its figures stay as they are. This can’t be undone.');
    expect(body('forget-unreadable')).toContain('can’t be undone');
  });

  test('the inflation typed, as a fraction, or why not', () => {
    expect(readInflation('3')).toBe(0.03);
    expect(readInflation(' 2.5 % ')).toBe(0.025);
    expect(readInflation('0')).toBe(0);
    for (const t of ['', 'abc', '-1', '21']) expect(typeof readInflation(t)).toBe('string');
  });
});
