'use client';

// A transaction's tags and note, in its detail on the Activity tab (#40):
// the tags it carries, each with a button to take it off; a field to put one
// on, which offers the tags whose names hold what is typed and makes a new
// tag when none has that name ("create a tag as you type"); and its note. A
// row entered by hand or imported into a manual account has its note as its
// own (the one its edit form shows); a bank's, one SimpleFIN brought, and one
// imported into a linked account keep it beside them (lib/txn-annotations.ts).
// All show the same here.
//
// A pending row gets a new id when it posts, and what is said about it is
// kept by id, so tags and a note are offered once it has posted, as an
// exclusion is: they can't quietly lapse.
//
// Refused, a change leaves the field as it was before it was pressed: the
// name typed back in the tag field, the note still in its editor (shown on
// the row only once saved), with focus on that field, which points at why
// (said at the top of the sheet, `refusedBy`), unless focus has moved on to
// something else meanwhile. A chip pressed goes with its press, so a refused
// chip's change brings focus to the tag field.
//
// The editor keeps what is typed in it: a note saved, or read again, is
// taken into it only while it holds the note the row had, so what is typed
// while a save is out stays.
//
// Under the tag field and its suggestions, Rename or delete tags goes to
// the tags themselves (Settings > Transactions, the Tags sheet), where a
// tag is renamed or deleted everywhere at once.

import { useMemo, useRef, useState } from 'react';
import { MAX_NOTE_CHARS } from '@/lib/manual-txn-input';
import { TAG_NAME_MAX, cleanTagName, tagNameKey, type Tag } from '@/lib/tags';
import TagChips from './TagChips';
import { shownName } from '@/lib/merchant-name';

/** A change to a row's tags: ids to put on or take off, or a name typed. */
export type TagChange = { add?: string[]; remove?: string[]; newTag?: string };

/** How many matching tags are offered under the field. */
const SUGGESTED = 6;

/** Focus to `field` once its change is refused, if focus was lost (what was
 *  pressed went, or waits) or is still on what was pressed, and the sheet
 *  it is in hasn't started closing. */
function focusBack(field: HTMLElement | null, pressed: Element | null) {
  if (!field?.isConnected) return;
  const at = document.activeElement;
  const lost = !at || at === document.body || !at.isConnected || at.getAttribute('disabled') !== null;
  if (!lost && at !== pressed) return;
  for (let n: Element | null = field; n; n = n.parentElement) {
    if (n.getAttribute('role') === 'dialog' && n.getAttribute('data-open') === 'false') return;
  }
  field.focus();
}

export default function TxnTagsNote({
  t,
  tags,
  onChangeTags,
  onSaveNote,
  refusedBy,
  onManageTags,
}: {
  t: { transaction_id: string; name: string; name_from_bank?: true; pending: boolean; tags?: string[]; note?: string | null };
  tags: readonly Tag[];
  /** Each a promise of whether it was saved. */
  onChangeTags: (change: TagChange) => Promise<boolean>;
  onSaveNote: (note: string) => Promise<boolean>;
  /** The id of what says why a change was refused, while it says so. */
  refusedBy?: string;
  /** Opens the tags themselves, to rename or delete one. */
  onManageTags?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState(t.note ?? '');
  const [rowNote, setRowNote] = useState(t.note ?? '');
  if ((t.note ?? '') !== rowNote) {
    setRowNote(t.note ?? '');
    if (note === rowNote) setNote(t.note ?? '');
  }
  // Which field's change was refused last, until the next change, or until
  // the sheet says nothing went wrong (what it says next is about something
  // else).
  const [refused, setRefused] = useState<'tag' | 'note' | null>(null);
  const [saidBy, setSaidBy] = useState(refusedBy);
  if (refusedBy !== saidBy) {
    setSaidBy(refusedBy);
    if (!refusedBy) setRefused(null);
  }
  const tagField = useRef<HTMLInputElement>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const noteOut = useRef(false);
  /** A tag change, and, refused, the name typed back and focus on the field. */
  const changeTags = (change: TagChange, typedName = '') => {
    setRefused(null);
    const pressed = document.activeElement;
    void onChangeTags(change).then((saved) => {
      if (saved) return;
      if (typedName) setDraft((d) => d || typedName);
      setRefused('tag');
      focusBack(tagField.current, pressed);
    });
  };
  const on = useMemo(() => new Set(t.tags ?? []), [t.tags]);
  const typed = cleanTagName(draft);
  const suggestions = useMemo(() => {
    const q = typed.toLowerCase();
    return tags.filter((tag) => !on.has(tag.id) && (!q || tag.name.toLowerCase().includes(q))).slice(0, SUGGESTED);
  }, [tags, on, typed]);

  if (t.pending) {
    return <div className="rename-hint">Once it posts, it can be tagged and given a note.</div>;
  }

  /** Puts on the tag with the name typed, in any case, or a new one. */
  const putOn = () => {
    if (!typed) return;
    const there = tags.find((tag) => tagNameKey(tag.name) === tagNameKey(typed));
    if (there) {
      if (!on.has(there.id)) changeTags({ add: [there.id] }, draft);
    } else changeTags({ newTag: typed }, draft);
    setDraft('');
  };

  return (
    <div className="txn-tags-note">
      <div className="txn-tags-row">
        <TagChips ids={t.tags} tags={tags} onRemove={(id) => changeTags({ remove: [id] })} />
      </div>
      <div className="rename-row">
        <input
          ref={tagField}
          className="text-input"
          aria-describedby={refused === 'tag' ? refusedBy : undefined}
          value={draft}
          maxLength={TAG_NAME_MAX}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              putOn();
            }
          }}
          placeholder="Add a tag"
          aria-label={`Add a tag to ${shownName(t)}`}
        />
        <button className="secondary" disabled={!typed} onClick={putOn}>
          Add
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="chip-row tag-suggestions" role="group" aria-label="Your tags">
          {suggestions.map((tag) => (
            <button key={tag.id} type="button" className="chip" onClick={() => changeTags({ add: [tag.id] })}>
              {tag.name}
            </button>
          ))}
        </div>
      )}
      {onManageTags && tags.length > 0 && (
        // In a row of its own: the column would stretch the button to its width.
        <div>
          <button type="button" className="btn ghost" aria-haspopup="dialog" onClick={onManageTags}>
            Rename or delete tags
          </button>
        </div>
      )}
      <textarea
        ref={noteField}
        aria-describedby={refused === 'note' ? refusedBy : undefined}
        className="text-input txn-note-input"
        value={note}
        maxLength={MAX_NOTE_CHARS}
        rows={2}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note"
        aria-label={`Note on ${shownName(t)}`}
      />
      <div className="rename-row">
        <button
          className="secondary"
          disabled={note.trim() === (t.note ?? '').trim()}
          onClick={() => {
            // Pressed again while it saves: sent once.
            if (noteOut.current) return;
            noteOut.current = true;
            setRefused(null);
            const pressed = document.activeElement;
            void onSaveNote(note.trim()).then((saved) => {
              noteOut.current = false;
              if (saved) return;
              setRefused('note');
              focusBack(noteField.current, pressed);
            });
          }}
        >
          {note.trim() || !t.note ? 'Save note' : 'Clear note'}
        </button>
      </div>
      <div className="rename-hint">Tags and notes are yours: sharing never shows them.</div>
    </div>
  );
}
