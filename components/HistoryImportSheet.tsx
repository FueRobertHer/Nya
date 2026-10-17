'use client';

// Importing years of a LINKED account's history from files its bank exports
// (#52): the sheet behind "Import history" on a linked account's chart. Built
// for a phone, one question at a time, as the manual account's import sheet
// (components/ImportSheet.tsx), whose mapping and date questions it shares.
//
//   1. The file, with the account's past imports below, each with Undo, where
//      the bank's own transactions begin, and how far back the estimated
//      history already reaches.
//   2. The file read in the browser to ask its questions (which statement,
//      which columns, the order of its dates).
//   3. The REVIEW, from the server against the account as it is: rows the
//      account already has (the bank's, or an earlier file's in another
//      format) are proposals, each with that transaction beside it and a
//      confidence, answered one by one or all at once (the same transaction,
//      or one of its own; a low-confidence one has no answer until the person
//      gives it, and one across the edge of either side's days says why);
//      rows already imported are skipped; the new rows, and how many are
//      older than the bank's own; the period the file covers, which the person
//      can widen to the one they exported; and the lines that can't be read,
//      with whether they are transactions, which decides whether the chart is
//      drawn through the file's period. Nothing is kept until Import, and the
//      import is refused if the account changed since this review.
//
// The file is sent for the review and again for the import, as for a manual
// account: nothing is staged on the server between them.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import { CsvMapping, DateOrderQuestion, kindsText, shownReason, type Picked } from './ImportSheet';
import { Masked } from './HideAmounts';
import { formatMoney, signedMoney } from '@/lib/format';
import { instantDay } from '@/lib/local-date';
import { isCurrencyCode } from '@/lib/manual-txn-input';
import { MAX_FILE_BYTES, MAX_IMPORT_ROWS, type FileFormat } from '@/lib/import/record';
import { decodeFile, detectFormat, FORMAT_NAMES } from '@/lib/import/text';
import { readImport, type ImportOptions, type ReadResult, type StatementInfo } from '@/lib/import/read';
import { columnsFromNames, DELIMITERS, guessColumns, readCsvTable, type CsvColumns, type CsvSign, type CsvTable, type Delimiter } from '@/lib/import/csv';
import type { DateOrder } from '@/lib/import/dates';
import type { DecimalMark } from '@/lib/import/amounts';

/** The linked account the sheet is open on. */
export type HistoryImportTarget = { account_id: string; name: string; institution_name: string; type: string; currency: string | null };

type Choice = 'same' | 'new';
type ConflictChoice = 'new' | 'skip';
type ChoiceSet<T> = { all?: T; each: Record<string, T> };

type Shown = { date: string; name: string; amount: number; currency: string | null };
type Edge = { kind: 'before-bank'; day: string } | { kind: 'outside-file'; from: string; to: string } | { kind: 'outside-import'; from: string; to: string };
type Proposal = {
  index: number;
  line: number | null;
  file: Shown;
  /** The transaction already there: the bank's, or one an earlier file kept. */
  twin: Shown & { kind: 'bank' | 'imported'; id: string; descriptor: string | null; import_id: string | null; file_name?: string | null; imported_at?: string };
  days: number;
  confidence: 'high' | 'medium' | 'low';
  similar: boolean;
  edge: Edge | null;
  choice: Choice | null;
};
type Conflict = {
  index: number;
  line: number | null;
  row_id: string;
  differs: { name: boolean; amount: boolean; date: boolean };
  suggested: 'new' | null;
  choice: ConflictChoice | null;
  file: Shown;
  stored: Shown;
};
type Counts = { new: number; duplicates: number; already: number; present: number; repeated: number; skipped: number; conflicts: number; unanswered: number; unreadable: number };

/** The server's review (app/api/history-import reviewOf). */
export type Review = {
  format: FileFormat;
  statement: StatementInfo | null;
  read: { date_order: DateOrder | null; order_open?: boolean; decimal: DecimalMark | null };
  counts: Counts;
  rows: { line: number | null; date: string; name: string; amount: number; currency: string; category: string | null; outcome: string }[];
  problems: { line: number; reason: string }[];
  more_problems: number;
  proposals: Proposal[];
  more_proposals: number;
  conflicts: Conflict[];
  more_conflicts: number;
  kinds: { transfers: number; atm: number; payments: number; fees: number };
  first_date: string | null;
  last_date: string | null;
  covers: { from: string; to: string; stated: boolean; whole?: true } | null;
  bank_from: string | null;
  /** The connection's older transactions are still on their way to Nya. */
  history_pending?: boolean;
  before_bank: number;
  within_bank: number;
  pending_alike: number;
  currency: string | null;
  other_currencies: { currency: string; count: number }[];
  totals: { out: number; in: number };
  shortened: number;
  warnings: string[];
  account_mismatch: { expected: string; found: string; basis?: 'last-file' | 'mask' } | null;
  review: string;
};

/** One past import (app/api/history-import GET, lib/history-import/commit.ts). */
type Listed = {
  id: string;
  record: 'ok' | 'unreadable' | 'unrecognised' | 'missing';
  format: FileFormat | null;
  file_name: string | null;
  imported_at: string | null;
  counts: { imported: number; duplicates: number; present: number } | null;
  first_date: string | null;
  last_date: string | null;
  covers: { from: string; to: string } | null;
  taken_over: number;
  rows_now: number | null;
  duplicates_now: number | null;
  superseded_now: number | null;
  returned_now?: number | null;
};
type UndoPlan = { record: 'ok' | 'unreadable'; remove: number; duplicates: number; kept: { file_name: string | null; count: number }[]; incomplete: boolean };
type Reach = { reach: string | null; why: 'not-counted' | 'anchor-not-covered' | 'held-flat' | null; gaps: { imported: { from: string; to: string }; uncovered: { from: string; to: string } }[] };
type Past = {
  imports: Listed[];
  settings: Settings | null;
  bank_from: string | null;
  history_pending: boolean;
  walked: boolean;
  /** The account's currency at the bank, when known. */
  currency?: string | null;
  reach: Reach | null;
};
type Settings = {
  csv?: { columns: Record<string, string>; sign: CsvSign; decimal: DecimalMark | null; date_order: DateOrder | null; delimiter: string; currency: string } | null;
  ofx?: { flip: boolean; currency?: string } | null;
  qif?: { date_order: DateOrder | null; decimal: DecimalMark | null; flip: boolean; currency: string } | null;
};
type Done = {
  imported: number;
  duplicates: number;
  already?: number;
  present: number;
  repeated: number;
  skipped: number;
  unreadable: number;
  before_bank?: number;
  /** Drawn again at once (how far back this account's estimate now follows
   *  imported rows), or after the backfill runs again (`backfill`). */
  history: { drawn: boolean; from: string | null; reach?: string | null; backfill?: boolean };
};
type Step = 'pick' | 'statement' | 'mapping' | 'order' | 'review' | 'done';

const NONE = <T,>(): ChoiceSet<T> => ({ each: {} });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const fmtDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtRange = (a: string | null, b: string | null) => (a && b ? (a === b ? fmtDay(a) : `${fmtDay(a)} to ${fmtDay(b)}`) : null);
/** As the Activity tab shows an amount: money in signed plus. */
const fmtAmount = (amount: number, currency: string | null) => signedMoney(-amount, currency, { always: true });
const wire = <T,>(c: ChoiceSet<T>) => ({ ...(c.all ? { all: c.all } : {}), ...(Object.keys(c.each).length > 0 ? { each: c.each } : {}) });
/** The answer that applies to a proposal now: the person's, else their
 *  choice for every one, else the review's default (none for a low one). */
const choiceOf = (c: ChoiceSet<Choice>, p: Pick<Proposal, 'index' | 'confidence'>): Choice | null => c.each[String(p.index)] ?? c.all ?? (p.confidence === 'low' ? null : 'same');

const CONFIDENCE_TEXT = { high: 'very likely the same', medium: 'likely the same', low: 'possibly the same' } as const;

/** Why a proposal is the same transaction only through a posting lag, in
 *  words (lib/history-import/plan.ts Edge). */
export function edgeText(edge: Edge, bank: string): string {
  if (edge.kind === 'before-bank') return `${bank} has nothing before ${fmtDay(edge.day)}: the same only if it posted days later`;
  if (edge.kind === 'outside-file') return `this file covers ${fmtRange(edge.from, edge.to)}: the same only if dated otherwise in it`;
  return `that import covers ${fmtRange(edge.from, edge.to)}: the same only if dated otherwise in it`;
}

/** The review's counts with the answers given since it was asked for: the
 *  listed proposals moved between "already there", "new" and "to answer".
 *  Those not listed follow the answer for every one, which asks for the
 *  review again. */
export function countsNow(r: Pick<Review, 'counts' | 'proposals'>, sent: ChoiceSet<Choice>, now: ChoiceSet<Choice>): Counts {
  const counts = { ...r.counts };
  const bucket = (c: Choice | null, p: Proposal): keyof Counts => (c === 'same' ? (p.twin.kind === 'imported' ? 'already' : 'duplicates') : c === 'new' ? 'new' : 'unanswered');
  for (const p of r.proposals) {
    const before = choiceOf(sent, p);
    const after = choiceOf(now, p);
    if (before === after) continue;
    counts[bucket(before, p)]--;
    counts[bucket(after, p)]++;
  }
  return counts;
}

/** A first mapping for a header, as the manual import's sheet drafts one. */
function draftColumns(header: string[]): CsvColumns {
  const guess = guessColumns(header);
  const taken = new Set(Object.values(guess));
  const free = () => {
    const at = header.findIndex((_, i) => !taken.has(i));
    const i = at < 0 ? 0 : at;
    taken.add(i);
    return i;
  };
  const out: CsvColumns = { ...guess, date: guess.date ?? free(), description: guess.description ?? free() };
  if (out.amount === undefined && (out.debit === undefined || out.credit === undefined)) {
    delete out.debit;
    delete out.credit;
    out.amount = free();
  }
  return out;
}

const LIVE_ROWS = 20;

async function postForm(meta: Record<string, unknown>, file: Picked): Promise<{ res: Response; data: any }> {
  const form = new FormData();
  form.set('file', file.blob, file.name);
  form.set('meta', JSON.stringify({ file_name: file.name, ...meta }));
  const res = await fetch('/api/history-import', { method: 'POST', body: form });
  return { res, data: await res.json().catch(() => null) };
}

export default function HistoryImportSheet({
  target,
  onClose,
  onImported,
}: {
  target: HistoryImportTarget | null;
  onClose: () => void;
  /** After an import or an undo changed the account's rows, and so its
   *  estimated history. */
  onImported: () => void;
}) {
  const [shown, setShown] = useState<HistoryImportTarget | null>(null);
  const [past, setPast] = useState<Past | null>(null);
  const [pastError, setPastError] = useState('');
  const [file, setFile] = useState<Picked | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [options, setOptions] = useState<ImportOptions>({});
  const [step, setStep] = useState<Step>('pick');
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [choices, setChoices] = useState<ChoiceSet<Choice>>(NONE);
  const [sentChoices, setSentChoices] = useState<ChoiceSet<Choice>>(NONE);
  const [conflicts, setConflicts] = useState<ChoiceSet<ConflictChoice>>(NONE);
  const [covers, setCovers] = useState<{ from: string; to: string } | null>(null);
  const [whole, setWhole] = useState(false);
  const [undoing, setUndoing] = useState<Listed | null>(null);
  const [undoPlan, setUndoPlan] = useState<{ plan: UndoPlan | null; error: string } | null>(null);
  const [notice, setNotice] = useState('');
  const thisYear = new Date().getFullYear();
  const account = shown;
  const name = account?.name ?? 'the account';

  const loadPast = useCallback(async (id: string) => {
    setPastError('');
    try {
      const res = await fetch(`/api/history-import?account_id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPast(null);
        setPastError(data?.error ?? 'Past imports couldn’t be loaded.');
        return;
      }
      setPast({
        imports: Array.isArray(data?.imports) ? data.imports : [],
        settings: data?.settings ?? null,
        bank_from: data?.bank_from ?? null,
        history_pending: data?.history_pending === true,
        walked: data?.walked !== false,
        reach: data?.reach ?? null,
      });
    } catch {
      setPast(null);
      setPastError('Past imports couldn’t be loaded: the server couldn’t be reached.');
    }
  }, []);

  // A fresh start each time it opens.
  useEffect(() => {
    if (!target) return;
    setShown(target);
    setFile(null);
    setInputKey((k) => k + 1);
    setOptions({});
    setStep('pick');
    setReview(null);
    setBusy(false);
    setError('');
    setDone(null);
    setAcknowledged(false);
    setChoices(NONE);
    setSentChoices(NONE);
    setConflicts(NONE);
    setCovers(null);
    setWhole(false);
    setUndoing(null);
    setUndoPlan(null);
    setNotice('');
    setPast(null);
    void loadPast(target.account_id);
  }, [target, loadPast]);

  const csvTable = useMemo<CsvTable | { error: string } | null>(
    () => (file?.format === 'csv' ? readCsvTable(file.text, { delimiter: options.csv?.delimiter, header_line: options.csv?.header_line }) : null),
    [file, options.csv?.delimiter, options.csv?.header_line]
  );
  const asking = step === 'statement' || step === 'order' || step === 'mapping';
  const read = useMemo<ReadResult | null>(
    () => (file && asking ? readImport(file.text, { format: file.format, options, thisYear, ...(csvTable ? { table: csvTable, limit: LIVE_ROWS } : {}) }) : null),
    [file, options, thisYear, csvTable, asking]
  );

  /** Asks the server for the review, with these answers, choices and period. */
  async function requestReview(next: ImportOptions, picked: Picked | null = file, chosen = choices, conflictChoices = conflicts, period = covers) {
    if (!picked || !account) return;
    setBusy(true);
    setError('');
    try {
      const { res, data } = await postForm(
        {
          action: 'preview',
          account_id: account.account_id,
          options: next,
          choices: { proposals: wire(chosen), conflicts: wire(conflictChoices) },
          ...(period ? { covers: period } : {}),
          ...(whole ? { whole: true } : {}),
        },
        picked
      );
      if (res.ok && data?.preview) {
        setReview(data.preview);
        setChoices(chosen);
        setSentChoices(chosen);
        setConflicts(conflictChoices);
        setAcknowledged(false);
        setStep('review');
        return;
      }
      if (res.ok && data?.needs) {
        setStep(data.needs === 'statement' ? 'statement' : data.needs === 'date_order' && picked.format === 'qif' ? 'order' : 'mapping');
        return;
      }
      setError(data?.error ?? 'The file couldn’t be checked. Please try again.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  function proceed(next: ImportOptions, picked: Picked, remembered = false) {
    setOptions(next);
    const r = readImport(picked.text, { format: picked.format, options: next, thisYear, ...(picked.format === 'csv' ? { limit: LIVE_ROWS } : {}) });
    if (r.status === 'error') {
      setError(r.error);
      setStep('pick');
      return;
    }
    if (r.status === 'statement') return setStep('statement');
    if (r.status === 'mapping') {
      setOptions({ ...next, csv: { columns: draftColumns(r.table.header), sign: next.csv?.sign ?? 'negative-out', delimiter: r.table.delimiter } });
      return setStep('mapping');
    }
    if (r.status === 'date_order') return setStep(picked.format === 'csv' ? 'mapping' : 'order');
    if (picked.format === 'csv' && !remembered) return setStep('mapping');
    void requestReview(next, picked, NONE(), NONE(), null);
  }

  async function pick(f: File | null) {
    setError('');
    setNotice('');
    setDone(null);
    if (!f || !account) return;
    if (f.size > MAX_FILE_BYTES) {
      setError(`This file is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB, more than one import takes. Export a shorter period and import it in parts.`);
      return;
    }
    if (f.size === 0) {
      setError('This file is empty.');
      return;
    }
    setBusy(true);
    try {
      const { text, encoding } = decodeFile(new Uint8Array(await f.arrayBuffer()));
      const picked: Picked = { name: f.name, blob: f, text, encoding, format: detectFormat(text) };
      setFile(picked);
      setChoices(NONE);
      setSentChoices(NONE);
      setConflicts(NONE);
      setCovers(null);
      setWhole(false);
      // What this account's last file of the same kind taught; else the
      // account's own currency for a file that doesn't say one (from the
      // server, for an account opened from the Accounts that ended card).
      const s = past?.settings ?? null;
      const currency = account.currency ?? past?.currency ?? null;
      const own = currency && isCurrencyCode(currency) ? { currency } : {};
      let next: ImportOptions = picked.format === 'ofx' ? {} : own;
      let remembered = false;
      if (picked.format === 'ofx' && s?.ofx) next = { ...(s.ofx.flip ? { flip: true } : {}), ...(s.ofx.currency ? { currency: s.ofx.currency } : {}) };
      if (picked.format === 'qif' && s?.qif) {
        next = { flip: s.qif.flip || undefined, currency: s.qif.currency, ...(s.qif.date_order ? { date_order: s.qif.date_order } : {}), ...(s.qif.decimal ? { decimal: s.qif.decimal } : {}) };
      }
      if (picked.format === 'csv' && s?.csv) {
        const delimiter = (DELIMITERS as readonly string[]).includes(s.csv.delimiter) ? (s.csv.delimiter as Delimiter) : undefined;
        const table = readCsvTable(text, { delimiter });
        const columns = 'error' in table ? null : columnsFromNames(s.csv.columns, table.header);
        if (columns) {
          remembered = true;
          next = {
            csv: { columns, sign: s.csv.sign, ...(delimiter ? { delimiter } : {}) },
            currency: s.csv.currency,
            ...(s.csv.decimal ? { decimal: s.csv.decimal } : {}),
            ...(s.csv.date_order ? { date_order: s.csv.date_order } : {}),
          };
        }
      }
      proceed(next, picked, remembered);
    } catch {
      setError('This file couldn’t be read.');
    } finally {
      setBusy(false);
    }
  }

  async function importNow() {
    if (!file || !account || !review || busy) return;
    setBusy(true);
    setError('');
    try {
      const { res, data } = await postForm(
        {
          action: 'import',
          account_id: account.account_id,
          options,
          choices: { proposals: wire(choices), conflicts: wire(conflicts) },
          ...(covers ? { covers } : {}),
          ...(whole ? { whole: true } : {}),
          review: review.review,
          acknowledge_account: acknowledged,
        },
        file
      );
      if (res.ok) {
        setDone(data);
        setStep('done');
        onImported();
        void loadPast(account.account_id);
        return;
      }
      if (res.status === 409 && (data?.needs === 'review' || data?.needs === 'answers')) {
        // The account changed since (or answers are missing): the review as it is now.
        await requestReview(options, file, choices, conflicts, covers);
        setError(data.error);
        return;
      }
      setError(data?.error ?? 'The file couldn’t be imported. Please try again.');
    } catch {
      // Back to the list of imports, which says whether it went in.
      setStep('pick');
      setError('Could not reach the server, so it may not have been imported. The list of imports below shows whether it was; if it isn’t there, choose the file again.');
      void loadPast(account.account_id);
    } finally {
      setBusy(false);
    }
  }

  async function askUndo(item: Listed) {
    if (!account) return;
    setUndoing(item);
    setUndoPlan(null);
    try {
      const res = await fetch(`/api/history-import?account_id=${encodeURIComponent(account.account_id)}&undo=${encodeURIComponent(item.id)}`);
      const data = await res.json().catch(() => null);
      setUndoPlan(res.ok && data?.undo ? { plan: data.undo, error: '' } : { plan: null, error: data?.error ?? 'What undoing it would do couldn’t be worked out. Please try again.' });
    } catch {
      setUndoPlan({ plan: null, error: 'Could not reach the server.' });
    }
  }

  async function undo(item: Listed) {
    if (!account || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/history-import', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: account.account_id, import_id: item.id, confirm: true }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        const parts = [`${plural(data?.removed ?? 0, 'transaction')} removed`];
        if (data?.duplicates > 0) parts.push(`${data.duplicates.toLocaleString()} kept as the bank’s removed too`);
        if (data?.kept > 0) parts.push(`${data.kept.toLocaleString()} kept for a later import`);
        setNotice(`Undone: ${parts.join(', ')}. The estimated history is drawn again without it.`);
        setUndoing(null);
        setUndoPlan(null);
        onImported();
      } else setError(data?.error ?? 'The import couldn’t be undone. Please try again.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
      void loadPast(account.account_id);
    }
  }

  function chooseAgain() {
    setFile(null);
    setInputKey((k) => k + 1);
    setOptions({});
    setReview(null);
    setDone(null);
    setError('');
    setChoices(NONE);
    setSentChoices(NONE);
    setConflicts(NONE);
    setCovers(null);
    setWhole(false);
    setStep('pick');
  }

  if (!shown) return null;
  const back =
    step === 'statement' || step === 'mapping' || step === 'order'
      ? chooseAgain
      : step === 'review'
        ? () => (file?.format === 'csv' ? setStep('mapping') : chooseAgain())
        : undefined;

  return (
    <Sheet open={!!target} title={step === 'done' ? 'Imported' : `Import ${name}’s history`} onClose={() => !busy && onClose()} onBack={busy ? undefined : back}>
      {step === 'pick' && (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            Bring in years of {name}’s transactions from files {shown.institution_name} lets you download, to see further back than it shares with Nya. OFX or QFX is
            best (each transaction carries the bank’s own id, so importing a period again adds nothing twice), or CSV or QIF. Up to{' '}
            {MAX_FILE_BYTES / (1024 * 1024)} MB and {MAX_IMPORT_ROWS.toLocaleString()} transactions a file.
          </p>
          <p className="panel-note">
            Transactions {shown.institution_name} already gave Nya, and those an earlier file brought in, are found and shown beside the file’s, for you to
            confirm, before anything is kept.
          </p>
          {past?.history_pending && <HistoryPendingNote bank={shown.institution_name} />}
          {past?.bank_from && (
            <p className="panel-note">
              {shown.institution_name}’s own transactions for this connection start on {fmtDay(past.bank_from)}. Export a period that reaches up to that day, or
              past it, so no days fall between the two.
            </p>
          )}
          {past && !past.walked && (
            <p className="panel-note">
              Rows imported into {name} show as its activity. They don’t change its estimated balance history: a market’s moves and a loan’s interest aren’t
              transactions.
            </p>
          )}
          {past?.reach?.reach && <p className="panel-note">The estimated history reaches back to {fmtDay(past.reach.reach)} through what you imported.</p>}
          <div className="sheet-form">
            <label className="field">
              File to import into {name}
              <input
                key={inputKey}
                type="file"
                accept=".ofx,.qfx,.csv,.tsv,.txt,.qif,text/csv,application/x-ofx,application/vnd.intu.qfx,application/qif"
                onChange={(e) => void pick(e.target.files?.[0] ?? null)}
                disabled={busy}
              />
            </label>
          </div>
          {busy && <p className="panel-note">Reading the file…</p>}
          {error && <div className="error">{error}</div>}
          {notice && <p className="status-note">{notice}</p>}
          <PastHistoryImports
            past={past}
            error={pastError}
            account={name}
            bank={shown.institution_name}
            busy={busy}
            undoing={undoing}
            plan={undoPlan}
            onUndo={(i) => void askUndo(i)}
            onKeep={() => {
              setUndoing(null);
              setUndoPlan(null);
            }}
            onConfirm={(i) => void undo(i)}
          />
        </>
      )}

      {step === 'statement' && read?.status === 'statement' && file && (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            This file holds {read.statements.length} {file.format === 'qif' ? 'accounts' : 'statements'}. Which one is {name}’s?
          </p>
          <div className="button-stack" style={{ marginTop: 12 }}>
            {read.statements.map((s) => (
              <button key={s.index} className="secondary import-choice" disabled={busy} onClick={() => proceed({ ...options, statement: s.index }, file)}>
                <span>{s.label}</span>
                <span className="import-choice-meta">
                  {plural(s.count, 'transaction')}
                  {fmtRange(s.start, s.end) ? ` · ${fmtRange(s.start, s.end)}` : ''}
                  {s.currency ? ` · ${s.currency}` : ''}
                </span>
              </button>
            ))}
          </div>
          {error && <div className="error">{error}</div>}
        </>
      )}

      {step === 'order' && file && (
        <>
          <DateOrderQuestion read={read} options={options} onChange={(o) => setOptions(o)} />
          {error && <div className="error">{error}</div>}
          <div className="button-pair" style={{ marginTop: 16 }}>
            <button className="secondary" onClick={chooseAgain} disabled={busy}>
              Another file
            </button>
            <button onClick={() => void requestReview(options)} disabled={busy || read?.status !== 'ready'}>
              {busy ? 'Checking…' : 'Next'}
            </button>
          </div>
        </>
      )}

      {step === 'mapping' && file && (
        <CsvMapping file={file} read={read} table={csvTable} options={options} setOptions={setOptions} account={name} busy={busy} error={error} onNext={() => void requestReview(options)} />
      )}

      {step === 'review' && review && file && (
        <ReviewView
          review={review}
          file={file}
          options={options}
          account={shown}
          busy={busy}
          error={error}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
          choices={choices}
          sentChoices={sentChoices}
          onChoose={(index, choice) => setChoices({ ...choices, each: { ...choices.each, [String(index)]: choice } })}
          onChooseAll={(choice) => void requestReview(options, file, { all: choice, each: {} }, conflicts, covers)}
          conflicts={conflicts}
          onConflict={(index, choice) => void requestReview(options, file, choices, { ...conflicts, each: { ...conflicts.each, [String(index)]: choice } }, covers)}
          onConflictAll={(choice) => void requestReview(options, file, choices, { all: choice, each: {} }, covers)}
          onCovers={(period) => {
            setCovers(period);
            void requestReview(options, file, choices, conflicts, period);
          }}
          whole={whole}
          onWhole={setWhole}
          onFlip={(flip) => {
            const next = { ...options, flip: flip || undefined };
            setOptions(next);
            void requestReview(next, file, NONE(), NONE(), covers);
          }}
          onImport={() => void importNow()}
          onBack={() => (file.format === 'csv' ? setStep('mapping') : chooseAgain())}
        />
      )}

      {step === 'done' && done && (
        <>
          <p className="import-headline">
            {done.imported > 0 ? `${plural(done.imported, 'transaction')} imported into ${name}` : `Nothing new: everything in this file is already in ${name}`}
          </p>
          <p className="panel-note">
            {[
              done.duplicates > 0 ? `${done.duplicates.toLocaleString()} kept as ${shown.institution_name}’s own, not counted twice` : null,
              (done.already ?? 0) > 0 ? `${done.already!.toLocaleString()} kept as rows an earlier file brought in, not counted twice` : null,
              done.present > 0 ? `${done.present.toLocaleString()} already imported` : null,
              done.skipped > 0 ? `${done.skipped.toLocaleString()} skipped` : null,
              done.repeated > 0 ? `${done.repeated.toLocaleString()} listed twice in the file` : null,
              done.unreadable > 0 ? `${plural(done.unreadable, 'line')} not read` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'Every row in the file was read.'}
          </p>
          {done.history.drawn && done.history.reach && (
            <p className="status-note">{name}’s estimated history now reaches back to {fmtDay(done.history.reach)}, through what you imported.</p>
          )}
          {done.history.backfill && done.imported > 0 && (
            <p className="panel-note">The estimated history is being worked out again with these transactions: the chart shows them in a moment.</p>
          )}
          {!done.history.drawn && !done.history.backfill && done.imported > 0 && past?.walked !== false && (
            <p className="panel-note">The net worth chart is drawn back through it on the next load.</p>
          )}
          <p className="panel-note">
            The last year of them shows on the Activity tab, marked as imported. Where {shown.institution_name} later sends the same transactions, its own take their
            place. If this was the wrong file, undo it below.
          </p>
          <PastHistoryImports
            past={past}
            error={pastError}
            account={name}
            bank={shown.institution_name}
            busy={busy}
            undoing={undoing}
            plan={undoPlan}
            onUndo={(i) => void askUndo(i)}
            onKeep={() => {
              setUndoing(null);
              setUndoPlan(null);
            }}
            onConfirm={(i) => void undo(i)}
          />
          {error && <div className="error">{error}</div>}
          {notice && <p className="status-note">{notice}</p>}
          <div className="button-pair" style={{ marginTop: 16 }}>
            <button className="secondary" onClick={chooseAgain} disabled={busy}>
              Import another
            </button>
            <button onClick={onClose} disabled={busy}>
              Done
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** The review: what importing the file would do, with every proposal to
 *  confirm or change. */
export function ReviewView({
  review: r,
  file,
  options,
  account,
  busy,
  error,
  acknowledged,
  onAcknowledge,
  choices,
  sentChoices,
  onChoose,
  onChooseAll,
  conflicts,
  onConflict,
  onConflictAll,
  onCovers,
  whole = false,
  onWhole = () => {},
  onFlip,
  onImport,
  onBack,
}: {
  review: Review;
  file: Picked;
  options: ImportOptions;
  account: HistoryImportTarget;
  busy: boolean;
  error: string;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  choices: ChoiceSet<Choice>;
  sentChoices: ChoiceSet<Choice>;
  onChoose: (index: number, choice: Choice) => void;
  onChooseAll: (choice: Choice) => void;
  conflicts: ChoiceSet<ConflictChoice>;
  onConflict: (index: number, choice: ConflictChoice) => void;
  onConflictAll: (choice: ConflictChoice) => void;
  onCovers: (period: { from: string; to: string }) => void;
  /** The person says the lines that can't be read aren't transactions. */
  whole?: boolean;
  onWhole?: (v: boolean) => void;
  onFlip: (flip: boolean) => void;
  onImport: () => void;
  onBack: () => void;
}) {
  const [editingPeriod, setEditingPeriod] = useState<{ from: string; to: string } | null>(null);
  const [allProblems, setAllProblems] = useState(false);
  const name = account.name;
  const bank = account.institution_name;
  const c = countsNow(r, sentChoices, choices);
  const waiting = c.conflicts + c.unanswered;
  const blocked = !!r.account_mismatch && !acknowledged;
  const canImport = c.new + c.duplicates + c.already > 0 && waiting === 0;
  const kinds = kindsText(r.kinds);
  const shownProblems = allProblems ? r.problems : r.problems.slice(0, 5);
  const total = r.proposals.length + r.more_proposals;
  return (
    <>
      <p className="import-headline" style={{ marginTop: 0 }}>
        {c.new > 0 ? plural(c.new, 'new transaction') : `Nothing new to import into ${name}`}
      </p>
      <p className="panel-note" style={{ marginTop: 4 }}>
        {[
          c.duplicates > 0 ? `${c.duplicates.toLocaleString()} ${c.duplicates === 1 ? 'is' : 'are'} ${bank}’s own` : null,
          c.already > 0 ? `${c.already.toLocaleString()} ${c.already === 1 ? 'is' : 'are'} already in from another file` : null,
          c.present > 0 ? `${c.present.toLocaleString()} already imported` : null,
          waiting > 0 ? `${plural(waiting, 'row')} to decide` : null,
          c.skipped > 0 ? `${c.skipped.toLocaleString()} skipped` : null,
          c.repeated > 0 ? `${c.repeated.toLocaleString()} listed twice in the file` : null,
          c.unreadable > 0 ? `${plural(c.unreadable, 'line')} can’t be read` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Every row in the file reads.'}
      </p>
      {r.bank_from ? (
        <p className="panel-note">
          {r.before_bank > 0 ? `${plural(r.before_bank, 'new transaction')} ${r.before_bank === 1 ? 'is' : 'are'} older than ${bank}’s own (from ${fmtDay(r.bank_from)}): history it never gave.` : `None of the new rows is older than ${bank}’s own (from ${fmtDay(r.bank_from)}).`}
          {r.within_bank > 0 ? ` ${plural(r.within_bank, 'new transaction')} ${r.within_bank === 1 ? 'falls' : 'fall'} in its period, though it has nothing like ${r.within_bank === 1 ? 'it' : 'them'}.` : ''}
        </p>
      ) : (
        <p className="panel-note">{bank} hasn’t given Nya any of {name}’s transactions, so every row is matched against earlier imports only.</p>
      )}
      {r.history_pending && <HistoryPendingNote bank={bank} />}
      {r.pending_alike > 0 && (
        <p className="panel-note">
          {plural(r.pending_alike, 'row')} {r.pending_alike === 1 ? 'looks' : 'look'} like a transaction still pending at {bank}: once it posts, {bank}’s takes its place.
        </p>
      )}
      {r.covers && !editingPeriod && (
        <p className="panel-note">
          The file covers {fmtRange(r.covers.from, r.covers.to)}
          {r.covers.stated ? ', as you said' : r.format === 'ofx' ? ', its statement’s period' : ', its first to last day'}. The estimated history is drawn only across days a
          file or the bank covers.{' '}
          <button className="link-btn" disabled={busy} onClick={() => setEditingPeriod({ from: r.covers!.from, to: r.covers!.to })}>
            Change
          </button>
        </p>
      )}
      {r.covers && c.unreadable > 0 && (
        <>
          <label className="quick-add-check">
            <input type="checkbox" checked={whole} disabled={busy} onChange={(e) => onWhole(e.target.checked)} />
            <span>
              The {plural(c.unreadable, 'line')} that can’t be read {c.unreadable === 1 ? 'isn’t a transaction' : 'aren’t transactions'} (a total, a title): draw the
              estimated history through this file’s period
            </span>
          </label>
          {!whole && (
            <p className="panel-note">
              Until you say so, this file’s period isn’t used to draw the estimated history: it may lack {c.unreadable === 1 ? 'that line’s transaction' : 'those lines’ transactions'}.
            </p>
          )}
        </>
      )}
      {editingPeriod && (
        <div className="sheet-form history-import-period">
          <p className="panel-note" style={{ marginTop: 0 }}>
            The period you exported, if it is longer than the rows show (a statement whose first or last days had no transactions). It must hold every row.
          </p>
          <label className="field">
            From
            <input type="date" value={editingPeriod.from} max={r.first_date ?? undefined} onChange={(e) => setEditingPeriod({ ...editingPeriod, from: e.target.value })} disabled={busy} />
          </label>
          <label className="field">
            To
            <input type="date" value={editingPeriod.to} min={r.last_date ?? undefined} onChange={(e) => setEditingPeriod({ ...editingPeriod, to: e.target.value })} disabled={busy} />
          </label>
          <div className="button-pair">
            <button className="secondary" onClick={() => setEditingPeriod(null)} disabled={busy}>
              Cancel
            </button>
            <button
              disabled={busy || !editingPeriod.from || !editingPeriod.to}
              onClick={() => {
                onCovers(editingPeriod);
                setEditingPeriod(null);
              }}
            >
              Use this period
            </button>
          </div>
        </div>
      )}
      {r.other_currencies.length > 0 && (
        <p className="panel-note">
          {r.other_currencies.map((o) => `${plural(o.count, 'row')} in ${o.currency}`).join(', ')}: shown in their own currency, never added into totals in {r.currency}.
        </p>
      )}
      {kinds && <p className="panel-note">{kinds}</p>}
      {r.warnings.map((w) => (
        <p key={w} className="stale-note">
          {w}
        </p>
      ))}
      {r.account_mismatch && (
        <>
          <p className="stale-note">
            {r.account_mismatch.basis === 'mask'
              ? `This file is for ${r.account_mismatch.found}, but ${name} is ${r.account_mismatch.expected}.`
              : `This file is for ${r.account_mismatch.found}, but ${name}’s last OFX file was for ${r.account_mismatch.expected}.`}
          </p>
          <label className="quick-add-check">
            <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(e) => onAcknowledge(e.target.checked)} />
            <span>It’s the right file: import it into {name}</span>
          </label>
        </>
      )}
      {(r.format === 'ofx' || r.format === 'qif') && (
        <label className="quick-add-check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={options.flip === true} disabled={busy} onChange={(e) => onFlip(e.target.checked)} />
          <span>Read every amount the other way round (for a bank that writes them so)</span>
        </label>
      )}

      {total > 0 && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            {r.proposals.some((p) => p.twin.kind === 'imported') ? 'Likely already here' : `Likely already from ${bank}`}
          </p>
          <p className="panel-note" style={{ marginTop: 0 }}>
            {total === 1 ? 'This row has' : `These ${total.toLocaleString()} rows have`} the same amount as a transaction {bank} gave Nya
            {r.proposals.some((p) => p.twin.kind === 'imported') ? ' or an earlier file brought in' : ''}, dated a few days apart at most. The same transaction is kept
            once, as the one already here; one of its own is kept beside it. Nothing is merged without your say: check the ones that need an answer.
          </p>
          {total > 1 && (
            <div className="import-choices" role="group" aria-label="For every row">
              <button className="secondary" disabled={busy} aria-pressed={choices.all === 'same' && Object.keys(choices.each).length === 0} onClick={() => onChooseAll('same')}>
                All the same
              </button>
              <button className="secondary" disabled={busy} aria-pressed={choices.all === 'new' && Object.keys(choices.each).length === 0} onClick={() => onChooseAll('new')}>
                All their own
              </button>
            </div>
          )}
          <ul className="import-rows import-conflicts">
            {r.proposals.map((p) => {
              const chosen = choiceOf(choices, p);
              return (
                <li key={p.index}>
                  <div className="import-row-text">
                    <div className="import-row-meta">In the file{p.line ? ` (line ${p.line})` : ''}</div>
                    <div className="import-conflict-version">
                      <span className="import-row-name">{p.file.name}</span>
                      <span className={`import-row-amount${p.file.amount < 0 ? ' inflow' : ''}`}><Masked>{fmtAmount(p.file.amount, p.file.currency)}</Masked></span>
                    </div>
                    <div className="import-row-meta">{fmtDay(p.file.date)}</div>
                    <div className="import-row-meta" style={{ marginTop: 6 }}>
                      {p.twin.kind === 'imported'
                        ? `Imported from ${p.twin.file_name ?? 'an earlier file'}${p.twin.imported_at ? ` on ${instantDay(p.twin.imported_at) ?? p.twin.imported_at.slice(0, 10)}` : ''}`
                        : `From ${bank}`}
                    </div>
                    <div className="import-conflict-version">
                      <span className="import-row-name">{p.twin.name}</span>
                      <span className={`import-row-amount${p.twin.amount < 0 ? ' inflow' : ''}`}><Masked>{fmtAmount(p.twin.amount, p.twin.currency ?? p.file.currency)}</Masked></span>
                    </div>
                    <div className="import-row-meta">
                      {fmtDay(p.twin.date)}
                      {p.twin.descriptor && p.twin.descriptor !== p.twin.name ? ` · ${p.twin.descriptor}` : ''}
                    </div>
                    <div className="import-row-meta">
                      {p.days === 0 ? 'The same day' : `${plural(p.days, 'day')} apart`}
                      {p.similar ? ', alike in name' : ''} · {CONFIDENCE_TEXT[p.confidence]}
                      {chosen === null ? ' · choose one' : ''}
                    </div>
                    {p.edge && <div className="import-row-meta">{edgeText(p.edge, bank)}.</div>}
                    <div className="import-choices" role="group" aria-label={`What ${p.file.name} is`}>
                      <button className="secondary" disabled={busy} aria-pressed={chosen === 'same'} onClick={() => onChoose(p.index, 'same')}>
                        The same
                      </button>
                      <button className="secondary" disabled={busy} aria-pressed={chosen === 'new'} onClick={() => onChoose(p.index, 'new')}>
                        Its own
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {r.more_proposals > 0 && (
            <p className="panel-note">
              {plural(r.more_proposals, 'more row')} like these {r.more_proposals === 1 ? 'isn’t' : 'aren’t'} listed: {r.more_proposals === 1 ? 'it follows' : 'they follow'} the
              choice for every row above, or else {r.more_proposals === 1 ? 'is' : 'are'} kept as the one already here unless only possibly the same.
            </p>
          )}
        </>
      )}

      {r.conflicts.length > 0 && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            Bank ids already imported
          </p>
          <p className="panel-note" style={{ marginTop: 0 }}>
            {r.conflicts.length + r.more_conflicts === 1 ? 'This row has' : 'These rows have'} the bank’s id (FITID) of a transaction an earlier import kept, but{' '}
            {r.conflicts.length + r.more_conflicts === 1 ? 'doesn’t' : 'don’t'} match it. Some banks number each download from 1 again. Import a row as a new
            transaction, or skip it.
          </p>
          {r.conflicts.length + r.more_conflicts > 1 && (
            <div className="import-choices" role="group" aria-label="For every bank id">
              <button className="secondary" disabled={busy} onClick={() => onConflictAll('new')}>
                All as new
              </button>
              <button className="secondary" disabled={busy} onClick={() => onConflictAll('skip')}>
                Skip all
              </button>
            </div>
          )}
          <ul className="import-rows import-conflicts">
            {r.conflicts.map((x) => (
              <li key={x.index}>
                <div className="import-row-text">
                  <div className="import-conflict-version">
                    <span className="import-row-name">{x.file.name}</span>
                    <span className={`import-row-amount${x.file.amount < 0 ? ' inflow' : ''}`}><Masked>{fmtAmount(x.file.amount, x.file.currency)}</Masked></span>
                  </div>
                  <div className="import-row-meta">
                    {fmtDay(x.file.date)} · already imported: {x.stored.name}, {fmtDay(x.stored.date)}, <Masked>{fmtAmount(x.stored.amount, x.stored.currency)}</Masked>
                    {(conflicts.each[String(x.index)] ?? conflicts.all ?? x.suggested) === null ? ' · choose one' : ''}
                  </div>
                  <div className="import-choices" role="group" aria-label={`What to do with ${x.file.name}`}>
                    {(['new', 'skip'] as ConflictChoice[]).map((choice) => (
                      <button key={choice} className="secondary" disabled={busy} aria-pressed={x.choice === choice} onClick={() => onConflict(x.index, choice)}>
                        {choice === 'new' ? 'Import as new' : 'Skip'}
                      </button>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="section-label" style={{ marginTop: 16 }}>
        The first rows, as they will be read
      </p>
      {r.rows.length === 0 ? (
        <p className="empty-note">No row in this file could be read.</p>
      ) : (
        <ul className="import-rows">
          {r.rows.map((row, i) => (
            <li key={`${row.line}-${i}`} className={row.outcome === 'new' ? undefined : 'import-row-skipped'}>
              <div className="import-row-text">
                <div className="import-row-name">{row.name}</div>
                <div className="import-row-meta">
                  {fmtDay(row.date)}
                  {row.category ? ` · ${row.category}` : ''} · {OUTCOME_TEXT[row.outcome] ?? row.outcome}
                </div>
              </div>
              <div className={`import-row-amount${row.amount < 0 ? ' inflow' : ''}`}><Masked>{fmtAmount(row.amount, row.currency)}</Masked></div>
            </li>
          ))}
        </ul>
      )}

      {r.problems.length > 0 && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            Lines that can’t be read
          </p>
          <ul className="import-problems">
            {shownProblems.map((pr, i) => (
              <li key={`${pr.line}-${i}`}>
                {pr.line > 0 ? `Line ${pr.line}: ` : ''}
                <Masked>{shownReason(pr.reason)}</Masked>
              </li>
            ))}
          </ul>
          {!allProblems && r.problems.length > 5 && (
            <button className="link-btn" onClick={() => setAllProblems(true)}>
              Show all {r.problems.length.toLocaleString()}
              {r.more_problems > 0 ? ` (and ${r.more_problems.toLocaleString()} more not listed)` : ''}
            </button>
          )}
        </>
      )}

      {c.new > 0 && r.currency && sentChoices === choices && (
        <p className="panel-note" style={{ marginTop: 12 }}>
          New: <Masked>{formatMoney(r.totals.out, r.currency)}</Masked> out, <Masked>{formatMoney(r.totals.in, r.currency)}</Masked> in
        </p>
      )}
      <p className="panel-note">
        Importing never changes {name}’s balance or what was recorded of it: the rows are kept apart from {bank}’s, and only the estimated part of the chart is drawn
        from them. You can undo an import from this sheet.
      </p>
      {waiting > 0 && <p className="stale-note">Say what {waiting === 1 ? 'the row above is' : `the ${waiting.toLocaleString()} rows above are`}, then import.</p>}
      {error && <div className="error">{error}</div>}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onBack} disabled={busy}>
          {file.format === 'csv' ? 'Columns' : 'Another file'}
        </button>
        <button onClick={onImport} disabled={busy || !canImport || blocked}>
          {busy ? 'Importing…' : c.new > 0 ? `Import ${plural(c.new, 'transaction')}` : c.duplicates > 0 ? 'Keep as the bank’s' : 'Nothing to import'}
        </button>
      </div>
    </>
  );
}

const OUTCOME_TEXT: Record<string, string> = {
  new: 'new',
  present: 'already imported',
  repeated: 'listed twice in the file',
  duplicate: 'the bank’s own, kept once',
  ask: 'to decide',
  skip: 'skipped',
};

/** The account's past imports, newest first, each with Undo and its
 *  confirmation. */
function PastHistoryImports({
  past,
  error,
  account,
  bank,
  busy,
  undoing,
  plan,
  onUndo,
  onKeep,
  onConfirm,
}: {
  past: Past | null;
  error: string;
  account: string;
  bank: string;
  busy: boolean;
  undoing: Listed | null;
  plan: { plan: UndoPlan | null; error: string } | null;
  onUndo: (i: Listed) => void;
  onKeep: () => void;
  onConfirm: (i: Listed) => void;
}) {
  if (error) return <p className="panel-note">{error}</p>;
  if (!past || past.imports.length === 0) return null;
  return (
    <>
      <p className="section-label" style={{ marginTop: 20 }}>
        Past imports into {account}
      </p>
      <ul className="import-past">
        {past.imports.map((i) => {
          const title = i.file_name ?? (i.format ? `${FORMAT_NAMES[i.format]} file` : 'An import');
          const confirming = undoing?.id === i.id;
          return (
            <li key={i.id}>
              <div className="import-past-head">
                <span className="import-row-name">{title}</span>
                {!confirming && i.record !== 'unrecognised' && (
                  <button className="link-btn danger-link" disabled={busy} onClick={() => onUndo(i)}>
                    Undo
                  </button>
                )}
              </div>
              <div className="import-row-meta">
                {[
                  i.imported_at ? `Imported ${instantDay(i.imported_at) ?? i.imported_at.slice(0, 10)}` : null,
                  i.counts ? `${plural(i.counts.imported, 'transaction')} added` : null,
                  i.covers ? `covers ${fmtRange(i.covers.from, i.covers.to)}` : fmtRange(i.first_date, i.last_date),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {(i.superseded_now ?? 0) > 0 && (
                <div className="import-row-meta">
                  {plural(i.superseded_now!, 'of them', 'of them')} {i.superseded_now === 1 ? 'is' : 'are'} now {bank}’s own, sent since: counted once, as {bank}’s.
                </div>
              )}
              {(i.returned_now ?? 0) > 0 && (
                <div className="import-row-meta">
                  {plural(i.returned_now!, 'row')} kept as already here {i.returned_now === 1 ? 'counts' : 'count'} again: {bank} no longer has{' '}
                  {i.returned_now === 1 ? 'it' : 'them'}, or the file {i.returned_now === 1 ? 'it was' : 'they were'} in was undone.
                </div>
              )}
              {i.taken_over > 0 && <div className="import-row-meta">{plural(i.taken_over, 'transaction')} an earlier import added {i.taken_over === 1 ? 'is' : 'are'} kept for this one.</div>}
              {i.record === 'unreadable' && <div className="import-row-meta">Its record can’t be read; Undo still takes its transactions out.</div>}
              {i.record === 'missing' && <div className="import-row-meta">Its record is gone; Undo still takes its transactions out.</div>}
              {i.record === 'unrecognised' && <div className="import-row-meta">A newer version of Nya saved it, so it can’t be undone here.</div>}
              {confirming && (
                <div className="import-confirm">
                  {!plan ? (
                    <p className="panel-note" style={{ marginTop: 6 }}>
                      Working out what undoing it would do…
                    </p>
                  ) : plan.error || !plan.plan ? (
                    <div className="error">{plan.error}</div>
                  ) : (
                    <p className="panel-note" style={{ marginTop: 6 }}>
                      {undoText(plan.plan)} What you said about them (a category, an exclusion, a split) goes with them, they leave any group they’re in, and the estimated history is drawn again without them. The
                      balance stays as it is. This can’t be undone.
                    </p>
                  )}
                  <div className="button-pair" style={{ marginTop: 8 }}>
                    <button className="secondary" onClick={onKeep} disabled={busy}>
                      Keep it
                    </button>
                    <button className="danger" onClick={() => onConfirm(i)} disabled={busy || !plan?.plan}>
                      {busy ? 'Undoing…' : 'Undo import'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** That the connection's older transactions are still on their way to Nya,
 *  and what importing before they arrive means. */
function HistoryPendingNote({ bank }: { bank: string }) {
  return (
    <p className="panel-note">
      {bank} is still sending this connection’s older transactions to Nya: it was linked recently. You can import now. Transactions {bank} sends later take the
      place of the imported ones, and a category or an exclusion you set on those carries over.
    </p>
  );
}

/** What an undo will do, in sentences, for its confirmation. */
export function undoText(p: UndoPlan): string {
  const parts: string[] = [];
  if (p.remove === 0 && p.duplicates === 0 && p.kept.length === 0) parts.push('None of its transactions is left. Undo removes its record.');
  else parts.push(p.remove > 0 ? `Remove the ${plural(p.remove, 'transaction')} this import added?` : 'Undo this import?');
  if (p.duplicates > 0) parts.push(`The ${plural(p.duplicates, 'row')} it kept as the bank’s own ${p.duplicates === 1 ? 'goes' : 'go'} too; the bank’s stay.`);
  for (const k of p.kept) {
    parts.push(
      `${plural(k.count, 'more transaction')} ${k.count === 1 ? 'stays' : 'stay'}: ${k.file_name ?? 'a later import'} found ${k.count === 1 ? 'it' : 'them'} already here, so ${k.count === 1 ? 'it is' : 'they are'} kept for that import.`
    );
  }
  if (p.record === 'unreadable') parts.push('Its record can’t be read, and goes too.');
  if (p.incomplete) parts.push('Some of this account’s imported transactions can’t be read now: any of its there stay.');
  return parts.join(' ');
}
