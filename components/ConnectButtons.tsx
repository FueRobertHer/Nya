'use client';

// The two ways to connect an institution (app/api/create-link-token), each
// with a line on what it is for, on the Accounts tab and on the empty state
// before anything is connected. Two because no one Plaid link token can list
// both plain banks and retirement plans without Transactions: Link shows only
// the institutions that support every product a token asks for
// (lib/item-products.ts).

import { useEffect, useState } from 'react';
import type { LinkKind } from '@/lib/item-products';

/** What each way is called, and what it is for. */
export const CONNECT_OPTIONS: readonly { kind: LinkKind; label: string; note: string }[] = [
  {
    kind: 'bank',
    label: 'Connect a bank or card',
    note: 'Checking, savings, credit cards and loans, with their transactions.',
  },
  {
    kind: 'investments',
    label: 'Connect a brokerage or retirement account',
    note: '401(k)s, IRAs and brokerage accounts, including ones the bank option can’t find.',
  },
];

export default function ConnectButtons({
  connecting,
  onConnect,
}: {
  /** Whether a Link flow is starting (any of them): both buttons wait. */
  connecting: boolean;
  onConnect: (kind: LinkKind) => void;
}) {
  // Which button started the flow in progress, so only it says so. A flow
  // started elsewhere (Reconnect, say) disables both without naming either.
  const [starting, setStarting] = useState<LinkKind | null>(null);
  useEffect(() => {
    if (!connecting) setStarting(null);
  }, [connecting]);
  return (
    <ConnectButtonsView
      connecting={connecting}
      starting={starting}
      onConnect={(kind) => {
        setStarting(kind);
        onConnect(kind);
      }}
    />
  );
}

/** The buttons themselves, with no state of their own. */
export function ConnectButtonsView({
  connecting,
  starting,
  onConnect,
}: {
  connecting: boolean;
  starting: LinkKind | null;
  onConnect: (kind: LinkKind) => void;
}) {
  return (
    <div className="button-stack connect-options">
      {CONNECT_OPTIONS.map((option, i) => (
        <div key={option.kind}>
          {/* The bank option first and filled: it is the one most people need. */}
          <button className={i === 0 ? undefined : 'secondary'} onClick={() => onConnect(option.kind)} disabled={connecting}>
            {connecting && starting === option.kind ? 'Starting…' : option.label}
          </button>
          <p className="panel-note">{option.note}</p>
        </div>
      ))}
    </div>
  );
}
