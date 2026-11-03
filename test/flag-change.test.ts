import { afterEach, describe, expect, test } from 'bun:test';
import { applyFlagChange, flagChangeNeedsFreshSignIn, FlagChangeRefused, nextFlagValue, NoFlagChange, parseFlagChange, type FlagChange } from '@/lib/flag-change';
import { describeChange, switchRows } from '@/lib/flag-view';
import type { FlagValue } from '@/lib/flags';
import type { ContainerId } from '@/lib/containers';

// A change the admin makes to a feature switch (lib/flag-change.ts): what a
// request may ask of each kind, the value it leaves, and when it asks for a
// fresh sign-in. And the rows and words the pages show them in
// (lib/flag-view.ts).

const C1 = '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70' as ContainerId;
const C2 = '6e2d8f3b-0c4a-4d7e-9f2b-3c4d5e6f7a81' as ContainerId;
const AT = '2026-11-01T12:00:00.000Z';
const NOW = Date.parse('2026-11-02T09:00:00.000Z');
const LATER = new Date(NOW).toISOString();

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const ok = (key: Parameters<typeof parseFlagChange>[0], raw: unknown) => {
  const change = parseFlagChange(key, raw);
  if ('refused' in change) throw new Error(change.refused);
  return change;
};
const refused = (key: Parameters<typeof parseFlagChange>[0], raw: unknown) => {
  const change = parseFlagChange(key, raw);
  return 'refused' in change ? change.refused : null;
};

describe('what a request may ask', () => {
  test('a choice of its own kind, for every kind but the list', () => {
    expect(ok('plan-tax', { op: 'choose', choice: 'admin' })).toEqual({ op: 'choose', choice: 'admin' });
    expect(ok('csp', { op: 'choose', choice: 'enforce' })).toEqual({ op: 'choose', choice: 'enforce' });
    expect(ok('ops', { op: 'choose', choice: 'on' })).toEqual({ op: 'choose', choice: 'on' });
    expect(refused('ops', { op: 'choose', choice: 'everyone' })).toBe('That isn’t a choice this switch takes.');
    expect(refused('sign-in', { op: 'choose', choice: 'everyone' })).toBe('Who may sign in is changed by adding and removing people.');
    expect(refused('ops', null)).toBe('Say what to change.');
    expect(refused('ops', { op: 'delete' })).toBe('That isn’t a change a switch takes.');
  });

  test('accounts, for an audience only, by a real container id', () => {
    expect(ok('lunchflow', { op: 'add-account', container: C1 })).toEqual({ op: 'add-account', container: C1 });
    expect(ok('lunchflow', { op: 'remove-account', container: C1 })).toEqual({ op: 'remove-account', container: C1 });
    expect(refused('lunchflow', { op: 'add-account', container: 'not-a-container' })).toBe('Name an account by its id.');
    expect(refused('csp', { op: 'add-account', container: C1 })).toBe('Only a switch for an audience is on for accounts.');
    expect(refused('sign-in', { op: 'add-account', container: C1 })).toBe('Only a switch for an audience is on for accounts.');
  });

  test('people, for the sign-in list only: an email, lowercased, or a Clerk user id', () => {
    expect(ok('sign-in', { op: 'add-person', entry: '  Jane@Example.com ' })).toEqual({ op: 'add-person', entry: 'jane@example.com' });
    expect(ok('sign-in', { op: 'add-person', entry: 'user_2abcDEF9' })).toEqual({ op: 'add-person', entry: 'user_2abcDEF9' });
    expect(refused('ops', { op: 'add-person', entry: 'jane@example.com' })).toBe('Only who may sign in lists people.');
    // A typo never adds a meaningless entry.
    expect(refused('sign-in', { op: 'add-person', entry: 'jane' })).toBe('Type an email address, or a Clerk user id (it starts with user_).');
    expect(refused('sign-in', { op: 'add-person', entry: 'user_ab-c' })).toBe('Type an email address, or a Clerk user id (it starts with user_).');
    expect(refused('sign-in', { op: 'add-person', entry: 'jane@' })).toBe('That doesn’t look like an email address.');
    expect(refused('sign-in', { op: 'add-person', entry: 'jane doe@example.com' })).toBe('That doesn’t look like an email address.');
    // What the stored list could never hold, adding or removing.
    for (const op of ['add-person', 'remove-person']) {
      expect(refused('sign-in', { op, entry: '' })).toBe('Type an email address or a Clerk user id.');
      expect(refused('sign-in', { op, entry: '   ' })).toBe('Type an email address or a Clerk user id.');
      expect(refused('sign-in', { op, entry: 7 })).toBe('Type an email address or a Clerk user id.');
      expect(refused('sign-in', { op, entry: 'a@b.c,d@e.f' })).toBe('Add or remove one person at a time.');
      expect(refused('sign-in', { op, entry: `user_${'a'.repeat(316)}` })).toBe('That is longer than an email address or a user id can be.');
    }
    expect(refused('sign-in', { op: 'add-person', entry: `user_${'a'.repeat(315)}` })).toBeNull(); // 320, the longest
    // Removing takes any entry a list set some other way could hold.
    expect(ok('sign-in', { op: 'remove-person', entry: 'legacy-id' })).toEqual({ op: 'remove-person', entry: 'legacy-id' });
  });
});

const audience = (on: string, containers: string[] = [], updatedAt = AT) => ({ on, containers, updatedAt }) as FlagValue;
const list = (ids: string[], emails: string[], updatedAt = AT) => ({ ids, emails, updatedAt }) as FlagValue;
const apply = (key: Parameters<typeof applyFlagChange>[0], current: FlagValue | null, change: FlagChange) => applyFlagChange(key, current, change, NOW);

describe('the value a change leaves', () => {
  test('a choice: its value, an audience keeping its accounts; the choice already stored changes nothing', () => {
    expect(apply('plan-tax', null, { op: 'choose', choice: 'admin' })).toEqual(audience('admin', [], LATER));
    expect(apply('plan-tax', audience('nobody', [C1]), { op: 'choose', choice: 'everyone' })).toEqual(audience('everyone', [C1], LATER));
    expect(apply('plan-tax', audience('everyone', [C1]), { op: 'choose', choice: 'everyone' })).toBe('unchanged');
    expect(apply('csp', { mode: 'report-only', updatedAt: AT }, { op: 'choose', choice: 'enforce' })).toEqual({ mode: 'enforce', updatedAt: LATER });
    expect(apply('ops', { on: true, updatedAt: AT }, { op: 'choose', choice: 'on' })).toBe('unchanged');
  });

  test('an account: added once, from the default with nothing stored; removed when named', () => {
    process.env.VERCEL_ENV = 'production';
    expect(apply('lunchflow', null, { op: 'add-account', container: C1 })).toEqual(audience('nobody', [C1], LATER));
    expect(apply('lunchflow', audience('admin', [C1]), { op: 'add-account', container: C2 })).toEqual(audience('admin', [C1, C2], LATER));
    expect(apply('lunchflow', audience('admin', [C1]), { op: 'add-account', container: C1 })).toBe('unchanged');
    expect(apply('lunchflow', audience('admin', [C1, C2]), { op: 'remove-account', container: C1 })).toEqual(audience('admin', [C2], LATER));
    expect(apply('lunchflow', audience('admin', [C2]), { op: 'remove-account', container: C1 })).toBe('unchanged');
    // Removing from nothing stored changes nothing, and never answers null.
    expect(apply('lunchflow', null, { op: 'remove-account', container: C1 })).toBe('unchanged');
  });

  test('a person: added once to the half they belong in; removed in any case they were typed', () => {
    expect(apply('sign-in', null, { op: 'add-person', entry: 'jane@example.com' })).toEqual(list([], ['jane@example.com'], LATER));
    expect(apply('sign-in', list(['user_a'], []), { op: 'add-person', entry: 'user_b' })).toEqual(list(['user_a', 'user_b'], [], LATER));
    expect(apply('sign-in', list(['user_a'], []), { op: 'add-person', entry: 'user_a' })).toBe('unchanged');
    const typed = ok('sign-in', { op: 'remove-person', entry: 'Jane@Example.COM' });
    expect(apply('sign-in', list(['user_a'], ['jane@example.com']), typed)).toEqual(list(['user_a'], [], LATER));
    expect(apply('sign-in', null, { op: 'remove-person', entry: 'user_a' })).toBe('unchanged');
  });

  test('a list or an audience already at a thousand refuses one more', () => {
    const many = Array.from({ length: 1000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(apply('lunchflow', audience('nobody', many), { op: 'add-account', container: C1 })).toEqual({ refused: 'A switch can be on for at most 1000 accounts by name.' });
    const ids = Array.from({ length: 1000 }, (_, i) => `user_${i}`);
    expect(apply('sign-in', list(ids, []), { op: 'add-person', entry: 'user_new' })).toEqual({ refused: 'The list holds at most 1000 user ids.' });
    // The other half still has room.
    expect(apply('sign-in', list(ids, []), { op: 'add-person', entry: 'jane@example.com' })).toMatchObject({ emails: ['jane@example.com'] });
  });

  test('for a store update, nothing to change and a refusal are thrown, never answered', () => {
    expect(() => nextFlagValue('ops', { on: true, updatedAt: AT }, { op: 'choose', choice: 'on' }, NOW)).toThrow(NoFlagChange);
    const ids = Array.from({ length: 1000 }, (_, i) => `user_${i}`);
    expect(() => nextFlagValue('sign-in', list(ids, []), { op: 'add-person', entry: 'user_new' }, NOW)).toThrow(FlagChangeRefused);
    expect(nextFlagValue('ops', null, { op: 'choose', choice: 'on' }, NOW)).toEqual({ on: true, updatedAt: LATER });
  });
});

describe('a fresh sign-in', () => {
  test('asked for everywhere but Vercel’s Preview and a local next dev', () => {
    const cases: [string | undefined, string | undefined, boolean][] = [
      ['production', 'production', true],
      ['preview', 'production', false],
      [undefined, 'development', false], // bun run dev
      [undefined, 'production', true], // next start, off Vercel: flagEnvironment() says development, and it is asked for
      ['development', 'development', false], // vercel dev
    ];
    for (const [vercel, node, asked] of cases) {
      if (vercel === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = vercel;
      (process.env as Record<string, string>).NODE_ENV = node!;
      expect([vercel, node, flagChangeNeedsFreshSignIn()]).toEqual([vercel, node, asked]);
    }
  });
});

describe('the rows and the record', () => {
  const report = {
    entries: new Map<string, FlagValue>([
      ['lunchflow', audience('admin', [C1, C2])],
      ['sign-in', list(['user_a'], ['pat@example.com'])],
    ]),
    unrecognised: ['restore'],
  };

  test('the admin page names accounts and people; /dev/flags counts them and names none', () => {
    const admin = Object.fromEntries(switchRows(report, 'admin').map((r) => [r.key, r]));
    expect(admin.lunchflow).toMatchObject({ name: 'Lunch Flow', stored: 'admin', accounts: 2, containers: [C1, C2] });
    expect(admin['sign-in']).toMatchObject({ stored: 'list', people: 2, ids: ['user_a'], emails: ['pat@example.com'] });
    expect(admin.restore.stored).toBe('unreadable');
    expect(admin['plan-tax']).toMatchObject({ stored: null, removeBy: '2027-06-30', offMeans: expect.stringContaining('flat rate') });
    const dev = switchRows(report, 'dev');
    const text = JSON.stringify(dev);
    for (const secret of [C1, C2, 'user_a', 'pat@example.com']) expect(text).not.toContain(secret);
    expect(dev.find((r) => r.key === 'lunchflow')).toMatchObject({ accounts: 2, containers: null });
    expect(dev.find((r) => r.key === 'sign-in')).toMatchObject({ people: 2, ids: null, emails: null });
  });

  test('a variable still set says what it decides', () => {
    process.env.LUNCHFLOW_ENABLED = '1';
    process.env.CSP_MODE = 'enforce';
    const rows = Object.fromEntries(switchRows(report, 'admin').map((r) => [r.key, r]));
    expect(rows.lunchflow).toMatchObject({ variableSet: true, variableChoice: 'everyone' });
    expect(rows.csp).toMatchObject({ variableSet: true, variableChoice: 'enforce' });
    expect(rows['plan-tax']).toMatchObject({ variable: null, variableSet: false, variableChoice: null });
  });

  test('each change in words, under the flag’s name, with who made it unless it was the admin', () => {
    const admin = C1 as never;
    const line = (key: string, from: FlagValue | null, to: FlagValue, by: string) => describeChange({ at: AT, key, from, to, by }, admin);
    expect(line('plan-tax', audience('nobody'), audience('admin'), C1)).toEqual({ at: AT, key: 'plan-tax', name: 'Detailed tax in the Plan', change: 'Off to You', by: null });
    expect(line('plan-tax', null, audience('everyone'), 'local development')).toMatchObject({ change: 'Set to Everyone', by: 'Local development' });
    expect(line('lunchflow', audience('nobody'), audience('nobody', [C2]), C1)).toMatchObject({ name: 'Lunch Flow', change: 'Added Account 6e2d8f3b' });
    expect(line('lunchflow', audience('nobody', [C2, C1]), audience('nobody', [C1]), 'account deletion')).toMatchObject({ change: 'Removed Account 6e2d8f3b', by: 'Account deletion' });
    expect(line('lunchflow', audience('nobody'), audience('nobody', [C1]), C2)).toMatchObject({ change: 'Added You', by: 'Account 6e2d8f3b' });
    expect(line('lunchflow', audience('admin', [C2]), audience('everyone', [C2]), C1).change).toBe('You to Everyone');
    expect(line('lunchflow', audience('admin'), audience('admin'), C1).change).toBe('Saved again');
    expect(line('csp', { mode: 'report-only', updatedAt: AT }, { mode: 'enforce', updatedAt: AT }, C1)).toMatchObject({ name: 'Content security policy', change: 'Report only to Enforce' });
    expect(line('ops', { on: false, updatedAt: AT }, { on: true, updatedAt: AT }, C1)).toMatchObject({ name: 'Ops routes', change: 'Off to On' });
    expect(line('sign-in', list([], []), list([], ['jane@example.com']), C1)).toMatchObject({ name: 'Who may sign in', change: 'Added jane@example.com' });
    expect(line('sign-in', list(['user_a'], []), list([], []), C1).change).toBe('Removed user_a');
    // A flag a later release added, which this one doesn't know.
    expect(line('newer-flag', null, audience('admin'), C1)).toMatchObject({ name: 'newer-flag', change: 'Set to You' });
  });
});
