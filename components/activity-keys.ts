// Whether the Activity tab's single-key shortcuts for the review queue
// (components/review-keys.ts activityKey: R, N, Shift+A, U, ?) are on, on
// this device. They can be turned off (WCAG 2.1.4, character key shortcuts):
// a key pressed by mistake, or a word said to speech input, never acts. Card
// Mode's keys stay, as they act only while its dialog has focus.
//
// REMEMBERED ON THIS DEVICE, never on the server: a viewer's own convenience,
// kept in localStorage (`nya:activity-keys`) as the hide-amounts switch is
// (components/hide-amounts.ts), and read leniently: storage that can't be
// read reads as on, as before anything was chosen; a choice that can't be
// written still holds while the page is open.
//
// ONE SWITCH, TWO PLACES: in the keys' own help on the Activity tab
// (components/ReviewBar.tsx), and on the Review queue card under Manage
// (components/ReviewSettingsCard.tsx), which is always there, keyboard or
// none: once the keys are off, "?" no longer opens their help, and a touch
// screen shows no link to it. Both read this page's one value
// (useActivityKeys), so turning it off in one place shows in the other.

import { useSyncExternalStore } from 'react';

export const ACTIVITY_KEYS_KEY = 'nya:activity-keys';

type DeviceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** This device's storage, or null where there is none (the server). Even
 *  reaching it can throw, where site data is blocked. */
function deviceStorage(): DeviceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** LENIENT: whether this device has the keys on; on when it can't say. */
export function readActivityKeys(storage: DeviceStorage | null = deviceStorage()): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(ACTIVITY_KEYS_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Keeps the choice on this device, quietly when it can't. */
export function writeActivityKeys(on: boolean, storage: DeviceStorage | null = deviceStorage()): void {
  if (!storage) return;
  try {
    if (on) storage.removeItem(ACTIVITY_KEYS_KEY);
    else storage.setItem(ACTIVITY_KEYS_KEY, 'off');
  } catch {
    // Held for this page only.
  }
}

// This page's value: read from the device the first time it is asked for,
// then what was last chosen here.
let chosen: boolean | null = null;
const listeners = new Set<() => void>();

/** Whether the keys are on for this page now. */
export function activityKeysNow(): boolean {
  if (chosen === null) chosen = readActivityKeys();
  return chosen;
}

/** Turns the keys on or off: for this page at once, everywhere it is shown,
 *  and on this device when its storage can keep it. */
export function setActivityKeys(on: boolean): void {
  chosen = on;
  writeActivityKeys(on);
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever the choice changes on this page; answers how to stop. */
export function subscribeActivityKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the keys are on, for a component that shows the switch or acts on
 *  the keys: it draws again when that changes. On, where there is no
 *  browser (the server, the first render over its page). */
export function useActivityKeys(): boolean {
  return useSyncExternalStore(subscribeActivityKeys, activityKeysNow, () => true);
}

/** For tests: forget this page's value, so the next read is the device's. */
export function forgetActivityKeysForTests(): void {
  chosen = null;
}
