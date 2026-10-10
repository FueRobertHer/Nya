'use client';

// Download my data (app/api/my-data, lib/user-export.ts), under Manage
// accounts. The person picks a format, confirms it is them, and the file is
// saved by the browser.
//
// THE FRESH SIGN-IN. With Clerk, the request goes through Clerk's
// useReverification: when the server answers that the sign-in isn't recent
// enough, Clerk opens its own "confirm it's you" window and sends the request
// again once that is done. With the shared password, the password is asked
// for here and sent with the request.
//
// WHOLE FILES ONLY. The server says how many bytes the file is before
// sending it (X-Nya-Export-Bytes), and the page counts what arrives: nothing
// is saved unless the two agree. A connection cut part way, or a stream the
// platform ends early without an error, leaves nothing behind rather than a
// file that looks complete and isn't. Saved through a short-lived object URL,
// revoked once the browser has the file; nothing is kept in the page's
// storage. Named with the viewer's own date, not the server's UTC one.
//
// AN INCOMPLETE FILE SAYS SO. Something stored that is damaged, or saved in a
// form this version doesn't know, never stops the download: the file holds
// everything else, and the server names the parts it is missing something
// from (X-Nya-Export-Incomplete) beside its notes. Then the card says plainly
// that the file is incomplete, above the notes that say what is missing.

import { useState } from 'react';
import { useReverification } from '@clerk/nextjs';
import { isReverificationCancelledError } from '@clerk/nextjs/errors';
import { DOWNLOADS_PER_WINDOW } from '@/lib/download-limit';
import { localDate } from '@/lib/local-date';

export type Format = 'json' | 'transactions-csv' | 'balances-csv';

/** The formats, described. `sharing`: whether there is sharing to include
 *  (with Clerk; with the shared password there are no people to share with). */
export function formatsFor(sharing: boolean): { value: Format; label: string; note: string }[] {
  return [
    {
      value: 'json',
      label: 'Everything (JSON)',
      note: `Accounts, balance history, transactions, investment transactions, budgets, goals${sharing ? ', account links and sharing settings' : ' and account links'}, in one file.`,
    },
    {
      value: 'transactions-csv',
      label: 'Transactions (CSV)',
      note: 'Every stored bank and card transaction, one per row, for a spreadsheet. Investment transactions are in the JSON file only.',
    },
    { value: 'balances-csv', label: 'Balance history (CSV)', note: 'Net worth and each account’s balance, day by day.' },
  ];
}

/** What a page that can't tell the whole file arrived says, and saves nothing. */
export const CUT_OFF = 'The download was cut off part way, so nothing was saved. Try again.';

/** How the file is laid out, field by field. */
export const FORMAT_GUIDE = 'https://github.com/FueRobertHer/Nya/blob/main/docs/data-export.md';

export type Phase =
  | { kind: 'idle' }
  /** Clerk's window is asking the person to confirm it is them. */
  | { kind: 'confirming' }
  /** The server is reading and decrypting everything. */
  | { kind: 'preparing' }
  | { kind: 'receiving'; bytes: number; total: number }
  /** `incomplete`: the parts of the JSON file it is made from that are
   *  missing something (X-Nya-Export-Incomplete), empty when it is whole. */
  | { kind: 'done'; filename: string; bytes: number; notes: string[]; incomplete: string[] }
  | { kind: 'error'; message: string };

type Hint = { clerk_error: { type: string; reason: string } };
type Outcome = { ok: true; blob: Blob; filename: string; notes: string[]; incomplete: string[] } | { ok: false; error: string } | Hint;

/** Clerk's reverification hint, as app/api/my-data answers with it. */
function isHint(v: unknown): v is Hint {
  const e = (v as Hint | null)?.clerk_error;
  return !!e && e.type === 'forbidden' && e.reason === 'reverification-error';
}

/** The file's name, with the viewer's own date: the server's is the UTC day,
 *  which is tomorrow from a US evening on. */
export function localFilename(format: Format, now: Date = new Date()): string {
  const day = localDate(now);
  if (format === 'json') return `nya-data-${day}.json`;
  return `nya-${format === 'transactions-csv' ? 'transactions' : 'balances'}-${day}.csv`;
}

/** The parts a file is missing something from: keys, comma-separated. */
export function incompleteOf(header: string | null): string[] {
  return (header ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
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

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One request for the file, read to its end and checked against the size the
 * server announced. Never a Response: Clerk's hook reads a Response as JSON,
 * which the file is not. A hint is handed back as it came, for the hook to act
 * on.
 */
export async function requestFile(format: Format, password: string | null, setPhase: (p: Phase) => void): Promise<Outcome> {
  setPhase({ kind: 'preparing' });
  let res: Response;
  try {
    res = await fetch('/api/my-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(password === null ? { format } : { format, password }),
    });
  } catch {
    return { ok: false, error: 'Nya could not be reached. Check your connection and try again.' };
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (isHint(data)) {
      setPhase({ kind: 'confirming' });
      return data;
    }
    return { ok: false, error: typeof data?.error === 'string' ? data.error : 'The download didn’t work. Try again.' };
  }
  // Without the size there is no telling a whole file from part of one.
  const declared = res.headers.get('x-nya-export-bytes');
  const reader = res.body?.getReader();
  if (declared === null || !/^\d+$/.test(declared) || !reader) {
    await reader?.cancel().catch(() => {});
    return { ok: false, error: CUT_OFF };
  }
  const total = Number(declared);
  const notes = notesOf(res.headers.get('x-nya-export-notes'));
  const incomplete = incompleteOf(res.headers.get('x-nya-export-incomplete'));
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      bytes += value.length;
      setPhase({ kind: 'receiving', bytes, total });
    }
  } catch {
    return { ok: false, error: CUT_OFF };
  }
  // Ended without an error, but short (or long): not the file that was sent.
  if (bytes !== total) return { ok: false, error: CUT_OFF };
  return { ok: true, blob: new Blob(parts as BlobPart[], { type }), filename: localFilename(format), notes, incomplete };
}

/** Hands the file to the browser to save. */
function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for the browser to have taken it; then the page lets go.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The state both kinds of sign-in share, and what to do with an outcome. */
function useDownload() {
  const [format, setFormat] = useState<Format>('json');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const run = async (request: () => Promise<Outcome>) => {
    try {
      const outcome = await request();
      if (isHint(outcome)) {
        setPhase({ kind: 'error', message: 'Nya couldn’t confirm it’s you. Sign out and in again, then try again.' });
      } else if (!outcome.ok) {
        setPhase({ kind: 'error', message: outcome.error });
      } else {
        save(outcome.blob, outcome.filename);
        setPassword('');
        setPhase({ kind: 'done', filename: outcome.filename, bytes: outcome.blob.size, notes: outcome.notes, incomplete: outcome.incomplete });
      }
    } catch (err) {
      if (isReverificationCancelledError(err)) setPhase({ kind: 'idle' });
      else setPhase({ kind: 'error', message: 'The download didn’t work. Try again.' });
    }
  };
  return { format, setFormat, password, setPassword, phase, setPhase, run };
}

function WithClerk() {
  const d = useDownload();
  const verified = useReverification((format: Format) => requestFile(format, null, d.setPhase));
  return (
    <DownloadMyDataView
      format={d.format}
      onFormat={d.setFormat}
      needsPassword={false}
      password=""
      onPassword={() => {}}
      phase={d.phase}
      onDownload={() => d.run(() => verified(d.format))}
    />
  );
}

function WithPassword() {
  const d = useDownload();
  return (
    <DownloadMyDataView
      format={d.format}
      onFormat={d.setFormat}
      needsPassword
      password={d.password}
      onPassword={d.setPassword}
      phase={d.phase}
      onDownload={() => d.run(() => requestFile(d.format, d.password, d.setPhase))}
    />
  );
}

/** `clerk`: whether sign-in is Clerk's (lib/auth-mode.ts). Clerk's hook only
 *  works inside its provider, which exists only then. */
export default function DownloadMyData({ clerk }: { clerk: boolean }) {
  return clerk ? <WithClerk /> : <WithPassword />;
}

export function DownloadMyDataView({
  format,
  onFormat,
  needsPassword,
  password,
  onPassword,
  phase,
  onDownload,
}: {
  format: Format;
  onFormat: (f: Format) => void;
  needsPassword: boolean;
  password: string;
  onPassword: (s: string) => void;
  phase: Phase;
  onDownload: () => void;
}) {
  const busy = phase.kind === 'confirming' || phase.kind === 'preparing' || phase.kind === 'receiving';
  // With the shared password there are no people, so no sharing to include.
  const sharing = !needsPassword;
  return (
    <div className="card download-card">
      <div className="inst-header">
        <div className="inst-name">Download my data</div>
      </div>
      <p className="panel-note">
        A copy of what Nya keeps for you: your accounts and their balance history (recorded and estimated days marked),
        every transaction with your own categories and merchant names, investment transactions, budgets, goals and
        account links{sharing ? ', and what you share' : ''}. The file isn’t encrypted, so keep it somewhere safe.
      </p>
      <p className="panel-note">
        Left out: the access tokens Nya uses to reach your banks through Plaid (credentials, not your data, and they
        only work for Nya), and the app’s own machinery, such as caches and counters. The file lists everything it
        leaves out, and why.
      </p>

      <fieldset className="download-formats" disabled={busy}>
        <legend className="section-label">Format</legend>
        {formatsFor(sharing).map((f) => (
          <label key={f.value} className="download-format">
            <input type="radio" name="download-format" value={f.value} checked={format === f.value} onChange={() => onFormat(f.value)} />
            <span>
              <span className="download-format-name">{f.label}</span>
              <span className="download-format-note">{f.note}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {needsPassword ? (
        <label className="field">
          Your app password, to confirm it’s you
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && password && !busy) onDownload();
            }}
            disabled={busy}
          />
        </label>
      ) : (
        <p className="panel-note">If you haven’t signed in within the last few minutes, you’ll be asked to confirm it’s you first.</p>
      )}

      <button onClick={onDownload} disabled={busy || (needsPassword && !password)}>
        {busy ? 'Preparing…' : 'Download'}
      </button>

      <div aria-live="polite">
        {phase.kind === 'confirming' && <p className="panel-note">Confirm it’s you in the window that opened.</p>}
        {phase.kind === 'preparing' && (
          <p className="panel-note">Preparing your file. Everything is read and decrypted first, so this can take a few seconds.</p>
        )}
        {phase.kind === 'receiving' && (
          <p className="panel-note">
            Downloading… {formatBytes(phase.bytes)} of {formatBytes(phase.total)}
          </p>
        )}
        {phase.kind === 'done' && (
          <>
            <p className="status-note">
              Saved {phase.filename} ({formatBytes(phase.bytes)}).
            </p>
            {phase.incomplete.length > 0 && (
              <p className="stale-note">
                This file is incomplete: some of what Nya keeps for you could not be read, so it isn’t in the file. What’s
                missing is below. Nothing was changed.
              </p>
            )}
            {phase.notes.map((n, i) => (
              <p key={i} className="stale-note">
                {n}
              </p>
            ))}
          </>
        )}
        {phase.kind === 'error' && <div className="error">{phase.message}</div>}
      </div>

      <p className="panel-note">
        Up to {DOWNLOADS_PER_WINDOW} downloads an hour.{' '}
        <a href={FORMAT_GUIDE} target="_blank" rel="noreferrer">
          What each field means
        </a>
      </p>
    </div>
  );
}
