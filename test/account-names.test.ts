import { describe, expect, test } from 'bun:test';
import { distinctAccountNames, nameAndMask, withMask } from '@/lib/account-names';

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

  // Activity's rows cut their second line with an ellipsis: the account's own
  // name first, so what is cut is the institution, never the name.
  test('name first, for a line that may be cut: the institution after a comma', () => {
    const names = distinctAccountNames([acct('a', 'Plaid Checking', 'First Platypus Bank'), acct('b', 'Plaid Checking', 'Tartan Bank'), acct('c', 'Savings', 'Tartan Bank'), acct('d', 'Cash', '')], { nameFirst: true });
    expect(names.get('a')).toBe('Plaid Checking, First Platypus Bank');
    expect(names.get('b')).toBe('Plaid Checking, Tartan Bank');
    expect(names.get('c')).toBe('Savings');
    expect(names.get('d')).toBe('Cash');
  });

  test('an account with no institution or no mask has nothing of it written', () => {
    const names = distinctAccountNames([acct('a', 'Cash', ''), acct('b', 'Cash', 'Ally'), acct('c', 'Cash', 'Ally')]);
    expect(names.get('a')).toBe('Cash');
    expect(names.get('b')).toBe('Ally Cash');
    expect(names.get('c')).toBe('Ally Cash');
  });
});

// A bank's name may already end in the account's last digits; Nya writes
// them once, after the name, so a name cut short keeps them in view.
describe('an account name with its last digits', () => {
  test('a name without them: the digits after it', () => {
    expect(nameAndMask('Roth IRA', '3302')).toEqual({ name: 'Roth IRA', mask: '3302' });
    expect(withMask('Roth IRA', '3302')).toBe('Roth IRA ••3302');
    expect(withMask('Plan 4421 Savings', '4421')).toBe('Plan 4421 Savings ••4421');
  });

  test('no digits: the name alone', () => {
    expect(nameAndMask('Roth IRA', null)).toEqual({ name: 'Roth IRA', mask: null });
    expect(withMask('Roth IRA', ' ')).toBe('Roth IRA');
  });

  test('a name that ends in them: taken off it and written once', () => {
    for (const name of [
      'Brokerage Account Alex Morgan Joint ...4421',
      'Brokerage Account Alex Morgan Joint - 4421',
      'Brokerage Account Alex Morgan Joint x4421',
      'Brokerage Account Alex Morgan Joint XXXX4421',
      'Brokerage Account Alex Morgan Joint (4421)',
      'Brokerage Account Alex Morgan Joint ••4421 ',
      'Brokerage Account Alex Morgan Joint - ****4421',
      'Brokerage Account Alex Morgan Joint …4421',
    ]) {
      expect(nameAndMask(name, '4421')).toEqual({ name: 'Brokerage Account Alex Morgan Joint', mask: '4421' });
    }
  });

  test('digits run into the name, or nothing but them: the name whole, nothing after it', () => {
    expect(nameAndMask('Account 214421', '4421')).toEqual({ name: 'Account 214421', mask: null });
    expect(nameAndMask('Max4421', '4421')).toEqual({ name: 'Max4421', mask: null });
    expect(nameAndMask('XXXX4421', '4421')).toEqual({ name: 'XXXX4421', mask: null });
    expect(nameAndMask('...4421', '4421')).toEqual({ name: '...4421', mask: null });
  });

  test('what joined the digits goes with them, and the name keeps its own marks', () => {
    expect(withMask('Account No. 4421', '4421')).toBe('Account No. ••4421');
    expect(withMask('Account:XXXX4421', '4421')).toBe('Account ••4421');
    expect(withMask('Account/x4421', '4421')).toBe('Account ••4421');
    expect(withMask('Roth IRA ', '3302')).toBe('Roth IRA ••3302');
  });

  test('an x that ends a word is not taken for the digits’ mark', () => {
    expect(nameAndMask('Index 4421', '4421')).toEqual({ name: 'Index', mask: '4421' });
    expect(nameAndMask('Max 1234', '4421')).toEqual({ name: 'Max 1234', mask: '4421' });
  });
});
