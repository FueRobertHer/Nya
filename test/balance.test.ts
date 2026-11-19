import { describe, expect, test } from 'bun:test';
import { isBankCash, isDepositoryHsa, isInvestmentType, isOwedType, signedContribution } from '@/lib/balance';

// Small surface, but it is now the single definition behind net worth, the
// history subtraction, manual-account validation and every figure the Dashboard
// renders. An inversion here shows up as a net worth wrong by twice the balance
// of every card and loan, in the same direction, everywhere at once.

describe('isOwedType', () => {
  test('credit and loan are owed', () => {
    expect(isOwedType('credit')).toBe(true);
    expect(isOwedType('loan')).toBe(true);
  });

  test('asset types are not', () => {
    for (const t of ['depository', 'investment', 'brokerage', 'other']) {
      expect(isOwedType(t)).toBe(false);
    }
  });

  // Plaid types are lowercase and the manual-account form constrains its own
  // set, so nothing normalizes case before calling this. Pinning the behaviour
  // so a future caller that passes 'Credit' fails loudly here rather than
  // quietly counting a card as an asset.
  test('is case-sensitive and rejects unknown types', () => {
    expect(isOwedType('Credit')).toBe(false);
    expect(isOwedType('')).toBe(false);
    expect(isOwedType('credit_card')).toBe(false);
  });
});

describe('signedContribution', () => {
  test('assets add, debts subtract', () => {
    expect(signedContribution('depository', 1000)).toBe(1000);
    expect(signedContribution('investment', 25_000)).toBe(25_000);
    expect(signedContribution('credit', 5544.35)).toBe(-5544.35);
    expect(signedContribution('loan', 310_000)).toBe(-310_000);
  });

  // An overdrawn checking account is a real negative, and a card in credit
  // (a refund past the balance) is a real positive. Both must pass through
  // rather than be clamped.
  test('negative balances keep their meaning on both sides', () => {
    expect(signedContribution('depository', -42)).toBe(-42);
    expect(signedContribution('credit', -120)).toBe(120);
  });

  test('an unknown type is treated as an asset, matching computeNetWorth', () => {
    expect(signedContribution('other', 500)).toBe(500);
    expect(signedContribution('', 500)).toBe(500);
  });
});

// Now gates a Plaid call, not just a label: lib/networth.ts skips
// /investments/holdings/get for an Item with no account of these types. A
// false negative here means a real brokerage silently stops reporting its
// positions, with no error anywhere to say so.
describe('isInvestmentType', () => {
  test('investment and the legacy brokerage both hold securities', () => {
    expect(isInvestmentType('investment')).toBe(true);
    expect(isInvestmentType('brokerage')).toBe(true);
  });

  test('cash, cards and loans do not', () => {
    for (const t of ['depository', 'credit', 'loan', 'other', '']) {
      expect(isInvestmentType(t)).toBe(false);
    }
  });

  // Same rule as isOwedType above: Plaid types are lowercase and nothing
  // normalizes before the call.
  test('is case-sensitive', () => {
    expect(isInvestmentType('Investment')).toBe(false);
  });
});

describe('isDepositoryHsa and isBankCash', () => {
  test('an HSA a bank reports as a bank account is not bank cash', () => {
    for (const subtype of ['hsa', 'HSA']) {
      expect(isDepositoryHsa({ type: 'depository', subtype })).toBe(true);
      expect(isBankCash({ type: 'depository', subtype })).toBe(false);
    }
  });

  test('checking, savings and cash on hand are bank cash; an investment HSA is neither', () => {
    for (const subtype of ['checking', 'savings', 'cash', null, undefined]) {
      expect(isBankCash({ type: 'depository', subtype })).toBe(true);
      expect(isDepositoryHsa({ type: 'depository', subtype })).toBe(false);
    }
    expect(isDepositoryHsa({ type: 'investment', subtype: 'hsa' })).toBe(false);
    expect(isBankCash({ type: 'investment', subtype: 'hsa' })).toBe(false);
    expect(isBankCash({ type: 'credit', subtype: 'credit card' })).toBe(false);
    // Still not a type that holds securities: holdings aren't asked for.
    expect(isInvestmentType('depository')).toBe(false);
  });
});
