// components/online.ts
//
// Whether this device is online, and what Home's hero says while it isn't
// (design-system.md, Status and honesty, Offline): Nya keeps the last numbers
// it showed (the snapshot on the device, components/Dashboard.tsx) and puts a
// caution on the total, "Offline. Showing balances from 9:41 AM.", through
// the hero's caveats (components/TotalCaveats.tsx), so it is said where the
// number is, in the caution's color.
//
// navigator.onLine and the online and offline events say it. On the server,
// and in a browser that doesn't say, it is online: nothing is claimed that
// isn't known, and the page Nya draws first never disagrees with the server's.

import { useSyncExternalStore } from 'react';
import { formatDay } from '@/lib/format';
import { localDate } from '@/lib/local-date';
import type { Caveat } from './TotalCaveats';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Online unless the browser says it isn't: false only once navigator.onLine is. */
const onlineNow = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const onlineOnServer = () => true;

/** Whether this device is online now, following the online and offline
 *  events. Online on the server and in the first paint that matches it. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, onlineNow, onlineOnServer);
}

/** When the numbers shown were loaded (`asOf`, an ISO time), as the note says
 *  it: the time today ("9:41 AM"), the day and the time before ("yesterday at
 *  9:41 AM", "Oct 27 at 9:41 AM"), in the person's own time zone. */
export function shownFrom(asOf: string, now: Date = new Date()): string | null {
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = localDate(d);
  return day === localDate(now) ? time : `${formatDay(day, { now, sentence: true })} at ${time}`;
}

/** The note itself: offline, and from when the balances shown are. */
export function offlineWords(asOf: string | null, now: Date = new Date()): string {
  const from = asOf ? shownFrom(asOf, now) : null;
  return from ? `Offline. Showing balances from ${from}.` : 'Offline. Showing the last balances this device saved.';
}

/** The caution for Home's total while this device is offline, or none. */
export function offlineCaveats(online: boolean, asOf: string | null, now: Date = new Date()): Caveat[] {
  if (online) return [];
  return [{ key: 'offline', severity: 'caution', summary: 'offline', body: offlineWords(asOf, now) }];
}

/** The same, following the device: none while it is online. */
export function useOfflineCaveats(asOf: string | null): Caveat[] {
  return offlineCaveats(useOnline(), asOf);
}
