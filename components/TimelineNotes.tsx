'use client';

// Notes on the net-worth timeline (#50, lib/timeline-notes.ts): what the
// chart marks on its days (components/NetWorthChart.tsx), and the sheet the
// Net worth card's "Chart notes" opens (rollout phase 4a), where the person
// adds, edits and deletes their own (a house bought, a 401(k) rolled over).
// The notes Nya writes when an account ends are listed too, and follow the
// account: changing or reopening it changes them. A note added, saved or
// deleted is said on the list, on a done notice that takes focus
// (docs/design/guidelines.md#after-save); one just added can be undone there,
// which removes it as if it had never been added.
//
// Read on its own request (app/api/timeline-notes), never part of the cached
// net-worth payload, so a note saved shows at once and a failure to read the
// notes costs the chart nothing but its markers, said on the card and here.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { Why } from './Why';
import { CAUTION, LevelWord } from './ConnectionStatus';
import { localDate } from '@/lib/local-date';
import { formatDay } from '@/lib/format';
import { Notice } from './TotalCaveats';

export type TimelineNote = { id: string; date: string; text: string; kind: 'auto' | 'user'; account_id?: string };

/** "Today", "Mar 12", "Mar 12, 2025": a calendar day, read at local midnight
 *  (lib/format.ts formatDay); `sentence` for the middle of one. */
const dayText = (iso: string, sentence = false) => formatDay(iso, { sentence });

/** The notes, read again whenever `refreshKey` changes (a reload). */
export function useTimelineNotes(refreshKey: unknown) {
  const [notes, setNotes] = useState<TimelineNote[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    fetch('/api/timeline-notes')
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!live) return;
        if (!res.ok || !Array.isArray(data?.notes)) {
          // What the chart showed before is no longer known to be right.
          setNotes([]);
          setProblem('Your notes couldn’t be read just now, so the chart shows none.');
          return;
        }
        setNotes(data.notes);
        const flawed = (data.unreadable_ids?.length ?? 0) + (data.unrecognised_ids?.length ?? 0);
        setProblem(flawed > 0 ? `${flawed === 1 ? 'One note' : `${flawed} notes`} couldn’t be read, so ${flawed === 1 ? 'it isn’t' : 'they aren’t'} shown.` : null);
      })
      .catch(() => {
        if (!live) return;
        setNotes([]);
        setProblem('Your notes couldn’t be read just now, so the chart shows none.');
      });
    return () => {
      live = false;
    };
  }, [refreshKey, tick]);
  return { notes, problem, reload };
}

type Draft = { id: string | null; date: string; text: string };

/** Where the sheet is: the list, a note's form, or the question before
 *  deleting one. The form and the question are a second level with a back
 *  button, not a sheet on a sheet. */
type Level = { at: 'list' } | { at: 'form'; draft: Draft } | { at: 'delete'; draft: Draft };

/** What the list says of the last change, and the note an Undo removes: only
 *  one just added, since removing it puts the notes back exactly as they
 *  were. An edit has no Undo (it is restamped, so saving the old words isn't
 *  the same note), nor a delete, which the question said can't be undone. */
type Said = { text: string; added?: { id: string; text: string } };

/** The notes sheet: every note, newest first; the person's own can be
 *  edited and deleted, Nya's say where they come from. */
export function TimelineNotesSheet({
  open,
  onClose,
  notes,
  problem,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  notes: TimelineNote[];
  problem: string | null;
  onChanged: () => void;
}) {
  const [level, setLevel] = useState<Level>({ at: 'list' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState<Said | null>(null);
  const today = localDate();
  const keep = useRef<HTMLButtonElement>(null);
  const doneLine = useRef<HTMLDivElement>(null);
  const errorId = useId();
  /** A level, with no error left from before, saying `line` if given. */
  const go = (next: Level, line: Said | null = null) => {
    setError('');
    setLevel(next);
    setSaid(line);
  };
  // Opened again: the list, not the form left behind, from its first frame.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) go({ at: 'list' });
  }
  // The question replaces the form's buttons: focus goes to the safe answer,
  // so a stray Enter keeps the note.
  useEffect(() => {
    if (level.at === 'delete') keep.current?.focus({ preventScroll: true });
  }, [level.at]);
  // What was done is said with focus on it: here, after the sheet's own
  // focus on its panel for the new level, which runs first.
  useEffect(() => {
    if (said) doneLine.current?.focus();
  }, [said]);

  /** The server's answer once it has the change, else null with the error set. */
  const send = async (method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>, failed = 'That note couldn’t be saved'): Promise<{ id?: unknown } | null> => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/timeline-notes', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `${failed}.`);
        return null;
      }
      onChanged();
      return data;
    } catch {
      setError(`${failed}: the server couldn’t be reached.`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = async (d: Draft) => {
    const text = d.text.trim();
    if (d.id) {
      if (await send('PATCH', { id: d.id, date: d.date, text: d.text })) go({ at: 'list' }, { text: `Saved "${text}", for ${dayText(d.date, true)}.` });
      return;
    }
    const added = await send('POST', { date: d.date, text: d.text });
    if (added) go({ at: 'list' }, { text: `Added "${text}", for ${dayText(d.date, true)}.`, added: typeof added.id === 'string' ? { id: added.id, text } : undefined });
  };
  const remove = async (d: Draft) => {
    const stored = notes.find((n) => n.id === d.id) ?? d;
    if (await send('DELETE', { id: d.id })) go({ at: 'list' }, { text: `Deleted "${stored.text}" from ${dayText(stored.date, true)}.` });
  };
  /** Takes back the note just added: removed, as if never added. */
  const undo = async (added: { id: string; text: string }) => {
    if (await send('DELETE', { id: added.id }, 'That note couldn’t be taken back')) go({ at: 'list' }, { text: `Undone: "${added.text}" is no longer on the chart.` });
  };

  const newest = [...notes].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const close = () => !busy && onClose();
  const back = () => !busy && go(level.at === 'delete' ? { at: 'form', draft: level.draft } : { at: 'list' });

  if (level.at === 'list') {
    return (
      <Sheet
        open={open}
        title="Chart notes"
        onClose={close}
        footer={
          <button className="btn btn-block" onClick={() => go({ at: 'form', draft: { id: null, date: today, text: '' } })} disabled={busy}>
            Add a note
          </button>
        }
      >
        <div className="stack">
          {said && (
            <Notice level="done" role="status" ref={doneLine} tabIndex={-1}>
              {said.text}
            </Notice>
          )}
          {said?.added && (
            // Its own row, so the button sizes itself rather than the stack's width.
            <div>
              <button type="button" className="btn ghost" onClick={() => void undo(said.added!)} disabled={busy}>
                {busy ? 'Undoing…' : 'Undo'}
              </button>
            </div>
          )}
          {error && (
            <Notice level="critical" role="alert">
              {error}
            </Notice>
          )}
          {problem && (
            <div className="notice caution">
              {CAUTION}
              <p>
                <LevelWord level="caution" />
                {problem}
              </p>
            </div>
          )}
          <Why label="What are these?">
            A note marks its day on the chart, so a step in the line says what it was: a house bought, a 401(k) rolled over. Nya
            adds one when an account closes or stops counting.
          </Why>
          {newest.length === 0 ? (
            <p className="empty-note">No notes yet.</p>
          ) : (
            <ul className="card list-rows">
              {newest.map((n) => (
                <li key={n.id} className="list-row">
                  <span className="list-row-text">
                    <span className="list-row-title">{n.text}</span>
                    <span className="list-row-sub">
                      {dayText(n.date)}
                      {n.kind === 'auto' && <> <span className="badge">Added when the account changed</span></>}
                    </span>
                  </span>
                  {n.kind === 'user' && (
                    <button className="btn ghost" disabled={busy} onClick={() => go({ at: 'form', draft: { id: n.id, date: n.date, text: n.text } })}>
                      Edit
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sheet>
    );
  }

  const d = level.draft;
  if (level.at === 'delete') {
    // The note as it is kept, not as the form was left: that is what goes.
    const stored = notes.find((n) => n.id === d.id) ?? d;
    return (
      <Sheet
        open={open}
        title="Delete note"
        onClose={close}
        onBack={back}
        footer={
          <>
            {error && (
              <div className="sheet-footer-note" id={errorId}>
                <Notice level="critical" role="alert">
                  {error}
                </Notice>
              </div>
            )}
            <button type="button" ref={keep} className="btn secondary" onClick={back} disabled={busy}>
              Keep it
            </button>
            <button type="button" className="btn danger" onClick={() => remove(d)} disabled={busy} aria-describedby={error ? errorId : undefined}>
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </>
        }
      >
        <p>{`Delete "${stored.text}" from ${dayText(stored.date, true)}? This can’t be undone.`}</p>
      </Sheet>
    );
  }

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date >= '1970-01-01' && d.date <= today && d.text.trim().length > 0 && d.text.trim().length <= 200;
  const edit = (next: Partial<Draft>) => setLevel({ at: 'form', draft: { ...d, ...next } });
  return (
    <Sheet
      open={open}
      title={d.id ? 'Edit note' : 'Add a note'}
      onClose={close}
      onBack={back}
      footer={
        <>
          {error && (
            <div className="sheet-footer-note" id={errorId}>
              <Notice level="critical" role="alert">
                {error}
              </Notice>
            </div>
          )}
          {d.id && (
            <button type="button" className="btn secondary" onClick={() => go({ at: 'delete', draft: d })} disabled={busy}>
              Delete…
            </button>
          )}
          <button type="button" className="btn" onClick={() => save(d)} disabled={busy || !valid} aria-describedby={error ? errorId : undefined}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="sheet-form">
        <label className="field">
          Day
          <input type="date" value={d.date} min="1970-01-01" max={today} onChange={(e) => edit({ date: e.target.value })} disabled={busy} />
        </label>
        <label className="field">
          Note
          <input value={d.text} onChange={(e) => edit({ text: e.target.value })} maxLength={200} placeholder="e.g. Bought the house" disabled={busy} />
        </label>
      </div>
    </Sheet>
  );
}
