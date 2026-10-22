'use client';

// Bring back a download (docs/data-export.md, "Bringing it back"), under
// Manage accounts beside Download my data: a JSON download of another copy
// of Nya brought into this account, when it is empty. Offered only where the
// deployment turned restores on (RESTORE_ENABLED); a restore recorded here is
// always shown, with its undo.
//
// THE FILE STAYS HERE. It is read in this page a few megabytes at a time
// (lib/user-restore/file.ts): a protected one opened first with its
// passphrase (components/OpenProtectedDownload.tsx openFile), then checked
// against this version's closed shapes, then planned in batches, the parts
// only the server's checks can read sent to them first, so a file is checked
// to its end before anything is written. Then the person sees what comes
// back and what doesn't, confirms it is them, and the batches are sent in
// order (lib/user-restore/send.ts). Nothing of the file is kept: not in the
// page's storage, not on the server but as the values it holds.
//
// STOPPED PART WAY (a closed tab, a dropped connection), the restore is
// unfinished: the card says so, and goes on with the same file, or undoes
// it. Undo empties the account again, offered while unfinished and for
// UNDO_DAYS after, with the download offered first.
//
// THE FRESH SIGN-IN, as for a download: with Clerk, its useReverification
// asks the person to confirm it is them when the server says so; with the
// shared password, it is asked for here, and emptied once used.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useReverification } from '@clerk/nextjs';
import { isReverificationCancelledError } from '@clerk/nextjs/errors';
import { collect, previewOf, blobSource, FileRefused, type FileSource, type Preview } from '@/lib/user-restore/file';
import { makePlan, startBody, sendBatches, finishRestore, RestoreStopped, type Fetcher, type Plan } from '@/lib/user-restore/send';
import { newUserRestoreId } from '@/lib/user-restore/ids';
import type { Collected } from '@/lib/user-restore/plan';
import type { RecordView } from '@/lib/user-restore/store';
import { formatMoney, plainNumber } from '@/lib/format';
import { Masked } from './HideAmounts';
import { openFile, openFailure } from './OpenProtectedDownload';
import DownloadMyData from './DownloadMyData';
import { accountWords, broughtLines, canUndo, leftOutLines, looksProtected, sharingLines, unreadableNotes, waitingBanks, type RestoreState } from './restore-state';

const EMPTY_WORDS = 'empty my account';

type Hint = { clerk_error: { type: string; reason: string } };
type Answer = { ok: true; body: Record<string, any> } | { ok: false; status: number | null; error: string; body: Record<string, any> | null } | Hint;

function isHint(v: unknown): v is Hint {
  const e = (v as Hint | null)?.clerk_error;
  return !!e && e.type === 'forbidden' && e.reason === 'reverification-error';
}

/** One request that may need a fresh sign-in, answered as JSON. A hint is
 *  handed back as it came, for Clerk's hook to act on. */
async function ask(method: string, path: string, body: Record<string, unknown>): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, status: null, error: 'Nya couldn’t be reached. Check your connection and try again.', body: null };
  }
  const data = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok && isHint(data)) return data;
  if (!res.ok) return { ok: false, status: res.status, error: typeof data?.error === 'string' ? data.error : `Nya answered ${res.status}. Try again.`, body: data };
  return { ok: true, body: data ?? {} };
}

const pageFetch: Fetcher = (input, init) => fetch(input, init);

/** The file as read: where its bytes are, what was collected, and what it
 *  would bring back. */
type Loaded = { source: FileSource; collected: Collected; preview: Preview };

type Phase =
  | { kind: 'idle' }
  | { kind: 'passphrase'; file: File; error?: string }
  | { kind: 'opening'; done: number }
  | { kind: 'reading' }
  | { kind: 'checking'; batches: number }
  | { kind: 'preview'; loaded: Loaded; plan: Plan }
  | { kind: 'starting'; loaded: Loaded; plan: Plan }
  | { kind: 'sending'; done: number; total: number }
  | { kind: 'finishing' }
  | { kind: 'working'; what: string };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
/** A day (YYYY-MM-DD) as the Earlier accounts list writes it, on the
 *  viewer's own calendar (components/AccountLinks.tsx). */
const listedDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

type CardProps = { onChanged?: () => void; autoScan?: boolean };

/** `clerk`: whether sign-in is Clerk's (lib/auth-mode.ts). Clerk's hook only
 *  works inside its provider, which exists only then. `autoScan`: look at
 *  whether the account is empty as the card opens (an account with nothing
 *  in it yet, where a restore is likely); otherwise only when asked, since
 *  the look reads every key of the account and is counted. `onChanged`: run
 *  once a restore, an undo or an emptying changed the account. */
export default function RestoreCard({ clerk, ...props }: CardProps & { clerk: boolean }) {
  return clerk ? <WithClerk {...props} /> : <RestoreFlow ask={ask} needsPassword {...props} />;
}

function WithClerk(props: CardProps) {
  const verified = useReverification(ask);
  return <RestoreFlow ask={verified} needsPassword={false} {...props} />;
}

function RestoreFlow({ ask: send, needsPassword, onChanged, autoScan = false }: CardProps & { ask: typeof ask; needsPassword: boolean }) {
  const [state, setState] = useState<RestoreState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [withoutOk, setWithoutOk] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [downloadFirst, setDownloadFirst] = useState(false);
  const [emptyWords, setEmptyWords] = useState('');
  const [stopFrom, setStopFrom] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (scan: boolean) => {
    try {
      const res = await fetch(`/api/user-restore${scan ? '?scan=1' : ''}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'What was brought back couldn’t be read.');
      setState(data as RestoreState);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'What was brought back couldn’t be read.');
    }
  }, []);
  useEffect(() => {
    void load(autoScan);
  }, [load, autoScan]);

  const busy = phase.kind !== 'idle' && phase.kind !== 'preview' && phase.kind !== 'passphrase';
  const record = state?.record ?? null;
  const unfinished = !!record && record.status !== 'finished';

  /** Asks with the password when the shared one signs in; null for a
   *  cancelled Clerk window. */
  const asked = async (method: string, path: string, body: Record<string, unknown>): Promise<Answer | null> => {
    try {
      return await send(method, path, needsPassword ? { ...body, password } : body);
    } catch (err) {
      if (isReverificationCancelledError(err)) return null;
      return { ok: false, status: null, error: 'That didn’t work. Try again.', body: null };
    }
  };

  /** Reads the chosen file: opens a protected one, collects, and, for a new
   *  restore, plans and checks it; for an unfinished one, goes on with it. */
  const read = async (source: FileSource) => {
    setError(null);
    setPhase({ kind: 'reading' });
    let collected: Collected;
    try {
      collected = await collect(source);
    } catch (err) {
      setPhase({ kind: 'idle' });
      setError(err instanceof FileRefused ? err.problem : 'This file couldn’t be read.');
      return;
    }
    if (unfinished && record) {
      await goOn(source, collected, record);
      return;
    }
    const preview = previewOf(collected);
    if (preview.refuse) {
      setPhase({ kind: 'idle' });
      setError(preview.refuse);
      return;
    }
    setPhase({ kind: 'checking', batches: 0 });
    try {
      const plan = await makePlan(source, collected, { fetcher: pageFetch, onBatch: (batches) => setPhase({ kind: 'checking', batches }) });
      setWithoutOk(preview.without.length === 0);
      setPhase({ kind: 'preview', loaded: { source, collected, preview }, plan });
    } catch (err) {
      setPhase({ kind: 'idle' });
      setError(err instanceof RestoreStopped ? err.problem : 'This file couldn’t be checked. Try again.');
    }
  };

  const chosen = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    if (looksProtected(head)) {
      setPassphrase('');
      setPhase({ kind: 'passphrase', file });
      return;
    }
    await read(blobSource(file, false));
  };

  const open = async (file: File) => {
    setPhase({ kind: 'opening', done: 0 });
    try {
      const opened = await openFile(file, passphrase, (p) => {
        if (p.kind === 'working') setPhase({ kind: 'opening', done: p.done });
      });
      setPassphrase('');
      await read(blobSource(opened, true));
    } catch (err) {
      setPhase({ kind: 'passphrase', file, error: openFailure(err) });
    }
  };

  /** Sends what the record doesn't have yet, then finishes. */
  const goOn = async (source: FileSource, collected: Collected, rec: Pick<RecordView, 'id' | 'done' | 'plan'>, plan?: Plan) => {
    setPhase({ kind: 'sending', done: rec.done, total: rec.plan.batches });
    try {
      await sendBatches(source, collected, rec, { fetcher: pageFetch, plan, onProgress: (done, total) => setPhase({ kind: 'sending', done, total }) });
      setPhase({ kind: 'finishing' });
      await finishRestore(pageFetch, rec.id);
      setPhase({ kind: 'idle' });
    } catch (err) {
      setPhase({ kind: 'idle' });
      setError(err instanceof RestoreStopped ? `${err.problem}${err.retryAfter ? ` It can go on in about ${Math.ceil(err.retryAfter / 60)} minutes.` : ''}` : 'The restore stopped. Choose the same file to go on.');
    }
    await load(false);
    onChanged?.();
  };

  /** Finishes a restore every batch of which is written (a finish that
   *  stopped, or took too long): no file needed. */
  const finishNow = async (id: string) => {
    setError(null);
    setPhase({ kind: 'finishing' });
    try {
      await finishRestore(pageFetch, id);
    } catch (err) {
      setError(err instanceof RestoreStopped ? err.problem : 'The restore couldn’t be finished. Try again.');
    }
    setPhase({ kind: 'idle' });
    await load(false);
    onChanged?.();
  };

  const start = async (loaded: Loaded, plan: Plan) => {
    setError(null);
    setPhase({ kind: 'starting', loaded, plan });
    const answer = await asked('POST', '/api/user-restore', startBody(loaded.preview, plan, loaded.source, newUserRestoreId(), null));
    setPassword('');
    if (!answer) return setPhase({ kind: 'preview', loaded, plan });
    if (isHint(answer)) {
      setPhase({ kind: 'preview', loaded, plan });
      return setError('Nya couldn’t confirm it’s you. Sign out and in again, then try again.');
    }
    if (!answer.ok) {
      setPhase({ kind: 'preview', loaded, plan });
      setError(answer.error);
      if (answer.status === 409) await load(true);
      return;
    }
    // The dashboard is read again once it has finished (goOn), not before:
    // the page this card is on may change as the account fills.
    await goOn(loaded.source, loaded.collected, answer.body.record as RecordView, plan);
  };

  const undo = async () => {
    if (!record) return;
    setError(null);
    setPhase({ kind: 'working', what: 'Undoing the restore. This takes a minute or two.' });
    const answer = await asked('DELETE', '/api/user-restore', { restore_id: record.id, confirm: true });
    setPassword('');
    setConfirmUndo(false);
    setPhase({ kind: 'idle' });
    if (answer && !isHint(answer) && !answer.ok) setError(answer.error);
    await load(true);
    onChanged?.();
  };

  const empty = async () => {
    setError(null);
    setPhase({ kind: 'working', what: 'Emptying this account.' });
    const answer = await asked('POST', '/api/user-restore', { action: 'empty', confirm: emptyWords.trim().toLowerCase() });
    setPassword('');
    setEmptyWords('');
    setPhase({ kind: 'idle' });
    if (answer && !isHint(answer) && !answer.ok) setError(answer.error);
    await load(true);
    onChanged?.();
  };

  const stopFollowing = async (accounts: { account_id: string }[], from: string) => {
    setError(null);
    setPhase({ kind: 'working', what: 'Saving…' });
    for (const a of accounts) {
      const answer = await ask('POST', '/api/account-lifecycle', { account_id: a.account_id, state: 'untracked', from });
      if (!isHint(answer) && !answer.ok) {
        setError(answer.error);
        break;
      }
    }
    setPhase({ kind: 'idle' });
    await load(false);
    onChanged?.();
  };

  if (loadError) {
    return (
      <div className="card download-card restore-card">
        <div className="inst-header">
          <div className="inst-name">Bring back a download</div>
        </div>
        <div className="error">{loadError}</div>
      </div>
    );
  }
  if (!state) return null;
  // Not offered here, unless a restore is recorded (its undo stays).
  const notes = unreadableNotes(state, listedDay);
  if (!state.enabled && !record && notes.length === 0) return null;

  const scan = state.scan;
  const banks = waitingBanks(state.waiting);
  const passwordField = needsPassword && (
    <label className="field">
      Your app password, to confirm it’s you
      <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
    </label>
  );

  return (
    <div className="card download-card restore-card">
      <div className="inst-header">
        <div className="inst-name">Bring back a download</div>
      </div>

      {state.demo ? (
        <p className="panel-note">Demo accounts can’t bring a download back: everyone who tries the demo shares its data.</p>
      ) : (
        <>
          {!record && !state.record_unreadable && (
            <p className="panel-note">
              Moving to another copy of Nya, or starting again after deleting your account? Choose a JSON download (from Download my data, protected or not) to bring
              everything in it into this account: your accounts and their history, your transactions and what you said about them, your categories, budgets,
              goals and settings. It goes only into an account with nothing in it yet. The file stays on this device: it is read here, a few megabytes at a time,
              and checked to its end before anything is written.
            </p>
          )}

          {notes.map((n) => (
            <p key={n.words} className="stale-note">
              {n.words}
            </p>
          ))}

          {record && <RecordSummary record={record} />}

          {unfinished && record?.status === 'writing' && record.done < record.plan.batches && (
            <p className="stale-note">
              This restore hasn’t finished: {plainNumber(record.done)} of {plainNumber(record.plan.batches)} parts are written, so what you see is only part
              of your data, and no net worth total is recorded meanwhile. Choose the same file to go on, or undo it.
            </p>
          )}
          {unfinished && record?.status === 'writing' && record.done === record.plan.batches && (
            <>
              <p className="stale-note">Every part of this restore is written, but it hasn’t finished: no net worth total is recorded until it does.</p>
              {state.enabled && phase.kind === 'idle' && <button onClick={() => void finishNow(record.id)}>Finish the restore</button>}
            </>
          )}
          {record?.status === 'undoing' && <p className="stale-note">This restore is being undone. If that stopped part way, undo it again to finish.</p>}

          {/* The file: chosen for a new restore, or to go on with one. */}
          {state.enabled && (!record || record.status === 'writing') && (
            <>
              {!record && !scan && phase.kind === 'idle' && (
                <button className="secondary" onClick={() => void load(true)}>
                  Check whether this account can take one
                </button>
              )}
              {!record && scan && !scan.empty && scan.message && <p className="stale-note">{scan.message}</p>}
              {(record ? record.done < record.plan.batches : scan?.empty === true) && phase.kind === 'idle' && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".json,.age,application/json"
                    className="visually-hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      void chosen(f);
                    }}
                  />
                  <button onClick={() => fileInput.current?.click()} disabled={busy}>
                    {record ? 'Choose the same file to go on' : 'Choose a download'}
                  </button>
                  {!record && scan && scan.settings.length > 0 && (
                    <p className="panel-note">This account has settings of its own: the file’s replace them.</p>
                  )}
                </>
              )}
            </>
          )}

          {phase.kind === 'passphrase' && (
            <>
              <p className="panel-note">This download is protected with a passphrase. It is opened here, on this device, and never sent anywhere.</p>
              <label className="field">
                Its passphrase
                <input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
              </label>
              {phase.error && <div className="error">{phase.error}</div>}
              <div className="card-actions">
                <button className="secondary" onClick={() => setPhase({ kind: 'idle' })}>
                  Cancel
                </button>
                <button onClick={() => void open(phase.file)} disabled={!passphrase}>
                  Open it
                </button>
              </div>
            </>
          )}

          <div aria-live="polite">
            {phase.kind === 'opening' && <p className="panel-note">Opening the file with its passphrase… {Math.round(phase.done * 100)}%</p>}
            {phase.kind === 'reading' && <p className="panel-note">Reading the file and checking every part of it…</p>}
            {phase.kind === 'checking' && <p className="panel-note">Checking it with Nya: {plainNumber(phase.batches)} parts so far…</p>}
            {phase.kind === 'sending' && (
              <p className="panel-note">
                Bringing it back: {plainNumber(phase.done)} of {plainNumber(phase.total)} parts written. Keep this page open.
              </p>
            )}
            {phase.kind === 'finishing' && <p className="panel-note">Finishing…</p>}
            {phase.kind === 'working' && <p className="panel-note">{phase.what}</p>}
            {error && <div className="error">{error}</div>}
          </div>

          {(phase.kind === 'preview' || phase.kind === 'starting') && (
            <PreviewView
              loaded={phase.loaded}
              sharing={sharingLines(state.sharing ?? [])}
              withoutOk={withoutOk}
              onWithoutOk={setWithoutOk}
              passwordField={passwordField}
              busy={phase.kind === 'starting'}
              blocked={(needsPassword && !password) || !withoutOk}
              onCancel={() => setPhase({ kind: 'idle' })}
              onRestore={() => void start(phase.loaded, phase.plan)}
              clerk={!needsPassword}
            />
          )}

          {record?.status === 'finished' && banks.length > 0 && (
            <div className="restore-section">
              <div className="section-label">Waiting for an answer</div>
              <p className="panel-note">
                No net worth total is recorded while a bank brought back waits: a total without it would be short for good. For each one, connect it again and link
                each account to its new one when Nya offers (its transactions then count once), or stop following it.
              </p>
              {banks.map((b) => (
                <div key={b.institution_name} className="restore-bank">
                  <div className="restore-bank-name">{b.institution_name}</div>
                  <p className="panel-note">
                    {b.accounts.map(accountWords).join(', ')}
                    {b.last ? `: transactions up to ${b.last}` : ''}
                  </p>
                  <label className="field">
                    Stop following from
                    <input
                      type="date"
                      value={stopFrom[b.institution_name] ?? b.from ?? ''}
                      onChange={(e) => setStopFrom((s) => ({ ...s, [b.institution_name]: e.target.value }))}
                      disabled={busy}
                    />
                  </label>
                  <button
                    className="secondary"
                    disabled={busy || !(stopFrom[b.institution_name] ?? b.from)}
                    onClick={() => void stopFollowing(b.accounts, stopFrom[b.institution_name] ?? b.from!)}
                  >
                    Stop following {b.institution_name}
                  </button>
                </div>
              ))}
            </div>
          )}

          {record && canUndo(record, Date.now()) && phase.kind === 'idle' && (
            <div className="restore-section">
              <div className="section-label">Undo</div>
              <p className="panel-note">
                Undo empties this account again. Everything in it goes: what the restore brought back{record.started_at ? ` on ${day(record.started_at)}` : ''} and
                anything added or changed since. Your sign-in and API tokens stay. Download your data first to keep anything since.
                {record.status === 'finished' && record.undo_until ? ` Offered until ${day(record.undo_until)}.` : ''}
              </p>
              {/* The download first, here, whichever screen this card is on. */}
              {downloadFirst ? (
                <DownloadMyData clerk={!needsPassword} />
              ) : (
                <button className="secondary" onClick={() => setDownloadFirst(true)}>
                  Download my data first
                </button>
              )}
              <label className="plan-check">
                <input type="checkbox" checked={confirmUndo} onChange={(e) => setConfirmUndo(e.target.checked)} /> Empty this account again
              </label>
              {confirmUndo && passwordField}
              {!needsPassword && confirmUndo && <p className="panel-note">If you haven’t signed in within the last few minutes, you’ll be asked to confirm it’s you first.</p>}
              <button className="danger" disabled={!confirmUndo || (needsPassword && !password)} onClick={() => void undo()}>
                Undo the restore
              </button>
            </div>
          )}

          {record?.status === 'finished' && !canUndo(record, Date.now()) && (
            <p className="panel-note">This restore can no longer be undone: it finished more than {state.undo_days} days ago.</p>
          )}

          {/* For an account that holds data no restore brought, or a record
              that can't be read: everything goes but the sign-in. */}
          {state.enabled && phase.kind === 'idle' && ((!record && scan && !scan.empty) || state.record_unreadable || (record?.status === 'finished' && !canUndo(record, Date.now()))) && (
            <div className="restore-section">
              <div className="section-label">Empty this account first</div>
              <p className="panel-note">
                Deletes everything in this account but your sign-in and API tokens: accounts, history, transactions, budgets, goals and settings. Download your data
                first to keep a copy. Disconnect any bank first. To go ahead, type “{EMPTY_WORDS}”.
              </p>
              <label className="field">
                Type “{EMPTY_WORDS}”
                <input value={emptyWords} onChange={(e) => setEmptyWords(e.target.value)} autoComplete="off" />
              </label>
              {emptyWords.trim().toLowerCase() === EMPTY_WORDS && passwordField}
              <button className="danger" disabled={emptyWords.trim().toLowerCase() !== EMPTY_WORDS || (needsPassword && !password)} onClick={() => void empty()}>
                Empty this account
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** What a restore brought back, and from which download. */
export function RecordSummary({ record }: { record: RecordView }) {
  const lines = broughtLines(record.brought, record.history);
  return (
    <div className="restore-section">
      <p className={record.status === 'finished' ? 'status-note' : 'panel-note'}>
        {record.status === 'finished' && record.finished_at
          ? `Brought back on ${day(record.finished_at)}, from a download made ${day(record.source.exported_at)}${record.source.protected ? ' (protected)' : ''}.`
          : `Started on ${day(record.started_at)}, from a download made ${day(record.source.exported_at)}.`}
      </p>
      {record.status === 'finished' && lines.length > 0 && (
        <ul className="restore-list">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {record.earlier.length > 0 && (
        <p className="panel-note">
          That download was itself brought back into the copy it came from: {record.earlier.map((e) => `on ${day(e.restored_at)}, from one made ${day(e.exported_at)}`).join('; ')}.
        </p>
      )}
    </div>
  );
}

/** What the file would bring back and what it wouldn't, before the start. */
export function PreviewView({
  loaded,
  sharing = [],
  withoutOk,
  onWithoutOk,
  passwordField,
  busy,
  blocked,
  onCancel,
  onRestore,
  clerk,
}: {
  loaded: Loaded;
  sharing?: readonly string[];
  withoutOk: boolean;
  onWithoutOk: (ok: boolean) => void;
  passwordField: ReactNode;
  busy: boolean;
  blocked: boolean;
  onCancel: () => void;
  onRestore: () => void;
  clerk: boolean;
}) {
  const p = loaded.preview;
  const brought = broughtLines(p.brought, p.history);
  const left = leftOutLines(p.left_out, p.collected.never);
  return (
    <div className="restore-section">
      <div className="section-label">What comes back</div>
      <p className="panel-note">From a download made {day(p.collected.exported_at)}:</p>
      <ul className="restore-list">
        {brought.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <div className="section-label">What doesn’t</div>
      <ul className="restore-list">
        {left.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {sharing.length > 0 && (
        <>
          <div className="section-label">Shared already</div>
          <p className="panel-note">This account already shares with these people, so they will see what comes back as you share it:</p>
          <ul className="restore-list">
            {sharing.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </>
      )}
      {p.collected.notes.length > 0 && (
        <>
          <div className="section-label">What the file says</div>
          {p.collected.notes.map((n) => (
            <p key={n} className="panel-note">
              {n}
            </p>
          ))}
        </>
      )}
      {p.without.length > 0 && (
        <>
          <div className="section-label">Damaged in the file</div>
          <p className="stale-note">Some of what the other copy kept couldn’t be read when the file was made, so it isn’t in it. Brought back without it:</p>
          {p.without.map((w) => (
            <div key={w.part} className="restore-without">
              <p className="panel-note">{w.words}</p>
              {w.affects.length > 0 && (
                <ul className="restore-list">
                  {w.affects.slice(0, 20).map((f, i) => (
                    <li key={i}>
                      {f.date} · {f.name} · <Masked>{formatMoney(f.amount, f.currency)}</Masked>
                    </li>
                  ))}
                  {w.affects.length > 20 && <li>and {plainNumber(w.affects.length - 20)} more</li>}
                </ul>
              )}
            </div>
          ))}
          <label className="plan-check">
            <input type="checkbox" checked={withoutOk} onChange={(e) => onWithoutOk(e.target.checked)} /> Bring it back without them
          </label>
        </>
      )}
      {passwordField}
      {clerk && <p className="panel-note">If you haven’t signed in within the last few minutes, you’ll be asked to confirm it’s you first.</p>}
      <div className="card-actions">
        <button className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button onClick={onRestore} disabled={busy || blocked}>
          {busy ? 'Starting…' : 'Bring it back'}
        </button>
      </div>
    </div>
  );
}
