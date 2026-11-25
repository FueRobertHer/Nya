'use client';

// Plaid Link for the dashboard (components/Dashboard.tsx): opened as soon as a
// fresh token is ready, and, when Plaid's window can't open (its script
// blocked, or Link silent), said so instead of a button that seems to do
// nothing (docs/features.md, Connecting accounts). Until it opens, the
// button that started it keeps saying so (useLinkStarting).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { usePlaidLink, type PlaidLinkOnEvent, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from 'react-plaid-link';

/** How long Plaid's window has to open once its token is in, before the
 *  page says it couldn't: its script or its own requests can be blocked (a
 *  content blocker, a network that refuses Plaid), and Link then shows
 *  nothing and calls nothing back. */
export const PLAID_OPEN_TIMEOUT_MS = 30_000;

/** Whether a Plaid connection is still starting, for the buttons that start
 *  one: from the press (`fetching` its token) until Link says it opened
 *  (`onOpen`, given to PlaidLinkHandler) or the token is taken back (Link
 *  exited, or was given up on). Plaid's script and window can take a while
 *  once the token is in (up to PLAID_OPEN_TIMEOUT_MS), and the button
 *  pressed keeps its "Starting…" through it. A new token starts unopened. */
export function useLinkStarting(fetching: boolean, token: string | null): { starting: boolean; onOpen: (token: string) => void } {
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const onOpen = useCallback((opened: string) => setOpenedFor(opened), []);
  return { starting: fetching || (token !== null && openedFor !== token), onOpen };
}

/** Plaid Link, opened as soon as a fresh token is ready. usePlaidLink loads
 *  Plaid's script from its CDN as it mounts, token or not, so the dashboard
 *  mounts this only once a connection is first started (plaidWanted). `exit`
 *  goes out through a ref: see onEvent in Dashboard. `onOpen` is called
 *  with the token when Link says it opened (its OPEN event). When the
 *  script fails to load, or Link hasn't said it opened within
 *  PLAID_OPEN_TIMEOUT_MS, `onUnavailable` is called once for that token, so
 *  the button that started it doesn't seem to do nothing. */
export default function PlaidLinkHandler({
  token,
  onSuccess,
  onEvent,
  onExit,
  onOpen,
  onUnavailable,
  exitRef,
  openRef,
}: {
  token: string | null;
  onSuccess: PlaidLinkOnSuccess;
  onEvent: PlaidLinkOnEvent;
  onExit: PlaidLinkOnExit;
  onOpen: (token: string) => void;
  onUnavailable: () => void;
  exitRef: MutableRefObject<(opts?: { force?: boolean }) => void>;
  openRef: MutableRefObject<boolean>;
}) {
  // The token Link said it opened for, and the one already given up on.
  const openedFor = useRef<string | null>(null);
  const failedFor = useRef<string | null>(null);
  // Through a ref, as onUnavailable is: Link keeps the callbacks it was
  // built with for its token.
  const opened = useRef(onOpen);
  opened.current = onOpen;
  const seeEvent = useCallback<PlaidLinkOnEvent>(
    (eventName, metadata) => {
      if (eventName === 'OPEN' && token) {
        openedFor.current = token;
        opened.current(token);
      }
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
