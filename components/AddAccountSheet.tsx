'use client';

// Every way to add an account, one row each, from "+ Add account" on the
// Accounts tab (docs/design/information-architecture.md#accounts). Replaces
// the connect block that used to open the tab. Which service reaches which
// banks, and what each costs, is behind "Which should I use?".
//
// A Plaid row keeps the sheet open, saying "Starting…", until its link token
// is back and Link opens over it; then the sheet closes. Every other row
// closes this sheet first and opens its own, so no sheet opens on top of
// another.

import { useState } from 'react';
import { Sheet } from './Sheet';
import { Why } from './Why';
import { CoverageNote } from './TrustLinks';
import { CONNECT_OPTIONS, LUNCHFLOW_OPTION, SIMPLEFIN_OPTION } from './ConnectButtons';
import type { LinkKind } from '@/lib/item-products';

const CHEVRON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

type Row = { key: string; title: string; sub: string; onSelect: () => void; disabled?: boolean };

export default function AddAccountSheet({
  open,
  onClose,
  connecting,
  brokerage,
  onConnect,
  onConnectSimpleFin,
  onConnectLunchFlow,
  onAddManual,
  onSwitching,
}: {
  open: boolean;
  onClose: () => void;
  /** Whether a Link flow is starting (any of them): the Plaid rows wait. */
  connecting: boolean;
  /** Whether the brokerage and retirement option is offered here. */
  brokerage: boolean;
  /** Starts Plaid Link; settles once Link has opened or failed to. */
  onConnect: (kind: LinkKind) => Promise<unknown> | void;
  onConnectSimpleFin?: () => void;
  onConnectLunchFlow?: () => void;
  onAddManual: () => void;
  onSwitching: () => void;
}) {
  const [starting, setStarting] = useState<LinkKind | null>(null);
  const then = (go: () => void) => () => {
    onClose();
    go();
  };

  const rows: Row[] = [
    ...CONNECT_OPTIONS.filter((option) => brokerage || option.kind === 'bank').map((option) => ({
      key: option.kind,
      title: connecting && starting === option.kind ? 'Starting…' : option.label,
      sub: option.note,
      disabled: connecting,
      onSelect: () => {
        setStarting(option.kind);
        Promise.resolve(onConnect(option.kind)).finally(() => {
          setStarting(null);
          onClose();
        });
      },
    })),
    ...(onConnectSimpleFin
      ? [{ key: 'simplefin', title: SIMPLEFIN_OPTION.label, sub: 'Your own SimpleFIN account ($15 a year, paid to SimpleFIN), or Redbark', onSelect: then(onConnectSimpleFin) }]
      : []),
    ...(onConnectLunchFlow
      ? [{ key: 'lunchflow', title: LUNCHFLOW_OPTION.label, sub: 'Your own Lunch Flow account (about $35 a year for two bank connections)', onSelect: then(onConnectLunchFlow) }]
      : []),
    { key: 'manual', title: 'Add a manual account', sub: 'Any account, with a balance you enter in its own currency', onSelect: then(onAddManual) },
    { key: 'switching', title: 'Switching from another app', sub: 'Monarch, YNAB, Lunch Money, Actual Budget or ZeroSum', onSelect: then(onSwitching) },
  ];

  return (
    <Sheet open={open} title="Add an account" onClose={onClose}>
      <>
        <ul className="list-rows">
          {rows.map((row) => (
            <li key={row.key}>
              <button className="list-row" onClick={row.onSelect} disabled={row.disabled}>
                <span className="list-row-text">
                  <span className="list-row-title">{row.title}</span>
                  <span className="list-row-sub">{row.sub}</span>
                </span>
                {CHEVRON}
              </button>
            </li>
          ))}
        </ul>
        <Why label="Which should I use?">
          <div className="stack tight">
            <CoverageNote />
            {onConnectSimpleFin && <p className="helper">{SIMPLEFIN_OPTION.note}</p>}
            {onConnectLunchFlow && <p className="helper">{LUNCHFLOW_OPTION.note}</p>}
          </div>
        </Why>
      </>
    </Sheet>
  );
}
