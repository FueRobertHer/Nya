'use client';

// A day, as a page drawn on the server and then in the browser shows it: the
// ISO day (UTC) until the page runs in the browser, then the day in the
// reader's own time (fmtInstantDay: "today", "Oct 5"). A client component is
// rendered on the server too, where the time zone is the server's, so a day
// worked out there could differ from the browser's and the page would not
// match itself as it loads (the admin page: app/admin-view). Switched as
// components/hide-amounts.ts useAmountsHidden switches, with a server
// snapshot.

import { useSyncExternalStore } from 'react';
import { fmtInstantDay } from './accounts-format';

const subscribe = () => () => {};

/** The ISO day of an instant, as the server shows it. */
export const isoDay = (iso: string): string => iso.slice(0, 10);

/** How to write an instant's day here and now. */
export function useBrowserDay(): (iso: string) => string {
  const browser = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  return browser ? fmtInstantDay : isoDay;
}
