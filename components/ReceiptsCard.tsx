'use client';

// Receipts and documents, under Manage accounts (#47): every file kept, what
// is used of the space this copy of Nya allows, and the files as ZIP files.
//
// THE LIST. Newest first, fifty at a time, each with its thumbnail (fetched
// as it scrolls into view; an icon instead while amounts are hidden, as on a
// transaction) and the transaction it is on, as it was when the file was
// placed. Narrowed by year, by money out over an amount, and to those that
// need the person: not on a transaction (its transaction went), waiting on
// the bank (a disconnected one, or a pending transaction still to post), or
// on one of two transactions that look the same. Each
// opens in the viewer (components/AttachmentViewer.tsx), to be saved, moved,
// renamed or deleted.
//
// ONE COPY. This copy of Nya keeps one copy of each file and no backup of it
// (docs/operations.md), so the card says when the files were last
// downloaded, and asks for a download when they never were or not for 90
// days.
//
// THE ZIP FILES (app/api/attachments/download). About 50 MB each, decrypted,
// each behind a fresh sign-in as every download of your data is (Clerk's
// useReverification, or the app password typed here), and counted as one
// download for the set: the first's answer carries a token the others send.
// Each is checked whole against the size the server announced before it is
// saved (components/DownloadMyData.tsx). A passphrase protects them all, kept
// in the page only until the last is saved.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReverification } from '@clerk/nextjs';
import { isReverificationCancelledError } from '@clerk/nextjs/errors';
import { amountsHidden, formatMoney } from '@/lib/format';
import { localDate } from '@/lib/local-date';
import { OPEN_DOWNLOAD_PATH } from '@/lib/download-options';
import { Masked } from './HideAmounts';
import { useAmountsHidden } from './hide-amounts';
import { PassphraseFields, passphraseHint } from './DownloadOptions';
import { CUT_OFF, formatBytes } from './DownloadMyData';
import { listFiles, looseWords, saveBlob, sizeWords, thumbUrl, type FileView, type ListAnswer } from './attachment-client';
import AttachmentViewer, { DocIcon, fileDay, fileTitle } from './AttachmentViewer';
import { shortDay, type PickRow } from './attachment-pick';
import { amountTyped } from './receipt-filter';

const PAGE = 50;
/** Days after which the card asks for a download again. */
export const REMIND_DAYS = 90;

export type Need = '' | 'loose' | 'waiting' | 'check';

/** Which of the person's attention a file needs, if any. */
export function needOf(f: Pick<FileView, 'place'>): Need {
  if (f.place.on === 'none') return 'loose';
  if (f.place.on === 'earlier' || f.place.posting) return 'waiting';
  return f.place.check ? 'check' : '';
}

/** The files the filters keep, in order. */
export function filterFiles(files: readonly FileView[], f: { year: string; over: string; need: Need }): FileView[] {
  const min = amountTyped(f.over);
  return files.filter(
    (x) =>
      (!f.year || fileDay(x).startsWith(f.year)) &&
      (min === null || (x.as_placed !== null && x.as_placed.amount > min)) &&
      (!f.need || needOf(x) === f.need)
  );
}

/** What the card says of the last download (D3), and whether to ask for one. */
export function downloadReminder(zipAt: string | null, files: number, now: Date = new Date()): { text: string; ask: boolean } | null {
  if (files === 0) return null;
  const one = 'This copy of Nya keeps one copy of each file, so download them to keep your own.';
  if (!zipAt) return { text: `${one} You haven’t downloaded them yet.`, ask: true };
  const days = Math.floor((now.getTime() - Date.parse(zipAt)) / 86_400_000);
  return { text: `${one} Last downloaded ${shortDay(zipAt.slice(0, 10))}.`, ask: days >= REMIND_DAYS };
}

// ---- The ZIP files ----

type VolumeSummary = { volume: number; files: number; bytes: number; from: string | null; to: string | null };
/** The download made ready (GET /api/attachments/download): what each
 *  volume holds, and `plan`, the signed plan every volume is asked with, so
 *  each is the one made ready, whatever changes meanwhile. */
type Plan = { volumes: VolumeSummary[]; left_out: { id: string; why: string }[]; unreadable: number; plan: string };

type ZipPhase =
  | { kind: 'idle' }
  | { kind: 'confirming'; volume: number }
  | { kind: 'preparing'; volume: number }
  | { kind: 'receiving'; volume: number; bytes: number; total: number }
  | { kind: 'error'; message: string };

type Hint = { clerk_error: { type: string; reason: string } };
type VolumeRequest = { volume: number; volumes: number; plan: string; set: string | null; passphrase: string | null };
type VolumeOutcome =
  | { ok: true; blob: Blob; filename: string; set: string | null; notes: string[]; added: number }
  | { ok: false; error: string; expired?: true }
  | Hint;

function isHint(v: unknown): v is Hint {
  const e = (v as Hint | null)?.clerk_error;
  return !!e && e.type === 'forbidden' && e.reason === 'reverification-error';
}

/** A volume's name, with the viewer's own date. */
export function volumeFilename(volume: number, volumes: number, protectedFile: boolean, now: Date = new Date()): string {
  return `nya-attachments-${localDate(now)}-${volume}-of-${volumes}.zip${protectedFile ? '.age' : ''}`;
}

function notesOf(header: string | null): string[] {
  if (!header) return [];
  try {
    const notes = JSON.parse(decodeURIComponent(header));
    return Array.isArray(notes) ? notes.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

/** One volume, read to its end and checked against the size announced. A
 *  hint is handed back as it came, for Clerk's hook. */
async function requestVolume(r: VolumeRequest, password: string | null, setPhase: (p: ZipPhase) => void): Promise<VolumeOutcome> {
  setPhase({ kind: 'preparing', volume: r.volume });
  let res: Response;
  try {
    res = await fetch('/api/attachments/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: r.volume, plan: r.plan, ...(r.set ? { set: r.set } : {}), ...(r.passphrase ? { passphrase: r.passphrase } : {}), ...(password === null ? {} : { password }) }),
    });
  } catch {
    return { ok: false, error: 'Nya could not be reached. Check your connection and try again.' };
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (isHint(data)) {
      setPhase({ kind: 'confirming', volume: r.volume });
      return data;
    }
    return { ok: false, error: typeof data?.error === 'string' ? data.error : 'The download didn’t work. Try again.', ...(data?.plan_expired === true ? { expired: true as const } : {}) };
  }
  const declared = res.headers.get('x-nya-export-bytes');
  const reader = res.body?.getReader();
  if (declared === null || !/^\d+$/.test(declared) || !reader) {
    await reader?.cancel().catch(() => {});
    return { ok: false, error: CUT_OFF };
  }
  const total = Number(declared);
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      bytes += value.length;
      setPhase({ kind: 'receiving', volume: r.volume, bytes, total });
    }
  } catch {
    return { ok: false, error: CUT_OFF };
  }
  if (bytes !== total) return { ok: false, error: CUT_OFF };
  return {
    ok: true,
    blob: new Blob(parts as BlobPart[], { type: res.headers.get('content-type') ?? 'application/zip' }),
    filename: volumeFilename(r.volume, r.volumes, !!r.passphrase),
    set: res.headers.get('x-nya-set'),
    notes: notesOf(res.headers.get('x-nya-export-notes')),
    added: Number(res.headers.get('x-nya-added') ?? 0) || 0,
  };
}

type ZipProps = { send: (r: VolumeRequest, password: string | null, setPhase: (p: ZipPhase) => void) => Promise<VolumeOutcome>; needsPassword: boolean; onSaved: () => void };

function ZipWithClerk({ onSaved }: { onSaved: () => void }) {
  const verified = useReverification((r: VolumeRequest, setPhase: (p: ZipPhase) => void) => requestVolume(r, null, setPhase));
  return <ZipDownload needsPassword={false} send={(r, _password, setPhase) => verified(r, setPhase)} onSaved={onSaved} />;
}

function ZipDownload({ send, needsPassword, onSaved }: ZipProps) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<ZipPhase>({ kind: 'idle' });
  const [set, setSet] = useState<string | null>(null);
  const [saved, setSaved] = useState<number[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  // Files added after the download was made ready: in no volume of it.
  const [added, setAdded] = useState(0);
  const [password, setPassword] = useState('');
  const [protect, setProtect] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');

  const getPlan = async () => {
    setLoading(true);
    setPlanError(null);
    try {
      const res = await fetch('/api/attachments/download', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) setPlanError(typeof data?.error === 'string' ? data.error : 'Your receipts and documents couldn’t be listed.');
      else {
        setPlan(data as Plan);
        setSet(null);
        setSaved([]);
        setNotes([]);
        setAdded(0);
        setPhase({ kind: 'idle' });
      }
    } catch {
      setPlanError('Nya could not be reached. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const busy = phase.kind === 'confirming' || phase.kind === 'preparing' || phase.kind === 'receiving';
  const blocked = (needsPassword && !password) || (protect && passphraseHint(passphrase, confirm) !== null);

  const download = async (v: VolumeSummary) => {
    if (!plan) return;
    try {
      const out = await send({ volume: v.volume, volumes: plan.volumes.length, plan: plan.plan, set, passphrase: protect ? passphrase : null }, needsPassword ? password : null, setPhase);
      if (isHint(out)) return setPhase({ kind: 'error', message: 'Nya couldn’t confirm it’s you. Sign out and in again, then try again.' });
      if (!out.ok) {
        // Made ready too long ago: it is made ready again, from the start.
        if (out.expired) {
          setPlan(null);
          setSaved([]);
        }
        return setPhase({ kind: 'error', message: out.error });
      }
      saveBlob(out.blob, out.filename);
      if (out.set) setSet(out.set);
      setNotes(out.notes);
      setAdded(out.added);
      const next = [...new Set([...saved, v.volume])];
      setSaved(next);
      setPhase({ kind: 'idle' });
      onSaved();
      // Every volume saved: the passphrase and the password leave the page.
      if (next.length === plan.volumes.length) {
        setPassword('');
        setPassphrase('');
        setConfirm('');
      }
    } catch (err) {
      setPhase(isReverificationCancelledError(err) ? { kind: 'idle' } : { kind: 'error', message: 'The download didn’t work. Try again.' });
    }
  };

  return (
    <div className="receipts-zip">
      <div className="section-label">Download as ZIP files</div>
      <p className="panel-note">
        Every file, decrypted, in ZIP files of about 50 MB, in the order you added them, each in a folder by the year of its transaction, with a list of what
        each file is on. Protect them with a passphrase: they show what you bought.
      </p>
      {!plan ? (
        <button className="secondary" onClick={getPlan} disabled={loading}>
          {loading ? 'Listing…' : 'Get the download ready'}
        </button>
      ) : plan.volumes.length === 0 ? (
        <p className="panel-note">There is nothing to download.</p>
      ) : (
        <>
          <PassphraseFields on={protect} onToggle={setProtect} passphrase={passphrase} onPassphrase={setPassphrase} confirm={confirm} onConfirm={setConfirm} disabled={busy} />
          {needsPassword ? (
            <label className="field">
              Your app password, to confirm it’s you
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            </label>
          ) : (
            <p className="panel-note">If you haven’t signed in within the last few minutes, you’ll be asked to confirm it’s you first, and again for a later file if it takes long.</p>
          )}
          <ul className="receipts-volumes">
            {plan.volumes.map((v) => (
              <li key={v.volume}>
                <button className={saved.includes(v.volume) ? 'secondary' : undefined} disabled={busy || blocked} onClick={() => download(v)}>
                  {plan.volumes.length === 1 ? 'Download' : `Download file ${v.volume} of ${plan.volumes.length}`}
                </button>
                <span className="receipts-volume-note">
                  {v.files} {v.files === 1 ? 'file' : 'files'}, {formatBytes(v.bytes)}
                  {v.from && v.to ? `, added ${v.from === v.to ? v.from : `${v.from} to ${v.to}`}` : ''}
                  {saved.includes(v.volume) ? ' · saved' : ''}
                </span>
              </li>
            ))}
          </ul>
          {plan.left_out.length > 0 && (
            <p className="stale-note">
              {plan.left_out.length === 1 ? 'One file is' : `${plan.left_out.length} files are`} left out: {plan.left_out.length === 1 ? 'it isn’t' : 'they aren’t'} whole in storage. The list
              in the last ZIP file names {plan.left_out.length === 1 ? 'it' : 'them'}.
            </p>
          )}
          {plan.unreadable > 0 && <p className="stale-note">{plan.unreadable === 1 ? 'One record' : `${plan.unreadable} records`} couldn’t be read, so not every file is here.</p>}
        </>
      )}
      <div aria-live="polite">
        {phase.kind === 'confirming' && <p className="panel-note">Confirm it’s you in the window that opened.</p>}
        {phase.kind === 'preparing' && <p className="panel-note">Preparing file {phase.volume}: each receipt is read and decrypted first.</p>}
        {phase.kind === 'receiving' && (
          <p className="panel-note">
            Downloading file {phase.volume}… {formatBytes(phase.bytes)} of {formatBytes(phase.total)}
          </p>
        )}
        {protect && saved.length > 0 && (
          <p className="panel-note">
            They are protected with your passphrase. Open each on <a href={OPEN_DOWNLOAD_PATH}>Open a protected download</a> or with the age app.
          </p>
        )}
        {notes.map((n) => (
          <p key={n} className="stale-note">
            {n}
          </p>
        ))}
        {added > 0 && (
          <button className="secondary" onClick={getPlan} disabled={busy || loading}>
            Get the download ready again
          </button>
        )}
        {planError && <div className="error">{planError}</div>}
        {phase.kind === 'error' && <div className="error">{phase.message}</div>}
      </div>
    </div>
  );
}

// ---- The card ----

export default function ReceiptsCard({ clerk, rows, onChanged }: { clerk: boolean; rows: readonly PickRow[] | null; onChanged: () => void }) {
  // Drawn again when the switch changes; the flag itself answers where
  // there is no browser to subscribe to (a render in a test).
  const hidden = useAmountsHidden() || amountsHidden();
  const [answer, setAnswer] = useState<ListAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState('');
  const [over, setOver] = useState('');
  const [need, setNeed] = useState<Need>('');
  const [shown, setShown] = useState(PAGE);
  const [viewing, setViewing] = useState<number | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    const out = await listFiles();
    if ('error' in out) setError(out.error);
    else {
      setError(null);
      setAnswer(out);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const files = useMemo(() => answer?.files ?? [], [answer]);
  const years = useMemo(() => [...new Set(files.map((f) => fileDay(f).slice(0, 4)))].sort().reverse(), [files]);
  const counts = useMemo(() => {
    const c = { loose: 0, waiting: 0, check: 0 };
    for (const f of files) {
      const n = needOf(f);
      if (n) c[n]++;
    }
    return c;
  }, [files]);
  const kept = useMemo(() => filterFiles(files, { year, over, need }), [files, year, over, need]);

  if (!answer) {
    return error ? (
      <div className="card receipts-card">
        <div className="inst-header">
          <div className="inst-name">Receipts and documents</div>
        </div>
        <div className="error">{error}</div>
      </div>
    ) : null;
  }
  const { usage, mode } = answer;
  const reminder = downloadReminder(usage.zip_at, files.length);
  const shownFiles = kept.slice(0, shown);

  return (
    <div className="card receipts-card">
      <div className="inst-header">
        <div className="inst-name">Receipts and documents</div>
        <div className="inst-total">
          {usage.files} {usage.files === 1 ? 'file' : 'files'}
        </div>
      </div>
      <p className="panel-note">
        Photos and PDFs attached to your transactions, encrypted, and never shared, even where the transaction is.{' '}
        {usage.quota_bytes !== null ? `${sizeWords(usage.bytes)} used of the ${sizeWords(usage.quota_bytes)} this copy of Nya allows.` : `${sizeWords(usage.bytes)} used.`}
      </p>
      {!mode.uploads && <p className="panel-note">Adding new ones is off on this copy of Nya; those already attached can still be opened, moved, deleted and downloaded.</p>}
      {reminder && <p className={reminder.ask ? 'stale-note' : 'panel-note'}>{reminder.text}</p>}
      {answer.deleting > 0 && (
        <p className="stale-note">
          {answer.deleting === 1 ? 'One is' : `${answer.deleting} are`} being deleted: {answer.deleting === 1 ? 'it' : 'they'} can’t be opened any more, and a nightly run finishes
          removing {answer.deleting === 1 ? 'it' : 'them'}.
        </p>
      )}
      {answer.unreadable.length > 0 && <p className="stale-note">{answer.unreadable.length === 1 ? 'One couldn’t' : `${answer.unreadable.length} couldn’t`} be read just now, so the list isn’t whole.</p>}
      {answer.unrecognised.length > 0 && <p className="stale-note">{answer.unrecognised.length === 1 ? 'One is' : `${answer.unrecognised.length} are`} saved in a form this version of Nya doesn’t know.</p>}
      {error && <div className="error">{error}</div>}
      {said && <p className="status-note">{said}</p>}

      {files.length > 0 && (
        <div className="receipts-filters">
          <select className="text-input" value={need} onChange={(e) => setNeed(e.target.value as Need)} aria-label="Show which">
            <option value="">All</option>
            {counts.loose > 0 && <option value="loose">Not on a transaction ({counts.loose})</option>}
            {counts.waiting > 0 && <option value="waiting">Waiting on your bank ({counts.waiting})</option>}
            {counts.check > 0 && <option value="check">To check which transaction ({counts.check})</option>}
          </select>
          {years.length > 1 && (
            <select className="text-input" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
              <option value="">Every year</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          )}
          <input className="text-input" inputMode="decimal" autoComplete="off" value={over} onChange={(e) => setOver(e.target.value)} placeholder="Money out over" aria-label="Money out over, in each transaction’s own currency" />
        </div>
      )}
      {(counts.loose > 0 || counts.waiting > 0 || counts.check > 0) && need === '' && (
        <p className="panel-note">
          {[
            counts.loose > 0 ? `${counts.loose} not on a transaction` : null,
            counts.waiting > 0 ? `${counts.waiting} waiting on your bank` : null,
            counts.check > 0 ? `${counts.check} to check` : null,
          ]
            .filter(Boolean)
            .join(', ')}
          : choose them above.
        </p>
      )}

      {files.length === 0 ? (
        <p className="empty-note">Nothing attached yet. Open a transaction on the Activity tab to attach a receipt or a document.</p>
      ) : kept.length === 0 ? (
        <p className="empty-note">None match.</p>
      ) : (
        <ul className="receipts-list">
          {shownFiles.map((f, i) => {
            const why = looseWords(f.place);
            return (
              <li key={f.id}>
                <button className="receipts-item" onClick={() => setViewing(i)}>
                  <span className="receipts-thumb">
                    {f.kind === 'image' && f.thumb && !hidden && !f.damaged ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumbUrl(f.id)} alt="" loading="lazy" />
                    ) : (
                      <DocIcon />
                    )}
                  </span>
                  <span className="receipts-text">
                    <span className="receipts-name">{f.as_placed?.name ?? fileTitle(f)}</span>
                    <span className="receipts-sub">
                      {shortDay(fileDay(f))}
                      {f.as_placed && (
                        <>
                          {' · '}
                          <Masked>{formatMoney(-f.as_placed.amount, f.as_placed.currency)}</Masked>
                        </>
                      )}
                      {` · ${f.kind === 'pdf' ? 'PDF' : 'Photo'}, ${sizeWords(f.bytes)}`}
                      {f.damaged ? ' · damaged' : ''}
                    </span>
                    {why && <span className="receipts-why">{why}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {kept.length > shown && (
        <button className="secondary" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, kept.length - shown)} more
        </button>
      )}

      {files.length > 0 && (clerk ? <ZipWithClerk onSaved={() => void load()} /> : <ZipDownload needsPassword send={requestVolume} onSaved={() => void load()} />)}

      <AttachmentViewer
        files={shownFiles}
        index={viewing}
        onIndex={setViewing}
        onClose={() => setViewing(null)}
        rows={rows}
        onChanged={(words) => {
          setSaid(words);
          setViewing(null);
          void load();
          onChanged();
        }}
      />
    </div>
  );
}
