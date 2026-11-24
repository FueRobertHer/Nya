'use client';

// Plaid Link for the dashboard (components/Dashboard.tsx): opened as soon as a
// fresh token is ready, and, when Plaid's window can't open (its script
// blocked, or Link silent), said so instead of a button that seems to do
// nothing (docs/features.md, Connecting accounts).

import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { usePlaidLink, type PlaidLinkOnEvent, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from 'react-plaid-link';

/** How long Plaid's window has to open once its token is in, before the
 *  page says it couldn't: its script or its own requests can be blocked (a
 *  content blocker, a network that refuses Plaid), and Link then shows
 *  nothing and calls nothing back. */
export const PLAID_OPEN_TIMEOUT_MS = 30_000;

/** Plaid Link, opened as soon as a fresh token is ready. usePlaidLink loads
 *  Plaid's script from its CDN as it mounts, token or not, so the dashboard
 *  mounts this only once a connection is first started (plaidWanted). `exit`
 *  goes out through a ref: see onEvent in Dashboard. When the script fails
 *  to load, or Link hasn't said it opened (its OPEN event) within
 *  PLAID_OPEN_TIMEOUT_MS, `onUnavailable` is called once for that token, so
 *  the button that started it doesn't seem to do nothing. */
export default function PlaidLinkHandler({
  token,
  onSuccess,
  onEvent,
  onExit,
  onUnavailable,
  exitRef,
  openRef,
}: {
  token: string | null;
  onSuccess: PlaidLinkOnSuccess;
  onEvent: PlaidLinkOnEvent;
  onExit: PlaidLinkOnExit;
  onUnavailable: () => void;
  exitRef: MutableRefObject<(opts?: { force?: boolean }) => void>;
  openRef: MutableRefObject<boolean>;
}) {
  // The token Link said it opened for, and the one already given up on.
  const openedFor = useRef<string | null>(null);
  const failedFor = useRef<string | null>(null);
  const seeEvent = useCallback<PlaidLinkOnEvent>(
    (eventName, metadata) => {
      if (eventName === 'OPEN') openedFor.current = token;
      onEvent(eventName, metadata);
    },
    [token, onEvent]
  );
  const { open, ready, exit, error } = usePlaidLink({ token, onSuccess, onEvent: seeEvent, onExit });
  useLayoutEffect(() => {
    exitRef.current = exit as (opts?: { force?: boolean }) => void;
  }, [exit, exitRef]);
  useEffect(() => {
    if (token && ready) {
      openRef.current = true;
      open();
    }
  }, [token, ready, open, openRef]);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  useEffect(() => {
    if (!token) return;
    const giveUp = () => {
      if (openedFor.current === token || failedFor.current === token) return;
      failedFor.current = token;
      openRef.current = false;
      unavailable.current();
    };
    if (error) {
      giveUp();
      return;
    }
    const timer = setTimeout(giveUp, PLAID_OPEN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [token, error, openRef]);
  return null;
}
