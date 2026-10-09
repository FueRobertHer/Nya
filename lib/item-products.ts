// lib/item-products.ts
//
// Which Plaid products a linked Item has, where a call Nya makes depends on it.
//
// TWO WAYS IN (app/api/create-link-token). Plaid's Link shows only the
// institutions, and the account types, that support every product in a link
// token's `products`, and `products` may not be empty. So no one token can say
// "Transactions or Investments":
//   - the bank option asks for Transactions, so every Item it makes has it,
//     billed from the day the Item is created;
//   - the brokerage and retirement option asks for Investments, and lists
//     Transactions under `required_if_supported_products`, which Plaid adds,
//     and bills, only when the person shares an account type that supports it
//     at an institution that offers it. A 401(k) or an IRA never does, so most
//     Items from this option have no Transactions at all.
//
// WHY A SYNC MUST ASK FIRST. On an Item without the product, /transactions/sync
// is not a harmless empty answer: Plaid's reference says a first call to it
// initializes Transactions on the Item, and initializing a product is what
// Plaid bills (it then stays on the Item, and billed, until the Item is
// removed). So lib/transactions.ts calls only when one of these holds:
//   - Plaid already bills Transactions on the Item, so a call costs nothing
//     more: every Item from the bank option, and every Item linked before Nya
//     recorded this, which all came from the bank option when it was the only
//     one;
//   - Nya has synced it before, so the billing has already started;
//   - the Item holds an account Transactions describes and Nya reads (a
//     depository account or a card), so the first call is worth what it
//     starts. A brokerage connection that gains a checking account this way
//     gets its transactions, at the same price as any bank.
// Otherwise the Item simply has no transactions: no rows, no note, nothing
// wrong. Recurring bills, insights and budgets see no rows from it.
//
// Whether Plaid bills Transactions is read from /item/get's `billed_products`
// when the Item is linked (app/api/exchange-public-token) and kept on its
// record (StoredItem.transactions_billed in lib/storage.ts). Only that one
// fact, not Plaid's whole list: the record is plain text, and the list could
// say more (that there is a loan at this bank, say) than the sync needs.

/** How many days of transactions to ask Plaid for, both when a link token
 *  initializes Transactions and when a first sync does (Plaid's default is 90).
 *  Two years, so the estimated net-worth backfill can reach back further. */
export const TRANSACTIONS_DAYS_REQUESTED = 730;

/** The two link flows (see the header). */
export const LINK_KINDS = ['bank', 'investments'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export function isLinkKind(v: unknown): v is LinkKind {
  return typeof v === 'string' && (LINK_KINDS as readonly string[]).includes(v);
}

/**
 * Whether an Item (as /item/get answers it) shows Plaid billing Transactions,
 * from its `billed_products`, as it is stored. Null when the answer has no
 * list, which reads as "not known", never as "not billed".
 */
export function transactionsBilledOf(item: unknown): boolean | null {
  if (!item || typeof item !== 'object') return null;
  const billed = (item as { billed_products?: unknown }).billed_products;
  if (!Array.isArray(billed)) return null;
  return billed.includes('transactions');
}

/**
 * Whether Plaid already bills Transactions on the Item, so a sync cannot start
 * a charge. An Item with no record (`transactions_billed` absent) was linked
 * before Nya recorded it, through the only option there was, which required
 * Transactions. One whose lookup failed (null) is not known to be billed.
 */
export function transactionsBilled(item: { transactions_billed?: boolean | null }): boolean {
  return item.transactions_billed === undefined || item.transactions_billed === true;
}

/**
 * Whether any of these account types is one Transactions describes and Nya
 * reads: depository accounts and cards. Plaid's Transactions covers student
 * loans too, but a loan's balance and terms come from /accounts/get and
 * Liabilities, and its payments show on the account they are paid from, so a
 * loan alone is not worth starting the product for. Investment accounts are
 * outside it altogether: their activity comes from Investments.
 */
export function holdsTransactionAccounts(types: readonly unknown[]): boolean {
  return types.some((t) => t === 'depository' || t === 'credit');
}
