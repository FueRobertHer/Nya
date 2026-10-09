'use client';

// What the "already connected" sheet says and offers (components/Dashboard.tsx)
// when a new connection is stopped at an institution already connected
// (lib/existing-items.ts): add the accounts to the connection there, one Item
// for one login, or connect again.
//
// A connection made the other way (as a bank or card, or as a brokerage or
// retirement account) may not offer the accounts someone came for: Plaid's
// Link shows only the account types compatible with the products a connection
// was made with, except where the bank's own sign-in window lists them. So
// then the sheet says so, and offers to connect again the way they started,
// choosing only the accounts not connected yet, rather than leaving "It's a
// different login" as the only way on.

import type { LinkKind } from '@/lib/item-products';

export type RedirectItem = { item_id: string; institution_name: string; accounts: unknown[]; linked_as?: LinkKind };

const WAY: Record<LinkKind, string> = {
  bank: 'a bank or card',
  investments: 'a brokerage or retirement account',
};
const ACCOUNTS: Record<LinkKind, string> = {
  bank: 'bank accounts and cards',
  investments: 'retirement and brokerage accounts',
};

/** Whether every connection found was made the other way from `kind`. One
 *  whose way isn't known (the lookup at link failed) counts as the same. */
export function madeTheOtherWay(items: readonly RedirectItem[], kind: LinkKind): boolean {
  return items.length > 0 && items.every((i) => i.linked_as !== undefined && i.linked_as !== kind);
}

export function RedirectChoices({
  name,
  items,
  kind,
  connecting,
  onAdd,
  onConnectAgain,
}: {
  name: string;
  items: readonly RedirectItem[];
  /** Which way the stopped connection was started. */
  kind: LinkKind;
  connecting: boolean;
  onAdd: (item_id: string) => void;
  onConnectAgain: () => void;
}) {
  const otherWay = madeTheOtherWay(items, kind);
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {otherWay ? (
          <>
            {name} is already connected as {WAY[items[0].linked_as!]}, and Plaid may not offer its {ACCOUNTS[kind]} on that
            connection. Try adding them to it first. If they aren&apos;t offered, connect {name} again as {WAY[kind]} and choose
            only the accounts that aren&apos;t connected yet, so none is counted twice.
          </>
        ) : (
          <>
            To add more {name} accounts, add them to the connection you already have. Connecting it again would create a
            duplicate connection with the same accounts. If it&apos;s a different login (a joint or business login, say),
            connect it separately.
          </>
        )}
      </p>
      <div className="button-stack" style={{ marginTop: 16 }}>
        {items.map((inst) => (
          <button key={inst.item_id} disabled={connecting} onClick={() => onAdd(inst.item_id)}>
            {items.length > 1
              ? `Add to ${inst.institution_name} (${inst.accounts.length} account${inst.accounts.length === 1 ? '' : 's'})`
              : 'Add accounts to existing connection'}
          </button>
        ))}
        <button className="secondary" disabled={connecting} onClick={onConnectAgain}>
          {otherWay ? `Connect it again as ${WAY[kind]}` : "It's a different login"}
        </button>
      </div>
    </>
  );
}
