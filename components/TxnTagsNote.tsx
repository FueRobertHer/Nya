'use client';

// A transaction's tags and note, in its detail on the Activity tab (#40):
// the tags it carries, each with a button to take it off; a field to put one
// on, which offers the tags whose names hold what is typed and makes a new
// tag when none has that name ("create a tag as you type"); and its note. A
// manual or imported row's note is the row's own (the one its edit form
// shows); a bank row's is kept beside it (lib/txn-annotations.ts). Both show
// the same here.
//
// A pending row gets a new id when it posts, and what is said about it is
// kept by id, so tags and a note are offered once it has posted, as an
// exclusion is: they can't quietly lapse.

import { useMemo, useState } from 'react';
import { MAX_NOTE_CHARS } from '@/lib/manual-txn-input';
import { TAG_NAME_MAX, cleanTagName, tagNameKey, type Tag } from '@/lib/tags';
import TagChips from './TagChips';

/** A change to a row's tags: ids to put on or take off, or a name typed. */
export type TagChange = { add?: string[]; remove?: string[]; newTag?: string };

/** How many matching tags are offered under the field. */
const SUGGESTED = 6;

export default function TxnTagsNote({
  t,
  tags,
  onChangeTags,
  onSaveNote,
}: {
  t: { transaction_id: string; name: string; pending: boolean; tags?: string[]; note?: string | null };
  tags: readonly Tag[];
  onChangeTags: (change: TagChange) => void;
  onSaveNote: (note: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState(t.note ?? '');
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
      if (!on.has(there.id)) onChangeTags({ add: [there.id] });
    } else onChangeTags({ newTag: typed });
    setDraft('');
  };

  return (
    <div className="txn-tags-note">
      <div className="txn-tags-row">
        <TagChips ids={t.tags} tags={tags} onRemove={(id) => onChangeTags({ remove: [id] })} />
      </div>
      <div className="rename-row">
        <input
          className="text-input"
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
          aria-label={`Add a tag to ${t.name}`}
        />
        <button className="secondary" disabled={!typed} onClick={putOn}>
          Add
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="tag-suggestions" role="group" aria-label="Your tags">
          {suggestions.map((tag) => (
            <button key={tag.id} type="button" className="tag-suggestion" onClick={() => onChangeTags({ add: [tag.id] })}>
              {tag.name}
            </button>
          ))}
        </div>
      )}
      <textarea
        className="text-input txn-note-input"
        value={note}
        maxLength={MAX_NOTE_CHARS}
        rows={2}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note"
        aria-label={`Note on ${t.name}`}
      />
      <div className="rename-row">
        <button className="secondary" disabled={note.trim() === (t.note ?? '').trim()} onClick={() => onSaveNote(note.trim())}>
          {note.trim() || !t.note ? 'Save note' : 'Clear note'}
        </button>
      </div>
      <div className="rename-hint">Tags and notes are yours: sharing never shows them.</div>
    </div>
  );
}
