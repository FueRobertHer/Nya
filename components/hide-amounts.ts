// components/hide-amounts.ts
//
// Hide amounts: one switch (components/HideAmounts.tsx, in the header) that
// shows the app's structure while hiding its figures, for using Nya in
// public, on a shared screen or in a screenshot. While it is on, every
// formatter in lib/format.ts writes an amount's figures as "•••", keeping its
// sign and currency ("-$•••"); meters, bars and charts keep their shapes, and
// percentages stay, since they say no amount.
//
// REMEMBERED ON THIS DEVICE, never on the server: it is a viewer's own
// convenience for this browser, kept in localStorage (`nya:hide-amounts`)
// beside the dashboard's last-known snapshot, and read leniently. Storage
// that can't be read (a private window, blocked site data) reads as amounts
// shown; a choice that can't be written still holds while the page is open.
// A change made in another tab on this device is followed here too (the
// storage event).
//
// SET BEFORE ANY AMOUNT IS DRAWN. In the browser this module reads the choice
// as the page loads it and sets lib/format.ts at once. The dashboard and the
// report page draw their first amounts after their own effects have run
// (the server renders a spinner, or an empty report), so a figure is never
// drawn and then hidden. The server never sets it: what a route answers, the
// read-only API and every download carry the figures, and a page renders
// on the server as shown (useSyncExternalStore's server snapshot).
//
// PRINTING. A printed report is a deliberate act, so the report page shows
// its figures while the browser prints it (showFigures, from beforeprint to
// afterprint), whatever the switch says.
//
// While amounts are hidden the root element carries data-amounts="hidden":
// the CSS hook for what is drawn without the formatters, such as an amount
// typed into a field (app/globals.css, "Hide amounts").

import { useSyncExternalStore } from 'react';
import { setAmountsHidden } from '@/lib/format';

export const HIDE_AMOUNTS_KEY = 'nya:hide-amounts';

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

/** LENIENT, a convenience nothing writes, deletes or records on: whether this
 *  device says to hide amounts, and no when it can't say. */
export function readHideAmounts(storage: DeviceStorage | null = deviceStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(HIDE_AMOUNTS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Keeps the choice on this device: false when it couldn't be kept (it still
 *  holds while the page is open). */
export function writeHideAmounts(on: boolean, storage: DeviceStorage | null = deviceStorage()): boolean {
  if (!storage) return false;
  try {
    if (on) storage.setItem(HIDE_AMOUNTS_KEY, '1');
    else storage.removeItem(HIDE_AMOUNTS_KEY);
    return true;
  } catch {
    return false;
  }
}

/** The switch on this page, and whether a report is printing. */
let chosen = false;
let printing = false;
const listeners = new Set<() => void>();

/** Whether this page hides amounts now. */
const current = (): boolean => chosen && !printing;

/** The CSS hook: the root element marked while amounts are hidden. Only
 *  once something on the page has subscribed, which is after React has
 *  hydrated it: the root is never changed under React's feet. */
function markRoot(): void {
  if (typeof document === 'undefined' || listeners.size === 0) return;
  if (current()) document.documentElement.dataset.amounts = 'hidden';
  else delete document.documentElement.dataset.amounts;
}

/** Tells lib/format.ts, the CSS hook and every component drawn by it. */
function publish(): void {
  setAmountsHidden(current());
  markRoot();
  for (const listener of [...listeners]) listener();
}

/** The switch: hides or shows amounts on this page at once, and keeps the
 *  choice on this device. Answers whether it was kept. */
export function setHideAmounts(on: boolean, storage: DeviceStorage | null = deviceStorage()): boolean {
  chosen = on;
  const kept = writeHideAmounts(on, storage);
  publish();
  return kept;
}

/** Shows the figures meanwhile, whatever the switch says (a report being
 *  printed), or goes back to what it says. */
export function showFigures(on: boolean): void {
  if (printing === on) return;
  printing = on;
  publish();
}

/** Another tab on this device changed the switch (or cleared the storage). */
function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== HIDE_AMOUNTS_KEY) return;
  const next = readHideAmounts();
  if (next === chosen) return;
  chosen = next;
  publish();
}

/** Calls `listener` whenever the switch, or printing, changes what this page
 *  hides; answers how to stop. */
export function subscribeHideAmounts(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    markRoot();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** Whether amounts are hidden, for a component that draws them: it draws
 *  again whenever that changes. The server, and the browser's first render
 *  over the server's page, say no. */
export function useAmountsHidden(): boolean {
  return useSyncExternalStore(subscribeHideAmounts, current, () => false);
}

/** The switch as this page has it now, outside a component. */
export const amountsHiddenNow = current;

/** For tests: the choice as if this page had just loaded it from `storage`. */
export function loadHideAmountsForTests(storage: DeviceStorage | null): void {
  chosen = readHideAmounts(storage);
  printing = false;
  publish();
}

// In the browser, the choice is read as the page loads this module, before
// anything draws an amount (see SET BEFORE ANY AMOUNT IS DRAWN).
if (typeof window !== 'undefined') {
  chosen = readHideAmounts();
  setAmountsHidden(current());
}
