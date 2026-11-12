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
//
// On an investment account at Vanguard (`vanguard`, by Plaid's institution
// id) the picker also takes Vanguard's Performance page as a PDF, read on
// this device into the account's months (components/PerformanceImport.tsx):
// a step of its own, 'months', with its review and its Import in the
// footer, and its imports listed with the transaction files'. It also takes
// Vanguard's transactions download (its CSV, or its QFX or OFX), known by
// its layout and reviewed on the server (components/TransactionsImport.tsx):
// a step of its own, 'txns', whose one Import takes every account checked,
// and waits for a yes when a QFX differs from what counts now; on an account
// at another firm that file is refused rather than read as some other file.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import { CsvMapping, DateOrderQuestion, kindsText, shownReason, type Picked } from './ImportSheet';
import { Masked } from './HideAmounts';
import { formatDay, formatInstantDay, formatMoney, onDay, signedMoney } from '@/lib/format';
import { isCurrencyCode } from '@/lib/manual-txn-input';
import { MAX_FILE_BYTES, MAX_IMPORT_ROWS, type FileFormat } from '@/lib/import/record';
import { decodeFile, detectFormat, FORMAT_NAMES } from '@/lib/import/text';
import { readImport, type ImportOptions, type ReadResult, type StatementInfo } from '@/lib/import/read';
import { columnsFromNames, DELIMITERS, guessColumns, readCsvTable, type CsvColumns, type CsvSign, type CsvTable, type Delimiter } from '@/lib/import/csv';
import type { DateOrder } from '@/lib/import/dates';
import type { DecimalMark } from '@/lib/import/amounts';
import { LevelWord, Notice } from './TotalCaveats';
import { StripSkeleton } from './FiguresStrip';
import { Why } from './Why';
import { loadInvestmentActivity, investmentImportsChanged, investmentMonthsSaved } from './InvestmentActivity';
import { isVanguardTransactions } from '@/lib/import/vanguard-transactions';
import { isVanguardQfx } from '@/lib/import/vanguard-qfx';
import type { ImportsReview } from '@/lib/investment-imports-review';
import type { ListedImport } from '@/lib/investment-imports-store';
import {
  checkedFirst,
  noneOfYours,
  qfxDiffers,
  rowsTaken,
  takeOf,
  TransactionImports,
  TransactionsNow,
  TransactionsReview,
  TXN_SOURCE,
  useTransactionImports,
} from './TransactionsImport';
import { MAX_IMPORTS_PER_ACCOUNT } from '@/lib/investment-imports';
import {
  isPdf,
  notVanguardWords,
  pdfProblem,
  PerformanceImports,
  PerformanceNow,
  PerformanceReview,
  readPdfHere,
  SOURCE,
  usePerformanceData,
  usePerformanceReview,
  type PdfReader,
} from './PerformanceImport';
import { MAX_IMPORTS, type MonthsImport } from '@/lib/investment-months';
import type { Read } from '@/lib/import/performance-review';
import { MAX_PDF_BYTES } from '@/lib/import/pdf-text';
import { localDate } from '@/lib/local-date';

/** The linked account the sheet is open on. An investment account at
 *  Vanguard (`vanguard`) also takes its Performance page as a PDF, checked
 *  against its balance now and every Vanguard account's (`vanguard_balances`). */
export type HistoryImportTarget = {
  account_id: string;
  name: string;
  institution_name: string;
  type: string;
  currency: string | null;
  item_id?: string | null;
  vanguard?: boolean;
  balance?: number | null;
  vanguard_balances?: number[];
};

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
type Step = 'pick' | 'statement' | 'mapping' | 'order' | 'review' | 'done' | 'months' | 'txns';

const NONE = <T,>(): ChoiceSet<T> => ({ each: {} });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const fmtDay = (day: string) => formatDay(day);
/** The same mid sentence: "today", "Sep 3", "Sep 3, 2025". */
const inDay = (day: string) => formatDay(day, { sentence: true });
const fmtRange = (a: string | null, b: string | null) => (a && b ? (a === b ? inDay(a) : `${inDay(a)} to ${inDay(b)}`) : null);
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
  if (edge.kind === 'before-bank') return `${bank} has nothing before ${inDay(edge.day)}: the same only if it posted days later`;
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

/** The done notice's check (as components/DemoDataCard.tsx's). */
const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const loadMonthsActivity = (id: string, item: string) => loadInvestmentActivity(id, item);

export default function HistoryImportSheet({
  target,
  onClose,
  onImported,
  readPdf = readPdfHere,
}: {
  target: HistoryImportTarget | null;
  onClose: () => void;
  /** After an import or an undo changed the account's rows, and so its
   *  estimated history; `investments` when it was Vanguard's transactions
   *  download, which changes what the Plan's inputs count. */
  onImported: (what?: { investments?: boolean }) => void;
  /** Reads a Performance page's PDF; pdf.js in the browser. */
  readPdf?: PdfReader;
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
  // A Performance page being read (`read` null) or reviewed, and what the
  // last import or undo of one said.
  const [pdf, setPdf] = useState<{ name: string; read: Read | null } | null>(null);
  const [monthsError, setMonthsError] = useState<{ level: 'critical' | 'caution'; text: string; again?: boolean } | null>(null);
  // Vanguard's transactions download being reviewed (`review` null while the
  // server checks it), the accounts checked, and what the last import, undo
  // or check of one said.
  const [txn, setTxn] = useState<{ name: string; text: string; today: string; review: ImportsReview | null } | null>(null);
  const [txnChecked, setTxnChecked] = useState<string[]>([]);
  // The person's yes to a QFX that differs from what counts now.
  const [txnYes, setTxnYes] = useState(false);
  const [txnError, setTxnError] = useState<{ level: 'critical' | 'caution'; text: string; again?: boolean } | null>(null);
  const thisYear = new Date().getFullYear();
  const account = shown;
  const name = account?.name ?? 'the account';
  const vanguard = !!account?.vanguard;
  const perf = usePerformanceData(vanguard && account ? { account_id: account.account_id, item_id: account.item_id ?? null } : null, loadMonthsActivity);
  const txns = useTransactionImports(vanguard && account ? account.account_id : null);
  const txnList = txns.list && txns.list.imports.length > 0 ? txns.list : null;
  const imported = !!perf.imports || !!txnList;
  const reviewCtx = useMemo(
    () => ({
      account_id: account?.account_id ?? '',
      name,
      currency: account?.currency ?? null,
      balance: account?.balance ?? null,
      vanguard: account?.vanguard_balances ?? [],
      imports: perf.imports,
      points: perf.points,
      activity: perf.activity,
      today: localDate(),
    }),
    [account, name, perf.imports, perf.points, perf.activity]
  );
  const monthsReview = usePerformanceReview(pdf?.read ?? null, reviewCtx, pdf?.name ?? null);

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
    setPdf(null);
    setMonthsError(null);
    setTxn(null);
    setTxnChecked([]);
    setTxnYes(false);
    setTxnError(null);
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
    setMonthsError(null);
    setTxnError(null);
    if (!f || !account) return;
    const head = new Uint8Array(await f.slice(0, 8).arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (isPdf(f.name, head)) {
      if (!account.vanguard) {
        setError(notVanguardWords(name, account.institution_name));
        return;
      }
      void readMonths(f);
      return;
    }
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
      // Vanguard's transactions download: its own review, on a Vanguard
      // account only.
      if (isVanguardTransactions(text) || isVanguardQfx(text)) {
        if (!account.vanguard)
          setError(
            /vanguard/i.test(account.institution_name)
              ? `This is ${TXN_SOURCE}, which Nya imports only into the Vanguard investment accounts it’s connected to, and ${name} isn’t one. Import it from one of those.`
              : `This is ${TXN_SOURCE}, and ${name} is at ${account.institution_name}. Import it from one of your Vanguard accounts.`
          );
        else await reviewTxns(f.name, text);
        return;
      }
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

  /** A Performance page, read here into its months for the review. */
  async function readMonths(f: File) {
    if (f.size > MAX_PDF_BYTES) {
      setError(pdfProblem({ kind: 'error', error: 'too-large' }));
      return;
    }
    setBusy(true);
    setPdf({ name: f.name, read: null });
    setStep('months');
    try {
      const outcome = await readPdf(new Uint8Array(await f.arrayBuffer()));
      if (outcome.kind !== 'read') {
        setPdf(null);
        setStep('pick');
        setError(pdfProblem(outcome));
        return;
      }
      setPdf({ name: f.name, read: outcome });
    } catch {
      setPdf(null);
      setStep('pick');
      setError(pdfProblem({ kind: 'error', error: 'unreadable' }));
    } finally {
      setBusy(false);
      setInputKey((k) => k + 1);
    }
  }

  async function importMonths() {
    const body = monthsReview.body;
    if (!account || !body || busy) return;
    setBusy(true);
    setMonthsError(null);
    try {
      const res = await fetch('/api/investment-months', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        perf.setImports(data?.investment_months ?? null);
        investmentMonthsSaved(account.account_id, account.item_id ?? '', data?.investment_months ?? null);
        setNotice(`${body.months.length.toLocaleString()} months imported from ${pdf?.name ?? SOURCE}.`);
        setPdf(null);
        setStep('pick');
        onImported();
        return;
      }
      if (res.status === 409 && data?.needs === 'undo') {
        setPdf(null);
        setStep('pick');
        setMonthsError({ level: 'caution', text: `${name} has ${MAX_IMPORTS} imports of its Performance page, the most Nya keeps. Undo an old one to import this file.` });
        return;
      }
      if (res.status === 409 && data?.needs === 'review') {
        // Checked again against what is there now: the review follows it.
        await perf.reload(account.account_id);
        setMonthsError({ level: 'caution', text: typeof data?.error === 'string' ? data.error : 'The imports changed on another device.', again: true });
        return;
      }
      setMonthsError({ level: 'critical', text: typeof data?.error === 'string' ? data.error : 'The months couldn’t be imported. Please try again.' });
    } catch {
      setPdf(null);
      setStep('pick');
      setMonthsError({
        level: 'critical',
        text: 'Could not reach the server, so the months may not have been imported. The imports below show whether they were; if not, import the file again.',
      });
      void perf.reload(account.account_id);
    } finally {
      setBusy(false);
    }
  }

  async function undoMonths(i: MonthsImport): Promise<boolean> {
    if (!account || busy) return false;
    setBusy(true);
    setMonthsError(null);
    setNotice('');
    try {
      const res = await fetch('/api/investment-months', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo', account_id: account.account_id, import_id: i.id }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        perf.setImports(data?.investment_months ?? null);
        investmentMonthsSaved(account.account_id, account.item_id ?? '', data?.investment_months ?? null);
        setNotice(`Undone: the import of ${SOURCE} from ${formatInstantDay(i.imported_at, { sentence: true }) ?? i.imported_at.slice(0, 10)}.`);
        onImported();
        return true;
      }
      setMonthsError({ level: 'critical', text: typeof data?.error === 'string' ? data.error : 'The import couldn’t be undone. Please try again.' });
      if (res.status === 404) void perf.reload(account.account_id);
      return false;
    } catch {
      setMonthsError({ level: 'critical', text: 'Could not reach the server, so it may not have been undone. The imports below show whether it was.' });
      void perf.reload(account.account_id);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Vanguard's transactions download, checked on the server against the
   *  accounts as they are. Checked again (`keep`: the accounts checked
   *  before), the person's choices stay where they still can be taken. */
  async function reviewTxns(fileName: string, text: string, keep?: string[]) {
    if (!account) return;
    setBusy(true);
    setTxnError(null);
    // The import sends the same day, so its rows are the ones reviewed.
    const today = localDate();
    setTxn({ name: fileName, text, today, review: null });
    setTxnYes(false);
    setStep('txns');
    try {
      const res = await fetch('/api/investment-imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'review', account_id: account.account_id, file_name: fileName, text, today }),
      });
      const data = await res.json().catch(() => null);
      const review: ImportsReview | null = res.ok && data?.review ? data.review : null;
      const none = review ? noneOfYours(review, name) : null;
      if (!review || none) {
        setTxn(null);
        setStep('pick');
        setError(none ?? (typeof data?.error === 'string' ? data.error : 'The file couldn’t be checked. Please try again.'));
        return;
      }
      setTxn({ name: fileName, text, today, review });
      setTxnChecked(keep ? checkedFirst(review).filter((k) => keep.includes(k)) : checkedFirst(review));
    } catch {
      setTxn(null);
      setStep('pick');
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
      setInputKey((k) => k + 1);
    }
  }

  /** After an import or an undo of the download: each account it touched
   *  loads its activity again, this sheet's too, and so do the Plan's inputs. */
  function txnsChanged(accounts: { account_id: string; item_id: string }[]) {
    investmentImportsChanged(accounts);
    perf.refreshActivity();
    onImported({ investments: true });
  }

  async function importTxns() {
    const review = txn?.review;
    if (!account || !txn || !review || busy) return;
    const take = takeOf(review, txnChecked);
    if (take.length === 0 || (qfxDiffers(review, txnChecked) && !txnYes)) return;
    const touched = review.accounts.flatMap((a) => (a.account && take.some((t) => t.account_id === a.account!.account_id) ? [{ account_id: a.account.account_id, item_id: a.account.item_id }] : []));
    setBusy(true);
    setTxnError(null);
    try {
      const res = await fetch('/api/investment-imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', account_id: account.account_id, file_name: txn.name, text: txn.text, today: txn.today, take, counting: review.fingerprint }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        txns.set(data);
        const rows = rowsTaken(review, txnChecked);
        setNotice(`${plural(rows, 'transaction')} imported into ${plural(take.length, 'account')} from ${txn.name}.`);
        setTxn(null);
        setStep('pick');
        txnsChanged(touched);
        return;
      }
      if (res.status === 409 && data?.needs === 'review') {
        setTxnError({ level: 'caution', text: typeof data?.error === 'string' ? data.error : 'The imports changed on another device.', again: true });
        return;
      }
      if (res.status === 409 && data?.needs === 'undo') {
        const full = review.accounts.find((a) => a.account?.account_id === data?.account_id)?.account?.name ?? 'An account in this file';
        setTxnError({ level: 'caution', text: `${full} has ${MAX_IMPORTS_PER_ACCOUNT} imports of ${TXN_SOURCE}, the most Nya keeps. Undo an old one to import this file.` });
        return;
      }
      setTxnError({ level: 'critical', text: typeof data?.error === 'string' ? data.error : 'The transactions couldn’t be imported. Please try again.' });
    } catch {
      setTxn(null);
      setStep('pick');
      setTxnError({
        level: 'critical',
        text: 'Could not reach the server, so the transactions may not have been imported. The imports below show whether they were; if not, import the file again.',
      });
      void txns.reload(account.account_id);
      // It may have landed: what it would have changed loads again.
      txnsChanged(touched);
    } finally {
      setBusy(false);
    }
  }

  async function undoTxns(i: ListedImport): Promise<boolean> {
    if (!account || busy) return false;
    setBusy(true);
    setTxnError(null);
    setNotice('');
    const names = txns.list?.names ?? {};
    const touched = [...i.accounts.flatMap((id) => (names[id] ? [{ account_id: id, item_id: names[id].item_id }] : [])), { account_id: account.account_id, item_id: account.item_id ?? '' }];
    try {
      const res = await fetch('/api/investment-imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo', account_id: account.account_id, import_id: i.import_id }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        txns.set(data);
        const n = i.accounts.length;
        setNotice(`Undone: the import of ${i.file_name ?? TXN_SOURCE} from ${formatInstantDay(i.imported_at, { sentence: true }) ?? i.imported_at.slice(0, 10)}${n > 1 ? `, from ${plural(n, 'account')}` : ''}.`);
        txnsChanged(touched);
        return true;
      }
      setTxnError({ level: 'critical', text: typeof data?.error === 'string' ? data.error : 'The import couldn’t be undone. Please try again.' });
      if (res.status === 404) void txns.reload(account.account_id);
      return false;
    } catch {
      setTxnError({ level: 'critical', text: 'Could not reach the server, so it may not have been undone. The imports below show whether it was.' });
      void txns.reload(account.account_id);
      txnsChanged(touched);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function chooseAgain() {
    setPdf(null);
    setMonthsError(null);
    setTxn(null);
    setTxnYes(false);
    setTxnError(null);
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
    step === 'statement' || step === 'mapping' || step === 'order' || step === 'months' || step === 'txns'
      ? chooseAgain
      : step === 'review'
        ? () => (file?.format === 'csv' ? setStep('mapping') : chooseAgain())
        : undefined;

  return (
    <Sheet
      open={!!target}
      title={step === 'done' ? 'Imported' : `Import ${name}’s history`}
      onClose={() => !busy && onClose()}
      onBack={busy ? undefined : back}
      footer={
        step === 'months' ? (
          <>
            <button type="button" className="btn secondary" onClick={chooseAgain} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => void importMonths()} disabled={busy || !monthsReview.body || !!monthsError?.again}>
              {pdf?.read && monthsReview.count > 0 ? `Import ${monthsReview.count.toLocaleString()} ${monthsReview.count === 1 ? 'month' : 'months'}` : 'Import'}
            </button>
          </>
        ) : step === 'txns' ? (
          <>
            <button type="button" className="btn secondary" onClick={chooseAgain} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => void importTxns()} disabled={
                busy || !txn?.review || takeOf(txn.review, txnChecked).length === 0 || !!txnError?.again || (qfxDiffers(txn.review, txnChecked) && !txnYes)
              }
            >
              {txn?.review && takeOf(txn.review, txnChecked).length > 0
                ? `Import ${plural(rowsTaken(txn.review, txnChecked), 'transaction')} into ${plural(takeOf(txn.review, txnChecked).length, 'account')}`
                : 'Import'}
            </button>
          </>
        ) : undefined
      }
    >
      {step === 'pick' && vanguard && (
        <div className="stack">
          {imported ? (
            <>
              <TransactionsNow name={name} activity={perf.activity} />
              {perf.imports && <PerformanceNow name={name} imports={perf.imports} points={perf.points} activity={perf.activity} currency={shown.currency} />}
              <p>
                Bring in more of {name}’s history from files {shown.institution_name} lets you download: a newer Performance page as a PDF, or transactions as a CSV,
                QFX, OFX or QIF file.
              </p>
            </>
          ) : (
            <>
              <p>Bring in years of {name}’s history from files {shown.institution_name} lets you download, to see further back than it shares with Nya.</p>
              <div className="stack tight">
                <h3 className="section-label">{SOURCE}, as a PDF</h3>
                <p className="helper">
                  Every month since the account opened (its balance, deposits and withdrawals, and returns), so its chart and your all-time returns reach back. On the
                  Performance page, choose this account alone and a range from when it opened, then print the page to a PDF. Nya reads it on this device and keeps only
                  the months: the file isn’t uploaded.
                </p>
              </div>
              <div className="stack tight">
                <h3 className="section-label">{TXN_SOURCE}: CSV, OFX or QFX</h3>
                <p className="helper">
                  Up to 18 months of transactions for every account in your Vanguard login, in Vanguard’s own words, so a conversion or a transfer of shares counts as
                  what it was. For the days a file covers, its transactions take the place of the ones Vanguard gave Nya. Choose CSV if you can: an OFX or QFX file
                  leaves out conversions and shares moved in kind.
                </p>
              </div>
              <p className="helper">
                A QIF file, or a CSV laid out another way, is imported as before: up to {MAX_FILE_BYTES / (1024 * 1024)} MB and{' '}
                {MAX_IMPORT_ROWS.toLocaleString()} transactions, shown beside what {shown.institution_name} gave Nya for you to confirm. Those show as the account’s
                activity and don’t change its balance history: a market’s moves aren’t transactions.
              </p>
            </>
          )}
          {past?.history_pending && <HistoryPendingNote bank={shown.institution_name} />}
          {past?.bank_from && (
            <p className="helper">
              {shown.institution_name}’s own transactions for this connection start {onDay(inDay(past.bank_from))}. Export a period that reaches up to that day, or
              past it, so no days fall between the two.
            </p>
          )}
          <div className="stack tight">
            <label className="field">
              File to import into {name}
              <input
                key={inputKey}
                type="file"
                accept=".pdf,.ofx,.qfx,.csv,.tsv,.txt,.qif,application/pdf,text/csv,application/x-ofx,application/vnd.intu.qfx,application/qif"
                onChange={(e) => void pick(e.target.files?.[0] ?? null)}
                disabled={busy}
              />
            </label>
            {imported && (
              <p className="helper">
                {[
                  perf.imports ? 'The newest Performance page counts, whole.' : '',
                  txnList ? 'For each day, the newest transactions download that covers it decides, a CSV before a QFX.' : '',
                  'Older imports are kept so you can go back to them.',
                ]
                  .filter(Boolean)
                  .join(' ')}
              </p>
            )}
          </div>
          {busy && <p className="helper">Reading the file…</p>}
          {error && (
            <Notice level="critical" role="alert">
              {error}
            </Notice>
          )}
          {monthsError && (
            <Notice level={monthsError.level} role={monthsError.level === 'critical' ? 'alert' : 'status'}>
              {monthsError.text}
            </Notice>
          )}
          {txnError && (
            <Notice level={txnError.level} role={txnError.level === 'critical' ? 'alert' : 'status'}>
              {txnError.text}
            </Notice>
          )}
          {notice && (
            <div className="notice done" role="status">
              {CHECK}
              <div>
                <LevelWord level="done" />
                {notice}
              </div>
            </div>
          )}
          {perf.importsError && <p className="helper">{perf.importsError}</p>}
          {txns.error && <p className="helper">{txns.error}</p>}
          {imported && (
            <div className="stack tight">
              <h3 className="section-label">Past imports into {name}</h3>
              {txnList && <TransactionImports name={name} list={txnList} activity={perf.activity} busy={busy} onUndo={undoTxns} />}
              {perf.imports && (
                <PerformanceImports
                  name={name}
                  imports={perf.imports}
                  points={perf.points}
                  activity={perf.activity}
                  currency={shown.currency}
                  busy={busy}
                  onUndo={undoMonths}
                />
              )}
            </div>
          )}
          <PastHistoryImports
            past={past}
            error={pastError}
            account={name}
            bank={shown.institution_name}
            busy={busy}
            undoing={undoing}
            plan={undoPlan}
            headed={!imported}
            onUndo={(i) => void askUndo(i)}
            onKeep={() => {
              setUndoing(null);
              setUndoPlan(null);
            }}
            onConfirm={(i) => void undo(i)}
          />
          {imported && (
            <Why>
              Each import is kept on its own, as it was read, and nothing else in Nya is changed by it: not what Vanguard gave Nya, not its recorded balances, not your
              deposits and withdrawals, not another import. What counts is worked out from what’s here each time you look, so undoing an import takes out only that
              import, and the account is as it was before it. Only the newest Performance page counts, so two files’ months are never mixed; to correct a month Vanguard
              has since changed, import its page again. For each day, the newest transactions download that covers it decides, a CSV before a QFX (which leaves out
              conversions and shares moved in kind), so undoing one hands its days to the next that covers them, or back to what Vanguard gave Nya. A download imported
              into several accounts is undone from all of them.
            </Why>
          )}
        </div>
      )}

      {step === 'months' && pdf && (
        <div className="stack">
          {!pdf.read ? (
            <>
              <p role="status">Reading {pdf.name}…</p>
              <StripSkeleton />
            </>
          ) : (
            <>
              {perf.importsError && (
                <Notice level="caution" role="status">
                  {perf.importsError}
                </Notice>
              )}
              {monthsError && (
                <div className="stack tight">
                  <Notice level={monthsError.level} role={monthsError.level === 'critical' ? 'alert' : 'status'}>
                    {monthsError.text}
                  </Notice>
                  {monthsError.again && (
                    <div>
                      <button type="button" className="btn secondary" onClick={() => setMonthsError(null)}>
                        Check the file again
                      </button>
                    </div>
                  )}
                </div>
              )}
              <PerformanceReview state={monthsReview} ctx={reviewCtx} fileName={pdf.name} onAgain={chooseAgain} />
            </>
          )}
        </div>
      )}

      {step === 'txns' && txn && (
        <div className="stack">
          {!txn.review ? (
            <>
              <p role="status">Reading {txn.name}…</p>
              <StripSkeleton />
            </>
          ) : (
            <>
              {txnError && (
                <div className="stack tight">
                  <Notice level={txnError.level} role={txnError.level === 'critical' ? 'alert' : 'status'}>
                    {txnError.text}
                  </Notice>
                  {txnError.again && (
                    <div>
                      <button type="button" className="btn secondary" disabled={busy} onClick={() => void reviewTxns(txn.name, txn.text, txnChecked)}>
                        Check the file again
                      </button>
                    </div>
                  )}
                </div>
              )}
              <TransactionsReview
                fileName={txn.name}
                review={txn.review}
                sheet={{ account_id: shown.account_id, name }}
                checked={txnChecked}
                onChecked={(masks) => {
                  // A yes is to what was shown: checking other accounts asks again.
                  setTxnChecked(masks);
                  setTxnYes(false);
                }}
                yes={txnYes}
                onYes={setTxnYes}
                disabled={busy}
              />
              {txn.review.source === 'vanguard-qfx' ? (
                <Why>
                  Vanguard’s QFX file is the same download as its CSV, written for money apps, but it leaves out conversions and shares moved in kind: a conversion’s
                  shares would read as nothing moving. Nor does it say what money in or out was, so none of it counts as new savings. So a CSV decides the days it covers,
                  whichever was imported last, and a QFX decides only days no CSV covers. Unlike the CSV, a QFX says which days it covers, up to the day it was made,
                  which Nya leaves out as it may not be complete. Where it and what Nya counts now don’t agree, Nya says so and waits for your yes. What Vanguard gave Nya
                  isn’t changed, only not counted, so undoing the import brings it back. Each import is kept on its own and listed in this sheet with its Undo.
                </Why>
              ) : (
                <Why>
                  Vanguard’s download says what happened in its own words: a conversion as a conversion, with the shares it moved and what they were worth, and a sweep
                  as a move inside the account. Nya reads it only as Vanguard lays it out, and a kind of transaction it doesn’t know stops that account’s import, never
                  guessed at. The file has every account in your Vanguard login, matched to yours in Nya by their last four digits. It doesn’t say which days it covers,
                  so Nya takes its first to its last transaction, never later than yesterday. For those days the file decides, over any QFX import. What Vanguard gave
                  Nya isn’t changed, only not counted, so undoing the import brings it back. Each import is kept on its own and listed in this sheet with its Undo.
                </Why>
              )}
            </>
          )}
        </div>
      )}

      {step === 'pick' && !vanguard && (
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
              {shown.institution_name}’s own transactions for this connection start {onDay(inDay(past.bank_from))}. Export a period that reaches up to that day, or
              past it, so no days fall between the two.
            </p>
          )}
          {past && !past.walked && (
            <p className="panel-note">
              Rows imported into {name} show as its activity. They don’t change its estimated balance history: a market’s moves and a loan’s interest aren’t
              transactions.
            </p>
          )}
          {past?.reach?.reach && <p className="panel-note">The estimated history reaches back to {inDay(past.reach.reach)} through what you imported.</p>}
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
          {error && (
            <Notice level="critical" role="alert">
              {error}
            </Notice>
          )}
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
        <div className="stack">
          <p className="panel-note">
            This file holds {read.statements.length} {file.format === 'qif' ? 'accounts' : 'statements'}. Which one is {name}’s?
          </p>
          <div className="button-stack">
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
          {error && (
            <Notice level="critical" role="alert">
              {error}
            </Notice>
          )}
        </div>
      )}

      {step === 'order' && file && (
        <>
          <DateOrderQuestion read={read} options={options} onChange={(o) => setOptions(o)} />
          {error && (
            <Notice level="critical" role="alert">
              {error}
            </Notice>
          )}
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
            <p className="status-note">{name}’s estimated history now reaches back to {inDay(done.history.reach)}, through what you imported.</p>
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
          <div className="stack tight">
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
            {error && (
              <Notice level="critical" role="alert">
                {error}
              </Notice>
            )}
            {notice && <p className="status-note">{notice}</p>}
          </div>
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
          {r.before_bank > 0 ? `${plural(r.before_bank, 'new transaction')} ${r.before_bank === 1 ? 'is' : 'are'} older than ${bank}’s own (from ${inDay(r.bank_from)}): history it never gave.` : `None of the new rows is older than ${bank}’s own (from ${inDay(r.bank_from)}).`}
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
                        ? `Imported from ${p.twin.file_name ?? 'an earlier file'}${p.twin.imported_at ? ` ${onDay(formatInstantDay(p.twin.imported_at, { sentence: true }) ?? p.twin.imported_at.slice(0, 10))}` : ''}`
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
                    {fmtDay(x.file.date)} · already imported: {x.stored.name}, {inDay(x.stored.date)}, <Masked>{fmtAmount(x.stored.amount, x.stored.currency)}</Masked>
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
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
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
  headed = true,
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
  /** Its own heading: false under the Performance pages' list, which has it. */
  headed?: boolean;
  onUndo: (i: Listed) => void;
  onKeep: () => void;
  onConfirm: (i: Listed) => void;
}) {
  if (error) return <p className="panel-note">{error}</p>;
  if (!past || past.imports.length === 0) return null;
  return (
    <>
      {headed && (
        <p className="section-label" style={{ marginTop: 20 }}>
          Past imports into {account}
        </p>
      )}
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
                  i.imported_at ? `Imported ${formatInstantDay(i.imported_at, { sentence: true }) ?? i.imported_at.slice(0, 10)}` : null,
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
                <div className="import-confirm stack tight">
                  {!plan ? (
                    <p className="panel-note">Working out what undoing it would do…</p>
                  ) : plan.error || !plan.plan ? (
                    <Notice level="critical" role="alert">
                      {plan.error}
                    </Notice>
                  ) : (
                    <p className="panel-note">
                      {undoText(plan.plan)} What you said about them (a category, an exclusion, a split) goes with them, they leave any group they’re in, and the estimated history is drawn again without them. The
                      balance stays as it is. This can’t be undone.
                    </p>
                  )}
                  <div className="button-pair">
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
