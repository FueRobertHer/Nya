'use client';

// Grouping transactions that net out (#39): a $120 dinner and the $60 a
// friend paid back, a trip and its reimbursement. Opened from a
// transaction's detail on the Activity tab (Group with others), it starts
// with that transaction and offers the others to add: posted, in the same
// currency, not split and not in a group, nearest in date first, with a
// search. The group gets a name and a category, and counts once, at its net,
// in that category (lib/split-rows.ts). Opened on a group, it renames and
// refiles it, puts transactions in or takes them out, and ungroups it after
// asking (app/api/transaction-groups).

import { useEffect, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import CategoryPicker from './CategoryPicker';
import type { Txn } from './MonthBreakdown';
import { formatMoney, signedMoney } from '@/lib/format';
import { currencyOf } from '@/lib/spending';
import { categoryById, displayName, groupOf, indexTaxonomy, type CategoryIndex, type CategoryKind, type Taxonomy } from '@/lib/categories';
import { GROUP_NAME_MAX, MAX_MEMBERS, MIN_MEMBERS, toUnits, unitScale } from '@/lib/split-rows';

/** How many transactions the list offers at once; the search finds the rest. */
const OFFERED = 60;

/** "Oct 5": a transaction's day as the list shows it. */
function shownDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/**
 * The transactions a group can take, beside the ones in it now: posted, in
 * its currency, each as the bank has it (not a split's part, not a group's
 * row, not one whose split couldn't be read), nearest in date to `near`
 * first, those whose name, account or amount hold `query`. Pure.
 */
export function groupCandidates(rows: readonly Txn[], opts: { currency: string | null; near: string; exclude: ReadonlySet<string>; query: string }): Txn[] {
  const q = opts.query.trim().toLowerCase();
  const near = dayNumber(opts.near);
  return rows
    .filter(
      (t) =>
        !t.pending &&
        !t.split_of &&
        !t.group_members &&
        !t.split_unread &&
        !t.split_unapplied &&
        // In a group already, if one the list has no row for.
        !t.group_unapplied &&
        !t.group_outside &&
        !opts.exclude.has(t.transaction_id) &&
        currencyOf(t) === opts.currency &&
        (!q || t.name.toLowerCase().includes(q) || t.account_name.toLowerCase().includes(q) || String(Math.abs(t.amount)).includes(q))
    )
    .sort((a, b) => Math.abs(dayNumber(a.date) - near) - Math.abs(dayNumber(b.date) - near) || (a.date < b.date ? 1 : -1));
}

/**
 * The category a new group is filed under until the person picks one: that
 * of its largest outflow not filed as a transfer (the dinner, never the
 * payback a friend sent, which a bank files as a transfer in), else of its
 * first transaction not filed as a transfer, else, when every one is (two
 * sides of a move between accounts), the first one's. Pure.
 */
export function groupCategoryFor(rows: readonly Txn[], ix: CategoryIndex, uncategorized: string): string {
  const filed = (t: Txn) => (t.category_id ? categoryById(ix, t.category_id) : null);
  const isTransfer = (t: Txn) => {
    const c = filed(t);
    return (c ? groupOf(ix, c).kind : t.category_kind) === 'transfer';
  };
  const spending = rows.filter((t) => !isTransfer(t));
  const largest = spending.filter((t) => t.amount > 0).sort((a, b) => b.amount - a.amount)[0];
  const pick = largest ?? spending[0] ?? rows[0];
  return (pick && filed(pick)?.id) || uncategorized;
}

/** What the group sheet says the ticked transactions come to, and where. */
export function groupStatus(opts: { count: number; net: number; currency: string | null; category: { name: string; kind: CategoryKind } | null }): string {
  if (opts.count < MIN_MEMBERS) return `Choose at least ${MIN_MEMBERS} transactions.`;
  if (opts.count > MAX_MEMBERS) return `A group holds at most ${MAX_MEMBERS} transactions.`;
  const under = opts.category ? displayName(opts.category.name) : null;
  // A transfer category's net counts in no total: say so, never "counted".
  if (opts.category?.kind === 'transfer') return `${opts.count} transactions. ${under} is a transfer category, so this group isn’t counted in spending.`;
  if (opts.net === 0) return `${opts.count} transactions, netting to nothing${under ? `, under ${under}` : ''}.`;
  return `${opts.count} transactions, counted as ${formatMoney(Math.abs(opts.net), opts.currency)} ${opts.net > 0 ? 'out' : 'in'}${under ? ` under ${under}` : ''}.`;
}

export default function GroupSheet({
  start,
  group,
  txns,
  taxonomy,
  onClose,
  onSaved,
}: {
  /** A transaction to start a group from, or null. */
  start: Txn | null;
  /** A group's row to change (its transactions inside it), or null. */
  group: Txn | null;
  /** The year's rows, as the list has them: what can join. */
  txns: readonly Txn[];
  taxonomy: Taxonomy;
  onClose: () => void;
  /** After a save or an ungroup: the list is read again. */
  onSaved: () => void;
}) {
  const open = !!(start || group);
  const first = group ?? start;
  const members0 = useMemo(() => (group ? (group.group_members ?? []) : start ? [start] : []), [group, start]);
  // From what it opens on (and afresh each time it opens on something).
  const [name, setName] = useState(() => (group ? group.name : (start?.name ?? '')));
  // The person's pick of a category: a group's own, or, for a new one, none
  // until they pick (the ticked transactions suggest one, groupCategoryFor).
  const [picked, setPicked] = useState<string | null>(() => (group ? (group.category_id ?? taxonomy.uncategorized) : null));
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(members0.map((m) => m.transaction_id)));
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const ix = useMemo(() => indexTaxonomy(taxonomy), [taxonomy]);

  useEffect(() => {
    if (!first) return;
    setName(group ? group.name : (start?.name ?? ''));
    setPicked(group ? (group.category_id ?? taxonomy.uncategorized) : null);
    setChosen(new Set(members0.map((m) => m.transaction_id)));
    setQuery('');
    setError('');
    setConfirming(false);
  }, [first, group, start, members0, taxonomy.uncategorized]);

  const currency = first ? currencyOf(group?.group_members?.[0] ?? first) : null;
  // Every row a group can be made of, by id: its transactions, and the year's.
  const pool = useMemo(() => new Map([...txns, ...members0].map((t) => [t.transaction_id, t] as const)), [txns, members0]);
  const offered = useMemo(
    () => (first ? groupCandidates(txns, { currency, near: first.date, exclude: new Set(members0.map((m) => m.transaction_id)), query }).slice(0, OFFERED) : []),
    [txns, first, currency, members0, query]
  );

  if (!first) return <Sheet open={false} title="Group" onClose={onClose}>{null}</Sheet>;

  // One ticked to add stays listed when the search no longer finds it: first.
  const inGroup = new Set(members0.map((m) => m.transaction_id));
  const shown = new Set(offered.map((t) => t.transaction_id));
  const hidden = [...chosen].filter((id) => !inGroup.has(id) && !shown.has(id)).flatMap((id) => pool.get(id) ?? []);
  const toAdd = [...hidden, ...offered];
  // What the ticked ones come to, and where.
  const ticked = [...chosen].flatMap((id) => pool.get(id) ?? []);
  const scale = unitScale(currency);
  const net = ticked.reduce((n, t) => n + toUnits(t.amount, scale), 0) / scale;
  const categoryId = picked ?? groupCategoryFor(ticked, ix, taxonomy.uncategorized);
  const missing = (group?.group_missing ?? 0) + (group?.group_removed ?? 0);
  const category = categoryById(ix, categoryId);
  // A group's edit saves only a change.
  const changed =
    !group ||
    name.trim() !== group.name ||
    categoryId !== group.category_id ||
    [...chosen].some((id) => !inGroup.has(id)) ||
    [...inGroup].some((id) => !chosen.has(id));
  const ready = name.trim().length > 0 && chosen.size >= MIN_MEMBERS && chosen.size <= MAX_MEMBERS && !!categoryId && changed;
  const toggle = (id: string) =>
    setChosen((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function send(method: 'POST' | 'PATCH' | 'DELETE', body: unknown) {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/transaction-groups', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        onSaved();
        onClose();
        return;
      }
      const data = await res.json().catch(() => null);
      setError(data?.error ?? 'Could not save that. Please try again.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  function save() {
    if (!group) {
      void send('POST', { name: name.trim(), category_id: categoryId, members: [...chosen] });
      return;
    }
    const before = new Set(members0.map((m) => m.transaction_id));
    void send('PATCH', {
      id: group.group_id,
      ...(name.trim() !== group.name ? { name: name.trim() } : {}),
      ...(categoryId !== group.category_id ? { category_id: categoryId } : {}),
      add: [...chosen].filter((id) => !before.has(id)),
      remove: [...before].filter((id) => !chosen.has(id)),
    });
  }

  const row = (t: Txn) => (
    <label className="group-member" key={t.transaction_id}>
      <input type="checkbox" checked={chosen.has(t.transaction_id)} onChange={() => toggle(t.transaction_id)} disabled={saving} />
      <span className="group-member-text">
        <span>{t.name}</span>
        <span className="type-tag">
          {shownDay(t.date)} · {t.account_name}
        </span>
        {/* Left out on its own, it counts through the group once in it. */}
        {chosen.has(t.transaction_id) && t.excluded === true && (
          <span className="excluded-tag">{t.excluded_by_rule ? 'A rule hides it' : 'You excluded it'}: in the group, it counts through the group.</span>
        )}
      </span>
      <span className={`num${t.amount < 0 ? ' inflow' : ''}`}>{signedMoney(-t.amount, currency, { always: true })}</span>
    </label>
  );

  return (
    <Sheet open={open} title={group ? 'Edit group' : 'Group transactions'} onClose={() => !saving && onClose()}>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Transactions that belong together, such as a dinner and what a friend paid you back, count once, at what they come to, in the group&apos;s
        category. Each stays listed under the group.
      </p>
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={name} maxLength={GROUP_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dinner with Sam" disabled={saving} />
        </label>
        <label className="field">
          Category
          <CategoryPicker taxonomy={taxonomy} value={categoryId} onChange={setPicked} disabled={saving} />
        </label>
        <div className="group-list" role="group" aria-label="Transactions in the group">
          {members0.map(row)}
        </div>
        {missing > 0 && (
          <p className="panel-note">
            {missing} more {missing === 1 ? 'transaction was' : 'transactions were'} in it and {missing === 1 ? 'isn’t' : 'aren’t'} here: the bank removed{' '}
            {missing === 1 ? 'it' : 'them'}, {missing === 1 ? 'its' : 'their'} account is hidden, or {missing === 1 ? 'it' : 'they'} couldn’t be loaded.
          </p>
        )}
        <input
          className="text-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a transaction to add"
          aria-label="Find a transaction to add"
          disabled={saving}
        />
        <div className="group-list" role="group" aria-label="Transactions to add">
          {toAdd.length === 0 ? <p className="empty-note">{query ? 'No transaction matches.' : 'No other transactions in this currency.'}</p> : toAdd.map(row)}
        </div>
      </div>
      <p className="split-left" role="status">
        {groupStatus({ count: chosen.size, net, currency, category: category ? { name: category.name, kind: groupOf(ix, category).kind } : null })}
      </p>
      {error && <div className="error">{error}</div>}
      <div className="button-pair">
        <button onClick={save} disabled={!ready || saving}>
          {saving ? 'Saving…' : group ? 'Save group' : 'Group them'}
        </button>
        <button className="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
      {group && !confirming && (
        <button className="secondary" style={{ marginTop: 12 }} onClick={() => setConfirming(true)} disabled={saving}>
          Ungroup
        </button>
      )}
      {group && confirming && (
        <>
          <p className="panel-note">Ungroup {group.name}? Its transactions count on their own again, each under its own category.</p>
          <div className="button-pair">
            <button className="danger" onClick={() => send('DELETE', { id: group.group_id })} disabled={saving}>
              Ungroup
            </button>
            <button className="secondary" onClick={() => setConfirming(false)} disabled={saving}>
              Keep the group
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
