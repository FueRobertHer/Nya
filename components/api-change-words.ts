// components/api-change-words.ts
//
// A change made with an API token (lib/api-changes.ts), in a sentence for the
// list under the API tokens card (components/ApiChanges.tsx): what it made,
// changed or deleted, by the names and amounts it stored, before and after.
// Amounts go through lib/format.ts when the sentence is written, so the
// sentence is written as it is drawn, and drawn inside <Masked>.
//
// What a change stored is read leniently: it is the stored record of another
// store, which a later release may add fields to, and one forgotten, pending
// or failed has none. A sentence never fails: what it can't read, it leaves
// out, and says what kind of change it was.

import { formatMoney, signedMoney } from '@/lib/format';

/** A change as app/api/api-changes lists it. */
export type ListedChange = {
  id: string;
  at: string;
  via: 'api' | 'mcp' | 'app';
  token: { id: string; hint: string; label: string } | null;
  op: string;
  target: { kind: string; id: string; account_id?: string };
  state: 'pending' | 'done' | 'failed';
  before?: unknown;
  after?: unknown;
  undoes?: string;
  undone_by?: string;
  error?: string;
  forgotten_at?: string;
};

/** The manual accounts there are now, for a balance's name and currency. */
export type AccountNames = Record<string, { name: string; currency: string | null }>;

const OP_WORDS: Record<string, string> = {
  'manual-account.create': 'Added a manual account',
  'manual-account.update': 'Changed a manual account',
  'manual-account.balance': 'Set a manual account’s balance',
  'transaction.create': 'Added a transaction',
  'transaction.update': 'Changed a transaction',
  'transaction.delete': 'Deleted a transaction',
  'category.create': 'Added a category',
  'category.update': 'Changed a category',
  'group.create': 'Added a category group',
  'group.update': 'Changed a category group',
  'tag.create': 'Added a tag',
  'tag.update': 'Changed a tag',
  undo: 'Undid a change',
};

/** What kind of change it was, alone. */
export const opWords = (op: string) => OP_WORDS[op] ?? 'Made a change';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const at = (r: Rec | null, ...path: string[]): unknown => path.reduce<unknown>((v, k) => rec(v)?.[k], r);
const cur = (v: unknown): string | null => (typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : null);

/** A day as the viewer reads it: "Oct 9". */
function day(iso: unknown): string | null {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A transaction's amount with its sign as the app shows it: money in is +. */
function txnMoney(row: Rec | null): string | null {
  const amount = num(row?.amount);
  return amount === null ? null : signedMoney(-amount, cur(row?.currency) ?? 'USD', { always: true });
}

/** "Coffee, -$4.50 on Oct 9", from what it can read. */
function txnWords(row: Rec | null): string {
  const name = text(row?.name) ?? 'a transaction';
  const parts = [txnMoney(row), day(row?.date) ? `on ${day(row?.date)}` : null].filter(Boolean);
  return parts.length > 0 ? `${name}, ${parts.join(' ')}` : name;
}

/** What changed between two records' fields, in words. */
function changedFields(before: Rec | null, after: Rec | null, fields: readonly [key: string, words: (b: unknown, a: unknown) => string][]): string[] {
  if (!before || !after) return [];
  return fields.filter(([k]) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).map(([k, words]) => words(before[k], after[k]));
}

const renamed = (b: unknown, a: unknown) => `renamed from ${text(b) ?? 'no name'} to ${text(a) ?? 'no name'}`;

function accountSentence(c: ListedChange, names: AccountNames): string {
  const before = rec(c.before);
  const after = rec(c.after);
  if (c.op === 'manual-account.balance') {
    const known = names[c.target.id];
    const currency = known?.currency ?? 'USD';
    const from = num(before?.balance);
    const to = num(after?.balance);
    const whose = known ? `${known.name}’s balance` : 'a manual account’s balance';
    if (from === null || to === null) return `Set ${whose}.`;
    return `Set ${whose} from ${formatMoney(from, currency)} to ${formatMoney(to, currency)}.`;
  }
  const name = text(after?.name) ?? text(before?.name);
  if (c.op === 'manual-account.create') {
    const balance = num(after?.balance);
    return `Added the manual account ${name ?? ''}${balance === null ? '' : `, with a balance of ${formatMoney(balance, cur(after?.currency) ?? 'USD')}`}.`.replace('account ,', 'account,');
  }
  const parts = changedFields(before, after, [
    ['name', renamed],
    ['institution_name', (b, a) => `its institution from ${text(b) ?? 'none'} to ${text(a) ?? 'none'}`],
    ['type', (b, a) => `its type from ${text(b) ?? 'none'} to ${text(a) ?? 'none'}`],
    ['subtype', (b, a) => `its subtype from ${text(b) ?? 'none'} to ${text(a) ?? 'none'}`],
  ]);
  return `Changed the manual account ${name ?? ''}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.`;
}

function transactionSentence(c: ListedChange): string {
  const beforeRow = rec(at(rec(c.before), 'row'));
  const afterRow = rec(at(rec(c.after), 'row'));
  if (c.op === 'transaction.create') return `Added ${txnWords(afterRow)}.`;
  if (c.op === 'transaction.delete') return `Deleted ${txnWords(beforeRow)}.`;
  const rowParts = changedFields(beforeRow, afterRow, [
    ['amount', () => `its amount from ${txnMoney(beforeRow) ?? 'none'} to ${txnMoney(afterRow) ?? 'none'}`],
    ['name', renamed],
    ['date', (b, a) => `its day from ${day(b) ?? 'none'} to ${day(a) ?? 'none'}`],
    ['currency', (b, a) => `its currency from ${cur(b) ?? 'none'} to ${cur(a) ?? 'none'}`],
    ['category', () => 'its category'],
    ['note', (_b, a) => (text(a) ? 'its note' : 'its note taken off')],
    ['account_id', () => 'moved to another account'],
  ]);
  const saidBefore = rec(at(rec(c.before), 'said')) ?? {};
  const saidAfter = rec(at(rec(c.after), 'said')) ?? {};
  const saidParts = changedFields(saidBefore, saidAfter, [
    ['excluded', (_b, a) => (a === true ? 'left out of budgets and reports' : 'put back in budgets and reports')],
    ['tags', () => 'its tags'],
    ['untagged', () => 'its tags'],
  ]);
  const parts = [...new Set([...rowParts, ...saidParts])];
  return `Changed ${txnWords(beforeRow ?? afterRow)}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.`;
}

function taxonomySentence(c: ListedChange): string {
  const key = c.target.kind === 'group' ? 'group' : c.target.kind === 'tag' ? 'tag' : 'category';
  const what = key === 'group' ? 'category group' : key;
  const before = rec(at(rec(c.before), key));
  const after = rec(at(rec(c.after), key));
  const name = text(after?.name) ?? text(before?.name) ?? '';
  if (c.op.endsWith('.create')) return `Added the ${what} ${name}.`;
  const parts = changedFields(before, after, [
    ['name', renamed],
    ['group', () => 'moved to another group'],
    ['icon', () => 'its icon'],
    ['archived', (_b, a) => (a === true ? 'archived' : 'taken out of the archive')],
    ['color', (b, a) => `its color from ${text(b) ?? 'none'} to ${text(a) ?? 'none'}`],
  ]);
  return `Changed the ${what} ${name}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.`;
}

/**
 * The change in a sentence. `undone` is the change an undo undid, when it is
 * in the list; `names`, the manual accounts there are now.
 */
export function changeSentence(c: ListedChange, names: AccountNames = {}, undone?: ListedChange): string {
  if (c.op === 'undo') return undone ? `Undid this: ${changeSentence(undone, names).replace(/^./, (s) => s.toLowerCase())}` : 'Undid an earlier change.';
  if (c.forgotten_at || c.state !== 'done' || c.before === undefined || c.after === undefined) return `${opWords(c.op)}.`;
  switch (c.target.kind) {
    case 'manual-account':
      return accountSentence(c, names).replace(/ +([.:,])/g, '$1');
    case 'transaction':
      return transactionSentence(c);
    case 'category':
    case 'group':
    case 'tag':
      return taxonomySentence(c).replace(/ +([.:,])/g, '$1');
    default:
      return `${opWords(c.op)}.`;
  }
}

/** Why a change can't be undone, as the list can tell, or null. */
export function cannotUndo(c: ListedChange): string | null {
  if (c.op === 'undo') return 'An undo isn’t undone: make the change again.';
  if (c.undone_by) return 'Undone.';
  if (c.forgotten_at) return 'What it changed is forgotten, so it can’t be undone.';
  if (c.state !== 'done') return 'It may not have been made, so there is nothing to undo.';
  return null;
}

/** How it was made: through the API, an AI assistant, or in the app. */
export function viaWords(via: string): string {
  return via === 'mcp' ? 'through an AI assistant' : via === 'api' ? 'through the API' : 'in the app';
}
