'use client';

// Your tags, under Manage on the Accounts tab (#40): how many there are, and
// a drawer to make one, rename it, give it another color or delete it. Each
// change is sent on its own (app/api/tags), and the drawer shows the tags as
// the server answers, so a change made on another device is never shown as
// undone. Deleting a tag takes it off every transaction it is on and out of
// every rule that adds it (lib/tag-delete.ts), which the drawer says first.
// Tags are put on a transaction from its detail on the Activity tab, or by a
// rule.

import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import TagChips from './TagChips';
import { TAG_COLORS, TAG_NAME_MAX, shownColor, type Tag } from '@/lib/tags';

type Level = { at: 'list' } | { at: 'tag'; id: string } | { at: 'add' };

/** Sends one change; the tags and counts as they are after it, or why not. */
async function change(body: Record<string, unknown>): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data };
    return { ok: false, error: typeof data?.error === 'string' ? data.error : 'That change couldn’t be made. Try again.' };
  } catch {
    return { ok: false, error: 'Nya could not be reached. Check your connection and try again.' };
  }
}

export default function TagsCard({
  tags,
  ruleUses = {},
  onChanged,
}: {
  tags: readonly Tag[];
  /** How many rules add each tag, by id, where known. */
  ruleUses?: Readonly<Record<string, number>>;
  /** A change made: the tags as the server answered them. */
  onChanged: (set: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<Level>({ at: 'list' });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>('gray');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The counts of what each tag is on, read as the drawer opens.
  useEffect(() => {
    if (!open) {
      setLevel({ at: 'list' });
      return;
    }
    let live = true;
    void fetch('/api/tags')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!live || !data) return;
        if (data.counts && typeof data.counts === 'object') setCounts(data.counts);
        onChanged(data.tags);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, onChanged]);

  const go = (next: Level) => {
    setLevel(next);
    setError(null);
    setConfirmDelete(false);
    if (next.at === 'tag') {
      const t = tags.find((x) => x.id === next.id);
      setName(t?.name ?? '');
      setColor(t ? shownColor(t.color) : 'gray');
    } else if (next.at === 'add') {
      setName('');
      setColor(TAG_COLORS[(tags.length % (TAG_COLORS.length - 1)) + 1]);
    }
  };

  async function send(body: Record<string, unknown>, then: Level | null = { at: 'list' }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await change(body);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (r.data?.counts) setCounts(r.data.counts);
    onChanged(r.data?.tags);
    if (then) go(then);
  }

  const colorChoice = (
    <div className="tag-colors" role="radiogroup" aria-label="Color">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={color === c}
          aria-label={c}
          className={`tag-color tag-${c}${color === c ? ' chosen' : ''}`}
          onClick={() => setColor(c)}
          disabled={busy}
        />
      ))}
    </div>
  );

  let body: React.ReactNode;
  if (level.at === 'list') {
    body = (
      <>
        <p className="panel-note" style={{ marginTop: 0 }}>
          Put tags on transactions from their detail on the Activity tab, or have a rule add them. Renaming a tag renames it everywhere at once.
        </p>
        <button className="secondary" onClick={() => go({ at: 'add' })}>
          Add a tag
        </button>
        <ul className="cat-manage-list" style={{ marginTop: 12 }}>
          {tags.map((t) => (
            <li key={t.id}>
              <button className="cat-manage-row" onClick={() => go({ at: 'tag', id: t.id })}>
                <TagChips ids={[t.id]} tags={tags} />
                <span className="cat-manage-kind">
                  {counts[t.id] ?? 0} by hand{ruleUses[t.id] ? `, ${ruleUses[t.id]} rule${ruleUses[t.id] === 1 ? '' : 's'}` : ''}
                </span>
              </button>
            </li>
          ))}
          {tags.length === 0 && <li className="panel-note">No tags yet.</li>}
        </ul>
      </>
    );
  } else if (level.at === 'add') {
    body = (
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={name} maxLength={TAG_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="e.g. Reimbursable" disabled={busy} />
        </label>
        {colorChoice}
        {error && <div className="error">{error}</div>}
        <button onClick={() => send({ action: 'add', name, color })} disabled={busy || !name.trim()} style={{ marginTop: 12 }}>
          {busy ? 'Adding…' : 'Add tag'}
        </button>
      </div>
    );
  } else {
    const t = tags.find((x) => x.id === level.id);
    const n = t ? (counts[t.id] ?? 0) : 0;
    const r = t ? (ruleUses[t.id] ?? 0) : 0;
    body = !t ? (
      <p className="empty-note">That tag no longer exists.</p>
    ) : (
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={name} maxLength={TAG_NAME_MAX} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </label>
        <button className="secondary" onClick={() => send({ action: 'rename', id: t.id, name }, null)} disabled={busy || !name.trim() || name.trim() === t.name}>
          Rename
        </button>
        <div style={{ marginTop: 16 }}>{colorChoice}</div>
        <button className="secondary" onClick={() => send({ action: 'recolor', id: t.id, color }, null)} disabled={busy || color === shownColor(t.color)}>
          Change color
        </button>
        <div className="panel-section">
          {confirmDelete ? (
            <>
              <p className="panel-note">
                {t.name} comes off every transaction it is on ({n} put on by hand){r > 0 ? ` and out of the ${r} rule${r === 1 ? '' : 's'} that add it` : ''}. This
                can&apos;t be undone.
              </p>
              <div className="button-pair">
                <button className="danger" onClick={() => send({ action: 'delete', id: t.id })} disabled={busy}>
                  {busy ? 'Deleting…' : 'Delete tag'}
                </button>
                <button className="secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  Keep it
                </button>
              </div>
            </>
          ) : (
            <button className="danger-outline" onClick={() => setConfirmDelete(true)} disabled={busy}>
              Delete tag…
            </button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Tags</div>
      </div>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {tags.length === 0
          ? 'Tags cut across categories: "reimbursable", "vacation 2026", "tax deductible". A transaction can carry several.'
          : `${tags.length} tag${tags.length === 1 ? '' : 's'}. A transaction can carry several; spending by tag is on the Activity tab.`}
      </p>
      <button className="secondary" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>
        {tags.length === 0 ? 'Add tags' : 'Edit tags'}
      </button>
      <Sheet
        open={open}
        title={level.at === 'tag' ? 'Tag' : level.at === 'add' ? 'Add a tag' : 'Tags'}
        onClose={() => setOpen(false)}
        onBack={level.at === 'list' ? undefined : () => go({ at: 'list' })}
      >
        {body}
      </Sheet>
    </div>
  );
}
