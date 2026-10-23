'use client';

// Shared expenses (#49) on the Activity tab: the card's own read
// (app/api/shared-expenses, read strictly), which sheet is open, and every
// change sent to the routes beside it. A change that moves a total (a share,
// an IOU, a payment, what was settled or let go, the counting setting) reads
// the transactions again quietly too, since the read layer counts your part
// (lib/shared-expenses/rows.ts); the card is read again after every change.
//
// Nothing here moves money or decides anything: each change is one the
// person made, from a sheet they confirmed.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardAnswer } from '@/lib/shared-expenses/read';
import type { Txn } from './MonthBreakdown';

/** Which sheet is open, on what. */
export type SharedOpen =
  | { kind: 'share'; t: Txn }
  | { kind: 'paid'; t: Txn; person?: string; allocations?: readonly { item: string; amount: number }[]; also?: readonly string[]; fromProposal?: boolean }
  | { kind: 'person'; id: string | null }
  | { kind: 'iou'; id: string | null; person?: string }
  | { kind: 'handoff'; person: string; currency: string }
  | { kind: 'settle'; person: string; currency: string; letGo?: boolean };

export type Sent = { error: string | null; body: Record<string, unknown> | null };

export type SharedExpenses = {
  /** The card as the route answers it; null until read, or when it couldn't be. */
  card: CardAnswer | null;
  /** Why it couldn't be read. */
  failed: string | null;
  open: SharedOpen | null;
  setOpen: (o: SharedOpen | null) => void;
  /** Sends one change (see the header): its error in words, or null. */
  send: (path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown, opts?: { keepalive?: boolean; moves?: boolean }) => Promise<Sent>;
  reload: () => void;
};

/** The routes under app/api/shared-expenses, by name. */
export const SHARED_ROUTES = {
  card: '/api/shared-expenses',
  people: '/api/shared-expenses/people',
  shares: '/api/shared-expenses/shares',
  ious: '/api/shared-expenses/ious',
  payments: '/api/shared-expenses/payments',
  close: '/api/shared-expenses/close',
} as const;

export function useSharedExpenses({ enabled, onTotalsChanged }: { enabled: boolean; onTotalsChanged: () => void }): SharedExpenses {
  const [card, setCard] = useState<CardAnswer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<SharedOpen | null>(null);
  // The newest read wins: an older one answering late is dropped.
  const reads = useRef(0);
  const changed = useRef(onTotalsChanged);
  changed.current = onTotalsChanged;

  const reload = useCallback(() => {
    const n = ++reads.current;
    fetch(SHARED_ROUTES.card)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (n !== reads.current) return;
        if (res.ok && body && Array.isArray(body.people)) {
          setCard(body as CardAnswer);
          setFailed(null);
        } else {
          setFailed(typeof body?.error === 'string' ? body.error : 'Your shared expenses couldn’t be read.');
        }
      })
      .catch(() => n === reads.current && setFailed('Could not reach the server.'));
  }, []);

  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);

  const send = useCallback<SharedExpenses['send']>(
    async (path, method, body, opts = {}) => {
      try {
        const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(opts.keepalive ? { keepalive: true } : {}) });
        const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!res.ok) return { error: typeof answer?.error === 'string' ? answer.error : 'Could not save that. Please try again.', body: answer };
        reload();
        if (opts.moves !== false) changed.current();
        return { error: null, body: answer };
      } catch {
        return { error: 'Could not reach the server.', body: null };
      }
    },
    [reload]
  );

  return { card, failed, open, setOpen, send, reload };
}
