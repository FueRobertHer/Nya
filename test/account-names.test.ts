import { describe, expect, test } from 'bun:test';
import { distinctAccountNames } from '@/lib/account-names';

// The names a list gives its accounts, so two rows never read the same when
// the accounts are different (lib/account-names.ts): the screen review found
// "Plaid Mortgage is overdue" twice, from two sandbox banks with the same
// account names and masks.

const acct = (id: string, name: string, institution: string, mask: string | null = null) => ({ id, name, institution, mask });

describe('distinct account names', () => {
  test('a name no other account has is the name alone', () => {
    const names = distinctAccountNames([acct('a', 'Checking', 'Chase', '1111'), acct('b', 'Savings', 'Chase', '2222')]);
    expect([...names]).toEqual([
      ['a', 'Checking'],
      ['b', 'Savings'],
    ]);
  });

  test('the same name at two institutions: each with its institution, and no mask, even when the masks match', () => {
    const names = distinctAccountNames([acct('a', 'Plaid Mortgage', 'Tartan Bank', '8888'), acct('b', 'Plaid Mortgage', 'Houndstooth Bank', '8888'), acct('c', 'Plaid Checking', 'Tartan Bank', '0000')]);
    expect(names.get('a')).toBe('Tartan Bank Plaid Mortgage');
    expect(names.get('b')).toBe('Houndstooth Bank Plaid Mortgage');
    expect(names.get('c')).toBe('Plaid Checking');
  });

  test('the same name at one institution: the mask is added', () => {
    const names = distinctAccountNames([acct('a', 'Checking', 'Chase', '1111'), acct('b', 'Checking', 'Chase', '2222'), acct('c', 'Checking', 'Ally', '1111')]);
    expect(names.get('a')).toBe('Chase Checking ••1111');
    expect(names.get('b')).toBe('Chase Checking ••2222');
    // Ally's has no twin at Ally: its institution is enough.
    expect(names.get('c')).toBe('Ally Checking');
  });

  test('name, institution and mask all the same: nothing more to add, so they stay alike', () => {
    const names = distinctAccountNames([acct('a', 'Checking', 'Chase', '1111'), acct('b', 'Checking', 'Chase', '1111')]);
    expect(names.get('a')).toBe('Chase Checking ••1111');
    expect(names.get('b')).toBe('Chase Checking ••1111');
  });

  test('told not to add the mask, for a caller that writes it after every name', () => {
    const names = distinctAccountNames([acct('a', 'Checking', 'Chase', '1111'), acct('b', 'Checking', 'Chase', '2222')], { mask: false });
    expect(names.get('a')).toBe('Chase Checking');
    expect(names.get('b')).toBe('Chase Checking');
  });

  test('an account with no institution or no mask has nothing of it written', () => {
    const names = distinctAccountNames([acct('a', 'Cash', ''), acct('b', 'Cash', 'Ally'), acct('c', 'Cash', 'Ally')]);
    expect(names.get('a')).toBe('Cash');
    expect(names.get('b')).toBe('Ally Cash');
    expect(names.get('c')).toBe('Ally Cash');
  });
});
