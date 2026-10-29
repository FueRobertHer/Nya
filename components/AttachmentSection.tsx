'use client';

// A transaction's receipts and documents (#47), in its row's sheet on the
// Activity tab: the files on it, and adding one by taking a photo or
// choosing a file. Read when the row is opened, never with the list: the
// list says only which rows have one (lib/activity.ts `attached`).
//
// WHERE A FILE GOES. On the transaction itself: a split transaction's whole,
// never a part; a group's row shows its transactions' files, and a file is
// added from one of its transactions. A bank row standing for a row imported
// from the bank's file shows that row's files too (`attached_on`).
//
// GETTING IT READY. Each file is made ready in the browser first
// (components/attachment-capture.ts: a photo made smaller and re-encoded,
// which drops where it was taken), then sent part by part
// (components/attachment-client.ts), one file at a time, with its progress.
// A file refused says why, and nothing of it is kept.
//
// WITH AMOUNTS HIDDEN its photos are drawn as icons, not thumbnails: a
// receipt shows what was paid. The viewer asks before showing one.
//
// Nothing is offered where the file store isn't connected; adding is not
// offered where it is off (no quota set, docs/operations.md), and the files
// already attached can still be opened, moved and deleted.

import { useCallback, useEffect, useRef, useState } from 'react';
import { prepareFile } from './attachment-capture';
import { filesOn, quotaNote, thumbUrl, uploadFile, type FileView, type Mode, type Usage } from './attachment-client';
import AttachmentViewer, { DocIcon, fileTitle, fileDay } from './AttachmentViewer';
import { shortDay, type PickRow } from './attachment-pick';
import { useAmountsHidden } from './hide-amounts';
import { amountsHidden } from '@/lib/format';
import { Notice } from './TotalCaveats';

/** At most this many on one transaction (lib/attachments.ts PER_TRANSACTION). */
export const PER_TRANSACTION = 10;

/** What the section reads of a row. */
export type AttachRow = PickRow & {
  attached?: true | null;
  attached_on?: string[];
  group_id?: string;
};

/** The transaction a file added from this row goes on, or null for none (a
 *  group's row). */
export function attachTarget(t: Pick<AttachRow, 'transaction_id' | 'split_of' | 'group_members'>): string | null {
  if (t.group_members) return null;
  return t.split_of ?? t.transaction_id;
}

/** The transactions whose files the row shows: its own and those it stands
 *  for, or a group's transactions'. */
export function shownIds(t: AttachRow): string[] {
  const target = attachTarget(t);
  return [...new Set([...(target ? [target] : []), ...(t.attached_on ?? [])])].slice(0, 12);
}

type Loaded = { mode: Mode; files: FileView[]; usage: Usage | null };
type Sending = { name: string; at: number; of: number; sent: number; total: number; preparing: boolean };

export default function AttachmentSection({ t, rows, onChanged }: { t: AttachRow; rows: readonly PickRow[] | null; onChanged: () => void }) {
  // Drawn again when the switch changes; the flag itself answers where
  // there is no browser to subscribe to (a render in a test).
  const hidden = useAmountsHidden() || amountsHidden();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const target = attachTarget(t);
  const ids = shownIds(t).join(',');

  const load = useCallback(async () => {
    if (!ids) return;
    const out = await filesOn(ids.split(','));
    if ('error' in out) setReadError(out.error);
    else {
      setReadError(null);
      setLoaded(out);
    }
  }, [ids]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!ids) return null;
  const files = loaded?.files ?? [];
  const mode = loaded?.mode ?? null;
  const canAdd = !!target && !!mode?.connected && mode.uploads && files.length < PER_TRANSACTION;
  // Nothing to show, nor to offer: no section at all.
  if (loaded && files.length === 0 && !canAdd && t.attached !== null) return null;
  if (!loaded && !readError) {
    return t.attached ? (
      <div className="attach-section" aria-busy="true">
        <div className="section-label">Receipts and documents</div>
        <p className="rename-hint">Opening…</p>
      </div>
    ) : null;
  }

  const send = async (list: FileList | null) => {
    if (!list || list.length === 0 || !target) return;
    const chosen = [...list].slice(0, PER_TRANSACTION - files.length);
    const failed: string[] = [];
    let added = 0;
    setSaid(null);
    setProblems([]);
    for (const [i, file] of chosen.entries()) {
      const name = file.name || 'Photo';
      setSending({ name, at: i + 1, of: chosen.length, sent: 0, total: 0, preparing: true });
      const ready = await prepareFile(file);
      if ('refused' in ready) {
        failed.push(chosen.length > 1 ? `${name}: ${ready.refused}` : ready.refused);
        continue;
      }
      const out = await uploadFile(target, ready, (p) => setSending({ name, at: i + 1, of: chosen.length, sent: p.sent, total: p.total, preparing: false }));
      if ('error' in out) failed.push(chosen.length > 1 ? `${name}: ${out.error}` : out.error);
      else added++;
    }
    if (list.length > chosen.length) failed.push(`At most ${PER_TRANSACTION} files can be on one transaction.`);
    setSending(null);
    setProblems(failed);
    if (added > 0) {
      setSaid(added === 1 ? 'Attached.' : `${added} files attached.`);
      await load();
      onChanged();
    }
  };

  const quota = quotaNote(loaded?.usage ?? null);
  return (
    <div className="attach-section">
      <div className="section-label">Receipts and documents</div>
      {t.attached === null && <p className="rename-hint">Whether this has any couldn’t be read with the list.</p>}
      {readError && (
        <Notice level="critical" role="alert">
          {readError}
        </Notice>
      )}

      {files.length > 0 && (
        <ul className="attach-thumbs">
          {files.map((f, i) => (
            <li key={f.id}>
              <button className="attach-thumb" onClick={() => setViewing(i)} aria-label={`Open ${fileTitle(f)}, from ${shortDay(fileDay(f))}`}>
                {f.kind === 'image' && f.thumb && !hidden && !f.damaged ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumbUrl(f.id)} alt="" loading="lazy" />
                ) : (
                  <span className="attach-thumb-icon">
                    <DocIcon />
                    <span>{f.damaged ? 'Damaged' : f.kind === 'pdf' ? 'PDF' : 'Photo'}</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {canAdd && (
        <>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void send(e.target.files).finally(() => (e.target.value = ''))} />
          <input ref={chooser} type="file" accept="image/*,application/pdf,.heic,.heif,.pdf" multiple hidden onChange={(e) => void send(e.target.files).finally(() => (e.target.value = ''))} />
          <div className="button-pair attach-add">
            <button className="secondary" disabled={!!sending} onClick={() => camera.current?.click()}>
              Take a photo
            </button>
            <button className="secondary" disabled={!!sending} onClick={() => chooser.current?.click()}>
              Choose a file
            </button>
          </div>
        </>
      )}
      {mode?.connected && !mode.uploads && files.length > 0 && <p className="rename-hint">Adding new receipts and documents is off on this copy of Nya.</p>}

      <div className="stack tight">
        <div aria-live="polite">
          {sending && (
            <div className="attach-progress">
              <span>
                {sending.preparing ? 'Getting it ready' : 'Sending'}
                {sending.of > 1 ? ` ${sending.at} of ${sending.of}` : ''}…
              </span>
              {!sending.preparing && sending.total > 0 && <progress max={sending.total} value={sending.sent} aria-label="Sent so far" />}
            </div>
          )}
          {said && <p className="status-note">{said}</p>}
        </div>
        {problems.map((p) => (
          <Notice key={p} level="critical" role="alert">
            {p}
          </Notice>
        ))}
      </div>
      {quota && <p className="rename-hint">{quota}</p>}

      <AttachmentViewer
        files={files}
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
