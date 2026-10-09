'use client';

// Importing a bank's file into a manual account (#43): the sheet behind the
// Import button on a manual account's row and on the Activity tab. Built for a
// phone: one question at a time, lists rather than tables.
//
//   1. The account (when opened from Activity) and the file, with the
//      account's past imports below, each with Undo.
//   2. Read in the browser with the same code the server runs (lib/import/):
//      a file holding several statements asks which; a CSV file asks for its
//      columns, how money out is written and, when every date fits both, the
//      order of its dates, showing how its first rows read as each answer
//      changes. A CSV from a bank whose mapping this account remembers, an
//      OFX or a QIF file needs none of that and goes straight on.
//   3. The preview, from the server against the account's own rows: how many
//      are new, already there or listed twice, the lines that can't be read
//      and why, the first rows as they will be read, the dates covered and
//      the currency, and for an OFX statement its balance, offered only when
//      it is today's or yesterday's. Then an explicit Import.
//
// Nothing is stored until Import. The file is sent for the preview and again
// for the import, and read again each time, so what is imported is what the
// server reads, matched against the account as it is at that moment.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import type { SheetInstitution } from './ManualTxnSheet';
import { formatMoney, signedMoney } from '@/lib/format';
import { instantDay, localDate } from '@/lib/local-date';
import { isOwedType } from '@/lib/balance';
import { DEFAULT_CURRENCY, isCurrencyCode } from '@/lib/manual-txn-input';
import { MAX_FILE_BYTES, MAX_IMPORT_ROWS, type FileFormat } from '@/lib/import/record';
import { decodeFile, detectFormat, FORMAT_NAMES } from '@/lib/import/text';
import { readImport, type CsvSummary, type ImportOptions, type ReadResult, type StatementInfo } from '@/lib/import/read';
import { normalizeRecords } from '@/lib/import/normalize';
import { DATE_ORDER_NAMES, type DateOrder } from '@/lib/import/dates';
import { DECIMAL_NAMES, type DecimalMark } from '@/lib/import/amounts';
import { columnsFromNames, DELIMITER_NAMES, DELIMITERS, guessColumns, readCsvTable, splitCsv, type CsvColumns, type CsvSign, type Delimiter } from '@/lib/import/csv';

/** What the sheet is open on: an account (from its row), or none yet. */
export type ImportTarget = { account_id: string | null };

/** One past import, as app/api/import lists it. */
export type ImportSummary = {
  id: string;
  record: 'ok' | 'unreadable' | 'unrecognised' | 'missing';
  format: FileFormat | null;
  file_name: string | null;
  imported_at: string | null;
  counts: { imported: number; present: number; repeated: number; unreadable: number } | null;
  first_date: string | null;
  last_date: string | null;
  currency: string | null;
  statement: string | null;
  balance_update: { from: number; to: number; as_of: string } | null;
  rows_now: number | null;
  edited_now: number | null;
  moved_now: number | null;
};

/** How the account's last file was read (lib/import/store.ts ImportSettings). */
type Settings = {
  csv?: { columns: Record<string, string>; sign: CsvSign; decimal: DecimalMark | null; date_order: DateOrder | null; delimiter: string; currency: string } | null;
  ofx?: { flip: boolean } | null;
  qif?: { date_order: DateOrder | null; decimal: DecimalMark | null; flip: boolean; currency: string } | null;
};

type Outcome = 'new' | 'present' | 'repeated';

/** The server's preview (app/api/import previewOf). */
export type Preview = {
  format: FileFormat;
  encoding: string;
  statement: StatementInfo | null;
  read: { date_order: DateOrder | null; dates_ordered: boolean; decimal: DecimalMark | null; delimiter?: Delimiter; header_line?: number; skipped?: number };
  counts: { new: number; present: number; repeated: number; unreadable: number };
  rows: { line: number | null; date: string; name: string; amount: number; currency: string; category: string | null; note: string | null; outcome: Outcome }[];
  problems: { line: number; reason: string }[];
  more_problems: number;
  first_date: string | null;
  last_date: string | null;
  currency: string | null;
  other_currencies: { currency: string; count: number }[];
  totals: { out: number; in: number };
  shortened: number;
  warnings: string[];
  account_mismatch: { expected: string; found: string } | null;
  balance: { amount: number; as_of: string | null; from: number; refusal: string | null } | null;
};

type Done = { imported: number; present: number; repeated: number; unreadable: number; balance_updated: boolean; balance?: number; balance_error?: string };

export type Picked = { name: string; blob: Blob; text: string; encoding: string; format: FileFormat };
type Step = 'pick' | 'statement' | 'mapping' | 'order' | 'preview' | 'done';
type Account = SheetInstitution['accounts'][number] & { institution_name: string };

const label = (a: Account) => (a.institution_name && a.institution_name !== a.name ? `${a.institution_name} · ${a.name}` : a.name);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** A calendar day, "Sep 3, 2026", read on the local calendar as written. */
const fmtDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtRange = (a: string | null, b: string | null) => (a && b ? (a === b ? fmtDay(a) : `${fmtDay(a)} to ${fmtDay(b)}`) : null);
/** As the Activity tab shows an amount: money in signed plus. */
const fmtAmount = (amount: number, currency: string | null) => signedMoney(-amount, currency, { always: true });

const OUTCOME_TEXT: Record<Outcome, string> = { new: 'new', present: 'already there', repeated: 'listed twice in the file' };

/** A first mapping for a header: the columns its names make plain
 *  (guessColumns), and for the date, the description and the amount, which
 *  every mapping needs, a column to start from where the names said
 *  nothing. The sheet shows how the rows read, for the person to correct. */
function draftColumns(header: string[]): CsvColumns {
  const guess = guessColumns(header);
  const taken = new Set(Object.values(guess));
  const free = () => {
    const at = header.findIndex((_, i) => !taken.has(i));
    const i = at < 0 ? 0 : at;
    taken.add(i);
    return i;
  };
  const date = guess.date ?? free();
  const description = guess.description ?? free();
  const out: CsvColumns = { ...guess, date, description };
  if (out.amount === undefined && (out.debit === undefined || out.credit === undefined)) {
    delete out.debit;
    delete out.credit;
    out.amount = free();
  }
  return out;
}

/** Why a statement's balance isn't offered, in words. */
function balanceRefusal(why: string, account: string): string {
  switch (why) {
    case 'past':
      return `Nya sets a balance from a statement only when it is today’s or yesterday’s, so a past figure never stands in for today’s. Update ${account} from its row if it is still right.`;
    case 'ahead':
      return 'It is dated ahead, so it isn’t offered.';
    case 'currency':
      return `It isn’t in ${DEFAULT_CURRENCY}, the currency manual balances are kept in.`;
    case 'kind':
      return `This statement’s kind doesn’t match ${account}’s (a card statement for a card, a bank statement for a bank account), so its sign can’t be trusted here.`;
    case 'owed-negative':
      return 'It would make the amount owed negative.';
    case 'undated':
      return 'It has no date.';
    default:
      return 'It can’t be set as the balance.';
  }
}

async function postForm(meta: Record<string, unknown>, file: Picked): Promise<{ res: Response; data: any }> {
  const form = new FormData();
  form.set('file', file.blob, file.name);
  form.set('meta', JSON.stringify({ file_name: file.name, ...meta }));
  const res = await fetch('/api/import', { method: 'POST', body: form });
  return { res, data: await res.json().catch(() => null) };
}

export default function ImportSheet({
  target,
  institutions,
  onClose,
  onImported,
}: {
  target: ImportTarget | null;
  institutions: SheetInstitution[];
  onClose: () => void;
  /** After an import or an undo changed the account's rows; `balanceChanged`
   *  when its balance was set too. */
  onImported: (result: { balanceChanged: boolean }) => void;
}) {
  const accounts = useMemo<Account[]>(
    () =>
      institutions
        .filter((i) => i.manual)
        .flatMap((i) => i.accounts.filter((a) => !a.hidden).map((a) => ({ ...a, institution_name: i.institution_name }))),
    [institutions]
  );
  // Kept while the drawer slides out, so it doesn't empty on the way.
  const [shown, setShown] = useState<ImportTarget | null>(null);
  const [accountId, setAccountId] = useState('');
  const [past, setPast] = useState<{ imports: ImportSummary[]; settings: Settings | null } | null>(null);
  const [pastError, setPastError] = useState('');
  const [file, setFile] = useState<Picked | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [options, setOptions] = useState<ImportOptions>({});
  const [step, setStep] = useState<Step>('pick');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const [setBalance, setSetBalance] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [undoing, setUndoing] = useState<ImportSummary | null>(null);
  const [notice, setNotice] = useState('');

  const account = accounts.find((a) => a.account_id === accountId) ?? null;
  const thisYear = new Date().getFullYear();

  const loadPast = useCallback(async (id: string) => {
    if (!id) return;
    setPastError('');
    try {
      const res = await fetch(`/api/import?account_id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPast(null);
        setPastError(data?.error ?? 'Past imports couldn’t be loaded.');
        return;
      }
      setPast({ imports: Array.isArray(data?.imports) ? data.imports : [], settings: data?.settings ?? null });
    } catch {
      setPast(null);
      setPastError('Past imports couldn’t be loaded: the server couldn’t be reached.');
    }
  }, []);

  // A fresh start each time it opens. Only on opening: balances reloading in
  // the background must not reset a file half read.
  useEffect(() => {
    if (!target) return;
    setShown(target);
    setFile(null);
    setInputKey((k) => k + 1);
    setOptions({});
    setStep('pick');
    setPreview(null);
    setBusy(false);
    setError('');
    setDone(null);
    setSetBalance(false);
    setAcknowledged(false);
    setUndoing(null);
    setNotice('');
    setPast(null);
    const start = target.account_id ?? accounts[0]?.account_id ?? '';
    setAccountId(start);
    void loadPast(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  /** The file read with these answers, in the browser. */
  const read = useMemo<ReadResult | null>(() => (file ? readImport(file.text, { format: file.format, options, thisYear }) : null), [file, options, thisYear]);

  /** Asks the server for the preview, with these answers. */
  async function requestPreview(next: ImportOptions, picked: Picked | null = file) {
    if (!picked || !account) return;
    setBusy(true);
    setError('');
    try {
      const { res, data } = await postForm({ action: 'preview', account_id: account.account_id, options: next }, picked);
      if (res.ok && data?.preview) {
        setPreview(data.preview);
        setSetBalance(false);
        setAcknowledged(false);
        setStep('preview');
        return;
      }
      if (res.ok && data?.needs) {
        // The server needs an answer the sheet didn't ask yet.
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

  /** On to whatever the file needs next with these answers: a question, or
   *  the preview. `remembered` says a CSV's mapping came from the last file. */
  function proceed(next: ImportOptions, picked: Picked, remembered = false) {
    setOptions(next);
    const r = readImport(picked.text, { format: picked.format, options: next, thisYear });
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
    void requestPreview(next, picked);
  }

  async function pick(f: File | null) {
    setError('');
    setNotice('');
    setDone(null);
    if (!f) return;
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
      // What this account's last file of the same kind taught.
      const s = past?.settings ?? null;
      let next: ImportOptions = {};
      let remembered = false;
      if (picked.format === 'ofx' && s?.ofx?.flip) next = { flip: true };
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
    if (!file || !account || !preview || busy) return;
    setBusy(true);
    setError('');
    const b = preview.balance;
    try {
      const { res, data } = await postForm(
        {
          action: 'import',
          account_id: account.account_id,
          options,
          acknowledge_account: acknowledged,
          ...(setBalance && b && !b.refusal ? { balance: { from: b.from, to: b.amount } } : {}),
        },
        file
      );
      if (res.ok) {
        setDone(data);
        setStep('done');
        onImported({ balanceChanged: data?.balance_updated === true && setBalance });
        void loadPast(account.account_id);
        return;
      }
      setError(data?.error ?? 'The file couldn’t be imported. Please try again.');
    } catch {
      setError('Could not reach the server, so it may not have been imported. Check the list of imports before trying again.');
      void loadPast(account.account_id);
    } finally {
      setBusy(false);
    }
  }

  async function undo(item: ImportSummary) {
    if (!account || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/import', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: account.account_id, import_id: item.id, confirm: true }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setNotice(`Undone: ${plural(data?.removed ?? 0, 'transaction')} removed.`);
        setUndoing(null);
        onImported({ balanceChanged: false });
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
    setPreview(null);
    setDone(null);
    setError('');
    setStep('pick');
  }

  if (!shown) return null;
  const name = account?.name ?? 'the account';
  const back =
    step === 'statement' || step === 'mapping' || step === 'order'
      ? chooseAgain
      : step === 'preview'
        ? () => (file?.format === 'csv' ? setStep('mapping') : chooseAgain())
        : undefined;

  return (
    <Sheet open={!!target} title={step === 'done' ? 'Imported' : 'Import a file'} onClose={() => !busy && onClose()} onBack={busy ? undefined : back}>
      {step === 'pick' && (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            A file your bank exports: OFX or QFX is best (each transaction carries the bank’s own id, so importing it again adds nothing twice),
            or CSV or QIF. Up to {MAX_FILE_BYTES / (1024 * 1024)} MB and {MAX_IMPORT_ROWS.toLocaleString()} transactions.
          </p>
          <div className="sheet-form">
            {!shown.account_id && (
              <label className="field">
                Account
                <select
                  value={accountId}
                  onChange={(e) => {
                    setAccountId(e.target.value);
                    setPast(null);
                    void loadPast(e.target.value);
                  }}
                  disabled={busy}
                >
                  {accounts.map((a) => (
                    <option key={a.account_id} value={a.account_id}>
                      {label(a)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              {shown.account_id ? `File to import into ${name}` : 'File'}
              <input
                key={inputKey}
                type="file"
                accept=".ofx,.qfx,.csv,.tsv,.txt,.qif,text/csv,application/x-ofx,application/vnd.intu.qfx,application/qif"
                onChange={(e) => void pick(e.target.files?.[0] ?? null)}
                disabled={busy || !account}
              />
            </label>
          </div>
          {busy && <p className="panel-note">Reading the file…</p>}
          {error && <div className="error">{error}</div>}
          {notice && <p className="status-note">{notice}</p>}
          <PastImports
            past={past}
            error={pastError}
            account={name}
            busy={busy}
            undoing={undoing}
            onUndo={(i) => setUndoing(i)}
            onKeep={() => setUndoing(null)}
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
            <button onClick={() => void requestPreview(options)} disabled={busy || read?.status !== 'ready'}>
              {busy ? 'Checking…' : 'Next'}
            </button>
          </div>
        </>
      )}

      {step === 'mapping' && file && (
        <CsvMapping
          file={file}
          read={read}
          options={options}
          setOptions={setOptions}
          account={name}
          busy={busy}
          error={error}
          onNext={() => void requestPreview(options)}
        />
      )}

      {step === 'preview' && preview && file && (
        <PreviewView
          preview={preview}
          file={file}
          options={options}
          account={account}
          busy={busy}
          error={error}
          setBalance={setBalance}
          onSetBalance={setSetBalance}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
          onFlip={(flip) => {
            const next = { ...options, flip: flip || undefined };
            setOptions(next);
            void requestPreview(next);
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
              done.present > 0 ? `${done.present.toLocaleString()} already there` : null,
              done.repeated > 0 ? `${done.repeated.toLocaleString()} listed twice in the file` : null,
              done.unreadable > 0 ? `${plural(done.unreadable, 'line')} not read` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'Every row in the file was read.'}
          </p>
          {done.balance_updated && typeof done.balance === 'number' && (
            <p className="status-note">
              {name}’s {account && isOwedType(account.type) ? 'amount owed' : 'balance'} is now {formatMoney(done.balance, DEFAULT_CURRENCY)}.
            </p>
          )}
          {done.balance_error && <div className="error">The rows were imported, but {done.balance_error}</div>}
          {done.imported > 0 && (
            <p className="panel-note">They show on the Activity tab and count like any transaction. If this was the wrong file, undo it below.</p>
          )}
          <PastImports
            past={past}
            error={pastError}
            account={name}
            busy={busy}
            undoing={undoing}
            onUndo={(i) => setUndoing(i)}
            onKeep={() => setUndoing(null)}
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

/** The question every date fitting both orders asks (lib/import/dates.ts):
 *  never guessed. With an answer already given, the dates as read, changeable. */
export function DateOrderQuestion({ read, options, onChange }: { read: ReadResult | null; options: ImportOptions; onChange: (o: ImportOptions) => void }) {
  const asking = read?.status === 'date_order';
  const examples = asking ? read.examples : [];
  const mixed = asking && read.detection.mixed;
  const chosen = options.date_order ?? (read?.status === 'ready' ? read.read.date_order : null);
  return (
    <div className="import-question">
      <p className="panel-note" style={{ marginTop: 0 }}>
        {asking
          ? mixed
            ? 'Some dates in this file only make sense month first, and others only day first. Which way should they be read? The rest won’t be read.'
            : `Every date in this file could be month first or day first${examples.length > 0 ? ` (${examples.join(', ')})` : ''}. Which is it?`
          : 'Dates are read as:'}
      </p>
      <div className="button-pair quick-add-choice" role="group" aria-label="Order of the dates">
        {(['mdy', 'dmy'] as DateOrder[]).map((o) => (
          <button key={o} className="secondary" aria-pressed={chosen === o} onClick={() => onChange({ ...options, date_order: o })}>
            {DATE_ORDER_NAMES[o]}
          </button>
        ))}
      </div>
    </div>
  );
}

const ROLE_LABELS: Record<'date' | 'description' | 'amount' | 'debit' | 'credit' | 'category' | 'note' | 'currency', string> = {
  date: 'Date',
  description: 'Description',
  amount: 'Amount',
  debit: 'Money out',
  credit: 'Money in',
  category: 'Category (optional)',
  note: 'Notes (optional)',
  currency: 'Currency (optional)',
};

/** The mapping step for a CSV file: which column is which, how its amounts
 *  and dates are written, and the first rows as they read with that. */
export function CsvMapping({
  file,
  read,
  options,
  setOptions,
  account,
  busy,
  error,
  onNext,
}: {
  file: Picked;
  read: ReadResult | null;
  options: ImportOptions;
  setOptions: (o: ImportOptions) => void;
  account: string;
  busy: boolean;
  error: string;
  onNext: () => void;
}) {
  const table: CsvSummary | undefined =
    read?.status === 'mapping' ? read.table : read?.status === 'ready' ? read.read.table : read?.status === 'date_order' ? read.table : undefined;
  const csv = options.csv ?? { columns: { date: 0, description: 1 }, sign: 'negative-out' as CsvSign };
  const columns = csv.columns;
  const separate = columns.amount === undefined;
  const set = (patch: Partial<NonNullable<ImportOptions['csv']>>) => setOptions({ ...options, csv: { ...csv, ...patch } });
  /** Another separator or header line: other column names, so the mapping
   *  starts again from what they say. */
  const reread = (patch: { delimiter?: Delimiter; header_line?: number }) => {
    const next = { delimiter: patch.delimiter ?? csv.delimiter, header_line: patch.header_line };
    const t = readCsvTable(file.text, next);
    set({ ...next, columns: 'error' in t ? csv.columns : draftColumns(t.header) });
  };
  const setColumn = (role: keyof CsvColumns, value: string) => {
    const next: CsvColumns = { ...columns };
    if (value === '') delete next[role];
    else next[role] = Number(value);
    set({ columns: next });
  };
  const today = localDate();
  const currency = options.currency && isCurrencyCode(options.currency) ? options.currency : DEFAULT_CURRENCY;
  const live = useMemo(() => (read?.status === 'ready' ? normalizeRecords(read.records, { today, currency }) : null), [read, today, currency]);
  // The first lines of the file, for choosing where the column names are.
  const lines = useMemo(() => splitCsv(file.text, table?.delimiter ?? ',', Math.max(12, (table?.skipped ?? 0) + 6)).rows, [file.text, table?.delimiter, table?.skipped]);
  if (!table) {
    return (
      <>
        <div className="error">{read?.status === 'error' ? read.error : 'This file couldn’t be read as a table.'}</div>
      </>
    );
  }
  const columnSelect = (role: keyof CsvColumns, optional: boolean) => (
    <label className="field" key={role}>
      {ROLE_LABELS[role]}
      <select value={columns[role] ?? ''} onChange={(e) => setColumn(role, e.target.value)} disabled={busy}>
        {optional && <option value="">None</option>}
        {table.header.map((h, i) => (
          <option key={i} value={i}>
            {h}
          </option>
        ))}
      </select>
    </label>
  );
  const unreadable = read?.status === 'ready' ? read.problems.length + (live?.problems.length ?? 0) : 0;
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Say which column holds what. Check the rows below read as they should before going on; {account} will remember this for the next file from
        the same bank.
      </p>
      <div className="sheet-form">
        <div className="quick-add-pair">
          <label className="field">
            Separated by
            <select value={table.delimiter} onChange={(e) => reread({ delimiter: e.target.value as Delimiter })} disabled={busy}>
              {DELIMITERS.map((d) => (
                <option key={d} value={d}>
                  {DELIMITER_NAMES[d]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Column names on
            <select value={table.header_line} onChange={(e) => reread({ header_line: Number(e.target.value) })} disabled={busy}>
              {lines.map((l) => (
                <option key={l.line} value={l.line}>
                  {`Line ${l.line}: ${l.cells.join(' | ').slice(0, 40)}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        {columnSelect('date', false)}
        {columnSelect('description', false)}
        <div className="button-pair quick-add-choice" role="group" aria-label="How amounts are given" style={{ marginTop: 0, marginBottom: 12 }}>
          <button
            className="secondary"
            aria-pressed={!separate}
            disabled={busy}
            onClick={() => {
              const { debit, credit, ...rest } = columns;
              set({ columns: { ...rest, amount: debit ?? credit ?? 0 } });
            }}
          >
            One amount column
          </button>
          <button
            className="secondary"
            aria-pressed={separate}
            disabled={busy}
            onClick={() => {
              const { amount, ...rest } = columns;
              set({ columns: { ...rest, debit: amount ?? 0, credit: Math.min(table.header.length - 1, (amount ?? 0) + 1) } });
            }}
          >
            Money out and in apart
          </button>
        </div>
        {separate ? (
          <div className="quick-add-pair">
            {columnSelect('debit', false)}
            {columnSelect('credit', false)}
          </div>
        ) : (
          <>
            {columnSelect('amount', false)}
            <p className="panel-note" style={{ margin: '0 0 6px' }}>
              In this file, money out is written as:
            </p>
            <div className="button-pair quick-add-choice" role="group" aria-label="How money out is written" style={{ marginTop: 0, marginBottom: 12 }}>
              <button className="secondary" aria-pressed={csv.sign === 'negative-out'} disabled={busy} onClick={() => set({ sign: 'negative-out' })}>
                Negative (-12.50)
              </button>
              <button className="secondary" aria-pressed={csv.sign === 'positive-out'} disabled={busy} onClick={() => set({ sign: 'positive-out' })}>
                Positive (12.50)
              </button>
            </div>
          </>
        )}
        {columnSelect('category', true)}
        {columnSelect('note', true)}
        {columnSelect('currency', true)}
        {columns.currency === undefined && (
          <label className="field">
            Currency of every row
            <input
              value={options.currency ?? DEFAULT_CURRENCY}
              onChange={(e) => setOptions({ ...options, currency: e.target.value.toUpperCase().slice(0, 3) })}
              maxLength={3}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
        )}
        <p className="panel-note" style={{ margin: '0 0 6px' }}>
          Decimal mark
        </p>
        <div className="button-pair quick-add-choice" role="group" aria-label="Decimal mark" style={{ marginTop: 0, marginBottom: 12 }}>
          {(['.', ','] as DecimalMark[]).map((m) => {
            const current = options.decimal ?? (read?.status === 'ready' ? read.read.decimal : null) ?? '.';
            return (
              <button key={m} className="secondary" aria-pressed={current === m} disabled={busy} onClick={() => setOptions({ ...options, decimal: m })}>
                {DECIMAL_NAMES[m]}
              </button>
            );
          })}
        </div>
        {(read?.status === 'date_order' || (read?.status === 'ready' && read.read.dates_ordered)) && <DateOrderQuestion read={read} options={options} onChange={setOptions} />}
      </div>

      {read?.status === 'mapping' && read.problem && <div className="error">{read.problem}</div>}
      {read?.status === 'error' && <div className="error">{read.error}</div>}
      {live && read?.status === 'ready' && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            How the first rows read
          </p>
          {live.rows.length === 0 ? (
            <p className="empty-note">No row reads as a transaction with these columns.</p>
          ) : (
            <ul className="import-rows">
              {live.rows.slice(0, 5).map((r) => (
                <li key={r.index}>
                  <div className="import-row-text">
                    <div className="import-row-name">{r.row.name}</div>
                    <div className="import-row-meta">
                      {fmtDay(r.row.date)}
                      {r.row.category ? ` · ${r.row.category}` : ''}
                      {` · ${r.row.amount > 0 ? 'money out' : 'money in'}`}
                    </div>
                  </div>
                  <div className={`import-row-amount${r.row.amount < 0 ? ' inflow' : ''}`}>{fmtAmount(r.row.amount, r.row.currency)}</div>
                </li>
              ))}
            </ul>
          )}
          <p className="panel-note">
            {plural(live.rows.length, 'row')} read
            {unreadable > 0 ? `, ${plural(unreadable, 'line')} can’t be (the next step lists them)` : ''}
            {table.skipped > 0 ? `. ${plural(table.skipped, 'line')} above the column names skipped` : ''}.
          </p>
        </>
      )}
      {error && <div className="error">{error}</div>}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button onClick={onNext} disabled={busy || read?.status !== 'ready' || !live || live.rows.length === 0 || !isCurrencyCode(options.currency ?? DEFAULT_CURRENCY)}>
          {busy ? 'Checking…' : `Check against ${account}`}
        </button>
      </div>
    </>
  );
}

/** The server's preview, and the Import button. */
export function PreviewView({
  preview: p,
  file,
  options,
  account,
  busy,
  error,
  setBalance,
  onSetBalance,
  acknowledged,
  onAcknowledge,
  onFlip,
  onImport,
  onBack,
}: {
  preview: Preview;
  file: Picked;
  options: ImportOptions;
  account: Account | null;
  busy: boolean;
  error: string;
  setBalance: boolean;
  onSetBalance: (v: boolean) => void;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  onFlip: (flip: boolean) => void;
  onImport: () => void;
  onBack: () => void;
}) {
  const [allProblems, setAllProblems] = useState(false);
  const name = account?.name ?? 'the account';
  const owed = account ? isOwedType(account.type) : false;
  const c = p.counts;
  const range = fmtRange(p.first_date, p.last_date);
  const b = p.balance;
  const offered = !!b && !b.refusal;
  const blocked = !!p.account_mismatch && !acknowledged;
  const canImport = c.new > 0 || (setBalance && offered);
  const shownProblems = allProblems ? p.problems : p.problems.slice(0, 5);
  const readAs = [
    FORMAT_NAMES[p.format],
    p.statement?.label ?? null,
    p.encoding === 'windows-1252' ? 'Windows-1252 text' : null,
    p.read.dates_ordered && p.read.date_order ? `dates ${DATE_ORDER_NAMES[p.read.date_order]}` : null,
    p.read.decimal === ',' ? 'decimal comma' : null,
  ].filter(Boolean);
  return (
    <>
      <p className="import-headline" style={{ marginTop: 0 }}>
        {c.new > 0 ? `${plural(c.new, 'new transaction')}` : `Nothing new to import into ${name}`}
      </p>
      <p className="panel-note" style={{ marginTop: 4 }}>
        {[
          c.present > 0 ? `${c.present.toLocaleString()} already in ${name}` : null,
          c.repeated > 0 ? `${c.repeated.toLocaleString()} listed twice in the file` : null,
          c.unreadable > 0 ? `${plural(c.unreadable, 'line')} can’t be read` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Every row in the file reads.'}
      </p>
      <p className="panel-note">
        {range ? `${range}` : 'No dates'}
        {p.currency ? ` · in ${p.currency}` : ''}
        {c.new > 0 && p.currency ? ` · new: ${formatMoney(p.totals.out, p.currency)} out, ${formatMoney(p.totals.in, p.currency)} in` : ''}
      </p>
      <p className="panel-note">Read as {readAs.join(', ')}.</p>
      {p.other_currencies.length > 0 && (
        <p className="panel-note">
          {p.other_currencies.map((o) => `${plural(o.count, 'row')} in ${o.currency}`).join(', ')}: shown in their own currency, never added into totals in{' '}
          {p.currency}.
        </p>
      )}
      {p.shortened > 0 && (
        <p className="panel-note">
          {plural(p.shortened, 'description')} longer than a transaction’s can be {p.shortened === 1 ? 'was' : 'were'} shortened; the full text is kept with the import.
        </p>
      )}
      {p.warnings.map((w) => (
        <p key={w} className="stale-note">
          {w}
        </p>
      ))}
      {p.account_mismatch && (
        <>
          <p className="stale-note">
            This file is for {p.account_mismatch.found}, but {name}’s last OFX file was for {p.account_mismatch.expected}.
          </p>
          <label className="quick-add-check">
            <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(e) => onAcknowledge(e.target.checked)} />
            <span>It’s the right file: import it into {name}</span>
          </label>
        </>
      )}
      {(p.format === 'ofx' || p.format === 'qif') && (
        <label className="quick-add-check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={options.flip === true} disabled={busy} onChange={(e) => onFlip(e.target.checked)} />
          <span>Read every amount the other way round (for a bank that writes them so)</span>
        </label>
      )}

      <p className="section-label" style={{ marginTop: 16 }}>
        The first rows, as they will be read
      </p>
      {p.rows.length === 0 ? (
        <p className="empty-note">No row in this file could be read.</p>
      ) : (
        <ul className="import-rows">
          {p.rows.map((r, i) => (
            <li key={`${r.line}-${i}`} className={r.outcome === 'new' ? undefined : 'import-row-skipped'}>
              <div className="import-row-text">
                <div className="import-row-name">{r.name}</div>
                <div className="import-row-meta">
                  {fmtDay(r.date)}
                  {r.category ? ` · ${r.category}` : ''} · {OUTCOME_TEXT[r.outcome]}
                </div>
              </div>
              <div className={`import-row-amount${r.amount < 0 ? ' inflow' : ''}`}>{fmtAmount(r.amount, r.currency)}</div>
            </li>
          ))}
        </ul>
      )}

      {p.problems.length > 0 && (
        <>
          <p className="section-label" style={{ marginTop: 16 }}>
            Lines that can’t be read
          </p>
          <ul className="import-problems">
            {shownProblems.map((pr, i) => (
              <li key={`${pr.line}-${i}`}>
                {pr.line > 0 ? `Line ${pr.line}: ` : ''}
                {pr.reason}
              </li>
            ))}
          </ul>
          {!allProblems && p.problems.length > 5 && (
            <button className="link-btn" onClick={() => setAllProblems(true)}>
              Show all {p.problems.length.toLocaleString()}
              {p.more_problems > 0 ? ` (and ${p.more_problems.toLocaleString()} more not listed)` : ''}
            </button>
          )}
        </>
      )}

      {b &&
        (offered ? (
          <label className="quick-add-check" style={{ marginTop: 16 }}>
            <input type="checkbox" checked={setBalance} disabled={busy} onChange={(e) => onSetBalance(e.target.checked)} />
            <span>
              Also set {name}’s {owed ? 'amount owed' : 'balance'} to {formatMoney(b.amount, DEFAULT_CURRENCY)}, the statement’s balance on{' '}
              {b.as_of ? fmtDay(b.as_of) : 'its date'} (now {formatMoney(b.from, DEFAULT_CURRENCY)})
            </span>
          </label>
        ) : (
          <p className="panel-note" style={{ marginTop: 16 }}>
            The statement’s balance{b.as_of ? ` on ${fmtDay(b.as_of)}` : ''} was {formatMoney(b.amount, p.statement?.currency ?? DEFAULT_CURRENCY)}.{' '}
            {balanceRefusal(b.refusal!, name)}
          </p>
        ))}
      <p className="panel-note">
        Importing doesn’t change {name}’s {owed ? 'amount owed' : 'balance'}
        {offered ? ' unless you tick the box' : ''}. You can undo an import from this sheet.
      </p>

      {error && <div className="error">{error}</div>}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onBack} disabled={busy}>
          {file.format === 'csv' ? 'Columns' : 'Another file'}
        </button>
        <button onClick={onImport} disabled={busy || !canImport || blocked}>
          {busy ? 'Importing…' : c.new > 0 ? `Import ${plural(c.new, 'transaction')}` : setBalance && offered ? 'Set the balance' : 'Nothing to import'}
        </button>
      </div>
    </>
  );
}

/** An account's past imports, newest first, each with Undo and its
 *  confirmation, which says what will go. */
export function PastImports({
  past,
  error,
  account,
  busy,
  undoing,
  onUndo,
  onKeep,
  onConfirm,
}: {
  past: { imports: ImportSummary[] } | null;
  error: string;
  account: string;
  busy: boolean;
  undoing: ImportSummary | null;
  onUndo: (i: ImportSummary) => void;
  onKeep: () => void;
  onConfirm: (i: ImportSummary) => void;
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
          const range = fmtRange(i.first_date, i.last_date);
          const rows = i.rows_now;
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
                  range,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {rows !== null && i.counts && rows !== i.counts.imported && (
                <div className="import-row-meta">{rows === 0 ? 'None of them is left.' : `${rows.toLocaleString()} still stored.`}</div>
              )}
              {i.record === 'unreadable' && <div className="import-row-meta">Its record can’t be read; Undo still takes its transactions out.</div>}
              {i.record === 'missing' && <div className="import-row-meta">Its record is gone; Undo still takes its transactions out.</div>}
              {i.record === 'unrecognised' && <div className="import-row-meta">A newer version of Nya saved it, so it can’t be undone here.</div>}
              {i.balance_update && (
                <div className="import-row-meta">It also set the balance to {formatMoney(i.balance_update.to, DEFAULT_CURRENCY)}.</div>
              )}
              {confirming && (
                <div className="import-confirm">
                  <p className="panel-note" style={{ marginTop: 6 }}>
                    {rows === null
                      ? 'Remove every transaction this import added? Some accounts’ transactions can’t be read now, so how many isn’t known.'
                      : rows === 0
                        ? 'None of its transactions is left. Undo removes its record.'
                        : `Remove the ${plural(rows, 'transaction')} this import added?`}
                    {i.edited_now ? ` ${i.edited_now.toLocaleString()} of them ${i.edited_now === 1 ? 'was' : 'were'} changed since, and ${i.edited_now === 1 ? 'goes' : 'go'} too.` : ''}
                    {i.moved_now ? ` ${i.moved_now.toLocaleString()} ${i.moved_now === 1 ? 'is' : 'are'} on another account now, and ${i.moved_now === 1 ? 'goes' : 'go'} too.` : ''}{' '}
                    Any you excluded are forgotten with them. The balance stays as it is. This can’t be undone.
                  </p>
                  <div className="button-pair" style={{ marginTop: 8 }}>
                    <button className="secondary" onClick={onKeep} disabled={busy}>
                      Keep it
                    </button>
                    <button className="danger" onClick={() => onConfirm(i)} disabled={busy}>
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
