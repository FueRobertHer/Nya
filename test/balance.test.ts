import { describe, expect, test } from 'bun:test';
import { isOwedType, signedContribution } from '@/lib/balance';

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
