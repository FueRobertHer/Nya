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
import type { RestoredRows } from '@/lib/user-restore/forget';
import { idEnds, type Unlisted } from '@/lib/earlier-names';

/** What GET /api/user-restore answers. */
export type RestoreState = {
  enabled: boolean;
  demo: boolean;
  record: RecordView | null;
  /** The restore's record can't be read: emptying the account is the way
   *  out. */
  record_unreadable: boolean;
  /** The restored accounts whose entry can't be read: damaged ones, each as
   *  the Earlier accounts list names it or said why it isn't listed
   *  (`entries`); those in a form this version doesn't know, a newer
   *  version's or a fault, which nothing here offers to remove
   *  (`unrecognised`, lib/repo.ts); `unnamed`: what names them couldn't be
   *  read just now; `broken_links`: a saved link can't be read, which holds
   *  back every forget. And whether the end of one that would wait can't be
   *  read. Totals hold, and each has a way out of its own. */
  accounts_unreadable: { entries: UnreadableAccount[]; unrecognised: UnrecognisedAccount[]; ends: boolean; unnamed: boolean; broken_links: boolean };
  undo_days: number;
  waiting: WaitingAccount[];
  scan?: ScanView;
  /** With the scan: whom this account shares with already, and what. */
  sharing?: SharingNow[];
  /** With the scan: the API tokens made here, which stay (TokensNow). */
  tokens?: TokensNow | null;
};

/** A restored account whose entry can't be read (app/api/user-restore): what
 *  the directory calls it ("Chase Checking ••1111"; null: nothing it can
 *  read); where the Earlier accounts list (Manage) lists it, by the name it
 *  shows there (lib/earlier-names.ts) and its days, and whether some of the
 *  rows a restore brought back for it are in a form this version doesn't
 *  know (`unrecognised`: then that list offers no Forget for it, as
 *  lib/user-restore/forget.ts restoredForgetRefusal refuses it); or, for one
 *  it doesn't, why not (lib/earlier-names.ts Unlisted), the accounts a link
 *  joins it to by what the directory calls them, whether it would be listed
 *  once that is undone, and, for one with nothing to list it by, which this
 *  card forgets, what that takes of the rows a restore brought back for it
 *  (`rows`; null otherwise). Both null: not named (`unnamed`). */
export type UnreadableAccount = {
  account_id: string;
  label: string | null;
  listed: { name: string; first: string | null; last: string | null; unrecognised?: boolean } | null;
  unlisted: { why: Unlisted; others: (string | null)[]; listable: boolean; rows: RestoredRows | null } | null;
};

/** A restored account whose entry is in a form this version doesn't know
 *  (app/api/user-restore), by what the directory calls it (null: nothing it
 *  can read). */
export type UnrecognisedAccount = { account_id: string; label: string | null };

/** A note on what can't be read (unreadableNotes): its words; whether
 *  emptying the account is the way out; and the account the card offers to
 *  forget, with what to ask before it does. */
export type UnreadableNote = { key: string; words: string; empty: boolean; remove?: { account_id: string; confirm: string } };

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
  ['store:currency-settings', () => 'your home currency and your own exchange rates'],
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
  const changes = left['api_changes'] ?? 0;
  if (changes > 0) out.push(`${plural(changes, 'change')} made with API tokens in your other copy: about that copy, whose tokens don’t come back`);
  return out;
}

/** "Mar 13, 2024": a calendar day, as the card says one (a day is no
 *  instant: read in UTC, so it is the same day everywhere). */
export const calendarDay = (d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

/** The accounts the file says ended, which count here as they did there
 *  (lib/user-restore/file.ts Preview `counted`), in words. */
export function countedLines(counted: readonly { institution_name: string; name: string | null; mask: string | null; day: string }[]): string[] {
  return counted.map((a) => `${a.institution_name} ${accountWords(a)} ended in your other copy on ${calendarDay(a.day)}: its transactions up to then count here too, as they did there`);
}

/** The API tokens made here (app/api/user-restore, with the scan): they
 *  stay through a restore, and read what it brings back. */
export type TokensNow = { kept: number; writing: number };

/** What the API tokens made here do with what comes back, in words; null
 *  when there are none. */
export function tokensLine(tokens: TokensNow | null | undefined): string | null {
  if (!tokens || tokens.kept === 0) return null;
  const one = tokens.kept === 1;
  const change = tokens.writing === 0 ? '' : tokens.writing === tokens.kept ? ', and can change it' : `, and ${plainNumber(tokens.writing)} of them can change it`;
  return `${plural(tokens.kept, 'API token')} made here ${one ? 'stays' : 'stay'}: ${one ? 'it reads' : 'they read'} what comes back${change}.`;
}

const ASK = 'or ask whoever runs this copy of Nya.';
/** Why an account whose rows a restore brought back are in a form this
 *  version doesn't know can't be forgotten, here or anywhere (lib/repo.ts:
 *  only damaged entries may be offered for removal). */
const ROWS_UNKNOWN =
  'some of the transactions a restore brought back for it are in a form this version of Nya doesn’t know: a newer version wrote them, or it is a fault. They are kept as they are, so it can’t be forgotten here: ask whoever runs this copy of Nya.';

/** How a restored account whose entry can't be read is forgotten, when the
 *  Earlier accounts list doesn't show it: why it doesn't, and what works
 *  (see UnreadableAccount). `remove`: this card does it. */
function unlistedWay(u: NonNullable<UnreadableAccount['unlisted']>): { words: string; remove: boolean } {
  const then = u.listable ? 'then forget it under Earlier accounts' : 'then forget it here';
  const left = (why: string, way: string) => `It isn’t listed under Earlier accounts (Manage), since ${why}. To forget it, ${way}, ${then}; ${ASK}`;
  switch (u.why) {
    case 'unknown':
      return u.rows?.unrecognised
        ? {
            words: `Nya has no name it can read for it and no balance history, so it isn’t listed under Earlier accounts (Manage), and ${ROWS_UNKNOWN}`,
            remove: false,
          }
        : { words: `Nya has no name it can read for it and no balance history, so it isn’t listed under Earlier accounts (Manage). Forget it here for good, ${ASK}`, remove: true };
    case 'live':
      return { words: left('it is one of your connected accounts', 'disconnect its bank (Accounts tab)'), remove: false };
    case 'connected':
      return { words: left('its bank is still connected', 'disconnect that bank (Accounts tab)'), remove: false };
    case 'link-unreadable':
      return { words: left('a link saved for it can’t be read', 'remove that link (Manage, Reconnected accounts, Unreadable)'), remove: false };
    case 'linked':
      return { words: left(`it is linked to ${u.others[0] ?? 'another account'}, whose history it is part of`, 'unlink it (Manage, Reconnected accounts, Linked)'), remove: false };
    case 'linked-to': {
      const known = u.others.filter((o): o is string => o !== null);
      const rest = u.others.length - known.length;
      const from = [...known, ...(rest === 0 ? [] : [rest === 1 ? (known.length > 0 ? 'another earlier account' : 'an earlier account') : `${plainNumber(rest)} ${known.length > 0 ? 'other ' : ''}earlier accounts`])];
      const many = u.others.length > 1;
      return { words: left(`${joined(from)} ${many ? 'are' : 'is'} linked to it`, `unlink ${many ? 'them' : 'that one'} (Manage, Reconnected accounts, Linked)`), remove: false };
    }
    case 'manual':
      return { words: `It has a manual account’s id, so it can’t be forgotten as an earlier account: ask whoever runs this copy of Nya.`, remove: false };
  }
}

/** What can't be read of a restore here, in words, each with whether
 *  emptying the account is the way out (only for the record itself, and only
 *  while this copy offers restores: a restored account's entry or end has a
 *  repair of its own). Each account to forget is named as the Earlier
 *  accounts list names it, its days written by `day`, since forgetting is
 *  for good; one the list doesn't show is said why, with what works. Two
 *  notes that would read the same are told apart by the end of each
 *  account's id. */
export function unreadableNotes(
  state: Pick<RestoreState, 'enabled' | 'record_unreadable' | 'accounts_unreadable'>,
  day: (iso: string) => string = (iso) => iso
): UnreadableNote[] {
  const out: UnreadableNote[] = [];
  if (state.record_unreadable) {
    const record = 'Nya can’t read the record of a restore here, so it can’t tell whether one finished. No net worth total is recorded meanwhile.';
    out.push(
      state.enabled
        ? { key: 'record', words: `${record} Empty this account (below) to start again, ${ASK}`, empty: true }
        : { key: 'record', words: `${record} Bringing back a download, and emptying an account, are turned off on this copy of Nya: ask whoever runs it.`, empty: false }
    );
  }
  if (state.accounts_unreadable.ends) {
    out.push({
      key: 'ends',
      words:
        'How one of the accounts a restore brought back ended can’t be read, so no net worth total is recorded until it can be. Remove the damaged closure on the Accounts tab, then mark that account again if it ended.',
      empty: false,
    });
  }
  const { entries, unrecognised, unnamed } = state.accounts_unreadable;
  if (entries.length > 0 && unnamed) {
    const one = entries.length === 1;
    out.push({
      key: 'unnamed',
      words: `What Nya keeps about ${one ? 'an account' : plural(entries.length, 'account')} a restore brought back can’t be read, so no net worth total is recorded until it can be. ${
        one ? 'Its name' : 'Their names'
      } couldn’t be read just now either, so this card can’t say how to forget ${one ? 'it' : 'them'}: try again later, ${ASK}`,
      empty: false,
    });
  } else if (state.accounts_unreadable.broken_links && entries.some((a) => a.unlisted?.why !== 'link-unreadable')) {
    out.push({
      key: 'broken-links',
      words: 'A saved link can’t be read, so no account can be forgotten until it is removed: remove it first (Manage, Reconnected accounts, Unreadable).',
      empty: false,
    });
  }
  /** What forgetting one from here takes, for its confirm (see
   *  UnreadableAccount `rows`). */
  const takes = (rows: RestoredRows | null): string => {
    const days = rows?.first && rows.last ? ` (${rows.first === rows.last ? day(rows.first) : `${day(rows.first)} to ${day(rows.last)}`})` : '';
    if (!rows) return 'What a restore brought back for it, and what you said about its transactions, are deleted';
    const these = rows.count === 1 ? 'The transaction' : `The ${plural(rows.count, 'transaction')}`;
    if (rows.count > 0 && rows.unreadable) return `${these} a restore brought back for it that can be read${days}, those that can’t be, and what you said about them, are deleted`;
    if (rows.count > 0) return `${these} a restore brought back for it${days}, and what you said about ${rows.count === 1 ? 'it' : 'them'}, are deleted`;
    if (rows.unreadable) return 'The transactions a restore brought back for it, which can’t be read, are deleted';
    return 'A restore brought back no transactions for it, and what Nya keeps about it is deleted';
  };
  /** Each account, damaged (`entries`, unless unnamed) or in a form this
   *  version doesn't know (`unrecognised`); `end`: the end of its id, to tell
   *  it from another that would read the same. */
  type One = { kind: 'damaged'; a: UnreadableAccount } | { kind: 'unknown'; a: UnrecognisedAccount };
  const noteOf = (one: One, end?: string): UnreadableNote => {
    const a = one.a;
    const told = end ? ` (…${end})` : '';
    const subject = `${a.label ?? 'an account'}${told}`;
    const key = `account:${a.account_id}`;
    if (one.kind === 'unknown') {
      return {
        key,
        words: `What Nya keeps about ${subject}, which a restore brought back, is in a form this version of Nya doesn’t know: a newer version wrote it, or it is a fault. It is kept as it is, and no net worth total is recorded meanwhile: ask whoever runs this copy of Nya.`,
        empty: false,
      };
    }
    const what = `What Nya keeps about ${subject}, which a restore brought back, can’t be read, so no net worth total is recorded until it can be.`;
    if (one.a.listed) {
      const { name, first, last, unrecognised } = one.a.listed;
      const days = first || last ? ` (${first ? day(first) : 'unknown'} to ${last ? day(last) : 'unknown'})` : '';
      // The list offers no Forget for it then (app/api/account-links).
      if (unrecognised) return { key, words: `${what} It is listed under Earlier accounts (Manage) as ${name}${days}, but ${ROWS_UNKNOWN}`, empty: false };
      return { key, words: `${what} Forget it under Earlier accounts (Manage), where it is listed as ${name}${days}, ${ASK}`, empty: false };
    }
    if (!one.a.unlisted) return { key, words: `${what} Ask whoever runs this copy of Nya.`, empty: false };
    const way = unlistedWay(one.a.unlisted);
    const confirm = `Forget ${a.label ?? 'this account'}${told} for good? ${takes(one.a.unlisted.rows)}, and this can’t be undone. To keep a copy, cancel and choose Download my data first.`;
    return { key, words: `${what} ${way.words}`, empty: false, ...(way.remove ? { remove: { account_id: a.account_id, confirm } } : {}) };
  };
  const accounts: One[] = [...(unnamed ? [] : entries.map((a): One => ({ kind: 'damaged', a }))), ...unrecognised.map((a): One => ({ kind: 'unknown', a }))];
  const drafts = accounts.map((one) => noteOf(one));
  const alike = new Map<string, string[]>();
  accounts.forEach((one, i) => alike.set(drafts[i].words, [...(alike.get(drafts[i].words) ?? []), one.a.account_id]));
  const ends = new Map<string, string>();
  for (const ids of alike.values()) if (ids.length > 1) for (const [id, end] of idEnds(ids)) ends.set(id, end);
  out.push(...accounts.map((one, i) => (ends.has(one.a.account_id) ? noteOf(one, ends.get(one.a.account_id)) : drafts[i])));
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
