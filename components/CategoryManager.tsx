'use client';

// The Categories screen (under Manage on the Accounts tab): your categories in
// their groups (lib/categories.ts), and every change to them, one drawer with
// a level per thing being changed, built for a phone. Each change is sent on
// its own (app/api/categories) and the drawer shows the set as the server
// answers it, so a change made on another device is never shown as undone;
// one refused says why, with what to do instead (a category in use can't be
// deleted: merge or archive it).
//
//   - a category: rename it, give it an icon, move it to another group (one of
//     another kind changes how its transactions count, which is said first),
//     archive it (hidden from the lists to choose from, still on every
//     transaction in it), merge it into another of the same kind (its
//     transactions and budget go with it, added to that one's), or delete it
//     if nothing uses it;
//   - a group: rename it, move it up or down, or delete it once empty;
//   - add a category, in a group, or a group, of a kind.

import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import CategoryPicker from './CategoryPicker';
import {
  categoriesIn,
  displayName,
  groupOf,
  indexTaxonomy,
  sortedGroups,
  ICON_MAX,
  KIND_WORDS,
  NAME_MAX,
  type Category,
  type CategoryGroup,
  type CategoryKind,
  type Taxonomy,
} from '@/lib/categories';

type Level =
  | { at: 'list' }
  | { at: 'category'; id: string }
  | { at: 'group'; id: string }
  | { at: 'add-category'; group: string | null }
  | { at: 'add-group' };

/** How a group's kind is said on the screen. */
const KIND_LABEL: Record<CategoryKind, string> = { expense: 'Spending', income: 'Income', transfer: 'Transfers' };

/** Sends one change; the set as it is after it, or why it wasn't made. */
async function change(body: Record<string, unknown>): Promise<{ ok: true; taxonomy: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (res.ok) return { ok: true, taxonomy: data?.categories };
    return { ok: false, error: typeof data?.error === 'string' ? data.error : 'That change couldn’t be made. Try again.' };
  } catch {
    return { ok: false, error: 'Nya could not be reached. Check your connection and try again.' };
  }
}

export default function CategoryManager({
  open,
  onClose,
  taxonomy,
  onTaxonomy,
}: {
  open: boolean;
  onClose: () => void;
  taxonomy: Taxonomy;
  /** A change made: the set as the server answered it. */
  onTaxonomy: (t: unknown) => void;
}) {
  const [level, setLevel] = useState<Level>({ at: 'list' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each level's form, filled in as it opens.
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [group, setGroup] = useState('');
  const [kind, setKind] = useState<CategoryKind>('expense');
  const [into, setInto] = useState('');
  const [confirm, setConfirm] = useState<'merge' | 'delete' | 'archive' | null>(null);
  const [refusedDelete, setRefusedDelete] = useState(false);

  useEffect(() => {
    if (!open) setLevel({ at: 'list' });
  }, [open]);

  const ix = indexTaxonomy(taxonomy);
  const go = (next: Level) => {
    setLevel(next);
    setError(null);
    setConfirm(null);
    setRefusedDelete(false);
    setInto('');
    if (next.at === 'category') {
      const c = ix.byId.get(next.id);
      setName(c?.name ?? '');
      setIcon(c?.icon ?? '');
      setGroup(c?.group ?? '');
    } else if (next.at === 'group') {
      setName(ix.groupById.get(next.id)?.name ?? '');
    } else if (next.at === 'add-category') {
      setName('');
      setIcon('');
      setGroup(next.group ?? ix.byId.get(taxonomy.uncategorized)?.group ?? '');
    } else if (next.at === 'add-group') {
      setName('');
      setKind('expense');
    }
  };
  const back = () => go({ at: 'list' });

  /** Sends a change; on success takes the answer and goes where `then` says. */
  async function send(body: Record<string, unknown>, then: Level | null = { at: 'list' }): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const r = await change(body);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    onTaxonomy(r.taxonomy);
    if (then) go(then);
    return true;
  }

  const groups = sortedGroups(taxonomy);
  const title =
    level.at === 'category'
      ? 'Category'
      : level.at === 'group'
        ? 'Group'
        : level.at === 'add-category'
          ? 'Add a category'
          : level.at === 'add-group'
            ? 'Add a group'
            : 'Categories';

  let body: React.ReactNode;
  if (level.at === 'list') {
    body = (
      <>
        <p className="panel-note" style={{ marginTop: 0 }}>
          Transactions are filed into these. Renaming one renames it everywhere at once, budgets included; a group&apos;s kind decides how its
          categories count: spending, income, or transfers, which the month&apos;s totals and budgets leave out.
        </p>
        <div className="button-pair">
          <button className="secondary" onClick={() => go({ at: 'add-category', group: null })}>
            Add a category
          </button>
          <button className="secondary" onClick={() => go({ at: 'add-group' })}>
            Add a group
          </button>
        </div>
        {groups.map((g) => (
          <div className="panel-section" key={g.id}>
            <button className="cat-manage-group" onClick={() => go({ at: 'group', id: g.id })} aria-label={`${g.name}, ${KIND_LABEL[g.kind]}: edit the group`}>
              <span className="cat-manage-group-name">{g.name}</span>
              <span className="cat-manage-kind">{KIND_LABEL[g.kind]}</span>
            </button>
            <ul className="cat-manage-list">
              {categoriesIn(taxonomy, g.id).map((c) => (
                <li key={c.id}>
                  <button className={`cat-manage-row${c.archived ? ' archived' : ''}`} onClick={() => go({ at: 'category', id: c.id })}>
                    <span>
                      {c.icon ? `${c.icon} ` : ''}
                      {displayName(c.name)}
                    </span>
                    {c.archived && <span className="cat-manage-tag">Archived</span>}
                    {c.id === taxonomy.uncategorized && <span className="cat-manage-tag">Uncategorized</span>}
                  </button>
                </li>
              ))}
              {categoriesIn(taxonomy, g.id).length === 0 && <li className="panel-note">No categories in it.</li>}
            </ul>
          </div>
        ))}
      </>
    );
  } else if (level.at === 'category') {
    const c = ix.byId.get(level.id);
    body = c ? categoryLevel(c) : <p className="empty-note">That category no longer exists.</p>;
  } else if (level.at === 'group') {
    const g = ix.groupById.get(level.id);
    body = g ? groupLevel(g) : <p className="empty-note">That group no longer exists.</p>;
  } else if (level.at === 'add-category') {
    body = (
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="e.g. Coffee" disabled={busy} />
        </label>
        <label className="field">
          Group
          <select value={group} onChange={(e) => setGroup(e.target.value)} disabled={busy}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({KIND_LABEL[g.kind].toLowerCase()})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Icon (optional)
          <input value={icon} maxLength={ICON_MAX} onChange={(e) => setIcon(e.target.value)} placeholder="An emoji" disabled={busy} />
        </label>
        {error && <div className="error">{error}</div>}
        <button onClick={() => send({ action: 'add-category', name, group, icon })} disabled={busy || !name.trim()}>
          {busy ? 'Adding…' : 'Add category'}
        </button>
      </div>
    );
  } else {
    body = (
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kids" disabled={busy} />
        </label>
        <label className="field">
          Its categories count as
          <select value={kind} onChange={(e) => setKind(e.target.value as CategoryKind)} disabled={busy}>
            <option value="expense">Spending</option>
            <option value="income">Income</option>
            <option value="transfer">Transfers (left out of totals)</option>
          </select>
        </label>
        <p className="panel-note">A group keeps its kind; to count a category another way, move it into a group of that kind.</p>
        {error && <div className="error">{error}</div>}
        <button onClick={() => send({ action: 'add-group', name, kind })} disabled={busy || !name.trim()} style={{ marginTop: 12 }}>
          {busy ? 'Adding…' : 'Add group'}
        </button>
      </div>
    );
  }

  function categoryLevel(c: Category) {
    const kindNow = groupOf(ix, c).kind;
    const target = ix.groupById.get(group);
    const uncategorized = c.id === taxonomy.uncategorized;
    // Merging is only into another category of the same kind, not archived.
    const sameKind: Taxonomy = {
      ...taxonomy,
      categories: taxonomy.categories.filter((x) => x.id !== c.id && !x.archived && groupOf(ix, x).kind === kindNow),
    };
    const intoCategory = ix.byId.get(into);
    const intoName = intoCategory?.name;
    const intoGroup = intoCategory ? groupOf(ix, intoCategory) : null;
    return (
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </label>
        <button className="secondary" onClick={() => send({ action: 'rename-category', id: c.id, name }, null)} disabled={busy || !name.trim() || name.trim() === c.name}>
          Rename
        </button>

        <label className="field" style={{ marginTop: 16 }}>
          Icon
          <input value={icon} maxLength={ICON_MAX} onChange={(e) => setIcon(e.target.value)} placeholder="An emoji, or none" disabled={busy} />
        </label>
        <button className="secondary" onClick={() => send({ action: 'set-icon', id: c.id, icon }, null)} disabled={busy || icon.trim() === (c.icon ?? '')}>
          {icon.trim() ? 'Set icon' : 'Clear icon'}
        </button>

        <label className="field" style={{ marginTop: 16 }}>
          Group
          <select value={group} onChange={(e) => setGroup(e.target.value)} disabled={busy}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({KIND_LABEL[g.kind].toLowerCase()})
              </option>
            ))}
          </select>
        </label>
        {target && target.kind !== kindNow && (
          <p className="panel-note">
            Its transactions will count as {KIND_WORDS[target.kind]} instead of {KIND_WORDS[kindNow]}, in every total and budget.
          </p>
        )}
        <button className="secondary" onClick={() => send({ action: 'move-category', id: c.id, group }, null)} disabled={busy || group === c.group}>
          Move
        </button>

        {!uncategorized && (
          <div className="panel-section">
            <div className="section-label">Merge into another</div>
            <CategoryPicker taxonomy={sameKind} value={into} none="Choose a category…" onChange={setInto} disabled={busy} label={`Merge ${c.name} into`} />
            {confirm === 'merge' && intoName ? (
              <>
                <p className="panel-note">
                  Every transaction filed under {displayName(c.name)} will be filed under {displayName(intoName)}, its budget is added to{' '}
                  {displayName(intoName)}&apos;s, and {displayName(c.name)} goes.
                  {intoGroup && intoGroup.id !== c.group
                    ? ` Its spending moves from ${groupOf(ix, c).name} to ${intoGroup.name}, which can change both groups’ limits.`
                    : ''}{' '}
                  This can&apos;t be undone.
                </p>
                <div className="button-pair">
                  <button className="secondary" onClick={() => setConfirm(null)} disabled={busy}>
                    Keep both
                  </button>
                  <button className="danger" onClick={() => send({ action: 'merge', id: c.id, into })} disabled={busy}>
                    {busy ? 'Merging…' : 'Merge'}
                  </button>
                </div>
              </>
            ) : (
              <button className="secondary" style={{ marginTop: 8 }} onClick={() => setConfirm('merge')} disabled={busy || !into}>
                Merge…
              </button>
            )}
          </div>
        )}

        {!uncategorized && (
          <div className="panel-section">
            <div className="section-label">Hide or remove</div>
            <div className="button-stack">
              <button className="secondary" onClick={() => send({ action: 'archive', id: c.id, archived: !c.archived }, null)} disabled={busy}>
                {c.archived ? 'Unarchive' : 'Archive'}
              </button>
              {confirm === 'delete' ? (
                <div className="button-pair" style={{ marginTop: 0 }}>
                  <button className="secondary" onClick={() => setConfirm(null)} disabled={busy}>
                    Keep it
                  </button>
                  <button
                    className="danger"
                    onClick={async () => {
                      if (!(await send({ action: 'delete-category', id: c.id }))) setRefusedDelete(true);
                    }}
                    disabled={busy}
                  >
                    {busy ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              ) : (
                <button className="danger-outline" onClick={() => setConfirm('delete')} disabled={busy}>
                  Delete
                </button>
              )}
            </div>
            <p className="panel-note">
              {refusedDelete
                ? 'Merge it into another category above to keep its transactions together, or archive it to hide it from the lists.'
                : 'Archived, it is hidden from the lists to choose from and still shown on every transaction in it. Only a category nothing uses can be deleted.'}
            </p>
          </div>
        )}
        {uncategorized && (
          <p className="panel-note">
            Transactions that say nothing about their category are filed here. It can be renamed and moved to another spending group, but not archived,
            merged away or deleted.
          </p>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  function groupLevel(g: CategoryGroup) {
    const at = groups.findIndex((x) => x.id === g.id);
    const swap = (to: number) => {
      const ids = groups.map((x) => x.id);
      [ids[at], ids[to]] = [ids[to], ids[at]];
      return send({ action: 'order-groups', ids }, null);
    };
    const inside = categoriesIn(taxonomy, g.id).length;
    return (
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </label>
        <button className="secondary" onClick={() => send({ action: 'rename-group', id: g.id, name }, null)} disabled={busy || !name.trim() || name.trim() === g.name}>
          Rename
        </button>
        <p className="panel-note">Its categories count as {KIND_WORDS[g.kind]}.</p>
        <div className="button-pair">
          <button className="secondary" onClick={() => swap(at - 1)} disabled={busy || at <= 0}>
            Move up
          </button>
          <button className="secondary" onClick={() => swap(at + 1)} disabled={busy || at >= groups.length - 1}>
            Move down
          </button>
        </div>
        <button className="secondary" style={{ marginTop: 12 }} onClick={() => go({ at: 'add-category', group: g.id })} disabled={busy}>
          Add a category to it
        </button>
        <div className="panel-section">
          {confirm === 'delete' ? (
            <div className="button-pair" style={{ marginTop: 0 }}>
              <button className="secondary" onClick={() => setConfirm(null)} disabled={busy}>
                Keep it
              </button>
              <button className="danger" onClick={() => send({ action: 'delete-group', id: g.id })} disabled={busy}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          ) : (
            <button className="danger-outline" onClick={() => setConfirm('delete')} disabled={busy || inside > 0}>
              Delete group
            </button>
          )}
          {inside > 0 && <p className="panel-note">Move or merge its {inside === 1 ? 'category' : `${inside} categories`} into other groups to delete it.</p>}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <Sheet open={open} title={title} onClose={() => !busy && onClose()} onBack={level.at === 'list' ? undefined : back}>
      {body}
    </Sheet>
  );
}
