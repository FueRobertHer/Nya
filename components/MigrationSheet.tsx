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
// bank's rows). Every answer is sent with the file again, and the review read
// afresh, so what is shown is always the server's reading; the import sends
// the fingerprint of the review shown and an id minted here, so the same import
// sent twice is made once. The list under the file is every import from
// another app, with Undo, which takes all of one out in one action.
//
// Amounts are formatted through lib/format.ts only, never kept formatted in a
// memo, so they follow whatever the formatters do (the hide-amounts toggle).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { formatMoney, signedMoney } from '@/lib/format';
import { displayName, sortedGroups, categoriesIn, KIND_WORDS, type CategoryKind, type Taxonomy } from '@/lib/categories';
import { APP_NAMES, APPS, ROLE_NAMES, type AppId, type AppRole } from '@/lib/import/apps/types';
import { MANUAL_TYPES } from '@/lib/manual';
import { isCurrencyCode } from '@/lib/manual-txn-input';

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
type Proposal = {
  index: number;
  line: number | null;
  file: { date: string; name: string; amount: number; currency: string | null };
  twin: { date: string; name: string; amount: number; currency: string | null; kind: 'bank' | 'imported'; descriptor: string | null };
  days: number;
  confidence: 'high' | 'medium' | 'low';
  similar: boolean;
  choice: 'same' | 'new' | null;
};
type Target = {
  key: string;
  kind: 'manual' | 'linked';
  name: string;
  new: boolean;
  sources: string[];
  currency: string;
  counts: Record<string, number>;
  first_date: string | null;
  last_date: string | null;
  totals: { out: number; in: number };
  currency_of_totals: string | null;
  proposals: Proposal[];
  more_proposals: number;
  problems: { line: number; reason: string }[];
  more_problems: number;
  before_bank: number | null;
  within_bank: number | null;
  pending_alike: number | null;
  history_pending: boolean;
  splits: number;
  exploded: { reason: string; count: number }[];
  tags_cut: number;
};
export type Review = {
  app: AppId;
  app_name: string;
  detected: boolean;
  entry: string | null;
  read: { date_order: 'mdy' | 'dmy' | null; order_open: boolean; sign: 'negative-out' | 'positive-out' | null; sign_from: 'app' | 'file' | 'chosen' | null; decimal: '.' | ',' };
  currency: { chosen: string | null; in_file: boolean };
  rows: number;
  notes: string[];
  accounts: (SourceAccount & { choice: unknown })[];
  offered: Offered[];
  categories: { mappings: Mapping[]; added: number; room: number; problem: string | null };
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

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const fmtDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtRange = (a: string | null, b: string | null) => (a && b ? (a === b ? fmtDay(a) : `${fmtDay(a)} to ${fmtDay(b)}`) : null);
/** An amount in Plaid's sign, as the Activity tab shows it: money in with a plus. */
const fmtAmount = (amount: number, currency: string | null) => signedMoney(-amount, currency, { always: true });
const listWords = (words: string[]) => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

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
  const [currency, setCurrency] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, ProposalChoices>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ counts: DoneCounts; accounts: number; already: boolean; status: 'importing' | 'done' | 'undoing' } | null>(null);
  const [past, setPast] = useState<Listed[] | null>(null);
  const [pastError, setPastError] = useState('');
  const [undoing, setUndoing] = useState<Listed | null>(null);
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
    setCurrency(null);
    setChoices({});
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
        ...(cur ? { currency: cur } : {}),
        choices: Object.fromEntries(
          Object.entries(ch).map(([k, c]) => [k, { proposals: { ...(c.all ? { all: c.all } : {}), ...(Object.keys(c.each).length > 0 ? { each: c.each } : {}) } }])
        ),
      };
    },
    [accounts, categories, choices, currency, options, tags]
  );

  /** Sends the file with these answers, for a question or the review. */
  const send = useCallback(
    async (picked: { name: string; blob: Blob }, meta: Record<string, unknown>) => {
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
    await send(f, { action: 'preview', options: {}, accounts: {}, categories: {}, tags: true, choices: {} });
  };

  /** Changes answers and reads the review again with them. */
  const answer = (over: Answers) => {
    if (over.options) setOptions(over.options);
    if (over.accounts) setAccounts(over.accounts);
    if (over.categories) setCategories(over.categories);
    if (over.tags !== undefined) setTags(over.tags);
    if (over.currency !== undefined) setCurrency(over.currency);
    if (over.choices) setChoices(over.choices);
    if (file) void send(file, metaOf('preview', over));
  };

  const importIt = async () => {
    if (!file || !review) return;
    const data = await send(file, { ...metaOf('import'), review: review.review, migration_id: migrationId });
    if (data && !data.error && (data.migration_id || data.already)) {
      setDone({ counts: data.counts ?? null, accounts: (data.imports ?? []).length, already: !!data.already, status: data.status ?? 'done' });
      setReview(null);
      onImported();
      void loadPast();
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
      const kept = [
        data.accounts?.kept?.length ? `${listWords(data.accounts.kept)} kept, since ${data.accounts.kept.length === 1 ? 'it holds' : 'they hold'} other transactions` : null,
        data.categories?.kept ? `${plural(data.categories.kept, 'category', 'categories')} kept, in use` : null,
        data.tags?.kept ? `${plural(data.tags.kept, 'tag')} kept, in use` : null,
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
        <UndoConfirm item={undoing} busy={busy} error={error} onConfirm={confirmUndo} onCancel={() => setUndoing(null)} />
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
        <div className="sheet-form">
          <p className="panel-note" style={{ marginTop: 0 }}>
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
          {error && <div className="error">{error}</div>}
        </div>
      ) : review ? (
        <ReviewStep
          r={review}
          taxonomy={taxonomy}
          options={options}
          accounts={accounts}
          categories={categories}
          tags={tags}
          choices={choices}
          busy={busy}
          error={error}
          onAnswer={answer}
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
          {error && <div className="error">{error}</div>}
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
          <PastMigrations items={past} error={pastError} onUndo={setUndoing} />
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
                <option key={i} value={i}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
      {q.problem && <div className="error">{q.problem}</div>}
      {error && <div className="error">{error}</div>}
      <p className="section-label">The first rows</p>
      <ul className="import-problems">
        {q.table.sample.map((row) => (
          <li key={row.line}>
            Line {row.line}: {row.cells.join(' · ')}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The review: where each account goes, the categories, tags and splits, and
 *  each Nya account's import. */
export function ReviewStep({
  r,
  taxonomy,
  options,
  accounts,
  categories,
  tags,
  choices,
  busy,
  error,
  onAnswer,
  onImport,
}: {
  r: Review;
  taxonomy: Taxonomy | null;
  options: Options;
  accounts: Record<string, AccountAnswer>;
  categories: Record<string, CategoryAnswer>;
  tags: boolean;
  choices: Record<string, ProposalChoices>;
  busy: boolean;
  error: string;
  onAnswer: (over: Answers) => void;
  onImport: () => void;
}) {
  const [allCategories, setAllCategories] = useState(false);
  const [currencyText, setCurrencyText] = useState<string | null>(null);
  const [allProblems, setAllProblems] = useState(false);
  const waiting = r.waiting.accounts + r.waiting.proposals;
  const canImport = !busy && waiting === 0 && r.blocks.length === 0 && r.targets.length > 0;
  const range = fmtRange(
    r.accounts.reduce<string | null>((m, a) => (a.first && (!m || a.first < m) ? a.first : m), null),
    r.accounts.reduce<string | null>((m, a) => (a.last && (!m || a.last > m) ? a.last : m), null)
  );
  const mappings = allCategories ? r.categories.mappings : r.categories.mappings.slice(0, 12);
  const setAccount = (key: string, a: AccountAnswer | null) => {
    const next = { ...accounts };
    if (a) next[key] = a;
    else delete next[key];
    onAnswer({ accounts: next });
  };
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
            {r.read.sign_from === 'file' ? ' (its income rows say so)' : r.read.sign_from === 'app' ? ` (${r.app_name}’s own way is positive: check the rows below)` : ''}
          </span>
        </label>
      )}
      {!r.currency.in_file &&
        (currencyText === null ? (
          <p className="panel-note">
            {r.currency.chosen
              ? `Amounts are read in ${r.currency.chosen}, as you chose.`
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
              Currency of every row
              <input
                value={currencyText}
                onChange={(e) => setCurrencyText(e.target.value.toUpperCase().slice(0, 3))}
                maxLength={3}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
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
        ))}
      {r.notes.map((n) => (
        <p key={n} className="panel-note">
          {n}
        </p>
      ))}

      <p className="section-label" style={{ marginTop: 16 }}>
        Where each account goes
      </p>
      <p className="panel-note" style={{ marginTop: 0 }}>
        A linked account’s rows are matched against its bank’s own, so none is counted twice. Nothing goes anywhere you haven’t chosen.
      </p>
      <ul className="import-rows import-conflicts">
        {r.accounts.map((a) => (
          <AccountRow key={a.key} a={a} answer={accounts[a.key] ?? null} offered={r.offered} appName={r.app_name} currency={r.currency.chosen} busy={busy} onAnswer={(x) => setAccount(a.key, x)} />
        ))}
      </ul>

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
          {r.categories.problem && <div className="error">{r.categories.problem}</div>}
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

      {r.targets.map((t) => (
        <TargetSection key={t.key} t={t} choices={choices[t.key] ?? { each: {} }} busy={busy} onChoose={(c) => onAnswer({ choices: { ...choices, [t.key]: c } })} />
      ))}

      {r.problems.length > 0 && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            Lines that can’t be read
          </p>
          <ul className="import-problems">
            {(allProblems ? r.problems : r.problems.slice(0, 5)).map((p) => (
              <li key={`${p.line}-${p.reason}`}>
                Line {p.line}: {p.reason}
              </li>
            ))}
          </ul>
          {!allProblems && r.problems.length > 5 && (
            <button className="link-btn" onClick={() => setAllProblems(true)}>
              Show all {(r.problems.length + r.more_problems).toLocaleString()}
            </button>
          )}
        </>
      )}

      {r.blocks.map((b) => (
        <div key={b} className="error">
          {b}
        </div>
      ))}
      {error && <div className="error">{error}</div>}
      <div className="action-row">
        <button disabled={!canImport} onClick={onImport}>
          {busy ? 'Reading…' : waiting > 0 ? `${plural(waiting, 'answer')} still needed` : 'Import'}
        </button>
      </div>
      <p className="panel-note">Undo takes all of it out again in one action. Nothing is written to your balance history.</p>
    </div>
  );
}

/** One of the file's accounts, and where it goes. */
function AccountRow({
  a,
  answer,
  offered,
  appName,
  currency,
  busy,
  onAnswer,
}: {
  a: SourceAccount;
  answer: AccountAnswer | null;
  offered: Offered[];
  appName: string;
  /** The currency chosen for the file's amounts, if one was. */
  currency: string | null;
  busy: boolean;
  onAnswer: (a: AccountAnswer | null) => void;
}) {
  const value = !answer ? '' : answer.to === 'new' ? 'new' : answer.to === 'skip' ? 'skip' : `${answer.to}:${answer.id}`;
  const range = fmtRange(a.first, a.last);
  const owedType = answer?.to === 'new' && (answer.type === 'credit' || answer.type === 'loan');
  const hint = owedType ? -a.net : a.net;
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
        {answer?.to === 'new' && (
          <>
            <label className="field">
              <span>Name</span>
              <input value={answer.name} maxLength={60} disabled={busy} onChange={(e) => onAnswer({ ...answer, name: e.target.value })} />
            </label>
            <label className="field">
              <span>Institution</span>
              <input value={answer.institution} maxLength={60} disabled={busy} onChange={(e) => onAnswer({ ...answer, institution: e.target.value })} />
            </label>
            <label className="field">
              <span>Kind</span>
              <select value={answer.type} disabled={busy} onChange={(e) => onAnswer({ ...answer, type: e.target.value })}>
                {MANUAL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_NAMES[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{owedType ? 'Owed on it now' : 'Its balance now'}</span>
              <input inputMode="decimal" value={answer.balance} placeholder="0.00" disabled={busy} onChange={(e) => onAnswer({ ...answer, balance: e.target.value })} />
            </label>
            <p className="panel-note" style={{ marginTop: 0 }}>
              Its transactions in this file come to {formatMoney(hint, a.currencies[0] ?? currency)} ({appName}’s balance if the file holds all of its history).{' '}
              <button className="link-btn" disabled={busy} onClick={() => onAnswer({ ...answer, balance: String(Math.round(hint * 100) / 100) })}>
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

/** What one Nya account's import would be, and a linked account's rows that
 *  look like its bank's. */
function TargetSection({ t, choices, busy, onChoose }: { t: Target; choices: ProposalChoices; busy: boolean; onChoose: (c: ProposalChoices) => void }) {
  const c = t.counts;
  const range = fmtRange(t.first_date, t.last_date);
  // Answers are by the file's line, which stays the row's whatever else is
  // sent into this account (lib/migration/plan.ts MigrationAnswers).
  const at = (p: Proposal) => String(p.line ?? 0);
  const choiceOf = (p: Proposal) => choices.each[at(p)] ?? choices.all ?? p.choice;
  return (
    <>
      <p className="section-label" style={{ marginTop: 16 }}>
        {t.name}
        {t.new ? ' (new)' : t.kind === 'linked' ? ' (linked)' : ''}
      </p>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {[
          `${plural(c.new ?? 0, 'new transaction')}`,
          c.duplicates ? `${c.duplicates.toLocaleString()} the bank has already, kept as its own` : null,
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
        {t.currency_of_totals && (c.new ?? 0) > 0 ? ` · new: ${formatMoney(t.totals.out, t.currency_of_totals)} out, ${formatMoney(t.totals.in, t.currency_of_totals)} in` : ''}
      </p>
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
      {t.proposals.length > 0 && (
        <ul className="import-rows import-conflicts">
          {t.proposals.map((p) => {
            const chosen = choiceOf(p);
            return (
              <li key={p.index}>
                <div className="import-row-text">
                  <div className="import-conflict-version">
                    <span className="import-row-name">{p.file.name}</span>
                    <span className={`import-row-amount${p.file.amount < 0 ? ' inflow' : ''}`}>{fmtAmount(p.file.amount, p.file.currency)}</span>
                  </div>
                  <div className="import-row-meta">In the file, {fmtDay(p.file.date)}</div>
                  <div className="import-conflict-version">
                    <span className="import-row-name">{p.twin.name}</span>
                    <span className={`import-row-amount${p.twin.amount < 0 ? ' inflow' : ''}`}>{fmtAmount(p.twin.amount, p.twin.currency ?? p.file.currency)}</span>
                  </div>
                  <div className="import-row-meta">
                    {p.twin.kind === 'bank' ? 'The bank’s' : 'An earlier file’s'}, {fmtDay(p.twin.date)} · {p.days === 0 ? 'the same day' : `${plural(p.days, 'day')} apart`} · {CONFIDENCE[p.confidence]}
                    {chosen === null ? ' · choose one' : ''}
                  </div>
                  <div className="import-choices" role="group" aria-label={`What ${p.file.name} is`}>
                    <button className="secondary" disabled={busy} aria-pressed={chosen === 'same'} onClick={() => onChoose({ ...choices, each: { ...choices.each, [at(p)]: 'same' } })}>
                      The same
                    </button>
                    <button className="secondary" disabled={busy} aria-pressed={chosen === 'new'} onClick={() => onChoose({ ...choices, each: { ...choices.each, [at(p)]: 'new' } })}>
                      Its own
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {t.more_proposals > 0 && <p className="panel-note">{plural(t.more_proposals, 'more row')} like these follow the choice made for them: kept as the bank’s own unless only possibly the same.</p>}
      {t.problems.length > 0 && (
        <ul className="import-problems">
          {t.problems.slice(0, 3).map((p) => (
            <li key={`${p.line}-${p.reason}`}>
              Line {p.line}: {p.reason}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Every import from another app, with Undo. */
export function PastMigrations({ items, error, onUndo }: { items: Listed[] | null; error: string; onUndo: (item: Listed) => void }) {
  if (error) return <p className="panel-note">{error}</p>;
  if (!items || items.length === 0) return null;
  return (
    <>
      <p className="section-label" style={{ marginTop: 16 }}>
        Imported before
      </p>
      <ul className="import-past">
        {items.map((item) => {
          const e = item.entry;
          return (
            <li key={item.id}>
              <div className="import-past-head">
                <span className="import-row-name">
                  {e ? `From ${APP_NAMES[e.app]}${e.file_name ? `, ${e.file_name}` : ''}` : item.record === 'unreadable' ? 'An import that can’t be read' : 'An import from a later version of Nya'}
                </span>
                {e && (
                  <button className="link-btn" onClick={() => onUndo(item)}>
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

/** What Undo takes out, before it does. */
export function UndoConfirm({ item, busy, error, onConfirm, onCancel }: { item: Listed; busy: boolean; error: string; onConfirm: () => void; onCancel: () => void }) {
  const e = item.entry!;
  return (
    <div className="sheet-form">
      <p className="panel-note" style={{ marginTop: 0 }}>
        Undo takes out every transaction this import from {APP_NAMES[e.app]} brought into {listWords(e.imports.map((i) => i.name))}, with their tags, notes and splits, and their
        categories on linked accounts’ rows.
        {e.made.accounts.length > 0 ? ` The ${plural(e.made.accounts.length, 'account')} it made (${listWords(e.made.accounts.map((a) => a.name))}) ${e.made.accounts.length === 1 ? 'goes' : 'go'} too, unless ${e.made.accounts.length === 1 ? 'it holds' : 'they hold'} transactions of your own since.` : ''}
        {e.made.categories.length + e.made.tags.length > 0 ? ' The categories and tags it made go when nothing else uses them.' : ''}
      </p>
      {error && <div className="error">{error}</div>}
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
