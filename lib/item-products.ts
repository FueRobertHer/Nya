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
//     Transactions only under `additional_consented_products`: Plaid collects
//     the person's consent to it, and its reference says such products "will
//     not be billed until you start using them by calling the relevant
//     endpoints". No Item from this option has Transactions when it is linked.
//     It is off unless PLAID_BROKERAGE_LINK=1 (brokerageLinkEnabled).
//
// WHY A SYNC MUST ASK FIRST. On an Item without the product, /transactions/sync
// is not a harmless empty answer: Plaid's reference says a first call to it
// initializes Transactions on the Item, and initializing a product is what
// Plaid bills (it then stays on the Item, and billed, until the Item is
// removed). That call is the only thing that can start the charge, so
// lib/transactions.ts makes it only when one of these holds:
//   - Plaid already bills Transactions on the Item, so a call costs nothing
//     more: every Item from the bank option, and every Item linked before Nya
//     recorded this, which all came from the bank option when it was the only
//     one;
//   - Nya has synced it before, so the billing has already started;
//   - the Item holds a bank (depository) account or a card, whose transactions
//     Nya reads, so the first call is worth what it starts. Plaid may not offer
//     such accounts on a connection made through the brokerage option at all
//     (Link shows only account types compatible with Investments, except where
//     the bank's own sign-in window lists the accounts), but where one is
//     there, its transactions come in at the same price as any bank's.
// Otherwise the Item simply has no transactions (noTransactionsReason): no
// rows, nothing wrong, and no warning, and the views that count spending say
// that its accounts bring in none (lib/no-transactions.ts).
//
// A first call Plaid refuses (the institution doesn't provide Transactions for
// these accounts, or the person didn't consent to sharing them) is remembered
// for REFUSAL_RECHECK_DAYS in the Item's own transaction state, with the bank
// accounts and cards it was about, so it is not asked again on every load, but
// is at once for an account added since, and after a successful Reconnect
// (lib/transactions.ts forgetRefusal), which for a consent refusal asks for
// that consent again (app/api/create-update-link-token).
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

/** How long a first call Plaid refused stands before it is asked again: an
 *  institution can start offering Transactions. */
export const REFUSAL_RECHECK_DAYS = 30;

/** The two link flows (see the header). */
export const LINK_KINDS = ['bank', 'investments'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export function isLinkKind(v: unknown): v is LinkKind {
  return typeof v === 'string' && (LINK_KINDS as readonly string[]).includes(v);
}

/**
 * Whether the brokerage and retirement option is offered: off unless
 * PLAID_BROKERAGE_LINK=1. Off by default so that a release which reads Items
 * made without Transactions (the check above) runs before any such Item
 * exists: an older release calls /transactions/sync on every Item, and would
 * start Transactions on each of them. Turn it on once this release has been
 * deployed for a while, and never roll back past it after (docs/operations.md).
 */
export function brokerageLinkEnabled(): boolean {
  return process.env.PLAID_BROKERAGE_LINK === '1';
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
 * Which way an Item was linked, as far as its record says: through the bank
 * option (or before there were two), or through the brokerage option, which
 * never initializes Transactions at Link. Undefined when the lookup at link
 * failed. For the duplicate-institution sheet: a connection made the other way
 * may not offer the accounts the person came to add.
 */
export function linkedAs(item: { transactions_billed?: boolean | null }): LinkKind | undefined {
  if (item.transactions_billed === false) return 'investments';
  return item.transactions_billed === null ? undefined : 'bank';
}

/**
 * Whether any of these account types is one whose transactions Nya reads and
 * Plaid's Transactions covers: a depository account (checking, savings, money
 * market, a cash management account, any other) or a card. Plaid's reference
 * also covers "some loan-type accounts (only those with account subtype
 * student or mortgage)", but a loan's balance and terms come from
 * /accounts/get and Liabilities, and its payments show on the account they are
 * paid from, so a loan alone is not worth starting the product for.
 * Investment accounts are outside it altogether: their activity comes from
 * Investments.
 */
export function holdsTransactionAccounts(types: readonly unknown[]): boolean {
  return types.some(isTransactionType);
}

function isTransactionType(type: unknown): boolean {
  return type === 'depository' || type === 'credit';
}

/** The ids of the bank accounts and cards among an Item's accounts, sorted:
 *  the accounts a refusal is about. */
export function transactionAccountIds(accounts: readonly { account_id?: unknown; type?: unknown }[]): string[] {
  const ids = accounts.filter((a) => isTransactionType(a.type) && typeof a.account_id === 'string').map((a) => a.account_id as string);
  return [...new Set(ids)].sort();
}

/**
 * Why an Item has no transactions, said by what is true of it:
 *   investment_accounts  every account it holds is an investment account;
 *   no_cash_accounts     it holds no bank account or card (a loan, say);
 *   refused              it holds one, and Plaid doesn't provide Transactions
 *                        for it, so that account's spending is not known;
 *   no_consent           it holds one, and the person didn't consent to
 *                        sharing its transactions: reconnecting and allowing
 *                        it brings them in.
 * The first two never bring transactions in, whatever the connection's
 * health; the last two leave spending that exists unknown.
 */
export type NoTransactionsReason = 'investment_accounts' | 'no_cash_accounts' | 'refused' | 'no_consent';

/** The reason for an Item that holds no bank account or card. */
export function noTransactionsReason(types: readonly unknown[]): 'investment_accounts' | 'no_cash_accounts' {
  return types.length > 0 && types.every((t) => t === 'investment') ? 'investment_accounts' : 'no_cash_accounts';
}

/** Plaid's answer to a first call when the person never consented to sharing
 *  transactions: update mode asking for that consent resolves it. */
export const CONSENT_REQUIRED = 'ADDITIONAL_CONSENT_REQUIRED';

/** What a remembered refusal says about the Item: no consent, or Plaid not
 *  providing Transactions for its accounts. */
export function refusalReason(refusal: Pick<Refusal, 'code'>): 'refused' | 'no_consent' {
  return refusal.code === CONSENT_REQUIRED ? 'no_consent' : 'refused';
}

/** A first call Plaid refused, as remembered in the Item's transaction state:
 *  when, Plaid's code, and the bank accounts and cards it was about. */
export type Refusal = { at: string; code: string; accounts: string[] };

/**
 * Whether a remembered refusal still stands for an Item whose bank accounts
 * and cards are now `accounts` (transactionAccountIds), so no call is made: it
 * is from the last REFUSAL_RECHECK_DAYS, and about every one of them. A bank
 * account or card added since is asked about at once. One with no usable time
 * never stands.
 */
export function refusalStands(refusal: Refusal | null | undefined, accounts: readonly string[], now: number = Date.now()): boolean {
  if (!refusal || !Array.isArray(refusal.accounts)) return false;
  const covered = new Set(refusal.accounts);
  if (!accounts.every((id) => covered.has(id))) return false;
  const at = Date.parse(refusal.at);
  return Number.isFinite(at) && at <= now && now - at < REFUSAL_RECHECK_DAYS * 24 * 60 * 60 * 1000;
}
