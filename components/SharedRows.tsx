'use client';

// Shared expenses (#49) on a transaction of the Activity tab's list: the line
// under its name that says how it is shared, or what it paid back
// (components/shared-expenses-text.ts rowLine), and the actions in its
// detail: Share the cost (or Who owes what, once shared), and This paid
// back... on any posted row. An IOU's row is no transaction: tapping it
// opens the IOU. Each action opens one of the Shared sheets, which the
// dashboard mounts on every segment of the tab (SharedSheets, in
// components/SharedExpensesCard.tsx).

import { formatMoney } from '@/lib/format';
import { currencyOf } from '@/lib/spending';
import { Masked } from './HideAmounts';
import type { SheetAction } from './ActionRows';
import type { Txn } from './MonthBreakdown';
import { rowLine, type Names } from './shared-expenses-text';

export type SharedRowHooks = {
  names: Names;
  onShare: (t: Txn) => void;
  onPaidBack: (t: Txn) => void;
  onIou: (id: string) => void;
  /** Whether the person owes anyone anything: "This paid…" on money out is
   *  offered only then. */
  owes: boolean;
};

/** The line itself: a span inside a row's button, a paragraph in its sheet. */
export function SharedRowLine({ t, hooks, as: Line = 'span' }: { t: Txn; hooks: SharedRowHooks; as?: 'span' | 'p' }) {
  const c = currencyOf(t);
  const line = rowLine(t, hooks.names, (n) => formatMoney(n, c));
  if (!line) return null;
  return (
    <Line className="txn-row-note">
      <Masked>{line}</Masked>
    </Line>
  );
}

/** Whether a row can be shared from its detail: posted money out, in a
 *  currency, that isn't in a group or paying something back. */
export function canShare(t: Txn): boolean {
  return !t.pending && (t.shared_was ?? t.amount) > 0 && !!currencyOf(t) && !t.group_members && !t.group_outside && !t.group_id && !t.settles && !t.shared_iou && !t.shared_part;
}

/** Whether a row can be said to have paid something back: posted, in a
 *  currency, not shared, split or in a group. */
export function canPayBack(t: Txn, owes: boolean): boolean {
  if (t.pending || !currencyOf(t) || t.shared || t.split_parts || t.group_members || t.group_outside || t.group_id || t.shared_iou || t.shared_part) return false;
  const amount = t.shared_was ?? t.amount;
  return amount < 0 || (amount > 0 && owes) || !!t.settles;
}

/** The rows a transaction's detail gains for sharing (rows of the sheet's
 *  one list of actions, components/ActionRows.tsx): Share the cost, or Who
 *  owes what once shared, and what it paid back. Each opens a Shared sheet,
 *  then closes this one. */
export function sharedActions(t: Txn, hooks: SharedRowHooks, onDone: () => void): SheetAction[] {
  const shareable = canShare(t);
  const payable = canPayBack(t, hooks.owes);
  const isShared = !!t.shared || (t.split_parts ?? []).some((p) => p.shared);
  const amount = t.shared_was ?? t.amount;
  return [
    ...(shareable
      ? [
          {
            key: 'share',
            title: isShared ? 'Who owes what' : 'Share the cost',
            opens: true,
            onSelect: () => {
              hooks.onShare(t);
              onDone();
            },
          },
        ]
      : []),
    ...(payable
      ? [
          {
            key: 'paid-back',
            title: t.settles ? 'What it paid back' : amount < 0 ? 'This paid back…' : 'This paid…',
            opens: true,
            onSelect: () => {
              hooks.onPaidBack(t);
              onDone();
            },
          },
        ]
      : []),
  ];
}
