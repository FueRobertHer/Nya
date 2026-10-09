'use client';

// The ways to connect an institution (app/api/create-link-token), each with a
// line on what it is for, on the Accounts tab and on the empty state before
// anything is connected. Two because no one Plaid link token can list both
// plain banks and retirement plans without Transactions: Link shows only the
// institutions that support every product a token asks for
// (lib/item-products.ts). The second shows only where the deployment has
// turned it on (PLAID_BROKERAGE_LINK=1, decided on the server in app/page.tsx).

import { useEffect, useId, useState } from 'react';
import type { LinkKind } from '@/lib/item-products';

/** What each way is called, and what it is for. */
export const CONNECT_OPTIONS: readonly { kind: LinkKind; label: string; note: string }[] = [
  {
    kind: 'bank',
    label: 'Connect a bank or card',
    note: 'Checking, savings and credit cards with their transactions, plus loans.',
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
  brokerage,
}: {
  /** Whether a Link flow is starting (any of them): every button waits. */
  connecting: boolean;
  onConnect: (kind: LinkKind) => void;
  /** Whether the brokerage and retirement option is offered here. */
  brokerage: boolean;
}) {
  // Which button started the flow in progress, so only it says so. A flow
  // started elsewhere (Reconnect, say) disables them without naming one.
  const [starting, setStarting] = useState<LinkKind | null>(null);
  const idBase = useId();
  useEffect(() => {
    if (!connecting) setStarting(null);
  }, [connecting]);
  return (
    <ConnectButtonsView
      connecting={connecting}
      starting={starting}
      brokerage={brokerage}
      idBase={idBase}
      onConnect={(kind) => {
        setStarting(kind);
        onConnect(kind);
      }}
    />
  );
}

/** The buttons themselves, with no state of their own. `idBase` makes each
 *  line's id, which its button names as its description. */
export function ConnectButtonsView({
  connecting,
  starting,
  brokerage,
  idBase,
  onConnect,
}: {
  connecting: boolean;
  starting: LinkKind | null;
  brokerage: boolean;
  idBase: string;
  onConnect: (kind: LinkKind) => void;
}) {
  const options = CONNECT_OPTIONS.filter((option) => brokerage || option.kind === 'bank');
  return (
    <div className="button-stack connect-options">
      {options.map((option, i) => {
        const noteId = `${idBase}-${option.kind}`;
        return (
          <div key={option.kind}>
            {/* The bank option first and filled: it is the one most people need. */}
            <button
              className={i === 0 ? undefined : 'secondary'}
              onClick={() => onConnect(option.kind)}
              disabled={connecting}
              aria-describedby={noteId}
            >
              {connecting && starting === option.kind ? 'Starting…' : option.label}
            </button>
            <p className="panel-note" id={noteId}>
              {option.note}
            </p>
          </div>
        );
      })}
    </div>
  );
}
