// components/restore-state.ts
//
// What the Bring back a download card (components/RestoreCard.tsx) says, as
// pure functions of what the routes answer (app/api/user-restore) and what
// the page read of the file (lib/user-restore/file.ts previewOf): what comes
// back and what doesn't, in words the person knows, never part names; the
// banks that wait, with the day Stop following starts from; how long undo
// is offered. No React, no fetch, so the tests read it directly.

import { plainNumber } from '@/lib/format';
import { ANY_CONNECTOR, CONNECTOR_KINDS, CONNECTOR_WORDS } from '@/lib/connectors/types';
import type { RecordView } from '@/lib/user-restore/store';
import type { WaitingAccount } from '@/lib/user-restore/restored';

/** What GET /api/user-restore answers. */
export type RestoreState = {
  enabled: boolean;
  demo: boolean;
  record: RecordView | null;
  /** The restore's record can't be read: emptying the account is the way
   *  out. */
  record_unreadable: boolean;
  /** The restored accounts whose entry can't be read, each as the Earlier
   *  accounts list names it, and whether the end of one that would wait
   *  can't be: totals hold, and each has a repair of its own. */
  accounts_unreadable: { entries: UnreadableAccount[]; ends: boolean };
  undo_days: number;
  waiting: WaitingAccount[];
  scan?: ScanView;
  /** With the scan: whom this account shares with already, and what. */
  sharing?: SharingNow[];
};

/** A restored account whose entry can't be read, as the Earlier accounts list
 *  (Manage) shows it: its label there (null: listed as "Balance history"),
 *  its days, and whether it is listed (one linked to another isn't, until
 *  the link goes). */
export type UnreadableAccount = { account_id: string; label: string | null; first: string | null; last: string | null; listed: boolean };

/** One person this account shares with already (app/api/user-restore). */
export type SharingNow = { label: string; kinds: string[]; accounts: number };

const KIND_WORDS: Readonly<Record<string, string>> = {
  net_worth: 'your net worth',
  spending: 'your spending',
  holdings: 'your holdings',
  budgets: 'your budgets',
  goals: 'goals you chose',
};

const joined = (list: readonly string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** Whom the account shares with already, each with what, in words: they
 *  see what a restore brings back as it is shared. */
export function sharingLines(sharing: readonly SharingNow[]): string[] {
  return sharing.map((s) => `${s.label}: ${joined([...s.kinds.map((k) => KIND_WORDS[k] ?? k), ...(s.accounts > 0 ? [plural(s.accounts, 'account')] : [])])}`);
}

/** The emptiness scan (lib/user-restore/empty.ts), as the route says it. */
export type ScanView = {
  empty: boolean;
  record: boolean;
  found: string[];
  unseen: boolean;
  settings: string[];
  banks: string[];
  credentials: { plaid: number; connectors: number };
  message: string | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${plainNumber(n)} ${n === 1 ? one : many}`;

/** Each part's words, by how many records it has, in the order said. Parts
 *  not named here are said under "and the rest", counted. */
const BROUGHT: readonly (readonly [part: string, words: (n: number) => string])[] = [
  ['store:categories', () => 'your categories and their groups'],
  ['store:tags', () => 'your tags'],
  ['store:rules', () => 'your rules'],
  ['manual-accounts', (n) => plural(n, 'manual account')],
  ['restored-accounts', (n) => `${plural(n, 'account')} of banks connected through Plaid, kept as earlier accounts until you connect each bank again`],
  ['store:connector-connections', (n) => `${plural(n, 'connection')} to ${ANY_CONNECTOR}, to connect again with ${CONNECTOR_KINDS.map((k) => CONNECTOR_WORDS[k].again).join(' or ')}`],
  ['restored-rows', (n) => `${plural(n, 'bank transaction')}, counted once their accounts are linked again`],
  ['store:manual-transactions', (n) => `the transactions of ${plural(n, 'manual account')}`],
  ['store:imported-transactions', (n) => `transactions imported into ${plural(n, 'account')} from files`],
  ['store:imports', (n) => plural(n, 'import into a manual account', 'imports into manual accounts')],
  ['store:history-imports', (n) => plural(n, 'import of older transactions', 'imports of older transactions')],
  ['store:app-imports', (n) => plural(n, 'import from another app', 'imports from other apps')],
  ['overrides', (n) => `${plural(n, 'category', 'categories')} you chose for transactions`],
  ['renames', (n) => plural(n, 'merchant name')],
  ['store:transaction-annotations', (n) => `notes, tags and exclusions on ${plural(n, 'transaction')}`],
  ['store:transaction-splits', (n) => plural(n, 'split')],
  ['store:transaction-groups', (n) => plural(n, 'group of transactions', 'groups of transactions')],
  ['store:transaction-approvals', (n) => plural(n, 'approval')],
  ['links', (n) => plural(n, 'link between an earlier account and a new one', 'links between earlier accounts and new ones')],
  ['budgets', () => 'your budgets'],
  ['store:budget-months', () => 'your budgets by month, with their rollover'],
  ['goals', () => 'your goals'],
  ['store:goal-plans', (n) => `the plans of ${plural(n, 'goal')}`],
  ['store:planned-items', () => 'your planned bills and income'],
  ['store:holdings:history', (n) => `${plural(n, 'month')} of holdings history`],
  ['store:timeline-notes', (n) => plural(n, 'note on the timeline', 'notes on the timeline')],
  ['store:account-lifecycle', (n) => plural(n, 'account you marked closed or stopped following', 'accounts you marked closed or stopped following')],
];

/** Settings the file replaces, said together. */
const SETTINGS = new Set([
  'store:report-settings',
  'store:review-settings',
  'store:weekly-summary',
  'store:allocation-settings',
  'store:fire-plan',
  'store:income-carryover',
  'store:vendor-defaults',
  'store:import-settings',
]);

/** Kept as the file has them, with nothing to say on their own. */
const QUIET = new Set(['directory', 'hidden', 'declined', 'carried-categories', 'store:carried-annotations', 'store:carried-imported-twins', 'store:imported-twins', 'store:connector-accounts', 'store:connector-ended', 'store:restored-transactions', 'store:restored-accounts', 'store:restored-investment-transactions', 'investment_transactions']);

/** What comes back, in words (see BROUGHT), the balance history by its days. */
export function broughtLines(brought: Readonly<Record<string, number>>, history: { first: string; last: string } | null): string[] {
  const out: string[] = [];
  const said = new Set<string>();
  for (const [part, words] of BROUGHT) {
    const n = brought[part];
    if (!n) continue;
    out.push(words(n));
    said.add(part);
  }
  if (history) out.push(`your balance history, ${history.first} to ${history.last}, recorded and estimated days each where they were`);
  if (Object.keys(brought).some((p) => SETTINGS.has(p))) out.push('your settings');
  const invested = brought['investment_transactions'] ?? 0;
  if (invested > 0) out.push(`${plural(invested, 'investment transaction')}, kept for your next download (not shown yet)`);
  const rest = Object.entries(brought).filter(([p, n]) => n > 0 && !said.has(p) && !SETTINGS.has(p) && !QUIET.has(p) && !p.startsWith('history:'));
  if (rest.length > 0) out.push(`and ${plural(rest.reduce((a, [, n]) => a + n, 0), 'more record')} of what you made`);
  return out;
}

/** What doesn't come back, in words: pending transactions and what was said
 *  only about them, and what never comes back. `never` counts the file's
 *  API tokens and sharing connections. */
export function leftOutLines(left: Readonly<Record<string, number>>, never: { api_tokens: number; sharing: number }): string[] {
  const out: string[] = [];
  const pending = left['pending_transactions'] ?? 0;
  if (pending > 0) out.push(`${plural(pending, 'pending transaction')}: the bank sends ${pending === 1 ? 'it' : 'them'} again once posted`);
  const about = Object.entries(left).filter(([k]) => k.endsWith(':pending')).reduce((a, [, n]) => a + n, 0);
  if (about > 0) out.push(`what you said only about pending transactions (${plainNumber(about)})`);
  out.push('the sign-ins Nya used to reach your banks: connect each bank again');
  if (never.api_tokens > 0) out.push(`${plural(never.api_tokens, 'API token')}: make new ones if you need them`);
  if (never.sharing > 0) out.push(`${plural(never.sharing, 'sharing connection')}: sharing is between two people, so share again from here`);
  return out;
}

/** What can't be read of a restore here, in words, each with whether
 *  emptying the account is the way out (only for the record itself, and only
 *  while this copy offers restores: a restored account's entry or end has a
 *  repair of its own). Each account to forget is named as the Earlier
 *  accounts list names it, its days written by `day`, since forgetting is
 *  for good. */
export function unreadableNotes(
  state: Pick<RestoreState, 'enabled' | 'record_unreadable' | 'accounts_unreadable'>,
  day: (iso: string) => string = (iso) => iso
): { words: string; empty: boolean }[] {
  const out: { words: string; empty: boolean }[] = [];
  if (state.record_unreadable) {
    const record = 'Nya can’t read the record of a restore here, so it can’t tell whether one finished. No net worth total is recorded meanwhile.';
    out.push(
      state.enabled
        ? { words: `${record} Empty this account (below) to start again, or ask whoever runs this copy of Nya.`, empty: true }
        : { words: `${record} Bringing back a download, and emptying an account, are turned off on this copy of Nya: ask whoever runs it.`, empty: false }
    );
  }
  if (state.accounts_unreadable.ends) {
    out.push({
      words:
        'How one of the accounts a restore brought back ended can’t be read, so no net worth total is recorded until it can be. Remove the damaged closure on the Accounts tab, then mark that account again if it ended.',
      empty: false,
    });
  }
  for (const a of state.accounts_unreadable.entries) {
    const name = a.label ?? 'Balance history';
    const days = a.first || a.last ? ` (${a.first ? day(a.first) : 'unknown'} to ${a.last ? day(a.last) : 'unknown'})` : '';
    const what = `What Nya keeps about ${a.label ?? 'an account'}, which a restore brought back, can’t be read, so no net worth total is recorded until it can be.`;
    out.push({
      words: a.listed
        ? `${what} Forget it under Earlier accounts (Manage), where it is listed as ${name}${days}, or ask whoever runs this copy of Nya.`
        : `${what} It is linked to another account, so it can be forgotten only once that link is removed (Manage, Reconnected accounts); or ask whoever runs this copy of Nya.`,
      empty: false,
    });
  }
  return out;
}

/** The day after `day` (YYYY-MM-DD), UTC. */
export function dayAfter(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The banks whose restored accounts wait (see WaitingAccount), each with its
 *  accounts, its last restored day, and the day Stop following starts from
 *  unless the person chooses another: the day after that last day. */
export function waitingBanks(waiting: readonly WaitingAccount[]): { institution_name: string; accounts: WaitingAccount[]; last: string | null; from: string | null }[] {
  const banks = new Map<string, WaitingAccount[]>();
  for (const a of waiting) banks.set(a.institution_name, [...(banks.get(a.institution_name) ?? []), a]);
  return [...banks].map(([institution_name, accounts]) => {
    const last = accounts.reduce<string | null>((m, a) => (a.last !== null && (m === null || a.last > m) ? a.last : m), null);
    return { institution_name, accounts, last, from: last ? dayAfter(last) : null };
  });
}

/** An account's name as the card says it: "Checking ••1111". */
export const accountWords = (a: { name: string | null; mask: string | null }) => `${a.name ?? 'Account'}${a.mask ? ` ••${a.mask}` : ''}`;

/** Whether the restore can still be undone at `now` (lib/user-restore/
 *  undo.ts undoable): while unfinished, and until undo_until. */
export function canUndo(record: RecordView, now: number): boolean {
  if (record.status !== 'finished') return true;
  return record.undo_until !== null && now <= Date.parse(record.undo_until);
}

/** The first bytes of a protected download (lib/age/age.ts INTRO). */
export const PROTECTED_INTRO = 'age-encryption.org/';
export function looksProtected(head: Uint8Array): boolean {
  return new TextDecoder().decode(head.slice(0, PROTECTED_INTRO.length)) === PROTECTED_INTRO;
}
