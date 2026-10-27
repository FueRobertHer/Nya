import { describe, expect, test } from 'bun:test';
import { readableName, shownName } from '@/lib/merchant-name';
import { bankRowDisplay, bankRowOlder, type StoredTxn } from '@/lib/transactions';
import { txn } from './api-fixture';

describe('readableName: a bank descriptor in capitals, readable', () => {
  test.each([
    ['CREDIT CARD 3333 PAYMENT *//', 'Credit Card 3333 Payment'],
    ['SQ *BLUE BOTTLE COFFEE', 'SQ *Blue Bottle Coffee'],
    ['AT&T *WIRELESS', 'AT&T *Wireless'],
    ["TRADER JOE'S #552", "Trader Joe's #552"],
    ['WAL-MART SUPERCENTER', 'Wal-Mart Supercenter'],
    ['7-ELEVEN 34211', '7-ELEVEN 34211'],
    ['ATM WITHDRAWAL', 'ATM Withdrawal'],
    ['ACH DEPOSIT FROM ACME CORP', 'ACH Deposit from Acme Corp'],
    ['CVS PHARMACY', 'CVS Pharmacy'],
    ['THE HOME DEPOT', 'The Home Depot'],
    ['BANK OF AMERICA', 'Bank of America'],
    ['UBER   TRIP  -', 'Uber Trip'],
    ['SAFEWAY 1234 SAN JOSE CA', 'Safeway 1234 San Jose CA'],
    ['CHEVRON PORTLAND OR', 'Chevron Portland OR'],
    ['SHELL INDIANAPOLIS IN', 'Shell Indianapolis IN'],
    ['AMAZON US', 'Amazon US'],
    ['USPS PO 0123', 'USPS PO 0123'],
    ['HBO MAX', 'HBO Max'],
    ['CAFÉ ROUGE', 'Café Rouge'],
    ['MÜNCHEN AIRPORT', 'München Airport'],
  ])('%s reads %s', (raw, shown) => {
    expect(readableName(raw)).toBe(shown);
  });

  test('a name with any lowercase letter is left as it is', () => {
    expect(readableName('Uber')).toBe('Uber');
    expect(readableName('iTunes STORE')).toBe('iTunes STORE');
  });

  test('a name with no letters, or only marks, is left as it is', () => {
    expect(readableName('12345')).toBe('12345');
    expect(readableName('*//')).toBe('*//');
  });
});

describe('shownName: only the bank text is reworded', () => {
  test('a bank descriptor (no merchant name) reads readably', () => {
    expect(shownName({ name: 'CREDIT CARD 3333 PAYMENT *//', name_from_bank: true })).toBe('Credit Card 3333 Payment');
  });

  test('a merchant name from Plaid, a rename or a rule name stays as given', () => {
    expect(shownName({ name: 'IKEA' })).toBe('IKEA');
    expect(shownName({ name: 'USAA' })).toBe('USAA');
  });
});

describe("the rows say when their name is the bank's text", () => {
  const ctx = { account_name: 'Checking', account_type: 'depository' };
  test("no merchant name from Plaid: the descriptor is the bank's, flagged", () => {
    const t = txn('t_pay', 'acc_chk', 3, 25, { name: 'CREDIT CARD 3333 PAYMENT *//' }) as unknown as StoredTxn;
    expect(bankRowDisplay(t, ctx).name_from_bank).toBe(true);
    expect(bankRowOlder(t, ctx).name_from_bank).toBe(true);
  });

  test('a merchant name from Plaid is shown as Plaid gives it, not flagged', () => {
    const t = txn('t_ikea', 'acc_chk', 3, 80, { name: 'IKEA 0042 BROOKLYN', merchant_name: 'IKEA' }) as unknown as StoredTxn;
    expect(bankRowDisplay(t, ctx).name).toBe('IKEA');
    expect('name_from_bank' in bankRowDisplay(t, ctx)).toBe(false);
  });
});
