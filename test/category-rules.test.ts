import { describe, expect, test } from 'bun:test';
import { isMoneyMovement, isTransfer, countsInTotals } from '@/lib/spending';
import { detectRecurring, type RecurringRow } from '@/lib/recurring';
import { planFlow } from '@/lib/fire/inputs';
import { groupOf, indexTaxonomy, legacyKind, seedTaxonomy, textKeys, TEXT } from '@/lib/categories';
import type { Txn } from '@/components/MonthBreakdown';

// The rules every total keeps (lib/spending.ts, lib/recurring.ts,
// lib/fire/inputs.ts) once transactions are filed into the person's
// categories: a transfer by the kind of the category's group, the finer rules
// by the category words the row carries, never a name. Seeded, nothing moves.

const filed = (category: string | null, kind: 'expense' | 'income' | 'transfer', name = category) => ({
  transaction_code: null,
  category,
  category_name: name,
  category_kind: kind,
  iso_currency_code: 'USD',
});

describe('a transfer is decided by the kind of the category’s group', () => {
  test('in a transfer group, whatever its words; moved into a spending group, it counts', () => {
    expect(isTransfer(filed('savings moves', 'transfer'))).toBe(true);
    expect(isTransfer(filed('loan payments', 'expense'))).toBe(false);
    expect(isTransfer(filed('transfer out', 'expense'))).toBe(false);
    expect(countsInTotals(filed('loan payments', 'expense'), 'USD')).toBe(true);
    expect(countsInTotals(filed('groceries', 'transfer'), 'USD')).toBe(false);
    // Plaid's transfer and ATM codes are money moved, in any category.
    expect(isTransfer({ ...filed('groceries', 'expense'), transaction_code: 'atm' })).toBe(true);
  });

  test('a loan payment in a transfer group stays a bill for recurring detection; any other transfer is money moved', () => {
    expect(isMoneyMovement(filed('loan payments', 'transfer'))).toBe(false);
    expect(isMoneyMovement(filed('savings moves', 'transfer'))).toBe(true);
    expect(isMoneyMovement(filed('transfer out', 'expense'))).toBe(false);
  });

  test('a row not filed is judged by its words, as before', () => {
    expect(isTransfer({ transaction_code: null, category: 'loan payments' })).toBe(true);
    expect(isTransfer({ transaction_code: null, category: 'transfer in' })).toBe(true);
    expect(isMoneyMovement({ transaction_code: null, category: 'loan payments' })).toBe(false);
    expect(isTransfer({ transaction_code: null, category: 'groceries' })).toBe(false);
  });

  test('seeded, every category counts exactly as its words did, so no total moved when categories arrived', () => {
    const t = seedTaxonomy(textKeys(['transfer', 'transfers to mum', 'transfer: savings', 'income', 'groceries', 'other', 'bank fees']), () => crypto.randomUUID());
    const ix = indexTaxonomy(t);
    for (const c of t.categories) {
      const kind = groupOf(ix, c).kind;
      for (const k of c.provider_keys.filter((k) => k.provider === TEXT)) {
        const before = { transaction_code: null, category: k.key };
        const after = { ...before, category_kind: kind };
        expect([k.key, isTransfer(after), isMoneyMovement(after)]).toEqual([k.key, isTransfer(before), isMoneyMovement(before)]);
        expect(kind).toBe(legacyKind(k.key));
      }
    }
  });
});

describe('the finer rules read the words the row carries, never the name', () => {
  const day = (iso: string, over: Partial<RecurringRow> = {}): RecurringRow => ({
    date: iso,
    name: 'Nopa',
    amount: 64,
    institution_name: 'Chase',
    category: 'food and drink',
    transaction_code: null,
    iso_currency_code: 'USD',
    ...over,
  });

  test('a restaurant visited twice a year apart is no yearly bill, whatever its category is named', () => {
    const renamed = { category_kind: 'expense' as const };
    expect(detectRecurring([day('2025-03-10', renamed), day('2026-03-12', renamed)])).toEqual([]);
    // Words that aren't everyday spending would be one.
    expect(detectRecurring([day('2025-03-10', { category: 'subscriptions' }), day('2026-03-12', { category: 'subscriptions' })]).map((s) => s.cadence)).toEqual(['yearly']);
  });

  test('the Plan: income by the kind of the category, refunds and loan payments by its words', () => {
    const txn = (over: Partial<Txn>): Txn =>
      ({
        transaction_id: 't',
        date: '2026-10-01',
        name: 'x',
        amount: -100,
        pending: false,
        account_name: 'Checking',
        institution_name: 'Bank',
        category: 'food and drink',
        iso_currency_code: 'USD',
        vendor_key: 'v',
        logo_url: null,
        category_icon_url: null,
        subcategory: null,
        category_confidence: null,
        transaction_code: null,
        payment_channel: null,
        datetime: null,
        website: null,
        check_number: null,
        account_owner: null,
        city: null,
        region: null,
        counterparty: null,
        payment_processor: null,
        payment_reference: null,
        ...over,
      }) as Txn;
    // Money back in a spending category is a refund, renamed or not.
    expect(planFlow(txn({ category_name: 'Eating out', category_kind: 'expense' }))).toBe('refund');
    // A category of the person's own in an income group is income.
    expect(planFlow(txn({ category: 'side gig', category_name: 'side gig', category_kind: 'income' }))).toBe('income');
    // Loan payments moved into a spending group still follow the loan rule.
    expect(planFlow(txn({ category: 'loan payments', amount: 1200, subcategory: 'mortgage payment', category_kind: 'expense' }))).toBe('loan');
    expect(planFlow(txn({ category: 'loan payments', amount: 300, subcategory: 'credit card payment', category_kind: 'expense' }))).toBe('card-payment');
  });
});
