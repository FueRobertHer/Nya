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
