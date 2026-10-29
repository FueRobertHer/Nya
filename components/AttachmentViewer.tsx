'use client';

// One receipt or document, full screen (#47): opened from a transaction's
// sheet (components/AttachmentSection.tsx) or from Receipts and documents
// in Settings, Your data and privacy (components/ReceiptsCard.tsx).
//
// A PHOTO is shown from the app's own address (/api/attachments/<id>/file),
// opened on the server for the signed-in person alone, never cached; it
// zooms with a pinch, a double tap or double click, the + and - buttons or
// keys, and moves with a drag once zoomed. Its text alternative names the
// transaction it is on, its amount said through spoken() so a hidden amount
// is heard as "hidden".
//
// WITH AMOUNTS HIDDEN a photo is not drawn until the person asks for it
// ("Show receipt"): a receipt shows what was paid, and the switch is there
// for a screen being watched. It is hidden again when the viewer closes.
//
// A PDF is never drawn in the page: the server sends it to be saved
// (lib/attachment-http.ts), so it opens in the person's own app, with what
// it carries.
//
// From here a file can be saved, moved to another transaction (a search of
// the transactions loaded, components/attachment-pick.ts), renamed or
// deleted. Each change goes to the server and the list is read again.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { amountsHidden, formatMoney, onDay, spoken } from '@/lib/format';
import { Masked } from './HideAmounts';
import { useAmountsHidden } from './hide-amounts';
import { deleteFile, fileUrl, moveFile, renameFile, saveFile, sizeWords, looseWords, type FileView } from './attachment-client';
import { candidates, findCandidates, shortDay, type PickRow } from './attachment-pick';
import { Notice } from './TotalCaveats';

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const STEP = 1.5;
const DOUBLE_TAP_MS = 300;

/** What the viewer says a file is. */
export function fileTitle(f: Pick<FileView, 'name' | 'kind'>): string {
  return f.name ?? (f.kind === 'pdf' ? 'Document' : 'Receipt');
}

/** The day a file is filed under: its transaction's, else when it was added. */
export function fileDay(f: Pick<FileView, 'as_placed' | 'created_at'>): string {
  return f.as_placed?.date ?? f.created_at.slice(0, 10);
}

/** A photo's text alternative: what it is of, its amount said as the switch
 *  allows (spoken by the caller). */
export function altText(f: Pick<FileView, 'as_placed' | 'created_at' | 'name'>): string {
  const p = f.as_placed;
  if (!p) return `Receipt${f.name ? ` ${f.name}` : ''}, added ${shortDay(f.created_at, { sentence: true })}`;
  return `Receipt for ${p.name}, ${formatMoney(Math.abs(p.amount), p.currency)} ${onDay(shortDay(p.date, { sentence: true }))}`;
}

/** A file's name as saved: its own, else what it is of and the day. */
export function savedName(f: Pick<FileView, 'name' | 'kind' | 'as_placed' | 'created_at'>): string {
  const ext = f.kind === 'pdf' ? '.pdf' : '.jpg';
  if (f.name) return /\.(pdf|jpe?g)$/i.test(f.name) ? f.name : `${f.name}${ext}`;
  const of = (f.as_placed?.name ?? 'receipt').replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 40) || 'receipt';
  return `${fileDay(f)} ${of}${ext}`;
}

type Zoom = { scale: number; x: number; y: number };
const FIT: Zoom = { scale: 1, x: 0, y: 0 };
const clamp = (n: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));

/** A zoomed photo, moved by pointers: one drags, two pinch. */
function Zoomable({ src, alt, zoom, onZoom, onBroken }: { src: string; alt: string; zoom: Zoom; onZoom: (z: Zoom) => void; onBroken: () => void }) {
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ zoom: Zoom; dist: number; x: number; y: number } | null>(null);
  const lastTap = useRef(0);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const begin = () => {
    const pts = [...pointers.current.values()];
    if (pts.length === 0) return (start.current = null);
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    const x = pts.reduce((n, p) => n + p.x, 0) / pts.length;
    const y = pts.reduce((n, p) => n + p.y, 0) / pts.length;
    start.current = { zoom: zoomRef.current, dist, x, y };
  };

  return (
    <div
      className="attach-stage"
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        begin();
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId) || !start.current) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pts = [...pointers.current.values()];
        const s = start.current;
        const x = pts.reduce((n, p) => n + p.x, 0) / pts.length;
        const y = pts.reduce((n, p) => n + p.y, 0) / pts.length;
        if (pts.length > 1 && s.dist > 0) {
          const scale = clamp((s.zoom.scale * Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)) / s.dist);
          onZoom(scale === 1 ? FIT : { scale, x: s.zoom.x + (x - s.x), y: s.zoom.y + (y - s.y) });
        } else if (s.zoom.scale > 1) {
          onZoom({ ...s.zoom, x: s.zoom.x + (x - s.x), y: s.zoom.y + (y - s.y) });
        }
      }}
      onPointerUp={(e) => {
        const wasOne = pointers.current.size === 1;
        pointers.current.delete(e.pointerId);
        begin();
        if (!wasOne || e.pointerType === 'mouse') return;
        // A double tap: in to 2.5x, or back to fit.
        const now = Date.now();
        if (now - lastTap.current < DOUBLE_TAP_MS) {
          lastTap.current = 0;
          onZoom(zoomRef.current.scale > 1 ? FIT : { scale: 2.5, x: 0, y: 0 });
        } else lastTap.current = now;
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        begin();
      }}
      onDoubleClick={() => onZoom(zoomRef.current.scale > 1 ? FIT : { scale: 2.5, x: 0, y: 0 })}
      onWheel={(e) => {
        if (!e.ctrlKey) return;
        const scale = clamp(zoomRef.current.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        onZoom(scale === 1 ? FIT : { ...zoomRef.current, scale });
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="attach-img"
        src={src}
        alt={alt}
        draggable={false}
        onError={onBroken}
        style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
      />
    </div>
  );
}

type Step = { kind: 'view' } | { kind: 'move' } | { kind: 'rename' } | { kind: 'delete' };

export default function AttachmentViewer({
  files,
  index,
  onIndex,
  onClose,
  onChanged,
  rows,
}: {
  files: readonly FileView[];
  /** The file shown, or null for none (closed). */
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** After a change: the files read again (and the transactions, for the
   *  paperclip). `gone`: the file shown left the list. */
  onChanged: (said: string | null) => void;
  /** The transactions a file can be moved to: those the Activity tab loaded. */
  rows: readonly PickRow[] | null;
}) {
  // Drawn again when the switch changes; the flag itself answers where
  // there is no browser to subscribe to (a render in a test).
  const hidden = useAmountsHidden() || amountsHidden();
  const f = index !== null ? (files[index] ?? null) : null;
  const [revealed, setRevealed] = useState(false);
  const [zoom, setZoom] = useState<Zoom>(FIT);
  const [broken, setBroken] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'view' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const panel = useRef<HTMLDivElement>(null);

  // A new file: fitted, its controls back to the start. Shown again only if
  // the person asked to see receipts while this viewer is open.
  const id = f?.id ?? null;
  useEffect(() => {
    setZoom(FIT);
    setBroken(false);
    setStep({ kind: 'view' });
    setError(null);
    setQuery('');
  }, [id]);
  // Closed: hidden again.
  const open = f !== null;
  useEffect(() => {
    if (!open) setRevealed(false);
  }, [open]);

  // While open: the page behind doesn't scroll, focus is in the viewer, and
  // goes back where it was.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    panel.current?.focus({ preventScroll: true });
    return () => {
      root.style.overflow = overflow;
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [open]);

  const all = useMemo(() => (rows ? candidates(rows, f?.place.on === 'transaction' ? f.place.transaction_id : null) : []), [rows, f]);
  const found = useMemo(() => findCandidates(all, query), [all, query]);

  if (!f) return null;
  const isImage = f.kind === 'image' && !f.damaged;
  const showing = isImage && (!hidden || revealed) && !broken;
  const many = files.length > 1;
  const loose = looseWords(f.place);

  /** A change sent, and what to say once it is made: `said` undefined for
   *  none to read again (a file saved). */
  const run = async (work: () => Promise<{ ok: true; data: unknown } | { error: string } | string | null>, said?: (data: unknown) => string | null, after?: () => void) => {
    setBusy(true);
    setError(null);
    const out = await work();
    setBusy(false);
    const problem = typeof out === 'string' ? out : out && 'error' in out ? out.error : null;
    if (problem) return setError(problem);
    after?.();
    if (said) onChanged(said(out && typeof out === 'object' && 'data' in out ? out.data : null));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (step.kind !== 'view') setStep({ kind: 'view' });
      else onClose();
      return;
    }
    if (step.kind !== 'view' || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (showing && (e.key === '+' || e.key === '=')) setZoom((z) => ({ ...z, scale: clamp(z.scale * STEP) }));
    else if (showing && e.key === '-') setZoom((z) => (clamp(z.scale / STEP) === 1 ? FIT : { ...z, scale: clamp(z.scale / STEP) }));
    else if (many && zoom.scale === 1 && e.key === 'ArrowRight' && index! < files.length - 1) onIndex(index! + 1);
    else if (many && zoom.scale === 1 && e.key === 'ArrowLeft' && index! > 0) onIndex(index! - 1);
  };

  const placed = f.as_placed;
  const view = (
    <div className="attach-viewer" role="dialog" aria-modal="true" aria-label={fileTitle(f)} tabIndex={-1} ref={panel} onKeyDown={onKey}>
      <div className="attach-viewer-head">
        <div className="attach-viewer-title">
          <div className="attach-viewer-name">{fileTitle(f)}</div>
          <div className="attach-viewer-sub">
            {placed ? (
              <>
                {placed.name} · {shortDay(placed.date, { sentence: true })} · <Masked>{formatMoney(Math.abs(placed.amount), placed.currency)}</Masked>
              </>
            ) : (
              `Added ${shortDay(f.created_at, { sentence: true })}`
            )}
            {` · ${f.kind === 'pdf' ? 'PDF' : 'Photo'}, ${sizeWords(f.bytes)}`}
          </div>
        </div>
        <button className="sheet-icon-btn" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="attach-viewer-body">
        {f.damaged ? (
          <p className="attach-viewer-note">This file is damaged and can’t be opened. Delete it, and attach it again if you still have it.</p>
        ) : f.kind === 'pdf' ? (
          <div className="attach-viewer-doc">
            <DocIcon />
            <p className="attach-viewer-note">A PDF opens in your own app: save it to read it.</p>
          </div>
        ) : broken ? (
          <p className="attach-viewer-note">This file couldn’t be opened just now. Try again, or delete it if it keeps happening.</p>
        ) : !showing ? (
          <div className="attach-viewer-doc">
            <p className="attach-viewer-note">Amounts are hidden, and a receipt shows them.</p>
            <button className="secondary attach-reveal" onClick={() => setRevealed(true)}>
              Show receipt
            </button>
          </div>
        ) : (
          <Zoomable src={fileUrl(f.id)} alt={spoken(altText(f))} zoom={zoom} onZoom={setZoom} onBroken={() => setBroken(true)} />
        )}
      </div>

      <div className="attach-viewer-foot">
        {loose && <p className="attach-viewer-note attach-viewer-loose">{loose}</p>}
        {error && (
          <Notice level="critical" role="alert">
            {error}
          </Notice>
        )}

        {step.kind === 'view' && (
          <>
            {(many || showing) && (
              <div className="attach-viewer-row">
                {many && (
                  <button className="secondary" onClick={() => onIndex(index! - 1)} disabled={index === 0} aria-label="Previous file">
                    Previous
                  </button>
                )}
                {many && (
                  <span className="attach-viewer-count" aria-live="polite">
                    {index! + 1} of {files.length}
                  </span>
                )}
                {many && (
                  <button className="secondary" onClick={() => onIndex(index! + 1)} disabled={index === files.length - 1} aria-label="Next file">
                    Next
                  </button>
                )}
                {showing && (
                  <>
                    <button className="secondary" onClick={() => setZoom((z) => (clamp(z.scale / STEP) === 1 ? FIT : { ...z, scale: clamp(z.scale / STEP) }))} disabled={zoom.scale <= 1} aria-label="Zoom out">
                      −
                    </button>
                    <button className="secondary" onClick={() => setZoom((z) => ({ ...z, scale: clamp(z.scale * STEP) }))} disabled={zoom.scale >= MAX_ZOOM} aria-label="Zoom in">
                      +
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="attach-viewer-actions">
              {!f.damaged && (
                <button className="secondary" disabled={busy} onClick={() => run(() => saveFile(f.id, savedName(f)))}>
                  Save
                </button>
              )}
              {rows && (
                <button className="secondary" disabled={busy} onClick={() => setStep({ kind: 'move' })}>
                  {f.place.on === 'transaction' ? 'Attach to another transaction' : 'Attach to a transaction'}
                </button>
              )}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setNameDraft(f.name ?? '');
                  setStep({ kind: 'rename' });
                }}
              >
                Rename
              </button>
              <button className="danger-outline" disabled={busy} onClick={() => setStep({ kind: 'delete' })}>
                Delete
              </button>
            </div>
          </>
        )}

        {step.kind === 'move' && (
          <div className="attach-picker">
            <label className="field">
              Which transaction?
              <input
                className="text-input"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Merchant, amount or day"
                autoFocus
              />
            </label>
            <ul className="attach-picker-list">
              {found.map((c) => (
                <li key={c.id}>
                  <button
                    className="secondary attach-picker-item"
                    disabled={busy}
                    onClick={() => run(() => moveFile(f.id, c.id), () => `Moved to ${c.name} ${onDay(shortDay(c.date, { sentence: true }))}.`, () => setStep({ kind: 'view' }))}
                  >
                    <span className="attach-picker-text">
                      <span>{c.name}</span>
                      <span className="attach-picker-day">
                        {shortDay(c.date)}
                        {c.pending ? ' · pending' : ''}
                      </span>
                    </span>
                    <span className="num">
                      <Masked>{formatMoney(-c.amount, c.currency)}</Masked>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {found.length === 0 && <p className="attach-viewer-note">No transaction loaded matches. Only the last 12 months are here.</p>}
            <button className="secondary" onClick={() => setStep({ kind: 'view' })}>
              Cancel
            </button>
          </div>
        )}

        {step.kind === 'rename' && (
          <div className="attach-rename">
            <label className="field">
              Name
              <input className="text-input" value={nameDraft} maxLength={120} onChange={(e) => setNameDraft(e.target.value)} placeholder={f.kind === 'pdf' ? 'Invoice' : 'Receipt'} autoFocus />
            </label>
            <div className="button-pair">
              <button className="secondary" onClick={() => setStep({ kind: 'view' })} disabled={busy}>
                Cancel
              </button>
              <button disabled={busy || nameDraft.trim() === (f.name ?? '')} onClick={() => run(() => renameFile(f.id, nameDraft.trim() || null), () => 'Renamed.', () => setStep({ kind: 'view' }))}>
                Save
              </button>
            </div>
          </div>
        )}

        {step.kind === 'delete' && (
          <div className="attach-delete">
            <p className="attach-viewer-note">
              Delete this {f.kind === 'pdf' ? 'document' : 'receipt'}? It can’t be opened from then on, and once it is gone from the file store (at once, or by a
              later nightly run if the store can’t be reached), no backup can bring it back.
            </p>
            <div className="button-pair">
              <button className="secondary" onClick={() => setStep({ kind: 'view' })} disabled={busy}>
                Keep it
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  run(
                    () => deleteFile(f.id),
                    (data) =>
                      (data as { finished?: boolean } | null)?.finished === false
                        ? 'Deleted: it can’t be opened any more. The file store couldn’t be reached, so a nightly run finishes removing it.'
                        : 'Deleted.'
                  )
                }
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
  // Over the whole page, out of the table row it was opened from; drawn in
  // place where there is no page (a render on the server, or a test).
  return typeof document === 'undefined' ? view : createPortal(view, document.body);
}

/** A document, drawn. */
export function DocIcon() {
  return (
    <svg className="attach-doc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </svg>
  );
}
