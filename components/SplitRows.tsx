'use client';

// Splits and groups on the Activity tab's list (#39): a split transaction is
// listed once, as the bank has it, with its parts nested under it, each with
// its category and amount; a group's row says what its transactions come to,
// with them nested under it. Grouping is how they are shown, keyed on
// split_of and group_id (lib/split-rows.ts): the totals above the list count
// the parts and the nets, as every total does. This file holds the nested
// rows, what a tap on one offers, and the actions a transaction's detail
// gains (Split, Group with others, Edit split, Edit group); the sheets are
// components/SplitSheet.tsx and components/GroupSheet.tsx.

import type { Txn } from './MonthBreakdown';
import CategoryPicker from './CategoryPicker';
import { signedMoney } from '@/lib/format';
import { currencyOf } from '@/lib/spending';
import { displayName, type Taxonomy } from '@/lib/categories';
import { PART_PREFIX, MIN_MEMBERS } from '@/lib/split-rows';
import { isConnectorKind } from '@/lib/connectors/types';

/** What a row of the list says in place of its category: a split
 *  transaction's parts, a group's size; null for any other. */
export function entryLabel(t: Pick<Txn, 'split_parts' | 'group_members' | 'group_missing' | 'group_removed'>): string | null {
  // The parts the person made: the difference the bank made since is not one.
  if (t.split_parts) return `Split into ${t.split_parts.filter((p) => !p.split_remainder).length}`;
  if (t.group_members) {
    const n = t.group_members.length;
    return `Group of ${n}`;
  }
  return null;
}

/** Whether the bank (through Plaid or SimpleFIN) keeps a row's amount: a
 *  row entered by hand or imported changes only when it is edited or
 *  imported again. */
export const bankKept = (t: Pick<Txn, 'source'>): boolean => !t.source || isConnectorKind(t.source);

/** A row's notice under its name about its split or group, if any. */
export function entryNotice(t: Txn): string | null {
  if (t.group_outside) {
    const day = new Date(`${t.group_outside.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `It is in the group “${t.group_outside.name}”, which counts on ${day}, before the transactions shown here begin, so it isn’t counted here.`;
  }
  if (t.group_unapplied) {
    return `It is in the group “${t.group_unapplied.name}”, whose transactions are in more than one currency now, so it counts on its own. Ungroup it to split this or group it again.`;
  }
  if (t.split_unread) return 'How you split this couldn’t be read, so it shows whole.';
  if (t.split_unapplied) return 'Its split no longer fits (its currency changed), so it shows whole: split it again.';
  if (t.split_parts?.some((p) => p.split_remainder)) return bankKept(t) ? 'The bank changed this amount since you split it.' : 'This amount changed since you split it.';
  const gone = (t.group_missing ?? 0) + (t.group_removed ?? 0);
  if (t.group_members && gone > 0) {
    return `${gone} of its transactions ${gone === 1 ? 'isn’t' : 'aren’t'} here (the bank removed ${gone === 1 ? 'it' : 'them'}, ${gone === 1 ? 'its' : 'their'} account is hidden, or ${gone === 1 ? 'it' : 'they'} couldn’t be loaded), so ${gone === 1 ? 'it isn’t' : 'they aren’t'} counted.`;
  }
  return null;
}

/** The actions a transaction's detail gains: Split and Group with others on
 *  one counted on its own, Edit split on a split one, Edit group on a
 *  group's row, and Ungroup on one of a group that no longer applies (the
 *  list has no row for it). Not on a pending one, which gets a new id when it
 *  posts. */
export function SplitActions({
  t,
  onSplit,
  onGroup,
  onUngroup,
}: {
  t: Txn;
  onSplit: (t: Txn) => void;
  onGroup: (t: Txn) => void;
  /** Ungroups the group by its id. */
  onUngroup: (id: string) => void;
}) {
  // In a group the list has no row for: one that no longer applies, or one
  // counted on a day before what is shown.
  const listless = t.group_unapplied ?? t.group_outside;
  if (listless) {
    return (
      <div className="rename-row">
        <button className="secondary" onClick={() => onUngroup(listless.id)}>
          Ungroup “{listless.name}”
        </button>
      </div>
    );
  }
  if (t.group_members) {
    return (
      <div className="rename-row">
        <button className="secondary" onClick={() => onGroup(t)}>
          Edit group
        </button>
      </div>
    );
  }
  if (t.split_unread) return null;
  if (t.pending) return <div className="rename-hint">Once it posts, it can be split or grouped with others.</div>;
  return (
    <div className="rename-row">
      <button className="secondary" onClick={() => onSplit(t)}>
        {t.split_parts ? 'Edit split' : 'Split'}
      </button>
      {!t.split_parts && (
        <button className="secondary" onClick={() => onGroup(t)}>
          Group with others
        </button>
      )}
    </div>
  );
}

/** Sends a change to a split or a group: null when it was made, else what
 *  went wrong, in the server's words when it gave some. */
export async function sendChange(url: string, method: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.error ?? 'Could not save that. Please try again.';
  } catch {
    return 'Could not reach the server.';
  }
}

/**
 * A split transaction's parts, nested under it: each with its category and
 * amount, its note marked, and one left out of budgets on its own said so.
 * A tap opens one: its category, whether it counts, and the whole split.
 */
export function PartRows({
  parent,
  last,
  taxonomy,
  open,
  onOpen,
  onChanged,
  onError,
  onEditSplit,
}: {
  parent: Txn;
  /** Whether the transaction is the day's last: its last part ends the day. */
  last: boolean;
  taxonomy: Taxonomy | null;
  /** The id of the row whose detail is open. */
  open: string | null;
  onOpen: (id: string | null) => void;
  onChanged: () => void;
  /** What went wrong with a change, or null once one is made. */
  onError: (message: string | null) => void;
  onEditSplit: (t: Txn) => void;
}) {
  const currency = currencyOf(parent);
  const patch = async (part: Txn, change: Record<string, unknown>) => {
    onError(await sendChange('/api/transaction-splits', 'PATCH', { transaction_id: parent.transaction_id, part_id: part.transaction_id.slice(PART_PREFIX.length), ...change }));
    onChanged();
  };
  return (
    <>
      {(parent.split_parts ?? []).map((p, i, all) => {
        const label = p.category_name !== undefined ? p.category_name : p.category;
        const opened = open === p.transaction_id;
        return (
          <tr
            key={p.transaction_id}
            className={`acct-row part-row${last && i === all.length - 1 ? ' last-in-day' : ''}`}
            onClick={() => onOpen(opened ? null : p.transaction_id)}
          >
            <td>
              <div className="part-text">
                <div>
                  {label ? displayName(label) : 'No category'}
                  {p.note && <span className="note-tag"> · {p.note}</span>}
                </div>
                {p.split_remainder && (
                  <div className="excluded-tag">
                    {bankKept(parent) ? 'What the bank changed the amount by' : 'What the amount changed by'} since you split it: edit the split to place it.
                  </div>
                )}
                {p.split_excluded && <div className="excluded-tag">Left out of budgets and reports on its own</div>}
              </div>
              {opened && (
                <div className="txn-edit" onClick={(e) => e.stopPropagation()}>
                  {taxonomy && !p.split_remainder && (
                    <CategoryPicker
                      taxonomy={taxonomy}
                      className="text-input recat-select"
                      value={p.category_id ?? taxonomy.uncategorized}
                      onChange={(id) => {
                        if (id && id !== p.category_id) void patch(p, { category_id: id });
                        onOpen(null);
                      }}
                      label={`Category for this part of ${parent.name}`}
                    />
                  )}
                  {!p.split_remainder && parent.excluded !== true && (
                    <div className="rename-row">
                      <button
                        className="secondary"
                        onClick={() => {
                          void patch(p, { excluded: !p.split_excluded });
                          onOpen(null);
                        }}
                      >
                        {p.split_excluded ? 'Count this part again' : 'Leave this part out of budgets and reports'}
                      </button>
                    </div>
                  )}
                  <div className="rename-row">
                    <button
                      className="secondary"
                      onClick={() => {
                        onEditSplit(parent);
                        onOpen(null);
                      }}
                    >
                      Edit split
                    </button>
                  </div>
                </div>
              )}
            </td>
            <td className={`num${p.amount < 0 ? ' inflow' : ''}${p.excluded === true ? ' excluded' : ''}`}>{signedMoney(-p.amount, currency, { always: true })}</td>
          </tr>
        );
      })}
    </>
  );
}

/**
 * A group's transactions, nested under its row: each as it is, its own
 * amount and day. A tap opens one, which can be taken out of the group.
 */
export function MemberRows({
  group,
  last,
  open,
  onOpen,
  onChanged,
  onError,
}: {
  group: Txn;
  /** Whether the group's row is the day's last: its last transaction ends the day. */
  last: boolean;
  open: string | null;
  onOpen: (id: string | null) => void;
  onChanged: () => void;
  /** What went wrong with a change, or null once one is made. */
  onError: (message: string | null) => void;
}) {
  const members = group.group_members ?? [];
  const currency = currencyOf(group);
  return (
    <>
      {members.map((m, i) => {
        const opened = open === `${group.transaction_id}>${m.transaction_id}`;
        return (
          <tr
            key={m.transaction_id}
            className={`acct-row part-row${last && i === members.length - 1 ? ' last-in-day' : ''}`}
            onClick={() => onOpen(opened ? null : `${group.transaction_id}>${m.transaction_id}`)}
          >
            <td>
              <div className="part-text">
                <div>{m.name}</div>
                <div className="type-tag">
                  {new Date(`${m.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {m.institution_name} · {m.account_name}
                </div>
                {/* What was said of it on its own doesn't change the group's net. */}
                {m.excluded === true && <div className="excluded-tag">{m.excluded_by_rule ? 'A rule hides it' : 'You excluded it'}: in the group, it counts through the group.</div>}
              </div>
              {opened && (
                <div className="txn-edit" onClick={(e) => e.stopPropagation()}>
                  {members.length > MIN_MEMBERS ? (
                    <div className="rename-row">
                      <button
                        className="secondary"
                        onClick={async () => {
                          onOpen(null);
                          onError(await sendChange('/api/transaction-groups', 'PATCH', { id: group.group_id, remove: [m.transaction_id] }));
                          onChanged();
                        }}
                      >
                        Take it out of the group
                      </button>
                    </div>
                  ) : (
                    <div className="rename-hint">A group holds at least {MIN_MEMBERS} transactions: to take this one out, ungroup it from the group’s row.</div>
                  )}
                  <div className="rename-hint">In a group, it counts through the group’s total, under the group’s category.</div>
                </div>
              )}
            </td>
            <td className={`num${m.amount < 0 ? ' inflow' : ''} excluded`}>{signedMoney(-m.amount, currency, { always: true })}</td>
          </tr>
        );
      })}
    </>
  );
}
