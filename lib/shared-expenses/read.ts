// lib/shared-expenses/read.ts
//
// Reading shared expenses (#49), two ways, each labelled:
//
//   - FOR THE READ LAYER (layerInputs, lib/activity.ts finishActivity): a
//     display read. What can't be read leaves its row as the bank shows it,
//     with a note (lib/shared-expenses/rows.ts), never a stop, and nothing
//     writes on it. The setting that can't be read counts as `bank`; the rows
//     said to be no repayment are read leniently, for a note alone.
//   - FOR THE CARD (readCard, app/api/shared-expenses and the read-only API):
//     strict. Balances are figures only when every entry of every store
//     read: an entry that can't be read could be anyone's, so a balance short
//     of it is never shown. What can't be read is named, by store, so the
//     person can remove what is damaged (once they confirm) and nothing else.

import type { Ctx } from '../containers';
import { effectiveLinks, getLinks, resolveId } from '../link-core';
import { liveAccountIds } from '../links';
import { balancesOf, itemState, itemsOf, paidOf, type Balance, type ItemState } from './balances';
import { DEFAULT_COUNTING, type Counting, type Dismissed, type ExpenseSettings, type Iou, type Payment, type Person, type Share } from './model';
import type { ShareInputs } from './rows';
import { expenseDismissedStore, expenseIousStore, expensePaymentsStore, expensePeopleStore, expenseSettingsStore, expenseSharesStore } from './store';

/** What the read layer applies shares with (lib/shared-expenses/rows.ts
 *  ShareInputs, but for what the reader adds: the categories, the day it
 *  reads from, hidden accounts, the rows imported from files). A display
 *  read (see the header). */
export async function layerInputs(ctx: Ctx): Promise<Pick<ShareInputs, 'counting' | 'settingsUnread' | 'shares' | 'sharesUnknown' | 'payments' | 'paymentsUnknown' | 'ious' | 'iousUnread' | 'dismissed' | 'accounts' | 'accountsUnread'>> {
  const [settings, shares, payments, ious, dismissed] = await Promise.all([
    expenseSettingsStore.getReport(ctx),
    expenseSharesStore.getAllReport(ctx),
    expensePaymentsStore.getAllReport(ctx),
    expenseIousStore.getAllReport(ctx),
    // Lenient: only to leave a row said to be no repayment out of a note;
    // nothing writes, deletes or records on it.
    expenseDismissedStore.getAllLenient(ctx),
  ]);
  // Which accounts are live, and the links between earlier ones and them,
  // only when something is shared or paid: what a share is carried across a
  // re-link by, and what says one is gone or waits on a link. Unread,
  // nothing is carried, the rows alone say what is gone, and a note says so.
  const accounts = shares.entries.size > 0 || payments.entries.size > 0 ? await accountsFor(ctx) : null;
  const settingsUnread = settings.unreadable || settings.unrecognised;
  return {
    counting: settings.value?.counting ?? DEFAULT_COUNTING,
    settingsUnread,
    shares: shares.entries,
    sharesUnknown: new Set([...shares.unreadable, ...shares.unrecognised]),
    payments: payments.entries,
    paymentsUnknown: new Set([...payments.unreadable, ...payments.unrecognised]),
    ious: ious.entries,
    iousUnread: ious.unreadable.length + ious.unrecognised.length,
    dismissed: new Set(dismissed.keys()),
    ...(accounts === 'unread' ? { accountsUnread: true } : accounts ? { accounts } : {}),
  };
}

/** The live bank accounts and how each id resolves through the active links
 *  (lib/link-core.ts), or 'unread' when they couldn't be read (logged). */
async function accountsFor(ctx: Ctx): Promise<NonNullable<ShareInputs['accounts']> | 'unread'> {
  try {
    return await sharedAccounts(ctx);
  } catch (err) {
    console.error('shared expenses: account links could not be read', err instanceof Error ? err.name : 'error');
    return 'unread';
  }
}

/** The same, read strictly: what an edit checks a carry by
 *  (lib/shared-expenses/edits.ts), which fails rather than take the links
 *  for none. */
export async function sharedAccounts(ctx: Ctx): Promise<NonNullable<ShareInputs['accounts']>> {
  const [links, live] = await Promise.all([getLinks(ctx), liveAccountIds(ctx, { strict: true, readOnly: true })]);
  const applied = effectiveLinks(links, live);
  return { live, resolve: (id: string) => resolveId(id, applied) };
}

/** What can't be read in one store: ids that may be removed once the person
 *  confirms (unreadable), and those that never may (unrecognised). */
export type Unread = { unreadable: string[]; unrecognised: string[] };

export type Card = {
  settings: ExpenseSettings | null;
  /** The setting can't be read (then totals count as `bank`). */
  settings_unread: boolean;
  people: Map<string, Person>;
  shares: Map<string, Share>;
  ious: Map<string, Iou>;
  payments: Map<string, Payment>;
  dismissed: Map<string, Dismissed>;
  /** By store name, what couldn't be read; empty when everything did. */
  unread: Record<string, Unread>;
  /** Every item, with what is open of it. */
  items: ItemState[];
  /** Each person's balances, or null while anything couldn't be read. */
  balances: Map<string, Balance[]> | null;
  counting: Counting;
};

/** Everything, strictly (see the header). */
export async function readCard(ctx: Ctx): Promise<Card> {
  const [settings, people, shares, ious, payments, dismissed] = await Promise.all([
    expenseSettingsStore.getReport(ctx),
    expensePeopleStore.getAllReport(ctx),
    expenseSharesStore.getAllReport(ctx),
    expenseIousStore.getAllReport(ctx),
    expensePaymentsStore.getAllReport(ctx),
    expenseDismissedStore.getAllReport(ctx),
  ]);
  const unread: Record<string, Unread> = {};
  const note = (name: string, r: { unreadable: string[]; unrecognised: string[] }) => {
    if (r.unreadable.length + r.unrecognised.length > 0) unread[name] = { unreadable: r.unreadable, unrecognised: r.unrecognised };
  };
  note(expensePeopleStore.name, people);
  note(expenseSharesStore.name, shares);
  note(expenseIousStore.name, ious);
  note(expensePaymentsStore.name, payments);
  note(expenseDismissedStore.name, dismissed);
  const items = itemsOf(shares.entries, ious.entries);
  const paid = paidOf(payments.entries, items);
  // A balance needs every share, IOU and payment: one that can't be read
  // could be anyone's (the people and the dismissed rows change no balance).
  const whole = ![expenseSharesStore.name, expenseIousStore.name, expensePaymentsStore.name].some((n) => unread[n]);
  const settingsUnread = settings.unreadable || settings.unrecognised;
  return {
    settings: settings.value,
    settings_unread: settingsUnread,
    people: people.entries,
    shares: shares.entries,
    ious: ious.entries,
    payments: payments.entries,
    dismissed: dismissed.entries,
    unread,
    items: [...items.values()].map((i) => itemState(i, paid)),
    balances: whole ? balancesOf(items, payments.entries) : null,
    counting: settingsUnread ? 'bank' : (settings.value?.counting ?? DEFAULT_COUNTING),
  };
}

/** The card as the app's route answers it: plain lists, in a fixed order
 *  (people by name, items by day), ids only where a list names another. */
export function cardAnswer(card: Card) {
  const byName = (a: [string, Person], b: [string, Person]) => (a[1].name ?? '￿').localeCompare(b[1].name ?? '￿') || (a[0] < b[0] ? -1 : 1);
  return {
    counting: card.counting,
    settings_unread: card.settings_unread,
    own: { venmo: card.settings?.own_venmo ?? null, cashtag: card.settings?.own_cashtag ?? null },
    people: [...card.people].sort(byName).map(([id, p]) => ({
      id,
      name: p.name ?? null,
      venmo: p.venmo ?? null,
      cashtag: p.cashtag ?? null,
      app: p.app ?? null,
      tag: p.tag ?? null,
      requests: p.requests ?? [],
      archived: !!p.archived_at,
      removed: !!p.removed_at,
    })),
    items: [...card.items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1)),
    shares: [...card.shares].map(([transaction_id, s]) => ({
      transaction_id,
      part: s.part ?? null,
      account_id: s.account_id,
      amount_was: s.amount_was,
      currency: s.currency,
      date: s.date,
      what: s.what,
      entries: s.entries.map((e) => ({ id: e.id, person: e.person, amount: e.amount, how: e.how ?? null })),
      kept_gone: s.kept_gone ?? null,
      updated_at: s.updated_at,
    })),
    payments: [...card.payments].map(([transaction_id, p]) => ({ transaction_id, ...p, note: p.note ?? null, kept_gone: p.kept_gone ?? null })),
    dismissed: [...card.dismissed].map(([transaction_id, d]) => ({ transaction_id, date: d.date })),
    balances: card.balances ? Object.fromEntries(card.balances) : null,
    unread: card.unread,
  };
}

export type CardAnswer = ReturnType<typeof cardAnswer>;
