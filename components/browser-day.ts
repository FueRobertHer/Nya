'use client';

// A day or a time, as a page drawn on the server and then in the browser
// shows it: in UTC, said so, until the page runs in the browser, then in the
// reader's own time (fmtInstantDay: "today", "Oct 5"; fmtAsOf: "Oct 5,
// 9:12 AM", as Nightly jobs writes its runs). A client component is rendered
// on the server too, where the time zone is the server's, so a day worked out
// there could differ from the browser's and the page would not match itself
// as it loads (the admin page: app/admin-view). Switched as
// components/hide-amounts.ts useAmountsHidden switches, with a server
// snapshot.

import { useSyncExternalStore } from 'react';
import { fmtAsOf, fmtInstantDay } from './accounts-format';

const subscribe = () => () => {};

/** The ISO day of an instant, as the server shows it. */
export const isoDay = (iso: string): string => iso.slice(0, 10);

/** An instant's day and time in UTC, as the server shows it. */
export const isoWhen = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function useInBrowser(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}

/** How to write an instant's day here and now. */
export function useBrowserDay(): (iso: string) => string {
  return useInBrowser() ? fmtInstantDay : isoDay;
}

/** How to write an instant's day and time here and now. */
export function useBrowserWhen(): (iso: string) => string {
  return useInBrowser() ? fmtAsOf : isoWhen;
}
