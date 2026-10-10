'use client';

// Opens a download protected with a passphrase (lib/protected-download.ts),
// in the browser, on the public page app/open-download. The file is read from
// the person's own device and decrypted here with the passphrase they type:
// nothing is sent anywhere (nothing here makes a request), and the page needs
// no sign-in, so a file still opens after the account it came from is gone.
//
// WHOLE OR NOTHING. The age format (lib/age/age.ts) authenticates each 64 KiB
// part and marks the last, so a file cut short, reordered or changed fails to
// open, and nothing is saved until every part has opened.
//
// THE SLOW PART is unlocking the key with the passphrase (scrypt,
// lib/age/scrypt.ts): a few seconds and 256 MB at the setting Nya writes,
// which is what makes guessing a passphrase slow too. The page says how far
// it has got. A file protected with a slower setting than a browser can
// manage is sent to the age app.
//
// MEMORY. A phone may stop a page that holds too much, so the file is never
// read whole: its header first, then a few megabytes at a time after the
// key is unlocked (lib/age/age.ts blobSource), and what has opened is kept
// as Blobs a few megabytes each, which a browser can hold outside the page's
// own memory, rather than as one growing array. At the peak, during the
// unlocking, that is the 256 MB and little else. A device that can't spare
// that much is told so, and to use a computer.

import { useState } from 'react';
import { AgeError, WORK_FACTOR, blobSource, openWithPassphrase } from '@/lib/age/age';
import { scrypt } from '@/lib/age/scrypt';
import { NOT_A_SIGN_IN } from '@/components/DownloadOptions';

export type OpenPhase =
  | { kind: 'idle' }
  /** Unlocking the key with the passphrase, then opening the contents. */
  | { kind: 'working'; step: 'key' | 'contents'; done: number }
  | { kind: 'done'; name: string; blob: Blob }
  | { kind: 'error'; message: string };

/** A file's size in words. */
export function sizeOf(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The opened file's name: the protected one's without ".age", or with
 *  ".opened" added when it didn't end so. A number a browser added to a
 *  second copy ("x.json (1).age", "x.json(1).age", "x.json-2.age") goes
 *  before the extension, so the opened file still opens by its type. */
export function openedName(name: string): string {
  if (!/\.age$/i.test(name) || name.length <= 4) return `${name}.opened`;
  const bare = name.slice(0, -4);
  const copy = /^(.+)(\.(?:json|csv|ofx))( ?\(\d+\)|-\d+)$/i.exec(bare);
  return copy ? `${copy[1]}${copy[3]}${copy[2]}` : bare;
}

/** The opened file's type, from its name: what a protected download holds. */
function typeOf(name: string): string {
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.csv$/i.test(name)) return 'text/csv';
  if (/\.ofx$/i.test(name)) return 'application/x-ofx';
  return 'application/octet-stream';
}

/** Why a file didn't open, in words for the person (lib/age/age.ts AgeFailure). */
export function openFailure(err: unknown): string {
  if (!(err instanceof AgeError)) {
    // What a browser throws when it can't find the memory for the key's
    // work: a RangeError, or Firefox's InternalError, saying so.
    if (err instanceof RangeError || (err instanceof Error && /memory|allocat/i.test(err.message))) {
      return 'This device couldn’t spare the memory to open the file here. Open it on a computer, on this page or with the age app.';
    }
    return 'The file couldn’t be opened here. Try again, or open it with the age app.';
  }
  switch (err.kind) {
    case 'passphrase':
      return err.message === 'That passphrase doesn’t open this file.'
        ? 'That passphrase doesn’t open this file. Type it exactly as you set it: capitals, spaces and punctuation count.'
        : err.message;
    case 'not-age':
      return 'This isn’t a protected download: those end in .age. A file ending in .json, .csv or .ofx is already open.';
    case 'unsupported':
      return err.message;
    case 'mac':
      return 'This file was changed after it was made, so it can’t be trusted, and nothing was opened. Download it again.';
    case 'header':
    case 'payload':
      return 'This file is damaged or incomplete (it may have been cut short while it was saved), so nothing was opened. Download it again.';
  }
}

/** Hands the opened file to the browser to save, then lets it go. */
function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** How much of the opened file is gathered before it becomes a Blob. */
const GATHER = 4 * 1024 * 1024;

/** Opens `file` with `passphrase`, saying how far it has got: its contents,
 *  once every part has opened (see MEMORY in the header). */
export async function openFile(file: Blob, passphrase: string, onPhase: (p: OpenPhase) => void): Promise<Blob> {
  onPhase({ kind: 'working', step: 'key', done: 0 });
  const opened: Blob[] = [];
  let gathered: Uint8Array[] = [];
  let bytes = 0;
  await openWithPassphrase(
    blobSource(file),
    passphrase,
    {
      scrypt: (p, salt, N, r, par, len) => scrypt(p, salt, N, r, par, len, (done) => onPhase({ kind: 'working', step: 'key', done })),
      // What Nya writes, which is what the age app writes too: a slower
      // setting needs more memory than a browser tab can count on.
      maxWorkFactor: WORK_FACTOR,
      onPayloadProgress: (done) => onPhase({ kind: 'working', step: 'contents', done }),
    },
    (part) => {
      gathered.push(part);
      bytes += part.length;
      if (bytes >= GATHER) {
        opened.push(new Blob(gathered as BlobPart[]));
        gathered = [];
        bytes = 0;
      }
    }
  );
  opened.push(new Blob(gathered as BlobPart[]));
  return new Blob(opened);
}

export default function OpenProtectedDownload() {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [phase, setPhase] = useState<OpenPhase>({ kind: 'idle' });

  const open = async () => {
    if (!file || !passphrase) return;
    try {
      const contents = await openFile(file, passphrase, setPhase);
      const name = openedName(file.name);
      const blob = new Blob([contents], { type: typeOf(name) });
      setPassphrase('');
      save(blob, name);
      setPhase({ kind: 'done', name, blob });
    } catch (err) {
      setPhase({ kind: 'error', message: openFailure(err) });
    }
  };

  return (
    <OpenProtectedDownloadView
      fileName={file?.name ?? null}
      onFile={(f) => {
        setFile(f);
        setPhase({ kind: 'idle' });
      }}
      passphrase={passphrase}
      onPassphrase={setPassphrase}
      phase={phase}
      onOpen={open}
      onSaveAgain={() => phase.kind === 'done' && save(phase.blob, phase.name)}
    />
  );
}

export function OpenProtectedDownloadView({
  fileName,
  onFile,
  passphrase,
  onPassphrase,
  phase,
  onOpen,
  onSaveAgain,
}: {
  fileName: string | null;
  onFile: (file: File | null) => void;
  passphrase: string;
  onPassphrase: (s: string) => void;
  phase: OpenPhase;
  onOpen: () => void;
  onSaveAgain: () => void;
}) {
  const busy = phase.kind === 'working';
  const ready = !!fileName && !!passphrase && !busy;
  return (
    <section className="card info-section open-download">
      <h2>Open a file</h2>
      <label className="field">
        The protected file (its name ends in .age)
        <input type="file" accept=".age" onChange={(e) => onFile(e.target.files?.[0] ?? null)} disabled={busy} />
      </label>
      <label className="field">
        Its passphrase
        <input
          type="password"
          {...NOT_A_SIGN_IN}
          value={passphrase}
          onChange={(e) => onPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready) onOpen();
          }}
          disabled={busy}
        />
      </label>
      <button onClick={onOpen} disabled={!ready}>
        {busy ? 'Opening…' : 'Open'}
      </button>
      <div aria-live="polite">
        {phase.kind === 'working' && phase.step === 'key' && (
          <p className="panel-note">
            Unlocking it with your passphrase… {Math.round(phase.done * 100)}%. This takes a few seconds on purpose: it is
            what makes guessing a passphrase slow.
          </p>
        )}
        {phase.kind === 'working' && phase.step === 'contents' && <p className="panel-note">Opening… {Math.round(phase.done * 100)}%</p>}
        {phase.kind === 'done' && (
          <>
            <p className="status-note">
              Opened and saved {phase.name} ({sizeOf(phase.blob.size)}). It isn’t protected any more, so keep it somewhere
              safe.
            </p>
            <button className="secondary" onClick={onSaveAgain}>
              Save it again
            </button>
          </>
        )}
        {phase.kind === 'error' && <div className="error">{phase.message}</div>}
      </div>
    </section>
  );
}
