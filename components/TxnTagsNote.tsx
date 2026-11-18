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
// (said at the top of the sheet, `refusedBy`). A chip pressed goes with its
// press, so a refused chip's change brings focus to the tag field.

import { useMemo, useRef, useState } from 'react';
import { MAX_NOTE_CHARS } from '@/lib/manual-txn-input';
import { TAG_NAME_MAX, cleanTagName, tagNameKey, type Tag } from '@/lib/tags';
import TagChips from './TagChips';
import { shownName } from '@/lib/merchant-name';

/** A change to a row's tags: ids to put on or take off, or a name typed. */
export type TagChange = { add?: string[]; remove?: string[]; newTag?: string };

/** How many matching tags are offered under the field. */
const SUGGESTED = 6;

export default function TxnTagsNote({
  t,
  tags,
  onChangeTags,
  onSaveNote,
  refusedBy,
}: {
  t: { transaction_id: string; name: string; name_from_bank?: true; pending: boolean; tags?: string[]; note?: string | null };
  tags: readonly Tag[];
  /** Each a promise of whether it was saved. */
  onChangeTags: (change: TagChange) => Promise<boolean>;
  onSaveNote: (note: string) => Promise<boolean>;
  /** The id of what says why a change was refused, while it says so. */
  refusedBy?: string;
}) {
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState(t.note ?? '');
  // Which field's change was refused last, until the next change.
  const [refused, setRefused] = useState<'tag' | 'note' | null>(null);
  const tagField = useRef<HTMLInputElement>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  /** A tag change, and, refused, the name typed back and focus on the field. */
  const changeTags = (change: TagChange, typedName = '') => {
    setRefused(null);
    void onChangeTags(change).then((saved) => {
      if (saved) return;
      if (typedName) setDraft((d) => d || typedName);
      setRefused('tag');
      tagField.current?.focus();
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
            setRefused(null);
            void onSaveNote(note.trim()).then((saved) => {
              if (saved) return;
              setRefused('note');
              noteField.current?.focus();
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
