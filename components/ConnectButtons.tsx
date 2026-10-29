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

/** Bringing your own sync (components/Connectors.tsx), offered beside Plaid's
 *  ways and only started when chosen. */
export const SIMPLEFIN_OPTION = {
  label: 'Connect with SimpleFIN',
  note: 'Bring your own sync: your own SimpleFIN account ($15 a year, paid to SimpleFIN) may reach banks Plaid doesn’t. Redbark, a separate paid service that works the same way, covers Australia and New Zealand.',
} as const;

/** The same, with your own Lunch Flow account's API key (lib/connectors/lunchflow.ts). */
export const LUNCHFLOW_OPTION = {
  label: 'Connect with Lunch Flow',
  note: 'Bring your own sync: your own Lunch Flow account (about $35 a year for two bank connections, paid to Lunch Flow) reaches banks in many countries, through providers such as GoCardless and Akahu.',
} as const;

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
  onConnectSimpleFin,
  onConnectLunchFlow,
}: {
  /** Whether a Link flow is starting (any of them): every button waits. */
  connecting: boolean;
  onConnect: (kind: LinkKind) => void;
  /** Whether the brokerage and retirement option is offered here. */
  brokerage: boolean;
  /** Opens the SimpleFIN connection, when offered. */
  onConnectSimpleFin?: () => void;
  /** Opens the Lunch Flow connection, when offered. */
  onConnectLunchFlow?: () => void;
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
      onConnectSimpleFin={onConnectSimpleFin}
      onConnectLunchFlow={onConnectLunchFlow}
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
  onConnectSimpleFin,
  onConnectLunchFlow,
}: {
  connecting: boolean;
  starting: LinkKind | null;
  brokerage: boolean;
  idBase: string;
  onConnect: (kind: LinkKind) => void;
  onConnectSimpleFin?: () => void;
  onConnectLunchFlow?: () => void;
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
      {onConnectSimpleFin && (
        <div>
          <button className="secondary" onClick={onConnectSimpleFin} aria-describedby={`${idBase}-simplefin`}>
            {SIMPLEFIN_OPTION.label}
          </button>
          <p className="panel-note" id={`${idBase}-simplefin`}>
            {SIMPLEFIN_OPTION.note}
          </p>
        </div>
      )}
      {onConnectLunchFlow && (
        <div>
          <button className="secondary" onClick={onConnectLunchFlow} aria-describedby={`${idBase}-lunchflow`}>
            {LUNCHFLOW_OPTION.label}
          </button>
          <p className="panel-note" id={`${idBase}-lunchflow`}>
            {LUNCHFLOW_OPTION.note}
          </p>
        </div>
      )}
    </div>
  );
}

/** The way into the switch from another app (components/MigrationSheet.tsx)
 *  on the first screen, with nothing connected. Here, not beside the sheet,
 *  so that screen doesn't bring the sheet's code with it. */
export function SwitchingLink({ onOpen }: { onOpen: () => void }) {
  return (
    <p className="panel-note migration-link">
      Switching from another app?{' '}
      <button className="link-btn" onClick={onOpen}>
        Bring your history from Monarch, YNAB, Lunch Money, Actual Budget or ZeroSum
      </button>
    </p>
  );
}
