'use client';

// Switching from another app (M2, "Migration importers"): the sheet that
// brings a person's history from Monarch, YNAB, Lunch Money, Actual Budget or
// ZeroSum. The file goes to app/api/migration, which reads it (lib/import/
// apps/) and answers either a question (which app and which column is which,
// for a header Nya doesn't know; the order of its dates) or the review: the
// file's accounts, each waiting for the person to say where it goes (a new
// manual account, one they have, a linked account, or nowhere), the app's
// categories mapped to theirs, the tags, the split transactions rebuilt or not,
// and each Nya account's own import (a linked account's review against its
// bank's rows). An answer is sent with the file again, and the review read
// afresh, so what is shown is always the server's reading; but never for each
// key pressed: a new account's fields are sent once, with Update the review,
// and the answers to a linked account's proposals go with the import (All the
// same and All their own read the review again, once). The import sends the
// fingerprint of the review shown and an id minted here, so the same import
// sent twice is made once. The list under the file is every import from
// another app, with Undo, which takes all of one out in one action, and says
// first what it would take.
//
// Amounts are formatted through lib/format.ts only, as they are drawn, never
// kept formatted in a memo, so they follow the hide-amounts switch: each one
// drawn inside <Masked>, so a screen reader hears "hidden" for it, and a
// file's own figures (its first rows, a column's name, a line's problem) with
// hideFiguresIn, since they carry no currency to tell an amount by.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { Masked, spokenLabel } from './HideAmounts';
import { shownReason } from './ImportSheet';
import { formatMoney, hideAmountsIn, hideFiguresIn, plainNumber, signedMoney } from '@/lib/format';
import { displayName, sortedGroups, categoriesIn, KIND_WORDS, type CategoryKind, type Taxonomy } from '@/lib/categories';
import { APP_NAMES, APPS, ROLE_NAMES, type AppId, type AppRole } from '@/lib/import/apps/types';
import { MANUAL_TYPES } from '@/lib/manual';
import { isCurrencyCode } from '@/lib/manual-txn-input';
import { Notice } from './TotalCaveats';

type Options = { app?: AppId; columns?: Partial<Record<AppRole, number>>; date_order?: 'mdy' | 'dmy'; sign?: 'negative-out' | 'positive-out' };
type AccountAnswer =
  | { to: 'new'; name: string; institution: string; type: string; balance: string }
  | { to: 'manual'; id: string }
  | { to: 'linked'; id: string }
  | { to: 'skip' };
type CategoryAnswer = { to: 'existing'; id: string } | { to: 'new'; kind: CategoryKind };
type ProposalChoices = { all?: 'same' | 'new'; each: Record<string, 'same' | 'new'> };
/** The answers a review is read again with; `currency` null goes back to
 *  each account's own. */
type Answers = {
  options?: Options;
  accounts?: Record<string, AccountAnswer>;
  categories?: Record<string, CategoryAnswer>;
  tags?: boolean;
  carry?: boolean;
  currency?: string | null;
  choices?: Record<string, ProposalChoices>;
};

type Offered = { kind: 'manual' | 'linked'; id: string; name: string; institution: string; type: string; currency: string | null; mask?: string | null };
type SourceAccount = { key: string; name: string; rows: number; first: string | null; last: string | null; currencies: string[]; net: number; transfers: number; opening: number; splits: number; uncategorized: number };
type Mapping = {
  key: string;
  group: string | null;
  name: string;
  kind: CategoryKind | null;
  from: 'app' | 'name' | null;
  rows: number;
  target: { to: 'existing'; id: string; name: string; kind: CategoryKind; group: string; archived: boolean } | { to: 'new'; name: string; kind: CategoryKind; group: { id: string; name: string } | { new: string } };
  by: string;
  differs: string | null;
};
/** Where what the app said of a row its bank (or a file imported before) has
 *  goes, were it the same (lib/migration/plan.ts CarryTo), and how many go
 *  each way (CarryCounts). */
type CarryTo = 'bank' | 'approved' | 'earlier';
type CarryCounts = { bank: number; approved: number; notes: number; earlier: number };
type Proposal = {
  index: number;
  line: number | null;
  file: { date: string; name: string; amount: number; currency: string | null };
  twin: { date: string; name: string; amount: number; currency: string | null; kind: 'bank' | 'imported'; descriptor: string | null };
  days: number;
  confidence: 'high' | 'medium' | 'low';
  similar: boolean;
  choice: 'same' | 'new' | null;
  carry_to?: CarryTo | null;
  /** It would give the bank's row something there. */
  moves?: boolean;
};
type Target = {
  key: string;
  kind: 'manual' | 'linked';
  account_id?: string | null;
  name: string;
  new: boolean;
  sources: string[];
  currency: string;
  counts: Record<string, number>;
  first_date: string | null;
  last_date: string | null;
  totals: { out: number; in: number };
  currency_of_totals: string | null;
  other_currencies?: { currency: string; count: number }[];
  /** Its first rows as read, to check the file's money out and in by. */
  rows?: { line: number | null; date: string; name: string; amount: number; currency: string; category: string | null; action: string }[];
  proposals: Proposal[];
  more_proposals: number;
  /** Of its rows that are the bank's as the review was read, where what the
   *  app said of them goes (carriedNow). */
  carry?: Partial<CarryCounts>;
  problems: { line: number; reason: string }[];
  more_problems: number;
  before_bank: number | null;
  within_bank: number | null;
  pending_alike: number | null;
  history_pending: boolean;
  splits: number;
  exploded: { reason: string; count: number }[];
  whole?: { reason: string; count: number }[];
  left_out?: { opening: number; groups: number; lines: number };
  combined?: { transactions: number; lines: number };
  ended?: { state: string; day: string; rows: number } | null;
  tags_cut: number;
};
export type Review = {
  app: AppId;
  app_name: string;
  detected: boolean;
  entry: string | null;
  read: { date_order: 'mdy' | 'dmy' | null; order_open: boolean; sign: 'negative-out' | 'positive-out' | null; sign_from: 'app' | 'file' | 'chosen' | null; decimal: '.' | ',' };
  currency: { chosen: string | null; in_file: boolean };
  /** Whether a linked account's rows its bank has take the app's category,
   *  tags, notes and splits. */
  carry?: boolean;
  rows: number;
  /** The file's first rows as read: what its sign is checked by. */
  sample?: { line: number; date: string; name: string; amount: number; currency: string | null; account: string }[];
  notes: string[];
  accounts: (SourceAccount & { choice: unknown })[];
  offered: Offered[];
  categories: { mappings: Mapping[]; more?: number; added: number; room: number; problem: string | null };
  counts: { uncategorized: number; transfers: number; opening: number };
  tags: { on: boolean; names: { name: string; rows: number; existing: boolean }[]; more: number; added: number };
  splits: { rebuilt: number; parts: number; dropped: number; kept: { reason: string; count: number }[]; unmarked: string | null };
  problems: { line: number; reason: string }[];
  more_problems: number;
  targets: Target[];
  blocks: string[];
  waiting: { accounts: number; proposals: number };
  review: string;
};
export type Question =
  | { needs: 'mapping'; app: AppId | null; columns: Partial<Record<AppRole, number>>; table: { header: string[]; sample: { line: number; cells: string[] }[]; rows: number }; problem: string | null }
  | { needs: 'date_order'; app: AppId; examples: string[] };
type DoneCounts = { rows: number; imported: number; duplicates: number; present: number; splits: number; tagged: number } | null;
export type Listed = {
  id: string;
  record: 'ok' | 'unreadable' | 'unrecognised';
  entry: {
    app: AppId;
    file_name: string | null;
    started_at: string;
    status: 'importing' | 'done' | 'undoing';
    imports: { account_id: string; kind: 'manual' | 'linked'; name: string }[];
    made: { accounts: { id: string; name: string }[]; categories: string[]; tags: string[] };
    counts: DoneCounts;
  } | null;
};
/** What Undo would take out (app/api/migration ?undo=): each account's
 *  import as its own Undo says it, added up. */
export type UndoPreview = {
  remove: number;
  edited: number;
  moved: number;
  duplicates: number;
  restore: number;
  kept: { file_name: string | null; count: number }[];
  incomplete: boolean;
};
type NewAnswer = Extract<AccountAnswer, { to: 'new' }>;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const fmtDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtRange = (a: string | null, b: string | null) => (a && b ? (a === b ? fmtDay(a) : `${fmtDay(a)} to ${fmtDay(b)}`) : null);
/** An amount in Plaid's sign, as the Activity tab shows it: money in with a plus. */
const fmtAmount = (amount: number, currency: string | null) => signedMoney(-amount, currency, { always: true });
const listWords = (words: string[]) => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
/** An answer by a key the file wrote, never one an object inherits. */
const own = <T,>(by: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(by, key) ? by[key] : undefined);

/** How each app's export is made, in its own words, briefly (docs/features.md
 *  has the full steps). */
const HOW: Record<AppId, string> = {
  monarch: 'Settings, Data, Download transactions (or an account’s Edit menu, Download transactions).',
  ynab: 'In the web app, your plan’s menu, Export plan (or Export budget data): import the zip, or the Register file in it.',
  lunchmoney: 'Transactions, set the view to everything, then the Export to CSV icon above the table.',
  actual: 'All accounts, the menu at the top right, Export (the CSV, not Settings, Export data).',
  zerosum: 'The budget menu, Export, CSV (or Export CSV above your transactions).',
};

const TYPE_NAMES: Record<string, string> = { depository: 'Bank account', credit: 'Credit card', investment: 'Investment', loan: 'Loan', other: 'Other' };
const CONFIDENCE: Record<Proposal['confidence'], string> = { high: 'very likely the same', medium: 'likely the same', low: 'possibly the same' };
const ACTION_WORDS: Record<string, string> = { add: 'new', duplicate: 'the bank’s own', none: 'already in Nya', ask: 'to answer', replace: 'replaces one' };
const ENDED_WORDS: Record<string, string> = { closed: 'closed on', left: 'has not been yours since', unfollowed: 'stopped being followed from' };

/** The answer as the route takes it, or null while a new account's fields
 *  aren't complete (it waits, unanswered). */
function wireAccount(a: AccountAnswer): Record<string, unknown> | null {
  if (a.to !== 'new') return a;
  const balance = Number(a.balance.replace(/[,\s]/g, ''));
  if (a.balance.trim() === '' || !Number.isFinite(balance)) return null;
  return { to: 'new', name: a.name, institution: a.institution, type: a.type, balance };
}

/** A new account's kind, guessed from its name, for the person to check. */
const guessType = (name: string) => (/visa|master ?card|amex|american express|sapphire|card|credit/i.test(name) ? 'credit' : /brokerage|ira|401k|invest/i.test(name) ? 'investment' : /loan|mortgage/i.test(name) ? 'loan' : 'depository');

/** Answers to a linked account's proposals are by the file's line, which
 *  stays the row's whatever else is sent into the account
 *  (lib/migration/plan.ts MigrationAnswers). */
const lineOf = (p: Proposal) => String(p.line ?? 0);
/** What a proposal is answered as: the person's answer for it, for them
 *  all, else very likely and likely ones are the same and possibly the same
 *  ones wait (lib/history-import/plan.ts). */
const choiceOf = (c: ProposalChoices, p: Proposal): 'same' | 'new' | null => c.each[lineOf(p)] ?? c.all ?? (p.confidence === 'low' ? null : 'same');

/** A linked account's counts with the answers given here since the review
 *  was read (they go with the import, never one request each). */
export function countsNow(t: Pick<Target, 'counts' | 'proposals'>, sent: ProposalChoices, now: ProposalChoices): Record<string, number> {
  const counts = { ...t.counts };
  const bucket = (c: 'same' | 'new' | null, p: Proposal) => (c === 'same' ? (p.twin.kind === 'imported' ? 'already' : 'duplicates') : c === 'new' ? 'new' : 'unanswered');
  for (const p of t.proposals) {
    const before = choiceOf(sent, p);
    const after = choiceOf(now, p);
    if (before === after) continue;
    counts[bucket(before, p)] = (counts[bucket(before, p)] ?? 0) - 1;
    counts[bucket(after, p)] = (counts[bucket(after, p)] ?? 0) + 1;
  }
  return counts;
}

/** Of a linked account's rows that are its bank's, with the answers given
 *  here since the review was read: how many would take what the app said of
 *  them (`bank`), how many the person approved in the review queue stay
 *  where they approved them (`approved`) and of those, how many take their
 *  tags or notes (`notes`), and how many a file imported before brought keep
 *  what they have (`earlier`: lib/migration/plan.ts CarryCounts). A row
 *  that would give its bank's row nothing counts in neither `bank` nor
 *  `notes`. */
export function carriedNow(t: Pick<Target, 'carry' | 'proposals'>, sent: ProposalChoices, now: ProposalChoices): CarryCounts {
  const out: CarryCounts = { bank: 0, approved: 0, notes: 0, earlier: 0, ...t.carry };
  for (const p of t.proposals) {
    if (!p.carry_to) continue;
    const before = choiceOf(sent, p) === 'same';
    const after = choiceOf(now, p) === 'same';
    if (before === after) continue;
    const by = after ? 1 : -1;
    if (p.carry_to === 'earlier') out.earlier += by;
    else if (p.carry_to === 'approved') {
      out.approved += by;
      if (p.moves) out.notes += by;
    } else if (p.moves) out.bank += by;
  }
  return out;
}

/** What the review says of the transactions the person's banks already have,
 *  with the app's carried onto them or not. */
export function carryWords(c: CarryCounts, on: boolean, appName: string): string {
  const them = (n: number) => (n === 1 ? 'it' : 'them');
  if (!on) return 'They keep what they have now; the file’s rows that are them come in only as theirs.';
  const words: string[] = [];
  if (c.bank > 0) words.push(`${plural(c.bank, 'transaction')} would take them, as your own choice for ${them(c.bank)}, ahead of your rules and the bank’s categories, so their budgets and reports may change.`);
  if (c.approved > 0)
    words.push(
      `${plural(c.approved, 'transaction')} you approved in the review queue ${c.approved === 1 ? 'stays' : 'stay'} where you approved ${them(c.approved)}${c.notes > 0 ? `: only the tags and notes go onto ${them(c.approved)}` : ''}.`
    );
  if (c.bank + c.notes > 0) words.push('Undo puts them back.');
  if (c.earlier > 0)
    words.push(`${plural(c.earlier, 'transaction')} a file imported before brought ${c.earlier === 1 ? 'keeps what it has' : 'keep what they have'}: ${appName}’s categories, tags, notes and splits go only onto your banks’ own.`);
  return words.join(' ');
}

const NO_CHOICES: ProposalChoices = { each: {} };

export default function MigrationSheet({
  open,
  taxonomy,
  onClose,
  onImported,
}: {
  open: boolean;
  /** The person's categories, for sending one of the app's to one of theirs. */
  taxonomy: Taxonomy | null;
  onClose: () => void;
  /** After an import or an undo changed what is stored. */
  onImported: () => void;
}) {
  const [file, setFile] = useState<{ name: string; blob: Blob } | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [migrationId, setMigrationId] = useState('');
  const [options, setOptions] = useState<Options>({});
  const [accounts, setAccounts] = useState<Record<string, AccountAnswer>>({});
  const [categories, setCategories] = useState<Record<string, CategoryAnswer>>({});
  const [tags, setTags] = useState(true);
  const [carry, setCarry] = useState(true);
  const [currency, setCurrency] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, ProposalChoices>>({});
  // The answers to proposals the review shown was read with: those given
  // since go with the import.
  const [sentChoices, setSentChoices] = useState<Record<string, ProposalChoices>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ counts: DoneCounts; accounts: number; already: boolean; status: 'importing' | 'done' | 'undoing' } | null>(null);
  const [past, setPast] = useState<Listed[] | null>(null);
  const [pastError, setPastError] = useState('');
  const [undoing, setUndoing] = useState<Listed | null>(null);
  const [undoPreview, setUndoPreview] = useState<UndoPreview | null>(null);
  const [notice, setNotice] = useState('');
  // Answers sent with the review shown: a later answer reads it again.
  const asked = useRef(0);

  const loadPast = useCallback(async () => {
    setPastError('');
    try {
      const res = await fetch('/api/migration');
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Your earlier imports couldn’t be listed.');
      setPast(data.imports);
    } catch (e) {
      setPastError(e instanceof Error ? e.message : 'Your earlier imports couldn’t be listed.');
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadPast();
  }, [open, loadPast]);

  const reset = () => {
    setFile(null);
    setInputKey((k) => k + 1);
    setOptions({});
    setAccounts({});
    setCategories({});
    setTags(true);
    setCarry(true);
    setCurrency(null);
    setChoices({});
    setSentChoices({});
    setReview(null);
    setQuestion(null);
    setError('');
    setDone(null);
  };

  const close = () => {
    reset();
    setNotice('');
    setUndoing(null);
    onClose();
  };

  const metaOf = useCallback(
    (action: 'preview' | 'import', over: Answers = {}) => {
      const acc = over.accounts ?? accounts;
      const wired = Object.fromEntries(Object.entries(acc).flatMap(([k, a]) => {
        const w = wireAccount(a);
        return w ? [[k, w]] : [];
      }));
      const ch = over.choices ?? choices;
      const cur = over.currency !== undefined ? over.currency : currency;
      return {
        action,
        options: over.options ?? options,
        accounts: wired,
        categories: over.categories ?? categories,
        tags: over.tags ?? tags,
        carry: over.carry ?? carry,
        ...(cur ? { currency: cur } : {}),
        choices: Object.fromEntries(
          Object.entries(ch).map(([k, c]) => [k, { proposals: { ...(c.all ? { all: c.all } : {}), ...(Object.keys(c.each).length > 0 ? { each: c.each } : {}) } }])
        ),
      };
    },
    [accounts, carry, categories, choices, currency, options, tags]
  );

  /** Sends the file with these answers, for a question or the review;
   *  `sent`, the answers to proposals it carries, are the review's once it
   *  comes back. */
  const send = useCallback(
    async (picked: { name: string; blob: Blob }, meta: Record<string, unknown>, sent?: Record<string, ProposalChoices>) => {
      const at = ++asked.current;
      setBusy(true);
      setError('');
      try {
        const form = new FormData();
        form.set('file', picked.blob, picked.name);
        form.set('meta', JSON.stringify({ file_name: picked.name, ...meta }));
        const res = await fetch('/api/migration', { method: 'POST', body: form });
        const data = await res.json().catch(() => null);
        if (at !== asked.current) return null;
        if (!res.ok) {
          setError(typeof data?.error === 'string' ? data.error : 'The file couldn’t be read just now. Try again.');
          return data;
        }
        if (data?.needs) {
          setQuestion(data as Question);
          setReview(null);
        } else if (data?.preview) {
          setQuestion(null);
          setReview(data.preview as Review);
          if (sent) setSentChoices(sent);
        }
        return data;
      } catch {
        if (at === asked.current) setError('The file couldn’t be sent. Check your connection and try again.');
        return null;
      } finally {
        if (at === asked.current) setBusy(false);
      }
    },
    []
  );

  const choose = async (picked: File) => {
    reset();
    setNotice('');
    const f = { name: picked.name, blob: picked };
    setFile(f);
    setMigrationId(`app-import:${crypto.randomUUID()}`);
    await send(f, { action: 'preview', options: {}, accounts: {}, categories: {}, tags: true, choices: {} }, {});
  };

  /** Changes answers and reads the review again with them. */
  const answer = (over: Answers) => {
    if (over.options) setOptions(over.options);
    if (over.accounts) setAccounts(over.accounts);
    if (over.categories) setCategories(over.categories);
    if (over.tags !== undefined) setTags(over.tags);
    if (over.carry !== undefined) setCarry(over.carry);
    if (over.currency !== undefined) setCurrency(over.currency);
    if (over.choices) setChoices(over.choices);
    if (file) void send(file, metaOf('preview', over), over.choices ?? choices);
  };

  const importIt = async () => {
    if (!file || !review) return;
    const data = await send(file, { ...metaOf('import'), review: review.review, migration_id: migrationId });
    if (data && !data.error && (data.migration_id || data.already)) {
      setDone({ counts: data.counts ?? null, accounts: (data.imports ?? []).length, already: !!data.already, status: data.status ?? 'done' });
      setReview(null);
      onImported();
      void loadPast();
    } else if (data?.needs === 'review') {
      // What the review showed changed: read it again, keeping why.
      const why = typeof data.error === 'string' ? data.error : '';
      await send(file, metaOf('preview'), choices);
      setError(why);
    }
  };

  const openUndo = async (item: Listed) => {
    setUndoing(item);
    setUndoPreview(null);
    setError('');
    try {
      const res = await fetch(`/api/migration?undo=${encodeURIComponent(item.id)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'What it would take out couldn’t be counted just now.');
      setUndoPreview(data.undo as UndoPreview);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'What it would take out couldn’t be counted just now.');
    }
  };

  const confirmUndo = async () => {
    if (!undoing) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/migration', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ migration_id: undoing.id, confirm: true }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'It couldn’t be undone just now. Try again.');
      const why = { transactions: 'it holds other transactions', changed: 'you changed it since', goal: 'a goal tracks it' } as const;
      const keptAccounts = (data.accounts?.kept ?? []) as { name: string; why: keyof typeof why }[];
      const kept = [
        ...keptAccounts.map((k) => `${k.name} kept, since ${why[k.why] ?? 'it is in use'}`),
        data.categories?.kept ? `${plural(data.categories.kept, 'category', 'categories')} kept, in use` : null,
        data.tags?.kept ? `${plural(data.tags.kept, 'tag')} kept, in use` : null,
        data.kept ? `${plural(data.kept, 'transaction')} kept for a later import` : null,
      ].filter(Boolean);
      setNotice(`Undone: ${plural(data.removed + data.duplicates, 'transaction')} taken out${data.accounts?.removed?.length ? `, with ${listWords(data.accounts.removed)}` : ''}.${kept.length ? ` ${kept.join('; ')}.` : ''}`);
      setUndoing(null);
      onImported();
      void loadPast();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'It couldn’t be undone just now. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const title = undoing ? 'Undo an import' : review ? `From ${review.app_name}` : 'Switching from another app';
  return (
    <Sheet open={open} title={title} onClose={close} onBack={undoing ? () => setUndoing(null) : review || question || done ? reset : undefined}>
      {undoing ? (
        <UndoConfirm item={undoing} preview={undoPreview} busy={busy} error={error} onConfirm={confirmUndo} onCancel={() => setUndoing(null)} />
      ) : done ? (
        <div className="sheet-form">
          <p className="import-headline" style={{ marginTop: 0 }}>
            {!done.already
              ? `Imported ${plural(done.counts?.imported ?? 0, 'transaction')} into ${plural(done.accounts, 'account')}.`
              : done.status === 'done'
                ? 'This import was already made.'
                : done.status === 'undoing'
                  ? 'This import is being undone.'
                  : 'This import is still being made, or stopped part way.'}
          </p>
          {done.already && done.status !== 'done' && (
            <p className="panel-note">It is in the list of imports: if it stays there unfinished, Undo takes out whatever it made, and you can import the file again.</p>
          )}
          {done.counts && (
            <p className="panel-note">
              {[
                done.counts.duplicates > 0 ? `${done.counts.duplicates.toLocaleString()} kept as your banks’ own` : null,
                done.counts.present > 0 ? `${done.counts.present.toLocaleString()} already in Nya` : null,
                done.counts.splits > 0 ? `${plural(done.counts.splits, 'split transaction')}` : null,
                done.counts.tagged > 0 ? `${done.counts.tagged.toLocaleString()} tagged` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <p className="panel-note">To take all of it out again, use Undo beside it in the list of imports. Each account’s import is also listed on that account, with Undo of its own.</p>
          <div className="action-row">
            <button onClick={close}>Done</button>
          </div>
        </div>
      ) : question?.needs === 'mapping' ? (
        <MappingStep q={question} options={options} busy={busy} error={error} onAnswer={(o) => answer({ options: o })} />
      ) : question?.needs === 'date_order' ? (
        <div className="sheet-form stack tight">
          <p className="panel-note">
            Every date in this file could be read two ways (such as {question.examples.join(', ')}). Which order does {APP_NAMES[question.app]} write them in?
          </p>
          <div className="action-row">
            <button className="secondary" disabled={busy} onClick={() => answer({ options: { ...options, date_order: 'mdy' } })}>
              Month first (US)
            </button>
            <button className="secondary" disabled={busy} onClick={() => answer({ options: { ...options, date_order: 'dmy' } })}>
              Day first
            </button>
          </div>
          {error && (
            <Notice level="critical" role="alert">
              <Masked>{hideAmountsIn(error)}</Masked>
            </Notice>
          )}
        </div>
      ) : review ? (
        <ReviewStep
          r={review}
          taxonomy={taxonomy}
          options={options}
          accounts={accounts}
          categories={categories}
          tags={tags}
          carry={carry}
          choices={choices}
          sentChoices={sentChoices}
          busy={busy}
          error={error}
          onAnswer={answer}
          onChoose={(key, c) => setChoices({ ...choices, [key]: c })}
          onImport={importIt}
        />
      ) : (
        <div className="sheet-form">
          <p className="panel-note" style={{ marginTop: 0 }}>
            Bring your history from Monarch, YNAB, Lunch Money, Actual Budget or ZeroSum: its accounts, categories, tags, notes and split transactions. Nothing is
            imported until you have said where each account goes and checked the review.
          </p>
          <label className="field">
            <span>The app’s export (CSV, or the zip it gives you)</span>
            <input key={inputKey} type="file" accept=".csv,.tsv,.zip,text/csv,application/zip" disabled={busy} onChange={(e) => e.target.files?.[0] && void choose(e.target.files[0])} />
          </label>
          {busy && <div className="spinner" role="status" aria-label="Reading the file" />}
          {error && (
            <Notice level="critical" role="alert">
              <Masked>{hideAmountsIn(error)}</Masked>
            </Notice>
          )}
          {notice && <p className="panel-note" role="status">{notice}</p>}
          <details className="migration-how">
            <summary>How to export from each app</summary>
            <ul className="import-problems">
              {APPS.map((a) => (
                <li key={a}>
                  <strong>{APP_NAMES[a]}:</strong> {HOW[a]}
                </li>
              ))}
            </ul>
          </details>
          <PastMigrations items={past} error={pastError} onUndo={(item) => void openUndo(item)} />
        </div>
      )}
    </Sheet>
  );
}

/** The way in, under the Accounts tab's buttons and on the first screen with
 *  nothing connected. */
export function SwitchingLink({ onOpen }: { onOpen: () => void }) {
  return (
    <p className="panel-note migration-link">
      Switching from another app?{' '}
      <button className="link-btn" onClick={onOpen}>
        Bring your history from Monarch, YNAB, Lunch Money, Actual Budget or ZeroSum
      </button>
    </p>
  );
}

/** Which app the file is from, and which column is which: for a header Nya
 *  doesn't know (lib/import/apps/read.ts). */
export function MappingStep({ q, options, busy, error, onAnswer }: { q: Extract<Question, { needs: 'mapping' }>; options: Options; busy: boolean; error: string; onAnswer: (o: Options) => void }) {
  const app = options.app ?? q.app ?? null;
  const columns = options.columns ?? q.columns;
  const roles: AppRole[] = ['date', 'account', 'payee', 'amount', 'outflow', 'inflow', 'category', 'group', 'notes', 'tags', 'currency'];
  return (
    <div className="sheet-form">
      <p className="panel-note" style={{ marginTop: 0 }}>
        {q.app
          ? `Some columns this file needs as ${APP_NAMES[q.app]}’s export weren’t found. Say which column is which.`
          : 'Nya doesn’t recognise this file’s columns as one of these apps’ exports. Say which app it is from and which column is which, or import a bank’s file into one account with that account’s Import.'}
      </p>
      <label className="field">
        <span>It is from</span>
        <select value={app ?? ''} disabled={busy} onChange={(e) => e.target.value && onAnswer({ ...options, app: e.target.value as AppId, columns: undefined })}>
          <option value="">Choose the app</option>
          {APPS.map((a) => (
            <option key={a} value={a}>
              {APP_NAMES[a]}
            </option>
          ))}
        </select>
      </label>
      {app &&
        roles.map((role) => (
          <label key={role} className="field">
            <span>{ROLE_NAMES[role]}</span>
            <select
              value={columns[role] ?? ''}
              disabled={busy}
              onChange={(e) => {
                const next = { ...columns };
                if (e.target.value === '') delete next[role];
                else next[role] = Number(e.target.value);
                onAnswer({ ...options, app, columns: next });
              }}
            >
              <option value="">None</option>
              {q.table.header.map((h, i) => (
                <option key={i} value={i} aria-label={spokenLabel(hideFiguresIn(h))}>
                  {hideFiguresIn(h)}
                </option>
              ))}
            </select>
          </label>
        ))}
      {q.problem && (
        <Notice level="critical" role="alert">
          <Masked>{hideAmountsIn(q.problem)}</Masked>
        </Notice>
      )}
      {error && (
        <Notice level="critical" role="alert">
          <Masked>{hideAmountsIn(error)}</Masked>
        </Notice>
      )}
      <p className="section-label">The first rows</p>
      <ul className="import-problems">
        {q.table.sample.map((row) => (
          <li key={row.line}>
            Line {row.line}: <Masked>{hideFiguresIn(row.cells.join(' · '))}</Masked>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The review: where each account goes, the categories, tags and splits, and
 *  each Nya account's import. A new account's fields and the answers to a
 *  linked account's proposals stay here as they are typed and chosen: the
 *  fields are sent once, with Update the review (a file is never sent again
 *  for each key pressed), and the answers go with the import itself. */
export function ReviewStep({
  r,
  taxonomy,
  options,
  accounts,
  categories,
  tags,
  carry = true,
  choices,
  sentChoices = {},
  busy,
  error,
  onAnswer,
  onChoose = () => {},
  onImport,
}: {
  r: Review;
  taxonomy: Taxonomy | null;
  options: Options;
  accounts: Record<string, AccountAnswer>;
  categories: Record<string, CategoryAnswer>;
  tags: boolean;
  carry?: boolean;
  choices: Record<string, ProposalChoices>;
  /** The answers to proposals the review was read with. */
  sentChoices?: Record<string, ProposalChoices>;
  busy: boolean;
  error: string;
  onAnswer: (over: Answers) => void;
  /** An answer to one of a linked account's proposals, kept until the import. */
  onChoose?: (key: string, c: ProposalChoices) => void;
  onImport: () => void;
}) {
  const [allCategories, setAllCategories] = useState(false);
  const [currencyText, setCurrencyText] = useState<string | null>(null);
  const [allProblems, setAllProblems] = useState(false);
  // New accounts' fields as typed, not yet in the review.
  const [drafts, setDrafts] = useState<Record<string, NewAnswer>>({});
  const pending = Object.keys(drafts).length > 0;
  const linkedNow = r.targets.filter((t) => t.kind === 'linked').map((t) => ({ t, counts: countsNow(t, own(sentChoices, t.key) ?? NO_CHOICES, own(choices, t.key) ?? NO_CHOICES) }));
  const unanswered = linkedNow.reduce((n, x) => n + Math.max(0, x.counts.unanswered ?? 0), 0);
  const waiting = r.waiting.accounts + unanswered;
  const canImport = !busy && !pending && waiting === 0 && r.blocks.length === 0 && r.targets.length > 0;
  const range = fmtRange(
    r.accounts.reduce<string | null>((m, a) => (a.first && (!m || a.first < m) ? a.first : m), null),
    r.accounts.reduce<string | null>((m, a) => (a.last && (!m || a.last > m) ? a.last : m), null)
  );
  const mappings = allCategories ? r.categories.mappings : r.categories.mappings.slice(0, 12);
  const setAccount = (key: string, a: AccountAnswer | null) => {
    const next = { ...accounts, ...drafts };
    if (a) next[key] = a;
    else delete next[key];
    setDrafts({});
    onAnswer({ accounts: next });
  };
  const update = () => {
    if (!pending) return;
    const next = { ...accounts, ...drafts };
    setDrafts({});
    onAnswer({ accounts: next });
  };
  // Where what the app said of the rows the banks already have goes: the
  // box is offered while it moves anything (or is off), an approved row only
  // with tags or a note to take.
  const carried = linkedNow.reduce<CarryCounts>(
    (n, { t }) => {
      const c = carriedNow(t, own(sentChoices, t.key) ?? NO_CHOICES, own(choices, t.key) ?? NO_CHOICES);
      return { bank: n.bank + c.bank, approved: n.approved + c.approved, notes: n.notes + c.notes, earlier: n.earlier + c.earlier };
    },
    { bank: 0, approved: 0, notes: 0, earlier: 0 }
  );
  const carrying = carried.bank + carried.notes > 0 || r.carry === false;
  return (
    <div className="sheet-form">
      <p className="import-headline" style={{ marginTop: 0 }}>
        {plural(r.rows, 'transaction')} in {plural(r.accounts.length, 'account')}
      </p>
      <p className="panel-note">
        {[`Read as ${r.app_name}’s export${r.detected ? '' : ', as you said'}`, r.entry ? `from ${r.entry}` : null, range].filter(Boolean).join(' · ')}
      </p>
      {r.read.sign && (
        <label className="quick-add-check">
          <input
            type="checkbox"
            checked={r.read.sign === 'negative-out'}
            disabled={busy}
            onChange={(e) => onAnswer({ options: { ...options, sign: e.target.checked ? 'negative-out' : 'positive-out' } })}
          />
          <span>
            Money out is written as negative in this file
            {r.read.sign_from === 'file' ? ' (its income rows say so)' : r.read.sign_from === 'app' ? ` (${r.app_name}’s own way is positive: check its first rows)` : ''}
          </span>
        </label>
      )}
      {r.read.sign && (r.sample ?? []).length > 0 && (
        <ul className="import-rows">
          {(r.sample ?? []).map((x) => (
            <li key={x.line}>
              <div className="import-row-text">
                <div className="import-row-name">{x.name}</div>
                <div className="import-row-meta">
                  {fmtDay(x.date)}
                  {x.account ? ` · ${x.account}` : ''}
                  {` · read as ${x.amount > 0 ? 'money out' : 'money in'}`}
                </div>
              </div>
              <div className={`import-row-amount${x.amount < 0 ? ' inflow' : ''}`}>
                <Masked>{fmtAmount(x.amount, x.currency)}</Masked>
              </div>
            </li>
          ))}
        </ul>
      )}
      {currencyText === null ? (
        <p className="panel-note">
          {r.currency.chosen
            ? `Amounts${r.currency.in_file ? ' that don’t say their currency' : ''} are read in ${r.currency.chosen}, as you chose.`
            : r.currency.in_file
              ? 'Each row says its currency; a new account is kept in the one most of its rows are in.'
              : 'This file doesn’t say its currency, so amounts are read in the currency of the account they go into (USD for a new one).'}{' '}
          <button className="link-btn" disabled={busy} onClick={() => setCurrencyText(r.currency.chosen ?? '')}>
            Change
          </button>
          {r.currency.chosen && (
            <>
              {' '}
              <button className="link-btn" disabled={busy} onClick={() => onAnswer({ currency: null })}>
                Use each account’s own
              </button>
            </>
          )}
        </p>
      ) : (
        <div className="quick-add-pair import-currency">
          <label className="field">
            {r.currency.in_file ? 'Currency of rows that don’t say one' : 'Currency of every row'}
            <input
              value={currencyText}
              onChange={(e) => setCurrencyText(e.target.value.toUpperCase().slice(0, 3))}
              maxLength={3}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <button
            className="secondary"
            disabled={busy || !isCurrencyCode(currencyText)}
            onClick={() => {
              onAnswer({ currency: currencyText });
              setCurrencyText(null);
            }}
          >
            Use
          </button>
        </div>
      )}
      {r.notes.map((n) => (
        <p key={n} className="panel-note">
          <Masked>{hideAmountsIn(n)}</Masked>
        </p>
      ))}

      <p className="section-label" style={{ marginTop: 16 }}>
        Where each account goes
      </p>
      <p className="panel-note" style={{ marginTop: 0 }}>
        A linked account’s rows are matched against its bank’s own: one its bank has is kept as the bank’s, never counted beside it. Nothing goes anywhere you haven’t chosen.
      </p>
      <ul className="import-rows import-conflicts">
        {r.accounts.map((a) => (
          <AccountRow
            key={a.key}
            a={a}
            answer={own(accounts, a.key) ?? null}
            draft={own(drafts, a.key) ?? null}
            offered={r.offered}
            appName={r.app_name}
            currency={r.currency.chosen}
            busy={busy}
            onAnswer={(x) => setAccount(a.key, x)}
            onDraft={(d) => setDrafts({ ...drafts, [a.key]: d })}
            onSubmit={update}
          />
        ))}
      </ul>
      {pending && (
        <div className="action-row">
          <button className="secondary" disabled={busy} onClick={update}>
            Update the review
          </button>
        </div>
      )}

      {r.categories.mappings.length > 0 && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            Categories
          </p>
          <p className="panel-note" style={{ marginTop: 0 }}>
            {r.categories.added > 0 ? `${plural(r.categories.added, 'new category', 'new categories')}, the rest your own by name.` : 'Each goes to one of your own.'} Change any of them
            here.
          </p>
          <ul className="import-rows">
            {mappings.map((m) => (
              <CategoryRow key={m.key} m={m} taxonomy={taxonomy} busy={busy} onAnswer={(c) => onAnswer({ categories: { ...categories, [m.key]: c } })} />
            ))}
          </ul>
          {r.categories.mappings.length > mappings.length && (
            <button className="link-btn" onClick={() => setAllCategories(true)}>
              Show all {r.categories.mappings.length.toLocaleString()} categories
            </button>
          )}
          {r.categories.problem && (
            <Notice level="critical" role="alert">
              {r.categories.problem}
            </Notice>
          )}
        </>
      )}
      {(r.counts.transfers > 0 || r.counts.opening > 0 || r.counts.uncategorized > 0) && (
        <p className="panel-note">
          {[
            r.counts.transfers > 0 ? `${plural(r.counts.transfers, 'transfer')} between your accounts, filed as transfers and left out of spending` : null,
            r.counts.opening > 0 ? `${plural(r.counts.opening, 'opening balance')}, under Starting balances, counted as neither income nor spending` : null,
            r.counts.uncategorized > 0 ? `${plural(r.counts.uncategorized, 'transaction')} with no category` : null,
          ]
            .filter(Boolean)
            .join('. ')}
          .
        </p>
      )}

      {(r.tags.names.length > 0 || !r.tags.on) && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            Tags
          </p>
          <label className="quick-add-check">
            <input type="checkbox" checked={tags} disabled={busy} onChange={(e) => onAnswer({ tags: e.target.checked })} />
            <span>
              Bring the tags
              {r.tags.on ? ` (${plural(r.tags.names.length + r.tags.more, 'tag')}${r.tags.added > 0 ? `, ${r.tags.added.toLocaleString()} new` : ''})` : ''}
            </span>
          </label>
        </>
      )}

      {(r.splits.rebuilt > 0 || r.splits.kept.length > 0 || r.splits.unmarked) && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            Split transactions
          </p>
          {r.splits.rebuilt > 0 && (
            <p className="panel-note" style={{ marginTop: 0 }}>
              {plural(r.splits.rebuilt, 'split transaction')} rebuilt, with {plural(r.splits.parts, 'part')} adding up exactly to each.
              {r.splits.dropped > 0 ? ` ${plural(r.splits.dropped, 'line')} of nothing left out of them.` : ''}
            </p>
          )}
          {r.splits.kept.map((k) => (
            <p key={k.reason} className="panel-note">
              {plural(k.count, 'line')} of split transactions come in as transactions of their own: {k.reason}
            </p>
          ))}
          {r.splits.unmarked && <p className="panel-note">{r.splits.unmarked}</p>}
        </>
      )}

      {(carrying || carried.approved + carried.earlier > 0) && r.targets.some((t) => t.kind === 'linked') && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            Your banks’ own transactions
          </p>
          {carrying && (
            <label className="quick-add-check">
              <input type="checkbox" checked={carry} disabled={busy} onChange={(e) => onAnswer({ carry: e.target.checked })} />
              <span>Give the transactions your banks already have the category, tags, notes and splits they had in {r.app_name}</span>
            </label>
          )}
          <p className="panel-note" style={{ marginTop: 0 }}>
            {carryWords(carried, carry, r.app_name)}
          </p>
        </>
      )}

      {r.targets.map((t) => (
        <TargetSection
          key={t.key}
          t={t}
          appName={r.app_name}
          institution={r.offered.find((o) => o.kind === 'linked' && o.id === t.account_id)?.institution ?? null}
          choices={own(choices, t.key) ?? NO_CHOICES}
          sent={own(sentChoices, t.key) ?? NO_CHOICES}
          busy={busy}
          onChoose={(c) => onChoose(t.key, c)}
          onChooseAll={(all) => onAnswer({ choices: { ...choices, [t.key]: { all, each: {} } } })}
        />
      ))}

      {r.problems.length > 0 && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            Lines that can’t be read
          </p>
          <ul className="import-problems">
            {(allProblems ? r.problems : r.problems.slice(0, 5)).map((p) => (
              <li key={`${p.line}-${p.reason}`}>
                Line {p.line}: <Masked>{shownReason(p.reason)}</Masked>
              </li>
            ))}
          </ul>
          {!allProblems && r.problems.length > 5 && (
            <button className="link-btn" onClick={() => setAllProblems(true)}>
              Show all {plainNumber(r.problems.length + r.more_problems)}
            </button>
          )}
        </>
      )}

      {(r.blocks.length > 0 || error) && (
        <div className="stack tight">
          {r.blocks.map((b) => (
            <Notice key={b} level="critical" role="alert">
              <Masked>{hideAmountsIn(b)}</Masked>
            </Notice>
          ))}
          {error && (
            <Notice level="critical" role="alert">
              <Masked>{hideAmountsIn(error)}</Masked>
            </Notice>
          )}
        </div>
      )}
      <div className="action-row">
        <button disabled={!canImport} onClick={onImport}>
          {busy ? 'Reading…' : pending ? 'Update the review first' : waiting > 0 ? `${plural(waiting, 'answer')} still needed` : 'Import'}
        </button>
      </div>
      <p className="panel-note">Undo takes all of it out again in one action. Nothing is written to your balance history.</p>
    </div>
  );
}

/** One of the file's accounts, and where it goes. A new account's fields are
 *  the person's draft until they update the review: never sent, nor
 *  disabled, while they type. */
function AccountRow({
  a,
  answer,
  draft,
  offered,
  appName,
  currency,
  busy,
  onAnswer,
  onDraft,
  onSubmit,
}: {
  a: SourceAccount;
  answer: AccountAnswer | null;
  draft: NewAnswer | null;
  offered: Offered[];
  appName: string;
  /** The currency chosen for the file's amounts, if one was. */
  currency: string | null;
  busy: boolean;
  onAnswer: (a: AccountAnswer | null) => void;
  onDraft: (a: NewAnswer) => void;
  onSubmit: () => void;
}) {
  const value = !answer ? '' : answer.to === 'new' ? 'new' : answer.to === 'skip' ? 'skip' : `${answer.to}:${answer.id}`;
  const range = fmtRange(a.first, a.last);
  const fields: NewAnswer | null = draft ?? (answer?.to === 'new' ? answer : null);
  const owedType = fields !== null && (fields.type === 'credit' || fields.type === 'loan');
  const hint = owedType ? -a.net : a.net;
  const enter = (e: { key: string; preventDefault: () => void }) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    onSubmit();
  };
  return (
    <li>
      <div className="import-row-text">
        <div className="import-row-name">{a.name}</div>
        <div className="import-row-meta">
          {[
            plural(a.rows, 'transaction'),
            range,
            a.splits > 0 ? plural(a.splits, 'split') : null,
            a.uncategorized > 0 ? `${a.uncategorized.toLocaleString()} with no category` : null,
            a.currencies.length > 0 ? a.currencies.join(', ') : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        <label className="field" style={{ marginTop: 6 }}>
          <span>Goes into</span>
          <select
            value={value}
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') onAnswer(null);
              else if (v === 'skip') onAnswer({ to: 'skip' });
              else if (v === 'new') onAnswer({ to: 'new', name: a.name.slice(0, 60), institution: appName, type: guessType(a.name), balance: '' });
              else {
                const [kind, ...rest] = v.split(':');
                onAnswer({ to: kind as 'manual' | 'linked', id: rest.join(':') });
              }
            }}
          >
            <option value="">Choose where it goes</option>
            <option value="new">A new manual account</option>
            {offered.some((o) => o.kind === 'manual') && (
              <optgroup label="Your manual accounts">
                {offered
                  .filter((o) => o.kind === 'manual')
                  .map((o) => (
                    <option key={o.id} value={`manual:${o.id}`}>
                      {o.institution} · {o.name}
                    </option>
                  ))}
              </optgroup>
            )}
            {offered.some((o) => o.kind === 'linked') && (
              <optgroup label="Your linked accounts">
                {offered
                  .filter((o) => o.kind === 'linked')
                  .map((o) => (
                    <option key={o.id} value={`linked:${o.id}`}>
                      {o.institution} · {o.name}
                      {o.mask ? ` (${o.mask})` : ''}
                    </option>
                  ))}
              </optgroup>
            )}
            <option value="skip">Leave it out</option>
          </select>
        </label>
        {fields && (
          <>
            <label className="field">
              <span>Name</span>
              <input value={fields.name} maxLength={60} onChange={(e) => onDraft({ ...fields, name: e.target.value })} onKeyDown={enter} />
            </label>
            <label className="field">
              <span>Institution</span>
              <input value={fields.institution} maxLength={60} onChange={(e) => onDraft({ ...fields, institution: e.target.value })} onKeyDown={enter} />
            </label>
            <label className="field">
              <span>Kind</span>
              <select value={fields.type} onChange={(e) => onDraft({ ...fields, type: e.target.value })}>
                {MANUAL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_NAMES[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{owedType ? 'Owed on it now' : 'Its balance now'}</span>
              <input inputMode="decimal" value={fields.balance} placeholder="0.00" onChange={(e) => onDraft({ ...fields, balance: e.target.value })} onKeyDown={enter} />
            </label>
            <p className="panel-note" style={{ marginTop: 0 }}>
              Its transactions in this file come to <Masked>{formatMoney(hint, a.currencies[0] ?? currency)}</Masked> ({appName}’s balance if the file holds all of its history).{' '}
              <button className="link-btn" onClick={() => onDraft({ ...fields, balance: String(Math.round(hint * 100) / 100) })}>
                Use it
              </button>
            </p>
          </>
        )}
      </div>
    </li>
  );
}

/** One of the app's categories, and where it goes. */
function CategoryRow({ m, taxonomy, busy, onAnswer }: { m: Mapping; taxonomy: Taxonomy | null; busy: boolean; onAnswer: (c: CategoryAnswer) => void }) {
  const value = m.target.to === 'existing' ? `existing:${m.target.id}` : `new:${m.target.kind}`;
  const where = m.target.to === 'existing' ? `Your ${displayName(m.target.name)}${m.target.archived ? ' (archived)' : ''}` : `New: ${m.target.name}, in ${'id' in m.target.group ? m.target.group.name : `${m.target.group.new} (new)`}`;
  return (
    <li>
      <div className="import-row-text">
        <div className="import-row-name">{m.group ? `${m.group}: ${m.name}` : m.name}</div>
        <div className="import-row-meta">
          {plural(m.rows, 'transaction')} · {where}, counted as {KIND_WORDS[m.target.kind]}
          {m.kind && m.from === 'name' ? ' (its kind proposed from its name)' : ''}
        </div>
        {m.differs && <div className="import-row-meta">{m.differs}</div>}
        <label className="field" style={{ marginTop: 6 }}>
          <span className="visually-hidden">Where {m.name} goes</span>
          <select
            value={value}
            disabled={busy}
            onChange={(e) => {
              const [to, id] = e.target.value.split(':');
              onAnswer(to === 'new' ? { to: 'new', kind: id as CategoryKind } : { to: 'existing', id });
            }}
          >
            <option value="new:expense">New category, counted as spending</option>
            <option value="new:income">New category, counted as income</option>
            <option value="new:transfer">New category, a transfer (in no total)</option>
            {m.target.to === 'existing' && !taxonomy?.categories.some((c) => c.id === (m.target as { id: string }).id) && <option value={value}>{displayName(m.target.name)}</option>}
            {taxonomy &&
              sortedGroups(taxonomy).map((g) => (
                <optgroup key={g.id} label={g.name}>
                  {categoriesIn(taxonomy, g.id)
                    .filter((c) => !c.archived || (m.target.to === 'existing' && m.target.id === c.id))
                    .map((c) => (
                      <option key={c.id} value={`existing:${c.id}`}>
                        {displayName(c.name)}
                      </option>
                    ))}
                </optgroup>
              ))}
          </select>
        </label>
      </div>
    </li>
  );
}

/** What one Nya account's import would be: its first rows, to check the
 *  file's money out and in by, and a linked account's rows that look like
 *  its bank's, each answered here (kept until the import) or all at once. */
function TargetSection({
  t,
  appName,
  institution,
  choices,
  sent,
  busy,
  onChoose,
  onChooseAll,
}: {
  t: Target;
  appName: string;
  /** A linked account's bank, by name. */
  institution: string | null;
  choices: ProposalChoices;
  /** The answers the review was read with. */
  sent: ProposalChoices;
  busy: boolean;
  onChoose: (c: ProposalChoices) => void;
  onChooseAll: (all: 'same' | 'new') => void;
}) {
  const c = t.kind === 'linked' ? countsNow(t, sent, choices) : t.counts;
  const range = fmtRange(t.first_date, t.last_date);
  const bank = institution ?? 'the bank';
  // The money in and out the review counted, while no answer since moves it.
  const fresh = JSON.stringify(sent) === JSON.stringify(choices);
  const left = t.left_out ?? { opening: 0, groups: 0, lines: 0 };
  return (
    <>
      <p className="section-label" style={{ marginTop: 16 }}>
        {t.name}
        {t.new ? ' (new)' : t.kind === 'linked' ? ' (linked)' : ''}
      </p>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {[
          `${plural(c.new ?? 0, 'new transaction')}`,
          c.duplicates ? `${plainNumber(c.duplicates)} ${bank} has already, kept as its own` : null,
          c.already ? `${c.already.toLocaleString()} an earlier file brought` : null,
          c.present ? `${c.present.toLocaleString()} already in Nya` : null,
          c.unanswered ? `${c.unanswered.toLocaleString()} to answer` : null,
          c.unreadable ? `${plural(c.unreadable, 'line')} can’t be read` : null,
          t.splits ? plural(t.splits, 'split transaction') : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <p className="panel-note">
        {range ? `${range} · ` : ''}in {t.currency}
        {t.currency_of_totals && (c.new ?? 0) > 0 && fresh && (
          <>
            {' · new: '}
            <Masked>{formatMoney(t.totals.out, t.currency_of_totals)}</Masked> out, <Masked>{formatMoney(t.totals.in, t.currency_of_totals)}</Masked> in
          </>
        )}
      </p>
      {(t.other_currencies ?? []).length > 0 && (
        <p className="panel-note">
          {(t.other_currencies ?? []).map((o) => `${plural(o.count, 'row')} in ${o.currency}`).join(', ')}: shown in their own currency, never added into totals in {t.currency}.
        </p>
      )}
      {(t.rows ?? []).length > 0 && (
        <ul className="import-rows">
          {(t.rows ?? []).map((r, i) => (
            <li key={`${r.line ?? 'x'}-${i}`}>
              <div className="import-row-text">
                <div className="import-row-name">{r.name}</div>
                <div className="import-row-meta">
                  {fmtDay(r.date)}
                  {r.category ? ` · ${r.category}` : ''}
                  {` · ${r.amount > 0 ? 'money out' : 'money in'}`}
                  {ACTION_WORDS[r.action] ? ` · ${ACTION_WORDS[r.action]}` : ''}
                </div>
              </div>
              <div className={`import-row-amount${r.amount < 0 ? ' inflow' : ''}`}>
                <Masked>{fmtAmount(r.amount, r.currency)}</Masked>
              </div>
            </li>
          ))}
        </ul>
      )}
      {t.kind === 'linked' && (left.opening > 0 || left.groups > 0 || left.lines > 0) && (
        <p className="panel-note">
          {[
            left.opening > 0
              ? `${left.opening === 1 ? 'An opening balance or balance adjustment' : `${left.opening.toLocaleString()} opening balances and balance adjustments`} from ${appName} ${left.opening === 1 ? 'isn’t' : 'aren’t'} brought in: ${t.name}’s balance and transactions are ${bank}’s own`
              : null,
            left.groups > 0
              ? `${plural(left.groups, 'group')} of transactions ${appName} keeps at ${left.groups === 1 ? 'its' : 'their'} net ${left.groups === 1 ? 'isn’t' : 'aren’t'} brought in where ${bank}’s own transactions, or a file imported before, already have ${left.groups === 1 ? 'its' : 'their'} transactions one by one`
              : null,
            left.lines > 0
              ? `${plural(left.lines, 'line')} of split transactions ${left.lines === 1 ? 'isn’t' : 'aren’t'} brought in: the file doesn’t hold ${left.lines === 1 ? 'its transaction' : 'their transactions'} whole, and ${bank}’s own transactions, or a file imported before, already reach ${left.lines === 1 ? 'its' : 'their'} day`
              : null,
          ]
            .filter(Boolean)
            .join('. ')}
          .
        </p>
      )}
      {(t.whole ?? []).map((w) => (
        <p key={w.reason} className="panel-note">
          {plural(w.count, 'line')} of split transactions come in whole, as {bank} (or a file imported before) has them, without their parts: {w.reason}
        </p>
      ))}
      {(t.combined?.transactions ?? 0) > 0 && (
        <p className="panel-note">
          {plural(t.combined!.lines, 'row')} of one day and payee that add up exactly to one of {bank}’s transactions come in as {plural(t.combined!.transactions, 'split transaction')}, matched to {t.combined!.transactions === 1 ? 'it' : 'them'}.
        </p>
      )}
      {t.ended && t.ended.rows > 0 && (
        <p className="panel-note">
          {t.ended.state === 'closed' ? `${t.name} closed on ${fmtDay(t.ended.day)}` : t.ended.state === 'left' ? `${t.name} has not been yours since ${fmtDay(t.ended.day)}` : `You stopped following ${t.name} from ${fmtDay(t.ended.day)}`}:{' '}
          {t.ended.rows === 1 ? 'one of the transactions this file adds is' : `${t.ended.rows.toLocaleString()} of the transactions this file adds are`} dated from then, and {t.ended.rows === 1 ? 'counts' : 'count'} in nothing, as its bank’s own from then don’t.
        </p>
      )}
      {t.kind === 'linked' && t.before_bank !== null && (t.before_bank > 0 || (t.within_bank ?? 0) > 0) && (
        <p className="panel-note">
          {t.before_bank > 0 ? `${plural(t.before_bank, 'new transaction')} from before the bank’s own begin` : ''}
          {t.before_bank > 0 && (t.within_bank ?? 0) > 0 ? '; ' : ''}
          {(t.within_bank ?? 0) > 0 ? `${plural(t.within_bank!, 'transaction')} on days the bank covers with nothing like ${t.within_bank === 1 ? 'it' : 'them'}` : ''}. The file is taken to hold
          every transaction of the account from its first day to its last.
        </p>
      )}
      {t.history_pending && <p className="panel-note">The bank is still sending its older transactions, so more of these may turn out to be its own once it has.</p>}
      {t.exploded.map((e) => (
        <p key={e.reason} className="panel-note">
          {plural(e.count, 'line')} of split transactions come in as transactions of their own here: {e.reason}
        </p>
      ))}
      {t.tags_cut > 0 && <p className="panel-note">{plural(t.tags_cut, 'transaction')} had more tags than one can carry (20): the first 20 come.</p>}
      {(t.proposals.length > 1 || t.more_proposals > 0) && (
        <div className="import-choices" role="group" aria-label={`For every row of ${t.name} that may be ${bank}’s`}>
          <button className="secondary" disabled={busy} aria-pressed={choices.all === 'same' && Object.keys(choices.each).length === 0} onClick={() => onChooseAll('same')}>
            All the same
          </button>
          <button className="secondary" disabled={busy} aria-pressed={choices.all === 'new' && Object.keys(choices.each).length === 0} onClick={() => onChooseAll('new')}>
            All their own
          </button>
        </div>
      )}
      {t.proposals.length > 0 && (
        <ul className="import-rows import-conflicts">
          {t.proposals.map((p) => {
            const chosen = choiceOf(choices, p);
            return (
              <li key={p.index}>
                <div className="import-row-text">
                  <div className="import-conflict-version">
                    <span className="import-row-name">{p.file.name}</span>
                    <span className={`import-row-amount${p.file.amount < 0 ? ' inflow' : ''}`}>
                      <Masked>{fmtAmount(p.file.amount, p.file.currency)}</Masked>
                    </span>
                  </div>
                  <div className="import-row-meta">In the file, {fmtDay(p.file.date)}</div>
                  <div className="import-conflict-version">
                    <span className="import-row-name">{p.twin.name}</span>
                    <span className={`import-row-amount${p.twin.amount < 0 ? ' inflow' : ''}`}>
                      <Masked>{fmtAmount(p.twin.amount, p.twin.currency ?? p.file.currency)}</Masked>
                    </span>
                  </div>
                  <div className="import-row-meta">
                    {p.twin.kind === 'bank' ? `${institution ?? 'The bank'}’s` : 'An earlier file’s'}, {fmtDay(p.twin.date)} · {p.days === 0 ? 'the same day' : `${plural(p.days, 'day')} apart`} · {CONFIDENCE[p.confidence]}
                    {chosen === null ? ' · choose one' : ''}
                  </div>
                  <div className="import-choices" role="group" aria-label={`What ${p.file.name} is`}>
                    <button className="secondary" aria-pressed={chosen === 'same'} onClick={() => onChoose({ ...choices, each: { ...choices.each, [lineOf(p)]: 'same' } })}>
                      The same
                    </button>
                    <button className="secondary" aria-pressed={chosen === 'new'} onClick={() => onChoose({ ...choices, each: { ...choices.each, [lineOf(p)]: 'new' } })}>
                      Its own
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {t.more_proposals > 0 && (
        <p className="panel-note">
          {plural(t.more_proposals, 'more row')} like these {t.more_proposals === 1 ? 'isn’t' : 'aren’t'} listed:{' '}
          {choices.all
            ? `${t.more_proposals === 1 ? 'it is' : 'they are'} answered as ${choices.all === 'same' ? `${bank}’s own` : 'their own'}, as you chose for every row.`
            : `very likely and likely ones are taken as ${bank}’s own, and possibly the same ones wait: All the same or All their own answers them.`}
        </p>
      )}
      {t.problems.length > 0 && (
        <ul className="import-problems">
          {t.problems.slice(0, 3).map((p) => (
            <li key={`${p.line}-${p.reason}`}>
              Line {p.line}: <Masked>{shownReason(p.reason)}</Masked>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Every import from another app, with Undo. */
export function PastMigrations({ items, error, onUndo }: { items: Listed[] | null; error: string; onUndo: (item: Listed) => void }) {
  if (error) return <p className="panel-note"><Masked>{hideAmountsIn(error)}</Masked></p>;
  if (!items || items.length === 0) return null;
  return (
    <>
      <p className="section-label" style={{ marginTop: 16 }}>
        Imported before
      </p>
      <ul className="import-past">
        {items.map((item) => {
          const e = item.entry;
          const name = e ? `From ${APP_NAMES[e.app]}${e.file_name ? `, ${e.file_name}` : ''}` : item.record === 'unreadable' ? 'An import that can’t be read' : 'An import from a later version of Nya';
          return (
            <li key={item.id}>
              <div className="import-past-head">
                <span className="import-row-name">{name}</span>
                {e && (
                  <button className="link-btn" aria-label={`Undo the import ${name.charAt(0).toLowerCase()}${name.slice(1)}`} onClick={() => onUndo(item)}>
                    Undo
                  </button>
                )}
              </div>
              {e && (
                <div className="import-row-meta">
                  {[
                    new Date(e.started_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
                    e.status === 'done'
                      ? e.counts
                        ? plural(e.counts.imported, 'transaction')
                        : null
                      : e.status === 'undoing'
                        ? 'being undone, or stopped part way: Undo finishes it'
                        : 'being made, or stopped part way: Undo takes out what it made',
                    listWords(e.imports.map((i) => i.name)),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
              {!e && <div className="import-row-meta">Each account’s import is still listed, with Undo, on that account.</div>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** What Undo takes out, before it does: what was made, and each account's
 *  import as its own Undo says it (`preview`, counted when the confirmation
 *  opens: rows changed since go too, rows a later import relied on stay). */
export function UndoConfirm({
  item,
  preview = null,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  item: Listed;
  preview?: UndoPreview | null;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const e = item.entry!;
  const p = preview;
  return (
    <div className="sheet-form">
      <p className="panel-note" style={{ marginTop: 0 }}>
        Undo takes out every transaction this import from {APP_NAMES[e.app]} brought into {listWords(e.imports.map((i) => i.name))}, with their tags, notes and splits, and their
        categories on linked accounts’ rows.
        {e.made.accounts.length > 0
          ? ` The ${plural(e.made.accounts.length, 'account')} it made (${listWords(e.made.accounts.map((a) => a.name))}) ${e.made.accounts.length === 1 ? 'goes' : 'go'} too, unless ${e.made.accounts.length === 1 ? 'it holds' : 'they hold'} transactions of your own since, you changed ${e.made.accounts.length === 1 ? 'it' : 'them'}, or a goal tracks ${e.made.accounts.length === 1 ? 'it' : 'them'}.`
          : ''}
        {e.made.categories.length + e.made.tags.length > 0 ? ' The categories and tags it made go when nothing else uses them.' : ''}
      </p>
      {p ? (
        <ul className="import-problems">
          <li>
            {plural(p.remove, 'transaction')} {p.remove === 1 ? 'goes' : 'go'}
            {p.duplicates > 0 ? `, and so ${p.duplicates === 1 ? 'does the row' : `do the ${p.duplicates.toLocaleString()} rows`} it kept as your banks’ own (your banks’ transactions stay)` : ''}.
          </li>
          {p.edited > 0 && (
            <li>
              {p.edited.toLocaleString()} of them {p.edited === 1 ? 'was' : 'were'} changed since, and {p.edited === 1 ? 'goes' : 'go'} too.
            </li>
          )}
          {p.moved > 0 && (
            <li>
              {p.moved.toLocaleString()} {p.moved === 1 ? 'is' : 'are'} on another account now, and {p.moved === 1 ? 'goes' : 'go'} too.
            </li>
          )}
          {p.restore > 0 && <li>{plural(p.restore, 'transaction')} it replaced {p.restore === 1 ? 'is' : 'are'} put back as {p.restore === 1 ? 'it was' : 'they were'}.</li>}
          {p.kept.map((k, i) => (
            <li key={i}>
              {plural(k.count, 'more transaction')} {k.count === 1 ? 'stays' : 'stay'}: {k.file_name ?? 'a later import'} found {k.count === 1 ? 'it' : 'them'} already there, so {k.count === 1 ? 'it is' : 'they are'} kept for that import.
            </li>
          ))}
          {p.incomplete && <li>Some accounts’ transactions can’t be read now: any of its transactions there stay.</li>}
        </ul>
      ) : (
        !error && <p className="panel-note">Counting what it takes out…</p>
      )}
      {error && (
        <Notice level="critical" role="alert">
          <Masked>{hideAmountsIn(error)}</Masked>
        </Notice>
      )}
      <div className="action-row">
        <button className="secondary" disabled={busy} onClick={onCancel}>
          Keep it
        </button>
        <button disabled={busy} onClick={onConfirm}>
          {busy ? 'Undoing…' : 'Undo the import'}
        </button>
      </div>
    </div>
  );
}
