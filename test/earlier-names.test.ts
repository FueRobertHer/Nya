import { describe, expect, test, mock } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

// How the Earlier accounts list names each account (lib/earlier-names.ts),
// which the restore card's notes use too, and why it leaves one out
// (lib/links.ts whyUnlisted), which must agree with what it lists.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { earlierNames, idEnds } = await import('@/lib/earlier-names');
const { whyUnlisted, forgettableAccounts } = await import('@/lib/links');
type Entry = import('@/lib/links').DirectoryEntry;

describe('earlierNames', () => {
  test('a label, or Balance history, as it is; two that would read the same over the same days told apart by the end of each id', () => {
    const names = earlierNames([
      { id: 'acc_9f2Lq7', label: null, first: '2025-11-01', last: '2025-11-02' },
      { id: 'acc_Xw31Bd', label: null, first: '2025-11-01', last: '2025-11-02' },
      { id: 'acc_kP0z5e', label: null, first: '2025-11-01', last: '2025-11-03' },
      { id: 'acc_one', label: 'Chase Checking ••1111', first: '2025-11-01', last: '2025-11-02' },
      { id: 'acc_two', label: 'Chase Checking ••1111', first: '2025-11-01', last: '2025-11-02' },
      { id: 'acc_three', label: 'Chase Checking ••1111', first: '2024-01-01', last: '2024-02-01' },
    ]);
    expect([...names]).toEqual([
      ['acc_9f2Lq7', 'Balance history · …2Lq7'],
      ['acc_Xw31Bd', 'Balance history · …31Bd'],
      // Other days: the list tells it apart already.
      ['acc_kP0z5e', 'Balance history'],
      ['acc_one', 'Chase Checking ••1111 · …_one'],
      ['acc_two', 'Chase Checking ••1111 · …_two'],
      ['acc_three', 'Chase Checking ••1111'],
    ]);
  });

  test('ids that end alike are given as much of their ends as tells them apart, the same each time', () => {
    expect([...idEnds(['x_1111', 'y_1111', 'acc_2222'])]).toEqual([
      ['x_1111', 'x_1111'],
      ['y_1111', 'y_1111'],
      ['acc_2222', 'c_2222'],
    ]);
    expect([...idEnds(['ab', 'cd'])]).toEqual([
      ['ab', 'ab'],
      ['cd', 'cd'],
    ]);
    expect(idEnds(['x_1111', 'y_1111', 'acc_2222'])).toEqual(idEnds(['x_1111', 'y_1111', 'acc_2222']));
  });
});

describe('whyUnlisted', () => {
  const entry = (item_id = 'item_gone'): Entry => ({
    provider: 'plaid',
    item_id,
    institution_id: 'ins_1',
    institution_name: 'Chase',
    name: 'Checking',
    official_name: null,
    mask: '1111',
    type: 'depository',
    subtype: 'checking',
    persistent_account_id: null,
    first_seen: '2025-01-01',
    last_seen: '2025-06-01',
  });
  const span = { first: '2025-01-01', last: '2025-06-01', firstBalance: 1, lastBalance: 2 };
  const input = {
    directory: { a_listed: entry(), a_conn: entry('item_live'), a_old: entry(), a_new: entry(), a_live: entry('item_live') },
    spans: { a_spans: span, manual_x: span, a_brk: span, a_live: span },
    liveIds: new Set(['a_live']),
    links: new Map([['a_old', { to: 'a_new', linked_at: '2025-06-02T00:00:00.000Z', evidence: {} }]]),
    unreadableLinks: new Set(['a_brk']),
  };
  const stored = new Set(['item_live']);

  test('says why each account the list leaves out is left out, and agrees with what it lists', () => {
    const ids = ['a_listed', 'a_spans', 'a_live', 'manual_x', 'a_conn', 'a_brk', 'a_old', 'a_new', 'a_unknown'];
    expect(ids.map((id) => whyUnlisted(input, stored, id))).toEqual([null, null, 'live', 'manual', 'connected', 'link-unreadable', 'linked', 'linked-to', 'unknown']);
    const listed = forgettableAccounts(input, new Set(), stored).map((e) => e.id);
    expect(listed.sort()).toEqual(ids.filter((id) => whyUnlisted(input, stored, id) === null).sort());
  });
});
