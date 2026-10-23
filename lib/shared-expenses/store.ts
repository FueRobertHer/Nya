// lib/shared-expenses/store.ts
//
// Where shared expenses (#49) are kept: six stores on the storage seam
// (lib/repo.ts), each encrypted, each in the person's own data download, each
// with the closed shape lib/shared-expenses/model.ts checks.
//
//   expense-settings   one value: whether shared expenses change totals.
//   expense-people     one entry per person, under a random id.
//   expense-shares     one entry per shared transaction, under its id (a
//                      bank's, a manual, imported or SimpleFIN row's), as
//                      transaction-splits is keyed: a transaction is shared
//                      once, and two devices sharing it at once meet in one
//                      compare-and-set.
//   expense-ious       one entry per IOU, under a random id.
//   expense-payments   one entry per transaction the person confirmed paid
//                      something back, under its id, so a row pays once.
//   expense-dismissed  one entry per transaction the person said is no
//                      repayment, under its id, so it is never proposed again.
//
// Ids are a transaction's own (opaque: they say which transactions were
// shared or paid something back, never with whom or how much) or random;
// nothing inside a value is a transaction's id, so a restore re-keys field
// names only (lib/user-restore/plan.ts TXN_KEYED).
//
// READS ARE STRICT, as the seam's are. The read layer reads them as display
// reads (lib/shared-expenses/read.ts): what can't be read leaves its row as
// the bank shows it, with a note. The card's read and every write read them
// strictly (getAllReport, update), so a balance is a figure only when every
// entry read, and nothing is ever written over what couldn't be.

import { defineMapStore, defineValueStore } from '../repo';
import { isDismissed, isExpenseSettings, isIou, isPayment, isPerson, isShare, type Dismissed, type ExpenseSettings, type Iou, type Payment, type Person, type Share } from './model';

export const expenseSettingsStore = defineValueStore<ExpenseSettings>('expense-settings', {
  what: 'shared expense settings',
  isValid: isExpenseSettings,
  exportable: true, // what the person chose
});

export const expensePeopleStore = defineMapStore<Person>('expense-people', {
  what: 'people you split costs with',
  isValid: isPerson,
  exportable: true, // the names the person typed
});

export const expenseSharesStore = defineMapStore<Share>('expense-shares', {
  what: 'shared transactions',
  isValid: isShare,
  exportable: true, // who owes what of the person's transactions
});

export const expenseIousStore = defineMapStore<Iou>('expense-ious', {
  what: 'IOUs',
  isValid: isIou,
  exportable: true, // what the person typed
});

export const expensePaymentsStore = defineMapStore<Payment>('expense-payments', {
  what: 'payments you confirmed',
  isValid: isPayment,
  exportable: true, // what the person confirmed
});

export const expenseDismissedStore = defineMapStore<Dismissed>('expense-dismissed', {
  what: 'payments you said paid nothing back',
  isValid: isDismissed,
  exportable: true, // what the person said
});
